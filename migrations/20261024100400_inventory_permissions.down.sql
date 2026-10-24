-- Reverses 20261024100400_inventory_permissions.
--
-- Deletes the grn.* / inventory.* keys and the 10 inventory report keys with
-- every grant of them (which also undoes the awarding.create -> grn grant and
-- the Company Administrator additions), then the two system roles with their
-- user assignments. The enum labels stay (see 20261024100000.down.sql).
--
-- One-way door, like 20260803110000.down.sql: role ids come from a sequence, so
-- re-running the up mints DIFFERENT ids for Storekeeper / Inventory Controller.
-- Step 0 therefore refuses while any approval policy step still names one of
-- them; re-point or delete those steps first.

BEGIN;

-- Step 0: refuse if an approval policy still points at these roles.
DO $$
DECLARE
  offending INTEGER;
BEGIN
  SELECT count(*) INTO offending
    FROM public.tbl_approval_policy_steps s
    JOIN public.tbl_roles r ON r.id = s.approver_source_id
   WHERE s.approver_source_type = 'ROLE'
     AND r.created_by IS NULL
     AND r.title IN ('Storekeeper', 'Inventory Controller');

  IF offending > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop the inventory roles: % approval policy step(s) still name them. Re-point or delete those steps first.',
      offending;
  END IF;
END $$;

-- Step 1: the two system roles, their assignments and grants.
DELETE FROM public.tbl_user_role_scopes urs
 USING public.tbl_roles r
 WHERE urs.role_id = r.id
   AND r.created_by IS NULL
   AND r.title IN ('Storekeeper', 'Inventory Controller');

DELETE FROM public.tbl_role_permissions rp
 USING public.tbl_roles r
 WHERE rp.role_id = r.id
   AND r.created_by IS NULL
   AND r.title IN ('Storekeeper', 'Inventory Controller');

DELETE FROM public.tbl_roles r
 WHERE r.created_by IS NULL
   AND r.title IN ('Storekeeper', 'Inventory Controller');

-- Step 2: every remaining grant of the new keys (Company Administrator, the
-- awarding.create holders, any custom role an admin granted them to), then the
-- keys themselves.
DELETE FROM public.tbl_role_permissions rp
 USING public.tbl_permissions p
 WHERE rp.permission_id = p.id
   AND (   p.resource::text IN ('grn', 'inventory')
        OR (p.resource::text = 'reports' AND p.action::text IN (
              'stock_on_hand','stock_ledger','grn_register','pending_deliveries',
              'consumption_by_department','stock_adjustments','count_variance',
              'slow_moving','near_expiry','vendor_delivery_performance')));

DELETE FROM public.tbl_permissions p
 WHERE p.resource::text IN ('grn', 'inventory')
    OR (p.resource::text = 'reports' AND p.action::text IN (
          'stock_on_hand','stock_ledger','grn_register','pending_deliveries',
          'consumption_by_department','stock_adjustments','count_variance',
          'slow_moving','near_expiry','vendor_delivery_performance'));

COMMIT;
