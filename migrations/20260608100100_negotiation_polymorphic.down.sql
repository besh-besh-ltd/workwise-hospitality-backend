-- Rollback for 20260608100100_negotiation_polymorphic.sql
--
-- Restore rfq_id NOT NULL (only safe if no ARC-sourced rows exist), drop
-- the new columns and the check constraint. The rollback aborts if any
-- ARC-sourced row exists, because dropping source_id would orphan its only
-- pointer.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tbl_negotiation_rounds WHERE source_type = 'ARC') THEN
    RAISE EXCEPTION 'Refusing to rollback: ARC-sourced negotiation rounds exist. Migrate or delete them first.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_tbl_negotiation_rounds_fill_source
  ON public.tbl_negotiation_rounds;
DROP FUNCTION IF EXISTS public.tbl_negotiation_rounds_fill_source();

DROP INDEX IF EXISTS public.idx_tbl_negotiation_rounds_source;

ALTER TABLE public.tbl_negotiation_rounds
  DROP CONSTRAINT IF EXISTS tbl_negotiation_rounds_source_type_chk;

-- Restore rfq_id NOT NULL only if every row has a non-null rfq_id.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tbl_negotiation_rounds WHERE rfq_id IS NULL) THEN
    ALTER TABLE public.tbl_negotiation_rounds
      ALTER COLUMN rfq_id SET NOT NULL;
  END IF;
END $$;

ALTER TABLE public.tbl_negotiation_rounds
  DROP COLUMN IF EXISTS source_id,
  DROP COLUMN IF EXISTS source_type;
