import db from '../config/dbConn.js';

const adminModel = {
  getUser: async (email) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_users WHERE status= 1 AND is_deleted = 0 AND email = $1 AND user_type NOT IN (2,3,4)`,
        [email]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getUserById: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_users WHERE status= 1 AND is_deleted = 0 AND id = $1`,
        [id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  /**
   * The admin predicate, in one place. `getUser` above is the login lookup and
   * carries the same three conditions inline; every password operation has to
   * agree with it exactly, or a disabled admin could reset their way back in.
   */
  getAdminByEmail: async (email) => {
    return db.oneOrNone(
      `SELECT id, name, email, user_type, password
         FROM tbl_users
        WHERE status = 1
          AND is_deleted = 0
          AND user_type NOT IN (2, 3, 4)
          AND LOWER(email) = LOWER($1)`,
      [email]
    );
  },

  getAdminAuthById: async (id) => {
    return db.oneOrNone(
      `SELECT id, name, email, user_type, password
         FROM tbl_users
        WHERE status = 1
          AND is_deleted = 0
          AND user_type NOT IN (2, 3, 4)
          AND id = $1`,
      [id]
    );
  },

  /**
   * Changing the password clears any reset in flight. Otherwise a link mailed
   * just before the change stays live and can silently undo it.
   */
  updateAdminPassword: async (id, passwordHash) => {
    return db.none(
      `UPDATE tbl_users
          SET password = $2,
              pwd_changed_at = NOW(),
              pwd_reset_token_hash = NULL,
              pwd_reset_expires_at = NULL,
              pwd_reset_used_at = NULL,
              pwd_reset_attempts = 0
        WHERE id = $1`,
      [id, passwordHash]
    );
  },

  /**
   * Issuing a new link invalidates the previous one — the column holds a single
   * hash, so the write replaces it. `pwd_reset_attempts` counts links issued
   * inside the current live window so a mailbox cannot be flooded by repeats;
   * it restarts once the window has lapsed.
   */
  setAdminResetToken: async (id, tokenHash, ttlMinutes) => {
    return db.one(
      `UPDATE tbl_users
          SET pwd_reset_token_hash = $2,
              pwd_reset_expires_at = NOW() + ($3 || ' minutes')::interval,
              pwd_reset_used_at = NULL,
              pwd_reset_attempts = CASE
                WHEN pwd_reset_expires_at IS NULL OR pwd_reset_expires_at < NOW()
                  THEN 1
                ELSE pwd_reset_attempts + 1
              END
        WHERE id = $1
        RETURNING pwd_reset_attempts`,
      [id, tokenHash, String(ttlMinutes)]
    );
  },

  liveResetIssueCount: async (id) => {
    const row = await db.oneOrNone(
      `SELECT pwd_reset_attempts AS issued
         FROM tbl_users
        WHERE id = $1
          AND pwd_reset_expires_at IS NOT NULL
          AND pwd_reset_expires_at > NOW()`,
      [id]
    );
    return row ? Number(row.issued) : 0;
  },

  /**
   * Deliberately narrow: the token must be unused, unexpired, and belong to a
   * live admin. A row failing any of those is not a reset candidate at all.
   */
  findAdminByResetTokenHash: async (tokenHash) => {
    return db.oneOrNone(
      `SELECT id, name, email, user_type
         FROM tbl_users
        WHERE pwd_reset_token_hash = $1
          AND pwd_reset_used_at IS NULL
          AND pwd_reset_expires_at > NOW()
          AND status = 1
          AND is_deleted = 0
          AND user_type NOT IN (2, 3, 4)`,
      [tokenHash]
    );
  },

  /**
   * One statement, so the password write and the token burn cannot separate.
   * The WHERE clause repeats the liveness conditions, making this a
   * compare-and-set: a token already consumed by a concurrent request updates
   * zero rows, and the caller reports an invalid link instead of resetting
   * twice off one email.
   */
  consumeAdminResetToken: async (id, tokenHash, passwordHash) => {
    const result = await db.result(
      `UPDATE tbl_users
          SET password = $3,
              pwd_changed_at = NOW(),
              pwd_reset_used_at = NOW(),
              pwd_reset_token_hash = NULL,
              pwd_reset_expires_at = NULL,
              pwd_reset_attempts = 0
        WHERE id = $1
          AND pwd_reset_token_hash = $2
          AND pwd_reset_used_at IS NULL
          AND pwd_reset_expires_at > NOW()`,
      [id, tokenHash, passwordHash]
    );
    return result.rowCount;
  }
};

export default adminModel;
