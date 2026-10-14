-- Reverts 20261014110000_pr_indexes.sql. Idempotent.
-- The Company Administrator's pr.create / evaluate / approve / convert grants
-- that the up migration removed are deliberately NOT re-granted (ruling R40:
-- the role keeps pr.read only, which 20261013100000 itself grants).
BEGIN;

ALTER TABLE public.tbl_pr_catalog_request DROP CONSTRAINT IF EXISTS fk_pr_catreq_resolved_by;

DROP INDEX IF EXISTS public.idx_pr_catreq_line;
DROP INDEX IF EXISTS public.idx_pr_review_line_line;
DROP INDEX IF EXISTS public.idx_pr_line_rfq_product;
DROP INDEX IF EXISTS public.idx_pr_line_clause_line;
DROP INDEX IF EXISTS public.idx_pr_attachment_line;
DROP INDEX IF EXISTS public.idx_pr_attachment_pr;

COMMIT;
