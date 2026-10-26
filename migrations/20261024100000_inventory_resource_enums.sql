-- Inventory module (spec docs/superpowers/specs/2026-10-23-inventory-management-design.md
-- §11): the enum labels the permission seed in 20261024100400 relies on.
--
--   resource_type          + 'grn', 'inventory'
--   permission_action_type + one action per inventory report key
--                            (reports.<key>, same shape as 20260919120000)
--
-- Enum labels ONLY, alone in their own file and transaction. Postgres refuses
-- to use a new enum value in the transaction that added it ("New enum values
-- must be committed before they can be used"), and tests/setup/prepareTestDb.js
-- applies each pending-migration file as ONE client.query, so the rows that use
-- these labels must live in a later file (20261024100400), not later in this
-- one. 'read', 'create', 'update', 'approve' and 'admin' are original members
-- of permission_action_type and need no change.
--
-- Idempotent: ADD VALUE IF NOT EXISTS. The down file cannot remove labels.

BEGIN;

ALTER TYPE public.resource_type ADD VALUE IF NOT EXISTS 'grn';
ALTER TYPE public.resource_type ADD VALUE IF NOT EXISTS 'inventory';

ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'stock_on_hand';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'stock_ledger';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'grn_register';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'pending_deliveries';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'consumption_by_department';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'stock_adjustments';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'count_variance';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'slow_moving';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'near_expiry';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'vendor_delivery_performance';

COMMIT;
