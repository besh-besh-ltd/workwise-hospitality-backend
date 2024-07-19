import pgp from 'pg-promise';
import db from '../config/dbConn.js';

const couponModel = {
  couponExists: async (coupon, user) => {
    return new Promise(function (resolve, reject) {
      let whereCondition = '';
      if (user) {
        whereCondition = `AND status = 1`;
      }
      db.any(
        `SELECT * FROM tbl_coupon WHERE coupon = $1 AND status != 2 ${whereCondition}`,
        [coupon]
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
  couponIdExists: async (coupon_id) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_coupon WHERE id = $1', [coupon_id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  checkCouponCodeExists: async (coupon_code, today) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_coupon WHERE coupon = $1 AND status = 1 AND 
      start_date <= $2 AND end_date >= $2`,
        [coupon_code, today]
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
  couponExistsWithId: async (coupon_id, coupon) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_coupon WHERE coupon = $1 AND id != $2', [
        coupon,
        coupon_id
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
  addCoupon: async (couponObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(couponObj, null, 'tbl_coupon') + ' RETURNING id';

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
  updateCoupon: async (
    coupon,
    is_percentage,
    discount_amount,
    start_date,
    end_date,
    status,
    coupon_id,
    updated_by
  ) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE 
				tbl_coupon SET 
				coupon = ($1), 
        is_percentage = ($2),
        discount_amount = ($3),
        start_date = ($4),
        end_date = ($5),
        status = ($6),
        updated_by = ($8)
       	WHERE id=($7) returning id`,
        [
          coupon,
          is_percentage,
          discount_amount,
          start_date,
          end_date,
          status,
          coupon_id,
          updated_by
        ]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  getAllCoupon: async (limit, offset, coupon) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = ``;
      if (coupon) {
        dynamicQuery += `AND coupon ILIKE '%${coupon}%'`;
      }
      db.any(
        `SELECT * 
          FROM tbl_coupon WHERE status !=2 ${dynamicQuery}
          ORDER BY created_at DESC LIMIT $2 OFFSET $1`,
        [offset, limit]
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
  getAllCouponCount: async (coupon) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = ``;
      if (coupon) {
        dynamicQuery += `AND coupon ILIKE '%${coupon}%'`;
      }
      db.one(
        `SELECT COUNT(id) FROM tbl_coupon WHERE status !=2 ${dynamicQuery}`
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
  deleteCoupon: async (coupon_id, updated_by) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `UPDATE 
				tbl_coupon SET 
        status = 2,
        updated_by = ($2)
       	WHERE id=($1)`,
        [coupon_id, updated_by]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  addOffer: async (offerObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(offerObj, null, 'tbl_offer') + ' RETURNING id';

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
  addSubscriptionPlansOffer: async (subscriptionPlansOfferObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(
          subscriptionPlansOfferObj,
          null,
          'tbl_subscription_plans_offer_mapping'
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
  offerExists: async (offerText, user) => {
    return new Promise(function (resolve, reject) {
      let whereCondition = '';
      if (user) {
        whereCondition = `AND status = 1`;
      }
      db.any(
        `SELECT * FROM tbl_offer WHERE text = $1 AND status != 2 ${whereCondition}`,
        [offerText]
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
  sameOfferExists: async (offerText, offerId, user) => {
    return new Promise(function (resolve, reject) {
      let whereCondition = '';
      if (user) {
        whereCondition = `AND status = 1`;
      }
      db.any(
        `SELECT * FROM tbl_offer WHERE text = $1 AND id != $2 AND status != 2 ${whereCondition}`,
        [offerText, offerId]
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
  offerList: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT off.*,
        ARRAY 
        (SELECT json_build_object('map_id', tspom.id,'subscription_plan_id',tspom.subscription_plan_id,
        'subscription_plan_status',tsp.status,'subscription_plan_name',tsp.plan_name)
        FROM tbl_subscription_plans_offer_mapping tspom ,
        tbl_subscription_plans tsp
        WHERE off.id = tspom.offer_id
        AND tspom.subscription_plan_id = tsp.id AND tspom.status = 1 AND tsp.status != 2) AS "subscription_plan"
        FROM tbl_offer off WHERE status !=2`
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
  offerIdExists: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_offer WHERE id = $1 AND status != 2', [id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  updateOffer: async (offerObj, offerId) => {
    return new Promise(function (resolve, reject) {
      const condition = `WHERE id = $1 RETURNING id`;
      const values = [offerId];
      let query = pgp().helpers.update(offerObj, null, 'tbl_offer') + condition;

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
  updateSubscriptionPlansOfferMappingInactive: async (
    offerId,
    subscription_plan_id
  ) => {
    return new Promise(function (resolve, reject) {
      let subCondition = '';
      if (subscription_plan_id) {
        subCondition = `AND subscription_plan_id NOT IN (${subscription_plan_id})`;
      }
      db.any(
        `UPDATE tbl_subscription_plans_offer_mapping SET status= 0
       WHERE offer_id = $1 ${subCondition}`,
        [offerId]
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
  checkSubscriptionPlansOfferMapping: async (mapDetails) => {
    return new Promise(function (resolve, reject) {
      db.any(
        ` SELECT *
        FROM tbl_subscription_plans_offer_mapping
        WHERE offer_id= $1
        AND subscription_plan_id = $2`,
        mapDetails
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
  updateSubscriptionPlansOfferMappingActive: async (
    offerId,
    subscription_plan_id
  ) => {
    return new Promise(function (resolve, reject) {
      db.any(
        ` UPDATE tbl_subscription_plans_offer_mapping SET status= 1
       WHERE offer_id = $1 AND subscription_plan_id = $2  `,
        [offerId, subscription_plan_id]
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
  offerDetails: async (offerId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT off.*,
        ARRAY 
        (SELECT json_build_object('map_id', tspom.id,'subscription_plan_id',tspom.subscription_plan_id,
        'subscription_plan_status',tsp.status,'subscription_plan_name',tsp.plan_name)
        FROM tbl_subscription_plans_offer_mapping tspom ,
        tbl_subscription_plans tsp
        WHERE off.id = tspom.offer_id
        AND tspom.subscription_plan_id = tsp.id AND tspom.status = 1 AND tsp.status != 2) AS "subscription_plan"
        FROM tbl_offer off WHERE status !=2 AND off.id = $1`,
        [offerId]
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
  deleteOffer: async (offerObj, offerId) => {
    return new Promise(function (resolve, reject) {
      const condition = `WHERE id = $1 RETURNING id`;
      const values = [offerId];
      let query = pgp().helpers.update(offerObj, null, 'tbl_offer') + condition;

      db.one(query, values)
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

export default couponModel;
