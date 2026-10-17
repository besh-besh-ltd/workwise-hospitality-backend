-- Negotiation — backfill vendor_approvals for pre-existing rounds.
--
-- The vendor_approvals JSONB column (added in
-- 20260624100000_multi_product_negotiation_rounds.sql) was introduced after
-- rounds already existed. Legacy rounds carry vendor_ids but an empty/NULL
-- vendor_approvals array, so the approval UI and the per-vendor approval logic
-- have nothing to render. This one-time backfill reconstructs a vendor_approvals
-- entry per vendor_id from the round's terminal status.
--
-- Must run AFTER 20260624100000_multi_product_negotiation_rounds.sql.
--
-- Idempotent: every statement only touches rows whose vendor_approvals is still
-- empty (jsonb_array_length = 0) or NULL, so re-runs are no-ops and already
-- populated rounds are never overwritten.
--
-- Apply with:
--   psql "$DATABASE_URL" -f migrations/20260624100100_backfill_negotiation_vendor_approvals.sql

BEGIN;

-- 1. APPROVED rounds (ACTIVE/ENDED/CLOSED with approved_at set) ---------------
UPDATE tbl_negotiation_rounds
SET vendor_approvals = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'vendor_id', vid,
      'status', 'APPROVED',
      'remarks', NULL,
      'acted_by', created_by,
      'acted_at', approved_at::text
    )
  )
  FROM unnest(vendor_ids) AS vid
),
updated_at = NOW()
WHERE vendor_ids IS NOT NULL
  AND jsonb_array_length(COALESCE(vendor_approvals, '[]'::jsonb)) = 0
  AND status IN ('ACTIVE', 'ENDED', 'CLOSED')
  AND approved_at IS NOT NULL;

-- 2. CANCELLED / EXPIRED rounds ----------------------------------------------
UPDATE tbl_negotiation_rounds
SET vendor_approvals = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'vendor_id', vid,
      'status', 'REJECTED',
      'remarks', remarks,
      'acted_by', created_by,
      'acted_at', COALESCE(closed_at, updated_at, created_at)::text
    )
  )
  FROM unnest(vendor_ids) AS vid
),
updated_at = NOW()
WHERE vendor_ids IS NOT NULL
  AND jsonb_array_length(COALESCE(vendor_approvals, '[]'::jsonb)) = 0
  AND status IN ('CANCELLED', 'EXPIRED');

-- 3. PENDING_APPROVAL rounds (still awaiting) --------------------------------
UPDATE tbl_negotiation_rounds
SET vendor_approvals = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'vendor_id', vid,
      'status', 'PENDING',
      'remarks', NULL,
      'acted_by', NULL,
      'acted_at', NULL
    )
  )
  FROM unnest(vendor_ids) AS vid
),
updated_at = NOW()
WHERE vendor_ids IS NOT NULL
  AND jsonb_array_length(COALESCE(vendor_approvals, '[]'::jsonb)) = 0
  AND status = 'PENDING_APPROVAL';

-- 4. Rounds with NULL vendor_ids (very old data) -----------------------------
UPDATE tbl_negotiation_rounds
SET vendor_approvals = '[]'::jsonb,
    updated_at = NOW()
WHERE vendor_ids IS NULL
  AND (vendor_approvals IS NULL OR vendor_approvals = '[]'::jsonb);

COMMIT;
