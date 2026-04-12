/**
 * WH-69: Re-approval helper used when an RFQ is edited after it has already
 * been approved (or while a pending approval exists).
 *
 * Strategy: cancel any existing PENDING or APPROVED approval instance for the
 * entity, then call the standard createApprovalInstance to spawn a fresh one.
 * Both operations participate in the caller's transaction.
 *
 * Approval is currently a formality on this codebase — the RFQ status itself
 * is NOT reset. We only bookmark a new pending instance so the approver chain
 * sees the post-edit state.
 */

import { createApprovalInstance } from '../../models/generalModel.js';
import { logger } from '../../util/logger.js';

/**
 * Cancel active approvals for an RFQ and reissue.
 *
 * @param {Object}    rfq             — full row from rfqModel.getFullRfqForEdit
 * @param {number}    userId          — editor's tbl_users.id
 * @param {string}    editSessionId   — uuid of the current edit session (for audit)
 * @param {Object}    t               — pg-promise transaction context (required)
 * @returns {Promise<{ cancelledIds: number[], newInstanceId: number|null }>}
 */
export async function cancelAndReissueApproval(rfq, userId, editSessionId, t) {
  if (!t) throw new Error('cancelAndReissueApproval requires a transaction context');
  if (!rfq?.id) throw new Error('cancelAndReissueApproval: rfq is required');

  const entityType = rfq.is_tender ? 'TENDER' : 'RFQ';

  // 1) Cancel any active (PENDING/APPROVED) instances. We mark APPROVED ones
  //    as CANCELLED too because the post-edit state has not been re-approved.
  const active = await t.any(
    `SELECT id, status FROM tbl_approval_instances
      WHERE entity_type IN ('RFQ','TENDER')
        AND entity_id   = $1
        AND status      IN ('PENDING','APPROVED')`,
    [rfq.id]
  );

  const cancelledIds = [];
  for (const inst of active) {
    await t.none(
      `UPDATE tbl_approval_instances
          SET status      = 'CANCELLED',
              completed_at = NOW(),
              metadata     = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
        WHERE id = $2`,
      [
        JSON.stringify({
          cancelled_due_to: 'rfq_edit',
          cancelled_by: userId,
          edit_session_id: editSessionId
        }),
        inst.id
      ]
    );
    cancelledIds.push(inst.id);
  }

  // 2) Spawn a fresh approval instance using the standard engine.
  //    If no policy exists for this scope (some edge cases on legacy RFQs),
  //    we swallow the error and continue — the caller is doing an edit, not
  //    a new approval, and we don't want to block the edit on policy gaps.
  let newInstanceId = null;
  try {
    const newInstance = await createApprovalInstance({
      entity_type: entityType,
      entity_id: rfq.id,
      hospitality_company_id: rfq.hospitality_company_id,
      hotel_id: rfq.hotel_id || null,
      department_id: rfq.department_id || null,
      // Process scope is part of the policy match key (see
      // findBestMatchingPolicyTx). Omitting it caused legitimate
      // process-scoped policies to look like "no policy in this scope"
      // and the reissue to silently fall through to the catch below.
      process_id: rfq.process_id || null,
      initiated_by: userId,
      metadata: {
        reissue_reason: 'rfq_edit',
        edit_session_id: editSessionId,
        cancelled_instance_ids: cancelledIds
      },
      txContext: t
    });
    newInstanceId = newInstance?.id || null;
  } catch (err) {
    // Don't block the edit if approval re-creation fails — log and continue.
    logger.warn(
      { rfqId: rfq.id, err: err.message || err },
      `[reapprovalService] Could not reissue approval for RFQ ${rfq.id}`
    );
  }

  return { cancelledIds, newInstanceId };
}
