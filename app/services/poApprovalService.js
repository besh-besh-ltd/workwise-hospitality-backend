import db from '../config/dbConn.js';
import { submitApprovalAction, recordLifecycleEvent } from '../models/generalModel.js';
import { logger } from '../util/logger.js';
import { logError } from '../helper/common.js';
import { REASON_CODES, CANCEL_REASONS, REJECTION_ROUTES } from './po/poSendBackReasons.js';
import { notifyPoRejected } from './po/poRejectionNotifier.js';

/**
 * LOCK ORDER — every PO decision, on every surface.
 *
 * PO row FOR UPDATE first, then the approval instance FOR UPDATE (taken by
 * submitApprovalAction). Editing a pending PO (handleUpdatePO) and initiating
 * one (initiatePurchaseOrder) already lock in that order. A decision that
 * locked the instance first and then wrote the PO row (the approve post-action,
 * the reject status flip) deadlocked against an edit of the same PO: each held
 * the lock the other needed and Postgres killed one with 40P01. Pinned by
 * tests/services/po.decision.lockOrder.test.js.
 */
const lockPo = (t, poId) =>
  t.oneOrNone(
    `SELECT id, approval_instance_id, status::text AS status, rfq_id, finalized_vendor_id,
            rfq_product_id, po_number, initiated_by
       FROM tbl_rfq_purchase_order
      WHERE id = $1
      FOR UPDATE`,
    [poId]
  );

/** A refused PO decision, carrying the HTTP status and error code to answer with. */
export class PoDecisionError extends Error {
  constructor(message, { code, httpStatus = 400 } = {}) {
    super(message);
    this.name = 'PoDecisionError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * The reason and route a rejection request asks for, with the defaults an old
 * client relies on. Throws PoDecisionError (400) for anything refused.
 *
 *   reason absent        -> OTHER
 *   route absent         -> CANCEL for NOT_REQUIRED, otherwise COMMERCIAL
 *   route TECHNICAL      -> ROUTE_NOT_AVAILABLE (reserved, not built)
 *   CANCEL + any reason other than NOT_REQUIRED / OTHER -> INVALID_REASON
 *
 * @returns {{reasonCategory: string, route: 'COMMERCIAL'|'CANCEL'}}
 */
export function resolveRejectionRoute({ reason_category, route } = {}) {
  const reason = reason_category == null || reason_category === '' ? 'OTHER' : String(reason_category);
  if (!REASON_CODES.includes(reason)) {
    throw new PoDecisionError('Choose one of the listed reasons.', { code: 'INVALID_REASON' });
  }
  const taken = route == null || route === ''
    ? (reason === 'NOT_REQUIRED' ? 'CANCEL' : 'COMMERCIAL')
    : String(route);
  if (!REJECTION_ROUTES.includes(taken)) {
    throw new PoDecisionError(
      taken === 'TECHNICAL'
        ? 'Sending a PO back to technical evaluation is not available yet.'
        : 'A PO can be rejected for re-award or cancelled as not needed.',
      { code: 'ROUTE_NOT_AVAILABLE' }
    );
  }
  if (taken === 'CANCEL' && !CANCEL_REASONS.includes(reason)) {
    throw new PoDecisionError(
      'Cancelling a PO needs the reason "Not needed any more" or "Something else".',
      { code: 'INVALID_REASON' }
    );
  }
  return { reasonCategory: reason, route: taken };
}

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
    // 0. Lock order: the PO row before the approval instance (see lockPo).
    await lockPo(t, po_id);

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

/**
 * A PO rejection as one unit, on the caller's transaction.
 *
 * In order, all on `t`:
 *   0. lock the PO row (then submitApprovalAction locks the instance)
 *   1. the decision (REJECT)
 *   2. PO status 'rejected', or 'cancelled' for the CANCEL route
 *   3. the vendor-scoped de-finalization (handlePORejectionByInstance)
 *   4. a CLOSED tbl_po_send_backs row recording route, reason and comment
 *   5. the PO lifecycle row
 *
 * Any failure throws and the caller's transaction rolls ALL of it back.
 * Nothing is sent from here; see rejectPurchaseOrder for the post-commit side.
 *
 * A decision the engine reports as already taken (the instance is no longer
 * PENDING, or this approver already rejected it) changes nothing and comes back
 * with `alreadyCompleted: true`.
 *
 * @param {Object} args
 * @param {number} args.poId
 * @param {{id:number}} args.user - req.user
 * @param {string} [args.comment]
 * @param {string} args.reasonCategory - one of REASON_CODES
 * @param {'COMMERCIAL'|'CANCEL'} args.route
 * @param {number} [args.approvalInstanceId] - the instance the caller acted on;
 *   refused unless it is the PO's current one
 * @param {number} [args.approvalInstanceStepId]
 * @param {Object} t - pg-promise transaction
 * @returns {Promise<{po:Object, sendBackId:number|null, result:Object, alreadyCompleted:boolean}>}
 */
export async function executePoRejectionAtomically(
  { poId, user, comment = '', reasonCategory, route, approvalInstanceId = null, approvalInstanceStepId = null },
  t
) {
  if (!t) throw new Error('executePoRejectionAtomically requires a transaction');
  if (!REJECTION_ROUTES.includes(route)) throw new Error(`Unsupported rejection route: ${route}`);
  if (!REASON_CODES.includes(reasonCategory)) throw new Error(`Unsupported reason: ${reasonCategory}`);

  const po = await lockPo(t, poId);
  if (!po) throw new PoDecisionError('Purchase order not found.', { code: 'PO_NOT_FOUND', httpStatus: 404 });
  // The instance acted on: the caller's (generic card) or the PO's current one
  // (PO page). A caller holding an instance the PO has since moved off (an
  // edit re-initiated it) is refused rather than allowed to reject the PO
  // through a superseded approval.
  if (approvalInstanceId && po.approval_instance_id && Number(approvalInstanceId) !== Number(po.approval_instance_id)) {
    throw new PoDecisionError(
      'This approval is no longer the one in progress for the purchase order. Refresh and try again.',
      { code: 'STEP_NOT_PENDING', httpStatus: 409 }
    );
  }
  const instanceId = Number(approvalInstanceId || po.approval_instance_id);
  if (!instanceId) {
    throw new PoDecisionError('This purchase order has no approval in progress.', { code: 'STEP_NOT_PENDING', httpStatus: 409 });
  }
  const text = comment == null ? '' : String(comment);

  // 1. The decision. Locks the instance (after the PO, above).
  const result = await submitApprovalAction(
    {
      approval_instance_id: instanceId,
      approval_instance_step_id: approvalInstanceStepId,
      approver_user_id: user.id,
      action: 'REJECT',
      comment: text,
    },
    t
  );
  if (result.already_completed) return { po, sendBackId: null, result, alreadyCompleted: true };
  if (result.instance_status !== 'REJECTED') {
    throw new Error(`PO ${poId}: REJECT left the approval ${result.instance_status}`);
  }

  // 2 + 3. Status and the vendor's de-finalization, on this transaction.
  const { handlePORejectionByInstance } = await import('../controllers/po/purchaseOrderController.js');
  const poStatus = route === 'CANCEL' ? 'cancelled' : 'rejected';
  await handlePORejectionByInstance(instanceId, user.id, { txContext: t, poStatus });

  // 4. The reason, as a closed send-back. Call-off POs have no RFQ and never
  // carry a PO approval instance, so this always has an rfq_id in practice.
  let sendBackId = null;
  if (po.rfq_id) {
    const step = await t.one(
      `SELECT a.approval_instance_step_id, s.step_order
         FROM tbl_approval_actions a
         JOIN tbl_approval_instance_steps s ON s.id = a.approval_instance_step_id
        WHERE a.approval_instance_id = $1 AND a.action = 'REJECT' AND a.approver_user_id = $2
        ORDER BY a.id DESC
        LIMIT 1`,
      [instanceId, user.id]
    );
    sendBackId = (await t.one(
      `INSERT INTO tbl_po_send_backs
         (purchase_order_id, rfq_id, approval_instance_id, approval_instance_step_id, step_order,
          route, reason_category, comment, requested_by, status, resolution, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CLOSED', $10, NOW())
       RETURNING id`,
      [
        po.id, po.rfq_id, instanceId, step.approval_instance_step_id, step.step_order,
        route, reasonCategory, text, user.id, route === 'CANCEL' ? 'CANCELLED' : 'REJECTED',
      ]
    )).id;
  }

  // 5. The PO's own lifecycle row (submitApprovalAction wrote the generic one).
  await recordLifecycleEvent({
    entity_type: 'PO',
    entity_id: po.id,
    stage: route === 'CANCEL' ? 'PO_CANCELLED' : 'PO_REJECTED',
    action: 'REJECT',
    performed_by: user.id,
    metadata: {
      rfq_id: po.rfq_id,
      po_number: po.po_number,
      approval_instance_id: instanceId,
      route,
      reason_category: reasonCategory,
      send_back_id: sendBackId,
    },
    remarks: text || null,
    txContext: t,
  });

  return { po: { ...po, status: poStatus }, sendBackId, result, alreadyCompleted: false };
}

/**
 * Reject a PO from any surface: validate the reason and route, run the
 * rejection in one transaction, and only after COMMIT tell the people who can
 * act. Both POST /po/approve/:po_id and the generic approval action call this,
 * so the two end in the same state.
 *
 * @param {Object} args
 * @param {number} args.poId
 * @param {{id:number}} args.user
 * @param {string} [args.comment]
 * @param {string} [args.reason_category] - as sent by the client
 * @param {string} [args.route] - as sent by the client
 * @param {number} [args.approvalInstanceId]
 * @param {number} [args.approvalInstanceStepId]
 * @param {Object} [deps]
 * @param {Object} [deps.conn]
 * @returns {Promise<{po, sendBackId, result, alreadyCompleted, route, reasonCategory}>}
 * @throws PoDecisionError for a refused request; anything else is a failure
 *   that rolled the whole rejection back
 */
export async function rejectPurchaseOrder(
  { poId, user, comment = '', reason_category, route, approvalInstanceId = null, approvalInstanceStepId = null },
  { conn = db } = {}
) {
  const decision = resolveRejectionRoute({ reason_category, route });

  const out = await conn.tx((t) =>
    executePoRejectionAtomically(
      {
        poId, user, comment, approvalInstanceId, approvalInstanceStepId,
        reasonCategory: decision.reasonCategory, route: decision.route,
      },
      t
    )
  );

  // COMMIT has happened. notifyPoRejected never throws.
  if (!out.alreadyCompleted) {
    void notifyPoRejected({
      poId: Number(poId),
      actorId: user.id,
      route: decision.route,
      reasonCategory: decision.reasonCategory,
      comment,
    });
  }

  logger.info(
    { poId, route: decision.route, reasonCategory: decision.reasonCategory, alreadyCompleted: out.alreadyCompleted },
    'PO rejection committed'
  );

  return { ...out, route: decision.route, reasonCategory: decision.reasonCategory };
}
