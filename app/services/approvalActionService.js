import {
  submitApprovalAction as submitApprovalActionModel,
  getApprovalInstanceById,
  notifyNextApprovalStep,
} from '../models/generalModel.js';
import { logError } from '../helper/common.js';
import { dispatch as dispatchNotification } from './notificationService.js';
import { approvalActionUrl, entityLabel, buyerHome } from './notificationLinks.js';
import db from '../config/dbConn.js';
import { bindParkedAward, bindSelectedQuotes } from './po/awardQuoteBinding.js';
import { isApproverOnCurrentStep } from './approvalMembership.js';
import { refusesForeignTarget, ApprovalInstanceNotFoundError } from './approvalTargetOwner.js';

/**
 * Approval Action Service
 *
 * Single canonical entry point for executing approval actions (APPROVE / REJECT)
 * against an existing approval instance.
 *
 * Background: `submitApprovalAction` in generalModel.js is a low-level
 * transactional primitive. It only mutates the approval instance / step /
 * approver rows. Each entity type (RFQ, TENDER, TECHNICAL, PO, ARC, NEGOTIATION,
 * NEGOTIATION_QUOTE) has its own post-action handler that performs the
 * entity-specific business logic (transitioning the entity row, generating
 * documents, sending vendor emails, etc.).
 *
 * Historically, every controller that called `submitApprovalAction` had to
 * remember to also call the right post-action handler. The generic action
 * endpoint in generalController.js had a long if/else chain that was easy
 * to forget — for example, the TECHNICAL APPROVE branch was missing, which
 * left tech eval rounds stuck in SUBMITTED status whenever an approver
 * approved them through the lifecycle journey or any other generic surface.
 *
 * `executeApprovalAction` removes that footgun. It runs the model action and
 * then dispatches to the correct post-action handler based on
 * (entity_type, instance_status) using a registry. All controllers should call
 * this wrapper instead of `submitApprovalAction` directly.
 *
 * Notes:
 * - Handlers are dynamically imported to avoid circular dependencies between
 *   the service layer and the controllers that own each handler.
 * - Post-action errors are logged but never re-thrown. The approval status
 *   transition has already committed by the time the dispatcher runs, so
 *   throwing here would mislead callers into thinking the action failed.
 *   This matches the existing inline try/catch behaviour in generalController.js.
 * - Auto-approval (when the initiator is the only approver) does NOT flow
 *   through this service — `createApprovalInstance` directly mutates the
 *   approval instance row inside its own transaction. Auto-approval call
 *   sites must continue to invoke their post-action handler explicitly.
 */

// Registry of post-action handlers, keyed by entity_type and resulting instance_status.
// Each entry is a loader function that returns the actual handler. Loaders are invoked
// lazily so we don't import controller modules at service-load time, which would
// create a controller -> service -> controller import cycle.
const postActionRegistry = {
  RFQ: {
    APPROVED: () => import('../controllers/rfq/rfqController.js').then(m => m.handleRFQPostApproval),
    REJECTED: () => import('../controllers/rfq/rfqController.js').then(m => m.handleRFQRejection),
  },
  TENDER: {
    APPROVED: () => import('../controllers/rfq/rfqController.js').then(m => m.handleRFQPostApproval),
    REJECTED: () => import('../controllers/rfq/rfqController.js').then(m => m.handleRFQRejection),
  },
  TECHNICAL: {
    APPROVED: () => import('../controllers/rfq/rfqController.js').then(m => m.handleTechnicalPostApproval),
    REJECTED: () => import('../controllers/rfq/rfqController.js').then(m => m.handleTechnicalRejection),
  },
  // PO decisions never reach the post-commit dispatcher from
  // executeApprovalAction: both run inside poApprovalService's transaction.
  // APPROVED stays registered for executePoApproval's in-transaction lookup.
  // REJECTED is deliberately absent — a PO rejection is decision, status,
  // de-finalization, reason and lifecycle in ONE transaction
  // (poApprovalService.rejectPurchaseOrder), and running half of it after
  // somebody else's commit is exactly the split it exists to prevent.
  PO: {
    APPROVED: () => import('../controllers/po/purchaseOrderController.js').then(m => m.handlePOPostApproval),
  },
  // ARC v2 — separate entity types per plan §5.5. The legacy single 'ARC'
  // entity type is intentionally NOT registered here; any leftover v1 ARC
  // approval instances no-op and are expected to be cleaned up post-migration.
  ARC_TECH: {
    APPROVED: () => import('../controllers/arc_v2/arcEvaluationController.js').then(m => m.handleArcTechPostApproval),
    REJECTED: () => import('../controllers/arc_v2/arcEvaluationController.js').then(m => m.handleArcTechRejection),
  },
  ARC_COMMITTEE: {
    APPROVED: () => import('../controllers/arc_v2/arcCommitteeController.js').then(m => m.handleArcCommitteeApproval),
    REJECTED: () => import('../controllers/arc_v2/arcCommitteeController.js').then(m => m.handleArcCommitteeRejection),
  },
  // ARC publish-approval gate. The INSTANCE entity_type is ARC_PUBLISH (its
  // policy is matched as plain 'ARC'). Registering ARC_PUBLISH — and NOT bare
  // 'ARC' — is the collision guard: a legacy tender 'ARC' instance reaching a
  // terminal state finds no registry entry and no-ops, so it can never mis-fire
  // the publish float/reject hooks.
  ARC_PUBLISH: {
    APPROVED: () => import('../controllers/arc_v2/arcController.js').then(m => m.handleArcPublishApproval),
    REJECTED: () => import('../controllers/arc_v2/arcController.js').then(m => m.handleArcPublishRejection),
  },
  ARC_AMENDMENT: {
    APPROVED: () => import('../controllers/arc_v2/arcAmendmentController.js').then(m => m.handleArcAmendmentApproval),
    REJECTED: () => import('../controllers/arc_v2/arcAmendmentController.js').then(m => m.handleArcAmendmentRejection),
  },
  MR: {
    APPROVED: () => import('../controllers/mr/mrController.js').then(m => m.handleMrPostApproval),
    REJECTED: () => import('../controllers/mr/mrController.js').then(m => m.handleMrRejection),
  },
  // Purchase requisitions. Both handlers row-lock the PR and are idempotent;
  // they also notify (prNotify), so notifyApprovalOutcome skips PR.
  PR: {
    APPROVED: () => import('../controllers/pr/prController.js').then(m => m.handlePrPostApproval),
    REJECTED: () => import('../controllers/pr/prController.js').then(m => m.handlePrRejection),
  },
  NEGOTIATION: {
    APPROVED: () => import('../controllers/negotiation/negotiationController.js').then(m => m.handleNegotiationPostApproval),
    REJECTED: () => import('../controllers/negotiation/negotiationController.js').then(m => m.handleNegotiationRejection),
  },
  ARC_NEGOTIATION: {
    APPROVED: () => import('../controllers/arc_v2/arcNegotiationController.js').then(m => m.handleArcNegotiationApproval),
    REJECTED: () => import('../controllers/arc_v2/arcNegotiationController.js').then(m => m.handleArcNegotiationRejection),
  },
  // REJECTED was missing here until fix/negotiation-search-and-reject — this was
  // the only entity type with an APPROVED handler and no rejection pair, so a
  // reject taken from the generic action endpoint (the entity-agnostic approval
  // card on the RFQ details page) flipped the instance to REJECTED but left the
  // product finalized to the refused vendor, with nothing on the lifecycle.
  NEGOTIATION_QUOTE: {
    APPROVED: () => import('../controllers/general/negotiationQuotePostApproval.js').then(m => m.handleNegotiationQuotePostApproval),
    REJECTED: () => import('../controllers/general/negotiationQuotePostApproval.js').then(m => m.handleNegotiationQuoteRejection),
  },
};

/** Every engine type with a post-approval or rejection handler. */
export const REGISTERED_APPROVAL_TYPES = Object.freeze(Object.keys(postActionRegistry));

/**
 * Execute an approval action and dispatch the entity-specific post-action.
 *
 * @param {Object} args
 * @param {number} args.approval_instance_id
 * @param {number} [args.approval_instance_step_id]
 * @param {number} args.approver_user_id
 * @param {'APPROVE'|'REJECT'} args.action
 * @param {string} [args.comment]
 * @param {string} [args.reason_category] - PO REJECT only; see poApprovalService.resolveRejectionRoute
 * @param {string} [args.route] - PO REJECT only: COMMERCIAL or CANCEL
 * @returns {Promise<Object>} Result from submitApprovalAction (instance_status, step_status, etc.)
 * @throws PoDecisionError for a refused PO rejection (carries httpStatus + code)
 */
export async function executeApprovalAction(args) {
  const instance = await getApprovalInstanceById(args.approval_instance_id);

  // The instance's target (the RFQ, round, ARC, MR or PO its handlers act on)
  // must be its own company's. One opened in this company naming another
  // company's target (the generic submit route accepted every type until
  // c3a51cd6) is answered like a missing instance, before any vote is
  // recorded, any handler runs or anyone is notified. dispatchPostApprovalAction
  // makes the same check for every other way a handler is reached.
  if (instance && await refusesForeignTarget(db, instance, 'executeApprovalAction')) {
    throw new ApprovalInstanceNotFoundError();
  }

  // PO decisions take their own path, both of them, and both lock the PO row
  // before the approval instance (poApprovalService's lock order):
  //
  //   APPROVE — the decision and the PO document commit together, or neither
  //             does (executePoApprovalAtomically).
  //   REJECT  — decision, status, vendor de-finalization, the reason and the
  //             lifecycle row commit together, then the people who can act are
  //             told (rejectPurchaseOrder). Same function as POST
  //             /po/approve/:po_id, so the two surfaces end in the same state.
  if (instance?.entity_type === 'PO' && instance.entity_id) {
    const action = String(args.action || '').toUpperCase();
    if (action === 'APPROVE') return executePoApproval(args, instance);
    if (action === 'REJECT') return executePoRejection(args, instance);
  }

  // 0. A NEGOTIATION_QUOTE approve: the award it carries (a parked finalize
  // payload, or the selected_quotes of a submit-for-approval) must bind to its
  // RFQ, vendor and this instance's product before the approval is recorded.
  // negotiationQuotePostApproval turns a payload into a PO line after the
  // commit, and a refusal there would leave the instance APPROVED with no PO.
  // Throws PoDecisionError (404/400), which the action route answers with its
  // own status and code.
  //
  // Only for an approver who can act on the current step now. This route has
  // no tenant gate of its own (submitApprovalAction's approver check is it),
  // so binding first would answer anyone, from any company, whether an
  // instance's award binds (404/400) before telling them they are not an
  // approver. Everyone else falls through to submitApprovalAction's refusal.
  if (
    instance?.entity_type === 'NEGOTIATION_QUOTE'
    && String(args.action || '').toUpperCase() === 'APPROVE'
    && await isApproverOnCurrentStep(instance.id, args.approver_user_id, { pendingOnly: true })
  ) {
    await bindParkedAward(db, instance);
    await bindSelectedQuotes(db, instance);
  }

  // 1. Run the underlying transactional model action (status updates only).
  const result = await submitApprovalActionModel(args);

  // A replay: the instance had already concluded (or this approver had already
  // given this decision), so nothing was decided now. submitApprovalAction
  // answers an already-concluded instance BEFORE its approver check, so the
  // caller need not be an approver at all, and re-running the post-approval
  // handler here re-drafted the award's PO (cancelling the one awaiting
  // approval) and re-sent the outcome mail on behalf of whoever replayed it.
  // The handler and the notifications ran when the decision was made.
  if (result.already_completed) return result;

  // 2. Dispatch entity-specific post-action only if the instance terminally transitioned.
  if (result.instance_status === 'APPROVED' || result.instance_status === 'REJECTED') {
    const dispatched = await dispatchPostApprovalAction(args.approval_instance_id, args.approver_user_id, {
      status: result.instance_status,
      comment: args.comment,
    });
    if (!dispatched.refused) {
      await notifyApprovalOutcome(args.approval_instance_id, args.approver_user_id, {
        status: result.instance_status,
        comment: args.comment,
      });
    }
  }

  return result;
}

/**
 * A PO rejection from the generic approval card. The optional `reason_category`
 * and `route` are the PO page's, with the same defaults (OTHER, COMMERCIAL).
 * Returns the engine's result shape plus the route and reason taken.
 */
async function executePoRejection(args, instance) {
  const { rejectPurchaseOrder } = await import('./poApprovalService.js');
  const out = await rejectPurchaseOrder({
    poId: Number(instance.entity_id),
    approvalInstanceId: args.approval_instance_id,
    approvalInstanceStepId: args.approval_instance_step_id || null,
    user: { id: args.approver_user_id },
    comment: args.comment || '',
    reason_category: args.reason_category,
    route: args.route,
  });
  return {
    ...out.result,
    route: out.route,
    reason_category: out.reasonCategory,
    send_back_id: out.sendBackId,
  };
}

/**
 * A PO approval, committed together with the document that records it.
 *
 * Regeneration used to be a step that ran after the decision had already
 * committed, wrapped in a catch that logged and carried on. Sixteen production
 * POs show what that produced: an approval recorded in the database and a
 * document, served from S3, that does not mention it. The approvers were told
 * nothing — the endpoint returned 200 either way — and several of them clicked
 * Approve three or four more times trying to make something happen.
 *
 * Now a document that cannot be produced takes the approval down with it, and
 * the approver is told to try again.
 *
 * Ordering: decision, then document (built through the same transaction, so it
 * prints this approver as "Approved"), then the entity transition, then COMMIT,
 * and only then the emails.
 */
async function executePoApproval(args, instance) {
  const { executePoApprovalAtomically } = await import('./poApprovalService.js');
  const { writePoDocument } = await import('./poDocumentService.js');

  return executePoApprovalAtomically(
    {
      po_id: instance.entity_id,
      approval_instance_id: args.approval_instance_id,
      approval_instance_step_id: args.approval_instance_step_id,
      approver_user_id: args.approver_user_id,
      action: args.action,
      comment: args.comment,
    },
    {
      writeDocument: writePoDocument,

      // Inside the transaction: the PO status transition and its lifecycle row.
      // Only APPROVE decisions take this path (rejections: executePoRejection).
      postAction: async (tx, result) => {
        if (result.instance_status !== 'APPROVED') return;
        const handler = await postActionRegistry.PO.APPROVED();
        if (handler) {
          await handler(args.approval_instance_id, args.approver_user_id, {
            status: result.instance_status,
            comment: args.comment,
            txContext: tx,
          });
        }
      },

      // After the commit: everything that leaves the building.
      afterCommit: async (result) => {
        await notifyNextApprovalStep(args.approval_instance_id, result);
        if (result.instance_status === 'APPROVED') {
          await notifyApprovalOutcome(args.approval_instance_id, args.approver_user_id, {
            status: result.instance_status,
            comment: args.comment,
          });
        }
      },
    }
  );
}

/**
 * Tell the person who raised an approval how it ended.
 *
 * Rejection was silent for every entity type except the ARC family, which has
 * its own notifier. An RFQ was pushed back to draft and its publish schedule
 * disarmed, a PO was rejected and its vendor de-finalized, a material
 * requisition was refused, a negotiation round was cancelled with every vendor
 * flipped to REJECTED — and in each case the initiator was told nothing. They
 * found out by noticing the state had changed.
 *
 * Sits here rather than in the eight per-entity rejection handlers so there is
 * one place to keep correct, and runs post-commit for the same reason the
 * entity handlers do.
 *
 * Never throws: a notification failure must not make a committed approval look
 * like it failed.
 */
export async function notifyApprovalOutcome(approvalInstanceId, actorUserId, { status, comment } = {}) {
  try {
    const instance = await getApprovalInstanceById(approvalInstanceId);
    if (!instance || !instance.initiated_by) return;

    // The actor already knows — they are the one who just decided.
    if (Number(instance.initiated_by) === Number(actorUserId)) return;

    // ARC entity types run their own richer notifier (arcNotificationService),
    // which knows about stages, committees and vendor audiences. Notifying here
    // too would double up.
    if (String(instance.entity_type || '').startsWith('ARC')) return;
    // PR likewise: handlePrPostApproval / handlePrRejection tell the requester
    // (and, on approval, the hotel's buyers) through prNotify, with an email.
    if (instance.entity_type === 'PR') return;

    const label = entityLabel(instance.entity_type);
    const metadata = instance.metadata || {};
    const identifier =
      metadata.rfq_no || metadata.po_number || metadata.mr_number || metadata.pr_number || instance.entity_id;

    const rejected = status === 'REJECTED';

    await dispatchNotification({
      userIds: [Number(instance.initiated_by)],
      senderUserId: actorUserId || null,
      category: 'approval',
      type: rejected ? 'approval_rejected' : 'approval_approved',
      title: rejected
        ? `Rejected: ${label} #${identifier}`
        : `Approved: ${label} #${identifier}`,
      body: rejected
        ? comment
          ? `Your ${label.toLowerCase()} was rejected — "${comment}"`
          : `Your ${label.toLowerCase()} was rejected.`
        : `Your ${label.toLowerCase()} cleared all approval steps.`,
      data: {
        entity_type: instance.entity_type,
        entity_id: instance.entity_id,
        approval_instance_id: approvalInstanceId,
        status,
      },
      actionUrl:
        approvalActionUrl(instance.entity_type, instance.entity_id, metadata) || buyerHome(),
    });
  } catch (notifyErr) {
    logError(`Approval outcome notification failed for instance ${approvalInstanceId}`, notifyErr);
  }
}

/**
 * Fire the entity-specific post-action for an instance that reached a
 * terminal status. THE dispatcher: executeApprovalAction, the propagation
 * service's auto-completion (handleAutoCompletedInstances), ARC round recovery
 * and every create-time auto-approval reach a handler through here. Exported
 * because instances can ALSO terminally transition at CREATION time —
 * createApprovalInstance auto-approves every step whose only required approver
 * is the initiator, returning `autoApproved: true` WITHOUT any
 * executeApprovalAction call. Callers that create instances must invoke this
 * when that happens, or side effects (contract generation, status flips)
 * silently never run.
 *
 * Before any handler: the instance's target must be its own company's
 * (approvalTargetOwner). Otherwise nothing runs and `refused` is true, so the
 * caller notifies nobody either.
 *
 * Post-actions must never fail the approval itself — errors are logged and
 * swallowed, matching the behaviour of the entity handlers' own try/catch.
 *
 * @returns {Promise<{dispatched: boolean, refused: boolean, result?: *}>}
 *   result is the handler's own return value.
 */
export async function dispatchPostApprovalAction(approvalInstanceId, actorUserId, { status, comment } = {}) {
  try {
    const instance = await getApprovalInstanceById(approvalInstanceId);
    if (!instance) return { dispatched: false, refused: false };
    if (await refusesForeignTarget(db, instance, `dispatch:${status}`)) {
      return { dispatched: false, refused: true };
    }
    const lookup = postActionRegistry[instance.entity_type];
    const loader = lookup?.[status];
    if (loader) {
      const handler = await loader();
      if (typeof handler === 'function') {
        const result = await handler(approvalInstanceId, actorUserId, { comment, instance });
        return { dispatched: true, refused: false, result };
      }
    }
    return { dispatched: false, refused: false };
  } catch (postErr) {
    logError(`Post-approval handler failed for instance ${approvalInstanceId}`, postErr);
    return { dispatched: false, refused: false };
  }
}
