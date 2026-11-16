-- Restores chk_arc_policy_global_scope with feat/arc's definition, but only
-- where feat/arc's columns (company_id, is_global) exist. Elsewhere there was
-- never a check to restore, and this changes nothing.
--
-- Added NOT VALID: policies created while the check was gone have no
-- company_id and would fail validation. New and updated rows are checked
-- again, which also brings back the original failure: every new policy is
-- refused, because the code never writes company_id.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tbl_approval_policies'
          AND column_name = 'company_id')
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tbl_approval_policies'
          AND column_name = 'is_global')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.tbl_approval_policies'::regclass
          AND conname = 'chk_arc_policy_global_scope')
  THEN
    ALTER TABLE public.tbl_approval_policies
      ADD CONSTRAINT chk_arc_policy_global_scope
      CHECK (
        (is_global = 1
           AND hospitality_company_id IS NULL
           AND hotel_id IS NULL
           AND department_id IS NULL
           AND process_id IS NULL
           AND company_id IS NOT NULL)
        OR
        (is_global = 0
           AND hospitality_company_id IS NOT NULL
           AND company_id IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;

COMMIT;
