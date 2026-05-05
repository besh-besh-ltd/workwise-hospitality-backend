-- ============================================================================
-- Migration 003 — bypass-ARC reason per product
-- ----------------------------------------------------------------------------
-- The Phase 8 first cut stored the override reason on tbl_rfq, which:
--   * doesn't say WHICH product was bypassed (an RFQ can have many lines,
--     only some of which are contracted),
--   * forced sessionStorage on the FE as a transit mechanism between the
--     contracted-item modal and the RFQ save.
--
-- Per-product storage fixes both. The reason is captured server-side at
-- the moment the product is added to the draft (POST /rfq/add-product-to-draft)
-- and stays attached to that exact line forever.
--
-- The tbl_rfq.bypass_arc smallint flag is kept as a derived rollup
-- (set 1 if any product on the RFQ has a bypass reason). The
-- tbl_rfq.bypass_arc_reason / recorded_by / recorded_at columns are
-- DEPRECATED but left in place — back-compat with any in-flight drafts
-- that were saved with the parent-level shape. New writes go to the
-- product row; reads SHOULD prefer the product-level value.
-- ============================================================================

BEGIN;

ALTER TABLE public.tbl_rfq_products
  ADD COLUMN IF NOT EXISTS bypass_arc_reason TEXT,
  ADD COLUMN IF NOT EXISTS bypass_arc_recorded_by INTEGER,
  ADD COLUMN IF NOT EXISTS bypass_arc_recorded_at TIMESTAMP WITHOUT TIME ZONE;

-- Optional CHECK enforcing the same ≥30-char minimum the FE/Joi check.
-- Worth having at the DB layer too: a bypass with a 5-char "ok" reason
-- defeats the audit purpose, and we don't want any future direct INSERT
-- to slip past the API guard.
ALTER TABLE public.tbl_rfq_products
  DROP CONSTRAINT IF EXISTS chk_rfq_products_bypass_arc_reason_len;
ALTER TABLE public.tbl_rfq_products
  ADD CONSTRAINT chk_rfq_products_bypass_arc_reason_len
  CHECK (
    bypass_arc_reason IS NULL OR char_length(bypass_arc_reason) >= 30
  );

-- Lookup index: filter by "rows with a bypass" cheaply for the listing /
-- audit views. Tiny disk cost; partial so it only grows with real data.
CREATE INDEX IF NOT EXISTS idx_rfq_products_bypass_arc
  ON public.tbl_rfq_products (rfq_id)
  WHERE bypass_arc_reason IS NOT NULL;

COMMIT;
