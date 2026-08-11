// ============================================================================
// poVendorController.js
// ----------------------------------------------------------------------------
// Vendor-facing Purchase Order controllers. The authenticated vendor's id is
// taken from req.user (acl([3]) gates these routes to vendors) and used as the
// finalized_vendor_id scope key — tenant ids are NEVER read from body/query.
//
//   GET  /po/vendor/dashboard      -> vendorDashboard  (Task 1, implemented)
//   POST /po/vendor/list-view      -> vendorListView    (Task 2, stub)
//   GET  /po/vendor/detail/:po_id  -> vendorPoDetail    (Task 3, stub)
// ============================================================================

import db from "../../config/dbConn.js";
import { logError } from "../../helper/common.js";
import * as poVendorModel from "../../models/poVendorModel.js";
import { getPODetailFull } from "../../models/poDashboardModel.js";
import { generateCallOffPoPdf } from "../../helper/arc_v2/callOffPoRenderer.js";
import {
  buildVendorOrdersWorkbook,
  sendWorkbook,
  datedFilename,
} from "../../services/poExcelExport.js";

function ok(res, data, message = "success") {
  return res.status(200).json({ status: 1, message, data });
}

function bad(res, code, message, status) {
  return res.status(code).json({ status, message });
}

// ===========================================================================
// GET /po/vendor/dashboard
// ===========================================================================
export const vendorDashboard = async (req, res) => {
  try {
    const data = await poVendorModel.vendorDashboard(req.user.id);
    return ok(res, data);
  } catch (error) {
    logError("vendorDashboard failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to load vendor dashboard." });
  }
};

// ===========================================================================
// POST /po/vendor/list-view  (Task 2 — faceted vendor orders list)
// ===========================================================================
export const vendorListView = async (req, res) => {
  try {
    return ok(res, await poVendorModel.vendorListView(req.user.id, req.body || {}));
  } catch (error) {
    logError("vendorListView failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to load vendor orders." });
  }
};

// ===========================================================================
// POST /po/vendor/export — the vendor order book, as .xlsx
// ---------------------------------------------------------------------------
// POST, not GET, purely so it can share the list view's body contract (tab /
// search / filters) verbatim — one shape, one filter builder, no chance of the
// download and the table disagreeing. Scope is req.user.id inside the model, so
// a vendor can only ever export their own orders.
// ===========================================================================
export const vendorExport = async (req, res) => {
  try {
    const body = req.body || {};
    const { rows, truncated } = await poVendorModel.vendorListViewForExport(req.user.id, body);
    const filters = [["Tab", body.tab || "all"]];
    if (body.search) filters.push(["Search", String(body.search)]);
    if (body.filters?.type) filters.push(["Order type", String(body.filters.type)]);
    const wb = buildVendorOrdersWorkbook({
      rows,
      generatedBy: req.user?.name || undefined,
      filters,
      truncated,
      rowCap: poVendorModel.VENDOR_EXPORT_ROW_CAP,
    });
    return await sendWorkbook(res, wb, datedFilename("my-purchase-orders"));
  } catch (error) {
    logError("vendorExport failed", error);
    return res.status(500).json({ status: 0, message: error.message || "Failed to export orders." });
  }
};

// ===========================================================================
// GET /po/vendor/detail/:po_id  (Task 3 — vendor PO detail)
// ---------------------------------------------------------------------------
// Reuses the call-off-aware buyer detail shaper, but scopes by the caller's own
// finalized_vendor_id (req.user.id) instead of the buyer company gate. Out-of-
// scope / non-existent POs return 404 (never 403) so we don't leak existence.
// ===========================================================================
export const vendorPoDetail = async (req, res) => {
  try {
    const detail = await getPODetailFull(req.params.po_id, { vendorId: req.user.id });
    if (!detail) return bad(res, 404, "Purchase order not found", 2);
    return ok(res, detail);
  } catch (error) {
    logError("vendorPoDetail failed", error);
    return bad(res, 500, error.message || "Failed to load purchase order detail.", 3);
  }
};

// ===========================================================================
// GET /po/vendor/detail/:po_id/pdf  — resolve (and lazily generate) the PO PDF
// ---------------------------------------------------------------------------
// Returns { url } for the vendor's own PO. If the document hasn't been rendered
// yet (e.g. legacy/seeded call-offs created before the PDF feature), generate it
// on demand for call-offs. Ownership scoped to finalized_vendor_id (404 else).
// ===========================================================================
export const vendorPoPdf = async (req, res) => {
  try {
    const poId = Number(req.params.po_id);
    const po = await db.oneOrNone(
      `SELECT id, finalized_vendor_id, is_call_off, po_pdf_url
         FROM tbl_rfq_purchase_order WHERE id = $1`,
      [poId]
    );
    if (!po || Number(po.finalized_vendor_id) !== Number(req.user.id)) {
      return bad(res, 404, "Purchase order not found", 2);
    }
    if (po.po_pdf_url) return ok(res, { url: po.po_pdf_url });
    if (po.is_call_off) {
      const result = await generateCallOffPoPdf(poId); // null under test/env-gate or on failure
      const url = result?.url
        || (await db.oneOrNone(`SELECT po_pdf_url FROM tbl_rfq_purchase_order WHERE id = $1`, [poId]))?.po_pdf_url;
      if (url) return ok(res, { url });
    }
    return bad(res, 503, "The PO document is not available yet — please try again shortly.", 0);
  } catch (error) {
    logError("vendorPoPdf failed", error);
    return bad(res, 500, error.message || "Failed to generate PO document.", 3);
  }
};
