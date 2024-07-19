import { Router } from 'express';

import couponController from '../../controllers/admin/couponController.js';

import { validateDbBody } from '../../validations/dbValidation/couponDbValidation.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/couponValidation.js';
import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const couponRoutes = Router();

couponRoutes.post(
  '/create-coupon',
  passportSignIn,
  validateBody(schemas.create_coupon),
  validateDbBody.create_coupon,
  couponController.createCoupon
);

couponRoutes.put(
  '/update-coupon/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.create_coupon),
  validateDbBody.update_coupon,
  couponController.updateCoupon
);

couponRoutes.get('/list-coupon', passportSignIn, couponController.listCoupon);

couponRoutes.delete(
  '/delete-coupon/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.update_coupon,
  couponController.deleteCoupon
);

couponRoutes.post(
  '/add-offer',
  passportSignIn,
  validateBody(schemas.add_offer),
  validateDbBody.add_offer,
  couponController.addOffer
);
couponRoutes.get('/offer-list', passportSignIn, couponController.offerList);
couponRoutes.get(
  '/offer-by-id/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.offer_id_exists,
  couponController.offerDetails
);
couponRoutes.put(
  '/update-offer/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.add_offer),
  validateDbBody.offer_id_exists,
  validateDbBody.add_offer,
  couponController.updateOffer
);
couponRoutes.delete(
  '/delete-offer/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.offer_id_exists,
  couponController.deleteOffer
);

export default couponRoutes;
