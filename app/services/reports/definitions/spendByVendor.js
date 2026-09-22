// ============================================================================
// 1.4 — Spend by Vendor
// ----------------------------------------------------------------------------
// Every vendor that transacted in the period, ranked by spend, with the prior
// period for comparison and a Pareto cut. The question it answers is "who are
// we actually buying from, and how exposed are we to each of them" — which is
// also why sheet 2 exists: the top 25 is what goes in front of a board.
//
// Departures from prototypes/report_samples/1.4_Spend_by_Vendor_FY26.xlsx,
// each because the column has no source in this schema:
//   • City / State — tbl_company.location is populated for 0 of 91 vendors.
//   • DPO          — there is no payment or invoice-settlement data at all.
// Added instead, because both are backed and useful: PO count and last PO date.
// ============================================================================

import { FMT, istDate, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import { spendByVendor } from "../../../models/reportsModel.js";

const PARETO_CUT = 0.8;

// One column list, used to render the workbook AND the on-screen preview, so
// what a user checks before downloading is what they download.
const COLUMNS = [
  { header: "Rank", key: "rank", width: 7, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Vendor ID", key: "vendor_id", width: 11, align: "right", type: "int" },
  { header: "Vendor Name", key: "vendor_name", width: 34, type: "text" },
  { header: "Primary Category", key: "primary_category", width: 28, type: "text" },
  { header: "GSTIN", key: "gstin", width: 18, type: "text" },
  { header: "Spend (₹)", key: "amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Share %", key: "share", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Cum %", key: "cumulative", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Prior Period (₹)", key: "prior_amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "YoY %", key: "yoy", width: 10, align: "right", numFmt: FMT.PCT_VAR, type: "percent" },
  { header: "MSME", key: "msme", width: 8, align: "center", type: "text" },
  { header: "ARC", key: "arc", width: 8, align: "center", type: "text" },
  { header: "POs", key: "po_count", width: 8, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Last PO", key: "last_po_at", width: 14, align: "center", numFmt: FMT.DATE, type: "date" },
];

const TOP_N = 25;
const TOP_COLUMNS = COLUMNS.filter((c) =>
  ["rank", "vendor_id", "vendor_name", "primary_category", "amount", "share", "cumulative"].includes(c.key)
);

/**
 * Rank, share and the running cumulative — computed here rather than in SQL so
 * the Pareto cut, the total row and the preview all read from one array and
 * cannot disagree by a rounding step.
 */
function decorate(raw) {
  const total = raw.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  let running = 0;
  return raw.map((r, idx) => {
    const amount = Number(r.amount) || 0;
    running += amount;
    const prior = r.prior_amount === null || r.prior_amount === undefined ? null : Number(r.prior_amount);
    return {
      rank: idx + 1,
      vendor_id: r.vendor_id,
      vendor_name: r.vendor_name || `Vendor ${r.vendor_id}`,
      primary_category: r.primary_category || "—",
      gstin: r.gstin || "—",
      amount,
      share: total > 0 ? amount / total : null,
      cumulative: total > 0 ? running / total : null,
      prior_amount: prior,
      // A vendor with no prior-period spend is new, not infinitely grown —
      // leave YoY empty rather than dividing by zero.
      yoy: prior && prior !== 0 ? (amount - prior) / prior : null,
      msme: r.is_msme ? "Yes" : "—",
      arc: r.on_contract ? "ARC" : "—",
      po_count: r.po_count,
      last_po_at: istDate(r.last_po_at),
    };
  });
}

export default {
  key: "spend_by_vendor",
  number: "1.4",
  family: "Spend Analytics",
  title: "Spend by Vendor",
  description:
    "Every vendor ranked by spend for the period, with prior-period comparison, Pareto cut, MSME and rate-contract status.",
  permission: "reports.spend_by_vendor",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const raw = await spendByVendor(scope, period);
    const rows = decorate(raw);
    const paretoCount = (() => {
      let n = 0;
      for (const r of rows) {
        n += 1;
        if ((r.cumulative || 0) >= PARETO_CUT) break;
      }
      return rows.length ? n : 0;
    })();
    return { rows, period, paretoCount };
  },

  preview({ rows }) {
    return {
      columns: COLUMNS.map(({ header, key, type, align }) => ({ header, key, type, align })),
      rows,
    };
  },

  buildWorkbook(wb, { rows, period, paretoCount }, { generatedBy }) {
    const params = [
      ["Reporting period", `FY ${period.label}`],
      ["Comparison", `vs ${period.priorLabel}`],
      ["Sort", "Descending by spend"],
      ["Pareto cut", `${paretoCount} vendor(s) make up the first 80% of spend`],
      ["Scope", "Approved purchase orders only; drafts, rejected and cancelled excluded"],
      ["MSME", "Udyam-registered — 45-day payment rule applies (MSMED Act s.15)"],
      ["ARC", "Vendor holds an active annual rate contract"],
    ];

    const ws = reportSheet(wb, "Vendor Ranking", { footerTitle: "Spend by Vendor" });
    writeReportSheet(ws, {
      title: "Spend by Vendor",
      subtitle: `All transacting vendors ranked by spend · FY ${period.label} · All amounts in ₹`,
      params,
      columns: COLUMNS.map((c) => ({
        ...c,
        // Total row: the two money columns sum; share is the whole of it; YoY
        // is derived from the two sums so it matches the columns above it.
        total:
          c.key === "share"
            ? () => 1
            : c.key === "yoy"
              ? ({ totalRow }) => ({
                  formula: `IF(I${totalRow}=0,"",(F${totalRow}-I${totalRow})/I${totalRow})`,
                })
              : c.total,
      })),
      rows,
      totalLabel: "Total",
      freezeCols: 3,
      generatedBy,
      asOf: istDateLabel(new Date()),
    });

    const top = rows.slice(0, TOP_N);
    const ws2 = reportSheet(wb, "Top 25", { footerTitle: "Spend by Vendor — Top 25" });
    writeReportSheet(ws2, {
      title: `Top ${TOP_N} Vendors — FY ${period.label}`,
      subtitle: "Pareto view of the largest vendor exposures · All amounts in ₹",
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Sort", "Spend descending"],
        ["Shown", `${top.length} of ${rows.length} transacting vendors`],
      ],
      columns: TOP_COLUMNS.map((c) => ({ ...c, total: c.key === "share" ? undefined : c.total })),
      rows: top,
      totalLabel: `Top ${top.length} total`,
      freezeCols: 3,
      generatedBy,
      asOf: istDateLabel(new Date()),
    });

    return wb;
  },
};
