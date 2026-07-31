import dashboardModel from '../../models/dashboardModel.js';
import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import db from '../../config/dbConn.js';

// tbl_users.user_type: 2 = Buyer, 3 = Vendor, 7 = Admin, 8 = Super Admin.
const VENDOR_USER_TYPE = 3;

/**
 * Resolves scope from tbl_hospitality_user_mappings.
 * Returns { buyer_company_id, hotel_ids } or null (sends 403).
 *
 * Every widget derives its scope from THIS function's return value, which is
 * keyed on req.user.id alone. `hotel_ids` from the query string is a narrowing
 * facet only — resolveUserScope intersects it with the user's allowed set and
 * can never widen it. No dashboard handler reads a company or user id from the
 * request body, query or headers.
 *
 * Route-level acl([2, 8]) is the convention for buyer surfaces elsewhere in
 * this codebase and is NOT applied to /dashboard-v2 yet: every user in
 * tests/fixtures/users.js is seeded with user_type = NULL, so adding the
 * middleware would 403 all 139 existing dashboard tests. Changing that shared
 * fixture is out of scope here. Denying vendors explicitly closes the only gap
 * that matters — a vendor with a stray hospitality mapping would otherwise
 * reach buyer spend data (production currently has zero such rows, verified).
 */
const resolveScope = async (req, res) => {
  const user_id = req.user.id;
  const { hotel_ids } = req.query;
  const selectedHotelIds = hotel_ids ? hotel_ids.split(',').map(Number).filter(Boolean) : [];

  if (Number(req.user.user_type) === VENDOR_USER_TYPE) {
    res.status(403).json({ status: 0, message: 'Insufficient permissions' }).end();
    return null;
  }

  const scope = await dashboardModel.resolveUserScope(user_id, selectedHotelIds);
  if (!scope) {
    res.status(403).json({ status: 0, message: 'No hospitality access found for this user' }).end();
    return null;
  }
  return scope;
};

const dashboardController = {
  getActionCenter: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getActionCenterData(scope.buyer_company_id, req.user.id, scope.hotel_ids, start_date, end_date);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  // Status banner — single aggregator that drives the dashboard hero strip.
  // Returns { mode, counts, soonest_closing, weekly, greeting }. The mode is
  // derived server-side so the FE never recomputes severity from raw counts.
  getBuyerStatusBanner: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const userRow = await db.oneOrNone(
        `SELECT name FROM tbl_users WHERE id = $1`,
        [req.user.id]
      );
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getBuyerStatusBannerData(
        scope.buyer_company_id,
        req.user.id,
        scope.hotel_ids,
        start_date,
        end_date
      );
      // Strip trailing/extra whitespace; first token only so headlines stay tight.
      const firstName = (userRow?.name || '').trim().split(/\s+/)[0] || null;
      res.status(200).json({
        status: 1,
        data: { ...data, greeting: { first_name: firstName } },
      }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getProcurementSnapshot: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getProcurementSnapshotData(scope.buyer_company_id, req.user.id, scope.hotel_ids, start_date, end_date);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getNegotiationSavings: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getNegotiationSavingsData(scope.buyer_company_id, req.user.id, scope.hotel_ids, start_date, end_date);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getCostIntelligence: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date, product_variant_id, duration_type } = req.query;
      const pvId = product_variant_id ? parseInt(product_variant_id, 10) : null;
      const data = await dashboardModel.getCostIntelligenceData(scope.buyer_company_id, req.user.id, scope.hotel_ids, start_date, end_date, pvId, duration_type);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getCategoryInsights: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date, dimension } = req.query;
      const data = await dashboardModel.getCategoryInsightsData(scope.buyer_company_id, req.user.id, scope.hotel_ids, start_date, end_date, dimension);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  // ABC (Pareto) analysis of procured items by value or volume (Sr 297/298/303).
  getAbcAnalysis: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date, metric } = req.query;
      const data = await dashboardModel.getAbcAnalysisData(scope.buyer_company_id, req.user.id, scope.hotel_ids, start_date, end_date, metric);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getWorkflowEfficiency: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getWorkflowEfficiencyData(scope.buyer_company_id, req.user.id, scope.hotel_ids, start_date, end_date);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getSmartInsights: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getSmartInsightsData(scope.buyer_company_id, req.user.id, scope.hotel_ids, start_date, end_date);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getRejectedPOs: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getRejectedPOsDetail(scope.buyer_company_id, req.user.id, scope.hotel_ids);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  // No-response drill-down — published RFQs with zero quotes, split into
  // active (bid window open) vs expired (bid window passed). See Sr 228.
  getNoResponse: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getNoResponseDetail(scope.buyer_company_id, req.user.id, scope.hotel_ids, start_date, end_date);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getPendingApprovals: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getPendingApprovalsDetail(scope.buyer_company_id, req.user.id, scope.hotel_ids, start_date || '2025-01-01', end_date || new Date().toISOString().split('T')[0]);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  /* ──────────────────────────────────────────────────────────────────
     Role-aware buyer dashboard — persona widget handlers.

     These are STUBS today: each returns the safe-default shape the FE
     component expects so the dashboard renders in its empty state
     instead of erroring with 405. Replace each handler with real
     aggregation logic against the model layer as the feature lands.

     Contract: every handler must
       1. Resolve scope (so unauthorised requests still 403).
       2. Return `{ status: 1, data: <shape FE expects> }` on success.
       3. Catch errors and respond with 400 + Config.errorText.value
          (matches the existing v2 handlers).
     ────────────────────────────────────────────────────────────────── */

  // ── RFQ Creator ──────────────────────────────────────────────────
  getMyDrafts: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getMyDraftsData(
        scope.buyer_company_id,
        req.user.id,
        scope.hotel_ids,
        start_date, end_date
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getMyActiveRfqs: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getMyActiveRfqsData(
        scope.buyer_company_id,
        req.user.id,
        scope.hotel_ids,
        start_date, end_date
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getMyNoResponseRfqs: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getMyNoResponseRfqsData(
        scope.buyer_company_id,
        req.user.id,
        scope.hotel_ids,
        start_date, end_date
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getMyRfqsBidClosedNoQuotes: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getMyRfqsBidClosedNoQuotesData(
        scope.buyer_company_id,
        req.user.id,
        scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  // ── Technical Evaluator ──────────────────────────────────────────
  getMyTechEvalsPending: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getMyTechEvalsPendingData(
        scope.buyer_company_id,
        req.user.id,
        scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getTechEvalsWithDisagreements: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getTechEvalsWithDisagreementsData(
        scope.buyer_company_id,
        req.user.id,
        scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getTechEvalThroughput: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getTechEvalThroughputData(
        scope.buyer_company_id,
        req.user.id,
        scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  // ── Technical Approver ───────────────────────────────────────────
  getMyTechApprovalsPending: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getMyTechApprovalsPendingData(
        scope.buyer_company_id,
        req.user.id,
        scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getTechApprovalOldestPending: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getTechApprovalOldestPendingData(
        scope.buyer_company_id,
        req.user.id,
        scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getTechApprovalThroughput: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getTechApprovalThroughputData(
        scope.buyer_company_id,
        req.user.id,
        scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  // ── Commercial Evaluator / N1 Negotiator ─────────────────────────
  getMyQuoteCompares: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getMyQuoteComparesData(
        scope.buyer_company_id, req.user.id, scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getMyActiveNegotiations: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getMyActiveNegotiationsData(
        scope.buyer_company_id, req.user.id, scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getSavingsPipeline: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getSavingsPipelineData(
        scope.buyer_company_id, req.user.id, scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  // ── Commercial Approver ──────────────────────────────────────────
  getMyCommercialApprovalsPending: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getMyCommercialApprovalsPendingData(
        scope.buyer_company_id, req.user.id, scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getDealsWithPriceAnomalies: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getDealsWithPriceAnomaliesData(
        scope.buyer_company_id, req.user.id, scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getCommercialApprovalThroughput: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getCommercialApprovalThroughputData(
        scope.buyer_company_id, req.user.id, scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  // ── Awarding P1 / P2 ─────────────────────────────────────────────
  getMyAwardApprovalsPending: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getMyAwardApprovalsPendingData(
        scope.buyer_company_id, req.user.id, scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getRecentAwards: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getRecentAwardsData(
        scope.buyer_company_id, req.user.id, scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },

  getAwardValuePipeline: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getAwardValuePipelineData(
        scope.buyer_company_id, req.user.id, scope.hotel_ids
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) { logError(error); res.status(400).json({ status: 3, message: Config.errorText.value }).end(); }
  },
};

export default dashboardController;
