-- Migration 006 — Add process_id to tbl_arc_release.
--
-- Contracted POs (drafted from an ARC release) need their own approval
-- process selection because:
--   1. Admin always defines PO approval policies under a process_id.
--   2. The source tender's process_id is a TENDER-type process, not a
--      PO-type process — using it for PO approval finds no policy.
--   3. The buyer creating the release is the right person to pick which
--      PO process governs this release (different processes per
--      department / spend tier / approval chain).
--
-- The process picked at release-creation time is persisted on
-- tbl_arc_release.process_id and forwarded into tbl_rfq_purchase_order
-- via the draft path so initiatePurchaseOrder reads it without a join.

ALTER TABLE public.tbl_arc_release
  ADD COLUMN IF NOT EXISTS process_id integer
    REFERENCES public.tbl_approval_processes(id);

CREATE INDEX IF NOT EXISTS idx_arc_release_process_id
  ON public.tbl_arc_release(process_id);
