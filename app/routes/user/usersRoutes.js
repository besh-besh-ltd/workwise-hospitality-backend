import { Router } from 'express';
import UsersController from '../../controllers/users/usersController.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/userValidation.js';
import { validateDbBody } from '../../validations/dbValidation/userDbValidation.js';
import { acl } from '../../helper/common.js';
import passport from '../../middleware/passport.js';
import handle_auth from '../../helper/handleAuth.js';

// const passportLogIn = passport.authenticate("jwtAdm", { session: false });

const passportLogIn = passport.authenticate('localUsr', { session: false });
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const UsersRoutes = Router();

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
  passportSignIn,
  validateDbBody.user_id_profileexists,
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
UsersRoutes.post(
  '/upload-file',
  passportSignIn,
  schema_posts.upload_user_document,
  UsersController.upload_documents
);
UsersRoutes.get(
  '/vendor-profile/:vendor_id',
  passportSignIn,
  validateDbBody.user_id_profileexists,
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

UsersRoutes.get(
  '/vendor-dashboard-data',
  passportSignIn,
  UsersController.vendorDashboardData
);


UsersRoutes.get(
  '/get-dashboard-data',
  passportSignIn,
  UsersController.getDashboardData
);

//End API

export default UsersRoutes;
