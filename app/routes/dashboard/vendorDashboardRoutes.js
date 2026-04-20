import { Router } from 'express';
import passport from '../../middleware/passport.js';
import vendorDashboardController from '../../controllers/dashboard/vendorDashboardController.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });
const VendorDashboardRoutes = Router();

VendorDashboardRoutes.get('/opportunities', passportSignIn, vendorDashboardController.getOpportunities);
VendorDashboardRoutes.get('/performance', passportSignIn, vendorDashboardController.getPerformance);
VendorDashboardRoutes.get('/insights', passportSignIn, vendorDashboardController.getInsights);

export default VendorDashboardRoutes;
