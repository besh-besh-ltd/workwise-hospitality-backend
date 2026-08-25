import db from '../config/dbConn.js';
import { submitApprovalAction } from '../models/generalModel.js';
import { logger } from '../util/logger.js';
import { logError } from '../helper/common.js';

/**
 * PO approval as a single all-or-nothing unit.
 *
 * A purchase order's PDF is a stored artefact: `po_pdf_url` points at a file in
 * S3, and downloading serves that file rather than rendering on demand. The
 * approver table printed inside it therefore only changes when something
 * rewrites the file. When that rewrite failed, the approval committed anyway —
 * the PO moved to acceptance_pending and the vendor was emailed a link to a
 * document that did not mention the approval it was sent to confirm.
 *
 * Sixteen POs in production reached that state. The approvers noticed nothing:
 * the endpoint returned 200 either way. Some of them clicked Approve three or
 * four more times, which recorded more lifecycle events and changed nothing.
 *
 * Why the old code could not simply be wrapped in a transaction:
 * `submitApprovalAction` opened its own, on a second connection, and committed
 * before the document was attempted. Everything downstream ran outside the
 * only transaction that mattered. It now accepts a transaction, so the decision
 * and the document share one commit.
 *
 * Ordering inside the transaction is load-bearing:
 *
 *   1. record the decision      — writes the approver row
 *   2. write the document       — reads that row through the SAME transaction,
 *                                 so it prints this approver as "Approved"
 *                                 rather than "Invited"
 *   3. run the post-action      — status transition, lifecycle event
 *   4. COMMIT
 *   5. side effects            — vendor email, notifications
 *
 * Step 2 reading uncommitted state is the point, not an accident: it is what
 * lets the document be part of the same commit as the decision it records.
 *
 * Step 5 is strictly after the commit, so nothing THIS service announces can
 * refer to an approval that rolled back. One caveat worth knowing: the PO
 * post-action handler (handlePOPostApproval) fires the vendor acceptance email
 * itself, fire-and-forget, from inside step 3 — so that particular email can
 * still escape a transaction that later fails to commit. Pre-existing, and
 * narrow now that the document is written before the post-action runs: the
 * failure that actually happens in production is caught in step 2, long before
 * any email. Moving it out means restructuring handlePOPostApproval, which is
 * its own change.
 */

/**
 * @param {Object} args
 * @param {number} args.po_id
 * @param {number} args.approval_instance_id
 * @param {number} [args.approval_instance_step_id]
 * @param {number} args.approver_user_id
 * @param {'APPROVE'|'REJECT'} args.action
 * @param {string} [args.comment]
 *
 * @param {Object} [deps]
 * @param {Object} [deps.conn] - connection or transaction to run on
 * @param {Function} [deps.writeDocument] - (poId, tx) => Promise<string>; must throw on failure
 * @param {Function} [deps.postAction] - (tx, result) => Promise<void>; runs inside the transaction
 * @param {Function} [deps.afterCommit] - (result) => Promise<void>; side effects, post-commit
 *
 * @returns {Promise<Object>} the approval engine result
 * @throws if the decision cannot be recorded or its document cannot be produced
 */
export async function executePoApprovalAtomically(
  { po_id, approval_instance_id, approval_instance_step_id, approver_user_id, action, comment = '' },
  { conn = db, writeDocument, postAction, afterCommit } = {}
) {
  if (!writeDocument) throw new Error('executePoApprovalAtomically requires a writeDocument dependency');

  const normalizedAction = String(action || '').toUpperCase();

  const result = await conn.tx(async (t) => {
    // 1. Record the decision on THIS transaction.
    const actionResult = await submitApprovalAction(
      { approval_instance_id, approval_instance_step_id, approver_user_id, action: normalizedAction, comment },
      t
    );

    // 2. Rewrite the document.
    //
    // Runs on every approve, not only the terminal one — the approver table
    // inside the PDF lists every step, so an intermediate approval leaves it
    // wrong too.
    //
    // It also runs when the engine reports `already_completed`. That is the
    // approver who clicks Approve a second time because the first attempt
    // appeared to do nothing: no second decision is recorded, but the document
    // they were trying to produce gets written. It is the one self-service
    // repair available for a PO whose document already went stale.
    //
    // No try/catch. A document that cannot be produced must take the approval
    // down with it — that is the whole guarantee.
    if (normalizedAction === 'APPROVE') {
      await writeDocument(po_id, t);
    }

    // 3. Entity transition and lifecycle, still inside the transaction.
    if (postAction && (actionResult.instance_status === 'APPROVED' || actionResult.instance_status === 'REJECTED')) {
      await postAction(t, actionResult);
    }

    return actionResult;
  });

  // 4. COMMIT has happened. Only now does anything leave the building.
  //
  // Failures here are logged, not thrown: the approval is durable and correct,
  // and telling the approver their approval failed because an email bounced
  // would be a lie. This is the one place where carrying on is right.
  if (afterCommit) {
    try {
      await afterCommit(result);
    } catch (err) {
      logError('executePoApprovalAtomically: post-commit side effects failed', err);
    }
  }

  logger.info(
    { poId: po_id, approvalInstanceId: approval_instance_id, action: normalizedAction, outcome: result.instance_status },
    'PO approval committed with its document'
  );

  return result;
}
