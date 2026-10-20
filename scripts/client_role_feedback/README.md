# Client role feedback — data changes (buyer 13)

Three one-off configuration changes for the client (buyer `tbl_company` 13), each
with a backup, a rollback, and a before/after reconciliation of every in-flight
approval. Plan: `docs/superpowers/plans/2026-10-19-client-role-feedback-plan.md`
(D4 and 4a) and the implementation plan's Task 8.

| Step | Changes | Expected (prod, verified 2026-10-19) |
|---|---|---|
| `01_deactivate_unused.sql` | `is_active = false` on the buyer's processes 'RFQ Approval', 'RFQ Approval Matrix', 'Unit ARC', and on every active buyer policy on them or of type TENDER with no instance ever | processes **8, 9, 11**; policies **8, 190, 191, 192, 193**; process 2 'Day to Day Procurement' kept |
| `02_remove_dead_levels.sql` | DELETE the dead 'RFQ Creator' / 'Technical Evaluator' level of each buyer policy (active or not), renumber the later levels **in place** (ids kept), change-log row `SCRIPT_REMOVE_DEAD_LEVEL`, version + 1 | **53** policies = RFQ 25 + TECHNICAL 27 + TENDER 1 (≈; re-counted, must match) |
| `03_arc_round_peer_approval.sql` | the single ROLE step 'ARC Commercial Approver' of the buyer's ARC_NEGOTIATION / ARC_GROUP_NEGOTIATION policies → 'ARC Commercial Evaluator', rule ALL, **same row**; change-log row `SCRIPT_ARC_ROUND_PEER_APPROVAL`, version + 1 | policy **221** (Orchid Mumbai, step role 32 → 29) |

All expectations live in `data.sql`. A preflight that finds anything else refuses.

## Order and prerequisites

1. Migrations `20261019100000_client_role_terminology`, `20261019100100_retire_proxy_approver`,
   `20261019100200_arc_commercial_evaluator_round_approval` are applied to the target DB
   (03 refuses without the last one; 03 also needs the 'ARC Commercial Approver' title).
2. `01` → `02` → `03`. They are independent (02 counts inactive policies, so it does not
   care whether 01 ran), but this is the order they were rehearsed in.
3. Rollbacks in REVERSE order (`99_rollback_03` → `_02` → `_01`). 02 edits policies 190/191
   that 01 deactivated, so rolling 01 back while 02 is applied refuses (drift), by design.

## Gates

- **DRY is the default.** Each step runs in one `REPEATABLE READ` transaction that ends in
  `ROLLBACK` unless BOTH `--commit` is passed AND `CONFIRM_DB` equals the database the
  connection resolved to (`SELECT current_database()`). Otherwise nothing runs.
- `run.sh reconcile` is always read-only (`default_transaction_read_only=on`).
- Every run prints host, database, step, mode and request id first.
- Writes are attributed in `tbl_audit_row_changes` (`app.actor_id` = 150, `app.request_id`
  = the run's request id): `SELECT * FROM tbl_audit_row_changes WHERE request_id = '<id>'`.
- `-v name=value` may only replace the `expected_*` values of `data.sql` (printed as
  `OVERRIDE`), `target_policies` (report filter) or `rollback_request_id`. Override an
  expectation only after a DRY run has shown the real number and a human agreed.

## What one run does (inside the single transaction)

```
data.sql → reconcile_report.sql + ../audit_approval_rbac_coherence.sql  → out/<step>-before-<ts>-<rid>.txt
<step>.sql: preflight (refusals) · backup (before-images) · change · postchecks · after-images
            · in-flight approvals must be identical (lib/assert_pending_unchanged.sql)
reconcile_report.sql + audit                                            → out/<step>-after-<ts>-<rid>.txt
ROLLBACK (dry) | COMMIT
```

then the before → after diff is printed (it is exactly what the step changed, or would
change: both reports read the same snapshot plus the step's own writes). After a COMMIT the
report is re-run in a fresh read-only session and compared with the in-transaction one.

Backups: `ops_backup._bak_<step>_<first 8 hex of the request id>` (schema created if
missing), before- and after-images as `to_jsonb` rows. They are kept; drop them by hand once
nobody needs the rollback. Rollbacks refuse when a live row no longer equals its
after-image (somebody changed it since) — a human decides.

## Reconcile report sections (diff-friendly, read-only)

R0 policy shape · R1 PENDING per policy · **R2 in-flight state (must never change)** ·
R3 link anomalies (NULL / other policy / missing) · R4 order offsets (instance step_order ≠
linked step's; the engine renumbers after dropping a dead level, so 02 clears these) ·
R5 current step without a PENDING approver · R6 PENDING approvers without read+approve at
their scope · R7 instance steps ≠ effective policy steps · R8 summary · then audit A–F.

Expected diffs: **01** R0 (`active` t→f on 8, 190-193), R8 counts, audit F/C rows of the
deactivated policies. **02** R0 (dead level gone, later levels renumbered, same `#ids`,
version + 1), R4 rows disappear, R8 step/offset counts. **03** R0 line of policy 221.
R2, R3, R5, R6, R7 identical in every step.

## Production commands (controller, after the human's go)

```bash
cd /Users/apple/Documents/Workwise/hospitality/.worktrees/role-terms/backend   # or wherever this suite is checked out
export ENV_FILE=/Users/apple/Documents/Workwise/hospitality/backend/.env      # HOST/USER/PASSWORD only; never sourced
export TARGET_DB=hospitality_main
S=./scripts/client_role_feedback

$S/run.sh reconcile                                   # baseline, read-only

$S/run.sh 01                                          # DRY — read the NOTICEs + diff
CONFIRM_DB=hospitality_main $S/run.sh 01 --commit     # note the request id it prints

$S/run.sh 02                                          # DRY — check the 53 / breakdown
CONFIRM_DB=hospitality_main $S/run.sh 02 --commit

$S/run.sh 03                                          # DRY
CONFIRM_DB=hospitality_main $S/run.sh 03 --commit

$S/run.sh reconcile                                   # after, read-only
```

Rollback (reverse order; DRY first, then the same with `CONFIRM_DB=… --commit`):

```bash
$S/run.sh 99_rollback_03 -v rollback_request_id=<request id of the 03 COMMIT run>
$S/run.sh 99_rollback_02 -v rollback_request_id=<request id of the 02 COMMIT run>
$S/run.sh 99_rollback_01 -v rollback_request_id=<request id of the 01 COMMIT run>
```

If a run fails with `could not serialize access` or a lock timeout, someone was editing the
same rows; nothing was written — run it again.

## Local rehearsal

```bash
./scripts/client_role_feedback/rehearse_local.sh
```

Builds `hospitality_roleterms_rehearsal` on localhost from `tests/setup/schema.sql` +
`seed_reference.sql` + `pendingMigrations.json` + `rehearsal/fixture.sql` (prod ids and prod
counts, plus negative controls: buyer 90, a tenant role titled 'RFQ Creator', a two-step ARC
policy, a dead level at the end of a policy, history linking a dead level), then runs every
gate, refusal, DRY, COMMIT, rollback and re-apply with assertions. Transcript:
`out/rehearsal/transcript.txt`. It never reads `backend/.env`.

## Notes

- Policies' `updated_at` is stamped by their BEFORE UPDATE trigger on every write, rollbacks
  included; it is the one column a rollback cannot restore (processes' is restored).
- 02: a historical (non-PENDING) instance step linking a removed level loses the link via
  `fk_instance_step_policy_step ON DELETE SET NULL`; it is backed up and `99_rollback_02`
  restores it. A PENDING instance linking one makes the preflight refuse.
- 02: instances' `metadata.approval_diagnostics.skipped_steps` keep naming the removed step
  ids (history, JSON, not a foreign key).
- Change-log rows are append-only: rollbacks add `SCRIPT_ROLLBACK_*` rows and keep the
  forward ones.
