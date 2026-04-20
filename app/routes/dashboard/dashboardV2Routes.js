import { Router } from 'express';
import passport from '../../middleware/passport.js';
import dashboardController from '../../controllers/dashboard/dashboardController.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });
const DashboardRoutes = Router();

DashboardRoutes.get('/action-center', passportSignIn, dashboardController.getActionCenter);
DashboardRoutes.get('/procurement-snapshot', passportSignIn, dashboardController.getProcurementSnapshot);
DashboardRoutes.get('/negotiation-savings', passportSignIn, dashboardController.getNegotiationSavings);
DashboardRoutes.get('/cost-intelligence', passportSignIn, dashboardController.getCostIntelligence);
DashboardRoutes.get('/category-insights', passportSignIn, dashboardController.getCategoryInsights);
DashboardRoutes.get('/workflow-efficiency', passportSignIn, dashboardController.getWorkflowEfficiency);
DashboardRoutes.get('/smart-insights', passportSignIn, dashboardController.getSmartInsights);
DashboardRoutes.get('/pending-approvals', passportSignIn, dashboardController.getPendingApprovals);
DashboardRoutes.get('/rejected-pos', passportSignIn, dashboardController.getRejectedPOs);

export default DashboardRoutes;
