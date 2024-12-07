import { Router } from 'express';
import rfqController from '../../controllers/rfq/rfqController.js';
import noLogin from '../../middleware/noLogin.js';
import { validateBody, validateParam } from '../../validations/paramValidation/userValidation.js';
import { validateDbBody } from '../../validations/dbValidation/userDbValidation.js';
import passport from '../../middleware/passport.js';
import { rfqSchemas } from '../../validations/paramValidation/rfqValidation.js';
const passportLogIn = passport.authenticate('localUsr', { session: false });
const passportSignIn = passport.authenticate('jwtUsr', { session: false });
import { acl } from '../../helper/common.js';
import { schema_posts } from '../../validations/paramValidation/productValidation.js';
import { projectSchemas } from '../../validations/paramValidation/projectValidation.js';


const RfqRoutes = Router();

RfqRoutes.post(
  '/create',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  validateDbBody.rfq_project_exist,
  validateBody(rfqSchemas.create),
  rfqController.create
);

RfqRoutes.post(
  '/save-draft',
  passportSignIn,
  rfqController.saveDraft
);

RfqRoutes.get(
  '/draft',
  passportSignIn,
  rfqController.getRFQDraftData
);

RfqRoutes.post(
  '/add-product-to-draft',
  passportSignIn,
  rfqController.createOrUpdateRfqDraftWithProductVendors
);

RfqRoutes.post(
  '/remove-vendor-from-draft',
  passportSignIn,
  rfqController.removeVendorFromDraft
);

RfqRoutes.put(
  '/update',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  validateBody(rfqSchemas.update),
  rfqController.create
);

// RfqRoutes.get(
//   '/all',
//   // passportSignIn,
//   //validateDbBody.user_id_profileexists,
//   rfqController.listAll
// );

RfqRoutes.post(
  '/get-details',
  noLogin.customer_auth,
  validateDbBody.rfq_access_check_req_body,
  rfqController.getRfqDetailsById
);

RfqRoutes.get(
  '/getRfqById/:id',
  noLogin.customer_auth,
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
  validateBody(projectSchemas.get_buyer_body_validation),
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
  noLogin.customer_auth,
  rfqController.createQuote
);

RfqRoutes.put(
  '/quote/update/:quoteId',
  noLogin.customer_auth,
  rfqController.updateQuoteItems
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
  validateDbBody.rfq_access_check,
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
  rfqController.searchProduct
);

RfqRoutes.post(
  '/search-product-by-category',
  rfqController.searchProductByCategory
);

RfqRoutes.post(
  '/search-vendor',
  noLogin.customer_auth,
  rfqController.searchVendor
);

RfqRoutes.post(
  '/product-price-stats',
  noLogin.customer_auth,
  acl([2]),
  rfqController.productPriceStats
);

RfqRoutes.get(
  '/get-past-rfqs/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.getPastRFQs
);

RfqRoutes.post('/rfq-list', passportSignIn, rfqController.rfqList);

RfqRoutes.get('/save-state-cities', rfqController.saveStateCities);


// to show the preview of the final data for the creation of the rfq
RfqRoutes.post('/magic-search-rfq-preview',
  passportSignIn, 
  validateDbBody.user_id_profileexists,
  acl([2]),
  validateDbBody.rfq_project_exist,
  schema_posts.magicSearchExcelUpload,
  rfqController.magicSearchRfqCreate
);

RfqRoutes.post(
  '/send-query-message',
  noLogin.customer_auth,
  rfqSchemas.queryMessageFileUploadHandler, 
  validateDbBody.rfq_access_check_req_body,
  validateBody(rfqSchemas.sendMessage),
  rfqController.sendQueryMessage
);

RfqRoutes.post(
  '/list-query-messages',
  noLogin.customer_auth,
  validateDbBody.rfq_access_check_req_body,
  rfqController.listQueryMessages
);

RfqRoutes.post(
  '/list-queries',
  noLogin.customer_auth,
  validateDbBody.rfq_access_check_req_body,
  rfqController.listQueries
);

// to create the rfq using magic search rfq feature
RfqRoutes.post('/magic-search-rfq-create',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2]),
  validateDbBody.rfq_project_exist,
  validateBody(rfqSchemas.create),
  rfqController.create  
)

// technical eveluation modules

// route not used
// RfqRoutes.post('/add-technical-eveluation',
//   passportSignIn,
//   rfqController.addTechnicalEveluation 
// )

RfqRoutes.post('/add-clause',
  passportSignIn,
  validateBody(rfqSchemas.addClause),
  rfqController.addClause
)

RfqRoutes.put('/update-clause',
  passportSignIn,
  validateBody(rfqSchemas.updateClause),
  rfqController.updateClause
)

RfqRoutes.delete('/remove-clause/:id',
  passportSignIn,
  validateParam(rfqSchemas.id),
  rfqController.removeClause
)

RfqRoutes.get('/get-clauses/:id',
  noLogin.customer_auth,
  rfqController.getClauses
)


// vendor side
RfqRoutes.post('/add-tech-comment',
  noLogin.customer_auth,
  validateBody(rfqSchemas.addTechComment),
  rfqController.addTechComment
)

// vendor side
RfqRoutes.post('/get-tech-comments',
  noLogin.customer_auth,
  validateBody(rfqSchemas.getTechComments),
  rfqController.getTechComments
)

RfqRoutes.post('/get-vendor-names',
  passportSignIn,
  validateBody(rfqSchemas.getVendorNames),
  rfqController.getVendorNames
)

// vendor side
RfqRoutes.post('/get-vendor-responses',
  noLogin.customer_auth,
  validateBody(rfqSchemas.getVendorResponses),
  rfqController.getVendorResponses
)

// vendor side
RfqRoutes.post('/add-vendor-response',
  noLogin.customer_auth,
  validateBody(rfqSchemas.addVendorResponse),
  rfqController.addVendorResponse
)

RfqRoutes.post('/tech-evaluation-cleared-vendors',
  passportSignIn,
  validateBody(rfqSchemas.addtechEvaluationClearedVendors),
  rfqController.addtechEvaluationClearedVendors
)

// this endpoint needs query( ?token=123123123 ) in the endpoint from the frontend side.
RfqRoutes.get('/get-tech-evaluation-rfqs',
  passportSignIn,
  rfqController.getTechEvaluationRFQDetails
)

// vendor side
RfqRoutes.post('/get-clauses-of-product',
  noLogin.customer_auth,
  validateBody(rfqSchemas.getClausesOfProduct),
  rfqController.getClausesOfProduct
)

// vendor side
RfqRoutes.post('/get-tech-evaluation-result',
  noLogin.customer_auth,
  validateBody(rfqSchemas.getTechEvaluationResult),
  rfqController.getTechEvaluationResult
)

export default RfqRoutes;