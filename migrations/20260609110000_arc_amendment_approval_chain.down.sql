ALTER TABLE public.tbl_arc_amendment
  DROP COLUMN IF EXISTS approval_chain,
  DROP COLUMN IF EXISTS current_step;
