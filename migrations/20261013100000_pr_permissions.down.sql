-- Revert the Purchase Requisition permission catalogue and system roles.
--
-- The enum labels ('pr', 'convert') stay. Postgres cannot drop an enum label, and
-- recreating resource_type / permission_action_type would mean rewriting every column
-- that uses them. Unused labels are inert (see 20260919120000_reports_permissions.down.sql).
-- A role still referenced by a scope assignment is kept (with its grants) and a NOTICE is raised.

BEGIN;

DELETE FROM public.tbl_role_permissions rp
 USING public.tbl_permissions p, public.tbl_roles r
 WHERE rp.permission_id = p.id
   AND rp.role_id = r.id
   AND p.resource = 'pr'::public.resource_type
   AND (r.title = 'Company Administrator'
        OR r.title NOT IN ('PR Requester','PR Technical Reviewer','PR Approver','PR Buyer')
        OR NOT EXISTS (SELECT 1 FROM public.tbl_user_role_scopes s WHERE s.role_id = r.id));

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM public.tbl_roles r
   WHERE r.title IN ('PR Requester','PR Technical Reviewer','PR Approver','PR Buyer') AND r.created_by IS NULL
     AND EXISTS (SELECT 1 FROM public.tbl_user_role_scopes s WHERE s.role_id = r.id);
  IF n > 0 THEN
    RAISE NOTICE '% PR system role(s) still assigned to users; kept with their pr.* grants', n;
  END IF;
END $$;

DELETE FROM public.tbl_roles r
 WHERE r.title IN ('PR Requester','PR Technical Reviewer','PR Approver','PR Buyer')
   AND r.created_by IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.tbl_user_role_scopes s WHERE s.role_id = r.id);

-- Permissions: only when no remaining grant references them.
DELETE FROM public.tbl_permissions p
 WHERE p.resource = 'pr'::public.resource_type
   AND NOT EXISTS (SELECT 1 FROM public.tbl_role_permissions rp WHERE rp.permission_id = p.id);

COMMIT;
