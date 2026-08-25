-- PO document generation state.
--
-- Backs the watchdog that repairs POs whose stored document is older than
-- their own latest approval. Sixteen POs in production are in that state; the
-- approval transaction now prevents new ones, and these columns let the sweep
-- retry the rest and escalate the ones it cannot fix.
--
-- Mirrors the columns tbl_rfq already carries for the stuck-publish watchdog
-- (publish_attempts / publish_failure_reason / publish_failure_notified_at),
-- deliberately: same problem shape, same proven treatment.

ALTER TABLE tbl_rfq_purchase_order
  ADD COLUMN IF NOT EXISTS po_document_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS po_document_failure_reason text,
  ADD COLUMN IF NOT EXISTS po_document_failure_notified_at timestamp without time zone,
  ADD COLUMN IF NOT EXISTS po_document_generated_at timestamp without time zone;

COMMENT ON COLUMN tbl_rfq_purchase_order.po_document_attempts IS
  'Consecutive failed document-generation attempts by the watchdog. Reset to 0 on success.';
COMMENT ON COLUMN tbl_rfq_purchase_order.po_document_failure_reason IS
  'Why the last document-generation attempt failed. NULL when the document is current.';
COMMENT ON COLUMN tbl_rfq_purchase_order.po_document_failure_notified_at IS
  'When a human was told this PO cannot produce its document. Set once, so escalation does not repeat.';
COMMENT ON COLUMN tbl_rfq_purchase_order.po_document_generated_at IS
  'When po_pdf_url was last successfully written. Authoritative going forward; historical rows are dated from the millisecond timestamp in the S3 key.';

-- Partial index: the watchdog only ever scans POs that have an approval
-- instance and are past draft.
CREATE INDEX IF NOT EXISTS idx_po_document_watchdog
  ON tbl_rfq_purchase_order (approval_instance_id)
  WHERE approval_instance_id IS NOT NULL AND status <> 'draft';
