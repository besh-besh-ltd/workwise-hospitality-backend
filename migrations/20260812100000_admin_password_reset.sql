-- Admin self-service password reset.
--
-- The admin panel had no way to change a password. `/admin/auth` exposed only
-- login and admin-profile, so a locked-out admin had to have their row edited
-- by hand, and an admin who wanted to rotate a password simply could not.
--
-- The user-side flow this could have reused stores a bare 6-digit OTP in
-- `tbl_users.otp` and resets by matching on that column alone
-- (`update tbl_users set password = $2 where otp = $1`). That has no email
-- binding, no expiry, and no single-use marker — the OTP stays valid forever
-- because the clear step is commented out — so anyone holding one number can
-- re-take the account at any later date, and 10^6 is inside brute-force range.
-- Admin accounts are the highest-value credential in the system, so they get a
-- token that is random, hashed at rest, expiring, single-use and attempt-capped
-- instead. See the note in the down migration before dropping these.

ALTER TABLE tbl_users
  ADD COLUMN IF NOT EXISTS pwd_reset_token_hash  text,
  ADD COLUMN IF NOT EXISTS pwd_reset_expires_at  timestamp with time zone,
  ADD COLUMN IF NOT EXISTS pwd_reset_used_at     timestamp with time zone,
  ADD COLUMN IF NOT EXISTS pwd_reset_attempts    smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pwd_changed_at        timestamp with time zone;

-- Reset lookup is always "find the one live token matching this hash", so the
-- hash and the liveness predicate belong in the same index. Partial, because
-- the overwhelming majority of rows have no reset in flight.
CREATE INDEX IF NOT EXISTS idx_users_pwd_reset_live
    ON tbl_users (pwd_reset_token_hash)
 WHERE pwd_reset_token_hash IS NOT NULL
   AND pwd_reset_used_at IS NULL;
