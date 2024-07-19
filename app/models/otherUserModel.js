import db from '../config/dbConn.js';
import Config from '../config/app.config.js';

const otherUserModel = {
  getOtherUserList: async (limit, offset, organization, verified, name) => {
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
      db.any(
        `SELECT tbl_users.*,trr.reject_reason,
        CASE
        WHEN new_profile_image IS NULL THEN
        NULL
        ELSE new_profile_image
        END AS profile_image  
        FROM tbl_users
        LEFT JOIN tbl_reject_reason trr ON  tbl_users.reject_reason_id = trr.id
        WHERE is_deleted = 0 AND user_type = 4 ${dynamicQuery}
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
  getOtherUserCount: async (organization, verified, name) => {
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
      db.one(
        `SELECT count(id) from tbl_users WHERE is_deleted = 0 AND user_type = 4 ${dynamicQuery}`
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
  otherUserIdExist: async (buyerId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_users WHERE id = $1 AND is_deleted = 0 AND user_type = 4',
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
  getOtherUserDetails: async (buyerId) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `SELECT tbl_users.*,
        CASE
        WHEN new_profile_image IS NULL THEN
        NULL
        ELSE new_profile_image
        END AS profile_image  FROM tbl_users WHERE is_deleted = 0 AND user_type = 4 AND id = $1`,
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
  blockOtherUser: async (otherUserId, updated_by, status) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE 
        tbl_users SET 
        status = $3,
        updated_by = ($1) 
	    WHERE id=($2) RETURNING id`,
        [updated_by, otherUserId, status]
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
  addOtherUser: async (otherUserObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `INSERT INTO tbl_users(name, email, mobile, organization_name, user_type, password,
           status,created_by,new_profile_image,original_profile_image) 
        VALUES($1, $2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          otherUserObj.name,
          otherUserObj.email,
          otherUserObj.mobile,
          otherUserObj.organization_name || null,
          otherUserObj.register_as,
          otherUserObj.password,
          otherUserObj.status,
          otherUserObj.created_by,
          otherUserObj.fileName || null,
          otherUserObj.originalFilename || null
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
  userEmailExist: async (email) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_users WHERE email = $1 AND is_deleted = 0', [
        email
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
  userMobileExist: async (mobile) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_users WHERE mobile = $1 AND is_deleted = 0', [
        mobile
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
  getOtherUserDetails: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT tbl_users.*,
        CASE
        WHEN new_profile_image IS NULL THEN
        NULL
        ELSE new_profile_image
        END AS profile_image  FROM tbl_users WHERE is_deleted = 0 AND user_type = 4 AND id = $1`,
        [vendorId]
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
  updateOtherUser: async (otherUserId, otherUserObj) => {
    return new Promise(function (resolve, reject) {
      let dynamicUpdate = ``;
      if (otherUserObj.originalFilename) {
        dynamicUpdate = `,new_profile_image = '${otherUserObj.fileName}',original_profile_image = '${otherUserObj.originalFilename}'`;
      }
      db.one(
        `UPDATE 
        tbl_users SET
        name = $3,
        mobile = $4,
        organization_name = $5,
        updated_by = $1
        ${dynamicUpdate}
	      WHERE id= $2 RETURNING id`,
        [
          otherUserObj.updatedBy,
          otherUserId,
          otherUserObj.name,
          otherUserObj.mobile,
          otherUserObj.organization_name || null
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
  deleteOtherUser: async (otherUserId, updated_by) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE 
        tbl_users SET 
        is_deleted = 1,
        updated_by = ($1) 
	    WHERE id=($2) RETURNING id`,
        [updated_by, otherUserId]
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
  approveOtherUser: async (otherUserId, updatedBy, status, reasonId) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = ``;
      if (reasonId) {
        dynamicQuery = `,reject_reason_id = ${reasonId}`;
      }
      db.one(
        `UPDATE 
        tbl_users SET 
        status = $3,
        updated_by = ($1) 
        ${dynamicQuery}
	    WHERE id=($2) RETURNING id`,
        [updatedBy, otherUserId, status]
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

export default otherUserModel;
