-- Register the ABC Analysis dashboard widget permission (Sr 297/298/303) and
-- grant it to every role that already has at least one dashboard widget, so the
-- new widget appears for the same audience as the existing analytics cards.
--
-- Apply with: psql $DATABASE_URL -f migrations/2026_06_16_dashboard_abc_analysis_permission.sql

-- NOTE: ALTER TYPE ... ADD VALUE must be committed before the new enum value can
-- be used in a later statement, so it runs OUTSIDE the transaction below.
ALTER TYPE permission_action_type ADD VALUE IF NOT EXISTS 'abc_analysis';

BEGIN;

-- 1) Register the permission row (idempotent).
INSERT INTO tbl_permissions (resource, action)
SELECT 'dashboard', 'abc_analysis'
WHERE NOT EXISTS (
  SELECT 1 FROM tbl_permissions WHERE resource = 'dashboard' AND action = 'abc_analysis'
);

-- 2) Grant it to every role that already holds ANY dashboard widget permission.
INSERT INTO tbl_role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p_new.id
FROM tbl_role_permissions rp
JOIN tbl_permissions p_any
  ON p_any.id = rp.permission_id
 AND p_any.resource = 'dashboard'
CROSS JOIN tbl_permissions p_new
WHERE p_new.resource = 'dashboard'
  AND p_new.action = 'abc_analysis'
  AND NOT EXISTS (
    SELECT 1 FROM tbl_role_permissions x
    WHERE x.role_id = rp.role_id AND x.permission_id = p_new.id
  );

COMMIT;
