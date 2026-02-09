import Joi from 'joi';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Config from '../../config/app.config.js';
import userModel from '../../models/userModel.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import multerS3 from 'multer-s3';
import s3Client from '../../config/s3config.js';


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
  name: Joi.string().optional(),
  term_content : Joi.string().optional()
});

const productItems = Joi.object({
  id : Joi.number().optional().allow(null),
  name: Joi.string().optional().allow(null).allow(''),
  product_name: Joi.string().optional().allow(null).allow(''),
  variant: Joi.number().optional().allow('').allow(null),
  product_id: Joi.number().required(),
  comment: Joi.string().optional().allow(null).allow(''),
  datasheet: Joi.string().optional().allow(null).allow(''),
  datasheet_file: Joi.array().items(Joi.string()).optional(),
  spec_file: Joi.array().items(Joi.string()).optional(),
  qap_file: Joi.array().items(Joi.string()).optional(),
  qap: Joi.string().optional().allow(null).allow(''),
  sheet_id: Joi.number().optional().allow(null),
  sheet_name: Joi.string().optional().allow(null).allow(''),
  vendors: Joi.array()
    .items(vendorItems)
    .min(1)
    .required()
    .custom((value, helpers) => {
      const productName = helpers.state.ancestors[0].name; // Accessing product name from ancestors
      if (value.length < 1) {
        return helpers.error('array.min', { limit: 1, productName });
      }
      return value; // Return value if validation passes
    })
    .messages({
      'array.base': 'Vendors must be an array',
      'any.required': 'Vendors are required for product "{#productName}".',
      'array.min': 'At least {#limit} vendor required for product - "{#productName}".'
    }),
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

let store_query_message_upload_file = multerS3({
  s3: s3Client,
  bucket: process.env.AWS_S3_BUCKET, // Directly specified bucket name
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: function (req, file, cb) {
    // 1. Extract file extension
    const ext = path.extname(file.originalname).toLowerCase();

    // 2. Generate unique filename with timestamp + UUID
    const fileName = `${Date.now()}-${uuidv4()}${ext}`;

    // 3. Create full S3 path matching your URL structure
    const fullPath = `query_message_files/${fileName}`; // Exact path you want

    // 4. Pass the complete path to callback
    cb(null, fullPath);
  }
});

// S3 storage for clarification files (one-at-a-time clarification system)
let store_clarification_upload_file = multerS3({
  s3: s3Client,
  bucket: process.env.AWS_S3_BUCKET,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const fileName = `${Date.now()}-${uuidv4()}${ext}`;
    const fullPath = `clarification_files/${fileName}`;
    cb(null, fullPath);
  }
});



// let store_query_message_upload_file = multer.diskStorage({
//   destination: function (req, file, callback) {
//     callback(null, Config.upload.query_message_file)
//   },
//   filename: function (req, file, callback) {
//     var extention = path.extname(file.originalname);
//     var new_file_name = +new Date() + '-' + uuidv4() + extention;
//     callback(null, new_file_name);
//   }
// })

const today = new Date();
const tomorrow = new Date(today);
tomorrow.setDate(tomorrow.getDate() + 1);
const tomorrowString = tomorrow.toISOString().slice(0, 10); // Format as YYYY-MM-DD

// Get today's date at the beginning of the day for comparison
const todayForComparison = new Date(today);
todayForComparison.setHours(0, 0, 0, 0);
const todayString = todayForComparison.toISOString().slice(0, 10); // Format as YYYY-MM-DD

export const rfqSchemas = {
  // Technical summary lead form (public)
  technicalSummary: Joi.object({
    fullName: Joi.string().optional(),
    companyName: Joi.string().optional(),
    designation: Joi.string().optional(),
    workEmail: Joi.string().email().optional(),
    phoneNumber: Joi.string().optional()
  }),

  create: Joi.object().keys({
    rfq_id: Joi.number().optional().allow('').allow(null),
    comment: Joi.string().optional().allow(''),
    company_name: Joi.string().required(),
    response_email: Joi.string().required(),
    contact_name: Joi.string().required(),
    contact_number: Joi.string()
      .trim()
      .min(7)
      .max(20) // Increased to accommodate country codes
      .required()
      .regex(/^(?:\+\d{1,4}-)?\d{6,15}$/)
      .messages({
        'string.pattern.base':
          'Contact number must be in the format +<country_code>-<mobile_number> or just <mobile_number>.'
      }),
    bid_end_date: Joi.string()
      .optional()
      .allow(null)
      .allow('')
      .custom((value, helpers) => {
        if (value && new Date(value) <= tomorrow) {
          return helpers.message(
            `bid_end_date must be greater than ${tomorrowString}`
          );
        }
        return value;
      }),
    ra_start_date: Joi.string()
      .optional()
      .allow(null)
      .allow('')
      .custom((value, helpers) => {
        // mukul: 04/may/2025 : Check if reverse_auction is 1 and bid_end_date is present, and ra_start_date is after bid end date only
        const { reverse_auction, bid_end_date } = helpers.state.ancestors[0];

        if (value && reverse_auction === 1 && bid_end_date) {
          const raStart = new Date(value);
          const bidEnd = new Date(bid_end_date);

          if (
            raStart.toDateString() === bidEnd.toDateString() ||
            raStart < bidEnd
          ) {
            return helpers.message(
              'Reverse Auction Start Date must be after the Procurement End Date'
            );
          }

          const now = new Date();
          if (raStart < now) {
            return helpers.message('ra_start_date cannot be in the past');
          }
        }

        return value;
      }),

    ra_end_date: Joi.string()
      .optional()
      .allow(null)
      .allow('')
      .custom((value, helpers) => {
        const { ra_start_date } = helpers.state.ancestors[0];

        // mukul: 04/may/2025 : Check if reverse_auction is 1 and ra_start_date is present, and ra_end_date is after ra_start_date only with 60min gap
        if (value && ra_start_date) {
          const raEnd = new Date(value);
          const raStart = new Date(ra_start_date);

          const diffInMinutes = (raEnd - raStart) / (1000 * 60); // convert ms to minutes

          if (diffInMinutes < 60) {
            return helpers.message(
              'Reverse Auction End Date & Time must be at least 60 minutes after the Reverse Auction Start Time.'
            );
          }
        }
        return value;
      }),
    location: Joi.string().optional().allow('').allow(null),
    is_published: Joi.number().integer().min(0).max(1).required(),
    rfq_type: Joi.string().valid('firm', 'budgetary').allow('').allow(null),
    rfq_added_from: Joi.string().valid('magic', 'manual').allow('').allow(null),
    reverse_auction: Joi.valid(0, 1).allow(''),
    sheet_id: Joi.number().optional().allow(null),
    updatableData: Joi.object().optional(),
    filters: Joi.object().optional(),
    termsChanged: Joi.boolean().optional(),
    termFilesChanged: Joi.boolean().optional(),
    selectedSheets: Joi.array().items(Joi.number()).allow(null),
    terms: Joi.array().items(termsItems).allow(null).allow(''),
    project_id: Joi.number().integer().required(),
    term_and_condition_files: Joi.array().items(Joi.string()).optional(),
    is_tender: Joi.number().integer().valid(0, 1).optional().allow(null),
    tender_fees: Joi.number().integer().min(0).optional().allow(null),
    tender_publish_date: Joi.string().optional().allow(null).allow(''),
    vendor_clarification_date: Joi.string().optional().allow(null).allow(''),
    hospitality_company_id: Joi.number().integer().optional().allow(null),
    hotel_id: Joi.number().integer().optional().allow(null),
    hotel_ids: Joi.array().items(Joi.number()).optional().allow(null),
    department_id: Joi.number().integer().optional().allow(null),
    title: Joi.string().required(),
  }),
  update: Joi.object().keys({
    rfq_id: Joi.number().required(),
    response_email: Joi.string().required(),
    contact_name: Joi.string().required(),
    status: Joi.number().allow(1, 2).optional(),
    termsChanged: Joi.boolean().optional(),
    selectedTerms: Joi.array().items(termsItems).allow(null).allow(''),
    contact_number: Joi.string().trim().min(6).max(17).required(),
    is_tender: Joi.number().required(),
    tender_fees: Joi.number().integer().min(0).optional().allow(null),
    tender_publish_date: Joi.string().optional().allow(null).allow(''),
    vendor_clarification_date: Joi.string().optional().allow(null).allow(''),
    hospitality_company_id: Joi.number().integer().optional().allow(null),
    hotel_id: Joi.number().integer().optional().allow(null),
    hotel_ids: Joi.array().items(Joi.number()).optional().allow(null),
    title: Joi.string().required(),
    technical_evaluation_by: Joi.number().integer().required(),
    bid_end_date: Joi.string()
      .optional()
      .allow(null)
      .allow('')
      .custom((value, helpers) => {
        if (value && new Date(value) <= tomorrow) {
          return helpers.message(
            `bid_end_date must be greater than ${tomorrowString}`
          );
        }
        return value;
      }),
    ra_start_date: Joi.string()
      .optional()
      .allow(null)
      .allow('')
      .custom((value, helpers) => {
        // mukul: 04/may/2025 : Check if reverse_auction is 1 and bid_end_date is present, and ra_start_date is after bid end date only
        const { reverse_auction, bid_end_date } = helpers.state.ancestors[0];

        if (value && reverse_auction === 1 && bid_end_date) {
          const raStart = new Date(value);
          const bidEnd = new Date(bid_end_date);

          if (
            raStart.toDateString() === bidEnd.toDateString() ||
            raStart < bidEnd
          ) {
            return helpers.message(
              'Reverse Auction Start Date must be after the Procurement End Date'
            );
          }

          const now = new Date();
          if (raStart < now) {
            return helpers.message('ra_start_date cannot be in the past');
          }
        }

        return value;
      }),
    ra_end_date: Joi.string()
      .optional()
      .allow(null)
      .allow('')
      .custom((value, helpers) => {
        const { ra_start_date } = helpers.state.ancestors[0];

        // mukul: 04/may/2025 : Check if reverse_auction is 1 and ra_start_date is present, and ra_end_date is after ra_start_date only with 60min gap
        if (value && ra_start_date) {
          const raEnd = new Date(value);
          const raStart = new Date(ra_start_date);

          const diffInMinutes = (raEnd - raStart) / (1000 * 60); // convert ms to minutes

          if (diffInMinutes < 60) {
            return helpers.message(
              'Reverse Auction End Date & Time must be at least 60 minutes after the Reverse Auction Start Time.'
            );
          }
        }
        return value;
      }),
    project_id: Joi.number().integer().allow(null).optional(),
    rfq_type: Joi.string().trim().optional(),
    reverse_auction: Joi.valid(0, 1).allow(''),
    location: Joi.string().optional().allow('').allow(null),
    updatableData: Joi.object().optional(),
    department_id: Joi.number().integer().optional().allow(null)
  }).unknown(false),
  finalize: Joi.object().keys({
    rfq_id: Joi.number().required(),
    rfq_no: Joi.number().required(),
    product_variant_id: Joi.number().required(),
    vendor_id: Joi.number().required(),
    quote_id: Joi.number().required(),
    quote_item_id: Joi.number().required(),
    existing_po_id: Joi.number().optional().allow(null),
    variant: Joi.number().required(),
    route_type: Joi.string().valid('ARC', 'PO').optional().allow(null), // ARC or PO route selection

    // PO Related Validations (only required for PO route)
    project_id: Joi.number().optional().allow(null),
    total_value: Joi.number().optional().allow(null), // Optional for ARC route
    product_info: Joi.object({
      rfq_product_id: Joi.number().required(),
      quantity: Joi.number().required(),
      unit: Joi.string().required(),
      charges_meta: Joi.object().optional(),
      unit_price: Joi.number().required(),
      finalized_vendor_id: Joi.number().required()
    }).optional(), // Optional for ARC route
    selected_hierarchy: Joi.number().optional().allow(null),
  }),
  getAllRfqsForAdminValidation: Joi.object().keys({
    page: Joi.number().integer().optional(),
    limit: Joi.number().integer().optional(),
    offset: Joi.number().integer().optional(),
    rfq_status: Joi.string().valid('1', '2').allow(null, '').optional(),
    rfq_no: Joi.string().allow(null, '').optional(),
    company: Joi.array().items(Joi.number()).optional(),
    admin_service_status: Joi.string()
      .valid('Pending', 'Working', 'Complete')
      .allow(null, '')
      .optional(),
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
          url: Joi.string().uri().required().optional().allow(null, '')
        })
      )
      .optional()
      .allow(null)
  }),
  sendMessageToVendors: Joi.object().keys({
    rfq_id: Joi.number().required(),
    vendor_id: Joi.array()
      .items(
        Joi.object({
          id: Joi.number().required()
        })
      )
      .required(),
    message_text: Joi.string().trim().required(),
    files: Joi.array()
      .items(
        Joi.object({
          name: Joi.string().optional().allow(null, ''),
          url: Joi.string().uri().required().optional().allow(null, '')
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
           fileSize: 100 * 1024 * 1024 // 100 MB in bytes
        }
      }).array('files', 10);
      upload(req, res, async function (err) {
        if (err) {
          res.status(400).json({ status: 2, errors: { file: err } });
          return;
        }
        // console.log('File upload successful:', req.files);
        // const uploadedFiles = req.files?.map((file) => ({
        //   name: file.originalname,
        //   url: `${Config.base_url}/query_message_files/${file.filename}`
        // }));

        // req.files = uploadedFiles;
        // console.log('Uploaded files:', req.files);
        next();
      });
    } catch (err) {
      console.error('Server error:', err);
      res.status(500).json({ status: 3, message: 'server error' });
    }
  },

  // technical_evaluation
  addClause: Joi.object().keys({
    rfq_id: Joi.number().integer().required(),
    rfq_product_id: Joi.number().integer().required(),
    clause_text: Joi.string().required(),
    file_url: Joi.array().items(Joi.string().uri()).optional().allow(null),
    clause_type: Joi.string().valid('clause', 'sampling').default('clause'),
    weightage: Joi.number().integer().min(0).optional().allow(null)
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
  addClauseUsingFile: Joi.object({
    rfq_id: Joi.number().integer().optional(),
    rfq_product_id: Joi.number().integer().optional()
  }),
  updateClause: Joi.object().keys({
    clause_id: Joi.number().integer().required(),
    clause_text: Joi.string().required(),
    file_url: Joi.array().items(Joi.string().uri()).optional().allow(null),
    clause_type: Joi.string().valid('clause', 'sampling').optional(),
    weightage: Joi.number().integer().min(0).optional().allow(null)
  }),

  id: Joi.object().keys({
    id: Joi.number().integer().required()
  }),

  getClauses: Joi.object().keys({
    rfq_id: Joi.number().integer().required(),
    rfq_product_id: Joi.number().integer().optional()
  }),

  addTechComment: Joi.object().keys({
    clause_id: Joi.number().integer().required(),
    sender_id: Joi.number().integer().required(),
    receiver_id: Joi.number().integer().required(),
    text: Joi.string().required(),
    file_url: Joi.array().items(Joi.string().uri()).optional().allow(null)
  }),

  getTechComments: Joi.object().keys({
    clause_id: Joi.number().integer().required(),
    sender_id: Joi.number().integer().required(),
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

  addVendorResponse: Joi.array()
    .items(
      Joi.object({
        rfq_id: Joi.number().integer().required(),
        rfq_product_id: Joi.number().integer().required(),
        vendor_id: Joi.number().integer().required(),
        clause_id: Joi.number().integer().required(),
        vendor_response: Joi.string().optional().allow('').allow(null),
        file_url: Joi.array().items(Joi.string().uri()).optional().allow(null)
      })
    )
    .min(1),

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

  updateMinimumPassingScore: Joi.object({
    rfq_id: Joi.number().integer().required(),
    rfq_product_id: Joi.number().integer().required(),
    minimum_passing_score: Joi.number().integer().min(0).max(100).required()
  }),

  updateBuyerMarks: Joi.object({
    clause_id: Joi.number().integer().required(),
    vendor_id: Joi.number().integer().required(),
    buyer_marks: Joi.number().integer().min(0).optional().allow(null),
    buyer_remark: Joi.string().optional().allow(null, '')
  }),

  getTechEvaluationResult: Joi.object({
    rfq_id: Joi.number().integer().optional(),
    rfq_product_id: Joi.number().integer().required(),
    vendor_id: Joi.number().integer().required()
  }),

  technicalSummary: Joi.object({
    fullName: Joi.string().optional(),
    companyName: Joi.string().optional(),
    designation: Joi.string().optional(),
    workEmail: Joi.string().email().optional(),
    phoneNumber: Joi.string().optional()
  }),

  techEvalSubmitForApproval: Joi.object({
    rfq_id: Joi.number().integer().required(),
    rfq_product_id: Joi.number().integer().required(),
    is_tender: Joi.boolean().optional() // No longer required - fetched from database
  }),

  techEvalApprovalAction: Joi.object({
    approval_instance_id: Joi.number().integer().required(),
    approval_instance_step_id: Joi.number().integer().optional(),
    action: Joi.string().valid('APPROVE', 'REJECT', 'approve', 'reject').required(),
    comment: Joi.string().trim().max(1000).optional().allow(null, '')
  }),

  rfqApprovalAction: Joi.object({
    approval_instance_id: Joi.number().integer().required(),
    approval_instance_step_id: Joi.number().integer().optional(),
    action: Joi.string().valid('APPROVE', 'REJECT', 'approve', 'reject').required(),
    comment: Joi.string().trim().max(1000).optional().allow(null, '')
  }),

  // One-at-a-time Clarification System schemas
  raiseClarification: Joi.object({
    rfq_id: Joi.number().integer().required(),
    subject: Joi.string().trim().min(5).max(200).required(),
    question: Joi.string().trim().min(10).max(5000).required()
  }),

  // Response is now optional - buyer can close without sending a final message
  resolveClarification: Joi.object({
    clarification_id: Joi.number().integer().required(),
    response: Joi.string().trim().max(5000).optional().allow(null, '')
  }),

  // Send message in clarification thread (chat system)
  sendClarificationMessage: Joi.object({
    clarification_id: Joi.number().integer().required(),
    message: Joi.string().trim().min(1).max(5000).required()
  }),

  // File upload handler for clarifications (supports up to 10 files, 100MB each)
  clarificationFileUploadHandler: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_clarification_upload_file,
        limits: {
          fileSize: 100 * 1024 * 1024 // 100 MB in bytes
        }
      }).array('files', 10);
      upload(req, res, async function (err) {
        if (err) {
          res.status(400).json({ status: 2, errors: { file: err.message || err } });
          return;
        }
        next();
      });
    } catch (err) {
      console.error('Server error:', err);
      res.status(500).json({ status: 3, message: 'server error' });
    }
  },
};

/**
 * Middleware: validateGetRfqsQuery
 *
 * This middleware validates query parameters for the unified /get-rfqs API endpoint.
 *
 * API Purpose:
 *   - Provides a single, optimized endpoint to fetch RFQs for sidebar use in both Technical Evaluation and Quote Comparison pages.
 *   - Returns only essential RFQ fields, with fast queries and minimal payload.
 *   - Enforces user-type-based access: Engineering users can only access technical evaluation RFQs, Finance users can only access non-technical evaluation RFQs.
 *
 * Validation Logic:
 *   - Required query params: page (int, min 1), limit (int, 1-100), tech_eval ('0' or '1' as string)
 *   - Optional query params: project_id (int), sort ('ASC'|'DESC'), rfq_no (int|null)
 *   - .unknown(true) allows additional filters to be sent without breaking validation (future-proof)
 *   - User type logic:
 *       - If user_type == 9 (Finance), tech_eval must be '0'
 *       - If user_type == 10 (Engineering), tech_eval must be '1'
 *   - If any check fails, responds with 400 and a clear error message
 *
 * Notes for maintainers:
 *   - Add new filters to the Joi schema as needed for future sidebar features.
 *   - Keep user-type logic in this middleware, not in the controller.
 *   - This ensures strict, centralized validation and access control for the sidebar RFQ API.
 */
export function validateGetRfqsQuery(req, res, next) {
  const schema = Joi.object({
    page: Joi.number().integer().min(1).required(),
    limit: Joi.number().integer().min(1).max(100).required(),
    tech_eval: Joi.boolean().required(),
    project_id: Joi.number().optional(),
    sort: Joi.string().valid('ASC', 'DESC').optional(),
    rfq_no: Joi.number().optional().allow(null),
    // add any other filters you want to support
  }).unknown(true); // allow extra params

  const { error, value } = schema.validate(req.query);
  if (error) {
    return res.status(400).json({ status: 2, message: error.details[0].message });
  }


  const userType = req.user?.user_type;
  const techEval = req.query.tech_eval;

  if (userType == 10 && techEval == true) {
    return res.status(400).json({ status: 2, message: 'Engineering users can only access technical evaluation RFQs' });
  }
  if (userType == 9 && techEval == false) {
    return res.status(400).json({ status: 2, message: 'Finance users can only access non-technical evaluation RFQs' });
  }

  next();
}
