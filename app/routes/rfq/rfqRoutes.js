import { Router } from 'express';
import rfqController from '../../controllers/rfq/rfqController.js';
import noLogin from '../../middleware/noLogin.js';
import { validateBody, validateParam } from '../../validations/paramValidation/userValidation.js';
import { validateDbBody } from '../../validations/dbValidation/userDbValidation.js';
import passport from '../../middleware/passport.js';
import { rfqSchemas } from '../../validations/paramValidation/rfqValidation.js';
import { validateGetRfqsQuery } from '../../validations/paramValidation/rfqValidation.js';
const passportSignIn = passport.authenticate('jwtUsr', { session: false });
import { acl, verifyAIWebhookBody } from '../../helper/common.js';
import { schema_posts } from '../../validations/paramValidation/productValidation.js';
import { projectSchemas } from '../../validations/paramValidation/projectValidation.js';


const RfqRoutes = Router();

RfqRoutes.post(
  '/create',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateDbBody.project_access_check,
  validateBody(rfqSchemas.create),
  rfqController.create
);

RfqRoutes.post(
  '/save-draft',
  passportSignIn,
  acl([2, 8]),
  rfqController.saveDraft
);

RfqRoutes.get(
  '/draft',
  passportSignIn,
  acl([2, 8]),
  rfqController.getRFQDraftData
);
RfqRoutes.delete(
  '/delete-draft/:id', 
  passportSignIn,
  validateParam(rfqSchemas.id),
  rfqController.deleteDraft
);  


RfqRoutes.post(
  '/add-product-to-draft',
  passportSignIn,
  acl([2, 8]),
  rfqController.createOrUpdateRfqDraftWithProductVendors
);

RfqRoutes.post(
  '/remove-vendor-from-draft',
  passportSignIn,
  acl([2, 8]),
  rfqController.removeVendorFromDraft
);

RfqRoutes.post(
  '/add-product-to-rfq',
  passportSignIn,
  acl([2, 8]),
  validateDbBody.rfq_access_check,
  rfqController.addProductVendorsInEditRfq
);

RfqRoutes.put(
  '/update',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateDbBody.rfq_access_check,
  validateBody(rfqSchemas.update),
  rfqController.update
);


RfqRoutes.post(
  '/get-details',
  noLogin.customer_auth,
  validateDbBody.rfq_access_check_req_body,
  rfqController.getRfqDetailsById
);

RfqRoutes.get(
  '/getRfqById/:id',
  noLogin.customer_auth,
  validateDbBody.rfq_access_check_req_body,
  rfqController.getRfqById
);

// RfqRoutes.get('/targetPriceHistory/:rfq_product_id',
//   passportSignIn,
//   rfqController.getTargetPricehistory
// )

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

// RFQ Chart Data
// mukul 07-06-2025 ,  not in use, cross check and remove
RfqRoutes.get(
  '/rfq-chart-data',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.getRfqChartData
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
  acl([2, 8]),
  validateDbBody.rfq_access_check,
  validateDbBody.user_id_profileexists,
  rfqController.getVendors
);

RfqRoutes.post(
  '/get-vendors-for-product',
  passportSignIn,
  acl([2, 8]),
  validateDbBody.user_id_profileexists,
  rfqController.getVendorsForProduct
)

RfqRoutes.get(
  '/get-vendors-by-rfq-product',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.getVendorsByRfqProduct
)

RfqRoutes.post(
  '/quote/create',
  noLogin.customer_auth,
  validateDbBody.rfq_access_check_req_body,
  rfqController.createQuote
);

RfqRoutes.put(
  '/quote/update/:quoteId',
  noLogin.customer_auth,
  validateDbBody.rfq_access_check_req_body,
  rfqController.updateQuoteItems
);

RfqRoutes.get(
  '/get-quotes/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8, 10]),
  validateDbBody.rfq_access_check,
  rfqController.getQuotesByRfqById
);
RfqRoutes.get(
  '/download-quote-results/:id',
  passportSignIn,
  acl([2, 8, 10]),
  validateDbBody.user_id_profileexists,
  validateDbBody.rfq_access_check,
  // rfqController.downloadQuoteResults
  rfqController.downloadQuoteResultsProductWise
);
RfqRoutes.get(
  '/get-lpr-lqr',
   passportSignIn,
   acl([2, 8, 10]),
   validateDbBody.user_id_profileexists,
   rfqController.getLprLqrByVariantId
)
RfqRoutes.get(
  '/close-rfq/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateDbBody.rfq_access_check,
  rfqController.closeRFQ
);
RfqRoutes.get(
  '/send-reminder/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateDbBody.rfq_access_check,
  rfqController.sendReminder
);
RfqRoutes.get(
  '/vendors-for-reminder/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateDbBody.rfq_access_check,
  rfqController.getVendorsForReminder
);
RfqRoutes.post(
  '/send-selective-reminder/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateDbBody.rfq_access_check,
  rfqController.sendSelectiveReminder
);
RfqRoutes.post(
  '/finalize',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8, 10]),
  validateDbBody.rfq_access_check,
  validateBody(rfqSchemas.finalize),
  rfqController.finalize
);

RfqRoutes.post(
  '/search-product',
  rfqController.searchProduct
);

RfqRoutes.post(
  '/search-variant-products',
  rfqController.searchVariantProducts
);

RfqRoutes.post(
  '/search-variant-vendors',
  rfqController.searchVariantVendors
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


// mukul 07-06-2025 ,  not in use but functional 
RfqRoutes.post(
  '/product-price-stats',
  noLogin.customer_auth,
  acl([2, 8]),
  rfqController.productPriceStats
);

RfqRoutes.get(
  '/get-past-rfqs/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.getPastRFQs
);

RfqRoutes.post('/rfq-list', passportSignIn, rfqController.rfqList);


RfqRoutes.get('/get-vendor-quote-status/:rfq_id',
   passportSignIn,
   acl([3]),
   rfqController.getVendorQuoteStatus);

// mukul 07-06-2025 ,  not in use, cross check and remove even if this is wokrong move this to another roue folder as this file belongs to rfq only
RfqRoutes.get('/save-state-cities', rfqController.saveStateCities);

// to show the available units
// mukul 07-06-2025 ,  not in use but functioanl not remove this one
RfqRoutes.get('/units',
  // passportSignIn,
  rfqController.getUnits
)

// to show the preview of the final data for the creation of the rfq
RfqRoutes.post('/magic-search-rfq-preview',
  passportSignIn, 
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateDbBody.project_access_check,
  // schema_posts.magicSearchExcelUpload, // mukul 21-05-2025,  this is not required as we are not uploading any file, need to remove it completely 
  rfqController.magicSearchRfqCreate
);

RfqRoutes.post('/initiate-magic-search',
  passportSignIn,
  acl([2, 8]),
  rfqController.initiateMagicSearch,
);

RfqRoutes.post('/magic-webhook',
  // passportSignIn,
  // acl([2, 8]),
  verifyAIWebhookBody,
  rfqController.handleAIWebhook,
);

RfqRoutes.post('/estimate-cost',
  noLogin.customer_auth,
  rfqController.estimateCost,
)
RfqRoutes.post('/send-follow-up-emails',
  passportSignIn,
  acl[3],
  rfqController.sendFollowUpEmails,
)

RfqRoutes.get('/get-cost-estimation/:persistent_id',
  passportSignIn,
  rfqController.getCostEstimatesData
)
RfqRoutes.post('/tender-summary',
  noLogin.customer_auth,
  rfqController.tenderSummary
)

RfqRoutes.post('/technical-summary',
  noLogin.customer_auth,
  schema_posts.clauseFileUpload,
  rfqController.addClauseUsingFile
)

RfqRoutes.get('/process-magic-search-draft',
  passportSignIn, 
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateDbBody.project_access_check,
  // schema_posts.magicSearchExcelUpload, // mukul 21-05-2025,  this is not required as we are not uploading any file, need to remove it completely 
  rfqController.processMagicSearchDraft
);

RfqRoutes.get('/draft-sheets',
  passportSignIn, 
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateDbBody.project_access_check,
  // schema_posts.magicSearchExcelUpload, // mukul 21-05-2025,  this is not required as we are not uploading any file, need to remove it completely 
  rfqController.getRfqDraftSheets
);

RfqRoutes.get('/draft-sheet-wise',
  passportSignIn, 
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateDbBody.project_access_check,
  // schema_posts.magicSearchExcelUpload, // mukul 21-05-2025,  this is not required as we are not uploading any file, need to remove it completely 
  rfqController.getDraftRfqSheetWise
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
  '/send-query-message-to-vendor',
  noLogin.customer_auth,
  rfqSchemas.queryMessageFileUploadHandler,
  // validateDbBody.rfq_access_check_req_body,
  // validateBody(rfqSchemas.sendMessageToVendors),
  rfqController.sendBroadcastQueryMessageToVendors
);

RfqRoutes.post(
  '/negotiate',
  passportSignIn,
  validateDbBody.negotiateModule,
  rfqController.negotiatePrice
)

RfqRoutes.get('/targetPrice/:rfq_product_id',
  passportSignIn,
  rfqController.getTargetPriceHistrory  
)

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

RfqRoutes.get(
  '/vendor-types',
  rfqController.vendorTypes
);

// to create the rfq using magic search rfq feature
RfqRoutes.post('/magic-search-rfq-create',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateDbBody.project_access_check,
  validateBody(rfqSchemas.create),
  rfqController.create  
)

RfqRoutes.post(
  '/boq/process-and-download',
  passportSignIn,
  acl([2, 8]),
  schema_posts.magicSearchExcelUpload,
  rfqController.processBoqAndDownload
);

RfqRoutes.post('/add-clause-using-file',
  passportSignIn,
  acl([2, 8]),
  schema_posts.clauseFileUpload,
  validateDbBody.rfq_access_check,
  validateBody(rfqSchemas.addClauseUsingFile),
  rfqController.addClauseUsingFile
)

RfqRoutes.post('/add-clause',
  passportSignIn,
  acl([2, 8]),
  validateDbBody.rfq_access_check,
  validateBody(rfqSchemas.addClause),
  rfqController.addClause
)

RfqRoutes.put('/update-clause',
  passportSignIn,
  acl([2, 8]),
  validateBody(rfqSchemas.updateClause),
  rfqController.updateClause
)

RfqRoutes.delete('/remove-clause/:id',
  passportSignIn,
  acl([2, 8]),
  validateParam(rfqSchemas.id),
  rfqController.removeClause
)

RfqRoutes.get('/get-clauses/:id',
  noLogin.customer_auth,
  // validateDbBody.rfq_access_check_req_body,
  rfqController.getClauses
)

// vendor side
RfqRoutes.post('/add-tech-comment',
  noLogin.customer_auth,
  // validateBody(rfqSchemas.addTechComment),
  rfqController.addTechComment
)

// vendor side
RfqRoutes.post('/get-tech-comments',
  noLogin.customer_auth,
  validateBody(rfqSchemas.getTechComments),
  rfqController.getTechComments
)
RfqRoutes.post('/get-summarised-deviation',
  passportSignIn,
  rfqController.getSummarisedDeviation
)

RfqRoutes.post('/get-vendor-names',
  passportSignIn,
  validateBody(rfqSchemas.getVendorNames),
  validateDbBody.rfq_access_check,
  rfqController.getVendorNames
)

// vendor side
RfqRoutes.post('/get-vendor-responses',
  noLogin.customer_auth,
  validateBody(rfqSchemas.getVendorResponses),
  // validateDbBody.rfq_access_check,
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
  // validateBody(rfqSchemas.addtechEvaluationClearedVendors),
  rfqController.addtechEvaluationClearedVendors
)

RfqRoutes.post('/get-tech-evaluation-rfqs',
  passportSignIn,
  rfqController.getTechEvaluationRFQDetails
)

// New unified route for sidebar data (now GET, params in query)
RfqRoutes.get('/get-rfqs',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8, 9, 10]),
  validateGetRfqsQuery,
  rfqController.getRfqs
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

//  product wise audit report
RfqRoutes.get('/report/rfq-product-wise',
  passportSignIn,
  rfqController.rfqProductWiseReport
)

//  product wise audit report
RfqRoutes.get('/report/rfq-project-wise',
  passportSignIn,
  rfqController.projectWiseReport
)


//  product wise audit report
RfqRoutes.post('/report/send-on-email',
  passportSignIn,
  schema_posts.reportZipFileUpload,
  rfqController.sendReportOnEmail
)

RfqRoutes.get(
  '/rfq-draft-data',
  passportSignIn,
  acl([2, 8]),
  rfqController.getRFQDraftData
);

RfqRoutes.post(
  '/get-draft-rfqs',
  passportSignIn,
  acl([2, 8]),
  rfqController.getDraftRFQs
);

RfqRoutes.post(
  '/get-processing-rfqs',
  passportSignIn,
  acl([2, 7, 8]),
  rfqController.getProcessingRFQs
);

RfqRoutes.get(
  '/get-draft-by-id/:id',
  passportSignIn,
  acl([2, 8]),
  rfqController.getDraftById
);

RfqRoutes.post('/get-draft-vendors/:draftId',
  passportSignIn,
  acl([2, 8]),
  rfqController.getDraftProductVendors
)

RfqRoutes.post(
  '/draft-product-vendors',
  passportSignIn,
  acl([2, 8]),
  rfqController.createOrUpdateRfqDraftWithProductVendors
);

RfqRoutes.post(
  '/save-excel',
  passportSignIn,
  rfqController.saveExcel
);

export default RfqRoutes;