-- Reverses 20261024100500_po_receipt_backfill: column values only.
--
-- Puts back exactly what the up changed: a legacy PO the up marked 'received'
-- (legacy, received, in a received status, no plan, no GRN) returns to
-- 'not_received', then every legacy flag is cleared. A legacy backlog PO that
-- was later received through the new flow keeps its real receipt_status.
--
-- Guarded so it is a no-op when 20261024100200's columns/tables are already
-- gone (e.g. this down re-run after the full rollback).

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'tbl_rfq_purchase_order'
                AND column_name = 'receipt_legacy')
     AND to_regclass('public.tbl_po_delivery') IS NOT NULL
     AND to_regclass('public.tbl_grn') IS NOT NULL THEN

    -- plpgsql plans these only when this branch runs.
    UPDATE public.tbl_rfq_purchase_order po
       SET receipt_status = 'not_received'
     WHERE po.receipt_legacy = true
       AND po.receipt_status = 'received'
       AND po.status IN ('GRN', 'invoice_raised', 'completed')
       AND NOT EXISTS (SELECT 1 FROM public.tbl_po_delivery d WHERE d.po_id = po.id)
       AND NOT EXISTS (SELECT 1 FROM public.tbl_grn g WHERE g.po_id = po.id);

    UPDATE public.tbl_rfq_purchase_order
       SET receipt_legacy = false
     WHERE receipt_legacy = true;
  END IF;
END $$;

COMMIT;
