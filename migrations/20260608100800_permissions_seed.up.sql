-- ARC v2 — Migration 10 of 10: permission keys + default roles.
--
-- Extends the resource_type and permission_action_type enums to accommodate
-- ARC v2 + MR. Then inserts the new (resource, action) permission rows into
-- tbl_permissions, seeds 7 default roles in tbl_roles, and maps roles to
-- permissions via tbl_role_permissions.
--
-- Per plan §5.5, the system roles are defaults — tenant admins refine via
-- the existing role-management UI. created_by IS NULL marks them as system
-- (read-only) roles per the platform's convention.

-- ----------------------------------------------------------------
-- Step 1: extend enums.
-- ----------------------------------------------------------------
-- ALTER TYPE ... ADD VALUE is idempotent with IF NOT EXISTS (Postgres 12+).

DO $$
BEGIN
  -- resource_type additions
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'arc-tech'      AND enumtypid = 'public.resource_type'::regtype) THEN
    ALTER TYPE public.resource_type ADD VALUE 'arc-tech';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'arc-comm'      AND enumtypid = 'public.resource_type'::regtype) THEN
    ALTER TYPE public.resource_type ADD VALUE 'arc-comm';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'arc-committee' AND enumtypid = 'public.resource_type'::regtype) THEN
    ALTER TYPE public.resource_type ADD VALUE 'arc-committee';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'mr'            AND enumtypid = 'public.resource_type'::regtype) THEN
    ALTER TYPE public.resource_type ADD VALUE 'mr';
  END IF;

  -- permission_action_type additions
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'evaluate' AND enumtypid = 'public.permission_action_type'::regtype) THEN
    ALTER TYPE public.permission_action_type ADD VALUE 'evaluate';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'admin' AND enumtypid = 'public.permission_action_type'::regtype) THEN
    ALTER TYPE public.permission_action_type ADD VALUE 'admin';
  END IF;
END $$;

-- ----------------------------------------------------------------
-- Step 2: insert permission rows.
-- ----------------------------------------------------------------
-- Idempotent: ON CONFLICT DO NOTHING relies on a (resource, action) unique
-- constraint if one exists; if not, the NOT EXISTS check handles dedup.

INSERT INTO public.tbl_permissions (resource, action, ordering)
SELECT v.resource::public.resource_type, v.action::public.permission_action_type, 0
FROM (VALUES
  ('arc',           'read'),
  ('arc',           'create'),
  ('arc',           'admin'),
  ('arc-tech',      'evaluate'),
  ('arc-comm',      'evaluate'),
  ('arc-committee', 'read'),
  ('arc-committee', 'approve'),
  ('mr',            'read'),
  ('mr',            'create'),
  ('mr',            'approve')
) AS v(resource, action)
WHERE NOT EXISTS (
  SELECT 1 FROM public.tbl_permissions p
  WHERE p.resource::text = v.resource AND p.action::text = v.action
);

-- ----------------------------------------------------------------
-- Step 3: seed default ARC + MR roles (system roles, created_by = NULL).
-- ----------------------------------------------------------------

INSERT INTO public.tbl_roles (title, description, created_by)
SELECT v.title, v.description, NULL
FROM (VALUES
  ('ARC Creator',              'Can create and float Annual Rate Contracts.'),
  ('ARC Tech Evaluator',       'Evaluates the technical responses on Annual Rate Contracts.'),
  ('ARC Commercial Evaluator', 'Runs commercial evaluation and reconciles split-vendor awards on ARCs.'),
  ('ARC Committee Member',     'Sits on the ARC committee that approves finalised awards and amendments.'),
  ('ARC Admin',                'Operational owner of the ARC module — handles terminations, escalations, manual overrides.'),
  ('MR Raiser',                'Raises Material Requisitions for contracted items within their hotel/department scope.'),
  ('MR Approver',              'Approves Material Requisitions at any configured step on the MR approval policy.')
) AS v(title, description)
WHERE NOT EXISTS (
  SELECT 1 FROM public.tbl_roles r WHERE r.title = v.title AND r.created_by IS NULL
);

-- ----------------------------------------------------------------
-- Step 4: map roles to permissions.
-- ----------------------------------------------------------------
-- Each role gets the permissions described in plan §5.5.

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
                    'ARC Committee Member','ARC Admin','MR Raiser','MR Approver')
  LOOP
    perms_to_assign := CASE r.title
      WHEN 'ARC Creator'              THEN ARRAY['arc.read','arc.create']
      WHEN 'ARC Tech Evaluator'       THEN ARRAY['arc-tech.evaluate']
      WHEN 'ARC Commercial Evaluator' THEN ARRAY['arc-comm.evaluate']
      WHEN 'ARC Committee Member'     THEN ARRAY['arc-committee.read','arc-committee.approve']
      WHEN 'ARC Admin'                THEN ARRAY['arc.read','arc.create','arc.admin','arc-tech.evaluate','arc-comm.evaluate','arc-committee.read','arc-committee.approve']
      WHEN 'MR Raiser'                THEN ARRAY['mr.read','mr.create']
      WHEN 'MR Approver'              THEN ARRAY['mr.read','mr.approve']
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
