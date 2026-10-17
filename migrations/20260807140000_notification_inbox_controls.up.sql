-- Inbox controls: dismiss and re-open.
--
-- The notification centre had exactly three verbs — list, mark one read, mark
-- everything read. There was no way to clear a single item you had dealt with,
-- and no way to put one back after opening it by accident. The only tool for a
-- cluttered inbox was "mark all read", which destroys the read/unread
-- distinction wholesale, so people used it once and then stopped trusting the
-- panel to tell them anything.
--
-- `dismissed_at` is a soft delete. Notifications are an audit trail of who was
-- told what and when — several of these rows are the only record that an
-- approver was asked to act — so a hard DELETE would destroy evidence to tidy a
-- list. Dismissed rows leave the inbox and stop counting; they stay in the
-- table.

ALTER TABLE tbl_notifications
  ADD COLUMN IF NOT EXISTS dismissed_at timestamp with time zone;

-- Every inbox read is now "mine, not dismissed", so the recipient predicate and
-- the dismissal check belong in one index.
CREATE INDEX IF NOT EXISTS idx_notif_recipient_active
    ON tbl_notifications (recipient_user_id, created_at DESC)
 WHERE dismissed_at IS NULL;
