import { Router } from 'express';
import { acl } from '../../helper/common.js';
import hospitalityController from '../../controllers/users/hospitalityController.js';
import UsersController from '../../controllers/users/usersController.js';
import hospitalityMiddleware from '../../middleware/hospitality.js';
import passport from '../../middleware/passport.js';
import {
  validateBody,
  validateParam,
  schemas,
  uploadHospitalityDocuments
} from '../../validations/paramValidation/hospitalityValidation.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const HospitalityRoutes = Router();

HospitalityRoutes.get(
  '/companies',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  hospitalityController.listCompanies
);

HospitalityRoutes.post(
  '/company',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  uploadHospitalityDocuments,
  validateBody(schemas.hospitalityCompany),
  hospitalityController.createCompany
);

HospitalityRoutes.put(
  '/company/:company_id',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  uploadHospitalityDocuments,
  validateBody(schemas.hospitalityCompany),
  hospitalityController.updateCompany
);

HospitalityRoutes.get(
  '/company/:company_id/hotels',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  hospitalityController.listCompanyHotels
);

HospitalityRoutes.post(
  '/company/:company_id/hotels',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  uploadHospitalityDocuments,
  validateBody(schemas.hospitalityHotel),
  hospitalityController.createHotel
);

HospitalityRoutes.post(
  '/company/:company_id/create-ho',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  hospitalityController.createHO
);

HospitalityRoutes.put(
  '/company/:company_id/hotels/:hotel_id',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.hotelIdParam),
  uploadHospitalityDocuments,
  validateBody(schemas.hospitalityHotel),
  hospitalityController.updateHotel
);

HospitalityRoutes.get(
  '/hotels/:hotel_id/documents',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  hospitalityController.getHotelDocuments
);

HospitalityRoutes.post(
  '/company/:company_id/map-users',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  validateBody(schemas.hospitalityMapUsers),
  hospitalityController.mapUsers
);

HospitalityRoutes.post(
  '/company/:company_id/map-projects',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  validateBody(schemas.hospitalityMapProjects),
  hospitalityController.mapProjects
);

HospitalityRoutes.get(
  '/company/:company_id/mapped-user-ids',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  hospitalityController.getMappedUserIds
);

HospitalityRoutes.get(
  '/my-contexts',
  passportSignIn,
  hospitalityController.getMyContexts
);

HospitalityRoutes.get(
  '/company/:company_id/user-mappings',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  hospitalityController.listCompanyUserMappings
);

HospitalityRoutes.get(
  '/company/:company_id/mapped-project-ids',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  hospitalityController.getMappedProjectIds
);

HospitalityRoutes.get(
  '/project/:project_id/mappings',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.checkHospitality(false),
  hospitalityController.getProjectMappings
);


HospitalityRoutes.delete(
  '/project/:project_id/mapping',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateBody(schemas.deleteMapping),
  hospitalityController.deleteProjectMapping
);

HospitalityRoutes.get(
  '/user/:user_id/mappings',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  hospitalityController.getUserMappingsById
);

HospitalityRoutes.delete(
  '/user/:user_id/mapping',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateBody(schemas.deleteMapping),
  hospitalityController.deleteUserMapping
);


  /**
   * @created : mukul jatav 
   * validate rfq_id params ( not in db just format )
   * Retrieves all hotels currently mapped to the specified RFQ.
 */
HospitalityRoutes.get(
  '/rfq-hotels/:rfq_id',
  passportSignIn,
  validateParam(schemas.rfqIdParam),
  hospitalityController.getRFQHotels
);


HospitalityRoutes.post(
  '/subscription-payment',
  validateBody(schemas.hospitalitySubscriptionPayment),
  UsersController.hospitalitySubscriptionPayment
);



HospitalityRoutes.get('/entities', passportSignIn, acl([7]), UsersController.getListedEntities);

// Send BU login credentials to mapped users
HospitalityRoutes.post(
  '/company/:company_id/hotels/:hotel_id/send-credentials',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  hospitalityController.sendBUCredentials
);

// Send payment link to business unit email (admin action)
HospitalityRoutes.post(
  '/company/:company_id/hotels/:hotel_id/send-payment-link',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  hospitalityController.sendPaymentLink
);

// Send batch payment links (company-level or BU-level)
HospitalityRoutes.post(
  '/company/send-batch-payment-links',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  hospitalityController.sendBatchPaymentLinks
);

// Public endpoints for hotel payment (accessed via email link, no auth)
HospitalityRoutes.get(
  '/hotel-payment/:hotel_id',
  hospitalityController.getHotelPaymentInfo
);

// Public endpoint for company-level consolidated payment info
HospitalityRoutes.get(
  '/hotel-payment/company/info',
  hospitalityController.getCompanyPaymentInfo
);

HospitalityRoutes.post(
  '/hotel-payment/create-order',
  hospitalityController.createHotelPaymentOrder
);

HospitalityRoutes.post(
  '/hotel-payment/verify',
  hospitalityController.verifyHotelPayment
);

/**
 * @route GET /api/v1/hospitality/vendor/my-mappings
 * @description Get all active hotel and category subscriptions for the authenticated vendor
 * @access Private (Vendors only - authenticated via JWT)
 * @returns {Object} Hotels array and categorized categories object
 */
HospitalityRoutes.get(
  '/vendor/my-mappings',
  passportSignIn,
  hospitalityController.getVendorMappings
);

/**
 * @route GET /api/v1/hospitality/vendor/subscription-status
 * @description Get vendor's full subscription state (active/expired/pending, categories, hotels, expiry)
 * @access Private (Vendors only - authenticated via JWT)
 */
HospitalityRoutes.get(
  '/vendor/subscription-status',
  passportSignIn,
  hospitalityController.getVendorSubscriptionStatus
);

/**
 * @route POST /api/v1/hospitality/renew-subscription
 * @description Renew an expired hospitality subscription. Auto-populates from previous subscription.
 * @access Private (Vendors only - authenticated via JWT)
 */
HospitalityRoutes.post(
  '/renew-subscription',
  passportSignIn,
  hospitalityController.renewSubscription
);

/**
 * @route POST /api/v1/hospitality/verify-payment
 * @description Verify Razorpay payment with signature validation (replaces insecure test webhook).
 * @access Public — authenticated by the Razorpay HMAC-SHA256 signature, NOT
 * by JWT. The login flow uses this endpoint BEFORE the vendor has a token
 * (hospitality_pending renewal), so a passportSignIn middleware here would
 * 401 the call and re-break login. Security is preserved: only a caller
 * that completed a real Razorpay checkout can produce a valid
 * order_id|payment_id signature against our secret, and the endpoint
 * derives the target vendor from the matched tbl_vendor_payments row —
 * not from any caller-supplied identity. This matches how
 * /api/v1/users/razorpay-webhook is also exposed without JWT.
 */
HospitalityRoutes.post(
  '/verify-payment',
  hospitalityController.verifyPayment
);

// ============================================================
// WH-74: Vendor self-service subscription management
// ============================================================

/**
 * @route GET /api/v1/hospitality/vendor/subscription-summary
 * @description Rich subscription overview: status, active items (categories
 * with nested sub-categories, hotels), payment history, available actions.
 * @access Private (Vendors only - authenticated via JWT)
 */
HospitalityRoutes.get(
  '/vendor/subscription-summary',
  passportSignIn,
  hospitalityController.getVendorSubscriptionSummary
);

/**
 * @route POST /api/v1/hospitality/vendor/subscription/preview
 * @description Pure-read diff + cost calculator. Accepts target state and
 * returns added/removed items, pricing breakdown, and validation warnings.
 * @access Private (Vendors only - authenticated via JWT)
 */
HospitalityRoutes.post(
  '/vendor/subscription/preview',
  passportSignIn,
  hospitalityController.previewSubscriptionModification
);

/**
 * @route POST /api/v1/hospitality/vendor/subscription/modify
 * @description Apply subscription changes. Free path commits in a single tx;
 * paid path creates a Razorpay order whose metadata carries the diff.
 * @access Private (Vendors only - authenticated via JWT)
 */
HospitalityRoutes.post(
  '/vendor/subscription/modify',
  passportSignIn,
  hospitalityController.modifySubscription
);

/**
 * @route GET /api/v1/hospitality/vendor/subscription/payment-history
 * @description Paginated list of past payments with per-payment item breakdown.
 * @access Private (Vendors only - authenticated via JWT)
 */
HospitalityRoutes.get(
  '/vendor/subscription/payment-history',
  passportSignIn,
  hospitalityController.getVendorPaymentHistoryPaginated
);

/**
 * @route POST /api/v1/hospitality/vendor/subscription/extend
 * @description Extend active subscription by 1 financial year. Charges the
 * same category × hotels pricing for the next FY period.
 * @access Private (Vendors only - authenticated via JWT)
 */
HospitalityRoutes.post(
  '/vendor/subscription/extend',
  passportSignIn,
  hospitalityController.extendSubscription
);

/**
 * @route GET /api/v1/hospitality/vendor/subscription/download/:paymentId
 * @description On-demand download of Tax Invoice or Payment Receipt PDF
 * for a past payment. Query param: type=invoice|receipt
 * @access Private (Vendors only - authenticated via JWT)
 */
HospitalityRoutes.get(
  '/vendor/subscription/download/:paymentId',
  passportSignIn,
  hospitalityController.downloadPaymentDocument
);

export default HospitalityRoutes;


