import { Router } from 'express';
import noLogin from '../../middleware/noLogin.js';
import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtUsr', { session: false });
import portalTourController from '../../controllers/portalTour/portalTourController.js';

const portalTourRoutes = Router();

portalTourRoutes.get('/content/:id',
    passportSignIn,
    portalTourController.getPageTourContent
);

export default portalTourRoutes;
