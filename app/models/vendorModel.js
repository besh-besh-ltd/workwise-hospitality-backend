import db from '../config/dbConn.js';
import Config from '../config/app.config.js';
import pgp from 'pg-promise';

const vendorModel = {
  // Helper function to escape SQL strings
  _escapeSqlString: (str) => {
    if (!str) return str;
    // Replace single quotes with double single quotes to escape them in SQL
    return str.replace(/'/g, "''");
  },

 getVendorList: async (limit, offset, organization, verified, name, email, status, dateFrom, dateTo, created_by, source, subscription_plan, isPrivate,mobile) => {    
  return new Promise(function (resolve, reject) {
      // Escape input strings to prevent SQL injection and syntax errors
      const escapedName = name ? vendorModel._escapeSqlString(name) : null;
      const escapedOrganization = organization ? vendorModel._escapeSqlString(organization) : null;
      const escapedEmail = email ? vendorModel._escapeSqlString(email) : null;
      const escapedSource = source ? vendorModel._escapeSqlString(source) : null;
      const escapedPlan = subscription_plan ? vendorModel._escapeSqlString(subscription_plan) : null;
      const escapedIsPrivate = isPrivate ? vendorModel._escapeSqlString(isPrivate) : null;
      const escapedMobile = mobile ? mobile.replace(/[^0-9]/g, '') : null;
      
      let dynamicQuery = '';
      if (name) {
        dynamicQuery += `
          AND (
            to_tsvector('english', tbl_users.name) @@ plainto_tsquery('english', '${escapedName}')
            OR similarity(tbl_users.name, '${escapedName}') > 0.1
            OR to_tsvector('english', COALESCE(tbl_company.company_name, tbl_users.organization_name)) @@ plainto_tsquery('english', '${escapedName}')
            OR similarity(COALESCE(tbl_company.company_name, tbl_users.organization_name), '${escapedName}') > 0.1
          )`;
      }
      if (organization) {
        dynamicQuery += `
          AND (
            to_tsvector('english', COALESCE(tbl_company.company_name, tbl_users.organization_name)) @@ plainto_tsquery('english', '${escapedOrganization}')
            OR similarity(COALESCE(tbl_company.company_name, tbl_users.organization_name), '${escapedOrganization}') > 0.1
            OR to_tsvector('english', tbl_users.name) @@ plainto_tsquery('english', '${escapedOrganization}')
            OR similarity(tbl_users.name, '${escapedOrganization}') > 0.1
          )`;
      }
      if (verified == 't') {
        dynamicQuery += ` AND tbl_users.status = 1`;
      } else if (verified == 'f') {
        dynamicQuery += ` AND tbl_users.status = 0`;
      }
      if (email) {
        dynamicQuery += ` AND tbl_users.email ILIKE '%${escapedEmail}%'`;
      }
      if (status !== undefined && status !== null) {
        dynamicQuery += ` AND tbl_users.status = '${status}'`;
      }
    if (mobile) {
      dynamicQuery += `
    AND regexp_replace(tbl_users.mobile, '[^0-9]', '', 'g')
    ILIKE '%${escapedMobile}%'
  `;
}
    if (dateFrom) {
        dynamicQuery += ` AND tbl_users.created_at >= '${dateFrom}'`;
      }
      if (dateTo) {
        dynamicQuery += ` AND tbl_users.created_at <= '${dateTo} 23:59:59'`;
      }
      if (created_by) {
        dynamicQuery += ` AND tbl_users.created_by = '${created_by}'`;
      }
      if(source === 'unknown' || source === 'null'){
        dynamicQuery += ` AND tbl_company.source IS NULL`;
      } else if(source){
        dynamicQuery += ` AND tbl_company.source ILIKE '${escapedSource}'`;
      }
      if(subscription_plan){
        dynamicQuery += ` AND tbl_users.subscription_plan_id = '${escapedPlan}'`;
      }
      if(isPrivate){
        dynamicQuery += ` AND tbl_company.is_private = '${escapedIsPrivate}'`;
      }

      let orderByClause = 'ORDER BY tbl_users.created_at DESC';
      if (name || organization) {
        // If searching by name or organization, order by both exact matches, ts_rank and similarity score
        const searchTerm = escapedName || escapedOrganization;
        
        orderByClause = `
          ORDER BY
            CASE
              WHEN LOWER(tbl_users.name) = LOWER('${searchTerm}') THEN 10
              WHEN LOWER(COALESCE(tbl_company.company_name, tbl_users.organization_name)) = LOWER('${searchTerm}') THEN 10
              ELSE 0
            END DESC,
            CASE
              WHEN LOWER(tbl_users.name) ILIKE LOWER('${searchTerm}%') THEN 8
              WHEN LOWER(COALESCE(tbl_company.company_name, tbl_users.organization_name)) ILIKE LOWER('${searchTerm}%') THEN 8
              ELSE 0
            END DESC,
            CASE
              WHEN LOWER(tbl_users.name) ILIKE LOWER('%${searchTerm}%') THEN 6
              WHEN LOWER(COALESCE(tbl_company.company_name, tbl_users.organization_name)) ILIKE LOWER('%${searchTerm}%') THEN 6
              ELSE 0
            END DESC,
            GREATEST(
              COALESCE(ts_rank_cd(to_tsvector('english', tbl_users.name), plainto_tsquery('english', '${searchTerm}')), 0),
              COALESCE(ts_rank_cd(to_tsvector('english', COALESCE(tbl_company.company_name, tbl_users.organization_name)), plainto_tsquery('english', '${searchTerm}')), 0)
            ) DESC,
            GREATEST(
              COALESCE(similarity(tbl_users.name, '${searchTerm}'), 0),
              COALESCE(similarity(COALESCE(tbl_company.company_name, tbl_users.organization_name), '${searchTerm}'), 0)
            ) DESC,
            tbl_users.created_at DESC
        `;
      }

      let q = `SELECT 
          tbl_users.id,
          tbl_users.name,
          tbl_users.email,
          tbl_users.mobile,
          COALESCE(tbl_company.company_name, tbl_users.organization_name) AS organization_name,
          tbl_users.status,
          tbl_users.created_at,
          tbl_users.updated_at,
          tbl_company.source,
          tbl_users.subscription_plan_id,
          tbl_company.is_private,
          creator.name AS created_by_name,
          updater.name AS updated_by_name,
          trr.reject_reason,
          ${(name || organization) ? `
          CASE
            WHEN LOWER(tbl_users.name) = LOWER('${escapedName || escapedOrganization}') THEN 10
            WHEN LOWER(COALESCE(tbl_company.company_name, tbl_users.organization_name)) = LOWER('${escapedName || escapedOrganization}') THEN 10
            WHEN LOWER(tbl_users.name) ILIKE LOWER('${escapedName || escapedOrganization}%') THEN 8
            WHEN LOWER(COALESCE(tbl_company.company_name, tbl_users.organization_name)) ILIKE LOWER('${escapedName || escapedOrganization}%') THEN 8
            WHEN LOWER(tbl_users.name) ILIKE LOWER('%${escapedName || escapedOrganization}%') THEN 6
            WHEN LOWER(COALESCE(tbl_company.company_name, tbl_users.organization_name)) ILIKE LOWER('%${escapedName || escapedOrganization}%') THEN 6
            ELSE 0
          END AS exact_match_score,
          GREATEST(
            COALESCE(ts_rank_cd(to_tsvector('english', tbl_users.name), plainto_tsquery('english', '${escapedName || escapedOrganization}')), 0),
            COALESCE(ts_rank_cd(to_tsvector('english', COALESCE(tbl_company.company_name, tbl_users.organization_name)), plainto_tsquery('english', '${escapedName || escapedOrganization}')), 0)
          ) AS rank,
          GREATEST(
            COALESCE(similarity(tbl_users.name, '${escapedName || escapedOrganization}'), 0),
            COALESCE(similarity(COALESCE(tbl_company.company_name, tbl_users.organization_name), '${escapedName || escapedOrganization}'), 0)
          ) AS similarity_score,
          ` : ''}
          NULL AS profile_image  
        FROM tbl_users 
        LEFT JOIN tbl_company ON tbl_users.company_id = tbl_company.id
        LEFT JOIN tbl_reject_reason trr ON tbl_users.reject_reason_id = trr.id
        LEFT JOIN tbl_users creator ON tbl_users.created_by = creator.id
        LEFT JOIN tbl_users updater ON tbl_users.updated_by = updater.id
        WHERE tbl_users.is_deleted = '0' AND tbl_users.user_type = '3' ${dynamicQuery}
        ${orderByClause}
        LIMIT $1 OFFSET $2`

      db.any(
        q,
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
 
getVendorListCount: async (organization, verified, name, email, status, dateFrom, dateTo, created_by, source, subscription_plan, is_private,mobile) => {
    return new Promise(function (resolve, reject) {
    // Escape input strings
    const escapedName = name ? vendorModel._escapeSqlString(name) : null;
    const escapedOrganization = organization ? vendorModel._escapeSqlString(organization) : null;
    const escapedEmail = email ? vendorModel._escapeSqlString(email) : null;
    const escapedSource = source ? vendorModel._escapeSqlString(source) : null;
    const escapedPlan = subscription_plan ? vendorModel._escapeSqlString(subscription_plan) : null;
    const escapedIsPrivate = is_private ? vendorModel._escapeSqlString(is_private) : null;
    const escapedMobile = mobile ? mobile.replace(/[^0-9]/g, '') : null;
    
    let dynamicQuery = 'AND tbl_users.user_type = 3 ';
    if (name) {
      dynamicQuery += `
        AND (
          to_tsvector('english', tbl_users.name) @@ plainto_tsquery('english', '${escapedName}')
          OR similarity(tbl_users.name, '${escapedName}') > 0.1
          OR to_tsvector('english', COALESCE(tbl_company.company_name, tbl_users.organization_name)) @@ plainto_tsquery('english', '${escapedName}')
          OR similarity(COALESCE(tbl_company.company_name, tbl_users.organization_name), '${escapedName}') > 0.1
        )`;
    }
    if (organization) {
      dynamicQuery += `
        AND (
          to_tsvector('english', COALESCE(tbl_company.company_name, tbl_users.organization_name)) @@ plainto_tsquery('english', '${escapedOrganization}')
          OR similarity(COALESCE(tbl_company.company_name, tbl_users.organization_name), '${escapedOrganization}') > 0.1
          OR to_tsvector('english', tbl_users.name) @@ plainto_tsquery('english', '${escapedOrganization}')
          OR similarity(tbl_users.name, '${escapedOrganization}') > 0.1
        )`;
    }
    if (verified == 't') {
      dynamicQuery += ` AND tbl_users.status = 1`;
    } else if (verified == 'f') {
      dynamicQuery += ` AND tbl_users.status = 0`;
    }
    if (email) {
      dynamicQuery += ` AND tbl_users.email ILIKE '%${escapedEmail}%'`;
    }
    if (mobile) {
        dynamicQuery += ` AND regexp_replace(tbl_users.mobile, '[^0-9]', '', 'g') ILIKE '%${escapedMobile}%'`;
      }
    if (status !== undefined && status !== null) {
      dynamicQuery += ` AND tbl_users.status = '${status}'`;
    }
    if (dateFrom) {
      dynamicQuery += ` AND tbl_users.created_at >= '${dateFrom}'`;
    }
    if (dateTo) {
      dynamicQuery += ` AND tbl_users.created_at <= '${dateTo} 23:59:59'`;
    }
    if (created_by) {
      dynamicQuery += ` AND tbl_users.created_by = '${created_by}'`;
    }
    if(source === 'unknown' || source === 'null'){
        dynamicQuery += ` AND tbl_company.source IS NULL`;
      } else if(source){
        dynamicQuery += ` AND tbl_company.source = '${escapedSource}'`;
      }
    if(subscription_plan){
        dynamicQuery += ` AND tbl_users.subscription_plan_id = '${escapedPlan}'`;
    }
    if(is_private){
        dynamicQuery += ` AND tbl_company.is_private = '${escapedIsPrivate}'`;
    }

    const query = `
    SELECT
      COUNT(*) FILTER (WHERE tbl_users.is_deleted = 0 ${dynamicQuery}) AS total_vendors,
      COUNT(*) FILTER (WHERE tbl_users.is_deleted = 1 ${dynamicQuery}) AS deleted_vendors,
      COUNT(*) FILTER (WHERE tbl_users.is_deleted = 0 AND tbl_users.status = 1 ${dynamicQuery}) AS active_vendors,
      COUNT(*) FILTER (WHERE tbl_users.is_deleted = 0 AND tbl_users.status = 0 ${dynamicQuery}) AS deactivated_vendors
    FROM tbl_users
    LEFT JOIN tbl_company ON tbl_users.company_id = tbl_company.id
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
      const escapedName = vendorModel._escapeSqlString(name);
      
      db.any(
        `SELECT 
          id, 
          vendor_approve,
          CASE
            WHEN LOWER(vendor_approve) = LOWER($1) THEN 10
            WHEN LOWER(vendor_approve) ILIKE LOWER($1 || '%') THEN 8
            WHEN LOWER(vendor_approve) ILIKE LOWER('%' || $1 || '%') THEN 6
            ELSE 0
          END AS exact_match_score,
          ts_rank_cd(to_tsvector('english', vendor_approve), plainto_tsquery('english', $1)) AS rank,
          similarity(vendor_approve, $1) AS similarity_score
        FROM tbl_vendor_approve 
        WHERE 
          similarity(vendor_approve, $1) > 0.1
          OR to_tsvector('english', vendor_approve) @@ plainto_tsquery('english', $1)
        ORDER BY 
          exact_match_score DESC,
          rank DESC,
          similarity_score DESC,
          vendor_approve ASC`,
        [escapedName]
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
      const escapedStateName = vendorModel._escapeSqlString(stateName);
      
      db.any(
        `SELECT * FROM tbl_location_states WHERE "state_name" ILIKE '%${escapedStateName}%'`
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
      const escapedCityName = vendorModel._escapeSqlString(cityName);
      
      db.any(
        `SELECT * FROM tbl_location_cities WHERE city_name ILIKE '%${escapedCityName}%'`
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
        `SELECT tbl_users.*,tbl_company.company_name,tbl_company.profile,tbl_company.nature_of_business,tbl_company.type_of_business,tbl_company.no_of_employess,tbl_company.gstin,tbl_company.import_export_code,tbl_company.cin,tbl_company.website,tbl_company.turnover,tbl_company.established_year,tbl_company.logo,
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
        (SELECT json_build_object(
          'vendor_approve', tbl_vendor_approve.vendor_approve,
          'id', tbl_vendor_approve.id, 
          'vendor_approve_url', CASE
            WHEN tbl_vendor_approve.vendor_logo IS NULL THEN NULL
            ELSE tbl_vendor_approve.vendor_logo
          END,
          'similarity_score', 
            CASE 
              WHEN tbl_users.name IS NOT NULL THEN 
                similarity(tbl_vendor_approve.vendor_approve, tbl_users.name)
              ELSE 0
            END
        )
          FROM tbl_vendorapprove_user_mapping VM 
          LEFT JOIN tbl_vendor_approve on tbl_vendor_approve.id = VM.vendor_approve_id  
          WHERE tbl_users.id = VM.user_id
          ORDER BY 
            CASE 
              WHEN tbl_users.name IS NOT NULL THEN 
                similarity(tbl_vendor_approve.vendor_approve, tbl_users.name)
              ELSE 0
            END DESC
        ) AS "vendor_approve",
        NULL AS profile_image  FROM tbl_users left join tbl_company on tbl_users.company_id = tbl_company.id  WHERE is_deleted = 0 AND user_type = 3 AND tbl_users.id = $1`,
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
  getLocationsByCompanyId: async (company_id) => {
    try {
      const query = `
        SELECT 
          l.id,
          l.company_id,
          l.address,
          l.postal_code,
          l.country_id,
          c.country_name,
          l.state_id,
          s.state_name,
          l.city_id,
          ci.city_name,
          l.created_at,
          l.updated_at
        FROM tbl_company_location l
        LEFT JOIN tbl_location_country c ON l.country_id = c.id
        LEFT JOIN tbl_location_states s ON l.state_id = s.id
        LEFT JOIN tbl_location_cities ci ON l.city_id = ci.id
        WHERE l.company_id = $1
        ORDER BY l.id DESC;
      `;

      const result = await db.any(query, [company_id]);
      return result;

    } catch (error) {
      console.error("Error fetching vendor locations with join:", error);
      throw error;
    }
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
           status,created_by) 
        VALUES($1, $2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          vendorObj.name,
          vendorObj.email,
          vendorObj.mobile,
          vendorObj.organization_name || null,
          vendorObj.register_as,
          vendorObj.password,
          vendorObj.status,
          vendorObj.created_by
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
        dynamicUpdate = ``;
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
      db.any(
        'INSERT INTO tbl_reject_reason(reject_reason, status, type) VALUES($1, $2, $3) RETURNING id',
        [reasonObj.reject_reason, reasonObj.status, reasonObj.type]
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
  /**
   * @param isApproved (undefined | string) will add a condition in query to fetch only approved, disapproved or all vendors (if undefined)
   */
  getVendorDropdownList: async (search = null, isApproved = null) => {
    return new Promise(function (resolve, reject) {
      
      const escapedSearch = search ? vendorModel._escapeSqlString(search) : '';
      
      const q = `SELECT 
          tu.id,
          tu.name,
          tu.mobile, 
          tu.email,
          COALESCE(tc.company_name, tu.organization_name) AS organization_name,
          ${escapedSearch ? "ts_rank_cd(to_tsvector('english', tc.company_name), plainto_tsquery('english', $1)) AS rank," : ''}
          ${escapedSearch ? 'word_similarity(lower(tc.company_name), lower($1)) as similarity_score,' : ''}
          ${escapedSearch ? `CASE
              WHEN lower(tc.company_name) LIKE lower($1) || '%' THEN 1
              ELSE 0
          END AS starts_with_input,` : ''}
          ${escapedSearch ? `CASE
            WHEN lower(tc.company_name) ~* ('(^|\\s)' || lower($1) || '(\\s|$)') THEN 1
            ELSE 0
          END AS exact_word_match,` : ''}
          ${escapedSearch ? `CASE
            WHEN position(lower($1) in lower(tc.company_name)) > 0 THEN 1
            ELSE 0
          END AS partial_word_match,` : ''}
          tu.user_type
         FROM tbl_users tu
         LEFT JOIN tbl_company tc ON tu.company_id = tc.id
         WHERE tc.id IS NOT NULL AND tu.is_deleted = 0 AND (tu.user_type = 3 OR tu.user_type = 4) 
         ${search ? ` AND (
          to_tsvector('english', tc.company_name) @@ plainto_tsquery('english', $1)
          OR (char_length($1) = 1 AND similarity(tc.company_name, $1) > 0)
          OR (char_length($1) > 1 AND similarity(tc.company_name, $1) > 0.1)
      ) ` : ''}
        ${isApproved != null ? isApproved == 'true' ? 'AND tu.status = 1' : 'AND tu.status = 0' : ''}
        ORDER BY 
        ${search ? 
          `rank DESC, starts_with_input DESC, exact_word_match DESC, partial_word_match DESC, similarity_score DESC, tu.created_at` : 
          `tu.created_at`
        }`

      db.any(q, [escapedSearch]
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
  
  getSpocDetails: async (id, filterByStatus = true) => {
    return new Promise(function (resolve, reject) {
      let query = 'SELECT * FROM tbl_users_spoc WHERE user_id = $1 AND (is_deleted = 0 OR is_deleted IS NULL)';
      if (filterByStatus) {
        query += ' AND status = 1';
      }
      query += ' ORDER BY created_at DESC';
      
      db.any(query, [id])
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

  updateUserSpoc: async (name, email, mobile, role, userId, spocId, status = null) => {
    return new Promise(function (resolve, reject) {
      let updateFields = [];
      let params = [];
      let paramCount = 1;

      if (name !== null) {
        updateFields.push(`name = $${paramCount}`);
        params.push(name);
        paramCount++;
      }
      if (email !== null) {
        updateFields.push(`email = $${paramCount}`);
        params.push(email);
        paramCount++;
      }
      if (mobile !== null) {
        updateFields.push(`mobile = $${paramCount}`);
        params.push(mobile);
        paramCount++;
      }
      if (role !== null) {
        updateFields.push(`role = $${paramCount}`);
        params.push(role);
        paramCount++;
      }
      if (status !== null) {
        updateFields.push(`status = $${paramCount}`);
        params.push(status);
        paramCount++;
      }

      updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
      
      // Add userId and spocId to params
      params.push(userId, spocId);

      const query = `
        UPDATE tbl_users_spoc
        SET ${updateFields.join(', ')}
        WHERE user_id = $${paramCount} AND id = $${paramCount + 1}
        RETURNING *;
      `;

      db.any(query, params)
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
              TCL.address AS address,
              TUC.company_name,
              COUNT(DISTINCT TR.id)::INT AS rfq_count
          FROM tbl_rfq_product_vendors TRPV
          JOIN tbl_rfq TR
              ON TR.id = TRPV.rfq_id
          JOIN tbl_product_variant TPV
              ON TPV.id = TRPV.product_variant_id
          JOIN tbl_product TP ON TP.id = TPV.product_id
          JOIN tbl_product_categories TPC
              ON TPC.product_id = TP.id
          JOIN tbl_category TC
              ON TC.id = TPC.category_id AND TC.parent_id = 0 
          JOIN tbl_users TU
              ON TU.id = TRPV.user_id
          LEFT JOIN tbl_company TUC
              ON TU.company_id = TUC.id 
          LEFT JOIN tbl_company_location TCL
              ON TUC.id = TCL.company_id
          WHERE TR.created_by = $1
              AND TU.is_deleted = 0 
              AND TU.status = 1 
          GROUP BY 
              TRPV.user_id, TU.name, TU.organization_name, TU.email, TU.mobile, TCL.address, TUC.company_name
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
  },
  getAdminUsers: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT id, name, user_type 
         FROM tbl_users 
         WHERE is_deleted = 0 
         AND user_type IN (1, 5, 6)
         ORDER BY name ASC`
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

  getBuyerCompanyDropdown: async (search = null, limit = 100) => {
    return new Promise(function (resolve, reject) {
      const params = [];
      let searchClause = '';

      if (search) {
        params.push(`%${search.trim().toLowerCase()}%`);
        searchClause = `AND (LOWER(c.company_name) LIKE $${params.length} OR LOWER(u.email) LIKE $${params.length} OR LOWER(u.name) LIKE $${params.length})`;
      }

      const query = `
        SELECT DISTINCT ON (c.id)
          c.id AS company_id,
          c.company_name,
          u.id AS buyer_user_id,
          u.name AS buyer_name,
          u.email AS buyer_email,
          u.mobile AS buyer_mobile
        FROM tbl_users u
        INNER JOIN tbl_company c ON u.company_id = c.id
        WHERE u.is_deleted = 0
          AND u.user_type IN (7)
          AND c.id IS NOT NULL
          ${searchClause}
        ORDER BY c.id, u.created_at DESC
        LIMIT ${limit};
      `;

      db.any(query, params)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  getVendorCompanyMappings: async (vendorId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT 
            bvm.company_id,
            c.company_name
         FROM tbl_buyer_private_vendors_mapping bvm
         LEFT JOIN tbl_company c ON bvm.company_id = c.id
         WHERE bvm.vendor_id = $1
         ORDER BY c.company_name ASC`,
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

  replaceVendorCompanyMappings: async (vendorId, companyIds = [], createdBy) => {
    return db.tx(async (t) => {
      await t.none(
        `DELETE FROM tbl_buyer_private_vendors_mapping WHERE vendor_id = $1`,
        [vendorId]
      );

      if (!companyIds || companyIds.length === 0) {
        return true;
      }

      const insertQuery = `
        INSERT INTO tbl_buyer_private_vendors_mapping (created_by, vendor_id, company_id, created_date, updated_date)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;

      for (const companyId of companyIds) {
        const companyIdInt = parseInt(companyId, 10);
        if (!Number.isNaN(companyIdInt)) {
          await t.none(insertQuery, [createdBy || null, vendorId, companyIdInt]);
        }
      }

      return true;
    });
  },

  findReasonByText: async (reasonText) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_reject_reason WHERE reject_reason = $1',
        [reasonText]
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

  getVendorsWithSpocsAndToken: async (userIds, rfqNo) => {
    return new Promise(function (resolve, reject) {
      const query = `
        SELECT 
          u.id AS vendor_id,
          u.name,
          u.email,
          u.mobile,
          COALESCE(c.company_name, u.organization_name, u.name),
          c.company_name,
          -- Pick only ONE token using subquery (latest or earliest)
          (
            SELECT token FROM tbl_vendor_rfq_tokens_non_login
            WHERE vendor_id = u.id AND rfq_no = $2
            LIMIT 1
          ) AS token,
          COALESCE(
            json_agg(DISTINCT jsonb_build_object(
              'spoc_id', s.id,
              'name', s.name,
              'email', s.email,
              'mobile', s.mobile,
              'role', s.role
            )) FILTER (WHERE s.id IS NOT NULL),
            '[{"spoc_id": null, "name": null, "email": null, "mobile": null, "role": null}]'::json
          ) AS spocs
        FROM tbl_users u
        LEFT JOIN tbl_users_spoc s ON s.user_id = u.id AND s.is_deleted = 0
        LEFT JOIN tbl_company c ON u.company_id = c.id
        WHERE u.id = ANY($1)
        GROUP BY u.id, c.company_name
      `;
  
      db.any(query, [userIds, rfqNo])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(new Error(err));
        });
    });
  },

  getAllSpocs: async (limit = 10, offset = 0, status = null) => {
    return new Promise(function (resolve, reject) {
      let statusFilter = '';
      if (status !== null && status !== undefined) {
        statusFilter = ` AND tus.status = ${parseInt(status, 10)}`;
      }
      db.any(
        `SELECT tus.id,
                tus.user_id,
                tus.name,
                tus.email,
                tus.mobile,
                tus.role,
                tus.status,
                COALESCE(tc.company_name, tu.organization_name) AS vendor_name,
                creator.name AS created_by_name,
                COUNT(*) OVER() AS total_count
         FROM tbl_users_spoc tus
         JOIN tbl_users tu ON tu.id = tus.user_id
         LEFT JOIN tbl_company tc ON tu.company_id = tc.id
         LEFT JOIN tbl_users creator ON creator.id = tus.created_by
         WHERE (tus.is_deleted = 0 OR tus.is_deleted IS NULL)${statusFilter}
         ORDER BY tus.created_at DESC
         LIMIT $1 OFFSET $2;`,
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

  // Add SPOC for vendor - consolidated function
  add_user_spoc: async (spocObj) => {
    return new Promise(function (resolve, reject) {
      const status = spocObj.status ?? 1; // default approved
      const createdBy = spocObj.created_by ?? null;
      db.any(
        `INSERT INTO tbl_users_spoc (user_id, name, email, mobile, role, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING *;`,
         [spocObj.user_id, spocObj.spoc_name, spocObj.spoc_email, spocObj.spoc_mobile, spocObj.spoc_role, status, createdBy]
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

  // Check if exactly same SPOC exists
  check_exactly_same_spoc: async (spocObj) => {
    return new Promise(function (resolve, reject) {
      // Convert user_id to an integer if it's supposed to be a bigint
      const userId = parseInt(spocObj.user_id, 10);

      db.any(
        `SELECT * FROM tbl_users_spoc
          WHERE user_id = $1
          AND name = $2
          AND email = $3
          AND mobile = $4
          AND role = $5;`,
         [userId, spocObj.spoc_name, spocObj.spoc_email, spocObj.spoc_mobile, spocObj.spoc_role]
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
};

export default vendorModel;