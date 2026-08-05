-- Revert call-off PO line columns (audit CO7 rollback).
-- WARNING: re-imposing NOT NULL will fail if any call-off line rows exist with
-- NULL rfq_product_id/quote_id; purge those first.

BEGIN;

ALTER TABLE public.tbl_purchase_order_product
  DROP COLUMN IF EXISTS arc_contract_line_id,
  DROP COLUMN IF EXISTS product_variant_id,
  ALTER COLUMN quote_id       SET NOT NULL,
  ALTER COLUMN rfq_product_id SET NOT NULL;

COMMIT;
