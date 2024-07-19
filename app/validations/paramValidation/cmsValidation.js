import Joi from 'joi';
import { encode } from 'html-entities';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Config from '../../config/app.config.js';
// import blogModel from '../../models/blogModel.js';
import cmsModel from '../../models/cmsModel.js';
import productModel from '../../models/productModel.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';

let store_banner_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.banner_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let store_logo_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.company_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let store_budget_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.budget_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let shop_by_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.shop_by_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let store_media_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.media_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let store_lookbooks_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.lookbook_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let store_testimonial_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.testimonial_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let store_blog_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.blog_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let store_collection_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.collection_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let gift_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.gift_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let gender_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.gender_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let press_room_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.press_room_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let page_images = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.page_image);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let governance_file = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.governance_file);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});
let cv_file = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, Config.upload.cv_file);
  },
  filename: function (req, file, callback) {
    let extention = path.extname(file.originalname);
    let new_file_name = +new Date() + '-' + uuidv4() + extention;
    callback(null, new_file_name);
  }
});

let validatingImage = async (schema) => {
  return (req, res, next) => {
    const result = Joi.validate(req.body, schema, {
      abortEarly: false
    });
    console.log('result', result);
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
    // console.log('req.params', req.params);
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
  create_banner: Joi.object().keys({
    page_id: Joi.string().required(),
    content: Joi.string().optional().allow(null).allow(''),
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only')
  }),
  create_logo: Joi.object().keys({
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only')
  }),
  create_pagecontent: Joi.object().keys({
    page_id: Joi.string().required(),
    section_name: Joi.string().required(),
    content: Joi.string().required()
  }),
  update_pagecontent: Joi.object().keys({
    page_id: Joi.string().required(),
    section_name: Joi.string().required(),
    content: Joi.string().required()
  }),
  create_faq: Joi.object().keys({
    question: Joi.string().trim().required(),
    description: Joi.string().trim().required(),
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only')
  }),
  create_testimonial: Joi.object().keys({
    title: Joi.string().trim().required(),
    created_name: Joi.string().trim().required(),
    description: Joi.string().trim().required(),
    url: Joi.string().trim().required(),
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only'),
    image: Joi.string().optional().allow(null).allow(''),
    created_image: Joi.string().optional().allow(null).allow('')
  }),
  create_blog: Joi.object().keys({
    title: Joi.string().trim().required(),
    description: Joi.string().trim().required(),
    blog_category: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper id'),
    slug: Joi.string().trim().optional().allow(null, ''),
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only'),
    image: Joi.string().optional().allow(null).allow('')
  }),
  id: Joi.object().keys({
    id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper id')
  }),
  update_faq: Joi.object().keys({
    question: Joi.string().required(),
    description: Joi.string().required(),
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only')
  }),
  update_banner: Joi.object().keys({
    title: Joi.string().required(),
    url: Joi.string().required(),
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only')
  }),
  banner_id: Joi.object().keys({
    banner_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper banner id')
  }),
  page_content_id: Joi.object().keys({
    page_content_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper id')
  }),
  collection_id: Joi.object().keys({
    collection_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper collection id')
  }),
  budget_id: Joi.object().keys({
    budget_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper budget id')
  }),
  shop_by_category_id: Joi.object().keys({
    shop_by_category_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper budget id')
  }),
  print_media_id: Joi.object().keys({
    print_media_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper print media id')
  }),
  photo_gallery_id: Joi.object().keys({
    photo_gallery_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper print media id')
  }),
  lookbook_id: Joi.object().keys({
    lookbook_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper lookbook id')
  }),
  testimonial_id: Joi.object().keys({
    testimonial_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper testimonial id')
  }),
  faq_id: Joi.object().keys({
    faq_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper FAQ id')
  }),
  create_blog_category: Joi.object().keys({
    category_name: Joi.string().required(),
    status: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only')
  }),
  update_blog_category: Joi.object().keys({
    category_name: Joi.string().required(),
    status: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only')
  }),
  update_category: Joi.object().keys({
    name: Joi.string().required(),
    parent_id: Joi.string().optional().allow(null).allow(''),
    status: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only')
  }),
  blog_cat_id: Joi.object().keys({
    cat_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper id')
  }),
  blog_id: Joi.object().keys({
    blog_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper blog id')
  }),
  option_id: Joi.object().keys({
    id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper id')
  }),
  create_options: Joi.object().keys({
    title: Joi.string().required(),
    type: Joi.string().required(),
    gold: Joi.string().optional().allow(null).allow(''),
    diamond: Joi.string().optional().allow(null).allow(''),
    platinum: Joi.string().optional().allow(null).allow(''),
    gem: Joi.string().optional().allow(null).allow(''),
    status: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only')
  }),
  update_options: Joi.object().keys({
    title: Joi.string().required(),
    type: Joi.string().required(),
    gold: Joi.string().optional().allow(null).allow(''),
    diamond: Joi.string().optional().allow(null).allow(''),
    platinum: Joi.string().optional().allow(null).allow(''),
    gem: Joi.string().optional().allow(null).allow(''),
    status: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only')
  }),
  update_goldrate: Joi.object().keys({
    eighteen_carat: Joi.string().required(),
    twentytwo_carat: Joi.string().required(),
    twentyfour_carat: Joi.string().required()
  }),
  create_product: Joi.object().keys({
    product_name: Joi.string().required(),
    option_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only'),
    status: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'numeric values only'),
    gold_purity: Joi.string().optional().allow(null).allow(''),
    gold_weight: Joi.string().optional().allow(null).allow(''),
    gold_price_id: Joi.string()
      .optional()
      .regex(/^[0-9]*$/, 'numeric values only'),
    diamond_purity: Joi.string().optional().allow(null).allow(''),
    diamond_weight: Joi.string().optional().allow(null).allow(''),
    diamond_price_id: Joi.string()
      .optional()
      .allow('')
      .regex(/^[0-9]*$/, 'numeric values only'),
    platinum_purity: Joi.string().optional().allow(null).allow(''),
    platinum_weight: Joi.string().optional().allow(null).allow(''),
    platinum_price_id: Joi.string()
      .optional()
      .allow('')
      .regex(/^[0-9]*$/, 'numeric values only'),
    gem_purity: Joi.string().optional().allow(null).allow(''),
    gem_weight: Joi.string().optional().allow(null).allow(''),
    gem_price_id: Joi.string()
      .optional()
      .allow('')
      .regex(/^[0-9]*$/, 'numeric values only'),
    description: Joi.string().optional().allow(null).allow(''),
    sku: Joi.string().required(),
    cat_arr: Joi.string().optional(),
    slug: Joi.string().required(),
    making_charge_percent: Joi.string().required(),
    making_charge: Joi.string().required()
  }),
  price_id: Joi.object().keys({
    id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper id')
  }),
  price: Joi.object().keys({
    price: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper price')
  }),
  product_image: Joi.object().keys({
    file: Joi.required()
  }),
  blog_image: Joi.object().keys({
    file: Joi.required()
  }),
  cat_slug: Joi.object().keys({
    cat_slug: Joi.string().required()
  }),
  banner_image: Joi.object().keys({
    file: Joi.required()
  }),
  logo_image: Joi.object().keys({
    file: Joi.required()
  }),
  banner_image_update: Joi.object().keys({
    file: Joi.optional(),
    page_id: Joi.string().required(),
    content: Joi.string().optional().allow(null).allow(''),
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only')
  }),
  logo_image_update: Joi.object().keys({
    file: Joi.optional(),
    status: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only')
  }),
  create_budget: Joi.object().keys({
    title: Joi.string().required(),
    upper_limit: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper id'),
    lower_limit: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper id'),
    status: Joi.string()
      .optional()
      .regex(/^[0|1]$/, 'numeric values only'),
    image: Joi.string().optional().allow(null).allow('')
  }),
  create_shop_by: Joi.object().keys({
    title: Joi.string().required(),
    url: Joi.string().required(),
    status: Joi.string()
      .optional()
      .regex(/^[0|1]$/, 'numeric values only'),
    image: Joi.string().optional().allow(null).allow('')
  }),
  create_print_media: Joi.object().keys({
    status: Joi.string()
      .optional()
      .regex(/^[0|1]$/, 'numeric values only'),
    image: Joi.string().optional().allow(null).allow('')
  }),
  create_lookbooks: Joi.object().keys({
    video_url: Joi.string().required(),
    status: Joi.string()
      .optional()
      .regex(/^[0|1]$/, 'numeric values only'),
    image: Joi.string().optional().allow(null).allow('')
  }),
  update_collection: Joi.object().keys({
    url: Joi.string().required(),
    image: Joi.string().optional().allow(null).allow('')
  }),
  create_gift: Joi.object().keys({
    title: Joi.string().required(),
    url: Joi.string().regex(/\//, 'need / on url').required(),
    description: Joi.string().required(),
    status: Joi.string()
      .optional()
      .regex(/^[0|1]$/, 'numeric values only'),
    big_image: Joi.string()
      .required()
      .regex(/^[0|1]$/, 'numeric values only'),
    image: Joi.string().optional().allow(null).allow('')
  }),
  create_press_room: Joi.object().keys({
    title: Joi.string().required(),
    url: Joi.string().regex(/\//, 'need / on url').optional(),
    status: Joi.string()
      .optional()
      .regex(/^[0|1]$/, 'numeric values only'),
    date: Joi.string().required(),
    image: Joi.string().optional().allow(null).allow('')
  }),
  update_page: Joi.object().keys({
    content: Joi.string().required(),
    image: Joi.string().optional().allow(null).allow('')
  }),
  create_governance: Joi.object().keys({
    title: Joi.string().required(),
    description: Joi.string().optional().allow('').allow(null),
    status: Joi.string()
      .optional()
      .regex(/^[0|1]$/, 'numeric values only'),
    file: Joi.string().optional().allow(null).allow(''),
    button_name: Joi.string().required()
  }),
  create_gender: Joi.object().keys({
    title: Joi.string().required(),
    url: Joi.string().regex(/\//, 'need / on url').required(),
    description: Joi.string().required(),
    status: Joi.string()
      .optional()
      .regex(/^[0|1]$/, 'numeric values only'),
    image: Joi.string().optional().allow(null).allow('')
  }),
  gift_id: Joi.object().keys({
    gift_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper gift id')
  }),
  gender_id: Joi.object().keys({
    gender_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper gender id')
  }),
  press_room_id: Joi.object().keys({
    press_room_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper press room id')
  }),
  page_name: Joi.object().keys({
    page_name: Joi.string().required()
  }),
  governance_id: Joi.object().keys({
    governance_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper governance id')
  }),
  job_submit: Joi.object().keys({
    job_id: Joi.string().optional().allow(null).allow(''),
    name: Joi.string().required(),
    email: Joi.string().email().required(),
    mobile: Joi.string()
      .regex(/^[0-9]*$/, 'Please send proper mobile no')
      .min(8)
      .max(11)
      .required(),
    qualification: Joi.string().optional().allow(null).allow(''),
    applied_for: Joi.string().optional().allow(null).allow(''),
    // organization: Joi.string().required(),
    // experience: Joi.string().required(),
    // ctc: Joi.string().required(),
    // notice_period: Joi.string()
    //   .regex(/^[0-9]*$/, 'Please send proper notice period')
    //   .required(),
    cv: Joi.string().optional().allow(null).allow('')
  }),
  setting: Joi.object().keys({
    company_details: Joi.string().required(),
    call_number: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper mobile no')
      .min(10)
      .max(10),
    fb: Joi.string()
      .required()
      .regex(
        /^(https?:\/\/)?(www\.)?facebook\.com\/[a-zA-Z0-9.]{5,}$/,
        'Please send proper Facebook url'
      ),
    twitter: Joi.string()
      .required()
      .regex(
        /^(https?:\/\/)?(www\.)?twitter\.com\/[a-zA-Z0-9_]{1,15}$/,
        'Please send proper Twitter url'
      ),
    youtube: Joi.string()
      .required()
      .regex(
        /^(https?:\/\/)?(www\.)?youtube\.com\/@([a-zA-Z0-9_-]+)$/,
        'Please send proper Youtube url'
      ),
    insta: Joi.string()
      .required()
      .regex(
        /^(https?:\/\/)?(www\.)?instagram\.com\/[a-zA-Z0-9_.]{1,30}$/,
        'Please send proper Instagram url'
      ),
    whatsapp: Joi.string()
      .required()
      .regex(
        /^(https?:\/\/)?(www\.)?wa\.me\/[0-9]{5,}$/,
        'Please send proper Whatsapp url'
      ),
    right_hamburger: Joi.string().required(),
    quick_links: Joi.string().required(),
    other_links: Joi.string().required(),
    map: Joi.string().required()
  }),
  stay_in_touch: Joi.object().keys({
    mobile: Joi.string()
      .required()
      .max(8)
      .min(11)
      .regex(/^[0-9]*$/, 'Please send proper mobile number')
  }),
  franchisee_enquiry: Joi.object().keys({
    name: Joi.string().required(),
    email: Joi.string().email().required(),
    mobile: Joi.string()
      .required()
      .max(8)
      .min(11)
      .regex(/^[0-9]*$/, 'Please send proper mobile number'),
    preferred_location: Joi.string().required(),
    state: Joi.string().required(),
    city: Joi.string().required(),
    nature_business: Joi.string().required(),
    yearly_turnover: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper number'),
    capacity: Joi.string().required(),
    mode: Joi.string().required(),
    description: Joi.string().required(),
    type: Joi.string().valid('fe', 'cse').required()
  }),
  store_appointment: Joi.object().keys({
    name: Joi.string().required(),
    email: Joi.string().email().required(),
    mobile: Joi.string()
      .required()
      .max(8)
      .min(11)
      .regex(/^[0-9]*$/, 'Please send proper mobile number'),
    store_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send store id'),
    state_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper state id'),
    city_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper city id'),
    description: Joi.string().required()
  }),
  advance_book: Joi.object().keys({
    state_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper state id'),
    city_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper city id'),
    store_id: Joi.string()
      .required()
      .regex(/^[0-9]*$/, 'Please send proper store id'),
    purchase_amount: Joi.string()
      .required()
      .custom((value, helpers) => {
        const parsedValue = parseFloat(value);

        if (isNaN(parsedValue) || parsedValue < 10000) {
          return helpers.message(
            'Minimum online transaction value is Rs 10000/-'
          );
        }

        return parsedValue;
      }, 'custom validation'),
    name: Joi.string().required(),
    gender: Joi.string().required(),
    mobile: Joi.string()
      .required()
      .max(8)
      .min(11)
      .regex(/^[0-9]*$/, 'Please send proper mobile number'),
    email: Joi.string().email().required(),
    address: Joi.string().required(),
    pin: Joi.string()
      .required()
      .min(6)
      .max(6)
      .regex(/^[0-9]*$/, 'Please send proper pin')
  })
};

const schema_posts = {
  add_logo_image: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_logo_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();
          /* console.log('ext-->', ext);
          return false; */
          if (
            ext == '.png' ||
            ext == '.jpg' ||
            ext == '.jpeg' ||
            ext == '.webp'
          ) {
            let validateImage = validatingImage(schemas.logo_image);
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
  },
  add_banner_image: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_banner_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();
          /* console.log('ext-->', ext);
          return false; */
          if (
            ext == '.png' ||
            ext == '.jpg' ||
            ext == '.jpeg' ||
            ext == '.webp'
          ) {
            let validateImage = validatingImage(schemas.banner_image);
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
  },
  update_banner_image: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_banner_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();
          /* console.log('ext-->', ext);
          return false; */
          if (
            ext == '.png' ||
            ext == '.jpg' ||
            ext == '.jpeg' ||
            ext == '.webp'
          ) {
            let validateImage = validatingImage(schemas.banner_image_update);
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
  },
  update_logo_image: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_logo_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();
          /*  console.log('ext-->', ext);
          return false; */
          if (
            ext == '.png' ||
            ext == '.jpg' ||
            ext == '.jpeg' ||
            ext == '.webp'
          ) {
            let validateImage = validatingImage(schemas.logo_image_update);
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
  },
  create_budget: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_budget_images,
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
            // var validateImage = validatingImage(schemas.create_budget);
            // if (validateImage) {
            cb(null, true);
            // }
          } else {
            cb(null, false);
            return cb('Only .png, .jpg, .jpeg format allowed!', null);
          }
        }
      }).single('image');
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
          const result = schemas.create_budget.validate(req.body, {
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
            if (req.method == 'POST' && !req.file) {
              errCount++;
              error.file = 'Budget image is required';
            }
            if (req.body.upper_limit < req.body.lower_limit) {
              errCount++;
              error.upper_limit = 'Upper limit cannot be less than lower limit';
            }
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
  create_shop_by: async (req, res, next) => {
    try {
      let upload = multer({
        storage: shop_by_images,
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
            // var validateImage = validatingImage(schemas.create_budget);
            // if (validateImage) {
            cb(null, true);
            // }
          } else {
            cb(null, false);
            return cb('Only .png, .jpg, .jpeg format allowed!', null);
          }
        }
      }).single('image');
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
          const result = schemas.create_shop_by.validate(req.body, {
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
            if (req.method == 'POST' && !req.file) {
              errCount++;
              error.file = 'Shop by image is required';
            }
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
  create_print_media: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_media_images,
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
            // var validateImage = validatingImage(schemas.create_budget);
            // if (validateImage) {
            cb(null, true);
            // }
          } else {
            cb(null, false);
            return cb('Only .png, .jpg, .jpeg format allowed!', null);
          }
        }
      }).single('image');
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
          const result = schemas.create_print_media.validate(req.body, {
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
            if (req.method == 'POST' && !req.file) {
              errCount++;
              error.file = 'Print media image is required';
            }
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
  create_photo_gallery: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_media_images,
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
            // var validateImage = validatingImage(schemas.create_budget);
            // if (validateImage) {
            cb(null, true);
            // }
          } else {
            cb(null, false);
            return cb('Only .png, .jpg, .jpeg format allowed!', null);
          }
        }
      }).single('image');
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
          const result = schemas.create_print_media.validate(req.body, {
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
            if (req.method == 'POST' && !req.file) {
              errCount++;
              error.file = 'Photo gallery image is required';
            }
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
  update_collection: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_collection_images,
        limits: {
          fileSize: 10000000 // Compliant: 8MB
        },
        fileFilter: (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();

          if (
            ext == '.png' ||
            ext == '.jpg' ||
            ext == '.jpeg' ||
            ext == '.webp'
          ) {
            // var validateImage = validatingImage(schemas.update_collection);
            // if (validateImage) {
            cb(null, true);
            // }
          } else {
            cb(null, false);
            return cb('Only .png, .jpg, .jpeg format allowed!', null);
          }
        }
      }).single('image');
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
          const result = schemas.update_collection.validate(req.body, {
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
            // if (!req.file) {
            //   errCount++;
            //   error.file = 'Collection image is required';
            // }

            let checkCollection = await cmsModel.collection_find_one(
              req.params.collection_id
            );
            if (checkCollection.length == 0) {
              errCount++;
              error.collection_id = 'Collection not exist';
            }

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
  create_lookbooks: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_lookbooks_images,
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
            // var validateImage = validatingImage(schemas.create_lookbooks);
            // if (validateImage) {
            cb(null, true);
            // }
          } else {
            cb(null, false);
            return cb('Only .png, .jpg, .jpeg format allowed!', null);
          }
        }
      }).single('image');
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
          const result = schemas.create_lookbooks.validate(req.body, {
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
            if (req.method == 'POST' && !req.file) {
              errCount++;
              error.file = 'Lookbook image is required';
            }

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
  /* create_testimonial: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_testimonial_images,
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
      }).single('image');
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
          const result = schemas.create_testimonial.validate(req.body, {
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
            if (req.method == 'POST' && !req.file) {
              errCount++;
              error.file = 'Testimonial image is required';
            }
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
  }, */
  create_testimonial: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_testimonial_images,
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
        { name: 'image', maxCount: 1 },
        { name: 'created_image', maxCount: 1 }
      ]);
      upload(req, res, async (err) => {
        if (err) {
          return res.status(400).json({
            status: 2,
            message: err.message
          });
        }

        const result = schemas.create_testimonial.validate(req.body, {
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
  },
  create_blog: async (req, res, next) => {
    try {
      let upload = multer({
        storage: store_blog_images,
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
      }).single('image');
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
          const result = schemas.create_blog.validate(req.body, {
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
            if (req.method == 'POST' && !req.file) {
              errCount++;
              error.file = 'Blog image is required';
            }
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
  create_gender: async (req, res, next) => {
    try {
      let upload = multer({
        storage: gender_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: async (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();

          if (
            ext == '.png' ||
            ext == '.jpg' ||
            ext == '.jpeg' ||
            ext == '.webp'
          ) {
            // let validateImage = await validatingImage(schemas.create_gift);
            // console.log('validateImage', validateImage);
            // if (validateImage) {
            cb(null, true);
            // }
          } else {
            cb(null, false);
            return cb('Only .png, .jpg, .jpeg format allowed!', null);
          }
        }
      }).single('image');
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
          const result = schemas.create_gender.validate(req.body, {
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
            let { url } = req.body;
            let error = {};
            let errCount = 0;
            if (req.method == 'POST' && !req.file) {
              errCount++;
              error.file = 'Gender image is required';
            }
            let getSlug = url ? url.split('/')[1] : '';
            let checkSlug = await productModel.cat_slug_exist(getSlug);
            if (checkSlug.length == 0) {
              errCount++;
              error.url = 'Url not exist';
            }

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
  create_gift: async (req, res, next) => {
    try {
      let upload = multer({
        storage: gift_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: async (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();

          if (
            ext == '.png' ||
            ext == '.jpg' ||
            ext == '.jpeg' ||
            ext == '.webp'
          ) {
            // let validateImage = await validatingImage(schemas.create_gift);
            // console.log('validateImage', validateImage);
            // if (validateImage) {
            cb(null, true);
            // }
          } else {
            cb(null, false);
            return cb('Only .png, .jpg, .jpeg format allowed!', null);
          }
        }
      }).single('image');
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
          const result = schemas.create_gift.validate(req.body, {
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
            let { url } = req.body;
            let error = {};
            let errCount = 0;
            if (req.method == 'POST' && !req.file) {
              errCount++;
              error.file = 'Gift image is required';
            }
            let getSlug = url ? url.split('/')[1] : '';
            let checkSlug = await productModel.cat_slug_exist(getSlug);
            if (checkSlug.length == 0) {
              errCount++;
              error.url = 'Url not exist';
            }

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
  create_press_room: async (req, res, next) => {
    try {
      let upload = multer({
        storage: press_room_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: async (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();

          if (
            ext == '.png' ||
            ext == '.jpg' ||
            ext == '.jpeg' ||
            ext == '.webp'
          ) {
            // let validateImage = await validatingImage(schemas.create_gift);
            // console.log('validateImage', validateImage);
            // if (validateImage) {
            cb(null, true);
            // }
          } else {
            cb(null, false);
            return cb('Only .png, .jpg, .jpeg format allowed!', null);
          }
        }
      }).single('image');
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
          const result = schemas.create_press_room.validate(req.body, {
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
            let { url } = req.body;
            let error = {};
            let errCount = 0;
            if (req.method == 'POST' && !req.file) {
              errCount++;
              error.file = 'Press room image is required';
            }
            /*   let getSlug = url ? url.split('/')[1] : '';
            let checkSlug = await productModel.cat_slug_exist(getSlug);
            if (checkSlug.length == 0) {
              errCount++;
              error.url = 'Url not exist';
            } */

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
  create_governance: async (req, res, next) => {
    try {
      let upload = multer({
        storage: governance_file,
        limits: {
          fileSize: 10000000 // Compliant: 8MB
        },
        fileFilter: async (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();

          if (ext == '.pdf') {
            cb(null, true);
          } else {
            cb(null, false);
            return cb('Only .pdf format allowed!', null);
          }
        }
      }).single('file');
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
          const result = schemas.create_governance.validate(req.body, {
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
            if (req.method == 'POST' && !req.file) {
              errCount++;
              error.file = 'Governance file is required';
            }
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
  job_submit: async (req, res, next) => {
    try {
      let upload = multer({
        storage: cv_file,
        limits: {
          fileSize: 10000000 // Compliant: 8MB
        },
        fileFilter: async (req, file, cb) => {
          let ext = path.extname(file.originalname).toLowerCase();

          if (ext == '.pdf') {
            cb(null, true);
          } else {
            cb(null, false);
            return cb('Only .pdf format allowed!', null);
          }
        }
      }).single('cv');
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
          const result = schemas.job_submit.validate(req.body, {
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
            if (req.method == 'POST' && !req.file) {
              errCount++;
              error.file = 'CV is required';
            }

            let { job_id } = req.body;

            if (job_id) {
              const jobIdExists = await cmsModel.job_find_one(job_id);
              if (jobIdExists.length == 0) {
                err++;
                error.job_id = 'Job not exists';
              } else {
                req.jobTitle = jobIdExists[0].title;
              }
            }

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
  update_page: async (req, res, next) => {
    try {
      let upload = multer({
        storage: page_images,
        limits: {
          fileSize: 2000000 // Compliant: 8MB
        },
        fileFilter: async (req, file, cb) => {
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
      }).single('image');
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
          const result = schemas.update_page.validate(req.body, {
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
            // if (req.method == 'POST' && !req.file) {
            //   errCount++;
            //   error.file = 'Press room image is required';
            // }
            /*   let getSlug = url ? url.split('/')[1] : '';
            let checkSlug = await productModel.cat_slug_exist(getSlug);
            if (checkSlug.length == 0) {
              errCount++;
              error.url = 'Url not exist';
            } */

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
  }
};

export { validateBody, validateParam, schemas, schema_posts };
