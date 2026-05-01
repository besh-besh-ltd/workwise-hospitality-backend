-- =============================================================================
-- Migration: Mid-Flight Approval Policy Change Propagation
-- Description: Adds audit tables, status columns, and version tracking to
--              support dynamic propagation of policy/membership changes to
--              in-flight (PENDING) approval instances.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. New Table: tbl_approval_policy_change_log
--    Central audit for all propagation events (policy changes & membership changes)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tbl_approval_policy_change_log (
  id                    SERIAL PRIMARY KEY,
  approval_policy_id    INTEGER,                              -- NULL for membership-only changes
  changed_by            INTEGER NOT NULL,                     -- user who triggered the change
  change_type           TEXT NOT NULL,                        -- POLICY_STEPS_CHANGED | ROLE_MEMBERSHIP_CHANGED | DEPT_MEMBERSHIP_CHANGED | USER_STATUS_CHANGED | SCOPE_MAPPING_CHANGED
  change_summary        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- full diff payload
  affected_instance_ids INTEGER[] DEFAULT '{}',               -- instance IDs updated by this event
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_policy_change_log_policy
  ON tbl_approval_policy_change_log(approval_policy_id);

CREATE INDEX IF NOT EXISTS idx_policy_change_log_created
  ON tbl_approval_policy_change_log(created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. New Table: tbl_approval_instance_change_log
--    Per-instance audit trail of what changed due to propagation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tbl_approval_instance_change_log (
  id                    SERIAL PRIMARY KEY,
  approval_instance_id  INTEGER NOT NULL,
  policy_change_log_id  INTEGER REFERENCES tbl_approval_policy_change_log(id),
  change_summary        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Example shape:
  -- {
  --   "reason": "policy_change" | "role_removed" | "dept_removed" | "user_deactivated" | "scope_removed",
  --   "approvers_added": [{ "user_id": 5, "step_order": 2, "user_name": "..." }],
  --   "approvers_removed": [{ "user_id": 3, "step_order": 1, "user_name": "..." }],
  --   "steps_added": [{ "step_order": 4 }],
  --   "steps_removed": [{ "step_order": 2 }],
  --   "rules_changed": [{ "step_order": 1, "old_rule": "ALL", "new_rule": "ANY" }]
  -- }
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instance_change_log_instance
  ON tbl_approval_instance_change_log(approval_instance_id);

CREATE INDEX IF NOT EXISTS idx_instance_change_log_policy_change
  ON tbl_approval_instance_change_log(policy_change_log_id);

-- ---------------------------------------------------------------------------
-- 3. Column additions: tbl_approval_step_approvers
--    Support REMOVED status and mid-flight tracking
-- ---------------------------------------------------------------------------
ALTER TABLE tbl_approval_step_approvers
  ADD COLUMN IF NOT EXISTS removed_at       TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS removal_reason   TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS added_mid_flight BOOLEAN DEFAULT FALSE;

-- Relax status CHECK constraint to allow 'REMOVED' (added by mid-flight propagation).
-- Original constraint only allowed: PENDING, APPROVED, REJECTED.
ALTER TABLE tbl_approval_step_approvers
  DROP CONSTRAINT IF EXISTS tbl_approval_step_approvers_status_check;
ALTER TABLE tbl_approval_step_approvers
  ADD CONSTRAINT tbl_approval_step_approvers_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'REMOVED'));

-- ---------------------------------------------------------------------------
-- 4. Column additions: tbl_approval_instance_steps
--    Track mid-flight step additions and removals
-- ---------------------------------------------------------------------------
ALTER TABLE tbl_approval_instance_steps
  ADD COLUMN IF NOT EXISTS added_mid_flight   BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS removed_mid_flight BOOLEAN DEFAULT FALSE;

-- Relax status CHECK constraint to allow 'REMOVED' and 'SKIPPED' (added by mid-flight propagation).
-- Original constraint only allowed: PENDING, APPROVED, REJECTED, CANCELLED.
ALTER TABLE tbl_approval_instance_steps
  DROP CONSTRAINT IF EXISTS tbl_approval_instance_steps_status_check;
ALTER TABLE tbl_approval_instance_steps
  ADD CONSTRAINT tbl_approval_instance_steps_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REMOVED', 'SKIPPED'));

-- ---------------------------------------------------------------------------
-- 5. Version tracking: tbl_approval_policies
--    Increments on each policy update for optimistic concurrency
-- ---------------------------------------------------------------------------
ALTER TABLE tbl_approval_policies
  ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- ---------------------------------------------------------------------------
-- 6. Version tracking: tbl_approval_instances
--    Records which policy version this instance was last synced with
-- ---------------------------------------------------------------------------
ALTER TABLE tbl_approval_instances
  ADD COLUMN IF NOT EXISTS policy_version INTEGER DEFAULT 1;

-- ---------------------------------------------------------------------------
-- 7. tbl_approval_actions: expand action CHECK constraint
--    Original constraint only allowed: APPROVE, REJECT.
--    The propagation engine emits additional audit-trail action types when
--    mid-flight changes mutate instances (approver added/removed, step
--    added/removed, policy revalidated, etc). Without this relaxation, the
--    propagation tx fails with constraint 23514 and rolls back.
-- ---------------------------------------------------------------------------
ALTER TABLE tbl_approval_actions
  DROP CONSTRAINT IF EXISTS tbl_approval_actions_action_check;
ALTER TABLE tbl_approval_actions
  ADD CONSTRAINT tbl_approval_actions_action_check
  CHECK (action IN (
    'APPROVE',
    'REJECT',
    'CANCELLED',
    'POLICY_CHANGE',
    'APPROVER_REMOVED',
    'APPROVER_ADDED',
    'STEP_REMOVED',
    'STEP_ADDED',
    'MEMBERSHIP_REVALIDATION'
  ));

COMMIT;
