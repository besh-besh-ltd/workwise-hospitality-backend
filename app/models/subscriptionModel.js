import pgp from 'pg-promise';
import db from '../config/dbConn.js';
import Config from '../config/app.config.js';

const subscriptionModel = {
  getSubscriptionList: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * ,
         ARRAY 
    (SELECT json_build_object('map_id', tsfpm.id,'feature_name',tsf.title,'feature_id',tsf.id, 'allocated_feature',tsfpm.allocated_feature)
    FROM tbl_subscription_feature_plan_mapping tsfpm, tbl_subscription_feature tsf
    WHERE tsfpm.plan_id = tsp.id
            AND tsfpm.feature_id =tsf.id AND tsf.status = 1 AND tsfpm.status = 1) AS "feature"
    FROM tbl_subscription_plans tsp
    WHERE tsp.status != 2 ORDER BY tsp.price`
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
  getSubscriptionListDropdown: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT tsp.plan_name,tsp.id,tsp.price
    FROM tbl_subscription_plans tsp
    WHERE tsp.status != 2 ORDER BY tsp.price`
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
  getBuyerSubscriptionList: async (today) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * ,
         ARRAY 
    (SELECT json_build_object('map_id', tsfpm.id,'feature_name',tsf.title,'feature_id',tsf.id )
    FROM tbl_subscription_feature_plan_mapping tsfpm, tbl_subscription_feature tsf
    WHERE tsfpm.plan_id = tsp.id
            AND tsfpm.feature_id =tsf.id AND tsf.status = 1 AND tsfpm.status = 1) AS "feature",
    ARRAY 
    (SELECT json_build_object('text',off.text,'price',off.price,'is_percentage',off.is_percentage)
    FROM tbl_subscription_plans_offer_mapping tspom, 
    tbl_offer off
    WHERE tspom.subscription_plan_id = tsp.id
            AND off.id =tspom.offer_id AND tspom.status = 1 AND off.status = 1 AND  
            off.start_date <= $1 AND off.end_date >= $1 ) AS "Offers"        

    FROM tbl_subscription_plans tsp
    WHERE tsp.status = 1 ORDER BY tsp.price`,
        [today]
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
  getBuyerSubscriptionDetails: async (today, sub_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * ,
         ARRAY 
    (SELECT json_build_object('map_id', tsfpm.id,'feature_name',tsf.title,'feature_id',tsf.id )
    FROM tbl_subscription_feature_plan_mapping tsfpm, tbl_subscription_feature tsf
    WHERE tsfpm.plan_id = tsp.id
            AND tsfpm.feature_id =tsf.id AND tsf.status = 1 AND tsfpm.status = 1) AS "feature",
    ARRAY 
    (SELECT json_build_object('text',off.text,'price',off.price,'is_percentage',off.is_percentage)
    FROM tbl_subscription_plans_offer_mapping tspom, 
    tbl_offer off
    WHERE tspom.subscription_plan_id = tsp.id
            AND off.id =tspom.offer_id AND tspom.status = 1 AND off.status = 1 AND  
            off.start_date <= $1 AND off.end_date >= $1 ) AS "Offers"        

    FROM tbl_subscription_plans tsp
    WHERE tsp.status = 1 AND tsp.id = $2`,
        [today, sub_id]
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
  createSubscription: async (subscriptionObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(subscriptionObj, null, 'tbl_subscription_plans') +
        ' RETURNING id';

      db.one(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  createFeaturePlanMapping: async (featurePlanObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(
          featurePlanObj,
          null,
          'tbl_subscription_feature_plan_mapping'
        ) + ' RETURNING id';

      db.one(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  featureIdExist: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_subscription_feature WHERE id = $1 AND status = 1',
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
  checkFreeSubscription: async (planId) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = ``;
      if (planId) {
        dynamicQuery = `AND id !=${planId}`;
      }
      db.any(
        `SELECT * FROM tbl_subscription_plans WHERE plan_type = 'f' AND status = 1 ${dynamicQuery}`
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
  subscriptionIdExist: async (subscriptionId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_subscription_plans WHERE id = $1 AND status != 2',
        [subscriptionId]
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
  subscriptionOfferExist: async (subscriptionId, offerId) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = ``;
      if (offerId) {
        dynamicQuery = `AND offer_id != ${offerId}`;
      }
      db.any(
        `SELECT * FROM tbl_subscription_plans_offer_mapping WHERE 
        subscription_plan_id = $1 AND status = 1 ${dynamicQuery}`,
        [subscriptionId]
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
  buyerSubscriptionIdExist: async (subscriptionId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_subscription_plans WHERE id = $1 AND status = 1',
        [subscriptionId]
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
  buyerSubscriptionIdCheck: async (userId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_user_subscriptions WHERE user_id = $1 AND status = 1',
        [userId]
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
  getSubscriptionFeatureList: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT *
    FROM tbl_subscription_feature tsf
    WHERE tsf.status = 1`
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
  getSubscriptionDetails: async (subscriptionId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * ,
         ARRAY 
    (SELECT json_build_object('map_id', tsfpm.id,'feature_name',tsf.title,'feature_id',tsf.id,'allocated_feature',tsfpm.allocated_feature )
    FROM tbl_subscription_feature_plan_mapping tsfpm, tbl_subscription_feature tsf
    WHERE tsfpm.plan_id = tsp.id
            AND tsfpm.feature_id =tsf.id AND tsf.status = 1 AND tsfpm.status = 1) AS "feature"
    FROM tbl_subscription_plans tsp
    WHERE tsp.id = $1`,
        [subscriptionId]
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
  getSubscriptionMappingDetails: async (planId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_subscription_feature_plan_mapping WHERE plan_id = $1 AND status = 1`,
        [planId]
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
  updateSubscription: async (subscriptionObj, subscriptionId) => {
    Object.entries(subscriptionObj).forEach((ele) => {
      db.any(
        `UPDATE tbl_subscription_plans SET ${ele[0]} = $1 WHERE id = $2`,
        [ele[1], subscriptionId],
        (err) => {
          if (err) {
            console.log(`Error query---------->`);
            reject(err);
          } else {
            // console.log(`Comapny with id ${user_id} updated.`);
            resolve();
          }
        }
      );
    });
    /* return new Promise(function (resolve, reject) {
      db.query('UPDATE tbl_subscription_plans SET ? WHERE id = ?', [
        subscriptionObj,
        subscriptionId
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    }); */
  },
  deleteFeaturePlanMapping: async (subscriptionId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'UPDATE tbl_subscription_feature_plan_mapping SET status = 2 WHERE plan_id = $1',
        [subscriptionId]
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
  deleteSubscription: async (subscriptionId, userId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'UPDATE tbl_subscription_plans SET status = 2,updated_by = $2 WHERE id = $1',
        [subscriptionId, userId]
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
  createUserSubscription: async (UserSubscriptionObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(
          UserSubscriptionObj,
          null,
          'tbl_user_subscriptions'
        ) + ' RETURNING id';

      db.one(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  createUserSubscriptionFeature: async (userSubscriptionFeatureObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(
          userSubscriptionFeatureObj,
          null,
          'tbl_user_subscription_feature'
        ) + ' RETURNING id';

      db.one(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  createSubscriptionPayment: async (subscriptionPaymentObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(
          subscriptionPaymentObj,
          null,
          'tbl_subscriptions_payment'
        ) + ' RETURNING id';

      db.one(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  updateSubscriptionPayment: async (subscriptionPaymentObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `UPDATE tbl_subscriptions_payment SET status = $1, date= $2, after_payment_response= $3, payment_id= $4, method= $5
        WHERE receipt = $6 AND order_id = $7 AND status = 0 RETURNING id, user_subscriptions_id,user_id,amount,
        subscription_charge,	offer_price,	coupon_price`,
        [
          subscriptionPaymentObj.status,
          subscriptionPaymentObj.date,
          subscriptionPaymentObj.after_payment_response,
          subscriptionPaymentObj.payment_id,
          subscriptionPaymentObj.method,
          subscriptionPaymentObj.receipt,
          subscriptionPaymentObj.order_id
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
  updateUserSubscription: async (user_subscriptions_id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `UPDATE tbl_user_subscriptions SET status = 1
        WHERE user_id = $1 AND id = $2 RETURNING id,plan_id,start_date,end_date `,
        [user_id, user_subscriptions_id]
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
  updateUserSubscriptionId: async (subscriptions_id, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `UPDATE tbl_users SET subscription_plan_id = $1
        WHERE id = $2  RETURNING id `,
        [subscriptions_id, user_id]
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
  getOfferDetails: async (offerId, today) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_offer WHERE id = $1 AND status = 1 AND 
      start_date <= $2 AND end_date >= $2 ORDER BY end_date`,
        [offerId, today]
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
  getSubscribersList: async (
    limit,
    offset,
    subscriptionId,
    search,
    userType,
    verificationStatus,
    expire
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = ``;
      let dynamicSelect = `FROM tbl_user_subscriptions tus`;
      let dynamicStatus = 1;
      if (subscriptionId) {
        dynamicQuery += ` AND tus.plan_id = ${subscriptionId}`;
      }
      if (search) {
        dynamicQuery += ` AND (users.name ILIKE '%${search}%' OR users.email ILIKE '%${search}%')`;
      }
      if (userType) {
        dynamicQuery += ` AND users.user_type = ${userType}`;
      }
      if (verificationStatus) {
        dynamicQuery += ` AND users.status = ${verificationStatus}`;
      }
      if (expire == 'true') {
        dynamicStatus = 3;
        dynamicQuery += `AND tus.rn = 1`;
        dynamicSelect = `FROM (
          SELECT *,
                 ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY end_date DESC) as rn
          FROM tbl_user_subscriptions
          WHERE status = 3
      ) AS tus`;
      }
      db.any(
        `SELECT tus.*,users.name,users.email,users.mobile,tsp.plan_name,users.user_type,
        users.status user_status,
        CASE
        WHEN tspay.invoice_file IS NULL THEN
        NULL
        ELSE tspay.invoice_file
        END AS invoice_file
         ${dynamicSelect} 
         LEFT JOIN tbl_users users  on tus.user_id = users.id
         LEFT JOIN tbl_subscription_plans tsp ON tus.plan_id = tsp.id
         LEFT JOIN tbl_subscriptions_payment tspay ON tus.id = tspay.user_subscriptions_id
         WHERE tus.status = ${dynamicStatus} ${dynamicQuery} 
         ORDER BY tus.created_at DESC LIMIT ${limit} OFFSET $1`,
        [offset]
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
  getSubscribersCount: async (
    subscriptionId,
    search,
    userType,
    verificationStatus,
    expire
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = ``;
      let dynamicSelect = `FROM tbl_user_subscriptions tus`;
      let dynamicStatus = 1;
      if (subscriptionId) {
        dynamicQuery = ` AND tus.plan_id = ${subscriptionId}`;
      }
      if (search) {
        dynamicQuery += ` AND (users.name ILIKE '%${search}%' OR users.email ILIKE '%${search}%')`;
      }
      if (userType) {
        dynamicQuery += ` AND users.user_type = ${userType}`;
      }
      if (verificationStatus) {
        dynamicQuery += ` AND users.status = ${verificationStatus}`;
      }
      if (expire == 'true') {
        dynamicStatus = 3;
        dynamicQuery += `AND tus.rn = 1`;
        dynamicSelect = `FROM (
          SELECT *,
                 ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY end_date DESC) as rn
          FROM tbl_user_subscriptions
          WHERE status = 3
      ) AS tus`;
      }
      db.one(
        `SELECT count(tus.id)
         ${dynamicSelect}
         LEFT JOIN tbl_users users  on tus.user_id = users.id
         WHERE tus.status = ${dynamicStatus} ${dynamicQuery}`
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
  checkBuyerSubscription: async (id, user_id, plan_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_user_subscriptions WHERE user_id = $1 AND id= $2 AND plan_id = $3 AND status = 1',
        [user_id, id, plan_id]
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
  updateBuyerSubscription: async (userSubscriptionsObj, id) => {
    return new Promise(function (resolve, reject) {
      const condition = `WHERE id = $1 RETURNING id`;
      const values = [id];
      let query =
        pgp().helpers.update(
          userSubscriptionsObj,
          null,
          'tbl_user_subscriptions'
        ) + condition;

      db.one(query, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getPaymentList: async (
    limit,
    offset,
    start_date,
    end_date,
    payment_status,
    search
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = ``;
      if (search) {
        dynamicQuery += ` AND (users.name ILIKE '%${search}%' OR users.email ILIKE '%${search}%')`;
      }
      if (start_date) {
        dynamicQuery += ` AND tsp.date <= '${start_date}'`;
      }
      if (end_date) {
        dynamicQuery += ` AND tsp.date >= '${end_date}'`;
      }
      if (payment_status) {
        dynamicQuery += ` AND tsp.status = ${payment_status}`;
      }
      db.any(
        `SELECT tsp.*,users.name,users.email,users.mobile,users.user_type,users.status user_status,
        users.is_deleted ,
        CASE
        WHEN tsp.invoice_file IS NULL THEN
        NULL
        ELSE tsp.invoice_file
        END AS invoice_file
         FROM tbl_subscriptions_payment tsp
        LEFT JOIN tbl_users users ON tsp.user_id = users.id
        WHERE tsp.id IS NOT NULL ${dynamicQuery}
         ORDER BY tsp.id DESC LIMIT ${limit} OFFSET $1`,
        [offset]
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
  paymentListCount: async (start_date, end_date, payment_status, search) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = ``;
      if (search) {
        dynamicQuery += ` AND (users.name ILIKE '%${search}%' OR users.email ILIKE '%${search}%')`;
      }
      if (start_date) {
        dynamicQuery += ` AND tsp.date <= '${start_date}'`;
      }
      if (end_date) {
        dynamicQuery += ` AND tsp.date >= '${end_date}'`;
      }
      if (payment_status) {
        dynamicQuery += ` AND tsp.status = ${payment_status}`;
      }
      db.one(
        `SELECT count(tsp.id)
         FROM tbl_subscriptions_payment tsp
        LEFT JOIN tbl_users users ON tsp.user_id = users.id
        WHERE tsp.id IS NOT NULL ${dynamicQuery}`
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
  updateInvoice: async (invoicePath, id) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE tbl_subscriptions_payment SET invoice_file = $1 WHERE id = $2 RETURNING id`,
        [invoicePath, id]
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
  getSubscriberDetails: async (buyerId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT tus.*,users.name,users.email,users.mobile,tsp.plan_name,users.user_type,
        users.status user_status,
        CASE
        WHEN tspay.invoice_file IS NULL THEN
        NULL
        ELSE tspay.invoice_file
        END AS invoice_file FROM  (
          SELECT *,
                 ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY end_date DESC) as rn
          FROM tbl_user_subscriptions
          WHERE status IN (3,1) AND user_id = $1
      ) AS tus 
      LEFT JOIN tbl_users users  on tus.user_id = users.id
      LEFT JOIN tbl_subscription_plans tsp ON tus.plan_id = tsp.id
      LEFT JOIN tbl_subscriptions_payment tspay ON tus.id = tspay.user_subscriptions_id
      WHERE tus.status IN (3,1) AND tus.user_id = $1 AND tus.rn = 1`,
        [buyerId]
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

export default subscriptionModel;
