import db, { pgp } from '../config/dbConn.js';
import Config from '../config/app.config.js';

const userModel = {
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
        `select * from tbl_users where email = $1 AND user_type != '1' AND is_deleted = '0'`,
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
  getCompanyDetail: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_company where user_id = $1', [user_id])
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

  clear_forgot_otp_user: async (otp) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				tbl_users set 
				otp = ''
       	where otp= '${otp}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
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
  get_vendorapprove_list: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_vendor_approve')
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  get_vendorreview_list: async (user_id, limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select tbl_vendor_reviews.*,tbl_users.name as buyer_name, tbl_users.email as buyer_email,
        CASE
        WHEN tbl_users.new_profile_image IS NULL THEN
        NULL
        ELSE tbl_users.new_profile_image
        END AS image_url  from tbl_vendor_reviews LEFT JOIN tbl_users ON tbl_vendor_reviews.reviewed_by = tbl_users.id  where reviewed_to = ${user_id} ORDER BY id DESC LIMIT $2 OFFSET $3`,
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
  checkVendorApproveDetail: async (user_id, approve_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_vendorapprove_user_mapping WHERE user_id = $1 AND vendor_approve_id = $2',
        [user_id, approve_id]
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
  /*   companyProfileUpdate: async (cmpObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
        tbl_company set 
        company_name = $1,
        location = $2,
        email = $3,
        mobile = $4,
        gstin = $5,
        cin = $6,
        profile = $7
          where user_id= $8`,
        [
          cmpObj.company_name,
          cmpObj.location,
          cmpObj.email,
          cmpObj.mobile,
          cmpObj.gstin,
          cmpObj.cin,
          cmpObj.profile,
          cmpObj.user_id
        ]
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
  }, */
  /*   companyProfileUpdate: async (cmpObj, user_id) => {
    console.log(`cmpObj---------->`, cmpObj);
    console.log(`user_id---------->`, user_id);
    db.query(
      'UPDATE tbl_company SET ? WHERE user_id = ?',
      [cmpObj, user_id],
      (err) => {
        if (err) {
          console.log(`Error query---------->`);
          reject(err);
        } else {
          console.log(`Comapny with id ${user_id} updated.`);
          resolve();
        }
      }
    );
  }, */
  companyProfileUpdate: async (cmpObj, user_id) => {
    Object.entries(cmpObj).forEach((ele) => {
      db.any(
        `UPDATE tbl_company SET ${ele[0]} = $1 WHERE user_id = $2`,
        [ele[1], user_id],
        (err) => {
          if (err) {
            console.log(`Error query---------->`);
            reject(err);
          } else {
            console.log(`Comapny with id ${user_id} updated.`);
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
            console.log(`Error query---------->`);
            reject(err);
          } else {
            console.log(`Comapny with id ${user_id} updated.`);
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
            console.log(`Error query---------->`);
            reject(err);
          } else {
            console.log(`Comapny with id ${user_id} updated.`);
            resolve();
          }
        }
      );
    });
  },

  user_detail_check: async (id) => {
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

  update_profile_image: async (user_id, filename, original_filename) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_users set 
				new_profile_image = $2,
				original_profile_image = $3
       	where id= $1`,
        [user_id, filename, original_filename]
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
        `select tbl_users.*,tbl_company.mobile as company_mobile,tbl_company.gstin,
        tbl_company.cin,tbl_company.profile,tbl_company.company_name,tbl_company.location,
        tbl_company.import_export_code,tbl_company.certifications,tbl_company.nature_of_business,
        tbl_company.type_of_business,tbl_company.turnover,tbl_company.no_of_employess,
        tbl_location_states.state_name , tbl_location_cities.city_name  
        from tbl_users 
        left join tbl_company on tbl_users.id = tbl_company.user_id  
        LEFT JOIN tbl_location_states on tbl_users.state = tbl_location_states.id
        LEFT JOIN tbl_location_cities on tbl_users.city = tbl_location_cities.id
        where tbl_users.id = $1`,
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

  vendorinfo: async (current_user, user_id) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `SELECT tbl_users.id as user_id,tbl_users.name as vendor_name,
        tbl_users.new_profile_image as profile_image,
        tbl_users.address,
        tbl_users.dob,
        tbl_users.nationality,
        tbl_users.status,
        tbl_company.id as company_id,
        tbl_company.gstin,
        tbl_company.cin,
        tbl_company.website,
        tbl_company.nature_of_business,
        tbl_company.type_of_business,
        tbl_company.turnover,
        tbl_company.no_of_employess,
        tbl_company.import_export_code,
        tbl_company.certifications,
        tbl_company.mobile,
        tbl_company.email,
        tbl_company.company_name,
        tbl_company.profile,
        tbl_company.location,
        ARRAY
        (SELECT json_build_object('vendor_approve', tbl_vendor_approve.vendor_approve,'vendor_approve', tbl_vendor_approve.vendor_approve,'id',tbl_vendor_approve.id, 'vendor_approve_url',  CASE
        WHEN tbl_vendor_approve.vendor_logo IS NULL THEN
        NULL
        ELSE tbl_vendor_approve.vendor_logo
        END)
          FROM tbl_vendorapprove_user_mapping VM left join tbl_vendor_approve on tbl_vendor_approve.id = VM.vendor_approve_id  WHERE  tbl_users.id = VM.user_id) AS "vendor_approve",
        ARRAY
          (SELECT json_build_object('brochure',tbl_files.file_name,'brochure_url', tbl_files.file_path )
            FROM tbl_files  WHERE  tbl_files.user_id = tbl_users.id) AS "brochure",
        ARRAY
          (SELECT json_build_object('reviewed_by',tbl_vendor_reviews.reviewed_by,'review_date',tbl_vendor_reviews.review_date,'rating',tbl_vendor_reviews.rating,'description',tbl_vendor_reviews.description,'buyer',BU.name,'buyer_email',BU.email )
            FROM tbl_vendor_reviews  left join tbl_users BU on BU.id = tbl_vendor_reviews.reviewed_by  WHERE  tbl_vendor_reviews.reviewed_to = tbl_users.id AND tbl_vendor_reviews.reviewed_by = ${current_user}) AS "reviews",
        ARRAY
          (SELECT json_build_object('product_image', tbl_product_images.new_image_name,'product_image_url',  CASE
          WHEN tbl_product_images.new_image_name IS NULL THEN
          NULL
          ELSE tbl_product_images.new_image_name
          END)
            FROM tbl_product P left join tbl_product_images on P.id = tbl_product_images.product_id  WHERE  P.vendor = tbl_users.id) AS "product_images",
        CASE
        WHEN tbl_users.new_profile_image IS NULL THEN
        NULL
        ELSE tbl_users.new_profile_image
        END AS profile_image_url
        from tbl_users 
        left join tbl_company on tbl_users.id = tbl_company.user_id 
         where tbl_users.id = $1`,
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

  /*   vendorinfo: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `SELECT tbl_users.id as user_id,tbl_users.name as vendor_name,
        tbl_users.new_profile_image as profile_image,
        tbl_users.address,
        tbl_users.dob,
        tbl_users.nationality,
        tbl_users.status,
        tbl_company.id as company_id,
        tbl_company.gstin,
        tbl_company.cin,
        tbl_company.website,
        tbl_company.nature_of_business,
        tbl_company.type_of_business,
        tbl_company.turnover,
        tbl_company.no_of_employess,
        tbl_company.import_export_code,
        tbl_company.certifications,
        tbl_company.mobile,
        tbl_company.email,
        tbl_company.company_name,
        tbl_company.profile,
        tbl_company.location,
        ARRAY
        (SELECT json_build_object('vendor_approve', tbl_vendor_approve.vendor_approve,'vendor_approve', tbl_vendor_approve.vendor_approve,'id',tbl_vendor_approve.id, 'vendor_approve_url',  CASE
        WHEN tbl_vendor_approve.vendor_logo IS NULL THEN
        NULL
        ELSE concat('${Config.base_url}/vendor_approve/',tbl_vendor_approve.vendor_logo)
        END)
          FROM tbl_vendorapprove_user_mapping VM left join tbl_vendor_approve on tbl_vendor_approve.id = VM.vendor_approve_id  WHERE  tbl_users.id = VM.user_id) AS "vendor_approve",
        ARRAY
          (SELECT json_build_object('brochure',tbl_files.file_name,'brochure_url', tbl_files.file_path )
            FROM tbl_files  WHERE  tbl_files.user_id = tbl_users.id) AS "brochure",
        ARRAY
          (SELECT json_build_object('reviewed_by',tbl_vendor_reviews.reviewed_by,'review_date',tbl_vendor_reviews.review_date,'rating',tbl_vendor_reviews.rating,'description',tbl_vendor_reviews.description)
            FROM tbl_vendor_reviews  WHERE  tbl_vendor_reviews.reviewed_to = tbl_users.id) AS "reviews",
        ARRAY
          (SELECT json_build_object('product_image', tbl_product_images.new_image_name,'product_image_url',  CASE
          WHEN tbl_product_images.new_image_name IS NULL THEN
          NULL
          ELSE concat('${Config.base_url}/product_image/',tbl_product_images.new_image_name)
          END)
            FROM tbl_product P left join tbl_product_images on P.id = tbl_product_images.product_id  WHERE  P.vendor = tbl_users.id) AS "product_images",
        CASE
        WHEN tbl_users.new_profile_image IS NULL THEN
        NULL
        ELSE concat('${Config.base_url}/user_image/',tbl_users.new_profile_image)
        END AS profile_image_url
        from tbl_users 
        left join tbl_company on tbl_users.id = tbl_company.user_id 
         where tbl_users.id = $1`,
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
  }, */
  /*   update_change_password_status: async (user_id, password) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
        Users set 
        password = '${password}'
          where id = '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  }, */
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
  user_register_temp: async (usrobj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `insert into temp_users(fname, lname, email, mobile, password,  role_id, token, fcm_id) values( '${usrobj.first_name}', '${usrobj.last_name}', '${usrobj.email}', '${usrobj.mobile}', '${usrobj.password}','${usrobj.role_id}','${usrobj.verificationToken}','${usrobj.fcm_id}')`,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results.insertId);
        }
      );
    });
  },
  agent_register: async (usrobj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `insert into Users(fname, lname, email, mobile, password,  role_id, fcm_id) values( '${usrobj.first_name}','${usrobj.last_name}', '${usrobj.email}', '${usrobj.mobile}', '${usrobj.password}','${usrobj.role_id}','${usrobj.fcm_id}')`,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results.insertId);
        }
      );
    });
  },
  agent_user_update: async (compObj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update Users SET fname = '${compObj.first_name}', lname = '${compObj.last_name}', mobile = '${compObj.mobile}',password = '${compObj.password}',fcm_id = '${compObj.fcm_id}' WHERE email = '${compObj.email}' `,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results);
        }
      );
    });
  },
  agent_user_status_update: async (compObj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update Users SET profile_status= 'C' WHERE id = '${compObj.user_id}' `,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results);
        }
      );
    });
  },
  company_user_update: async (compObj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update company_users SET company_name = '${compObj.company_name}', address = '${compObj.address}' WHERE user_id = '${compObj.user_id}' `,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results);
        }
      );
    });
  },
  company_register: async (compObj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `insert into company_users(user_id, company_name, address) values( '${compObj.user_id}','${compObj.company_name}', '${compObj.address}')`,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results.insertId);
        }
      );
    });
  },
  company_update: async (compObj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update company_users SET company_id = '${compObj.company_id}', agent_id = '${compObj.agent_id}', agent_photo = '${compObj.filename}',signature = '${compObj.filename_signature}' WHERE user_id = '${compObj.user_id}' `,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results.insertId);
        }
      );
    });
  },
  company_signature_update: async (compObj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update company_users SET signature = '${compObj.filename}' WHERE user_id = '${compObj.user_id}' `,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results.insertId);
        }
      );
    });
  },
  enquiry_submit: async (enqObj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `insert into Enquiries(fname, lname, email, mobile, description_dtl,contact_type, createdAt) values( '${enqObj.first_name}', '${enqObj.last_name}', '${enqObj.email}', '${enqObj.phone}', '${enqObj.message}', '${enqObj.contact_type}', '${enqObj.created_at}')`,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results.insertId);
        }
      );
    });
  },
  contact_submit: async (enqObj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `insert into Enquiries(fname, lname, email, mobile, country, city, area_of_interest, description_dtl,contact_type, createdAt) values( '${enqObj.first_name}', '${enqObj.last_name}', '${enqObj.email}', '${enqObj.phone}', '${enqObj.country}','${enqObj.city}','${enqObj.area_of_interest}', '${enqObj.message}', '${enqObj.contact_type}', '${enqObj.created_at}')`,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results.insertId);
        }
      );
    });
  },

  agent_user_email_exist: async (email) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Users where email = '${email}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  agent_user_mobile_exist: async (mobile) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Users where mobile = '${mobile}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  agent_user_id_exist: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Users where id = '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_course_list: async (limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select Courses.*,Universities.university as university_name, Countries.countryname as country_name from Courses 
        LEFT JOIN Countries ON Courses.country_code = Countries.countrycode 
        LEFT JOIN Universities ON Courses.university_id = Universities.id 
        where Courses.is_deleted != '1'  ORDER BY Courses.course_name ASC LIMIT ${limit} OFFSET ${offset} `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_blog_detail: async (blog_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Blogs where id = '${blog_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_blog_count: async () => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select count(*) AS blog_count from Blogs`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_blog_list: async (limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Blogs ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${offset} `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_student_list_by_agent: async (user_id, limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select A.*, (select B.fname from Users B where A.created_by = B.id) as created_fname, (select B.lname from Users B where A.created_by = B.id) as created_lname from Users A where A.agent_id = '${user_id}' and A.role_id='3'  ORDER BY A.fname ASC LIMIT ${limit} OFFSET ${offset} `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_student_list_by_agent_count: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Users where agent_id = ${user_id} and role_id='3'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  assigned_councellors_by_student_id: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select B.* from Users A, Users B where A.id = ${user_id} and A.councellor_id = B.id`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  assigned_agent_by_student_id: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select B.* from Users A, Users B where A.id = ${user_id} and A.agent_id = B.id`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },

  get_course_count: async () => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select count(*) AS course_count from Courses 
        where Courses.is_deleted != '1'   `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_finance_course_list: async () => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select finance_courses.*, Countries.countryname as country_name from finance_courses 
        LEFT JOIN Countries ON finance_courses.country_code = Countries.countrycode 
         where finance_courses.finance_course_type = 'finance' AND finance_courses.is_deleted != '1' order by createdAt desc LIMIT 3 `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_finance_course_list_details: async (course_type, limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select finance_courses.*, Countries.countryname as country_name from finance_courses 
        LEFT JOIN Countries ON finance_courses.country_code = Countries.countrycode 
         where finance_courses.finance_course_type = '${course_type}' AND finance_courses.is_deleted != '1' order by finance_courses.course_name ASC LIMIT ${limit} OFFSET ${offset} `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_finance_course_list_count: async (course_type) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select finance_courses.* from finance_courses
         where finance_courses.finance_course_type = '${course_type}' AND finance_courses.is_deleted != '1'  `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_document: async (document_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from All_documents where id = ${document_id} `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  delete_document: async (document_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `DELETE FROM All_documents WHERE id = ${document_id} `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_scholarship_course_list: async () => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select finance_courses.*,Countries.countryname as country_name from finance_courses 
        LEFT JOIN Countries ON finance_courses.country_code = Countries.countrycode 
         where finance_courses.finance_course_type = 'scholarship' AND finance_courses.is_deleted != '1' order by createdAt desc LIMIT 3 `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_other_course_list: async () => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select finance_courses.*, Countries.countryname as country_name from finance_courses 
        LEFT JOIN Countries ON finance_courses.country_code = Countries.countrycode 
         where finance_courses.finance_course_type = 'other' AND finance_courses.is_deleted != '1' order by createdAt desc LIMIT 3 `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  submit_application_passport_details: async (data, user_id) => {
    return new Promise(function (resolve, reject) {
      // check if already exists
      var exist_query = `SELECT COUNT(*) AS total_items FROM Appl_passport_info WHERE user_id = ${data.user_id}`;
      db.query(exist_query, function (error, row_counts, fields) {
        var query = '';
        if (row_counts[0].total_items > 0) {
          // update the existing data
          query = `
             UPDATE Appl_passport_info
             SET
              passport_no = '${data.passport_no}',
              issue_date = '${data.issue_date}',
              exp_date = '${data.exp_date}',
              issue_country = '${data.issue_country}',
              issue_place = '${data.issue_place}',
              birth_country = '${data.birth_country}',
              nationality = '${data.nationality}',
              citizen = '${data.citizen}',
              citizen_other_country = '${data.citizen_other_country}',
              living_studying_other_country = '${data.living_studying_other_country}',
              applied_immigration = '${data.applied_immigration}',
              medical_condition = '${data.medical_condition}',
              visa_refusal = '${data.visa_refusal}',
              criminal_record = '${data.criminal_record}',
              gurdian_name = '${data.gurdian_name}',
              gurdian_relation = '${data.gurdian_relation}',
              gurdian_email = '${data.gurdian_email}'
             WHERE
               application_id = ${data.application_id};
             `;
        } else {
          // add new data
          // personal info table data
          query = `
             INSERT INTO Appl_passport_info(
              application_id, 
              created_by,
              user_id,
              passport_no, 
              issue_date, 
              exp_date, 
              issue_country, 
              issue_place, 
              birth_country, 
              nationality, 
              citizen, 
              citizen_other_country, 
              living_studying_other_country, 
              applied_immigration, 
              medical_condition, 
              visa_refusal, 
              criminal_record, 
              gurdian_name, 
              gurdian_relation, 
              gurdian_email
             ) 
             VALUES (            
               ${data.application_id},
               ${user_id},
               ${data.user_id},
               '${data.passport_no}',
               '${data.issue_date}',
               '${data.exp_date}',
               '${data.issue_country}',
               '${data.issue_place}',
               '${data.birth_country}',
               '${data.nationality}',
               '${data.citizen}',
               '${data.citizen_other_country}',
               '${data.living_studying_other_country}',
               '${data.applied_immigration}',
               '${data.medical_condition}',
               '${data.visa_refusal}',
               '${data.criminal_record}',
               '${data.gurdian_name}',
               '${data.gurdian_relation}',
               '${data.gurdian_email}'
             )`;
        }
        db.query(query, function (error, results, fields) {
          if (error) throw error;
          // Passport data query here ===>
          resolve(results);
        });
      });
    });
  },

  get_app_id: async (data, user_id) => {
    return new Promise(function (resolve, reject) {
      var q = `SELECT id FROM Master_applications WHERE created_by = ${user_id} AND course_id = ${data.course_id}`;
      db.query(q, function (error, results, fields) {
        if (error) throw error;
        // Passport data query here ===>
        resolve(results);
      });
    });
  },
  processEducation: async (education) => {
    return new Promise((resolve, reject) => {
      const id = education.id;

      // Check if the education with the given id exists
      db.query(
        'SELECT * FROM Appl_academic_info WHERE id = ?',
        [id],
        (err, [existingEducation]) => {
          if (err) {
            reject(err);
            return;
          }

          if (existingEducation) {
            // If it exists, update the entry
            db.query(
              'UPDATE Appl_academic_info SET ? WHERE id = ?',
              [education, id],
              (err) => {
                if (err) {
                  reject(err);
                } else {
                  console.log(`Education with id ${id} updated.`);
                  resolve();
                }
              }
            );
          } else {
            // If it doesn't exist, insert a new entry
            db.query(
              'INSERT INTO Appl_academic_info SET ?',
              education,
              (err) => {
                if (err) {
                  reject(err);
                } else {
                  console.log(`New education with id ${id} added.`);
                  resolve();
                }
              }
            );
          }
        }
      );
    });
  },
  processWorkExp: async (item) => {
    return new Promise((resolve, reject) => {
      const id = item.id;

      // Check if the item with the given id exists
      db.query(
        'SELECT * FROM Appl_work_exp WHERE id = ?',
        [id],
        (err, [existingWorkexp]) => {
          if (err) {
            reject(err);
            return;
          }

          if (existingWorkexp) {
            // If it exists, update the entry
            db.query(
              'UPDATE Appl_work_exp SET ? WHERE id = ?',
              [item, id],
              (err) => {
                if (err) {
                  reject(err);
                } else {
                  console.log(`item with id ${id} updated.`);
                  resolve();
                }
              }
            );
          } else {
            // If it doesn't exist, insert a new entry
            db.query('INSERT INTO Appl_work_exp SET ?', item, (err) => {
              if (err) {
                reject(err);
              } else {
                console.log(`New item with id ${id} added.`);
                resolve();
              }
            });
          }
        }
      );
    });
  },
  processEnglishTest: async (item) => {
    return new Promise((resolve, reject) => {
      const id = item.id;

      // Check if the item with the given id exists
      db.query(
        'SELECT * FROM Appl_english_test WHERE id = ?',
        [id],
        (err, [existingEnglishTest]) => {
          if (err) {
            reject(err);
            return;
          }

          if (existingEnglishTest) {
            // If it exists, update the entry
            db.query(
              'UPDATE Appl_english_test SET ? WHERE id = ?',
              [item, id],
              (err) => {
                if (err) {
                  reject(err);
                } else {
                  console.log(`item with id ${id} updated.`);
                  resolve();
                }
              }
            );
          } else {
            // If it doesn't exist, insert a new entry
            db.query('INSERT INTO Appl_english_test SET ?', item, (err) => {
              if (err) {
                reject(err);
              } else {
                console.log(`New item with id ${id} added.`);
                resolve();
              }
            });
          }
        }
      );
    });
  },

  get_course_search_list: async (
    course_name,
    country_code,
    is_pgwp,
    state_id,
    discipline_id,
    programe_type,
    intake_id,
    english_type,
    tution_fee,
    application_fee,
    duration
  ) => {
    var query_string = '';
    if (course_name != undefined && course_name != '') {
      query_string += `AND Courses.course_name LIKE '%${course_name}%' `;
    }
    if (country_code != undefined && country_code != '') {
      query_string += `AND Courses.country_code LIKE '%${country_code}%' `;
    }
    if (is_pgwp != undefined && is_pgwp != '') {
      query_string += `AND Courses.is_pgwp = '${is_pgwp}' `;
    }
    if (state_id != undefined && state_id != '') {
      query_string += `AND Courses.state_id = '${state_id}' `;
    }
    if (discipline_id != undefined && discipline_id != '') {
      query_string += `AND Courses.discipline_id = '${discipline_id}' `;
    }
    if (programe_type != undefined && programe_type != '') {
      query_string += `AND Courses.programe_type = '${programe_type}' `;
    }
    if (intake_id != undefined && intake_id != '') {
      query_string += `AND Courses.intake_id = '${intake_id}' `;
    }
    if (english_type != undefined && english_type != '') {
      query_string += `AND Courses.ets LIKE '%${english_type}%' `;
    }
    if (tution_fee != undefined && tution_fee != '') {
      query_string += `AND Courses.tution_fees > 1 AND Courses.tution_fees <= ${tution_fee}  `;
    }
    if (application_fee != undefined && application_fee != '') {
      query_string += `AND Courses.course_fees > 1 AND Courses.course_fees <= ${application_fee}  `;
    }
    if (duration != undefined && duration != '') {
      query_string += `AND Courses.course_duration_month > 1 AND Courses.course_duration_month <= ${duration}  `;
    }

    let query = `
    SELECT DISTINCT
        Courses.id,
        Courses.*, 
        Universities.university AS university_name, 
        Countries.countryname AS country_name 
    FROM 
        Courses 
        LEFT JOIN Countries ON Courses.country_code = Countries.countrycode
        LEFT JOIN Universities ON Courses.university_id = Universities.id
    WHERE 
        Courses.is_deleted != '1' 
        ${query_string};
    `;
    // console.log('query-->', query);
    return new Promise(function (resolve, reject) {
      db.query(query, function (error, results, fields) {
        if (error) throw error;
        resolve(results);
      });
      // db.query(
      //   `select Courses.*,Universities.university as university_name, Countries.countryname as country_name from Courses
      //   LEFT JOIN Countries ON Courses.country_code = Countries.countrycode
      //   LEFT JOIN Universities ON Courses.university_id = Universities.id
      //   where Courses.is_deleted != '1' ${query_string}  `,
      //   function (error, results, fields) {
      //     if (error) throw error;
      //     resolve(results);
      //   }
      // );
    });
  },
  get_university_list: async (limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select Universities.*, Countries.countryname from Universities
        LEFT JOIN Countries ON Universities.country_code = Countries.countrycode  
        where status = '1' ORDER BY Universities.university ASC LIMIT ${limit} OFFSET ${offset}`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_university_count: async () => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select count(*) AS course_count from Universities
        where status = '1' `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_university_search_list: async (
    university_name,
    country_code,
    is_pgwp,
    state_id,
    discipline_id,
    programe_type,
    intake_id
  ) => {
    var query_string = '';
    if (university_name != undefined && university_name != '') {
      query_string += `AND Universities.university LIKE '%${university_name}%' `;
    }
    if (country_code != undefined && country_code != '') {
      query_string += `AND Universities.country_code LIKE '%${country_code}%' `;
    }
    if (is_pgwp != undefined && is_pgwp != '') {
      query_string += `AND Universities.is_pgwp = '${is_pgwp}' `;
    }
    if (state_id != undefined && state_id != '') {
      query_string += `AND Universities.state_id = '${state_id}' `;
    }
    if (discipline_id != undefined && discipline_id != '') {
      query_string += `AND Universities.discipline_id = '${discipline_id}' `;
    }
    if (programe_type != undefined && programe_type != '') {
      query_string += `AND Universities.programe_type = '${programe_type}' `;
    }
    if (intake_id != undefined && intake_id != '') {
      query_string += `AND Universities.intake_id = '${intake_id}' `;
    }

    let query = `
    SELECT DISTINCT
        Universities.id,
        Universities.*,
        Countries.countryname
    FROM
        Universities
        LEFT JOIN Countries ON Universities.country_code = Countries.countrycode
    WHERE
        Universities.status = '1'
        ${query_string};
    `;
    console.log(query);
    return new Promise(function (resolve, reject) {
      // let qq = `select Universities.*, Countries.countryname from Universities
      // LEFT JOIN Countries ON Universities.country_code = Countries.countrycode
      // where status = '1' ${query_string}`;
      // console.log('qq-->', qq);
      db.query(query, function (error, results, fields) {
        if (error) throw error;
        resolve(results);
      });
    });
  },

  user_mobile_temp_exists: async (mobile) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from temp_users where mobile = '${mobile}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  agent_user_mobile_exists: async (mobile) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Users where mobile = '${mobile}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  user_mobile_exists: async (mobile) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Users where mobile = '${mobile}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },

  get_banner_content: async (page_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Cms_banners where page_id = '${page_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_page_section_content: async (page_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Cms_page_sections where page_id = '${page_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_cms_contents: async (table) => {
    return new Promise(function (resolve, reject) {
      db.query(`select * from ${table}`, function (error, results, fields) {
        if (error) throw error;
        resolve(results);
      });
    });
  },
  update_user_temp_otp: async (updateOtp) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				temp_users set 
				otp = '${updateOtp.otp}'
       	where id= '${updateOtp.user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  update_user_temp_otp_resend: async (updateOtp) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				temp_users set 
				otp = '${updateOtp.otp}'
       	where email= '${updateOtp.email}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },

  update_user_temp_verfication: async (email, token) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				temp_users set 
				status = '1'
       	where email= '${email}' AND token = '${token}' AND status= '0'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results.affectedRows);
        }
      );
    });
  },
  update_user_otp: async (updateOtp) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				Users set 
				otp = '${updateOtp.otp}'
       	where id= '${updateOtp.user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  user_detail_exists: async (otp) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from temp_users where otp = '${otp}' AND status = '0'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },

  update_session: async (user_id, session_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				Users set 
				session_id = '${session_id}'
       	where id= '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  update_otp_status_temp: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				temp_users set 
				status = '1'
       	where id= '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  update_otp_status: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				Users set 
				status = '1'
       	where id= '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },

  user_preference_update: async (userObj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				Users set 
				qualification_id = '${userObj.qualification_id}',
				area_of_interest = '${userObj.area_of_interest}'
       	where id= '${userObj.user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  user_detail_update_profile_status: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				Users set 
				profile_status = 'C'
       	where id= '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  qualification_list: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from qualification order by title asc`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },

  area_interest_list: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from area_interest order by title asc`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_country_list: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Countries order by countryname asc`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_disciplines: async (table) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from ${table} order by id asc`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_state_list: async (country_code) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from States where country_code = '${country_code}' order by stateName asc`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_intake_list: async (country_code) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Intakes  order by id asc`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_application_id: async (course_id, user_id) => {
    // let test = `select id from Master_applications where course_id = '${course_id}' AND created_by = '${user_id}'`;
    //console.log('test-->', test);
    return new Promise(function (resolve, reject) {
      db.query(
        `select id,university_id,intake,year,remarks from Master_applications where course_id = '${course_id}' AND created_by = '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          //   console.log('results-->', results);
          resolve(results);
        }
      );
    });
  },

  university_id_exists: async (university_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Universities where id = '${university_id}'`,
        function (error, results, fields) {
          if (error) throw error;

          resolve(results);
        }
      );
    });
  },
  get_university_course_list: async (university_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select ucm.*,Courses.*,Universities.university,Countries.countryname as country_name from university_course_mapping ucm 
        left join Courses on ucm.course_id = Courses.id 
        left join Countries on Courses.country_code = Countries.countrycode
        left join Universities on ucm.university_id = Universities.id 
        where ucm.university_id = '${university_id}'`,
        function (error, results, fields) {
          if (error) throw error;

          resolve(results);
        }
      );
    });
  },
  get_academic_info: async (application_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Appl_academic_info  
        where application_id = '${application_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_englist_test: async (application_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Appl_english_test  
        where application_id = '${application_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_passport_info: async (application_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Appl_passport_info  
        where application_id = '${application_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_personal_info: async (application_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Appl_personal_info  
        where application_id = '${application_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_status_info: async (application_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Appl_status  
        where application_id = '${application_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_work_exp_info: async (application_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Appl_work_exp  
        where application_id = '${application_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_university_detail: async (university_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select Universities.*,Countries.countryname as country_name from Universities 
        LEFT JOIN Countries ON Universities.country_code = Countries.countrycode 
        where id = '${university_id}'`,
        function (error, results, fields) {
          if (error) throw error;

          resolve(results);
        }
      );
    });
  },
  user_id_temp_exists: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from temp_users where id = '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          //   console.log('results-->', results);
          resolve(results);
        }
      );
    });
  },
  fcm_exists_exists: async (fcm_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from temp_users where fcm_id = '${fcm_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          //   console.log('results-->', results);
          resolve(results);
        }
      );
    });
  },
  document_id_exists: async (document_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from All_documents where id = '${document_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          //   console.log('results-->', results);
          resolve(results);
        }
      );
    });
  },
  get_term_condition: async (fcm_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select term_condition from Gensettings where id = '1'`,
        function (error, results, fields) {
          if (error) throw error;
          //   console.log('results-->', results);
          resolve(results);
        }
      );
    });
  },
  user_temp_to_users: async (usrobj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `insert into Users(fcm_id,fname, lname, email, mobile, password,  role_id, status, otp, token, admin_approval_status) values('${usrobj.fcm_id}', '${usrobj.fname}', '${usrobj.lname}', '${usrobj.email}', '${usrobj.mobile}', '${usrobj.password}','${usrobj.role_id}','${usrobj.status}','${usrobj.otp}','${usrobj.token}','${usrobj.admin_approval_status}')`,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results);
        }
      );
    });
  },
  user_detail: async (id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Users where id = '${id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },

  update_user_document: async (user_id, document, document_original) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				Users set 
				document = '${document}',
				document_original = '${document_original}'
       	where id = '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  add_user_document: async (user_id, doc_name, document, document_original) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `insert into user_documents(user_id,doc_name,doc_type,file_name, original_filename) values('${user_id}', '${doc_name}','doc', '${document}', '${document_original}')`,
        function (error, results, fields) {
          if (error) throw error;

          resolve(results);
        }
      );
    });
  },
  application_status_save: async (application_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `insert into Appl_status(application_id,status) values('${application_id}', 'pending')`,
        function (error, results, fields) {
          if (error) throw error;

          resolve(results);
        }
      );
    });
  },

  clear_forgot_otp_user_temp: async (otp) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				temp_users set 
				otp = ''
       	where otp= '${otp}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },

  user_detail_existss: async (mobile, otp, otp_status) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'select * from tbl_users where mobile = $1 and otp=$2 and otp_status=$3',
        [mobile, otp, otp_status]
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

  get_all_user: async () => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_users')
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
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

  user_otp_exists: async (otp) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_users where otp	 = $1', [otp])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
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

  address_id_exists: async (address_id) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_user_address where id = $1', [address_id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  update_user_address: async (userObj) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `update 
        tbl_user_address set 
        name = ($1),
        gender = ($2),
        dob = ($3),
        aniversary_date = ($4),
        email = ($5),
        address = ($6),
        landmark = ($7),
        city = ($8),
        state = ($9),
        pincode = ($10),
        country = ($11),
        mobile = ($12),
        alternative_mobile = ($13)
	    where id=($14) returning id`,
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
          userObj.address_id
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
  get_all_user_address: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'select * from tbl_user_address where created_by = $1 order by created_at desc',
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
  delete_address: async (address_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `delete from 
        tbl_user_address 
       	 where id=($1)`,
        [address_id]
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

  occasion_id_exists: async (occasion_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'select * from tbl_occasion_of_purchase where id = $1 AND status = 1',
        [occasion_id]
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
  get_university_by_courseid: async (course_id) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT Universities.*,
      CASE WHEN Courses.id IS NOT NULL THEN 'true' ELSE 'false' END AS is_main_university
FROM Universities
LEFT JOIN Courses ON Universities.id = Courses.university_id
                 AND Courses.id = ${course_id};`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_highest_grades: async (course_id) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT * FROM Appl_education_levels`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_english_tests_names: async (course_id) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT * FROM Appl_englishtests_lists`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  upload_application_documents: async (
    user_id,
    file_name,
    files,
    doc_type_id
  ) => {
    console.log('files model-->', files);
    // return false;
    return new Promise(function (resolve, reject) {
      let items = [];

      files.map((item) => {
        items.push({
          user_id,
          doc_type: item.mimetype,
          file_name: file_name ? file_name : item.originalname,
          path: `${item.destination}${item.filename}`,
          doc_name: item.filename,
          status: 1,
          institute: '',
          doc_type_id
        });
      });

      var columnQ = '';
      var rowQuery = [];
      items.map((item) => {
        const keys = Object.keys(item);
        const values = Object.values(item).map((value) =>
          typeof value === 'string' ? `'${value}'` : value
        );
        const columns = keys.map((key) => `${key}`).join(', ');
        columnQ = `INSERT INTO All_documents (${columns}) VALUES `;
        const dataValues = values.join(', ');

        rowQuery.push(`(${dataValues})`);
      });

      db.query(
        `${columnQ + rowQuery.join(',')}`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_all_documents: async (user_id) => {
    return new Promise(function (resolve, reject) {
      // let query = `SELECT * FROM All_documents WHERE user_id =${user_id}`;
      let query = `SELECT All_documents.*, User_document_types.Name
      FROM All_documents
      LEFT JOIN User_document_types ON All_documents.doc_type_id = User_document_types.id
      WHERE All_documents.user_id = ${user_id} ORDER BY All_documents.id DESC`;
      // console.log('files user_id-->', query);
      // return false;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  getDocumentDetails: async (doc_id) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT * FROM All_documents WHERE id =${doc_id}`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_all_applications: async (user_id) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT Master_applications.*,Courses.course_name,Courses.course_fees FROM Master_applications 
      LEFT JOIN Courses ON Master_applications.course_id = Courses.id
      WHERE Master_applications.created_by = ${user_id} ORDER BY Master_applications.id DESC`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  update_application_transaction: async (
    application_id,
    transaction_id,
    payment_gateway_id
  ) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update Master_applications SET transaction_id = '${transaction_id}',payment_gateway_id = '${payment_gateway_id}' WHERE id = '${application_id}' `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  update_application_final_status: async (transaction_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update Master_applications SET payment_status = 'S' WHERE transaction_id = '${transaction_id}' `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_application_by_id: async (application_id) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT * FROM Master_applications WHERE Master_applications.id = ${application_id}`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_active_payment_gateway: async (application_id) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT * FROM Payment_gateways WHERE is_active = '1'`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_applications_transactions: async (application_id) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT Master_applications.*,payment_details.strpe_pay_status,payment_details.payment_date,payment_details.payment_mode,payment_details.email, payment_details.address   FROM Master_applications LEFT JOIN payment_details ON Master_applications.transaction_id =  payment_details.transaction_id WHERE Master_applications.id = ${application_id} and Master_applications.transaction_id IS NOT NULL`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_document_application_id: async (application_id) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT AD.document_id AS doc_id FROM Appl_documents AD WHERE AD.application_id = ${application_id}`;
      // console.log('query-->', query);
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_documents_details: async (document_arr) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT AD.*  FROM All_documents AD WHERE AD.id IN ('${document_arr}')`;
      // console.log('query2-->', query);
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  update_pay_status: async (application_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update Master_applications SET is_payment_added = '1' WHERE id = '${application_id}' `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  create_transaction: async (transactionObj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `insert into payment_details(user_id, transaction_id, application_id_arr, amount, payment_status, pay_status, payment_date, payment_mode, email ) values( '${transactionObj.user_id}', '${transactionObj.transaction_id}', '${transactionObj.application_id_arr}', '${transactionObj.amount}', '${transactionObj.payment_status}','${transactionObj.pay_status}','${transactionObj.payment_date}','${transactionObj.payment_mode}','${transactionObj.email}')`,
        function (error, results, fields) {
          if (error) throw error;
          //console.log('user_id--->', results.insertId);

          resolve(results.insertId);
        }
      );
    });
  },
  update_stripe_transaction: async (transactionObj) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update payment_details SET name = '${transactionObj.name}',mobile = '${transactionObj.mobile}',payment_status = '${transactionObj.payment_status}',pay_status = '${transactionObj.pay_status}',email = '${transactionObj.email}' WHERE transaction_id = '${transactionObj.transaction_id}' `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  del_payment: async (application_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update Master_applications SET is_payment_added = '0' WHERE id = '${application_id}' `,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  },
  get_course_by_id: async (course_id, fileds) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT ${fileds.join(
        ','
      )} FROM Courses WHERE id = ${course_id}`;

      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_university_by_id: async (university_id, fileds) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT ${fileds.join(
        ','
      )} FROM Universities WHERE id = ${university_id}`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_user_by_id: async (user_id, fileds) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT ${fileds.join(',')} FROM Users WHERE id = ${user_id}`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_appl_status: async (appl_id, fileds) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT ${fileds.join(
        ','
      )} FROM Appl_status WHERE application_id = ${appl_id}`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  getMenus: async () => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT * FROM Cms_menus`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_ap_details: async (appl_id, table) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT * FROM ${table} WHERE application_id = ${appl_id}`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  addApplicationStatus: async (applicaiton_id, status) => {
    return new Promise(function (resolve, reject) {
      let query = `INSERT INTO Appl_status (application_id,status) VALUES (${applicaiton_id}, '${status}')`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_document_types: async (user_id) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT * FROM User_document_types`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  get_user_info: async (table, user_id) => {
    return new Promise(function (resolve, reject) {
      let query = `SELECT * FROM ${table} where user_id=${user_id}`;
      db.query(query, function (error, results, fields) {
        if (error) reject(error);
        resolve(results);
      });
    });
  },
  add_student: async (usrobj, created_by_user) => {
    let name = usrobj.name.split(' ');
    return new Promise(function (resolve, reject) {
      var exist_query1 = `SELECT * FROM Users WHERE email = '${usrobj.email}'`;
      db.query(exist_query1, function (error, row_counts, fields) {
        console.log('row_counts', row_counts);
        var query = '';
        if (row_counts[0]?.id) {
          resolve(row_counts[0]?.id);
        } else {
          // insert into
          query = `insert into Users(fname, lname, email, mobile, password,  role_id, admin_approval_status, agent_id, created_by) values( '${
            name[0]
          }', '${name.length > 0 ? name[1] : ''}', '${usrobj.email}', '${
            usrobj.phone
          }', '${
            usrobj.password
          }',3,'verified', ${created_by_user},${created_by_user})`;
          db.query(query, function (error, results, fields) {
            if (error) throw error;
            resolve(results.insertId);
          });
        }
      });
    });
  },
  add_student_document: async (
    user_id,
    file_name,
    files,
    doc_type_id,
    created_by
  ) => {
    return new Promise(function (resolve, reject) {
      let items = [];

      files.map((item) => {
        items.push({
          user_id,
          created_by,
          doc_type: item.mimetype,
          file_name: file_name ? file_name : item.originalname,
          path: `${item.destination}${item.filename}`,
          doc_name: item.filename,
          status: 1,
          institute: '',
          doc_type_id
        });
      });

      var columnQ = '';
      var rowQuery = [];
      items.map((item) => {
        const keys = Object.keys(item);
        const values = Object.values(item).map((value) =>
          typeof value === 'string' ? `'${value}'` : value
        );
        const columns = keys.map((key) => `${key}`).join(', ');
        columnQ = `INSERT INTO All_documents (${columns}) VALUES `;
        const dataValues = values.join(', ');

        rowQuery.push(`(${dataValues})`);
      });

      db.query(
        `${columnQ + rowQuery.join(',')}`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
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

  uploadFiless: async (files, user_id, doc_type) => {
    let dataArray = [];
    console.log('files-->', files);
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

    console.log('dataArray-->', dataArray);
    const keys = [
      'user_id',
      'file_name',
      'new_file_name',
      'file_path',
      'file_type',
      'doc_type'
    ];
    console.log('keys-->', keys);
    //return false;

    let ptrFileExist = new Promise(function (resolve, reject) {
      db.any(
        `select * from tbl_files where user_id = ${user_id} AND doc_type='ptr'`
      )
        .then(function (data) {
          console.log('ptrFileExist resolve-->', data);
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
  setCommunicationSettings: async (user_id, email, sms, type_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT * FROM tbl_communication_settings WHERE type_id=$1 AND user_id = $2`,
        [type_id, user_id]
      )
        .then((res) => {
          if (res.length > 0) {
            db.any(
              `update 
          tbl_communication_settings set 
          email = ($1),
          sms = ($2)
           where type_id=$3 AND user_id = $4 RETURNING *`,
              [email, sms, type_id, user_id]
            )
              .then(function (data) {
                resolve(data);
              })
              .catch(function (err) {
                reject(err);
              });
          } else {
            db.any(
              `insert into tbl_communication_settings(type_id, email, sms, user_id) 
              values($1, $2,$3,$4) RETURNING *`,
              [type_id, email, sms, user_id]
            )
              .then(function (data) {
                resolve(data);
              })
              .catch(function (err) {
                reject(err);
              });
          }
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  communicationSettingsListCTRL: async () => {
    return new Promise(function (resolve, reject) {
      db.query(`SELECT * FROM tbl_communication_settings_types`)
        .then((res) => {
          resolve(res);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  getCommunicationSettings: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `SELECT type_id,email,sms FROM tbl_communication_settings WHERE user_id=${user_id}`
      )
        .then((res) => {
          resolve(res);
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
  }
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
};

export default userModel;
