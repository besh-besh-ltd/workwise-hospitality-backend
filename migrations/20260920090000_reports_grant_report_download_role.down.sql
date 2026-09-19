-- Revoke the reports catalogue from "Report Download".
--
-- Leaves the Company Administrator grants from 20260919120000 alone; this only
-- undoes the fifteen added here.

BEGIN;

DELETE FROM public.tbl_role_permissions rp
 USING public.tbl_roles r, public.tbl_permissions p
 WHERE rp.role_id = r.id
   AND rp.permission_id = p.id
   AND r.title = 'Report Download'
   AND r.created_by IS NULL
   AND p.resource::text = 'reports'
   AND p.action::text <> 'approval_audit_trail';

COMMIT;
