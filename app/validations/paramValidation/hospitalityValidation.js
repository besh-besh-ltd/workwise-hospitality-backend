import Joi from 'joi';

const validateBody = (schema) => {
  return (req, res, next) => {
    const result = schema.validate(req.body, { abortEarly: false });

    if (result.error) {
      const errMsg = {};
      for (const detail of result.error.details) {
        errMsg[detail.context.key] = detail.message;
      }
      return res.status(400).json({ status: 2, errors: errMsg });
    }

    if (!req.value) {
      req.value = {};
    }
    req.value.body = result.value;
    next();
  };
};

const validateParam = (schema) => {
  return (req, res, next) => {
    const result = schema.validate(req.params);
    if (result.error) {
      return res.status(400).json({ status: 2, errors: 'Invalid argument' });
    }

    if (!req.value) {
      req.value = {};
    }
    req.value.params = result.value;
    next();
  };
};

const schemas = {
  companyIdParam: Joi.object()
    .keys({
      company_id: Joi.number().integer().required(),
    })
    .required(),
  hospitalityCompany: Joi.object().keys({
    name: Joi.string().trim().max(120).required(),
    region: Joi.string().trim().allow('', null),
    contact_email: Joi.string()
      .trim()
      .email({ tlds: { allow: false } })
      .allow('', null),
  }),
  hospitalityHotel: Joi.object().keys({
    name: Joi.string().trim().max(120).required(),
    city: Joi.string().trim().allow('', null),
    keys: Joi.number().integer().min(0).optional(),
    status: Joi.string().trim().max(50).allow('', null),
  }),
  hospitalityMapUsers: Joi.object().keys({
    mapping_type: Joi.number().valid(0, 1).required(),
    hotel_id: Joi.when('mapping_type', {
      is: 1,
      then: Joi.number().required(),
      otherwise: Joi.any().optional().allow(null),
    }),
    user_ids: Joi.array().items(Joi.number().required()).min(1).required(),
    auto_map_projects: Joi.boolean().optional(),
  }),
  hospitalityMapProjects: Joi.object().keys({
    mapping_type: Joi.number().valid(0, 1).required(),
    hotel_id: Joi.when('mapping_type', {
      is: 1,
      then: Joi.number().required(),
      otherwise: Joi.any().optional().allow(null),
    }),
    project_ids: Joi.array().items(Joi.number().required()).min(1).required(),
  }),
  hospitalitySubscriptionPayment: Joi.object().keys({
    user_key: Joi.string().required(),
    categories: Joi.array()
      .items(Joi.number().integer().positive())
      .min(1)
      .required(),
    hotels: Joi.array()
      .items(Joi.number().integer().positive())
      .optional()
      .allow(null),
  }),
  deleteMapping: Joi.object().keys({
    company_id: Joi.number().integer().required(),
    mapping_type: Joi.number().valid(0, 1).required(),
    hotel_id: Joi.when('mapping_type', {
      is: 1,
      then: Joi.number().required(),
      otherwise: Joi.any().optional().allow(null),
    }),
  }),
};

export { validateBody, validateParam, schemas };


