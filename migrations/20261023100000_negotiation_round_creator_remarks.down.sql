BEGIN;

ALTER TABLE public.tbl_negotiation_rounds
  DROP CONSTRAINT IF EXISTS tbl_negotiation_rounds_creator_remarks_len;

ALTER TABLE public.tbl_negotiation_rounds
  DROP COLUMN IF EXISTS creator_remarks;

COMMIT;
