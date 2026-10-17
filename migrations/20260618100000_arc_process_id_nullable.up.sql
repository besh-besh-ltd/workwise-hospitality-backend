-- ARC: process_id is optional (audit H5).
-- ARC approval routes via the committee/hierarchy model, not an approval
-- process, so a new ARC is no longer forced to carry a (often bogus) process_id.
-- Apply with: psql $DATABASE_URL -f migrations/20260618100000_arc_process_id_nullable.sql

BEGIN;

ALTER TABLE public.tbl_arc
  ALTER COLUMN process_id DROP NOT NULL;

COMMIT;
