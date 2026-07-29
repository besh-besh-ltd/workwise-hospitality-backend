#!/usr/bin/env bash
#
# Ordered runner for the pending hand-applied migrations (negotiation + charges).
#
# These changes are live on STAGING but were applied ad-hoc and never tracked,
# so they are missing from git branches and their PRODUCTION status is unknown.
# This runner replays them, in dependency order, idempotently.
#
# Runs, in order:
#   1. 20260608100100_negotiation_polymorphic.sql
#        source_type / source_id columns, rfq_id -> nullable, source index,
#        auto-fill trigger.
#   2. 20260624100000_multi_product_negotiation_rounds.sql
#        products / arc_item_id / rfq_product_id columns, chk_neg_round_scope,
#        per-product FKs + indexes, 3-column unique key on round_quotes.
#   3. 20260624100100_backfill_negotiation_vendor_approvals.sql
#        one-time data backfill of vendor_approvals for legacy rounds (only
#        touches rounds whose vendor_approvals is still empty).
#   4. 20260624100200_backfill_quote_charges_slugs.sql
#        one-time data backfill: slugs on other_charges/global_charges, and
#        fold legacy freight/package columns into other_charges (only touches
#        rows still missing a slug / with empty other_charges).
#
# Ordering rationale: #2 depends on source_type from #1; #3 depends on the
# columns from #2. #4 is an independent (charges) domain and runs last.
#
# Every step is idempotent (IF NOT EXISTS / DO-guarded / WHERE-guarded), so this
# is safe to re-run and safe on a DB that already has some of the changes. Each
# file runs inside its own transaction and aborts the whole run on the first
# error (ON_ERROR_STOP=1).
#
# ─── Usage ──────────────────────────────────────────────────────────────────
#   Option A — pass a full connection string:
#     DATABASE_URL="postgres://user:pass@host:5432/dbname?sslmode=require" \
#       ./migrations/run_pending_migrations.sh
#
#   Option B — pass discrete PG* vars:
#     PGHOST=... PGPORT=5432 PGUSER=... PGPASSWORD=... PGDATABASE=... \
#       ./migrations/run_pending_migrations.sh
#
#   Dry run (print the SQL that WOULD run, touch nothing):
#     ./migrations/run_pending_migrations.sh --dry-run
#
#   Run only a subset by group:
#     ./migrations/run_pending_migrations.sh --only negotiation
#     ./migrations/run_pending_migrations.sh --only charges
#
# ⚠️  Take a snapshot / backup before pointing this at production.
# ────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ordered list — DO NOT reorder. Format: "<group>|<filename>"
MIGRATIONS=(
  "negotiation|20260608100100_negotiation_polymorphic.sql"
  "negotiation|20260624100000_multi_product_negotiation_rounds.sql"
  "negotiation|20260624100100_backfill_negotiation_vendor_approvals.sql"
  "charges|20260624100200_backfill_quote_charges_slugs.sql"
)

DRY_RUN=0
ONLY_GROUP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --only)    ONLY_GROUP="${2:-}"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Build the psql target: prefer DATABASE_URL, else rely on PG* env vars.
if [[ -n "${DATABASE_URL:-}" ]]; then
  PSQL=(psql "${DATABASE_URL}" -v ON_ERROR_STOP=1)
else
  PSQL=(psql -v ON_ERROR_STOP=1)
fi

echo "──────────────────────────────────────────────"
echo " Pending migrations (negotiation + charges)"
echo " Target : ${DATABASE_URL:-${PGHOST:-\$PGHOST}/${PGDATABASE:-\$PGDATABASE}}"
echo " Mode   : $([[ $DRY_RUN -eq 1 ]] && echo 'DRY RUN (no changes)' || echo 'APPLY')"
echo " Filter : ${ONLY_GROUP:-<all groups>}"
echo "──────────────────────────────────────────────"

ran=0
for entry in "${MIGRATIONS[@]}"; do
  group="${entry%%|*}"
  file="${entry#*|}"

  if [[ -n "$ONLY_GROUP" && "$group" != "$ONLY_GROUP" ]]; then
    continue
  fi

  path="${SCRIPT_DIR}/${file}"
  if [[ ! -f "$path" ]]; then
    echo "✗ Missing migration file: $path" >&2
    exit 1
  fi
  ran=$((ran + 1))

  if [[ $DRY_RUN -eq 1 ]]; then
    echo
    echo "===== [${group}] would run: ${file} ====="
    cat "$path"
    continue
  fi

  echo
  echo "▶ [${group}] Applying ${file} ..."
  "${PSQL[@]}" -f "$path"
  echo "✓ Done ${file}"
done

if [[ $ran -eq 0 ]]; then
  echo "No migrations matched filter '${ONLY_GROUP}'." >&2
  exit 1
fi

echo
if [[ $DRY_RUN -eq 1 ]]; then
  echo "Dry run complete — nothing was applied ($ran file(s) shown)."
else
  echo "All selected migrations applied successfully ($ran file(s))."
fi
