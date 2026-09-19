// ============================================================================
// 3.1 — Open PO Register
// ----------------------------------------------------------------------------
// Every order that is raised and not yet closed out, oldest first, with an
// ageing profile underneath it.
//
// ── An honest column name ───────────────────────────────────────────────────
// The approved sample ages each order against its EXPECTED DELIVERY DATE and
// shows how much of it is still outstanding. Neither exists in this schema:
// a purchase order carries no promised-delivery date, and goods receipt is
// recorded as a document rather than a received quantity, so "60% pending"
// cannot be computed for any order.
//
// The column is therefore "Days Open" — age since the order was raised — and
// not "Days Overdue". They are very different claims, and reporting the first
// under the name of the second would have people chasing suppliers over
// deadlines nobody ever set.
// ============================================================================

import { FMT, istDate, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import { openPoRegister } from "../../../models/reportsModel.js";

const BUCKETS = [
  { label: "0-15", min: 0, max: 15 },
  { label: "16-30", min: 16, max: 30 },
  { label: "31-60", min: 31, max: 60 },
  { label: "61-90", min: 61, max: 90 },
  { label: "90+", min: 91, max: Infinity },
];

const CRITICAL_DAYS = 90;

const bucketFor = (days) => BUCKETS.find((b) => days >= b.min && days <= b.max)?.label || "90+";

const STATUS_LABELS = {
  approved: "Approved",
  sent: "Sent to vendor",
  dispatched: "Dispatched",
  invoice_raised: "Invoice raised",
  acceptance_pending: "Awaiting vendor acceptance",
};

const REGISTER_COLUMNS = [
  { header: "#", key: "rank", width: 6, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "PO Number", key: "po_number", width: 20, type: "text" },
  { header: "PO Date", key: "po_date", width: 14, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "Status", key: "status_label", width: 24, type: "text" },
  { header: "Property", key: "hotel_name", width: 30, type: "text" },
  { header: "Department", key: "department", width: 22, type: "text" },
  { header: "Vendor", key: "vendor_name", width: 30, type: "text" },
  { header: "RFQ #", key: "rfq_no", width: 12, align: "right", type: "text" },
  { header: "PO Value (₹)", key: "total_value", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Days Open", key: "days_open", width: 11, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Ageing", key: "bucket", width: 10, align: "center", type: "text" },
];

const SUMMARY_COLUMNS = [
  { header: "Ageing Bucket", key: "bucket", width: 16, type: "text" },
  { header: "PO Count", key: "count", width: 11, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "% Count", key: "count_share", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Open Value (₹)", key: "value", width: 17, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "% Value", key: "value_share", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Avg Days Open", key: "avg_days", width: 14, align: "right", numFmt: FMT.INT, type: "int" },
];

const CRITICAL_COLUMNS = [
  { header: "#", key: "rank", width: 6, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "PO Number", key: "po_number", width: 20, type: "text" },
  { header: "PO Date", key: "po_date", width: 14, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "Property", key: "hotel_name", width: 30, type: "text" },
  { header: "Vendor", key: "vendor_name", width: 30, type: "text" },
  { header: "Status", key: "status_label", width: 24, type: "text" },
  { header: "PO Value (₹)", key: "total_value", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Days Open", key: "days_open", width: 11, align: "right", numFmt: FMT.INT, type: "int" },
];

export default {
  key: "open_po_register",
  number: "3.1",
  family: "Purchase Orders",
  title: "Open PO Register",
  description: "Every open purchase order with its age, summarised by ageing bucket.",
  permission: "reports.open_po_register",
  readiness: { state: "ready" },
  filters: [{ key: "hotel_ids", type: "hotels", label: "Business unit" }],

  estimateRows: async () => 0,

  async fetch(scope) {
    const raw = await openPoRegister(scope);

    const rows = raw.map((r, idx) => {
      const days = Number(r.days_open) || 0;
      return {
        rank: idx + 1,
        po_number: r.po_number,
        po_date: istDate(r.created_at),
        status_label: STATUS_LABELS[r.status] || r.status,
        hotel_name: r.hotel_name || "—",
        department: r.department || "—",
        vendor_name: r.vendor_name || "—",
        rfq_no: r.rfq_no ? String(r.rfq_no) : "—",
        total_value: Number(r.total_value) || 0,
        days_open: days,
        bucket: bucketFor(days),
      };
    });

    const totalCount = rows.length;
    const totalValue = rows.reduce((s, r) => s + r.total_value, 0);
    const summaryRows = BUCKETS.map((b) => {
      const inBucket = rows.filter((r) => r.bucket === b.label);
      const value = inBucket.reduce((s, r) => s + r.total_value, 0);
      return {
        bucket: `${b.label} days`,
        count: inBucket.length,
        count_share: totalCount > 0 ? inBucket.length / totalCount : null,
        value,
        value_share: totalValue > 0 ? value / totalValue : null,
        avg_days: inBucket.length
          ? Math.round(inBucket.reduce((s, r) => s + r.days_open, 0) / inBucket.length)
          : null,
      };
    });

    const criticalRows = rows
      .filter((r) => r.days_open > CRITICAL_DAYS)
      .map((r, idx) => ({ ...r, rank: idx + 1 }));

    return { rows, registerRows: rows, summaryRows, criticalRows };
  },

  preview({ registerRows }) {
    return {
      columns: REGISTER_COLUMNS.map(({ header, key, type, align }) => ({ header, key, type, align })),
      rows: registerRows,
    };
  },

  buildWorkbook(wb, { registerRows, summaryRows, criticalRows }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const ageNote = [
      "Days Open",
      "Age since the order was raised. Not days overdue — a purchase order carries no promised delivery date.",
    ];

    const ws1 = reportSheet(wb, "Open POs", { footerTitle: "Open PO Register" });
    writeReportSheet(ws1, {
      title: "Open PO Register",
      subtitle: `${registerRows.length} open order(s) · Oldest first · All amounts in ₹`,
      params: [
        ["As of", asOf],
        ["Included", "Approved, sent, dispatched, invoice raised, and awaiting vendor acceptance"],
        ["Excluded", "Drafts, orders awaiting approval, rejected, cancelled and completed"],
        ageNote,
        ["Ageing buckets", "0-15 / 16-30 / 31-60 / 61-90 / 90+ days"],
      ],
      columns: REGISTER_COLUMNS,
      rows: registerRows,
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    const ws2 = reportSheet(wb, "Aging Summary", { footerTitle: "Open PO Ageing" });
    writeReportSheet(ws2, {
      title: "Open PO Ageing Summary",
      subtitle: "Count and value by ageing bucket",
      params: [["As of", asOf], ageNote, ["Buckets", "0-15 / 16-30 / 31-60 / 61-90 / 90+ days"]],
      columns: SUMMARY_COLUMNS.map((c) =>
        c.key === "count_share" || c.key === "value_share" ? { ...c, total: () => 1 } : c
      ),
      rows: summaryRows,
      totalLabel: "Total",
      generatedBy,
      asOf,
    });

    const ws3 = reportSheet(wb, "90+ Days", { footerTitle: "Open PO Register — 90+ days" });
    writeReportSheet(ws3, {
      title: `Open More Than ${CRITICAL_DAYS} Days`,
      subtitle:
        criticalRows.length > 0
          ? `${criticalRows.length} order(s) need a decision: chase, receive or close`
          : "Nothing has been open this long",
      params: [
        ["As of", asOf],
        ["Filter", `Days open > ${CRITICAL_DAYS}`],
        ["Action owner", "Property purchase manager"],
        [
          "Why it matters",
          "An order this old is usually already delivered and unrecorded, or abandoned. Either way the commitment it represents is wrong.",
        ],
      ],
      columns: CRITICAL_COLUMNS,
      rows: criticalRows,
      totalLabel: criticalRows.length ? "Total" : undefined,
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    return wb;
  },
};
