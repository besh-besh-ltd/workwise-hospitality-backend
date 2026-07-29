ALTER TABLE public.tbl_arc_amendment DROP CONSTRAINT IF EXISTS tbl_arc_amendment_status_chk;
ALTER TABLE public.tbl_arc_amendment
  ADD CONSTRAINT tbl_arc_amendment_status_chk
  CHECK (status IN ('requested','approved','rejected','live','ended','voided'));
