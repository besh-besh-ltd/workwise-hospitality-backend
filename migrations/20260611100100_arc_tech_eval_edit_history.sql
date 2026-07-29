-- ARC lifecycle page — technical-evaluation edit history.
--
-- When a tech-eval approver uses "amend-then-approve" (edit any vendor's
-- marks, then approve), each changed field is recorded here as a discrete
-- before/after row — mirroring tbl_arc_amendment_edit_history. The
-- Technical stage's approval panel reads this table; each amend batch is
-- additionally folded into the approval engine comment so downstream
-- approvers see what changed before their step.

CREATE TABLE IF NOT EXISTS public.tbl_arc_tech_eval_edit_history (
  id                 BIGSERIAL PRIMARY KEY,
  arc_id             BIGINT  NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  response_id        BIGINT  NOT NULL REFERENCES public.tbl_arc_item_tech_evaluation_vendors_response(id) ON DELETE CASCADE,
  field_changed      VARCHAR(60) NOT NULL,
  before_value       JSONB,
  after_value        JSONB,
  changed_by         INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  comment            TEXT,
  changed_at         TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_tech_eval_edit_history_arc
  ON public.tbl_arc_tech_eval_edit_history (arc_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_tech_eval_edit_history_response
  ON public.tbl_arc_tech_eval_edit_history (response_id);
