import { Router } from 'express';
import UsersController from '../../controllers/users/usersController.js';
import vendorController from '../../controllers/admin/vendorController.js';
import noLogin from '../../middleware/noLogin.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/userValidation.js';
import { validateDbBody } from '../../validations/dbValidation/userDbValidation.js';
import { acl } from '../../helper/common.js';
import passport from '../../middleware/passport.js';
import { projectSchemas } from '../../validations/paramValidation/projectValidation.js';

// const passportLogIn = passport.authenticate("jwtAdm", { session: false });

const passportLogIn = passport.authenticate('localUsr', { session: false });
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const UsersRoutes = Router();


UsersRoutes.post(
  '/book-demo',
  UsersController.userBookDemo
);


// use to create dufferent type of buyer company users,
// like procurment, management, finance, engineering
UsersRoutes.post(
  '/create-buyer-company-user',
  passportSignIn,
  validateDbBody.user_exists,
  UsersController.create_buyer_company_users
);


/**
 * mukul 09-06-2025
 * to update conpany details and head office location
 * API' is only accessabel for company admin
 * this api can be use for admin side as well
 * */
UsersRoutes.put(
  '/update-company-detail',
  passportSignIn,
  acl([3, 7]),
  validateBody(schemas.company_profile),
  UsersController.update_company_detail
);

UsersRoutes.get(
  '/company-users',
  passportSignIn,
  UsersController.get_company_users
);

UsersRoutes.post(
  '/user-registration',
  validateBody(schemas.user_register),
  validateDbBody.user_exists,
  UsersController.user_registration
);
UsersRoutes.post(
  '/company-registration',
  validateBody(schemas.company_registration),
  validateDbBody.user_exists,
  UsersController.company_registration
);
UsersRoutes.post(
  '/notifications/subscribe',

  UsersController.subscribe
);
UsersRoutes.get(
  '/notifications/notification-list',
  passportSignIn,
  UsersController.notificationList
);
UsersRoutes.get(
  '/notifications/notification-detail/:notification_id',
  passportSignIn,
  UsersController.notificationDetail
);
UsersRoutes.post(
  '/notifications/read-notification/:notification_id',
  passportSignIn,
  UsersController.readNotification
);
UsersRoutes.post(
  '/login',
  passportLogIn,
  validateBody(schemas.user_login),
  UsersController.user_login
);
UsersRoutes.post(
  '/refresh-token',
  passportSignIn,
  validateDbBody.user_id_exists,
  UsersController.refresh_token
);
UsersRoutes.post(
  '/registration-otp-send',
  validateBody(schemas.registration_otp_send),
  UsersController.sendRegistrationOTP
);
UsersRoutes.post(
  '/registration-otp-verify',
  validateBody(schemas.registration_otp_verify),
  UsersController.verifyRegistrationOTP
);
UsersRoutes.post(
  '/forgot-password-otp-send',
  validateDbBody.user_email_exists,
  UsersController.forgot_passw_otp_send
);
UsersRoutes.post(
  '/forgot-password-otp-authenticate',
  validateDbBody.forgot_otp_exists,
  validateBody(schemas.otp_user),
  UsersController.forgot_password_otp_authenticate
);

UsersRoutes.put(
  '/update-user-detail',
  // schema_posts.add_user_profile_image,
  passportSignIn,
  validateBody(schemas.update_profile),
  validateDbBody.user_id_exists,
  UsersController.update_user_detail
);
UsersRoutes.post(
  '/update-profile-image',
  passportSignIn,
  schema_posts.add_user_profile_image,
  UsersController.update_profile_image
);
UsersRoutes.get(
  '/get-profile',
  noLogin.customer_auth,
  UsersController.get_profile
);
UsersRoutes.get(
  '/get-profile-documents',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  UsersController.get_profile_documents
);


/**
 * @creared_by - mukul 10-06-2025
 * @last_changes_by - mukul 10-06-2025
 * @acces - only buyer comany admin
 * @return -  total purchased accounts limit and acount of active accounts
 */
UsersRoutes.get(
  '/buyer-account-limits',
  passportSignIn,
    acl([7]),
  UsersController.getBuyerAccountLimits
);
UsersRoutes.post(
  '/change-password',
  passportSignIn,
  validateBody(schemas.change_password),
  UsersController.change_password
);
UsersRoutes.post(
  '/social-login',
  validateBody(schemas.social_login),
  // validateDbBody.user_exists,
  UsersController.social_login
);
UsersRoutes.get(
  '/vendorapprove-list',
  // passportSignIn,
  UsersController.vendorapprove_list
);

// this needs to be change in future.....
// in no authorization token we are takng the token from the query
// for getting the user_id of the user when it is valid then only 
// we upload the file.
UsersRoutes.post(
  '/upload-file',
  noLogin.customer_auth,
  schema_posts.upload_user_document,
  UsersController.upload_documents
);


UsersRoutes.post
(
  '/enhance-vendor-profile',
  passportSignIn,
  acl([1,3]),
  schema_posts.upload_vendor_document,
  UsersController.enhance_vendor_profile
  // validateBody(schemas.enhance_vendor_profile),
  // UsersController.enhance_vendor_profile
);
UsersRoutes.post(
  '/upload-payment-terms',
  passportSignIn,
  acl([1,3]),
  UsersController.upload_payment_terms
)

UsersRoutes.get(
  '/get-vendor-payment-terms',
  noLogin.customer_auth,
 UsersController.get_payment_terms
)

UsersRoutes.get
(
  '/get-vendor-profile-documents',
  passportSignIn,
  acl([3]),
  UsersController.get_vendor_profile_documents
);

UsersRoutes.get(
  '/get-vendor-profile-reviews',
  passportSignIn,
  UsersController.get_vendor_profile_reviews
)

UsersRoutes.post(
  '/publish-profile-reviews',
  passportSignIn,
  UsersController.publish_profile_reviews
)
UsersRoutes.get(
  '/vendor-profile/:vendor_id',
  noLogin.customer_auth,
  UsersController.vendor_profile
);
UsersRoutes.post(
  '/coupon-check',
  passportSignIn,
  acl([2, 3, 4]),
  validateBody(schemas.coupon_check),
  validateDbBody.subscription_and_coupon_id_exists,
  UsersController.subscriptionDetails
);

UsersRoutes.post(
  '/subscription-payment',
  passportSignIn,
  acl([2, 3, 4]),
  validateBody(schemas.subscription_payment),
  validateDbBody.subscription_and_coupon_id_exists,
  UsersController.subscriptionPayment
);
UsersRoutes.post('/razorpay-webhook', UsersController.razorpay_webhook);
UsersRoutes.post('/test-razorpay-webhook', UsersController.test_razorpay_webhook);
UsersRoutes.post(
  '/create-vendor-review',
  passportSignIn,
  validateBody(schemas.vendor_review),
  validateDbBody.review_validate,
  UsersController.createVendorReview
);

UsersRoutes.get(
  '/vendor-review-list',
  passportSignIn,
  UsersController.vendorreview_list
);

// mukul 07-06-2025 ,  not in use, cross check and remove
UsersRoutes.post(
  '/communication-settings',
  passportSignIn,
  UsersController.communicationSettings
);

// mukul 07-06-2025 ,  not in use, cross check and remove
UsersRoutes.get(
  '/communication-settings',
  passportSignIn,
  UsersController.getCommunicationSettings
);

// mukul 07-06-2025 ,  not in use, cross check and remove
UsersRoutes.get(
  '/communication-settings-list',
  UsersController.communicationSettingsList
);

UsersRoutes.post(
  '/buyer-private-vendor',
  passportSignIn,
  acl([2,8]),
  validateBody(schemas.buyer_private_vendor_approved),
  // validateDbBody.vendor_exist,
  // UsersController.addPrivateVendor
  UsersController.addApprovedPrivateVendor
);

UsersRoutes.get(
  '/buyer-private-vendor',
  passportSignIn,
  UsersController.getBuyerPrivateVendors
);

// mukul 07-06-2025 ,  not in use, cross check and remove
UsersRoutes.post(
  '/buyer-excel-add-vendor',
  passportSignIn,
  acl([2, 8]),
  schema_posts.buyerExcelUploadVendorFileHandler, 
  UsersController.buyerExcelUploadVendor,
)

// to add spoc of any user
UsersRoutes.post(
  '/add-spoc',
  passportSignIn,
  validateBody(schemas.user_spoc),
  (req, res, next) => {
    // Set vendor ID parameter for vendor controller
    req.params.id = req.body.vendor_id || req.user.id;
    next();
  },
  vendorController.addSpoc
)

// to update the spoc of the user
UsersRoutes.put(
  '/update-spoc/:spoc_id',
  passportSignIn,
  validateBody(schemas.user_spoc),
  validateDbBody.spoc_id_exists,
  (req, res, next) => {
    // Set vendor ID parameter for vendor controller
    req.params.id = req.user.id;
    next();
  },
  vendorController.updateSpoc
)
// to delete the spoc of the user
UsersRoutes.delete(
  '/delete-spoc/:spoc_id',
  passportSignIn,
  validateDbBody.spoc_id_exists,
  (req, res, next) => {
    // Set vendor ID parameter for vendor controller
    req.params.id = req.user.id;
    next();
  },
  vendorController.deleteSpoc
)

UsersRoutes.get(
  '/vendor-dashboard-data',
  passportSignIn,
  UsersController.vendorDashboardData
);

// Dashboard Routes
UsersRoutes.post(
  '/get-dashboard-data',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  validateBody(projectSchemas.get_buyer_body_validation),
  UsersController.getDashboardData
);

UsersRoutes.get(
  '/get-dashboard-Analytics',
  passportSignIn,
  validateDbBody.user_id_profileexists,
  UsersController.getDashboardAnalytics
);

UsersRoutes.get(
  '/dashboard-top-vendors-and-products',
  passportSignIn,
  UsersController.getTopVendorsandProducts
)

UsersRoutes.get(
  '/dashboard-finalized-vendors',
  passportSignIn,
  UsersController.getFinalizedVendors
)

UsersRoutes.get(
  '/dashboard-finalized-products',
  passportSignIn,
  UsersController.getFinalizedProducts
)

UsersRoutes.post(
  '/dashboard-search-vendor',
  passportSignIn,
  UsersController.searchVendorsByName
)


export default UsersRoutes;
