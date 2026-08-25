DROP INDEX IF EXISTS idx_po_document_watchdog;

ALTER TABLE tbl_rfq_purchase_order
  DROP COLUMN IF EXISTS po_document_attempts,
  DROP COLUMN IF EXISTS po_document_failure_reason,
  DROP COLUMN IF EXISTS po_document_failure_notified_at,
  DROP COLUMN IF EXISTS po_document_generated_at;
