import db from '../config/dbConn.js';

const pushSubscriptionModel = {
  upsert: async ({ user_id, endpoint, p256dh, auth, user_agent }) => {
    return db.any(
      `INSERT INTO tbl_push_subscriptions
         (user_id, endpoint, p256dh, auth, user_agent, last_used_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         p256dh  = EXCLUDED.p256dh,
         auth    = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent,
         last_used_at = NOW()
       RETURNING id`,
      [user_id, endpoint, p256dh, auth, user_agent || null]
    );
  },

  listByUserIds: async (userIds) => {
    if (!userIds || userIds.length === 0) return [];
    return db.any(
      `SELECT id, user_id, endpoint, p256dh, auth
         FROM tbl_push_subscriptions
        WHERE user_id IN ($1:csv)`,
      [userIds]
    );
  },

  deleteByEndpoint: async (endpoint) => {
    return db.result(
      `DELETE FROM tbl_push_subscriptions WHERE endpoint = $1`,
      [endpoint]
    );
  },

  deleteById: async (id) => {
    return db.result(
      `DELETE FROM tbl_push_subscriptions WHERE id = $1`,
      [id]
    );
  },

  existsForUserAndEndpoint: async (user_id, endpoint) => {
    return db.oneOrNone(
      `SELECT id FROM tbl_push_subscriptions
        WHERE user_id = $1 AND endpoint = $2`,
      [user_id, endpoint]
    );
  }
};

export default pushSubscriptionModel;
