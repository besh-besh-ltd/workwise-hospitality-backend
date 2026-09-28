-- Reverse 20260928100000: restore the five retired widgets (with the grants the
-- up migration backed up) and remove the two widgets it introduced.
--
-- Not reversed: registering codes that already existed (prod had them before)
-- and the persona ordering; enum values cannot be dropped and are harmless.
-- Run 20260928102000.down.sql first if the seed grants were applied.

BEGIN;

ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'tech_approval_oldest_pending';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'deals_with_price_anomalies';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'tech_eval_throughput';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'tech_approval_throughput';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'commercial_approval_throughput';

COMMIT;

BEGIN;

INSERT INTO public.tbl_permissions (resource, action, ordering)
SELECT 'dashboard'::public.resource_type,
       v.action::public.permission_action_type,
       v.ordering
  FROM (VALUES
          ('tech_eval_throughput',           22),
          ('tech_approval_oldest_pending',   31),
          ('tech_approval_throughput',       32),
          ('deals_with_price_anomalies',     51),
          ('commercial_approval_throughput', 52)
       ) AS v(action, ordering)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.tbl_permissions p
    WHERE p.resource::text = 'dashboard' AND p.action::text = v.action
 );

DO $$
BEGIN
  IF to_regclass('public.tbl_dashboard_v3_cut_grants') IS NOT NULL THEN
    INSERT INTO public.tbl_role_permissions (role_id, permission_id)
    SELECT g.role_id, p.id
      FROM public.tbl_dashboard_v3_cut_grants g
      JOIN public.tbl_permissions p
        ON p.resource::text = 'dashboard' AND p.action::text = g.action
     WHERE NOT EXISTS (
       SELECT 1 FROM public.tbl_role_permissions rp
        WHERE rp.role_id = g.role_id AND rp.permission_id = p.id
     );
    DROP TABLE public.tbl_dashboard_v3_cut_grants;
  END IF;
END $$;

DELETE FROM public.tbl_role_permissions rp
 USING public.tbl_permissions p
 WHERE rp.permission_id = p.id
   AND p.resource::text = 'dashboard'
   AND p.action::text IN ('my_rfq_approvals_pending', 'approval_turnaround');

DELETE FROM public.tbl_permissions p
 WHERE p.resource::text = 'dashboard'
   AND p.action::text IN ('my_rfq_approvals_pending', 'approval_turnaround');

COMMIT;
