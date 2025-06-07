import { Router } from 'express';
import noLogin from '../../middleware/noLogin.js';
import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtUsr', { session: false });
import portalTourController from '../../controllers/portalTour/portalTourController.js';

// mukul 07-06-2025 ,  not in use but functional, these api's is for portal tour, backend isready for this functionlity need to create frontend

const portalTourRoutes = Router();

// get tour coontent by page id
portalTourRoutes.get('/content/:id',
    passportSignIn,
    portalTourController.getPageTourContent
);

// get user tour progress by page id
portalTourRoutes.get('/user-tour-progress/:id',
    passportSignIn,
    portalTourController.getUserTourProgrs
);

// upload user tour progress
portalTourRoutes.post('/upload-tour-progress',
    passportSignIn,
    portalTourController.uploadUserTourProgress
);

// update user tour progress
portalTourRoutes.patch('/update-tour-progress',
    passportSignIn,
    portalTourController.updateUserTourProgress
);

export default portalTourRoutes;
