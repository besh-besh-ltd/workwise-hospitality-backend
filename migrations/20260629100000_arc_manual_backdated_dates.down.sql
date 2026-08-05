-- Down: 20260629100000_arc_manual_backdated_dates.down.sql
BEGIN;

ALTER TABLE public.tbl_arc_manual_entry DROP COLUMN IF EXISTS backdated_dates;

COMMIT;
