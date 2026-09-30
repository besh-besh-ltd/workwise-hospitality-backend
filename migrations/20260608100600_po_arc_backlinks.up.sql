-- ARC v2 — Migration 8 of 10: additive PO backlinks for ARC call-off POs.
--
-- Per plan §3.3 #2 and §4.9, we add three nullable columns to
-- tbl_rfq_purchase_order so a call-off PO can point back to the originating
-- ARC contract + MR, and the read APIs can branch on is_call_off.
--
-- All existing rows are RFQ POs (is_call_off defaults FALSE on backfill), so
-- RFQ flows are unchanged. The call-off path bypasses initiatePurchaseOrder
-- and writes is_call_off=TRUE (see plan §5.4 callOffPoService).

ALTER TABLE public.tbl_rfq_purchase_order
  ADD COLUMN IF NOT EXISTS arc_contract_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS source_mr_id    BIGINT NULL,
  ADD COLUMN IF NOT EXISTS is_call_off     BOOLEAN NOT NULL DEFAULT FALSE;

-- Relax rfq_id to nullable so call-off POs (is_call_off=TRUE) can omit it.
-- All existing rows are RFQ POs (rfq_id IS NOT NULL); a future enforcement
-- CHECK in the application layer (or a DB-level partial CHECK) keeps the
-- invariant: "(is_call_off=TRUE AND arc_contract_id IS NOT NULL) OR
-- (is_call_off=FALSE AND rfq_id IS NOT NULL)".
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'tbl_rfq_purchase_order'
      AND column_name  = 'rfq_id'
      AND is_nullable  = 'NO'
  ) THEN
    ALTER TABLE public.tbl_rfq_purchase_order ALTER COLUMN rfq_id DROP NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_rfq_purchase_order_call_off_or_rfq_chk'
  ) THEN
    ALTER TABLE public.tbl_rfq_purchase_order
      ADD CONSTRAINT tbl_rfq_purchase_order_call_off_or_rfq_chk
      CHECK (
        (is_call_off = TRUE  AND arc_contract_id IS NOT NULL AND source_mr_id IS NOT NULL)
        OR
        (is_call_off = FALSE AND rfq_id          IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_rfq_purchase_order_arc_contract_fkey'
  ) THEN
    ALTER TABLE public.tbl_rfq_purchase_order
      ADD CONSTRAINT tbl_rfq_purchase_order_arc_contract_fkey
      FOREIGN KEY (arc_contract_id) REFERENCES public.tbl_arc_contract(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_rfq_purchase_order_source_mr_fkey'
  ) THEN
    ALTER TABLE public.tbl_rfq_purchase_order
      ADD CONSTRAINT tbl_rfq_purchase_order_source_mr_fkey
      FOREIGN KEY (source_mr_id) REFERENCES public.tbl_material_requisition(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Backlink index for the call-off PO list / lookup-by-contract path.
CREATE INDEX IF NOT EXISTS idx_tbl_rfq_purchase_order_arc_contract
  ON public.tbl_rfq_purchase_order (arc_contract_id)
  WHERE arc_contract_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tbl_rfq_purchase_order_source_mr
  ON public.tbl_rfq_purchase_order (source_mr_id)
  WHERE source_mr_id IS NOT NULL;

-- Partial index for fast "all call-off POs" listings.
CREATE INDEX IF NOT EXISTS idx_tbl_rfq_purchase_order_call_off
  ON public.tbl_rfq_purchase_order (is_call_off)
  WHERE is_call_off = TRUE;
