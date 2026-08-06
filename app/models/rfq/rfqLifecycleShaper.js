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

// ---------------------------------------------------------------------------
// stage_actors — "who has the ball right now, by name, all of them"
// ---------------------------------------------------------------------------
//
// The RFQ workspace already carries a one-line strip built from this same
// lifecycle summary (StageShared.js `LifecycleContext`). That strip truncates to
// three names + "+N", which is exactly the information a buyer standing in front
// of the comparison sheet needs in full: WHO must act, and whether they are one
// of them. This shaper answers that question from the identical source, so the
// banner and the strip can never disagree, and it never truncates.
//
// Resolution order per phase mirrors StageShared.actorsOf exactly:
//   1. action_holders          — the LIVE holders (pending approvers on the
//                                open instance, or the permission-holders for
//                                an evaluation stage). Only ever populated on a
//                                phase whose status is 'current'.
//   2. upcoming_actors.approver_steps[0] — the policy-resolved first approval
//                                step, for a phase that has not started.
//   3. upcoming_actors.evaluators        — the permission-resolved evaluators.
//
// Identity: every source above already carries a stable `id` from tbl_users, so
// "is this me?" is an id comparison, never a name comparison. `is_me` is decided
// here, server-side, from the authenticated caller.
//
// NOTE the deliberate asymmetry with shapeRfqLifecycle: this function does NOT
// apply that function's per-stage permission redaction. It is called from
// endpoints that have already gated the caller on the RFQ itself, and it emits
// names + ids only — never emails, never any commercial figure.

const ROLE_LABEL_APPROVERS  = "Approvers";
const ROLE_LABEL_EVALUATORS = "Evaluators";

// { role_label, decision_rule, users:[{id,name}] } | null for one phase.
function phaseActors(phase) {
  if (!phase) return null;

  const ah = phase.action_holders;
  if (ah && Array.isArray(ah.users) && ah.users.length) {
    return {
      role_label: ah.label || "Action holders",
      decision_rule: ah.decision_rule || null,
      users: ah.users,
    };
  }

  const ua = phase.upcoming_actors;
  if (ua && Array.isArray(ua.approver_steps) && ua.approver_steps.length) {
    const step = ua.approver_steps[0];
    return {
      role_label: ROLE_LABEL_APPROVERS,
      decision_rule: step.decision_rule || null,
      users: Array.isArray(step.approvers) ? step.approvers : [],
    };
  }
  if (ua && Array.isArray(ua.evaluators) && ua.evaluators.length) {
    return { role_label: ROLE_LABEL_EVALUATORS, decision_rule: null, users: ua.evaluators };
  }
  return null;
}

// Dedupe by user id (the same person can sit on several sources), drop anything
// without an id — a nameless or idless actor is not something a banner can name
// or match against — and order by name so the list is stable across requests.
function normalizeActors(users, { userId = null, withIsMe = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const u of users || []) {
    const id = Number(u?.id ?? u?.user_id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    // `role` is a slot, not a value: the lifecycle summary carries no role
    // titles, so callers that want them fill this in afterwards.
    const actor = { user_id: id, name: u?.name || null, role: u?.role || null };
    if (withIsMe) actor.is_me = userId != null && Number(userId) === id;
    out.push(actor);
  }
  out.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return out;
}

/**
 * @param {object} summary  rfqModel.getLifecycleSummary() output
 * @param {{userId?: number|null}} opts  userId — the authenticated caller, for `is_me`.
 * @returns {{stage_label, role_label, decision_rule, actors, next}|null}
 *          null when nothing is live: no current phase, or a current phase with
 *          no resolvable actor (e.g. an RFQ still collecting quotes).
 */
export function shapeStageActors(summary, { userId = null } = {}) {
  const phases = Array.isArray(summary?.phases) ? summary.phases : [];
  const byKey = Object.fromEntries(phases.map((p) => [p.key, p]));
  const ordered = PHASE_ORDER.map((k) => byKey[k]).filter(Boolean);

  const activeIdx = ordered.findIndex((p) => p.status === "current");
  if (activeIdx < 0) return null;

  const active = ordered[activeIdx];
  const now = phaseActors(active);
  if (!now) return null;

  // "Up next" is the nearest LATER phase that is neither skipped nor actorless —
  // a skipped technical stage must not be announced as the next thing anyone
  // does. Same selection the RFQ-page strip makes.
  let next = null;
  for (const p of ordered.slice(activeIdx + 1)) {
    if (p.status === "skipped") continue;
    const a = phaseActors(p);
    if (!a) continue;
    next = {
      stage_label: PHASE_TO_STAGE[p.key]?.label || p.label || null,
      role_label: a.role_label,
      actors: normalizeActors(a.users),
    };
    break;
  }

  return {
    stage_label: PHASE_TO_STAGE[active.key]?.label || active.label || null,
    role_label: now.role_label,
    decision_rule: now.decision_rule,
    actors: normalizeActors(now.users, { userId, withIsMe: true }),
    next,
  };
}
