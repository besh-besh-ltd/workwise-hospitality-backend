import Joi from 'joi';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import multerS3 from 'multer-s3';
import s3Client from '../../config/s3config.js';

// S3 storage for hospitality documents
const store_hospitality_document = multerS3({
  s3: s3Client,
  bucket: process.env.AWS_S3_BUCKET,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const fileName = `${Date.now()}-${uuidv4()}${ext}`;
    const fullPath = `hospitality_documents/${fileName}`;
    cb(null, fullPath);
  }
});

// GST validation: 15 characters, alphanumeric (format: 27AABCU9603R1ZX)
const gstPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

// PAN validation: 10 characters, alphanumeric (format: ABCDE1234F)
const panPattern = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

// Helper function to validate GST
const validateGST = (value, helpers) => {
  if (!value || value.trim() === '') {
    return value; // Optional field, allow empty
  }
  const upperValue = value.toUpperCase().trim();
  if (!gstPattern.test(upperValue)) {
    return helpers.message('GST must be 15 characters in format: 27AABCU9603R1ZX');
  }
  return upperValue;
};

// Helper function to validate PAN
const validatePAN = (value, helpers) => {
  if (!value || value.trim() === '') {
    return helpers.message('PAN is required');
  }
  const upperValue = value.toUpperCase().trim();
  if (!panPattern.test(upperValue)) {
    return helpers.message('PAN must be 10 characters in format: ABCDE1234F');
  }
  return upperValue;
};

const validateBody = (schema) => {
  return (req, res, next) => {
    const result = schema.validate(req.body, { abortEarly: false });

    if (result.error) {
      const errMsg = {};
      for (const detail of result.error.details) {
        errMsg[detail.context.key] = detail.message;
      }
      return res.status(400).json({ status: 2, errors: errMsg });
    }

    if (!req.value) {
      req.value = {};
    }
    req.value.body = result.value;
    next();
  };
};

const validateParam = (schema) => {
  return (req, res, next) => {
    const result = schema.validate(req.params);
    if (result.error) {
      return res.status(400).json({ status: 2, errors: 'Invalid argument' });
    }

    if (!req.value) {
      req.value = {};
    }
    req.value.params = result.value;
    next();
  };
};

const schemas = {
  companyIdParam: Joi.object()
    .keys({
      company_id: Joi.number().integer().required(),
    })
    .required(),
  hotelIdParam: Joi.object()
    .keys({
      company_id: Joi.number().integer().required(),
      hotel_id: Joi.number().integer().required(),
    })
    .required(),
  hospitalityCompany: Joi.object().keys({
    name: Joi.string().trim().max(120).required(),
    region: Joi.string().trim().allow('', null),
    contact_email: Joi.string()
      .trim()
      .email({ tlds: { allow: false } })
      .allow('', null),
    registered_office_address: Joi.string().trim().allow('', null),
    corporate_office_address: Joi.string().trim().allow('', null),
    gst: Joi.string().trim().custom(validateGST).allow('', null),
    pan: Joi.string().trim().custom(validatePAN).required(),
    bank_account_number: Joi.string().trim().allow('', null),
    bank_name: Joi.string().trim().allow('', null),
    ifsc_code: Joi.string().trim().max(20).allow('', null),
    account_holder_name: Joi.string().trim().allow('', null),
    msme: Joi.string().trim().allow('', null),
  }),
  hospitalityHotel: Joi.object().keys({
    name: Joi.string().trim().max(120).required(),
    city: Joi.string().trim().allow('', null),
    keys: Joi.number().integer().min(0).optional(),
    status: Joi.string().trim().max(50).allow('', null),
    full_address: Joi.string().trim().allow('', null),
    state: Joi.string().trim().max(100).allow('', null),
    gst: Joi.string().trim().custom(validateGST).allow('', null),
    pan: Joi.string().trim().custom((value, helpers) => {
      if (!value || value.trim() === '') {
        return value; // Optional for hotels
      }
      const upperValue = value.toUpperCase().trim();
      if (!panPattern.test(upperValue)) {
        return helpers.message('PAN must be 10 characters in format: ABCDE1234F');
      }
      return upperValue;
    }).allow('', null),
    bank_account_number: Joi.string().trim().allow('', null),
    bank_name: Joi.string().trim().allow('', null),
    ifsc_code: Joi.string().trim().max(20).allow('', null),
    account_holder_name: Joi.string().trim().allow('', null),
    msme: Joi.string().trim().allow('', null),
    delivery_address: Joi.string().trim().allow('', null),
  }),
  hospitalityMapUsers: Joi.object().keys({
    mapping_type: Joi.number().valid(0, 1).required(),
    hotel_id: Joi.when('mapping_type', {
      is: 1,
      then: Joi.number().required(),
      otherwise: Joi.any().optional().allow(null),
    }),
    user_ids: Joi.array().items(Joi.number().required()).min(1).required(),
    auto_map_projects: Joi.boolean().optional(),
  }),
  hospitalityMapProjects: Joi.object().keys({
    mapping_type: Joi.number().valid(0, 1).required(),
    hotel_id: Joi.when('mapping_type', {
      is: 1,
      then: Joi.number().required(),
      otherwise: Joi.any().optional().allow(null),
    }),
    project_ids: Joi.array().items(Joi.number().required()).min(1).required(),
  }),
  hospitalitySubscriptionPayment: Joi.object().keys({
    user_key: Joi.string().required(),
    categories: Joi.array()
      .items(Joi.number().integer().positive())
      .min(1)
      .required(),
    subcategories: Joi.array()
      .items(Joi.number().integer().positive())
      .optional(),
    hotels: Joi.array()
      .items(Joi.number().integer().positive())
      .min(1)
      .allow(null),
  }),
  deleteMapping: Joi.object().keys({
    company_id: Joi.number().integer().required(),
    mapping_type: Joi.number().valid(0, 1).required(),
    hotel_id: Joi.when('mapping_type', {
      is: 1,
      then: Joi.number().required(),
      otherwise: Joi.any().optional().allow(null),
    }),
  }),

  rfqIdParam: Joi.object()
    .keys({
      rfq_id: Joi.number().integer().required(),
    })
    .required(),
  
};

const uploadHospitalityDocuments = async (req, res, next) => {
  try {
    const upload = multer({
      storage: store_hospitality_document,
      limits: {
        fileSize: 26214400 // 25MB
      },
      fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (
          ext === '.png' ||
          ext === '.jpg' ||
          ext === '.jpeg' ||
          ext === '.pdf' ||
          ext === '.doc' ||
          ext === '.docx'
        ) {
          cb(null, true);
        } else {
          cb(new Error('File format not allowed! Only .png, .jpg, .jpeg, .pdf, .doc, .docx are allowed.'), false);
        }
      }
    }).fields([
      { name: 'gst', maxCount: 1 },
      { name: 'pan', maxCount: 1 },
      { name: 'cancelled_cheque', maxCount: 1 },
      { name: 'msme', maxCount: 1 }
    ]);

    upload(req, res, function (err) {
      if (err) {
        return res.status(400).json({
          status: 2,
          errors: { file: err.message || 'File upload failed' }
        });
      }
      next();
    });
  } catch (err) {
    return res.status(400).json({
      status: 3,
      message: 'Server error during file upload'
    });
  }
};

export { validateBody, validateParam, schemas, uploadHospitalityDocuments };


