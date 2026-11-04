-- Drop chk_arc_policy_global_scope, a check that refuses every new approval
-- policy on a database that carries it.
--
-- Why. The unmerged feat/arc branch shipped
-- app/migrations/002-arc-global-hierarchy.sql, which added
-- tbl_approval_policies.company_id and .is_global plus this CHECK. Both of its
-- branches require company_id IS NOT NULL. That file was applied to staging by
-- hand; it is not in the pgmigrations ledger and not in this repo. Our schema
-- has neither column, and createApprovalPolicy (app/models/generalModel.js)
-- never writes company_id, so on staging every new policy fails with:
--   new row for relation "tbl_approval_policies" violates check constraint
--   "chk_arc_policy_global_scope"
-- QA hit it on 2026-11-04 saving Unit ARC · Publish Approval and Unit ARC ·
-- Negotiation Round Approval, but the entity type makes no difference. Editing
-- an existing policy still works, because feat/arc backfilled company_id on the
-- rows that existed then.
--
-- What. Drop the check, nothing else. No code in this repo reads company_id or
-- is_global, and those columns are nullable or defaulted, so they never block
-- a write; they are left where they exist.
--
-- Idempotent, and a no-op on a database without the check (the test schema,
-- and any environment feat/arc never touched). Dropping a CHECK takes a brief
-- exclusive lock on a small table; lock_timeout makes it give up, changing
-- nothing, rather than queue every policy read behind a long transaction.
-- Just re-run it.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.tbl_approval_policies
  DROP CONSTRAINT IF EXISTS chk_arc_policy_global_scope;

COMMIT;
