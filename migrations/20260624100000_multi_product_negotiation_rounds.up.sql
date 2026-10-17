-- Negotiation — multi-product rounds.
--
-- Reconstructed migration for the multi-product negotiation feature. The
-- columns/indexes/constraints below already exist on staging (applied
-- out-of-band) but were never committed as a migration file, so production
-- is missing them. Without these, the multi-product round code fails:
--   * negotiationModel selects `products` (NULL column -> feature broken)
--   * multi-product rounds carry rfq_product_id = NULL at the top level and
--     store per-product coverage in the `products` JSONB array; the
--     chk_neg_round_scope constraint enforces that every round is scoped by
--     EITHER a single rfq_product_id OR a products[] payload.
--
-- Must run AFTER 20260608100100_negotiation_polymorphic.sql (this file relies
-- on source_type/source_id already existing for the ARC-item index).
--
-- Fully idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and
-- DO/IF guards on every constraint. Safe to re-run and safe on a DB that
-- already has some of these objects.
--
-- Apply with:
--   psql "$DATABASE_URL" -f migrations/20260624100000_multi_product_negotiation_rounds.sql

BEGIN;

-- 1. tbl_negotiation_rounds: multi-product + ARC-item columns ------------------
ALTER TABLE public.tbl_negotiation_rounds
  ADD COLUMN IF NOT EXISTS rfq_product_id   integer,
  ADD COLUMN IF NOT EXISTS vendor_ids       integer[],
  ADD COLUMN IF NOT EXISTS vendor_approvals jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS products         jsonb,
  ADD COLUMN IF NOT EXISTS arc_item_id      bigint;

-- FK: single-product / legacy rounds point at their RFQ product.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_negotiation_rounds_rfq_product_id_fkey'
      AND conrelid = 'public.tbl_negotiation_rounds'::regclass
  ) THEN
    ALTER TABLE public.tbl_negotiation_rounds
      ADD CONSTRAINT tbl_negotiation_rounds_rfq_product_id_fkey
      FOREIGN KEY (rfq_product_id)
      REFERENCES public.tbl_rfq_products(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Scope guard: a round must be scoped by a single product OR a products[]
-- payload (multi-product). Requires the `products` column added above.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_neg_round_scope'
      AND conrelid = 'public.tbl_negotiation_rounds'::regclass
  ) THEN
    ALTER TABLE public.tbl_negotiation_rounds
      ADD CONSTRAINT chk_neg_round_scope
      CHECK (rfq_product_id IS NOT NULL OR products IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_negotiation_rounds_product_id
  ON public.tbl_negotiation_rounds (rfq_product_id);

CREATE INDEX IF NOT EXISTS idx_negotiation_rounds_product_status
  ON public.tbl_negotiation_rounds (rfq_product_id, status, round_number DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_negotiation_rounds_rfq_product_round
  ON public.tbl_negotiation_rounds (rfq_id, rfq_product_id, round_number)
  WHERE rfq_product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_neg_rounds_arc_item
  ON public.tbl_negotiation_rounds (source_id, arc_item_id)
  WHERE source_type::text = 'ARC';

-- 2. tbl_negotiation_round_quotes: per-product quotes -------------------------
ALTER TABLE public.tbl_negotiation_round_quotes
  ADD COLUMN IF NOT EXISTS rfq_product_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_negotiation_round_quotes_rfq_product_id_fkey'
      AND conrelid = 'public.tbl_negotiation_round_quotes'::regclass
  ) THEN
    ALTER TABLE public.tbl_negotiation_round_quotes
      ADD CONSTRAINT tbl_negotiation_round_quotes_rfq_product_id_fkey
      FOREIGN KEY (rfq_product_id)
      REFERENCES public.tbl_rfq_products(id);
  END IF;
END $$;

-- The uniqueness of a quote must include rfq_product_id so the SAME vendor can
-- quote MULTIPLE products in one round. If a legacy 2-column unique
-- (negotiation_round_id, vendor_id) exists under the auto-generated name, swap
-- it for the 3-column version. Guarded so it only fires when the current
-- definition lacks rfq_product_id.
DO $$
DECLARE
  con_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO con_def
  FROM pg_constraint
  WHERE conname = 'tbl_negotiation_round_quotes_negotiation_round_id_vendor_id_key'
    AND conrelid = 'public.tbl_negotiation_round_quotes'::regclass;

  IF con_def IS NOT NULL AND con_def NOT ILIKE '%rfq_product_id%' THEN
    ALTER TABLE public.tbl_negotiation_round_quotes
      DROP CONSTRAINT tbl_negotiation_round_quotes_negotiation_round_id_vendor_id_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_negotiation_round_quotes_negotiation_round_id_vendor_id_key'
      AND conrelid = 'public.tbl_negotiation_round_quotes'::regclass
  ) THEN
    ALTER TABLE public.tbl_negotiation_round_quotes
      ADD CONSTRAINT tbl_negotiation_round_quotes_negotiation_round_id_vendor_id_key
      UNIQUE (negotiation_round_id, vendor_id, rfq_product_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_round_quotes_product_id
  ON public.tbl_negotiation_round_quotes (rfq_product_id);

CREATE INDEX IF NOT EXISTS idx_negotiation_round_quotes_round_vendor
  ON public.tbl_negotiation_round_quotes (negotiation_round_id, vendor_id, rfq_product_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_round_quotes_round_vendor_product
  ON public.tbl_negotiation_round_quotes (negotiation_round_id, vendor_id, rfq_product_id);

COMMIT;
