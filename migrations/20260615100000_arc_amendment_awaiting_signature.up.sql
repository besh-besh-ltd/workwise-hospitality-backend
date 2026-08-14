-- Add 'awaiting_signature' to the amendment status domain. This status sits
-- between 'approved' (engine terminal) and 'live' (effects bound): the
-- amendment is approved but parked until the vendor signs the addendum.
ALTER TABLE public.tbl_arc_amendment DROP CONSTRAINT IF EXISTS tbl_arc_amendment_status_chk;
ALTER TABLE public.tbl_arc_amendment
  ADD CONSTRAINT tbl_arc_amendment_status_chk
  CHECK (status IN ('requested','approved','awaiting_signature','rejected','live','ended','voided'));
