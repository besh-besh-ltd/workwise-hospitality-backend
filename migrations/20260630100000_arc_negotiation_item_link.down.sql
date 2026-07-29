-- Rollback: 20260630100000_arc_negotiation_item_link
--
-- WARNING: Removing arc_item_id also removes any ARC negotiation data stored in
-- these columns. Only roll back in development environments.

DROP INDEX IF EXISTS public.uq_neg_round_quote_arc_item;
DROP INDEX IF EXISTS public.idx_neg_rounds_arc_item;
DROP INDEX IF EXISTS public.idx_neg_round_quotes_arc_item;

ALTER TABLE public.tbl_negotiation_round_quotes
  DROP CONSTRAINT IF EXISTS tbl_negotiation_round_quotes_arc_item_id_fkey,
  DROP COLUMN IF EXISTS arc_item_id;

ALTER TABLE public.tbl_negotiation_rounds
  DROP CONSTRAINT IF EXISTS tbl_negotiation_rounds_arc_item_id_fkey,
  DROP COLUMN IF EXISTS arc_item_id,
  DROP COLUMN IF EXISTS products;
