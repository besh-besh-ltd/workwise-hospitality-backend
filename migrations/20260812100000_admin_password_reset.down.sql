-- Dropping these columns disables admin password reset entirely; the routes in
-- app/routes/admin/authRoutes.js will 500 on the missing columns. Revert the
-- application code first.

DROP INDEX IF EXISTS idx_users_pwd_reset_live;

ALTER TABLE tbl_users
  DROP COLUMN IF EXISTS pwd_reset_token_hash,
  DROP COLUMN IF EXISTS pwd_reset_expires_at,
  DROP COLUMN IF EXISTS pwd_reset_used_at,
  DROP COLUMN IF EXISTS pwd_reset_attempts,
  DROP COLUMN IF EXISTS pwd_changed_at;
