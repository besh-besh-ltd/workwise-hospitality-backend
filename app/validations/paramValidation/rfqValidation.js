import Joi from 'joi';

const vendorItems = Joi.object({
  user_id: Joi.number().required(),
  name: Joi.string().optional()
});
const specItems = Joi.object({
  title: Joi.string().required(),
  value: Joi.string().required()
});
const termsItems = Joi.object({
  id: Joi.number().required()
});

const productItems = Joi.object({
  name: Joi.string().optional().allow(null).allow(''),
  variant: Joi.number().optional().allow('').allow(null),
  product_id: Joi.number().required(),
  comment: Joi.string().optional().allow(null).allow(''),
  datasheet: Joi.string().optional().allow(null).allow(''),
  datasheet_file: Joi.string().optional().allow(null).allow(''),
  spec_file: Joi.string().optional().allow(null).allow(''),
  qap_file: Joi.string().optional().allow(null).allow(''),
  qap: Joi.string().optional().allow(null).allow(''),
  vendors: Joi.array().items(vendorItems).allow(null).allow(''),
  spec: Joi.array().items(specItems).required().min(3),
  defaultSelectedVAB: Joi.string().optional().allow('').allow(null),
  predefined_tds_file: Joi.string().optional().allow('').allow(null),
  predefined_qap_file: Joi.string().optional().allow('').allow(null),
  user_selected_predefined_tds: Joi.boolean().optional().allow('').allow(null),
  user_selected_predefined_qap: Joi.boolean().optional().allow('').allow(null)
});

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
      .max(10)
      .required()
      .regex(/^[0-9]*$/),
    bid_end_date: Joi.string().optional().allow('').allow(null),
    location: Joi.string().optional().allow('').allow(null),
    is_published: Joi.number().integer().min(0).max(1).required(),
    products: Joi.array().items(productItems).min(1).required(),
    // products: Joi.array().optional().allow('').allow(null),
    vendors: Joi.array().items(vendorItems).allow(null).allow(''),
    terms: Joi.array().items(termsItems).allow(null).allow('')
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
      .max(10)
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
    quote_id: Joi.number().required()
  })
};
