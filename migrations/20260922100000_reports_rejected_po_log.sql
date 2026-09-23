-- Report 3.3 becomes the Rejected PO Log, and is restricted to administrators.
--
-- Product dropped the "Cancelled / Amended PO Log" from the approved pack: the
-- platform keeps no PO revision trail, so amendments cannot be reported. They
-- asked for the rejection record instead, which the approval engine has kept
-- all along. The permission key is renamed to say what the report now is.
--
-- Renamed rather than added-and-dropped, because the grant rows reference the
-- enum value by OID: RENAME VALUE carries every existing grant with it, and an
-- add-then-delete would silently drop them. Nothing has reached production yet,
-- which is what makes this the cheap moment to do it.
--
-- ── Access ──────────────────────────────────────────────────────────────────
-- 20260920090000 granted this report to "Report Download" (183 users on
-- staging) along with fourteen others. Its replacement names the approver who
-- rejected each PO and quotes their comment, which is the same class of
-- disclosure the Approval Audit Trail was kept off that role for. It comes off
-- here and stays with Company Administrator.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum
              WHERE enumtypid = 'permission_action_type'::regtype
                AND enumlabel = 'po_cancel_amend')
     AND NOT EXISTS (SELECT 1 FROM pg_enum
                      WHERE enumtypid = 'permission_action_type'::regtype
                        AND enumlabel = 'po_rejections') THEN
    ALTER TYPE public.permission_action_type RENAME VALUE 'po_cancel_amend' TO 'po_rejections';
  END IF;
END $$;

DELETE FROM public.tbl_role_permissions rp
 USING public.tbl_roles r, public.tbl_permissions p
 WHERE rp.role_id = r.id
   AND rp.permission_id = p.id
   AND r.title = 'Report Download'
   AND r.created_by IS NULL
   AND p.resource::text = 'reports'
   AND p.action::text = 'po_rejections';

COMMIT;
