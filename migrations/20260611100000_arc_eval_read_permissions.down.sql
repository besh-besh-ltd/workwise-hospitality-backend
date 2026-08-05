-- Down: remove the arc-tech.read / arc-comm.read keys and their role joins.

DELETE FROM public.tbl_role_permissions rp
USING public.tbl_permissions p
WHERE rp.permission_id = p.id
  AND p.action::text = 'read'
  AND p.resource::text IN ('arc-tech','arc-comm');

DELETE FROM public.tbl_permissions p
WHERE p.action::text = 'read'
  AND p.resource::text IN ('arc-tech','arc-comm');
