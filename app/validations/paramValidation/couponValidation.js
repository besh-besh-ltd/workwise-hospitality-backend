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
  id: Joi.object().keys({
    id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper id')
  }),
  create_coupon: Joi.object().keys({
    coupon: Joi.string().trim().required(),
    is_percentage: Joi.boolean().required(),
    discount_amount: Joi.string()
      .required()
      .regex(/^[-+]?[0-9]*\.?[0-9]+$/, 'Please send proper amount'),
    start_date: Joi.date().iso().required(),
    end_date: Joi.date().iso().min(Joi.ref('start_date')).required(),
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'status should be 0 or 1')
  }),
  add_offer: Joi.object().keys({
    text: Joi.string().trim().required(),
    price: Joi.string()
      .required()
      .regex(/^[-+]?[0-9]*\.?[0-9]+$/, 'Please send proper price'),
    is_percentage: Joi.boolean().required(),
    subscription_plan_id: Joi.array().items(Joi.number().integer()).required(),
    start_date: Joi.date().iso().required(),
    end_date: Joi.date().iso().min(Joi.ref('start_date')).required(),
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'status should be 0 or 1')
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
  }
};

export { validateBody, validateParam, schemas, schema_posts };
