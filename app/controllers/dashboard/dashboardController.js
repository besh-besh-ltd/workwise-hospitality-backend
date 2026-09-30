import dashboardModel from '../../models/dashboardModel.js';
import dashboardConfigModel from '../../models/dashboard/dashboardConfigModel.js';
import { normalizeDate } from '../../models/dashboard/dashboardMetrics.js';
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

  // The widget guard has usually resolved this already (same user, same
  // hotel_ids); reuse it rather than re-running the mapping queries.
  const cached = req.dashboardScope;
  const scope = cached && cached.key === selectedHotelIds.join(',')
    ? cached.scope
    : await dashboardModel.resolveUserScope(user_id, selectedHotelIds);
  if (!scope) {
    res.status(403).json({ status: 0, message: 'No hospitality access found for this user' }).end();
    return null;
  }
  // The window is an IST calendar-day range. Anything that is not a real
  // YYYY-MM-DD becomes "no bound" rather than a 500; an inverted pair is
  // swapped. Models never read req.query dates directly.
  let start_date = normalizeDate(req.query.start_date);
  let end_date = normalizeDate(req.query.end_date);
  if (start_date && end_date && start_date > end_date) [start_date, end_date] = [end_date, start_date];
  return { ...scope, start_date, end_date };
};

/** Wrap a persona model call: scope first, uniform envelope and error path. */
const personaHandler = (load) => async (req, res) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    const data = await load(scope, req);
    res.status(200).json({ status: 1, data }).end();
  } catch (error) {
    logError(error);
    res.status(400).json({ status: 3, message: Config.errorText.value }).end();
  }
};

const dashboardController = {
  // Which dashboard layout the caller's buyer company runs (SPEC D5), read at
  // request time so a company can be switched on — or back off — without a
  // deploy. A buyer with no hospitality access gets the legacy layout, whose
  // own widgets then explain the missing access.
  getConfig: async (req, res) => {
    try {
      if (Number(req.user.user_type) === VENDOR_USER_TYPE) {
        return res.status(403).json({ status: 0, message: 'Insufficient permissions' }).end();
      }
      const scope = await dashboardModel.resolveUserScope(req.user.id, []);
      const v3_enabled = scope ? await dashboardConfigModel.isV3Enabled(scope.buyer_company_id) : false;
      const data = { v3_enabled };
      if (v3_enabled) {
        const email = await dashboardConfigModel.getAdminContactEmail(scope.buyer_company_id);
        if (email) data.admin_contact_email = email;
      }
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getActionCenter: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getActionCenterData(scope.buyer_company_id, req.user.id, scope.hotel_ids);
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
      const { start_date, end_date } = scope;
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
      const { start_date, end_date } = scope;
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
      const { start_date, end_date } = scope;
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
      const { start_date, end_date } = scope;
      const { product_variant_id, duration_type } = req.query;
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
      const { start_date, end_date } = scope;
      const { dimension } = req.query;
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
      const { start_date, end_date } = scope;
      const data = await dashboardModel.getAbcAnalysisData(scope.buyer_company_id, req.user.id, scope.hotel_ids, start_date, end_date);
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
      const { start_date, end_date } = scope;
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
      const { start_date, end_date } = scope;
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
      const data = await dashboardModel.getNoResponseDetail(scope.buyer_company_id, req.user.id, scope.hotel_ids);
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
      const data = await dashboardModel.getPendingApprovalsDetail(scope.buyer_company_id, req.user.id, scope.hotel_ids);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  /* ──────────────────────────────────────────────────────────────────
     Role-aware buyer dashboard — persona widget handlers.

     Every handler resolves scope first (vendors and unmapped users get a
     403), then calls ONE model function. Queues are undated; period widgets
     (savings pipeline, recently approved POs, PO value by stage, approval
     turnaround) receive the normalised IST window. See SPEC "Widget
     catalogue v1" for what each one counts.
     ────────────────────────────────────────────────────────────────── */
  // One handler shape for every persona widget.
  getMyDrafts: personaHandler((scope, req) => dashboardModel.getMyDraftsData(scope.buyer_company_id, req.user.id, scope.hotel_ids)),
  getMyActiveRfqs: personaHandler((scope, req) => dashboardModel.getMyActiveRfqsData(scope.buyer_company_id, req.user.id, scope.hotel_ids)),
  getMyNoResponseRfqs: personaHandler((scope, req) => dashboardModel.getMyNoResponseRfqsData(scope.buyer_company_id, req.user.id, scope.hotel_ids)),
  getMyRfqsBidClosedNoQuotes: personaHandler((scope, req) => dashboardModel.getMyRfqsBidClosedNoQuotesData(scope.buyer_company_id, req.user.id, scope.hotel_ids)),
  getMyTechEvalsPending: personaHandler((scope, req) => dashboardModel.getMyTechEvalsPendingData(scope.buyer_company_id, req.user.id, scope.hotel_ids)),
  getTechEvalsWithDisagreements: personaHandler((scope, req) => dashboardModel.getTechEvalsWithDisagreementsData(scope.buyer_company_id, req.user.id, scope.hotel_ids)),
  getMyTechApprovalsPending: personaHandler((scope, req) => dashboardModel.getMyTechApprovalsPendingData(scope.buyer_company_id, req.user.id, scope.hotel_ids)),
  getMyRfqApprovalsPending: personaHandler((scope, req) => dashboardModel.getMyRfqApprovalsPendingData(scope.buyer_company_id, req.user.id, scope.hotel_ids)),
  getMyQuoteCompares: personaHandler((scope, req) => dashboardModel.getMyQuoteComparesData(scope.buyer_company_id, req.user.id, scope.hotel_ids)),
  getMyActiveNegotiations: personaHandler((scope, req) => dashboardModel.getMyActiveNegotiationsData(scope.buyer_company_id, req.user.id, scope.hotel_ids)),
  getSavingsPipeline: personaHandler((scope, req) => dashboardModel.getSavingsPipelineData(scope.buyer_company_id, req.user.id, scope.hotel_ids, scope.start_date, scope.end_date)),
  getMyCommercialApprovalsPending: personaHandler((scope, req) => dashboardModel.getMyCommercialApprovalsPendingData(scope.buyer_company_id, req.user.id, scope.hotel_ids)),
  getMyAwardApprovalsPending: personaHandler((scope, req) => dashboardModel.getMyAwardApprovalsPendingData(scope.buyer_company_id, req.user.id, scope.hotel_ids)),
  getRecentAwards: personaHandler((scope, req) => dashboardModel.getRecentAwardsData(scope.buyer_company_id, req.user.id, scope.hotel_ids, scope.start_date, scope.end_date)),
  getAwardValuePipeline: personaHandler((scope, req) => dashboardModel.getAwardValuePipelineData(scope.buyer_company_id, req.user.id, scope.hotel_ids, scope.start_date, scope.end_date)),
  getApprovalTurnaround: personaHandler((scope, req) => dashboardModel.getApprovalTurnaroundData(scope.buyer_company_id, req.user.id, scope.hotel_ids, scope.start_date, scope.end_date)),
};

export default dashboardController;
