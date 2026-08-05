-- Rollback for 20260608100400_arc_contract_tables.sql

DROP TABLE IF EXISTS public.tbl_arc_contract_signature_otp CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_contract_line CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_contract CASCADE;
