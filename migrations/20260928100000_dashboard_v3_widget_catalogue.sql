-- Buyer dashboard V3 — the v1 widget catalogue (docs/dashboard_v3/SPEC.md).
--
-- 1. Registers every v1 `dashboard.*` widget permission. Production already
--    holds 22 of the 24 codes (migration 20260526120000 + the ABC analysis
--    one); this adds the two new ones — `my_rfq_approvals_pending` (the RFQ
--    approval queue, the largest real queue on prod with no widget) and
--    `approval_turnaround` (one card replacing three "throughput" cards) — and
--    registers the full set on environments that never had them (test DBs).
--    Every statement is guarded, so re-running is a no-op.
--
-- 2. Retires the five widgets cut from v1: `tech_approval_oldest_pending`
--    (merged into my_tech_approvals_pending), `deals_with_price_anomalies`
--    (no agreed baseline — prod has no completed POs to compare against), and
--    the three `*_throughput` cards (replaced by approval_turnaround). Their
--    permission rows go so the admin role editor stops offering widgets that
--    no longer render. Postgres cannot drop enum values, so those stay. Any
--    grant being removed is copied into tbl_dashboard_v3_cut_grants first so
--    the down migration restores it exactly (prod has none; staging's custom
--    "All Dashboards" role has all five).
--
-- 3. Renumbers `ordering` so the role editor lists widgets persona by persona.
--
-- Comparisons against the enums go through ::text: a bare enum literal is
-- validated at parse time, and the cut values do not exist on a fresh DB.

BEGIN;

ALTER TYPE public.resource_type ADD VALUE IF NOT EXISTS 'dashboard';

ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'action_center';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'procurement_snapshot';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'negotiation_savings';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'cost_intelligence';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'category_insights';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'abc_analysis';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'workflow_efficiency';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'smart_insights';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'my_drafts';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'my_active_rfqs';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'my_no_response_rfqs';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'my_rfqs_bid_closed_no_quotes';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'my_tech_evals_pending';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'tech_evals_with_vendor_disagreements';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'my_tech_approvals_pending';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'my_quote_compares';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'my_active_negotiations';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'savings_pipeline';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'my_commercial_approvals_pending';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'my_award_approvals_pending';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'recent_awards';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'award_value_pipeline';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'my_rfq_approvals_pending';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'approval_turnaround';

COMMIT;

BEGIN;

-- ── 2. Retire the cut widgets (backing up their grants first) ────────────────
CREATE TABLE IF NOT EXISTS public.tbl_dashboard_v3_cut_grants (
  role_id    integer     NOT NULL,
  action     text        NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, action)
);

COMMENT ON TABLE public.tbl_dashboard_v3_cut_grants IS
  'Grants of the five dashboard widgets retired by migration 20260928100000, kept so its down migration can restore them. Safe to drop once V3 is settled.';

INSERT INTO public.tbl_dashboard_v3_cut_grants (role_id, action)
SELECT rp.role_id, p.action::text
  FROM public.tbl_role_permissions rp
  JOIN public.tbl_permissions p ON p.id = rp.permission_id
 WHERE p.resource::text = 'dashboard'
   AND p.action::text IN ('tech_approval_oldest_pending', 'deals_with_price_anomalies',
                          'tech_eval_throughput', 'tech_approval_throughput',
                          'commercial_approval_throughput')
ON CONFLICT DO NOTHING;

DELETE FROM public.tbl_role_permissions rp
 USING public.tbl_permissions p
 WHERE rp.permission_id = p.id
   AND p.resource::text = 'dashboard'
   AND p.action::text IN ('tech_approval_oldest_pending', 'deals_with_price_anomalies',
                          'tech_eval_throughput', 'tech_approval_throughput',
                          'commercial_approval_throughput');

DELETE FROM public.tbl_permissions p
 WHERE p.resource::text = 'dashboard'
   AND p.action::text IN ('tech_approval_oldest_pending', 'deals_with_price_anomalies',
                          'tech_eval_throughput', 'tech_approval_throughput',
                          'commercial_approval_throughput');

-- ── 1 + 3. Register the v1 catalogue and order it persona by persona ─────────
CREATE TEMP TABLE dashboard_v1_catalogue (action text PRIMARY KEY, ordering smallint NOT NULL) ON COMMIT DROP;

INSERT INTO dashboard_v1_catalogue (action, ordering) VALUES
  -- Cross-role
  ('action_center',                         0),
  ('procurement_snapshot',                  1),
  ('negotiation_savings',                   2),
  ('cost_intelligence',                     3),
  ('category_insights',                     4),
  ('abc_analysis',                          5),
  ('workflow_efficiency',                   6),
  ('smart_insights',                        7),
  -- RFQ creator
  ('my_drafts',                            10),
  ('my_active_rfqs',                       11),
  ('my_no_response_rfqs',                  12),
  ('my_rfqs_bid_closed_no_quotes',         13),
  -- Technical evaluator
  ('my_tech_evals_pending',                20),
  ('tech_evals_with_vendor_disagreements', 21),
  -- Technical approver
  ('my_tech_approvals_pending',            30),
  -- Commercial evaluator / N1
  ('my_quote_compares',                    40),
  ('my_active_negotiations',               41),
  ('savings_pipeline',                     42),
  -- Commercial approver (negotiated quotes)
  ('my_commercial_approvals_pending',      50),
  -- Awarding (POs)
  ('my_award_approvals_pending',           60),
  ('recent_awards',                        61),
  ('award_value_pipeline',                 62),
  -- RFQ approver
  ('my_rfq_approvals_pending',             70),
  -- Any approver
  ('approval_turnaround',                  80);

INSERT INTO public.tbl_permissions (resource, action, ordering)
SELECT 'dashboard'::public.resource_type,
       c.action::public.permission_action_type,
       c.ordering
  FROM dashboard_v1_catalogue c
 WHERE NOT EXISTS (
   SELECT 1 FROM public.tbl_permissions p
    WHERE p.resource::text = 'dashboard'
      AND p.action::text = c.action
 );

UPDATE public.tbl_permissions p
   SET ordering = c.ordering
  FROM dashboard_v1_catalogue c
 WHERE p.resource::text = 'dashboard'
   AND p.action::text = c.action
   AND p.ordering IS DISTINCT FROM c.ordering;

COMMIT;
