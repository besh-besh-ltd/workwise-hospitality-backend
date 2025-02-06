import { Router } from 'express';
import UsersController from '../../controllers/users/usersController.js';
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

UsersRoutes.post(
  '/user-registration',
  validateBody(schemas.user_register),
  validateDbBody.user_exists,
  UsersController.user_registration
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
// Endpoint for uploading the file without authentication
// This can be dangerous but let's see in future .
// UsersRoutes.post(
//   '/upload-file-without-auth',
//   noLogin.customer_auth,
//   schema_posts.upload_document_without_auth,
//   UsersController.upload_document_without_auth
// );
UsersRoutes.get(
  '/vendor-profile/:vendor_id',
  noLogin.customer_auth,
  UsersController.vendor_profile
);
UsersRoutes.post(
  '/buyer-coupon-check',
  passportSignIn,
  acl([2, 4]),
  validateBody(schemas.buyer_coupon_check),
  validateDbBody.buyer_subscription_and_coupon_id_exists,
  UsersController.buyerSubscriptionDetails
);
UsersRoutes.post(
  '/buyer-subscription-payment',
  passportSignIn,
  acl([2, 4]),
  validateBody(schemas.buyer_subscription_payment),
  validateDbBody.buyer_subscription_id_exists,
  UsersController.buyerSubscriptionPayment
);
UsersRoutes.post('/razorpay-webhook', UsersController.razorpay_webhook);
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

UsersRoutes.post(
  '/communication-settings',
  passportSignIn,
  UsersController.communicationSettings
);
UsersRoutes.get(
  '/communication-settings',
  passportSignIn,
  UsersController.getCommunicationSettings
);

UsersRoutes.get(
  '/communication-settings-list',
  UsersController.communicationSettingsList
);

UsersRoutes.post(
  '/buyer-private-vendor',
  passportSignIn,
  acl([2]),
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

// to add vendor in bulk using excel
UsersRoutes.post(
  '/buyer-excel-add-vendor',
  passportSignIn,
  acl([2]),
  schema_posts.buyerExcelUploadVendorFileHandler, 
  UsersController.buyerExcelUploadVendor,
)

// to add spoc of any user
UsersRoutes.post(
  '/add-spoc',
  passportSignIn,
  validateBody(schemas.user_spoc),
  UsersController.addSpoc
)

// to update the spoc of the user
UsersRoutes.put(
  '/update-spoc/:spoc_id',
  passportSignIn,
  validateBody(schemas.user_spoc),
  validateDbBody.spoc_id_exists,
  UsersController.updateSpoc
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
