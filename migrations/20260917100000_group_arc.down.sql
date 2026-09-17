-- Rollback for 20260917100000_group_arc.sql

BEGIN;

DROP TABLE IF EXISTS public.tbl_arc_contract_line_hotel;
DROP TABLE IF EXISTS public.tbl_arc_comm_evaluation_award_hotel;
DROP TABLE IF EXISTS public.tbl_arc_invitation_hotel;
DROP TABLE IF EXISTS public.tbl_arc_item_hotel_qty;
DROP TABLE IF EXISTS public.tbl_arc_hotel_mappings;
ALTER TABLE public.tbl_arc DROP COLUMN IF EXISTS is_group;

COMMIT;
