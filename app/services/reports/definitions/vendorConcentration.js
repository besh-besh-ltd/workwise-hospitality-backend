// ============================================================================
// 2.2 — Vendor Concentration Risk
// ----------------------------------------------------------------------------
// How exposed each category is to one supplier, and how exposed the company is
// to one vendor overall. The question behind it is "what happens if this
// supplier stops tomorrow", which is why the single-source sheet matters more
// than the index.
//
// ── On the word "single source" ─────────────────────────────────────────────
// It means OBSERVED, not approved: an item we happened to buy from one vendor
// in this period. The platform holds no approved-supplier list per item, so it
// cannot say whether an alternative was available and unused. The sheet says
// so rather than implying a qualification gap that may not exist.
// ============================================================================

import { FMT, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import { categoryVendorSpend, singleSourceItems, spendTotals } from "../../../models/reportsModel.js";

/** Board-reportable exposure — any single vendor above this share of spend. */
const BOARD_THRESHOLD = 0.1;

/**
 * Herfindahl-Hirschman Index: the sum of squared percentage shares.
 * Below 1500 is competitive, 1500-2500 moderate, above 2500 concentrated.
 */
function hhiOf(shares) {
  return Math.round(shares.reduce((s, x) => s + (x * 100) ** 2, 0));
}

/** The sample's rating bands, kept verbatim so the two packs agree. */
function ratingOf({ topShare, top3Share, vendors }) {
  if (vendors < 2 || topShare > 0.6) return "Critical";
  if (topShare > 0.35 || top3Share > 0.75) return "High";
  if (topShare >= 0.2) return "Medium";
  return vendors >= 4 ? "Low" : "Medium";
}

const CATEGORY_COLUMNS = [
  { header: "Rank", key: "rank", width: 7, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Category", key: "category", width: 32, type: "text" },
  { header: "Spend (₹)", key: "amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Vendors", key: "vendors", width: 10, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Top Vendor", key: "top_vendor", width: 28, type: "text" },
  { header: "Top %", key: "top_share", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Top-3 %", key: "top3_share", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "HHI", key: "hhi", width: 9, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Rating", key: "rating", width: 11, align: "center", type: "text" },
  { header: "Single Source?", key: "single_source", width: 14, align: "center", type: "text" },
];

const EXPOSURE_COLUMNS = [
  { header: "Rank", key: "rank", width: 7, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Vendor", key: "vendor_name", width: 34, type: "text" },
  { header: "Largest Category", key: "top_category", width: 30, type: "text" },
  { header: "Spend (₹)", key: "amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Share %", key: "share", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Board-Reportable", key: "board", width: 17, align: "center", type: "text" },
];

const SINGLE_COLUMNS = [
  { header: "#", key: "rank", width: 6, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Item", key: "item_name", width: 42, type: "text" },
  { header: "Sole Supplier (observed)", key: "vendor_name", width: 32, type: "text" },
  { header: "Quantity", key: "qty", width: 11, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Spend (₹)", key: "amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
];

export default {
  key: "vendor_concentration",
  number: "2.2",
  family: "Vendor Reports",
  title: "Vendor Concentration Risk",
  description:
    "Per-category supplier concentration, largest single-vendor exposures and single-source items.",
  permission: "reports.vendor_concentration",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  estimateRows: async () => 0,

  async fetch(scope, period) {
    const [pairs, singles, totals] = await Promise.all([
      categoryVendorSpend(scope, period),
      singleSourceItems(scope, period),
      spendTotals(scope, period),
    ]);

    const total = Number(totals.amount) || 0;

    // One pass over (category, vendor) pairs — every figure on sheet 1 comes
    // from the same array, so the shares and the index cannot disagree.
    const byCategory = new Map();
    for (const p of pairs) {
      const acc = byCategory.get(p.category_id) || { category: p.category || "Uncategorised", vendors: [] };
      acc.vendors.push({ name: p.vendor_name || `Vendor ${p.vendor_id}`, amount: Number(p.amount) || 0 });
      byCategory.set(p.category_id, acc);
    }

    const categoryRows = [...byCategory.values()]
      .map((c) => {
        const sorted = [...c.vendors].sort((a, b) => b.amount - a.amount);
        const amount = sorted.reduce((s, v) => s + v.amount, 0);
        const shares = amount > 0 ? sorted.map((v) => v.amount / amount) : [];
        const topShare = shares[0] ?? null;
        const top3Share = shares.slice(0, 3).reduce((s, x) => s + x, 0) || null;
        return {
          category: c.category,
          amount,
          vendors: sorted.length,
          top_vendor: sorted[0]?.name || "—",
          top_share: topShare,
          top3_share: top3Share,
          hhi: hhiOf(shares),
          rating: ratingOf({ topShare: topShare ?? 1, top3Share: top3Share ?? 1, vendors: sorted.length }),
          single_source: sorted.length === 1 ? "Yes" : "—",
        };
      })
      .sort((a, b) => b.amount - a.amount)
      .map((r, idx) => ({ ...r, rank: idx + 1 }));

    // Vendor-level exposure across every category.
    const byVendor = new Map();
    for (const p of pairs) {
      const k = p.vendor_id;
      const acc = byVendor.get(k) || { vendor_name: p.vendor_name || `Vendor ${k}`, amount: 0, cats: [] };
      acc.amount += Number(p.amount) || 0;
      acc.cats.push({ category: p.category, amount: Number(p.amount) || 0 });
      byVendor.set(k, acc);
    }
    const exposureRows = [...byVendor.values()]
      .sort((a, b) => b.amount - a.amount)
      .map((v, idx) => {
        const share = total > 0 ? v.amount / total : null;
        const topCat = [...v.cats].sort((a, b) => b.amount - a.amount)[0];
        return {
          rank: idx + 1,
          vendor_name: v.vendor_name,
          top_category: topCat?.category || "—",
          amount: v.amount,
          share,
          board: share !== null && share > BOARD_THRESHOLD ? "Yes" : "—",
        };
      });

    const singleRows = singles.map((s, idx) => ({
      rank: idx + 1,
      item_name: s.item_name,
      vendor_name: s.vendor_name || `Vendor ${s.vendor_id}`,
      qty: Math.round(Number(s.qty) || 0),
      amount: Number(s.amount) || 0,
    }));

    return { rows: categoryRows, categoryRows, exposureRows, singleRows, period, total };
  },

  preview({ categoryRows }) {
    return {
      columns: CATEGORY_COLUMNS.map(({ header, key, type, align }) => ({ header, key, type, align })),
      rows: categoryRows,
    };
  },

  buildWorkbook(wb, { categoryRows, exposureRows, singleRows, period }, { generatedBy }) {
    const asOf = istDateLabel(new Date());

    const ws1 = reportSheet(wb, "Category Risk", { footerTitle: "Vendor Concentration Risk" });
    writeReportSheet(ws1, {
      title: "Vendor Concentration Risk — by Category",
      subtitle: `${categoryRows.length} categor(ies) · FY ${period.label} · All amounts in ₹`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Rating", "Low: top < 20% and 4+ vendors · Medium: 20–35% · High: 35–60% or top-3 > 75% · Critical: top > 60% or fewer than 2 vendors"],
        ["HHI", "Sum of squared vendor shares. Below 1,500 competitive · 1,500–2,500 moderate · above 2,500 concentrated"],
        ["Sort", "Largest categories first"],
        ["As of", asOf],
      ],
      columns: CATEGORY_COLUMNS,
      rows: categoryRows,
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    const ws2 = reportSheet(wb, "Vendor Exposures", { footerTitle: "Largest Vendor Exposures" });
    writeReportSheet(ws2, {
      title: "Largest Single-Vendor Exposures",
      subtitle: `${exposureRows.length} vendor(s) · FY ${period.label} · All amounts in ₹`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Board-reportable", `Any single vendor above ${BOARD_THRESHOLD * 100}% of total spend`],
        ["Action", "A mitigation plan is expected for each board-reportable exposure"],
        ["As of", asOf],
      ],
      columns: EXPOSURE_COLUMNS.map((c) => (c.key === "share" ? { ...c, total: () => 1 } : c)),
      rows: exposureRows,
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    const ws3 = reportSheet(wb, "Single-Source Items", { footerTitle: "Single-Source Items" });
    writeReportSheet(ws3, {
      title: "Single-Source Items",
      subtitle: `${singleRows.length} item(s) bought from exactly one supplier · FY ${period.label}`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        [
          "Definition",
          "Observed, not approved: bought from one supplier this period. The platform holds no approved-supplier list per item, so this does not by itself mean no alternative exists.",
        ],
        ["Action", "Qualify a second supplier for the largest of these"],
        ["Sort", "Largest spend first"],
        ["As of", asOf],
      ],
      columns: SINGLE_COLUMNS,
      rows: singleRows,
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    return wb;
  },
};
