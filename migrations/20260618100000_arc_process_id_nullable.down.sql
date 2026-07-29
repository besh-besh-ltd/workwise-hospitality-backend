-- Revert: ARC process_id back to NOT NULL (audit H5 rollback).
-- WARNING: will fail if any tbl_arc rows have a NULL process_id; backfill first.

BEGIN;

ALTER TABLE public.tbl_arc
  ALTER COLUMN process_id SET NOT NULL;

COMMIT;
