-- Notification delivery state.
--
-- Until now `tbl_notifications` modelled a single boolean, `is_read`, which had
-- to serve two different questions at once:
--
--   "has this user had a chance to see it?"  → drives the bell badge
--   "has this user acted on it?"             → drives the unread highlight
--
-- One column cannot answer both. The badge only cleared once every item was
-- individually clicked (or nuked with "mark all read", which destroys the
-- read/unread distinction), so in practice the badge was permanently lit and
-- users stopped reading it.
--
-- `delivered_at` splits the two: opening the bell marks everything on screen
-- delivered (badge clears), while `is_read` continues to track what the user
-- actually opened (highlight persists until clicked).

ALTER TABLE tbl_notifications
  ADD COLUMN IF NOT EXISTS delivered_at timestamp with time zone;

-- Backfill: every pre-existing row was already listed in the bell, so by the
-- new definition it has been delivered. Without this, the first deploy would
-- greet every existing user with a badge counting their entire history.
-- A row that was read is delivered at the moment it was read; everything else
-- inherits its creation time.
UPDATE tbl_notifications
   SET delivered_at = COALESCE(is_read_at, created_at, now())
 WHERE delivered_at IS NULL;

-- The badge query is `WHERE recipient_user_id = $1 AND delivered_at IS NULL`.
-- A partial index keeps it proportional to the undelivered backlog (normally a
-- handful of rows) rather than to the user's lifetime notification count.
CREATE INDEX IF NOT EXISTS idx_notif_recipient_undelivered
    ON tbl_notifications (recipient_user_id)
 WHERE delivered_at IS NULL;
