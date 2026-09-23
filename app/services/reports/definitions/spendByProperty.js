// ============================================================================
// 1.3 — Spend by Property
// ----------------------------------------------------------------------------
// Spend per business unit, and then the reason a group procurement team asks
// for this report at all: the same item bought at materially different rates
// across properties, ranked by what consolidating it would be worth.
//
// Departures from prototypes/report_samples/1.3_Spend_by_Property_Outlet.xlsx:
//   • The "By Outlet" sheet is not here. The hierarchy stops at the business
//     unit — there is no outlet entity — so covers, cost per cover and F&B
//     revenue have nothing to come from. The catalogue records this.
//   • Occupancy %, CPAR and Spend % of Revenue are dropped for the same
//     reason: no occupancy and no revenue are captured.
//   • Cost per Key stays, blank until room counts are entered.
// ============================================================================

import { FMT, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import {
  spendByProperty,
  interPropertyRateVariance,
  spendTotals,
} from "../../../models/reportsModel.js";

const change = (a, b) => (b && b !== 0 ? (a - b) / b : null);

const PROPERTY_COLUMNS = [
  { header: "Rank", key: "rank", width: 7, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Property", key: "hotel_name", width: 34, type: "text" },
  { header: "City", key: "city", width: 16, type: "text" },
  { header: "Keys", key: "keys", width: 8, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Actual (₹)", key: "amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Share %", key: "share", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Prior Year (₹)", key: "prior_amount", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "YoY %", key: "yoy", width: 10, align: "right", numFmt: FMT.PCT_VAR, type: "percent" },
  { header: "POs", key: "po_count", width: 8, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Cost per Key (₹)", key: "cost_per_key", width: 16, align: "right", numFmt: FMT.INR, type: "money" },
];

const VARIANCE_COLUMNS = [
  { header: "#", key: "rank", width: 6, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Item", key: "item_name", width: 40, type: "text" },
  { header: "Unit", key: "unit", width: 9, align: "center", type: "text" },
  { header: "Properties", key: "properties", width: 11, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Lowest Rate (₹)", key: "min_rate", width: 15, align: "right", numFmt: FMT.INR_2, type: "money" },
  { header: "Highest Rate (₹)", key: "max_rate", width: 16, align: "right", numFmt: FMT.INR_2, type: "money" },
  { header: "Wtd Avg Rate (₹)", key: "wtd_avg_rate", width: 16, align: "right", numFmt: FMT.INR_2, type: "money" },
  { header: "Spread %", key: "spread", width: 11, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Qty", key: "total_qty", width: 10, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Value (₹)", key: "total_value", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Save Potential (₹)", key: "save_potential", width: 18, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
];

export default {
  key: "spend_by_property",
  number: "1.3",
  family: "Spend Analytics",
  title: "Spend by Property",
  description:
    "Per-property spend and ranking, plus items whose rate varies materially between properties.",
  permission: "reports.spend_by_property",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const [properties, variance, totals] = await Promise.all([
      spendByProperty(scope, period),
      interPropertyRateVariance(scope, period),
      spendTotals(scope, period),
    ]);

    const total = Number(totals.amount) || 0;

    const propertyRows = properties.map((p, idx) => {
      const amount = Number(p.amount) || 0;
      const prior = Number(p.prior_amount) || 0;
      const keys = p.keys ? Number(p.keys) : null;
      return {
        rank: idx + 1,
        hotel_name: p.hotel_name || `Business unit ${p.hotel_id}`,
        city: p.city || "—",
        keys,
        amount,
        share: total > 0 ? amount / total : null,
        prior_amount: prior || null,
        yoy: change(amount, prior),
        po_count: p.po_count,
        cost_per_key: keys ? Math.round(amount / keys) : null,
      };
    });

    const varianceRows = variance.map((v, idx) => {
      const min = Number(v.min_rate) || 0;
      const max = Number(v.max_rate) || 0;
      return {
        rank: idx + 1,
        item_name: v.item_name,
        unit: v.unit || "—",
        properties: v.properties,
        min_rate: min,
        max_rate: max,
        wtd_avg_rate: Number(v.wtd_avg_rate) || 0,
        // Against the lowest rate, which is the one a buyer can point at and
        // say "we already pay this somewhere".
        spread: min > 0 ? (max - min) / min : null,
        total_qty: Number(v.total_qty) || 0,
        total_value: Number(v.total_value) || 0,
        save_potential: Math.max(0, Math.round(Number(v.save_potential) || 0)),
      };
    });

    return { rows: propertyRows, propertyRows, varianceRows, period };
  },

  preview({ propertyRows }) {
    return {
      columns: PROPERTY_COLUMNS.map(({ header, key, type, align }) => ({ header, key, type, align })),
      rows: propertyRows,
    };
  },

  buildWorkbook(wb, data, { generatedBy }) {
    const { propertyRows, varianceRows, period } = data;
    const asOf = istDateLabel(new Date());
    const scopeNote = ["Scope", "Approved purchase orders only; drafts, rejected and cancelled excluded"];

    const ws1 = reportSheet(wb, "By Property", { footerTitle: "Spend by Property" });
    writeReportSheet(ws1, {
      title: "Spend by Property",
      subtitle: `${propertyRows.length} business unit(s) · FY ${period.label} · All amounts in ₹`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Comparison", `vs ${period.priorLabel}`],
        ["Sort", "Descending by spend"],
        ["Cost per Key", "Blank where the business unit has no room count recorded"],
        scopeNote,
        ["As of", asOf],
      ],
      columns: PROPERTY_COLUMNS.map((c) => ({ ...c, total: c.key === "share" ? () => 1 : c.total })),
      rows: propertyRows,
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    const ws2 = reportSheet(wb, "Rate Variance", { footerTitle: "Inter-Property Rate Variance" });
    writeReportSheet(ws2, {
      title: "Inter-Property Rate Variance",
      subtitle: `${varianceRows.length} item(s) bought at different rates across properties · FY ${period.label}`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Included", "Items bought at two or more properties, at the same unit, where the rate differs by more than 10%"],
        ["Rate basis", "Value ÷ quantity actually paid per property, not the quoted unit price"],
        ["Very large spreads", "A spread of several hundred percent is usually a unit-of-measure or data-entry inconsistency rather than a price difference. Worth checking either way."],
        [
          "Save Potential",
          "What the same volume would have cost at the lowest observed rate. An upper bound — it assumes that rate was available everywhere.",
        ],
        ["Action", "Consider consolidating the largest into a group rate contract"],
        ["As of", asOf],
      ],
      columns: VARIANCE_COLUMNS,
      rows: varianceRows,
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    return wb;
  },
};
