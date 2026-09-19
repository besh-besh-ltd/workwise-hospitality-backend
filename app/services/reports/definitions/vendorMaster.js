// ============================================================================
// 2.3 — Vendor Master Activity
// ----------------------------------------------------------------------------
// Who we buy from, when we last did, and how much they have had over their
// lifetime. The activity state is DERIVED from the last order rather than read
// off a field, because there is no vendor lifecycle status in this schema —
// tbl_users carries an integer `status` and an `is_deleted` flag and nothing
// else.
//
// That is also why the approved sample's "Blacklist & Hold Log" is not here:
// blacklisting and holding are not states this platform can represent, so
// there is nothing to list. The catalogue records it against report 2.3
// rather than the sheet quietly going missing.
//
// SCOPE NOTE: a vendor appears because they transacted on an order the caller
// can see — never because they exist. Listing the vendor master directly would
// hand every tenant the supplier base of all the others.
// ============================================================================

import { FMT, istDate, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import { vendorMasterActivity } from "../../../models/reportsModel.js";

/** Days since the last order, past which a vendor is no longer "active". */
const ACTIVE_DAYS = 90;
const DORMANT_DAYS = 365;

function activityOf(daysSince) {
  if (daysSince === null || daysSince === undefined) return "No orders";
  if (daysSince <= ACTIVE_DAYS) return "Active";
  if (daysSince <= DORMANT_DAYS) return "Dormant";
  return "Inactive";
}

const MASTER_COLUMNS = [
  { header: "#", key: "rank", width: 6, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Vendor ID", key: "vendor_id", width: 11, align: "right", type: "int" },
  { header: "Vendor Name", key: "vendor_name", width: 34, type: "text" },
  { header: "GSTIN", key: "gstin", width: 18, type: "text" },
  { header: "MSME", key: "msme", width: 8, align: "center", type: "text" },
  { header: "Onboarded", key: "onboarded_at", width: 14, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "Activity", key: "activity", width: 12, align: "center", type: "text" },
  { header: "Last Order", key: "last_po_at", width: 14, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "Days Since", key: "days_since", width: 11, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Period Spend (₹)", key: "period_amount", width: 17, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Period POs", key: "period_po_count", width: 11, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Lifetime Spend (₹)", key: "lifetime_amount", width: 19, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
];

const ONBOARD_COLUMNS = [
  { header: "#", key: "rank", width: 6, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Vendor Name", key: "vendor_name", width: 34, type: "text" },
  { header: "MSME", key: "msme", width: 8, align: "center", type: "text" },
  { header: "Onboarded", key: "onboarded_at", width: 14, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "First Order", key: "first_po_at", width: 14, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "Days to First Order", key: "tat_days", width: 18, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Period Spend (₹)", key: "period_amount", width: 17, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
];

const dayDiff = (a, b) => {
  if (!a || !b) return null;
  const d = Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
  return Number.isFinite(d) ? d : null;
};

export default {
  key: "vendor_master",
  number: "2.3",
  family: "Vendor Reports",
  title: "Vendor Master Activity",
  description:
    "The vendors you buy from, with last order, activity state, period spend and lifetime spend.",
  permission: "reports.vendor_master",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  estimateRows: async () => 0,

  async fetch(scope, period) {
    const raw = await vendorMasterActivity(scope, period);

    const rows = raw.map((v, idx) => {
      const daysSince = v.days_since_last_po === null ? null : Number(v.days_since_last_po);
      return {
        rank: idx + 1,
        vendor_id: v.vendor_id,
        vendor_name: v.vendor_name || `Vendor ${v.vendor_id}`,
        gstin: v.gstin || "—",
        msme: v.is_msme ? "Yes" : "—",
        onboarded_at: istDate(v.onboarded_at),
        activity: activityOf(daysSince),
        last_po_at: istDate(v.last_po_at),
        days_since: daysSince,
        period_amount: Number(v.period_amount) || 0,
        period_po_count: Number(v.period_po_count) || 0,
        lifetime_amount: Number(v.lifetime_amount) || 0,
        _first_po_at: v.first_po_at,
        _onboarded_raw: v.onboarded_at,
      };
    });

    // Onboarded during the period, judged by the account's creation date.
    const fromMs = new Date(`${period.from}T00:00:00Z`).getTime();
    const toMs = new Date(`${period.to}T00:00:00Z`).getTime();
    const onboardedRows = rows
      .filter((r) => {
        if (!r._onboarded_raw) return false;
        const t = new Date(r._onboarded_raw).getTime();
        return t >= fromMs && t < toMs;
      })
      .sort((a, b) => new Date(a._onboarded_raw) - new Date(b._onboarded_raw))
      .map((r, idx) => ({
        rank: idx + 1,
        vendor_name: r.vendor_name,
        msme: r.msme,
        onboarded_at: r.onboarded_at,
        first_po_at: istDate(r._first_po_at),
        tat_days: dayDiff(r._first_po_at, r._onboarded_raw),
        period_amount: r.period_amount,
      }));

    return { rows, masterRows: rows, onboardedRows, period };
  },

  preview({ masterRows }) {
    return {
      columns: MASTER_COLUMNS.map(({ header, key, type, align }) => ({ header, key, type, align })),
      rows: masterRows,
    };
  },

  buildWorkbook(wb, { masterRows, onboardedRows, period }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const derivedNote = [
      "Activity",
      `Derived from the last order, not from a status field — this platform holds no vendor lifecycle state. Active: ordered within ${ACTIVE_DAYS} days · Dormant: within ${DORMANT_DAYS} · Inactive: longer ago.`,
    ];
    const scopeNote = [
      "Included",
      "Vendors you have bought from on orders within your access. Not the full vendor master.",
    ];

    const ws1 = reportSheet(wb, "Vendor Master", { footerTitle: "Vendor Master Activity" });
    writeReportSheet(ws1, {
      title: "Vendor Master Activity",
      subtitle: `${masterRows.length} vendor(s) · FY ${period.label} · All amounts in ₹`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        scopeNote,
        derivedNote,
        ["Sort", "Lifetime spend, descending"],
        ["As of", asOf],
      ],
      columns: MASTER_COLUMNS,
      rows: masterRows,
      totalLabel: "Total",
      freezeCols: 3,
      generatedBy,
      asOf,
      footerLines: [
        "Blacklisted and on-hold vendors are not reported: this platform has no way to record either state.",
      ],
    });

    const ws2 = reportSheet(wb, "Onboarded in Period", { footerTitle: "Vendors onboarded" });
    writeReportSheet(ws2, {
      title: `Vendors Onboarded in FY ${period.label}`,
      subtitle:
        onboardedRows.length > 0
          ? `${onboardedRows.length} vendor(s) added during the period`
          : "No vendors you transact with were added during this period",
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Onboarded", "The date the vendor account was created"],
        ["Days to First Order", "From account creation to their first purchase order"],
        ["As of", asOf],
      ],
      columns: ONBOARD_COLUMNS,
      rows: onboardedRows,
      totalLabel: onboardedRows.length ? "Total" : undefined,
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    return wb;
  },
};
