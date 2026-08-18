-- ARC v2 — Migration 2 of 10: polymorphic refactor on tbl_negotiation_rounds.
--
-- The existing negotiation engine is hard-coupled to RFQ via the NOT NULL
-- rfq_id column. ARC v2 reuses the same engine for commercial evaluation
-- (PRD Open Q16 — Option A chosen). This migration adds two columns:
--
--   source_type VARCHAR(20) — 'RFQ' (existing rows backfilled) or 'ARC'
--   source_id   INTEGER     — references either tbl_rfq.id or tbl_arc.id
--
-- After this migration, RFQ callers (negotiationModel.createRound and the
-- existing endpoints) continue to populate rfq_id alongside the new pair,
-- so all RFQ-side queries (`WHERE rfq_id = $1`) keep working without code
-- changes. New ARC callers populate (source_type='ARC', source_id=arc_id)
-- and leave rfq_id NULL — that's why rfq_id is relaxed from NOT NULL to
-- nullable.
--
-- Indexing: a composite (source_type, source_id) index supports the future
-- ARC accessor. The existing rfq_id index is kept untouched.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, conditional NOT NULL set, conditional
-- backfill (only WHERE source_id IS NULL).

ALTER TABLE public.tbl_negotiation_rounds
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS source_id INTEGER;

-- Backfill existing rows. Only touches rows where the new columns are NULL,
-- so re-runs are no-ops.
UPDATE public.tbl_negotiation_rounds
SET source_type = 'RFQ',
    source_id   = rfq_id
WHERE source_type IS NULL
   OR source_id   IS NULL;

-- Tighten constraints after backfill. Wrapped in DO/IF blocks so the migration
-- is safe to re-run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'tbl_negotiation_rounds'
      AND column_name  = 'source_type'
      AND is_nullable  = 'YES'
  ) THEN
    ALTER TABLE public.tbl_negotiation_rounds
      ALTER COLUMN source_type SET NOT NULL,
      ALTER COLUMN source_type SET DEFAULT 'RFQ';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'tbl_negotiation_rounds'
      AND column_name  = 'source_id'
      AND is_nullable  = 'YES'
  ) THEN
    ALTER TABLE public.tbl_negotiation_rounds
      ALTER COLUMN source_id SET NOT NULL;
  END IF;

  -- Relax rfq_id to nullable so ARC-sourced rounds can store NULL there.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'tbl_negotiation_rounds'
      AND column_name  = 'rfq_id'
      AND is_nullable  = 'NO'
  ) THEN
    ALTER TABLE public.tbl_negotiation_rounds
      ALTER COLUMN rfq_id DROP NOT NULL;
  END IF;

  -- Check constraint: source_type may only be 'RFQ' or 'ARC' for now.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_negotiation_rounds_source_type_chk'
  ) THEN
    ALTER TABLE public.tbl_negotiation_rounds
      ADD CONSTRAINT tbl_negotiation_rounds_source_type_chk
      CHECK (source_type IN ('RFQ', 'ARC'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tbl_negotiation_rounds_source
  ON public.tbl_negotiation_rounds (source_type, source_id);

-- Backward-compat trigger.
-- The previous shape of tbl_negotiation_rounds only required rfq_id, and
-- multiple call sites in the codebase (and ad-hoc fixture INSERTs in tests)
-- omit source_type/source_id. To preserve those callers without a sweep, this
-- BEFORE INSERT trigger fills the new columns from rfq_id when they're NULL.
-- ARC-sourced inserts always set source_type='ARC' + source_id explicitly, so
-- the trigger leaves them alone.
CREATE OR REPLACE FUNCTION public.tbl_negotiation_rounds_fill_source()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source_type IS NULL AND NEW.rfq_id IS NOT NULL THEN
    NEW.source_type := 'RFQ';
  END IF;
  IF NEW.source_id IS NULL AND NEW.rfq_id IS NOT NULL THEN
    NEW.source_id := NEW.rfq_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tbl_negotiation_rounds_fill_source
  ON public.tbl_negotiation_rounds;

CREATE TRIGGER trg_tbl_negotiation_rounds_fill_source
  BEFORE INSERT ON public.tbl_negotiation_rounds
  FOR EACH ROW
  EXECUTE FUNCTION public.tbl_negotiation_rounds_fill_source();
