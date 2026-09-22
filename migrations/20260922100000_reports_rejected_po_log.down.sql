-- Restore the old key and the Report Download grant.

BEGIN;

INSERT INTO public.tbl_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.tbl_roles r
  CROSS JOIN public.tbl_permissions p
 WHERE r.title = 'Report Download'
   AND r.created_by IS NULL
   AND p.resource::text = 'reports'
   AND p.action::text = 'po_rejections'
   AND NOT EXISTS (SELECT 1 FROM public.tbl_role_permissions rp
                    WHERE rp.role_id = r.id AND rp.permission_id = p.id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum
              WHERE enumtypid = 'permission_action_type'::regtype
                AND enumlabel = 'po_rejections') THEN
    ALTER TYPE public.permission_action_type RENAME VALUE 'po_rejections' TO 'po_cancel_amend';
  END IF;
END $$;

COMMIT;
