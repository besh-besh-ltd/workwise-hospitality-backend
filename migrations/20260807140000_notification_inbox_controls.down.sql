DROP INDEX IF EXISTS idx_notif_recipient_active;

ALTER TABLE tbl_notifications
  DROP COLUMN IF EXISTS dismissed_at;
