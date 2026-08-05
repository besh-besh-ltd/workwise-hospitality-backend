-- Rollback for 20260608100200_arc_core_tables.sql

DROP TABLE IF EXISTS public.tbl_arc_tech_evaluation_rounds CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_item_tech_evaluation_cleared_vendors CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_item_tech_evaluation_vendors_response_files CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_item_tech_evaluation_vendors_response CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_item_tech_evaluation_clauses_files CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_item_tech_evaluation_clauses CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_item_tech_evaluation CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_item_history_snapshot CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_event_log CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_invitation CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_item CASCADE;
DROP TABLE IF EXISTS public.tbl_arc CASCADE;
