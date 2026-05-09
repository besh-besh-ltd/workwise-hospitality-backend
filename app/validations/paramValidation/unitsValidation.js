import Joi from "joi";

export const unitsSchemas = {
  create: Joi.object().keys({
    name: Joi.string().trim().min(1).max(50).required().messages({
      "string.empty": "Unit name is required",
      "string.max": "Unit name must be at most 50 characters",
    }),
  }),
  id: Joi.object().keys({
    id: Joi.number().integer().required(),
  }),
};
