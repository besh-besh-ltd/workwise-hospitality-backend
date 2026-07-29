-- ARC lifecycle page — per-stage read permission keys.
--
-- The single authoritative ARC page gates each lifecycle stage by
-- permission: users without a stage's read key see a "No permission"
-- panel. arc-tech / arc-comm resources existed with only 'evaluate';
-- this adds the 'read' action so admins can grant view-only access to
-- Technical / Commercial without granting scoring rights.
--
-- Role mapping (system roles from 20260608100800):
--   ARC Tech Evaluator        += arc-tech.read
--   ARC Commercial Evaluator  += arc-comm.read, arc-tech.read  (sees qualification basis)
--   ARC Committee Member      += arc-tech.read, arc-comm.read  (reviews marks/awards)
--   ARC Creator               += arc-tech.read, arc-comm.read  (owner watches read-only)
--   ARC Admin                 += arc-tech.read, arc-comm.read

INSERT INTO public.tbl_permissions (resource, action, ordering)
SELECT v.resource::public.resource_type, v.action::public.permission_action_type, 0
FROM (VALUES
  ('arc-tech', 'read'),
  ('arc-comm', 'read')
) AS v(resource, action)
WHERE NOT EXISTS (
  SELECT 1 FROM public.tbl_permissions p
  WHERE p.resource::text = v.resource AND p.action::text = v.action
);

DO $$
DECLARE
  r RECORD;
  perms_to_assign TEXT[];
  perm_resource TEXT;
  perm_action   TEXT;
  perm_id       INTEGER;
  role_perm_pair TEXT;
BEGIN
  FOR r IN
    SELECT id, title FROM public.tbl_roles
    WHERE created_by IS NULL
      AND title IN ('ARC Creator','ARC Tech Evaluator','ARC Commercial Evaluator',
                    'ARC Committee Member','ARC Admin')
  LOOP
    perms_to_assign := CASE r.title
      WHEN 'ARC Tech Evaluator'       THEN ARRAY['arc-tech.read']
      WHEN 'ARC Commercial Evaluator' THEN ARRAY['arc-comm.read','arc-tech.read']
      WHEN 'ARC Committee Member'     THEN ARRAY['arc-tech.read','arc-comm.read']
      WHEN 'ARC Creator'              THEN ARRAY['arc-tech.read','arc-comm.read']
      WHEN 'ARC Admin'                THEN ARRAY['arc-tech.read','arc-comm.read']
      ELSE                                  ARRAY[]::TEXT[]
    END;

    FOREACH role_perm_pair IN ARRAY perms_to_assign
    LOOP
      perm_resource := split_part(role_perm_pair, '.', 1);
      perm_action   := split_part(role_perm_pair, '.', 2);

      SELECT id INTO perm_id
      FROM public.tbl_permissions p
      WHERE p.resource::text = perm_resource AND p.action::text = perm_action
      LIMIT 1;

      IF perm_id IS NOT NULL THEN
        INSERT INTO public.tbl_role_permissions (role_id, permission_id)
        SELECT r.id, perm_id
        WHERE NOT EXISTS (
          SELECT 1 FROM public.tbl_role_permissions rp
          WHERE rp.role_id = r.id AND rp.permission_id = perm_id
        );
      END IF;
    END LOOP;
  END LOOP;
END $$;
