# Activity trail: company-administration capture — runbook

Branch `fix/activity-admin-capture`. Backend only. One migration, one backfill.

## What was wrong

The activity trail (`tbl_activity_events`, written by
`app/middleware/activityCapture.js` from `app/services/activity/eventRegistry.js`)
files every event under a company. Entries that had no record of their own to
look up fell back to **the acting user's** business-unit mapping.
Production's company administrators — users 150 (Phileein Hospitality, buyer
company 13) and 402 (Workwise, buyer company 90), `user_type` 7 — have **no
mapping at all**, so those events resolved to no company and were dropped with
nothing but an in-memory counter.

Measured against the row-level audit (`tbl_audit_row_changes`, joined to the
trail by `request_id`) between 2026-09-04 (live capture start) and 2026-10-12:

| Admin action | App requests | In the trail before this fix |
|---|---|---|
| User create / role / department changes before the 22 Sep fix | 32 | 0 |
| Same, after 22 Sep | 14 | 14 |
| Removing a user from a business unit | 3 | 0 |
| Creating an approval workflow | 2 | 0 |
| Password reset sent by an admin | 7 | 0 |

Same flaw, no prod traffic yet: role create/edit, workflow delete, approval
cover (delegation). Not catalogued at all: editing a workflow, company details,
project links, legacy approval hierarchy, payment links, private vendors.
Not covered by the row-level audit: `tbl_company` (so nobody can say when the
dashboard switch was flipped), approval delegations, project mappings, the
permission catalogue.

## What changed

1. **Company-wide events.** `tbl_activity_events.buyer_company_id` (every row;
   filled by a BEFORE INSERT trigger from the hospitality company when there is
   one). A row may name only the buyer company — a role, a workflow, the company
   profile — and is shown to every administrator of that buyer company.
   `CHECK (hospitality_company_id IS NOT NULL OR buyer_company_id IS NOT NULL)`.
2. **Scope order** for every captured event: the record's own row → route
   params / validated body → what the controller handed over
   (`res.locals.activityDetail.scope`) → the actor's unit → **the actor's buyer
   company** (company-wide). Never from headers. A buyer company is used only if
   it has hospitality companies (so vendor actions never land anywhere).
3. **Registry fixes.** BU removal (controller hands over the unit removed from,
   only after the removal commits — the same route answers 200 with an
   approval-impact warning and removes nothing), password reset, roles
   (response id is `data.role_id`), workflows (+ new edit entry), cover.
   Newly catalogued: company details, project links, legacy hierarchy,
   payment links, private vendors, password change.
4. **No silent gaps.** `NOT_AN_EVENT` lists the admin-router routes that are
   deliberately not events (queries, auth, read receipts, uploads, vendor
   self-service, payment callbacks). `tests/services/activity.routeCoverage.test.js`
   walks the live Express app and fails for any mutating route under `/users`,
   `/hospitality`, `/rbac` or `/general` that is in neither list. Remaining gaps
   are logged (`Activity trail gap: event not recorded`) once per route per
   process.
5. **Row-level audit** attached to `tbl_company`, `tbl_approval_delegations`,
   `tbl_hospitality_project_mappings`, `tbl_permissions`.
   `tbl_company_buyer_account_limit` is **not** included: it has no `id` column
   and the trigger records `COALESCE(NEW.id, OLD.id)`, so attaching it would make
   every write to it fail.
6. **Backfill** source `admin_actions` rebuilds the dropped events from the
   row-level audit (one per request; reconstructed; real actor and request id,
   so the change detail opens).

The code tolerates the migration not being applied yet: every read and write
checks for `buyer_company_id` first and behaves exactly as before while it is
absent (company-wide events are dropped, as they always were). A positive check
is cached for the process; a negative one is re-checked after a minute, so the
migration takes effect without a restart.

## Release order (DB first)

Stage first, then production.

1. **Backup** (prod): `caffeinate -i pg_dump -Fc --no-owner --no-acl -d hospitality_main -f ~/workwise-db-backups/hospitality_main-preActivityAdmin-<ts>.dump`, then `pg_restore -l` to verify the TOC.
2. **Migration:** `psql -v ON_ERROR_STOP=1 -f migrations/20261012100000_activity_company_wide_events.sql`, then
   `INSERT INTO pgmigrations (name, run_on) VALUES ('20261012100000_activity_company_wide_events', now());`
3. **Deploy** the backend (qa → main). Order relative to step 2 does not matter for safety; company-wide events start landing once both are done.
4. **Backfill** (from the backend root, with that environment's DB env):
   ```bash
   node scripts/activity/backfill.mjs --only=admin_actions --dry-run   # expect ~45 on prod
   node scripts/activity/backfill.mjs --only=admin_actions
   ```
   Must run after step 2 (workflows are company-wide rows). Idempotent: a
   second run adds nothing.

## Verification (read-only)

```sql
-- schema
SELECT column_name, is_nullable FROM information_schema.columns
 WHERE table_name = 'tbl_activity_events'
   AND column_name IN ('buyer_company_id', 'hospitality_company_id');
SELECT conname FROM pg_constraint WHERE conname IN ('chk_activity_company_scope', 'fk_activity_buyer_company');
SELECT tgname FROM pg_trigger
 WHERE tgname IN ('tbl_company_audit', 'tbl_approval_delegations_audit',
                  'tbl_hospitality_project_mappings_audit', 'tbl_permissions_audit',
                  'tbl_activity_events_fill_buyer');                       -- 5 rows

-- every row names a company of some kind; buyer filled on old rows
SELECT count(*) FILTER (WHERE buyer_company_id IS NULL) AS no_buyer,
       count(*) FILTER (WHERE hospitality_company_id IS NULL) AS company_wide
  FROM tbl_activity_events;                                                -- no_buyer = 0

-- backfill landed (prod dry run 2026-10-12: 45 = 29 user_updated, 7 password_reset_sent,
-- 4 user_created, 3 user_mapping_removed, 2 approval_process_created)
SELECT event_key, count(*) FROM tbl_activity_events
 WHERE is_reconstructed AND metadata->>'source_table' = 'tbl_audit_row_changes'
 GROUP BY 1 ORDER BY 2 DESC;

-- coverage from now on: admin requests since the deploy with no trail row (expect 0)
SELECT a.table_name, count(DISTINCT a.request_id)
  FROM tbl_audit_row_changes a
 WHERE a.changed_at >= '<deploy time, UTC>' AND a.request_id IS NOT NULL AND a.actor_user_id IS NOT NULL
   AND a.table_name IN ('tbl_user_role_scopes', 'tbl_hospitality_user_mappings', 'tbl_approval_processes', 'tbl_roles')
   AND NOT EXISTS (SELECT 1 FROM tbl_activity_events e WHERE e.request_id = a.request_id)
 GROUP BY 1;
```

Smoke (as an administrator): create and delete a test approval workflow, then
open Activity → it shows "… created the approval workflow …" and "… deleted …".

## Rollback

- Code only: revert the deploy. The extra column and rows are inert to the old
  code (it filters by hospitality company; company-wide rows are simply not shown).
- Schema: `psql -v ON_ERROR_STOP=1 -f migrations/20261012100000_activity_company_wide_events.down.sql`
  and delete its `pgmigrations` row. Company-wide rows are **moved** to
  `tbl_activity_events_company_wide_parked`, not deleted; re-applying the up
  migration restores them. The four audit triggers it added are dropped (none
  existed before it on production).
- Backfill rows: `DELETE FROM tbl_activity_events WHERE is_reconstructed AND metadata->>'source_table' = 'tbl_audit_row_changes';`
