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
