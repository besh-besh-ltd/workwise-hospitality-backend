/**
 * Approval Propagation Service
 *
 * Handles dynamic propagation of approval policy changes and role/department
 * membership changes to in-flight (PENDING) approval instances.
 *
 * Two entry points:
 *   1. propagatePolicyChangeToInstances() — called when admin edits policy steps
 *   2. revalidateApproverMembership()     — called when user roles/depts/status change
 *
 * Pre-flight check:
 *   simulateApproverImpact() — dry-run to detect if a change would cause
 *   unintended auto-approval (BLOCKED) or affect pending approvals (WARNING).
 */

import db from '../config/dbConn.js';
import {
  resolveApprovers,
  ENTITY_APPROVE_RESOURCE_MAP,
  roleHasReadAndApprovePermission,
  policyStepApproverEligibility,
  getApprovalInstanceById,
  recordLifecycleEvent
} from '../models/generalModel.js';
import { logger } from '../util/logger.js';
import { notifyApprovalChanged } from './approvalEvents.js';
import { logError } from '../helper/common.js';
import {
  sendPolicyChangeNotification,
  sendApproverRemovedNotification,
  sendApprovalStandsNotification,
  sendApproverAddedMidFlightNotification
} from '../helper/sendEmailFunctions/approvalEmails.js';

// SQL fragment to exclude PENDING approval instances whose underlying RFQ has
// already been published (tbl_rfq.is_published = 1). Once an RFQ is live, the
// approval that gated its publication is effectively obsolete — even if the
// instance row is still PENDING — so it shouldn't surface in impact discovery
// or be mutated by membership/policy propagation.
//
// Assumes the calling SQL aliases the approval-instance table as `ai`.
const SKIP_PUBLISHED_RFQ_SQL = `
  AND NOT (ai.entity_type = 'RFQ' AND EXISTS (
    SELECT 1 FROM tbl_rfq r WHERE r.id = ai.entity_id AND r.is_published = 1
  ))`;

/**
 * Resolve which POLICY step an INSTANCE step came from, with a defined
 * precedence. Every reconciliation query must use this and only this.
 *
 *   1. `ais.policy_step_id` — the true link, written by createApprovalInstance
 *      (generalModel.js) and refreshed by propagatePolicyChangeToInstances.
 *      Accepted only when it still resolves to a LIVE step OF THIS INSTANCE'S
 *      POLICY; a link that points into some other policy is treated as broken,
 *      not followed.
 *   2. `ps.step_order = ais.step_order` — ordinal fallback, used ONLY when (1)
 *      is NULL or does not resolve to a live step of this instance's policy.
 *      (In production a broken link is always NULL — see the invariants below —
 *      but the id is re-checked against the policy rather than trusted.)
 *
 * BOTH are required.
 *
 * (1) is required because instance step numbering is NOT policy step numbering.
 * createApprovalInstance assigns instance `step_order` from a fresh counter that
 * only advances for steps that survived resolution (generalModel.js:2226-2258):
 * a ROLE step whose role lacks read+approve, or any step resolving to zero
 * approvers, is dropped WITHOUT consuming a number. Policy steps 1,2,3 with #1
 * dropped become instance steps 1,2 — so instance step 1 is policy step 2.
 * Matching on the ordinal alone then hands the reconciler the WRONG policy step,
 * and re-resolution runs against the wrong role. That fails in the dangerous
 * direction: a user who holds the other level's role is judged "still qualified"
 * and keeps an authority they were just stripped of. This population is real and
 * sizeable in production — see the counts below.
 *
 * (2) is required because a policy edit DELETEs and re-INSERTs every step row
 * (generalController.upsertApprovalPolicy → deletePolicySteps + insertPolicySteps)
 * and `fk_instance_step_policy_step` is ON DELETE SET NULL. The edit now captures
 * every pending instance's links first (snapshotPendingInstanceStepLinks) and
 * re-points them at the new rows, but instances edited before that change lost
 * their links. Dropping the ordinal path would strand all of them.
 *
 * KNOWN LIMIT — a stored link may itself be ordinal-shaped. Until this commit,
 * propagatePolicyChangeToInstances refreshed links with
 * `UPDATE … WHERE step_order = <policy step_order>`, i.e. it wrote
 * `ais(step_order=k).policy_step_id = newStep(step_order=k).id`. On a divergent
 * instance that link is a re-labelled ordinal guess, and rule (1) above follows
 * it at TOP precedence and reports `matched_by_id = true` — a pre-existing
 * corrupted link is INDISTINGUISHABLE from a genuine one, here and in the logs
 * (only the fallback case is logged). This is not a regression: it returns the
 * same answer the old ordinal-only path returned, and it was measured read-only
 * on production before being accepted.
 *
 * What that measurement established — these are invariants, and they are the
 * part worth trusting:
 *   - `fk_instance_step_policy_step` is present and `convalidated = true`;
 *   - ZERO dangling links exist (no `policy_step_id` without a matching policy
 *     step). A broken link is therefore always NULL, never a stale id;
 *   - ZERO linked steps have a linked role that fails to contain the step's live
 *     approvers — i.e. no ordinal-shaped link is currently producing a wrong
 *     answer, in any entity type.
 * So there is no bleed to stop and NO backfill/repair pass is warranted; do not
 * add one without a fresh measurement.
 *
 * Supporting counts, POINT-IN-TIME and expected to drift — instances complete
 * continuously, and these moved measurably within an hour of being taken. State
 * the predicate with any number quoted from here. Measured 2026-08-03:
 *   - all steps of PENDING instances:      366 linked / 150 NULL (516)
 *   - PENDING steps of PENDING instances:  320 linked / 131 NULL (451)
 *   - 471 instance steps where the ordinal lands on a different policy step than
 *     `policy_step_id` — the population rule (1) exists for.
 *
 * Emits exactly one row (or none) per instance step, aliased `ps`, so callers —
 * including buildChangedScopeFilterSql, which writes `ps.approver_source_type` /
 * `ps.approver_source_id` — need no changes. `ps.matched_by_id` says which rule
 * fired; `ps IS NULL` means the step is UNRESOLVABLE (policy deleted, or the
 * policy has fewer steps than the instance) and callers must decide explicitly
 * what to do about it rather than letting a join quietly drop the row.
 *
 * Assumes the calling SQL aliases the instance table `ai` and instance steps `ais`.
 */
export const POLICY_STEP_RESOLUTION_SQL = `
  LEFT JOIN LATERAL (
    SELECT
      p.id                AS matched_policy_step_id,
      p.approver_source_type,
      p.approver_source_id,
      (p.id IS NOT DISTINCT FROM ais.policy_step_id) AS matched_by_id
    FROM tbl_approval_policy_steps p
    WHERE p.approval_policy_id = ai.approval_policy_id
      AND (p.id = ais.policy_step_id OR p.step_order = ais.step_order)
    ORDER BY (p.id IS NOT DISTINCT FROM ais.policy_step_id) DESC,
             p.step_order ASC, p.id ASC
    LIMIT 1
  ) ps ON TRUE`;

/**
 * Normalise a scope axis value to `null` or a positive integer.
 *
 * Scope snapshots taken in usersController COALESCE NULLs to 0 so the tuple
 * diff can use string keys; 0 therefore means "unscoped on this axis"
 * (= wildcard), exactly like a NULL column value.
 */
function scopeAxis(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Build the SQL predicate restricting approval-instance discovery to the role
 * scopes actually being removed.
 *
 * One OR-group per removed `tbl_user_role_scopes` row. Each group mirrors the
 * matching semantics of `resolveApprovers()` (generalModel.js) EXACTLY —
 * anything looser over-reports (the bug this closes), anything tighter
 * under-reports (worse: a real skipped approval goes unwarned):
 *
 *   company    `urs.company_id = $2`               → hard equality, no wildcard
 *   hotel      `urs.hotel_id IS NULL OR = $3`      → NULL scope covers every hotel
 *   department deptClause applied only when the instance IS dept-scoped, and
 *              then `urs.department_id = $5 OR IS NULL`
 *   process    `$6 IS NULL OR urs.process_id IS NULL OR urs.process_id = $6`
 *
 * Department *membership* removals (tbl_user_department) stay hotel-blind —
 * that table carries no company/hotel axis — so they keep the flat
 * `changedDeptIds` treatment.
 *
 * Mutates `params` (pushing bind values) and returns the SQL fragment.
 * Returns `' AND FALSE'` when the caller supplied change info but none of it
 * can match anything — matching nothing is the safe reading of "the removed
 * grants could never have made this user an approver".
 *
 * Assumes the calling SQL aliases the instance table as `ai` and the policy
 * step table as `ps`.
 */
function buildChangedScopeFilterSql(changedScopes, changedDeptIds, params) {
  const orGroups = [];

  for (const scope of changedScopes) {
    const roleId = scopeAxis(scope.role_id);
    const companyId = scopeAxis(scope.company_id);
    // A scope row without a role or a company can never resolve an approver
    // (resolveApprovers joins on both), so it cannot have caused any impact.
    if (!roleId || !companyId) continue;

    params.push(roleId, companyId, scopeAxis(scope.hotel_id),
      scopeAxis(scope.department_id), scopeAxis(scope.process_id));
    const p = params.length;
    orGroups.push(`(
      ps.approver_source_type = 'ROLE'
      AND ps.approver_source_id = $${p - 4}
      AND ai.hospitality_company_id = $${p - 3}
      AND ($${p - 2}::int IS NULL OR ai.hotel_id = $${p - 2})
      AND ($${p - 1}::int IS NULL OR ai.department_id IS NULL OR ai.department_id = $${p - 1})
      AND ($${p}::int IS NULL OR ai.process_id IS NULL OR ai.process_id = $${p})
    )`);
  }

  if (changedDeptIds.length > 0) {
    params.push(changedDeptIds);
    orGroups.push(`(ps.approver_source_type = 'DEPARTMENT' AND ps.approver_source_id = ANY($${params.length}::int[]))`);
  }

  if (orGroups.length === 0) return ' AND FALSE';
  return ` AND (${orGroups.join(' OR ')})`;
}

/**
 * Metadata keys that carry a human-facing identifier, per entity type. The
 * FIRST hit wins, so a PO instance is labelled with its PO number even though
 * its metadata also carries the originating RFQ number.
 */
const IDENTIFIER_KEYS_BY_ENTITY = {
  PO: ['po_number', 'po_no'],
  MR: ['mr_number', 'mr_no'],
  RFQ: ['rfq_number', 'rfq_no'],
  TENDER: ['tender_number', 'rfq_number', 'rfq_no'],
  TECHNICAL: ['rfq_number', 'rfq_no'],
  NEGOTIATION: ['rfq_number', 'rfq_no'],
  NEGOTIATION_QUOTE: ['rfq_number', 'rfq_no'],
  ARC: ['arc_number', 'arc_no', 'contract_number'],
  ARC_PUBLISH: ['arc_number', 'arc_no', 'contract_number'],
  ARC_TECH: ['arc_number', 'arc_no', 'contract_number'],
  ARC_COMMITTEE: ['arc_number', 'arc_no', 'contract_number'],
  ARC_NEGOTIATION: ['arc_number', 'arc_no', 'contract_number'],
};

// Last-resort ordering for entity types not listed above.
const IDENTIFIER_KEYS_FALLBACK = [
  'rfq_number', 'rfq_no', 'po_number', 'po_no', 'arc_number', 'arc_no', 'mr_number',
];

/**
 * Pick the identifier that belongs to THIS instance's entity type.
 *
 * Previously a flat `rfq_number || rfq_no || po_number || …` chain, which
 * labelled a Purchase Order with the RFQ number it descended from — the admin
 * saw "Purchase Order 536074" for PO 138626.
 */
function resolveEntityIdentifier(entityType, metadata, entityId) {
  const keys = IDENTIFIER_KEYS_BY_ENTITY[entityType] || [];
  for (const key of [...keys, ...IDENTIFIER_KEYS_FALLBACK]) {
    const value = metadata?.[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return `ID-${entityId}`;
}

// ============================================================================
// SECTION 1: POLICY STEP DIFF
// ============================================================================

/**
 * Snapshot current policy steps before they are deleted during an update.
 * Must be called BEFORE deletePolicySteps().
 */
export async function snapshotPolicySteps(policyId, t = db) {
  return t.any(
    'SELECT * FROM tbl_approval_policy_steps WHERE approval_policy_id = $1 ORDER BY step_order ASC',
    [policyId]
  );
}

/**
 * Capture, for every PENDING instance of this policy, which policy step each
 * instance step was built from: Map<instance step id, policy step id>.
 *
 * MUST be called inside the policy-edit transaction BEFORE deletePolicySteps().
 * The edit deletes and re-inserts every policy step, and
 * `fk_instance_step_policy_step` is ON DELETE SET NULL, so afterwards the
 * database no longer knows which level any instance step came from. This map
 * is what lets propagation match by that link instead of guessing by ordinal.
 *
 * A link into a different policy is treated as broken and left out, exactly as
 * POLICY_STEP_RESOLUTION_SQL treats it. Published RFQs are left out as they are
 * everywhere in propagation (SKIP_PUBLISHED_RFQ_SQL) — nothing touches them.
 */
export async function snapshotPendingInstanceStepLinks(policyId, t = db) {
  const rows = await t.any(
    `SELECT ais.id AS instance_step_id, ais.policy_step_id
       FROM tbl_approval_instances ai
       JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id
       JOIN tbl_approval_policy_steps ps
         ON ps.id = ais.policy_step_id AND ps.approval_policy_id = ai.approval_policy_id
      WHERE ai.approval_policy_id = $1 AND ai.status = 'PENDING'
      ${SKIP_PUBLISHED_RFQ_SQL}`,
    [policyId]
  );
  return new Map(rows.map(r => [Number(r.instance_step_id), Number(r.policy_step_id)]));
}

// Rows carry integer step_order; request bodies may carry strings.
const stepOrderOf = (s) => Number(s.step_order);
// A policy level's identity is who approves at it.
const approverKey = (s) => `${s.approver_source_type}:${s.approver_source_id}`;

/**
 * Pair the levels of a policy before an edit with the levels after it.
 * Pure function — no DB access. Steps must carry `step_order`.
 *
 *   1. identity — steps naming the same approver (source type + id) pair up,
 *      the k-th occurrence before the edit with the k-th occurrence after it,
 *      both in step_order. Removing Level 1 of [A, B] therefore pairs B with B.
 *   2. position — a step left unpaired on both sides at the same step_order:
 *      the admin replaced that level's approver.
 *   3. the rest are removed (old side) / added (new side).
 *
 * Pairing by position alone read "remove Level 1 of [A, B]" as "Level 1 changed
 * from A to B, Level 2 removed" — and every instance waiting at Level 2 had its
 * live step removed and auto-completed.
 *
 * @returns {{ pairs: Array<{oldStep, newStep, kind: 'identity'|'position'}>,
 *             removed: Array, added: Array }} — pairs in old step_order
 */
export function pairPolicySteps(oldSteps = [], newSteps = []) {
  const byOrder = (a, b) => stepOrderOf(a) - stepOrderOf(b);
  const olds = [...oldSteps].sort(byOrder);
  const news = [...newSteps].sort(byOrder);
  const pairs = [];
  const pairedOld = new Set();
  const pairedNew = new Set();
  const pair = (oldStep, newStep, kind) => {
    pairs.push({ oldStep, newStep, kind });
    pairedOld.add(oldStep);
    pairedNew.add(newStep);
  };

  const newByKey = new Map();
  for (const s of news) {
    const key = approverKey(s);
    if (!newByKey.has(key)) newByKey.set(key, []);
    newByKey.get(key).push(s);
  }
  const occurrence = new Map();
  for (const o of olds) {
    const key = approverKey(o);
    const k = occurrence.get(key) || 0;
    occurrence.set(key, k + 1);
    const n = newByKey.get(key)?.[k];
    if (n) pair(o, n, 'identity');
  }

  for (const o of olds) {
    if (pairedOld.has(o)) continue;
    const n = news.find(s => !pairedNew.has(s) && stepOrderOf(s) === stepOrderOf(o));
    if (n) pair(o, n, 'position');
  }

  pairs.sort((a, b) => byOrder(a.oldStep, b.oldStep));
  return {
    pairs,
    removed: olds.filter(s => !pairedOld.has(s)),
    added: news.filter(s => !pairedNew.has(s))
  };
}

/**
 * Compute a structured diff between old and new policy steps, built on
 * pairPolicySteps. Pure function — no DB access.
 *
 *   identity pair, rule changed → STEP_MODIFIED (sourceChanged false, ruleChanged true)
 *   identity pair, order changed → STEP_MOVED {from, to} — never changes an
 *                                  instance's status, only its policy_step_id
 *   identity pair, unchanged    → no entry
 *   position pair               → STEP_MODIFIED (sourceChanged true)
 *   removed / added             → STEP_REMOVED (old step_order) / STEP_ADDED (new step_order)
 *
 * Entries come back in policy order (old step_order; STEP_ADDED by new step_order).
 *
 * @param {Array} oldSteps — rows from tbl_approval_policy_steps (before deletion)
 * @param {Array} newSteps — the inserted rows (with ids), or request-body steps for a preview
 * @returns {Array} Array of diff entries
 */
export function computePolicyStepDiff(oldSteps, newSteps) {
  const { pairs, removed, added } = pairPolicySteps(oldSteps, newSteps);
  const diffs = [];

  for (const { oldStep, newStep, kind } of pairs) {
    const oldRule = oldStep.decision_rule || 'ANY';
    const newRule = newStep.decision_rule || 'ANY';
    const ruleChanged = oldRule !== newRule;

    if (kind === 'position' || ruleChanged) {
      diffs.push({
        type: 'STEP_MODIFIED',
        step_order: stepOrderOf(oldStep),
        oldStep,
        newStep,
        sourceChanged: kind === 'position',
        ruleChanged,
        oldRule,
        newRule
      });
    } else if (stepOrderOf(oldStep) !== stepOrderOf(newStep)) {
      diffs.push({ type: 'STEP_MOVED', from: stepOrderOf(oldStep), to: stepOrderOf(newStep), oldStep, newStep });
    }
  }
  for (const oldStep of removed) {
    diffs.push({ type: 'STEP_REMOVED', step_order: stepOrderOf(oldStep), oldStep });
  }
  for (const newStep of added) {
    diffs.push({ type: 'STEP_ADDED', step_order: stepOrderOf(newStep), newStep });
  }

  const anchor = (d) => (d.type === 'STEP_MOVED' ? d.from : d.step_order);
  return diffs.sort((a, b) => anchor(a) - anchor(b));
}

/** A diff entry as it is written to change logs and warning summaries. */
export function summarizeDiffEntry(d) {
  return d.type === 'STEP_MOVED'
    ? { type: d.type, from: d.from, to: d.to }
    : { type: d.type, step_order: d.step_order, sourceChanged: d.sourceChanged, ruleChanged: d.ruleChanged };
}

// ============================================================================
// SECTION 2: STEP RE-EVALUATION & ADVANCEMENT
// ============================================================================

/**
 * Re-evaluate whether an instance step is complete after an approver change.
 * REMOVED-aware: only considers non-REMOVED approvers.
 *
 * @returns {{ completed: boolean, status: string }}
 */
export async function reEvaluateInstanceStep(instanceStepId, t) {
  const step = await t.oneOrNone(
    'SELECT * FROM tbl_approval_instance_steps WHERE id = $1',
    [instanceStepId]
  );
  if (!step || step.status !== 'PENDING') {
    return { completed: false, status: step?.status || 'UNKNOWN' };
  }

  const approvers = await t.any(
    `SELECT status FROM tbl_approval_step_approvers
     WHERE approval_instance_step_id = $1 AND status != 'REMOVED'`,
    [instanceStepId]
  );

  // No approvers left → auto-complete.
  //
  // But FIRST distinguish the three ways a step can have nobody on it, because
  // they mean opposite things:
  //
  //   * It HAD approvers and a MEMBERSHIP change removed the last of them
  //     (role revoked, user deactivated, …). Auto-completing is the
  //     established behaviour — the step existed and was overtaken by that
  //     change, and simulateApproverImpact warned about it beforehand.
  //   * It NEVER had a single approver row. That is a step that was added but
  //     could not be filled — it is BLOCKED, waiting for somebody to hold the
  //     role. Auto-approving it would manufacture consent nobody gave, and
  //     would silently undo the blocking behaviour in applyDiffToInstance.
  //   * A POLICY EDIT emptied it: the edit pointed the level at an approver who
  //     resolves to nobody in this scope and tombstoned the old approvers
  //     (removal_reason 'policy_change'). The step still exists in the edited
  //     policy — it is BLOCKED exactly like the never-filled one. Counting
  //     those tombstones as "had approvers" approved it, so an edit completed
  //     the approval and fired its post-approval handler. A policy edit never
  //     completes a live approval.
  //
  // The filtered query above cannot tell them apart (all three return zero),
  // so read the tombstones: how many, and what removed the last of them.
  if (approvers.length === 0) {
    const history = await t.one(
      `WITH r AS (
         SELECT removal_reason, removed_at FROM tbl_approval_step_approvers
          WHERE approval_instance_step_id = $1
       )
       SELECT (SELECT count(*)::int FROM r) AS n,
              COALESCE((SELECT bool_or(removal_reason = 'policy_change') FROM r
                         WHERE removed_at = (SELECT max(removed_at) FROM r)), false) AS emptied_by_policy_edit`,
      [instanceStepId]
    );

    if (history.n === 0) {
      logger.warn(
        { instance_step_id: instanceStepId },
        '[ApprovalPropagation] step has never had an approver — leaving it PENDING (blocked) rather than auto-approving an authority nobody exercised'
      );
      return { completed: false, status: 'PENDING', blocked: true };
    }
    if (history.emptied_by_policy_edit) {
      logger.warn(
        { instance_step_id: instanceStepId },
        '[ApprovalPropagation] step was emptied by a policy edit (its level resolves to nobody) — leaving it PENDING (blocked) rather than approving it through the tombstones'
      );
      return { completed: false, status: 'PENDING', blocked: true };
    }

    await t.none(
      `UPDATE tbl_approval_instance_steps SET status = 'APPROVED', completed_at = NOW() WHERE id = $1`,
      [instanceStepId]
    );
    return { completed: true, status: 'APPROVED' };
  }

  const allApproved = approvers.every(a => a.status === 'APPROVED');
  const anyApproved = approvers.some(a => a.status === 'APPROVED');

  const stepComplete =
    (step.decision_rule === 'ALL' && allApproved) ||
    (step.decision_rule === 'ANY' && anyApproved);

  if (stepComplete) {
    await t.none(
      `UPDATE tbl_approval_instance_steps SET status = 'APPROVED', completed_at = NOW() WHERE id = $1`,
      [instanceStepId]
    );
    return { completed: true, status: 'APPROVED' };
  }

  return { completed: false, status: 'PENDING' };
}

/**
 * Advance the instance to the next PENDING step after the current one completes.
 * If no next step exists, mark the instance as APPROVED.
 *
 * @returns {{ instanceCompleted: boolean, nextStepOrder: number|null, nextStepId: number|null }}
 */
export async function advanceInstanceToNextStep(instanceId, t) {
  const instance = await t.oneOrNone(
    'SELECT * FROM tbl_approval_instances WHERE id = $1',
    [instanceId]
  );
  if (!instance || instance.status !== 'PENDING') {
    return { instanceCompleted: false, nextStepOrder: null, nextStepId: null };
  }

  const allSteps = await t.any(
    `SELECT * FROM tbl_approval_instance_steps
     WHERE approval_instance_id = $1
     ORDER BY step_order ASC`,
    [instanceId]
  );

  // Find the next PENDING step (skip APPROVED, REMOVED, SKIPPED)
  const nextStep = allSteps.find(
    s => s.step_order > instance.current_step && s.status === 'PENDING'
  );

  // Either branch moves the pending step: announce after commit.
  notifyApprovalChanged({ instanceIds: instanceId }, t);

  if (nextStep) {
    await t.none(
      'UPDATE tbl_approval_instances SET current_step = $1 WHERE id = $2',
      [nextStep.step_order, instanceId]
    );
    return { instanceCompleted: false, nextStepOrder: nextStep.step_order, nextStepId: nextStep.id };
  }

  // No more pending steps — instance is fully approved
  await t.none(
    `UPDATE tbl_approval_instances SET status = 'APPROVED', completed_at = NOW() WHERE id = $1`,
    [instanceId]
  );

  return { instanceCompleted: true, nextStepOrder: null, nextStepId: null };
}

/**
 * Dispatch the post-approval handler for an auto-completed instance.
 * Uses the same registry as approvalActionService.js.
 * Fire-and-forget: errors are logged but never thrown.
 */
async function dispatchPostApprovalHandler(instanceId, changedBy, reason) {
  try {
    const instance = await getApprovalInstanceById(instanceId);
    if (!instance) return;

    // Lazy-import registry to avoid circular deps
    const postActionRegistry = {
      RFQ:               { APPROVED: () => import('../controllers/rfq/rfqController.js').then(m => m.handleRFQPostApproval) },
      TENDER:            { APPROVED: () => import('../controllers/rfq/rfqController.js').then(m => m.handleRFQPostApproval) },
      TECHNICAL:         { APPROVED: () => import('../controllers/rfq/rfqController.js').then(m => m.handleTechnicalPostApproval) },
      PO:                { APPROVED: () => import('../controllers/po/purchaseOrderController.js').then(m => m.handlePOPostApproval) },
      // ARC v2 entity types — separate from v1's catch-all 'ARC'. See plan §5.5.
      ARC_TECH:          { APPROVED: () => import('../controllers/arc_v2/arcEvaluationController.js').then(m => m.handleArcTechPostApproval) },
      ARC_COMMITTEE:     { APPROVED: () => import('../controllers/arc_v2/arcCommitteeController.js').then(m => m.handleArcCommitteeApproval) },
      ARC_AMENDMENT:     { APPROVED: () => import('../controllers/arc_v2/arcAmendmentController.js').then(m => m.handleArcAmendmentApproval) },
      MR:                { APPROVED: () => import('../controllers/mr/mrController.js').then(m => m.handleMrPostApproval) },
      NEGOTIATION:       { APPROVED: () => import('../controllers/negotiation/negotiationController.js').then(m => m.handleNegotiationPostApproval) },
      NEGOTIATION_QUOTE: { APPROVED: () => import('../controllers/general/negotiationQuotePostApproval.js').then(m => m.handleNegotiationQuotePostApproval) },
    };

    const loader = postActionRegistry[instance.entity_type]?.APPROVED;
    if (loader) {
      const handler = await loader();
      if (typeof handler === 'function') {
        await handler(instanceId, changedBy, {
          comment: `Auto-completed due to ${reason}`,
          instance,
        });
      }
    }

    // Record lifecycle event
    try {
      await recordLifecycleEvent({
        entity_type: instance.entity_type,
        entity_id: instance.entity_id,
        stage: 'APPROVED',
        action: 'APPROVE',
        performed_by: changedBy,
        metadata: { approval_instance_id: instanceId, auto_completed_by: reason },
        remarks: `Auto-completed due to ${reason}`
      });
    } catch (lcErr) {
      logError('Error recording lifecycle event for auto-completion', lcErr);
    }
  } catch (err) {
    logError(`Post-approval handler failed for auto-completed instance ${instanceId}`, err);
  }
}

// ============================================================================
// SECTION 2B: THE CREATION-TIME PERMISSION GATE, APPLIED MID-FLIGHT
// ============================================================================

/**
 * `createApprovalInstance` refuses to build a ROLE-source step whose role does
 * not hold BOTH `read` and `approve` on the entity's resource
 * (generalModel.js:2235-2239 → roleHasReadAndApprovePermission). The step is
 * skipped outright: it never exists, and it does not even consume a step number.
 *
 * Nothing re-applied that gate afterwards. `resolveApprovers` — the only check
 * the reconciler ran — never reads `tbl_role_permissions` at all; it matches on
 * `tbl_user_role_scopes` (who holds the role) and says nothing about what the
 * role is allowed to do. So `PUT /api/v1/rbac/roles/:roleId` could strip
 * `approve` (or `read`) from a live role and every already-snapshotted approver
 * row backed by it stayed PENDING.
 *
 * That is not cosmetic, because THE SNAPSHOT IS THE AUTHORIZATION:
 * `generalModel.submitApprovalAction` validates only that the acting user has a
 * row on the current step with `status = 'PENDING'`. It re-checks no role, no
 * permission and no scope. Anything surviving in `tbl_approval_step_approvers`
 * keeps real authority over POs, RFQs and ARCs.
 *
 * ── WHY THIS FAILS OPEN ON AN UNKNOWN RESOURCE ──
 * `tbl_permissions.resource` is the `resource_type` ENUM, and
 * ENTITY_APPROVE_RESOURCE_MAP still does not cover every entity type — INDENT,
 * for instance, falls back to `entity_type.toLowerCase()`, which yields
 * `indent`, not an enum member. (ARC_TECH, ARC_COMMITTEE and ARC_AMENDMENT WERE
 * in that group; all three are mapped now — ARC_AMENDMENT to 'arc' — see the
 * resource table on ENTITY_APPROVE_RESOURCE_MAP in generalModel.js.) A "false"
 * for an unmapped resource says nothing about the role — it says the map has a
 * hole.
 *
 * `roleHasReadAndApprovePermission` no longer RAISES on such a value: it casts
 * the column (`p.resource::text = $2`) so an unknown resource returns false.
 * That fixed a 500 at creation time, but it does not make "false" meaningful
 * here. Mid-flight, acting on a meaningless false would DESTROY a live step and
 * advance an instance nobody approved — strictly worse than withholding an
 * approval that was never collected.
 *
 * ── TWO DISTINCT FAIL-OPEN REASONS, AND WHY THE SECOND ONE EXISTS ──
 * The catalogue is probed first, and a "false" is only trusted when the
 * catalogue can actually EXPRESS the requirement — i.e. when BOTH
 * `<resource>.read` and `<resource>.approve` rows exist:
 *
 *   RESOURCE_NOT_IN_CATALOGUE   neither row exists (e.g. 'indent'). The map
 *                               has a hole.
 *   RESOURCE_CANNOT_SATISFY_GATE  one of the two exists, the other does not.
 *
 * The second case is not hypothetical: production's `tender` resource holds
 * ONLY `approve` — there is no `tender.read` row anywhere — so
 * `roleHasReadAndApprovePermission(<any role>, 'tender')` can never return true
 * for any role that will ever exist. A "false" there is a statement about the
 * PERMISSION CATALOGUE, not about the role, exactly like the first case; the
 * only difference is that a partial resource used to slip past the "is it in the
 * catalogue at all" probe and get treated as a real verdict. Downstream, that
 * meant the policy-save guard rejected every ROLE step of every TENDER policy
 * with a 400 an admin could not resolve through any UI, because `tender.read`
 * does not exist and therefore cannot be granted to anything.
 *
 * Both fail OPEN and both log at warn: silence would trade a visible error for
 * the invisible under-approval this whole branch exists to eliminate.
 *
 * @returns {{permitted: boolean, resource: string, reason: string, missing_actions?: string[]}}
 */
export async function roleStepPermissionVerdict(roleId, entityType, t = db, cache = null) {
  const resource = ENTITY_APPROVE_RESOURCE_MAP[entityType] || String(entityType || '').toLowerCase();
  const cacheKey = `${roleId}::${resource}`;
  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);

  let verdict;
  // DISTINCT: 'arc' and 'tender' each carry a duplicate `approve` row in
  // production, so a plain count would mis-read a partial resource as complete.
  const rows = await t.any(
    `SELECT DISTINCT p.action::text AS action
       FROM tbl_permissions p
      WHERE p.resource::text = $1 AND p.action IN ('read', 'approve')`,
    [resource]
  );
  const present = new Set(rows.map(r => r.action));
  const missingActions = ['read', 'approve'].filter(a => !present.has(a));

  if (present.size === 0) {
    verdict = { permitted: true, resource, reason: 'RESOURCE_NOT_IN_CATALOGUE' };
    logger.warn(`[RolePermGate] entity_type ${entityType} maps to resource '${resource}', which has no read/approve rows in tbl_permissions — role ${roleId} left in place (failing OPEN; a map hole is not evidence about the role)`);
  } else if (missingActions.length > 0) {
    verdict = { permitted: true, resource, reason: 'RESOURCE_CANNOT_SATISFY_GATE', missing_actions: missingActions };
    logger.warn(
      `[RolePermGate] entity_type ${entityType} maps to resource '${resource}', which is MISSING ${missingActions.map(a => `${resource}.${a}`).join(' + ')} ` +
      `in tbl_permissions — NO role can ever pass the read+approve gate for it, so role ${roleId} is left in place (failing OPEN). ` +
      `Consequence: ROLE-source steps on ${entityType} policies WILL be dropped when an approval instance is created, and an instance ` +
      `whose every step is dropped is born APPROVED with nobody having approved it. Seed the missing permission row to fix this properly.`
    );
  } else {
    const ok = await roleHasReadAndApprovePermission(roleId, resource, t);
    verdict = { permitted: ok, resource, reason: ok ? 'OK' : 'MISSING_READ_OR_APPROVE' };
  }

  if (cache) cache.set(cacheKey, verdict);
  return verdict;
}

/**
 * Retire a PENDING instance step whose ROLE source has lost read+approve.
 *
 * ── WHY THE *STEP* IS MARKED REMOVED AND NOT MERELY ITS APPROVERS ──
 * Marking only the approvers REMOVED also advances the instance, via
 * `reEvaluateInstanceStep`'s "no non-REMOVED approvers left → auto-complete"
 * branch — but that branch writes `status = 'APPROVED', completed_at = NOW()`.
 * The instance would then carry a step recorded as APPROVED with zero approval
 * actions behind it. On spend of this size an approval nobody granted is the
 * worst artifact this engine can produce: it is indistinguishable, to a reader
 * and to every downstream query, from a real one.
 *
 * The honest analogue of the creation-time behaviour is "this step should not
 * exist", and the engine already has a vocabulary for exactly that — the
 * STEP_REMOVED path in `applyDiffToInstance`, used when a policy step is
 * deleted under a live instance. This mirrors it byte for byte: step →
 * `REMOVED` + `removed_mid_flight`, PENDING approvers → `REMOVED` with a
 * removal reason, one `STEP_REMOVED` audit row, and advancement only if this
 * was the current step. APPROVED/REJECTED approver rows are left untouched,
 * same as there — an action already taken is history, not state.
 *
 * Returns null when the step is no longer PENDING (already retired by an
 * earlier row in the same pass, or completed concurrently).
 */
async function retireIneligibleRoleStep({ instanceId, stepId, roleId, resource, changedBy, changeType, t }) {
  // Re-read under the caller's instance lock rather than trusting the
  // discovery snapshot: one instance can hold several steps backed by the same
  // role, and an earlier iteration may already have advanced past this one.
  const step = await t.oneOrNone(
    'SELECT id, step_order, status FROM tbl_approval_instance_steps WHERE id = $1',
    [stepId]
  );
  if (!step || step.status !== 'PENDING') return null;

  await t.none(
    `UPDATE tbl_approval_instance_steps
        SET status = 'REMOVED', removed_mid_flight = true, completed_at = NOW()
      WHERE id = $1`,
    [step.id]
  );
  notifyApprovalChanged({ instanceIds: instanceId }, t);

  const pendingApprovers = await t.any(
    `SELECT approver_user_id FROM tbl_approval_step_approvers
      WHERE approval_instance_step_id = $1 AND status = 'PENDING'`,
    [step.id]
  );
  if (pendingApprovers.length > 0) {
    await t.none(
      `UPDATE tbl_approval_step_approvers
          SET status = 'REMOVED', removed_at = NOW(), removal_reason = $2
        WHERE approval_instance_step_id = $1 AND status = 'PENDING'`,
      [step.id, changeType]
    );
  }

  await t.none(
    `INSERT INTO tbl_approval_actions
       (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
     VALUES ($1, $2, $3, 'STEP_REMOVED', $4)`,
    [instanceId, step.id, changedBy,
      `Step removed: role ${roleId} no longer holds both ${resource}.read and ${resource}.approve`]
  );

  logger.warn(`[RolePermGate] instance ${instanceId} step ${step.id} (step_order=${step.step_order}) REMOVED — role ${roleId} lost ${resource}.read/${resource}.approve; ${pendingApprovers.length} pending approver row(s) revoked`);

  // Advance only if this was the step the instance is actually sitting on;
  // a future step simply stays dead and `advanceInstanceToNextStep` skips it.
  let instanceCompleted = false;
  const instance = await t.oneOrNone(
    'SELECT current_step, status FROM tbl_approval_instances WHERE id = $1',
    [instanceId]
  );
  if (instance && instance.status === 'PENDING' && step.step_order === instance.current_step) {
    const adv = await advanceInstanceToNextStep(instanceId, t);
    instanceCompleted = adv.instanceCompleted;
  }

  return {
    step_id: step.id,
    step_order: step.step_order,
    approver_user_ids: pendingApprovers.map((a) => a.approver_user_id),
    instanceCompleted,
  };
}

// ============================================================================
// SECTION 3: APPLY DIFF TO A SINGLE INSTANCE
// ============================================================================

/**
 * Apply a policy step diff to a single PENDING approval instance.
 * Must be called within a transaction that holds FOR UPDATE locks on the instance.
 *
 * @param {Object} [mapping] — how instance steps map onto the OLD policy steps
 * @param {Map}    [mapping.instanceLinks] — Map<instance step id, old policy step id>
 *        captured by snapshotPendingInstanceStepLinks before the old policy
 *        steps were deleted. Omitted → the links stored on the instance rows
 *        are used (correct only while the old policy steps still exist).
 * @param {Map}    [mapping.oldStepIdByOrder] — Map<old step_order, old policy
 *        step id> covering EVERY old policy step. Omitted → the ordinal
 *        fallback is never used.
 * @param {Map}    [mapping.stepIdMap] — old policy step id → new policy step id
 *        for every paired level.
 * @param {Map}    [mapping.newOrderById] — new policy step id → step_order for
 *        every level of the edited policy. With stepIdMap, added levels are
 *        placed by their neighbours; omitted → by the policy ordinal.
 *
 * @returns {{ approversAdded: Array, approversRemoved: Array,
 *             approversKeptApproved: Array, stepsAdded: Array, stepsRemoved: Array,
 *             stepsModified: Array, stepsMoved: Array, unmatchedDiffEntries: Array,
 *             stepOrigins: Array, rulesChanged: Array, autoCompleted: boolean }}
 *   `stepOrigins` are `{instance_step_id, policy_step_id}` — the OLD policy step
 *   every instance step is known to come from, so the caller can re-point
 *   `policy_step_id` at that level's new row BY INSTANCE STEP ID.
 *   `unmatchedDiffEntries` are `{type: 'UNMATCHED_SKIPPED', diff_type,
 *   step_order, policy_step_id}` for removals / modifications / moves that
 *   found no instance step — a reconciliation this instance did NOT receive.
 *   Same reporting standard as PART 1's `unresolvedSteps` in
 *   revalidateApproverMembership. Additions are never unmatched: one that
 *   cannot be placed is appended (`stepsAdded[].placement === 'appended'`).
 *   A position-paired modification that lands on a closed step is reported as
 *   an addition placed at that step (`stepsAdded[].converted_from ===
 *   'STEP_MODIFIED'`, `placement: 'replaced_step'`, `replaces_instance_step_id`),
 *   not in `stepsModified`. An added or modified
 *   level that resolves to nobody carries `blocked: true, reason:
 *   'NO_APPROVERS_RESOLVED'`: its step is PENDING and nobody can approve it.
 *
 * INVARIANT: a policy edit never completes a live approval. The only edit
 * that may close the instance is an explicit removal of its last pending
 * level with nothing added (`autoCompleted`).
 */
export async function applyDiffToInstance(instance, diff, policy, changedBy, t, mapping = {}) {
  const { instanceLinks = null, oldStepIdByOrder = null, stepIdMap = null, newOrderById = null } = mapping;
  // Steps / approvers of this live instance are about to change — announce
  // after commit (de-duplicated per transaction, dropped on rollback).
  notifyApprovalChanged({ instanceIds: instance.id }, t);
  const result = {
    approversAdded: [],
    approversRemoved: [],
    // Approvers who already APPROVED on a step whose source changed and who
    // are no longer in the new resolution. Their action stands (we keep their
    // APPROVED row untouched) but they get a courtesy "your prior approval
    // still counts" email instead of silence.
    approversKeptApproved: [],
    stepsAdded: [],
    stepsRemoved: [],
    // Instance steps matched to a STEP_MODIFIED diff entry, with the new policy
    // step id they now belong to.
    stepsModified: [],
    // Instance steps whose level only moved within the policy. Nothing about
    // them changes except the policy_step_id the caller re-points.
    stepsMoved: [],
    // Diff entries that claimed no instance step at all: the policy step was
    // dropped at creation time (routine — nothing to reconcile), or the
    // instance carries no link and does not line up with the old policy, so
    // its steps cannot be attributed without guessing. Reported, never guessed.
    unmatchedDiffEntries: [],
    stepOrigins: [],
    rulesChanged: [],
    autoCompleted: false
  };

  if (!diff || diff.length === 0) return result;

  // Load instance steps with their approvers
  const instanceSteps = await t.any(
    `SELECT * FROM tbl_approval_instance_steps
     WHERE approval_instance_id = $1
     ORDER BY step_order ASC`,
    [instance.id]
  );

  // All entities are department-scoped
  const resolveDeptId = instance.department_id;

  // Applied in this order: moves (bookkeeping only), additions, removals,
  // modifications. Additions go first so that removing the current level
  // advances onto an added one instead of completing the instance.
  const removals = diff.filter(d => d.type === 'STEP_REMOVED');
  const modifications = diff.filter(d => d.type === 'STEP_MODIFIED');
  const moves = diff.filter(d => d.type === 'STEP_MOVED');
  const additions = diff.filter(d => d.type === 'STEP_ADDED').sort((a, b) => a.step_order - b.step_order);

  // ── WHICH INSTANCE STEP DOES A DIFF ENTRY (a POLICY level) BELONG TO? ──
  //
  // Instance numbering is NOT policy numbering: createApprovalInstance drops a
  // policy step that resolves to nobody (or whose role cannot approve) WITHOUT
  // consuming a number (generalModel.js `stepNumber++`), so policy level 2 is
  // routinely instance step 1. Guessing by ordinal applies a removal or a
  // source change to the wrong step of a live approval.
  //
  //   1. The link — the instance step whose originating policy step IS the
  //      entry's old step. Captured before the edit deleted the old rows.
  //   2. The ordinal — ONLY for an instance that carries no link at all AND
  //      whose policy-built steps sit at exactly the old policy's step_orders,
  //      i.e. nothing was dropped at creation, so the ordinal is a 1:1 mapping
  //      rather than a guess. A step REMOVED mid-flight or added mid-flight was
  //      not built from the old policy and is left out of that comparison.
  //   3. Otherwise no match: the entry is recorded as UNMATCHED_SKIPPED and this
  //      instance is not mutated for it. Fail closed — a skipped reconciliation
  //      is visible in the change log; a wrong one silently grants or strips
  //      approval authority.
  //
  // The two keys never mix on one instance (the ordinal is only consulted when
  // no link exists), and one instance step is claimed by at most one entry.
  const linkOf = instanceLinks
    ? (s) => instanceLinks.get(Number(s.id)) ?? null
    : (s) => (s.policy_step_id == null ? null : Number(s.policy_step_id));
  const hasLinks = instanceSteps.some(s => linkOf(s) != null);
  const policyBuiltOrders = instanceSteps
    .filter(s => s.status !== 'REMOVED' && !s.added_mid_flight)
    .map(s => s.step_order)
    .sort((a, b) => a - b);
  const oldOrders = oldStepIdByOrder ? [...oldStepIdByOrder.keys()].sort((a, b) => a - b) : null;
  const ordinalIsExact = !hasLinks && oldOrders !== null &&
    policyBuiltOrders.length === oldOrders.length &&
    policyBuiltOrders.every((order, i) => order === oldOrders[i]);

  const claimedStepIds = new Set();
  const stepForDiff = new Map(); // diff entry (by identity) -> instance step row

  // STEP_ADDED is excluded on purpose — it creates a new row rather than
  // claiming an existing one, and its position is derived separately below.
  const claimingEntries = [...removals, ...modifications, ...moves]
    .sort((a, b) => stepOrderOf(a.oldStep) - stepOrderOf(b.oldStep));

  for (const d of claimingEntries) {
    const oldPolicyStepId = d.oldStep?.id == null ? null : Number(d.oldStep.id);
    const oldOrder = stepOrderOf(d.oldStep);
    let hit = null;
    let via = null;
    if (oldPolicyStepId != null) {
      hit = instanceSteps.find(s => !claimedStepIds.has(s.id) && linkOf(s) === oldPolicyStepId);
      via = 'policy_step_id';
    }
    if (!hit && ordinalIsExact) {
      hit = instanceSteps.find(s => !claimedStepIds.has(s.id) && s.step_order === oldOrder);
      via = 'step_order';
    }
    if (!hit) {
      logger.warn(`[PropagateMatch] instance ${instance.id}: ${d.type} policy step_order=${oldOrder} (policy_step_id=${oldPolicyStepId ?? 'n/a'}) matched NO instance step (linked=${hasLinks}) — UNMATCHED_SKIPPED, this reconciliation was not applied`);
      result.unmatchedDiffEntries.push({
        type: 'UNMATCHED_SKIPPED',
        diff_type: d.type,
        step_order: oldOrder,
        policy_step_id: oldPolicyStepId
      });
      continue;
    }
    claimedStepIds.add(hit.id);
    stepForDiff.set(d, hit);
    logger.info(`[PropagateMatch] ${d.type} policy step_order=${oldOrder} (policy_step_id=${oldPolicyStepId ?? 'n/a'}): claimed instance step id=${hit.id} step_order=${hit.step_order} status=${hit.status} via ${via}`);
  }

  // Every instance step whose originating policy step is known — by link, or by
  // the exact ordinal — whether or not this edit touches it. The caller
  // re-points them all, so the instance leaves this edit fully linked.
  for (const s of instanceSteps) {
    let origin = linkOf(s);
    if (origin == null && ordinalIsExact && s.status !== 'REMOVED' && !s.added_mid_flight) {
      origin = oldStepIdByOrder.get(s.step_order) ?? null;
    }
    if (origin != null) result.stepOrigins.push({ instance_step_id: s.id, policy_step_id: origin });
  }

  const findInstanceStepForDiff = (d) => stepForDiff.get(d);

  // --- STEP MOVES ---
  // A level that only changed position. The instance keeps its own order (it is
  // mid-flight); the move is recorded and the link re-pointed by the caller.
  for (const d of moves) {
    const instStep = findInstanceStepForDiff(d);
    if (!instStep) continue;
    result.stepsMoved.push({ instance_step_id: instStep.id, step_order: instStep.step_order, from: d.from, to: d.to });
  }

  // ── HELPERS SHARED BY ADDITIONS, REMOVALS AND MODIFICATIONS ──

  // Open a gap at `fromOrder`. Two statements, not `step_order = step_order + 1`:
  // idx_unique_instance_step_order is checked row by row, so a one-statement
  // shift of two or more rows collides with itself and the edit fails.
  const shiftInstanceSteps = async (fromOrder) => {
    await t.none(
      `UPDATE tbl_approval_instance_steps SET step_order = -(step_order + 1)
        WHERE approval_instance_id = $1 AND step_order >= $2`,
      [instance.id, fromOrder]
    );
    await t.none(
      `UPDATE tbl_approval_instance_steps SET step_order = -step_order
        WHERE approval_instance_id = $1 AND step_order < 0`,
      [instance.id]
    );
    // Later loops compare in-memory step_order with current_step.
    for (const s of instanceSteps) if (s.step_order >= fromOrder) s.step_order += 1;
  };

  // Who the EDITED policy's level names, in this instance's scope. Same
  // eligibility rule creation uses — see policyStepApproverEligibility.
  // Without it, editing a live policy could install an approver that creating
  // the same instance would have dropped, and that approver is binding
  // (submitApprovalAction re-checks nothing). An ineligible source resolves to
  // NOBODY. Both callers treat nobody the same way — fillAddedStep and the
  // STEP_MODIFIED path BLOCK the step (PENDING, an audit row saying why, a
  // `blocked` report); neither ever approves it.
  const resolveEditedLevel = async (policyStep, diffType) => {
    const eligibility = await policyStepApproverEligibility(
      policyStep, instance.entity_type,
      {
        hospitality_company_id: instance.hospitality_company_id,
        hotel_id: instance.hotel_id,
        department_id: resolveDeptId,
        process_id: instance.process_id || null,
      }, t
    );
    if (!eligibility.eligible) {
      logger.warn(
        `[PropagateGate] ${diffType}: policy step ${policyStep.id} source ` +
        `${policyStep.approver_source_type}/${policyStep.approver_source_id} is INELIGIBLE ` +
        `for ${instance.entity_type} (${eligibility.reason}, resource '${eligibility.resource}') — ` +
        `resolving to nobody on instance ${instance.id} instead of installing them.`
      );
      return [];
    }
    return resolveApprovers(
      policyStep, instance.hospitality_company_id, instance.hotel_id,
      resolveDeptId, t, null, instance.process_id || null
    );
  };

  // Resolve and attach approvers to an added step that is (now) PENDING.
  // Returns the stepsAdded report fields for it.
  const fillAddedStep = async (stepRow, newStep) => {
    const newResolvedIds = await resolveEditedLevel(newStep, 'STEP_ADDED');

    if (newResolvedIds.length === 0) {
      // A NEW authority that resolves to nobody RIGHT NOW must BLOCK, not
      // vanish. The step stays PENDING with zero approvers so the instance
      // stalls until somebody is granted the role.
      //
      // This used to be written SKIPPED, and that voided the final authority
      // on two production POs (138699 / 138701): an admin added a 4th level at
      // 20:57 and granted the role ten hours later; the level was already
      // SKIPPED, the add-approver reconciler only looks at PENDING steps (see
      // revalidateApproverMembership PART 2), so the grant never reached it.
      // PENDING is what makes this recoverable. A stalled approval is visible
      // and fixable; a bypassed one is neither.
      logger.error(
        {
          instance_id: instance.id,
          entity_type: instance.entity_type,
          entity_id: instance.entity_id,
          step_order: stepRow.step_order,
          policy_step_id: newStep.id,
          approver_source_type: newStep.approver_source_type,
          approver_source_id: newStep.approver_source_id,
        },
        '[ApprovalPropagation] BLOCKED: a policy step was added to a live instance but resolves to no approvers. The approval cannot proceed until somebody holds that role in scope.'
      );
      await t.none(
        `INSERT INTO tbl_approval_actions
           (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
         VALUES ($1, $2, $3, 'STEP_ADDED', $4)`,
        [
          instance.id,
          stepRow.id,
          instance.initiated_by,
          `Step ${stepRow.step_order} added by a policy change but resolves to no approver in this scope — approval is blocked here until the role is granted.`,
        ]
      );
      return { status: 'PENDING', blocked: true, reason: 'NO_APPROVERS_RESOLVED' };
    }

    for (const userId of newResolvedIds) {
      const isInitiator = userId === instance.initiated_by;
      await t.none(
        `INSERT INTO tbl_approval_step_approvers
         (approval_instance_step_id, approver_user_id, status, added_mid_flight, acted_at, comment)
         VALUES ($1, $2, $3, true, $4, NULL)`,
        [stepRow.id, userId, isInitiator ? 'APPROVED' : 'PENDING', isInitiator ? new Date() : null]
      );
      if (isInitiator) {
        await t.none(
          `INSERT INTO tbl_approval_actions
           (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
           VALUES ($1, $2, $3, 'APPROVE', NULL)`,
          [instance.id, stepRow.id, userId]
        );
      }
      result.approversAdded.push({ user_id: userId, step_order: stepRow.step_order, auto_approved: isInitiator });
    }
    await t.none(
      `INSERT INTO tbl_approval_actions
       (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
       VALUES ($1, $2, $3, 'STEP_ADDED', 'Step added due to policy change')`,
      [instance.id, stepRow.id, changedBy]
    );
    return { status: 'PENDING', approverCount: newResolvedIds.length };
  };

  // Added levels written SKIPPED because they landed inside the completed
  // prefix: { row, newStep, reported }.
  const skippedAdditions = [];

  // The step at current_step just closed (removed, or completed by a
  // modification). Move on — except that an edit which ADDS levels never leaves
  // the instance completed: if nothing PENDING remains ahead, the added levels
  // that were written SKIPPED are the only authority left, so they become
  // PENDING and the first of them current. Removing the last pending level with
  // NO additions still completes the instance — that is what the admin asked for.
  const advancePastClosedStep = async () => {
    if (skippedAdditions.length > 0) {
      const pendingAhead = await t.oneOrNone(
        `SELECT 1 FROM tbl_approval_instance_steps
          WHERE approval_instance_id = $1 AND status = 'PENDING' AND step_order > $2 LIMIT 1`,
        [instance.id, instance.current_step]
      );
      if (!pendingAhead) {
        const revived = skippedAdditions.splice(0).sort((a, b) => a.row.step_order - b.row.step_order);
        for (const a of revived) {
          await t.none(
            `UPDATE tbl_approval_instance_steps SET status = 'PENDING', completed_at = NULL WHERE id = $1`,
            [a.row.id]
          );
          a.row.status = 'PENDING';
          Object.assign(a.reported, await fillAddedStep(a.row, a.newStep), { revived: true });
        }
        instance.current_step = revived[0].row.step_order;
        await t.none(
          `UPDATE tbl_approval_instances SET current_step = $1 WHERE id = $2`,
          [instance.current_step, instance.id]
        );
        logger.warn(`[PropagateAdd] instance ${instance.id}: the edit left no pending level, so ${revived.length} added level(s) placed before the current step were made PENDING instead of SKIPPED; current_step=${instance.current_step}`);
        return;
      }
    }
    const adv = await advanceInstanceToNextStep(instance.id, t);
    if (adv.instanceCompleted) {
      result.autoCompleted = true;
    } else if (adv.nextStepOrder) {
      instance.current_step = adv.nextStepOrder;
    }
  };

  // ── A POSITION PAIR THAT LANDS ON A CLOSED STEP IS AN ADDITION ──
  // A position-paired STEP_MODIFIED (sourceChanged) says "a DIFFERENT approver
  // now sits at this level". When the instance step built from that level is
  // already closed (APPROVED, SKIPPED, REMOVED, …) there is nothing left on it
  // to modify — and dropping the change let an edit that also closes the
  // current step complete the instance with the new approver never asked:
  // [A,B] → [C] pairs A↔C onto A's approved step and removes B, and the
  // instance finished. For THIS instance such a pair is the removal of the old
  // level plus the ADDITION of the new one: the closed step stays as history,
  // no longer linked to the level (it is left out of `stepOrigins`, and it
  // anchors nothing below), and the new source goes through the additions
  // below, placed AT the closed step's position (`placement:
  // 'replaced_step'`, controller ruling). Then R2/R3: inside the completed
  // prefix → SKIPPED, so [A,B] → [C,B] waiting at B does not send the approval
  // back to level 1; revived as the current PENDING step only if the instance
  // would otherwise complete ([A,B] → [C]). A closed step after the current
  // one (a dead SKIPPED/REMOVED step ahead) puts the new level ahead → PENDING.
  const retiredStepIds = new Set();
  const convertedModifications = new Set();
  const convertedAdditions = [];
  for (const d of modifications) {
    if (!d.sourceChanged) continue;
    const instStep = findInstanceStepForDiff(d);
    if (!instStep || instStep.status === 'PENDING') continue;
    retiredStepIds.add(instStep.id);
    convertedModifications.add(d);
    convertedAdditions.push({ type: 'STEP_ADDED', step_order: stepOrderOf(d.newStep), newStep: d.newStep, replaces: instStep });
    logger.info(`[PropagateModify] instance ${instance.id}: position-paired level change (policy step_order=${stepOrderOf(d.oldStep)} → ${stepOrderOf(d.newStep)}) lands on closed instance step id=${instStep.id} (${instStep.status}) — the new source is ADDED instead`);
  }
  const allAdditions = [...additions, ...convertedAdditions].sort((a, b) => a.step_order - b.step_order);

  // --- STEP ADDITIONS (before removals, so a removal never completes an
  //     instance the edit also extended) ---
  //
  // WHERE an added level goes. With the full new policy known (`stepIdMap` +
  // `newOrderById`, i.e. every real policy edit), it goes by its NEIGHBOURS in
  // the new policy: immediately before the instance step built from the
  // nearest following level; with no following level, after every existing
  // step (so after the one built from the preceding level). Steps of levels
  // this edit removes anchor nothing — they are about to go. That needs every
  // live instance step to be attributable to a level; if one is not, or the
  // two neighbours sit in the instance in the opposite order, the level is
  // APPENDED after every existing step instead (`placement: 'appended'`).
  // An added level is never dropped: dropping it lets an edit that also closes
  // the current step complete the instance with the new approver never asked.
  // Appended levels are PENDING, so closing the current step advances onto the
  // first of them. Callers that pass no new-policy map (direct callers of this
  // exported function) get the policy ordinal.
  //
  // WHAT it becomes, by where it lands relative to the current step:
  //   before it — its following level's step is already completed, i.e. it is
  //               inside the completed prefix → SKIPPED (but see
  //               advancePastClosedStep: never if that would finish the instance);
  //   at it     — its following level IS the current step → PENDING and
  //               current; the old current step waits after it;
  //   after it  → PENDING.
  const placeByNeighbours = Boolean(stepIdMap && newOrderById);
  const newOrderOfStep = new Map(); // live instance step id -> its level's new step_order
  let additionsPlaceable = true;
  if (placeByNeighbours && allAdditions.length > 0) {
    const originOf = new Map(result.stepOrigins.map(o => [o.instance_step_id, o.policy_step_id]));
    for (const s of instanceSteps) {
      if (s.status === 'REMOVED') continue;
      if (!originOf.has(s.id)) { additionsPlaceable = false; break; }
      // Attributable, but its level was replaced by this edit (see above).
      if (retiredStepIds.has(s.id)) continue;
      const newId = stepIdMap.get(originOf.get(s.id));
      // A level removed by this edit has no new position; its step is about
      // to be removed and anchors nothing.
      if (newId != null && newOrderById.has(Number(newId))) newOrderOfStep.set(s.id, newOrderById.get(Number(newId)));
    }
  }

  let renumberOffset = 0;
  const afterLastStep = () => Math.max(0, ...instanceSteps.map(s => s.step_order)) + 1;
  for (const d of allAdditions) {
    const newOrder = stepOrderOf(d.newStep);
    let insertPosition;
    let placement;
    if (d.replaces) {
      // A converted position pair takes the place of the closed step it
      // replaces (that step moves down one). Before the current step that is
      // inside the completed prefix → SKIPPED: the approval is not sent back
      // to a level it has passed. R3 still revives it if this edit would
      // otherwise complete the instance.
      insertPosition = d.replaces.step_order;
      placement = 'replaced_step';
      if (!placeByNeighbours) renumberOffset++;
    } else if (placeByNeighbours) {
      let pred = null;
      let succ = null;
      if (additionsPlaceable) {
        for (const s of instanceSteps) {
          const o = newOrderOfStep.get(s.id);
          if (o === undefined) continue;
          if (o < newOrder && (!pred || o > newOrderOfStep.get(pred.id))) pred = s;
          if (o > newOrder && (!succ || o < newOrderOfStep.get(succ.id))) succ = s;
        }
      }
      if (!additionsPlaceable || (!pred && !succ) || (pred && succ && pred.step_order >= succ.step_order)) {
        insertPosition = afterLastStep();
        placement = 'appended';
        logger.warn(`[PropagateAdd] instance ${instance.id}: STEP_ADDED policy step_order=${newOrder} (policy_step_id=${d.newStep.id}) has no reliable place between its neighbours (placeable=${additionsPlaceable}) — APPENDED as PENDING at step ${insertPosition}`);
      } else {
        insertPosition = succ ? succ.step_order : afterLastStep();
        placement = 'neighbours';
      }
    } else {
      insertPosition = d.step_order + renumberOffset;
      renumberOffset++;
      placement = 'ordinal';
    }

    const currentOrder = instance.current_step;
    await shiftInstanceSteps(insertPosition);
    if (insertPosition < currentOrder) {
      // The current step moved down one place.
      instance.current_step += 1;
      await t.none(
        `UPDATE tbl_approval_instances SET current_step = $1 WHERE id = $2`,
        [instance.current_step, instance.id]
      );
    }
    // insertPosition === currentOrder: current_step now names the added step.

    const insideCompletedPrefix = insertPosition < currentOrder;
    const row = await t.one(
      `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, step_order, decision_rule, status, policy_step_id, added_mid_flight, completed_at)
       VALUES ($1, $2, $3, $4, $5, true, ${insideCompletedPrefix ? 'NOW()' : 'NULL'}) RETURNING *`,
      [instance.id, insertPosition, d.newStep.decision_rule || 'ANY',
        insideCompletedPrefix ? 'SKIPPED' : 'PENDING', d.newStep.id]
    );
    instanceSteps.push(row);
    newOrderOfStep.set(row.id, newOrder);

    // A converted position pair names the closed step it took over from.
    const replaced = d.replaces
      ? { converted_from: 'STEP_MODIFIED', replaces_instance_step_id: d.replaces.id }
      : {};
    if (insideCompletedPrefix) {
      const reported = { step_order: insertPosition, placement, status: 'SKIPPED', ...replaced };
      result.stepsAdded.push(reported);
      skippedAdditions.push({ row, newStep: d.newStep, reported });
    } else {
      result.stepsAdded.push({ step_order: insertPosition, placement, ...replaced, ...(await fillAddedStep(row, d.newStep)) });
    }
  }

  // --- STEP REMOVALS ---
  for (const d of removals) {
    const instStep = findInstanceStepForDiff(d);
    if (!instStep) continue; // step was skipped at creation time (0 approvers)

    if (instStep.status !== 'PENDING') {
      // Historical (APPROVED/REJECTED) or already dead (REMOVED/SKIPPED). Never
      // modify, and never write a second STEP_REMOVED audit row for a step that
      // is already gone.
      const reason = (instStep.status === 'APPROVED' || instStep.status === 'REJECTED')
        ? 'already_completed'
        : 'not_pending';
      result.stepsRemoved.push({ step_order: instStep.step_order, skipped: true, reason });
      continue;
    }

    // Mark step as REMOVED
    await t.none(
      `UPDATE tbl_approval_instance_steps SET status = 'REMOVED', removed_mid_flight = true, completed_at = NOW() WHERE id = $1`,
      [instStep.id]
    );
    // Keep the in-memory snapshot (loaded once, above) in step with the DB.
    // Every later loop reads `instStep.status` from this object; without this
    // line a step killed here still looks PENDING to them.
    instStep.status = 'REMOVED';

    // Mark all PENDING approvers as REMOVED
    const pendingApprovers = await t.any(
      `SELECT approver_user_id FROM tbl_approval_step_approvers
       WHERE approval_instance_step_id = $1 AND status = 'PENDING'`,
      [instStep.id]
    );
    if (pendingApprovers.length > 0) {
      await t.none(
        `UPDATE tbl_approval_step_approvers
         SET status = 'REMOVED', removed_at = NOW(), removal_reason = 'policy_change'
         WHERE approval_instance_step_id = $1 AND status = 'PENDING'`,
        [instStep.id]
      );
      for (const ap of pendingApprovers) {
        result.approversRemoved.push({ user_id: ap.approver_user_id, step_order: instStep.step_order });
      }
    }

    // Record audit action
    await t.none(
      `INSERT INTO tbl_approval_actions
       (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
       VALUES ($1, $2, $3, 'STEP_REMOVED', $4)`,
      [instance.id, instStep.id, changedBy, 'Step removed due to policy change']
    );

    result.stepsRemoved.push({ step_order: instStep.step_order, skipped: false });

    // If this was the current step, advance
    if (instStep.step_order === instance.current_step) {
      await advancePastClosedStep();
    }
  }

  // A modified level whose EDITED authority resolves to nobody in this scope
  // BLOCKS its step — exactly like fillAddedStep's 0-approver addition: the
  // step stays PENDING, an audit row says why, the change log reports it
  // `blocked`, and it is NOT re-evaluated. Re-evaluating it approved the step
  // through the tombstones of the approvers this edit had just removed (or
  // through an approval given under the authority the edit replaced), so an
  // edit completed a live approval and fired its post-approval handler.
  // PENDING keeps it recoverable: a later edit naming somebody who holds the
  // level, or a grant reaching it, fills it.
  const blockModifiedStep = async (instStep, d, reported) => {
    logger.error(
      {
        instance_id: instance.id,
        entity_type: instance.entity_type,
        entity_id: instance.entity_id,
        step_order: instStep.step_order,
        policy_step_id: d.newStep?.id,
        approver_source_type: d.newStep?.approver_source_type,
        approver_source_id: d.newStep?.approver_source_id,
      },
      '[ApprovalPropagation] BLOCKED: a policy edit points a live level at an approver who resolves to nobody in this scope. The approval cannot proceed until somebody holds that level.'
    );
    await t.none(
      `INSERT INTO tbl_approval_actions
         (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
       VALUES ($1, $2, $3, 'POLICY_CHANGE', $4)`,
      [
        instance.id,
        instStep.id,
        changedBy,
        `Step ${instStep.step_order} changed by a policy edit but resolves to no approver in this scope — approval is blocked here until somebody holds that level.`,
      ]
    );
    Object.assign(reported, { blocked: true, reason: 'NO_APPROVERS_RESOLVED' });
  };

  // --- STEP MODIFICATIONS (approver/rule changes) ---
  for (const d of modifications) {
    // Landed on a closed step: handled above as an addition of the new source.
    if (convertedModifications.has(d)) continue;
    const instStep = findInstanceStepForDiff(d);
    if (!instStep) continue;

    // Recorded regardless of the step's status — it is the change log's account
    // of which step this level change landed on. (Re-pointing `policy_step_id`
    // is driven by `stepOrigins`, which covers every attributable step.)
    const modifiedReport = {
      step_order: instStep.step_order,
      instance_step_id: instStep.id,
      new_policy_step_id: d.newStep?.id
    };
    if (d.newStep?.id) result.stepsModified.push(modifiedReport);

    if (instStep.status !== 'PENDING') {
      // Historical (APPROVED/REJECTED) or dead (REMOVED/SKIPPED) — audit note
      // only. REMOVED matters as much as APPROVED here: inserting a PENDING
      // approver row onto a dead step produces an approver record nobody can
      // act on, which getPendingApprovalsForUser still surfaces (it filters on
      // sa.status, not s.status) and dispatchPropagationEmails then emails
      // about. The one-claim-per-step matcher above already makes a removal
      // and a modification claiming the same step impossible; this is the
      // backstop for a step that was REMOVED by an earlier propagation.
      continue;
    }

    // Set when the edited level resolves to nobody here → the step is BLOCKED.
    let resolvesToNobody = false;

    // Handle approver source change
    if (d.sourceChanged) {
      logger.info(`[PropagateModify] Step ${d.step_order}: source changed from ${d.oldStep.approver_source_type}/${d.oldStep.approver_source_id} to ${d.newStep.approver_source_type}/${d.newStep.approver_source_id}`);
      logger.info(`[PropagateModify] Resolving with scope: company=${instance.hospitality_company_id}, hotel=${instance.hotel_id}, dept=${resolveDeptId}`);

      // Reconcile against ACTUAL current approvers in the DB rather than against
      // the old policy step's resolution. The DB is the source of truth — using
      // the old policy resolution would miss stale approvers left over from prior
      // failed propagations, manual inserts, or membership drift that predated
      // this propagation engine.
      const currentApproverRows = await t.any(
        `SELECT approver_user_id, status FROM tbl_approval_step_approvers
         WHERE approval_instance_step_id = $1 AND status != 'REMOVED'`,
        [instStep.id]
      );
      const currentApproverIds = currentApproverRows.map(r => r.approver_user_id);

      // Resolve NEW approvers (from the new policy step definition), with the
      // creation-time eligibility rule (resolveEditedLevel). NOBODY — an
      // ineligible source, or nobody holding it here — still tombstones the
      // old approvers below (they no longer hold this level), and then the
      // step is BLOCKED (blockModifiedStep): it stays PENDING and is never
      // approved through those tombstones.
      const newResolvedIds = await resolveEditedLevel(d.newStep, 'STEP_MODIFIED');
      if (newResolvedIds.length === 0) resolvesToNobody = true;

      logger.info(`[PropagateModify] Current DB approvers (non-REMOVED): [${currentApproverIds.join(',')}], New resolved: [${newResolvedIds.join(',')}]`);

      const toRemove = currentApproverIds.filter(id => !newResolvedIds.includes(id));
      const toAdd = newResolvedIds.filter(id => !currentApproverIds.includes(id));
      logger.info(`[PropagateModify] toRemove: [${toRemove.join(',')}], toAdd: [${toAdd.join(',')}]`);

      // Remove approvers
      for (const userId of toRemove) {
        const approverRow = await t.oneOrNone(
          `SELECT status FROM tbl_approval_step_approvers
           WHERE approval_instance_step_id = $1 AND approver_user_id = $2`,
          [instStep.id, userId]
        );
        if (!approverRow) continue;
        if (approverRow.status === 'APPROVED') {
          // Already approved — their action stands, but they should be told the
          // policy changed so they understand why their name is no longer in
          // the active approver list. Do NOT touch the DB row.
          result.approversKeptApproved.push({ user_id: userId, step_order: instStep.step_order });
          continue;
        }
        if (approverRow.status === 'REJECTED') {
          // Rejected approvers are silently skipped — a REJECT already
          // terminated the instance, so propagation shouldn't even reach this
          // branch in practice. Defensive no-op.
          continue;
        }
        if (approverRow.status === 'PENDING') {
          await t.none(
            `UPDATE tbl_approval_step_approvers
             SET status = 'REMOVED', removed_at = NOW(), removal_reason = 'policy_change'
             WHERE approval_instance_step_id = $1 AND approver_user_id = $2`,
            [instStep.id, userId]
          );
          await t.none(
            `INSERT INTO tbl_approval_actions
             (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
             VALUES ($1, $2, $3, 'APPROVER_REMOVED', 'Approver removed due to policy change')`,
            [instance.id, instStep.id, userId]
          );
          result.approversRemoved.push({ user_id: userId, step_order: instStep.step_order });
        }
      }

      // Add approvers
      for (const userId of toAdd) {
        // Check if already exists (e.g., was previously removed then re-added)
        const existing = await t.oneOrNone(
          `SELECT id, status FROM tbl_approval_step_approvers
           WHERE approval_instance_step_id = $1 AND approver_user_id = $2`,
          [instStep.id, userId]
        );
        if (existing && existing.status !== 'REMOVED') continue; // already active

        // Auto-approve if user is the initiator
        const isInitiator = userId === instance.initiated_by;
        const approverStatus = isInitiator ? 'APPROVED' : 'PENDING';
        const approverComment = null;

        if (existing) {
          // Re-activate previously removed approver
          await t.none(
            `UPDATE tbl_approval_step_approvers
             SET status = $1, removed_at = NULL, removal_reason = NULL, added_mid_flight = true,
                 acted_at = $2, comment = $3
             WHERE id = $4`,
            [approverStatus, isInitiator ? new Date() : null, approverComment, existing.id]
          );
        } else {
          await t.none(
            `INSERT INTO tbl_approval_step_approvers
             (approval_instance_step_id, approver_user_id, status, added_mid_flight, acted_at, comment)
             VALUES ($1, $2, $3, true, $4, $5)`,
            [instStep.id, userId, approverStatus, isInitiator ? new Date() : null, approverComment]
          );
        }

        if (isInitiator) {
          await t.none(
            `INSERT INTO tbl_approval_actions
             (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
             VALUES ($1, $2, $3, 'APPROVE', NULL)`,
            [instance.id, instStep.id, userId]
          );
        }

        await t.none(
          `INSERT INTO tbl_approval_actions
           (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
           VALUES ($1, $2, $3, 'APPROVER_ADDED', 'Approver added due to policy change')`,
          [instance.id, instStep.id, userId]
        );
        result.approversAdded.push({ user_id: userId, step_order: instStep.step_order, auto_approved: isInitiator });
      }
    }

    // Handle decision rule change
    if (d.ruleChanged) {
      await t.none(
        `UPDATE tbl_approval_instance_steps SET decision_rule = $1 WHERE id = $2`,
        [d.newRule, instStep.id]
      );
      result.rulesChanged.push({
        step_order: instStep.step_order,
        old_rule: d.oldRule,
        new_rule: d.newRule
      });
    }

    // A rule-only change keeps the level's approver, but that approver may
    // already resolve to nobody (a step blocked by an earlier edit). With no
    // live PENDING approver left on the step, relaxing the rule must not
    // complete it through history — check who the level names now.
    if (!d.sourceChanged && d.ruleChanged) {
      const livePending = await t.oneOrNone(
        `SELECT 1 FROM tbl_approval_step_approvers
          WHERE approval_instance_step_id = $1 AND status = 'PENDING' LIMIT 1`,
        [instStep.id]
      );
      if (!livePending && (await resolveEditedLevel(d.newStep, 'STEP_MODIFIED')).length === 0) {
        resolvesToNobody = true;
      }
    }

    if (resolvesToNobody) {
      await blockModifiedStep(instStep, d, modifiedReport);
      continue;
    }

    // Re-evaluate step completion after any modification
    if (d.sourceChanged || d.ruleChanged) {
      const evalResult = await reEvaluateInstanceStep(instStep.id, t);
      if (evalResult.completed) instStep.status = evalResult.status;
      if (evalResult.completed && instStep.step_order === instance.current_step) {
        await advancePastClosedStep();
      }
    }
  }

  // A closed step whose level a position pair replaced is history, not the new
  // level's step: leave it out of the re-pointing, so it does not end up
  // linked to the level its successor (the added step) now carries.
  if (retiredStepIds.size > 0) {
    result.stepOrigins = result.stepOrigins.filter(o => !retiredStepIds.has(o.instance_step_id));
  }

  return result;
}

// ============================================================================
// SECTION 4: POLICY CHANGE PROPAGATION (MAIN ORCHESTRATOR)
// ============================================================================

/**
 * Old policy step id → new policy step id for the levels a diff changed
 * (STEP_MODIFIED / STEP_MOVED). Used only when the caller supplies no stepIdMap
 * — then the old policy steps still exist, unchanged levels keep valid links,
 * and only the changed levels need re-pointing.
 */
function stepIdMapFromDiff(diff) {
  const map = new Map();
  for (const d of diff) {
    if ((d.type === 'STEP_MODIFIED' || d.type === 'STEP_MOVED') && d.oldStep?.id != null && d.newStep?.id != null) {
      map.set(Number(d.oldStep.id), Number(d.newStep.id));
    }
  }
  return map;
}

/**
 * Map<old step_order, old policy step id> over EVERY old policy step, rebuilt
 * after the old rows were deleted. A step in the diff carries its old row; a
 * step absent from the diff was paired by identity with nothing changed —
 * position included, or it would be STEP_MOVED — so its old step_order is its
 * new row's step_order (`newOrderById`). Returns null (ordinal fallback
 * disabled) if any of that cannot be established.
 */
function rebuildOldStepIdByOrder(diff, stepIdMap, newOrderById) {
  const byOrder = new Map();
  const inDiff = new Set();
  for (const d of diff) {
    if (!d.oldStep || d.oldStep.id == null) continue;
    inDiff.add(Number(d.oldStep.id));
    byOrder.set(stepOrderOf(d.oldStep), Number(d.oldStep.id));
  }
  for (const [oldId, newId] of stepIdMap) {
    if (inDiff.has(Number(oldId))) continue;
    const order = newOrderById.get(Number(newId));
    if (order === undefined || byOrder.has(order)) return null;
    byOrder.set(order, Number(oldId));
  }
  return byOrder;
}

/**
 * Re-point instance steps at new policy step rows, by instance step id —
 * confined to one instance, or to the pending instances of one policy.
 */
async function repointInstanceSteps(stepIds, newPolicyStepIds, t, { instanceId = null, policyId = null }) {
  if (stepIds.length === 0) return;
  await t.none(
    `UPDATE tbl_approval_instance_steps ais
        SET policy_step_id = m.new_policy_step_id
       FROM unnest($1::int[], $2::int[]) AS m(instance_step_id, new_policy_step_id)
      WHERE ais.id = m.instance_step_id
        AND ($3::int IS NULL OR ais.approval_instance_id = $3)
        AND ($4::int IS NULL OR ais.approval_instance_id IN (
              SELECT id FROM tbl_approval_instances WHERE approval_policy_id = $4 AND status = 'PENDING'))`,
    [stepIds, newPolicyStepIds, instanceId, policyId]
  );
}

/**
 * Propagate a policy step diff to all PENDING instances that use this policy.
 * Called from upsertApprovalPolicy controller after steps are updated.
 *
 * @param {Object} params
 * @param {number} params.policyId
 * @param {Array}  params.diff — output of computePolicyStepDiff()
 * @param {number} params.changedBy — user who made the policy change
 * @param {Object} params.policy — full policy row
 * @param {Object} params.t — transaction context
 * @param {Map}    [params.instanceLinks] — snapshotPendingInstanceStepLinks(),
 *        taken in this transaction BEFORE the old policy steps were deleted
 * @param {Map}    [params.stepIdMap] — old policy step id → new policy step id
 *        for EVERY paired level (pairPolicySteps). Drives the re-pointing of
 *        every attributable instance step, changed by this edit or not.
 * @returns {Object} propagation summary
 */
export async function propagatePolicyChangeToInstances({ policyId, diff, changedBy, policy, t, instanceLinks = null, stepIdMap = null }) {
  if (!diff || diff.length === 0) {
    // Nothing about any level changed, but the save still deleted and
    // re-inserted every policy step, NULLing every instance link through the
    // FK. Put the captured links back so the next edit can still match by them.
    let linksRestored = 0;
    if (instanceLinks && stepIdMap) {
      const stepIds = [];
      const newIds = [];
      for (const [instanceStepId, oldPolicyStepId] of instanceLinks) {
        const newId = stepIdMap.get(oldPolicyStepId);
        if (newId == null) continue;
        stepIds.push(instanceStepId);
        newIds.push(Number(newId));
      }
      await repointInstanceSteps(stepIds, newIds, t, { policyId });
      linksRestored = stepIds.length;
    }
    return { instancesAffected: 0, details: [], linksRestored };
  }

  // Lock all PENDING instances for this policy (ascending ID to prevent deadlocks).
  // Published RFQs are excluded — their approval has already served its purpose.
  logger.info(`[Propagate] Querying PENDING instances for policy ${policyId}`);
  const pendingInstances = await t.any(
    `SELECT ai.* FROM tbl_approval_instances ai
     WHERE ai.approval_policy_id = $1 AND ai.status = 'PENDING'
     ${SKIP_PUBLISHED_RFQ_SQL}
     ORDER BY ai.id ASC
     FOR UPDATE`,
    [policyId]
  );

  logger.info(`[Propagate] Found ${pendingInstances.length} PENDING instances for policy ${policyId}: [${pendingInstances.map(i => `id=${i.id},entity=${i.entity_type}/${i.entity_id},status=${i.status}`).join(' | ')}]`);

  if (pendingInstances.length === 0) {
    return { instancesAffected: 0, details: [] };
  }

  const newStepIdFor = stepIdMap || stepIdMapFromDiff(diff);
  // With the full old→new map the new policy is known end to end: read its
  // rows (inserted in this transaction) for their step_order. That places
  // added levels by their neighbours and rebuilds the old ordinal map.
  let newOrderById = null;
  let oldStepIdByOrder = null;
  if (stepIdMap) {
    const newRows = await t.any(
      'SELECT id, step_order FROM tbl_approval_policy_steps WHERE approval_policy_id = $1',
      [policyId]
    );
    newOrderById = new Map(newRows.map(r => [Number(r.id), Number(r.step_order)]));
    oldStepIdByOrder = rebuildOldStepIdByOrder(diff, stepIdMap, newOrderById);
  }

  const details = [];
  const allApproversAdded = [];
  const allApproversRemoved = [];
  const allApproversKeptApproved = [];
  const autoCompletedInstanceIds = [];

  for (const instance of pendingInstances) {
    // Lock instance steps
    await t.any(
      `SELECT id FROM tbl_approval_instance_steps
       WHERE approval_instance_id = $1
       ORDER BY id ASC FOR UPDATE`,
      [instance.id]
    );

    const { stepOrigins, ...instanceResult } = await applyDiffToInstance(
      instance, diff, policy, changedBy, t, { instanceLinks, oldStepIdByOrder, stepIdMap, newOrderById }
    );

    // Re-point EVERY instance step whose originating level is known at that
    // level's new row, BY INSTANCE STEP ID — not only the steps this edit
    // modified. The edit replaced every policy step row, so a step left out
    // here would lose its link and every later reconciliation of it would have
    // to guess. A removed level has no new row; its steps stay unlinked.
    const stepsRelinked = [];
    for (const { instance_step_id, policy_step_id } of stepOrigins) {
      const newId = newStepIdFor.get(policy_step_id);
      if (newId == null || Number(newId) === policy_step_id) continue;
      stepsRelinked.push({ instance_step_id, from_policy_step_id: policy_step_id, to_policy_step_id: Number(newId) });
    }
    await repointInstanceSteps(
      stepsRelinked.map(r => r.instance_step_id),
      stepsRelinked.map(r => r.to_policy_step_id),
      t,
      { instanceId: instance.id }
    );

    // Update policy_version on instance
    await t.none(
      `UPDATE tbl_approval_instances SET policy_version = $1 WHERE id = $2`,
      [policy.version + 1, instance.id]
    );

    // Log to instance change log
    await t.none(
      `INSERT INTO tbl_approval_instance_change_log
       (approval_instance_id, policy_change_log_id, change_summary)
       VALUES ($1, NULL, $2)`,
      [instance.id, JSON.stringify({
        reason: 'policy_change',
        ...instanceResult,
        stepsRelinked
      })]
    );

    details.push({
      instance_id: instance.id,
      entity_type: instance.entity_type,
      entity_id: instance.entity_id,
      approvers_added: instanceResult.approversAdded.length,
      approvers_removed: instanceResult.approversRemoved.length,
      steps_added: instanceResult.stepsAdded.length,
      steps_removed: instanceResult.stepsRemoved.length,
      rules_changed: instanceResult.rulesChanged.length,
      steps_moved: instanceResult.stepsMoved.length,
      // Parts of the policy change this instance did not receive because no
      // instance step claimed them. Surfaced alongside the applied counts so a
      // partial reconciliation is visible in the propagation summary.
      unmatched_diff_entries: instanceResult.unmatchedDiffEntries.length,
      // Steps this edit left PENDING with nobody able to approve them (an
      // added or modified level that resolves to nobody here).
      steps_blocked: [...instanceResult.stepsAdded, ...instanceResult.stepsModified].filter(r => r.blocked).length,
      auto_completed: instanceResult.autoCompleted
    });

    allApproversAdded.push(...instanceResult.approversAdded.map(a => ({ ...a, instance_id: instance.id, entity_type: instance.entity_type, entity_id: instance.entity_id, metadata: instance.metadata })));
    allApproversRemoved.push(...instanceResult.approversRemoved.map(a => ({ ...a, instance_id: instance.id, entity_type: instance.entity_type, entity_id: instance.entity_id, metadata: instance.metadata })));
    allApproversKeptApproved.push(...instanceResult.approversKeptApproved.map(a => ({ ...a, instance_id: instance.id, entity_type: instance.entity_type, entity_id: instance.entity_id, metadata: instance.metadata })));

    if (instanceResult.autoCompleted) {
      autoCompletedInstanceIds.push(instance.id);
    }
  }

  // Log policy-level change
  const changeLogId = await t.one(
    `INSERT INTO tbl_approval_policy_change_log
     (approval_policy_id, changed_by, change_type, change_summary, affected_instance_ids)
     VALUES ($1, $2, 'POLICY_STEPS_CHANGED', $3, $4) RETURNING id`,
    [policyId, changedBy, JSON.stringify({ diff: diff.map(summarizeDiffEntry) }),
     pendingInstances.map(i => i.id)]
  );

  // Update the policy_change_log_id on instance change logs
  await t.none(
    `UPDATE tbl_approval_instance_change_log
     SET policy_change_log_id = $1
     WHERE approval_instance_id = ANY($2::int[]) AND policy_change_log_id IS NULL`,
    [changeLogId.id, pendingInstances.map(i => i.id)]
  );

  // Increment policy version
  await t.none(
    `UPDATE tbl_approval_policies SET version = version + 1 WHERE id = $1`,
    [policyId]
  );

  return {
    instancesAffected: pendingInstances.length,
    totalApproversAdded: allApproversAdded.length,
    totalApproversRemoved: allApproversRemoved.length,
    instancesAutoCompleted: autoCompletedInstanceIds.length,
    autoCompletedInstanceIds,
    details,
    _emailData: {
      approversAdded: allApproversAdded,
      approversRemoved: allApproversRemoved,
      approversKeptApproved: allApproversKeptApproved
    }
  };
}

// ============================================================================
// SECTION 5: PRE-FLIGHT IMPACT SIMULATION
// ============================================================================

/**
 * Simulate the impact of removing a user from approval (dry-run).
 * Used before role/department/status changes to detect dangerous auto-approvals.
 *
 * @param {number} userId — user being affected
 * @param {string} changeType — 'role_removed' | 'dept_removed' | 'user_deactivated' | 'scope_removed'
 * @param {Object} [options]
 * @param {number} [options.companyId] — blanket company filter (mapping removal path)
 * @param {number} [options.hotelId]   — blanket hotel filter (mapping removal path)
 * @param {Array}  [options.changedScopes] — removed tbl_user_role_scopes tuples
 *        `{role_id, company_id, hotel_id, department_id, process_id}`. PREFERRED:
 *        the filter then matches each removed grant on all four scope axes, so
 *        editing a role at one hotel cannot surface pending approvals from a
 *        different hotel — let alone a different legal entity.
 * @param {Array}  [options.changedRoleIds] — legacy bare role ids. Matches on
 *        role alone (no company/hotel/department/process predicate) and will
 *        over-report; kept only for callers that have no scope tuples.
 * @param {Array}  [options.changedDeptIds] — removed department memberships
 *        (tbl_user_department carries no company/hotel axis, so this stays flat)
 * @returns {{ willAutoComplete: boolean, affectedInstances: Array }}
 */
export async function simulateApproverImpact(userId, changeType, options = {}) {
  const { companyId, hotelId, changedScopes = [], changedRoleIds = [], changedDeptIds = [] } = options;

  // Find PENDING instances where this user is a PENDING approver.
  // MUST mirror revalidateApproverMembership's PART 1 discovery — the two are
  // only meaningful as a pair (the warning has to describe what the mutation
  // will actually do; commit 5a28b931). The originating policy step is resolved
  // with the SAME precedence rule on both sides — see POLICY_STEP_RESOLUTION_SQL.
  // Published RFQs are excluded — see SKIP_PUBLISHED_RFQ_SQL.
  let query = `
    SELECT DISTINCT
      ai.id as instance_id, ai.entity_type, ai.entity_id, ai.current_step,
      ai.metadata, ai.approval_policy_id,
      ai.hospitality_company_id, ai.hotel_id, ai.department_id,
      ais.id as step_id, ais.step_order, ais.decision_rule, ais.status as step_status,
      ais.policy_step_id,
      ps.approver_source_type, ps.approver_source_id
    FROM tbl_approval_instances ai
    JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id
    JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = ais.id
    ${POLICY_STEP_RESOLUTION_SQL}
    WHERE ai.status = 'PENDING'
      AND asa.approver_user_id = $1
      AND asa.status = 'PENDING'
      AND ais.status = 'PENDING'
      ${SKIP_PUBLISHED_RFQ_SQL}`;
  const params = [userId];

  if (companyId) {
    params.push(companyId);
    query += ` AND ai.hospitality_company_id = $${params.length}`;
  }
  if (hotelId) {
    params.push(hotelId);
    query += ` AND ai.hotel_id = $${params.length}`;
  }

  // Scope by what actually changed — only check steps tied to the role grants
  // / departments being removed. Two shapes:
  //   changedScopes  → full (role, company, hotel, dept, process) matching
  //   changedRoleIds → legacy role-only matching (over-reports; see JSDoc)
  // A deactivation disqualifies the user everywhere, so it skips both.
  if (changeType !== 'user_deactivated') {
    if (changedScopes.length > 0) {
      query += buildChangedScopeFilterSql(changedScopes, changedDeptIds, params);
    } else if (changedRoleIds.length > 0 || changedDeptIds.length > 0) {
      const sourceIdConditions = [];
      if (changedRoleIds.length > 0) {
        params.push(changedRoleIds);
        sourceIdConditions.push(`(ps.approver_source_type = 'ROLE' AND ps.approver_source_id = ANY($${params.length}::int[]))`);
      }
      if (changedDeptIds.length > 0) {
        params.push(changedDeptIds);
        sourceIdConditions.push(`(ps.approver_source_type = 'DEPARTMENT' AND ps.approver_source_id = ANY($${params.length}::int[]))`);
      }
      query += ` AND (${sourceIdConditions.join(' OR ')})`;
    }
  }

  query += ' ORDER BY ai.id ASC';
  const affected = await db.any(query, params);

  if (affected.length === 0) {
    return { willAutoComplete: false, affectedInstances: [] };
  }

  let willAutoComplete = false;
  const affectedInstances = [];
  // One verdict per (role, resource) for the whole simulation — an admin edit
  // routinely touches dozens of steps sharing a handful of roles.
  const permCache = new Map();

  for (const row of affected) {
    // NOTE: No re-resolution here. This simulation runs BEFORE DB mutations,
    // so resolveApprovers() would always find the user still qualified via
    // their current (not-yet-removed) roles — defeating the whole check.
    // The query scoping by changedRoleIds/changedDeptIds (above) already
    // prevents false positives by only matching steps tied to the roles/depts
    // actually being removed. The actual re-resolution happens post-mutation
    // in revalidateApproverMembership().

    // UNRESOLVABLE STEP (no live policy step by id OR by ordinal — policy
    // deleted, or the policy now has fewer steps than the instance). Kept in
    // the warning DELIBERATELY, even though revalidateApproverMembership will
    // refuse to touch it: the two sides fail in opposite-but-both-safe
    // directions. The admin is told the step exists and is in a broken state
    // (over-report), and nobody is removed on a guess (under-mutate). Silence
    // on both sides would be the one combination that hides a broken approval.
    if (!row.approver_source_type) {
      logger.warn(`[SimulateImpact] instance ${row.instance_id} step ${row.step_id} (step_order=${row.step_order}, policy_step_id=${row.policy_step_id}) has no resolvable policy step under policy ${row.approval_policy_id} — reported as affected, but the mutation path will not act on it`);
    }

    // ROLE-SOURCE PERMISSION GATE. If the backing role no longer holds
    // read+approve, the mutation path will not merely drop THIS user — it
    // retires the whole step (see retireIneligibleRoleStep). The warning has to
    // say so, or the admin is shown a smaller change than the one they are
    // about to authorise. Reported as REMOVE_STEP, and the step is treated as
    // certain to clear, because it is: it stops existing.
    let stepRetiredByPermissionGate = false;
    if (row.approver_source_type === 'ROLE') {
      const verdict = await roleStepPermissionVerdict(row.approver_source_id, row.entity_type, db, permCache);
      stepRetiredByPermissionGate = !verdict.permitted;
    }

    // Get all OTHER approvers for this step (excluding the user being removed and already REMOVED ones)
    const otherApprovers = await db.any(
      `SELECT status FROM tbl_approval_step_approvers
       WHERE approval_instance_step_id = $1
         AND approver_user_id != $2
         AND status != 'REMOVED'`,
      [row.step_id, userId]
    );

    // Would the step auto-complete if this user is removed?
    let wouldAutoCompleteStep = false;
    if (stepRetiredByPermissionGate) {
      wouldAutoCompleteStep = true;
    } else if (otherApprovers.length === 0) {
      // No other approvers — step auto-completes (empty)
      wouldAutoCompleteStep = true;
    } else if (row.decision_rule === 'ALL' && otherApprovers.every(a => a.status === 'APPROVED')) {
      // ALL rule, all remaining already approved
      wouldAutoCompleteStep = true;
    } else if (row.decision_rule === 'ANY' && otherApprovers.some(a => a.status === 'APPROVED')) {
      // ANY rule, at least one already approved
      wouldAutoCompleteStep = true;
    }

    // Would the instance auto-complete?
    let wouldAutoCompleteInstance = false;
    if (wouldAutoCompleteStep) {
      // Check if there are remaining PENDING steps after this one
      const remainingSteps = await db.any(
        `SELECT id FROM tbl_approval_instance_steps
         WHERE approval_instance_id = $1
           AND step_order > $2
           AND status = 'PENDING'`,
        [row.instance_id, row.step_order]
      );
      if (remainingSteps.length === 0) {
        wouldAutoCompleteInstance = true;
        willAutoComplete = true;
      }
    }

    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;

    affectedInstances.push({
      instance_id: row.instance_id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      entity_identifier: resolveEntityIdentifier(row.entity_type, metadata, row.entity_id),
      step_order: row.step_order,
      current_step: row.current_step,
      impact: stepRetiredByPermissionGate ? 'REMOVE_STEP' : 'REMOVE_APPROVER',
      wouldAutoCompleteStep,
      wouldAutoCompleteInstance
    });
  }

  return { willAutoComplete, affectedInstances };
}

// ============================================================================
// SECTION 6: MEMBERSHIP CHANGE REVALIDATION
// ============================================================================

/**
 * The COMPLETE set of ROLE / DEPARTMENT approver-source ids that could ever
 * resolve each of `userIds` inside `companyId` — i.e. the narrowest
 * `changedRoleIds` / `changedDeptIds` a `scope_added` caller can pass to
 * revalidateApproverMembership() without losing a single legitimate add.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * A grant that is not itself a role/department change (mapping a user into a
 * hospitality company — hospitalityController.mapUsers,
 * usersController.create_buyer_company_users) has no "changed role" to name, so
 * it used to call the reconciler with neither list. PART 2 then appends NO
 * source filter and its candidate set becomes EVERY PENDING ROLE- or
 * DEPARTMENT-sourced instance step in the company (production: 215 PENDING
 * instances in company 5), each one taken `FOR UPDATE` and re-resolved before
 * the user is even known to qualify — serially, once per mapped user, against a
 * 30s frontend timeout, while concurrent submitApprovalAction calls block on
 * the same row locks.
 *
 * ── WHY NARROWING TO THESE IDS IS LOSSLESS ────────────────────────────────
 * PART 2 only ever considers `ps.approver_source_type IN ('ROLE','DEPARTMENT')`
 * and decides membership solely by `resolveApprovers()` (generalModel.js).
 * Read those two branches:
 *
 *   ROLE       `JOIN tbl_user_role_scopes urs ON urs.user_id = u.id
 *               AND urs.role_id = $1 AND urs.company_id = $2 ...`
 *   DEPARTMENT `JOIN tbl_user_department ud ON u.id = ud.user_id
 *               AND ud.department_id = $1`
 *
 * Both are HARD EQUALITY against the step's `approver_source_id`, with no
 * NULL-as-wildcard escape on either side of either join:
 *   - `tbl_approval_policy_steps.approver_source_id` is `integer NOT NULL`
 *     (schema.sql), so there is no wildcard SOURCE — and even a hypothetical
 *     NULL would resolve nobody, since `NULL = anything` is never true.
 *   - `tbl_user_role_scopes.role_id` and `.company_id` are both
 *     `integer NOT NULL`; `tbl_user_department.department_id` is
 *     `integer NOT NULL`. There is no wildcard HOLDING either.
 * So `resolveApprovers` returns `userId` for a ROLE step only if the user holds
 * that exact role_id in that exact company, and for a DEPARTMENT step only if
 * the user is a member of that exact department. Every step this narrowing
 * drops is a step that would have resolved to a set NOT containing the user,
 * i.e. one where PART 2's `if (resolvedIds.includes(userId))` was already going
 * to be false. The lock + resolve was pure waste, not a decision.
 *
 * Note the DEPARTMENT list deliberately comes from `tbl_user_department` and
 * NOT from `tbl_user_role_scopes.department_id`: department MEMBERSHIP (what
 * a DEPARTMENT-sourced step resolves on) is a different relation from a role
 * grant's department SCOPE (which only narrows a ROLE-sourced match). Reading
 * the wrong one here would genuinely drop approvers.
 *
 * ── COMPANY-SCOPING INVARIANT (callers must honour) ───────────────────────
 * The roles are filtered by `company_id = companyId` because `resolveApprovers`
 * hard-equals `urs.company_id` to the instance's `hospitality_company_id`, and
 * PART 2 pins `ai.hospitality_company_id = companyId`. That is only sound when
 * the caller passes THE SAME `companyId` to this function and to
 * revalidateApproverMembership(). Both current callers pass the identical
 * variable to both. Pass `null` for a company-wide (unpinned) revalidation.
 *
 * ── NOT COVERED, BY PRE-EXISTING DESIGN ───────────────────────────────────
 * `USER`-sourced steps. PART 2's candidate query has always excluded them
 * (`IN ('ROLE','DEPARTMENT')`), so a mapping that newly satisfies
 * `userHasHospitalityAccess` for a USER-sourced step was never propagated
 * either before or after this narrowing. Unchanged here; recorded so it is a
 * known gap rather than an assumed one.
 *
 * @param {Array<number>} userIds
 * @param {number|null} companyId — hospitality company the revalidation is
 *        pinned to; MUST match the `companyId` passed to the reconciler.
 * @param {Object} [t] — optional tx/task context
 * @returns {Promise<Map<number, {roleIds: number[], deptIds: number[]}>>}
 *          keyed by user id; every requested id is present (possibly empty).
 */
export async function getApproverSourceScopesForUsers(userIds, companyId = null, t = db) {
  const ids = [...new Set((userIds || []).map((u) => parseInt(u, 10)).filter(Number.isInteger))];
  const scopes = new Map(ids.map((id) => [id, { roleIds: [], deptIds: [] }]));
  if (!ids.length) return scopes;

  const roleRows = await t.any(
    `SELECT user_id, ARRAY_AGG(DISTINCT role_id) AS ids
       FROM tbl_user_role_scopes
      WHERE user_id = ANY($1::int[])
        AND ($2::int IS NULL OR company_id = $2)
      GROUP BY user_id`,
    [ids, companyId ?? null]
  );
  for (const row of roleRows) {
    scopes.get(parseInt(row.user_id, 10)).roleIds = (row.ids || []).map(Number);
  }

  const deptRows = await t.any(
    `SELECT user_id, ARRAY_AGG(DISTINCT department_id) AS ids
       FROM tbl_user_department
      WHERE user_id = ANY($1::int[])
      GROUP BY user_id`,
    [ids]
  );
  for (const row of deptRows) {
    scopes.get(parseInt(row.user_id, 10)).deptIds = (row.ids || []).map(Number);
  }

  return scopes;
}

/**
 * Revalidate approver membership after role/department/status changes.
 * Removes users who no longer qualify and adds users who now qualify.
 *
 * @param {Object} params
 * @param {number} params.userId — the user whose membership changed
 * @param {number} params.changedBy — admin who made the change
 * @param {string} params.changeType — 'role_removed' | 'role_added' | 'dept_removed' | 'dept_added' | 'user_deactivated' | 'user_activated' | 'scope_removed' | 'scope_added'
 * @param {Array}  [params.changedScopes] — removed/added role scope tuples
 *        `{role_id, company_id, hotel_id, department_id, process_id}`. When
 *        present, PART 1's discovery query is narrowed the same way
 *        simulateApproverImpact narrows its own — so simulation and mutation
 *        agree on which instances a change can possibly touch. Behaviourally a
 *        no-op (resolveApprovers already re-filters per instance below), but it
 *        removes wasted per-instance work and the divergence that let the
 *        pre-flight over-reporting bug hide.
 * @param {Array}  [params.changedRoleIds] — legacy bare role IDs (over-matches)
 * @param {Array}  [params.changedDeptIds] — department IDs that were added/removed
 * @param {number} [params.companyId] — scope to specific company
 * @param {number} [params.hotelId] — accepted for caller symmetry but NOT applied
 *        as a discovery predicate; see the comment at the PART 1 query for why
 *        discovery stays company-wide.
 * @param {Object} [params.txContext] — transaction context (required)
 */
export async function revalidateApproverMembership({
  userId, changedBy, changeType,
  changedScopes = [], changedRoleIds = [], changedDeptIds = [],
  companyId, hotelId,
  txContext
}) {
  const t = txContext;
  if (!t) throw new Error('revalidateApproverMembership requires a transaction context');

  const result = {
    approversRemoved: [],
    approversAdded: [],
    instancesAffected: new Set(),
    autoCompletedInstanceIds: [],
    // Steps discovered but deliberately NOT acted on because their originating
    // policy step could not be resolved at all. Surfaced so this is countable
    // rather than invisible.
    unresolvedSteps: [],
    // Whole steps retired because their ROLE source lost read+approve. Distinct
    // from `approversRemoved`: those are per-user, these say the step itself
    // should not exist. See retireIneligibleRoleStep for why it is the step and
    // not an auto-APPROVE.
    stepsRemoved: []
  };

  // (role, resource) → verdict, for the whole call.
  const permCache = new Map();

  // ── PART 1: Remove user from steps where they no longer qualify ──

  // Find PENDING instances where user is a PENDING approver. The originating
  // policy step is resolved by POLICY_STEP_RESOLUTION_SQL (policy_step_id first,
  // ordinal only as fallback) — NOT by the ordinal alone, which silently
  // re-resolves against the wrong role whenever instance and policy numbering
  // diverge. Published RFQs are excluded.
  //
  // The source-type predicate below is written to KEEP unresolvable rows
  // (`ps.approver_source_type IS NULL`). Previously `IN ('ROLE','DEPARTMENT')`
  // alone silently demoted the LEFT JOIN to an INNER JOIN, so a step with no
  // matching policy step vanished from discovery and its approver was never
  // revalidated — an invisible outcome produced by a join, not by a decision.
  //
  // SCOPE OF THAT WIDENING, precisely: it only bites when NO change filter is
  // appended — i.e. `user_deactivated` / `user_activated`, and the
  // deleteUserMapping path (companyId/hotelId only, no changedScopes). Whenever
  // `changedScopes` or `changedRoleIds`/`changedDeptIds` ARE supplied, the
  // filter appended below emits `ps.approver_source_type = 'ROLE'` (see
  // buildChangedScopeFilterSql and the legacy branch further down), which is
  // NULL — not TRUE — for an unresolvable row, so those rows drop out again.
  // That is acceptable: a scope-scoped change can only be justified against a
  // step whose source we can actually read, and the fail-closed outcome for an
  // unresolvable row is identical either way (nobody is removed). The
  // difference is only whether we get to LOG it. Rows that do survive to the
  // loop are logged and skipped explicitly there.
  let removeQuery = `
    SELECT DISTINCT
      ai.id as instance_id, ai.entity_type, ai.entity_id, ai.current_step,
      ai.hospitality_company_id, ai.hotel_id, ai.department_id, ai.process_id, ai.initiated_by,
      ai.approval_policy_id, ai.metadata,
      ais.id as step_id, ais.step_order, ais.policy_step_id,
      ps.approver_source_type, ps.approver_source_id,
      ps.matched_policy_step_id, ps.matched_by_id
    FROM tbl_approval_instances ai
    JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id
    JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = ais.id
    ${POLICY_STEP_RESOLUTION_SQL}
    WHERE ai.status = 'PENDING'
      AND asa.approver_user_id = $1
      AND asa.status = 'PENDING'
      AND ais.status = 'PENDING'
      AND (ps.approver_source_type IS NULL OR ps.approver_source_type IN ('ROLE', 'DEPARTMENT'))
      ${SKIP_PUBLISHED_RFQ_SQL}`;
  const removeParams = [userId];

  if (companyId) {
    removeParams.push(companyId);
    removeQuery += ` AND ai.hospitality_company_id = $${removeParams.length}`;
  }

  // `hotelId` is DELIBERATELY NOT applied as a discovery predicate here, even
  // though the caller (hospitalityController.deleteUserMapping) passes it.
  //
  // Discovery and mutation have opposite safe directions. Missing a row here
  // means a user who just lost their grant keeps a live approval — the exact
  // failure this reconciler exists to prevent. Over-discovering costs only a
  // wasted resolveApprovers() call, because resolveApprovers has the final say
  // per instance and removes nobody who still qualifies. So discovery is
  // deliberately the wider of the two.
  //
  // A naive `ai.hotel_id = $hotelId` would also under-report structurally: a
  // company-scoped instance carries `hotel_id IS NULL`, and a company-wide role
  // grant (`urs.hotel_id IS NULL`) covers every hotel — the same NULL-as-wildcard
  // asymmetry buildChangedScopeFilterSql is careful about. Narrowing correctly
  // would mean `(ai.hotel_id IS NULL OR ai.hotel_id = $hotelId)`, which buys
  // nothing but the loss of the company-wide drift sweep. Left wide on purpose.
  if (hotelId) {
    logger.info(`[Revalidate] hotel ${hotelId} named by caller; discovery stays company-wide (see comment) — resolveApprovers still decides per instance`);
  }

  // Scope by what changed to avoid unnecessary revalidation. Same predicate the
  // pre-flight simulation uses, so the two never disagree about which instances
  // are in play. (De/reactivation disqualifies everywhere — no source filter.)
  if (changeType !== 'user_deactivated' && changeType !== 'user_activated') {
    if (changedScopes.length > 0) {
      removeQuery += buildChangedScopeFilterSql(changedScopes, changedDeptIds, removeParams);
    } else if (changedRoleIds.length > 0 || changedDeptIds.length > 0) {
      const sourceIdConditions = [];
      if (changedRoleIds.length > 0) {
        removeParams.push(changedRoleIds);
        sourceIdConditions.push(`(ps.approver_source_type = 'ROLE' AND ps.approver_source_id = ANY($${removeParams.length}::int[]))`);
      }
      if (changedDeptIds.length > 0) {
        removeParams.push(changedDeptIds);
        sourceIdConditions.push(`(ps.approver_source_type = 'DEPARTMENT' AND ps.approver_source_id = ANY($${removeParams.length}::int[]))`);
      }
      removeQuery += ` AND (${sourceIdConditions.join(' OR ')})`;
    }
  }

  removeQuery += ' ORDER BY ai.id ASC';

  const affectedRows = await t.any(removeQuery, removeParams);

  for (const row of affectedRows) {
    // UNRESOLVABLE STEP — neither `policy_step_id` nor the ordinal found a live
    // policy step (policy deleted, or the policy now has fewer steps than the
    // instance). We cannot know what this step was sourced from: instance steps
    // do not carry approver_source_type, so there is nothing left to re-resolve
    // against. FAIL CLOSED — never remove an approver on a guess; a wrong
    // removal can auto-complete the step, advance the instance and release
    // spend with nobody having approved it. Recorded + logged so this is
    // visible instead of being a row a join quietly dropped.
    if (!row.approver_source_type) {
      logger.warn(`[Revalidate] instance ${row.instance_id} step ${row.step_id} (step_order=${row.step_order}, policy_step_id=${row.policy_step_id}) has no resolvable policy step under policy ${row.approval_policy_id} — user ${userId} LEFT IN PLACE (cannot re-resolve; failing closed)`);
      result.unresolvedSteps.push({
        instance_id: row.instance_id, step_id: row.step_id,
        step_order: row.step_order, policy_step_id: row.policy_step_id
      });
      continue;
    }

    if (!row.matched_by_id) {
      // Fell back to the ordinal because the true link was NULL, or did not
      // resolve to a live step of this policy — the NULL case is expected after
      // a policy edit (steps deleted + re-inserted, FK NULLs each link), but
      // worth a breadcrumb when a removal decision is later questioned.
      logger.info(`[Revalidate] instance ${row.instance_id} step ${row.step_id}: policy step resolved by ORDINAL fallback (step_order=${row.step_order}, stored policy_step_id=${row.policy_step_id} is null or not a live step of policy ${row.approval_policy_id}) → policy step ${row.matched_policy_step_id}`);
    }

    // Lock the instance
    await t.oneOrNone('SELECT id FROM tbl_approval_instances WHERE id = $1 FOR UPDATE', [row.instance_id]);

    // Get the policy for department scoping
    const policy = await t.oneOrNone('SELECT * FROM tbl_approval_policies WHERE id = $1', [row.approval_policy_id]);
    if (!policy) continue;

    // ── THE CREATION-TIME PERMISSION GATE (see SECTION 2B) ──
    // resolveApprovers below answers "does this user still HOLD the role?" and
    // nothing else. It never reads tbl_role_permissions, so a role stripped of
    // read/approve still resolves all of its holders and they all stay live.
    // Apply the gate createApprovalInstance applies, first.
    //
    // NOTE ON BLAST RADIUS: this call is keyed on one user, but the verdict is
    // about the ROLE, so retiring the step also revokes co-approvers who hold
    // the same dead role. That is the correct outcome — none of them may act on
    // an entity their role can no longer read or approve — and it is exactly
    // what createApprovalInstance would have done had the instance been built
    // one moment later.
    if (row.approver_source_type === 'ROLE') {
      const verdict = await roleStepPermissionVerdict(row.approver_source_id, row.entity_type, t, permCache);
      if (!verdict.permitted) {
        const retired = await retireIneligibleRoleStep({
          instanceId: row.instance_id,
          stepId: row.step_id,
          roleId: row.approver_source_id,
          resource: verdict.resource,
          changedBy,
          changeType,
          t
        });
        if (retired) {
          result.stepsRemoved.push({
            instance_id: row.instance_id, step_id: retired.step_id,
            step_order: retired.step_order, role_id: row.approver_source_id,
            resource: verdict.resource, reason: verdict.reason
          });
          for (const removedUserId of retired.approver_user_ids) {
            result.approversRemoved.push({
              user_id: removedUserId, step_order: retired.step_order,
              instance_id: row.instance_id, entity_type: row.entity_type,
              entity_id: row.entity_id, metadata: row.metadata
            });
          }
          result.instancesAffected.add(row.instance_id);
          if (retired.instanceCompleted) result.autoCompletedInstanceIds.push(row.instance_id);
        }
        continue;
      }
    }

    // All entities are department-scoped
    const resolveDeptId = row.department_id;

    // Re-resolve approvers for this step. Pass process_id so a user whose
    // process scope was narrowed away from this instance's process is
    // correctly excluded from the resolved set (and therefore marked REMOVED
    // below).
    const policyStep = { approver_source_type: row.approver_source_type, approver_source_id: row.approver_source_id };
    const resolvedIds = await resolveApprovers(
      policyStep, row.hospitality_company_id, row.hotel_id,
      resolveDeptId, t, null, row.process_id || null
    );

    if (!resolvedIds.includes(userId)) {
      // User no longer qualifies — mark as REMOVED
      await t.none(
        `UPDATE tbl_approval_step_approvers
         SET status = 'REMOVED', removed_at = NOW(), removal_reason = $1
         WHERE approval_instance_step_id = $2 AND approver_user_id = $3 AND status = 'PENDING'`,
        [changeType, row.step_id, userId]
      );
      notifyApprovalChanged({ instanceIds: row.instance_id }, t);

      await t.none(
        `INSERT INTO tbl_approval_actions
         (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
         VALUES ($1, $2, $3, 'APPROVER_REMOVED', $4)`,
        [row.instance_id, row.step_id, userId, `Approver removed due to ${changeType}`]
      );

      result.approversRemoved.push({
        user_id: userId, step_order: row.step_order,
        instance_id: row.instance_id, entity_type: row.entity_type, entity_id: row.entity_id,
        metadata: row.metadata
      });
      result.instancesAffected.add(row.instance_id);

      // Re-evaluate step completion
      const evalResult = await reEvaluateInstanceStep(row.step_id, t);
      if (evalResult.completed && row.step_order === row.current_step) {
        const adv = await advanceInstanceToNextStep(row.instance_id, t);
        if (adv.instanceCompleted) {
          result.autoCompletedInstanceIds.push(row.instance_id);
        }
      }
    }
  }

  // ── PART 2: Add user to steps where they now qualify ──

  if (['role_added', 'dept_added', 'user_activated', 'scope_added'].includes(changeType)) {
    // Find PENDING instance steps whose originating policy step references the
    // changed roles/departments. Driven from the INSTANCE side through
    // POLICY_STEP_RESOLUTION_SQL, exactly like PART 1 — the old form joined
    // policy steps to instance steps on step_order alone, which attaches an
    // instance step to whichever policy step happens to share its ordinal and
    // could therefore ADD a user to a step their role does not back. Adding an
    // approver who should not be there is an over-grant of authority, the same
    // defect as PART 1's failure to remove, just pointed the other way.
    // Published RFQs are excluded.
    //
    // Unresolvable steps are excluded here (no `IS NULL` escape hatch, unlike
    // PART 1): if we cannot say which policy step this is, we certainly cannot
    // justify granting someone approval authority on it. Fail closed in the
    // direction that grants nothing.
    let addQuery = `
      SELECT DISTINCT
        ai.id as instance_id, ai.entity_type, ai.entity_id, ai.current_step,
        ai.hospitality_company_id, ai.hotel_id, ai.department_id, ai.process_id, ai.initiated_by,
        ai.approval_policy_id, ai.metadata,
        ais.id as step_id, ais.step_order,
        ps.approver_source_type, ps.approver_source_id
      FROM tbl_approval_instances ai
      JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id
      ${POLICY_STEP_RESOLUTION_SQL}
      WHERE ai.status = 'PENDING'
        AND ais.status = 'PENDING'
        AND ps.approver_source_type IN ('ROLE', 'DEPARTMENT')
        ${SKIP_PUBLISHED_RFQ_SQL}`;
    const addParams = [];

    if (companyId) {
      addParams.push(companyId);
      addQuery += ` AND ai.hospitality_company_id = $${addParams.length}`;
    }

    // Scope by changed role/dept IDs
    if (changedRoleIds.length > 0 && changedDeptIds.length === 0) {
      addParams.push(changedRoleIds);
      addQuery += ` AND ps.approver_source_type = 'ROLE' AND ps.approver_source_id = ANY($${addParams.length}::int[])`;
    } else if (changedDeptIds.length > 0 && changedRoleIds.length === 0) {
      addParams.push(changedDeptIds);
      addQuery += ` AND ps.approver_source_type = 'DEPARTMENT' AND ps.approver_source_id = ANY($${addParams.length}::int[])`;
    } else if (changedRoleIds.length > 0 && changedDeptIds.length > 0) {
      addParams.push(changedRoleIds);
      addParams.push(changedDeptIds);
      addQuery += ` AND (
        (ps.approver_source_type = 'ROLE' AND ps.approver_source_id = ANY($${addParams.length - 1}::int[]))
        OR (ps.approver_source_type = 'DEPARTMENT' AND ps.approver_source_id = ANY($${addParams.length}::int[]))
      )`;
    }

    addQuery += ' ORDER BY ai.id ASC';

    const candidateRows = await t.any(addQuery, addParams);

    for (const row of candidateRows) {
      // Check if user is already an active approver on this step
      const existingApprover = await t.oneOrNone(
        `SELECT id, status FROM tbl_approval_step_approvers
         WHERE approval_instance_step_id = $1 AND approver_user_id = $2 AND status != 'REMOVED'`,
        [row.step_id, userId]
      );
      if (existingApprover) continue; // already active

      // NO PERMISSION GATE HERE, deliberately. Symmetry is tempting — never
      // GRANT authority via a role that cannot read+approve the entity — but it
      // changes behaviour this defect is not about, and it is measurably wrong
      // against a step shape that legitimately exists:
      // `applyDiffToInstance` (STEP_ADDED / STEP_MODIFIED) resolves approvers
      // WITHOUT the creation-time gate, so a policy edit can leave a live ROLE
      // step whose role holds no rows for that resource. Gating the add path
      // then silently withholds approvers from steps that are still collecting
      // approvals — an under-population failure to sit alongside the
      // over-population one being fixed. (Empirically: it broke
      // approvalPropagation.mapAndCreateGaps.test.js, whose PO instances are
      // sourced from roles with no 'awarding' permissions at all.)
      //
      // PART 1 owns the gate. Retiring a step is a statement about the step;
      // declining to populate one is a statement about a user, and the two are
      // not interchangeable. If the add path should be gated, the right fix is
      // to gate applyDiffToInstance at the point steps are created, not to
      // filter their approvers afterwards.

      // Lock the instance
      await t.oneOrNone('SELECT id FROM tbl_approval_instances WHERE id = $1 FOR UPDATE', [row.instance_id]);

      // Get the policy for department scoping
      const policy = await t.oneOrNone('SELECT * FROM tbl_approval_policies WHERE id = $1', [row.approval_policy_id]);
      if (!policy) continue;

      // All entities are department-scoped
      const resolveDeptId = row.department_id;

      // Re-resolve all approvers for this step to confirm user should be
      // included (process-scope-aware via row.process_id).
      const policyStep = { approver_source_type: row.approver_source_type, approver_source_id: row.approver_source_id };
      const resolvedIds = await resolveApprovers(
        policyStep, row.hospitality_company_id, row.hotel_id,
        resolveDeptId, t, null, row.process_id || null
      );

      if (resolvedIds.includes(userId)) {
        notifyApprovalChanged({ instanceIds: row.instance_id }, t);
        const isInitiator = userId === row.initiated_by;
        const approverStatus = isInitiator ? 'APPROVED' : 'PENDING';
        const approverComment = null;

        // Check if there's a previously REMOVED entry to reactivate
        const removedEntry = await t.oneOrNone(
          `SELECT id FROM tbl_approval_step_approvers
           WHERE approval_instance_step_id = $1 AND approver_user_id = $2 AND status = 'REMOVED'`,
          [row.step_id, userId]
        );

        if (removedEntry) {
          await t.none(
            `UPDATE tbl_approval_step_approvers
             SET status = $1, removed_at = NULL, removal_reason = NULL, added_mid_flight = true,
                 acted_at = $2, comment = $3
             WHERE id = $4`,
            [approverStatus, isInitiator ? new Date() : null, approverComment, removedEntry.id]
          );
        } else {
          await t.none(
            `INSERT INTO tbl_approval_step_approvers
             (approval_instance_step_id, approver_user_id, status, added_mid_flight, acted_at, comment)
             VALUES ($1, $2, $3, true, $4, $5)`,
            [row.step_id, userId, approverStatus, isInitiator ? new Date() : null, approverComment]
          );
        }

        if (isInitiator) {
          await t.none(
            `INSERT INTO tbl_approval_actions
             (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
             VALUES ($1, $2, $3, 'APPROVE', NULL)`,
            [row.instance_id, row.step_id, userId]
          );
        }

        await t.none(
          `INSERT INTO tbl_approval_actions
           (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
           VALUES ($1, $2, $3, 'APPROVER_ADDED', $4)`,
          [row.instance_id, row.step_id, userId, `Approver added due to ${changeType}`]
        );

        result.approversAdded.push({
          user_id: userId, step_order: row.step_order,
          instance_id: row.instance_id, entity_type: row.entity_type, entity_id: row.entity_id,
          metadata: row.metadata, auto_approved: isInitiator
        });
        result.instancesAffected.add(row.instance_id);

        // Re-evaluate step if initiator was auto-approved
        if (isInitiator) {
          const evalResult = await reEvaluateInstanceStep(row.step_id, t);
          if (evalResult.completed && row.step_order === row.current_step) {
            const adv = await advanceInstanceToNextStep(row.instance_id, t);
            if (adv.instanceCompleted) {
              result.autoCompletedInstanceIds.push(row.instance_id);
            }
          }
        }
      }
    }
  }

  // Log instance change logs
  for (const instanceId of result.instancesAffected) {
    await t.none(
      `INSERT INTO tbl_approval_instance_change_log
       (approval_instance_id, change_summary)
       VALUES ($1, $2)`,
      [instanceId, JSON.stringify({
        reason: changeType,
        user_id: userId,
        approvers_removed: result.approversRemoved.filter(a => a.instance_id === instanceId),
        approvers_added: result.approversAdded.filter(a => a.instance_id === instanceId)
      })]
    );
  }

  // Log policy-level change
  if (result.instancesAffected.size > 0) {
    await t.none(
      `INSERT INTO tbl_approval_policy_change_log
       (approval_policy_id, changed_by, change_type, change_summary, affected_instance_ids)
       VALUES (NULL, $1, $2, $3, $4)`,
      [changedBy, changeType.toUpperCase(),
       JSON.stringify({ user_id: userId, approvers_removed: result.approversRemoved.length, approvers_added: result.approversAdded.length }),
       [...result.instancesAffected]]
    );
  }

  if (result.unresolvedSteps.length > 0) {
    logger.warn(`[Revalidate] ${result.unresolvedSteps.length} PENDING step(s) for user ${userId} could not be tied to a live policy step and were left untouched: ${JSON.stringify(result.unresolvedSteps)}`);
  }

  return {
    approversRemoved: result.approversRemoved,
    approversAdded: result.approversAdded,
    instancesAffected: result.instancesAffected.size,
    autoCompletedInstanceIds: result.autoCompletedInstanceIds,
    // Steps skipped because their policy step could not be resolved (fail-closed).
    unresolvedSteps: result.unresolvedSteps,
    // Steps retired because their ROLE source lost read+approve.
    stepsRemoved: result.stepsRemoved,
    // Same shape consumed by dispatchPropagationEmails — lets the caller
    // (usersController / hospitalityController) fire emails after the tx
    // commits without re-shaping the data.
    _emailData: {
      approversAdded: result.approversAdded,
      approversRemoved: result.approversRemoved,
      approversKeptApproved: []
    }
  };
}

// ============================================================================
// SECTION 6B: ROLE PERMISSION CHANGE REVALIDATION (role-keyed)
// ============================================================================

/**
 * Reconcile every in-flight approval backed by a role whose PERMISSIONS just
 * changed. Called from `rbacController.updateRoleWithPermissions` inside the
 * same transaction as the permission write.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM revalidateApproverMembership ──
 * That function is keyed on a USER: its whole discovery query pivots on
 * `asa.approver_user_id = $1`, and its per-step decision is "does this user
 * still resolve?". A permission edit changes nothing about any user — the
 * membership rows in `tbl_user_role_scopes` are untouched, so re-resolving
 * would find every holder still qualified and remove nobody. The changed thing
 * is the ROLE, and the affected population is "every PENDING step sourced from
 * it", which the user-keyed query cannot express. Hence a second entry point
 * that pivots on `ps.approver_source_id = $1` instead.
 *
 * Everything downstream is deliberately shared: the same
 * POLICY_STEP_RESOLUTION_SQL precedence (link first, ordinal fallback), the
 * same published-RFQ exclusion, the same retirement primitive, the same
 * `_emailData` shape for `dispatchPropagationEmails`, and the same audit
 * surfaces (`tbl_approval_actions` + `tbl_approval_instance_change_log` +
 * `tbl_approval_policy_change_log`).
 *
 * NOT SYMMETRIC, on purpose: a role that GAINS read+approve does not get its
 * steps back. Creation skips an ineligible step without materialising it, so
 * there is no dead row to revive — reinstating one would mean inventing a step
 * position mid-flight, which this engine declines to do everywhere else (see
 * the STEP_ADDED note in applyDiffToInstance). Newly-permitted roles take
 * effect on the next instance created.
 *
 * @param {Object} params
 * @param {number} params.roleId    — the role whose permissions changed
 * @param {number} params.changedBy — admin who made the change
 * @param {string} [params.changeType] — recorded as the removal reason
 * @param {Object} params.txContext — transaction context (required)
 */
export async function revalidateRolePermissionChange({
  roleId, changedBy, changeType = 'role_permissions_changed', txContext
}) {
  const t = txContext;
  if (!t) throw new Error('revalidateRolePermissionChange requires a transaction context');
  const numericRoleId = Number(roleId);
  if (!Number.isInteger(numericRoleId) || numericRoleId <= 0) {
    throw new Error(`revalidateRolePermissionChange: invalid roleId ${roleId}`);
  }

  const stepsRemoved = [];
  const approversRemoved = [];
  const autoCompletedInstanceIds = [];
  const instancesAffected = new Set();
  const permCache = new Map();

  // Ordered by instance id so concurrent admin edits take the instance locks in
  // the same sequence, exactly like propagatePolicyChangeToInstances.
  const rows = await t.any(
    `SELECT DISTINCT
       ai.id AS instance_id, ai.entity_type, ai.entity_id, ai.metadata,
       ai.approval_policy_id,
       ais.id AS step_id, ais.step_order, ais.policy_step_id,
       ps.approver_source_type, ps.approver_source_id, ps.matched_by_id
     FROM tbl_approval_instances ai
     JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id
     ${POLICY_STEP_RESOLUTION_SQL}
     WHERE ai.status = 'PENDING'
       AND ais.status = 'PENDING'
       AND ps.approver_source_type = 'ROLE'
       AND ps.approver_source_id = $1
       ${SKIP_PUBLISHED_RFQ_SQL}
     ORDER BY ai.id ASC, ais.step_order ASC`,
    [numericRoleId]
  );

  for (const row of rows) {
    const verdict = await roleStepPermissionVerdict(numericRoleId, row.entity_type, t, permCache);
    // The overwhelmingly common case: the role still holds read+approve for
    // this entity type, so the step is left completely alone — no audit row,
    // no change-log entry, no email. A permission edit that adds a permission,
    // or that touches an unrelated resource, must be a total no-op here.
    if (verdict.permitted) continue;

    if (!row.matched_by_id) {
      logger.info(`[RolePermGate] instance ${row.instance_id} step ${row.step_id}: policy step resolved by ORDINAL fallback (stored policy_step_id=${row.policy_step_id})`);
    }

    await t.oneOrNone('SELECT id FROM tbl_approval_instances WHERE id = $1 FOR UPDATE', [row.instance_id]);

    const retired = await retireIneligibleRoleStep({
      instanceId: row.instance_id,
      stepId: row.step_id,
      roleId: numericRoleId,
      resource: verdict.resource,
      changedBy,
      changeType,
      t
    });
    if (!retired) continue;

    stepsRemoved.push({
      instance_id: row.instance_id, step_id: retired.step_id,
      step_order: retired.step_order, entity_type: row.entity_type,
      entity_id: row.entity_id, resource: verdict.resource, reason: verdict.reason
    });
    for (const removedUserId of retired.approver_user_ids) {
      approversRemoved.push({
        user_id: removedUserId, step_order: retired.step_order,
        instance_id: row.instance_id, entity_type: row.entity_type,
        entity_id: row.entity_id, metadata: row.metadata
      });
    }
    instancesAffected.add(row.instance_id);
    if (retired.instanceCompleted) autoCompletedInstanceIds.push(row.instance_id);
  }

  for (const instanceId of instancesAffected) {
    await t.none(
      `INSERT INTO tbl_approval_instance_change_log
         (approval_instance_id, change_summary)
       VALUES ($1, $2)`,
      [instanceId, JSON.stringify({
        reason: changeType,
        role_id: numericRoleId,
        steps_removed: stepsRemoved.filter((s) => s.instance_id === instanceId),
        approvers_removed: approversRemoved.filter((a) => a.instance_id === instanceId)
      })]
    );
  }

  if (instancesAffected.size > 0) {
    await t.none(
      `INSERT INTO tbl_approval_policy_change_log
         (approval_policy_id, changed_by, change_type, change_summary, affected_instance_ids)
       VALUES (NULL, $1, $2, $3, $4)`,
      [changedBy, changeType.toUpperCase(),
        JSON.stringify({
          role_id: numericRoleId,
          steps_removed: stepsRemoved.length,
          approvers_removed: approversRemoved.length
        }),
        [...instancesAffected]]
    );
    logger.warn(`[RolePermGate] role ${numericRoleId} permission change retired ${stepsRemoved.length} live approval step(s) across ${instancesAffected.size} instance(s); ${autoCompletedInstanceIds.length} instance(s) auto-completed`);
  }

  return {
    roleId: numericRoleId,
    stepsRemoved,
    approversRemoved,
    instancesAffected: instancesAffected.size,
    autoCompletedInstanceIds,
    // Same shape dispatchPropagationEmails consumes, so the caller fires the
    // "you were removed from this approval" mails post-commit without reshaping.
    _emailData: {
      approversAdded: [],
      approversRemoved,
      approversKeptApproved: []
    }
  };
}

// ============================================================================
// SECTION 7: POST-PROPAGATION HANDLERS
// ============================================================================

/**
 * Fire post-approval handlers for any instances that were auto-completed
 * during propagation. Called AFTER the transaction commits.
 */
export async function handleAutoCompletedInstances(instanceIds, changedBy, reason) {
  for (const instanceId of instanceIds) {
    await dispatchPostApprovalHandler(instanceId, changedBy, reason);
  }
}

/**
 * Get pending instances that would be affected by a policy change.
 * Used by the preview endpoint and the save-time APPROVAL_IMPACT_WARNING.
 *
 * Must select exactly the instances propagatePolicyChangeToInstances will
 * touch — published RFQs are skipped there, so they are skipped here. A
 * warning that counts an instance the save will never change is a false alarm
 * the admin learns to click through.
 */
export async function getPendingInstancesForPolicy(policyId) {
  return db.any(`
    SELECT
      ai.id, ai.entity_type, ai.entity_id, ai.current_step, ai.metadata,
      ai.created_at,
      (SELECT COUNT(*) FROM tbl_approval_instance_steps WHERE approval_instance_id = ai.id) as total_steps
    FROM tbl_approval_instances ai
    WHERE ai.approval_policy_id = $1 AND ai.status = 'PENDING'
    ${SKIP_PUBLISHED_RFQ_SQL}
    ORDER BY ai.created_at DESC
  `, [policyId]);
}

/**
 * Get change history for an approval instance.
 */
export async function getInstanceChangeHistory(instanceId) {
  return db.any(`
    SELECT
      icl.*,
      pcl.change_type as policy_change_type,
      pcl.changed_by,
      u.name as changed_by_name
    FROM tbl_approval_instance_change_log icl
    LEFT JOIN tbl_approval_policy_change_log pcl ON icl.policy_change_log_id = pcl.id
    LEFT JOIN tbl_users u ON pcl.changed_by = u.id
    WHERE icl.approval_instance_id = $1
    ORDER BY icl.created_at DESC
  `, [instanceId]);
}

// ============================================================================
// SECTION 7: EMAIL DISPATCH
// ============================================================================

/**
 * Send propagation emails (fire-and-forget, AFTER the propagation tx commits).
 * Shared by all three caller paths so they get the same notifications:
 *   - Policy step changes (generalController.upsertApprovalPolicy)
 *   - Role/dept/status changes (usersController.update_user_detail)
 *   - Hospitality scope changes (hospitalityController.deleteUserMapping etc.)
 *
 * Lives here (not in a controller) because membership-change callers also
 * need it; otherwise approvers added/removed via role updates get no email.
 *
 * Emits four notification types:
 *   1. Approver removed → "you've been removed from this approval"
 *   2. Approver kept approved → "your prior approval still counts" (policy-change-only)
 *   3. Approver added mid-flight → "action required" (only for current-step adds)
 *   4. Remaining active approvers → "policy change summary" (when any add/remove)
 *
 * @param {Object} emailData    — { approversAdded, approversRemoved, approversKeptApproved }
 * @param {number} changedBy    — user ID who triggered the change
 * @param {string} changeReason — 'policy_change' | 'role_removed' | 'role_added' | etc.
 */
export async function dispatchPropagationEmails(emailData, changedBy, changeReason) {
  if (!emailData) return;
  try {
    const changedByUser = await db.oneOrNone('SELECT name FROM tbl_users WHERE id = $1', [changedBy]);
    const changedByName = changedByUser?.name || 'Administrator';

    // Group ARC instances keep unit entity types; only their policy says "group".
    const allIds = [...new Set([
      ...(emailData.approversRemoved || []), ...(emailData.approversKeptApproved || []),
      ...(emailData.approversAdded || []),
    ].map(a => a.instance_id).filter(Boolean))];
    const groupRows = allIds.length
      ? await db.any(
          `SELECT ai.id FROM tbl_approval_instances ai
             JOIN tbl_approval_policies pol ON pol.id = ai.approval_policy_id
            WHERE ai.id = ANY($1::int[]) AND pol.entity_type LIKE 'ARC\\_GROUP%'`,
          [allIds])
      : [];
    const groupInstanceIds = new Set(groupRows.map(r => Number(r.id)));
    const isGroupInst = (id) => groupInstanceIds.has(Number(id));

    // 1. Removal notifications
    if (emailData.approversRemoved?.length > 0) {
      const byInstance = {};
      for (const a of emailData.approversRemoved) {
        if (!byInstance[a.instance_id]) byInstance[a.instance_id] = { ...a, approvers: [] };
        const user = await db.oneOrNone('SELECT name, email FROM tbl_users WHERE id = $1', [a.user_id]);
        if (user) byInstance[a.instance_id].approvers.push({ user_id: a.user_id, user_name: user.name, user_email: user.email });
      }
      for (const key of Object.keys(byInstance)) {
        const inst = byInstance[key];
        const metadata = typeof inst.metadata === 'string' ? JSON.parse(inst.metadata) : inst.metadata;
        sendApproverRemovedNotification({
          entityType: inst.entity_type, entityId: inst.entity_id,
          entityIdentifier: metadata?.rfq_number || metadata?.rfq_no || metadata?.po_number || `ID-${inst.entity_id}`,
          changedByName, changeReason,
          stepOrder: inst.step_order,
          approvers: inst.approvers,
          extraContext: { rfq_id: metadata?.rfq_id || inst.entity_id, is_group: isGroupInst(inst.instance_id) }
        });
      }
    }

    // 2. "Your prior approval still counts" notifications (policy-change only)
    if (emailData.approversKeptApproved?.length > 0) {
      const byInstance = {};
      for (const a of emailData.approversKeptApproved) {
        if (!byInstance[a.instance_id]) byInstance[a.instance_id] = { ...a, approvers: [] };
        const user = await db.oneOrNone('SELECT name, email FROM tbl_users WHERE id = $1', [a.user_id]);
        if (user) byInstance[a.instance_id].approvers.push({ user_id: a.user_id, user_name: user.name, user_email: user.email });
      }
      for (const key of Object.keys(byInstance)) {
        const inst = byInstance[key];
        const metadata = typeof inst.metadata === 'string' ? JSON.parse(inst.metadata) : inst.metadata;
        sendApprovalStandsNotification({
          entityType: inst.entity_type, entityId: inst.entity_id,
          entityIdentifier: metadata?.rfq_number || metadata?.rfq_no || metadata?.po_number || `ID-${inst.entity_id}`,
          changedByName, changeReason,
          stepOrder: inst.step_order,
          approvers: inst.approvers,
          extraContext: { rfq_id: metadata?.rfq_id || inst.entity_id, is_group: isGroupInst(inst.instance_id) }
        });
      }
    }

    // 3. Addition notifications (skip auto-approved initiators)
    if (emailData.approversAdded?.length > 0) {
      const byInstance = {};
      for (const a of emailData.approversAdded) {
        if (a.auto_approved) continue;
        if (!byInstance[a.instance_id]) byInstance[a.instance_id] = { ...a, approvers: [] };
        const user = await db.oneOrNone('SELECT name, email FROM tbl_users WHERE id = $1', [a.user_id]);
        if (user) byInstance[a.instance_id].approvers.push({ user_id: a.user_id, user_name: user.name, user_email: user.email });
      }
      for (const key of Object.keys(byInstance)) {
        const inst = byInstance[key];
        const metadata = typeof inst.metadata === 'string' ? JSON.parse(inst.metadata) : inst.metadata;
        const instance = await db.oneOrNone('SELECT current_step, initiated_by FROM tbl_approval_instances WHERE id = $1', [inst.instance_id]);
        const totalSteps = await db.one('SELECT COUNT(*) as count FROM tbl_approval_instance_steps WHERE approval_instance_id = $1', [inst.instance_id]);
        const initiator = await db.oneOrNone('SELECT name FROM tbl_users WHERE id = $1', [instance?.initiated_by]);

        const currentStepApprovers = inst.approvers;
        if (currentStepApprovers.length > 0) {
          sendApproverAddedMidFlightNotification({
            entityType: inst.entity_type, entityId: inst.entity_id,
            entityIdentifier: metadata?.rfq_number || metadata?.rfq_no || metadata?.po_number || `ID-${inst.entity_id}`,
            changedByName, changeReason,
            stepOrder: inst.step_order, totalSteps: parseInt(totalSteps.count),
            initiatorName: initiator?.name || 'Unknown',
            approvers: currentStepApprovers,
            extraContext: { rfq_id: metadata?.rfq_id || inst.entity_id, is_group: isGroupInst(inst.instance_id) }
          });
        }
      }
    }

    // 4. "Policy change" summary to remaining active approvers
    if ((emailData.approversRemoved?.length > 0) || (emailData.approversAdded?.length > 0)) {
      const allInstanceIds = new Set([
        ...(emailData.approversRemoved || []).map(a => a.instance_id),
        ...(emailData.approversAdded || []).map(a => a.instance_id)
      ]);

      for (const instanceId of allInstanceIds) {
        const instance = await db.oneOrNone('SELECT * FROM tbl_approval_instances WHERE id = $1', [instanceId]);
        if (!instance || instance.status !== 'PENDING') continue;

        const metadata = typeof instance.metadata === 'string' ? JSON.parse(instance.metadata) : instance.metadata;

        const remainingApprovers = await db.any(`
          SELECT DISTINCT sa.approver_user_id as user_id, u.name as user_name, u.email as user_email
          FROM tbl_approval_step_approvers sa
          JOIN tbl_approval_instance_steps ais ON sa.approval_instance_step_id = ais.id
          JOIN tbl_users u ON sa.approver_user_id = u.id
          WHERE ais.approval_instance_id = $1 AND sa.status = 'PENDING'
        `, [instanceId]);

        const addedUserIds = new Set((emailData.approversAdded || []).filter(a => a.instance_id === instanceId).map(a => a.user_id));
        const toNotify = remainingApprovers.filter(a => !addedUserIds.has(a.user_id));

        if (toNotify.length > 0) {
          const removed = (emailData.approversRemoved || []).filter(a => a.instance_id === instanceId);
          const added = (emailData.approversAdded || []).filter(a => a.instance_id === instanceId);

          sendPolicyChangeNotification({
            entityType: instance.entity_type, entityId: instance.entity_id,
            entityIdentifier: metadata?.rfq_number || metadata?.rfq_no || metadata?.po_number || `ID-${instance.entity_id}`,
            changedByName, changeReason,
            changeSummary: {
              approversRemoved: removed.length, approversAdded: added.length,
              stepsRemoved: 0, stepsAdded: 0, rulesChanged: 0
            },
            approvers: toNotify,
            extraContext: { rfq_id: metadata?.rfq_id || instance.entity_id, is_group: isGroupInst(instanceId) }
          });
        }
      }
    }
  } catch (err) {
    logError('[dispatchPropagationEmails] error sending propagation emails', err);
  }
}
