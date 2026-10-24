-- Inventory module: permission keys, system roles and grants. Spec §6.1 and §11
-- (docs/superpowers/specs/2026-10-23-inventory-management-design.md).
--
--   grn        read | create | update | approve
--   inventory  read | create | update | approve | admin
--   reports    10 inventory report keys, one permission each (same shape as
--              20260919120000_reports_permissions.sql)
--
-- System roles (created_by NULL):
--   Storekeeper           grn r/c/u + inventory r/c/u
--   Inventory Controller  every grn + inventory action + the 10 report keys
-- Company Administrator gains inventory.read, inventory.admin, grn.read and the
-- 10 report keys (not grn.create: administering is not receiving).
--
-- Day-one receivers (spec §6.1): EVERY role that holds awarding.create - system
-- roles and company-created roles alike - gains grn.read + grn.create, so
-- receiving never stops on R1 day (today any buyer who can read a PO can mark
-- it received). This is a one-time grant at migration time: a role given
-- awarding.create later does not pick grn up automatically. Admins narrow it
-- afterwards.
--
-- Depends on 20261024100000 (enum labels, committed in their own transaction).
-- In the test database these grants reach only seed roles: fixtures are
-- inserted after pending migrations run.
--
-- Idempotent: every INSERT is NOT EXISTS-guarded; roles are keyed on
-- title + created_by IS NULL, never on id (ids differ per environment).

BEGIN;

-- Step 0: the enum labels must be there (a missing one would otherwise fail as
-- an opaque "invalid input value for enum" halfway through).
DO $$
DECLARE
  lbl TEXT;
BEGIN
  FOREACH lbl IN ARRAY ARRAY['grn','inventory','awarding','reports'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_enum
                    WHERE enumtypid = 'public.resource_type'::regtype AND enumlabel = lbl) THEN
      RAISE EXCEPTION 'resource_type is missing ''%'' - run 20261024100000_inventory_resource_enums.sql (and 20260919120000 for reports) first', lbl;
    END IF;
  END LOOP;
  FOREACH lbl IN ARRAY ARRAY['stock_on_hand','stock_ledger','grn_register','pending_deliveries',
                             'consumption_by_department','stock_adjustments','count_variance',
                             'slow_moving','near_expiry','vendor_delivery_performance'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_enum
                    WHERE enumtypid = 'public.permission_action_type'::regtype AND enumlabel = lbl) THEN
      RAISE EXCEPTION 'permission_action_type is missing ''%'' - run 20261024100000_inventory_resource_enums.sql first', lbl;
    END IF;
  END LOOP;
END $$;

-- Step 1: permission keys. `ordering` is the display order within a resource
-- (rbacModel lists ORDER BY resource, ordering, action). The report keys sit
-- after the existing report families (100-150) as family 160.
INSERT INTO public.tbl_permissions (resource, action, ordering)
SELECT v.resource::public.resource_type, v.action::public.permission_action_type, v.ordering
  FROM (VALUES
          ('grn',       'read',    1),
          ('grn',       'create',  2),
          ('grn',       'update',  3),
          ('grn',       'approve', 4),
          ('inventory', 'read',    1),
          ('inventory', 'create',  2),
          ('inventory', 'update',  3),
          ('inventory', 'approve', 4),
          ('inventory', 'admin',   5),
          ('reports',   'stock_on_hand',               160),
          ('reports',   'stock_ledger',                161),
          ('reports',   'grn_register',                162),
          ('reports',   'pending_deliveries',          163),
          ('reports',   'consumption_by_department',   164),
          ('reports',   'stock_adjustments',           165),
          ('reports',   'count_variance',              166),
          ('reports',   'slow_moving',                 167),
          ('reports',   'near_expiry',                 168),
          ('reports',   'vendor_delivery_performance', 169)
       ) AS v(resource, action, ordering)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.tbl_permissions p
    WHERE p.resource::text = v.resource AND p.action::text = v.action
 );

-- Step 2: the two system roles.
INSERT INTO public.tbl_roles (title, description, created_by)
SELECT v.title, v.description, NULL
  FROM (VALUES
          ('Storekeeper',
           'Receives goods against purchase orders (mark in), marks stock out to departments, takes returns and counts stock at their hotels.'),
          ('Inventory Controller',
           'Owns hotel inventory: everything a storekeeper does, plus GRN reversals and returns to vendor, approving adjustments and count variances, item setup, settings and inventory reports.')
       ) AS v(title, description)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.tbl_roles r WHERE r.title = v.title AND r.created_by IS NULL
 );

-- Step 3: role grants by title (system roles only).
DO $$
DECLARE
  inventory_reports CONSTANT TEXT[] := ARRAY[
    'reports.stock_on_hand','reports.stock_ledger','reports.grn_register',
    'reports.pending_deliveries','reports.consumption_by_department',
    'reports.stock_adjustments','reports.count_variance','reports.slow_moving',
    'reports.near_expiry','reports.vendor_delivery_performance'];
  r          RECORD;
  perms      TEXT[];
  perm       TEXT;
  perm_id    INTEGER;
BEGIN
  FOR r IN
    SELECT id, title FROM public.tbl_roles
     WHERE created_by IS NULL
       AND title IN ('Storekeeper', 'Inventory Controller', 'Company Administrator')
  LOOP
    perms := CASE r.title
      WHEN 'Storekeeper' THEN
        ARRAY['grn.read','grn.create','grn.update',
              'inventory.read','inventory.create','inventory.update']
      WHEN 'Inventory Controller' THEN
        ARRAY['grn.read','grn.create','grn.update','grn.approve',
              'inventory.read','inventory.create','inventory.update',
              'inventory.approve','inventory.admin'] || inventory_reports
      WHEN 'Company Administrator' THEN
        ARRAY['inventory.read','inventory.admin','grn.read'] || inventory_reports
      ELSE ARRAY[]::TEXT[]
    END;

    FOREACH perm IN ARRAY perms LOOP
      SELECT p.id INTO perm_id
        FROM public.tbl_permissions p
       WHERE p.resource::text = split_part(perm, '.', 1)
         AND p.action::text   = split_part(perm, '.', 2)
       LIMIT 1;
      IF perm_id IS NULL THEN
        RAISE EXCEPTION 'permission % not found - cannot grant it to role %', perm, r.title;
      END IF;

      INSERT INTO public.tbl_role_permissions (role_id, permission_id)
      SELECT r.id, perm_id
       WHERE NOT EXISTS (
         SELECT 1 FROM public.tbl_role_permissions rp
          WHERE rp.role_id = r.id AND rp.permission_id = perm_id
       );
    END LOOP;
  END LOOP;
END $$;

-- Step 4: every role holding awarding.create (system or company-created)
-- gains grn.read and grn.create.
INSERT INTO public.tbl_role_permissions (role_id, permission_id)
SELECT DISTINCT holder.role_id, g.id
  FROM public.tbl_role_permissions holder
  JOIN public.tbl_permissions a
    ON a.id = holder.permission_id
   AND a.resource::text = 'awarding'
   AND a.action::text = 'create'
  CROSS JOIN public.tbl_permissions g
 WHERE g.resource::text = 'grn'
   AND g.action::text IN ('read', 'create')
   AND NOT EXISTS (
     SELECT 1 FROM public.tbl_role_permissions rp
      WHERE rp.role_id = holder.role_id AND rp.permission_id = g.id
   );

COMMIT;
