import db from '../config/dbConn.js';
import Config from '../config/app.config.js';
import pgp from 'pg-promise';

const cmsModel = {
  homeBanner: async (page_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select *,
      CASE
      WHEN tbl_cms_banner.image IS NULL THEN
      NULL
      ELSE tbl_cms_banner.image
      END AS image_url from tbl_cms_banner where page_id = $1 AND status = 1 order by id desc LIMIT 1`,
        [page_id]
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
  pageSectionContent: async (page_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'select * from tbl_cms_page_sections where page_id = $1 AND is_deleted = 0 AND status = 1 order by id asc',
        [page_id]
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
  faqListing: async () => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_faq WHERE status = 1 order by question asc')
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  mediaListing: async () => {
    return new Promise(function (resolve, reject) {
      db.one(
        `select *,
      CASE
      WHEN tbl_media.thumbnail_image IS NULL THEN
      NULL
      ELSE tbl_media.thumbnail_image
      END AS thumbnail_url from tbl_media where is_featured ='1'`
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
  blogListing: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select tbl_blog.*,tbl_blog_category.title as blog_category, 
        CASE
        WHEN tbl_blog.image IS NULL THEN
        NULL
        ELSE tbl_blog.image
        END AS image_url  
        from tbl_blog LEFT JOIN tbl_blog_category on tbl_blog_category.id = tbl_blog.blog_cat_id 
        WHERE tbl_blog.status = 1
        order by title asc`
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
  /*   companyListing: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select tbl_company_logo.*,
        CASE
        WHEN tbl_company_logo.image IS NULL THEN
        NULL
        ELSE concat('${Config.base_url}/company_image/',tbl_company_logo.image)
        END AS image_url from tbl_company_logo  order by title asc`
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
  companyListing: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select tbl_vendor_approve.*,
        CASE
        WHEN tbl_vendor_approve.vendor_logo IS NULL THEN
        NULL
        ELSE tbl_vendor_approve.vendor_logo
        END AS image_url from tbl_vendor_approve  WHERE status = 1 AND show_in_website = 1  order by id desc`
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
  /*   testimonialListing: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select tbl_testimonials.*,tbl_users.new_profile_image,tbl_users.user_type,tbl_users.name,
        CASE
        WHEN tbl_users.new_profile_image IS NULL THEN
        NULL
        ELSE concat('${Config.base_url}/user_image/',tbl_users.new_profile_image)
        END AS user_url,
        CASE
        WHEN tbl_testimonials.thumbnail_image IS NULL THEN
        NULL
        ELSE concat('${Config.base_url}/testimonial_image/',tbl_testimonials.thumbnail_image)
        END AS image_url from tbl_testimonials LEFT JOIN tbl_users on tbl_users.id = tbl_testimonials.created_by 
        WHERE tbl_testimonials.status = 1
        order by title asc`
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
  testimonialListing: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select tbl_testimonials.*,tbl_users.new_profile_image,tbl_users.user_type,tbl_users.name,
        CASE
        WHEN tbl_testimonials.created_image IS NULL THEN
        NULL
        ELSE tbl_testimonials.created_image
        END AS created_image_url,
        CASE
        WHEN tbl_testimonials.thumbnail_image IS NULL THEN
        NULL
        ELSE tbl_testimonials.thumbnail_image
        END AS image_url from tbl_testimonials LEFT JOIN tbl_users on tbl_users.id = tbl_testimonials.created_by 
        WHERE tbl_testimonials.status = 1
        order by title asc`
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
  productListing: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select tbl_product.*,tbl_product_images.new_image_name,
        CASE
        WHEN tbl_product.description IS NULL THEN
        NULL
        ELSE SUBSTRING(tbl_product.description,0,120)
        END AS short_description,
        CASE
        WHEN tbl_product_images.new_image_name IS NULL THEN
        NULL
        ELSE tbl_product_images.new_image_name
        END AS image_url from tbl_product 
        LEFT JOIN tbl_product_images on tbl_product.id = tbl_product_images.product_id AND tbl_product_images.is_featured = '1'
        where  tbl_product.status = '1' AND tbl_product.is_featured = 1 AND tbl_product.is_review = 0 AND tbl_product.is_approve = 1
        order by name asc`
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
  managementList: async (management_type) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select tbl_management.*,
        CASE
        WHEN tbl_management.profile_image IS NULL THEN
        NULL
        ELSE tbl_management.profile_image
        END AS profile_image_url 
         from tbl_management where management_type = $1 order by name asc`,
        [management_type]
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
  contactUsInsert: async (contactObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_contact_us(name, email, phone, subject, comment, submitted_from) 
        values($1,$2,$3,$4,$5,$6) returning id`,
        [
          contactObj.name,
          contactObj.email,
          contactObj.phone,
          contactObj.subject,
          contactObj.comment,
          contactObj.submitted_from
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
  bannerInsert: async (page_id, content, filename, status, created_by) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_cms_banner(page_id, content, image, status, created_by  ) 
        values($1,$2,$3,$4,$5) returning id`,
        [page_id, content, filename, status, created_by]
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
  logoInsert: async (filename, status) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_company_logo( image, status  ) 
        values($1,$2) returning id`,
        [filename, status]
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
  pageContentInsert: async (page_id, section_name, content) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `insert into tbl_cms_page_sections(page_id,section_name, content ) 
        values($1,$2,$3) returning id`,
        [page_id, section_name, content]
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
  pageContentUpdate: async (
    page_id,
    section_name,
    content,
    page_content_id
  ) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_cms_page_sections set 
				page_id = ($1),
				section_name = ($2),
				content = ($3)
       	where id=($4)`,
        [page_id, section_name, content, page_content_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  bannerUpdate: async (page_id, content, status, banner_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_cms_banner set 
				page_id = ($1),
				content = ($2),
				
				status = ($3)
       	where id=($4)`,
        [page_id, content, status, banner_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  logoUpdate: async (status, logo_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_company_logo set 
				status = ($1)
       	where id=($2)`,
        [status, logo_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  bannerUpdateFilename: async (
    page_id,
    content,
    filename,
    status,
    banner_id
  ) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_cms_banner set 
				page_id = ($1),
				content = ($2),
				image = ($3),
				status = ($4)
       	where id=($5)`,
        [page_id, content, filename, status, banner_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  logoUpdateFilename: async (filename, status, logo_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_company_logo set 
				image = ($1),
				status = ($2)
       	where id=($3)`,
        [filename, status, logo_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  getbannerList: async (limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select tbl_cms_banner.*,tbl_cms_pages.name,
        CASE
        WHEN tbl_cms_banner.image IS NULL THEN
        NULL
        ELSE tbl_cms_banner.image
        END AS image_url from tbl_cms_banner LEFT JOIN tbl_cms_pages ON tbl_cms_banner.page_id = tbl_cms_pages.id limit ${limit} offset $1`,
        [offset]
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
  getlogoList: async (limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select tbl_company_logo.*,
        CASE
        WHEN tbl_company_logo.image IS NULL THEN
        NULL
        ELSE tbl_company_logo.image
        END AS image_url from tbl_company_logo  limit ${limit} offset $1`,
        [offset]
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
  getPageContentList: async (limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select tbl_cms_page_sections.id,tbl_cms_page_sections.status,tbl_cms_page_sections.page_id, tbl_cms_page_sections.section_name,tbl_cms_pages.name as page_name from tbl_cms_page_sections LEFT JOIN tbl_cms_pages ON tbl_cms_pages.id = tbl_cms_page_sections.page_id where tbl_cms_page_sections.is_deleted = 0  ORDER BY id DESC limit $1 offset $2`,
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
  getContactUsList: async (limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select * from tbl_contact_us ORDER BY id desc  limit $1 offset $2`,
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
  getPageContentDetail: async (page_id) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `select tbl_cms_page_sections.id,tbl_cms_page_sections.page_id,tbl_cms_page_sections.content, tbl_cms_page_sections.section_name,tbl_cms_pages.name as page_name from tbl_cms_page_sections LEFT JOIN tbl_cms_pages ON tbl_cms_pages.id = tbl_cms_page_sections.page_id WHERE tbl_cms_page_sections.id = ${page_id} `
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
  getBannerDetail: async (banner_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select *,
      CASE
      WHEN tbl_cms_banner.image IS NULL THEN
      NULL
      ELSE tbl_cms_banner.image
      END AS image_url from tbl_cms_banner WHERE id = ${banner_id} `
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
  getLogoDetail: async (logo_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select *,
      CASE
      WHEN tbl_company_logo.image IS NULL THEN
      NULL
      ELSE tbl_company_logo.image
      END AS image_url from tbl_company_logo WHERE id = ${logo_id} `
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
  getFaqDetail: async (faq_id) => {
    return new Promise(function (resolve, reject) {
      db.one(`select * from tbl_faq WHERE id = ${faq_id} `)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getBlogDetail: async (blog_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select *,
      CASE
      WHEN tbl_blog.image IS NULL THEN
      NULL
      ELSE tbl_blog.image
      END AS image_url from tbl_blog WHERE id = ${blog_id} `
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
  getTestimonialDetail: async (testimonial_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select *,
      CASE
      WHEN tbl_testimonials.thumbnail_image IS NULL THEN
      NULL
      ELSE tbl_testimonials.thumbnail_image
      END AS image_url,
      CASE
      WHEN tbl_testimonials.created_image IS NULL THEN
      NULL
      ELSE tbl_testimonials.created_image
      END AS created_image_url from tbl_testimonials WHERE id = ${testimonial_id} `
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

  getPageContentCount: async () => {
    return new Promise(function (resolve, reject) {
      db.any(`select * from tbl_cms_page_sections where is_deleted = 0`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getContactUsCount: async () => {
    return new Promise(function (resolve, reject) {
      db.any(`select * from tbl_contact_us`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  deletePageContent: async (page_content_id) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE 
        tbl_cms_page_sections SET 
        is_deleted = '1'
	    WHERE id=($1) RETURNING id`,
        [page_content_id]
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
  deleteBanner: async (banner_id) => {
    return new Promise(function (resolve, reject) {
      db.any(`DELETE from tbl_cms_banner WHERE id=($1)`, [banner_id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  deleteLogo: async (logo_id) => {
    return new Promise(function (resolve, reject) {
      db.any(`DELETE from tbl_company_logo WHERE id=($1)`, [logo_id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getBannerCount: async () => {
    return new Promise(function (resolve, reject) {
      db.any(`select * from tbl_cms_banner `)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getLogoCount: async () => {
    return new Promise(function (resolve, reject) {
      db.any(`select * from tbl_company_logo `)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getPageList: async () => {
    return new Promise(function (resolve, reject) {
      db.any(`select * from tbl_cms_pages `)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
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
  /*  user_profile_detail: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from tbl_users where id = '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          //   console.log('results-->', results);
          resolve(results);
        }
      );
    });
  }, */
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
  /* update_user_otp_resend: async (updateOtp) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				tbl_users set 
				otp = '${updateOtp.otp}'
       	where email= '${updateOtp.email}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  }, */
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
          // var errorText = common.getErrorText(err);
          // var error = new Error(errorText);
          reject(err);
        });
    });
  },
  /*   user_detail_otp_exists: async (otp) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from tbl_users where otp = '${otp}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  }, */
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
  /*   update_forgot_password_status: async (otp, password) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				tbl_users set 
				password = '${password}'
       	where otp= '${otp}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  }, */
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
          // var errorText = common.getErrorText(err);
          // var error = new Error(errorText);
          reject(err);
        });
    });
  },
  /*  clear_forgot_otp_user: async (otp) => {
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
  }, */
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
  /* user_id_exists: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Users where id = '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;

          resolve(results);
        }
      );
    });
  }, */
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

  user_detail_update: async (userObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_users set 
				name = $1,
				mobile = $2,
				organization_name = $3,
				country = $4,
				gstin = $5,
				cin = $6
       	where id= $7`,
        [
          userObj.name,
          userObj.mobile,
          userObj.organization_name,
          userObj.country,
          userObj.gstin,
          userObj.cin,
          userObj.user_id
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
  },
  /* user_detail_check: async (id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select * from Users where id = '${id}' AND  status = '1'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  }, */
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
  /*   update_profile_image: async (user_id, filename, original_filename) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `update 
				Users set 
				filename = '${filename}',
				original_filename = '${original_filename}'
       	where id = '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  }, */
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
  /*   userinfo: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.query(
        `select id,role_id,fcm_id,fname,lname,mobile,email,nationality,qualification_id,area_of_interest,status,filename from Users where id= '${user_id}'`,
        function (error, results, fields) {
          if (error) throw error;
          resolve(results);
        }
      );
    });
  }, */
  userinfo: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.one('select * from tbl_users where id = $1', [user_id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
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
  social_login_exist: async (id) => {
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
  },
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
        `insert into tbl_users(name, email, social_login_id,social_login_type,social_login_profile_image,status,user_type	) 
        values($1, $2,$3,$4,$5,$6,$7) returning id`,
        [
          usrobj.name,
          usrobj.email,
          usrobj.social_login_id,
          usrobj.login_type,
          usrobj.social_login_profile_image,
          usrobj.status,
          usrobj.user_type
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
  approveCmsPageContent: async (page_content_id, status) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE 
        tbl_cms_page_sections SET 
        status = $2
	    WHERE id=($1) RETURNING id`,
        [page_content_id, status]
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
  createFaq: async (faqObj) => {
    return new Promise(function (resolve, reject) {
      const query =
        pgp().helpers.insert(faqObj, null, 'tbl_faq') + ' RETURNING id';

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
  getAllFaq: async (limit, offset, search) => {
    return new Promise(function (resolve, reject) {
      let query = ``;
      if (search) {
        query = ` AND ( question ILIKE '%${search}%' OR description ILIKE '%${search}%')`;
      }
      db.any(
        `SELECT * FROM tbl_faq WHERE status != 2 ${query} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
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
  getAllFaqCount: async (search) => {
    return new Promise(function (resolve, reject) {
      let query = ``;
      if (search) {
        query = ` AND ( question ILIKE '%${search}%' OR description ILIKE '%${search}%')`;
      }
      db.one(`SELECT count(id) FROM tbl_faq WHERE status != 2 ${query}`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  checkFaq: async (faqId) => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_faq WHERE id = $1 AND status!=2`, [faqId])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  updateFaq: async (faqObj, faqId) => {
    return new Promise(function (resolve, reject) {
      const condition = `WHERE id = $1 RETURNING id`;
      const values = [faqId];
      let query = pgp().helpers.update(faqObj, null, 'tbl_faq') + condition;

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
  deleteFaq: async (faqObj, faqId) => {
    return new Promise(function (resolve, reject) {
      const condition = `WHERE id = $1 RETURNING id`;
      const values = [faqId];
      let query = pgp().helpers.update(faqObj, null, 'tbl_faq') + condition;

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
  createTestimonial: async (testimonialObj) => {
    return new Promise(function (resolve, reject) {
      const query =
        pgp().helpers.insert(testimonialObj, null, 'tbl_testimonials') +
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
  checkTestimonial: async (testimonialId) => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_testimonials WHERE id = $1 AND status!=2 `, [
        testimonialId
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
  getAllTestimonial: async (limit, offset, search) => {
    return new Promise(function (resolve, reject) {
      let query = ``;
      if (search) {
        query = ` AND ( title ILIKE '%${search}%' OR description ILIKE '%${search}%')`;
      }
      db.any(
        `SELECT * ,
              CASE
              WHEN tbl_testimonials.thumbnail_image IS NULL THEN
              NULL
              ELSE tbl_testimonials.thumbnail_image
              END AS image_url
          FROM tbl_testimonials
          WHERE status != 2 ${query}
          ORDER BY  "createdAt" DESC LIMIT $1 OFFSET $2`,
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
  getAllTestimonialCount: async (search) => {
    return new Promise(function (resolve, reject) {
      let query = ``;
      if (search) {
        query = ` AND ( title ILIKE '%${search}%' OR description ILIKE '%${search}%')`;
      }
      db.one(
        `SELECT count(id) FROM tbl_testimonials WHERE status != 2 ${query}`
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
  testimonialUpdateOne: async (testimonialObj, testimonialId) => {
    return new Promise(function (resolve, reject) {
      const condition = `WHERE id = $1 RETURNING id`;
      const values = [testimonialId];
      let query =
        pgp().helpers.update(testimonialObj, null, 'tbl_testimonials') +
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
  },
  deleteTestimonial: async (testimonialObj, testimonialId) => {
    return new Promise(function (resolve, reject) {
      const condition = `WHERE id = $1 RETURNING id`;
      const values = [testimonialId];
      let query =
        pgp().helpers.update(testimonialObj, null, 'tbl_testimonials') +
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
  },
  getAllBlogCategory: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT id,title 
          FROM tbl_blog_category
          ORDER BY  "title"`
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
  checkBlogCategory: async (blogCategoryId) => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_blog_category WHERE id = $1`, [blogCategoryId])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  createBlog: async (blogObj) => {
    return new Promise(function (resolve, reject) {
      const query =
        pgp().helpers.insert(blogObj, null, 'tbl_blog') + ' RETURNING id';

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
  getAllBlog: async (limit, offset, search) => {
    return new Promise(function (resolve, reject) {
      let query = ``;
      if (search) {
        query = ` AND ( tbl_blog.title ILIKE '%${search}%' OR tbl_blog.description ILIKE '%${search}%')`;
      }
      db.any(
        `SELECT tbl_blog.* ,tbl_blog_category.title category,
              CASE
              WHEN tbl_blog.image IS NULL THEN
              NULL
              ELSE tbl_blog.image
              END AS image_url
          FROM tbl_blog
          LEFT JOIN tbl_blog_category ON tbl_blog.blog_cat_id = tbl_blog_category.id
          WHERE status != 2 ${query}
          ORDER BY  tbl_blog."createdAt" DESC LIMIT $1 OFFSET $2`,
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
  getAllBlogCount: async (search) => {
    return new Promise(function (resolve, reject) {
      let query = ``;
      if (search) {
        query = ` AND ( tbl_blog.title ILIKE '%${search}%' OR tbl_blog.description ILIKE '%${search}%')`;
      }
      db.one(
        `SELECT count(tbl_blog.id) FROM tbl_blog
      LEFT JOIN tbl_blog_category ON tbl_blog.blog_cat_id = tbl_blog_category.id
      WHERE status != 2 ${query}`
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
  checkBlog: async (blogId) => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_blog WHERE id = $1 AND status!=2 `, [blogId])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  blogUpdateOne: async (blogObj, blogId) => {
    return new Promise(function (resolve, reject) {
      const condition = `WHERE id = $1 RETURNING id`;
      const values = [blogId];
      let query = pgp().helpers.update(blogObj, null, 'tbl_blog') + condition;

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
  deleteBlog: async (blogObj, blogId) => {
    return new Promise(function (resolve, reject) {
      const condition = `WHERE id = $1 RETURNING id`;
      const values = [blogId];
      let query = pgp().helpers.update(blogObj, null, 'tbl_blog') + condition;

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
  getTotalUser: async (lastDate, active, userType) => {
    return new Promise(function (resolve, reject) {
      let dynamicWhere = ``;
      let allUserType = [2, 3, 4];
      if (lastDate) {
        dynamicWhere += ` AND tbl_users.created_at >= '${lastDate}'`;
      }
      if (active) {
        dynamicWhere += ` AND tbl_users.status = ${active}`;
      }
      if (userType) {
        allUserType = [userType];
      }
      db.one(
        `SELECT count(id) FROM tbl_users WHERE user_type IN (${allUserType}) AND is_deleted = 0 ${dynamicWhere}`
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
  getPaidUsers: async () => {
    return new Promise(function (resolve, reject) {
      db.one(
        `SELECT count(tbl_users.id)
        FROM tbl_users 
        LEFT JOIN tbl_user_subscriptions tus ON tbl_users.id = tus.user_id AND tus.status = 1
        LEFT JOIN tbl_subscription_plans tsp ON tus.plan_id = tsp.id AND tsp.plan_type = 'p'
        WHERE tbl_users.user_type IN (2, 4) AND tbl_users.is_deleted = 0 AND tsp.plan_type IS NOT NULL 
        AND tus.status IS NOT NULL`
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

export default cmsModel;
