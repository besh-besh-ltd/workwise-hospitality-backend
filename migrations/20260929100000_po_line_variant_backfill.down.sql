-- Reverse 20260929100000: clear exactly the variants the backfill set.
-- A line whose variant has since changed (someone corrected it) is left alone,
-- as is every line the fixed insert path wrote — neither is in the ledger.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.tbl_po_line_variant_backfill') IS NOT NULL THEN
    UPDATE public.tbl_purchase_order_product pop
       SET product_variant_id = NULL
      FROM public.tbl_po_line_variant_backfill b
     WHERE pop.id = b.purchase_order_product_id
       AND pop.product_variant_id = b.product_variant_id;
    DROP TABLE public.tbl_po_line_variant_backfill;
  END IF;
END $$;

COMMIT;
