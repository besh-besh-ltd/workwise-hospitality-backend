import db from '../config/dbConn.js';
import Config from '../config/app.config.js';
import pgp from 'pg-promise';

const vendorModel = {
  getVendorList: async (limit, offset, organization, verified, name, email, status, dateFrom, dateTo) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (name) {
        dynamicQuery += `AND (tbl_users.name ILIKE '%${name}%' OR tbl_users.organization_name ILIKE '%${name}%')`;
      }
      if (organization) {
        dynamicQuery += `AND (tbl_users.organization_name ILIKE '%${organization}%' OR tbl_users.name ILIKE '%${organization}%')`;
      }
      if (verified == 't') {
        dynamicQuery += `AND tbl_users.status = 1 `;
      } else if (verified == 'f') {
        dynamicQuery += `AND tbl_users.status = 0 `;
      }
      if (email) {
        dynamicQuery += `AND tbl_users.email ILIKE '%${email}%'`;
      }
      if (status !== undefined && status !== null) {
        dynamicQuery += `AND tbl_users.status = ${status}`;
      }
      if (dateFrom) {
        dynamicQuery += `AND tbl_users.created_at >= '${dateFrom}'`;
      }
      if (dateTo) {
        dynamicQuery += `AND tbl_users.created_at <= '${dateTo}'`;
      }

      db.any(
        `SELECT 
          tbl_users.id,
          tbl_users.name,
          tbl_users.email,
          tbl_users.mobile,
          tbl_users.organization_name,
          tbl_users.status,
          tbl_users.new_profile_image,
          tbl_users.original_profile_image,
          tbl_users.created_at,
          tbl_users.updated_at,
          creator.name AS created_by_name,
          updater.name AS updated_by_name,
          trr.reject_reason,
          CASE
            WHEN tbl_users.new_profile_image IS NULL THEN NULL
            ELSE tbl_users.new_profile_image
          END AS profile_image  
        FROM tbl_users 
        LEFT JOIN tbl_reject_reason trr ON tbl_users.reject_reason_id = trr.id
        LEFT JOIN tbl_users creator ON tbl_users.created_by = creator.id
        LEFT JOIN tbl_users updater ON tbl_users.updated_by = updater.id
        WHERE tbl_users.is_deleted = 0 AND tbl_users.user_type = 3 ${dynamicQuery}
        ORDER BY tbl_users.created_at DESC 
        LIMIT $1 OFFSET $2`,
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
 
getVendorListCount: async (organization, verified, name, email, status, dateFrom, dateTo) => {
  return new Promise(function (resolve, reject) {
    let dynamicQuery = 'AND user_type = 3 ';
    if (name) {
      dynamicQuery += `AND (name ILIKE '%${name}%' OR organization_name ILIKE '%${name}%')`;
    }
    if (organization) {
      dynamicQuery += `AND (organization_name ILIKE '%${organization}%' OR name ILIKE '%${organization}%')`;
    }
    if (verified == 't') {
      dynamicQuery += `AND status = 1 `;
    } else if (verified == 'f') {
      dynamicQuery += `AND status = 0 `;
    }
    if (email) {
      dynamicQuery += `AND email ILIKE '%${email}%'`;
    }
    if (status !== undefined && status !== null) {
      dynamicQuery += `AND status = ${status}`;
    }
    if (dateFrom) {
      dynamicQuery += `AND created_at >= '${dateFrom}'`;
    }
    if (dateTo) {
      dynamicQuery += `AND created_at <= '${dateTo}'`;
    }
    const query = `
    SELECT
      COUNT(*) FILTER (WHERE is_deleted = 0 ${dynamicQuery}) AS total_vendors,
      COUNT(*) FILTER (WHERE is_deleted = 1 ${dynamicQuery}) AS deleted_vendors,
      COUNT(*) FILTER (WHERE is_deleted = 0 AND status = 1 ${dynamicQuery}) AS active_vendors,
      COUNT(*) FILTER (WHERE is_deleted = 0 AND status = 0 ${dynamicQuery}) AS deactivated_vendors
    FROM tbl_users
  `;

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
  vendorNameExist: async (name) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT id, vendor_approve FROM tbl_vendor_approve WHERE vendor_approve = $1 ',
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
  },

  checkState: async (stateName) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_location_states WHERE "state_name" ILIKE '%${stateName}%'`
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
  checkCity: async (cityName) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_location_cities  WHERE city_name ILIKE '%${cityName}%'`
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
        `SELECT tbl_users.*,tbl_company.profile,tbl_company.nature_of_business,tbl_company.no_of_employess,tbl_company.gstin,tbl_company.import_export_code,tbl_company.certifications,
        ARRAY
        (SELECT json_build_object('brochure',tbl_files.new_file_name,'brochure_url', CASE
        WHEN tbl_files.file_name IS NULL THEN
        NULL
        ELSE tbl_files.new_file_name
        END  )
          FROM tbl_files  WHERE  tbl_files.user_id = tbl_users.id AND tbl_files.doc_type = 'brochure') AS "brochure",
       ARRAY
          (SELECT json_build_object('ptr',tbl_files.new_file_name,'ptr_url', CASE
          WHEN tbl_files.new_file_name IS NULL THEN
          NULL
          ELSE tbl_files.new_file_name
          END )
            FROM tbl_files  WHERE  tbl_files.user_id = tbl_users.id AND tbl_files.doc_type = 'ptr') AS "ptr_files",
        ARRAY
            (SELECT json_build_object('documents',tbl_files.new_file_name,'document_url', CASE
            WHEN tbl_files.new_file_name IS NULL THEN
            NULL
            ELSE tbl_files.new_file_name
            END )
              FROM tbl_files  WHERE  tbl_files.user_id = tbl_users.id AND tbl_files.doc_type = 'documents') AS "documents",
       ARRAY
              (SELECT json_build_object('product',tbl_product.name, 'product_image_url',  CASE
              WHEN tbl_product_images.new_image_name IS NULL THEN
              NULL
              ELSE tbl_product_images.new_image_name
              END)
                FROM tbl_product left join tbl_product_images on tbl_product.id = tbl_product_images.product_id AND  tbl_product_images.is_featured = '1' WHERE  tbl_product.created_by = $1 ) AS "products",
       ARRAY
        (SELECT json_build_object('vendor_approve', tbl_vendor_approve.vendor_approve,'vendor_approve', tbl_vendor_approve.vendor_approve,'id',tbl_vendor_approve.id, 'vendor_approve_url',  CASE
        WHEN tbl_vendor_approve.vendor_logo IS NULL THEN
        NULL
        ELSE tbl_vendor_approve.vendor_logo
        END)
          FROM tbl_vendorapprove_user_mapping VM left join tbl_vendor_approve on tbl_vendor_approve.id = VM.vendor_approve_id  WHERE  tbl_users.id = VM.user_id) AS "vendor_approve",
        CASE
        WHEN new_profile_image IS NULL THEN
        NULL
        ELSE new_profile_image
        END AS profile_image  FROM tbl_users left join tbl_company on tbl_users.id = tbl_company.user_id  WHERE is_deleted = 0 AND user_type = 3 AND tbl_users.id = $1`,
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
  getCompanyDetails: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_company WHERE user_id = $1', [vendorId])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getVendoreditDetails: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_users WHERE id = $1', [vendorId])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getFiles: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_files WHERE user_id = $1', [vendorId])
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
  approveVendor: async (vendorId, updatedBy, status, reasonId) => {
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
  checkRejectReason: async (reject_reason) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_reject_reason WHERE reject_reason ILIKE '%${reject_reason}%' AND status = 1`
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
  createReason: async (reasonObj) => {
    return new Promise(function (resolve, reject) {
      const query =
        pgp().helpers.insert(reasonObj, null, 'tbl_reject_reason') +
        ' RETURNING id';

      db.any(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  rejectReasonDropdownList: async (type) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT *
         FROM tbl_reject_reason 
         WHERE status = 1 AND type = ${type}
        ORDER BY id DESC`
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
  getVendorDropdownList: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT tbl_users.id,tbl_users.name,tbl_users.mobile, tbl_users.email,tbl_users.organization_name,tbl_users.user_type
         FROM tbl_users 
         WHERE is_deleted = 0 AND user_type = 3 OR user_type = 4  AND status = 1
        ORDER BY created_at`
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
  userDetailById: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_users where id = $1', [id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  
  getSpocDetails: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_users_spoc where user_id = $1', [id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  SpocExist: async (vendorId,spocId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_users_spoc WHERE user_id = $1 AND id = $2',
        [vendorId,spocId]
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

  updateUserSpoc: async (name, email, mobile, role, userId, spocId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `UPDATE tbl_users_spoc
         SET name = $1, email = $2, mobile = $3, role = $4, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $5 AND id = $6
         AND (name != $1 OR email != $2 OR mobile != $3 OR role != $4)
         RETURNING *;`,
        [name, email, mobile, role, userId, spocId]
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

  deleteSpoc: async (userId, spocId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `DELETE FROM tbl_users_spoc WHERE user_id = $1 AND id = $2 RETURNING *;`,
        [userId, spocId] )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) { let error = new Error(err); reject(error); });
    });
  },

  topVendorsWithProducts: async (userId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `
          SELECT 
              TRPV.user_id, 
              TU.name AS name,
              TU.organization_name,
              TU.email AS email,
              TU.mobile AS mobile,
              TU.address AS address,
              TUC.company_name,
              COUNT(DISTINCT TR.id)::INT AS rfq_count
          FROM tbl_rfq_product_vendors TRPV
          JOIN tbl_rfq TR
              ON TR.id = TRPV.rfq_id
          JOIN tbl_product TP
              ON TP.id = TRPV.product_id
          JOIN tbl_product_categories TPC
              ON TPC.product_id = TP.id
          JOIN tbl_category TC
              ON TC.id = TPC.category_id AND TC.parent_id = 0 
          JOIN tbl_users TU
              ON TU.id = TRPV.user_id
          LEFT JOIN tbl_company TUC
              ON TUC.user_id = TU.id 
          WHERE TR.created_by = $1
              AND TU.is_deleted = 0 
              AND TU.status = 1 
          GROUP BY 
              TRPV.user_id, TU.name, TU.organization_name, TU.email, TU.mobile, TU.address, TUC.company_name
          ORDER BY 
              rfq_count DESC
          LIMIT 10;
        `
        , [userId]
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

  getFinalizedVendors: async (userId) => {
    const query = `
        SELECT DISTINCT
            TC.user_id,
            TC.company_name,
            TC.email,
            TC.mobile,
            TU.organization_name,
            TU.name
        FROM tbl_company TC
        LEFT JOIN tbl_users TU
            ON TC.user_id = TU.id
        INNER JOIN tbl_quote_finalization TQF
            ON TC.user_id = TQF.vendor_id
        INNER JOIN tbl_rfq TR
            ON TR.id = TQF.rfq_id
        WHERE TR.status = 1
            AND TR.is_published = 1
            AND TR.created_by = $1
      `;

    try {
      const data = db.query(query, [userId]);
      return data;
    } catch (error) {
      throw new Error(error);
    }
  },

  getFinalizedProducts: async (userId) => {
    const query = `
        SELECT DISTINCT
            TP.id AS value,
            TP.name AS label
        FROM tbl_product TP        
        INNER JOIN tbl_quote_finalization TQF
            ON TP.id = TQF.product_id
        INNER JOIN tbl_rfq TR
            ON TR.id = TQF.rfq_id
        WHERE TR.status = 1
            AND TR.is_published = 1
            AND TR.created_by = $1
      `;

    try {
      const data = db.query(query, [userId]);
      return data;
    } catch (error) {
      throw new Error(error);
    }
  }
};

export default vendorModel;