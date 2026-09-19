-- Grant the reports catalogue to the role that was already named for it.
--
-- 20260919120000 granted the sixteen `reports.*` permissions to Company
-- Administrator, which on staging has ZERO assignments. Meanwhile a system
-- role called "Report Download" (created_by IS NULL) is held by 183 users
-- across 491 scope rows and carries awarding.read, boq.read, negotiation.read,
-- quote-compare.read, rfq.read and te.read — precisely the read permissions
-- the reports row-scope predicate correlates against.
--
-- So the module shipped invisible: nobody could open Reports, while the people
-- the platform had already designated as report downloaders held a role that
-- granted nothing report-related. This is the correction.
--
-- ── Why fifteen and not sixteen ─────────────────────────────────────────────
-- `reports.approval_audit_trail` is deliberately NOT granted here. That report
-- names individuals, the decisions they took, and flags self-approvals; it is
-- a different class of disclosure from commercial spend, and 183 readers is
-- the wrong default for it. It stays on Company Administrator, and any other
-- role that should see it can be granted it explicitly in the access UI.
--
-- Additive and idempotent. A fresh environment running both migrations in
-- order arrives at the same place.

BEGIN;

INSERT INTO public.tbl_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.tbl_roles r
  CROSS JOIN public.tbl_permissions p
 WHERE r.title = 'Report Download'
   AND r.created_by IS NULL                      -- the system role, not a lookalike
   AND p.resource::text = 'reports'
   AND p.action::text <> 'approval_audit_trail'  -- see the note above
   AND NOT EXISTS (
     SELECT 1 FROM public.tbl_role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id
   );

COMMIT;
