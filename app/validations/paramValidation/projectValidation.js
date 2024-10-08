import Joi from 'joi';

export const projectSchemas = {
    create: Joi.object().keys({
        name:Joi.string().required(),
        description:Joi.string().optional().allow('').allow(null),
        location:Joi.string().optional().allow('').allow(null),
        ended_at:Joi.string().optional().allow('').allow(null),
    }),

    project_id: Joi.object().keys({
        project_id: Joi.number().integer().required(),
    }),

    temp_project_id:Joi.object().keys({
        project_id: Joi.number().integer().allow(null),
    }),

    update: Joi.object().keys({
        status:Joi.number().valid(0, 1), // Status can only be 0 or 1
        description:Joi.string().optional().allow('').allow(null),
        location:Joi.string().optional().allow('').allow(null),
        ended_at:Joi.string().optional().allow('').allow(null)
    })
}

