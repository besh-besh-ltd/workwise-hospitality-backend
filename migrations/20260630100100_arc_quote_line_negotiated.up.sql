-- ARC Negotiation — Migration 2 of 3: rate_source + negotiated_round_id on tbl_arc_quote_line.
--
-- Adds the DECISION-1 tag columns that distinguish a NEGOTIATED current rate
-- from the original LANDED rate. The vendor auto-apply write path sets
-- rate_source='NEGOTIATED' and negotiated_round_id=<round_id> when a vendor
-- submits a revised rate during an active round.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; CHECK/FK guards in DO/IF blocks.

ALTER TABLE public.tbl_arc_quote_line
  ADD COLUMN IF NOT EXISTS rate_source        VARCHAR(16) NOT NULL DEFAULT 'LANDED',
  ADD COLUMN IF NOT EXISTS negotiated_round_id BIGINT;

DO $$
BEGIN
  -- CHECK: rate_source IN ('LANDED','NEGOTIATED')
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tbl_arc_quote_line_rate_source_chk'
  ) THEN
    ALTER TABLE public.tbl_arc_quote_line
      ADD CONSTRAINT tbl_arc_quote_line_rate_source_chk
      CHECK (rate_source IN ('LANDED', 'NEGOTIATED'));
  END IF;

  -- FK: negotiated_round_id → tbl_negotiation_rounds, ON DELETE SET NULL
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'tbl_arc_quote_line_negotiated_round_id_fkey'
       AND table_name       = 'tbl_arc_quote_line'
  ) THEN
    ALTER TABLE public.tbl_arc_quote_line
      ADD CONSTRAINT tbl_arc_quote_line_negotiated_round_id_fkey
      FOREIGN KEY (negotiated_round_id)
      REFERENCES public.tbl_negotiation_rounds(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_arc_quote_line_rate_source
  ON public.tbl_arc_quote_line (rate_source)
  WHERE rate_source = 'NEGOTIATED';
