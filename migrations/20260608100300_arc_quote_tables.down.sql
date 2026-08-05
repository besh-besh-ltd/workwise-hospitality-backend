-- Rollback for 20260608100300_arc_quote_tables.sql

DROP TABLE IF EXISTS public.tbl_arc_comm_evaluation_history CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_comm_evaluation_award CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_comm_evaluation CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_quote_line_history CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_quote_line CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_quote CASCADE;
