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
    // An expired approval phase is OVER, not live: the RFQ published without it,
    // so nothing about it is still awaiting a decision. Marking it "active" made
    // it win default_stage below (first active stage) and pinned the page to
    // Overview for the rest of the RFQ's life — even once it had a PO. It is
    // settled-but-not-clean; the client renders reason=expired_pending in red.
    case "expired":   return { state: "ended",    reason: "expired_pending" };
    case "upcoming":
    default:          return { state: "locked",   reason: "not_started" };
  }
}

// Which permission resources open each stage's detail.
//
// NOTE ON 'po': there is no `po` resource in tbl_permissions at all — the
// catalogue is rfq/tender/te/quote-compare/negotiation/arc/awarding/boq/
// dashboard/arc-*/mr. `permissions.po` is therefore [] for every buyer, and
// gating the PO stage on po.read would hide it from 100% of users (verified in
// production: 0 of 230 rfq.read holders have po.read). Purchase orders
// originate from awarding, and 229 of those 230 hold awarding.read, so
// awarding is the resource that actually governs the PO stage.
const STAGE_READ_RESOURCES = {
  "overview":          ["rfq"],
  "technical":         ["te"],
  "negotiation-award": ["quote-compare", "negotiation", "awarding"],
  "purchase-order":    ["awarding"],
};

const opensStage = (actions) =>
  Array.isArray(actions) && (actions.includes("read") || actions.includes("admin"));

// A stage the caller has no module role for is still theirs to open if the
// approval policy put a decision in front of them on it — an approver can be
// named by policy alone, with no module permission. Mirrors the ARC awarding
// stage, which opens on `can_user_approve` for exactly this reason.
function hasPendingDecisionOnStage(stage) {
  const instances = stage?.phase?.approval_instances;
  if (!Array.isArray(instances)) return false;
  return instances.some((i) => i?.status === "PENDING" && i?.can_user_approve);
}

function canReadStage(stage, permissions) {
  const resources = STAGE_READ_RESOURCES[stage.key] || [];
  if (resources.some((r) => opensStage(permissions?.[r]))) return true;
  return hasPendingDecisionOnStage(stage);
}

/**
 * Strip the detail of stages the caller may not read, in place.
 *
 * The RFQ stage panels render straight from this payload — the PO list with
 * vendor names and ₹ totals, the per-product finalization and negotiation
 * prices — rather than fetching from separately-gated endpoints the way the ARC
 * page does. Hiding those panels in the client alone would leave the numbers
 * sitting in the JSON for anyone who opens devtools, so the redaction has to
 * happen here.
 *
 * `can_read: false` is what the client renders its no-permission panel from.
 */
function redactUnreadableStages(stages, permissions) {
  for (const stage of stages) {
    if (canReadStage(stage, permissions)) {
      stage.can_read = true;
      continue;
    }
    stage.can_read = false;
    stage.action = null;
    // The summary is not safe either — it carries counts and values
    // ("2 POs · ₹4,20,000", "1 product finalized").
    stage.summary = null;
    stage.phase = { key: stage.phase?.key ?? null, label: stage.phase?.label ?? null,
                    status: stage.phase?.status ?? null };
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
    // The generic approval endpoint accepts a null step id, but the summary
    // already resolves it — pass it through so the client doesn't have to
    // re-derive which step it is acting on.
    step_id: summary?.user_approval_step_id || null,
    entity_type: summary?.user_approval_entity_type || null,
  };

  const stages = PHASE_ORDER.map((phaseKey) => {
    const meta = PHASE_TO_STAGE[phaseKey];
    const phase = byPhaseKey[phaseKey] || { status: "upcoming" };
    const { state, reason } = mapState(phase.status);
    // Only a genuinely current phase carries the user action. An expired phase
    // used to be counted as current too, which hung the shared action object on
    // Overview and made it render "Action needed" for work owned by a later
    // stage. Publication already happened — there is no action left here.
    const isCurrent = phase.status === "current";
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

  redactUnreadableStages(stages, permissions);

  // default_stage = the current phase's stage; APPROVED_COMPLETED (current_phase
  // null, everything complete) → the last stage so the finished RFQ opens on PO.
  // Never open on a stage the caller cannot read — that would land them on a
  // no-permission panel instead of the RFQ.
  const readable = stages.filter((s) => s.can_read);
  const currentStage = readable.find((s) => s.state === "active");
  const lastReadable = readable.length ? readable[readable.length - 1].key : STAGE_ORDER[0];
  const default_stage = currentStage ? currentStage.key : lastReadable;

  return {
    rfq_id: summary?.rfq_id,
    current_status: summary?.current_stage || null,
    default_stage,
    action,
    permissions,
    stages,
  };
}
