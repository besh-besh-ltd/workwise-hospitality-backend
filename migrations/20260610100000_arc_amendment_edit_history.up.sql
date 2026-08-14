-- ARC v2 — Amendment edit history.
--
-- When a buyer uses "edit-then-approve" (counter-offer) on a vendor's
-- amendment request, each changed field is recorded here as a discrete
-- before/after row — mirroring the WH-69 RFQ snapshot-diff pattern
-- (tbl_rfq_change_history). The review modal's "Edit history" tab reads
-- this table; the central approval workflow additionally surfaces each
-- edit as a comment row in tbl_approval_actions so approvers downstream
-- see what was changed before their step.

CREATE TABLE IF NOT EXISTS public.tbl_arc_amendment_edit_history (
  id                 BIGSERIAL PRIMARY KEY,
  arc_amendment_id   BIGINT  NOT NULL REFERENCES public.tbl_arc_amendment(id) ON DELETE CASCADE,
  field_changed      VARCHAR(60) NOT NULL,
  before_value       JSONB,
  after_value        JSONB,
  changed_by         INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  comment            TEXT,
  changed_at         TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_amendment_edit_history_amendment
  ON public.tbl_arc_amendment_edit_history (arc_amendment_id, changed_at DESC);
