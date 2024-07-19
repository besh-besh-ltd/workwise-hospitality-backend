import { Router } from 'express';
import authController from '../../controllers/admin/authController.js';
import passport from '../../middleware/passport.js';
import handle_auth from '../../helper/handleAuth.js';

const passportLogIn = passport.authenticate('localAdm', { session: false });
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const authRoutes = Router();

authRoutes.post('/login', passportLogIn, authController.login);
authRoutes.get('/admin-profile', passportSignIn, authController.adminProfile);

export default authRoutes;
