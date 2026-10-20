-- Revokes the grant only. The arc-comm.approve permission row is never deleted:
-- 'ARC Commercial Approver' (and others) depend on it.
DELETE FROM public.tbl_role_permissions rp
USING public.tbl_roles r, public.tbl_permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.created_by IS NULL
  AND r.title = 'ARC Commercial Evaluator'
  AND p.resource::text = 'arc-comm'
  AND p.action::text = 'approve';
