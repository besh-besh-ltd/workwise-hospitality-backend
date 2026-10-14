-- tbl_pr_line_clause.clause_type: the RFQ clause types only, default 'clause'.
-- Purchase requisitions (spec 2026-10-13 §6.3). Idempotent.
--
-- WHY: 20261013101000_pr_tables created the column with DEFAULT 'mandatory' and
-- no CHECK. The application only ever writes the types POST /rfq/add-clause
-- accepts (prConstants.CLAUSE_TYPES: 'clause' | 'sampling'), because conversion
-- copies a PR clause into tbl_rfq_product_tech_evaluation_clauses unchanged. A
-- row written with the column default would carry a type the RFQ side does not
-- know. The default becomes 'clause' (the RFQ default) and a CHECK pins the set.
--
-- A row still holding the old default 'mandatory' (only possible from a manual
-- insert) is the same thing as 'clause' and is normalised first. Any OTHER
-- value makes ADD CONSTRAINT fail and the whole migration roll back — on
-- purpose: such a row needs a human decision, not a silent rewrite.
BEGIN;

ALTER TABLE public.tbl_pr_line_clause ALTER COLUMN clause_type SET DEFAULT 'clause';

UPDATE public.tbl_pr_line_clause SET clause_type = 'clause' WHERE clause_type = 'mandatory';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_pr_line_clause_type'
       AND conrelid = 'public.tbl_pr_line_clause'::regclass
  ) THEN
    ALTER TABLE public.tbl_pr_line_clause
      ADD CONSTRAINT chk_pr_line_clause_type CHECK (clause_type IN ('clause', 'sampling'));
  END IF;
END $$;

COMMIT;
