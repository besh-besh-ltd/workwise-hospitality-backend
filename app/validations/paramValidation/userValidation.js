import Joi from 'joi';
import { encode } from 'html-entities';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Config from '../../config/app.config.js';
import userModel from '../../models/userModel.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';

var store_profile_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.user_image);
  },
  filename: function (req, file, callback) {
    var extention = path.extname(file.originalname);
    var new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
var store_agent_profile_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.agent_user_image);
  },
  filename: function (req, file, callback) {
    var extention = path.extname(file.originalname);
    var new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});

var store_document = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.user_document);
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

const academicItems = Joi.object({
  id: Joi.number().optional(),
  highest_education: Joi.string().required(),
  institute_name: Joi.string().required(),
  country: Joi.string().required(),
  state: Joi.string().required(),
  city: Joi.string().required(),
  degree: Joi.string().required(),
  backlogs: Joi.string().required(),
  grade: Joi.string().required(),
  score: Joi.string().required(),
  primary_language: Joi.string().required(),
  start_date: Joi.string().required(),
  end_date: Joi.string().required(),
  is_highest: Joi.string().optional()
});
const workExpItems = Joi.object({
  id: Joi.number().optional(),
  organization: Joi.string().required(),
  position: Joi.string().required(),
  job_profile: Joi.string().required(),
  working_from: Joi.string().required(),
  working_upto: Joi.string().required(),
  mode_of_salary: Joi.string().required(),
  current_status: Joi.string().required()
});
const englishTests = Joi.object({
  id: Joi.number().optional(),
  test_id: Joi.number().required(),
  overall_score: Joi.string().required(),
  doe: Joi.string().required(),
  quantitative: Joi.string().required(),
  verbal: Joi.string().required(),
  analytical_writing: Joi.string().required()
});

const documents = Joi.object({
  document_id: Joi.number().required()
});

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
    mobile: Joi.string().min(8).max(11).required().label('Mobile'),
    organization_name: Joi.string().optional().allow(null).allow(''),
    register_as: Joi.string()
      .required()
      .regex(/^[2|3|4]$/, 'status should be 2 or 3 or 4'),

    password: Joi.string().min(3).max(15).required().label('Password'),
    confirm_password: Joi.any().valid(Joi.ref('password')).required().messages({
      'any.only': 'Password and Confirm password not matched'
    })
  }),
  vendor_review: Joi.object().keys({
    reviewed_to: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper receiver id'),

    rating: Joi.number().min(1).max(5).required(),
    description: Joi.string().optional().allow(null).allow('')
  }),
  user_login: Joi.object().keys({
    email: Joi.string().required().email().max(100),
    password: Joi.string().min(3).max(15).required().label('Password')
  }),
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
  otp_user: Joi.object().keys({
    otp: Joi.string().required(),
    password: Joi.string().min(3).max(15).required().label('Password'),
    confirm_password: Joi.any().valid(Joi.ref('password')).required().messages({
      'any.only': 'Password and Confirm password not matched'
    })
  }),

  update_profile: Joi.object().keys({
    company_name: Joi.string().optional().allow(null).allow(''),
    name: Joi.string().optional().allow(null).allow(''),
    location: Joi.string().optional().allow(null).allow(''),
    email: Joi.string().optional().allow(null).allow(''),
    mobile: Joi.string().optional().allow(null).allow(''),
    gstin: Joi.string().optional().allow(null).allow(''),
    cin: Joi.string().optional().allow(null).allow(''),
    profile: Joi.string().optional().allow(null).allow(''),
    linkedin: Joi.string().optional().allow(null).allow(''),
    facebook: Joi.string().optional().allow(null).allow(''),
    whatsapp: Joi.string().optional().allow(null).allow(''),
    skype: Joi.string().optional().allow(null).allow(''),
    vendor_approve: Joi.array().items(Joi.number()).allow(null),
    nature_of_business: Joi.string().optional().allow(null).allow(''),
    type_of_business: Joi.string().optional().allow(null).allow(''),
    turnover: Joi.string().optional().allow(null).allow(''),
    no_of_employess: Joi.string().optional().allow(null).allow(''),
    certifications: Joi.string().optional().allow(null).allow(''),
    address: Joi.string().optional().allow(null).allow(''),
    import_export_code: Joi.string().optional().allow(null).allow(''),
    country: Joi.string().optional().allow(null, ''),
    state: Joi.string().optional().allow(null, ''),
    city: Joi.string().optional().allow(null, '')
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

  agent_profile_image: Joi.object().keys({
    file: Joi.optional().allow(null)
  }),
  submit_application_step_6: Joi.object().keys({
    step: Joi.number().required(),
    application_id: Joi.number().required(),
    // items: Joi.array().items(documents).min(1).required(),
    items: Joi.array().items(documents)
  }),
  create_student: Joi.object().keys({
    step: Joi.number().required(),
    name: Joi.string().required(),
    email: Joi.string().trim().email().required(),
    phone: Joi.string()
      .trim()
      .min(10)
      .max(10)
      .required()
      .regex(/^[0-9]*$/),
    student_url: Joi.string().optional(),
    dob: Joi.string().required(),
    gender: Joi.string().optional(),
    marital_status: Joi.string().required(),
    c_address_1: Joi.string().required(),
    c_address_2: Joi.string().allow('').required(),
    c_courntry: Joi.string().required(),
    c_state: Joi.string().required(),
    c_city: Joi.string().required(),
    c_pincode: Joi.string().required(),
    p_address_1: Joi.string().required(),
    p_address_2: Joi.string().allow('').required(),
    p_courntry: Joi.string().required(),
    p_state: Joi.string().required(),
    p_city: Joi.string().required(),
    p_pincode: Joi.string().required(),
    passport_no: Joi.string().required(),
    issue_date: Joi.string().required(),
    exp_date: Joi.string().required(),
    issue_country: Joi.string().required(),
    issue_place: Joi.string().required(),
    birth_country: Joi.string().required(),
    nationality: Joi.string().required(),
    citizen: Joi.string().required(),
    citizen_other_country: Joi.number().required(),
    living_studying_other_country: Joi.number().required(),
    applied_immigration: Joi.number().required(),
    medical_condition: Joi.number().required(),
    visa_refusal: Joi.number().required(),
    criminal_record: Joi.number().required(),
    gurdian_name: Joi.string().required(),
    gurdian_relation: Joi.string().required(),
    gurdian_email: Joi.string().trim().email().required()
  }),
  buyer_subscription_payment: Joi.object().keys({
    sub_id: Joi.number().required(),
    coupon_code: Joi.string().trim().optional().allow(null, '')
  }),
  buyer_coupon_check: Joi.object().keys({
    coupon_code: Joi.string().trim().required(),
    sub_id: Joi.number().required()
  })
};

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
      console.log('====>', err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  },
  add_user_agent_profile_image: async (req, res, next) => {
    try {
      var upload = multer({
        storage: store_agent_profile_images,
        limits: {
          fileSize: 90000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          var ext = path.extname(file.originalname).toLowerCase();

          if (ext == '.png' || ext == '.jpg' || ext == '.jpeg') {
            var validateImage = validatingImage(schemas.agent_profile_image);
            if (validateImage) {
              // console.log('Case 1');

              cb(null, true);
            }
          } else {
            // console.log('Case 2');
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
      console.log('====>', err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  },
  /*  add_user_agent_signature: async (req, res, next) => {
    try {
      var upload = multer({
        storage: store_agent_profile_images,
        limits: {
          fileSize: 90000000 // Compliant: 8MB
        },
        fileFilter: (req, signature, cb) => {
          var ext = path.extname(signature.originalname).toLowerCase();

          if (ext == '.png' || ext == '.jpg' || ext == '.jpeg') {
            var validateImage = validatingImage(schemas.agent_profile_image);
            if (validateImage) {
              console.log('Case 1');

              cb(null, true);
            }
          } else {
            console.log('Case 2');
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
      console.log('====>', err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  }, */
  add_user_agent_signature: async (req, res, next) => {
    try {
      var upload = multer({
        storage: store_agent_profile_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          var ext = path.extname(file.originalname).toLowerCase();

          if (ext == '.png' || ext == '.jpg' || ext == '.jpeg') {
            var validateImage = validatingImage(schemas.agent_profile_image);
            if (validateImage) {
              cb(null, true);
            }
          } else {
            cb(null, false);
            return cb('Only .png, .jpg, .jpeg format allowed!', null);
          }
        }
      }).fields([
        { name: 'file', maxCount: 1 },
        { name: 'signature', maxCount: 1 }
      ]);
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
      console.log('====>', err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  },
  add_user_agent_final_signature: async (req, res, next) => {
    try {
      var upload = multer({
        storage: store_agent_profile_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          var ext = path.extname(file.originalname).toLowerCase();

          if (ext == '.png' || ext == '.jpg' || ext == '.jpeg') {
            var validateImage = validatingImage(schemas.agent_profile_image);
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
      console.log('====>', err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  },
  upload_user_document: async (req, res, next) => {
    try {
      /*       var upload = multer({
        storage: store_document,
        limits: {
          fileSize: 200000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          var ext = path.extname(file.originalname).toLowerCase();

          if (
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
            return cb('Only .pdf, .doc, .docx, .xlsx format allowed!', null);
          }
        }
      }).single('file'); */

      /* var upload = multer({
        storage: store_document,
        limits: {
          fileSize: 200000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          var ext = path.extname(file.originalname).toLowerCase();

          if (
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
            return cb('Only .pdf, .doc, .docx, .xlsx format allowed!', null);
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
      }); */

      var upload = multer({
        storage: store_document,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
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
      console.log('====>', err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  },
  upload_application_documents: async (req, res, next) => {
    try {
      var upload = multer({
        storage: store_document,
        limits: {
          fileSize: 1024 * 1024 * 500
        },
        fileFilter: function (_req, files, callback) {
          var ext = path.extname(files.originalname).toLowerCase();
          if (
            ext !== '.pdf' &&
            ext !== '.png' &&
            ext !== '.jpg' &&
            ext !== '.gif' &&
            ext !== '.doc' &&
            ext !== '.docx' &&
            ext !== '.xlsx' &&
            ext !== '.jpeg'
          ) {
            callback(
              'Only files with the following extensions are allowed: pdf, png, jpg, jpeg',
              null
            );
          } else {
            const req = validateBody(schemas.user_document);
            callback(null, true);
          }
        }
      }).array('file', 10);

      upload(req, res, async function (err) {
        if (err) {
          if (err.code == 'LIMIT_FILE_SIZE') {
            //console.log('Please upload file of 8MB');
          }
          res
            .status(400)
            .json({
              status: 2,
              errors: { file: err }
            })
            .end();
        } else {
          console.log('=========', req.files);
          if (req.files && req.files.length > 0) {
            next();
          } else {
            res
              .status(400)
              .json({
                status: 2,
                errors: { message: 'File is Required.' }
              })
              .end();
          }
        }
      });
    } catch (err) {
      console.log('ERR========');
      res
        .status(400)
        .json({
          status: 3,
          message: 'Error uploading files! Please try again later'
        })
        .end();
    }
  }
};

export {
  validateBody,
  validateParam,
  validateBodyController,
  schemas,
  schema_posts
};
