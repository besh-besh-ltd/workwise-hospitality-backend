#!/usr/bin/env bash
# Starts the backend against the LOCAL Vendor Networks E2E database, without
# editing .env. See docs/vendor-networks/E2E_RUNBOOK.md.
#
#   scripts/vendor_networks/e2e_server.sh                 # foreground, port 8122
#   E2E_PORT=8123 scripts/vendor_networks/e2e_server.sh
#
# How it stays off stage: dotenv.config() never overrides a variable that is
# already set in the environment, so everything exported here wins over .env.
# That covers the database, AND every outbound integration .env configures for
# stage: AWS (S3/Scheduler/Lambda -> local sink), mail (nodemailer -> JSON files,
# no SMTP), secrets (throwaway), WhatsApp/AiSensy/AI/OTP (unroutable), OTel (localhost).
set -euo pipefail

cd "$(dirname "$0")/../.."

E2E_PORT="${E2E_PORT:-8122}"
E2E_DB_NAME="${E2E_DB_NAME:-hospitality_test_e2e}"
E2E_DB_HOST="${E2E_DB_HOST:-127.0.0.1}"
E2E_AWS_SINK_PORT="${E2E_AWS_SINK_PORT:-9555}"

case "$E2E_DB_HOST" in
  localhost|127.0.0.1|::1) ;;
  *) echo "ABORT: E2E_DB_HOST '$E2E_DB_HOST' is not local" >&2; exit 2 ;;
esac
shopt -s nocasematch   # the deny list is case-insensitive (PROD, Stage, ...)
if ! [[ "$E2E_DB_NAME" =~ ^hospitality_test_|local|dev ]] || [[ "$E2E_DB_NAME" =~ prod|stage|staging|main ]]; then
  echo "ABORT: '$E2E_DB_NAME' does not look like a local database" >&2
  exit 2
fi
shopt -u nocasematch

# Server + database
export NODE_ENV=development            # not 'production': the ARC signing OTP is returned as dev_code
export PORT="$E2E_PORT"
export HOST="$E2E_DB_HOST"
export DATABASE_NAME="$E2E_DB_NAME"
export DATABASE_USERNAME="${E2E_DB_USER:-$(whoami)}"
export DATABASE_PASSWORD="${E2E_DB_PASSWORD:-}"
export DATABASE_PORT="${E2E_DB_PORT:-5432}"
export DATABASE_DIALECT=postgres
export TEST_DB_NO_SSL=1

# Links in mails/notifications
export FRONT_END_WEBSITE="${E2E_FRONTEND_URL:-http://localhost:3000}"
export DOWNLOADD_URL="$FRONT_END_WEBSITE"
export APP_BASE_PATH="http://localhost:$E2E_PORT"

# AWS: everything goes to the in-process sink (scripts/vendor_networks/e2e_aws_sink.mjs)
export AWS_ACCESS_KEY_ID=e2e-local
export AWS_SECRET_ACCESS_KEY=e2e-local
export AWS_REGION=ap-south-1
export AWS_S3_BUCKET=vn-e2e-local
export AWS_ENDPOINT_URL="http://localhost:$E2E_AWS_SINK_PORT"
export AWS_ENDPOINT_URL_S3="http://localhost:$E2E_AWS_SINK_PORT"
export E2E_AWS_SINK_PORT
export LAMBDA_ARN=arn:aws:lambda:ap-south-1:000000000000:function:vn-e2e
export EVENTBRIDGE_ROLE_ARN=arn:aws:iam::000000000000:role/vn-e2e

# Mail: every nodemailer transport is replaced by a file writer (scripts/vendor_networks/e2e_mail_sink.mjs).
# The SMTP host is hard-coded in app/config/app.config.js, so credentials alone are not enough.
export E2E_MAIL_DIR="${E2E_MAIL_DIR:-/tmp/vn-e2e-mail}"
export SMTP_EMAIL=vn-e2e@localhost.invalid
export SMTP_USER_PASSWORD=vn-e2e-no-smtp

# Secrets: throwaway, never the stage ones from .env. Fixed literals so tokens and encrypted ids
# survive a restart. The seed does not depend on any of them (it stores bcrypt hashes only;
# CRYPT_SECRET only encrypts ids in responses and token claims).
export JWT_SECRET=vn-e2e-local-jwt-secret
export REFRESH_TOKEN_SECRET=vn-e2e-local-refresh-secret
export CRYPT_SECRET=vn-e2e-local-crypt-secret
export SCHEDULER_SECRET=vn-e2e-local-scheduler-secret
export WEBHOOK_SECRET=vn-e2e-local-webhook-secret
# Web push: a throwaway VAPID pair, generated once and kept in /tmp/vn-e2e/vapid.json.
VAPID_FILE="${E2E_VAPID_FILE:-/tmp/vn-e2e/vapid.json}"
if [ ! -s "$VAPID_FILE" ]; then
  mkdir -p "$(dirname "$VAPID_FILE")"
  node -e 'process.stdout.write(JSON.stringify(require("web-push").generateVAPIDKeys()))' > "$VAPID_FILE"
fi
PUBLIC_VAPID_KEY="$(node -p "require('$VAPID_FILE').publicKey")"
PRIVATE_VAPID_KEY="$(node -p "require('$VAPID_FILE').privateKey")"
export PUBLIC_VAPID_KEY PRIVATE_VAPID_KEY
export VAPID_PUBLIC_KEY="$PUBLIC_VAPID_KEY" VAPID_PRIVATE_KEY="$PRIVATE_VAPID_KEY"
export WEB_PUSH_CONTACT="mailto:vn-e2e@localhost.invalid" VAPID_SUBJECT="mailto:vn-e2e@localhost.invalid"

# Other outbound integrations: dummy / unroutable
export AISENSY_API=http://127.0.0.1:9 AISENSY_API_KEY=vn-e2e WHATSAPP_KEY=vn-e2e
export FLUX_CHAT_API=http://127.0.0.1:9 FLUX_CHAT_KEY=vn-e2e
export AI_BASE_URL=http://127.0.0.1:9 DEEPSEEK_API_KEY=vn-e2e GOOGLE_AI_API_KEY=vn-e2e
export OTP_URL=http://127.0.0.1:9
export RAZORPAY_KEY=rzp_test_vn_e2e RAZORPAY_SECRET=vn-e2e RAZORPAY_SIGNATURE=vn-e2e
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317
export OTEL_SERVICE_NAME=workwise-backend-vn-e2e

echo "[e2e-server] db=$DATABASE_NAME@$HOST:$DATABASE_PORT port=$PORT aws-sink=:$E2E_AWS_SINK_PORT mail=$E2E_MAIL_DIR"
exec node --experimental-json-modules \
  --import ./scripts/vendor_networks/e2e_mail_sink.mjs \
  --import ./scripts/vendor_networks/e2e_aws_sink.mjs \
  --import ./otel-instrument.mjs \
  server.js
