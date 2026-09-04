import { Router } from 'express';
import authController from '../../controllers/admin/authController.js';
import passport from '../../middleware/passport.js';
import handle_auth from '../../helper/handleAuth.js';
import {
  validateBody,
  adminAuthSchemas
} from '../../validations/paramValidation/adminAuthValidation.js';

const passportLogIn = passport.authenticate('localAdm', { session: false });
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const authRoutes = Router();

authRoutes.post('/login', passportLogIn, authController.login);
authRoutes.get('/admin-profile', passportSignIn, authController.adminProfile);

authRoutes.post(
  '/change-password',
  passportSignIn,
  validateBody(adminAuthSchemas.change_password),
  authController.changePassword
);

// Unauthenticated by necessity — the caller is locked out. Both handlers are
// written to give away nothing about which addresses exist.
authRoutes.post(
  '/forgot-password',
  validateBody(adminAuthSchemas.forgot_password),
  authController.forgotPassword
);
authRoutes.post(
  '/reset-password',
  validateBody(adminAuthSchemas.reset_password),
  authController.resetPassword
);

export default authRoutes;
