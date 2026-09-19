// ============================================================================
// 1.1 — Total Spend Summary
// ----------------------------------------------------------------------------
// The headline: what did we spend this year, how does each month compare with
// last year, which properties drove it, and which categories. Three sheets,
// one period, all reconciling to the same total.
//
// Departures from prototypes/report_samples/1.1_Total_Spend_Summary_FY26.xlsx:
//   • "Annual Budget Pace" and "Pace Variance %" are dropped — the platform
//     holds no budgets, so there is no pace to measure against. Report 4.1
//     carries the same gap and says so in the catalogue.
//   • "Spend % of Revenue" is dropped — no revenue is captured anywhere.
//   • "Cost per Key" is kept but renders blank until room counts are filled in
//     on the business unit. That is a data-entry gap an administrator can close
//     today, not a missing capability, so the column stays to show the gap.
// ============================================================================

import { FMT, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import {
  spendByMonth,
  spendByProperty,
  spendByCategory,
  spendTotals,
} from "../../../models/reportsModel.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Apr-26" from a Postgres date, read as UTC so the month cannot slip. */
function monthLabel(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(2)}`;
}

/** (a - b) / b, or null when there is no base to compare against. */
const change = (a, b) => (b && b !== 0 ? (a - b) / b : null);

const MONTH_COLUMNS = [
  { header: "Month", key: "month", width: 12, type: "text" },
  { header: "Actual (₹)", key: "amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Prior Year (₹)", key: "prior_amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "YoY %", key: "yoy", width: 10, align: "right", numFmt: FMT.PCT_VAR, type: "percent" },
  { header: "MoM %", key: "mom", width: 10, align: "right", numFmt: FMT.PCT_VAR, type: "percent" },
  { header: "Cumulative (₹)", key: "cumulative", width: 17, align: "right", numFmt: FMT.INR, type: "money" },
];

const PROPERTY_COLUMNS = [
  { header: "Property", key: "hotel_name", width: 32, type: "text" },
  { header: "City", key: "city", width: 16, type: "text" },
  { header: "Keys", key: "keys", width: 8, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Actual (₹)", key: "amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Share %", key: "share", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Prior Year (₹)", key: "prior_amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "YoY %", key: "yoy", width: 10, align: "right", numFmt: FMT.PCT_VAR, type: "percent" },
  { header: "POs", key: "po_count", width: 8, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Cost per Key (₹)", key: "cost_per_key", width: 16, align: "right", numFmt: FMT.INR, type: "money" },
];

const CATEGORY_COLUMNS = [
  { header: "Rank", key: "rank", width: 7, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Category", key: "category", width: 34, type: "text" },
  { header: "Actual (₹)", key: "amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Share %", key: "share", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Prior Year (₹)", key: "prior_amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "YoY %", key: "yoy", width: 10, align: "right", numFmt: FMT.PCT_VAR, type: "percent" },
  { header: "Vendors", key: "vendor_count", width: 10, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "POs", key: "po_count", width: 8, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
];

const shareOf = (total) => (amount) => (total > 0 ? amount / total : null);

export default {
  key: "spend_summary",
  number: "1.1",
  family: "Spend Analytics",
  title: "Total Spend Summary",
  description:
    "Monthly spend for the period with prior-year comparison, plus breakdowns by property and by category.",
  permission: "reports.spend_summary",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  estimateRows: async () => 0, // three small summary sheets; never background

  async fetch(scope, period) {
    const [months, properties, categories, totals] = await Promise.all([
      spendByMonth(scope, period),
      spendByProperty(scope, period),
      spendByCategory(scope, period, { level: "parent" }),
      spendTotals(scope, period),
    ]);

    let running = 0;
    const monthRows = months.map((m, idx) => {
      const amount = Number(m.amount) || 0;
      const prior = Number(m.prior_amount) || 0;
      const prevMonth = idx > 0 ? Number(months[idx - 1].amount) || 0 : null;
      running += amount;
      return {
        month: monthLabel(m.month_start),
        amount,
        prior_amount: prior || null,
        yoy: change(amount, prior),
        // The first month of the window has nothing before it in range; an
        // em dash would be a string in a numeric column, so leave it empty.
        mom: idx === 0 ? null : change(amount, prevMonth),
        cumulative: running,
      };
    });

    const total = Number(totals.amount) || 0;
    const share = shareOf(total);

    const propertyRows = properties.map((p) => {
      const amount = Number(p.amount) || 0;
      const prior = Number(p.prior_amount) || 0;
      const keys = p.keys ? Number(p.keys) : null;
      return {
        hotel_name: p.hotel_name || `Business unit ${p.hotel_id}`,
        city: p.city || "—",
        keys,
        amount,
        share: share(amount),
        prior_amount: prior || null,
        yoy: change(amount, prior),
        po_count: p.po_count,
        cost_per_key: keys ? Math.round(amount / keys) : null,
      };
    });

    const categoryRows = categories.map((c, idx) => {
      const amount = Number(c.amount) || 0;
      const prior = Number(c.prior_amount) || 0;
      return {
        rank: idx + 1,
        category: c.category || "Uncategorised",
        amount,
        share: share(amount),
        prior_amount: prior || null,
        yoy: change(amount, prior),
        vendor_count: c.vendor_count,
        po_count: c.po_count,
      };
    });

    return { rows: monthRows, monthRows, propertyRows, categoryRows, totals, period };
  },

  // The preview shows the monthly sheet — the one a user checks a period
  // against. `rows` is that sheet, which is why fetch aliases it.
  preview({ monthRows }) {
    return {
      columns: MONTH_COLUMNS.map(({ header, key, type, align }) => ({ header, key, type, align })),
      rows: monthRows,
    };
  },

  buildWorkbook(wb, data, { generatedBy }) {
    const { monthRows, propertyRows, categoryRows, period, totals } = data;
    const asOf = istDateLabel(new Date());
    const scopeNote = ["Scope", "Approved purchase orders only; drafts, rejected and cancelled excluded"];
    const priorTotal = Number(totals.prior_amount) || 0;

    const ws1 = reportSheet(wb, "Monthly Summary", { footerTitle: "Total Spend Summary" });
    writeReportSheet(ws1, {
      title: "Total Spend Summary",
      subtitle: `FY ${period.label} · All business units in scope · All amounts in ₹`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Comparison", `vs ${period.priorLabel}`],
        scopeNote,
        ["Currency", "INR (₹), figures in absolute rupees"],
        ["As of", asOf],
      ],
      columns: MONTH_COLUMNS.map((c) => ({
        ...c,
        total:
          c.key === "yoy"
            ? ({ totalRow }) => ({ formula: `IF(C${totalRow}=0,"",(B${totalRow}-C${totalRow})/C${totalRow})` })
            : c.total,
      })),
      rows: monthRows,
      totalLabel: "Total",
      freezeCols: 1,
      generatedBy,
      asOf,
    });

    const ws2 = reportSheet(wb, "By Property", { footerTitle: "Total Spend Summary — By Property" });
    writeReportSheet(ws2, {
      title: "Spend by Property",
      subtitle: `${propertyRows.length} business unit(s) · FY ${period.label} · All amounts in ₹`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Sort", "Descending by spend"],
        ["Cost per Key", "Blank where the business unit has no room count recorded"],
        scopeNote,
        ["As of", asOf],
      ],
      columns: PROPERTY_COLUMNS.map((c) => ({ ...c, total: c.key === "share" ? () => 1 : c.total })),
      rows: propertyRows,
      totalLabel: "Total",
      freezeCols: 1,
      generatedBy,
      asOf,
    });

    const ws3 = reportSheet(wb, "Top Categories", { footerTitle: "Total Spend Summary — Categories" });
    writeReportSheet(ws3, {
      title: "Spend by Category",
      subtitle: `${categoryRows.length} categor(ies) ranked by spend · FY ${period.label} · All amounts in ₹`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Granularity", "Top-level category (sub-categories rolled up)"],
        ["Comparison", `vs ${period.priorLabel}${priorTotal ? "" : " — no prior-period spend in scope"}`],
        scopeNote,
        ["As of", asOf],
      ],
      columns: CATEGORY_COLUMNS.map((c) => ({ ...c, total: c.key === "share" ? () => 1 : c.total })),
      rows: categoryRows,
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    return wb;
  },
};
