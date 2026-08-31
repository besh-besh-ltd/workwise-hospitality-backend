BEGIN;
DROP INDEX IF EXISTS public.uq_one_head_office_per_company;
ALTER TABLE public.tbl_hospitality_company_hotels DROP COLUMN IF EXISTS is_head_office;
COMMIT;
