//
// Pure shaping: map rfqModel.getLifecycleSummary() output (4 phases:
// rfq_approval/technical/commercial/purchase_order, each status ∈
// upcoming|current|completed|skipped|expired) → the ARC-style lifecycle
// contract the RFQ lifecycle page consumes (4 stages with state ∈
// locked|active|complete|skipped|ended + default_stage). No DB access.

const PHASE_TO_STAGE = {
  rfq_approval:   { key: "overview",          label: "Overview" },
  technical:      { key: "technical",         label: "Technical Evaluation" },
  commercial:     { key: "negotiation-award", label: "Negotiation & Award" },
  purchase_order: { key: "purchase-order",    label: "Purchase Order" },
};

const PHASE_ORDER = ["rfq_approval", "technical", "commercial", "purchase_order"];

export const STAGE_ORDER = ["overview", "technical", "negotiation-award", "purchase-order"];

// phase.status (RFQ model) → { state, reason } (ARC stage vocabulary).
function mapState(phaseStatus) {
  switch (phaseStatus) {
    case "current":   return { state: "active",   reason: "in_progress" };
    case "completed": return { state: "complete", reason: "done" };
    case "skipped":   return { state: "skipped",  reason: "not_applicable" };
    case "expired":   return { state: "active",   reason: "expired_pending" };
    case "upcoming":
    default:          return { state: "locked",   reason: "not_started" };
  }
}

/**
 * @param {object} summary  rfqModel.getLifecycleSummary() output
 * @param {{permissions?: object}} opts
 * @returns ARC-style lifecycle contract
 */
export function shapeRfqLifecycle(summary, { permissions = {} } = {}) {
  const phases = Array.isArray(summary?.phases) ? summary.phases : [];
  const byPhaseKey = Object.fromEntries(phases.map((p) => [p.key, p]));

  const action = {
    required: !!summary?.user_action_required,
    can_approve: !!summary?.user_can_approve,
    label: summary?.user_action_label || null,
    instance_id: summary?.user_approval_instance_id || null,
  };

  const stages = PHASE_ORDER.map((phaseKey) => {
    const meta = PHASE_TO_STAGE[phaseKey];
    const phase = byPhaseKey[phaseKey] || { status: "upcoming" };
    const { state, reason } = mapState(phase.status);
    const isCurrent = phase.status === "current" || phase.status === "expired";
    return {
      key: meta.key,
      label: meta.label,
      state,
      reason,
      summary: phase.summary || null,
      phase,                                   // full per-phase payload for the stage panels
      action: isCurrent ? action : null,       // attach the user action to the current stage
    };
  });

  // default_stage = the current phase's stage; APPROVED_COMPLETED (current_phase
  // null, everything complete) → the last stage so the finished RFQ opens on PO.
  const currentStage = stages.find((s) => s.state === "active");
  const default_stage = currentStage ? currentStage.key : STAGE_ORDER[STAGE_ORDER.length - 1];

  return {
    rfq_id: summary?.rfq_id,
    current_status: summary?.current_stage || null,
    default_stage,
    action,
    permissions,
    stages,
  };
}
