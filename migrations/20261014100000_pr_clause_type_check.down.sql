-- Reverts 20261014100000_pr_clause_type_check.sql. Idempotent.
-- The CHECK goes and the column default returns to the original 'mandatory'.
-- Rows keep their 'clause' / 'sampling' values (a 'mandatory' row normalised
-- by the up migration is not restored — the two meant the same thing).
BEGIN;
ALTER TABLE public.tbl_pr_line_clause DROP CONSTRAINT IF EXISTS chk_pr_line_clause_type;
ALTER TABLE public.tbl_pr_line_clause ALTER COLUMN clause_type SET DEFAULT 'mandatory';
COMMIT;
