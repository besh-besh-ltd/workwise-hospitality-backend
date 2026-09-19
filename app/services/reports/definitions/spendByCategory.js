// ============================================================================
// 1.2 — Spend by Category
// ----------------------------------------------------------------------------
// The same spend seen at two grains and then crossed with property. Sheet 1
// rolls sub-categories into their parent, sheet 2 reports the sub-category
// itself, and both total to the same number — which is the double-count guard
// holding at two levels rather than one.
//
// Departures from prototypes/report_samples/1.2_Spend_by_Category_FY26.xlsx:
//   • GST Slab and GL Code are dropped. GST lives on a quote line, not on a
//     category, and there is no GL code anywhere in the schema.
//   • Default Department is dropped — tbl_department is a global three-column
//     lookup with no link to a category.
// ============================================================================

import { FMT, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import {
  spendByCategory,
  spendByCategoryProperty,
  spendTotals,
} from "../../../models/reportsModel.js";

const change = (a, b) => (b && b !== 0 ? (a - b) / b : null);

const CATEGORY_COLUMNS = [
  { header: "Rank", key: "rank", width: 7, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Category", key: "category", width: 34, type: "text" },
  { header: "Actual (₹)", key: "amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Share %", key: "share", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Prior Year (₹)", key: "prior_amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "YoY %", key: "yoy", width: 10, align: "right", numFmt: FMT.PCT_VAR, type: "percent" },
  { header: "Vendors", key: "vendor_count", width: 10, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "POs", key: "po_count", width: 8, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Avg PO Value (₹)", key: "avg_po", width: 17, align: "right", numFmt: FMT.INR, type: "money" },
];

const SUB_COLUMNS = [
  { header: "#", key: "rank", width: 6, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Category", key: "parent_category", width: 28, type: "text" },
  { header: "Sub-Category", key: "category", width: 32, type: "text" },
  { header: "Actual (₹)", key: "amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Share % (overall)", key: "share", width: 15, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Share % (category)", key: "share_of_parent", width: 16, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Vendors", key: "vendor_count", width: 10, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "POs", key: "po_count", width: 8, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
];

function decorate(rows, total) {
  return rows.map((c, idx) => {
    const amount = Number(c.amount) || 0;
    const prior = Number(c.prior_amount) || 0;
    return {
      rank: idx + 1,
      category_id: c.category_id,
      category: c.category || "Uncategorised",
      parent_category: c.parent_category || c.category || "Uncategorised",
      amount,
      share: total > 0 ? amount / total : null,
      prior_amount: prior || null,
      yoy: change(amount, prior),
      vendor_count: c.vendor_count,
      po_count: c.po_count,
      avg_po: c.po_count ? Math.round(amount / c.po_count) : null,
    };
  });
}

export default {
  key: "spend_by_category",
  number: "1.2",
  family: "Spend Analytics",
  title: "Spend by Category",
  description:
    "Category and sub-category spend with prior-year comparison, and a category-by-property grid.",
  permission: "reports.spend_by_category",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const [parents, leaves, grid, totals] = await Promise.all([
      spendByCategory(scope, period, { level: "parent" }),
      spendByCategory(scope, period, { level: "leaf" }),
      spendByCategoryProperty(scope, period, { level: "parent" }),
      spendTotals(scope, period),
    ]);

    const total = Number(totals.amount) || 0;
    const categoryRows = decorate(parents, total);
    const subRows = decorate(leaves, total);

    // Share of the parent category, so a sub-category reads in the context a
    // buyer thinks in ("62% of our housekeeping spend"), not just of the chain.
    const parentTotals = new Map();
    for (const r of subRows) {
      const k = r.parent_category;
      parentTotals.set(k, (parentTotals.get(k) || 0) + r.amount);
    }
    for (const r of subRows) {
      const pt = parentTotals.get(r.parent_category) || 0;
      r.share_of_parent = pt > 0 ? r.amount / pt : null;
    }

    // Long rows -> a grid. Pivoting here rather than in SQL keeps the column
    // list out of the query string.
    const hotels = [];
    const seen = new Set();
    for (const g of grid) {
      const key = g.hotel_id ?? 0;
      if (!seen.has(key)) {
        seen.add(key);
        hotels.push({ id: key, name: g.hotel_name || "Unassigned" });
      }
    }
    hotels.sort((a, b) => a.name.localeCompare(b.name));

    const byCategory = new Map();
    for (const g of grid) {
      const row = byCategory.get(g.category_id) || { category: g.category || "Uncategorised", cells: {}, total: 0 };
      const amt = Number(g.amount) || 0;
      row.cells[g.hotel_id ?? 0] = (row.cells[g.hotel_id ?? 0] || 0) + amt;
      row.total += amt;
      byCategory.set(g.category_id, row);
    }
    const gridRows = [...byCategory.values()]
      .sort((a, b) => b.total - a.total)
      .map((r) => {
        const out = { category: r.category, grid_total: r.total, share: total > 0 ? r.total / total : null };
        for (const h of hotels) out[`h_${h.id}`] = r.cells[h.id] ?? null;
        return out;
      });

    return { rows: categoryRows, categoryRows, subRows, gridRows, hotels, period, total };
  },

  preview({ categoryRows }) {
    return {
      columns: CATEGORY_COLUMNS.map(({ header, key, type, align }) => ({ header, key, type, align })),
      rows: categoryRows,
    };
  },

  buildWorkbook(wb, data, { generatedBy }) {
    const { categoryRows, subRows, gridRows, hotels, period } = data;
    const asOf = istDateLabel(new Date());
    const scopeNote = ["Scope", "Approved purchase orders only; drafts, rejected and cancelled excluded"];

    const ws1 = reportSheet(wb, "Categories", { footerTitle: "Spend by Category" });
    writeReportSheet(ws1, {
      title: "Spend by Category",
      subtitle: `${categoryRows.length} categor(ies) · FY ${period.label} · All amounts in ₹`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Comparison", `vs ${period.priorLabel}`],
        ["Granularity", "Top-level category (sub-categories rolled up)"],
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

    const ws2 = reportSheet(wb, "Sub-Categories", { footerTitle: "Spend by Sub-Category" });
    writeReportSheet(ws2, {
      title: "Spend by Sub-Category",
      subtitle: `${subRows.length} sub-categor(ies) · FY ${period.label} · All amounts in ₹`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Granularity", "Sub-category (the grain a line is actually bought at)"],
        ["Reconciliation", "Totals the same as the Categories sheet"],
        scopeNote,
        ["As of", asOf],
      ],
      columns: SUB_COLUMNS.map((c) => ({ ...c, total: c.key === "share" ? () => 1 : c.total })),
      rows: subRows,
      totalLabel: "Total",
      freezeCols: 3,
      generatedBy,
      asOf,
    });

    // The grid's columns depend on which properties are in scope, so they are
    // built per run rather than declared.
    const gridColumns = [
      { header: "Category", key: "category", width: 32, type: "text" },
      ...hotels.map((h) => ({
        header: h.name,
        key: `h_${h.id}`,
        width: 16,
        align: "right",
        numFmt: FMT.INR,
        type: "money",
        total: "sum",
      })),
      { header: "Total (₹)", key: "grid_total", width: 17, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
      { header: "Share %", key: "share", width: 10, align: "right", numFmt: FMT.PCT, type: "percent", total: () => 1 },
    ];

    const ws3 = reportSheet(wb, "Category x Property", { footerTitle: "Category x Property" });
    writeReportSheet(ws3, {
      title: "Category × Property",
      subtitle: `${gridRows.length} categor(ies) × ${hotels.length} propert(ies) · FY ${period.label} · ₹`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Reading", "A blank cell means that property bought nothing in that category"],
        ["Sort", "Categories descending by total spend"],
        scopeNote,
        ["As of", asOf],
      ],
      columns: gridColumns,
      rows: gridRows,
      totalLabel: "Total",
      freezeCols: 1,
      generatedBy,
      asOf,
    });

    return wb;
  },
};
