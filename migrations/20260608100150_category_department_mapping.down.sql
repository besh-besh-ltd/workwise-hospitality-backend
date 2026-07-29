-- Rollback for 20260608100150_category_department_mapping.sql

DROP INDEX IF EXISTS public.idx_tbl_category_department_department;
DROP INDEX IF EXISTS public.idx_tbl_category_department_category;
DROP TABLE IF EXISTS public.tbl_category_department;
