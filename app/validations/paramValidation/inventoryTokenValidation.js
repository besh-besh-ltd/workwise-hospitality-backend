// Request validation for the site-rep token routes (/api/v1/inventory/token/*),
// task C5. Shape only: the PO and hotel always come from the token
// (req.receiveToken), so poId and hotelId are optional here and never authority.

import Joi from 'joi';
import { createGrnSchema } from './inventoryReceiveValidation.js';

const ID = Joi.number().integer().positive();

/** POST /token/grn: GrnInput without poId/hotelId; post defaults to true (false is refused). */
export const tokenGrnSchema = createGrnSchema.keys({
  poId: ID.allow(null),
  hotelId: ID.allow(null),
  post: Joi.boolean().default(true),
});

export default { tokenGrnSchema };
