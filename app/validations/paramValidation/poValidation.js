import multer from 'multer';
import multerS3 from 'multer-s3';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import s3Client from '../../config/s3config.js';

var store_po_document = multerS3({
  s3: s3Client,
  bucket: process.env.AWS_S3_BUCKET,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const fileName = `${Date.now()}-${uuidv4()}${ext}`;
    const fullPath = `purchase-order/${fileName}`;
    cb(null, fullPath);
  }
});

export const poUploadMiddleware = (req, res, next) => {
  try {
    var upload = multer({
      storage: store_po_document,
      limits: {
        fileSize: 26214400 // 25MB
      },
      fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.pdf') {
          cb(null, true);
        } else {
          cb(new Error('Only PDF files are allowed'), false);
        }
      }
    }).single('file');
    upload(req, res, function (err) {
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
};

// ---------------------------------------------------------------------------
// Send-back attachments (client ticket T3): the evidence an approver attaches
// when asking for information, and what the person asked attaches in reply.
// Up to 10 files of 10 MB each, photos (JPG, PNG, WEBP, HEIC) or PDFs, under
// purchase-order/send-back/. Any refusal is a 400 INVALID_FILE; multer removes
// whatever it had already stored for that request (storage._removeFile).
//
// Mount it AFTER the caller has been authorised for the PO (see poRoutes), so
// nothing is uploaded for a request that was going to be refused anyway.
// ---------------------------------------------------------------------------
export const SEND_BACK_MAX_FILES = 10;
export const SEND_BACK_MAX_FILE_BYTES = 10 * 1024 * 1024;

const SEND_BACK_TYPES = Object.freeze({
  '.pdf': ['application/pdf'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.webp': ['image/webp'],
  // Browsers do not all know HEIC; an unknown type arrives as octet-stream.
  '.heic': ['image/heic', 'image/heif', 'application/octet-stream'],
  '.heif': ['image/heif', 'image/heic', 'application/octet-stream'],
});

const store_send_back_file = multerS3({
  s3: s3Client,
  bucket: process.env.AWS_S3_BUCKET,
  // The declared type, which fileFilter has already checked against
  // SEND_BACK_TYPES. Not AUTO_CONTENT_TYPE: it sniffs the bytes, so an SVG
  // named x.png and declared image/png would pass the filter and then be
  // served as image/svg+xml from a public URL.
  contentType: (req, file, cb) => cb(null, file.mimetype),
  key: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `purchase-order/send-back/${Date.now()}-${uuidv4()}${ext}`);
  }
});

const sendBackUpload = multer({
  storage: store_send_back_file,
  limits: { fileSize: SEND_BACK_MAX_FILE_BYTES, files: SEND_BACK_MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    if ((SEND_BACK_TYPES[ext] || []).includes(mime)) cb(null, true);
    else cb(new Error('UNSUPPORTED_TYPE'), false);
  }
}).array('files', SEND_BACK_MAX_FILES);

export const poSendBackUploadMiddleware = (req, res, next) => {
  sendBackUpload(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({
      status: 0,
      code: 'INVALID_FILE',
      message: `Attach up to ${SEND_BACK_MAX_FILES} photos (JPG, PNG, WEBP, HEIC) or PDFs, 10 MB each.`,
    });
  });
};
