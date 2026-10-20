#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Runner for the client role feedback data changes
# (backend/scripts/client_role_feedback) — LIVE CLIENT configuration changes.
#
#   ENV_FILE=… TARGET_DB=<db> ./run.sh reconcile [-v target_policies='{1,2}']
#   ENV_FILE=… TARGET_DB=<db> ./run.sh <step> [-v name=value …]                 # DRY
#   ENV_FILE=… TARGET_DB=<db> CONFIRM_DB=<db> ./run.sh <step> --commit [-v …]   # real
#
#   <step>  01 | 02 | 03 | 99_rollback_01 | 99_rollback_02 | 99_rollback_03
#           (a rollback needs -v rollback_request_id=<request id of the run to undo>)
#
# DRY IS THE DEFAULT. A step runs in ONE transaction (REPEATABLE READ) that
# ends in ROLLBACK unless BOTH --commit is given AND CONFIRM_DB names the
# database the connection actually resolved to (SELECT current_database()).
# Inside that transaction, in this order:
#     data.sql → reconcile report + RBAC coherence audit  → out/<step>-before-<ts>.txt
#     the step (preflight · backup · change · postchecks)
#     reconcile report + RBAC coherence audit             → out/<step>-after-<ts>.txt
#     ROLLBACK | COMMIT
# then the before/after diff is printed. Both reports read the same snapshot
# plus the step's own writes, so the diff is exactly what the step changed
# (or, DRY, would change). After a COMMIT the report is re-run in a fresh
# read-only session and compared with the in-transaction after-report.
#
# `reconcile` is always read-only: default_transaction_read_only=on.
#
# Every write is stamped for the audit trigger (tbl_audit_row_changes) with
# app.actor_id (data.sql) and app.request_id = the request id printed in the
# header (REQUEST_ID=… to choose it; otherwise a fresh uuid per run). Backups
# go to ops_backup._bak_<step>_<first 8 hex of the request id>.
#
# Connection: HOST / DATABASE_PORT / DATABASE_USERNAME / DATABASE_PASSWORD are
# read from ENV_FILE (never sourced). The database is NOT read from it —
# backend/.env's DATABASE_NAME points at stage — it must be named in TARGET_DB.
# sslmode: PGSSLMODE if set, else disable for a local host, require otherwise.
# OUT_DIR overrides the report directory (default: ./out, git-ignored).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
audit_sql="$(cd "$here/.." && pwd)/audit_approval_rbac_coherence.sql"

die()   { echo "run.sh: $*" >&2; exit 2; }
usage() { sed -n '5,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

[[ $# -ge 1 ]] || usage
target="$1"; shift

commit=0
psql_vars=()
while (($#)); do
  case "$1" in
    --commit) commit=1 ;;
    --dry)    ;;                                   # the default; accepted for clarity
    -v)       [[ $# -ge 2 ]] || die "-v needs name=value"; psql_vars+=("-v" "$2"); shift ;;
    -v?*)     psql_vars+=("$1") ;;
    *)        die "unknown argument: $1 (only --commit, --dry and -v name=value are accepted)" ;;
  esac
  shift
done
for v in ${psql_vars[@]+"${psql_vars[@]}"}; do
  [[ "$v" == "-v" ]] && continue
  v="${v#-v}"
  [[ "$v" =~ ^[a-z_]+=.*$ ]] || die "bad -v value: $v"
  case "${v%%=*}" in
    expected_unused_processes|expected_unused_process_ids|expected_kept_process_id|\
    expected_unused_policies|expected_unused_policy_ids|expected_dead_level_policies|\
    expected_dead_level_breakdown|expected_arc_round_policies|expected_arc_round_policy_ids|\
    target_policies|rollback_request_id) ;;
    *) die "-v ${v%%=*} cannot be overridden (allowed: the expected_* names in data.sql, target_policies, rollback_request_id)" ;;
  esac
done

case "$target" in
  reconcile)                                         step="reconcile" ;;
  01|01_deactivate_unused|01_deactivate_unused.sql)  step="01_deactivate_unused" ;;
  02|02_remove_dead_levels|02_remove_dead_levels.sql) step="02_remove_dead_levels" ;;
  03|03_arc_round_peer_approval|03_arc_round_peer_approval.sql) step="03_arc_round_peer_approval" ;;
  99_rollback_01|99_rollback_01.sql)                 step="99_rollback_01" ;;
  99_rollback_02|99_rollback_02.sql)                 step="99_rollback_02" ;;
  99_rollback_03|99_rollback_03.sql)                 step="99_rollback_03" ;;
  *) usage ;;
esac
if [[ "$step" == reconcile ]] && ((commit)); then die "reconcile is read-only; --commit makes no sense"; fi

# ── connection ──────────────────────────────────────────────────────────────
envf="${ENV_FILE:-}"
[[ -n "$envf" ]] || die "ENV_FILE is required (file with HOST, DATABASE_PORT, DATABASE_USERNAME, DATABASE_PASSWORD)"
[[ -f "$envf" ]] || die "no env file at $envf"
getv() { { grep -E "^$1=" "$envf" || true; } | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }

db="${TARGET_DB:-}"
[[ -n "$db" ]] || die "TARGET_DB is required (the database to connect to; it is never taken from ENV_FILE)"
[[ "$db" =~ ^[A-Za-z0-9_]+$ ]] || die "TARGET_DB looks wrong: $db"
host="$(getv HOST)"; port="$(getv DATABASE_PORT)"; user="$(getv DATABASE_USERNAME)"
[[ -n "$host" && -n "$user" ]] || die "ENV_FILE has no HOST / DATABASE_USERNAME"
port="${port:-5432}"
if [[ -n "${PGSSLMODE:-}" ]]; then sslmode="$PGSSLMODE"
elif [[ "$host" == localhost || "$host" == 127.0.0.1 || "$host" == ::1 || "$host" == /* ]]; then sslmode="disable"
else sslmode="require"; fi

# nothing from the caller's environment may redirect or reconfigure the session
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGSERVICE PGSERVICEFILE PGOPTIONS PGTARGETSESSIONATTRS
PGPASSWORD="$(getv DATABASE_PASSWORD)"
export PGPASSWORD
conn="host=$host port=$port user=$user dbname=$db sslmode=$sslmode application_name=client_role_feedback"
psql_base=(psql "$conn" -X -q -P pager=off -v ON_ERROR_STOP=1)

read -r resolved_db server_addr < <(
  PGOPTIONS='-c default_transaction_read_only=on' "${psql_base[@]}" -At -F ' ' \
    -c "SELECT current_database(), COALESCE(host(inet_server_addr()), 'local-socket')"
) || die "could not connect to $host:$port/$db"
[[ -n "${resolved_db:-}" ]] || die "could not resolve current_database()"

request_id="${REQUEST_ID:-$( (uuidgen 2> /dev/null || cat /proc/sys/kernel/random/uuid) | tr '[:upper:]' '[:lower:]')}"
[[ "$request_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "REQUEST_ID is not a lowercase uuid: $request_id"

if [[ "$step" == reconcile ]]; then mode="READ-ONLY"
elif ((commit)); then mode="COMMIT"
else mode="DRY (ends in ROLLBACK)"; fi

echo "══ client_role_feedback"
echo "   host      $host:$port (server $server_addr, sslmode $sslmode)"
echo "   database  $resolved_db"
echo "   step      $step"
echo "   mode      $mode"
echo "   request   $request_id"
for v in ${psql_vars[@]+"${psql_vars[@]}"}; do
  [[ "$v" == "-v" ]] && continue
  v="${v#-v}"
  case "${v%%=*}" in
    rollback_request_id) echo "   undoes    request ${v#*=}" ;;
    target_policies)     echo "   policies  ${v#*=}" ;;
    *)                   echo "   OVERRIDE  $v   (data.sql expectation replaced on the command line)" ;;
  esac
done

if ((commit)); then
  [[ -n "${CONFIRM_DB:-}" ]] || die "--commit requires CONFIRM_DB=<database name> — refusing (nothing was run)"
  [[ "$CONFIRM_DB" == "$resolved_db" ]] || die "CONFIRM_DB=$CONFIRM_DB but the connection resolved to $resolved_db — refusing (nothing was run)"
fi

out_dir="${OUT_DIR:-$here/out}"
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
[[ "$here$out_dir$audit_sql" != *"'"* ]] || die "paths must not contain a single quote"
ts="$(date +%Y%m%dT%H%M%S)-${request_id:0:8}"
tag="${step%%_*}"; [[ "$step" == 99_rollback_* ]] && tag="rollback${step##*_}"
[[ "$step" == reconcile ]] && tag="reconcile"

# ── reconcile (read-only) ───────────────────────────────────────────────────
if [[ "$step" == reconcile ]]; then
  report="$out_dir/reconcile-$ts.txt"
  PGOPTIONS='-c default_transaction_read_only=on' "${psql_base[@]}" ${psql_vars[@]+"${psql_vars[@]}"} -v vars_only=1 \
    -c "SELECT 'session read-only: ' || current_setting('transaction_read_only') AS mode" \
    -f "$here/data.sql" -f "$here/reconcile_report.sql" -f "$audit_sql" -o "$report"
  cat "$report"
  echo "── written to $report"
  exit 0
fi

# ── a step, in one transaction ──────────────────────────────────────────────
before="$out_dir/$tag-before-$ts.txt"
after="$out_dir/$tag-after-$ts.txt"
committed="$out_dir/$tag-committed-$ts.txt"
log="$out_dir/$tag-run-$ts.log"
expected_db="$resolved_db"; ((commit)) && expected_db="$CONFIRM_DB"

wrapper="$(mktemp "${TMPDIR:-/tmp}/client_role_feedback.XXXXXX")"
trap 'rm -f "$wrapper"' EXIT
if ((commit)); then finish='COMMIT;'; finish_note='COMMITTED'
else finish='ROLLBACK;'; finish_note='ROLLED BACK (dry run)'; fi
# psql meta-commands, one per line; paths are absolute and contain no quotes
printf '%s\n' \
  '\set ON_ERROR_STOP on' \
  "\\set request_id '$request_id'" \
  "\\set expected_db '$expected_db'" \
  'BEGIN ISOLATION LEVEL REPEATABLE READ;' \
  "SET LOCAL lock_timeout = '5s';" \
  "SET LOCAL statement_timeout = '300s';" \
  "\\ir '$here/data.sql'" \
  "\\o '$before'" \
  "\\ir '$here/reconcile_report.sql'" \
  "\\ir '$audit_sql'" \
  '\o' \
  "\\echo '════ $step'" \
  "\\ir '$here/$step.sql'" \
  "\\o '$after'" \
  "\\ir '$here/reconcile_report.sql'" \
  "\\ir '$audit_sql'" \
  '\o' \
  "$finish" \
  "\\echo '════ $finish_note'" \
  > "$wrapper"

set +e
"${psql_base[@]}" ${psql_vars[@]+"${psql_vars[@]}"} -f "$wrapper" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
set -e
if ((rc != 0)); then
  if grep -q '^════ COMMITTED$' "$log"; then
    echo "── psql exit $rc AFTER the commit was acknowledged — the change IS committed. Log: $log" >&2
  else
    echo "── FAILED (psql exit $rc) before COMMIT: the transaction was rolled back, nothing changed. Log: $log" >&2
  fi
  exit "$rc"
fi

echo
echo "── reconcile diff (before → after$( ((commit)) || echo ', dry' )): $before → $after"
diff -u "$before" "$after" | sed '1,2d' || true
diff -q "$before" "$after" > /dev/null && echo "   (no differences)"

if ((commit)); then
  PGOPTIONS='-c default_transaction_read_only=on' "${psql_base[@]}" ${psql_vars[@]+"${psql_vars[@]}"} -v vars_only=1 \
    -f "$here/data.sql" -f "$here/reconcile_report.sql" -f "$audit_sql" -o "$committed"
  if diff -q "$after" "$committed" > /dev/null; then
    echo "── post-commit report (fresh read-only session) equals the in-transaction after-report"
  else
    echo "── post-commit report differs from the in-transaction after-report (concurrent activity?):"
    diff -u "$after" "$committed" | sed '1,2d' || true
  fi
fi
echo "── log $log"
echo "── request id $request_id"
