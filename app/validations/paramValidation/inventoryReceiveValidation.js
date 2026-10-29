// Request validation and the attachment upload for the receiving routes
// (/api/v1/inventory/receive/*, /api/v1/inventory/grn*), task B1.
//
// Joi checks shape only (types, enums, lengths). Ids in the body (poId,
// hotelId, dispatchId, …) are requests, never authority: the GRN service
// checks each one against the PO row and the caller's role scopes.
// validateBody answers 400 {status:2, message} and puts the validated copy in
// req.value.body.

import path from 'path';
import Joi from 'joi';
import multer from 'multer';
import multerS3 from 'multer-s3';
import { v4 as uuidv4 } from 'uuid';
import s3Client from '../../config/s3config.js';

const DAY = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).message('{{#label}} must be a date (YYYY-MM-DD)');
const ID = Joi.number().integer().positive();
const QTY = Joi.number().min(0).max(1e13);

const grnLine = Joi.object({
  poLineId: ID.required(),
  receivedQty: QTY.required(),
  acceptedQty: QTY.required(),
  rejectedQty: QTY.default(0),
  rejectionReason: Joi.string()
    .valid('damaged', 'quality', 'wrong_item', 'short_shelf_life', 'temperature', 'excess', 'other')
    .allow(null, ''),
  uomFactor: Joi.number().positive().max(1e9).allow(null),
  mapToInvItemId: ID.allow(null),
  markOutDepartmentId: ID.allow(null),
  batchNo: Joi.string().trim().max(64).allow(null, ''),
  mfgDate: DAY.allow(null, ''),
  expiryDate: DAY.allow(null, ''),
  remarks: Joi.string().max(2000).allow(null, ''),
}).unknown(true);

const grnHeader = {
  hotelId: ID.allow(null),
  dispatchId: ID.allow(null),
  receivedAt: DAY.allow(null, ''),
  vendorChallanNo: Joi.string().trim().max(64).allow(null, ''),
  vendorChallanDate: DAY.allow(null, ''),
  vendorInvoiceNo: Joi.string().trim().max(64).allow(null, ''),
  vendorInvoiceDate: DAY.allow(null, ''),
  ewayBillNo: Joi.string().trim().max(64).allow(null, ''),
  vehicleNo: Joi.string().trim().max(32).allow(null, ''),
  remarks: Joi.string().max(2000).allow(null, ''),
  lines: Joi.array().items(grnLine).max(500).default([]),
};

/** POST /grn (GrnInput). post=false saves a draft. */
export const createGrnSchema = Joi.object({
  poId: ID.required(),
  ...grnHeader,
  hotelId: ID.required(),
  post: Joi.boolean().default(false),
  clientEventId: Joi.string().guid().required(),
}).unknown(true);

/** PUT /grn/:id (draft only). */
export const updateGrnSchema = Joi.object({
  ...grnHeader,
  poId: ID.allow(null),
  post: Joi.boolean(),
  clientEventId: Joi.string().guid().allow(null, ''),
}).unknown(true);

/** POST /grn/:id/post */
export const postGrnSchema = Joi.object({
  clientEventId: Joi.string().guid().required(),
}).unknown(true);

/** POST /grn/:id/reverse */
export const reverseGrnSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(2000).required(),
  lines: Joi.alternatives()
    .try(
      Joi.string().valid('all'),
      Joi.array().min(1).max(500).items(Joi.object({ grnLineId: ID.required(), qty: Joi.number().positive().required() }))
    )
    .required(),
}).unknown(true);

// ---------------------------------------------------------------------------
// GRN attachments: one file per request (field `file`, optional text field
// `kind`), a photo or a PDF up to 15 MB, stored under grn/attachments/.
// Mount AFTER the caller has been authorised for the GRN, so nothing is
// uploaded for a request that is going to be refused.
// ---------------------------------------------------------------------------
export const GRN_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;

const GRN_ATTACHMENT_TYPES = Object.freeze({
  '.pdf': ['application/pdf'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.webp': ['image/webp'],
  // Browsers do not all know HEIC; an unknown type arrives as octet-stream.
  '.heic': ['image/heic', 'image/heif', 'application/octet-stream'],
  '.heif': ['image/heif', 'image/heic', 'application/octet-stream'],
});

const grnAttachmentStorage = multerS3({
  s3: s3Client,
  bucket: process.env.AWS_S3_BUCKET,
  // The declared type (already checked by fileFilter), not a byte sniff, so a
  // disguised SVG is never served as image/svg+xml from a public URL.
  contentType: (req, file, cb) => cb(null, file.mimetype),
  key: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `grn/attachments/${Date.now()}-${uuidv4()}${ext}`);
  },
});

const grnAttachmentUpload = multer({
  storage: grnAttachmentStorage,
  limits: { fileSize: GRN_ATTACHMENT_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    if ((GRN_ATTACHMENT_TYPES[ext] || []).includes(mime)) cb(null, true);
    else cb(new Error('UNSUPPORTED_TYPE'), false);
  },
}).single('file');

export const grnAttachmentUploadMiddleware = (req, res, next) => {
  grnAttachmentUpload(req, res, (err) => {
    if (!err) return next();
    return res.status(400).json({
      status: 0,
      code: 'INVALID_FILE',
      message: 'Attach one photo (JPG, PNG, WEBP, HEIC) or PDF of up to 15 MB.',
    });
  });
};
