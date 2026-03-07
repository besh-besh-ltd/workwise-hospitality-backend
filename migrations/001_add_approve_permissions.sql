-- Migration: Add approve permissions and assign to correct roles
-- Date: 2026-03-02
-- Purpose: Only roles with 'approve' permissions should generate approval instance steps.
--          Non-approver roles (Tender Creator, Technical Evaluator, etc.) should be skipped.
--
-- Entity type → permission resource mapping:
--   RFQ             → rfq              (exists)
--   TENDER          → tender           (NEW)
--   TECHNICAL       → te               (exists)
--   NEGOTIATION     → negotiation      (exists)
--   NEGOTIATION_QUOTE → quote-compare  (exists)
--   PO              → awarding         (exists)
--   ARC             → arc              (NEW)

BEGIN;

-- ============================================================
-- 1. Insert MISSING approve permissions into tbl_permissions
--    (rfq, te, negotiation, quote-compare, awarding already have .approve)
-- ============================================================
INSERT INTO tbl_permissions (resource, action) VALUES ('tender', 'approve');
INSERT INTO tbl_permissions (resource, action) VALUES ('arc', 'approve');

-- ============================================================
-- 2. Assign MISSING approve permissions to the correct roles
-- ============================================================

-- Company CEO (role 1) → already has rfq,te,quote-compare,negotiation,awarding,boq. ADD: tender, arc
INSERT INTO tbl_role_permissions (role_id, permission_id)
SELECT 1, p.id FROM tbl_permissions p WHERE p.resource IN ('tender', 'arc') AND p.action = 'approve';

-- Tender Approver (role 4) → already has rfq. ADD: tender
INSERT INTO tbl_role_permissions (role_id, permission_id)
SELECT 4, p.id FROM tbl_permissions p WHERE p.resource = 'tender' AND p.action = 'approve';

-- Proxy Approver (role 5) → already has rfq. ADD: tender
INSERT INTO tbl_role_permissions (role_id, permission_id)
SELECT 5, p.id FROM tbl_permissions p WHERE p.resource = 'tender' AND p.action = 'approve';

-- Technical Approver (role 7) → already has te.approve. No change needed.

-- Commercial Negotiator N1 (role 8) → has NOTHING. ADD: negotiation, quote-compare
INSERT INTO tbl_role_permissions (role_id, permission_id)
SELECT 8, p.id FROM tbl_permissions p WHERE p.resource IN ('negotiation', 'quote-compare') AND p.action = 'approve';

-- Commercial Approver (role 12) → already has negotiation. ADD: quote-compare
INSERT INTO tbl_role_permissions (role_id, permission_id)
SELECT 12, p.id FROM tbl_permissions p WHERE p.resource = 'quote-compare' AND p.action = 'approve';

-- Final Awarding P1/P2/P3 (roles 13-15) → already have awarding.approve. No change needed.

-- ARC Approver (role 16) → already has awarding. ADD: arc
INSERT INTO tbl_role_permissions (role_id, permission_id)
SELECT 16, p.id FROM tbl_permissions p WHERE p.resource = 'arc' AND p.action = 'approve';

-- ============================================================
-- 3. Assign N2 role to all existing N1 users
--    Copy tbl_user_role_scopes entries where role_id = 8 (N1) → role_id = 9 (N2)
-- ============================================================
INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
SELECT user_id, 9, company_id, hotel_id, department_id
FROM tbl_user_role_scopes
WHERE role_id = 8;

-- ============================================================
-- 4. Fix active instance 10 — remove wrongful Step 1 (Ankush Mehta)
-- ============================================================

-- Delete step 1 approvers
DELETE FROM tbl_approval_step_approvers
WHERE approval_instance_step_id = (
  SELECT id FROM tbl_approval_instance_steps
  WHERE approval_instance_id = 10 AND step_order = 1
);

-- Delete step 1 actions (if any)
DELETE FROM tbl_approval_actions
WHERE approval_instance_id = 10
  AND approval_instance_step_id = (
    SELECT id FROM tbl_approval_instance_steps
    WHERE approval_instance_id = 10 AND step_order = 1
  );

-- Delete step 1
DELETE FROM tbl_approval_instance_steps
WHERE approval_instance_id = 10 AND step_order = 1;

-- Renumber remaining steps: step_order - 1
UPDATE tbl_approval_instance_steps
SET step_order = step_order - 1
WHERE approval_instance_id = 10;

-- Fix current_step pointer
UPDATE tbl_approval_instances
SET current_step = 1
WHERE id = 10;

COMMIT;
