// ============================================================================
// dashboardWidgetGuard.js
// ----------------------------------------------------------------------------
// Server-side enforcement of buyer-dashboard widget grants (SPEC "Access &
// rollout").
//
// Before this, /dashboard-v2 checked only the JWT and the caller's hotel scope:
// the frontend hid widgets a role was not granted, but any buyer could call a
// widget endpoint directly and read its aggregates. Hiding a card is not
// access control.
//
//   company switch OFF (tbl_company.buyer_dashboard_v3 = false)
//       → pass. The legacy layout shows its cards to every mapped buyer and
//         never had grants; gating it would blank the live dashboard.
//   company switch ON
//       → the route's widget code must be granted to the caller, in the
//         business units in view, through tbl_user_role_scopes. Union semantics
//         are those of the frontend's widget list
//         (rbacModel.getUserPermissionsForHotels): a grant at any selected BU,
//         or at the company level, counts.
//
// The BU set is the same one the widget's data is scoped to
// (dashboardModel.resolveUserScope): hotel_ids narrows the caller's own
// mappings and can never reach another tenant's hotel. The resolved scope is
// left on the request so the controller does not resolve it twice.
//
// Deliberately not can(): it resolves permissions through x-company-id /
// x-hotel-id headers, which are client-controlled.
// ============================================================================

import dashboardModel from '../models/dashboardModel.js';
import rbacModel from '../models/rbacModel.js';
import { isV3Enabled } from '../models/dashboard/dashboardConfigModel.js';
import { logger } from '../util/logger.js';

const VENDOR_USER_TYPE = 3;
const SUPER_ADMIN_USER_TYPE = 8;

/**
 * Route path → the widget permission (dashboard.<code>) that guards it.
 * Drill-down lists belong to the Action Centre that opens them.
 * A route that is neither here nor in UNGUARDED_ROUTES is refused while the
 * company switch is on — a new endpoint must be mapped before it is reachable.
 */
export const WIDGET_ROUTE_CODES = Object.freeze({
  // Cross-role
  '/action-center': 'action_center',
  '/pending-approvals': 'action_center',
  '/rejected-pos': 'action_center',
  '/no-response': 'action_center',
  '/procurement-snapshot': 'procurement_snapshot',
  '/negotiation-savings': 'negotiation_savings',
  '/cost-intelligence': 'cost_intelligence',
  '/category-insights': 'category_insights',
  '/abc-analysis': 'abc_analysis',
  '/workflow-efficiency': 'workflow_efficiency',
  '/smart-insights': 'smart_insights',
  // RFQ creator
  '/my-drafts': 'my_drafts',
  '/my-active-rfqs': 'my_active_rfqs',
  '/my-no-response-rfqs': 'my_no_response_rfqs',
  '/my-rfqs-bid-closed-no-quotes': 'my_rfqs_bid_closed_no_quotes',
  // Technical evaluator / approver
  '/my-tech-evals-pending': 'my_tech_evals_pending',
  '/tech-evals-with-disagreements': 'tech_evals_with_vendor_disagreements',
  '/my-tech-approvals-pending': 'my_tech_approvals_pending',
  // Commercial evaluator / approver
  '/my-quote-compares': 'my_quote_compares',
  '/my-active-negotiations': 'my_active_negotiations',
  '/savings-pipeline': 'savings_pipeline',
  '/my-commercial-approvals-pending': 'my_commercial_approvals_pending',
  // Awarding (POs)
  '/my-award-approvals-pending': 'my_award_approvals_pending',
  '/recent-awards': 'recent_awards',
  '/award-value-pipeline': 'award_value_pipeline',
  // RFQ approver / any approver
  '/my-rfq-approvals-pending': 'my_rfq_approvals_pending',
  '/approval-turnaround': 'approval_turnaround',
});

/** Shown to every buyer regardless of widget grants. */
export const UNGUARDED_ROUTES = Object.freeze(new Set(['/config', '/buyer-status-banner']));

const deny = (res) =>
  res.status(403).json({
    status: 0,
    message: "This dashboard widget isn't enabled for your role — ask your administrator to grant it.",
  }).end();

export async function dashboardWidgetGuard(req, res, next) {
  try {
    const routePath = req.route?.path || req.path;
    if (UNGUARDED_ROUTES.has(routePath)) return next();

    const user = req.user;
    // Unauthenticated requests never reach here (the JWT check runs first);
    // vendors are refused by the controller with its own message.
    if (!user || Number(user.user_type) === VENDOR_USER_TYPE) return next();
    if (Number(user.user_type) === SUPER_ADMIN_USER_TYPE) return next();

    const selectedHotelIds = req.query.hotel_ids
      ? String(req.query.hotel_ids).split(',').map(Number).filter(Boolean)
      : [];
    const scope = await dashboardModel.resolveUserScope(user.id, selectedHotelIds, user);
    // No hospitality access at all: the controller answers 403 itself.
    if (!scope) return next();
    req.dashboardScope = { key: selectedHotelIds.join(','), scope };

    if (!(await isV3Enabled(scope.buyer_company_id))) return next();

    const code = WIDGET_ROUTE_CODES[routePath];
    if (!code) return deny(res);

    const hotelIds = scope.hotel_ids || [];
    if (hotelIds.length === 0) return deny(res);
    const rows = await rbacModel.getUserPermissionsForHotels(user.id, hotelIds, 'dashboard');
    if (rows.some((r) => String(r.action) === code)) return next();
    return deny(res);
  } catch (err) {
    logger.error({ err }, '[dashboardWidgetGuard]');
    return res.status(500).json({ status: 3, message: 'Internal error' }).end();
  }
}

export default dashboardWidgetGuard;
