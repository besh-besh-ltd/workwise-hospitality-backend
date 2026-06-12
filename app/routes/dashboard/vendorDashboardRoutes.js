import { Router } from 'express';
import passport from '../../middleware/passport.js';
import vendorDashboardController from '../../controllers/dashboard/vendorDashboardController.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });
const VendorDashboardRoutes = Router();

VendorDashboardRoutes.get('/opportunities', passportSignIn, vendorDashboardController.getOpportunities);
VendorDashboardRoutes.get('/performance', passportSignIn, vendorDashboardController.getPerformance);
VendorDashboardRoutes.get('/insights', passportSignIn, vendorDashboardController.getInsights);
// Single-call status banner shown at the top of /dashboard/vendor.
VendorDashboardRoutes.get('/status-banner', passportSignIn, vendorDashboardController.getStatusBanner);

export default VendorDashboardRoutes;
