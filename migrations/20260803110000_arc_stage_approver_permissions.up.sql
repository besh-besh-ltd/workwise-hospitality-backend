-- ARC v2 — the missing *approver* half of the technical and commercial stages.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
-- ARC v2 modelled an EVALUATOR role per stage and never modelled an APPROVER
-- role. RFQ has both, and has had since the beginning:
--
--   role  7  'Technical Approver'   → te.read           + te.approve
--   role 12  'Commercial Approver'  → negotiation.read  + negotiation.approve
--                                     quote-compare.read + quote-compare.approve
--
-- ARC has no analogue. Before this migration the ARC-stage resources carried:
--
--   arc            read/create/admin (+ approve, legacy)   ❌ no read+approve role
--   arc-tech       evaluate (20260608100800) + read (20260611100000)  ❌ no approve
--   arc-comm       evaluate (20260608100800) + read (20260611100000)  ❌ no approve
--   arc-committee  read + approve (20260608100800)                    ✅ complete
--
-- `createApprovalInstance` (generalModel.js) drops a ROLE-source policy step
-- whose role lacks BOTH `read` and `approve` on the entity type's resource. With
-- no `approve` row in existence for arc-tech / arc-comm, NO role could ever
-- qualify: every ROLE step of an ARC_TECH or ARC_NEGOTIATION policy was destined
-- to be dropped, and an instance whose every step is dropped is born
-- `APPROVED, current_step = 0` — a negotiation round going live with nobody
-- having approved it. The admin Approval Wizard offers both stages and defaults
-- each level to approver_source_type = 'ROLE', so this was one saved policy away
-- from firing in production.
--
-- ── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--   1. permission keys  arc-tech.approve  and  arc-comm.approve
--   2. system role 'ARC Technical Approver'   → arc-tech.read + arc-tech.approve
--   3. system role 'ARC Negotiation Approver' → arc-comm.read + arc-comm.approve
--   4. arc.read on the legacy system role 'ARC Approver' (id 16 in production),
--      which has held arc.approve alone since inception and therefore failed its
--      own gate by exactly one row.
--
-- ── SEPARATION OF DUTIES (deliberate omissions) ────────────────────────────
-- The new approve keys are NOT granted to 'ARC Tech Evaluator', 'ARC Commercial
-- Evaluator' or 'ARC Admin'. The first two are the roles whose work is being
-- approved. 'ARC Admin' already holds arc-tech.evaluate + arc-comm.evaluate, so
-- adding either new key would let one role both score an evaluation and sign it
-- off. A tenant that genuinely wants one person doing both can grant that user
-- both roles — a visible, auditable, per-user choice, unlike a role that
-- silently carries both verbs.
--
-- ⚠️  DO NOT READ THAT AS "ARC Admin CANNOT APPROVE ANYTHING". It is not true,
--     and it was not made true here. 'ARC Admin' has held
--     arc-committee.read + arc-committee.approve since 20260608100800, and that
--     is the pair `ARC_COMMITTEE` gates on. Meanwhile arc-comm.evaluate is what
--     `requireArcPermission` checks on POST /commercial/finalize
--     (arc_v2/evaluationRoutes.js → arcEvaluationController.finalizeCommEval),
--     and that handler spawns the ARC_COMMITTEE instance with
--     `initiated_by = <the same user>`.
--
--     So a single ARC Admin can allocate the award, finalize commercial, and
--     then be a resolved approver on the committee gate over that same award.
--     If they are the only resolved approver, createApprovalInstance's
--     `isInitiatorInStep` short-circuit auto-approves it.
--
--     That is a PRE-EXISTING separation-of-duties gap on the AWARD stage,
--     untouched by this migration — closing it means removing
--     arc-committee.approve from 'ARC Admin', which is a product decision with
--     its own blast radius, not a side effect of adding tech/commercial
--     approvers. It is written down here so the omission reads as a known gap
--     rather than a claim that ARC Admin is fully separated.
--     Pinned by tests/services/arc.approvers.stageRoles.test.js.
--
-- Idempotent + forward-only: every statement is NOT EXISTS-guarded, so re-runs
-- and partially-applied databases are both safe.
--
-- ⚠️  TEST DATABASES DO NOT RUN MIGRATIONS. tests/setup/prepareTestDb.js builds
--     them from schema.sql + seed_reference.sql only. The identical seed is
--     mirrored into tests/setup/seed_reference.sql; the two must be changed
--     together or the test DB and production silently diverge.

-- ----------------------------------------------------------------
-- Step 0: pre-flight — the enums must already carry what we rely on.
-- ----------------------------------------------------------------
-- 'approve' is an original member of permission_action_type and 'arc-tech' /
-- 'arc-comm' were added by 20260608100800. Assert rather than assume: a missing
-- label would otherwise surface as an opaque "invalid input value for enum"
-- halfway through the insert below.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'approve' AND enumtypid = 'public.permission_action_type'::regtype
  ) THEN
    RAISE EXCEPTION 'permission_action_type is missing the ''approve'' label — cannot seed ARC approver permissions';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'arc-tech' AND enumtypid = 'public.resource_type'::regtype
  ) THEN
    RAISE EXCEPTION 'resource_type is missing the ''arc-tech'' label — run 20260608100800_permissions_seed.sql first';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'arc-comm' AND enumtypid = 'public.resource_type'::regtype
  ) THEN
    RAISE EXCEPTION 'resource_type is missing the ''arc-comm'' label — run 20260608100800_permissions_seed.sql first';
  END IF;
END $$;

-- ----------------------------------------------------------------
-- Step 1: the two missing permission keys (+ the reads they pair with).
-- ----------------------------------------------------------------
-- `arc-tech.approve` and `arc-comm.approve` are what this migration is FOR.
-- The three `read` rows below already exist in any database that has run
-- 20260608100800 and 20260611100000, so they are no-ops there. They are
-- repeated because the grants in Step 3 need them and a NOT EXISTS insert costs
-- nothing — it makes this file runnable standalone instead of silently
-- depending on the ordering of two earlier files. Without them a fresh schema
-- fails at Step 3's assert rather than producing a usable role.

INSERT INTO public.tbl_permissions (resource, action, ordering)
SELECT v.resource::public.resource_type, v.action::public.permission_action_type, 0
FROM (VALUES
  ('arc-tech', 'approve'),
  ('arc-comm', 'approve'),
  ('arc-tech', 'read'),      -- 20260611100000, repeated idempotently
  ('arc-comm', 'read'),      -- 20260611100000, repeated idempotently
  ('arc',      'read')       -- 20260608100800, repeated idempotently
) AS v(resource, action)
WHERE NOT EXISTS (
  SELECT 1 FROM public.tbl_permissions p
  WHERE p.resource::text = v.resource AND p.action::text = v.action
);

-- ----------------------------------------------------------------
-- Step 2: the two approver roles (system roles, created_by = NULL).
-- ----------------------------------------------------------------
-- Descriptions deliberately mirror the voice of RFQ roles 7 and 12
-- ('Approves technical evaluations' / 'Approves commercial negotiations').

INSERT INTO public.tbl_roles (title, description, created_by)
SELECT v.title, v.description, NULL
FROM (VALUES
  ('ARC Technical Approver',   'Approves technical evaluations on Annual Rate Contracts.'),
  ('ARC Negotiation Approver', 'Approves the launch of negotiation rounds on Annual Rate Contracts.')
) AS v(title, description)
WHERE NOT EXISTS (
  SELECT 1 FROM public.tbl_roles r WHERE r.title = v.title AND r.created_by IS NULL
);

-- ----------------------------------------------------------------
-- Step 3: map roles to permissions.
-- ----------------------------------------------------------------
-- Same structure as 20260608100800 Step 4. 'ARC Approver' is included only to
-- add the arc.read row it has always been missing; its arc.approve is untouched.

DO $$
DECLARE
  r RECORD;
  perms_to_assign TEXT[];
  perm_resource TEXT;
  perm_action   TEXT;
  perm_id       INTEGER;
  role_perm_pair TEXT;
BEGIN
  FOR r IN
    SELECT id, title FROM public.tbl_roles
    WHERE created_by IS NULL
      AND title IN ('ARC Technical Approver', 'ARC Negotiation Approver', 'ARC Approver')
  LOOP
    perms_to_assign := CASE r.title
      WHEN 'ARC Technical Approver'   THEN ARRAY['arc-tech.read','arc-tech.approve']
      WHEN 'ARC Negotiation Approver' THEN ARRAY['arc-comm.read','arc-comm.approve']
      -- Legacy role, holds arc.approve already; one row short of passing the
      -- read+approve gate for entity types ARC and ARC_PUBLISH.
      WHEN 'ARC Approver'             THEN ARRAY['arc.read']
      ELSE                                 ARRAY[]::TEXT[]
    END;

    FOREACH role_perm_pair IN ARRAY perms_to_assign
    LOOP
      perm_resource := split_part(role_perm_pair, '.', 1);
      perm_action   := split_part(role_perm_pair, '.', 2);

      SELECT id INTO perm_id
      FROM public.tbl_permissions p
      WHERE p.resource::text = perm_resource AND p.action::text = perm_action
      LIMIT 1;

      IF perm_id IS NULL THEN
        RAISE EXCEPTION 'permission % not found — cannot grant it to role %', role_perm_pair, r.title;
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
