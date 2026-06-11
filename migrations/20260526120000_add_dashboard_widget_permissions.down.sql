-- Rollback of 20260526120000_add_dashboard_widget_permissions.sql
--
-- We can fully undo the seeded rows (tbl_role_permissions cascade-cleaned
-- via FK + the tbl_permissions deletion) but cannot remove enum values:
-- PostgreSQL does not support DROP VALUE for ENUM types. The added enum
-- labels 'dashboard' on resource_type and the 25 widget actions on
-- permission_action_type are left in place. They cause no harm — they
-- simply become unused enum values that no row references.

-- ──────────────────────────────────────────────────────────────────
-- 1.  Drop any role-permission grants admins may have created against
--     the dashboard widget catalogue.
-- ──────────────────────────────────────────────────────────────────
DELETE FROM tbl_role_permissions
WHERE permission_id IN (
  SELECT id FROM tbl_permissions WHERE resource = 'dashboard'
);

-- ──────────────────────────────────────────────────────────────────
-- 2.  Drop the seeded tbl_permissions rows.
-- ──────────────────────────────────────────────────────────────────
DELETE FROM tbl_permissions WHERE resource = 'dashboard';

-- ──────────────────────────────────────────────────────────────────
-- 3.  Enum values stay (PostgreSQL limitation).
--     'dashboard' on resource_type and the 25 widget actions on
--     permission_action_type remain. Re-applying the forward migration
--     is fully idempotent.
-- ──────────────────────────────────────────────────────────────────
