// ============================================================================
// The report registry.
// ----------------------------------------------------------------------------
// One entry per report in the approved pack (prototypes/report_samples/), and
// the single source of truth for what the catalogue endpoint returns, which
// permission gates a report, and whether it can be run at all.
//
// ── Why unbuildable reports are still listed ────────────────────────────────
// Five of the sixteen have no backing data in this schema — there is no budget
// table, no forecast table, no document expiry date anywhere and no violation
// rule set. (3.3 was the sixth until product swapped its amendment log, which
// cannot be built, for the rejection log, which the approval engine records.) Hiding them would quietly
// shrink a pack the client signed off on, and the first question in the review
// would be "where did budget vs actual go?". They are listed with the state
// `not_configured` and the specific thing that is missing, so the answer is on
// the screen.
//
// `readiness`:
//   ready           — implemented and backed by data; runnable now.
//   coming_soon     — the data exists; the report is still being built.
//   not_configured  — blocked on data this platform does not yet capture.
//                     `missing` names it, in the client's words, not the
//                     schema's.
// ============================================================================

import spendSummary from "./spendSummary.js";
import spendByCategory from "./spendByCategory.js";
import spendByProperty from "./spendByProperty.js";
import spendByVendor from "./spendByVendor.js";
import vendorConcentration from "./vendorConcentration.js";
import vendorMaster from "./vendorMaster.js";
import openPoRegister from "./openPoRegister.js";
import approvalAuditTrail from "./approvalAuditTrail.js";
import poAgingByApprover from "./poAgingByApprover.js";
import poApprovalTat from "./poApprovalTat.js";
import rejectedPoLog from "./rejectedPoLog.js";

/** A report that is declared but not yet runnable. */
const stub = (def) => ({ filters: [], ...def });

const DEFINITIONS = [
  // ── 3.1 Spend Analytics ──────────────────────────────────────────────────
  spendSummary,
  spendByCategory,
  spendByProperty,
  spendByVendor,

  // ── 3.2 Vendor Reports ───────────────────────────────────────────────────
  stub({
    key: "vendor_compliance",
    number: "2.1",
    family: "Vendor Reports",
    title: "Vendor Compliance Status",
    description: "Licence and registration status per vendor, with documents expiring soon.",
    permission: "reports.vendor_compliance",
    readiness: {
      state: "not_configured",
      missing: "Vendor documents are stored without issue or expiry dates, so nothing can be reported as expiring.",
    },
  }),
  vendorConcentration,
  vendorMaster,

  // ── 3.3 Purchase Orders ──────────────────────────────────────────────────
  openPoRegister,
  poAgingByApprover,
  rejectedPoLog,

  // ── 3.4 Budget & Cost Control ────────────────────────────────────────────
  stub({
    key: "budget_vs_actual",
    number: "4.1",
    family: "Budget & Cost Control",
    title: "Budget vs Actual",
    description: "Actual spend against budget by department and property, with variance bands.",
    permission: "reports.budget_vs_actual",
    readiness: {
      state: "not_configured",
      missing: "No budgets are held in the platform. Budget figures per period, property and department are needed first.",
    },
  }),
  stub({
    key: "forecast_vs_actual",
    number: "4.2",
    family: "Budget & Cost Control",
    title: "Forecast vs Actual",
    description: "Forecast accuracy and bias by month and by category.",
    permission: "reports.forecast_vs_actual",
    readiness: {
      state: "not_configured",
      missing: "No forecasts are held in the platform. A per-period spend forecast is needed first.",
    },
  }),

  // ── 3.5 Compliance & Audit ───────────────────────────────────────────────
  approvalAuditTrail,
  stub({
    key: "policy_violations",
    number: "5.2",
    family: "Compliance & Audit",
    title: "Policy Violation Log",
    description: "Detected breaches of procurement policy, by code and severity.",
    permission: "reports.policy_violations",
    readiness: {
      state: "not_configured",
      missing: "There is no violation rule set to detect against, and no log to report from.",
    },
  }),
  stub({
    key: "document_expiry",
    number: "5.3",
    family: "Compliance & Audit",
    title: "Document Expiry Tracker",
    description: "Every compliance document with its expiry, the action queue and a renewal calendar.",
    permission: "reports.document_expiry",
    readiness: {
      state: "not_configured",
      missing: "Documents are stored without expiry dates, so there is nothing to track towards renewal.",
    },
  }),

  // ── 3.6 Operational KPIs ─────────────────────────────────────────────────
  poApprovalTat,
];

const BY_KEY = new Map(DEFINITIONS.map((d) => [d.key, d]));

export function allReports() {
  return DEFINITIONS;
}

export function getReport(key) {
  return BY_KEY.get(key) || null;
}

/** Only the reports that can actually be run. */
export function isRunnable(def) {
  return def?.readiness?.state === "ready" && typeof def.fetch === "function";
}

export default { allReports, getReport, isRunnable };
