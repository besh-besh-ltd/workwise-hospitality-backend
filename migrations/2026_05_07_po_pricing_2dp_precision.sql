-- 2026-05-07: Preserve decimal precision in PO calculation & PDF.
--
-- Two columns on tbl_purchase_order_product were `bigint`, which truncated
-- every fractional rupee (100.50 → 100). Quote line columns were `real`,
-- which carries IEEE-754 single-precision drift (~7 digits). Both round
-- buyer/vendor inputs *before* the pricing engine ever sees them.
--
-- This migration converts those columns to numeric(15,2) so engine inputs
-- and persisted line/grand totals carry true paise/cents precision. The
-- engine itself now rounds to 2dp (round2) instead of integer (Math.round)
-- — see app/services/pricingEngine.js.
--
-- Safe to run online: numeric(15,2) is wider than bigint/real for any value
-- we currently store, so the cast is lossless going forward (existing
-- truncated rows stay truncated; the fix applies to new writes).

BEGIN;

ALTER TABLE public.tbl_purchase_order_product
  ALTER COLUMN unit_price  TYPE numeric(15,2) USING unit_price::numeric(15,2),
  ALTER COLUMN total_price TYPE numeric(15,2) USING total_price::numeric(15,2);

ALTER TABLE public.tbl_quote_items
  ALTER COLUMN unit_price    TYPE numeric(15,2) USING unit_price::numeric(15,2),
  ALTER COLUMN tax           TYPE numeric(15,2) USING tax::numeric(15,2),
  ALTER COLUMN freight_price TYPE numeric(15,2) USING freight_price::numeric(15,2),
  ALTER COLUMN package_price TYPE numeric(15,2) USING package_price::numeric(15,2),
  ALTER COLUMN total_price   TYPE numeric(15,2) USING total_price::numeric(15,2);

ALTER TABLE public.tbl_quote_items
  ALTER COLUMN unit_price    SET DEFAULT 0,
  ALTER COLUMN tax           SET DEFAULT 0,
  ALTER COLUMN freight_price SET DEFAULT 0,
  ALTER COLUMN package_price SET DEFAULT 0,
  ALTER COLUMN total_price   SET DEFAULT 0;

COMMIT;
