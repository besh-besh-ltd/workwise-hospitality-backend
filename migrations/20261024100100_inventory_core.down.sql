-- Reverses 20261024100100_inventory_core.
--
-- Run AFTER the downs of 20261024100500 .. 20261024100200 (they reference
-- tbl_inv_item and tbl_inv_movement's neighbours).
--
-- Refuses while the ledger or the item master holds rows: dropping them would
-- silently destroy stock history and every hotel's item setup. Empty them
-- deliberately first (the ledger only by TRUNCATE: its trigger blocks DELETE).

BEGIN;

DO $$
BEGIN
  -- Nested: each inner query is planned only once its table is known to exist.
  IF to_regclass('public.tbl_inv_movement') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.tbl_inv_movement) THEN
      RAISE EXCEPTION 'Cannot roll back: tbl_inv_movement has rows (stock ledger history)';
    END IF;
  END IF;
  IF to_regclass('public.tbl_inv_item') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.tbl_inv_item) THEN
      RAISE EXCEPTION 'Cannot roll back: tbl_inv_item has rows (stock item master)';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS public.tbl_inv_batch;
DROP TABLE IF EXISTS public.tbl_inv_balance;
DROP TABLE IF EXISTS public.tbl_inv_movement;   -- drops its trigger with it
DROP FUNCTION IF EXISTS public.tbl_inv_movement_immutable();
DROP TABLE IF EXISTS public.tbl_inv_doc_code_history;
DROP TABLE IF EXISTS public.tbl_inv_doc_sequence;
DROP TABLE IF EXISTS public.tbl_inv_hotel_item;
DROP TABLE IF EXISTS public.tbl_inv_item_barcode;
DROP TABLE IF EXISTS public.tbl_inv_item_uom;
DROP TABLE IF EXISTS public.tbl_inv_category_default;
DROP TABLE IF EXISTS public.tbl_inv_item_variant;
DROP TABLE IF EXISTS public.tbl_inv_item;
DROP TABLE IF EXISTS public.tbl_inv_hotel_settings;
DROP TABLE IF EXISTS public.tbl_inv_company_settings;

COMMIT;
