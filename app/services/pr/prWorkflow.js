// Purchase Requisitions — the state machine (spec §4.1, §6, §7).
//
//   submit            draft/returned → in_review (review groups exist) or
//                     pending_approval (none). Every submit is a new revision.
//   startReview       one pending tbl_pr_review per reviewing department.
//   startApproval     the approval instance (createApprovalInstance, strict).
//   withdraw          in_review/pending_approval → draft (requester).
//   approverSendBack  pending_approval → returned (current-step approver).
//   handlePrPostApproval / handlePrRejection
//                     the engine's terminal outcome → approved / rejected.
//
// Rules every transition here follows:
//   - one db.tx; the PR row is locked (lockPr, FOR UPDATE) BEFORE its status is
//     read, and the expected status is re-checked → 409 PR_STATE_CONFLICT.
//     The lock is also what makes a double submit create exactly one approval
//     instance: the engine's own duplicate guard is an unlocked SELECT.
//   - fail-closed: anything the approval chain or the review routing cannot
//     satisfy is refused (422, the precise code) and the whole transaction
//     rolls back — no revision bump, no review, no instance.
//   - previewApproval / resolveReviewers are the very functions the routing
//     preview calls, so a preview and a refusal can never disagree.
//   - every change writes a tbl_pr_event in the same transaction;
//     notifications are sent only after the commit (prNotify never throws).

import db from '../../config/dbConn.js';
import { logger } from '../../util/logger.js';
import * as prModel from '../../models/pr/prModel.js';
import { createApprovalInstance, cancelApprovalInstance } from '../../models/generalModel.js';
import { dispatchPostApprovalAction } from '../approvalActionService.js';
import { NoApprovalPolicyError } from '../authorizationService.js';
import { PR_ERR, PrError, prError } from './prErrors.js';
import { record } from './prEvents.js';
import { assertPerm, canReadPr } from './prAccess.js';
import { guardCatalogLines } from './prCatalog.js';
import { computeReviewGroups, resolveReviewers, previewApproval, noReviewerProblem } from './prRouting.js';
import { EDITABLE_STATUSES, WITHDRAWABLE_STATUSES, MAX_LEN } from './prConstants.js';
import { notifyReviewTasks, notifyReturned, notifyApproved, notifyRejected } from './prNotify.js';

const cellOf = (pr) => ({
  companyId: Number(pr.hospitality_company_id), hotelId: Number(pr.hotel_id), departmentId: Number(pr.department_id),
});
const isRequester = (user, pr) => Number(pr.raised_by) === Number(user?.id);
const notFound = () => prError(PR_ERR.NOT_FOUND, 'Purchase requisition not found');
const stateConflict = (pr, verb) => prError(
  PR_ERR.STATE_CONFLICT,
  `This requisition is ${String(pr.status).replace(/_/g, ' ')} and cannot be ${verb}`,
  { status: pr.status });

const CONTACT_ADMIN = 'contact your admin to update the approval workflow';
const KIND_BY_CODE = new Map(Object.values(PR_ERR).map((kind) => [kind[0], kind]));

/**
 * A routing-preview problem ({code, message, ...details}) as the PrError submit
 * answers with. A code the PR contract does not know still fails closed, as an
 * unresolved approval step carrying the original code.
 */
function problemError({ code, message, ...details }) {
  const kind = KIND_BY_CODE.get(code);
  if (kind) return prError(kind, message, Object.keys(details).length ? details : undefined);
  return prError(PR_ERR.STEP_UNRESOLVED, message, { ...details, engine_code: code });
}

/**
 * The engine's refusals in the PR contract (defence in depth: previewApproval
 * has already said yes by the time the engine runs, so these mean the policy
 * changed between the two reads of one transaction — or a bug).
 */
function engineError(err) {
  if (err instanceof PrError) return err;
  if (err instanceof NoApprovalPolicyError || err?.code === 'NO_APPROVAL_POLICY_FOR_PROCESS'
      || err?.message === 'Policy has no approval steps configured') {
    return prError(PR_ERR.NO_POLICY, `No approval workflow is set up for purchase requisitions at this hotel — ${CONTACT_ADMIN}`);
  }
  switch (err?.code) {
    case 'APPROVAL_STEP_UNRESOLVED':
      return prError(PR_ERR.STEP_UNRESOLVED,
        `Approval step ${err.step_order} has no one who can approve for this hotel and department — ${CONTACT_ADMIN}`,
        { step_order: err.step_order, reason: err.reason });
    case 'APPROVAL_POLICY_RESOLVES_TO_NOBODY':
      return prError(PR_ERR.STEP_UNRESOLVED, `No approval step has anyone who can approve — ${CONTACT_ADMIN}`);
    case 'APPROVAL_NO_INDEPENDENT_APPROVER':
      return prError(PR_ERR.NO_INDEPENDENT_APPROVER, `No one other than the requester can approve this requisition — ${CONTACT_ADMIN}`);
    default:
      break;
  }
  if (/pending approval instance already exists|already been approved/i.test(err?.message || '')) {
    return prError(PR_ERR.STATE_CONFLICT, 'This requisition already has an approval in progress', {});
  }
  return err;
}

// ---------------------------------------------------------------------------
// Review / approval start (inside submit's transaction)
// ---------------------------------------------------------------------------

/**
 * Start the approval chain for a PR whose new revision is open (inside the
 * caller's transaction, PR row locked). Refuses with the routing preview's
 * first problem before the engine runs; the engine runs strict.
 * @returns {Promise<{instance: object, autoApproved: boolean}>}
 */
export async function startApproval(t, pr, actorId) {
  const cell = cellOf(pr);
  const preview = await previewApproval({ ...cell, amount: pr.estimated_total, requesterId: Number(pr.raised_by) }, t);
  if (preview.problems.length) throw problemError(preview.problems[0]);

  let engine;
  try {
    engine = await createApprovalInstance({
      entity_type: 'PR',
      entity_id: Number(pr.id),
      hospitality_company_id: cell.companyId,
      hotel_id: cell.hotelId,
      department_id: cell.departmentId,
      process_id: null,
      initiated_by: Number(pr.raised_by),
      amount: pr.estimated_total,
      strictSteps: true,
      metadata: { pr_number: pr.pr_number, pr_id: Number(pr.id), title: pr.title },
    }, t);
  } catch (err) {
    throw engineError(err);
  }
  const instance = engine.instance;
  const steps = await prModel.instanceStepSummary(t, instance.id);

  await prModel.updateHeader(t, pr.id, { status: 'pending_approval', approval_instance_id: instance.id });
  await record(t, {
    prId: pr.id, revision: pr.revision, actorId, type: 'approval_started',
    payload: { instance_id: Number(instance.id), amount: pr.estimated_total, steps },
  });
  return { instance, autoApproved: engine.autoApproved === true };
}

/**
 * Open the technical reviews of a PR's new revision (inside the caller's
 * transaction, PR row locked). Fail-closed, in the order the routing preview
 * lists problems: a group nobody may review (PR_NO_REVIEWER, first by
 * department title), then the approval chain's first problem — so reviewers
 * never work on a PR whose approval is already known to be broken.
 * @param {Array<{department_id, department_title, line_ids}>} groups computeReviewGroups output
 * @returns {Promise<{reviews: Array<{review_id, department_id, department_title, line_ids, reviewer_ids}>}>}
 */
export async function startReview(t, pr, groups) {
  const cell = cellOf(pr);
  const staffed = [];
  for (const g of groups) {
    const reviewers = await resolveReviewers({ ...cell, departmentId: g.department_id }, t);
    if (!reviewers.length) throw problemError(noReviewerProblem(g));
    staffed.push({ ...g, reviewer_ids: reviewers.map((r) => r.id) });
  }
  const approval = await previewApproval({ ...cell, amount: pr.estimated_total, requesterId: Number(pr.raised_by) }, t);
  if (approval.problems.length) throw problemError(approval.problems[0]);

  const reviews = [];
  for (const g of staffed) {
    const reviewId = await prModel.insertReview(t, {
      prId: pr.id, revision: pr.revision, departmentId: g.department_id, lineIds: g.line_ids,
    });
    const review = {
      review_id: reviewId, department_id: g.department_id, department_title: g.department_title,
      line_ids: g.line_ids, reviewer_ids: g.reviewer_ids,
    };
    await record(t, { prId: pr.id, revision: pr.revision, actorId: Number(pr.raised_by), type: 'review_created', payload: review });
    reviews.push(review);
  }
  await prModel.updateHeader(t, pr.id, { status: 'in_review' });
  return { reviews };
}

// ---------------------------------------------------------------------------
// Requester transitions
// ---------------------------------------------------------------------------

/**
 * Submit a draft/returned PR (requester only; pr.create on the PR's cell).
 * Lines are re-validated against the catalog as it is NOW (a contract that
 * became active, a variant that was withdrawn); the total is recomputed.
 * @returns {Promise<{id: number, status: string}>}
 */
export async function submit(prId, user) {
  const out = await db.tx(async (t) => {
    const pr = await prModel.lockPr(t, prId);
    if (!pr || !isRequester(user, pr)) throw notFound();
    if (!EDITABLE_STATUSES.includes(pr.status)) throw stateConflict(pr, 'submitted');
    const cell = cellOf(pr);
    await assertPerm(user.id, 'pr.create', cell, t);

    const lines = await prModel.activeLines(prId, t);
    if (!lines.length) {
      throw prError(PR_ERR.VALIDATION, 'Add at least one line before submitting', [{ field: 'lines', message: 'Add at least one line' }]);
    }
    const checked = await guardCatalogLines(t, cell, lines);
    // A catalog line is filed under its product's category as it is now.
    await prModel.setLineCategories(t, prId, checked
      .filter((l, i) => l.category_id !== lines[i].category_id)
      .map((l) => ({ id: l.id, category_id: l.category_id })));

    const next = await prModel.markSubmitted(t, prId);
    await record(t, {
      prId, revision: next.revision, actorId: user.id, type: 'submitted',
      payload: { estimated_total: next.estimated_total, line_count: lines.length, from_status: pr.status },
    });

    const groups = await computeReviewGroups({ companyId: cell.companyId, lines: checked }, t);
    if (groups.length) {
      const { reviews } = await startReview(t, next, groups);
      return { pr: next, status: 'in_review', reviews };
    }
    const { instance, autoApproved } = await startApproval(t, next, user.id);
    return { pr: next, status: 'pending_approval', instance, autoApproved };
  });

  if (out.reviews) await notifyReviewTasks({ pr: out.pr, reviews: out.reviews, actorId: user.id });
  // Never expected for a PR (the requester is never an approver), but if the
  // engine ever auto-approves, the PR must follow — after the commit, as MR does.
  if (out.autoApproved) {
    await dispatchPostApprovalAction(out.instance.id, user.id, { status: 'APPROVED', comment: 'Auto-approved at submission' });
  }
  return { id: prId, status: out.status };
}

/**
 * Cancel the PR's current approval instance inside the caller's transaction.
 * PENDING → cancelled (notifications deferred to the returned thunk). Already
 * CANCELLED (or gone) → nothing to undo. APPROVED / REJECTED → 409: a decision
 * landed first and its handler is about to move the PR.
 */
async function cancelCurrentInstance(t, pr, userId, reason) {
  const instanceId = pr.approval_instance_id ? Number(pr.approval_instance_id) : null;
  if (!instanceId) return { instanceId: null, notify: null };
  const inst = await t.oneOrNone(
    `SELECT id, status FROM tbl_approval_instances
      WHERE id = $1 AND entity_type = 'PR' AND entity_id = $2 FOR UPDATE`,
    [instanceId, pr.id]);
  if (!inst || inst.status === 'CANCELLED') return { instanceId, notify: null };
  if (inst.status !== 'PENDING') {
    throw prError(PR_ERR.STATE_CONFLICT,
      `The approval was already ${String(inst.status).toLowerCase()} — refresh to see the outcome`,
      { instance_status: inst.status });
  }
  const res = await cancelApprovalInstance(instanceId, userId, reason, { t });
  return { instanceId, notify: res.notify };
}

/**
 * Withdraw (requester): in_review / pending_approval → draft. The approval
 * instance is cancelled and pending reviews of the revision are superseded.
 */
export async function withdraw(prId, user) {
  const out = await db.tx(async (t) => {
    const pr = await prModel.lockPr(t, prId);
    if (!pr || !isRequester(user, pr)) throw notFound();
    if (!WITHDRAWABLE_STATUSES.includes(pr.status)) throw stateConflict(pr, 'withdrawn');
    const cancelled = pr.status === 'pending_approval'
      ? await cancelCurrentInstance(t, pr, user.id, 'Withdrawn by requester')
      : { instanceId: null, notify: null };
    const superseded = await prModel.supersedePendingReviews(t, prId, pr.revision);
    await prModel.updateHeader(t, prId, { status: 'draft' });
    await record(t, {
      prId, revision: pr.revision, actorId: user.id, type: 'withdrawn',
      payload: { from_status: pr.status, instance_id: cancelled.instanceId, superseded_review_ids: superseded },
    });
    return cancelled;
  });
  if (out.notify) await out.notify();
  return { id: prId, status: 'draft' };
}

// ---------------------------------------------------------------------------
// Approver send-back
// ---------------------------------------------------------------------------

/**
 * Send back (a PENDING approver of the instance's CURRENT step, note required):
 * pending_approval → returned, the instance cancelled. A caller who cannot
 * read the PR gets 404; a reader who is not on the current step gets 403.
 */
export async function approverSendBack(prId, user, rawNote) {
  const out = await db.tx(async (t) => {
    const pr = await prModel.lockPr(t, prId);
    if (!pr || !(await canReadPr(user, pr, t))) throw notFound();
    if (pr.status !== 'pending_approval') throw stateConflict(pr, 'sent back');

    const pos = pr.approval_instance_id
      ? await prModel.approvalPosition(t, { prId, instanceId: Number(pr.approval_instance_id), userId: user.id, lock: true })
      : null;
    if (!pos || pos.instance_status !== 'PENDING') {
      throw prError(PR_ERR.STATE_CONFLICT, 'The approval of this requisition has already moved on — refresh to see the latest', {
        instance_status: pos?.instance_status ?? null,
      });
    }
    if (isRequester(user, pr) || pos.is_pending_approver !== true || pos.step_status !== 'PENDING') {
      throw prError(PR_ERR.FORBIDDEN, 'Only an approver of the current approval step can send this requisition back');
    }

    const note = typeof rawNote === 'string' ? rawNote.trim() : '';
    if (!note || note.length > MAX_LEN.note) {
      throw prError(PR_ERR.VALIDATION, 'A note is required to send a requisition back', [{
        field: 'note', message: note ? `Must be at most ${MAX_LEN.note} characters` : 'Tell the requester what to change',
      }]);
    }

    const instanceId = Number(pr.approval_instance_id);
    const cancelled = await cancelApprovalInstance(instanceId, user.id, `Sent back: ${note}`, { t });
    await prModel.updateHeader(t, prId, { status: 'returned', returned_note: note });
    await record(t, {
      prId, revision: pr.revision, actorId: user.id, type: 'approval_sent_back',
      payload: { note, instance_id: instanceId, step_order: Number(pos.current_step) },
    });
    return { pr, note, notify: cancelled.notify };
  });
  if (out.notify) await out.notify();
  await notifyReturned({ pr: out.pr, note: out.note, actorId: user.id, by: 'approver' });
  return { id: prId, status: 'returned' };
}

// ---------------------------------------------------------------------------
// Engine outcome handlers (registered in approvalActionService and
// approvalPropagationService). Idempotent and fail-closed.
// ---------------------------------------------------------------------------

/**
 * Apply the engine's terminal outcome to the PR, once. Acts only when the
 * instance IS this PR's current instance, the instance really is `outcome`,
 * and the PR is still pending_approval; anything else is logged and ignored
 * (a re-fire, a stale instance of a withdrawn revision, a premature call).
 * Never throws: the decision has already committed.
 */
async function settle(outcome, approvalInstanceId, actorUserId, { comment = null } = {}) {
  const tag = outcome === 'APPROVED' ? 'handlePrPostApproval' : 'handlePrRejection';
  try {
    const settled = await db.tx(async (t) => {
      const ref = await t.oneOrNone(
        `SELECT entity_id FROM tbl_approval_instances WHERE id = $1 AND entity_type = 'PR'`, [approvalInstanceId]);
      if (!ref) return null;
      const pr = await prModel.lockPr(t, Number(ref.entity_id));
      const inst = await t.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [approvalInstanceId]);
      const skip = !pr ? 'PR not found'
        : Number(pr.approval_instance_id) !== Number(approvalInstanceId) ? 'not the PR\'s current approval'
          : pr.status !== 'pending_approval' ? `PR is ${pr.status}`
            : inst.status !== outcome ? `instance is ${inst.status}` : null;
      if (skip) {
        logger.info({ approvalInstanceId, prId: ref.entity_id, outcome }, `[prWorkflow.${tag}] no-op: ${skip}`);
        return null;
      }
      const after = outcome === 'APPROVED'
        ? await prModel.markApproved(t, pr.id)
        : await prModel.updateHeader(t, pr.id, { status: 'rejected' });
      await record(t, {
        prId: pr.id, revision: pr.revision, actorId: actorUserId || null,
        type: outcome === 'APPROVED' ? 'approved' : 'rejected',
        payload: { instance_id: Number(approvalInstanceId), ...(comment ? { comment } : {}) },
      });
      return after;
    });
    if (!settled) return;
    if (outcome === 'APPROVED') await notifyApproved({ pr: settled, actorId: actorUserId });
    else await notifyRejected({ pr: settled, actorId: actorUserId, comment });
  } catch (err) {
    logger.error({ err, approvalInstanceId }, `[prWorkflow.${tag}] failed`);
  }
}

/** Engine APPROVED → PR approved (+ approved_at), event, requester + hotel buyers notified. */
export async function handlePrPostApproval(approvalInstanceId, actorUserId, options = {}) {
  return settle('APPROVED', approvalInstanceId, actorUserId, options);
}

/** Engine REJECTED → PR rejected (terminal), event, requester notified. */
export async function handlePrRejection(approvalInstanceId, actorUserId, options = {}) {
  return settle('REJECTED', approvalInstanceId, actorUserId, options);
}

export default {
  submit, startReview, startApproval, withdraw, approverSendBack, handlePrPostApproval, handlePrRejection,
};
