// ============================================================================
// poVendorModel.js
// ----------------------------------------------------------------------------
// Read-only query layer for the vendor-facing Purchase Order pages
// (Dashboard / Orders list / Order detail). Every query is scoped to the
// authenticated vendor: a vendor user's id IS the finalized_vendor_id on their
// POs (both RFQ POs and ARC call-off POs), so scope is simply
//   po.finalized_vendor_id = $1 AND po.status = ANY(VENDOR_VISIBLE_STATUSES)
//
// SECURITY: the vendorId is taken from req.user (see poVendorController), never
// from the request body/query. All queries use parameterized placeholders.
// ============================================================================

import db from "../config/dbConn.js";

// ---------------------------------------------------------------------------
// Status visibility + buckets.
// ---------------------------------------------------------------------------
// A vendor never sees 'draft'/'pending_approval' (internal buyer states) nor
// 'cancelled'/'rejected' (internal). They see everything from the moment the PO
// is handed to them (acceptance_pending) through fulfilment and completion, plus
// their own rejection.
export const VENDOR_VISIBLE_STATUSES = [
  "acceptance_pending",
  "approved",
  "sent",
  "dispatched",
  "invoice_raised",
  "GRN",
  "completed",
  "rejected_by_vendor",
];

// 'sent' is the legacy "sent to vendor, awaiting acceptance" state — the same
// gate as 'acceptance_pending' (the new flow's name). Both are awaiting the
// vendor's accept/reject; only 'approved' onward is in fulfilment.
const AWAITING = ["acceptance_pending", "sent"];
const IN_FULFILMENT = ["approved", "dispatched"];
const EARNED = ["invoice_raised", "GRN", "completed"];

// next_step drives the vendor's "attention" queue: only POs with a pending
// vendor action are surfaced there.
function nextStep(status) {
  switch (status) {
    case "acceptance_pending":
    case "sent":
      return "Accept";
    case "approved":
      return "Mark dispatched";
    case "dispatched":
      return "Raise invoice";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// vendorDashboard(vendorId)
// Returns the full dashboard payload (KPIs, attention queue, earnings, buyers).
// ---------------------------------------------------------------------------
export async function vendorDashboard(vendorId) {
  // Single scan over the vendor's visible POs, joined to buyer/hotel names.
  // For RFQ POs the tenant comes from the parent RFQ; for call-offs it comes
  // from the ARC behind the contract — COALESCE picks whichever is present.
  const rows = await db.any(
    `SELECT po.id,
            po.po_number,
            po.status,
            po.total_value::float8 AS total_value,
            po.is_call_off,
            po.created_at,
            COALESCE(THC.name, ATHC.name) AS buyer_name,
            COALESCE(THCH.name, ATHCH.name) AS hotel_name
       FROM tbl_rfq_purchase_order po
       LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
       LEFT JOIN tbl_hospitality_companies THC ON THC.id = rfq.hospitality_company_id
       LEFT JOIN tbl_hospitality_company_hotels THCH ON THCH.id = rfq.hotel_id
       LEFT JOIN tbl_arc_contract acon ON acon.id = po.arc_contract_id
       LEFT JOIN tbl_arc arc ON arc.id = acon.arc_id
       LEFT JOIN tbl_hospitality_companies ATHC ON ATHC.id = arc.hospitality_company_id
       LEFT JOIN tbl_hospitality_company_hotels ATHCH ON ATHCH.id = arc.hotel_id
      WHERE po.finalized_vendor_id = $1
        AND po.status::text = ANY ($2::text[])
      ORDER BY po.created_at DESC`,
    [vendorId, VENDOR_VISIBLE_STATUSES]
  );

  // Month boundaries for the month-to-date earnings KPI (local server time;
  // in a model a single new Date() is fine — only workflow scripts forbid it).
  const now = new Date();
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  // Aggregate KPIs in JS (single scan; small per-vendor row counts).
  let awaitingCount = 0;
  let awaitingValue = 0;
  let inFulfilmentCount = 0;
  let earnedMtdValue = 0; // EARNED rows created this month (the KPI)
  let earnedPrevMonthValue = 0; // EARNED rows created in the prior full month
  let invoicedValue = 0;
  let completedValue = 0;
  let fulfilmentValue = 0;

  const attention = [];
  const buyerTotals = new Map();

  for (const r of rows) {
    const value = Number(r.total_value) || 0;
    if (AWAITING.includes(r.status)) {
      awaitingCount += 1;
      awaitingValue += value;
    }
    if (IN_FULFILMENT.includes(r.status)) {
      inFulfilmentCount += 1;
      fulfilmentValue += value;
    }
    if (EARNED.includes(r.status)) {
      const createdAt = new Date(r.created_at);
      if (createdAt >= startOfThisMonth) {
        earnedMtdValue += value; // month-to-date earnings
      } else if (createdAt >= startOfLastMonth) {
        earnedPrevMonthValue += value; // prior full month, for delta_pct
      }
      if (r.status === "invoice_raised") invoicedValue += value;
      else completedValue += value; // v1: GRN folded into completed; split later if the dashboard needs it
    }

    const step = nextStep(r.status);
    if (step) {
      attention.push({
        id: r.id,
        po_number: r.po_number,
        buyer_name: r.buyer_name || null,
        hotel_name: r.hotel_name || null,
        total_value: value,
        is_call_off: r.is_call_off,
        next_step: step,
      });
    }

    const key = r.buyer_name || "Unknown";
    buyerTotals.set(key, (buyerTotals.get(key) || 0) + value);
  }

  const top_buyers = [...buyerTotals.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);

  const by_stage = [
    { key: "awaiting", label: "Awaiting accept", value: awaitingValue },
    { key: "fulfilment", label: "In fulfilment", value: fulfilmentValue },
    { key: "invoiced", label: "Invoiced", value: invoicedValue },
    { key: "completed", label: "Completed", value: completedValue },
  ];

  // Percent change vs the prior full month's earned value (null if no baseline).
  const earningsDeltaPct =
    earnedPrevMonthValue > 0
      ? Math.round(((earnedMtdValue - earnedPrevMonthValue) / earnedPrevMonthValue) * 100)
      : null;

  return {
    kpis: {
      awaiting_action: { count: awaitingCount, value: awaitingValue },
      in_fulfilment: { count: inFulfilmentCount },
      earnings_mtd: { value: earnedMtdValue, delta_pct: earningsDeltaPct },
      on_time_pct: null,
    },
    attention,
    earnings: { by_stage, trend: [] },
    top_buyers,
    activity: [],
  };
}

// ---------------------------------------------------------------------------
// vendorListView(vendorId, { tab, search, filters, page, limit })
// Faceted, paginated orders list for the vendor Orders page. Every query is
// scoped to the caller's POs (finalized_vendor_id) within VENDOR_VISIBLE_STATUSES.
// ---------------------------------------------------------------------------

// Tab -> status buckets (each bucket is a subset of VENDOR_VISIBLE_STATUSES).
const TABS = {
  all: VENDOR_VISIBLE_STATUSES,
  awaiting: ["acceptance_pending", "sent"],
  fulfilment: ["approved", "dispatched"],
  invoiced: ["invoice_raised"],
  completed: ["GRN", "completed"],
  rejected: ["rejected_by_vendor"],
};

export async function vendorListView(
  vendorId,
  { tab = "all", search = "", filters = {}, page = 1, limit = 20 } = {}
) {
  // --- normalise inputs --------------------------------------------------
  const tabStatuses = TABS[tab] || VENDOR_VISIBLE_STATUSES;
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;

  // Effective status set = tab bucket intersected (implicitly) with the
  // vendor's visible set. The WHERE clause asserts both, so a malformed tab
  // can never widen visibility.
  const visible = VENDOR_VISIBLE_STATUSES;

  // --- build the filtered WHERE clause -----------------------------------
  // $1 vendorId, $2 visible statuses, $3 tab statuses; type/search appended.
  const where = [
    "po.finalized_vendor_id = $1",
    "po.status::text = ANY ($2::text[])",
    "po.status::text = ANY ($3::text[])",
  ];
  const params = [vendorId, visible, tabStatuses];

  if (filters && filters.type === "call_off") {
    where.push("po.is_call_off = TRUE");
  } else if (filters && filters.type === "rfq") {
    where.push("po.is_call_off = FALSE");
  }

  const trimmedSearch = (search || "").trim();
  if (trimmedSearch) {
    params.push(`%${trimmedSearch}%`);
    where.push(`po.po_number ILIKE $${params.length}`);
  }

  const whereSql = where.join("\n        AND ");

  // Joins resolve buyer/hotel names for BOTH PO flavours (RFQ vs ARC call-off);
  // COALESCE picks whichever parent supplies the hotel.
  const fromSql = `
       FROM tbl_rfq_purchase_order po
       LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
       LEFT JOIN tbl_arc_contract cc ON cc.id = po.arc_contract_id
       LEFT JOIN tbl_arc a ON a.id = cc.arc_id
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = COALESCE(rfq.hotel_id, a.hotel_id)
       LEFT JOIN tbl_hospitality_companies hc ON hc.id = h.hospitality_company_id`;

  // --- page of rows ------------------------------------------------------
  const limIdx = params.length + 1;
  const offIdx = params.length + 2;
  const rowParams = [...params, safeLimit, offset];
  const rows = await db.any(
    `SELECT po.id,
            po.po_number,
            po.status,
            po.total_value::float8 AS total_value,
            po.is_call_off,
            po.finalized_vendor_id,
            po.created_at,
            po.rfq_id,
            po.arc_contract_id,
            hc.name AS buyer_name,
            h.name  AS hotel_name
       ${fromSql}
      WHERE ${whereSql}
      ORDER BY po.created_at DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    rowParams
  );

  // --- total over the filtered (tab+type+search) set ---------------------
  const totalRow = await db.one(
    `SELECT COUNT(*)::int AS total
       ${fromSql}
      WHERE ${whereSql}`,
    params
  );

  // --- tab counts: one scan of the vendor's full visible set -------------
  const statusRows = await db.any(
    `SELECT po.status::text AS status
       FROM tbl_rfq_purchase_order po
      WHERE po.finalized_vendor_id = $1
        AND po.status::text = ANY ($2::text[])`,
    [vendorId, visible]
  );

  const tab_counts = { all: 0, awaiting: 0, fulfilment: 0, invoiced: 0, completed: 0, rejected: 0 };
  for (const r of statusRows) {
    for (const [key, statuses] of Object.entries(TABS)) {
      if (statuses.includes(r.status)) tab_counts[key] += 1;
    }
  }

  return {
    rows,
    total: totalRow.total,
    page: safePage,
    limit: safeLimit,
    tab_counts,
    facets: {
      type: [
        { key: "call_off", label: "Call-off" },
        { key: "rfq", label: "RFQ" },
      ],
    },
  };
}

export default { vendorDashboard, vendorListView, VENDOR_VISIBLE_STATUSES };
