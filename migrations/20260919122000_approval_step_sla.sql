-- Reports module: an SLA target per approval step.
--
-- Report 3.2 (PO Aging by Approver) exists to answer "which approvals are past
-- their promised turnaround, and with whom". The approval engine records when a
-- step opened and when each approver acted, so elapsed time is already
-- derivable — but nothing anywhere records what the time was SUPPOSED to be, so
-- "breach" has no definition and the report's SLA and "Breach by (hrs)" columns
-- cannot be computed at all.
--
-- Nullable on purpose. A policy step with no target is not in breach, it is
-- unmeasured: the report renders "—" rather than inventing a default and
-- reporting every approval in the company as late on day one.

BEGIN;

ALTER TABLE public.tbl_approval_policy_steps
  ADD COLUMN IF NOT EXISTS sla_hours integer;

ALTER TABLE public.tbl_approval_policy_steps
  DROP CONSTRAINT IF EXISTS chk_policy_step_sla_hours_positive;

ALTER TABLE public.tbl_approval_policy_steps
  ADD CONSTRAINT chk_policy_step_sla_hours_positive
  CHECK (sla_hours IS NULL OR sla_hours > 0);

COMMENT ON COLUMN public.tbl_approval_policy_steps.sla_hours IS
  'Target turnaround for this step, in calendar hours. NULL = unmeasured, which reports render as "—" rather than a breach.';

COMMIT;
