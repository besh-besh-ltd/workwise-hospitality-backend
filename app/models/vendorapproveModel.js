import pgp from 'pg-promise';

import db from '../config/dbConn.js';
import Config from '../config/app.config.js';

const vendorapproveModel = {
  getVendorApproveList: async (limit, offset, organization, verified) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';

      if (verified == 't') {
        dynamicQuery += `AND status = 1 `;
      } else if (verified == 'f') {
        dynamicQuery += `AND status = 0 `;
      }
      db.any(
        `SELECT tbl_vendor_approve.*,
        CASE
        WHEN vendor_logo IS NULL THEN
        NULL
        ELSE vendor_logo
        END AS vendor_image  FROM tbl_vendor_approve WHERE status = 1 AND user_type = 3  ${dynamicQuery}
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
  getVendorListCount: async (organization, verified) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (organization) {
        dynamicQuery += `AND organization_name  ILIKE '%${organization}%'`;
      }
      if (verified == 't') {
        dynamicQuery += `AND status = 1 `;
      } else if (verified == 'f') {
        dynamicQuery += `AND status = 0 `;
      }
      db.one(
        `SELECT COUNT(id) FROM tbl_users WHERE is_deleted = 0 AND user_type = 3 ${dynamicQuery}`
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
  getAllVendorApproveList: async (limit, offset, verified, name) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      console.log('verified==>>', verified);
      if (verified == 't') {
        dynamicQuery += `AND status = 1 `;
      } else if (verified == 'f') {
        dynamicQuery += `AND status = 0 `;
      }
      if (name) {
        dynamicQuery += `AND vendor_approve ILIKE '%${name}%' `;
      }
      db.any(
        `SELECT tbl_vendor_approve.*,
        CASE
        WHEN vendor_logo IS NULL THEN
        NULL
        ELSE vendor_logo
        END AS vendor_image,
        CASE
        WHEN datasheet_file IS NULL THEN
        NULL
        ELSE datasheet_file
        END AS datasheet_file_url,
        CASE
        WHEN qap_file IS NULL THEN
        NULL
        ELSE qap_file
        END AS qap_file_file_url   FROM tbl_vendor_approve WHERE id IS NOT NULL ${dynamicQuery}
        ORDER BY id DESC LIMIT $1 OFFSET $2`,
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
  getAllVendorApproveListCount: async (verified, name) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (verified == 't') {
        dynamicQuery += `AND status = 1 `;
      } else if (verified == 'f') {
        dynamicQuery += `AND status = 0 `;
      }
      if (name) {
        dynamicQuery += `AND vendor_approve ILIKE '%${name}%' `;
      }
      db.one(
        `SELECT COUNT(id) FROM tbl_vendor_approve WHERE id IS NOT NULL ${dynamicQuery}`
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
  vendorEmailExist: async (email) => {
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
  vendorIDExist: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_users WHERE id = $1 AND is_deleted = 0 AND user_type = 3',
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
  getVendorDetails: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT tbl_users.*,
        CASE
        WHEN new_profile_image IS NULL THEN
        NULL
        ELSE new_profile_image
        END AS profile_image  FROM tbl_users WHERE is_deleted = 0 AND user_type = 3 AND id = $1`,
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
  vendorMobileExist: async (mobile) => {
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
  addVendor: async (vendorObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `INSERT INTO tbl_users(name, email, mobile, organization_name, user_type, password,
           status,created_by,new_profile_image,original_profile_image) 
        VALUES($1, $2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          vendorObj.name,
          vendorObj.email,
          vendorObj.mobile,
          vendorObj.organization_name || null,
          vendorObj.register_as,
          vendorObj.password,
          vendorObj.status,
          vendorObj.created_by,
          vendorObj.fileName || null,
          vendorObj.originalFilename || null
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
  deleteVendor: async (vendorId, updated_by) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE 
        tbl_users SET 
        is_deleted = 1,
        updated_by = ($1) 
	    WHERE id=($2) RETURNING id`,
        [updated_by, vendorId]
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
  blockVendor: async (vendorId, updated_by, status) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE 
        tbl_users SET 
        status = $3,
        updated_by = ($1) 
	    WHERE id=($2) RETURNING id`,
        [updated_by, vendorId, status]
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
  otherVendorEmailExist: async (email, vendorId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_users WHERE email = $1 AND is_deleted = 0 AND id != $2',
        [email, vendorId]
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
  otherVendorMobileExist: async (mobile, vendorId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_users WHERE mobile = $1 AND is_deleted = 0 AND id != $2',
        [mobile, vendorId]
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
  updateVendor: async (vendorId, vendorObj) => {
    return new Promise(function (resolve, reject) {
      let dynamicUpdate = ``;
      if (vendorObj.originalFilename) {
        dynamicUpdate = `,new_profile_image = '${vendorObj.fileName}',original_profile_image = '${vendorObj.originalFilename}'`;
      }
      db.one(
        `UPDATE 
        tbl_users SET
        name = $3,
        email = $4 ,
        mobile = $5,
        organization_name = $6,
        updated_by = $1
        ${dynamicUpdate}
	      WHERE id= $2 RETURNING id`,
        [
          vendorObj.updatedBy,
          vendorId,
          vendorObj.name,
          vendorObj.email,
          vendorObj.mobile,
          vendorObj.organization_name || null
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
  approveVendor: async (vendorId, updatedBy, status) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE 
        tbl_users SET 
        status = $3,
        updated_by = ($1) 
	    WHERE id=($2) RETURNING id`,
        [updatedBy, vendorId, status]
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
  findVendorApproveByName: async (approvalName) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT tbl_vendor_approve.*
         FROM tbl_vendor_approve WHERE  vendor_approve ILIKE '%${approvalName}%'`
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
  findVendorApproveBulkByName: async (approvalName) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT tbl_vendor_approve.*
         FROM tbl_vendor_approve WHERE  vendor_approve ILIKE '%${approvalName}%'`
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
  findVendorApproveById: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT tbl_vendor_approve.*
         FROM tbl_vendor_approve WHERE status = 1 AND id =  $1`,
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
  createVendorApprove: async (vendorApproveObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(vendorApproveObj, null, 'tbl_vendor_approve') +
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
  vendorApproveIDExist: async (vendorApproveID) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT *, CASE
        WHEN vendor_logo IS NULL THEN
        NULL
        ELSE vendor_logo
        END AS vendor_image,
        CASE
        WHEN datasheet_file IS NULL THEN
        NULL
        ELSE datasheet_file
        END AS datasheet_file_url,
        CASE
        WHEN qap_file IS NULL THEN
        NULL
        ELSE qap_file
        END AS qap_file_file_url        
        FROM tbl_vendor_approve WHERE id = $1`,
        [vendorApproveID]
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
  updateVendorApprove: async (vendorApproveObj, vendorApproveID) => {
    return new Promise(function (resolve, reject) {
      const condition = ` WHERE id = $1 RETURNING id`;
      const values = [vendorApproveID];
      let query =
        pgp().helpers.update(vendorApproveObj, null, 'tbl_vendor_approve') +
        condition;

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

export default vendorapproveModel;
