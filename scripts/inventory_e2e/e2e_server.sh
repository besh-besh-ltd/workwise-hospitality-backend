#!/usr/bin/env bash
# Inventory module: LOCAL end-to-end backend (Task E3). Builds the local database,
# seeds the inventory world, then runs the backend against it with every outbound
# integration stubbed. See scripts/inventory_e2e/E2E_RUNBOOK.md.
#
#   scripts/inventory_e2e/e2e_server.sh                  # rebuild DB + seed + serve on :8092
#   E2E_RESET=seed scripts/inventory_e2e/e2e_server.sh   # keep schema, re-seed the world, serve
#   E2E_RESET=none scripts/inventory_e2e/e2e_server.sh   # restart on the existing data
#
#   E2E_RESET  full (default) | seed | none
#   E2E_PORT   8092    backend           E2E_AWS_SINK_PORT  9592   AWS stand-in (loopback)
#   E2E_DIR    /tmp/inv-e2e              mail/, aws-sink/, egress.log, seed.json, vapid.json
#   E2E_FRONTEND_URL  http://localhost:3000   (links in mails / the site-rep link)
#
# How it stays off stage, SMTP and AWS:
#   1. The database is LOCAL: hospitality_test_e2e_inventory on 127.0.0.1, guarded by
#      name and host here, by the harness (prepare) and by the seed (inet_server_addr).
#      The `hospitality_test_` prefix is required by the harness's own guard.
#   2. Every variable the app reads is exported here. dotenv.config() never overrides
#      an exported variable, and if a .env sits next to server.js the launcher refuses
#      to start unless every key in it is exported (so no stage value can leak in).
#   3. In-process preloads, in this order:
#        e2e_egress_guard.mjs  refuses (and logs) any TCP/TLS connection that is not loopback
#        e2e_mail_sink.mjs     every nodemailer transport -> JSON files in $E2E_DIR/mail
#                              (the Brevo host is hard-coded in app.config.js; this is what stops it)
#        e2e_aws_sink.mjs      S3 / Scheduler / Lambda -> a loopback HTTP stand-in
set -euo pipefail

cd "$(dirname "$0")/../.."
BACKEND_DIR="$(pwd)"

E2E_RESET="${E2E_RESET:-full}"
E2E_PORT="${E2E_PORT:-8092}"
E2E_DB_NAME="${E2E_DB_NAME:-hospitality_test_e2e_inventory}"
E2E_DB_HOST="${E2E_DB_HOST:-127.0.0.1}"
E2E_DB_PORT="${E2E_DB_PORT:-5432}"
E2E_DB_USER="${E2E_DB_USER:-$(whoami)}"
E2E_AWS_SINK_PORT="${E2E_AWS_SINK_PORT:-9592}"
E2E_DIR="${E2E_DIR:-/tmp/inv-e2e}"
E2E_FRONTEND_URL="${E2E_FRONTEND_URL:-http://localhost:3000}"

log() { echo "[inv-e2e] $*"; }
die() { echo "[inv-e2e] ABORT: $*" >&2; exit 2; }

# ---- guards ------------------------------------------------------------------
case "$E2E_RESET" in full|seed|none) ;; *) die "E2E_RESET must be full, seed or none (got '$E2E_RESET')" ;; esac
case "$E2E_DB_HOST" in localhost|127.0.0.1|::1) ;; *) die "E2E_DB_HOST '$E2E_DB_HOST' is not local" ;; esac
shopt -s nocasematch
if ! [[ "$E2E_DB_NAME" =~ ^hospitality_test_ ]] || [[ "$E2E_DB_NAME" =~ prod|stage|staging|main ]]; then
  die "'$E2E_DB_NAME' is not a local hospitality_test_* database"
fi
shopt -u nocasematch
for port in "$E2E_PORT" "$E2E_AWS_SINK_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $port is already in use (another e2e backend still running?)"
  fi
done

# ---- environment: every key the app reads, nothing left to .env ----------------
export NODE_ENV=development            # crons on; ARC OTPs come back as dev_code
export PORT="$E2E_PORT" LIMIT=10 APP_VERSION=1.0 LOG_LEVEL="${LOG_LEVEL:-info}"
export HOST="$E2E_DB_HOST" DATABASE_NAME="$E2E_DB_NAME" DATABASE_USERNAME="$E2E_DB_USER"
export DATABASE_PASSWORD="${E2E_DB_PASSWORD:-}" DATABASE_PORT="$E2E_DB_PORT" DATABASE_DIALECT=postgres
export TEST_DB_NO_SSL=1

# Links in mails, notifications and the site-rep link
export FRONT_END_WEBSITE="$E2E_FRONTEND_URL" FRONT_BASE_URL="$E2E_FRONTEND_URL" FRONTEND_URL="$E2E_FRONTEND_URL"
export DOWNLOADD_URL="$E2E_FRONTEND_URL" ADMIN_BASE_URL="$E2E_FRONTEND_URL"
export APP_BASE_PATH="http://localhost:$E2E_PORT" BASE_URL="http://localhost:$E2E_PORT"
export CORS_ORIGINS="" SOCKET_CORS_ORIGINS="$E2E_FRONTEND_URL"

# Secrets: throwaway literals (stable across restarts so a browser session survives one)
export JWT_SECRET=inv-e2e-local-jwt-secret REFRESH_TOKEN_SECRET=inv-e2e-local-refresh-secret
export CRYPT_SECRET=inv-e2e-local-crypt-secret JWT_EXPIRATION_IN_SECONDS=36000
export SCHEDULER_SECRET=inv-e2e-local-scheduler-secret WEBHOOK_SECRET=inv-e2e-local-webhook-secret
export RECAPTCHA_SECRET_KEY="" RECAPTCHA_MIN_SCORE=0

# AWS: all of it to the loopback stand-in; no profile or shared config can redirect it
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SESSION_TOKEN
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
export AWS_ACCESS_KEY_ID=inv-e2e-local AWS_SECRET_ACCESS_KEY=inv-e2e-local AWS_REGION=ap-south-1
export AWS_S3_BUCKET=inv-e2e-local
export AWS_ENDPOINT_URL="http://localhost:$E2E_AWS_SINK_PORT" AWS_ENDPOINT_URL_S3="http://localhost:$E2E_AWS_SINK_PORT"
export E2E_AWS_SINK_PORT E2E_AWS_SINK_DIR="$E2E_DIR/aws-sink"
export LAMBDA_ARN=arn:aws:lambda:ap-south-1:000000000000:function:inv-e2e
export EVENTBRIDGE_ROLE_ARN=arn:aws:iam::000000000000:role/inv-e2e
export GroupName=inv-e2e RFQ_PUBLISH_GROUP_NAME=inv-e2e

# Mail: nodemailer -> files. Undeliverable sender; no SMTP credentials at all.
export E2E_MAIL_DIR="$E2E_DIR/mail"
export SMTP_EMAIL=inventory-e2e@localhost.invalid SMTP_USER_PASSWORD=inv-e2e-no-smtp
export TEMPLATE_PATH=app/helper/email_template

# Web push: a throwaway VAPID pair kept in $E2E_DIR
mkdir -p "$E2E_DIR"
VAPID_FILE="$E2E_DIR/vapid.json"
if [ ! -s "$VAPID_FILE" ]; then
  node -e 'process.stdout.write(JSON.stringify(require("web-push").generateVAPIDKeys()))' > "$VAPID_FILE"
fi
PUBLIC_VAPID_KEY="$(node -p "require('$VAPID_FILE').publicKey")"
PRIVATE_VAPID_KEY="$(node -p "require('$VAPID_FILE').privateKey")"
export PUBLIC_VAPID_KEY PRIVATE_VAPID_KEY VAPID_PUBLIC_KEY="$PUBLIC_VAPID_KEY" VAPID_PRIVATE_KEY="$PRIVATE_VAPID_KEY"
export WEB_PUSH_CONTACT="mailto:inventory-e2e@localhost.invalid" VAPID_SUBJECT="mailto:inventory-e2e@localhost.invalid"

# Other outbound integrations: unroutable (port 9 = discard) or dummy
export AISENSY_API=http://127.0.0.1:9 AISENSY_API_KEY=inv-e2e WHATSAPP_KEY=inv-e2e
export FLUX_CHAT_API=http://127.0.0.1:9 FLUX_CHAT_KEY=inv-e2e
export AI_BASE_URL=http://127.0.0.1:9 AI_SERVER_URL=http://127.0.0.1:9 DEEPSEEK_API_KEY=inv-e2e GOOGLE_AI_API_KEY=inv-e2e
export OTP_URL=http://127.0.0.1:9 OTP_WORKINGKEY=inv-e2e OTP_SENDER=inv-e2e
export RAZORPAY_KEY=rzp_test_inv_e2e RAZORPAY_SECRET=inv-e2e RAZORPAY_SIGNATURE=inv-e2e
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317 OTEL_SERVICE_NAME=workwise-backend-inv-e2e

# Upload scratch paths (same values as .env.test)
export USER_IMAGE=app/uploads/user_image BANNER_IMAGE=app/uploads/banner_image MANAGEMENT_IMAGE=app/uploads/management_image
export BLOG_IMAGE=app/uploads/blog_image MEDIA_IMAGE=app/uploads/media_image COMPANY_IMAGE=app/uploads/company_image
export TESTIMONIAL_IMAGE=app/uploads/testimonial_image PRODUCT_IMAGE=app/uploads/product_image
export AGENT_USER_IMAGE=app/uploads/agent_user_image TERM_CONDITION=app/uploads/term_condition
export DOCUMENT_PATH=app/uploads/user_document PORGRAM_BROCHURE_PATH=app/uploads/course_brochure
export PRODUCT_FILE=app/uploads/product_export VENDOR_APPROVE_IMAGE=app/uploads/vendor_approve
export QUERY_MESSAGE_FILE_UPLOAD_PATH=app/uploads/query_message_files TEAM_MEMBER_IMAGE=app/uploads/team_member_image
export ADD_CLAUSE_FILE=app/uploads/add_clause_file BULK_PRODUCT_FILE=app/uploads/bulk_product_file
export INVOICE_FILE=app/uploads/bulk_product_file PROJECT_FILE_UPLOAD_PATH=app/uploads/project_files
export MAGIC_SEARCH_FILE=app/uploads/magic_search BUYER_UPLOAD_VENDOR_FILE=app/uploads/buyer_upload_vendor

export E2E_EGRESS_LOG="$E2E_DIR/egress.log"
export E2E_SEED_MANIFEST="$E2E_DIR/seed.json"

# A .env next to server.js holds STAGE values. dotenv only fills what is unset, so
# refuse to start if any of its keys is not exported above. Key NAMES only are read.
if [ -f "$BACKEND_DIR/.env" ]; then
  missing=()
  while IFS= read -r key; do
    [ -n "${!key+x}" ] || missing+=("$key")
  done < <(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$BACKEND_DIR/.env" | sort -u)
  if [ "${#missing[@]}" -gt 0 ]; then
    die ".env defines keys this launcher does not override: ${missing[*]} (export them here first)"
  fi
  log ".env present: every key it defines is overridden"
fi

# ---- database ------------------------------------------------------------------
if [ "$E2E_RESET" = full ]; then
  run_id="${E2E_DB_NAME#hospitality_test_}"
  [ "$E2E_DB_HOST" = 127.0.0.1 ] || [ "$E2E_DB_HOST" = localhost ] || die "full reset builds on .env.test's local HOST only"
  log "rebuilding $E2E_DB_NAME (schema + reference data + all pending migrations + fixtures)"
  E2E_RUN_ID="$run_id" node scripts/vendor_networks/e2e_prepare_db.mjs
fi
if [ "$E2E_RESET" != none ]; then
  rm -rf "$E2E_MAIL_DIR" "$E2E_AWS_SINK_DIR"
  node scripts/inventory_e2e/seed.mjs --db="$E2E_DB_NAME" --host="$E2E_DB_HOST" --port="$E2E_DB_PORT" --user="$E2E_DB_USER"
fi
[ -s "$E2E_SEED_MANIFEST" ] || die "no seed manifest at $E2E_SEED_MANIFEST (run with E2E_RESET=seed)"
mkdir -p "$E2E_MAIL_DIR" "$E2E_AWS_SINK_DIR"
: > "$E2E_EGRESS_LOG"

# ---- banner --------------------------------------------------------------------
cat <<EOF

================ inventory E2E backend ================
  API base       http://localhost:$E2E_PORT/api/v1
  frontend       cd ../frontend && NEXT_PUBLIC_API_URL=http://localhost:$E2E_PORT/api/v1 npx next dev --turbopack
  database       $E2E_DB_NAME @ $E2E_DB_HOST:$E2E_DB_PORT
  mail sink      $E2E_MAIL_DIR   (one JSON file per mail; nothing is sent)
  AWS stand-in   http://localhost:$E2E_AWS_SINK_PORT   objects under $E2E_AWS_SINK_DIR
  egress log     $E2E_EGRESS_LOG   (any BLOCKED line = something tried to leave)
  seed manifest  $E2E_SEED_MANIFEST
  password       E2e@12345 for every login (log in with the employee code)
    INVE2E-STORE   Storekeeper @ A1 (Saffron Grand Mumbai)
    INVE2E-CTRL    Inventory Controller @ A1 + A2
    INVE2E-BUYER   PO initiator / buyer, company A
    INVE2E-BBUYER  buyer, company B (isolation)
    INVE2E-VENDOR  vendor FreshKart Foods & Supplies
  site-rep link  $(node -p "require('$E2E_SEED_MANIFEST').siteRep.link")
  backend pid    $$
=======================================================

EOF

exec node --experimental-json-modules \
  --import ./scripts/inventory_e2e/e2e_egress_guard.mjs \
  --import ./scripts/vendor_networks/e2e_mail_sink.mjs \
  --import ./scripts/vendor_networks/e2e_aws_sink.mjs \
  server.js
