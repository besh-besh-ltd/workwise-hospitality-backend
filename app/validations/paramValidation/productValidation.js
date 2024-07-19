import Joi from 'joi';
import { encode } from 'html-entities';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Config from '../../config/app.config.js';
import userModel from '../../models/userModel.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import fs from 'fs';
import { log } from 'console';

var store_category_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.category_image);
  },
  filename: function (req, file, callback) {
    var extention = path.extname(file.originalname);
    var new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});

let store_product_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.product_image);
  },
  filename: function (req, file, callback) {
    var extention = path.extname(file.originalname);
    var new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});

let store_bulk_product_file = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.bulk_product_file);
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
    title: Joi.string().required(),
    parent_id: Joi.string().optional().allow(null).allow(''),
    slug: Joi.string().optional().allow(null).allow(''),
    status: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only')
  }),
  update_category: Joi.object().keys({
    title: Joi.string().required(),
    parent_id: Joi.string().optional().allow(null).allow(''),
    slug: Joi.string().optional().allow(null).allow(''),
    status: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only')
  }),
  id: Joi.object().keys({
    id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper id')
  }),
  create_attribute_value: Joi.object().keys({
    attribute_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only'),
    attribute_values: Joi.array().items(
      Joi.object().keys({
        id: Joi.string()
          .optional()
          .regex(/^[0-9]*$/, 'numeric values only'),
        attribute_value: Joi.string().required()
      })
    )
  }),
  create_product: Joi.object({
    name: Joi.string().required(),
    description: Joi.string().required(),
    manufacturer: Joi.string().required(),
    price: Joi.number().required(),
    sku: Joi.string().required(),
    slug: Joi.string().required(),
    vendor: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only'),
    availability: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only'),
    categories: Joi.array().items(
      // Joi.object({
      Joi.string().required()
      // })
    ),
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only'),
    featured: Joi.array().items(Joi.string().required()),
    gallery: Joi.array().items(Joi.string().required()),
    variations: Joi.array().items(
      Joi.object({
        attribute: Joi.string().required(),
        selectedValues: Joi.array().items(
          // Joi.object({
          Joi.string().required()
          // })
        )
      })
    ),
    variationOptions: Joi.array().items(
      Joi.object({
        title: Joi.string().required(),
        options: Joi.array().items(Joi.string().required()),
        // image: Joi.string().allow(null),
        price: Joi.number().required(),
        quantity: Joi.number().required(),
        sku: Joi.string().allow(''),
        status: Joi.string()
          .required()
          .regex(/^[0|1]$/, 'numeric values only')
      })
    )
  }),
  add_vendor_product: Joi.object({
    master_id: Joi.string().optional().allow(null, ''),
    name: Joi.string().required(),
    description: Joi.string().optional().allow(null, ''),
    manufacturer: Joi.string().optional().allow(null, ''),
    // price: Joi.number().required(),
    // sku: Joi.string().required(),
    // slug: Joi.string().required(),
    /* availability: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only'), */
    availability: Joi.string().optional().allow(null, ''),
    categories: Joi.string().required(),
    /* categories: Joi.array().items(
      // Joi.object({
      Joi.string()
        .required()
        .regex(/^[0-9]*$/, 'numeric values only')
      // })
    ), */
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only'),
    featured: Joi.string().optional().allow(null, ''),
    gallery: Joi.string().optional().allow(null, ''),
    /* variations: Joi.array().items(
      Joi.object({
        attribute: Joi.string().required(),
        attributeValue: Joi.string().required()
      })
    ), */
    variations: Joi.string().required(),
    approved_id: Joi.string().optional().allow('', null),
    approved_name: Joi.string().optional().allow('', null)
    /* approved_name: Joi.when('approved_id', {
      is: Joi.string().valid('').valid(null),
      then: Joi.string().required(),
      otherwise: Joi.string().allow('', null)
    }) */
  }),
  add_admin_product: Joi.object({
    name: Joi.string().required(),
    description: Joi.string().optional().allow('', null),
    manufacturer: Joi.string().optional().allow('', null),
    // price: Joi.number().required(),
    // sku: Joi.string().required(),
    // slug: Joi.string().required(),
    /* availability: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only'), */
    availability: Joi.string().optional().allow('', null),
    categories: Joi.string().required(),
    is_featured: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only'),
    /* Joi.array().items(
      // Joi.object({
      Joi.string().required()
      // })
    ), */
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only'),
    featured: Joi.array().items(Joi.string().required()),
    gallery: Joi.array().items(Joi.string().required()),
    qap: Joi.array().items(Joi.string().required()),
    tds: Joi.array().items(Joi.string().required()),
    variations: Joi.string().required(),
    /*  Joi.array().items(
      Joi.object({
        attribute: Joi.string().required(),
        attributeValue: Joi.string().required()
      })
    ), */
    approved_id: Joi.string().optional().allow('', null),
    approved_name: Joi.string().optional().allow('', null),
    /* approved_name: Joi.when('approved_id', {
      is: Joi.string().valid('').valid(null),
      then: Joi.string().required(),
      otherwise: Joi.string().allow('', null)
    }), */
    vendor: Joi.string().optional().allow('', null)
  }),
  vendor_product_accept_review: Joi.object().keys({
    products: Joi.array().optional().allow(null, ''),
    all: Joi.boolean().optional().allow(null, '')
  }),
  admin_product_accept_review: Joi.object().keys({
    products: Joi.array().optional().allow(null, ''),
    all: Joi.boolean().optional().allow(null, '')
  }),
  product_approval: Joi.object().keys({
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only'),
    reject_reason: Joi.string().trim().optional().allow(null, ''),
    reject_reason_id: Joi.string()
      .optional()
      .regex(/^\d+$/, 'numeric values only')
  })
};

const schema_posts = {
  create_category: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_category_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();

          if (ext == '.png' || ext == '.jpg' || ext == '.jpeg') {
            let validateImage = validatingImage(schemas.create_category);
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
      // console.log('====>', err);
      logError(err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
    }
  },
  add_product_image: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_product_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();

          if (
            ext == '.png' ||
            ext == '.jpg' ||
            ext == '.jpeg' ||
            ext == '.webp'
          ) {
            cb(null, true);
          } else {
            cb(null, false);
            return cb('Only .png, .jpg, .jpeg format allowed!', null);
          }
        }
      }).fields([
        { name: 'featured', maxCount: 1 },
        { name: 'gallery', maxCount: 8 }
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
          // console.log('req.body====>>>>>>>>>', req.body);
          const result = schemas.create_product.validate(req.body, {
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
            // console.log(req.files);

            // console.log(req.files.featured[0]);

            let error = {};
            let errCount = 0;
            // fs.unlink(req.files.featured[0].path, (unlinkError) => {
            //   if (unlinkError) {
            //     console.error('Error deleting file:', unlinkError);
            //   }
            // });

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
  add_vendor_product: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_product_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();

          if (file.fieldname == 'tds' || file.fieldname == 'qap') {
            if (ext == '.pdf') {
              cb(null, true);
            } else {
              cb(new Error('Only .pdf format allowed!'), false);
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
              cb(
                new Error('Only .png, .jpg, .jpeg, .webp format allowed!'),
                false
              );
            }
          }
        }
      }).fields([
        { name: 'featured', maxCount: 1 },
        { name: 'gallery', maxCount: 8 },
        { name: 'tds', maxCount: 1 },
        { name: 'qap', maxCount: 1 }
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
          // console.log('req.body====>>>>>>>>>', req.body);
          const result = schemas.add_vendor_product.validate(req.body, {
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
            /*  if (req.files?.featured && req.files?.featured.length > 0) {
              fs.unlink(req.files.featured[0].path, (unlinkError) => {
                if (unlinkError) {
                  console.error('Error deleting file:', unlinkError);
                }
              });
            }
            if (req.files?.gallery && req.files?.gallery.length > 0) {
              req.files.gallery.forEach((file) => {
                fs.unlink(file.path, (unlinkError) => {
                  if (unlinkError) {
                    console.error('Error deleting file:', unlinkError);
                  }
                });
              });
            } */
            return res.status(400).json(return_err);
          } else {
            let error = {};
            let errCount = 0;

            // console.log(req.files);

            // console.log(req.files.featured[0]);
            // console.log('master_id==>>>>', req.body.master_id);
            if (!req.body.master_id) {
              if (req.files?.featured && req.files?.featured.length > 0) {
              } else {
                if (req.method == 'POST') {
                  errCount++;
                  error.featured = 'Featured file required';
                }
              }
            }

            if (errCount > 0) {
              /*  if (req.files?.featured && req.files?.featured.length > 0) {
                fs.unlink(req.files.featured[0].path, (unlinkError) => {
                  if (unlinkError) {
                    console.error('Error deleting file:', unlinkError);
                  }
                });
              }
              if (req.files?.gallery && req.files?.gallery.length > 0) {
                req.files.gallery.forEach((file) => {
                  fs.unlink(file.path, (unlinkError) => {
                    if (unlinkError) {
                      console.error('Error deleting file:', unlinkError);
                    }
                  });
                });
              } */
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
  add_admin_product: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_product_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();
          if (file.fieldname == 'tds' || file.fieldname == 'qap') {
            if (ext == '.pdf') {
              cb(null, true);
            } else {
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
        { name: 'featured', maxCount: 1 },
        { name: 'gallery', maxCount: 8 },
        { name: 'tds', maxCount: 1 },
        { name: 'qap', maxCount: 1 }
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
          // console.log('req.body====>>>>>>>>>', req.body);
          const result = schemas.add_admin_product.validate(req.body, {
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
            /* if (req.files?.featured && req.files?.featured.length > 0) {
              fs.unlink(req.files.featured[0].path, (unlinkError) => {
                if (unlinkError) {
                  console.error('Error deleting file:', unlinkError);
                }
              });
            } */
            /* if (req.files?.gallery && req.files?.gallery.length > 0) {
              req.files.gallery.forEach((file) => {
                fs.unlink(file.path, (unlinkError) => {
                  if (unlinkError) {
                    console.error('Error deleting file:', unlinkError);
                  }
                });
              });
            } */
            return res.status(400).json(return_err);
          } else {
            let error = {};
            let errCount = 0;

            // console.log(req.files);

            // console.log(req.files.featured[0]);

            if (req.files?.featured && req.files?.featured.length > 0) {
            } else {
              if (req.method == 'POST') {
                errCount++;
                error.featured = 'Featured file required';
              }
            }

            if (errCount > 0) {
              /*  if (req.files?.featured && req.files?.featured.length > 0) {
                fs.unlink(req.files.featured[0].path, (unlinkError) => {
                  if (unlinkError) {
                    console.error('Error deleting file:', unlinkError);
                  }
                });
              }
              if (req.files?.gallery && req.files?.gallery.length > 0) {
                req.files.gallery.forEach((file) => {
                  fs.unlink(file.path, (unlinkError) => {
                    if (unlinkError) {
                      console.error('Error deleting file:', unlinkError);
                    }
                  });
                });
              }
              if (req.files?.tds && req.files?.tds.length > 0) {
                req.files.tds.forEach((file) => {
                  fs.unlink(file.path, (unlinkError) => {
                    if (unlinkError) {
                      console.error('Error deleting file:', unlinkError);
                    }
                  });
                });
              }
              if (req.files?.qap && req.files?.qap.length > 0) {
                req.files.qap.forEach((file) => {
                  fs.unlink(file.path, (unlinkError) => {
                    if (unlinkError) {
                      console.error('Error deleting file:', unlinkError);
                    }
                  });
                });
              } */
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
  productBulkUpload: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_bulk_product_file,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();

          if ('.xlsx') {
            cb(null, true);
          } else {
            cb(null, false);
            return cb('Only .xlsx format allowed!', null);
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
      logError(err);
      res.status(400).json({
        status: 3,
        message: 'server error'
      });
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
