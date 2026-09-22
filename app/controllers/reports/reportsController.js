// ============================================================================
// reportsController.js
// ----------------------------------------------------------------------------
// The Reports module's HTTP surface.
//
// ── Two gates, both required ────────────────────────────────────────────────
//
// 1. ENTITLEMENT — does this user hold `reports.<key>`? The catalogue returns
//    only what they hold, so the UI cannot offer what the API would refuse,
//    and every run endpoint re-checks rather than trusting that it didn't.
//
// 2. ROW SCOPE — which rows may they see? That lives in the model, as the same
//    buildScopeClause() predicate the PO dashboard uses.
//
// The two are separate on purpose. Entitlement is scope-blind: a user with one
// of twelve properties still gets to open the report, they just see one
// property in it. Folding scope into entitlement would lock them out entirely.
//
// SECURITY: tenant identity comes from req.user via deriveScope() and from
// nowhere else. Headers and the filter payload narrow an already-scoped set —
// naming a hotel you cannot see returns fewer rows, never more. The comment on
// deriveScope records the production incident that established this rule.
// ============================================================================

import { logError } from "../../helper/common.js";
import { deriveScope } from "../po/poDashboardController.js";
import { allReports, getReport, isRunnable } from "../../services/reports/definitions/index.js";
import { resolvePeriod, resolveHotelIds } from "../../services/reports/filters.js";
import {
  workbook,
  sendWorkbook,
  datedFilename,
  writeReportInfo,
} from "../../services/reports/excelKit.js";
import reportsModel, { REPORT_ROW_CAP } from "../../models/reportsModel.js";

// tbl_users.user_type: 3 = Vendor, 8 = Super Admin.
const VENDOR_USER_TYPE = 3;
const SUPER_ADMIN_USER_TYPE = 8;

/** A buyer must resolve to SOME tenant scope, or there is nothing to report on. */
function hasUsableScope(scope) {
  return (
    scope.hospitalityCompanyIds === null ||
    (Array.isArray(scope.hospitalityCompanyIds) && scope.hospitalityCompanyIds.length > 0) ||
    !!scope.companyId
  );
}

/**
 * The report keys this caller may run. Super admin holds everything; everyone
 * else holds whatever their roles grant.
 */
async function entitlementsFor(req) {
  if (Number(req.user.user_type) === SUPER_ADMIN_USER_TYPE) return null; // null = all
  return reportsModel.permittedReportActions(req.user.id);
}

const entitled = (grants, key) => grants === null || grants.has(key);

/**
 * Resolve the request into { scope, definition, period, hotelIds }, or send the
 * response and return null. Every run endpoint starts here so the gates cannot
 * be applied inconsistently between preview and download.
 */
async function resolveRequest(req, res, { requireRunnable = true } = {}) {
  if (Number(req.user.user_type) === VENDOR_USER_TYPE) {
    res.status(403).json({ status: 0, message: "Insufficient permissions" }).end();
    return null;
  }

  const def = getReport(req.params.key);
  // An unknown key and an unentitled key answer identically. Distinguishing
  // them would turn the endpoint into a directory of what exists.
  const grants = await entitlementsFor(req);
  if (!def || !entitled(grants, def.key)) {
    res.status(403).json({ status: 0, message: "Insufficient permissions" }).end();
    return null;
  }

  if (requireRunnable && !isRunnable(def)) {
    res
      .status(409)
      .json({
        status: 0,
        message: def.readiness?.missing || "This report is not available yet.",
        readiness: def.readiness,
      })
      .end();
    return null;
  }

  const scope = await deriveScope(req);
  if (!hasUsableScope(scope)) {
    res.status(403).json({ status: 0, message: "No hospitality access found for this user" }).end();
    return null;
  }

  const body = req.body || {};
  const hotelIds = resolveHotelIds(body.hotel_ids);
  // A hotel facet from the payload is intersected by deriveScope's own rules
  // downstream; setting it here only ever narrows.
  if (hotelIds.length > 0) scope.hotelIds = hotelIds;

  const period = resolvePeriod(body);
  return { scope, def, period, hotelIds };
}

// ===========================================================================
// GET /reports/catalogue
// ===========================================================================
export const catalogue = async (req, res) => {
  try {
    if (Number(req.user.user_type) === VENDOR_USER_TYPE) {
      return res.status(403).json({ status: 0, message: "Insufficient permissions" }).end();
    }
    const grants = await entitlementsFor(req);

    const reports = allReports()
      .filter((d) => entitled(grants, d.key))
      .map((d) => ({
        key: d.key,
        number: d.number,
        family: d.family,
        title: d.title,
        description: d.description,
        filters: d.filters || [],
        readiness: d.readiness,
        runnable: isRunnable(d),
      }));

    return res.status(200).json({ status: 1, data: { reports } }).end();
  } catch (error) {
    logError("reports.catalogue failed", error);
    return res.status(400).json({ status: 3, message: "Could not load the report catalogue" }).end();
  }
};

// ===========================================================================
// POST /reports/:key/preview
// ---------------------------------------------------------------------------
// The first sheet, capped, as JSON — so a user can check their filters caught
// what they meant before committing to a download.
// ===========================================================================
export const preview = async (req, res) => {
  try {
    const ctx = await resolveRequest(req, res);
    if (!ctx) return;
    const { scope, def, period } = ctx;

    const data = await def.fetch(scope, period);
    const { columns, rows } = def.preview(data);
    const limit = 50;

    return res
      .status(200)
      .json({
        status: 1,
        data: {
          key: def.key,
          title: def.title,
          period: { label: period.label, from: period.from, to: period.to },
          columns,
          rows: rows.slice(0, limit),
          total_rows: rows.length,
          truncated: rows.length > limit,
        },
      })
      .end();
  } catch (error) {
    logError("reports.preview failed", error);
    return res.status(400).json({ status: 3, message: "Could not build the preview" }).end();
  }
};

// ===========================================================================
// POST /reports/:key/download
// ---------------------------------------------------------------------------
// Builds the workbook from the caller's own scoped query and streams it. The
// browser sends filters, never rows or ids: whatever the user can see is what
// lands in the file, and nothing else.
//
// Every download writes a ledger row. That row is the record of the
// disclosure, which is why it is written even though there is no job to track.
// ===========================================================================
export const download = async (req, res) => {
  try {
    const ctx = await resolveRequest(req, res);
    if (!ctx) return;
    const { scope, def, period, hotelIds } = ctx;

    const data = await def.fetch(scope, period);
    const wb = workbook("Workwise");
    def.buildWorkbook(wb, data, { generatedBy: req.user.name || req.user.email || null });

    // A report that hit the row ceiling is INCOMPLETE, and a workbook that
    // does not say so is the worst outcome here — it looks whole and is short.
    // The provenance sheet only appears in that case, so a normal export is
    // not cluttered by a sheet that always says "fine".
    const rowCount = data.rows?.length ?? null;
    const truncated = rowCount !== null && rowCount >= REPORT_ROW_CAP;
    if (truncated) {
      writeReportInfo(wb, {
        title: def.title,
        generatedBy: req.user.name || req.user.email || null,
        filters: [["Period", period.label], ["Business units", hotelIds.length ? hotelIds.join(", ") : "all in scope"]],
        rowCount,
        truncated: true,
        rowCap: REPORT_ROW_CAP,
      });
    }

    // Ledger first: a row that records a disclosure which then failed to send
    // is harmless, one that sends and is never recorded is not.
    await reportsModel
      .recordExport({
        reportKey: def.key,
        requestedBy: req.user.id,
        hospitalityCompanyId: Array.isArray(scope.hospitalityCompanyIds)
          ? scope.hospitalityCompanyIds[0] || 0
          : 0,
        hotelIds,
        filters: { fy: period.label, from: period.from, to: period.to, hotel_ids: hotelIds },
        mode: "SYNC",
        status: "READY",
        rowCount,
      })
      .catch((e) => logError("reports.download: ledger write failed", e));

    return sendWorkbook(res, wb, datedFilename(def.key.replace(/_/g, "-")));
  } catch (error) {
    logError("reports.download failed", error);
    if (res.headersSent) return res.end();
    return res.status(400).json({ status: 3, message: "Could not build the report" }).end();
  }
};

// ===========================================================================
// GET /reports/exports — the caller's own history, never anyone else's.
// ===========================================================================
export const exportHistory = async (req, res) => {
  try {
    if (Number(req.user.user_type) === VENDOR_USER_TYPE) {
      return res.status(403).json({ status: 0, message: "Insufficient permissions" }).end();
    }
    const rows = await reportsModel.listExports(req.user.id, req.query.limit);
    return res.status(200).json({ status: 1, data: { exports: rows } }).end();
  } catch (error) {
    logError("reports.exportHistory failed", error);
    return res.status(400).json({ status: 3, message: "Could not load export history" }).end();
  }
};

export default { catalogue, preview, download, exportHistory };
