BEGIN;
ALTER TABLE public.tbl_approval_policy_steps
  DROP CONSTRAINT IF EXISTS chk_policy_step_sla_hours_positive;
ALTER TABLE public.tbl_approval_policy_steps
  DROP COLUMN IF EXISTS sla_hours;
COMMIT;
