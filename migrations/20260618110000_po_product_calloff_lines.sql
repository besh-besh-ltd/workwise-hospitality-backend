-- Call-off PO line items (audit CO7).
-- tbl_purchase_order_product was RFQ-shaped (rfq_product_id + quote_id NOT NULL),
-- so call-off POs could not carry line rows. Relax those for call-off lines and
-- add the ARC-shaped columns so call-offs are first-class POs readable by the
-- same detail/GRN/invoice paths as RFQ POs.
-- Apply with: psql $DATABASE_URL -f migrations/20260618110000_po_product_calloff_lines.sql

BEGIN;

ALTER TABLE public.tbl_purchase_order_product
  ALTER COLUMN rfq_product_id DROP NOT NULL,
  ALTER COLUMN quote_id       DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS product_variant_id   integer,
  ADD COLUMN IF NOT EXISTS arc_contract_line_id bigint;

COMMIT;
