-- Reverts 20261013102000_approval_instance_step_source_snapshot.sql. Idempotent.
-- Pinned (PR) instance steps lose their creation snapshot; revalidation would
-- fall back to policy_step_id / ordinal resolution for them.
--
-- ORDER: the application code that ships with the up migration REQUIRES these
-- columns. createApprovalInstance inserts them for pinned entity types (every
-- PR submit), the PR detail / decision gate selects them (prModel
-- approvalPosition), and membership revalidation reads them for EVERY entity
-- type (approvalPropagationService POLICY_STEP_RESOLUTION_SQL). Run this down
-- ONLY after that code has been reverted and redeployed — against the current
-- code those paths fail with "column ... does not exist".
BEGIN;
ALTER TABLE public.tbl_approval_instance_steps DROP CONSTRAINT IF EXISTS chk_ais_source_snapshot;
ALTER TABLE public.tbl_approval_instance_steps
  DROP COLUMN IF EXISTS source_min_amount,
  DROP COLUMN IF EXISTS source_policy_step_order,
  DROP COLUMN IF EXISTS source_approver_id,
  DROP COLUMN IF EXISTS source_approver_type;
COMMIT;
