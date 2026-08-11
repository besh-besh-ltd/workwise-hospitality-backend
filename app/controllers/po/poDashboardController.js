// ============================================================================
// poDashboardController.js
// ----------------------------------------------------------------------------
// Read-only controllers for the four new Purchase Order UI pages.
//
// SECURITY MODEL (corrected):
//   The AUTHORITY for what a caller may see is their RBAC scope rows
//   (tbl_user_role_scopes), applied in SQL by poDashboardModel.buildScopeClause
//   via authorizationService.buildScopeExistsClause — company × hotel ×
//   department × process, all derived from req.user.id.
//
//   The x-hotel-ids / x-department-id headers are a UI FACET only. They can
//   narrow the scoped set; they can never be the source of it. Previously they
//   WERE the source: omitting x-hotel-ids deleted the hotel predicate entirely
//   and a hotel-scoped buyer saw their whole company's POs (measured at
//   ₹4.86 crore vs a correct ₹2.07 crore for one production user).
//
//   Tenant ids are never accepted from the request body/query.
// ============================================================================

import { logError } from "../../helper/common.js";
import { resolveHospitalityCompanyScope } from "../../helper/arc_v2/resolveHospitalityCompany.js";
import {
  getPOList,
  getPOListForExport,
  getDashboardKpis,
  getAwaitingPOs,
  getPODetailFull,
  getTracking,
  getTrackingForExport,
  getAnalytics,
  EXPORT_ROW_CAP,
} from "../../models/poDashboardModel.js";
import {
  buildPoListWorkbook,
  buildTrackingWorkbook,
  buildAnalyticsWorkbook,
  sendWorkbook,
  datedFilename,
} from "../../services/poExcelExport.js";

// ---------------------------------------------------------------------------
// deriveScope(req): assembles the scope object the model consumes.
//
//   userId                 — THE scope authority. The model correlates it
//                            against tbl_user_role_scopes for the company ×
//                            hotel × department × process predicate.
//   hospitalityCompanyIds  — null = super admin (all companies); [] = no
//                            hospitality mappings (legacy po.company_id
//                            fallback); [...] = the user's mapped companies.
//   hotelIds / departmentId — NARROWING facets read from x-hotel-ids /
//                            x-hotel-id / x-hospitality-hotel /
//                            x-department-id. Intersected with the RBAC-scoped
//                            set; never a substitute for it. A caller passing a
//                            hotel outside their scope gets fewer rows, not more.
// ---------------------------------------------------------------------------
async function deriveScope(req) {
  // Company scope spans ALL the user's mapped hospitality companies (super admin
  // → null = all). Hotel/department granularity within those companies comes
  // from the RBAC predicate in the model, not from this call — the mappings
  // table is company-granular and would otherwise discard hotel binding.
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

// ---------------------------------------------------------------------------
// Query-string facets (vendor + creation-date window).
//
// NOT tenant identifiers: both are ANDed on top of the scope clause and can
// only ever narrow it, so accepting them from the client is safe. A vendor id
// the caller cannot see simply yields nothing. Anything malformed is DROPPED
// rather than rejected — a stray "?vendor_id=abc" must not 400 a dashboard.
// `date_from` / `date_to` are ISO calendar days, both ends inclusive (the same
// contract the RFQ/ARC/MR listings' FY filter uses).
// ---------------------------------------------------------------------------
function readFacetFilters(req) {
  const asISODate = (v) =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined;
  const vendorId = parseInt(req.query.vendor_id, 10);
  return {
    vendorId: Number.isInteger(vendorId) && vendorId > 0 ? vendorId : undefined,
    dateFrom: asISODate(req.query.date_from),
    dateTo: asISODate(req.query.date_to),
  };
}

// Human description of the facets, for the workbook's "Report info" sheet.
function describeFilters(req, extra = []) {
  const { vendorId, dateFrom, dateTo } = readFacetFilters(req);
  const out = [...extra];
  if (req.query.search) out.push(["Search", String(req.query.search)]);
  if (vendorId) out.push(["Vendor id", String(vendorId)]);
  if (dateFrom || dateTo) out.push(["Created between", `${dateFrom || "any"} and ${dateTo || "any"}`]);
  return out;
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
    const result = await getPOList(scope, {
      status, search, page, limit, sort, ...readFacetFilters(req),
    });
    return res.json(result);
  } catch (error) {
    logError("listPOs failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to load PO list." });
  }
};

// ===========================================================================
// GET /po/export — the dashboard list, as .xlsx
// ---------------------------------------------------------------------------
// Same scope + same filter builder as GET /po/list, unpaginated. That identity
// is the whole point: "export everything I can currently see" is enforced by
// running the caller's own scoped query again, not by trusting a row set or an
// id list posted up from the browser.
// ===========================================================================
export const exportPOList = async (req, res) => {
  try {
    const scope = await deriveScope(req);
    if (!hasUsableScope(scope)) {
      return res.status(400).json({ status: 0, message: "Company scope is required." });
    }
    const { status, search, sort } = req.query;
    const { data, truncated } = await getPOListForExport(scope, {
      status, search, sort, ...readFacetFilters(req),
    });
    const wb = buildPoListWorkbook({
      rows: data,
      generatedBy: req.user?.name || undefined,
      filters: describeFilters(req, [["Status tab", status || "all"]]),
      truncated,
      rowCap: EXPORT_ROW_CAP,
    });
    return await sendWorkbook(res, wb, datedFilename("purchase-orders"));
  } catch (error) {
    logError("exportPOList failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to export purchase orders." });
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
    const result = await getTracking(scope, { tab, search, page, limit, ...readFacetFilters(req) });
    return res.json(result);
  } catch (error) {
    logError("tracking failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to load tracking." });
  }
};

// ===========================================================================
// GET /po/tracking/export — the tracking table, as .xlsx (same scope+filters)
// ===========================================================================
export const exportTracking = async (req, res) => {
  try {
    const scope = await deriveScope(req);
    if (!hasUsableScope(scope)) {
      return res.status(400).json({ status: 0, message: "Company scope is required." });
    }
    const { tab, search } = req.query;
    const { data, truncated } = await getTrackingForExport(scope, {
      tab, search, ...readFacetFilters(req),
    });
    const wb = buildTrackingWorkbook({
      rows: data,
      generatedBy: req.user?.name || undefined,
      filters: describeFilters(req, [["Tab", tab || "active"]]),
      truncated,
      rowCap: EXPORT_ROW_CAP,
    });
    return await sendWorkbook(res, wb, datedFilename("po-tracking"));
  } catch (error) {
    logError("exportTracking failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to export PO tracking." });
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

// ===========================================================================
// GET /po/analytics/export — one sheet per chart, as .xlsx
// ===========================================================================
export const exportAnalytics = async (req, res) => {
  try {
    const scope = await deriveScope(req);
    if (!hasUsableScope(scope)) {
      return res.status(400).json({ status: 0, message: "Company scope is required." });
    }
    const period = req.query.period || "this-month";
    const result = await getAnalytics(scope, { period });
    const wb = buildAnalyticsWorkbook({
      analytics: result,
      period,
      generatedBy: req.user?.name || undefined,
      filters: [["Reporting period", period]],
    });
    return await sendWorkbook(res, wb, datedFilename("po-analytics"));
  } catch (error) {
    logError("exportAnalytics failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to export PO analytics." });
  }
};

// Exported for reuse by the existing getPODetails handler to merge detail-full
// fields into GET /po/:po_id (additive, non-breaking).
export { deriveScope };
