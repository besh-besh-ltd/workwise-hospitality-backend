-- Browser push notifications + in-app notification center
-- Apply with: psql $DATABASE_URL -f migrations/2026_05_26_push_notifications.sql

BEGIN;

CREATE TABLE IF NOT EXISTS tbl_push_subscriptions (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES tbl_users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_sub_user ON tbl_push_subscriptions(user_id);

ALTER TABLE tbl_notifications
  ADD COLUMN IF NOT EXISTS recipient_user_id INT,
  ADD COLUMN IF NOT EXISTS action_url TEXT,
  ADD COLUMN IF NOT EXISTS category VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_notif_recipient_unread
  ON tbl_notifications(recipient_user_id, is_read);

COMMIT;
