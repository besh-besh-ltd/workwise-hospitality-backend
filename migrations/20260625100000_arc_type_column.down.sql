-- Revert: drop the ARC `type` column.

BEGIN;

ALTER TABLE public.tbl_arc
  DROP COLUMN IF EXISTS type;

COMMIT;
