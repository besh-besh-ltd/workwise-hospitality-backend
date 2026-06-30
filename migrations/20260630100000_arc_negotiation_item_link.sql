-- ARC Negotiation — Migration 1 of 3: arc_item_id + products on negotiation tables.
--
-- Adds the ARC-side columns that allow tbl_negotiation_rounds and
-- tbl_negotiation_round_quotes to carry ARC item-level scope alongside the
-- existing RFQ polymorphic columns. Also ensures tbl_negotiation_rounds has the
-- `products` JSONB column that was added to prod directly (predates the
-- migrations/ folder) so prod+test stay in lockstep.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; FK guards wrapped in DO/IF.

ALTER TABLE public.tbl_negotiation_rounds
  ADD COLUMN IF NOT EXISTS arc_item_id BIGINT,
  ADD COLUMN IF NOT EXISTS products    JSONB;   -- no-op on prod (already present)

ALTER TABLE public.tbl_negotiation_round_quotes
  ADD COLUMN IF NOT EXISTS arc_item_id BIGINT;

-- FK: arc_item_id → tbl_arc_item, ON DELETE CASCADE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'tbl_negotiation_rounds_arc_item_id_fkey'
       AND table_name       = 'tbl_negotiation_rounds'
  ) THEN
    ALTER TABLE public.tbl_negotiation_rounds
      ADD CONSTRAINT tbl_negotiation_rounds_arc_item_id_fkey
      FOREIGN KEY (arc_item_id)
      REFERENCES public.tbl_arc_item(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'tbl_negotiation_round_quotes_arc_item_id_fkey'
       AND table_name       = 'tbl_negotiation_round_quotes'
  ) THEN
    ALTER TABLE public.tbl_negotiation_round_quotes
      ADD CONSTRAINT tbl_negotiation_round_quotes_arc_item_id_fkey
      FOREIGN KEY (arc_item_id)
      REFERENCES public.tbl_arc_item(id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_neg_rounds_arc_item
  ON public.tbl_negotiation_rounds (source_id, arc_item_id)
  WHERE source_type = 'ARC';

CREATE INDEX IF NOT EXISTS idx_neg_round_quotes_arc_item
  ON public.tbl_negotiation_round_quotes (arc_item_id);

-- Partial UNIQUE index: one quote per (round, vendor, ARC item).
-- arc_item_id IS NULL rows (RFQ rows, rfq_product_id-keyed) are excluded by the
-- WHERE clause, so this index has zero impact on the existing RFQ path.
-- Every ARC round-quote row has a non-null arc_item_id, so all ARC rows are
-- covered. This closes the concurrency window that the app-level pre-tx check
-- alone cannot protect (two concurrent submits both pass the pre-tx check; the
-- FOR UPDATE on the quote line serialises them, but the in-tx re-check + this
-- index together ensure the second is rejected, not committed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_neg_round_quote_arc_item
  ON public.tbl_negotiation_round_quotes (negotiation_round_id, vendor_id, arc_item_id)
  WHERE arc_item_id IS NOT NULL;
