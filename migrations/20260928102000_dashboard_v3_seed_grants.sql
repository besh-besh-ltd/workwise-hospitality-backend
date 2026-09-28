-- Buyer dashboard V3 — default widget grants, by capability.
--
-- Production had the 27 dashboard.* permissions but ZERO grants, so turning V3
-- on would have shown every buyer the "no access" page. System roles are
-- read-only in the admin UI (rbacController refuses created_by IS NULL), so the
-- defaults have to ship here.
--
-- Grants follow what a role can already DO, never a role id or title (ids
-- differ between staging and production):
--
--   cross-role cards (8)        every role holding any procurement permission
--                               — parity with the legacy dashboard, which showed
--                               these cards to every mapped buyer (SPEC D3)
--   RFQ creator (4)             rfq.create
--   technical evaluator (2)     te.create | te.update
--   technical approver          te.approve
--   commercial evaluator (3)    quote-compare.create | negotiation.create
--   negotiated-quote approvals  negotiation.approve | quote-compare.approve
--   PO approvals                awarding.approve
--   recent POs, PO pipeline     awarding.approve | awarding.create
--   RFQ approvals               rfq.approve | tender.approve | boq.approve
--   approval turnaround         any of the approve capabilities above
--   company.admin               every widget
--
-- Checked against production approvers (pending, or acted in the last 120
-- days): every PO, TECHNICAL and NEGOTIATION_QUOTE approver receives the
-- matching widget; 55 of 59 RFQ approvers do — the other four are named on
-- USER-source policy steps without holding an approve capability, and still
-- see those approvals in the Action Centre.
--
-- Rows inserted here are recorded in tbl_dashboard_seed_grants so the down
-- migration removes exactly them and nothing an administrator added.
-- Requires 20260928100000 (the catalogue).

BEGIN;

CREATE TABLE IF NOT EXISTS public.tbl_dashboard_seed_grants (
  role_id       integer     NOT NULL,
  permission_id integer     NOT NULL,
  seeded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

COMMENT ON TABLE public.tbl_dashboard_seed_grants IS
  'Dashboard widget grants inserted by migration 20260928102000, so its down migration removes exactly those. Safe to drop once V3 is settled.';

WITH rules(widget, capability) AS (VALUES
  ('my_drafts',                            'rfq.create'),
  ('my_active_rfqs',                       'rfq.create'),
  ('my_no_response_rfqs',                  'rfq.create'),
  ('my_rfqs_bid_closed_no_quotes',         'rfq.create'),
  ('my_tech_evals_pending',                'te.create'),
  ('my_tech_evals_pending',                'te.update'),
  ('tech_evals_with_vendor_disagreements', 'te.create'),
  ('tech_evals_with_vendor_disagreements', 'te.update'),
  ('my_tech_approvals_pending',            'te.approve'),
  ('my_quote_compares',                    'quote-compare.create'),
  ('my_quote_compares',                    'negotiation.create'),
  ('my_active_negotiations',               'quote-compare.create'),
  ('my_active_negotiations',               'negotiation.create'),
  ('savings_pipeline',                     'quote-compare.create'),
  ('savings_pipeline',                     'negotiation.create'),
  ('my_commercial_approvals_pending',      'negotiation.approve'),
  ('my_commercial_approvals_pending',      'quote-compare.approve'),
  ('my_award_approvals_pending',           'awarding.approve'),
  ('recent_awards',                        'awarding.approve'),
  ('recent_awards',                        'awarding.create'),
  ('award_value_pipeline',                 'awarding.approve'),
  ('award_value_pipeline',                 'awarding.create'),
  ('my_rfq_approvals_pending',             'rfq.approve'),
  ('my_rfq_approvals_pending',             'tender.approve'),
  ('my_rfq_approvals_pending',             'boq.approve'),
  ('approval_turnaround',                  'rfq.approve'),
  ('approval_turnaround',                  'tender.approve'),
  ('approval_turnaround',                  'boq.approve'),
  ('approval_turnaround',                  'te.approve'),
  ('approval_turnaround',                  'negotiation.approve'),
  ('approval_turnaround',                  'quote-compare.approve'),
  ('approval_turnaround',                  'awarding.approve')
),
cross_role(widget) AS (VALUES
  ('action_center'), ('procurement_snapshot'), ('negotiation_savings'), ('cost_intelligence'),
  ('category_insights'), ('abc_analysis'), ('workflow_efficiency'), ('smart_insights')
),
role_caps AS (
  SELECT rp.role_id,
         p.resource::text                        AS resource,
         p.resource::text || '.' || p.action::text AS cap
    FROM public.tbl_role_permissions rp
    JOIN public.tbl_permissions p ON p.id = rp.permission_id
),
wanted AS (
  SELECT rc.role_id, r.widget
    FROM rules r
    JOIN role_caps rc ON rc.cap = r.capability
  UNION
  SELECT rc.role_id, c.widget
    FROM role_caps rc
   CROSS JOIN cross_role c
   WHERE rc.resource IN ('rfq', 'tender', 'te', 'quote-compare', 'po', 'commercial',
                         'negotiation', 'awarding', 'boq', 'arc', 'arc-tech', 'arc-comm',
                         'arc-committee', 'mr')
  UNION
  SELECT rc.role_id, p.action::text
    FROM role_caps rc
   CROSS JOIN public.tbl_permissions p
   WHERE rc.cap = 'company.admin'
     AND p.resource::text = 'dashboard'
),
inserted AS (
  INSERT INTO public.tbl_role_permissions (role_id, permission_id)
  SELECT DISTINCT w.role_id, p.id
    FROM wanted w
    JOIN public.tbl_permissions p
      ON p.resource::text = 'dashboard'
     AND p.action::text = w.widget
   WHERE NOT EXISTS (
     SELECT 1 FROM public.tbl_role_permissions x
      WHERE x.role_id = w.role_id AND x.permission_id = p.id
   )
  RETURNING role_id, permission_id
)
INSERT INTO public.tbl_dashboard_seed_grants (role_id, permission_id)
SELECT role_id, permission_id FROM inserted
ON CONFLICT DO NOTHING;

COMMIT;
