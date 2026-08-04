-- Down: remove the ARC stage approver roles and the arc-tech/arc-comm approve keys.
--
-- ⚠️  THIS IS A ONE-WAY DOOR. It is a rollback, not half of a round trip.
--
-- The two roles are created by `INSERT ... SELECT` with no explicit id, exactly
-- like every other system role in this tree (20260608100800 does the same), so
-- their ids come from tbl_roles_id_seq. Re-running the UP after this DOWN
-- therefore mints DIFFERENT ids, while `tbl_approval_policy_steps
-- .approver_source_id` still holds the OLD ones — silently re-pointing approval
-- policies at whatever role now occupies that id.
--
-- Fixing that by hard-coding ids is not available: production's tbl_roles_id_seq
-- is already well past any value this file could safely claim, and colliding
-- with a tenant's custom role would be far worse than the problem. So instead of
-- pretending the cycle is safe, Step 0 REFUSES to run while any policy step
-- still names one of these roles. Clean the policies up first, deliberately,
-- and the down is then genuinely harmless.
--
-- Also deliberately unconditional: the arc.read un-grant on 'ARC Approver' in
-- Step 1. It is the exact inverse of what the up did. If someone granted that
-- row independently in between, this removes it — unknowable from here, and a
-- rollback that leaves half its changes behind is the worse failure mode.
--
-- 'arc.read' the PERMISSION is never dropped — it belongs to 20260608100800.
-- Neither are 'arc-tech.read' / 'arc-comm.read' (20260611100000), which the up
-- re-inserts idempotently and may therefore have created on a fresh schema;
-- dropping them here would delete another migration's rows.

-- ----------------------------------------------------------------
-- Step 0: refuse if any approval policy still points at these roles.
-- ----------------------------------------------------------------
DO $$
DECLARE
  offending INTEGER;
BEGIN
  SELECT count(*) INTO offending
  FROM public.tbl_approval_policy_steps s
  JOIN public.tbl_roles r ON r.id = s.approver_source_id
  WHERE s.approver_source_type = 'ROLE'
    AND r.created_by IS NULL
    AND r.title IN ('ARC Technical Approver', 'ARC Negotiation Approver');

  IF offending > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop the ARC approver roles: % approval policy step(s) still name them. Re-point or delete those steps first — dropping the roles here would leave dangling approver_source_id values that a later re-run of the UP would silently rebind to different roles.',
      offending;
  END IF;
END $$;

-- 1. Un-grant arc.read from the legacy 'ARC Approver' role.
DELETE FROM public.tbl_role_permissions rp
USING public.tbl_roles r, public.tbl_permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.title = 'ARC Approver'
  AND r.created_by IS NULL
  AND p.resource::text = 'arc'
  AND p.action::text = 'read';

-- 2. Drop every grant held by the two new roles, then the roles themselves.
DELETE FROM public.tbl_user_role_scopes urs
USING public.tbl_roles r
WHERE urs.role_id = r.id
  AND r.created_by IS NULL
  AND r.title IN ('ARC Technical Approver', 'ARC Negotiation Approver');

DELETE FROM public.tbl_role_permissions rp
USING public.tbl_roles r
WHERE rp.role_id = r.id
  AND r.created_by IS NULL
  AND r.title IN ('ARC Technical Approver', 'ARC Negotiation Approver');

DELETE FROM public.tbl_roles r
WHERE r.created_by IS NULL
  AND r.title IN ('ARC Technical Approver', 'ARC Negotiation Approver');

-- 3. Drop the two permission keys and any remaining grant of them.
DELETE FROM public.tbl_role_permissions rp
USING public.tbl_permissions p
WHERE rp.permission_id = p.id
  AND p.action::text = 'approve'
  AND p.resource::text IN ('arc-tech', 'arc-comm');

DELETE FROM public.tbl_permissions p
WHERE p.action::text = 'approve'
  AND p.resource::text IN ('arc-tech', 'arc-comm');
