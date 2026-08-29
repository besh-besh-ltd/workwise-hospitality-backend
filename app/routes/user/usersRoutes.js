import { Router } from 'express';
import UsersController from '../../controllers/users/usersController.js';
import userNotificationController from '../../controllers/users/userNotificationController.js';
import vendorController from '../../controllers/admin/vendorController.js';
import noLogin from '../../middleware/noLogin.js';
import db from '../../config/dbConn.js';
import jwtHelper from '../../helper/jwtHelper.js';
import Cryptr from 'cryptr';
import Config from '../../config/app.config.js';
const guestCryptr = new Cryptr(Config.cryptR.secret);
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts,
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

// Verify a vendor email-link token and return a short-lived JWT
// so the vendor gets a normal session without manual login.
UsersRoutes.post('/verify-vendor-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ status: 0, message: 'Token is required' });
    }

    const tokenData = await db.oneOrNone(
      'SELECT vendor_id FROM tbl_vendor_rfq_tokens_non_login WHERE token = $1',
      [token]
    );
    if (!tokenData) {
      return res.status(400).json({ status: 0, message: 'Invalid or expired token' });
    }

    const user = await db.oneOrNone(
      'SELECT id, name, email, user_type, company_id, status FROM tbl_users WHERE id = $1',
      [tokenData.vendor_id]
    );
    if (!user) {
      return res.status(404).json({ status: 0, message: 'Vendor not found' });
    }

    // Store the request's User-Agent in DB so passport jwtUsr strategy
    // can verify it against the encrypted ag claim in the JWT.
    const userAgent = req.get('User-Agent') || 'guest-access';
    await db.none(
      'UPDATE tbl_users SET user_agent = $1 WHERE id = $2',
      [userAgent, user.id]
    );

    // Build JWT matching the exact format that signAccessTokenUser produces
    // and that the jwtUsr passport strategy expects:
    // - sub: encrypted user id
    // - ag: encrypted user agent
    // - user: true
    const expirySeconds = 30 * 60; // 30 minutes
    const jwt = jwtHelper.signGuestAccessToken(
      {
        user_id: guestCryptr.encrypt(String(user.id)),
        name: user.name,
        user_agent: guestCryptr.encrypt(userAgent),
      },
      expirySeconds
    );

    return res.json({
      status: 1,
      data: {
        token: jwt,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          user_type: user.user_type,
          company_id: user.company_id,
        },
        expires_in: expirySeconds,
        is_guest: true,
      },
    });
  } catch (error) {
    console.error('verify-vendor-token error:', error);
    return res.status(500).json({ status: 3, message: 'Failed to verify token' });
  }
});

// use to create dufferent type of buyer company users,
// like procurment, management, finance, engineering
//
// ACL GATE (was missing): this endpoint creates a user IN THE CALLER'S OWN
// COMPANY and can assign it arbitrary role scopes, department memberships,
// and hospitality company/hotel mappings — the same authority surface as
// update-user-detail (gated `user_type === 7` in the controller) and every
// hospitality company-admin route in hospitalityRoutes.js (all `acl([7])`).
// Previously any authenticated user of any user_type could reach it and
// grant role scopes to a brand-new account. acl([7]) matches the existing
// sibling admin endpoint /company-users-detailed below and the isAdmin check
// in update_user_detail — company admin only.
UsersRoutes.post(
  '/create-buyer-company-user',
  passportSignIn,
  acl([7]),
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

UsersRoutes.get(
  '/company-users-detailed',
  passportSignIn,
  acl([7]),
  UsersController.get_company_users_detailed
);

// Is this email or mobile already taken? (UM-1) Admin-only, because it answers
// a question about accounts that exist.
UsersRoutes.get(
  '/check-identity',
  passportSignIn,
  acl([7]),
  UsersController.check_identity
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
  '/registration-upload',
  schema_posts.upload_vendor_document,
  UsersController.registration_upload
);
UsersRoutes.post(
  '/notifications/subscribe',

  UsersController.subscribe
);

// New push + bell endpoints (multi-device, recipient-based)
UsersRoutes.get(
  '/notifications/vapid-public-key',
  userNotificationController.vapidPublicKey
);
UsersRoutes.post(
  '/notifications/push-subscribe',
  passportSignIn,
  userNotificationController.pushSubscribe
);
UsersRoutes.delete(
  '/notifications/push-subscribe',
  passportSignIn,
  userNotificationController.pushUnsubscribe
);
UsersRoutes.get(
  '/notifications/list',
  passportSignIn,
  userNotificationController.list
);
UsersRoutes.get(
  '/notifications/unread-count',
  passportSignIn,
  userNotificationController.unreadCount
);
UsersRoutes.get(
  '/notifications/categories',
  passportSignIn,
  userNotificationController.categories
);
UsersRoutes.post(
  '/notifications/mark-delivered',
  passportSignIn,
  userNotificationController.markDelivered
);
UsersRoutes.post(
  '/notifications/dismiss/:id',
  passportSignIn,
  userNotificationController.dismiss
);
UsersRoutes.post(
  '/notifications/mark-unread/:id',
  passportSignIn,
  userNotificationController.markUnread
);
UsersRoutes.post(
  '/notifications/mark-read/:id',
  passportSignIn,
  userNotificationController.markRead
);
UsersRoutes.post(
  '/notifications/mark-all-read',
  passportSignIn,
  userNotificationController.markAllRead
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
  (req, res, next) => {
    // If employee_code is provided without email, set a placeholder
    // so passport-local doesn't reject with "Missing credentials"
    if (req.body.employee_code && !req.body.email) {
      req.body._loginViaEmployeeCode = true;
      req.body.email = req.body.employee_code;
    }
    next();
  },
  passportLogIn,
  (req, res, next) => {
    // Restore original body before Joi validation
    if (req.body._loginViaEmployeeCode) {
      delete req.body.email;
      delete req.body._loginViaEmployeeCode;
    }
    next();
  },
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
  noLogin.vendorTokenOrJwt,
  UsersController.get_profile
);
UsersRoutes.get(
  '/me/departments',
  passportSignIn,
  UsersController.get_my_departments
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
  noLogin.vendorTokenOrJwt,
  schema_posts.upload_user_document,
  UsersController.upload_documents
);

UsersRoutes.post(
  '/delete-file',
  noLogin.vendorTokenOrJwt,
  UsersController.delete_files
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
UsersRoutes.get(
  '/vendor-profile/:vendor_id/engagement',
  noLogin.customer_auth,
  UsersController.vendor_engagement
);
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
  '/add-buyer-vendor-location',
  passportSignIn,
  // acl([2,8,3]),
  vendorController.addVendorLocation //utilising same controller as defined in admin routes.
);

UsersRoutes.get(
  '/get-buyer-vendor-location/:id',
  passportSignIn,
  vendorController.getVendorLocations
)
UsersRoutes.delete(
  '/delete-buyer-vendor-location/:id',
  passportSignIn, 
  // acl([2,8,3]),
  vendorController.deleteVendorLocation   //utilising same controller as defined in admin routes.
)
UsersRoutes.post(
  '/map-spoc-location',
  passportSignIn,
  // acl([2,8,3]),
  vendorController.mapSpocToLocation 
)

UsersRoutes.put(
  '/update-buyer-vendor-location',
  passportSignIn,
  // acl([2,8,3]),
  vendorController.updateVendorLocation //utilising same controller as defined in admin routes.
)

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
