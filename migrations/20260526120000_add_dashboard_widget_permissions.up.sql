-- Role-aware buyer dashboard: add `dashboard.*` permission catalogue.
--
-- This migration is the backend foundation for the role-aware buyer dashboard
-- (frontend lives in /dashboard/buyer behind the NEXT_PUBLIC_BUYER_DASHBOARD_V3
-- feature flag). It adds 'dashboard' to the resource_type enum, adds the 25
-- widget action names to the permission_action_type enum, and seeds one
-- tbl_permissions row per widget so admins can grant them via the existing
-- RoleScopeSelector UI.
--
-- This migration deliberately does NOT seed `tbl_role_permissions`. Per the
-- product decision (`plan: Day-1 migration — grant nothing, admin must assign
-- explicitly`), existing buyer users see the empty-dashboard state until an
-- admin grants `dashboard.*` permissions to their role. Recommended preset
-- bundles per persona are documented in the admin UI tooltip.

-- ──────────────────────────────────────────────────────────────────
-- 1.  Extend resource_type enum
-- ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'resource_type'::regtype
      AND enumlabel = 'dashboard'
  ) THEN
    ALTER TYPE resource_type ADD VALUE 'dashboard';
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────
-- 2.  Extend permission_action_type enum with the 25 widget actions
-- ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  widget_action text;
  widget_actions text[] := ARRAY[
    -- Cross-role widgets (7)
    'action_center',
    'procurement_snapshot',
    'negotiation_savings',
    'cost_intelligence',
    'category_insights',
    'workflow_efficiency',
    'smart_insights',
    -- RFQ Creator (4)
    'my_drafts',
    'my_active_rfqs',
    'my_no_response_rfqs',
    'my_rfqs_bid_closed_no_quotes',
    -- Technical Evaluator (3)
    'my_tech_evals_pending',
    'tech_evals_with_vendor_disagreements',
    'tech_eval_throughput',
    -- Technical Approver (3)
    'my_tech_approvals_pending',
    'tech_approval_oldest_pending',
    'tech_approval_throughput',
    -- Commercial Evaluator / N1 Negotiator (3)
    'my_quote_compares',
    'my_active_negotiations',
    'savings_pipeline',
    -- Commercial Approver (3)
    'my_commercial_approvals_pending',
    'deals_with_price_anomalies',
    'commercial_approval_throughput',
    -- Awarding P1 / P2 (3)
    'my_award_approvals_pending',
    'recent_awards',
    'award_value_pipeline'
  ];
BEGIN
  FOREACH widget_action IN ARRAY widget_actions LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum
      WHERE enumtypid = 'permission_action_type'::regtype
        AND enumlabel = widget_action
    ) THEN
      EXECUTE format('ALTER TYPE permission_action_type ADD VALUE %L', widget_action);
    END IF;
  END LOOP;
END $$;

-- ──────────────────────────────────────────────────────────────────
-- 3.  Commit the enum changes BEFORE inserting rows that use them.
--
-- Postgres requires new enum values to be committed before they're usable
-- in DML in the same session. Knex / db migration runners typically commit
-- between numbered migrations, so this works as-is when running through
-- the migration tool. If running this file manually via psql, run it as
-- TWO sessions: one for the enum DDL above, then one for the inserts
-- below.
-- ──────────────────────────────────────────────────────────────────

-- ──────────────────────────────────────────────────────────────────
-- 4.  Seed tbl_permissions — one row per widget.
--
-- The `ordering` column controls display order in admin UIs that list
-- permissions; we group by persona so the picker shows related widgets
-- together. Idempotent via ON CONFLICT — re-running the migration is safe.
-- ──────────────────────────────────────────────────────────────────
INSERT INTO tbl_permissions (resource, action, ordering) VALUES
  -- Cross-role (0..10)
  ('dashboard', 'action_center',                        0),
  ('dashboard', 'procurement_snapshot',                 1),
  ('dashboard', 'negotiation_savings',                  2),
  ('dashboard', 'cost_intelligence',                    3),
  ('dashboard', 'category_insights',                    4),
  ('dashboard', 'workflow_efficiency',                  5),
  ('dashboard', 'smart_insights',                       6),
  -- RFQ Creator (10..19)
  ('dashboard', 'my_drafts',                           10),
  ('dashboard', 'my_active_rfqs',                      11),
  ('dashboard', 'my_no_response_rfqs',                 12),
  ('dashboard', 'my_rfqs_bid_closed_no_quotes',        13),
  -- Technical Evaluator (20..29)
  ('dashboard', 'my_tech_evals_pending',               20),
  ('dashboard', 'tech_evals_with_vendor_disagreements',21),
  ('dashboard', 'tech_eval_throughput',                22),
  -- Technical Approver (30..39)
  ('dashboard', 'my_tech_approvals_pending',           30),
  ('dashboard', 'tech_approval_oldest_pending',        31),
  ('dashboard', 'tech_approval_throughput',            32),
  -- Commercial Evaluator / N1 (40..49)
  ('dashboard', 'my_quote_compares',                   40),
  ('dashboard', 'my_active_negotiations',              41),
  ('dashboard', 'savings_pipeline',                    42),
  -- Commercial Approver (50..59)
  ('dashboard', 'my_commercial_approvals_pending',     50),
  ('dashboard', 'deals_with_price_anomalies',          51),
  ('dashboard', 'commercial_approval_throughput',      52),
  -- Awarding P1 / P2 (60..69)
  ('dashboard', 'my_award_approvals_pending',          60),
  ('dashboard', 'recent_awards',                       61),
  ('dashboard', 'award_value_pipeline',                62)
ON CONFLICT DO NOTHING;
