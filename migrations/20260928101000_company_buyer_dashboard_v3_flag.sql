-- Buyer dashboard V3 rollout switch, per buyer company (SPEC decision D5).
--
-- The role-aware dashboard used to sit behind NEXT_PUBLIC_BUYER_DASHBOARD_V3,
-- a build-time flag no deploy pipeline passed — it could not be turned on for
-- anyone. The switch now lives here and is read at request time by
-- GET /dashboard-v2/config and the per-widget permission guard:
--
--   false (default) → the legacy layout; widget endpoints stay ungated.
--   true            → the role-aware layout; each widget endpoint requires its
--                     dashboard.<code> grant in the caller's role scopes.
--
-- Enable / kill switch (no deploy needed):
--   UPDATE tbl_company SET buyer_dashboard_v3 = true  WHERE id = <buyer company>;
--   UPDATE tbl_company SET buyer_dashboard_v3 = false WHERE id = <buyer company>;

BEGIN;

ALTER TABLE public.tbl_company
  ADD COLUMN IF NOT EXISTS buyer_dashboard_v3 boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tbl_company.buyer_dashboard_v3 IS
  'Buyer dashboard V3 (role-aware, permission-gated) enabled for this buyer company. false = legacy layout.';

COMMIT;
