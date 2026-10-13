-- Approval instance steps: snapshot of the policy step each step was built from.
-- Purchase requisitions (spec 2026-10-13 §7, ruling R4). Idempotent.
--
-- WHY: approval instances of PINNED entity types (PR) keep the steps resolved
-- at submission. A policy save deletes and re-inserts every policy step, and
-- fk_instance_step_policy_step is ON DELETE SET NULL, so the live link
-- (policy_step_id) is lost on the first save. Membership revalidation then
-- fell back to POSITIONAL policy-step matching, which for a PR (whose steps
-- are dropped by value threshold / separation of duties) names the wrong
-- policy step — e.g. adding a holder of a ₹50k-only role to a ₹10k PR's step.
-- These columns are the authority for pinned steps instead: written once at
-- creation, never rewritten, never re-derived from the live policy.
--
-- Populated ONLY for pinned entity types; NULL for every other row, so every
-- other entity type keeps resolving through policy_step_id / ordinal exactly
-- as before.
--
-- decision_rule is not duplicated: tbl_approval_instance_steps.decision_rule is
-- already the creation-time copy, and the only writer that ever rewrites it
-- (applyDiffToInstance) no longer touches pinned instances.
BEGIN;

ALTER TABLE public.tbl_approval_instance_steps
  ADD COLUMN IF NOT EXISTS source_approver_type     VARCHAR(20)   NULL,
  ADD COLUMN IF NOT EXISTS source_approver_id       INTEGER       NULL,
  ADD COLUMN IF NOT EXISTS source_policy_step_order INTEGER       NULL,
  ADD COLUMN IF NOT EXISTS source_min_amount        NUMERIC(18,2) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_ais_source_snapshot'
       AND conrelid = 'public.tbl_approval_instance_steps'::regclass
  ) THEN
    ALTER TABLE public.tbl_approval_instance_steps
      ADD CONSTRAINT chk_ais_source_snapshot CHECK (
        (source_approver_type IS NULL) = (source_approver_id IS NULL)
        AND (source_approver_type IS NULL OR source_approver_type IN ('USER', 'ROLE', 'DEPARTMENT'))
      );
  END IF;
END $$;

COMMIT;
