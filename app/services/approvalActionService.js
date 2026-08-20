import {
  submitApprovalAction as submitApprovalActionModel,
  getApprovalInstanceById,
} from '../models/generalModel.js';
import { logger } from '../util/logger.js';
import { logError } from '../helper/common.js';
import { dispatch as dispatchNotification } from './notificationService.js';
import { approvalActionUrl, entityLabel, buyerHome } from './notificationLinks.js';

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
  PO: {
    APPROVED: () => import('../controllers/po/purchaseOrderController.js').then(m => m.handlePOPostApproval),
    REJECTED: () => import('../controllers/po/purchaseOrderController.js').then(m => m.handlePORejectionByInstance),
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

/**
 * Execute an approval action and dispatch the entity-specific post-action.
 *
 * @param {Object} args
 * @param {number} args.approval_instance_id
 * @param {number} [args.approval_instance_step_id]
 * @param {number} args.approver_user_id
 * @param {'APPROVE'|'REJECT'} args.action
 * @param {string} [args.comment]
 * @returns {Promise<Object>} Result from submitApprovalAction (instance_status, step_status, etc.)
 */
export async function executeApprovalAction(args) {
  // 1. Run the underlying transactional model action (status updates only).
  const result = await submitApprovalActionModel(args);

  // 2. Refresh the PO document. Must come BEFORE the post-action, which emails
  //    that PDF, and runs on EVERY approve rather than only the terminal one —
  //    the approver table inside the PDF lists each step.
  if (args.action === 'APPROVE') {
    await regeneratePoDocumentIfPo(args.approval_instance_id);
  }

  // 3. Dispatch entity-specific post-action only if the instance terminally transitioned.
  if (result.instance_status === 'APPROVED' || result.instance_status === 'REJECTED') {
    await dispatchPostApprovalAction(args.approval_instance_id, args.approver_user_id, {
      status: result.instance_status,
      comment: args.comment,
    });
    await notifyApprovalOutcome(args.approval_instance_id, args.approver_user_id, {
      status: result.instance_status,
      comment: args.comment,
    });
  }

  return result;
}

/**
 * Rewrite the stored PO PDF after an approval, if this instance belongs to a PO.
 *
 * A PO PDF is a stored artefact — `po_pdf_url` points at a file uploaded to S3,
 * and downloading serves that file rather than rendering on demand. So the
 * approver table printed inside it only changes when something rewrites the
 * file. Nothing here did.
 *
 * Regeneration used to live solely in the dedicated PO approval endpoint
 * (purchaseOrderController), on the stated assumption that it was "the
 * canonical PO approval surface". It is not the only one: the RFQ Lifecycle
 * Journey and the generic action endpoint both approve POs through this
 * service. An approval taken from either recorded correctly in the database and
 * transitioned the PO, but left the PDF frozen at whatever the previous write
 * captured.
 *
 * Observed on PO 483 (RFQ 536375): step 1 was approved through the dedicated
 * endpoint and the PDF was rewritten; step 2 was approved elsewhere a day
 * later, and the downloaded PO still printed that approver as "Invited" — a
 * document contradicting its own approval record, in front of a client.
 *
 * Attaching this to the action rather than to one endpoint means every surface
 * that can approve a PO now leaves a truthful document behind.
 *
 * Never throws: the approval has already committed, and a stale PDF must not be
 * reported to the caller as a failed approval. Same policy as the post-action
 * dispatcher below.
 */
async function regeneratePoDocumentIfPo(approvalInstanceId) {
  try {
    const instance = await getApprovalInstanceById(approvalInstanceId);
    if (!instance || instance.entity_type !== 'PO' || !instance.entity_id) return;

    // Dynamic import for the same reason the post-action handlers use one:
    // purchaseOrderModel pulls in controllers that import this service.
    const { regeneratePODocument } = await import('../models/purchaseOrderModel.js');
    // No txContext on purpose — submitApprovalActionModel has already committed,
    // so this must read the approval rows outside that transaction to see the
    // decision it is meant to be printing.
    await regeneratePODocument(instance.entity_id);
    logger.info(
      { approvalInstanceId, poId: instance.entity_id },
      'Regenerated PO document after approval action'
    );
  } catch (err) {
    logError('executeApprovalAction: failed to regenerate PO document', err);
  }
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

    const label = entityLabel(instance.entity_type);
    const metadata = instance.metadata || {};
    const identifier =
      metadata.rfq_no || metadata.po_number || metadata.mr_number || instance.entity_id;

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
 * terminal status. Exported because instances can ALSO terminally transition
 * at CREATION time — createApprovalInstance auto-approves every step whose
 * only required approver is the initiator, returning `autoApproved: true`
 * WITHOUT any executeApprovalAction call. Callers that create instances must
 * invoke this when that happens, or side effects (contract generation,
 * status flips) silently never run.
 *
 * Post-actions must never fail the approval itself — errors are logged and
 * swallowed, matching the behaviour of the entity handlers' own try/catch.
 */
export async function dispatchPostApprovalAction(approvalInstanceId, actorUserId, { status, comment } = {}) {
  try {
    const instance = await getApprovalInstanceById(approvalInstanceId);
    const lookup = postActionRegistry[instance?.entity_type];
    const loader = lookup?.[status];
    if (loader) {
      const handler = await loader();
      if (typeof handler === 'function') {
        await handler(approvalInstanceId, actorUserId, { comment, instance });
      }
    }
  } catch (postErr) {
    logError(`Post-approval handler failed for instance ${approvalInstanceId}`, postErr);
  }
}
