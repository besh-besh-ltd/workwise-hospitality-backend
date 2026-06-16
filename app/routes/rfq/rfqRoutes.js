import { Router } from 'express';
import rfqController from '../../controllers/rfq/rfqController.js';
import noLogin from '../../middleware/noLogin.js';
import { validateBody, validateParam } from '../../validations/paramValidation/userValidation.js';
import { validateDbBody } from '../../validations/dbValidation/userDbValidation.js';
import passport from '../../middleware/passport.js';
import { rfqSchemas } from '../../validations/paramValidation/rfqValidation.js';
import { validateGetRfqsQuery } from '../../validations/paramValidation/rfqValidation.js';
const passportSignIn = passport.authenticate('jwtUsr', { session: false });
import { acl, noAcl, verifyAIWebhookBody } from '../../helper/common.js';
import { schema_posts } from '../../validations/paramValidation/productValidation.js';
import { projectSchemas } from '../../validations/paramValidation/projectValidation.js';
import { can } from '../../middleware/auth.js';
import verifySchedulerRequest from '../../helper/schedulerAuth.js';
import hospitalityMiddleware from '../../middleware/hospitality.js';


const RfqRoutes = Router();

RfqRoutes.post(
  '/create',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  // can('tender.create'),
  validateDbBody.project_access_check,
  validateBody(rfqSchemas.create),
  rfqController.create
);

RfqRoutes.post(
  '/save-draft',
  passportSignIn,
  // can('tender.create'),
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

// Bulk variant — accepts variants: [{ variant_id }, ...] and adds them all
RfqRoutes.post(
  '/add-products-to-draft',
  passportSignIn,
  acl([2, 8]),
  rfqController.createOrUpdateRfqDraftWithBulkProducts
);

// Recommended products for Start RFQ wizard
RfqRoutes.post(
  '/recommended-products',
  passportSignIn,
  acl([2, 8]),
  rfqController.getRecommendedProducts
);

RfqRoutes.get(
  '/fetch-rfq-filters/:rfq_id',
  passportSignIn,
  acl([2, 8]),
  rfqController.fetchRfqFilters 
)

RfqRoutes.post(
  '/remove-vendor-from-draft',
  passportSignIn,
  acl([2, 8]),
  rfqController.removeVendorFromDraft
);

RfqRoutes.post(
  '/refresh-vendors',
  passportSignIn,
  acl([2, 8]),
  rfqController.refreshVendors
);

// @deprecated since WH-69 — adding products is now staged on the frontend and
// persisted as part of the snapshot in PUT /rfq/update. Route kept temporarily
// in case any external caller still hits it; remove after one release cycle.
RfqRoutes.post(
  '/add-product-to-rfq',
  passportSignIn,
  acl([2, 8]),

  rfqController.addProductVendorsInEditRfq
);

RfqRoutes.put(
  '/update',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),

  validateBody(rfqSchemas.update),
  rfqController.update
);

// WH-69: edit history feed for the new "Edit History" panel on rfq-management-details
RfqRoutes.get(
  '/:id/edit-history',
  passportSignIn,
  acl([2, 8]),
  validateParam(rfqSchemas.id),
  rfqController.getEditHistory
);

// RFQ Copy — creates a DRAFT clone of an existing RFQ for the chosen
// business unit (hotel), re-resolving vendors against the target's current
// eligible pool. Returns the new draft ID for the wizard to load.
RfqRoutes.post(
  '/copy',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateBody(rfqSchemas.copy),
  rfqController.copyRfq
);

// Copy lineage: back-link (copied_from) and forward-links (copies) for
// rendering the "Copied from RFQ #N" pill and "Copies of this RFQ" list
// on the RFQ details page. Filtered by the caller's accessible hotels.
RfqRoutes.get(
  '/:id/lineage',
  passportSignIn,
  acl([2, 8]),
  validateParam(rfqSchemas.id),
  rfqController.getRfqLineage
);


RfqRoutes.post(
  '/get-details',
  noLogin.customer_auth,

  rfqController.getRfqDetailsById
);

RfqRoutes.post(
  '/tender-payment/create-order',
  noLogin.customer_auth,

  rfqController.createTenderPaymentOrder
);

RfqRoutes.post(
  '/tender-payment/verify',
  noLogin.customer_auth,
  rfqController.verifyTenderPayment
);

RfqRoutes.get(
  '/lifecycle-summary/:rfqId',
  passportSignIn,
  rfqController.getLifecycleSummary
);

RfqRoutes.get(
  '/:rfqId/lifecycle',
  passportSignIn,
  rfqController.getRfqLifecycle
);

RfqRoutes.get(
  '/getRfqById/:id',
  noLogin.vendorTokenOrJwt,
  hospitalityMiddleware.requireActiveSubscriptionIfAuthenticated,
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

// Get RFQs/Tenders where user is in the approval line (current pending step)
RfqRoutes.post(
  '/pending-approvals',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  rfqController.getPendingApprovalRfqs
);

RfqRoutes.get('/get-terms', rfqController.getTerms);

RfqRoutes.get('/terms-pdf', passportSignIn, rfqController.downloadRfqTermsPdf);

RfqRoutes.post(
  '/get-vendors',
  passportSignIn,
  acl([2, 8]),

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
  noLogin.vendorTokenOrJwt,
  hospitalityMiddleware.requireActiveSubscriptionIfAuthenticated,
  rfqController.createQuote
);

RfqRoutes.put(
  '/quote/update/:quoteId',
  noLogin.vendorTokenOrJwt,
  hospitalityMiddleware.requireActiveSubscriptionIfAuthenticated,
  rfqController.updateQuoteItems
);

RfqRoutes.get(
  '/get-quotes/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8, 10]),
  rfqController.getQuotesByRfqById
);
// Server-computed quote-compare view model: per-line engine output, per-product
// comparison stats (bands, freight advantage, lowest), and overall metrics.
// Same access control as get-quotes.
RfqRoutes.get(
  '/quote-compare/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8, 10]),
  rfqController.getQuoteComparison
);
// Buyer Quote Comparison UI: single flat "QC contract" reshape of the
// comparison data (see quoteCompareViewModel). Read-only, buyer-facing.
RfqRoutes.get(
  '/quote-comparison-view/:id',
  passportSignIn,
  noAcl([3]),
  rfqController.getQuoteComparisonView
);
RfqRoutes.get(
  '/download-quote-results/:id',
  passportSignIn,
  acl([2, 8, 10]),
  validateDbBody.user_id_profileexists,

  // rfqController.downloadQuoteResults
  rfqController.downloadQuoteResultsProductWise
);
RfqRoutes.get(
  '/get-lpr-lqr',
   passportSignIn,
   acl([2,3, 8, 10]),
   validateDbBody.user_id_profileexists,
   rfqController.getLprLqrByVariantId
)

RfqRoutes.get(
  '/get-quote-history',
  noLogin.vendorTokenOrJwt,
  rfqController.getQuoteHistoryForvendor
);

RfqRoutes.post(
  '/close-rfq/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),

  rfqController.closeRFQ
);
RfqRoutes.post(
  '/withdraw-publish/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  rfqController.withdrawPublish
);
RfqRoutes.post(
  '/terminate/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  rfqController.terminateRFQ
);
RfqRoutes.post(
  '/force-publish/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  rfqController.forcePublishRfq
);
RfqRoutes.get(
  '/send-reminder/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),

  rfqController.sendReminder
);
RfqRoutes.get(
  '/vendors-for-reminder/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),

  rfqController.getVendorsForReminder
);
RfqRoutes.post(
  '/send-selective-reminder/:id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),

  rfqController.sendSelectiveReminder
);

RfqRoutes.get(
  '/get-existing-po',
  passportSignIn,
  rfqController.getExistingPO
);

RfqRoutes.post(
  '/finalize',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8, 10]),

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

//Changes By Ayush
RfqRoutes.post(
  '/search-vendor',
  noLogin.customer_auth,
  rfqController.searchVendor
);

RfqRoutes.post(
  '/bulk-search-vendors-by-category',
  noLogin.customer_auth,
  rfqController.bulkSearchVendorsByCategory
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
   acl([2,3]),
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
);
RfqRoutes.post('/send-follow-up-emails',
  passportSignIn,
  acl([2,3]),
  rfqController.sendFollowUpEmails,
);

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
  hospitalityMiddleware.requireActiveSubscriptionIfAuthenticated,
  rfqSchemas.queryMessageFileUploadHandler,

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

  rfqController.listQueryMessages
);

RfqRoutes.post(
  '/list-queries',
  noLogin.customer_auth,

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

  validateBody(rfqSchemas.addClauseUsingFile),
  rfqController.addClauseUsingFile
)

RfqRoutes.post('/add-clause',
  passportSignIn,
  acl([2, 8]),

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
  noLogin.vendorTokenOrJwt,
  rfqController.addTechComment
)

// vendor side
RfqRoutes.post('/get-tech-comments',
  noLogin.vendorTokenOrJwt,
  validateBody(rfqSchemas.getTechComments),
  rfqController.getTechComments
)
RfqRoutes.post('/get-summarised-deviation',
  passportSignIn,
  rfqController.getSummarisedDeviation
)

RfqRoutes.post('/get-deviation-previews',
  noLogin.vendorTokenOrJwt,
  rfqController.getDeviationPreviews
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
  // validateDbBody.rfq_access_check,
  rfqController.getVendorResponses
)

// vendor side
RfqRoutes.post('/add-vendor-response',
  noLogin.customer_auth,
  hospitalityMiddleware.requireActiveSubscriptionIfAuthenticated,
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

RfqRoutes.post(
  '/tech-eval/submit-for-approval',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateBody(rfqSchemas.techEvalSubmitForApproval),
  rfqController.submitTechEvalForApproval
)

RfqRoutes.get('/tech-eval-users/:project_id',
  passportSignIn,
  acl([2, 8]),
  rfqController.getTechEvalUsers
);

// New unified route for sidebar data (now GET, params in query)
RfqRoutes.get('/get-rfqs',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  acl([2, 3, 8, 9, 10]),
  hospitalityMiddleware.requireActiveSubscription,
  validateGetRfqsQuery,
  rfqController.getRfqs
)

// vendor side
RfqRoutes.post('/get-clauses-of-product',
  noLogin.customer_auth,
  validateBody(rfqSchemas.getClausesOfProduct),
  rfqController.getClausesOfProduct
)

// Tech evaluation vendor replacement
RfqRoutes.post('/replace-tech-eval-vendor',
  passportSignIn,
  acl([2, 8, 10]),
  rfqController.replaceTechEvalVendor
);

// Get next vendors for tech evaluation (L6, L7, etc.)
RfqRoutes.get('/get-next-vendors-for-tech-eval',
  passportSignIn,
  acl([2, 8, 10]),
  rfqController.getNextVendorsForTechEval
);

RfqRoutes.post('/get-tech-evaluation-result',
  noLogin.customer_auth,
  validateBody(rfqSchemas.getTechEvaluationResult),
  rfqController.getTechEvaluationResult
)

// Tech Evaluation Status - Get current status with rounds, passed/failed vendors
RfqRoutes.get('/tech-eval/status/:rfq_product_id',
  passportSignIn,
  acl([2, 8, 10]),
  rfqController.getTechEvalStatus
);

// Tech Evaluation History - Get evaluation history by rounds
RfqRoutes.get('/tech-eval/history/:rfq_product_id',
  passportSignIn,
  acl([2, 8, 10]),
  rfqController.getTechEvalHistory
);

// Tech Evaluation Dashboard - Summary of evaluation progress for an RFQ
RfqRoutes.get('/technical/dashboard/:rfq_id',
  passportSignIn,
  acl([2, 8, 10]),
  rfqController.getTechEvalDashboard
);

// Tech Evaluation Approval Action - Custom approve/reject endpoint
// This triggers post-approval processing (auto-replace failed vendors, etc.)
RfqRoutes.post('/tech-eval/approval/action',
  passportSignIn,
  validateBody(rfqSchemas.techEvalApprovalAction),
  rfqController.techEvalApprovalAction
);

// RFQ/Tender Approval Action - Custom approve/reject endpoint
// This triggers post-approval processing (status update to READY_TO_PUBLISH)
RfqRoutes.post('/:id/approve-action',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  validateBody(rfqSchemas.rfqApprovalAction),
  rfqController.approveRFQAction
);

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

//chnages by ayush
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

RfqRoutes.post(
  '/update-minimum-passing-score',
  passportSignIn,
  validateBody(rfqSchemas.updateMinimumPassingScore),
  rfqController.updateMinimumPassingScore
);

RfqRoutes.post(
  '/update-buyer-marks',
  passportSignIn,
  validateBody(rfqSchemas.updateBuyerMarks),
  rfqController.updateBuyerMarks
);

// ============================================
// Clarification Chat/Ticket System Routes
// ============================================

// Vendor raises clarification (with file uploads)
RfqRoutes.post(
  '/clarification/raise',
  noLogin.customer_auth,
  hospitalityMiddleware.requireActiveSubscriptionIfAuthenticated,
  rfqSchemas.clarificationFileUploadHandler,

  validateBody(rfqSchemas.raiseClarification),
  rfqController.raiseClarification
);

// Send message in clarification thread (both vendor and buyer can send)
RfqRoutes.post(
  '/clarification/message',
  noLogin.customer_auth,
  hospitalityMiddleware.requireActiveSubscriptionIfAuthenticated,
  rfqSchemas.clarificationFileUploadHandler,
  validateBody(rfqSchemas.sendClarificationMessage),
  rfqController.sendClarificationMessage
);

// Buyer closes clarification (with optional final response message)
RfqRoutes.post(
  '/clarification/resolve',
  passportSignIn,
  rfqSchemas.clarificationFileUploadHandler,
  validateDbBody.user_id_profileexists,
  acl([2, 8]),
  validateBody(rfqSchemas.resolveClarification),
  rfqController.resolveClarification
);

// List all clarifications for RFQ/Tender with messages (private - vendor sees only their own)
RfqRoutes.get(
  '/clarifications/:rfq_id',
  noLogin.customer_auth,
  rfqController.listClarifications
);

// Check active clarification status with messages (for quote blocking check)
RfqRoutes.get(
  '/clarification/active/:rfq_id',
  noLogin.customer_auth,
  rfqController.getActiveClarification
);

// ============================================
// Charge Names
// ============================================
RfqRoutes.get(
  '/charge-names/all',
  passportSignIn,
  acl([2, 8, 10]),
  rfqController.getAllChargeNames
);
RfqRoutes.get(
  '/charge-names',
  noLogin.vendorTokenOrJwt,
  rfqController.getChargeNames
);
RfqRoutes.post(
  '/charge-names',
  noLogin.vendorTokenOrJwt,
  rfqController.createChargeName
);
RfqRoutes.put(
  '/charge-names/:id',
  noLogin.vendorTokenOrJwt,
  rfqController.updateChargeName
);
RfqRoutes.delete(
  '/charge-names/:id',
  noLogin.vendorTokenOrJwt,
  rfqController.deleteChargeName
);

// ============================================
// Internal Scheduler Endpoints
// ============================================

// Internal endpoint for EventBridge Lambda to publish scheduled RFQs
RfqRoutes.post(
  '/internal/publish',
  verifySchedulerRequest,
  rfqController.schedulerPublishRfq
);

export default RfqRoutes;