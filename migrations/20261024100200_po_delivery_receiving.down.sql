-- Reverses 20261024100200_po_delivery_receiving.
--
-- Run AFTER the downs of 20261024100500 and 20261024100300, BEFORE the down of
-- 20261024100100.
--
-- Refuses while receiving documents exist (GRNs, dispatch notes, short-closes,
-- RTVs) or a vendor invoice carries the new invoice fields: dropping them would
-- lose receipt history and invoice numbers silently. Plan rows alone do not
-- block; they are regenerable.
--
-- Not reversed:
--   * Any one-invoice-per-PO unique constraint the up dropped. None exists in
--     the schema snapshot, and recreating one would fail once a PO holds two
--     invoices.
--   * rfq_id NOT NULL on tbl_payment_milestone / tbl_purchase_order_tasks is
--     restored only if no row has a NULL rfq_id (call-off milestones created
--     after the up); otherwise it stays nullable, with a NOTICE.
-- tbl_token_login_data.token gets NOT NULL back. Rows that only ever held a
-- hash get a dead placeholder ('revoked:' prefix), which can never match a
-- real token: those site-rep links stop working, as they must without the
-- hash column.

BEGIN;

DO $$
BEGIN
  -- Nested: plpgsql plans each inner query only when its branch runs, i.e.
  -- once the table/column is known to exist.
  IF to_regclass('public.tbl_grn') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.tbl_grn) THEN
      RAISE EXCEPTION 'Cannot roll back: tbl_grn has rows (goods receipts)';
    END IF;
  END IF;
  IF to_regclass('public.tbl_po_dispatch') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.tbl_po_dispatch) THEN
      RAISE EXCEPTION 'Cannot roll back: tbl_po_dispatch has rows (dispatch notes)';
    END IF;
  END IF;
  IF to_regclass('public.tbl_po_short_close') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.tbl_po_short_close) THEN
      RAISE EXCEPTION 'Cannot roll back: tbl_po_short_close has rows (short-close history)';
    END IF;
  END IF;
  IF to_regclass('public.tbl_rtv') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.tbl_rtv) THEN
      RAISE EXCEPTION 'Cannot roll back: tbl_rtv has rows (returns to vendor)';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'tbl_purchase_order_document'
                AND column_name = 'invoice_number') THEN
    IF EXISTS (SELECT 1 FROM public.tbl_purchase_order_document
                WHERE invoice_number IS NOT NULL OR invoice_date IS NOT NULL
                   OR invoice_amount IS NOT NULL OR dispatch_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Cannot roll back: tbl_purchase_order_document rows carry invoice number/date/amount or a dispatch link';
    END IF;
  END IF;
END $$;

-- D9, guarded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tbl_payment_milestone WHERE rfq_id IS NULL) THEN
    RAISE NOTICE 'tbl_payment_milestone has rows with NULL rfq_id; rfq_id stays nullable';
  ELSE
    ALTER TABLE public.tbl_payment_milestone ALTER COLUMN rfq_id SET NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tbl_purchase_order_tasks WHERE rfq_id IS NULL) THEN
    RAISE NOTICE 'tbl_purchase_order_tasks has rows with NULL rfq_id; rfq_id stays nullable';
  ELSE
    ALTER TABLE public.tbl_purchase_order_tasks ALTER COLUMN rfq_id SET NOT NULL;
  END IF;
END $$;

-- Token hardening.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'tbl_token_login_data'
                AND column_name = 'token_hash') THEN
    UPDATE public.tbl_token_login_data
       SET token = 'revoked:' || COALESCE(token_hash, md5(id::text || clock_timestamp()::text))
     WHERE token IS NULL;
  END IF;
END $$;
ALTER TABLE public.tbl_token_login_data ALTER COLUMN token SET NOT NULL;
DROP INDEX IF EXISTS public.ux_token_login_data_token_hash;
ALTER TABLE public.tbl_token_login_data
  DROP COLUMN IF EXISTS hotel_id,
  DROP COLUMN IF EXISTS last_used_at,
  DROP COLUMN IF EXISTS revoked_at,
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS token_hash;

-- Invoices.
ALTER TABLE public.tbl_purchase_order_document
  DROP COLUMN IF EXISTS dispatch_id,
  DROP COLUMN IF EXISTS invoice_amount,
  DROP COLUMN IF EXISTS invoice_date,
  DROP COLUMN IF EXISTS invoice_number;

-- PO roll-ups.
ALTER TABLE public.tbl_rfq_purchase_order
  DROP CONSTRAINT IF EXISTS tbl_rfq_purchase_order_receipt_status_check;
ALTER TABLE public.tbl_rfq_purchase_order
  DROP COLUMN IF EXISTS receipt_legacy,
  DROP COLUMN IF EXISTS delivery_plan_locked_at,
  DROP COLUMN IF EXISTS receipt_status;

ALTER TABLE public.tbl_purchase_order_product
  DROP CONSTRAINT IF EXISTS tbl_purchase_order_product_receipt_status_check;
ALTER TABLE public.tbl_purchase_order_product
  DROP COLUMN IF EXISTS receipt_status,
  DROP COLUMN IF EXISTS short_closed_qty,
  DROP COLUMN IF EXISTS returned_credit_qty,
  DROP COLUMN IF EXISTS returned_replace_qty,
  DROP COLUMN IF EXISTS rejected_qty,
  DROP COLUMN IF EXISTS accepted_qty,
  DROP COLUMN IF EXISTS received_qty;

-- Tables, children first (their audit triggers go with them).
DROP TABLE IF EXISTS public.tbl_rtv_line;
DROP TABLE IF EXISTS public.tbl_rtv;
DROP TABLE IF EXISTS public.tbl_po_short_close;
DROP TABLE IF EXISTS public.tbl_grn_attachment;
DROP TABLE IF EXISTS public.tbl_grn_line_alloc;
DROP TABLE IF EXISTS public.tbl_grn_line;
DROP TABLE IF EXISTS public.tbl_grn;
DROP TABLE IF EXISTS public.tbl_po_dispatch_line;
DROP TABLE IF EXISTS public.tbl_po_dispatch;
DROP TABLE IF EXISTS public.tbl_po_delivery_line;
DROP TABLE IF EXISTS public.tbl_po_delivery;

COMMIT;
