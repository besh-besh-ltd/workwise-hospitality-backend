-- Migration 005 — Backfill tbl_approval_policies.company_id where NULL.
--
-- The CHECK constraint chk_arc_policy_global_scope (migration 002)
-- requires every BU-scoped policy (is_global = 0) to carry the parent
-- tbl_company.id. The previous policy-update path occasionally sent
-- {company_id: undefined} which serialised to NULL, attempting to
-- overwrite the saved value. The check rejects the UPDATE outright on
-- environments where the constraint exists, so production data is safe;
-- but on environments that pre-date migration 002 (or where constraints
-- were dropped during local imports) some rows may have landed with a
-- NULL company_id. This migration:
--
--   1. Backfills any BU-scoped row whose company_id IS NULL by
--      resolving the parent tbl_company.id from the row's
--      hospitality_company_id (via tbl_hospitality_companies.buyer_company_id).
--   2. Leaves global rows alone — they should already have company_id
--      set at create time, and migration 002 enforces it.
--
-- Idempotent: safe to run multiple times. No-op when no rows need fixing.
--
-- Verification queries (run before + after):
--   SELECT COUNT(*) FROM tbl_approval_policies WHERE company_id IS NULL;
--   SELECT id, entity_type, hospitality_company_id, hotel_id, is_global, company_id
--     FROM tbl_approval_policies WHERE company_id IS NULL ORDER BY id;

UPDATE tbl_approval_policies p
   SET company_id = hc.buyer_company_id,
       updated_at = NOW()
  FROM tbl_hospitality_companies hc
 WHERE p.hospitality_company_id IS NOT NULL
   AND p.hospitality_company_id = hc.id
   AND p.company_id IS NULL
   AND p.is_global = 0;

-- Sanity: any remaining NULL company_id is a structural problem (a row
-- with neither hospitality_company_id nor an explicit company_id, which
-- would already violate chk_arc_policy_global_scope). Surface them so
-- an operator can investigate before re-applying the CHECK constraint.
DO $$
DECLARE
  null_remaining INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_remaining
    FROM tbl_approval_policies
   WHERE company_id IS NULL;
  IF null_remaining > 0 THEN
    RAISE NOTICE 'Migration 005: % policy rows still have NULL company_id after backfill — investigate manually.', null_remaining;
  ELSE
    RAISE NOTICE 'Migration 005: all rows have a non-null company_id.';
  END IF;
END $$;
