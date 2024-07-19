import db, { pgp } from '../config/dbConn.js';
import Config from '../config/app.config.js';

const rolesModel = {
  createSubadminUser: async (usrobj) => {
    // console.log('usrobj-->', usrobj);
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_users(name,email, mobile, user_type, status, password, created_by, new_profile_image, original_profile_image) 
        values($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [
          usrobj.name,
          usrobj.email,
          usrobj.mobile,
          usrobj.register_as,
          usrobj.status,
          usrobj.password,
          usrobj.created_by,
          usrobj.fileName,
          usrobj.originalFilename
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
  subadminEmailExist: async (email) => {
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
  subadminMobileExist: async (mobile) => {
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
  getSubAdminList: async (limit, offset, name) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (name) {
        dynamicQuery += `AND name  ILIKE '%${name}%'`;
      }
      /* if (organization) {
        dynamicQuery += `AND organization_name  ILIKE '%${organization}%'`;
      }
      if (verified == 't') {
        dynamicQuery += `AND status = 1 `;
      } else if (verified == 'f') {
        dynamicQuery += `AND status = 0 `;
      } */
      db.any(
        `SELECT tbl_users.*,
        CASE
        WHEN new_profile_image IS NULL THEN
        NULL
        ELSE new_profile_image
        END AS profile_image  FROM tbl_users WHERE is_deleted = 0 AND user_type = 5  ${dynamicQuery}
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
  getSubAdminDrop: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT id,name  FROM tbl_users WHERE is_deleted = 0 AND user_type = 5 AND status = 1 
        ORDER BY name asc `
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
  getMenuList: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT id,tile  FROM tbl_role_menu WHERE is_deleted = 0 AND status = 1  
        ORDER BY tile asc `
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
  getSubAdminCount: async (name) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (name) {
        dynamicQuery += `AND name  ILIKE '%${name}%'`;
      }
      /*  if (organization) {
        dynamicQuery += `AND organization_name  ILIKE '%${organization}%'`;
      }
      if (verified == 't') {
        dynamicQuery += `AND status = 1 `;
      } else if (verified == 'f') {
        dynamicQuery += `AND status = 0 `;
      } */
      db.one(
        `SELECT COUNT(id) FROM tbl_users WHERE is_deleted = 0 AND user_type = 5 ${dynamicQuery}`
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
  subadminIDExist: async (subadminId) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_users WHERE id = $1', [subadminId])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getSubadminDetails: async (subadminId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT *,CASE
      WHEN tbl_users.	new_profile_image IS NULL THEN
      NULL
      ELSE tbl_users.new_profile_image
      END AS image_url FROM tbl_users WHERE id = $1`,
        [subadminId]
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
  getRolePermissionDetails: async (subadminId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT TRP.*,TRM.tile  FROM tbl_role_permission TRP LEFT JOIN tbl_role_menu TRM ON TRP.menu_id = TRM.id WHERE TRP.user_id = $1`,
        [subadminId]
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
  updateSubadmin: async (subadminId, subadminObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_users set 
				name = '${subadminObj.name}',
			
				mobile = '${subadminObj.mobile}',
				new_profile_image = '${subadminObj.fileName}',
				original_profile_image = '${subadminObj.originalFilename}',
				updated_by = '${subadminObj.updatedBy}'
       	where id=($1)`,
        [subadminId, subadminObj]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  deletePermissionByUserId: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any('DELETE from tbl_role_permission where user_id = $1', [user_id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  addRolePermission: async (menu_id, user_id) => {
    // console.log('usrobj-->', usrobj);
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_role_permission(menu_id, user_id) 
        values($1, $2) returning id`,
        [menu_id, user_id]
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
  createNotification: async (usrobj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_notifications(sender_user_id, type, title, message, additional_data) 
        values($1, $2,$3,$4,$5) returning id`,
        [
          usrobj.sender_user_id,

          usrobj.type,
          usrobj.title,
          usrobj.message,
          usrobj.additional_data
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
  createNotification: async (usrobj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_notifications(sender_user_id, type, title, message, additional_data) 
        values($1, $2,$3,$4,$5) returning id`,
        [
          usrobj.sender_user_id,

          usrobj.type,
          usrobj.title,
          usrobj.message,
          usrobj.additional_data
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
  addVendorReview: async (reviewObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_vendor_reviews(reviewed_by, reviewed_to, rating,  description) 
        values($1, $2,$3,$4) returning id`,
        [
          reviewObj.reviewed_by,
          reviewObj.reviewed_to,
          reviewObj.rating,
          reviewObj.description
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
  updateVendorReview: async (reviewObj, review_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_vendor_reviews set 
				rating = ${reviewObj.rating},
				description = '${reviewObj.description}'
       	where id=($2)`,
        [reviewObj, review_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  getNotificationList: async (user_id, limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'select * from tbl_notifications where sender_user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
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
  notificationDetail: async (notification_id) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_notifications where id = $1', [notification_id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  checkReviewExists: async (user_id, reviewed_to) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'select * from tbl_vendor_reviews where reviewed_by = $1 AND reviewed_to = $2',
        [user_id, reviewed_to]
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
  statusUpdateNotification: async (notification_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_notifications set 
				is_read = 1
       	where id=($1)`,
        [notification_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
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
  getAdminNotificationList: async (
    limit,
    offset,
    name,
    status,
    notification_type
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (name) {
        dynamicQuery += `AND title  ILIKE '%${name}%'`;
      }

      if (status == '1') {
        dynamicQuery += ` AND status = 1 `;
      } else if (status == '0') {
        dynamicQuery += ` AND status = 0 `;
      }
      if (notification_type == '1') {
        dynamicQuery += ` AND notification_type = '1' `;
      } else if (status == '2') {
        dynamicQuery += ` AND notification_type = '2' `;
      }
      db.any(
        `SELECT * FROM tbl_notification_setting WHERE is_deleted = 0  ${dynamicQuery}
        ORDER BY id DESC LIMIT $1 OFFSET $2`,
        [limit, offset, name, status, notification_type]
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
  getAdminNotificationCount: async (name, status, notification_type) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (name) {
        dynamicQuery += `AND title  ILIKE '%${name}%'`;
      }

      if (status == '1') {
        dynamicQuery += `AND status = 1 `;
      } else if (status == '0') {
        dynamicQuery += `AND status = 0 `;
      }
      if (notification_type == '1') {
        dynamicQuery += `AND notification_type = 1 `;
      } else if (status == '2') {
        dynamicQuery += `AND notification_type = 2 `;
      }
      db.any(
        `SELECT * FROM tbl_notification_setting WHERE is_deleted = 0  ${dynamicQuery}`,
        [name, status, notification_type]
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
  addNotificationSetting: async (notificationObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_notification_setting(title, notification_type, status, content, send_to, created_by) 
        values($1, $2,$3,$4, $5, $6) returning id`,
        [
          notificationObj.title,
          notificationObj.notification_type,
          notificationObj.status,
          notificationObj.content,
          notificationObj.send_to,
          notificationObj.createdBy
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
  notificationIDExist: async (notificationId) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_notification_setting WHERE id = $1', [
        notificationId
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
  getNotificationDetails: async (notificationId) => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_notification_setting WHERE id = $1`, [
        notificationId
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
  updateNotification: async (notificationId, notificationObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_notification_setting set 
				title = '${notificationObj.title}',
				notification_type = '${notificationObj.notification_type}',
				status = '${notificationObj.status}',
				content = '${notificationObj.content}',
				send_to = '${notificationObj.send_to}'
       	where id=($1)`,
        [notificationId, notificationObj]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  findUserAccess: async (userId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT trm.tile FROM tbl_role_permission trp
      LEFT JOIN tbl_role_menu trm ON trp.menu_id = trm.id 
      WHERE user_id = $1 AND trm.is_deleted = 0`,
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
  }
};

export default rolesModel;
