import db, { pgp } from '../config/dbConn.js';
import Config from '../config/app.config.js';

const vendorModel = {
  getMediaList: async (limit, offset, name) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (name) {
        dynamicQuery += `AND file_name  ILIKE '%${name}%'`;
      }

      db.any(
        `SELECT * FROM tbl_files WHERE doc_type = 'media'  ${dynamicQuery}
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
  getMediaListCount: async (name) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (name) {
        dynamicQuery += `AND file_name  ILIKE '%${name}%'`;
      }

      db.one(
        `SELECT COUNT(id) FROM tbl_files WHERE doc_type = 'media' ${dynamicQuery}`
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
  uploadFiles: async (files, user_id, doc_type) => {
    let dataArray = [];

    files.map((item) => {
      dataArray.push({
        user_id,
        file_name: item.originalname,
        new_file_name: item.filename,
        file_path: `${Config.base_url}/user_document/${item.filename}`,
        file_type: item.mimetype,
        doc_type: doc_type
      });
    });
    const keys = [
      'user_id',
      'file_name',
      'new_file_name',
      'file_path',
      'file_type',
      'doc_type'
    ];

    const insertQuery =
      pgp.helpers.insert(dataArray, keys, 'tbl_files') + ' RETURNING *';

    return new Promise(function (resolve, reject) {
      db.manyOrNone(insertQuery)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  mediaIDExist: async (mediaId) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_files WHERE id = $1 ', [mediaId])
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
  }
};

export default vendorModel;
