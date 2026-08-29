-- Reverses 20260829094000_company_admin_capability.
--
-- The enum value itself is NOT removed. Postgres cannot drop an enum label
-- without rewriting the type, and anything still referencing 'company' would
-- break. It is inert once the permission is gone, so it is left in place —
-- re-running the up migration is a no-op against it.

BEGIN;

DELETE FROM public.tbl_role_permissions
 WHERE permission_id IN (
   SELECT id FROM public.tbl_permissions
    WHERE resource = 'company'::public.resource_type
      AND action = 'admin'::public.permission_action_type
 );

DELETE FROM public.tbl_roles WHERE title = 'Company Administrator' AND created_by IS NULL;

DELETE FROM public.tbl_permissions
 WHERE resource = 'company'::public.resource_type
   AND action = 'admin'::public.permission_action_type;

COMMIT;
