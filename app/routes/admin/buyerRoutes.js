import { Router } from 'express';

import buyerController from '../../controllers/admin/buyerController.js';
import usersController from '../../controllers/users/usersController.js';

import { validateDbBody } from '../../validations/dbValidation/buyerDbValidation.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/buyerValidation.js';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const buyerRoutes = Router();

buyerRoutes.get(
  '/buyer-list', 
  passportSignIn, 
  buyerController.buyerList
);
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

buyerRoutes.get(
  '/account-limits/:company_id',
  passportSignIn,
  usersController.getBuyerAccountLimits
);

buyerRoutes.put(
  '/update-account-limits/:company_id',
  passportSignIn,
  buyerController.updateBuyerAccountLimits
);

// mukul 07-06-2025 ,  not in use, cross check and remove
buyerRoutes.put(
  '/accept-buyer/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.approval),
  validateDbBody.buyer_approve_check,
  buyerController.approveBuyer
);


// mukul 07-06-2025 ,  not in use, but functionlion and we can use this by adding a delete button on buyer list in admin buyer management so that admin can make a buyer as deleted, 
buyerRoutes.delete(
  '/delete-buyer/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.buyer_id_exists,
  buyerController.deleteBuyer
);

buyerRoutes.put(
  '/review-buyers-private-vendor',
  passportSignIn,
  acl([1]),
  buyerController.reviewBuyerPrivateVendors
)

//  get the list of vendor to review.
buyerRoutes.get('/buyer-private-vendor-list', passportSignIn, buyerController.getBuyerPrivateVendorList);

// Changes by Agnij 2025-05-27 [Added admin company registration endpoint]
buyerRoutes.post(
  '/company-registration',
  passportSignIn,
  schema_posts.add_buyer,
  usersController.company_registration
);

export default buyerRoutes;
