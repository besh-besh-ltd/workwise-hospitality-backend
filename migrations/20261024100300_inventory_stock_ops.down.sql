-- Reverses 20261024100300_inventory_stock_ops.
--
-- Run AFTER the down of 20261024100400 and BEFORE the downs of 20261024100200
-- and 20261024100100.
--
-- Refuses while any stock document exists: mark-outs, adjustments and counts
-- are the explanation for the ledger's rows, and dropping them would leave
-- tbl_inv_movement pointing at documents that no longer exist.

BEGIN;

DO $$
BEGIN
  -- Nested: plpgsql plans each inner query only when its branch runs.
  IF to_regclass('public.tbl_inv_out') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.tbl_inv_out) THEN
      RAISE EXCEPTION 'Cannot roll back: tbl_inv_out has rows (mark-outs / returns)';
    END IF;
  END IF;
  IF to_regclass('public.tbl_inv_adjustment') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.tbl_inv_adjustment) THEN
      RAISE EXCEPTION 'Cannot roll back: tbl_inv_adjustment has rows (adjustments / opening stock)';
    END IF;
  END IF;
  IF to_regclass('public.tbl_inv_count') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.tbl_inv_count) THEN
      RAISE EXCEPTION 'Cannot roll back: tbl_inv_count has rows (stock counts)';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS public.tbl_inv_count_line_event;
DROP TABLE IF EXISTS public.tbl_inv_count_line;
DROP TABLE IF EXISTS public.tbl_inv_count;
DROP TABLE IF EXISTS public.tbl_inv_adjustment_line;
DROP TABLE IF EXISTS public.tbl_inv_adjustment;
DROP TABLE IF EXISTS public.tbl_inv_out_line;
DROP TABLE IF EXISTS public.tbl_inv_out;

COMMIT;
