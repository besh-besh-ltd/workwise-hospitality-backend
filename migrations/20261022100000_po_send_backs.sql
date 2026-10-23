-- PO send-backs: an approver puts a PO on hold and asks a named person for
-- information (INFO_REQUEST), or rejects it for re-award (COMMERCIAL) or as no
-- longer needed (CANCEL).
--
-- "On hold" is DERIVED from the OPEN row here. There is no new PO status and no
-- new tbl_approval_instances.status. At most one OPEN row per PO.
--
-- route='TECHNICAL' and target_role='TECHNICAL_EVALUATOR' are allowed by the
-- schema but refused by the API for now: room for a future "send back to
-- technical evaluation" without another CHECK change.
--
-- Also here:
--   * tbl_rfq_purchase_order.replaces_po_id  - a re-awarded PO points at the
--     rejected one it replaces.
--   * tbl_rfq_purchase_order.initiate_reminded_at - the one-time draft reminder.
--   * three approval-timeline actions. The CHECK is rebuilt with the 9 existing
--     values (identical on prod and stage, 2026-10-22) plus the new ones.
--   * log_changes_direct() row audit on both new tables.
--
-- file_url holds the URL the client got back from the upload, exactly like
-- tbl_purchase_order_document.document_url (TEXT, stored as received).

BEGIN;

CREATE TABLE IF NOT EXISTS public.tbl_po_send_backs (
  id                        SERIAL PRIMARY KEY,
  purchase_order_id         INT NOT NULL REFERENCES public.tbl_rfq_purchase_order(id),
  rfq_id                    INT NOT NULL REFERENCES public.tbl_rfq(id),
  approval_instance_id      INT NOT NULL REFERENCES public.tbl_approval_instances(id),
  approval_instance_step_id INT REFERENCES public.tbl_approval_instance_steps(id),
  step_order                INT NOT NULL,
  route           VARCHAR(20) NOT NULL
                  CHECK (route IN ('INFO_REQUEST','COMMERCIAL','CANCEL','TECHNICAL')),
  reason_category VARCHAR(30) NOT NULL
                  CHECK (reason_category IN ('EVIDENCE_MISSING','INFO_MISSING','TECH_QUERY',
                         'PRICE_TAX_QUERY','QTY_SPEC_CHANGE','RENEGOTIATE','NOT_REQUIRED','OTHER')),
  comment         TEXT NOT NULL,
  requested_by    INT NOT NULL REFERENCES public.tbl_users(id),
  target_role     VARCHAR(25)
                  CHECK (target_role IN ('RFQ_CREATOR','PO_INITIATOR','COMMERCIAL_EVALUATOR','TECHNICAL_EVALUATOR')),
  target_user_id  INT REFERENCES public.tbl_users(id),  -- resolved server-side, never from the body
  status          VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','ANSWERED','WITHDRAWN','SUPERSEDED','CLOSED')),
  response_text   TEXT,
  responded_by    INT REFERENCES public.tbl_users(id),
  responded_at    TIMESTAMPTZ,
  resolution      VARCHAR(30),  -- RESUMED | PO_AMENDED_RESTARTED | REJECTED_AFTER | RFQ_CLOSED | PO_SUPERSEDED
  reminded_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  CHECK (route <> 'INFO_REQUEST' OR (target_role IS NOT NULL AND target_user_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_po_send_back_one_open
  ON public.tbl_po_send_backs (purchase_order_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS ix_po_send_back_target_open
  ON public.tbl_po_send_backs (target_user_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS ix_po_send_back_rfq
  ON public.tbl_po_send_backs (rfq_id);
-- Holds per approval instance: the propagation sweep and the report hold-time
-- joins look them up by instance.
CREATE INDEX IF NOT EXISTS ix_po_send_back_instance ON public.tbl_po_send_backs (approval_instance_id);

CREATE TABLE IF NOT EXISTS public.tbl_po_send_back_files (
  id           SERIAL PRIMARY KEY,
  send_back_id INT NOT NULL REFERENCES public.tbl_po_send_backs(id) ON DELETE CASCADE,
  side         VARCHAR(10) NOT NULL CHECK (side IN ('REQUEST','RESPONSE')),
  file_url     TEXT NOT NULL,
  file_name    TEXT,
  mime_type    TEXT,
  uploaded_by  INT NOT NULL REFERENCES public.tbl_users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_po_send_back_files_sb
  ON public.tbl_po_send_back_files (send_back_id);

DROP TRIGGER IF EXISTS tbl_po_send_backs_audit ON public.tbl_po_send_backs;
CREATE TRIGGER tbl_po_send_backs_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_po_send_backs
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

DROP TRIGGER IF EXISTS tbl_po_send_back_files_audit ON public.tbl_po_send_back_files;
CREATE TRIGGER tbl_po_send_back_files_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_po_send_back_files
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

ALTER TABLE public.tbl_rfq_purchase_order
  ADD COLUMN IF NOT EXISTS replaces_po_id INT REFERENCES public.tbl_rfq_purchase_order(id),
  ADD COLUMN IF NOT EXISTS initiate_reminded_at TIMESTAMPTZ;

ALTER TABLE public.tbl_approval_actions
  DROP CONSTRAINT IF EXISTS tbl_approval_actions_action_check;
ALTER TABLE public.tbl_approval_actions
  ADD CONSTRAINT tbl_approval_actions_action_check CHECK (action::text IN (
    'APPROVE','REJECT','CANCELLED','POLICY_CHANGE','APPROVER_REMOVED','APPROVER_ADDED',
    'STEP_REMOVED','STEP_ADDED','MEMBERSHIP_REVALIDATION',
    'SEND_BACK','SEND_BACK_ANSWERED','SEND_BACK_WITHDRAWN'));

COMMIT;
