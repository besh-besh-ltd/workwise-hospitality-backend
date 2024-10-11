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
        ended_at:Joi.string().optional().allow('').allow(null)
    })
}

