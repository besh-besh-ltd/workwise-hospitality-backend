#!/usr/bin/env bash
# Creates the performance indexes from migrations/20261003100000_perf_indexes.sql
# on a LIVE database without taking a write lock. CREATE INDEX CONCURRENTLY
# cannot run inside a transaction, which is why this is a script and not part
# of the transactional migration runner.
#
# Run against STAGE first, then PROD:
#   PGHOST=... PGUSER=... PGPASSWORD=... PGSSLMODE=require \
#   PGDATABASE=hospitality_stage ./scripts/perf_indexes_concurrently.sh
#   PGDATABASE=hospitality_main  ./scripts/perf_indexes_concurrently.sh
#
# Safe to re-run: every statement is IF NOT EXISTS. An interrupted CONCURRENTLY
# build leaves an INVALID index behind which IF NOT EXISTS would then skip, so
# this script refuses to continue while any of its indexes is invalid — drop it
# with DROP INDEX CONCURRENTLY <name> and re-run. Index names are identical to
# the migration, so applying the migration afterwards is a no-op.
set -euo pipefail

: "${PGDATABASE:?set PGDATABASE (hospitality_stage or hospitality_main)}"
# lock_timeout goes in PGOPTIONS, NOT a leading `SET ...;` in the same -c:
# psql sends a multi-statement -c string as ONE implicit transaction, and
# CREATE INDEX CONCURRENTLY refuses to run inside a transaction block.
export PGOPTIONS="${PGOPTIONS:-} -c lock_timeout=5s"
PSQL=(psql -X -v ON_ERROR_STOP=1)
NAMES="'idx_pop_rfq_product_id_inc','idx_pop_purchase_order_id','idx_notif_owner_active','idx_company_location_company_id'"

check_invalid() {
  local bad
  bad=$("${PSQL[@]}" -Atc "SELECT string_agg(c.relname, ', ') FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE NOT i.indisvalid AND c.relname IN (${NAMES});")
  if [[ -n "$bad" ]]; then
    echo "INVALID index(es) left by an interrupted build: $bad" >&2
    echo "Run: DROP INDEX CONCURRENTLY <name>;  then re-run this script." >&2
    exit 1
  fi
}

echo "Target: ${PGHOST:-local}/${PGDATABASE}"
check_invalid

"${PSQL[@]}" -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pop_rfq_product_id_inc ON public.tbl_purchase_order_product (rfq_product_id) INCLUDE (purchase_order_id);"
"${PSQL[@]}" -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pop_purchase_order_id ON public.tbl_purchase_order_product (purchase_order_id);"
"${PSQL[@]}" -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notif_owner_active ON public.tbl_notifications ((COALESCE(recipient_user_id, sender_user_id)), created_at DESC) INCLUDE (delivered_at, is_read) WHERE dismissed_at IS NULL;"
"${PSQL[@]}" -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_company_location_company_id ON public.tbl_company_location (company_id);"

"${PSQL[@]}" -c "ANALYZE public.tbl_purchase_order_product; ANALYZE public.tbl_notifications; ANALYZE public.tbl_company_location;"

check_invalid
echo "--- created ---"
"${PSQL[@]}" -Atc "SELECT indexname || '  ' || indexdef FROM pg_indexes WHERE indexname IN (${NAMES}) ORDER BY 1;"
