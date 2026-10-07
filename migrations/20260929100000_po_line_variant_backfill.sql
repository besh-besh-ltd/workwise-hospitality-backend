-- Backfill tbl_purchase_order_product.product_variant_id for RFQ PO lines.
--
-- The RFQ award path (draftPurchaseOrder) never wrote the column — only the ARC
-- call-off path did — so every RFQ PO line on production had it NULL (2,387 of
-- 2,387 on 2026-09-29). The code now writes it at insert time; this fills the
-- history from the line's own rfq_product.
--
-- A line is set only when the resolution is unambiguous: its rfq_product exists,
-- belongs to the SAME RFQ as the line's PO, and names a variant that exists.
-- Production dry run (read-only, 2026-09-29): 2,387 lines would be set, across
-- 575 POs and 1,171 variants; 0 skipped.
--
-- Every row this sets is recorded in tbl_po_line_variant_backfill, so the down
-- migration clears exactly those rows — never a line written by the fixed code
-- path, never one a person corrected afterwards.
--
-- Idempotent: a re-run only touches lines that are still NULL.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tbl_po_line_variant_backfill (
  purchase_order_product_id integer     PRIMARY KEY,
  product_variant_id        integer     NOT NULL,
  backfilled_at             timestamptz NOT NULL DEFAULT now()
);

WITH candidates AS (
  SELECT pop.id, rp.product_variant_id
    FROM public.tbl_purchase_order_product pop
    JOIN public.tbl_rfq_purchase_order po ON po.id = pop.purchase_order_id
    JOIN public.tbl_rfq_products rp       ON rp.id = pop.rfq_product_id
    JOIN public.tbl_product_variant pv    ON pv.id = rp.product_variant_id
   WHERE pop.product_variant_id IS NULL
     AND rp.rfq_id = po.rfq_id
),
recorded AS (
  INSERT INTO public.tbl_po_line_variant_backfill (purchase_order_product_id, product_variant_id)
  SELECT id, product_variant_id FROM candidates
  ON CONFLICT (purchase_order_product_id) DO NOTHING
  RETURNING purchase_order_product_id, product_variant_id
)
UPDATE public.tbl_purchase_order_product pop
   SET product_variant_id = r.product_variant_id
  FROM recorded r
 WHERE pop.id = r.purchase_order_product_id
   AND pop.product_variant_id IS NULL;

COMMIT;
