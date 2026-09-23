// ============================================================================
// 5.1 — Approval Audit Trail
// ----------------------------------------------------------------------------
// Every approval decision taken on a purchase order, with who took it and
// when. This is the report an internal auditor opens, so what it claims has to
// be defensible line by line.
//
// ── The anomaly sheet, and how hard each flag is ────────────────────────────
//
// SELF-APPROVAL is a fact: the person who approved the order is the person who
// raised it. That is a segregation-of-duties breach under any reading, and it
// is the only flag here that needs no judgement.
//
// AFTER-HOURS is a HEURISTIC and is labelled as one. A decision taken at
// 23:00 IST is not wrong; it is unusual, and unusual is where an auditor
// starts looking. It is noted because a bulk-loaded or automated decision
// often shows up this way — on the staging data, half the events fall outside
// working hours precisely because they were seeded, not decided.
//
// The sample's "Matrix OK" column is dropped. It asserts that an order was
// approved at the authority level its value required, and this platform holds
// no value-based approval matrix to check against. A column that always said
// "Y" would be worse than no column at all.
// ============================================================================

import { FMT, istDate, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import { approvalAuditTrail } from "../../../models/reportsModel.js";

/** Outside this IST window a decision is flagged unusual, not wrong. */
const WORK_START_HOUR = 7;
const WORK_END_HOUR = 21;

const ACTION_LABELS = {
  APPROVE: "Approved",
  REJECT: "Rejected",
  CANCELLED: "Cancelled",
  POLICY_CHANGE: "Policy changed",
  APPROVER_REMOVED: "Approver removed",
  APPROVER_ADDED: "Approver added",
  STEP_REMOVED: "Step removed",
  STEP_ADDED: "Step added",
  MEMBERSHIP_REVALIDATION: "Membership revalidated",
};

const LOG_COLUMNS = [
  { header: "Event ID", key: "event_id", width: 11, align: "right", type: "int" },
  { header: "Timestamp (IST)", key: "occurred_at", width: 19, align: "center", numFmt: FMT.DATE_TIME, type: "date" },
  { header: "PO Number", key: "po_number", width: 20, type: "text" },
  { header: "PO Value (₹)", key: "total_value", width: 16, align: "right", numFmt: FMT.INR, type: "money" },
  { header: "Property", key: "hotel_name", width: 28, type: "text" },
  { header: "Step", key: "step_label", width: 8, align: "center", type: "text" },
  { header: "Decision", key: "action_label", width: 20, type: "text" },
  { header: "Actor", key: "actor_name", width: 26, type: "text" },
  { header: "Role", key: "actor_designation", width: 26, type: "text" },
  { header: "Comment", key: "comment", width: 40, type: "text" },
];

const ANOMALY_COLUMNS = [
  { header: "#", key: "rank", width: 6, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Timestamp (IST)", key: "occurred_at", width: 19, align: "center", numFmt: FMT.DATE_TIME, type: "date" },
  { header: "PO Number", key: "po_number", width: 20, type: "text" },
  { header: "PO Value (₹)", key: "total_value", width: 16, align: "right", numFmt: FMT.INR, type: "money" },
  { header: "Decision", key: "action_label", width: 20, type: "text" },
  { header: "Actor", key: "actor_name", width: 26, type: "text" },
  { header: "Finding", key: "finding", width: 40, type: "text" },
  { header: "Severity", key: "severity", width: 11, align: "center", type: "text" },
];

const MIX_COLUMNS = [
  { header: "Decision", key: "action_label", width: 24, type: "text" },
  { header: "Count", key: "count", width: 10, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "% of Total", key: "share", width: 12, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Value Decided (₹)", key: "value", width: 18, align: "right", numFmt: FMT.INR, type: "money" },
];

export default {
  key: "approval_audit_trail",
  number: "5.1",
  family: "Compliance & Audit",
  title: "Approval Audit Trail",
  description:
    "Every approval decision on a purchase order with its actor and timestamp, plus flagged anomalies.",
  permission: "reports.approval_audit_trail",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const raw = await approvalAuditTrail(scope, period);

    const rows = raw.map((e) => {
      const hour = Number(e.ist_hour);
      const afterHours = hour < WORK_START_HOUR || hour >= WORK_END_HOUR;
      return {
        event_id: Number(e.event_id),
        occurred_at: istDate(e.occurred_at),
        po_id: e.po_id,
        po_number: e.po_number,
        total_value: Number(e.total_value) || 0,
        hotel_name: e.hotel_name || "—",
        step_label: e.step_order ? `L${e.step_order}` : "—",
        // A cancellation logged as REJECT is a cancellation. Labelling it
        // "Rejected" put every closed RFQ's pending PO approvals into the
        // rejection count — 22 of prod's 69 "rejections".
        action: e.is_cancellation ? "CANCELLED" : e.action,
        action_label: e.is_cancellation ? ACTION_LABELS.CANCELLED : ACTION_LABELS[e.action] || e.action,
        actor_name: e.actor_name || `User ${e.actor_id}`,
        actor_designation: e.actor_designation || "—",
        comment: e.comment || "—",
        self_approved: !!e.self_approved,
        after_hours: afterHours,
        ist_hour: hour,
      };
    });

    // One row per FINDING, not per event: an event that is both a
    // self-approval and after hours raises two, because they are two separate
    // things for an auditor to chase.
    const anomalyRows = [];
    for (const r of rows) {
      if (r.self_approved) {
        anomalyRows.push({
          ...r,
          finding: "Self-approval — the approver also raised this order",
          severity: "High",
        });
      }
      if (r.after_hours) {
        anomalyRows.push({
          ...r,
          finding: `Decided outside working hours (${String(r.ist_hour).padStart(2, "0")}:00 IST)`,
          severity: "Low",
        });
      }
    }
    anomalyRows.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "High" ? -1 : 1));
    anomalyRows.forEach((r, idx) => { r.rank = idx + 1; });

    const byAction = new Map();
    for (const r of rows) {
      const acc = byAction.get(r.action_label) || { action_label: r.action_label, count: 0, value: 0 };
      acc.count += 1;
      acc.value += r.total_value;
      byAction.set(r.action_label, acc);
    }
    const mixRows = [...byAction.values()]
      .sort((a, b) => b.count - a.count)
      .map((m) => ({ ...m, share: rows.length ? m.count / rows.length : null }));

    return {
      rows,
      logRows: rows,
      anomalyRows,
      mixRows,
      period,
      selfApprovals: rows.filter((r) => r.self_approved).length,
    };
  },

  preview({ logRows }) {
    return {
      columns: LOG_COLUMNS.map(({ header, key, type, align }) => ({ header, key, type, align })),
      rows: logRows,
    };
  },

  buildWorkbook(wb, { logRows, anomalyRows, mixRows, period, selfApprovals }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const retention = [
      "Retention",
      "Approval decisions are append-only; nothing in this report is editable after the fact.",
    ];

    const ws1 = reportSheet(wb, "Event Log", { footerTitle: "Approval Audit Trail" });
    writeReportSheet(ws1, {
      title: "Approval Audit Trail — Event Log",
      subtitle: `${logRows.length} decision(s) · FY ${period.label} · Newest first`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Scope", "Approval decisions on purchase orders within your access"],
        ["Times", "Indian Standard Time"],
        retention,
        ["As of", asOf],
      ],
      columns: LOG_COLUMNS,
      rows: logRows,
      freezeCols: 3,
      generatedBy,
      asOf,
      footerLines: [
        "PO value repeats across the decisions taken on one order; do not sum it.",
      ],
    });

    const ws2 = reportSheet(wb, "Anomalies", { footerTitle: "Approval Audit — anomalies" });
    writeReportSheet(ws2, {
      title: "Audit Exceptions",
      subtitle:
        anomalyRows.length > 0
          ? `${anomalyRows.length} finding(s), of which ${selfApprovals} self-approval(s)`
          : "No exceptions found in this period",
      params: [
        ["Reporting period", `FY ${period.label}`],
        [
          "Self-approval (High)",
          "The approver also raised the order. A segregation-of-duties breach — a fact, not a judgement.",
        ],
        [
          "Outside working hours (Low)",
          `Decided before ${WORK_START_HOUR}:00 or after ${WORK_END_HOUR}:00 IST. A heuristic, not a fault: unusual timing is where an auditor starts, and bulk or automated decisions often surface this way.`,
        ],
        ["Reading", "An event can raise two findings; each is listed separately because each is chased separately."],
        ["As of", asOf],
      ],
      columns: ANOMALY_COLUMNS,
      rows: anomalyRows,
      freezeCols: 3,
      generatedBy,
      asOf,
    });

    const ws3 = reportSheet(wb, "Event Mix", { footerTitle: "Approval Audit — event mix" });
    writeReportSheet(ws3, {
      title: "Decision Mix",
      subtitle: `${logRows.length} decision(s) by type · FY ${period.label}`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Value Decided", "Sum of the order values each decision type was taken on; orders repeat across types."],
        ["As of", asOf],
      ],
      columns: MIX_COLUMNS.map((c) => (c.key === "share" ? { ...c, total: () => 1 } : c)),
      rows: mixRows,
      totalLabel: "Total",
      freezeCols: 1,
      generatedBy,
      asOf,
    });

    return wb;
  },
};
