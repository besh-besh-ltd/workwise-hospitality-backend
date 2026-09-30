-- Up: 20260803100000_approval_mid_flight_propagation.sql
-- Mid-flight approval policy/membership change propagation — the DDL the
-- reconciler (app/services/approvalPropagationService.js) and every
-- REMOVED-aware display surface depend on.
--
-- WHY THIS FILE EXISTS SO LATE: production and staging already have all of
-- this — it was applied by hand from an unmerged WIP branch and only ever
-- captured in tests/setup/schema.sql (a pg_dump of production, which is how CI
-- stayed green). It was never landed in migrations/, so any environment
-- rebuilt from the migration set lacked the entire REMOVED mechanism. That is
-- no longer a soft failure: quoteCompareViewModel.js now names
-- sa.removal_reason / sa.removed_at explicitly, so a rebuilt environment
-- errors at query time rather than degrading.
--
-- EVERY STATEMENT IS IDEMPOTENT (CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, DROP CONSTRAINT IF EXISTS before each re-ADD, DO-guarded FK) because
-- the expected case is a database that already has all of it.
--
-- VERIFIED AGAINST tests/setup/schema.sql (the production dump), not against
-- the WIP file. Two differences were found and resolved in favour of the dump:
--   * The dump carries `fk_instance_step_policy_step` (ON DELETE SET NULL,
--     validated) with a NULLABLE policy_step_id. The WIP migration never
--     mentioned either, yet the reconciler's correctness argument rests on
--     exactly that FK semantic (a policy edit DELETEs + re-INSERTs policy
--     steps, and SET NULL is what turns a stale link into a NULL one rather
--     than a wrong one). Both are asserted here, guarded so production is
--     untouched.
--   * The WIP wrote `DEFAULT NULL` on removed_at / removal_reason. Postgres
--     does not record that, and the dump shows no default. Dropped as noise.
--
-- ONE COSMETIC DIFFERENCE, verified harmless: the three CHECKs below are
-- written as `status IN (...)`, which Postgres normalises to
-- `ANY (ARRAY[(...)::text, ...])`, whereas the dump (whose constraints were
-- created with an explicit array cast) renders `ANY ((ARRAY[...])::text[])`.
-- The permitted value SETS are identical — confirmed by comparing the literals
-- pulled out of pg_get_constraintdef() on both sides after a rebuild. Expect
-- those three lines, and only those, to differ when diffing a rebuilt database
-- against tests/setup/schema.sql.
--
-- Apply with: psql $DATABASE_URL -f migrations/20260803100000_approval_mid_flight_propagation.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. tbl_approval_policy_change_log
--    Central audit for every propagation event (policy + membership changes).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tbl_approval_policy_change_log (
  id                    SERIAL PRIMARY KEY,
  approval_policy_id    INTEGER,                              -- NULL for membership-only changes
  changed_by            INTEGER NOT NULL,                     -- user who triggered the change
  change_type           TEXT NOT NULL,                        -- POLICY_STEPS_CHANGED | ROLE_MEMBERSHIP_CHANGED | DEPT_MEMBERSHIP_CHANGED | USER_STATUS_CHANGED | SCOPE_MAPPING_CHANGED
  change_summary        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- full diff payload
  affected_instance_ids INTEGER[] DEFAULT '{}'::integer[],    -- instance ids updated by this event
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_policy_change_log_policy
  ON public.tbl_approval_policy_change_log (approval_policy_id);

CREATE INDEX IF NOT EXISTS idx_policy_change_log_created
  ON public.tbl_approval_policy_change_log (created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. tbl_approval_instance_change_log
--    Per-instance trail of what a propagation event actually changed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tbl_approval_instance_change_log (
  id                    SERIAL PRIMARY KEY,
  approval_instance_id  INTEGER NOT NULL,
  policy_change_log_id  INTEGER REFERENCES public.tbl_approval_policy_change_log(id),
  change_summary        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Shape:
  -- {
  --   "reason": "policy_change" | "role_removed" | "dept_removed" | "user_deactivated" | "scope_removed",
  --   "approvers_added":   [{ "user_id": 5, "step_order": 2, "user_name": "..." }],
  --   "approvers_removed": [{ "user_id": 3, "step_order": 1, "user_name": "..." }],
  --   "steps_added":       [{ "step_order": 4 }],
  --   "steps_removed":     [{ "step_order": 2 }],
  --   "rules_changed":     [{ "step_order": 1, "old_rule": "ALL", "new_rule": "ANY" }]
  -- }
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instance_change_log_instance
  ON public.tbl_approval_instance_change_log (approval_instance_id);

CREATE INDEX IF NOT EXISTS idx_instance_change_log_policy_change
  ON public.tbl_approval_instance_change_log (policy_change_log_id);

-- ---------------------------------------------------------------------------
-- 3. tbl_approval_step_approvers — soft-tombstone columns + relaxed status.
--    The reconciler never DELETEs an approver: it flips status to 'REMOVED'
--    and stamps removed_at + removal_reason, so the audit survives and
--    display surfaces can label the row instead of losing it.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tbl_approval_step_approvers
  ADD COLUMN IF NOT EXISTS removed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removal_reason   TEXT,
  ADD COLUMN IF NOT EXISTS added_mid_flight BOOLEAN DEFAULT FALSE;

-- Original constraint allowed only PENDING, APPROVED, REJECTED.
ALTER TABLE public.tbl_approval_step_approvers
  DROP CONSTRAINT IF EXISTS tbl_approval_step_approvers_status_check;
ALTER TABLE public.tbl_approval_step_approvers
  ADD  CONSTRAINT tbl_approval_step_approvers_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'REMOVED'));

-- ---------------------------------------------------------------------------
-- 4. tbl_approval_instance_steps — mid-flight step tracking + relaxed status.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tbl_approval_instance_steps
  ADD COLUMN IF NOT EXISTS added_mid_flight   BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS removed_mid_flight BOOLEAN DEFAULT FALSE;

-- Original constraint allowed only PENDING, APPROVED, REJECTED, CANCELLED.
ALTER TABLE public.tbl_approval_instance_steps
  DROP CONSTRAINT IF EXISTS tbl_approval_instance_steps_status_check;
ALTER TABLE public.tbl_approval_instance_steps
  ADD  CONSTRAINT tbl_approval_instance_steps_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REMOVED', 'SKIPPED'));

-- The reconciler resolves an instance step back to its policy step by stored
-- id first and by ordinal only as a fallback. That is sound ONLY because a
-- policy edit (DELETE + re-INSERT of every policy step) NULLs the link rather
-- than leaving a stale id behind — i.e. because the FK is ON DELETE SET NULL
-- and policy_step_id is nullable. Both are already true in production; these
-- two statements are no-ops there and exist so a rebuilt database inherits the
-- same guarantee. DROP NOT NULL is catalog-only; the FK is added only when
-- absent, so no existing environment pays for a re-validation scan.
ALTER TABLE public.tbl_approval_instance_steps
  ALTER COLUMN policy_step_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname  = 'fk_instance_step_policy_step'
       AND conrelid = 'public.tbl_approval_instance_steps'::regclass
  ) THEN
    ALTER TABLE public.tbl_approval_instance_steps
      ADD CONSTRAINT fk_instance_step_policy_step
      FOREIGN KEY (policy_step_id)
      REFERENCES public.tbl_approval_policy_steps(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Version tracking. tbl_approval_policies.version increments on every
--    policy update; tbl_approval_instances.policy_version records which
--    version an in-flight instance was last reconciled against.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tbl_approval_policies
  ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

ALTER TABLE public.tbl_approval_instances
  ADD COLUMN IF NOT EXISTS policy_version INTEGER DEFAULT 1;

-- ---------------------------------------------------------------------------
-- 6. tbl_approval_actions — the propagation engine writes audit-trail action
--    types beyond APPROVE/REJECT. Without this the whole propagation tx fails
--    with 23514 and rolls back.
--
--    NOTE (matches production exactly, deliberately not "fixed" here):
--    `action` is VARCHAR(20) while 'MEMBERSHIP_REVALIDATION' is 23 characters,
--    so that one value is permitted by the CHECK but unwritable. No code path
--    emits it (verified by grep across app/), so it is dead-but-harmless. It
--    is kept verbatim so this file reproduces production rather than diverging
--    from it; widening the column belongs in its own migration if the value is
--    ever needed.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tbl_approval_actions
  DROP CONSTRAINT IF EXISTS tbl_approval_actions_action_check;
ALTER TABLE public.tbl_approval_actions
  ADD  CONSTRAINT tbl_approval_actions_action_check
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
