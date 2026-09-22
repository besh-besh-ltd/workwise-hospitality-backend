-- Reports module: the `reports.*` permission catalogue.
--
-- The brief is that a user may see and download only the reports they are
-- entitled to, so entitlement has to be per REPORT, not per module. One
-- `reports.read` would make the Spend-by-Vendor report and the Approval Audit
-- Trail the same grant, and those are very different disclosures: the first is
-- commercial, the second names individuals and their decisions.
--
-- That is the same shape `dashboard` already uses — one action per widget, 26
-- of them (20260526120000_add_dashboard_widget_permissions.sql) — so this adds
-- nothing new to the mental model or to the admin UI, which lists whatever is
-- in tbl_permissions.
--
-- There is deliberately no `reports.read`. The catalogue endpoint returns the
-- reports the caller holds a permission for, and the page renders access-denied
-- when that list is empty. A separate module-level gate would only create a
-- state where a user passes the gate and still sees nothing.
--
-- Grants: every report is granted to the existing `Company Administrator`
-- system role and to nothing else. The dashboard migration's precedent is to
-- grant nothing and make an admin assign explicitly, which is right for the
-- other roles — but a company administrator already administers the company,
-- and without this the module ships unreachable by anyone.
--
-- Additive and reversible (bar the enum values — see the .down.sql).

-- Two transactions, deliberately. Postgres refuses to use a new enum value in
-- the transaction that added it ("New enum values must be committed before
-- they can be used"), so the seed below cannot share a block with the ALTERs.
BEGIN;

ALTER TYPE public.resource_type ADD VALUE IF NOT EXISTS 'reports';

-- One action per report. The names are the report keys the API and the
-- frontend use, so a permission string is readable without a lookup table:
-- `reports.spend_by_vendor` is report 1.4.
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'spend_summary';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'spend_by_category';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'spend_by_property';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'spend_by_vendor';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'vendor_compliance';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'vendor_concentration';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'vendor_master';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'open_po_register';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'po_aging_by_approver';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'po_cancel_amend';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'budget_vs_actual';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'forecast_vs_actual';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'approval_audit_trail';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'policy_violations';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'document_expiry';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'po_approval_tat';

COMMIT;

BEGIN;

-- Seed one permission per report. `ordering` groups them by report family so
-- the admin picker shows 1.1-1.4 together, then 2.x, and so on.
INSERT INTO public.tbl_permissions (resource, action, ordering)
SELECT 'reports'::public.resource_type,
       v.action::public.permission_action_type,
       v.ordering
  FROM (VALUES
          -- 3.1 Spend Analytics
          ('spend_summary',        100),
          ('spend_by_category',    101),
          ('spend_by_property',    102),
          ('spend_by_vendor',      103),
          -- 3.2 Vendor Reports
          ('vendor_compliance',    110),
          ('vendor_concentration', 111),
          ('vendor_master',        112),
          -- 3.3 Purchase Orders
          ('open_po_register',     120),
          ('po_aging_by_approver', 121),
          ('po_cancel_amend',      122),
          -- 3.4 Budget & Cost Control
          ('budget_vs_actual',     130),
          ('forecast_vs_actual',   131),
          -- 3.5 Compliance & Audit
          ('approval_audit_trail', 140),
          ('policy_violations',    141),
          ('document_expiry',      142),
          -- 3.6 Operational KPIs
          ('po_approval_tat',      150)
       ) AS v(action, ordering)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.tbl_permissions p
    WHERE p.resource = 'reports'::public.resource_type
      AND p.action = v.action::public.permission_action_type
 );

-- Grant the full set to Company Administrator, which already carries
-- `company.admin`. Idempotent, and a no-op if that role has not been seeded.
INSERT INTO public.tbl_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.tbl_roles r
  CROSS JOIN public.tbl_permissions p
 WHERE r.title = 'Company Administrator'
   AND p.resource = 'reports'::public.resource_type
   AND NOT EXISTS (
     SELECT 1 FROM public.tbl_role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id
   );

COMMIT;
