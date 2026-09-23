// ============================================================================
// 3.3 — Rejected PO Log
// ----------------------------------------------------------------------------
// Every purchase order that did not go through, who stopped it, when, and why,
// and whether it was ever raised again.
//
// Replaces the sample's "Cancelled / Amended PO Log". Product dropped
// amendments — the platform has no PO revision trail — and asked for the
// rejection record instead, which the approval engine has kept all along.
//
// ── Three kinds, three sheets ───────────────────────────────────────────────
// "Rejected" means three different things with three different owners, and a
// single list blurs them:
//
//   Rejected by approver  a person in the approval chain said no, with a
//                         comment. On prod every one carries its approver,
//                         timestamp and comment.
//   Cancelled             the approval was cancelled, in practice because the
//                         RFQ was closed. Until the fix shipped alongside this
//                         report, the platform logged these as REJECT actions
//                         and left the PO showing "pending approval" forever.
//   Rejected by vendor    the supplier refused an approved order.
//
// Counting the first two together is the mistake to avoid: on prod it turns
// 47 rejections into 69.
//
// ── What is not here, and why ───────────────────────────────────────────────
// The sample groups by reason code (CAN-01…12). There are no reason codes:
// the reason is the approver's free-text comment, and on prod its median
// length is ten characters. The summary sheets group by approver and business
// unit instead, which are recorded.
//
// ACCESS: this report names individuals and quotes their decisions, so it is
// granted to Company Administrator only, like the Approval Audit Trail.
// ============================================================================

import { FMT, istDate, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import { rejectedPoLog } from "../../../models/reportsModel.js";

const KIND_LABEL = {
  REJECTED: "Rejected by approver",
  CANCELLED: "Cancelled",
  VENDOR_REJECTED: "Rejected by vendor",
};
const KINDS = ["REJECTED", "CANCELLED", "VENDOR_REJECTED"];

const NOT_RECORDED = "Not recorded";

const col = (header, key, width, extra = {}) => ({ header, key, width, type: "text", ...extra });
const money = (header, key, extra = {}) =>
  col(header, key, 16, { align: "right", numFmt: FMT.INR, type: "money", ...extra });
const date = (header, key, fmt = FMT.DATE) =>
  col(header, key, 17, { align: "center", numFmt: fmt, type: "date" });
const int = (header, key, width = 10, extra = {}) =>
  col(header, key, width, { align: "right", numFmt: FMT.INT, type: "int", ...extra });

const APPROVER_COLUMNS = [
  int("#", "rank", 6),
  col("PO Number", "po_number", 20),
  date("PO Date", "po_date"),
  date("Rejected On (IST)", "event_at", FMT.DATE_TIME),
  money("PO Value (₹)", "total_value", { total: "sum" }),
  col("Vendor", "vendor_name", 28),
  col("Property", "hotel_name", 26),
  col("Department", "department", 20),
  col("RFQ #", "rfq_no", 11, { align: "right" }),
  col("Step", "step_label", 7, { align: "center" }),
  col("Rejected By", "actor_name", 24),
  col("Role", "actor_designation", 24),
  col("Reason", "reason", 40),
  col("Re-raised As", "reraised_po_number", 18),
  col("Re-raised Status", "reraised_status", 16),
];

const CANCELLED_COLUMNS = [
  int("#", "rank", 6),
  col("PO Number", "po_number", 20),
  date("PO Date", "po_date"),
  date("Cancelled On (IST)", "event_at", FMT.DATE_TIME),
  money("PO Value (₹)", "total_value", { total: "sum" }),
  col("Vendor", "vendor_name", 28),
  col("Property", "hotel_name", 26),
  col("RFQ #", "rfq_no", 11, { align: "right" }),
  col("Cancelled By", "actor_name", 24),
  col("Reason", "reason", 44),
];

const VENDOR_COLUMNS = [
  int("#", "rank", 6),
  col("PO Number", "po_number", 20),
  date("PO Date", "po_date"),
  date("Rejected On (IST)", "event_at", FMT.DATE_TIME),
  money("PO Value (₹)", "total_value", { total: "sum" }),
  col("Vendor", "vendor_name", 28),
  col("Property", "hotel_name", 26),
  col("RFQ #", "rfq_no", 11, { align: "right" }),
  col("Vendor's Reason", "reason", 44),
  col("Re-raised As", "reraised_po_number", 18),
  col("Re-raised Status", "reraised_status", 16),
];

const SUMMARY_COLUMNS = [
  col("Kind", "kind_label", 24),
  int("POs", "count", 9, { total: "sum" }),
  col("Share %", "share", 10, { align: "right", numFmt: FMT.PCT, type: "percent" }),
  money("PO Value (₹)", "value", { total: "sum" }),
  int("Re-raised", "reraised", 11, { total: "sum" }),
  int("Not Re-raised", "not_reraised", 14, { total: "sum" }),
];

const BY_APPROVER_COLUMNS = [
  col("Approver", "actor_name", 26),
  col("Role", "actor_designation", 26),
  int("Rejections", "count", 11, { total: "sum" }),
  money("Value Rejected (₹)", "value", { total: "sum" }),
  col("Steps", "steps", 10, { align: "center" }),
  int("Re-raised", "reraised", 11, { total: "sum" }),
];

const BY_UNIT_COLUMNS = [
  col("Property", "hotel_name", 30),
  int("Rejected by Approver", "REJECTED", 19, { total: "sum" }),
  int("Cancelled", "CANCELLED", 11, { total: "sum" }),
  int("Rejected by Vendor", "VENDOR_REJECTED", 17, { total: "sum" }),
  int("Total", "total", 9, { total: "sum" }),
  money("PO Value (₹)", "value", { total: "sum" }),
];

// The preview lists all three kinds together, deliberately, rather than the
// first sheet: the runner disables Download when the preview is empty, and a
// period with only vendor rejections would otherwise look like nothing to
// report.
const PREVIEW_COLUMNS = [
  col("Kind", "kind_label", 20),
  col("PO Number", "po_number", 20),
  date("Decided On (IST)", "event_at", FMT.DATE_TIME),
  money("PO Value (₹)", "total_value"),
  col("Vendor", "vendor_name", 28),
  col("Property", "hotel_name", 26),
  col("By", "actor_name", 24),
  col("Reason", "reason", 40),
  col("Re-raised As", "reraised_po_number", 18),
];

function decorate(raw) {
  return raw.map((r) => ({
    kind: r.kind,
    kind_label: KIND_LABEL[r.kind] || r.kind,
    po_id: r.po_id,
    po_number: r.po_number,
    po_date: istDate(r.po_created_at),
    event_at: istDate(r.event_at),
    total_value: Number(r.total_value) || 0,
    vendor_name: r.vendor_name || "—",
    hotel_name: r.hotel_name || "—",
    department: r.department || "—",
    rfq_no: r.rfq_no ? String(r.rfq_no) : "—",
    step_label: r.step_order ? `L${r.step_order}` : "—",
    // A missing trail is shown as missing, never back-filled with a guess.
    actor_name: r.trail_missing ? NOT_RECORDED : r.actor_name || NOT_RECORDED,
    actor_designation: r.trail_missing ? "—" : r.actor_designation || "—",
    reason: r.reason && String(r.reason).trim() ? String(r.reason).trim() : r.trail_missing ? NOT_RECORDED : "—",
    reraised_po_number: r.reraised_po_number || "Not re-raised",
    reraised_status: r.reraised_status || "—",
    reraised: !!r.reraised_po_number,
    trail_missing: !!r.trail_missing,
  }));
}

const numbered = (rows) => rows.map((r, idx) => ({ ...r, rank: idx + 1 }));

export default {
  key: "po_rejections",
  number: "3.3",
  family: "Purchase Orders",
  title: "Rejected PO Log",
  description:
    "Every purchase order rejected by an approver, cancelled, or refused by the vendor: who, when, why, and whether it was raised again.",
  permission: "reports.po_rejections",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const rows = decorate(await rejectedPoLog(scope, period));
    const of = (k) => rows.filter((r) => r.kind === k);

    const totalCount = rows.length;
    const summaryRows = KINDS.map((k) => {
      const g = of(k);
      return {
        kind_label: KIND_LABEL[k],
        count: g.length,
        share: totalCount > 0 ? g.length / totalCount : null,
        value: g.reduce((s, r) => s + r.total_value, 0),
        reraised: g.filter((r) => r.reraised).length,
        not_reraised: g.filter((r) => !r.reraised).length,
      };
    });

    const byApprover = new Map();
    for (const r of of("REJECTED")) {
      const key = r.actor_name;
      const acc = byApprover.get(key) || {
        actor_name: r.actor_name,
        actor_designation: r.actor_designation,
        count: 0, value: 0, reraised: 0, stepSet: new Set(),
      };
      acc.count += 1;
      acc.value += r.total_value;
      if (r.reraised) acc.reraised += 1;
      if (r.step_label !== "—") acc.stepSet.add(r.step_label);
      byApprover.set(key, acc);
    }
    const approverRows = [...byApprover.values()]
      .map(({ stepSet, ...a }) => ({ ...a, steps: [...stepSet].sort().join(", ") || "—" }))
      .sort((a, b) => b.count - a.count || b.value - a.value);

    const byUnit = new Map();
    for (const r of rows) {
      const acc = byUnit.get(r.hotel_name) || {
        hotel_name: r.hotel_name, REJECTED: 0, CANCELLED: 0, VENDOR_REJECTED: 0, total: 0, value: 0,
      };
      acc[r.kind] += 1;
      acc.total += 1;
      acc.value += r.total_value;
      byUnit.set(r.hotel_name, acc);
    }
    const unitRows = [...byUnit.values()].sort((a, b) => b.total - a.total || b.value - a.value);

    return {
      rows,
      summaryRows,
      approverRejections: numbered(of("REJECTED")),
      cancellations: numbered(of("CANCELLED")),
      vendorRejections: numbered(of("VENDOR_REJECTED")),
      approverRows,
      unitRows,
      missingTrail: rows.filter((r) => r.trail_missing).length,
      period,
    };
  },

  preview({ rows }) {
    return {
      columns: PREVIEW_COLUMNS.map(({ header, key, type, align }) => ({ header, key, type, align })),
      rows,
    };
  },

  buildWorkbook(wb, data, { generatedBy }) {
    const {
      summaryRows, approverRejections, cancellations, vendorRejections,
      approverRows, unitRows, missingTrail, period,
    } = data;
    const asOf = istDateLabel(new Date());
    const periodParam = ["Reporting period", `FY ${period.label}`];
    const dated = ["Dated by", "When the decision was taken, not when the PO was raised"];
    const trailNote =
      missingTrail > 0
        ? [
            "Not recorded",
            `${missingTrail} PO(s) are marked rejected with no decision on record. They are listed, with the actor shown as not recorded, rather than left out.`,
          ]
        : null;
    const reasonNote = [
      "Reason",
      "The approver's own comment, as typed. There are no reason codes to group by.",
    ];

    const sheet = (name, footerTitle, spec) =>
      writeReportSheet(reportSheet(wb, name, { footerTitle }), { generatedBy, asOf, ...spec });

    sheet("Summary", "Rejected PO Log", {
      title: "Rejected PO Log — Summary",
      subtitle: `Purchase orders that did not go through · FY ${period.label} · All amounts in ₹`,
      params: [
        periodParam,
        ["Rejected by approver", "An approver in the chain declined the PO"],
        ["Cancelled", "The approval was cancelled, in practice because the RFQ was closed"],
        ["Rejected by vendor", "The supplier refused the approved order"],
        ["Re-raised", "A later PO on the same RFQ orders at least one of the same items"],
        dated,
        ...(trailNote ? [trailNote] : []),
      ],
      columns: SUMMARY_COLUMNS.map((c) => (c.key === "share" ? { ...c, total: () => 1 } : c)),
      rows: summaryRows,
      totalLabel: "Total",
    });

    sheet("Rejected by Approver", "Rejected PO Log — by approver", {
      title: "Rejected by Approver",
      subtitle: `${approverRejections.length} PO(s) · FY ${period.label} · Newest first`,
      params: [periodParam, dated, reasonNote, ["Step", "The approval level that rejected it (L1 is the first approver)"],
        ...(trailNote ? [trailNote] : [])],
      columns: APPROVER_COLUMNS,
      rows: approverRejections,
      totalLabel: approverRejections.length ? "Total" : undefined,
      freezeCols: 2,
    });

    sheet("Cancelled", "Rejected PO Log — cancelled", {
      title: "Cancelled",
      subtitle: `${cancellations.length} PO(s) · FY ${period.label} · Newest first`,
      params: [
        periodParam,
        dated,
        ["Cause", "The approval was cancelled, in practice because the RFQ was closed. The reason is the one given when it was closed."],
        ["Cancelled By", "The person who closed the RFQ"],
      ],
      columns: CANCELLED_COLUMNS,
      rows: cancellations,
      totalLabel: cancellations.length ? "Total" : undefined,
      freezeCols: 2,
    });

    sheet("Rejected by Vendor", "Rejected PO Log — by vendor", {
      title: "Rejected by Vendor",
      subtitle: `${vendorRejections.length} PO(s) · FY ${period.label} · Newest first`,
      params: [periodParam, dated, ["Vendor's Reason", "As the supplier entered it when refusing the order"]],
      columns: VENDOR_COLUMNS,
      rows: vendorRejections,
      totalLabel: vendorRejections.length ? "Total" : undefined,
      freezeCols: 2,
    });

    sheet("By Approver", "Rejected PO Log — approvers", {
      title: "Rejections by Approver",
      subtitle: `${approverRows.length} approver(s) · FY ${period.label}`,
      params: [periodParam, ["Scope", "Rejections by an approver only; cancellations and vendor refusals are not approver decisions"]],
      columns: BY_APPROVER_COLUMNS,
      rows: approverRows,
      totalLabel: approverRows.length ? "Total" : undefined,
      freezeCols: 1,
    });

    sheet("By Business Unit", "Rejected PO Log — business units", {
      title: "Rejections by Business Unit",
      subtitle: `${unitRows.length} business unit(s) · FY ${period.label}`,
      params: [periodParam, ["Sort", "Most POs first"]],
      columns: BY_UNIT_COLUMNS,
      rows: unitRows,
      totalLabel: unitRows.length ? "Total" : undefined,
      freezeCols: 1,
    });

    return wb;
  },
};
