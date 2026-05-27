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

// ─── Role-aware buyer dashboard — persona widget endpoints ──────────
// Stub responses today (safe-default shapes the FE renders via its
// EmptyState path). Replace each handler with real aggregation logic
// as the corresponding widget is productionised. See controller.

// RFQ Creator
DashboardRoutes.get('/my-drafts',                          passportSignIn, dashboardController.getMyDrafts);
DashboardRoutes.get('/my-active-rfqs',                     passportSignIn, dashboardController.getMyActiveRfqs);
DashboardRoutes.get('/my-no-response-rfqs',                passportSignIn, dashboardController.getMyNoResponseRfqs);
DashboardRoutes.get('/my-rfqs-bid-closed-no-quotes',       passportSignIn, dashboardController.getMyRfqsBidClosedNoQuotes);
// Technical Evaluator
DashboardRoutes.get('/my-tech-evals-pending',              passportSignIn, dashboardController.getMyTechEvalsPending);
DashboardRoutes.get('/tech-evals-with-disagreements',      passportSignIn, dashboardController.getTechEvalsWithDisagreements);
DashboardRoutes.get('/tech-eval-throughput',               passportSignIn, dashboardController.getTechEvalThroughput);
// Technical Approver
DashboardRoutes.get('/my-tech-approvals-pending',          passportSignIn, dashboardController.getMyTechApprovalsPending);
DashboardRoutes.get('/tech-approval-oldest-pending',       passportSignIn, dashboardController.getTechApprovalOldestPending);
DashboardRoutes.get('/tech-approval-throughput',           passportSignIn, dashboardController.getTechApprovalThroughput);
// Commercial Evaluator / N1
DashboardRoutes.get('/my-quote-compares',                  passportSignIn, dashboardController.getMyQuoteCompares);
DashboardRoutes.get('/my-active-negotiations',             passportSignIn, dashboardController.getMyActiveNegotiations);
DashboardRoutes.get('/savings-pipeline',                   passportSignIn, dashboardController.getSavingsPipeline);
// Commercial Approver
DashboardRoutes.get('/my-commercial-approvals-pending',    passportSignIn, dashboardController.getMyCommercialApprovalsPending);
DashboardRoutes.get('/deals-with-price-anomalies',         passportSignIn, dashboardController.getDealsWithPriceAnomalies);
DashboardRoutes.get('/commercial-approval-throughput',     passportSignIn, dashboardController.getCommercialApprovalThroughput);
// Awarding P1 / P2
DashboardRoutes.get('/my-award-approvals-pending',         passportSignIn, dashboardController.getMyAwardApprovalsPending);
DashboardRoutes.get('/recent-awards',                      passportSignIn, dashboardController.getRecentAwards);
DashboardRoutes.get('/award-value-pipeline',               passportSignIn, dashboardController.getAwardValuePipeline);

export default DashboardRoutes;
