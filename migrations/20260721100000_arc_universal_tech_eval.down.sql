-- Rollback: 20260721100000_arc_universal_tech_eval
-- Drop the six universal tech-eval tables in reverse-FK order.
DROP TABLE IF EXISTS public.tbl_arc_universal_tech_evaluation_cleared_vendors;
DROP TABLE IF EXISTS public.tbl_arc_universal_tech_evaluation_vendors_response_files;
DROP TABLE IF EXISTS public.tbl_arc_universal_tech_evaluation_vendors_response;
DROP TABLE IF EXISTS public.tbl_arc_universal_tech_evaluation_clauses_files;
DROP TABLE IF EXISTS public.tbl_arc_universal_tech_evaluation_clauses;
DROP TABLE IF EXISTS public.tbl_arc_universal_tech_evaluation;
