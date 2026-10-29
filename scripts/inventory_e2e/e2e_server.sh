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
# The environment, its guards and how it stays off stage, SMTP and AWS: e2e_env.sh.
set -euo pipefail

cd "$(dirname "$0")/../.."
E2E_RESET="${E2E_RESET:-full}"
# shellcheck source=scripts/inventory_e2e/e2e_env.sh
source scripts/inventory_e2e/e2e_env.sh

case "$E2E_RESET" in full|seed|none) ;; *) die "E2E_RESET must be full, seed or none (got '$E2E_RESET')" ;; esac
for port in "$E2E_PORT" "$E2E_AWS_SINK_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $port is already in use (another e2e backend still running?)"
  fi
done

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
  API run        node scripts/inventory_e2e/api_scenario.mjs       (fresh seed only)
  digest now     scripts/inventory_e2e/low_stock_digest.sh
  backend pid    $$
=======================================================

EOF

exec node --experimental-json-modules \
  --import ./scripts/inventory_e2e/e2e_egress_guard.mjs \
  --import ./scripts/vendor_networks/e2e_mail_sink.mjs \
  --import ./scripts/vendor_networks/e2e_aws_sink.mjs \
  server.js
