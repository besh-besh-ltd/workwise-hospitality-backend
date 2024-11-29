import Joi from 'joi';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Config from '../../config/app.config.js';
import userModel from '../../models/userModel.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';


const vendorItems = Joi.object({
  user_id: Joi.number().required(),
  name: Joi.string().optional()
});
const specItems = Joi.object({
  title: Joi.string().valid('Size', 'Spec', 'Quantity', 'Unit').required(),
  value: Joi.string().allow('').optional()
});
const termsItems = Joi.object({
  id: Joi.number().required(),
  name: Joi.string().optional()
});

const productItems = Joi.object({
  id : Joi.number().optional().allow(null),
  name: Joi.string().optional().allow(null).allow(''),
  variant: Joi.number().optional().allow('').allow(null),
  product_id: Joi.number().required(),
  comment: Joi.string().optional().allow(null).allow(''),
  datasheet: Joi.string().optional().allow(null).allow(''),
  datasheet_file: Joi.array().items(Joi.string()).optional(),
  spec_file: Joi.array().items(Joi.string()).optional(),
  qap_file: Joi.array().items(Joi.string()).optional(),
  qap: Joi.string().optional().allow(null).allow(''),
  vendors: Joi.array().items(vendorItems).allow(null).allow(''),
  spec: Joi.array()
    .items(specItems)
    .required()
    .min(4)
    .max(4)
    .custom((value, helpers) => {
      const quantityItem = value.find(item => item.title === 'Quantity');
      const unitItem = value.find(item => item.title === 'Unit');
      if (!quantityItem || !unitItem || !quantityItem.value || !unitItem.value) {
        // Pass product-specific information in the context
        return helpers.error('spec.missingRequiredFields', {
          productName: helpers.state.ancestors[0].name,
          productId: helpers.state.ancestors[0].product_id,
        });
      }
      return value;
    })
    .messages({
      'spec.missingRequiredFields': 'Product "{#productName}" requires for "Quantity" and "Unit" in the spec.',
      'any.required': 'The spec array is required and must include complete entries for "Size", "Spec", "Quantity", and "Unit".'
    }),
  defaultSelectedVAB: Joi.string().optional().allow('').allow(null),
  predefined_tds_file: Joi.string().optional().allow('').allow(null),
  predefined_qap_file: Joi.string().optional().allow('').allow(null),
  user_selected_predefined_tds: Joi.boolean().optional().allow('').allow(null),
  user_selected_predefined_qap: Joi.boolean().optional().allow('').allow(null)
});

let store_query_message_upload_file = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.query_message_file)
  },
  filename: function (req, file, callback) {
    var extention = path.extname(file.originalname);
    var new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
})

export const rfqSchemas = {
  create: Joi.object().keys({
    rfq_id: Joi.number().optional().allow('').allow(null),
    comment: Joi.string().optional().allow(''),
    company_name: Joi.string().required(),
    response_email: Joi.string().required(),
    contact_name: Joi.string().required(),
    contact_number: Joi.string()
      .trim()
      .min(10)
      .max(15)
      .required()
      .regex(/^[0-9]*$/),
    bid_end_date: Joi.string().optional().allow('').allow(null),
    location: Joi.string().optional().allow('').allow(null),
    is_published: Joi.number().integer().min(0).max(1).required(),
    rfq_type: Joi.string().valid('firm', 'budgetary').allow('').allow(null),
    reverse_auction: Joi.valid(0, 1).allow(''),
    products: Joi.array().items(productItems).min(1).required(),
    // products: Joi.array().optional().allow('').allow(null),
    vendors: Joi.array().items(vendorItems).allow(null).allow(''),
    terms: Joi.array().items(termsItems).allow(null).allow(''),
    project_id: Joi.number().integer().required(),
    term_and_condition_files: Joi.array().items(Joi.string()).optional(),
  }),
  update: Joi.object().keys({
    rfq_id: Joi.number().required(),
    comment: Joi.string().optional().allow(''),
    company_name: Joi.string().required(),
    response_email: Joi.string().required(),
    contact_name: Joi.string().required(),
    contact_number: Joi.string()
      .trim()
      .min(10)
      .max(15)
      .required()
      .regex(/^[0-9]*$/),
    bid_end_date: Joi.string().required(),
    location: Joi.string().required(),
    is_published: Joi.number().integer().min(0).max(1).required(),
    products: Joi.array().items(productItems).min(1).required(),
    vendors: Joi.array().items(vendorItems).allow(null).allow(''),
    terms: Joi.array().items(termsItems).allow(null).allow('')
  }),
  finalize: Joi.object().keys({
    rfq_id: Joi.number().required(),
    rfq_no: Joi.number().required(),
    product_id: Joi.number().required(),
    vendor_id: Joi.number().required(),
    quote_id: Joi.number().required(),
    variant:Joi.number().required()
  }),
  getAllRfqsForAdminValidation: Joi.object().keys({
    page: Joi.number().integer().optional(), 
    limit: Joi.number().integer().optional(),
    offset: Joi.number().integer().optional(), 
    rfq_status: Joi.string().valid('1', '2').allow(null).optional(), 
    admin_service_status: Joi.string().valid('Pending', 'Working', 'Complete').allow(null).optional(), 
    sort: Joi.string().valid('ASC', 'DESC').optional() 
  }),
  updateRfqStatusValidation: Joi.object().keys({
    rfq_id: Joi.number().integer().required(), 
    status: Joi.string().valid('Pending', 'Working', 'Complete').required(),
    comment: Joi.string().allow('').allow(null).optional()
  }),
  sendMessage: Joi.object().keys({
    rfq_id: Joi.number().required(), 
    receiver_id: Joi.number().required(),
    message_text: Joi.string().trim().required(),
    files: Joi.array()
      .items(
        Joi.object({
          name: Joi.string().optional().allow(null, ''),
          url: Joi.string().uri().required().optional().allow(null, ''),
        })
      )
      .optional()
      .allow(null)
  }),
  queryMessageFileUploadHandler: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_query_message_upload_file,
        limits: {
          fileSize: 8000000, // 8MB
        },
      }).array("files", 10);
      upload(req, res, async function (err) {
        if (err) {
          res.status(400).json({ status: 2, errors: { file: err } });
          return;
        }

        const uploadedFiles = req.files?.map((file) => ({
          name: file.originalname,
          url: `${Config.base_url}/query_message_files/${file.filename}`
        }));
  
        req.files = uploadedFiles;
  
        next();
      });
    } catch (err) {
      console.error("Server error:", err);
      res.status(500).json({ status: 3, message: "server error" });
    }
  },

  // technical_evaluation
  addClause: Joi.object().keys({
    rfq_id: Joi.number().integer().required(),
    rfq_product_id: number().integer().required(),
    clause_text: Joi.string().required(),
    file_url: Joi.array()
    .items(
      Joi.string()
        .uri()
        .required()
    )
    .optional()
    .allow(null)
    // file_url: Joi.alternatives().try(
    //   Joi.array()
    //     .items(
    //       Joi.string()
    //         .uri()
    //         .trim()
    //         .allow('')
    //     )
    //     .optional()
    //     .custom((value, helpers) => {
    //       const filtered = value.filter((url) => url !== '');
    //       return filtered;
    //     }),
    //   Joi.allow(null)
    // ).default([]),
  }),

  updateClause: Joi.object().keys({
    clause_id: Joi.number().integer().required(),
    clause_text: Joi.string().required(),
    file_url: Joi.array()
      .items(
        Joi.string()
          .uri()
          .required()
      )
      .optional()
      .allow(null)
  }),

  id: Joi.object().keys({
    id: Joi.number().integer().required(),
  }),

  getClauses: Joi.object().keys({
    tbl_rfq_product_tech_evaluation_id: Joi.number().integer().required(),
  }),

  addTechComment: Joi.object().keys({
    clause_id: Joi.number().integer().required(),
    sender_id: Joi.number().integer().required(),
    receiver_id: Joi.number().integer().required(),
    text: Joi.string().required(),
    file_url: Joi.array()
      .items(
        Joi.string()
          .uri()
          .required()
      )
      .optional()
      .allow(null)
  }),

  getTechComments: Joi.object().keys({
    clause_id: Joi.number().integer().required(),
    sender_id:Joi.number().integer().required(),
    receiver_id: Joi.number().integer().required()
  }),
  
  getVendorNames: Joi.object().keys({
    rfq_id: Joi.number().integer().required(),
    rfq_product_id: Joi.number().integer().required()
  }),

  getVendorResponses: Joi.object().keys({
    rfq_id: Joi.number().integer().required(),
    rfq_product_id: Joi.number().integer().required(),
    vendor_id: Joi.number().integer().required()
  }),

addVendorResponse: Joi.array().items(
    Joi.object({
      vendor_id: Joi.number().integer().required(),
      clause_id: Joi.number().integer().required(),
      vendor_response: Joi.string().required(),
      file_url: Joi.array()
        .items(
          Joi.string()
            .uri()
            .required()
        )
        .optional()
        .allow(null)
    })
  ).min(1)
  .required(),

  addtechEvaluationClearedVendors: Joi.object({
    vendor_id: Joi.number().integer().required(),
    rfq_product_tech_evaluation_id: Joi.number().integer().required(),
    status: Joi.valid(null, 0, 1).required(),
    reject_message: Joi.string().allow(null, '').optional()
  }),

  getClausesOfProduct: Joi.object({
    rfq_product_id: Joi.number().integer().required(),
    vendor_id: Joi.number().integer().allow(null).optional()
  }),

  getTechEvaluationResult: Joi.object({
    rfq_product_id: Joi.number().integer().required(),
    vendor_id: Joi.number().integer().required()
  })

};
