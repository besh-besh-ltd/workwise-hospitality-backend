-- Rollback for 20260608100800_permissions_seed.sql.
--
-- Removes role_permission mappings, then roles, then permissions. The enum
-- value additions on resource_type and permission_action_type CANNOT be
-- safely removed (PostgreSQL does not support DROP VALUE from an enum
-- without dropping the column references). They are left in place; they
-- are inert if no rows reference them.

DELETE FROM public.tbl_role_permissions
WHERE permission_id IN (
  SELECT id FROM public.tbl_permissions
  WHERE (resource::text, action::text) IN (
    ('arc','read'),('arc','create'),('arc','admin'),
    ('arc-tech','evaluate'),('arc-comm','evaluate'),
    ('arc-committee','read'),('arc-committee','approve'),
    ('mr','read'),('mr','create'),('mr','approve')
  )
);

DELETE FROM public.tbl_roles
WHERE created_by IS NULL
  AND title IN (
    'ARC Creator','ARC Tech Evaluator','ARC Commercial Evaluator',
    'ARC Committee Member','ARC Admin','MR Raiser','MR Approver'
  );

DELETE FROM public.tbl_permissions
WHERE (resource::text, action::text) IN (
  ('arc','read'),('arc','create'),('arc','admin'),
  ('arc-tech','evaluate'),('arc-comm','evaluate'),
  ('arc-committee','read'),('arc-committee','approve'),
  ('mr','read'),('mr','create'),('mr','approve')
);
