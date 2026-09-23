// ============================================================================
// 6.1 — PO Approval TAT
// ----------------------------------------------------------------------------
// How long approval actually takes, cut three ways: by order value, by the
// person deciding, and by the step in the chain. Sheet 3 is the one that
// answers "where does the time go", which is the question worth asking.
//
// ── Measured on COMPLETED approvals only ────────────────────────────────────
// A still-pending approval has no turnaround yet. Counting its elapsed time
// would let one stuck order drag the average for everybody, and the number
// would get worse every day nobody touched it. What is still waiting is
// report 3.2's job; this one reports what finished.
//
// The value bands are the ones in the approved sample. They are constants
// here rather than configuration because there is no screen to configure them
// on yet; when there is, they move to that screen and not before.
// ============================================================================

import { FMT, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import {
  poApprovalTat,
  poApprovalTatByApprover,
  poApprovalTatByStage,
} from "../../../models/reportsModel.js";

const L = 100000;
const VALUE_BANDS = [
  { label: "Routine (≤ ₹1 L)", min: 0, max: 1 * L },
  { label: "Mid value (₹1–5 L)", min: 1 * L, max: 5 * L },
  { label: "High value (₹5–25 L)", min: 5 * L, max: 25 * L },
  { label: "Capex (> ₹25 L)", min: 25 * L, max: Infinity },
];

const round1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

function stats(values) {
  if (!values.length) return { avg: null, median: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return {
    avg: round1(values.reduce((s, v) => s + v, 0) / values.length),
    median: round1(at(0.5)),
    p90: round1(at(0.9)),
  };
}

const BAND_COLUMNS = [
  { header: "Value Band", key: "band", width: 24, type: "text" },
  { header: "Approvals", key: "approvals", width: 11, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Avg TAT (hrs)", key: "avg", width: 14, align: "right", numFmt: "0.0", type: "int" },
  { header: "Median (hrs)", key: "median", width: 13, align: "right", numFmt: "0.0", type: "int" },
  { header: "P90 (hrs)", key: "p90", width: 12, align: "right", numFmt: "0.0", type: "int" },
  { header: "Value Approved (₹)", key: "value", width: 19, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
];

const APPROVER_COLUMNS = [
  { header: "Approver", key: "approver_name", width: 28, type: "text" },
  { header: "Role", key: "approver_designation", width: 28, type: "text" },
  { header: "Step", key: "step_label", width: 8, align: "center", type: "text" },
  { header: "Decisions", key: "decisions", width: 11, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Avg (hrs)", key: "avg_hours", width: 11, align: "right", numFmt: "0.0", type: "int" },
  { header: "Median (hrs)", key: "median_hours", width: 13, align: "right", numFmt: "0.0", type: "int" },
  { header: "P90 (hrs)", key: "p90_hours", width: 11, align: "right", numFmt: "0.0", type: "int" },
  { header: "SLA (hrs)", key: "sla_hours", width: 11, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Within SLA %", key: "within_sla", width: 13, align: "right", numFmt: FMT.PCT, type: "percent" },
];

const STAGE_COLUMNS = [
  { header: "Step", key: "step_label", width: 9, align: "center", type: "text" },
  { header: "Approvals", key: "approvals", width: 11, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Avg (hrs)", key: "avg_hours", width: 11, align: "right", numFmt: "0.0", type: "int" },
  { header: "Median (hrs)", key: "median_hours", width: 13, align: "right", numFmt: "0.0", type: "int" },
  { header: "P90 (hrs)", key: "p90_hours", width: 11, align: "right", numFmt: "0.0", type: "int" },
  { header: "SLA (hrs)", key: "sla_hours", width: 11, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Bottleneck Index", key: "bottleneck", width: 17, align: "right", numFmt: "0.00", type: "int" },
];

export default {
  key: "po_approval_tat",
  number: "6.1",
  family: "Operational KPIs",
  title: "PO Approval TAT",
  description: "Approval turnaround by value band, by approver and by stage, against SLA.",
  permission: "reports.po_approval_tat",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const [instances, byApprover, byStage] = await Promise.all([
      poApprovalTat(scope, period),
      poApprovalTatByApprover(scope, period),
      poApprovalTatByStage(scope, period),
    ]);

    const bandRows = VALUE_BANDS.map((b) => {
      const inBand = instances.filter((i) => {
        const v = Number(i.total_value) || 0;
        return v >= b.min && v < b.max;
      });
      const s = stats(inBand.map((i) => Number(i.tat_hours) || 0));
      return {
        band: b.label,
        approvals: inBand.length,
        ...s,
        value: inBand.reduce((sum, i) => sum + (Number(i.total_value) || 0), 0),
      };
    });

    const approverRows = byApprover.map((a) => ({
      approver_name: a.approver_name || `User ${a.approver_id}`,
      approver_designation: a.approver_designation || "—",
      step_label: `L${a.step_order}`,
      decisions: a.decisions,
      avg_hours: round1(a.avg_hours),
      median_hours: round1(a.median_hours),
      p90_hours: round1(a.p90_hours),
      sla_hours: a.sla_hours ?? null,
      // Blank rather than 100% where no SLA is configured — see report 3.2.
      within_sla: a.sla_hours ? (a.decisions - a.breaches) / a.decisions : null,
    }));

    const stageRows = byStage.map((s) => ({
      step_label: `L${s.step_order}`,
      approvals: s.approvals,
      avg_hours: round1(s.avg_hours),
      median_hours: round1(s.median_hours),
      p90_hours: round1(s.p90_hours),
      sla_hours: s.sla_hours ?? null,
      // >1 means the step averages longer than its target. Blank without one.
      bottleneck: s.sla_hours ? Math.round((Number(s.avg_hours) / s.sla_hours) * 100) / 100 : null,
    }));

    return { rows: bandRows, bandRows, approverRows, stageRows, instances, period };
  },

  preview({ bandRows }) {
    return {
      columns: BAND_COLUMNS.map(({ header, key, type, align }) => ({ header, key, type, align })),
      rows: bandRows,
    };
  },

  buildWorkbook(wb, { bandRows, approverRows, stageRows, instances, period }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const basis = [
      "TAT basis",
      "Calendar hours from submission to final decision, on approvals that COMPLETED in the period. Anything still pending is in report 3.2, not here.",
    ];
    const slaNote = [
      "SLA",
      'Configured per approval step. Where none is set the SLA and Within-SLA columns show "—": unmeasured, not compliant.',
    ];

    const ws1 = reportSheet(wb, "TAT by Value", { footerTitle: "PO Approval TAT" });
    writeReportSheet(ws1, {
      title: "PO Approval TAT — by Value Band",
      subtitle: `${instances.length} completed approval(s) · FY ${period.label}`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        basis,
        ["Bands", "Routine ≤ ₹1 L · Mid ₹1–5 L · High ₹5–25 L · Capex > ₹25 L"],
        ["As of", asOf],
      ],
      columns: BAND_COLUMNS,
      rows: bandRows,
      totalLabel: "Total",
      freezeCols: 1,
      generatedBy,
      asOf,
    });

    const ws2 = reportSheet(wb, "By Approver", { footerTitle: "PO Approval TAT — by approver" });
    writeReportSheet(ws2, {
      title: "PO Approval TAT — by Approver",
      subtitle: `${approverRows.length} approver(s) who decided something · FY ${period.label}`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Measured", "Time from the step opening to this person's decision"],
        slaNote,
        ["Sort", "Most decisions first"],
        ["As of", asOf],
      ],
      columns: APPROVER_COLUMNS,
      rows: approverRows,
      totalLabel: "Total",
      freezeCols: 1,
      generatedBy,
      asOf,
    });

    const ws3 = reportSheet(wb, "By Stage", { footerTitle: "PO Approval TAT — by stage" });
    writeReportSheet(ws3, {
      title: "PO Approval TAT — by Stage",
      subtitle: `Where the time goes · FY ${period.label}`,
      params: [
        ["Reporting period", `FY ${period.label}`],
        ["Bottleneck Index", "Average TAT ÷ SLA. Above 1.00 means the step averages longer than its target."],
        slaNote,
        ["As of", asOf],
      ],
      columns: STAGE_COLUMNS,
      rows: stageRows,
      totalLabel: "Total",
      freezeCols: 1,
      generatedBy,
      asOf,
    });

    return wb;
  },
};
