-- ARC v2 — Amendments: vendor-initiated workflow with locked approval chain.
--
-- Pivot from buyer-initiated to vendor-initiated. The approval matrix is
-- snapshotted at request time so every reviewer sees the same chain, even
-- if the underlying policy changes later. Phase A keeps the chain on the
-- amendment row itself (JSONB) instead of full tbl_approval_instances
-- machinery so the buyer review UI can render without joins.
--
-- approval_chain shape:
--   [
--     { step:1, role:"Procurement Manager", approver_user_ids:[123],
--       status:"pending"|"approved"|"rejected", decided_by:null|<uid>,
--       decided_at:null|<ts>, comment:null|"text" },
--     ...
--   ]
--
-- current_step points at the next pending step (1-indexed). When the last
-- step is approved, controller flips status to 'approved'.

ALTER TABLE public.tbl_arc_amendment
  ADD COLUMN IF NOT EXISTS approval_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS current_step    INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_tbl_arc_amendment_current_step
  ON public.tbl_arc_amendment (current_step)
  WHERE status = 'requested';
