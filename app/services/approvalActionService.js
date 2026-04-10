import {
  submitApprovalAction as submitApprovalActionModel,
  getApprovalInstanceById,
} from '../models/generalModel.js';

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
  ARC: {
    APPROVED: () => import('../controllers/arc/arcController.js').then(m => m.handleArcPostApproval),
  },
  NEGOTIATION: {
    APPROVED: () => import('../controllers/negotiation/negotiationController.js').then(m => m.handleNegotiationPostApproval),
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
    try {
      const instance = await getApprovalInstanceById(args.approval_instance_id);
      const lookup = postActionRegistry[instance?.entity_type];
      const loader = lookup?.[result.instance_status];
      if (loader) {
        const handler = await loader();
        if (typeof handler === 'function') {
          await handler(args.approval_instance_id, args.approver_user_id, {
            comment: args.comment,
            instance,
          });
        }
      }
    } catch (postErr) {
      // Post-actions must never fail the approval itself — log and swallow,
      // matching the behaviour of the existing inline try/catch blocks.
      console.error(`Post-approval handler failed for instance ${args.approval_instance_id}:`, postErr);
    }
  }

  return result;
}
