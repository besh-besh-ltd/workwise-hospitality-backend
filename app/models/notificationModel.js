import db, { pgp } from '../config/dbConn.js';
import Config from '../config/app.config.js';

const notificationModel = {
  createNotification: async (usrobj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_notifications(sender_user_id, type, title, message, additional_data) 
        values($1, $2,$3,$4,$5) returning id`,
        [
          usrobj.sender_user_id,

          usrobj.type,
          usrobj.title,
          usrobj.message,
          usrobj.additional_data
        ]
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
  createNotification: async (usrobj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_notifications(sender_user_id, type, title, message, additional_data) 
        values($1, $2,$3,$4,$5) returning id`,
        [
          usrobj.sender_user_id,

          usrobj.type,
          usrobj.title,
          usrobj.message,
          usrobj.additional_data
        ]
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
  addVendorReview: async (reviewObj) => {
    return new Promise((resolve, reject) => {
        db.any(
            `INSERT INTO tbl_vendor_reviews(
                reviewed_by, 
                reviewed_to, 
                rating, 
                description, 
                quality_of_work, 
                on_time_delivery, 
                trustworthiness_reliability, 
                overall_rating
            ) VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
                reviewObj.reviewed_by,
                reviewObj.reviewed_to,
                reviewObj.rating, 
                reviewObj.description,
                reviewObj.quality_of_work,
                reviewObj.on_time_delivery,
                reviewObj.trustworthiness_reliability,
                reviewObj.overall_rating
            ]
        )
        .then(data => resolve(data))
        .catch(err => reject(new Error(err)));
    });
},
  updateVendorReview: async (reviewObj, review_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_vendor_reviews set 
				rating = ${reviewObj.rating},
        quality_of_work = ${reviewObj.quality_of_work}, 
        on_time_delivery = ${reviewObj.on_time_delivery}, 
        trustworthiness_reliability = ${reviewObj.trustworthiness_reliability}, 
        overall_rating = ${reviewObj.overall_rating},
				description = '${reviewObj.description}'
       	where id=($2)`,
        [reviewObj, review_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  getNotificationList: async (user_id, limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'select * from tbl_notifications where sender_user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [user_id, limit, offset]
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
  // Ownership predicate for tbl_notifications.
  //
  // The table carries ownership in two columns for historical reasons:
  //   - Legacy rows (1,718 in production) populate ONLY `sender_user_id`, and
  //     despite the name it holds the RECIPIENT (e.g. "RFQ Pending" reminders
  //     are written with sender_user_id = the buyer being reminded). The
  //     notification LISTING has always keyed off this column.
  //   - ARC-era rows (671) populate `recipient_user_id` (createForRecipient);
  //     when both are set, `sender_user_id` is the genuine sender and only the
  //     recipient may read the row.
  //
  // COALESCE(recipient_user_id, sender_user_id) therefore resolves to the one
  // user who owns the notification under both shapes.
  //
  // SECURITY: `user_id` is REQUIRED and must come from req.user — never from
  // the request. Ids in this table are sequential (40..2429 in production), so
  // without the owner predicate any authenticated user (vendors included)
  // could enumerate every tenant's notifications.
  notificationDetail: async (notification_id, user_id) => {
    if (!user_id) {
      throw new Error('notificationDetail: user_id is required');
    }
    return db.any(
      `select * from tbl_notifications
        where id = $1
          and COALESCE(recipient_user_id, sender_user_id) = $2`,
      [notification_id, user_id]
    );
  },
  checkReviewExists: async (user_id, reviewed_to) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'select * from tbl_vendor_reviews where reviewed_by = $1 AND reviewed_to = $2',
        [user_id, reviewed_to]
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
  // SECURITY: same owner predicate as notificationDetail — the write side had
  // the identical IDOR (any id could be flipped to read by anyone).
  // Returns the affected rowCount so the controller can 404 on a miss.
  statusUpdateNotification: async (notification_id, user_id) => {
    if (!user_id) {
      throw new Error('statusUpdateNotification: user_id is required');
    }
    const result = await db.result(
      `update tbl_notifications
          set is_read = 1,
              is_read_at = NOW()
        where id = $1
          and COALESCE(recipient_user_id, sender_user_id) = $2`,
      [notification_id, user_id]
    );
    return result.rowCount;
  },

  createForRecipient: async ({
    sender_user_id,
    recipient_user_id,
    category,
    type,
    title,
    message,
    additional_data,
    action_url
  }) => {
    return db.one(
      `INSERT INTO tbl_notifications
         (sender_user_id, recipient_user_id, type, title, message,
          additional_data, category, action_url, is_read)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)
       RETURNING id, recipient_user_id, type, title, message,
                 additional_data, category, action_url, is_read, created_at`,
      [
        sender_user_id || null,
        recipient_user_id,
        type || null,
        title,
        message,
        additional_data ? JSON.stringify(additional_data) : null,
        category || null,
        action_url || null
      ]
    );
  },

  // The bell endpoints below all resolve ownership with the same
  // COALESCE(recipient_user_id, sender_user_id) predicate documented above
  // notificationDetail. They used to filter on `recipient_user_id` alone, which
  // silently hid every legacy row from the bell while the older
  // /notification-list endpoint still returned it — one user, two different
  // inboxes. Sharing the predicate collapses them back into one.

  // Dismissed rows are excluded everywhere the inbox is read or counted — a
  // dismissed notification that still drove the badge would be indistinguishable
  // from a bug.
  getByRecipient: async (recipient_user_id, limit, offset, { category = null, unreadOnly = false } = {}) => {
    return db.any(
      `SELECT id, sender_user_id, recipient_user_id, type, title, message,
              additional_data, category, action_url, is_read, created_at,
              delivered_at
         FROM tbl_notifications
        WHERE COALESCE(recipient_user_id, sender_user_id) = $1
          AND dismissed_at IS NULL
          ${category ? 'AND LOWER(category) = LOWER($4)' : ''}
          ${unreadOnly ? 'AND (is_read = 0 OR is_read IS NULL)' : ''}
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      category
        ? [recipient_user_id, limit, offset, category]
        : [recipient_user_id, limit, offset]
    );
  },

  // One round trip for both counters the bell needs:
  //   undelivered → the badge ("new since you last looked")
  //   unread      → how many rows still render highlighted
  getCounts: async (recipient_user_id) => {
    const row = await db.oneOrNone(
      `SELECT COUNT(*) FILTER (WHERE delivered_at IS NULL)::int        AS undelivered,
              COUNT(*) FILTER (WHERE is_read = 0 OR is_read IS NULL)::int AS unread,
              COUNT(*)::int                                              AS total
         FROM tbl_notifications
        WHERE COALESCE(recipient_user_id, sender_user_id) = $1
          AND dismissed_at IS NULL`,
      [recipient_user_id]
    );
    return {
      undelivered: row ? row.undelivered : 0,
      unread: row ? row.unread : 0,
      total: row ? row.total : 0
    };
  },

  // Per-category unread tallies, so the inbox can offer a filter that states
  // what is actually in it rather than a fixed list of tabs.
  getCategoryCounts: async (recipient_user_id) => {
    const rows = await db.any(
      `SELECT COALESCE(LOWER(category), 'other') AS category,
              COUNT(*)::int                                              AS total,
              COUNT(*) FILTER (WHERE is_read = 0 OR is_read IS NULL)::int AS unread
         FROM tbl_notifications
        WHERE COALESCE(recipient_user_id, sender_user_id) = $1
          AND dismissed_at IS NULL
        GROUP BY 1
        ORDER BY 1`,
      [recipient_user_id]
    );
    return rows;
  },

  // Soft delete. These rows are the only record that a given approver was asked
  // to act, so tidying the list must not destroy the audit trail.
  dismiss: async (notification_id, recipient_user_id) => {
    return db.result(
      `UPDATE tbl_notifications
          SET dismissed_at = NOW(),
              delivered_at = COALESCE(delivered_at, NOW())
        WHERE id = $1
          AND COALESCE(recipient_user_id, sender_user_id) = $2
          AND dismissed_at IS NULL`,
      [notification_id, recipient_user_id]
    );
  },

  // Undo for a misclick. Delivery is deliberately NOT reset: the user has
  // demonstrably seen the row, so resurrecting the badge would be a lie.
  markUnread: async (notification_id, recipient_user_id) => {
    return db.result(
      `UPDATE tbl_notifications
          SET is_read = 0, is_read_at = NULL
        WHERE id = $1
          AND COALESCE(recipient_user_id, sender_user_id) = $2
          AND dismissed_at IS NULL`,
      [notification_id, recipient_user_id]
    );
  },

  getUnreadCount: async (recipient_user_id) => {
    const row = await db.oneOrNone(
      `SELECT COUNT(*)::int AS count
         FROM tbl_notifications
        WHERE COALESCE(recipient_user_id, sender_user_id) = $1
          AND dismissed_at IS NULL
          AND (is_read = 0 OR is_read IS NULL)`,
      [recipient_user_id]
    );
    return row ? row.count : 0;
  },

  // Opening the bell delivers everything outstanding, not just the page on
  // screen — otherwise the badge would still show a residue the user has no
  // obvious way to clear. `notification_ids` narrows it when a caller wants to
  // deliver an explicit subset.
  markDelivered: async (recipient_user_id, notification_ids = null) => {
    const ids = Array.isArray(notification_ids)
      ? notification_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : null;

    if (ids && ids.length === 0) return 0;

    const result = await db.result(
      `UPDATE tbl_notifications
          SET delivered_at = NOW()
        WHERE COALESCE(recipient_user_id, sender_user_id) = $1
          AND dismissed_at IS NULL
          AND delivered_at IS NULL
          ${ids ? 'AND id IN ($2:csv)' : ''}`,
      ids ? [recipient_user_id, ids] : [recipient_user_id]
    );
    return result.rowCount;
  },

  // Reading implies delivery — a row can never be read but undelivered, and
  // leaving delivered_at NULL here would keep the badge lit for something the
  // user just opened.
  markRead: async (notification_id, recipient_user_id) => {
    return db.result(
      `UPDATE tbl_notifications
          SET is_read = 1,
              is_read_at = NOW(),
              delivered_at = COALESCE(delivered_at, NOW())
        WHERE id = $1
          AND COALESCE(recipient_user_id, sender_user_id) = $2`,
      [notification_id, recipient_user_id]
    );
  },

  markAllRead: async (recipient_user_id) => {
    return db.result(
      `UPDATE tbl_notifications
          SET is_read = 1,
              is_read_at = NOW(),
              delivered_at = COALESCE(delivered_at, NOW())
        WHERE COALESCE(recipient_user_id, sender_user_id) = $1
          AND dismissed_at IS NULL
          AND (is_read = 0 OR is_read IS NULL)`,
      [recipient_user_id]
    );
  },

  user_email_exist: async (email) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_users where email = $1', [email])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  user_mobile_exist: async (mobile) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_users where mobile = $1', [mobile])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  getUserAuthEmail: async (email) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_users where email = $1', [email])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getVendorApproveDetail: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'select * from tbl_vendorapprove_user_mapping where user_id = $1',
        [user_id]
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
  deleteVendorApproveDetail: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any('DELETE from tbl_vendorapprove_user_mapping where user_id = $1', [
        user_id
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  user_profile_detail: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_users where id = $1', [user_id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  user_profile_social_login: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.one(
        'select id,name,email,user_type,social_login_id, social_login_type, social_login_profile_image from tbl_users where id = $1',
        [user_id]
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
  user_profile_login_detail: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any('select name,status,user_type from tbl_users where id = $1', [
        user_id
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getAdminNotificationList: async (
    limit,
    offset,
    name,
    status,
    notification_type
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (name) {
        dynamicQuery += `AND title  ILIKE '%${name}%'`;
      }

      if (status == '1') {
        dynamicQuery += ` AND status = 1 `;
      } else if (status == '0') {
        dynamicQuery += ` AND status = 0 `;
      }
      if (notification_type == '1') {
        dynamicQuery += ` AND notification_type = '1' `;
      } else if (status == '2') {
        dynamicQuery += ` AND notification_type = '2' `;
      }
      db.any(
        `SELECT * FROM tbl_notification_setting WHERE is_deleted = 0  ${dynamicQuery}
        ORDER BY id DESC LIMIT $1 OFFSET $2`,
        [limit, offset, name, status, notification_type]
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
  getAdminNotificationCount: async (name, status, notification_type) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (name) {
        dynamicQuery += `AND title  ILIKE '%${name}%'`;
      }

      if (status == '1') {
        dynamicQuery += `AND status = 1 `;
      } else if (status == '0') {
        dynamicQuery += `AND status = 0 `;
      }
      if (notification_type == '1') {
        dynamicQuery += `AND notification_type = 1 `;
      } else if (status == '2') {
        dynamicQuery += `AND notification_type = 2 `;
      }
      db.any(
        `SELECT * FROM tbl_notification_setting WHERE is_deleted = 0  ${dynamicQuery}`,
        [name, status, notification_type]
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
  addNotificationSetting: async (notificationObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_notification_setting(title, notification_type, status, content, send_to, created_by,name) 
        values($1, $2,$3,$4, $5, $6, $7) returning id`,
        [
          notificationObj.title,
          notificationObj.notification_type,
          notificationObj.status,
          notificationObj.content,
          notificationObj.send_to,
          notificationObj.createdBy,
          notificationObj.name
        ]
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
  notificationIDExist: async (notificationId) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_notification_setting WHERE id = $1', [
        notificationId
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  notificationNameExists: async (notificationName) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_notification_setting WHERE name = $1 AND is_deleted = 0',
        [notificationName]
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
  otherNotificationNameExists: async (notificationName, notificationId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_notification_setting WHERE name = $1 AND is_deleted = 0 AND id != $2',
        [notificationName, notificationId]
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

  getNotificationDetails: async (notificationId) => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_notification_setting WHERE id = $1`, [
        notificationId
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  updateNotification: async (notificationId, notificationObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_notification_setting set 
				title = '${notificationObj.title}',
				notification_type = '${notificationObj.notification_type}',
				status = '${notificationObj.status}',
				content = '${notificationObj.content}',
				send_to = '${notificationObj.send_to}',
        name = '${notificationObj.name}'
       	where id=($1)`,
        [notificationId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  deleteNotification: async (notificationId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `UPDATE 
        tbl_notification_setting set 
				is_deleted = '1'
       	WHERE id=($1)`,
        [notificationId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  findDynamicNotification: async (name) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_notification_setting WHERE name = $1 AND status = 1 AND is_deleted = 0`,
        [name]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  }
};

export default notificationModel;
