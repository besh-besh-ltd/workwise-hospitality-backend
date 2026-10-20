#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Local rehearsal of the client role feedback data changes.
#
#   ./scripts/client_role_feedback/rehearse_local.sh          # build + rehearse everything
#   ./scripts/client_role_feedback/rehearse_local.sh build    # only (re)build the scratch DB
#
# LOCAL ONLY. Talks to localhost:5432 as the OS user, and only to the scratch
# database hospitality_roleterms_rehearsal, which it drops and recreates from
#   tests/setup/schema.sql + seed_reference.sql + pendingMigrations.json (in order)
#   + rehearsal/fixture.sql (prod-shaped: buyer 13, prod ids, prod counts)
# It never reads backend/.env; run.sh gets a generated env file pointing here.
#
# Then, for every step: refusals (gates, count/id mismatches, in-use, pending
# links, missing migration), DRY (database unchanged), COMMIT (exact effect),
# reconcile-report sections that must not move, DRY rollback, COMMIT rollback
# (database back to the snapshot), re-apply; finally all three rolled back in
# reverse order back to the freshly built state. Any failed check exits 1.
#
# Transcript: out/rehearsal/transcript.txt; per-run reports in out/rehearsal/<run>/.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend="$(cd "$here/../.." && pwd)"

REH_DB="hospitality_roleterms_rehearsal"
REH_HOST="localhost"
REH_PORT="5432"
REH_USER="$(id -un)"
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGSSLMODE

out="$here/out/rehearsal"
rm -rf "$out"; mkdir -p "$out"
exec > >(tee "$out/transcript.txt") 2>&1

envf="$out/rehearsal.env"
printf 'HOST=%s\nDATABASE_PORT=%s\nDATABASE_USERNAME=%s\nDATABASE_PASSWORD=\n' "$REH_HOST" "$REH_PORT" "$REH_USER" > "$envf"

lp() { local dbn="$1"; shift; psql "host=$REH_HOST port=$REH_PORT user=$REH_USER dbname=$dbn sslmode=disable" -X -q -v ON_ERROR_STOP=1 "$@"; }
q()  { lp "$REH_DB" -At -F '|' -c "$1"; }

section() { printf '\n══════ %s\n' "$*"; }
pass()    { printf '  ✓ %s\n' "$*"; }
fail()    { printf '  ✗ %s\n' "$*"; exit 1; }
check()   { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 — expected [$2], got [$1]"; fi; }

rid() { uuidgen | tr '[:upper:]' '[:lower:]'; }

# run.sh against the scratch DB; reports land in out/rehearsal/<label>/
run_label=""
run() { ENV_FILE="$envf" TARGET_DB="$REH_DB" OUT_DIR="$out/$run_label" "$here/run.sh" "$@"; }
# runs a run.sh invocation that must succeed; output kept in out/rehearsal/<label>.out
ok() {
  run_label="$1"; shift
  if ! run "$@" > "$out/$run_label.out" 2>&1; then
    tail -40 "$out/$run_label.out"; fail "$run_label: run.sh $* failed"
  fi
  pass "$run_label: run.sh $*"
}
# runs a run.sh invocation that must be REFUSED with a message matching $2
refused() {
  run_label="$1"; local pattern="$2"; shift 2
  if run "$@" > "$out/$run_label.out" 2>&1; then
    tail -40 "$out/$run_label.out"; fail "$run_label: expected a refusal ($pattern)"
  fi
  if grep -q -- "$pattern" "$out/$run_label.out"; then
    pass "$run_label refused: $(grep -m1 -o -- "$pattern.*" "$out/$run_label.out" | cut -c1-150)"
  else
    tail -40 "$out/$run_label.out"; fail "$run_label: refused, but not with: $pattern"
  fi
}
# report <label> before|after|committed|audit-before|audit-after → that run's file
report() {
  local f
  for f in "$out/$1"/*.txt; do
    if [[ "${f##*/}" =~ ^(0[0-9]|rollback0[0-9])-$2-[0-9]{8}T[0-9]{6}-[0-9a-f]{8}[.]txt$ ]]; then echo "$f"; return 0; fi
  done
  fail "no $2 report in $1"
}
# one reconcile section (R0..R8) of a report file
sect() { awk -v s="── $2 " 'index($0, s) == 1 {p = 1; print; next} /^── R[0-9] / {p = 0} /^$/ {next} p' "$1"; }
same_sections() { # same_sections <label> R2 R3 …
  local label="$1"; shift
  local b a s
  b="$(report "$label" before)"; a="$(report "$label" after)"
  for s in "$@"; do
    if diff -q <(sect "$b" "$s") <(sect "$a" "$s") > /dev/null; then
      pass "$label: reconcile $s identical before/after ($(sect "$a" "$s" | tail -1))"
    else
      diff -u <(sect "$b" "$s") <(sect "$a" "$s") | head -30; fail "$label: reconcile $s changed"
    fi
  done
}

# Everything a step or rollback may touch, in a stable order. Policies leave
# out updated_at: their BEFORE UPDATE trigger stamps it on every write,
# rollbacks included.
state() {
  q "SELECT 'proc', id, company_id, name, is_active, updated_at FROM tbl_approval_processes ORDER BY id"
  q "SELECT 'pol', id, entity_type, hospitality_company_id, hotel_id, department_id, process_id, is_active, is_master, version, created_at FROM tbl_approval_policies ORDER BY id"
  q "SELECT 'step', s.* FROM tbl_approval_policy_steps s ORDER BY id"
  q "SELECT 'inst', i.* FROM tbl_approval_instances i ORDER BY id"
  q "SELECT 'istep', s.* FROM tbl_approval_instance_steps s ORDER BY id"
  q "SELECT 'appr', a.* FROM tbl_approval_step_approvers a ORDER BY id"
  q "SELECT 'role', r.* FROM tbl_roles r ORDER BY id"
  q "SELECT 'grant', role_id, permission_id FROM tbl_role_permissions ORDER BY 2, 3"
  q "SELECT 'scope', s.* FROM tbl_user_role_scopes s ORDER BY id"
}
# the in-flight side only: every PENDING instance with its steps and approvers
pending_state() {
  q "SELECT i.id, i.status, i.current_step, i.approval_policy_id, i.policy_version, s.id, s.step_order, s.status, s.decision_rule,
            s.policy_step_id, s.added_mid_flight, s.removed_mid_flight, a.id, a.approver_user_id, a.status, a.removed_at
       FROM tbl_approval_instances i
       LEFT JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
       LEFT JOIN tbl_approval_step_approvers a ON a.approval_instance_step_id = s.id
      WHERE i.status = 'PENDING' ORDER BY i.id, s.step_order, a.id"
}
same_state() { # same_state <file> <message>
  if diff -q "$1" <(state) > /dev/null; then pass "$2"; else diff -u "$1" <(state) | head -40; fail "$2"; fi
}
snap() { state > "$out/state-$1.txt"; echo "$out/state-$1.txt"; }
no_backup_tables() {
  check "$(q "SELECT count(*) FROM pg_tables WHERE schemaname = 'ops_backup'")" "$1" "ops_backup holds $1 table(s)"
}

build_db() {
  section "build $REH_DB (schema + seed_reference + pending migrations + fixture)"
  [[ "$REH_DB" == hospitality_roleterms_rehearsal && "$REH_HOST" == localhost ]] || fail "refusing: not the local scratch DB"
  lp postgres -c "DROP DATABASE IF EXISTS $REH_DB WITH (FORCE)" -c "CREATE DATABASE $REH_DB" 2> /dev/null
  lp "$REH_DB" -f "$backend/tests/setup/schema.sql" > "$out/build.log" 2>&1
  # same as prepareTestDb.js: FKs from reference tables to tables the seed does not fill
  lp "$REH_DB" -c "ALTER TABLE tbl_approval_processes DROP CONSTRAINT IF EXISTS tbl_approval_processes_company_id_fkey;
                   ALTER TABLE tbl_approval_processes DROP CONSTRAINT IF EXISTS tbl_approval_processes_created_by_fkey;
                   ALTER TABLE tbl_charge_names DROP CONSTRAINT IF EXISTS tbl_charge_names_created_by_fkey;"
  lp "$REH_DB" -f "$backend/tests/setup/seed_reference.sql" >> "$out/build.log" 2>&1
  local m n=0
  while IFS= read -r m; do
    lp "$REH_DB" -f "$backend/$m" >> "$out/build.log" 2>&1 || { tail -5 "$out/build.log"; fail "migration $m"; }
    n=$((n + 1))
  done < <(node -e 'for (const m of require(process.argv[1]).migrations) console.log(m)' "$backend/tests/setup/pendingMigrations.json")
  lp "$REH_DB" -f "$here/rehearsal/fixture.sql" >> "$out/build.log" 2>&1 || { tail -5 "$out/build.log"; fail "fixture"; }
  pass "built: schema, seed, $n pending migration(s), fixture"
  check "$(q "SELECT string_agg(title, ',' ORDER BY title) FROM tbl_roles WHERE created_by IS NULL AND title IN ('RFQ Creator','Technical Evaluator','ARC Commercial Approver','ARC Commercial Evaluator')")" \
        "ARC Commercial Approver,ARC Commercial Evaluator,RFQ Creator,Technical Evaluator" "post-migration role titles present"
}

build_db
[[ "${1:-}" == build ]] && exit 0
S0="$(snap s0-built)"

# ─────────────────────────────────────────────────────────────────────────────
section "gates (nothing may run, nothing may change)"
run_label="gate-noenv"
if ( unset ENV_FILE; TARGET_DB="$REH_DB" "$here/run.sh" 01 ) > "$out/gate-noenv.out" 2>&1; then fail "ran without ENV_FILE"; fi
grep -q "ENV_FILE is required" "$out/gate-noenv.out" && pass "refused without ENV_FILE"
if ( ENV_FILE="$envf" "$here/run.sh" 01 ) > "$out/gate-nodb.out" 2>&1; then fail "ran without TARGET_DB"; fi
grep -q "TARGET_DB is required" "$out/gate-nodb.out" && pass "refused without TARGET_DB"
refused gate-commit-noconfirm "requires CONFIRM_DB" 01 --commit
CONFIRM_DB=hospitality_main refused gate-commit-wrongdb "but the connection resolved to $REH_DB" 01 --commit
refused gate-locked-var "cannot be set" 01 -v buyer_company_id=90
refused gate-bad-arg "unknown argument" 01 --force
CONFIRM_DB="$REH_DB" refused gate-dry-commit "--dry and --commit together" 01 --dry --commit
refused gate-bad-count "does not match" 02 -v "expected_dead_level_policies=53; DROP TABLE tbl_roles"
refused gate-bad-ids "does not match" 01 -v "expected_unused_policy_ids={8,190}) OR (1=1"
refused gate-bad-breakdown "does not match" 02 -v "expected_dead_level_breakdown=RFQ=25'--"
refused gate-bad-uuid "does not match" 99_rollback_01 -v rollback_request_id=not-a-uuid
same_state "$S0" "database unchanged by the refused runs"

section "reconcile (read-only)"
ok reconcile-s0 reconcile
grep -q "session read-only: on" "$out/reconcile-s0.out" && pass "reconcile session ran with transaction_read_only = on"
if PGOPTIONS='-c default_transaction_read_only=on' lp "$REH_DB" -c "UPDATE tbl_approval_processes SET name = name WHERE id = 2" > "$out/ro.out" 2>&1; then
  fail "a write succeeded under default_transaction_read_only"
fi
grep -q "read-only transaction" "$out/ro.out" && pass "default_transaction_read_only rejects writes (the mode reconcile runs in)"
for s in R0 R1 R2 R3 R4 R5 R6 R7 R8; do grep -q "^── $s " "$out/reconcile-s0.out" || fail "reconcile lacks $s"; done
ok reconcile-filtered reconcile -v "target_policies={1001,1003}"
check "$(sect "$out/reconcile-filtered.out" R0 | tail -1)" "(2 rows)" "reconcile -v target_policies narrows the report to those policies"
pass "report has sections R0-R8; coherence audit appended ($(grep -c 'BLIND APPROVER\|POLICY RESOLVES TO NOBODY\|NOBODY CAN APPROVE' "$out/reconcile-s0.out") audit row(s))"

# ─────────────────────────────────────────────────────────────────────────────
section "step 01 · deactivate unused processes + policies"
ok 01-dry 01
grep -q "matcher snapshot unchanged" "$out/01-dry.out" && pass "matcher snapshot equal (dry)"
grep -q "ROLLED BACK (dry run)" "$out/01-dry.out" && pass "dry run ended in ROLLBACK"
pass "$(grep -m1 -o 'transaction open [0-9.]* s' "$out/01-dry.out") (01 DRY, row locks held from the preflight to the end)"
if grep -q "RBAC COHERENCE AUDIT" "$(report 01-dry before)" "$(report 01-dry after)"; then fail "the audit ran inside the write transaction"; fi
grep -q "RBAC COHERENCE AUDIT" "$(report 01-dry audit-before)" && pass "coherence audit ran in its own read-only session, not in the write transaction"
grep -q "a DRY run changes nothing, so there is no after" "$out/01-dry.out" && pass "DRY: no post-run audit (nothing committed)"
same_state "$S0" "01 DRY left the database unchanged"
no_backup_tables 0

refused 01-wrong-ids "unused policies of buyer 13 are {8,190,191,192,193}" 01 -v expected_unused_policies=4 -v "expected_unused_policy_ids={8,190,191,192}"
q "INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, process_id) VALUES (99, 9102, 4, 3, 11, 9)" > /dev/null
refused 01-in-use "are in use" 01
q "DELETE FROM tbl_user_role_scopes WHERE id = 99" > /dev/null
same_state "$S0" "database unchanged by the refusals"

RID01A="$(rid)"
REQUEST_ID="$RID01A" CONFIRM_DB="$REH_DB" ok 01-commit 01 --commit
check "$(q "SELECT string_agg(id::text, ',' ORDER BY id) FROM tbl_approval_processes WHERE NOT is_active")" "6,8,9,11" \
      "inactive processes = seeded 6 + 8,9,11 (buyer-90 'RFQ Approval' 12 untouched)"
check "$(q "SELECT string_agg(id::text, ',' ORDER BY id) FROM tbl_approval_policies WHERE NOT is_active")" "8,190,191,192,193,1002" \
      "inactive policies = 8,190-193 (+ fixture's already-inactive 1002)"
check "$(q "SELECT count(*) FROM tbl_audit_row_changes WHERE request_id = '$RID01A' AND actor_user_id = 150 AND operation = 'UPDATE'")" "8" \
      "8 row updates audited with actor 150 + request id"
check "$(q "SELECT count(*) || ' ' || string_agg(DISTINCT phase, '/') FROM ops_backup._bak_01_${RID01A:0:8}")" "16 after/before" "backup holds 8 before + 8 after images"
grep -q "post-commit report (fresh read-only session) equals" "$out/01-commit.out" && pass "post-commit report = in-transaction after-report"
grep -q "^-F. NOBODY CAN APPROVE IN THIS DEPARTMENT | 192 | NEGOTIATION" "$out/01-commit.out" \
  && pass "audit diff (read-only before → after commit) drops the section-F rows of deactivated policy 192"
same_sections 01-commit R2 R3 R4 R5 R6 R7
S01A="$(snap s01a)"
REQUEST_ID="$(rid)" CONFIRM_DB="$REH_DB" refused 01-rerun "(already applied?)" 01 --commit

ok rb01-dry 99_rollback_01 -v rollback_request_id="$RID01A"
same_state "$S01A" "rollback 01 DRY left the database unchanged"
refused rb01-norid "rollback needs the request id" 99_rollback_01
CONFIRM_DB="$REH_DB" ok rb01-commit 99_rollback_01 --commit -v rollback_request_id="$RID01A"
same_state "$S0" "rollback 01 restored the built state exactly (incl. process updated_at)"

RID01="$(rid)"
REQUEST_ID="$RID01" CONFIRM_DB="$REH_DB" ok 01-reapply 01 --commit
S1="$(snap s1-after-01)"

# ─────────────────────────────────────────────────────────────────────────────
section "step 02 · remove dead RFQ Creator / Technical Evaluator levels"
pending_state > "$out/pending-before-02.txt"
ok 02-dry 02
grep -q "53 polic" "$out/02-dry.out" && pass "02 found 53 dead-level policies: $(grep -m1 -o 'RFQ=[0-9]*,TECHNICAL=[0-9]*,TENDER=[0-9]*' "$out/02-dry.out")"
same_state "$S1" "02 DRY left the database unchanged"
same_sections 02-dry R2 R3 R5 R6 R7
no_backup_tables 2   # 01 first run (rolled back; backups are kept) + 01 re-apply

refused 02-wrong-count "expected 52" 02 -v expected_dead_level_policies=52
q "UPDATE tbl_approval_instance_steps SET policy_step_id = 10011 WHERE id = 7101" > /dev/null
refused 02-pending-link "PENDING instance" 02
q "UPDATE tbl_approval_instance_steps SET policy_step_id = 10012 WHERE id = 7101" > /dev/null
q "INSERT INTO tbl_approval_policies (id, entity_type, hospitality_company_id, hotel_id, process_id, is_active, created_by) VALUES (1999, 'RFQ', 3, 4, 2, false, 150);
   INSERT INTO tbl_approval_policy_steps (id, approval_policy_id, step_order, approver_source_type, approver_source_id) VALUES (19991, 1999, 1, 'ROLE', 2)" > /dev/null
refused 02-empty-policy "no level left" 02 -v expected_dead_level_policies=54 -v expected_dead_level_breakdown=RFQ=26,TECHNICAL=27,TENDER=1
q "DELETE FROM tbl_approval_policy_steps WHERE id = 19991; DELETE FROM tbl_approval_policies WHERE id = 1999" > /dev/null
q "INSERT INTO tbl_approval_policies (id, entity_type, hospitality_company_id, hotel_id, process_id, is_active, created_by) VALUES (1998, 'RFQ', 3, 4, 2, false, 150);
   INSERT INTO tbl_approval_policy_steps (id, approval_policy_id, step_order, approver_source_type, approver_source_id) VALUES
     (19981, 1998, 1, 'ROLE', 2), (19982, 1998, 2, 'ROLE', 6), (19983, 1998, 3, 'ROLE', 4)" > /dev/null
refused 02-two-dead-levels "policies 1998 carry more than one dead level" 02 -v expected_dead_level_policies=54 -v expected_dead_level_breakdown=RFQ=26,TECHNICAL=27,TENDER=1
q "DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = 1998; DELETE FROM tbl_approval_policies WHERE id = 1998" > /dev/null
same_state "$S1" "database unchanged by the refusals"

# History linking a dead level (prod: 0, pinned in data.sql). Refused by
# default; allowed by an explicit override, NULLed by the FK, backed up, and
# restored by the rollback. Then the history row is removed again.
q "INSERT INTO tbl_approval_instances (id, entity_type, entity_id, approval_policy_id, status, current_step, hospitality_company_id, hotel_id, initiated_by, process_id, created_at, completed_at)
     VALUES (7004, 'RFQ', 5004, 1002, 'APPROVED', 2, 3, 4, 9101, 2, '2026-02-02 09:00', '2026-02-03 09:00');
   INSERT INTO tbl_approval_instance_steps (id, approval_instance_id, policy_step_id, step_order, decision_rule, status, completed_at) VALUES
     (7104, 7004, 10021, 1, 'ANY', 'APPROVED', '2026-02-02 12:00'), (7105, 7004, 10022, 2, 'ANY', 'APPROVED', '2026-02-03 09:00');
   INSERT INTO tbl_approval_step_approvers (id, approval_instance_step_id, approver_user_id, status, acted_at) VALUES
     (7205, 7104, 9101, 'APPROVED', '2026-02-02 12:00'), (7206, 7105, 9102, 'APPROVED', '2026-02-03 09:00')" > /dev/null
SH="$(snap s1-with-history)"
refused 02-history-unexpected "found 1 historical instance step link(s) to the levels being removed, expected 0" 02
RID02H="$(rid)"
REQUEST_ID="$RID02H" CONFIRM_DB="$REH_DB" ok 02-history-commit 02 --commit -v expected_dead_level_history_links=1
check "$(q "SELECT COALESCE(policy_step_id::text, 'NULL') FROM tbl_approval_instance_steps WHERE id = 7104")" "NULL" \
      "with the override: historical step 7104's link to the deleted level NULLed by the FK"
check "$(q "SELECT string_agg(phase || ':' || COALESCE(row_data->>'policy_step_id', 'NULL'), ' ' ORDER BY phase DESC) FROM ops_backup._bak_02_${RID02H:0:8} WHERE src_table = 'tbl_approval_instance_steps'")" \
      "before:10021 after:NULL" "…and backed up (before-image keeps the link)"
CONFIRM_DB="$REH_DB" ok rb02-history 99_rollback_02 --commit -v rollback_request_id="$RID02H"
same_state "$SH" "rollback 02 restored 7104's link along with the levels"
q "DELETE FROM tbl_approval_instances WHERE id = 7004" > /dev/null
same_state "$S1" "history row removed again: back to the post-01 state"

RID02A="$(rid)"
REQUEST_ID="$RID02A" CONFIRM_DB="$REH_DB" ok 02-commit 02 --commit
check "$(q "SELECT count(*) FROM tbl_approval_policy_steps s JOIN tbl_approval_policies p ON p.id = s.approval_policy_id
             JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
            WHERE hc.buyer_company_id = 13 AND s.approver_source_type = 'ROLE' AND s.approver_source_id IN (2, 6)")" "0" \
      "no RFQ Creator / Technical Evaluator level left on buyer 13"
check "$(q "SELECT string_agg(approval_policy_id || ':' || step_order || ':' || id, ' ' ORDER BY id) FROM tbl_approval_policy_steps WHERE approval_policy_id IN (190, 191, 1001, 1003, 1101, 1102)")" \
      "190:1:1902 191:1:1912 1001:1:10012 1003:1:10032 1003:2:10033 1101:1:11012 1102:1:11021" \
      "survivors renumbered in place, ids preserved (incl. a dead level at the END of 1102)"
check "$(q "SELECT string_agg(approval_policy_id || ':' || approver_source_id, ' ' ORDER BY id) FROM tbl_approval_policy_steps WHERE approval_policy_id IN (1204, 9001)")" \
      "1204:9201 1204:4 9001:2 9001:4" "tenant 'RFQ Creator' policy 1204 and buyer-90 policy 9001 untouched"
check "$(q "SELECT string_agg(id || '=' || version, ' ' ORDER BY id) FROM tbl_approval_policies WHERE id IN (190, 1001, 1002, 1204)")" \
      "190=2 1001=4 1002=2 1204=1" "version bumped by 1 on targets only"
check "$(q "SELECT count(*) || '/' || count(*) FILTER (WHERE changed_by = 150 AND affected_instance_ids = '{}') FROM tbl_approval_policy_change_log
             WHERE change_type = 'SCRIPT_REMOVE_DEAD_LEVEL' AND change_summary->>'request_id' = '$RID02A'")" "53/53" \
      "53 change-log rows, changed_by 150, affected_instance_ids '{}'"
check "$(q "SELECT change_summary->'removed_step'->>'id' || ' ' || (change_summary->'renumbered')::text FROM tbl_approval_policy_change_log
             WHERE approval_policy_id = 1003 AND change_summary->>'request_id' = '$RID02A'")" \
      '10031 [{"id": 10032, "to": 1, "from": 2}, {"id": 10033, "to": 2, "from": 3}]' "change log of 1003 names the removed step and the renumbering"
if diff -u "$out/pending-before-02.txt" <(pending_state); then
  pass "PENDING instances byte-identical: steps, approvers, statuses, current_step, links ($(wc -l < "$out/pending-before-02.txt" | tr -d ' ') rows)"
else fail "PENDING instances changed"; fi
check "$(q "SELECT string_agg(s.id || '->' || s.policy_step_id || '@' || ps.step_order, ' ' ORDER BY s.id) FROM tbl_approval_instance_steps s
             JOIN tbl_approval_policy_steps ps ON ps.id = s.policy_step_id WHERE s.id IN (7101, 7106, 7107, 7108, 7109, 7111)")" \
      "7101->10012@1 7106->10032@1 7107->10033@2 7108->11012@1 7109->11021@1 7111->10012@1" \
      "linked PENDING steps still point at the same rows, now at their own step_order"
same_sections 02-commit R2 R3 R5 R6 R7
check "$(sect "$(report 02-commit before)" R4 | tail -1) → $(sect "$(report 02-commit after)" R4 | tail -1)" "(51 rows) → (0 rows)" \
      "R4 order offsets (instance step_order vs linked policy step) all resolved"
grep -q "post-commit report (fresh read-only session) equals" "$out/02-commit.out" && pass "post-commit report = in-transaction after-report"
pass "$(grep -m1 -o 'transaction open [0-9.]* s' "$out/02-commit.out") (02 COMMIT, 53 policies)"
S2A="$(snap s02a)"
q "UPDATE tbl_approval_policy_steps SET decision_rule = 'ALL' WHERE id = 10042" > /dev/null
refused rb02-drift "rows changed since step 02 ran" 99_rollback_02 -v rollback_request_id="$RID02A"
q "UPDATE tbl_approval_policy_steps SET decision_rule = 'ANY' WHERE id = 10042" > /dev/null

ok rb02-dry 99_rollback_02 -v rollback_request_id="$RID02A"
same_state "$S2A" "rollback 02 DRY left the database unchanged"
CONFIRM_DB="$REH_DB" ok rb02-commit 99_rollback_02 --commit -v rollback_request_id="$RID02A"
same_state "$S1" "rollback 02 restored the post-01 state exactly (steps, ids, orders, versions)"
check "$(q "SELECT count(*) FROM tbl_approval_policy_change_log WHERE change_type = 'SCRIPT_ROLLBACK_REMOVE_DEAD_LEVEL' AND change_summary->>'rolled_back_request_id' = '$RID02A'")" "53" \
      "rollback logged one change-log row per policy"

RID02="$(rid)"
REQUEST_ID="$RID02" CONFIRM_DB="$REH_DB" ok 02-reapply 02 --commit
S2="$(snap s2-after-02)"

# ─────────────────────────────────────────────────────────────────────────────
section "step 03 · ARC round approval by peer evaluators (policy 221)"
q "DELETE FROM tbl_role_permissions WHERE role_id = 24 AND permission_id IN (SELECT id FROM tbl_permissions WHERE resource::text = 'arc-comm' AND action::text = 'approve')" > /dev/null
refused 03-no-migration "20261019100200" 03
for _ in 1 2; do lp "$REH_DB" -f "$backend/migrations/20261019100200_arc_commercial_evaluator_round_approval.sql" > /dev/null; done
check "$(q "SELECT count(*) FROM tbl_role_permissions rp JOIN tbl_permissions p ON p.id = rp.permission_id WHERE rp.role_id = 24 AND p.resource::text = 'arc-comm' AND p.action::text = 'approve'")" "1" \
      "migration 20261019100200 re-applied twice → exactly one grant (idempotent)"
same_state "$S2" "state back to post-02 after the migration round-trip"
q "INSERT INTO tbl_approval_instances (id, entity_type, entity_id, approval_policy_id, status, current_step, hospitality_company_id, hotel_id, initiated_by) VALUES (7020, 'ARC_NEGOTIATION', 8002, 221, 'PENDING', 1, 5, 6, 9108)" > /dev/null
refused 03-pending "PENDING" 03
q "DELETE FROM tbl_approval_instances WHERE id = 7020" > /dev/null
q "UPDATE tbl_user_role_scopes SET hotel_id = 4, company_id = 3 WHERE id IN (8, 9)" > /dev/null
refused 03-no-evaluator "nobody holds" 03
q "UPDATE tbl_user_role_scopes SET hotel_id = 6, company_id = 5 WHERE id IN (8, 9)" > /dev/null
same_state "$S2" "database unchanged by the refusals"

ok 03-dry 03
same_state "$S2" "03 DRY left the database unchanged"
RID03A="$(rid)"
REQUEST_ID="$RID03A" CONFIRM_DB="$REH_DB" ok 03-commit 03 --commit
check "$(q "SELECT id || ':' || approval_policy_id || ':' || step_order || ':' || approver_source_type || ':' || approver_source_id || ':' || decision_rule FROM tbl_approval_policy_steps WHERE approval_policy_id = 221")" \
      "2211:221:1:ROLE:24:ALL" "step 2211 updated in place → ARC Commercial Evaluator, rule ALL"
check "$(q "SELECT string_agg(s.approval_policy_id || ':' || s.approver_source_id || ':' || s.decision_rule, ' ' ORDER BY s.id) FROM tbl_approval_policy_steps s WHERE s.approval_policy_id IN (1301, 9002)")" \
      "1301:30:ANY 1301:24:ALL 9002:30:ANY" "two-step ARC policy 1301 and buyer-90 policy 9002 untouched"
check "$(q "SELECT version FROM tbl_approval_policies WHERE id = 221")" "2" "policy 221 version bumped"
check "$(q "SELECT count(*) FROM tbl_approval_policy_change_log WHERE change_type = 'SCRIPT_ARC_ROUND_PEER_APPROVAL' AND change_summary->>'request_id' = '$RID03A' AND changed_by = 150")" "1" \
      "one change-log row"
same_sections 03-commit R2 R3 R4 R5 R6 R7
S3A="$(snap s03a)"
q "INSERT INTO tbl_approval_instances (id, entity_type, entity_id, approval_policy_id, status, current_step, hospitality_company_id, hotel_id, initiated_by) VALUES (7021, 'ARC_NEGOTIATION', 8003, 221, 'PENDING', 1, 5, 6, 9108)" > /dev/null
refused rb03-pending "has PENDING instance 7021" 99_rollback_03 -v rollback_request_id="$RID03A"
q "DELETE FROM tbl_approval_instances WHERE id = 7021" > /dev/null
ok rb03-dry 99_rollback_03 -v rollback_request_id="$RID03A"
same_state "$S3A" "rollback 03 DRY left the database unchanged"
CONFIRM_DB="$REH_DB" ok rb03-commit 99_rollback_03 --commit -v rollback_request_id="$RID03A"
same_state "$S2" "rollback 03 restored the post-02 state exactly"
RID03="$(rid)"
REQUEST_ID="$RID03" CONFIRM_DB="$REH_DB" ok 03-reapply 03 --commit

# ─────────────────────────────────────────────────────────────────────────────
section "everything rolled back in reverse order"
CONFIRM_DB="$REH_DB" ok rb03-final 99_rollback_03 --commit -v rollback_request_id="$RID03"
same_state "$S2" "after rollback 03 = post-02"
CONFIRM_DB="$REH_DB" refused rb01-out-of-order "rows changed since step 01 ran" 99_rollback_01 --commit -v rollback_request_id="$RID01"
same_state "$S2" "an out-of-order rollback (01 while 02 is applied) changed nothing"
CONFIRM_DB="$REH_DB" ok rb02-final 99_rollback_02 --commit -v rollback_request_id="$RID02"
same_state "$S1" "after rollback 02 = post-01"
CONFIRM_DB="$REH_DB" ok rb01-final 99_rollback_01 --commit -v rollback_request_id="$RID01"
same_state "$S0" "after rollback 01 = the freshly built database"

section "lint"
bash -n "$here/run.sh" "$here/rehearse_local.sh" && pass "bash -n"
if command -v shellcheck > /dev/null; then shellcheck "$here/run.sh" "$here/rehearse_local.sh" && pass "shellcheck clean"; fi

section "REHEARSAL PASSED"
