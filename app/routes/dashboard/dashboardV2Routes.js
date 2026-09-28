import { Router } from 'express';
import passport from '../../middleware/passport.js';
import dashboardController from '../../controllers/dashboard/dashboardController.js';
import dashboardWidgetGuard from '../../middleware/dashboardWidgetGuard.js';

// Every /dashboard-v2 route is signed-in AND widget-guarded: once a buyer
// company runs the role-aware dashboard, each endpoint requires its
// dashboard.<code> grant (route → code map in dashboardWidgetGuard.js, which
// also lists the few routes every buyer may call). Folding the guard into the
// shared middleware means a newly added route cannot forget it — an unmapped
// route is refused while the company switch is on.
const passportSignIn = [passport.authenticate('jwtUsr', { session: false }), dashboardWidgetGuard];
const DashboardRoutes = Router();

// Which dashboard layout this buyer company runs, and who to contact for access.
DashboardRoutes.get('/config', passportSignIn, dashboardController.getConfig);

DashboardRoutes.get('/action-center', passportSignIn, dashboardController.getActionCenter);
// Single-call status banner shown at the top of /dashboard/buyer. Returns
// derived mode + counts + soonest closing RFQ + weekly stats.
DashboardRoutes.get('/buyer-status-banner', passportSignIn, dashboardController.getBuyerStatusBanner);
DashboardRoutes.get('/procurement-snapshot', passportSignIn, dashboardController.getProcurementSnapshot);
DashboardRoutes.get('/negotiation-savings', passportSignIn, dashboardController.getNegotiationSavings);
DashboardRoutes.get('/cost-intelligence', passportSignIn, dashboardController.getCostIntelligence);
DashboardRoutes.get('/category-insights', passportSignIn, dashboardController.getCategoryInsights);
DashboardRoutes.get('/abc-analysis', passportSignIn, dashboardController.getAbcAnalysis);
DashboardRoutes.get('/workflow-efficiency', passportSignIn, dashboardController.getWorkflowEfficiency);
DashboardRoutes.get('/smart-insights', passportSignIn, dashboardController.getSmartInsights);
DashboardRoutes.get('/pending-approvals', passportSignIn, dashboardController.getPendingApprovals);
DashboardRoutes.get('/rejected-pos', passportSignIn, dashboardController.getRejectedPOs);
DashboardRoutes.get('/no-response', passportSignIn, dashboardController.getNoResponse);

// ─── Role-aware buyer dashboard — persona widget endpoints ──────────
// Widget catalogue v1 — see docs/dashboard_v3/SPEC.md.

// RFQ Creator
DashboardRoutes.get('/my-drafts',                          passportSignIn, dashboardController.getMyDrafts);
DashboardRoutes.get('/my-active-rfqs',                     passportSignIn, dashboardController.getMyActiveRfqs);
DashboardRoutes.get('/my-no-response-rfqs',                passportSignIn, dashboardController.getMyNoResponseRfqs);
DashboardRoutes.get('/my-rfqs-bid-closed-no-quotes',       passportSignIn, dashboardController.getMyRfqsBidClosedNoQuotes);
// Technical Evaluator
DashboardRoutes.get('/my-tech-evals-pending',              passportSignIn, dashboardController.getMyTechEvalsPending);
DashboardRoutes.get('/tech-evals-with-disagreements',      passportSignIn, dashboardController.getTechEvalsWithDisagreements);
// Technical Approver
DashboardRoutes.get('/my-tech-approvals-pending',          passportSignIn, dashboardController.getMyTechApprovalsPending);
// RFQ approver
DashboardRoutes.get('/my-rfq-approvals-pending',           passportSignIn, dashboardController.getMyRfqApprovalsPending);
// Commercial Evaluator / N1
DashboardRoutes.get('/my-quote-compares',                  passportSignIn, dashboardController.getMyQuoteCompares);
DashboardRoutes.get('/my-active-negotiations',             passportSignIn, dashboardController.getMyActiveNegotiations);
DashboardRoutes.get('/savings-pipeline',                   passportSignIn, dashboardController.getSavingsPipeline);
// Commercial Approver
DashboardRoutes.get('/my-commercial-approvals-pending',    passportSignIn, dashboardController.getMyCommercialApprovalsPending);
// Awarding P1 / P2
DashboardRoutes.get('/my-award-approvals-pending',         passportSignIn, dashboardController.getMyAwardApprovalsPending);
DashboardRoutes.get('/recent-awards',                      passportSignIn, dashboardController.getRecentAwards);
DashboardRoutes.get('/award-value-pipeline',               passportSignIn, dashboardController.getAwardValuePipeline);
// Approvers — replaces the three throughput cards
DashboardRoutes.get('/approval-turnaround',                passportSignIn, dashboardController.getApprovalTurnaround);

export default DashboardRoutes;
