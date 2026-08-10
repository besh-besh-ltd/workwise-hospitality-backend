DROP INDEX IF EXISTS idx_notif_recipient_undelivered;

ALTER TABLE tbl_notifications
  DROP COLUMN IF EXISTS delivered_at;
