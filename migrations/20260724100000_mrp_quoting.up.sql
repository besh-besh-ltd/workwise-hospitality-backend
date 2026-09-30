-- Up: 20260724100000_mrp_quoting.sql
-- MRP (tax-inclusive) quoting method for RFQ send-quote + ARC vendor-quote.
-- Additive only: MRP mode reverse-calculates a tax-EXCLUSIVE base and stores it
-- into the EXISTING exclusive columns (unit_price/rate + tax/gst_pct); the only
-- new persistence here is per-line/header pricing_method + raw MRP/discount
-- audit inputs. All new columns are NULLABLE except the method columns, which
-- default 'TRADITIONAL' so every existing row stays behaviorally unchanged.
-- Apply with: psql $DATABASE_URL -f migrations/20260724100000_mrp_quoting.sql
BEGIN;

-- RFQ: tbl_quotes (header convenience column for reload + reporting)
ALTER TABLE public.tbl_quotes
  ADD COLUMN IF NOT EXISTS pricing_method VARCHAR(12) NOT NULL DEFAULT 'TRADITIONAL';
ALTER TABLE public.tbl_quotes
  DROP CONSTRAINT IF EXISTS chk_tbl_quotes_pricing_method;
ALTER TABLE public.tbl_quotes
  ADD CONSTRAINT chk_tbl_quotes_pricing_method
  CHECK (pricing_method IN ('TRADITIONAL','MRP'));

-- RFQ: tbl_quote_items (per-line method + audit inputs)
ALTER TABLE public.tbl_quote_items
  ADD COLUMN IF NOT EXISTS pricing_method VARCHAR(12) NOT NULL DEFAULT 'TRADITIONAL';
ALTER TABLE public.tbl_quote_items
  DROP CONSTRAINT IF EXISTS chk_tbl_quote_items_pricing_method;
ALTER TABLE public.tbl_quote_items
  ADD CONSTRAINT chk_tbl_quote_items_pricing_method
  CHECK (pricing_method IN ('TRADITIONAL','MRP'));
ALTER TABLE public.tbl_quote_items
  ADD COLUMN IF NOT EXISTS entered_mrp NUMERIC(15,2);
ALTER TABLE public.tbl_quote_items
  ADD COLUMN IF NOT EXISTS mrp_discount NUMERIC(15,2);
ALTER TABLE public.tbl_quote_items
  ADD COLUMN IF NOT EXISTS mrp_discount_mode public.item_mode;

-- RFQ: tbl_quote_item_history (snapshot must preserve method + inputs)
ALTER TABLE public.tbl_quote_item_history
  ADD COLUMN IF NOT EXISTS pricing_method VARCHAR(12) DEFAULT 'TRADITIONAL';
ALTER TABLE public.tbl_quote_item_history
  ADD COLUMN IF NOT EXISTS entered_mrp NUMERIC(15,2);
ALTER TABLE public.tbl_quote_item_history
  ADD COLUMN IF NOT EXISTS mrp_discount NUMERIC(15,2);
ALTER TABLE public.tbl_quote_item_history
  ADD COLUMN IF NOT EXISTS mrp_discount_mode public.item_mode;

-- ARC: tbl_arc_quote (header convenience column)
ALTER TABLE public.tbl_arc_quote
  ADD COLUMN IF NOT EXISTS pricing_method VARCHAR(12) NOT NULL DEFAULT 'TRADITIONAL';
ALTER TABLE public.tbl_arc_quote
  DROP CONSTRAINT IF EXISTS chk_tbl_arc_quote_pricing_method;
ALTER TABLE public.tbl_arc_quote
  ADD CONSTRAINT chk_tbl_arc_quote_pricing_method
  CHECK (pricing_method IN ('TRADITIONAL','MRP'));

-- ARC: tbl_arc_quote_line (per-line method + audit inputs)
ALTER TABLE public.tbl_arc_quote_line
  ADD COLUMN IF NOT EXISTS pricing_method VARCHAR(12) NOT NULL DEFAULT 'TRADITIONAL';
ALTER TABLE public.tbl_arc_quote_line
  DROP CONSTRAINT IF EXISTS chk_tbl_arc_quote_line_pricing_method;
ALTER TABLE public.tbl_arc_quote_line
  ADD CONSTRAINT chk_tbl_arc_quote_line_pricing_method
  CHECK (pricing_method IN ('TRADITIONAL','MRP'));
ALTER TABLE public.tbl_arc_quote_line
  ADD COLUMN IF NOT EXISTS entered_mrp NUMERIC(15,2);
ALTER TABLE public.tbl_arc_quote_line
  ADD COLUMN IF NOT EXISTS mrp_discount NUMERIC(15,2);
ALTER TABLE public.tbl_arc_quote_line
  ADD COLUMN IF NOT EXISTS mrp_discount_mode VARCHAR(12);

COMMIT;
