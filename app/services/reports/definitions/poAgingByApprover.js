// ============================================================================
// 3.2 — PO Aging by Approver
// ----------------------------------------------------------------------------
// What is waiting, who it is waiting on, and how long it has been waiting.
// The only report in the pack that names individuals as the bottleneck, which
// is exactly why its definitions have to be defensible.
//
// ── Two of them ─────────────────────────────────────────────────────────────
//
// A step with decision rule ANY lists EVERY pending approver, not one. Until
// somebody acts, each of them is equally the reason it has not moved, and
// picking one to name would be arbitrary.
//
// A step with no SLA recorded is UNMEASURED, not compliant and not in breach.
// Those rows render "—" and are excluded from breach counts entirely. The
// alternative — defaulting to some plausible number of hours — would report
// most of the company as late on the day this ships, off a target nobody set.
// SLA is configured per approval policy step (tbl_approval_policy_steps).
// ============================================================================

import { FMT, istDate, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import { pendingPoApprovals } from "../../../models/reportsModel.js";

const hrs = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

const QUEUE_COLUMNS = [
  { header: "#", key: "rank", width: 6, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "PO Number", key: "po_number", width: 20, type: "text" },
  { header: "PO Value (₹)", key: "total_value", width: 16, align: "right", numFmt: FMT.INR, type: "money" },
  { header: "Vendor", key: "vendor_name", width: 28, type: "text" },
  { header: "Property", key: "hotel_name", width: 28, type: "text" },
  { header: "Department", key: "department", width: 20, type: "text" },
  { header: "Step", key: "step_label", width: 9, align: "center", type: "text" },
  { header: "Rule", key: "decision_rule", width: 8, align: "center", type: "text" },
  { header: "Approver", key: "approver_name", width: 26, type: "text" },
  { header: "Role", key: "approver_designation", width: 26, type: "text" },
  { header: "Waiting Since", key: "step_opened_at", width: 18, align: "center", numFmt: FMT.DATE_TIME, type: "date" },
  { header: "Hours Pending", key: "hours_pending", width: 14, align: "right", numFmt: "0.0", type: "int" },
  { header: "SLA (hrs)", key: "sla_hours", width: 11, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Breach By (hrs)", key: "breach_by", width: 15, align: "right", numFmt: "0.0", type: "int" },
];

const BY_APPROVER_COLUMNS = [
  { header: "Approver", key: "approver_name", width: 28, type: "text" },
  { header: "Role", key: "approver_designation", width: 28, type: "text" },
  { header: "Pending", key: "pending", width: 10, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Pending Value (₹)", key: "pending_value", width: 18, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Avg Hours Waiting", key: "avg_hours", width: 17, align: "right", numFmt: "0.0", type: "int" },
  { header: "Oldest (hrs)", key: "oldest_hours", width: 13, align: "right", numFmt: "0.0", type: "int" },
  { header: "Measured", key: "measured", width: 11, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "SLA Breaches", key: "breaches", width: 13, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
];

const BREACH_COLUMNS = QUEUE_COLUMNS.filter((c) =>
  ["rank", "po_number", "total_value", "vendor_name", "approver_name", "approver_designation",
   "hours_pending", "sla_hours", "breach_by"].includes(c.key)
);

export default {
  key: "po_aging_by_approver",
  number: "3.2",
  family: "Purchase Orders",
  title: "PO Aging by Approver",
  description: "Approvals waiting, who they are waiting on, and which have passed their SLA.",
  permission: "reports.po_aging_by_approver",
  readiness: { state: "ready" },
  filters: [{ key: "hotel_ids", type: "hotels", label: "Business unit" }],


  async fetch(scope) {
    const raw = await pendingPoApprovals(scope);

    const rows = raw.map((r, idx) => {
      const pending = Number(r.hours_pending) || 0;
      const sla = r.sla_hours === null || r.sla_hours === undefined ? null : Number(r.sla_hours);
      return {
        rank: idx + 1,
        po_id: r.po_id,
        po_number: r.po_number,
        total_value: Number(r.total_value) || 0,
        vendor_name: r.vendor_name || "—",
        hotel_name: r.hotel_name || "—",
        department: r.department || "—",
        step_label: `L${r.step_order}`,
        decision_rule: r.decision_rule || "—",
        approver_id: r.approver_id,
        approver_name: r.approver_name || `User ${r.approver_id}`,
        approver_designation: r.approver_designation || "—",
        step_opened_at: istDate(r.step_opened_at),
        hours_pending: hrs(pending),
        sla_hours: sla,
        // Null, not zero, when there is no SLA: unmeasured is not compliant.
        breach_by: sla !== null && pending > sla ? hrs(pending - sla) : null,
      };
    });

    const byApprover = new Map();
    for (const r of rows) {
      const k = r.approver_id;
      const acc = byApprover.get(k) || {
        approver_name: r.approver_name,
        approver_designation: r.approver_designation,
        pending: 0, pending_value: 0, hoursSum: 0,
        oldest_hours: 0, measured: 0, breaches: 0,
      };
      acc.pending += 1;
      acc.pending_value += r.total_value;
      acc.hoursSum += r.hours_pending || 0;
      acc.oldest_hours = Math.max(acc.oldest_hours, r.hours_pending || 0);
      if (r.sla_hours !== null) {
        acc.measured += 1;
        if (r.breach_by !== null) acc.breaches += 1;
      }
      byApprover.set(k, acc);
    }
    const approverRows = [...byApprover.values()]
      .map((a) => ({
        ...a,
        avg_hours: a.pending ? hrs(a.hoursSum / a.pending) : null,
        oldest_hours: hrs(a.oldest_hours),
      }))
      .sort((a, b) => b.pending - a.pending || b.pending_value - a.pending_value);

    const breachRows = rows
      .filter((r) => r.breach_by !== null)
      .sort((a, b) => b.breach_by - a.breach_by)
      .map((r, idx) => ({ ...r, rank: idx + 1 }));

    const measured = rows.filter((r) => r.sla_hours !== null).length;

    return { rows, queueRows: rows, approverRows, breachRows, measured };
  },

  preview({ queueRows }) {
    return {
      columns: QUEUE_COLUMNS.map(({ header, key, type, align }) => ({ header, key, type, align })),
      rows: queueRows,
    };
  },

  buildWorkbook(wb, { queueRows, approverRows, breachRows, measured }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const slaNote = [
      "SLA",
      measured === queueRows.length
        ? "Configured on every approval step in this queue"
        : `Configured on ${measured} of ${queueRows.length} pending step(s). The rest show "—": unmeasured, not compliant and not in breach.`,
    ];
    const anyNote = [
      "Rule ANY",
      "Where a step can be approved by any one of several people, every one of them is listed — until somebody acts, each is equally the reason it has not moved.",
    ];

    const ws1 = reportSheet(wb, "Pending Queue", { footerTitle: "PO Aging by Approver" });
    writeReportSheet(ws1, {
      title: "PO Approvals Pending",
      subtitle: `${queueRows.length} pending approval task(s) · Longest waiting first`,
      params: [["As of", asOf], slaNote, anyNote, ["Sort", "Time pending, descending"]],
      columns: QUEUE_COLUMNS,
      rows: queueRows,
      totalLabel: undefined, // one row per approver task; a column sum would double-count PO value
      freezeCols: 2,
      generatedBy,
      asOf,
      footerLines: [
        "PO value repeats across rows where a step has several possible approvers; do not sum it.",
      ],
    });

    const ws2 = reportSheet(wb, "By Approver", { footerTitle: "PO Aging — By Approver" });
    writeReportSheet(ws2, {
      title: "Pending Approvals by Approver",
      subtitle: `${approverRows.length} approver(s) with something waiting`,
      params: [
        ["As of", asOf],
        slaNote,
        ["Measured", "How many of this approver's pending tasks have an SLA configured"],
        ["Sort", "Most pending first"],
      ],
      columns: BY_APPROVER_COLUMNS,
      rows: approverRows,
      totalLabel: "Total",
      freezeCols: 1,
      generatedBy,
      asOf,
    });

    const ws3 = reportSheet(wb, "SLA Breaches", { footerTitle: "PO Aging — SLA breaches" });
    writeReportSheet(ws3, {
      title: "Approvals Past Their SLA",
      subtitle:
        breachRows.length > 0
          ? `${breachRows.length} task(s) past the configured turnaround`
          : measured === 0
            ? "No SLA is configured on any approval step, so no breach can be reported"
            : "Nothing is past its SLA",
      params: [["As of", asOf], slaNote, ["Sort", "Worst overrun first"]],
      columns: BREACH_COLUMNS,
      rows: breachRows,
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    return wb;
  },
};
