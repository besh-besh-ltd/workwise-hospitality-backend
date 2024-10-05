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
    })
}

