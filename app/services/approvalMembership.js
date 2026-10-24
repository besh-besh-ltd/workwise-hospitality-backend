// Who may act on an approval instance right now, read-only.
//
// submitApprovalAction decides this under its lock, but some handlers have to
// answer about the instance BEFORE it runs (a pre-flight that reads the
// instance's RFQ, POs or parked award). Asking first, with the same test,
// keeps those pre-flights from answering a caller who is not on the instance:
// otherwise the order of the checks becomes an oracle (a 404/400 about a
// payload, where an outsider should only ever hear "not an approver").

import db from '../config/dbConn.js';

// submitApprovalAction's refusal of a caller with no approver row on the
// current step, word for word, so an early check answers the same.
export const NOT_AN_APPROVER_MESSAGE = 'User is not an approver for this step';

/**
 * Is `userId` an approver on the CURRENT step of this PENDING instance?
 *
 * By default an approver still to act OR one who already approved counts: the
 * membership test submitApprovalAction makes (and getApprovalInstanceDetails'
 * can_user_approve). A REMOVED or otherwise inactive approver row does not.
 * An approver who already approved is let through as a member of the
 * instance, but a second approve is NOT a silent success: submitApprovalAction's
 * idempotency branch compares the stored row status ('APPROVED') with the
 * action ('APPROVE'), never matches, and throws "User has already acted on this
 * step with status: APPROVED".
 *
 * `pendingOnly` narrows it to an approver who can record an action now (row
 * status PENDING), which is exactly who submitApprovalAction lets through.
 *
 * @param {number} instanceId
 * @param {number} userId
 * @param {object} [opts]
 * @param {boolean} [opts.pendingOnly=false]
 * @param {object}  [opts.dbCtx=db]
 * @returns {Promise<boolean>}
 */
export async function isApproverOnCurrentStep(instanceId, userId, { pendingOnly = false, dbCtx = db } = {}) {
  if (!instanceId || !userId) return false;
  const statuses = pendingOnly ? ['PENDING'] : ['PENDING', 'APPROVED'];
  const row = await dbCtx.oneOrNone(
    `SELECT 1
       FROM tbl_approval_instances i
       JOIN tbl_approval_instance_steps s
         ON s.approval_instance_id = i.id AND s.step_order = i.current_step
       JOIN tbl_approval_step_approvers sa
         ON sa.approval_instance_step_id = s.id AND sa.approver_user_id = $2
      WHERE i.id = $1 AND i.status = 'PENDING' AND sa.status = ANY($3::text[])
      LIMIT 1`,
    [instanceId, userId, statuses]
  );
  return !!row;
}
