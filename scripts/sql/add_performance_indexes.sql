-- Performance indexes for update-user-detail and approval propagation queries
-- These indexes target the most expensive queries identified in the API profiling.
-- Safe to run multiple times (IF NOT EXISTS).

-- Snapshot queries: user role scopes and departments by user_id
CREATE INDEX IF NOT EXISTS idx_user_role_scopes_user_id
  ON tbl_user_role_scopes(user_id);

CREATE INDEX IF NOT EXISTS idx_user_department_user_id
  ON tbl_user_department(user_id);

-- Approval instance lookups by status (used in all propagation queries)
CREATE INDEX IF NOT EXISTS idx_approval_instances_status
  ON tbl_approval_instances(status);

-- Approval instance steps: lookup by instance + status (join in propagation)
CREATE INDEX IF NOT EXISTS idx_approval_instance_steps_instance_status
  ON tbl_approval_instance_steps(approval_instance_id, status);

-- Step approvers: lookup by step + user + status (the hot path in every propagation query)
CREATE INDEX IF NOT EXISTS idx_approval_step_approvers_step_user_status
  ON tbl_approval_step_approvers(approval_instance_step_id, approver_user_id, status);

-- Approver lookup by user + status (used when finding all pending approvals for a user)
CREATE INDEX IF NOT EXISTS idx_approval_step_approvers_user_status
  ON tbl_approval_step_approvers(approver_user_id, status);

-- Policy steps: source type + source id (used when scoping by changed role/dept)
CREATE INDEX IF NOT EXISTS idx_approval_policy_steps_source
  ON tbl_approval_policy_steps(approver_source_type, approver_source_id);

-- Hospitality user mappings: user + company (used in resolveApprovers)
CREATE INDEX IF NOT EXISTS idx_hospitality_user_mappings_user_company
  ON tbl_hospitality_user_mappings(user_id, hospitality_company_id);

-- Role permissions: role_id (used in every permission check join)
CREATE INDEX IF NOT EXISTS idx_role_permissions_role_id
  ON tbl_role_permissions(role_id);

-- Policy steps: lookup by policy + step_order (used for stable JOIN instead of stale policy_step_id)
CREATE INDEX IF NOT EXISTS idx_approval_policy_steps_policy_order
  ON tbl_approval_policy_steps(approval_policy_id, step_order);

-- User role scopes: composite for permission resolution
CREATE INDEX IF NOT EXISTS idx_user_role_scopes_user_company
  ON tbl_user_role_scopes(user_id, company_id);
