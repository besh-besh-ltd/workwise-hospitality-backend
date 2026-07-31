#!/usr/bin/env bash
#
# ══════════════════════════════════════════════════════════════════════════════
#  FULL ordered migration runner — stage → main (production) deploy for arc-2.0.
# ══════════════════════════════════════════════════════════════════════════════
#
# Runs, IN DEPENDENCY ORDER, every migration that hospitality_main (production)
# is missing to catch up to feat/arc-2.0. Verified 2026-07-29 by a read-only
# audit of hospitality_main vs hospitality_stage: main is a clean pre-arc-2.0
# production DB (missing 42 needed tables + 28 needed columns; the ~18 dead
# legacy columns and tbl_tender_sendback_history are intentionally NOT created).
#
# Every file is idempotent — CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT
# EXISTS, DO/IF-guarded constraints, DROP ... IF EXISTS, ON CONFLICT DO NOTHING,
# WHERE-guarded backfills — so this is safe to re-run and safe on a DB that
# already has some of the changes (e.g. the few negotiation columns that were
# ad-hoc-applied to main). Each file runs inside its own transaction and the
# whole run aborts on the first error (ON_ERROR_STOP=1).
#
# The order below is the canonical run order. DO NOT reorder: later files FK to
# tables created by earlier ones (arc_core → arc_quote → arc_contract; mr_tables
# → arc_core; multi_product_negotiation → negotiation_polymorphic; etc.).
#
# ─── Usage ──────────────────────────────────────────────────────────────────
#   Option A — full connection string:
#     DATABASE_URL="postgres://user:pass@host:5432/hospitality_main?sslmode=require" \
#       ./migrations/run_pending_migrations.sh
#
#   Option B — discrete PG* vars:
#     PGHOST=... PGPORT=5432 PGUSER=... PGPASSWORD=... PGDATABASE=hospitality_main \
#     PGSSLMODE=require ./migrations/run_pending_migrations.sh
#
#   Preview the ordered plan (touch nothing, no SQL dumped):
#     ./migrations/run_pending_migrations.sh --list
#
#   Dry run (print the full SQL that WOULD run, touch nothing):
#     ./migrations/run_pending_migrations.sh --dry-run
#
#   Apply non-interactively (CI / scripted):
#     ./migrations/run_pending_migrations.sh --yes
#
#   Run only one domain group (for re-runs on an already-migrated DB):
#     ./migrations/run_pending_migrations.sh --only negotiation
#     Groups: pre | arc | mr | rbac | negotiation | charges | mrp
#
# ⚠️  PRODUCTION: take an RDS snapshot (AWS console) AND/OR a pg_dump backup
#     BEFORE applying. Run the DB migrations FIRST, then deploy the arc-2.0 code.
# ────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Canonical ordered list. Format: "<group>|<filename>". DO NOT reorder.
MIGRATIONS=(
  # ── Phase A: pre-ARC (independent of the ARC family) ──
  "pre|2026_05_26_push_notifications.sql"
  "pre|20260526120000_add_dashboard_widget_permissions.sql"
  "pre|20260604120000_add_copied_from_rfq_id.sql"
  # ── Phase B: ARC v2 core + MR foundation ──
  "arc|20260608100000_arc_v2_drop_v1.sql"                       # DROP IF EXISTS — no-op on main
  "negotiation|20260608100100_negotiation_polymorphic.sql"      # source_type/source_id (needed by multi-product below)
  "mr|20260608100150_category_department_mapping.sql"
  "arc|20260608100200_arc_core_tables.sql"                      # tbl_arc + 11 core ARC tables
  "arc|20260608100300_arc_quote_tables.sql"
  "arc|20260608100400_arc_contract_tables.sql"
  "mr|20260608100500_mr_tables.sql"                             # depends on arc_core
  "mr|20260608100600_po_arc_backlinks.sql"
  "arc|20260608100700_approval_policies_seed.sql"               # intentional no-op placeholder
  "rbac|20260608100800_permissions_seed.sql"                    # arc/mr enums + permissions (ON CONFLICT)
  # ── Phase C: ARC amendments / eval / clarification ──
  "arc|20260609100000_arc_amendments.sql"
  "arc|20260609110000_arc_amendment_approval_chain.sql"
  "arc|20260610100000_arc_amendment_edit_history.sql"
  "rbac|20260611100000_arc_eval_read_permissions.sql"
  "arc|20260611100100_arc_tech_eval_edit_history.sql"
  "arc|20260613100000_arc_contract_clarification.sql"
  "mr|20260614100000_calloff_po_company_id_fix.sql"             # data fix (0 rows on fresh main)
  "arc|20260615100000_arc_amendment_awaiting_signature.sql"
  "arc|20260615100100_arc_amendment_document.sql"
  "arc|20260615100200_arc_otp_addendum_target.sql"
  "rbac|2026_06_16_dashboard_abc_analysis_permission.sql"
  "arc|20260618100000_arc_process_id_nullable.sql"
  "mr|20260618110000_po_product_calloff_lines.sql"
  "arc|20260620100000_arc_tech_clause_mandatory.sql"
  # ── Phase D: ARC tech/quote refinements + negotiation multi-product ──
  "arc|20260620100100_arc_tech_response_mandatory_verdict.sql"
  "arc|20260620100200_arc_quote_tech_envelope.sql"
  "arc|20260622100000_arc_vendor_alias.sql"
  "arc|20260622110000_arc_publish_approval_statuses.sql"
  "arc|20260623100000_arc_quote_terms_accepted.sql"
  "mr|20260623100000_po_auto_initiated.sql"                     # same ts as arc_quote_terms_accepted; independent
  "arc|20260623110000_arc_tech_evidence_original_name.sql"
  "negotiation|20260624100000_multi_product_negotiation_rounds.sql"  # depends on negotiation_polymorphic
  "negotiation|20260624100100_backfill_negotiation_vendor_approvals.sql"  # DML backfill
  "charges|20260624100200_backfill_quote_charges_slugs.sql"     # DML backfill
  "arc|20260625100000_arc_type_column.sql"
  # ── Phase E: ARC manual entry + late features + MRP ──
  "arc|20260626100000_arc_manual_entry.sql"
  "arc|20260626100100_arc_manual_doc_and_hsn.sql"
  "arc|20260626100200_arc_type_self_contained.sql"
  "arc|20260627100000_arc_quote_version.sql"
  "arc|20260629100000_arc_manual_backdated_dates.sql"
  "arc|20260630100000_arc_negotiation_item_link.sql"
  "arc|20260630100100_arc_quote_line_negotiated.sql"
  "arc|20260701100000_arc_number_seq.sql"
  "arc|20260705100000_arc_cap_min_passing.sql"
  "arc|20260706100000_arc_tech_shortlist.sql"
  "rbac|20260713100000_urs_process_id.sql"                      # tbl_user_role_scopes.process_id
  "arc|20260721100000_arc_universal_tech_eval.sql"              # 6 universal-tech-eval tables
  "mrp|20260724100000_mrp_quoting.sql"                          # MRP columns (14)
)

DRY_RUN=0
LIST_ONLY=0
ASSUME_YES=0
ONLY_GROUP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --list)    LIST_ONLY=1; shift ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    --only)    ONLY_GROUP="${2:-}"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Build the psql target: prefer DATABASE_URL, else rely on PG* env vars.
if [[ -n "${DATABASE_URL:-}" ]]; then
  PSQL=(psql "${DATABASE_URL}" -v ON_ERROR_STOP=1)
  TARGET_DESC="${DATABASE_URL##*@}"           # host:port/db (hides creds)
else
  PSQL=(psql -v ON_ERROR_STOP=1)
  TARGET_DESC="${PGHOST:-\$PGHOST}/${PGDATABASE:-\$PGDATABASE}"
fi

# Pre-flight: every file must exist (fail fast before touching the DB).
missing=0
for entry in "${MIGRATIONS[@]}"; do
  f="${entry#*|}"
  [[ -f "${SCRIPT_DIR}/${f}" ]] || { echo "✗ Missing migration file: ${f}" >&2; missing=1; }
done
[[ $missing -eq 0 ]] || { echo "Aborting: missing migration file(s)." >&2; exit 1; }

# --list: print the ordered plan and exit (no DB access at all).
if [[ $LIST_ONLY -eq 1 ]]; then
  echo "Ordered migration plan (${#MIGRATIONS[@]} files):"
  i=0
  for entry in "${MIGRATIONS[@]}"; do
    i=$((i + 1))
    printf "  %2d  [%-11s] %s\n" "$i" "${entry%%|*}" "${entry#*|}"
  done
  exit 0
fi

echo "──────────────────────────────────────────────────────────────"
echo " arc-2.0 stage → main : full ordered migration run"
echo " Target : ${TARGET_DESC}"
echo " Files  : ${#MIGRATIONS[@]} total   Filter: ${ONLY_GROUP:-<all groups, in order>}"
echo " Mode   : $([[ $DRY_RUN -eq 1 ]] && echo 'DRY RUN (no changes)' || echo 'APPLY')"
echo "──────────────────────────────────────────────────────────────"

# Production safety gate: require explicit confirmation before applying.
if [[ $DRY_RUN -eq 0 && $ASSUME_YES -eq 0 ]]; then
  if [[ -t 0 ]]; then
    read -r -p "About to APPLY ${#MIGRATIONS[@]} migrations to '${TARGET_DESC}'. Type APPLY to continue: " reply
    [[ "$reply" == "APPLY" ]] || { echo "Aborted (no confirmation)."; exit 1; }
  else
    echo "Refusing to apply non-interactively without --yes." >&2
    exit 1
  fi
fi

ran=0
for entry in "${MIGRATIONS[@]}"; do
  group="${entry%%|*}"
  file="${entry#*|}"

  if [[ -n "$ONLY_GROUP" && "$group" != "$ONLY_GROUP" ]]; then
    continue
  fi
  ran=$((ran + 1))
  path="${SCRIPT_DIR}/${file}"

  if [[ $DRY_RUN -eq 1 ]]; then
    echo
    echo "===== [${group}] would run: ${file} ====="
    cat "$path"
    continue
  fi

  printf "\n▶ [%-11s] Applying %s ...\n" "$group" "$file"
  "${PSQL[@]}" -f "$path"
  echo "✓ Done ${file}"
done

if [[ $ran -eq 0 ]]; then
  echo "No migrations matched filter '${ONLY_GROUP}'." >&2
  exit 1
fi

echo
if [[ $DRY_RUN -eq 1 ]]; then
  echo "Dry run complete — nothing was applied (${ran} file(s) shown)."
else
  echo "✓ All selected migrations applied successfully (${ran} file(s))."
  echo "  Next: deploy the feat/arc-2.0 code, then smoke-test (RFQ / ARC / MR / negotiation / MRP)."
fi
