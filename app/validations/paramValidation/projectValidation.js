import Joi from 'joi';
import Config from '../../config/app.config.js';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

let store_project_files = multer.diskStorage({
    destination: function (req, file, callback) {
      callback(null, Config.upload.project_file);
    },
    filename: function (req, file, callback) {
      var extention = path.extname(file.originalname);
      var new_file_name = +new Date() + '-' + uuidv4() + extention;
      callback(null, new_file_name);
    }
});

// Calculate tomorrow's date
const today = new Date();
const tomorrow = new Date(today);
const tomorrowString = tomorrow.toISOString().slice(0, 10); // Format as YYYY-MM-DD

export const projectSchemas = {
    create: Joi.object().keys({
        name:Joi.string().required(),
        description:Joi.string().optional().allow('').allow(null),
        location:Joi.string().optional().allow('').allow(null),
        ended_at: Joi.string()
            .optional()
            .allow(null)
            .custom((value, helpers) => {
                if (value && new Date(value) <= tomorrow) {
                    return helpers.message(`ended_at must be greater than ${tomorrowString}`);
                }
                return value;
            }),
        rfq_type: Joi.string().valid('firm', 'budgetary').allow('', null),
        reverse_auction: Joi.number().valid(0, 1, -1)
    }),

    project_id: Joi.object().keys({
        project_id: Joi.number().integer().required(),
    }),

    get_buyer_body_validation : Joi.object().keys({
        page: Joi.number().integer().required(),  // Page number for pagination
        project_id: Joi.number().integer().allow(-1),  // ID of the project
        sort: Joi.string().valid('ASC', 'DESC').required(),  // Sorting order
        rfq_type: Joi.string().valid('firm', 'budgetary').allow(''),  // Type of RFQ
        reverse_auction: Joi.valid('0', '1', '-1'),  // Reverse auction flag,
        limit: Joi.number().integer()  // add limit
    }),


    update: Joi.object().keys({
        status:Joi.number().valid(0, 1), // Status can only be 0 or 1
        description:Joi.string().optional().allow('').allow(null),
        location:Joi.string().optional().allow('').allow(null),
        ended_at: Joi.string()
            .optional()
            .allow(null)
            .custom((value, helpers) => {
                if (value && new Date(value) <= tomorrow) {
                    return helpers.message(`ended_at must be greater than ${tomorrowString}`);
                }
                return value;
            }),
        rfq_type: Joi.string().valid('firm', 'budgetary').allow('', null),
        reverse_auction: Joi.number().valid(0, 1, -1)
    }),

    projectFileUploadHandler: async (req, res, next) => {
        try {
          const upload = multer({
            storage: store_project_files,
            limits: { fileSize: 25000000 }, // 25MB limit
          }).array('files', 10);
      
          upload(req, res, (err) => {
            if (err) {
              res.status(400).json({ status: 2, errors: { file: err } });
              return;
            }
      
            req.files = req.files?.map((file) => ({
              name: file.originalname,
              url: `${Config.base_url}/project_file/${file.filename}`,
            }));
      
            next();
          });
        } catch (err) {
          console.error('File upload error:', err);
          res.status(500).json({ status: 3, message: 'Server error' });
        }
      },

      saveFiles: Joi.object().keys({
        project_id: Joi.number().required(), 
        file_type: Joi.string().optional().allow("", null),
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

}

