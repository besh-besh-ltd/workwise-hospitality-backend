-- Down for 20261019100100_retire_proxy_approver: re-create the role.
--
-- Title/description are the original ('Proxy Approver', 'Proxy approver when
-- tender approver is unavailable'). The id was 5 on prod, stage and test; it is
-- reused only if that id is free, otherwise the sequence mints a new one (the
-- role has no user grants or policy steps, so nothing depends on the id).
--
-- Permissions are re-granted by (resource, action) lookup, lowest permission id
-- per pair (tbl_permissions has no unique key on the pair). The set below is the
-- 15 distinct pairs role 5 holds in the test seed after the pending migrations
-- (5 base rows from seed_reference.sql + 10 dashboard widget grants from
-- 20260928102000). Prod held 17 rows for this role - the same pairs, with
-- tender.approve duplicated; the duplicate is intentionally not restored.
-- tbl_dashboard_seed_grants rows are not recreated (that table is a scratch
-- ledger for 20260928102000's own down).
--
-- Idempotent: does nothing if a system role titled 'Proxy Approver' exists.

BEGIN;

DO $$
DECLARE
  rid INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tbl_roles
              WHERE title = 'Proxy Approver' AND created_by IS NULL) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tbl_roles WHERE id = 5) THEN
    INSERT INTO public.tbl_roles (id, title, description, created_by)
    VALUES (5, 'Proxy Approver', 'Proxy approver when tender approver is unavailable', NULL)
    RETURNING id INTO rid;
  ELSE
    INSERT INTO public.tbl_roles (title, description, created_by)
    VALUES ('Proxy Approver', 'Proxy approver when tender approver is unavailable', NULL)
    RETURNING id INTO rid;
  END IF;

  INSERT INTO public.tbl_role_permissions (role_id, permission_id)
  SELECT rid, min(p.id)
    FROM public.tbl_permissions p
    JOIN (VALUES
      ('rfq','read'), ('rfq','approve'), ('tender','approve'),
      ('boq','read'), ('boq','approve'),
      ('dashboard','action_center'), ('dashboard','procurement_snapshot'),
      ('dashboard','negotiation_savings'), ('dashboard','cost_intelligence'),
      ('dashboard','category_insights'), ('dashboard','abc_analysis'),
      ('dashboard','workflow_efficiency'), ('dashboard','smart_insights'),
      ('dashboard','my_rfq_approvals_pending'), ('dashboard','approval_turnaround')
    ) AS want(resource, action)
      ON p.resource::text = want.resource AND p.action::text = want.action
   GROUP BY want.resource, want.action;
END $$;

COMMIT;
