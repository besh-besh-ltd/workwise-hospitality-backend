-- Retire the "Proxy Approver" system role (client feedback 2026-10-19).
--
-- The role was never used: on prod, stage and test it has 0 user grants
-- (tbl_user_role_scopes) and 0 approval-policy steps, and standing delegation
-- is now handled by approval delegations (20260829095000). It only confuses the
-- role picker. No foreign key references tbl_roles, so deletion is plain.
--
-- Keyed on title + created_by IS NULL, never on id (ids differ per
-- environment); if the role is absent the migration is a no-op, so re-running
-- is safe.
--
-- Step 0 REFUSES to run if any tbl_user_role_scopes row or ROLE-source
-- tbl_approval_policy_steps row still references the role - deleting it would
-- leave dangling role ids that a later re-create could silently rebind.
-- Then: delete its tbl_role_permissions rows (prod has 17, including a
-- duplicate tender.approve), its tbl_dashboard_seed_grants rows (table only
-- exists where 20260928102000 ran, hence to_regclass), and the role itself.

BEGIN;

DO $$
DECLARE
  rid       INTEGER;
  offending INTEGER;
BEGIN
  SELECT id INTO rid FROM public.tbl_roles
   WHERE title = 'Proxy Approver' AND created_by IS NULL
   ORDER BY id LIMIT 1;

  IF rid IS NULL THEN
    RETURN;
  END IF;

  SELECT (SELECT count(*) FROM public.tbl_user_role_scopes WHERE role_id = rid)
       + (SELECT count(*) FROM public.tbl_approval_policy_steps
           WHERE approver_source_type = 'ROLE' AND approver_source_id = rid)
    INTO offending;

  IF offending > 0 THEN
    RAISE EXCEPTION
      'Refusing to retire Proxy Approver (role %): % user grant(s)/policy step(s) still reference it. Re-point or remove them first.',
      rid, offending;
  END IF;

  IF to_regclass('public.tbl_dashboard_seed_grants') IS NOT NULL THEN
    DELETE FROM public.tbl_dashboard_seed_grants WHERE role_id = rid;
  END IF;

  DELETE FROM public.tbl_role_permissions WHERE role_id = rid;
  DELETE FROM public.tbl_roles WHERE id = rid;
END $$;

COMMIT;
