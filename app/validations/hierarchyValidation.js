import Joi from "joi";
import { AVAILABLE_HIERARCHY_TYPES } from "../util/constants.js";

const approversType = Joi.object({
  user_id: Joi.number().required(),
  approval_level: Joi.number().required(),
  bypass_cap: Joi.number().required(),
  is_active: Joi.boolean().required(),
});

export const hierarchySchema = {
    getHeirarchies: Joi.object({
        type: Joi.string().allow(...Object.keys(AVAILABLE_HIERARCHY_TYPES)).optional()
    }),
    createHeirarchy: Joi.object({
        type: Joi.string().allow(...Object.keys(AVAILABLE_HIERARCHY_TYPES)).required(),
        approvers: Joi.array().items(approversType).required()
    }),
    updateHierarchy: Joi.object({
        type: Joi.string().allow(...Object.keys(AVAILABLE_HIERARCHY_TYPES)).required(),
        approvers: Joi.array().items(approversType).required(),
        removableApprovers: Joi.array().items(Joi.number()).optional()
    }),
    mapHierarchyToProject: Joi.object({
        hierarchy_id: Joi.number().required(),
        project_id: Joi.number().required(),
    }),
}