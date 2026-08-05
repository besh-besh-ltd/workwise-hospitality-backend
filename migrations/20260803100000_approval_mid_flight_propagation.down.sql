-- Rollback: 20260803100000_approval_mid_flight_propagation
--
-- Removes the mid-flight propagation DDL. Rows already sitting in the states
-- this feature introduced must be normalised BEFORE the tighter CHECKs go
-- back on, or the ADD CONSTRAINT fails — each normalisation below restores the
-- state the row would have had if the feature had never run.
--
-- TWO THINGS ARE DELIBERATELY NOT REVERTED:
--   * `fk_instance_step_policy_step` and the nullability of policy_step_id.
--     Production has had both since long before this file; the up-migration
--     only asserts them for rebuilt environments, so dropping them on rollback
--     would take production somewhere it has never been.
--   * 'CANCELLED' stays in the tbl_approval_actions CHECK. The WIP notes claim
--     the original allowed only APPROVE/REJECT, but rfqController.js writes
--     'CANCELLED' today and is no part of this feature — removing it would
--     break RFQ approval cancellation on a DDL-only rollback.

BEGIN;

-- Approver tombstones → the PENDING rows they were before the reconciler
-- touched them (a tombstone is only ever written over a PENDING row).
UPDATE public.tbl_approval_step_approvers
   SET status = 'PENDING', removed_at = NULL, removal_reason = NULL
 WHERE status = 'REMOVED';

ALTER TABLE public.tbl_approval_step_approvers
  DROP CONSTRAINT IF EXISTS tbl_approval_step_approvers_status_check;
ALTER TABLE public.tbl_approval_step_approvers
  ADD  CONSTRAINT tbl_approval_step_approvers_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'));

ALTER TABLE public.tbl_approval_step_approvers
  DROP COLUMN IF EXISTS removed_at,
  DROP COLUMN IF EXISTS removal_reason,
  DROP COLUMN IF EXISTS added_mid_flight;

-- Steps the reconciler retired → CANCELLED, the closest pre-feature terminal
-- state that the restored CHECK still admits.
UPDATE public.tbl_approval_instance_steps
   SET status = 'CANCELLED'
 WHERE status IN ('REMOVED', 'SKIPPED');

ALTER TABLE public.tbl_approval_instance_steps
  DROP CONSTRAINT IF EXISTS tbl_approval_instance_steps_status_check;
ALTER TABLE public.tbl_approval_instance_steps
  ADD  CONSTRAINT tbl_approval_instance_steps_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'));

ALTER TABLE public.tbl_approval_instance_steps
  DROP COLUMN IF EXISTS added_mid_flight,
  DROP COLUMN IF EXISTS removed_mid_flight;

-- Propagation-only audit rows must go before the CHECK narrows again; they
-- have no pre-feature equivalent to be rewritten into.
DELETE FROM public.tbl_approval_actions
 WHERE action IN ('POLICY_CHANGE', 'APPROVER_REMOVED', 'APPROVER_ADDED',
                  'STEP_REMOVED', 'STEP_ADDED', 'MEMBERSHIP_REVALIDATION');

ALTER TABLE public.tbl_approval_actions
  DROP CONSTRAINT IF EXISTS tbl_approval_actions_action_check;
ALTER TABLE public.tbl_approval_actions
  ADD  CONSTRAINT tbl_approval_actions_action_check
  CHECK (action IN ('APPROVE', 'REJECT', 'CANCELLED'));

ALTER TABLE public.tbl_approval_policies  DROP COLUMN IF EXISTS version;
ALTER TABLE public.tbl_approval_instances DROP COLUMN IF EXISTS policy_version;

DROP TABLE IF EXISTS public.tbl_approval_instance_change_log;
DROP TABLE IF EXISTS public.tbl_approval_policy_change_log;

COMMIT;
