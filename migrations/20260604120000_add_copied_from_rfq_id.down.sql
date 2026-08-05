-- Rollback for 20260604120000_add_copied_from_rfq_id.sql

DROP INDEX IF EXISTS idx_tbl_rfq_copied_from_rfq_id;

ALTER TABLE tbl_rfq
  DROP CONSTRAINT IF EXISTS tbl_rfq_copied_from_rfq_id_fkey;

ALTER TABLE tbl_rfq
  DROP COLUMN IF EXISTS copied_from_rfq_no;

ALTER TABLE tbl_rfq
  DROP COLUMN IF EXISTS copied_from_rfq_id;
