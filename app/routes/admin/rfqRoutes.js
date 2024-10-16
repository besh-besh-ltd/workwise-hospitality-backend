import { Router } from 'express';
import rfqController from '../../controllers/admin/rfqController.js';
import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });
import { validateBody, validateParam, schemas } from '../../validations/paramValidation/buyerValidation.js';
import { rfqSchemas } from '../../validations/paramValidation/rfqValidation.js';

const rfqRoutes = Router();

rfqRoutes.post(
  '/rfq-list',
  passportSignIn,
  validateBody(rfqSchemas.getAllRfqsForAdminValidation),
  rfqController.getAllRfqs
);
rfqRoutes.post(
  '/update-status',
  passportSignIn,
  validateBody(rfqSchemas.updateRfqStatusValidation),
  rfqController.createOrUpdateAdminRfqService
);
rfqRoutes.get('/rfq-list/:id', passportSignIn, validateParam(schemas.id), rfqController.getRfqById);

export default rfqRoutes;
