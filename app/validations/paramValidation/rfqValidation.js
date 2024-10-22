import Joi from 'joi';

const vendorItems = Joi.object({
  user_id: Joi.number().required(),
  name: Joi.string().optional()
});
const specItems = Joi.object({
  title: Joi.string().valid('Size', 'Spec', 'Quantity', 'Unit').required(),
  value: Joi.string().allow('').optional()
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
  datasheet_file: Joi.array().items(Joi.string()).optional(),
  spec_file: Joi.array().items(Joi.string()).optional(),
  qap_file: Joi.array().items(Joi.string()).optional(),
  qap: Joi.string().optional().allow(null).allow(''),
  vendors: Joi.array().items(vendorItems).allow(null).allow(''),
  spec: Joi.array().items(specItems).required().min(4).max(4)
  .custom((value, helpers) => {
    const quantityItem = value.find(item => item.title === 'Quantity');
    const unitItem = value.find(item => item.title === 'Unit');
    if (!quantityItem || !unitItem || !quantityItem.value || !unitItem.value) {
      return helpers.error('any.required');
    }
    return value;
  }),
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
    comment: Joi.string().optional()
  }),
};
