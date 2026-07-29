-- Rollback for 20260624100000_multi_product_negotiation_rounds.sql
--
-- Reverses the multi-product additions in the opposite order they were made:
-- round_quotes objects first, then tbl_negotiation_rounds. Restores the legacy
-- 2-column unique on round_quotes when it is safe to do so.
--
-- SAFETY GUARD: this rollback refuses to run if ANY negotiation round or round
-- quote actually uses the per-product columns (products / rfq_product_id).
-- Those columns hold the round's ONLY scope pointer, so dropping them while in
-- use would silently destroy live negotiation data. Migrate or clear that data
-- first (or drop the columns by hand if you accept the loss).
--
-- Fully idempotent: DROP ... IF EXISTS everywhere, guarded constraint/column
-- drops. Safe to re-run.

BEGIN;

-- 0. Refuse to roll back while the feature is in use ---------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tbl_negotiation_rounds
    WHERE products IS NOT NULL
       OR rfq_product_id IS NOT NULL
       OR arc_item_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Refusing to rollback: multi-product / product-scoped negotiation rounds exist. Clear or migrate them first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tbl_negotiation_round_quotes
    WHERE rfq_product_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Refusing to rollback: product-scoped round quotes exist. Clear or migrate them first.';
  END IF;
END $$;

-- 1. tbl_negotiation_round_quotes ---------------------------------------------
DROP INDEX IF EXISTS public.idx_round_quotes_round_vendor_product;
DROP INDEX IF EXISTS public.idx_negotiation_round_quotes_round_vendor;
DROP INDEX IF EXISTS public.idx_round_quotes_product_id;

-- Swap the 3-column unique back to the legacy 2-column shape. Only restore the
-- 2-column key if it would not be violated by existing rows.
DO $$
DECLARE
  con_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO con_def
  FROM pg_constraint
  WHERE conname = 'tbl_negotiation_round_quotes_negotiation_round_id_vendor_id_key'
    AND conrelid = 'public.tbl_negotiation_round_quotes'::regclass;

  IF con_def IS NOT NULL AND con_def ILIKE '%rfq_product_id%' THEN
    ALTER TABLE public.tbl_negotiation_round_quotes
      DROP CONSTRAINT tbl_negotiation_round_quotes_negotiation_round_id_vendor_id_key;

    IF NOT EXISTS (
      SELECT 1 FROM public.tbl_negotiation_round_quotes
      GROUP BY negotiation_round_id, vendor_id
      HAVING count(*) > 1
    ) THEN
      ALTER TABLE public.tbl_negotiation_round_quotes
        ADD CONSTRAINT tbl_negotiation_round_quotes_negotiation_round_id_vendor_id_key
        UNIQUE (negotiation_round_id, vendor_id);
    END IF;
  END IF;
END $$;

ALTER TABLE public.tbl_negotiation_round_quotes
  DROP CONSTRAINT IF EXISTS tbl_negotiation_round_quotes_rfq_product_id_fkey;

ALTER TABLE public.tbl_negotiation_round_quotes
  DROP COLUMN IF EXISTS rfq_product_id;

-- 2. tbl_negotiation_rounds ---------------------------------------------------
DROP INDEX IF EXISTS public.idx_neg_rounds_arc_item;
DROP INDEX IF EXISTS public.idx_negotiation_rounds_rfq_product_round;
DROP INDEX IF EXISTS public.idx_negotiation_rounds_product_status;
DROP INDEX IF EXISTS public.idx_negotiation_rounds_product_id;

ALTER TABLE public.tbl_negotiation_rounds
  DROP CONSTRAINT IF EXISTS chk_neg_round_scope;

ALTER TABLE public.tbl_negotiation_rounds
  DROP CONSTRAINT IF EXISTS tbl_negotiation_rounds_rfq_product_id_fkey;

ALTER TABLE public.tbl_negotiation_rounds
  DROP COLUMN IF EXISTS arc_item_id,
  DROP COLUMN IF EXISTS products,
  DROP COLUMN IF EXISTS vendor_approvals,
  DROP COLUMN IF EXISTS vendor_ids,
  DROP COLUMN IF EXISTS rfq_product_id;

COMMIT;
