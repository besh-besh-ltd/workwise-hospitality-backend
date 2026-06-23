import {
  submitApprovalAction as submitApprovalActionModel,
  getApprovalInstanceById,
} from '../models/generalModel.js';
import { logger } from '../util/logger.js';
import { logError } from '../helper/common.js';

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
  NEGOTIATION_QUOTE: {
    APPROVED: () => import('../controllers/general/negotiationQuotePostApproval.js').then(m => m.handleNegotiationQuotePostApproval),
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

  // 2. Dispatch entity-specific post-action only if the instance terminally transitioned.
  if (result.instance_status === 'APPROVED' || result.instance_status === 'REJECTED') {
    await dispatchPostApprovalAction(args.approval_instance_id, args.approver_user_id, {
      status: result.instance_status,
      comment: args.comment,
    });
  }

  return result;
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
