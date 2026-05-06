-- Migration 004 — Network-scope role grants for Group ARC.
--
-- Group ARC tenders are governed by a single network-wide approval
-- hierarchy (see migration 002). The hierarchy lives at parent
-- tbl_company.id with no BU/dept scoping. But the existing role-grant
-- model in tbl_user_role_scopes is BU-scoped: every row binds a
-- (user, role) pair to a specific (company_id, hotel_id, department_id).
-- That means:
--
--   - ROLE-source approvers under an is_global=1 policy never resolve
--     (the lookup requires urs.company_id = X for a specific company).
--   - Permission checks (te.read, quote-compare.read, tender.approve, …)
--     against a Group ARC entity always fail for users whose only role
--     grants are BU-scoped — even if they're network admins.
--
-- This migration adds an explicit network-scope semantics:
--
--   tbl_user_role_scopes.is_network_scope SMALLINT DEFAULT 0
--   When = 1, all of (company_id, hotel_id, department_id) MUST be NULL.
--   When = 0 (default, all existing rows), the row is BU-scoped exactly
--   as before — company_id NOT NULL, hotel_id/department_id may narrow.
--
-- Application-tier rules (enforced in code, not constraints):
--   - Network-scope rows govern Group ARC entities only.
--   - BU-scoped rows govern Single-ARC + RFQ entities only.
--   - The two scopes do NOT cross-pollinate. A user who holds te.read
--     at hotel A1 cannot evaluate a Group ARC tender that happens to
--     cover A1; they need a separate network-scope te.read grant.

ALTER TABLE tbl_user_role_scopes
  ADD COLUMN IF NOT EXISTS is_network_scope SMALLINT NOT NULL DEFAULT 0;

-- Loosen the NOT NULL on company_id so network-scope rows can carry NULL.
-- Existing rows are unaffected (they already have non-null company_id).
ALTER TABLE tbl_user_role_scopes
  ALTER COLUMN company_id DROP NOT NULL;

-- CHECK: when network-scope, every BU column must be NULL; when not,
-- company_id must be present (existing invariant preserved).
ALTER TABLE tbl_user_role_scopes
  DROP CONSTRAINT IF EXISTS chk_user_role_scopes_network_shape;
ALTER TABLE tbl_user_role_scopes
  ADD CONSTRAINT chk_user_role_scopes_network_shape CHECK (
    (is_network_scope = 1 AND company_id IS NULL AND hotel_id IS NULL AND department_id IS NULL)
    OR
    (is_network_scope = 0 AND company_id IS NOT NULL)
  );

-- Index the network-scope rows separately. Group ARC resolution looks
-- up by (role_id, is_network_scope=1), so a partial index keeps it
-- efficient as the table grows.
CREATE INDEX IF NOT EXISTS idx_user_role_scopes_network
  ON tbl_user_role_scopes(role_id, user_id) WHERE is_network_scope = 1;
