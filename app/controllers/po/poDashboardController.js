// ============================================================================
// poDashboardController.js
// ----------------------------------------------------------------------------
// Read-only controllers for the four new Purchase Order UI pages. Every handler
// derives the tenant scope from req.user + request HEADERS via deriveScope()
// and NEVER trusts tenant ids from the request body/query. See poDashboardModel
// for the SQL layer.
// ============================================================================

import { logError } from "../../helper/common.js";
import { resolveHospitalityCompanyScope } from "../../helper/arc_v2/resolveHospitalityCompany.js";
import {
  getPOList,
  getDashboardKpis,
  getAwaitingPOs,
  getPODetailFull,
  getTracking,
  getAnalytics,
} from "../../models/poDashboardModel.js";

// ---------------------------------------------------------------------------
// deriveScope(req): single source of truth for tenant scope.
// Precedence mirrors app/middleware/auth.js can():
//   company  : x-company-id || x-hospitality-company || req.user.company_id
//   hotels   : x-hotel-ids (csv) || x-hotel-id / x-hospitality-hotel (single)
//   dept     : x-department-id
// The header-supplied company id is the HOSPITALITY company id in the
// hospitality flow; we keep both `hospitalityCompanyId` (header) and
// `companyId` (req.user fallback for legacy non-hospitality POs) so the model
// can scope POs through their RFQ's hospitality_company_id when present.
// ---------------------------------------------------------------------------
async function deriveScope(req) {
  // Company scope spans ALL the user's mapped hospitality companies (super admin
  // → null = all), so a multi-company user sees their whole portfolio rather than
  // just the BU currently selected in the header. The dashboard narrows by the
  // explicit hotel/department facets below, NOT by the global BU selection —
  // consistent with the MR / ARC / Negotiation listings.
  const hospitalityCompanyIds = await resolveHospitalityCompanyScope(req);

  // tbl_company id fallback for legacy non-hospitality POs (po.company_id) —
  // used only when the user has no hospitality mappings (empty scope).
  const userCompanyId = req.user && req.user.company_id ? parseInt(req.user.company_id, 10) : null;

  let hotelIds = [];
  if (req.headers["x-hotel-ids"]) {
    hotelIds = req.headers["x-hotel-ids"]
      .split(",")
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !Number.isNaN(id) && id > 0);
  } else if (req.headers["x-hotel-id"] || req.headers["x-hospitality-hotel"]) {
    const id = parseInt(req.headers["x-hotel-id"] || req.headers["x-hospitality-hotel"], 10);
    if (!Number.isNaN(id) && id > 0) hotelIds = [id];
  }

  let departmentId = null;
  if (req.headers["x-department-id"]) {
    const id = parseInt(req.headers["x-department-id"], 10);
    if (!Number.isNaN(id) && id > 0) departmentId = id;
  }

  return {
    userId: req.user.id,
    // null = super admin (all companies); [] = no hospitality mappings (legacy
    // fallback to po.company_id); [...] = scope to exactly these companies.
    hospitalityCompanyIds,
    companyId: userCompanyId,
    hotelIds,
    departmentId,
  };
}

// Guard: a buyer must always resolve to SOME tenant scope; otherwise refuse.
// null = super admin (all); a non-empty company array; or a legacy company id.
function hasUsableScope(scope) {
  return scope.hospitalityCompanyIds === null
    || (Array.isArray(scope.hospitalityCompanyIds) && scope.hospitalityCompanyIds.length > 0)
    || !!scope.companyId;
}

// ===========================================================================
// GET /po/list
// ===========================================================================
export const listPOs = async (req, res) => {
  try {
    const scope = await deriveScope(req);
    if (!hasUsableScope(scope)) {
      return res.status(400).json({ status: 0, message: "Company scope is required." });
    }
    const { status, search, page, limit, sort } = req.query;
    const result = await getPOList(scope, { status, search, page, limit, sort });
    return res.json(result);
  } catch (error) {
    logError("listPOs failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to load PO list." });
  }
};

// ===========================================================================
// GET /po/dashboard/kpis
// ===========================================================================
export const dashboardKpis = async (req, res) => {
  try {
    const scope = await deriveScope(req);
    if (!hasUsableScope(scope)) {
      return res.status(400).json({ status: 0, message: "Company scope is required." });
    }
    const result = await getDashboardKpis(scope);
    return res.json(result);
  } catch (error) {
    logError("dashboardKpis failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to load dashboard KPIs." });
  }
};

// ===========================================================================
// GET /po/awaiting
// ===========================================================================
export const awaitingPOs = async (req, res) => {
  try {
    const scope = await deriveScope(req);
    if (!hasUsableScope(scope)) {
      return res.status(400).json({ status: 0, message: "Company scope is required." });
    }
    const result = await getAwaitingPOs(scope);
    return res.json(result);
  } catch (error) {
    logError("awaitingPOs failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to load awaiting POs." });
  }
};

// ===========================================================================
// GET /po/detail/:po_id  (full contract-shaped detail object)
// Also reused to augment GET /po/:po_id (see purchaseOrderController.getPODetails).
// ===========================================================================
export const poDetailFull = async (req, res) => {
  try {
    const scope = await deriveScope(req);
    if (!hasUsableScope(scope)) {
      return res.status(400).json({ status: 0, message: "Company scope is required." });
    }
    const result = await getPODetailFull(req.params.po_id, scope);
    if (!result) {
      // 404 (not 403) so we never leak existence of out-of-scope POs.
      return res.status(404).json({ status: 2, message: "Purchase order not found." });
    }
    return res.json({ data: result });
  } catch (error) {
    logError("poDetailFull failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to load PO detail." });
  }
};

// ===========================================================================
// GET /po/tracking
// ===========================================================================
export const tracking = async (req, res) => {
  try {
    const scope = await deriveScope(req);
    if (!hasUsableScope(scope)) {
      return res.status(400).json({ status: 0, message: "Company scope is required." });
    }
    const { tab, search, page, limit } = req.query;
    const result = await getTracking(scope, { tab, search, page, limit });
    return res.json(result);
  } catch (error) {
    logError("tracking failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to load tracking." });
  }
};

// ===========================================================================
// GET /po/analytics
// ===========================================================================
export const analytics = async (req, res) => {
  try {
    const scope = await deriveScope(req);
    if (!hasUsableScope(scope)) {
      return res.status(400).json({ status: 0, message: "Company scope is required." });
    }
    const { period } = req.query;
    const result = await getAnalytics(scope, { period });
    return res.json(result);
  } catch (error) {
    logError("analytics failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to load analytics." });
  }
};

// Exported for reuse by the existing getPODetails handler to merge detail-full
// fields into GET /po/:po_id (additive, non-breaking).
export { deriveScope };
