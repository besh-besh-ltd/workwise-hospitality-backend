-- Rollback: 20260630100100_arc_quote_line_negotiated

DROP INDEX IF EXISTS public.idx_arc_quote_line_rate_source;

ALTER TABLE public.tbl_arc_quote_line
  DROP CONSTRAINT IF EXISTS tbl_arc_quote_line_negotiated_round_id_fkey,
  DROP CONSTRAINT IF EXISTS tbl_arc_quote_line_rate_source_chk,
  DROP COLUMN IF EXISTS negotiated_round_id,
  DROP COLUMN IF EXISTS rate_source;
