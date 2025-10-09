import { Router } from 'express';
import rfqController from '../../controllers/admin/rfqController.js';
import usersRfqController from '../../controllers/rfq/rfqController.js';
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
  '/client-rfq-list',
  passportSignIn,
  // validateBody(rfqSchemas.getAllRfqsForAdminValidation),
  rfqController.getAllClientsrfqsForAdmin
);

rfqRoutes.get(
  '/companies-list',
  passportSignIn,

  rfqController.getAllCompaniesListForAdmin

)
rfqRoutes.post(
  '/update-status',
  passportSignIn,
  validateBody(rfqSchemas.updateRfqStatusValidation),
  rfqController.createOrUpdateAdminRfqService
);

/**
 * @createdBy mukul jatav - 13-06-2025
 * @queryParams {string} id - The ID of the RFQ to send a reminder for.
 * @description this api allow admin to send reminder to the vendors who have not submited the quote.
 */
rfqRoutes.get(
  '/send-reminder/:id',
  passportSignIn,
  usersRfqController.sendReminder
);

/**
 * @description Get vendors who haven't submitted quotes for selective reminder
 */
rfqRoutes.get(
  '/vendors-for-reminder/:id',
  passportSignIn,
  usersRfqController.getVendorsForReminder
);

/**
 * @description Send selective reminder to chosen vendors
 */
rfqRoutes.post(
  '/send-selective-reminder/:id',
  passportSignIn,
  usersRfqController.sendSelectiveReminder
);

rfqRoutes.get('/rfq-list/:id', passportSignIn, validateParam(schemas.id), rfqController.getRfqById);

export default rfqRoutes;
