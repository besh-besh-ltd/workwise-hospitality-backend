-- Rollback: remove Phase 1/2 columns added to tbl_arc_quote and tbl_arc_quote_line.
ALTER TABLE public.tbl_arc_quote
  DROP COLUMN IF EXISTS terms_accepted_at,
  DROP COLUMN IF EXISTS quote_pricing;

ALTER TABLE public.tbl_arc_quote_line
  DROP COLUMN IF EXISTS line_pricing;
