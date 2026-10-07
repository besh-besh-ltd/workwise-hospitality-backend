-- Reverse 20260928102000: remove exactly the widget grants it inserted.
-- Grants an administrator added afterwards are untouched.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.tbl_dashboard_seed_grants') IS NOT NULL THEN
    DELETE FROM public.tbl_role_permissions rp
     USING public.tbl_dashboard_seed_grants s
     WHERE rp.role_id = s.role_id
       AND rp.permission_id = s.permission_id;
    DROP TABLE public.tbl_dashboard_seed_grants;
  END IF;
END $$;

COMMIT;
