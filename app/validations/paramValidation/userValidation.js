import Joi from 'joi';
import { encode } from 'html-entities';
import multer from 'multer';
import multerS3 from 'multer-s3';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Config from '../../config/app.config.js';
import userModel from '../../models/userModel.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import { logger } from '../../util/logger.js';
import { S3Client } from '@aws-sdk/client-s3';
import s3Client from '../../config/s3config.js';





var store_profile_images = multerS3({
  s3: s3Client,
  bucket: process.env.AWS_S3_BUCKET, // Directly specified bucket name
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: function (req, file, cb) {
    // 1. Extract file extension
    const ext = path.extname(file.originalname).toLowerCase();
    
    // 2. Generate unique filename with timestamp + UUID
    const fileName = `${Date.now()}-${uuidv4()}${ext}`;
    
    // 3. Create full S3 path matching your URL structure
    const fullPath = `user_image/${fileName}`; // Exact path you want
    
    // 4. Pass the complete path to callback
    cb(null, fullPath);
  }
});


// var store_profile_images = multer.diskStorage({
//   destination: function (req, file, callback) {
//     callback(null, Config.upload.user_image);
//   },
//   filename: function (req, file, callback) {
//     var extention = path.extname(file.originalname);
//     var new_file_name = +new Date() + '-' + uuidv4() + extention;
//     callback(null, new_file_name);
//   }
// });
const store_document = multerS3({
  s3: s3Client,
  bucket: process.env.AWS_S3_BUCKET,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const newFileName = `${Date.now()}-${uuidv4()}${ext}`;
    cb(null, newFileName);
  }
});

const store_vendor_document = multerS3({
  s3: s3Client,
  bucket: process.env.AWS_S3_BUCKET,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const newFileName = `${Date.now()}-${uuidv4()}${ext}`;

    let folder = "vendor-documents";
    if (file.mimetype.startsWith("image/")) {
      folder = "vendor-images";
    } else if (file.mimetype.startsWith("video/")) {
      folder = "vendor-videos";
    }

    cb(null, `${folder}/${newFileName}`);
  }
});





// var store_document = multer.diskStorage({
//   destination: function (req, file, callback) {
//     callback(null, Config.upload.user_document);
//   },
//   filename: function (req, file, callback) {
//     var extention = path.extname(file.originalname);
//     var new_file_name = +new Date() + '-' + uuidv4() + extention;
//     callback(null, new_file_name);
//   }
// });

// multer configuration for without authentiation files.
var store_document_without_auth = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.user_document_without_auth);
  },
  filename: function (req, file, callback) {
    var extention = path.extname(file.originalname);
    var new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});

var validatingImage = (schema) => {
  return (req, res, next) => {
    const result = Joi.validate(req.body, schema, {
      abortEarly: false
    });
    if (result.error) {
      let err_msg = {};
      for (let counter in result.error.details) {
        let k = result.error.details[counter].context.key;
        let val = result.error.details[counter].message;
        err_msg[k] = val;
      }
      let return_err = { status: 2, errors: err_msg };
      return res.status(400).json(return_err);
    }

    if (!req.value) {
      req.value = {};
    }
    req.value['body'] = result.value;
    return true;
  };
};

const validateBody = (schema) => {
  return (req, res, next) => {
    const result = schema.validate(req.body, { abortEarly: false });
    if (result.error) {
      let err_msg = {};
      for (let counter in result.error.details) {
        let k = result.error.details[counter].context.key;
        let val = result.error.details[counter].message;
        err_msg[k] = val;
      }
      let return_err = { status: 2, errors: err_msg };
      return res.status(400).json(return_err);
    }

    if (!req.value) {
      req.value = {};
    }

    req.value['body'] = result.value;

    next();
  };
};
const validateParam = (schema) => {
  return (req, res, next) => {
    const result = schema.validate(req.params);
    if (result.error) {
      let return_err = { status: 2, errors: 'Invalid argument' };
      return res.status(400).json(return_err);
    }

    if (!req.value) {
      req.value = {};
    }
    req.value['params'] = result.value;
    next();
  };
};
const validateBodyController = (schema, req, res) => {
  const result = schema.validate(req.body, { abortEarly: false });

  if (result.error) {
    let err_msg = {};
    for (let counter in result.error.details) {
      let k = result.error.details[counter].context.key;
      let val = result.error.details[counter].message;
      err_msg[k] = val;
    }
    let return_err = { status: 2, errors: err_msg };
    return res.status(400).json(return_err).end();
  }

  if (!req.value) {
    req.value = {};
  }

  req.value['body'] = result.value;

  // next();
};

const schemas = {
  create_category: Joi.object().keys({
    name: Joi.string().required(),
    parent_id: Joi.string().optional().allow(null).allow(''),
    status: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only')
  }),
  update_category: Joi.object().keys({
    name: Joi.string().required(),
    parent_id: Joi.string().optional().allow(null).allow(''),
    status: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only')
  }),
  user_register: Joi.object().keys({
    name: Joi.string().required(),
    email: Joi.string().required().email().max(100),
    mobile: Joi.string().min(8).max(15).required().label('Mobile'),
    organization_name: Joi.string().optional().allow(null).allow(''),
    register_as: Joi.string()
      .required()
      .regex(/^[2|3|7|8|9|10]$/, 'status should be 2 / 3/ 7 / 8 / 9 / 10'), // 2 productemnt, 3 vendor, 7 buyer company account, 8 top management, 9 eng account, 10 finance account

    password: Joi.string().min(3).max(15).required().label('Password'),
    confirm_password: Joi.any().valid(Joi.ref('password')).required().messages({
      'any.only': 'Password and Confirm password not matched'
    }),
  }),
  
  company_registration: Joi.object().keys({
    name: Joi.string().required(),
    email: Joi.string().required().email().max(100),
    mobile: Joi.string().min(8).max(15).required().label('Mobile'),
    organization_name: Joi.string().required(),
    register_as: Joi.string()
      .optional()
      .regex(/^[3|7]$/, 'register_as should be 3 (vendor) or 7 (buyer)'),
    user_type: Joi.string()
      .required()
      .regex(/^[3|7]$/, 'user_type should be 3 (vendor) or 7 (buyer)'),
    password: Joi.string().min(3).max(15).required().label('Password'),
    status: Joi.number().valid(0, 1).optional().allow(null), // Allow status field for paid subscriptions
    address: Joi.string().optional().allow(null).allow(''),
    country: Joi.string().optional().allow(null).allow(''),
    source : Joi.string().optional().allow(null).allow(''),
    subscription_plan : Joi.number().optional().allow(null),
    whatsapp: Joi.string().optional().allow(null).allow(''),
    state: Joi.string().optional().allow(null).allow(''),
    city: Joi.string().optional().allow(null).allow(''),
    postal_code: Joi.string().optional().allow(null).allow(''),
    gstin: Joi.string().optional().allow(null).allow(''),
    cin: Joi.string().optional().allow(null).allow(''),
    profile: Joi.string().optional().allow(null).allow(''),
    nature_of_business: Joi.string().optional().allow(null).allow(''),
    type_of_business: Joi.string().optional().allow(null).allow(''),
    turnover: Joi.string().optional().allow(null).allow(''),
    no_of_employess: Joi.string().optional().allow(null).allow(''),
    import_export_code: Joi.string().optional().allow(null).allow(''),
    established_year: Joi.number().optional().allow(null).allow(''),
    website: Joi.string().optional().allow(null).allow(''),
    is_private: Joi.number().optional().allow(null),
    is_hospitality: Joi.number().valid(0, 1).optional().allow(null),
    hotels: Joi.alternatives()
      .try(
        Joi.array().items(Joi.number().integer().positive()),
        Joi.string()
      )
      .optional()
      .allow(null),
    categories: Joi.alternatives()
      .try(
        Joi.array().items(Joi.number().integer().positive()),
        Joi.string()
      )
      .optional()
      .allow(null),
    subcategories: Joi.alternatives()
      .try(
        Joi.array().items(Joi.number().integer().positive()),
        Joi.string()
      )
      .optional()
      .allow(null),
    pan: Joi.string().optional().allow(null).allow(''),
    fssai: Joi.string().optional().allow(null).allow(''),
    msme: Joi.string().optional().allow(null).allow(''),
    pan_doc: Joi.string().uri().optional().allow(null).allow(''),
    gst_doc: Joi.string().uri().optional().allow(null).allow(''),
    msme_doc: Joi.string().uri().optional().allow(null).allow(''),
    fssai_doc: Joi.string().uri().optional().allow(null).allow(''),
    cancelled_cheque_doc: Joi.string().uri().optional().allow(null).allow(''),
    bank_account_number: Joi.string().optional().allow(null).allow(''),
    bank_name: Joi.string().optional().allow(null).allow(''),
    ifsc_code: Joi.string().optional().allow(null).allow(''),
    account_holder_name: Joi.string().optional().allow(null).allow(''),
    // Additional fields for buyer registration
    max_top_management: Joi.number().optional().allow(null),
    max_procurement: Joi.number().optional().allow(null),
    max_engineering: Joi.number().optional().allow(null),
    max_finance: Joi.number().optional().allow(null),
  }),
  vendor_review: Joi.object().keys({
    reviewed_to: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper receiver id'),
    quality_of_work: Joi.number()
      .min(1)
      .max(5)
      .required()
      .label('Quality of Work'),
    on_time_delivery: Joi.number()
      .min(1)
      .max(5)
      .required()
      .label('On Time Delivery'),
    trustworthiness_reliability: Joi.number()
      .min(1)
      .max(5)
      .required()
      .label('Trustworthiness and Reliability'),
    overall_rating: Joi.number()
      .min(1)
      .max(5)
      .required()
      .label('Overall Rating'),
    description: Joi.string().optional().allow(null).allow('')
  }),
  user_login: Joi.object().keys({
    email: Joi.string().optional().email().max(100),
    employee_code: Joi.string().optional().max(50),
    password: Joi.string().min(3).max(15).required().label('Password')
  }).or('email', 'employee_code'),
  change_password: Joi.object().keys({
    password: Joi.string().min(3).max(15).required().label('Password'),
    confirm_password: Joi.any().valid(Joi.ref('password')).required().messages({
      'any.only': 'Password and Confirm password not matched'
    })
  }),
  social_login: Joi.object().keys({
    login_type: Joi.string().required(),
    access_token: Joi.string().required()
  }),
  registration_otp_send: Joi.object().keys({
    email: Joi.string().required().email().max(100)
  }),
  registration_otp_verify: Joi.object().keys({
    otp: Joi.string().required().length(6).regex(/^[0-9]+$/),
    token: Joi.string().required()
  }),
  otp_user: Joi.object().keys({
    otp: Joi.string().required(),
    password: Joi.string().min(3).max(15).required().label('Password'),
    confirm_password: Joi.any().valid(Joi.ref('password')).required().messages({
      'any.only': 'Password and Confirm password not matched'
    })
  }),

  update_profile: Joi.object().keys({
    email: Joi.string().email().optional(),
    name: Joi.string().optional(),
    mobile: Joi.string().optional(),
    status: Joi.number().valid(0, 1).optional(),
    user_id: Joi.number().optional(),
    department_ids: Joi.array().items(Joi.number()).optional(),
    roles: Joi.array().items(
      Joi.object().keys({
        role_id: Joi.number().required(),
        role_title: Joi.string().optional().allow(null).allow(''),
        company_id: Joi.number().optional().allow(null),
        hotel_id: Joi.number().optional().allow(null),
        department_id: Joi.number().optional().allow(null),
        permissions: Joi.object().optional()
      })
    ).optional(),
    employee_type: Joi.string().optional().allow('', null),
    employee_code: Joi.string().optional().allow('', null),
    payroll_company_id: Joi.number().integer().optional().allow(null),
    // Set by the frontend after admin clicks "Proceed Anyway" on the approval
    // impact warning modal. Bypasses the pre-flight check in the controller
    // so the role/dept change actually applies (and propagates to pending
    // approvals) instead of looping back to WARNING forever.
    confirmed_approval_impact: Joi.boolean().optional(),
  }),

  // mukul 09-06-2025, just saprate this from update_profile
  company_profile: Joi.object().keys({
    company_id: Joi.number().optional(),
    company_name: Joi.string().optional().allow(null).allow(''),
    established_year: Joi.number().optional().allow(null).allow(''),
    about_company : Joi.string().optional().allow(null).allow(''), // in tbl_company this is we have as profile
    gstin: Joi.string().optional().allow(null).allow(''),
    website : Joi.string().optional().allow(null).allow(''),
    street_address: Joi.string().optional().allow(null).allow(''),
    postal_code: Joi.number().optional().allow(null),
    country: Joi.number().optional().allow(null),
    state: Joi.number().optional().allow(null),
    city: Joi.number().optional().allow(null),
    nature_of_business: Joi.string().optional().allow(null).allow(''),
    type_of_business: Joi.string().optional().allow(null).allow(''),
    turnover: Joi.string().optional().allow(null),
    no_of_employess: Joi.string().optional().allow(null).allow(''),
    import_export_code: Joi.string().optional().allow(null).allow(''),
    cin: Joi.string().optional().allow(null).allow(''),
  }),
  enquiry: Joi.object().keys({
    first_name: Joi.string().required(),
    last_name: Joi.string().required(),
    phone: Joi.string().optional().allow(null).allow(''),
    email: Joi.string().required().email().max(100),
    message: Joi.string().required()
  }),
  contact_us: Joi.object().keys({
    first_name: Joi.string().required(),
    last_name: Joi.string().required(),
    email: Joi.string().required().email().max(100),
    phone: Joi.string().optional().allow(null).allow(''),
    country: Joi.string().required(),
    city: Joi.string().optional().allow(null).allow(''),
    area_of_interest: Joi.string().optional().allow(null).allow(''),
    message: Joi.string().required()
  }),

  create_user_address: Joi.object().keys({
    name: Joi.string().required(),
    gender: Joi.string().required(),
    dob: Joi.date().raw().required(),
    aniversary_date: Joi.string().optional().allow(null).allow(''),
    email: Joi.string().required().email().max(100),
    address: Joi.string().required(),
    landmark: Joi.string().optional().allow(null).allow(''),
    city: Joi.string().required(),
    state: Joi.string().required(),
    pincode: Joi.string().required(),
    country: Joi.string().required(),
    mobile: Joi.string().required(),
    alternative_mobile: Joi.string().optional().allow(null).allow('')
  }),
  update_user_address: Joi.object().keys({
    name: Joi.string().required(),
    gender: Joi.string().required(),
    dob: Joi.date().raw().required(),
    aniversary_date: Joi.string().optional().allow(null).allow(''),
    email: Joi.string().required().email().max(100),
    address: Joi.string().required(),
    landmark: Joi.string().optional().allow(null).allow(''),
    city: Joi.string().required(),
    state: Joi.string().required(),
    pincode: Joi.string().required(),
    country: Joi.string().required(),
    mobile: Joi.string().required(),
    alternative_mobile: Joi.string().optional().allow(null).allow('')
  }),
  update_user_detail: Joi.object().keys({
    dob: Joi.date().raw().required(),
    nationality: Joi.string().required(),
    qualification_id: Joi.string().required(),
    term_condition: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only'),
    qualification_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only'),
    area_of_interest: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only')
  }),
  address_id: Joi.object().keys({
    address_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper address id')
  }),
  profile_image: Joi.object().keys({
    file: Joi.optional().allow(null)
  }),
  user_document: Joi.object().keys({
    file: Joi.required()
  }),

  buyer_private_vendor: Joi.object().keys({
    vendorName: Joi.string().required().trim().max(60), // Required, trimmed, and max length of 60 characters
    email: Joi.string().required().email().trim().max(50), // Required, valid email, trimmed, and max length of 50 characters
    phone: Joi.string().required().trim().max(20), // Required, trimmed, and max length of 20 characters
    productList: Joi.string().required().trim().max(300), // Required, trimmed, and max length of 300 characters,
    is_private: Joi.number().optional().valid(0, 1)
  }),
  buyer_private_vendor_approved: Joi.object().keys({
    vendorName: Joi.string().required().trim().max(60),
    email: Joi.string().required().email().trim().max(50),
    phone: Joi.string().required().trim().max(15),
    productDetails: Joi.array()
      .items(
        Joi.object().keys({
          master_id: Joi.number().required(),
          name: Joi.string().required(),
          description: Joi.string().allow('', null),
          status: Joi.number().optional(),
          approved_id: Joi.array().items(Joi.number()).optional(),
          approved_name: Joi.array().items(Joi.string()).optional(),
          categories: Joi.array().items(Joi.number()).optional()
        })
      )
      .optional(),
    is_private: Joi.number().optional().valid(0, 1)
  }),

  user_spoc: Joi.object().keys({
    spoc_name: Joi.string()
      .required()
      .allow(null, '') // Allow null and empty string
      .trim(),
    spoc_role: Joi.string().optional().allow(null, ''), // Allow null and empty string
    spoc_email: Joi.string()
      .required()
      .allow(null, '')
      .trim()
      .email({ tlds: { allow: false } }), // Email validation only if non-empty
    spoc_mobile: Joi.string()
      .optional()
      .allow(null, '') // Allow null or empty strings
      .trim()
      .regex(
        /^\+\d{1,4}-\d{7,14}$/,
        'Please enter a valid mobile number in the format +91-XXXXXXXXXX'
      )
      .min(7) // Minimum 10 digits if non-empty
      .max(15), // Maximum 15 digits if non-empty
    vendor_id: Joi.string().optional().allow(null, ''),
  }),
  vendor_spoc_params: Joi.object().keys({
    vendor_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper vendor id')
  }),
  id: Joi.object().keys({
    id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper id')
  }),
};

let store_buyer_excel_upload_vendor_file = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.buyer_upload_vendor_file)
  },
  filename: function (req, file, callback) {
    var extention = path.extname(file.originalname);
    var new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
})

const schema_posts = {
  add_user_profile_image: async (req, res, next) => {
    try {
      var upload = multer({
        storage: store_profile_images,
        limits: {
          fileSize: 90000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          var ext = path.extname(file.originalname).toLowerCase();

          if (ext == '.png' || ext == '.jpg' || ext == '.jpeg') {
            var validateImage = validatingImage(schemas.profile_image);
            if (validateImage) {
              cb(null, true);
            }
          } else {
            cb(null, false);
            return cb('Only .png, .jpg, .jpeg format allowed!', null);
          }
        }
      }).single('file');
      upload(req, res, async function (err) {
        if (err) {
          let data = {};
          data.file = err;
          res
            .status(400)
            .json({
              status: 2,
              errors: data
            })
            .end();
        } else {
          next();
        }
      });
    } catch (err) {
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  },
  upload_user_document: async (req, res, next) => {
    try {
      var upload = multer({
        storage: store_document,
        limits: {
          // fileSize: 2000000 // Compliant: 8MB
          fileSize: 26214400 // Compliant: 25MB, changes by mukul, 27-11-2024
        }
      }).fields([{ name: 'file', maxCount: 8 }]);
      upload(req, res, async function (err) {
        if (err) {
          let data = {};
          data.file = err;
          res
            .status(400)
            .json({
              status: 2,
              errors: data
            })
            .end();
        } else {
          next();
        }
      });
    } catch (err) {
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  },
  upload_vendor_document: async (req, res, next) => {
    try {
      const upload = multer({
        storage: store_vendor_document,
        limits: {
          fileSize: 26214400 // 25MB limit
        }
      }).fields([
        { name: 'file', maxCount: 8 } // generic files/images
        // if you want separate inputs for videos: { name: "video", maxCount: 3 }
      ]);

      upload(req, res, function (err) {
        if (err) {
          return res.status(400).json({
            status: 2,
            errors: { file: err }
          });
        }
        next();
      });
    } catch (err) {
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  },

  upload_document_without_auth: async (req, res, next) => {
    try {
      var upload = multer({
        storage: store_document_without_auth,
        limits: {
          // fileSize: 2000000 // Compliant: 8MB
          fileSize: 26214400 // Compliant: 25MB, changes by mukul, 27-11-2024
        },
        fileFilter: (req, file, cb) => {
          var ext = path.extname(file.originalname).toLowerCase();

          if (
            ext == '.png' ||
            ext == '.jpg' ||
            ext == '.jpeg' ||
            ext == '.pdf' ||
            ext == '.doc' ||
            ext == '.docx' ||
            ext == '.xlsx'
          ) {
            var validateImage = validatingImage(schemas.user_document);
            if (validateImage) {
              cb(null, true);
            }
          } else {
            cb(null, false);
            return cb('File format not allowed!', null);
          }
        }
      }).fields([{ name: 'file', maxCount: 8 }]);
      upload(req, res, async function (err) {
        if (err) {
          let data = {};
          data.file = err;
          res
            .status(400)
            .json({
              status: 2,
              errors: data
            })
            .end();
        } else {
          next();
        }
      });
    } catch (err) {
      logError('userValidation error', err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  },
  buyerExcelUploadVendorFileHandler: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_buyer_excel_upload_vendor_file,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();

          if ('.xlsx') {
            cb(null, true);
          } else {
            cb(null, false);
            return cb('Only .xlsx format allowed!', null);
          }
        }
      }).single('file');
      upload(req, res, async function (err) {
        // Check for isPrivate field
        const isPrivate = !req.body.private
          ? undefined
          : parseInt(req.body.is_private);
        if (isPrivate !== undefined) {
          // Check if isPrivate is provided
          if (isPrivate !== 0 && isPrivate !== 1) {
            res
              .status(400)
              .json({
                status: 2,
                message: 'Invalid isPrivate value (must be either 0 or 1)'
              })
              .end();
            return;
          }
        }

        if (err) {
          let data = {};
          data.file = err;
          res
            .status(400)
            .json({
              status: 2,
              errors: data
            })
            .end();
        } else {
          next();
        }
      });
    } catch (err) {
      logError(err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  }
};

export {
  validateBody,
  validateParam,
  validateBodyController,
  schemas,
  schema_posts,
  store_vendor_document
};
