import { Router } from 'express';
import rfqController from '../../controllers/rfq/rfqController.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/userValidation.js';
import { validateDbBody } from '../../validations/dbValidation/userDbValidation.js';
import passport from '../../middleware/passport.js';
import { rfqSchemas } from '../../validations/paramValidation/rfqValidation.js';
const passportLogIn = passport.authenticate('localUsr', { session: false });
const passportSignIn = passport.authenticate('jwtUsr', { session: false });
import { acl } from '../../helper/common.js';

const RfqRoutes = Router();

RfqRoutes.post(
  '/create',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  validateBody(rfqSchemas.create),
  rfqController.create
);

RfqRoutes.put(
  '/update',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  validateBody(rfqSchemas.update),
  rfqController.create
);

RfqRoutes.get(
  '/all',
  // passportSignIn,
  //validateDbBody.user_id_profileexists,
  rfqController.listAll
);

RfqRoutes.get(
  '/getRfqById/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.getRfqById
);

RfqRoutes.post(
  '/getMyRfq',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.getRfqByUser
);

RfqRoutes.post(
  '/rfq-report',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.getRfqReport
);

RfqRoutes.post(
  '/getBuyerRfq',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.getBuyerRfq
);

RfqRoutes.get('/get-terms', rfqController.getTerms);

RfqRoutes.post(
  '/get-vendors',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.getVendors
);

RfqRoutes.post(
  '/quote/create',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.createQuote
);
RfqRoutes.get(
  '/get-quotes/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.getQuotesByRfqById
);
RfqRoutes.get(
  '/download-quote-results/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  // rfqController.downloadQuoteResults
  rfqController.downloadQuoteResultsProductWise
);
RfqRoutes.get(
  '/close-rfq/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.closeRFQ
);
RfqRoutes.get(
  '/send-reminder/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.sendReminder
);
RfqRoutes.post(
  '/finalize',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  validateBody(rfqSchemas.finalize),
  rfqController.finalize
);

RfqRoutes.post(
  '/search-product',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.searchProduct
);

RfqRoutes.post(
  '/search-vendor',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.searchVendor
);
RfqRoutes.get(
  '/get-past-rfqs/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.getPastRFQs
);

RfqRoutes.post('/rfq-list', passportSignIn, rfqController.rfqList);

RfqRoutes.get('/save-state-cities', rfqController.saveStateCities);

export default RfqRoutes;
