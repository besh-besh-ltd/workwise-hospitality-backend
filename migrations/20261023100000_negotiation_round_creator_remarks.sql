-- REQ-0026: the person who opens a negotiation round can leave a note for the
-- approvers. Internal only: it is never returned to vendors.
-- Separate from tbl_negotiation_rounds.remarks, which holds the reject/withdraw reason.

BEGIN;

ALTER TABLE public.tbl_negotiation_rounds
  ADD COLUMN IF NOT EXISTS creator_remarks TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_negotiation_rounds_creator_remarks_len'
      AND conrelid = 'public.tbl_negotiation_rounds'::regclass
  ) THEN
    ALTER TABLE public.tbl_negotiation_rounds
      ADD CONSTRAINT tbl_negotiation_rounds_creator_remarks_len
      CHECK (creator_remarks IS NULL OR char_length(creator_remarks) <= 1000);
  END IF;
END $$;

COMMIT;
