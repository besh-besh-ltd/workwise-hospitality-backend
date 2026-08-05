-- Rollback for 20260608100600_po_arc_backlinks.sql

DROP INDEX IF EXISTS public.idx_tbl_rfq_purchase_order_call_off;
DROP INDEX IF EXISTS public.idx_tbl_rfq_purchase_order_source_mr;
DROP INDEX IF EXISTS public.idx_tbl_rfq_purchase_order_arc_contract;

ALTER TABLE public.tbl_rfq_purchase_order
  DROP CONSTRAINT IF EXISTS tbl_rfq_purchase_order_call_off_or_rfq_chk,
  DROP CONSTRAINT IF EXISTS tbl_rfq_purchase_order_source_mr_fkey,
  DROP CONSTRAINT IF EXISTS tbl_rfq_purchase_order_arc_contract_fkey;

-- Restore rfq_id NOT NULL only if every row has a non-null rfq_id.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tbl_rfq_purchase_order WHERE rfq_id IS NULL) THEN
    ALTER TABLE public.tbl_rfq_purchase_order ALTER COLUMN rfq_id SET NOT NULL;
  END IF;
END $$;

ALTER TABLE public.tbl_rfq_purchase_order
  DROP COLUMN IF EXISTS is_call_off,
  DROP COLUMN IF EXISTS source_mr_id,
  DROP COLUMN IF EXISTS arc_contract_id;
