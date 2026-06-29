-- Up: 20260629100000_arc_manual_backdated_dates.sql
-- Persist the backdated date chain (and the S5 ended controls) entered in the
-- Manual ARC Entry workspace onto the draft's provenance row, so Save-draft →
-- resume no longer loses them (SC-5). These dates have no home on a *draft* ARC:
-- floated/comm-finalized/generated/signed_by_vendor live on rows (event /
-- comm_eval / contract) that don't exist until finalize. One JSONB blob keyed
-- by the controller's date names is the simplest durable store; finalize still
-- reads the authoritative values from the request body.
BEGIN;

ALTER TABLE public.tbl_arc_manual_entry
  ADD COLUMN IF NOT EXISTS backdated_dates JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
