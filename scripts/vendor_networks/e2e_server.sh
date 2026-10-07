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
# stage: AWS (S3/Scheduler/Lambda -> local sink), SMTP (dummy credentials, mail
# fails and is logged), WhatsApp/AiSensy/AI/OTP (unroutable), OTel (localhost).
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
if ! [[ "$E2E_DB_NAME" =~ ^hospitality_test_|local|dev ]] || [[ "$E2E_DB_NAME" =~ prod|stage|staging|main ]]; then
  echo "ABORT: '$E2E_DB_NAME' does not look like a local database" >&2
  exit 2
fi

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

# Other outbound integrations: dummy / unroutable
export SMTP_EMAIL=vn-e2e@localhost.invalid
export SMTP_USER_PASSWORD=vn-e2e-no-smtp
export AISENSY_API=http://127.0.0.1:9 AISENSY_API_KEY=vn-e2e WHATSAPP_KEY=vn-e2e
export FLUX_CHAT_API=http://127.0.0.1:9 FLUX_CHAT_KEY=vn-e2e
export AI_BASE_URL=http://127.0.0.1:9 DEEPSEEK_API_KEY=vn-e2e GOOGLE_AI_API_KEY=vn-e2e
export OTP_URL=http://127.0.0.1:9
export RAZORPAY_KEY=rzp_test_vn_e2e RAZORPAY_SECRET=vn-e2e RAZORPAY_SIGNATURE=vn-e2e
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317
export OTEL_SERVICE_NAME=workwise-backend-vn-e2e

echo "[e2e-server] db=$DATABASE_NAME@$HOST:$DATABASE_PORT port=$PORT aws-sink=:$E2E_AWS_SINK_PORT"
exec node --experimental-json-modules \
  --import ./scripts/vendor_networks/e2e_aws_sink.mjs \
  --import ./otel-instrument.mjs \
  server.js
