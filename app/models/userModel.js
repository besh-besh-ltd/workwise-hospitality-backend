import db, { pgp } from '../config/dbConn.js';
import Config from '../config/app.config.js';
import { logger } from '../util/logger.js';

const userModel = {

user_book_demo: async (mobile) => {
  return new Promise(function (resolve, reject) {
    db.any(
      `insert into users_book_demo(mobile) 
       values($1) returning *`,
      [ mobile ]
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
 * 
 * @param {*} user_data 
 * @param {*} company_data 
 * @returns company id, only if data successfully saved in tbl_company and tbl_user
 */

  company_registration: async (user_data, company_data, location_data = null) => {
    return new Promise((resolve, reject) => {
      db.tx(async t => {
        try {
          if (user_data.mobile) {
            user_data.mobile = user_data.mobile.toString().substring(0, 15);
          }

          // ------------------------------
          // Step 1: Insert Company
          // ------------------------------
          const companyFields = [
            "company_name", "source", "profile", "nature_of_business", "type_of_business",
            "turnover", "no_of_employess", "import_export_code", "gstin", "cin", "logo",
            "established_year", "website", "location", "is_private", "is_hospitality"
          ];

          const companyValues = companyFields.map(field => company_data?.[field] ?? null);
          const companyPlaceholders = companyFields.map((_, i) => `$${i + 1}`).join(', ');

          const insertCompanyQuery = `
            INSERT INTO tbl_company (${companyFields.join(', ')})
            VALUES (${companyPlaceholders})
            RETURNING id
          `;

          const companyResult = await t.one(insertCompanyQuery, companyValues);
          const company_id = companyResult.id;

          // ------------------------------
          // Step 2: Insert User
          // ------------------------------
          const userFields = [
            "name", "email", "mobile", "created_by", "updated_by",
            "status", "user_type", "password",
            "whatsapp", "subscription_plan_id"
          ];
          const userValues = userFields.map(f => user_data?.[f] ?? null);
          userFields.push("company_id");
          userValues.push(company_id);

          const userPlaceholders = userFields.map((_, i) => `$${i + 1}`).join(', ');

          const insertUserQuery = `
            INSERT INTO tbl_users (${userFields.join(', ')})
            VALUES (${userPlaceholders})
            RETURNING *
          `;

          const userResult = await t.one(insertUserQuery, userValues);

          if (location_data) {
            const locationFields = [
              "company_id",
              "address",
              "country_id",
              "state_id",
              "city_id",
              "postal_code",
              "created_by",
              "updated_by"
            ];

            const locationValues = [
              company_id,
              location_data?.address ?? null,
              location_data?.country_id ?? null,
              location_data?.state_id ?? null,
              location_data?.city_id ?? null,
              location_data?.postal_code ?? null,
              location_data?.created_by ?? userResult.id,
              location_data?.updated_by ?? userResult.id
            ];
            const locationPlaceholders = locationFields.map((_, i) => `$${i + 1}`).join(', ');

            await t.none(
              `
                INSERT INTO tbl_company_location (${locationFields.join(', ')})
                VALUES (${locationPlaceholders})
              `,
              locationValues
            );
          }

          resolve({
            success: true,
            company_id,
            user_id: userResult.id,
            user: userResult
          });

        } catch (error) {
          reject(error);
        }
      }).catch(err => {
        logger.error({ err }, 'Transaction error');
        reject(new Error(err));
      });
    });
  },
  update_companyDetails: async (userObj, companyObj) => {
  return db.tx(async t => {
    try {
      // 1. COMPANY UPDATE
      const companyUpdates = [];
      const companyValues = [];
      let index = 1;

      // Build company update fields
      for (const key in companyObj) {
        // Skip company_name as it's used in WHERE clause
        // if (key === 'company_name') continue;
        
        if (companyObj[key] !== null && companyObj[key] !== undefined) {
          companyUpdates.push(`${key} = $${index}`);
          companyValues.push(companyObj[key]);
          index++;
        }
      }

      if (companyValues.length === 0) {
        throw new Error("No company fields to update");
      }

      // Add company_name to the end for WHERE clause
      companyValues.push(userObj.id);
      const companyWhereIndex = companyValues.length;

      const updateCompanyQuery = `
        UPDATE tbl_company c
          SET ${companyUpdates.join(', ')}
          FROM tbl_users tu
          WHERE tu.id = $${companyWhereIndex}
            AND c.id = tu.company_id;
      `;

      logger.debug("UPDATE COMPANY QUERY => %s", updateCompanyQuery);

      // 2. USER UPDATE
      const userUpdates = [];
      const userValues = [];
      index = 1;  // Reset index for user parameters

      // Build user update fields
      for (const key in userObj) {
        // Skip email as it's used in WHERE clause
        if (key === 'id') continue;
        
        if (userObj[key] !== null && userObj[key] !== undefined) {
          userUpdates.push(`${key} = $${index}`);
          userValues.push(userObj[key]);
          index++;
        }
      }

      let userQuery = null;
      if (userValues.length > 0) {
        // Add email to the end for WHERE clause
        userValues.push(userObj.id);
        const userWhereIndex = userValues.length;

        userQuery = `
          UPDATE tbl_users
          SET ${userUpdates.join(', ')}
          WHERE id = $${userWhereIndex}

        `;
      }

      logger.debug("USER QUERY => %s", userQuery)

      // 3. EXECUTE QUERIES
      const queries = [t.any(updateCompanyQuery, companyValues)];
      if (userQuery) {
        queries.push(t.any(userQuery, userValues));
      }

      logger.debug("Batch Result %o", await t.batch(queries));

      return {
        success: true,
        message: "Company and user details updated successfully"
      };

    } catch (error) {
      // Enhanced error logging
      logger.error({ err: error, companyObj, userObj }, 'Update error details');
      throw error; // Re-throw for transaction rollback
    }
  });
  },



  insertBuyerAccountLimits: async (limitsData, company_id) => {
  return new Promise(function (resolve, reject) {
    db.none(
      `INSERT INTO tbl_company_buyer_account_limit (
         company_id,
         max_top_management,
         max_procurement,
         max_engineering,
         max_finance
       ) VALUES (
         $1, $2, $3, $4, $5
       )`,
      [
        company_id,
        limitsData.max_top_management || 0,
        limitsData.max_procurement || 0,
        limitsData.max_engineering || 0,
        limitsData.max_finance || 0
      ]
    )
    .then(() => {
      resolve({ success: true });
    })
    .catch(err => {
      logger.error({ err }, 'Error inserting into tbl_company_buyer_account_limit');
      reject(new Error(err));
    });
  });
},

  user_register: async (usrobj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_users(name, email, mobile, organization_name, user_type, password, status) 
        values($1, $2,$3,$4,$5,$6,$7) returning id`,
        [
          usrobj.name,
          usrobj.email,
          usrobj.mobile,
          usrobj.organization_name,
          usrobj.register_as,
          usrobj.password,
          usrobj.status
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

  /**
   * Whether an email or mobile is already in use, ignoring one account.
   *
   * Case-insensitive on purpose. The submit-time check compares
   * `email = $1` against a lowercased input, so a stored "Priya@example.com"
   * never matches "priya@example.com" and both accounts get created —
   * production already holds four duplicated emails and six duplicated
   * mobiles, one of them across four accounts.
   *
   * `excludeUserId` keeps an account from flagging its own details while it is
   * being edited; a warning that fires every time teaches people to ignore it.
   */
  identity_taken: async ({ email = null, mobile = null, excludeUserId = null }) => {
    const [emailRow, mobileRow] = await Promise.all([
      email
        ? db.oneOrNone(
            `SELECT 1 FROM tbl_users
              WHERE lower(email) = lower($1)
                AND COALESCE(is_deleted, 0) = 0
                AND ($2::int IS NULL OR id <> $2)
              LIMIT 1`,
            [String(email).trim(), excludeUserId]
          )
        : null,
      mobile
        ? db.oneOrNone(
            `SELECT 1 FROM tbl_users
              WHERE regexp_replace(mobile, '[^0-9]', '', 'g')
                    = regexp_replace($1, '[^0-9]', '', 'g')
                AND COALESCE(is_deleted, 0) = 0
                AND ($2::int IS NULL OR id <> $2)
              LIMIT 1`,
            [String(mobile).trim(), excludeUserId]
          )
        : null,
    ]);
    return { email: Boolean(emailRow), mobile: Boolean(mobileRow) };
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
      db.any(
        `SELECT 
            tbl_users.*, 
            COALESCE(tbl_company.is_hospitality, 0) AS is_hospitality
          FROM tbl_users 
          LEFT JOIN tbl_company ON tbl_users.company_id = tbl_company.id
          WHERE tbl_users.email = $1 
            AND tbl_users.user_type != '1' 
            AND tbl_users.is_deleted = '0'`,
        [email]
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
  getUserAuthByEmployeeCode: async (employeeCode) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT
            tbl_users.*,
            COALESCE(tbl_company.is_hospitality, 0) AS is_hospitality
          FROM tbl_users
          LEFT JOIN tbl_company ON tbl_users.company_id = tbl_company.id
          WHERE tbl_users.employee_code = $1
            AND tbl_users.user_type != '1'
            AND tbl_users.is_deleted = '0'`,
        [employeeCode]
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
  getCompanyDetail: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT c.*
   FROM tbl_users u
   JOIN tbl_company c ON u.company_id = c.id
   WHERE u.id = $1`, [user_id])
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
      db.any('select tu.*, tc.company_name from tbl_users tu join tbl_company tc ON tc.id = tu.company_id where tu.id = $1', [user_id])
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

  update_user_otp_resend: async (updateOtp) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_users set 
				otp = ($1)
       	where email=($2)`,
        [updateOtp.otp, updateOtp.email]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  userVerificationTokenUpdate: async (userObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_users set 
				token = ($1)
       	where email=($2)`,
        [userObj.token, userObj.email]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },

  user_detail_otp_exists: async (otp) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_users where otp = $1', [otp])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  update_forgot_password_status: async (otp, password) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_users set 
				password = ($2)
       	where otp=($1)`,
        [otp, password]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  /*   social_login_exist: async (id) => {
    return new Promise(function (resolve, reject) {
      db.one('select * from tbl_users where social_login_id = $1', [id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  }, */
  social_login_exist: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_users where social_login_id = $1', [id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },


  user_id_exists: async (user_id) => {
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
  findActiveVendor: async (vendor) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_users WHERE id = $1 AND user_type = 3 OR user_type = 4 AND is_deleted = 0',
        [vendor]
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
  get_vendorapprove_list: async (variant_id) => {
  return new Promise(async (resolve, reject) => {
    try {
      let data;

      if (variant_id) {
        data = await db.any(
                    `SELECT DISTINCT ON (tva.vendor_approve) tva.id, tva.vendor_approve, tva.show_in_website
          FROM tbl_vendor_approve tva
          WHERE tva.id IN (
              SELECT DISTINCT tvum.vendor_approve_id
              FROM tbl_vendorapprove_product_mapping tvum
              JOIN tbl_product_variant_vendor_mapping tpvvm ON tpvvm.id = tvum.variant_vendor_mapping_id
              WHERE tpvvm.product_variant_id = $1
                AND tpvvm.is_approved = TRUE
                AND tvum.variant_vendor_mapping_id IS NOT NULL
          )
          ORDER BY tva.vendor_approve, tva.id;
`,
          [variant_id]
        );
      } else {
        data = await db.any(`SELECT * FROM tbl_vendor_approve WHERE status = 1`);
      }

      resolve(data);
    } catch (err) {
      reject(new Error(err));
    }
  });
 },

  get_vendorreview_list: async (user_id, limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select 
          tbl_vendor_reviews.*,
          tbl_users.name as buyer_name, 
          tbl_users.email as buyer_email,
          tc.logo AS image_url 
        from tbl_vendor_reviews 
        LEFT JOIN tbl_users ON tbl_vendor_reviews.reviewed_by = tbl_users.id 
        JOIN tbl_company tc ON company_id = tc.id
          where reviewed_to = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
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
  /* user_detail_update: async (userObj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
        Users set 
        dob = '${userObj.dob}',
        nationality = '${userObj.nationality}',
        qualification_id = '${userObj.qualification_id}',
        filename = '${userObj.filename}',
        original_filename = '${userObj.original_filename}',
        area_of_interest = '${userObj.area_of_interest}',
        term_condition = '${userObj.term_condition}'
          where id= '${userObj.user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  }, */

  companyProfileCreate: async (cmpObj, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_company(company_name, location, email, mobile, gstin, cin, profile,nature_of_business,type_of_business,turnover,no_of_employess,certifications,import_export_code, user_id) 
        values($1, $2,$3,$4,$5,$6,$7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [
          cmpObj.company_name,
          cmpObj.location,
          cmpObj.email,
          cmpObj.mobile,
          cmpObj.gstin,
          cmpObj.cin,
          cmpObj.profile,
          cmpObj.nature_of_business,
          cmpObj.type_of_business,
          cmpObj.turnover,
          cmpObj.no_of_employess,
          cmpObj.certifications,
          cmpObj.import_export_code,
          user_id
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
  companyProfileVendorCreate: async (cmpObj, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_company(company_name, nature_of_business, type_of_business, turnover, no_of_employess, certifications,user_id) 
        values($1, $2,$3,$4,$5,$6, $7) returning id`,
        [
          cmpObj.company_name,
          cmpObj.nature_of_business,
          cmpObj.type_of_business,
          cmpObj.turnover,
          cmpObj.no_of_employess,
          cmpObj.certifications,
          user_id
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
  vendorApproveUserMap: async (user_id, item) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_vendorapprove_user_mapping(user_id,vendor_approve_id) 
        values($1, $2) returning id`,
        [user_id, item]
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
  companyProfileUpdate: async (cmpObj, user_id) => {
    Object.entries(cmpObj).forEach((ele) => {
      db.any(
        `UPDATE tbl_company SET ${ele[0]} = $1 WHERE id = $2`,
        [ele[1], user_id],
        (err) => {
          if (err) {
            logger.error({ err }, 'Error query in companyProfileUpdate');
            reject(err);
          } else {
            logger.debug(`Company with id ${user_id} updated.`);
            resolve();
          }
        }
      );
    });
  },
  companyProfileVendorUpdate: async (cmpObj, user_id) => {
    Object.entries(cmpObj).forEach((ele) => {
      db.any(
        `UPDATE tbl_company SET ${ele[0]} = $1 WHERE user_id = $2`,
        [ele[1], user_id],
        (err) => {
          if (err) {
            logger.error({ err }, 'Error query in companyProfileVendorUpdate');
            reject(err);
          } else {
            logger.debug(`Company with id ${user_id} updated.`);
            resolve();
          }
        }
      );
    });
  },
  userDetailUpdate: async (userObj, user_id) => {
    Object.entries(userObj).forEach((ele) => {
      db.any(
        `UPDATE tbl_users SET ${ele[0]} = $1 WHERE id = $2`,
        [ele[1], user_id],
        (err) => {
          if (err) {
            logger.error({ err }, 'Error query in userDetailUpdate');
            reject(err);
          } else {
            logger.debug(`User with id ${user_id} updated.`);
            resolve();
          }
        }
      );
    });
  },

  /**
   * The per-request identity lookup behind `jwtUsr`.
   *
   * `is_deleted` is filtered here so a removed account stops working the
   * moment it is removed, rather than surviving for the full 24-hour JWT life.
   *
   * `status` is deliberately NOT filtered, though it looks like it belongs.
   * Nine production accounts carry `status = 0` and are in daily use — one
   * with forty logins in ninety days — so adding the predicate would lock
   * working people out mid-shift. Deactivation is therefore currently partial:
   * `resolveApprovers` filters `status = 1`, so a deactivated user stops being
   * offered as an approver, but nothing stops them signing in. Closing that is
   * a decision with a data remediation attached, not a predicate.
   */
  /**
   * How many administrators a company has.
   *
   * Counts both kinds while the legacy user type still exists: an account with
   * `user_type = 7`, and an account holding the `company.admin` capability
   * through any granted role scope. Soft-deleted accounts do not count — an
   * administrator who cannot sign in is not cover.
   */
  countCompanyAdmins: async (companyId, excludeUserId = null) => {
    const row = await db.one(
      `SELECT count(DISTINCT u.id)::int AS n
         FROM tbl_users u
        WHERE u.company_id = $1
          AND COALESCE(u.is_deleted, 0) = 0
          AND ($2::int IS NULL OR u.id <> $2)
          AND (
            u.user_type = 7
            OR EXISTS (
              SELECT 1
                FROM tbl_user_role_scopes urs
                JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
                JOIN tbl_permissions p ON p.id = rp.permission_id
               WHERE urs.user_id = u.id
                 AND p.resource = 'company'
                 AND p.action = 'admin'
            )
          )`,
      [companyId, excludeUserId]
    );
    return row.n;
  },

  /**
   * Refuses to leave a company with no administrator.
   *
   * Nobody inside the company could restore one — creating and promoting
   * administrators is itself an administrator's power — so the company would
   * be locked out of its own configuration until Workwise intervened with SQL.
   * That is the trapdoor this whole phase exists to close.
   */
  assertNotLastCompanyAdmin: async (companyId, userId) => {
    const remaining = await userModel.countCompanyAdmins(companyId, userId);
    if (remaining > 0) return;
    const err = new Error(
      'This is the only administrator left. Give someone else administrator access first, ' +
      'or the company will have nobody who can manage users, units and approvals.'
    );
    err.code = 'LAST_COMPANY_ADMIN';
    err.status = 409;
    throw err;
  },

  user_detail_check: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_users where id = $1 and coalesce(is_deleted, 0) = 0', [id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  // mukul - 05-06-2025, update company logo by user id
    update_profile_image: async (user_id, filename) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `UPDATE tbl_company
         SET logo = $2
         WHERE id = (
         SELECT company_id FROM tbl_users WHERE id = $1
       )`,
        [user_id, filename]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          // var errorText = common.getErrorText(err);
          // var error = new Error(errorText);
          reject(err);
        });
    });
  },
  userinfo: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.one(
        'SELECT user_type, company_id FROM tbl_users WHERE id = $1',
        [user_id]
      )
        .then(function (userBasicInfo) {
          const { user_type, company_id } = userBasicInfo;
          
          let queryToExecute;
          let queryParams;
          
          if (user_type === 7 || user_type === 3) {
            queryToExecute = `
              SELECT tbl_users.*,
                  tbl_company.company_name,
                  tbl_company.profile,
                  tbl_company.nature_of_business,
                  tbl_company.type_of_business,
                  tbl_company.turnover,
                  tbl_company.no_of_employess,
                  tbl_company.import_export_code,
                  tbl_company.location,
                  tbl_users.mobile AS company_mobile,
                  tbl_company.gstin,
                  tbl_company.cin,
                  tbl_company.logo,
                  tbl_company.website,
                  tbl_company.established_year,
                  COALESCE(tbl_company.is_hospitality, 0) AS is_hospitality
              FROM tbl_users 
              LEFT JOIN tbl_company ON tbl_users.company_id = tbl_company.id
              WHERE tbl_users.id = $1`;
            queryParams = [user_id];
          } else {
            queryToExecute = `
              SELECT cu.*,
                  tbl_company.company_name,
                  tbl_company.profile,
                  tbl_company.nature_of_business,
                  tbl_company.type_of_business,
                  tbl_company.turnover,
                  tbl_company.no_of_employess,
                  tbl_company.import_export_code,
                  COALESCE(tbl_company.is_hospitality, 0) AS is_hospitality,
                  tbl_company.location,
                  admin_user.mobile AS company_mobile,
                  tbl_company.gstin,
                  tbl_company.cin,
                  tbl_company.logo,
                  tbl_company.website,
                  tbl_company.established_year
              FROM (
                SELECT tbl_users.*
                FROM tbl_users 
                WHERE tbl_users.id = $1
              ) cu
              LEFT JOIN tbl_users admin_user ON (admin_user.company_id = $2 AND admin_user.user_type = 7)
              LEFT JOIN tbl_company ON cu.company_id = tbl_company.id`;
            queryParams = [user_id, company_id];
          }

          db.one(queryToExecute, queryParams)
            .then(function (data) {
              resolve(data);
            })
            .catch(function (err) {
              logger.error({ err }, 'userinfo inner query failed');
              let error = new Error(err);
              reject(error);
            });
        })
        .catch(function (err) {
          logger.error({ err }, 'userinfo outer query failed');
          let error = new Error(err);
          reject(error);
        });
    });
  },
  userFileinfo: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_files  where user_id = $1', [user_id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  userapprovedbyvendor: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'select VA.id from tbl_vendorapprove_user_mapping VUM LEFT JOIN tbl_vendor_approve VA ON VUM.vendor_approve_id = VA.id where user_id = $1',
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
 vendorinfo: async (user_id, current_user = null) => {
    return new Promise(function (resolve, reject) {

      // query changes by Mukul Jatav 30-08-2024, 
      // rewrited query to reduce duplication, and included product name along with product images

      // query changes by Mukul Jatav 13-09-2024, 
      //  Remove product_images and added product_list with approved vendor list for each product in /vendor-profile/id API

      // query changes by Mukul Jatav 13-09-2024, added product_list with approved vendor list for each product in /vendor-profile/id API, this model returning product list but it's variant not changing product_name to variant_name or product_list to variant_list as this is quick fix for now

      // mukul 31-05-2025 changes as per the top management flow requerment

      // Base query with common fields
      let baseQuery = `
      SELECT tbl_users.id as user_id,
       tbl_users.name as vendor_name,
       tbl_company.logo as profile_image,
       tbl_users.status,
       tbl_users.whatsapp,
       tbl_users.subscription_plan_id,
       tbl_company.id as company_id,
       tbl_company.gstin,
       tbl_company.cin,
       tbl_company.website,
       tbl_company.nature_of_business,
       tbl_company.type_of_business,
       tbl_company.turnover,
       tbl_company.no_of_employess,
       tbl_company.import_export_code,
       tbl_company.established_year,
       tbl_company.company_name,
       tbl_company.profile,

       (
         SELECT json_agg(row_to_json(s) ORDER BY s.parent_title NULLS FIRST, s.title)
         FROM (
           SELECT DISTINCT ON (vhcs.item_type, vhcs.item_id)
             vhcs.id              AS subscription_id,
             vhcs.item_type,
             vhcs.item_id,
             c.title,
             c.parent_id,
             parent.title         AS parent_title,
             vhcs.start_date,
             vhcs.end_date,
             CASE
               WHEN vhcs.status = 'active' AND vhcs.end_date >= CURRENT_DATE THEN 'active'
               ELSE 'expired'
             END                  AS display_status
           FROM tbl_vendor_hotel_category_subscription vhcs
           JOIN tbl_category c ON c.id = vhcs.item_id
           LEFT JOIN tbl_category parent ON parent.id = c.parent_id
           WHERE vhcs.vendor_id = tbl_users.id
             AND vhcs.item_type IN ('category','subcategory')
             AND vhcs.status IN ('active','expired')
             AND c.is_deleted = 0
           ORDER BY
             vhcs.item_type,
             vhcs.item_id,
             CASE WHEN vhcs.status = 'active' AND vhcs.end_date >= CURRENT_DATE THEN 0 ELSE 1 END,
             vhcs.end_date DESC
         ) s
       ) AS subscribed_categories,

       ARRAY(
         SELECT json_build_object(
             'address', TCL.address,
             'postal_code', TCL.postal_code,
             'city_id', TCL.city_id,
             'city_name', LC.city_name,
             'state_id', TCL.state_id,
             'state_name', LS.state_name,
             'country_id', TCL.country_id,
             'country_name', LCO.country_name
         )
         FROM tbl_company_location TCL
         LEFT JOIN tbl_location_cities LC ON LC.id = TCL.city_id
         LEFT JOIN tbl_location_states LS ON LS.id = TCL.state_id
         LEFT JOIN tbl_location_country LCO ON LCO.id = TCL.country_id
         WHERE TCL.company_id = tbl_company.id
       ) AS location,

       ARRAY(
               SELECT json_build_object(
                              'brochure', tbl_files.file_name,
                              'brochure_url', tbl_files.file_path
                      )
               FROM tbl_files
               WHERE tbl_files.user_id = tbl_users.id
       ) AS "brochure",
                      ARRAY(
                  SELECT json_build_object(
                    'product_name', V.name,
                    'product_id', V.id,
                  'product_make', (
                    SELECT ARRAY_AGG(DISTINCT PVVM.make_name)
                    FROM tbl_product_variant_vendor_make PVVM
                    WHERE PVVM.variant_vendor_map_id = M.id
                  ),
                  'approved_by', (
                      SELECT ARRAY(
                        SELECT DISTINCT ON (VA.id)
                          json_build_object(
                            'vendor_approve_id', VA.id,
                            'vendor_name', VA.vendor_approve,
                            'approved_at', VM.created_at
                          )
                        FROM tbl_vendorapprove_product_mapping VM
                        LEFT JOIN tbl_vendor_approve VA ON VA.id = VM.vendor_approve_id
                        WHERE VM.variant_vendor_mapping_id = M.id
                        ORDER BY VA.id, VM.created_at DESC
                      )
                    )
                  )
                  FROM tbl_product_variant_vendor_mapping M
                  JOIN tbl_product_variant V ON V.id = M.product_variant_id

                  WHERE M.vendor_id = tbl_users.id
                  AND M.is_approved = TRUE
                  AND M.status = TRUE
                ) AS "product_list",

       CASE
           WHEN tbl_company.logo IS NULL THEN
               NULL
           ELSE tbl_company.logo
           END AS profile_image_url`;

      // Additional fields if current_user is not null
     if (current_user !== null) {
    baseQuery += `,
        tbl_users.mobile,
        tbl_users.email,
        ARRAY(
            SELECT json_build_object(
                'reviewed_by', vr.reviewed_by,
                'review_date', vr.review_date,
                'rating', vr.rating,
                'description', vr.description,
                'buyer', BU.name,
                'buyer_email', BU.email
            )
            FROM tbl_vendor_reviews vr
            LEFT JOIN tbl_users BU ON BU.id = vr.reviewed_by
            WHERE vr.reviewed_to = tbl_users.id
              AND vr.is_published = 1
        ) AS reviews,

        (
    SELECT json_agg(tvp)
    FROM tbl_vendor_profile tvp
    WHERE tvp.vendor_id = tbl_users.id and tvp.is_approved = true
) AS vendor_info,

        (
          SELECT json_agg(
            json_build_object(
              'document_type', vd.document_type,
              'document_number', vd.document_number,
              'document_url', vd.document_url,
              'uploaded_at', vd.created_at
            )
            ORDER BY vd.document_type
          )
          FROM tbl_vendor_documents vd
          WHERE vd.vendor_id = tbl_users.id
            AND vd.document_type IN ('pan','gst','msme','fssai','cancelled_cheque')
        ) AS compliance_docs,

        (
          SELECT json_build_object(
            'account_holder_name', vd.account_holder_name,
            'bank_name', vd.bank_name,
            'ifsc_code', vd.ifsc_code,
            'account_number_masked',
              CASE
                WHEN vd.bank_account_number IS NULL OR length(vd.bank_account_number) < 4 THEN NULL
                ELSE repeat('X', length(vd.bank_account_number) - 4) || right(vd.bank_account_number, 4)
              END
          )
          FROM tbl_vendor_documents vd
          WHERE vd.vendor_id = tbl_users.id
            AND vd.document_type = 'bank_account'
          LIMIT 1
        ) AS bank_details

    `;
      }

      // Completing the query with the FROM clause
      baseQuery += `
      FROM tbl_users
      LEFT JOIN tbl_company ON tbl_users.company_id = tbl_company.id
      WHERE tbl_users.id = $1`;

      // Execute the query
      db.one(baseQuery, [user_id])
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
   * Buyer-facing engagement metrics for a vendor — how much business the
   * requesting buyer's organisation has actually done with them. Combines the
   * RFQ side (the buyer's own RFQs) and the ARC / rate-contract side (scoped to
   * the buyer's hospitality companies), so the figures reflect THIS buyer's
   * history, never another tenant's.
   *
   * @param vendorId      the vendor being viewed
   * @param buyerUserId   req.user.id — scopes the RFQ side
   * @param companyIds    number[] of the buyer's hospitality companies, or null
   *                      for super admins (no company filter on the ARC side)
   */
  getVendorEngagementStats: async (vendorId, buyerUserId, companyIds) => {
    const scopeArc = Array.isArray(companyIds);
    // Empty scope array = no ARC access → match nothing (don't widen to all).
    const arcCond = scopeArc ? `AND a.hospitality_company_id = ANY($3::int[])` : ``;
    const args = scopeArc ? [vendorId, buyerUserId, companyIds] : [vendorId, buyerUserId];
    const row = await db.one(
      `SELECT
         (SELECT COUNT(DISTINCT q.rfq_id)
            FROM tbl_quotes q JOIN tbl_rfq r ON r.id = q.rfq_id
           WHERE q.created_by = $1 AND r.created_by = $2)                       AS rfq_participated,
         (SELECT COUNT(DISTINCT aq.arc_id)
            FROM tbl_arc_quote aq JOIN tbl_arc a ON a.id = aq.arc_id
           WHERE aq.vendor_id = $1 ${arcCond})                                  AS arc_participated,
         (SELECT COUNT(DISTINCT f.rfq_id)
            FROM tbl_quote_finalization f JOIN tbl_rfq r ON r.id = f.rfq_id
           WHERE f.vendor_id = $1 AND r.created_by = $2)                        AS rfq_awarded,
         (SELECT COUNT(*)
            FROM tbl_arc_contract c JOIN tbl_arc a ON a.id = c.arc_id
           WHERE c.vendor_id = $1 ${arcCond})                                   AS arc_contracts,
         (SELECT COUNT(*)
            FROM tbl_arc_callof_po cp
            JOIN tbl_arc_contract c ON c.id = cp.arc_contract_id
            JOIN tbl_arc a ON a.id = c.arc_id
           WHERE c.vendor_id = $1 ${arcCond})                                   AS released_pos,
         (SELECT COALESCE(SUM(cl.unit_rate * cl.committed_qty), 0)
            FROM tbl_arc_contract_line cl
            JOIN tbl_arc_contract c ON c.id = cl.arc_contract_id
            JOIN tbl_arc a ON a.id = c.arc_id
           WHERE c.vendor_id = $1 ${arcCond})                                   AS committed_value,
         (SELECT COALESCE(SUM(cl.unit_rate * cl.consumed_qty), 0)
            FROM tbl_arc_contract_line cl
            JOIN tbl_arc_contract c ON c.id = cl.arc_contract_id
            JOIN tbl_arc a ON a.id = c.arc_id
           WHERE c.vendor_id = $1 ${arcCond})                                   AS consumed_value`,
      args
    );
    return {
      rfqs_participated: Number(row.rfq_participated) + Number(row.arc_participated),
      contracts_awarded: Number(row.rfq_awarded) + Number(row.arc_contracts),
      pos_released: Number(row.released_pos),
      total_value: Number(row.committed_value),
      consumed_value: Number(row.consumed_value),
    };
  },

  update_change_password_status: async (user_id, password) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_users set 
				password = $2
       	where id= $1`,
        [user_id, password]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          // var errorText = common.getErrorText(err);
          // var error = new Error(errorText);
          reject(err);
        });
    });
  },
  /* social_login_exist: async (id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Users where social_login_id = '${id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  }, */

  /*   create_social_users: async (usrobj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `insert into Users(fname,lname, email,social_login_id,social_login_type,status,profile_status,password,role_id,social_login_profile_image) values( '${usrobj.first_name}', '${usrobj.last_name}', '${usrobj.email}', '${usrobj.social_login_id}', '${usrobj.login_type}','1','C','NULL','2','${usrobj.filename}')`,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results.insertId);
        }
      );
    });
  }, */
  create_social_users: async (usrobj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_users(name, email, social_login_id,social_login_type,social_login_profile_image,status,user_type,user_agent	) 
        values($1, $2,$3,$4,$5,$6,$7) returning id`,
        [
          usrobj.name,
          usrobj.email,
          usrobj.social_login_id,
          usrobj.login_type,
          usrobj.social_login_profile_image,
          '1',
          '2',
          usrobj.user_agent
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
  //end of model







  update_user_otp: async (updateOtp) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				tbl_users set 
				otp = '${updateOtp.otp}'
       	where id= '${updateOtp.user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },








  create_user_address: async (userObj) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `insert into tbl_user_address(name, gender, dob, aniversary_date, email, address, landmark, city, state, pincode, country, mobile, alternative_mobile, created_by,user_id ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
        [
          userObj.name,
          userObj.gender,
          userObj.dob,
          userObj.aniversary_date,
          userObj.email,
          userObj.address,
          userObj.landmark,
          userObj.city,
          userObj.state,
          userObj.pincode,
          userObj.country,
          userObj.mobile,
          userObj.alternative_mobile,
          userObj.created_by,
          userObj.user_id
        ]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          //	var errorText = common.getErrorText(err);
          //	var error = new Error(errorText);
          //		reject(error);
          reject(err);
        });
    });
  },


  getUserDetailByMobile: async (mobile) => {
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

  update_password_status: async (user_id, password) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_users set 
        password = $2,
        otp_status = '0'
       	where id=($1)`,
        [user_id, password]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          // var errorText = common.getErrorText(err);
          // var error = new Error(errorText);
          reject(err);
        });
    });
  },
  create_user: async (usrobj) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `insert into tbl_users(user_name, email, password, profile_image_original, profile_image_new,role_id, status) values($1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          usrobj.user_name,
          usrobj.email,
          usrobj.password,
          usrobj.profile_image_original,
          usrobj.profile_image_new,
          usrobj.role_id,
          usrobj.status
        ]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          //	var errorText = common.getErrorText(err);
          //	var error = new Error(errorText);
          //		reject(error);
          reject(err);
        });
    });
  },

  getUserAuth: async (email) => {
    return new Promise(function (resolve, reject) {
      db.any(`select * from tbl_users where status= 1 AND email = $1`, [email])
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
        file_path: item.location,
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
insertAssets: async (vendorId, files, text_content, payment_terms , file_type) => {
  const query = `
    INSERT INTO tbl_vendor_profile
    (vendor_id, file_name, file_url, file_type, text_content, payment_terms, is_approved, approved_by)
    VALUES ($1, $2, $3, $4, $5, $6, FALSE, NULL)
    RETURNING id
  `;

  let insertedRows = [];

  // Case 1: Files + optional text/payment_terms
  if (files && files.length > 0) {
    for (const f of files) {
      const values = [
        vendorId,
        f.originalname || null,
        f.location || null,
        file_type || "general",
        text_content || null,
        payment_terms || null
      ];

      const result = await db.query(query, values);
      if (result.length > 0) {
        insertedRows.push(result[0]);
      }
    }
  }

  // Case 2: Only text/payment_terms, no file
  if ((!files || files.length === 0) && (text_content || payment_terms)) {
    const values = [
      vendorId,
      null, // file_name
      null, // file_url
      file_type || "general",
      text_content || null,
      payment_terms || null
    ];

    const result = await db.query(query, values);
    if (result.length > 0) {
      insertedRows.push(result[0]);
    }
  }

  return insertedRows;
},



approveAsset: async (record_id,is_approved, approver_id) => {
  const query = `
    UPDATE tbl_vendor_profile
    SET is_approved = $3,
        approved_by = $1
    WHERE id = $2
    RETURNING id
  `;
  const values = [approver_id, record_id , is_approved];

  const result = await db.query(query, values);
  return result;
},

getAllVendorAssets: async ({ limit, offset }) => {
  return new Promise((resolve, reject) => {
    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM tbl_vendor_profile vp
      JOIN tbl_users u ON vp.vendor_id = u.id;
    `;

    const dataQuery = `
      SELECT 
        vp.*,
        u.name AS vendor_name,
        u.email AS vendor_email
      FROM tbl_vendor_profile vp
      JOIN tbl_users u ON vp.vendor_id = u.id
      ORDER BY vp.id DESC
      LIMIT $1 OFFSET $2;
    `;

    // Run count first
    db.query(countQuery)
      .then((countResult) => {
        const total = countResult[0]?.total || 0;

        db.query(dataQuery, [limit, offset])
          .then((dataResult) => {
            resolve({
              data: dataResult || [],
              total
            });
          })
          .catch((err) => reject(err));
      })
      .catch((err) => reject(err));
  });
},



getVendorReviews: async (vendor_id) => {
  try {
    const query = `
      SELECT 
        vr.id AS review_id,
        vr.rating,
        vr.description,
        vr.review_date,
        u.id AS user_id,
        u.name AS user_name,
        u.email
      FROM tbl_vendor_reviews vr
      INNER JOIN tbl_users u
        ON vr.reviewed_by = u.id
      WHERE vr.reviewed_to = $1
      ORDER BY vr.review_date DESC
    `;

    const results = await db.any(query, [vendor_id]); // ✅ pg-promise style
    return results;
  } catch (error) {
    logger.error({ err: error }, 'Error fetching vendor reviews');
    throw error;
  }
},

publishProfileReviews: async (reviewObj) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 1. First, set all reviews for that vendor to 0
    const resetQuery = `
      UPDATE tbl_vendor_reviews
      SET is_published = 0
      WHERE reviewed_to = $1
    `;
    await db.query(resetQuery, [reviewObj.user_id]);

    // 2. Then, set selected ones to 1
    const updateQuery = `
      UPDATE tbl_vendor_reviews
      SET is_published = 1
      WHERE reviewed_to = $1 AND id = ANY($2::int[])
      RETURNING *;
    `;
    const values = [reviewObj.user_id, reviewObj.review_ids];
    const result = await db.query(updateQuery, values);

    await db.query("COMMIT");
    return result || [];
  } catch (error) {
    await db.query("ROLLBACK");
    logger.error({ err: error }, 'Error publishing vendor reviews');
    throw error;
  }
},

 

 uploadFiless: async (files, user_id, doc_type) => {
    let dataArray = [];
    logger.debug({ files }, 'uploadFiless files');
    // return false;
    if (doc_type == 'brochure' || doc_type == 'ptr') {
      dataArray = {
        user_id,
        file_name: files[0].originalname,
        new_file_name: files[0].filename,
        file_path: `${Config.base_url}/user_document/${files[0].filename}`,
        file_type: files[0].mimetype,
        doc_type: doc_type
      };
    } else {
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
    }

    const keys = [
      'user_id',
      'file_name',
      'new_file_name',
      'file_path',
      'file_type',
      'doc_type'
    ];
    logger.debug({ keys }, 'uploadFiless keys');
    //return false;

    let ptrFileExist = new Promise(function (resolve, reject) {
      db.any(
        `select * from tbl_files where user_id = ${user_id} AND doc_type='ptr'`
      )
        .then(function (data) {
          logger.debug({ data }, 'ptrFileExist resolve');
          if (data.length < 1) {
            const insertQuery =
              pgp.helpers.insert(dataArray, keys, 'tbl_files') + ' RETURNING *';
            db.manyOrNone(insertQuery)
              .then(function (data) {
                resolve(data);
              })
              .catch(function (err) {
                let error = new Error(err);
                reject(error);
              });
          } else {
            let condition = `WHERE user_id = ${user_id} AND AND doc_type='ptr'`;
            const updateQuery =
              pgp.helpers.update(dataArray, keys, 'tbl_files') +
              ' ' +
              condition;
            db.manyOrNone(updateQuery)
              .then(function (data) {
                resolve(data);
              })
              .catch(function (err) {
                let error = new Error(err);
                reject(error);
              });
          }
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
    // console.log('ptrFileExist-->', ptrFileExist);
    // return false;
    /*     const query = upsert(table, columns, item, {
      constraint: 'constraint_name'
    });
    const insertQuery =
      pgp.helpers.insert(dataArray, keys, 'tbl_files') + ' RETURNING *'; */

    /*   return new Promise(function (resolve, reject) {
      db.manyOrNone(insertQuery)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    }); */
  },
  getUserById: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_users WHERE  id = $1`, [id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  updateNotificationEndpointByUserId: async (endpoint, user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_users set 
				endpoint = ($1)
       	where id=($2)`,
        [endpoint, user_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  insertLoginLog: async (logObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp.helpers.insert(logObj, null, 'tbl_login_log') + ' RETURNING id';

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
  updateAgent: async (userAgent, userId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_users set 
				user_agent = ($1)
       	where id=($2)`,
        [userAgent, userId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  insertBuyerPrivateVendor: async ({buyerId, vendorName, email, phone, productList, status = -1, is_private}) => {
    // this function insert user info in a temp user table for admin review, once admin review we will delete user from here 
    return new Promise(async (resolve, reject) => {
      try {
        // Check if a vendor with the same email already exists for the given buyerId
        const existingVendor = await db.any(
              `SELECT * 
                FROM tbl_temp_user
                WHERE buyer_id = $1 
                AND (email = $2 OR mobile = $3)`,
          [buyerId, email, phone]
        );

        if (existingVendor.length > 0) {
          return reject(new Error('Vendor_In_Review')); 
        }

        // Insert the new vendor record
        const result = await db.any(
          `INSERT INTO tbl_temp_user 
          (buyer_id, vendor_name, email, mobile, product_list, status, reject_reason, created_date, updated_date,is_private) 
          VALUES 
          ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $8) 
          RETURNING *`,
          [buyerId, vendorName, email, phone, productList, status || -1, null, is_private]
          // status -1 pending review, 0 disable user profile, 1 active user, 2 rejected
          //  added new field  is_private , whose default value is 0, until it is manually inserted 
        );
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  },
  
  getBuyerPrivateVendors: async (buyerId, limit, page) => {
    try {
      // get company_id for this buyer
      const buyer = await db.oneOrNone('SELECT company_id FROM tbl_users WHERE id = $1', [buyerId]);
      if (!buyer || !buyer.company_id) throw new Error('Buyer not found or no company associated');
      const companyId = buyer.company_id;

      return await db.any(
        `SELECT u.name, u.email, u.mobile, u.status FROM tbl_users u RIGHT JOIN tbl_buyer_private_vendors_mapping b ON u.id = b.vendor_id WHERE b.company_id = $1 ORDER BY b.id DESC LIMIT $2 OFFSET $3`,
        [companyId, limit, (page - 1) * limit]
      );

    } catch (err) {
      throw new Error(err);
    }
  },

  getBuyerPrivateVendorsCount: async (buyerId) => {
    try {
      // get company_id for this buyer
      const buyer = await db.oneOrNone('SELECT company_id FROM tbl_users WHERE id = $1', [buyerId]);
      if (!buyer || !buyer.company_id) throw new Error('Buyer not found or no company associated');
      const companyId = buyer.company_id;

      const response = await db.any(
        `SELECT COUNT(*) FROM tbl_users u RIGHT JOIN tbl_buyer_private_vendors_mapping b ON u.id = b.vendor_id WHERE b.company_id = $1`,
        [companyId]
      );

      return parseInt(response[0]?.count) || 0;

    } catch (err) {
      throw new Error(err);
    }
  },

  deleteVendorFromTempUserTable: async (vendorTempId) => {
    // delete user from temp_user table, by id
    return new Promise((resolve, reject) => {
      db.none(
        `DELETE FROM tbl_temp_user 
         WHERE id = $1`,
        [vendorTempId]
      )
        .then(() => {
          resolve({ message: 'Vendor successfully deleted' });
        })
        .catch((err) => {
          reject(err);
        });
    });
  },
  updateStatusInTempUserTable: async (vendorTempId, status, reject_reason) => {
    //  change status, 0 pending, 2 reject, 1 success
    return new Promise((resolve, reject) => {
      db.none(
        `UPDATE tbl_temp_user 
         SET status = $2, reject_reason = $3, updated_date = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [vendorTempId, status, reject_reason]
      )
        .then(() => {
          resolve({ message: 'Vendor successfully updated' });
        })
        .catch((err) => {
          reject(err);
        });
    });
  },
  updateIsPrivateOfVendorOnEmail: async (email) => {

    return new Promise((resolve, reject) => {
      db.none(
        `UPDATE tbl_company 
         SET is_private = 0
         WHERE email = $1`,
        [email]
      )
        .then(() => {
          resolve({ message: 'Vendor successfully made public' });
        })
        .catch((err) => {
          reject(err);
        });
    });
  },
  mapBuyerToVendor: async (buyerId, vendorId) => {
    // Map buyers to vendors and prioritize these vendors in search results for the buyer
    return new Promise(async (resolve, reject) => {
      try {
        // get company_id for this buyer
        const buyer = await db.oneOrNone('SELECT company_id FROM tbl_users WHERE id = $1', [buyerId]);
        if (!buyer || !buyer.company_id) return reject(new Error('Buyer not found or no company associated'));

        // check if vendor already mapped with this company
        const result = await db.any(
          `SELECT 1 FROM tbl_buyer_private_vendors_mapping WHERE company_id = $1 AND vendor_id = $2`,
          [buyer.company_id, vendorId]
        );
        if (result && result.length > 0) {
          resolve({ message: 'Vendor already mapped to this company. No changes made.' });
        } else {
          await db.none(
            `INSERT INTO tbl_buyer_private_vendors_mapping (created_by, vendor_id, company_id, created_date, updated_date)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [buyerId, vendorId, buyer.company_id]
          );
          resolve({ message: 'Vendor successfully mapped to company' });
        }
      } catch (err) {
        reject(err);
      }
    });
  },
  bulkMapBuyersToVendors: async (emailPairs, adminUserId) => {
    return new Promise(async (resolve, reject) => {
      if (!emailPairs || emailPairs.length === 0) {
        resolve({
          totalProcessed: 0,
          successfulMappings: 0,
          failedMappings: 0,
          mappedEntries: [],
          unmappedEntries: []
        });
        return;
      }

      try {
        const buyerEmailList = emailPairs.map(item => item.buyerEmail);
        const vendorEmailList = emailPairs.map(item => item.vendorEmail);
        const rowNumbers = emailPairs.map(item => item.row);
        const buyerEmails = [...new Set(buyerEmailList)];
        const vendorEmails = [...new Set(vendorEmailList)];
        
        const query = `
          WITH email_pairs AS (
            SELECT *
            FROM unnest($1::text[], $2::text[], $3::int[]) 
            AS ep(buyer_email, vendor_email, row_num)
          ),
          buyers AS (
            SELECT id AS buyer_id, email AS buyer_email, company_id
            FROM tbl_users 
            WHERE email = ANY($4) 
            AND user_type IN (2, 7, 8, 9, 10) 
            AND is_deleted = 0
          ),
          vendors AS (
            SELECT id AS vendor_id, email AS vendor_email
            FROM tbl_users 
            WHERE email = ANY($5) 
            AND user_type = 3 
            AND is_deleted = 0
          ),
          valid_pairs AS (
            SELECT ep.row_num, ep.buyer_email, ep.vendor_email, 
                   b.buyer_id, b.company_id, v.vendor_id,
                   CASE 
                     WHEN b.buyer_id IS NULL THEN 'Buyer not found'
                     WHEN v.vendor_id IS NULL THEN 'Vendor not found'
                     ELSE NULL
                   END AS error_reason
            FROM email_pairs ep
            LEFT JOIN buyers b ON ep.buyer_email = b.buyer_email
            LEFT JOIN vendors v ON ep.vendor_email = v.vendor_email
          ),
          ranked_pairs AS (
            SELECT vp.*, 
                   ROW_NUMBER() OVER (
                     PARTITION BY vp.company_id, vp.vendor_id 
                     ORDER BY vp.row_num
                   ) AS company_vendor_rank
            FROM valid_pairs vp
            WHERE vp.company_id IS NOT NULL AND vp.vendor_id IS NOT NULL
          ),
          enhanced_pairs AS (
            SELECT vp.*,
                   COALESCE(rp.company_vendor_rank, 0) AS company_vendor_rank
            FROM valid_pairs vp
            LEFT JOIN ranked_pairs rp ON vp.row_num = rp.row_num
          ),
          existing_mappings AS (
            SELECT DISTINCT rp.company_id, rp.vendor_id
            FROM ranked_pairs rp
            INNER JOIN tbl_buyer_private_vendors_mapping bpvm 
              ON rp.company_id = bpvm.company_id AND rp.vendor_id = bpvm.vendor_id
          ),
          insert_candidates AS (
            SELECT rp.*
            FROM ranked_pairs rp
            WHERE rp.company_vendor_rank = 1
          ),
          new_mappings AS (
            INSERT INTO tbl_buyer_private_vendors_mapping (created_by, vendor_id, company_id, created_date, updated_date)
            SELECT $6, ic.vendor_id, ic.company_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM insert_candidates ic
            WHERE NOT EXISTS (
              SELECT 1 FROM tbl_buyer_private_vendors_mapping bpvm 
              WHERE bpvm.company_id = ic.company_id AND bpvm.vendor_id = ic.vendor_id
            )
            RETURNING vendor_id, company_id
          )
          SELECT 
            ep.row_num,
            ep.buyer_email,
            ep.vendor_email,
            ep.vendor_id,
            COALESCE(buyer.name, 'Unknown') AS buyer_name,
            COALESCE(vendor.name, 'Unknown') AS vendor_name,
            COALESCE(buyer.email, ep.buyer_email) AS buyer_email_display,
            COALESCE(vendor.email, ep.vendor_email) AS vendor_email_display,
            CASE 
              WHEN ep.error_reason IS NOT NULL THEN ep.error_reason
              WHEN ep.company_vendor_rank > 1 THEN 'Already mapped to company'
              WHEN em.company_id IS NOT NULL THEN 'Already mapped to company'
              WHEN nm.vendor_id IS NOT NULL AND ep.company_vendor_rank = 1 THEN 'Mapped successfully'
              ELSE 'Unknown error'
            END AS status,
            CASE 
              WHEN ep.error_reason IS NOT NULL THEN false
              WHEN ep.company_vendor_rank > 1 THEN false
              WHEN em.company_id IS NOT NULL THEN false
              ELSE true
            END AS is_success
          FROM enhanced_pairs ep
          LEFT JOIN existing_mappings em ON ep.company_id = em.company_id AND ep.vendor_id = em.vendor_id
          LEFT JOIN new_mappings nm ON ep.company_id = nm.company_id AND ep.vendor_id = nm.vendor_id
          LEFT JOIN tbl_users buyer ON buyer.id = ep.buyer_id
          LEFT JOIN tbl_users vendor ON vendor.id = ep.vendor_id
          ORDER BY ep.row_num
        `;
        
        const result = await db.any(query, [
          buyerEmailList,
          vendorEmailList,
          rowNumbers,
          buyerEmails,
          vendorEmails,
          adminUserId
        ]);

        const successfulMappings = result.filter(r => r.is_success).length;
        const failedMappings = result.filter(r => !r.is_success).length;

        resolve({
          totalProcessed: result.length,
          successfulMappings,
          failedMappings,
          mappedEntries: result.filter(r => r.is_success),
          unmappedEntries: result.filter(r => !r.is_success)
        });

      } catch (error) {
        reject(error);
      }
    });
  },
  getVendorsWithBuyerNames: async () => {
    //  this query will get list of buyers vendor for review and with buyer_id it will also return buyer name
    const query = `
        SELECT 
            tu.id, 
            tu.vendor_name, 
            tu.email, 
            tu.mobile, 
            tu.product_list, 
            tu.status, 
            tu.reject_reason, 
            tu.created_date, 
            tu.updated_date, 
            u.name AS buyer_name
        FROM tbl_temp_user AS tu
        LEFT JOIN tbl_users AS u ON tu.buyer_id = u.id
    `;
    return new Promise((resolve, reject) => {
      db.any(query)
        .then(data => resolve(data))
        .catch(err => reject(new Error(err)));
    });
  },
  company_exist: async (email,mobile) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT *
        FROM tbl_company
        WHERE email = $1
        OR mobile = $2;`,
        [email,mobile]
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
  user_exist: async (email,mobile) => {
    return new Promise(function (resolve, reject) {
      logger.debug({ email }, 'user_exist check');
      db.any(
        `SELECT *
        FROM tbl_users
        WHERE (email = $1 AND $1 IS NOT NULL)
        OR (mobile = $2 AND $2 IS NOT NULL);`,
        [email,mobile]
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

  
  user_rfq_access_review: async (rfq_id, user_id, user_type) => {
    let query = null;
    let values = [];
    // Sanitize input values
    rfq_id = parseInt(rfq_id, 10); // Ensure rfq_id is an integer
    user_id = parseInt(user_id, 10); // Ensure user_id is an integer
    user_type = parseInt(user_type, 10); // Ensure user_type is an integer
    // Construct the parameterized query based on user type
    if ([2, 8, 9, 10].includes(user_type) ) {
        query = `
            SELECT 1 FROM tbl_rfq
            WHERE id = $1 AND created_by = $2
            UNION
            SELECT 1 FROM tbl_project_team
            WHERE project_id = (
              SELECT project_id FROM tbl_rfq WHERE id = $1
            ) AND user_id = $2;
          `;
      values = [rfq_id, user_id]; // Use parameterized values
    } else if (user_type === 3) {
      query = `SELECT 1
               FROM tbl_rfq_product_vendors
               WHERE rfq_id = $1
               AND user_id = $2;`;
      values = [rfq_id, user_id]; // Use parameterized values
    }
    return new Promise((resolve, reject) => {
      if (!query) {
        return reject(new Error('Invalid user type'));
      }
      db.any(query, values)
        .then((data) => {
          // If data is not empty, return true, otherwise false
          resolve(data.length > 0);
        })
        .catch((err) => {
          let error = new Error('Database query failed');
          error.details = err; // Add detailed error for potential logging
          reject(error);
        });
    });
  },

  getCompanyUsersDetailed: async (company_id, { page = 1, limit = 10, search = '', status, companyFilter, hotelFilter } = {}) => {
    const values = [company_id];
    let paramIndex = 2;
    let statusClause = '';
    let searchClause = '';
    let companyClause = '';
    let hotelClause = '';

    if (status === 'active' || status === 'inactive') {
      statusClause = `AND tu.status = $${paramIndex}`;
      values.push(status === 'active' ? 1 : 0);
      paramIndex++;
    }

    if (search && search.trim()) {
      const q = `%${search.trim()}%`;
      searchClause = `AND (tu.name ILIKE $${paramIndex} OR tu.email ILIKE $${paramIndex} OR tu.employee_code ILIKE $${paramIndex})`;
      values.push(q);
      paramIndex++;
    }

    if (companyFilter) {
      companyClause = `AND EXISTS (SELECT 1 FROM tbl_hospitality_user_mappings hum_f WHERE hum_f.user_id = tu.id AND hum_f.hospitality_company_id = $${paramIndex})`;
      values.push(companyFilter);
      paramIndex++;
    }

    if (hotelFilter) {
      hotelClause = `AND EXISTS (SELECT 1 FROM tbl_hospitality_user_mappings hum_f WHERE hum_f.user_id = tu.id AND hum_f.hospitality_hotel_id = $${paramIndex})`;
      values.push(hotelFilter);
      paramIndex++;
    }

    const whereClause = `
      WHERE tu.company_id = $1
        AND tu.is_deleted = 0
        ${statusClause}
        ${searchClause}
        ${companyClause}
        ${hotelClause}
    `;

    const countQuery = `SELECT COUNT(*) AS total FROM tbl_users tu ${whereClause}`;

    const dataQuery = `
      SELECT
        tu.id, tu.name, tu.email, tu.mobile, tu.user_type, tu.status,
        tu.created_at, tu.employee_type, tu.employee_code, tu.designation,
        tu.payroll_company_id,
        COALESCE(
          (SELECT json_agg(json_build_object('id', d.id, 'title', d.title) ORDER BY d.title)
           FROM tbl_user_department ud
           JOIN tbl_department d ON d.id = ud.department_id
           WHERE ud.user_id = tu.id
          ), '[]'::json
        ) AS departments,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'id', urs.id,
            'role_id', urs.role_id,
            'role_title', r.title,
            'company_id', urs.company_id,
            'hotel_id', urs.hotel_id,
            'department_id', urs.department_id
          ) ORDER BY r.title)
           FROM tbl_user_role_scopes urs
           JOIN tbl_roles r ON r.id = urs.role_id
           WHERE urs.user_id = tu.id
          ), '[]'::json
        ) AS role_scopes,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'id', hum.id,
            'mapping_type', hum.mapping_type,
            'hospitality_company_id', hum.hospitality_company_id,
            'hospitality_hotel_id', hum.hospitality_hotel_id,
            'auto_map_projects', hum.auto_map_projects,
            'company_name', hc.name,
            'hotel_name', hh.name
          ))
           FROM tbl_hospitality_user_mappings hum
           JOIN tbl_hospitality_companies hc ON hc.id = hum.hospitality_company_id AND hc.is_deleted = 0
           LEFT JOIN tbl_hospitality_company_hotels hh ON hh.id = hum.hospitality_hotel_id AND (hh.is_deleted = 0 OR hh.id IS NULL)
           WHERE hum.user_id = tu.id
          ), '[]'::json
        ) AS mappings
      FROM tbl_users tu
      ${whereClause}
      ORDER BY tu.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const offset = (page - 1) * limit;
    const dataValues = [...values, limit, offset];

    const [countResult, users] = await Promise.all([
      db.one(countQuery, values),
      db.any(dataQuery, dataValues)
    ]);

    return { users, total: parseInt(countResult.total, 10) };
  },

  getCompanyUsersStats: async (company_id) => {
    const query = `
      SELECT
        COUNT(DISTINCT tu.id) FILTER (WHERE tu.status = 1) AS active_count,
        COUNT(DISTINCT tu.id) FILTER (WHERE tu.status != 1) AS inactive_count,
        COUNT(DISTINCT tu.id) AS total_count,
        COUNT(DISTINCT hum.user_id) AS mapped_count
      FROM tbl_users tu
      LEFT JOIN tbl_hospitality_user_mappings hum ON hum.user_id = tu.id
      WHERE tu.company_id = $1 AND tu.is_deleted = 0
    `;
    return db.one(query, [company_id]);
  },

  // Changes by Agnij 28-05-2025 [Added function to get users by company ID]
  getCompanyUsers: async (company_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT tu.id, tu.name, tu.email, tu.mobile, tu.user_type, tu.status, tu.created_at,
                tu.employee_type, tu.employee_code, tu.designation, tu.payroll_company_id
         FROM tbl_users tu
         WHERE tu.company_id = $1 AND tu.is_deleted = 0
         ORDER BY tu.created_at DESC`,
        [company_id]
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
  userExistsById: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.oneOrNone(
        `SELECT 1 FROM tbl_users WHERE id = $1`,
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

  /*  uploadFiles: async (files, user_id, doc_type) => {
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

    // const insertQuery =  pgp.helpers.insert(dataArray, keys, 'tbl_files') + ' RETURNING *';
    const upsertQuery = pgp.helpers.upsert('tbl_files', keys, dataArray, {
      user_id: user_id,
      doc_type: 'ptr'
    }); // constraint_name is the unique constraint on your table

    return new Promise(function (resolve, reject) {
      db.manyOrNone(upsertQuery)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  } */

  updateUserAccount: async (userId, userObj) => {
    return new Promise(function (resolve, reject) {
      const updateFields = [];
      const queryParams = [userId];
      let paramCounter = 2;
      
      Object.entries(userObj).forEach(([key, value]) => {
        if (value !== undefined) {
          updateFields.push(`${key} = $${paramCounter++}`);
          queryParams.push(value);
        }
      });
      
      if (updateFields.length === 0) return resolve([]);
      
      const query = `
        UPDATE tbl_users SET ${updateFields.join(', ')}
        WHERE id = $1
        RETURNING id, name, email, mobile, status, updated_at, updated_by
      `;
      
      db.any(query, queryParams)
        .then(data => resolve(data))
        .catch(err => reject(err));
    });
  },

getBuyerAccountLimits: async (company_id) => {
  return new Promise((resolve, reject) => {
    db.any(
      `
      SELECT 
        cl.max_top_management, 
        cl.max_procurement, 
        cl.max_engineering, 
        cl.max_finance,
        COUNT(CASE WHEN u.user_type = 8 THEN 1 END) AS used_top_management,
        COUNT(CASE WHEN u.user_type = 2 THEN 1 END) AS used_procurement,
        COUNT(CASE WHEN u.user_type = 9 THEN 1 END) AS used_engineering,
        COUNT(CASE WHEN u.user_type = 10 THEN 1 END) AS used_finance
      FROM 
        tbl_company_buyer_account_limit cl
      LEFT JOIN 
        tbl_users u ON u.company_id = cl.company_id AND u.is_deleted = 0
      WHERE 
        cl.company_id = $1
      GROUP BY 
        cl.max_top_management, cl.max_procurement, cl.max_engineering, cl.max_finance;
      `,
      [company_id]
    )
      .then((data) => {
        resolve(data); 
      })
      .catch((err) => {
        logger.error({ err }, 'Error fetching buyer account limits');
        reject(new Error(err));
      });
  });
},

  saveVendorDocument: async (vendorId, documentType, documentUrl, documentNumber = null, bankDetails = null) => {
    return new Promise(async (resolve, reject) => {
      try {
        const query = `
          INSERT INTO tbl_vendor_documents (
            vendor_id, 
            document_type, 
            document_url, 
            document_number,
            bank_account_number,
            bank_name,
            ifsc_code,
            account_holder_name,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
          ON CONFLICT (vendor_id, document_type) 
          DO UPDATE SET
            document_url = EXCLUDED.document_url,
            document_number = EXCLUDED.document_number,
            bank_account_number = EXCLUDED.bank_account_number,
            bank_name = EXCLUDED.bank_name,
            ifsc_code = EXCLUDED.ifsc_code,
            account_holder_name = EXCLUDED.account_holder_name,
            updated_at = NOW()
          RETURNING id
        `;
        
        const values = [
          vendorId,
          documentType,
          documentUrl,
          documentNumber,
          bankDetails?.bank_account_number || null,
          bankDetails?.bank_name || null,
          bankDetails?.ifsc_code || null,
          bankDetails?.account_holder_name || null
        ];
        
        const result = await db.one(query, values);
        resolve(result);
      } catch (error) {
        logger.error({ err: error }, 'Error saving vendor document');
        reject(error);
      }
    });
  },

  getVendorDocuments: async (vendorId) => {
    return db.any(
      `SELECT * FROM tbl_vendor_documents WHERE vendor_id = $1 ORDER BY created_at DESC`,
      [vendorId]
    );
  },

};

export default userModel;
