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
  getApprovalInstanceById,
  recordLifecycleEvent
} from '../models/generalModel.js';
import { logger } from '../util/logger.js';
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
 * Compute a structured diff between old and new policy steps.
 * Pure function — no DB access.
 *
 * @param {Array} oldSteps — rows from tbl_approval_policy_steps (before deletion)
 * @param {Array} newSteps — step objects from the request body (after insertion, with IDs)
 * @returns {Array} Array of diff entries
 */
export function computePolicyStepDiff(oldSteps, newSteps) {
  const diffs = [];

  const oldByOrder = new Map(oldSteps.map(s => [s.step_order, s]));
  const newByOrder = new Map(newSteps.map(s => [s.step_order, s]));

  const allOrders = new Set([...oldByOrder.keys(), ...newByOrder.keys()]);

  for (const order of [...allOrders].sort((a, b) => a - b)) {
    const old = oldByOrder.get(order);
    const nw = newByOrder.get(order);

    if (old && !nw) {
      diffs.push({ type: 'STEP_REMOVED', step_order: order, oldStep: old });
    } else if (!old && nw) {
      diffs.push({ type: 'STEP_ADDED', step_order: order, newStep: nw });
    } else if (old && nw) {
      const sourceChanged = old.approver_source_type !== nw.approver_source_type ||
                            String(old.approver_source_id) !== String(nw.approver_source_id);
      const ruleChanged = (old.decision_rule || 'ANY') !== (nw.decision_rule || 'ANY');

      if (sourceChanged || ruleChanged) {
        diffs.push({
          type: 'STEP_MODIFIED',
          step_order: order,
          oldStep: old,
          newStep: nw,
          sourceChanged,
          ruleChanged,
          oldRule: old.decision_rule || 'ANY',
          newRule: nw.decision_rule || 'ANY'
        });
      }
      // else: UNCHANGED — skip
    }
  }

  return diffs;
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

  // No approvers left → auto-complete
  if (approvers.length === 0) {
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
// SECTION 3: APPLY DIFF TO A SINGLE INSTANCE
// ============================================================================

/**
 * Apply a policy step diff to a single PENDING approval instance.
 * Must be called within a transaction that holds FOR UPDATE locks on the instance.
 *
 * @returns {{ approversAdded: Array, approversRemoved: Array, stepsAdded: Array,
 *             stepsRemoved: Array, rulesChanged: Array, autoCompleted: boolean }}
 */
export async function applyDiffToInstance(instance, diff, policy, changedBy, t) {
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

  // Process diffs in order. Handle STEP_ADDED renumbering carefully.
  // Sort diffs: process removals first, then modifications, then additions (to avoid renumbering conflicts)
  const removals = diff.filter(d => d.type === 'STEP_REMOVED');
  const modifications = diff.filter(d => d.type === 'STEP_MODIFIED');
  const additions = diff.filter(d => d.type === 'STEP_ADDED').sort((a, b) => a.step_order - b.step_order);

  // Match instance steps by step_order (not policy_step_id, which goes stale
  // across policy updates). This works because both the policy step_order and
  // instance step_order use the same 1-based sequential numbering.
  const findInstanceStepByOrder = (stepOrder) => {
    const found = instanceSteps.find(s => s.step_order === stepOrder);
    logger.info(`[PropagateMatch] Looking for step_order=${stepOrder}: ${found ? `found id=${found.id}, status=${found.status}` : 'NOT FOUND'}`);
    return found;
  };

  // --- STEP REMOVALS ---
  for (const d of removals) {
    const instStep = findInstanceStepByOrder(d.step_order);
    if (!instStep) continue; // step was skipped at creation time (0 approvers)

    if (instStep.status === 'APPROVED' || instStep.status === 'REJECTED') {
      // Historical — do not modify
      result.stepsRemoved.push({ step_order: instStep.step_order, skipped: true, reason: 'already_completed' });
      continue;
    }

    // Mark step as REMOVED
    await t.none(
      `UPDATE tbl_approval_instance_steps SET status = 'REMOVED', removed_mid_flight = true, completed_at = NOW() WHERE id = $1`,
      [instStep.id]
    );

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
      const adv = await advanceInstanceToNextStep(instance.id, t);
      if (adv.instanceCompleted) {
        result.autoCompleted = true;
      } else if (adv.nextStepOrder) {
        instance.current_step = adv.nextStepOrder;
      }
    }
  }

  // --- STEP MODIFICATIONS (approver/rule changes) ---
  for (const d of modifications) {
    const instStep = findInstanceStepByOrder(d.step_order);
    if (!instStep) continue;

    if (instStep.status === 'APPROVED' || instStep.status === 'REJECTED') {
      // Historical — audit note only
      continue;
    }

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

      // Resolve NEW approvers (from new policy step definition)
      const newResolvedIds = await resolveApprovers(
        d.newStep, instance.hospitality_company_id, instance.hotel_id,
        resolveDeptId, t, null, instance.process_id || null
      );

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

    // Re-evaluate step completion after any modification
    if (d.sourceChanged || d.ruleChanged) {
      const evalResult = await reEvaluateInstanceStep(instStep.id, t);
      if (evalResult.completed && instStep.step_order === instance.current_step) {
        const adv = await advanceInstanceToNextStep(instance.id, t);
        if (adv.instanceCompleted) {
          result.autoCompleted = true;
        } else if (adv.nextStepOrder) {
          instance.current_step = adv.nextStepOrder;
        }
      }
    }
  }

  // --- STEP ADDITIONS (with renumbering) ---
  // Process additions in ascending order to handle renumbering correctly
  let renumberOffset = 0;
  for (const d of additions) {
    const insertPosition = d.step_order + renumberOffset;
    const currentStep = instance.current_step;

    // Shift existing instance steps at >= insertPosition
    await t.none(
      `UPDATE tbl_approval_instance_steps
       SET step_order = step_order + 1
       WHERE approval_instance_id = $1 AND step_order >= $2`,
      [instance.id, insertPosition]
    );

    // Update current_step if it was shifted
    if (currentStep >= insertPosition) {
      instance.current_step += 1;
      await t.none(
        `UPDATE tbl_approval_instances SET current_step = $1 WHERE id = $2`,
        [instance.current_step, instance.id]
      );
    }

    const isPastStep = insertPosition < instance.current_step;

    if (isPastStep) {
      // Past step — insert as SKIPPED
      await t.one(
        `INSERT INTO tbl_approval_instance_steps
         (approval_instance_id, step_order, decision_rule, status, policy_step_id, added_mid_flight, completed_at)
         VALUES ($1, $2, $3, 'SKIPPED', $4, true, NOW()) RETURNING id`,
        [instance.id, insertPosition, d.newStep.decision_rule || 'ANY', d.newStep.id]
      );
      result.stepsAdded.push({ step_order: insertPosition, status: 'SKIPPED' });
    } else {
      // Future step — insert as PENDING with resolved approvers
      const newResolvedIds = await resolveApprovers(
        d.newStep, instance.hospitality_company_id, instance.hotel_id,
        resolveDeptId, t, null, instance.process_id || null
      );

      if (newResolvedIds.length === 0) {
        // No approvers — insert as SKIPPED (same as createApprovalInstance)
        await t.one(
          `INSERT INTO tbl_approval_instance_steps
           (approval_instance_id, step_order, decision_rule, status, policy_step_id, added_mid_flight, completed_at)
           VALUES ($1, $2, $3, 'SKIPPED', $4, true, NOW()) RETURNING id`,
          [instance.id, insertPosition, d.newStep.decision_rule || 'ANY', d.newStep.id]
        );
        result.stepsAdded.push({ step_order: insertPosition, status: 'SKIPPED' });
      } else {
        const newInstStep = await t.one(
          `INSERT INTO tbl_approval_instance_steps
           (approval_instance_id, step_order, decision_rule, status, policy_step_id, added_mid_flight)
           VALUES ($1, $2, $3, 'PENDING', $4, true) RETURNING *`,
          [instance.id, insertPosition, d.newStep.decision_rule || 'ANY', d.newStep.id]
        );

        for (const userId of newResolvedIds) {
          const isInitiator = userId === instance.initiated_by;
          const status = isInitiator ? 'APPROVED' : 'PENDING';
          const comment = null;

          await t.none(
            `INSERT INTO tbl_approval_step_approvers
             (approval_instance_step_id, approver_user_id, status, added_mid_flight, acted_at, comment)
             VALUES ($1, $2, $3, true, $4, $5)`,
            [newInstStep.id, userId, status, isInitiator ? new Date() : null, comment]
          );

          if (isInitiator) {
            await t.none(
              `INSERT INTO tbl_approval_actions
               (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
               VALUES ($1, $2, $3, 'APPROVE', NULL)`,
              [instance.id, newInstStep.id, userId]
            );
          }

          result.approversAdded.push({ user_id: userId, step_order: insertPosition, auto_approved: isInitiator });
        }

        await t.none(
          `INSERT INTO tbl_approval_actions
           (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
           VALUES ($1, $2, $3, 'STEP_ADDED', 'Step added due to policy change')`,
          [instance.id, newInstStep.id, changedBy]
        );

        result.stepsAdded.push({ step_order: insertPosition, status: 'PENDING', approverCount: newResolvedIds.length });
      }
    }

    renumberOffset++;
  }

  return result;
}

// ============================================================================
// SECTION 4: POLICY CHANGE PROPAGATION (MAIN ORCHESTRATOR)
// ============================================================================

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
 * @returns {Object} propagation summary
 */
export async function propagatePolicyChangeToInstances({ policyId, diff, changedBy, policy, t }) {
  if (!diff || diff.length === 0) {
    return { instancesAffected: 0, details: [] };
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

    const instanceResult = await applyDiffToInstance(instance, diff, policy, changedBy, t);

    // Update policy_step_id references on modified steps to point to the new policy step IDs
    for (const d of diff.filter(dd => dd.type === 'STEP_MODIFIED' && dd.newStep?.id)) {
      const instStep = instanceResult.stepsModified?.find(s => s.step_order === d.step_order);
      // Also update by step_order directly in DB
      await t.none(
        `UPDATE tbl_approval_instance_steps SET policy_step_id = $1
         WHERE approval_instance_id = $2 AND step_order = $3`,
        [d.newStep.id, instance.id, d.step_order]
      );
    }

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
        ...instanceResult
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
    [policyId, changedBy, JSON.stringify({ diff: diff.map(d => ({ type: d.type, step_order: d.step_order })) }),
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
 * @param {Object} [options] — { companyId, hotelId } to scope the search
 * @returns {{ willAutoComplete: boolean, affectedInstances: Array }}
 */
export async function simulateApproverImpact(userId, changeType, options = {}) {
  const { companyId, hotelId, changedRoleIds = [], changedDeptIds = [] } = options;

  // Find PENDING instances where this user is a PENDING approver on
  // ROLE/DEPARTMENT-based steps. Mirrors revalidateApproverMembership query.
  // Published RFQs are excluded — see SKIP_PUBLISHED_RFQ_SQL.
  // NOTE: Join policy steps via approval_policy_id + step_order (not the stale
  // policy_step_id, which points to deleted rows after policy updates).
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
    LEFT JOIN tbl_approval_policy_steps ps
      ON ps.approval_policy_id = ai.approval_policy_id
      AND ps.step_order = ais.step_order
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

  // Scope by changed role/dept IDs — only check steps tied to the roles/depts
  // actually being removed. This prevents false positives where the user is an
  // approver via a DIFFERENT role that is being kept.
  if (changeType !== 'user_deactivated' && (changedRoleIds.length > 0 || changedDeptIds.length > 0)) {
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

  query += ' ORDER BY ai.id ASC';
  const affected = await db.any(query, params);

  if (affected.length === 0) {
    return { willAutoComplete: false, affectedInstances: [] };
  }

  let willAutoComplete = false;
  const affectedInstances = [];

  for (const row of affected) {
    // NOTE: No re-resolution here. This simulation runs BEFORE DB mutations,
    // so resolveApprovers() would always find the user still qualified via
    // their current (not-yet-removed) roles — defeating the whole check.
    // The query scoping by changedRoleIds/changedDeptIds (above) already
    // prevents false positives by only matching steps tied to the roles/depts
    // actually being removed. The actual re-resolution happens post-mutation
    // in revalidateApproverMembership().

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
    if (otherApprovers.length === 0) {
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
      entity_identifier: metadata?.rfq_number || metadata?.rfq_no || metadata?.po_number || `ID-${row.entity_id}`,
      step_order: row.step_order,
      current_step: row.current_step,
      impact: 'REMOVE_APPROVER',
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
 * Revalidate approver membership after role/department/status changes.
 * Removes users who no longer qualify and adds users who now qualify.
 *
 * @param {Object} params
 * @param {number} params.userId — the user whose membership changed
 * @param {number} params.changedBy — admin who made the change
 * @param {string} params.changeType — 'role_removed' | 'role_added' | 'dept_removed' | 'dept_added' | 'user_deactivated' | 'user_activated' | 'scope_removed' | 'scope_added'
 * @param {Array}  [params.changedRoleIds] — role IDs that were added/removed
 * @param {Array}  [params.changedDeptIds] — department IDs that were added/removed
 * @param {number} [params.companyId] — scope to specific company
 * @param {number} [params.hotelId] — scope to specific hotel
 * @param {Object} [params.txContext] — transaction context (required)
 */
export async function revalidateApproverMembership({
  userId, changedBy, changeType,
  changedRoleIds = [], changedDeptIds = [],
  companyId, hotelId,
  txContext
}) {
  const t = txContext;
  if (!t) throw new Error('revalidateApproverMembership requires a transaction context');

  const result = {
    approversRemoved: [],
    approversAdded: [],
    instancesAffected: new Set(),
    autoCompletedInstanceIds: []
  };

  // ── PART 1: Remove user from steps where they no longer qualify ──

  // Find PENDING instances where user is a PENDING approver on
  // ROLE/DEPARTMENT-based steps. Published RFQs are excluded.
  // NOTE: Join policy steps via approval_policy_id + step_order (not the stale
  // policy_step_id, which points to deleted rows after policy updates).
  let removeQuery = `
    SELECT DISTINCT
      ai.id as instance_id, ai.entity_type, ai.entity_id, ai.current_step,
      ai.hospitality_company_id, ai.hotel_id, ai.department_id, ai.process_id, ai.initiated_by,
      ai.approval_policy_id, ai.metadata,
      ais.id as step_id, ais.step_order, ais.policy_step_id,
      ps.approver_source_type, ps.approver_source_id
    FROM tbl_approval_instances ai
    JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id
    JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = ais.id
    LEFT JOIN tbl_approval_policy_steps ps
      ON ps.approval_policy_id = ai.approval_policy_id
      AND ps.step_order = ais.step_order
    WHERE ai.status = 'PENDING'
      AND asa.approver_user_id = $1
      AND asa.status = 'PENDING'
      AND ais.status = 'PENDING'
      AND ps.approver_source_type IN ('ROLE', 'DEPARTMENT')
      ${SKIP_PUBLISHED_RFQ_SQL}`;
  const removeParams = [userId];

  if (companyId) {
    removeParams.push(companyId);
    removeQuery += ` AND ai.hospitality_company_id = $${removeParams.length}`;
  }

  // Scope by changed role/dept IDs to avoid unnecessary revalidation
  if (changedRoleIds.length > 0 || changedDeptIds.length > 0) {
    const sourceIdConditions = [];
    if (changedRoleIds.length > 0) {
      removeParams.push(changedRoleIds);
      sourceIdConditions.push(`(ps.approver_source_type = 'ROLE' AND ps.approver_source_id = ANY($${removeParams.length}::int[]))`);
    }
    if (changedDeptIds.length > 0) {
      removeParams.push(changedDeptIds);
      sourceIdConditions.push(`(ps.approver_source_type = 'DEPARTMENT' AND ps.approver_source_id = ANY($${removeParams.length}::int[]))`);
    }
    // For user_deactivated/user_activated, don't filter by source IDs — affects all
    if (changeType !== 'user_deactivated' && changeType !== 'user_activated') {
      removeQuery += ` AND (${sourceIdConditions.join(' OR ')})`;
    }
  }

  removeQuery += ' ORDER BY ai.id ASC';

  const affectedRows = await t.any(removeQuery, removeParams);

  for (const row of affectedRows) {
    // Lock the instance
    await t.oneOrNone('SELECT id FROM tbl_approval_instances WHERE id = $1 FOR UPDATE', [row.instance_id]);

    // Get the policy for department scoping
    const policy = await t.oneOrNone('SELECT * FROM tbl_approval_policies WHERE id = $1', [row.approval_policy_id]);
    if (!policy) continue;

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
    // Find policy steps that reference the changed roles/departments.
    // Published RFQs are excluded.
    // NOTE: Join instance steps to current policy steps via step_order (not stale policy_step_id)
    let addQuery = `
      SELECT DISTINCT
        ai.id as instance_id, ai.entity_type, ai.entity_id, ai.current_step,
        ai.hospitality_company_id, ai.hotel_id, ai.department_id, ai.process_id, ai.initiated_by,
        ai.approval_policy_id, ai.metadata,
        ais.id as step_id, ais.step_order,
        ps.approver_source_type, ps.approver_source_id, ps.id as policy_step_id
      FROM tbl_approval_instances ai
      JOIN tbl_approval_policies p ON ai.approval_policy_id = p.id
      JOIN tbl_approval_policy_steps ps ON ps.approval_policy_id = p.id
      JOIN tbl_approval_instance_steps ais
        ON ais.approval_instance_id = ai.id
        AND ais.step_order = ps.step_order
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

  return {
    approversRemoved: result.approversRemoved,
    approversAdded: result.approversAdded,
    instancesAffected: result.instancesAffected.size,
    autoCompletedInstanceIds: result.autoCompletedInstanceIds,
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
 * Used by the preview endpoint.
 */
export async function getPendingInstancesForPolicy(policyId) {
  return db.any(`
    SELECT
      ai.id, ai.entity_type, ai.entity_id, ai.current_step, ai.metadata,
      ai.created_at,
      (SELECT COUNT(*) FROM tbl_approval_instance_steps WHERE approval_instance_id = ai.id) as total_steps
    FROM tbl_approval_instances ai
    WHERE ai.approval_policy_id = $1 AND ai.status = 'PENDING'
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
          extraContext: { rfq_id: metadata?.rfq_id || inst.entity_id }
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
          extraContext: { rfq_id: metadata?.rfq_id || inst.entity_id }
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
            extraContext: { rfq_id: metadata?.rfq_id || inst.entity_id }
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
            extraContext: { rfq_id: metadata?.rfq_id || instance.entity_id }
          });
        }
      }
    }
  } catch (err) {
    logError('[dispatchPropagationEmails] error sending propagation emails', err);
  }
}
