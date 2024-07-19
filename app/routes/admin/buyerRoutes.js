import { Router } from 'express';

import buyerController from '../../controllers/admin/buyerController.js';

import { validateDbBody } from '../../validations/dbValidation/buyerDbValidation.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/buyerValidation.js';
import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const buyerRoutes = Router();

buyerRoutes.get('/buyer-list', passportSignIn, buyerController.buyerList);
buyerRoutes.get(
  '/buyer-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.buyer_id_exists,
  buyerController.buyerDetails
);
buyerRoutes.get(
  '/buyer-rfq-list/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.buyer_id_exists,
  buyerController.buyer_rfq_list
);
buyerRoutes.get(
  '/buyer-subscription-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.buyer_id_exists,
  buyerController.buyer_subscription_details
);
buyerRoutes.put(
  '/block-buyer/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.approval),
  validateDbBody.buyer_block_check,
  buyerController.blockBuyer
);

buyerRoutes.put(
  '/update-buyer/:id',
  passportSignIn,
  validateParam(schemas.id),
  schema_posts.update_buyer,
  validateDbBody.buyer_id_exists,
  validateDbBody.buyer_email_mobile_exists,
  buyerController.updateBuyer
);

buyerRoutes.put(
  '/accept-buyer/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.approval),
  validateDbBody.buyer_approve_check,
  buyerController.approveBuyer
);

buyerRoutes.delete(
  '/delete-buyer/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.buyer_id_exists,
  buyerController.deleteBuyer
);

export default buyerRoutes;
