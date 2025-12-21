import db from '../config/dbConn.js';
import Config from '../config/app.config.js';

const buyerModel = {
  getBuyerList: async (limit, offset, organization, verified, name, user_type) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (name) {
        dynamicQuery += `AND name  ILIKE '%${name}%'`;
      }

      if (organization) {
        dynamicQuery += `AND organization_name  ILIKE '%${organization}%'`;
      }
      if (verified == 't') {
        dynamicQuery += `AND status = 1 `;
      } else if (verified == 'f') {
        dynamicQuery += `AND status = 0 `;
      }
      
      if (user_type) {
        dynamicQuery += `AND user_type = ${user_type} `;
      }
      
      db.any(
        `SELECT u.*, tc.company_name as company_name
        FROM tbl_users u
        LEFT JOIN tbl_company tc ON u.company_id = tc.id
        WHERE (u.user_type = 2 OR u.user_type = 7 OR u.user_type = 8 OR u.user_type = 9 OR u.user_type = 10) 
        AND u.is_deleted = 0 ${dynamicQuery}
        ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
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
  getBuyerListCount: async (organization, verified, name, user_type) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (name) {
        dynamicQuery += `AND name  ILIKE '%${name}%'`;
      }
      if (organization) {
        dynamicQuery += `AND organization_name  ILIKE '%${organization}%'`;
      }
      if (verified == 't') {
        dynamicQuery += `AND status = 1 `;
      } else if (verified == 'f') {
        dynamicQuery += `AND status = 0 `;
      }
      
      if (user_type) {
        dynamicQuery += `AND user_type = ${user_type} `;
      }
      
      db.one(
        `SELECT count(id) 
        FROM tbl_users 
        WHERE is_deleted = 0 
        AND (user_type = 2 OR user_type = 7 OR user_type = 8 OR user_type = 9 OR user_type = 10) ${dynamicQuery}`
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
  buyerIdExist: async (buyerId) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_users WHERE id = $1 AND (user_type = 2 OR user_type = 7 OR user_type = 8 OR user_type = 9 OR user_type = 10)', [
        buyerId
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
  getBuyerDetails: async (buyerId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT tbl_users.*,tbl_company.profile,tbl_company.nature_of_business,tbl_company.company_name,
        NULL AS profile_image  FROM tbl_users left join tbl_company ON tbl_users.company_id = tbl_company.id  WHERE tbl_users.is_deleted = 0 AND (tbl_users.user_type = 2 OR tbl_users.user_type = 7 OR tbl_users.user_type = 8 OR tbl_users.user_type = 9 OR tbl_users.user_type = 10) AND tbl_users.id = $1`,
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
  },
  blockBuyer: async (buyerId, updated_by, status) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE 
        tbl_users SET 
        status = $3,
        updated_by = ($1) 
	    WHERE id=($2) RETURNING id`,
        [updated_by, buyerId, status]
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
  otherBuyerEmailExist: async (email, buyerId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_users WHERE email = $1 AND is_deleted = 0 AND id != $2',
        [email, buyerId]
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
  otherBuyerMobileExist: async (mobile, buyerId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_users WHERE mobile = $1 AND is_deleted = 0 AND id != $2',
        [mobile, buyerId]
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

  updateBuyer: async (buyerId, buyerObj) => {
    return new Promise(function (resolve, reject) {
      let dynamicUpdate = ``;
      if (buyerObj.originalFilename) {
        dynamicUpdate = `,original_profile_image = '${buyerObj.originalFilename}'`;
      }
      db.one(
        `UPDATE 
        tbl_users SET
        updated_by = $1,
        name = $3,
        email = $4 ,
        mobile = $5,
        organization_name = $6,
        address = $7
        ${dynamicUpdate}
	      WHERE id= $2 RETURNING id`,
        [
          buyerObj.updatedBy,
          buyerId,
          buyerObj.name,
          buyerObj.email,
          buyerObj.mobile,
          buyerObj.organization_name,
          buyerObj.address
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
  approveBuyer: async (buyerId, updatedBy, status) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE 
        tbl_users SET 
        status = $3,
        updated_by = ($1) 
	    WHERE id=($2) RETURNING id`,
        [updatedBy, buyerId, status]
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
  deleteBuyer: async (buyerId, updated_by) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE 
        tbl_users SET 
        is_deleted = 1,
        updated_by = ($1) 
	    WHERE id=($2) RETURNING id`,
        [updated_by, buyerId]
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

export default buyerModel;
