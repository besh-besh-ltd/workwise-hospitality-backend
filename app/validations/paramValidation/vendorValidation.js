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
var store_vendor_approve_docs = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.vendor_approve);
  },
  filename: function (req, file, callback) {
    var extention = path.extname(file.originalname);
    var new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});

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

const schemas = {
  // create_category: Joi.object().keys({
  //   name: Joi.string().required(),
  //   parent_id: Joi.string().optional().allow(null).allow(''),
  //   status: Joi.string()
  //     .required()
  //     .regex(/^[0-9]*$/, 'numeric values only')
  // })
  vendor_register: Joi.object().keys({
    name: Joi.string().required(),
    email: Joi.string().required().email().max(100),
    mobile: Joi.string().min(8).max(11).required().label('Mobile'),
    organization_name: Joi.string().min(4).required(),
    address: Joi.string().optional().allow(null).allow(''),
    postal_code: Joi.string().optional().allow(null).allow(''),
    city: Joi.string().optional().allow(null).allow(''),
    state: Joi.string().optional().allow(null).allow(''),
    country: Joi.string().optional().allow(null).allow(''),
    website: Joi.string().optional().allow(null).allow(''),
    nature_business: Joi.string().optional().allow(null).allow(''),
    estd_year: Joi.string().optional().allow(null).allow(''),
    sales_spoc_name: Joi.string().optional().allow(null).allow(''),
    sales_spoc_position: Joi.string().optional().allow(null).allow(''),
    sales_spoc_business_email: Joi.string().optional().allow(null).allow(''),
    sales_spoc_mobile: Joi.string().optional().allow(null).allow(''),
    gstin: Joi.string().optional().allow(null).allow(''),
    import_export_code: Joi.string().optional().allow(null).allow(''),
    cin: Joi.string().optional().allow(null).allow(''),
    turn_over: Joi.string().optional().allow(null).allow(''),
    total_employees: Joi.string().optional().allow(null).allow(''),
    ptr_project_name: Joi.string().optional().allow(null).allow(''),
    ptr_project_description: Joi.string().optional().allow(null).allow(''),
    ptr_project_start_date: Joi.string().optional().allow(null).allow(''),
    ptr_project_end_date: Joi.string().optional().allow(null).allow(''),
    about_vendor_company: Joi.string().optional().allow(null).allow(''),
    image: Joi.string().optional().allow(null).allow(''),
    logo: Joi.string().optional().allow(null).allow(''),
    ptr_track: Joi.string().optional().allow(null).allow(''),
    certifications: Joi.string().optional().allow(null).allow(''),
    brochure: Joi.string().optional().allow(null).allow('')
  }),
  id: Joi.object().keys({
    id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper id')
  }),
  approval: Joi.object().keys({
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only'),
    reject_reason: Joi.string().trim().optional().allow(null, ''),
    reject_reason_id: Joi.string()
      .optional()
      .regex(/^\d+$/, 'numeric values only')
  }),
  add_vendor_approve: Joi.object().keys({
    name: Joi.string().required(),
    logo: Joi.string().optional(),
    tds: Joi.string().optional(),
    qap: Joi.string().optional(),
    status: Joi.string()
      .optional()
      .regex(/^[0|1]$/, 'numeric values only'),
    show_in_website: Joi.string()
      .optional()
      .regex(/^[0|1]$/, 'numeric values only')
  })
};

const schema_posts = {
  add_vendor: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_profile_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();
          if (file.fieldname == 'image' || file.fieldname == 'logo') {
            if (
              ext == '.png' ||
              ext == '.jpg' ||
              ext == '.jpeg' ||
              ext == '.webp'
            ) {
              cb(null, true);
            } else {
              cb(null, false);
              return cb('Only .png, .jpg, .jpeg, .webp format allowed!', null);
            }
          } else {
            cb(null, true);
            /* if (ext == '.pdf') {
              cb(null, true);
            } else {
              cb(null, false);
              return cb('Only .pdf format allowed!', null);
            } */
          }
        }
      }).fields([
        { name: 'image', maxCount: 1 },
        { name: 'logo', maxCount: 1 },
        { name: 'ptr_track', maxCount: 1 },
        { name: 'certifications', maxCount: 1 },
        { name: 'brochure', maxCount: 1 }
      ]);
      upload(req, res, async function (err) {
        if (err) {
          let data = {};
          data.file_name = err;
          res
            .status(400)
            .json({
              status: 2,
              message: data.file_name
            })
            .end();
        } else {
          const result = schemas.vendor_register.validate(req.body, {
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
          } else {
            let error = {};
            let errCount = 0;
            if (errCount > 0) {
              res
                .status(400)
                .json({
                  status: 2,
                  errors: error
                })
                .end();
            } else {
              next();
            }
          }
        }
      });
    } catch (err) {
      logError(err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  },
  add_vendor_approve: async (req, res, next) => {
    try {
      const upload = multer({
        storage: store_vendor_approve_docs,
        limits: {
          fileSize: 2000000 // Limit file size to 2MB
        },
        fileFilter: (req, file, cb) => {
          const ext = path.extname(file.originalname).toLowerCase();
          // console.log('ext-->', ext);
          // console.log('file name-->', file.fieldname);

          // File type validation
          if (file.fieldname === 'tds' || file.fieldname === 'qap') {
            if (ext === '.pdf') {
              cb(null, true);
            } else {
              cb(new Error('Only .pdf format allowed!'), false);
            }
          } else if (file.fieldname === 'logo') {
            if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
              cb(null, true);
            } else {
              cb(
                new Error('Only .png, .jpg, .jpeg, .webp format allowed!'),
                false
              );
            }
          } else {
            cb(new Error('Unexpected field name!'), false);
          }
        }
      }).fields([
        { name: 'logo', maxCount: 1 },
        { name: 'tds', maxCount: 1 },
        { name: 'qap', maxCount: 1 }
      ]);

      upload(req, res, async (err) => {
        if (err) {
          return res.status(400).json({
            status: 2,
            message: err.message
          });
        }

        const result = schemas.add_vendor_approve.validate(req.body, {
          abortEarly: false
        });

        if (result.error) {
          const err_msg = {};
          for (const detail of result.error.details) {
            const key = detail.context.key;
            const val = detail.message;
            err_msg[key] = val;
          }
          const return_err = { status: 2, errors: err_msg };
          return res.status(400).json(return_err);
        } else {
          const error = {};
          const errCount = 0;
          if (errCount > 0) {
            return res.status(400).json({
              status: 2,
              errors: error
            });
          } else {
            next();
          }
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
  /*   add_vendor_approve: async (req, res, next) => {
    try {
      const upload = multer({
        storage: store_vendor_approve_docs,
        limits: {
          fileSize: 2000000 // Limit file size to 2MB
        },
        fileFilter: (req, file, cb) => {
          const ext = path.extname(file.originalname).toLowerCase();
          console.log('ext-->', ext);
          console.log('file name-->', file.fieldname);

          // File type validation
          if (file.fieldname === 'tds' || file.fieldname === 'qap') {
            if (ext === '.pdf') {
              cb(null, true);
            } else {
              // cb(null, false);
              return cb('Only .pdf format allowed!', null);
            }
          } else if (file.fieldname === 'logo') {
            if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
              cb(null, true);
            } else {
              cb(null, false);
              return cb('Only .png, .jpg, .jpeg, .webp format allowed!', null);
            }
          }
        }
      }).fields([
        { name: 'logo', maxCount: 1 },
        { name: 'tds', maxCount: 1 },
        { name: 'qap', maxCount: 1 }
      ]);

      upload(req, res, async function (err) {
        if (err) {
          const data = { file_name: err };
          return res
            .status(400)
            .json({
              status: 2,
              message: data.file_name
            })
            .end();
        } else {
          const result = schemas.add_vendor_approve.validate(req.body, {
            abortEarly: false
          });
          if (result.error) {
            const err_msg = {};
            for (const detail of result.error.details) {
              const key = detail.context.key;
              const val = detail.message;
              err_msg[key] = val;
            }
            const return_err = { status: 2, errors: err_msg };
            return res.status(400).json(return_err);
          } else {
            const error = {};
            const errCount = 0;
            if (errCount > 0) {
              return res
                .status(400)
                .json({
                  status: 2,
                  errors: error
                })
                .end();
            } else {
              next();
            }
          }
        }
      });
    } catch (err) {
      logError(err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  } */
  /*   add_vendor_approve: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_vendor_approve_docs,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();
          console.log('ext-->', ext);
          console.log('file name-->', file.fieldname);
          if (file.fieldname == 'tds' || file.fieldname == 'qap') {
            if (ext == '.pdf') {
              cb(null, true);
            } else {
              console.log('right block');
              cb(null, false);
              return cb('Only .pdf format allowed!', null);
            }
          } else {
            if (
              ext == '.png' ||
              ext == '.jpg' ||
              ext == '.jpeg' ||
              ext == '.webp'
            ) {
              cb(null, true);
            } else {
              cb(null, false);
              return cb('Only .png, .jpg, .jpeg, .webp format allowed!', null);
            }
          }
        }
      }).fields([
        { name: 'logo', maxCount: 1 },
        { name: 'tds', maxCount: 1 },
        { name: 'qap', maxCount: 1 }
      ]);
      upload(req, res, async function (err) {
        if (err) {
          let data = {};
          data.file_name = err;
          res
            .status(400)
            .json({
              status: 2,
              message: data.file_name
            })
            .end();
        } else {
          const result = schemas.add_vendor_approve.validate(req.body, {
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
          } else {
            let error = {};
            let errCount = 0;
            if (errCount > 0) {
              res
                .status(400)
                .json({
                  status: 2,
                  errors: error
                })
                .end();
            } else {
              next();
            }
          }
        }
      });
    } catch (err) {
      logError(err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  } */
};

export { validateBody, validateParam, schemas, schema_posts };
