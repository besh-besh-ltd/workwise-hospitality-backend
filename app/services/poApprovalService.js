import db from '../config/dbConn.js';
import { submitApprovalAction } from '../models/generalModel.js';
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
 * The approval instance a PO decision acts on, locked FOR UPDATE after the PO
 * row (lock order). It must BE the PO's current one: the caller's instance
 * (generic card) or, absent one, the PO's link (PO page). A PO with no approval
 * linked, or one that has moved on to another instance (an edit re-initiated
 * it), is refused 409 INSTANCE_NOT_CURRENT rather than decided through a
 * superseded approval. submitApprovalAction re-takes the same row lock later,
 * a no-op inside one transaction.
 *
 * @returns {Promise<{id:number, status:string}>}
 */
async function lockCurrentPoInstance(t, po, approvalInstanceId) {
  const notCurrent = () => new PoDecisionError(
    'This approval is no longer the one in progress for the purchase order. Refresh to see where it stands.',
    { code: 'INSTANCE_NOT_CURRENT', httpStatus: 409 }
  );
  const instanceId = approvalInstanceId == null ? Number(po.approval_instance_id) : Number(approvalInstanceId);
  if (po.approval_instance_id == null || !Number.isInteger(instanceId) || instanceId !== Number(po.approval_instance_id)) {
    throw notCurrent();
  }
  const instance = await t.oneOrNone(
    `SELECT id, status FROM tbl_approval_instances WHERE id = $1 AND entity_type = 'PO' FOR UPDATE`,
    [instanceId]
  );
  if (!instance) throw notCurrent();
  return { id: Number(instance.id), status: instance.status };
}

/** 409 STEP_NOT_PENDING: the approval already concluded, so this decision was not recorded. */
const decisionNotRecorded = (instance, noun) => new PoDecisionError(
  `This purchase order's approval is already ${String(instance.status).toLowerCase()}, so your ${noun} was not recorded. Refresh to see where it stands.`,
  { code: 'STEP_NOT_PENDING', httpStatus: 409 }
);

/** 409 PO_NOT_PENDING_APPROVAL: the PO itself is no longer waiting for approval. */
const poNotPendingApproval = (po, verb) => new PoDecisionError(
  `This purchase order is ${String(po.status).replace(/_/g, ' ')}, not waiting for approval, so it cannot be ${verb}. Refresh to see where it stands.`,
  { code: 'PO_NOT_PENDING_APPROVAL', httpStatus: 409 }
);

/** Whether this approver has an APPROVE recorded on this instance. */
const hasOwnApproval = async (t, instanceId, userId) =>
  !!(await t.oneOrNone(
    `SELECT 1 FROM tbl_approval_actions
      WHERE approval_instance_id = $1 AND approver_user_id = $2 AND action = 'APPROVE'
      LIMIT 1`,
    [instanceId, userId]
  ));

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
 *   0. lock the PO, then the instance, and refuse (409) unless the instance is
 *      the PO's current one (INSTANCE_NOT_CURRENT), still PENDING
 *      (STEP_NOT_PENDING) and the PO is pending_approval
 *      (PO_NOT_PENDING_APPROVAL). The one exception: this approver's own
 *      APPROVE retried on an APPROVED instance answers `already_completed`
 *      and runs nothing below, not even step 5.
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
 * @throws PoDecisionError (409) for a refused decision, see step 0
 * @throws if the decision cannot be recorded or its document cannot be produced
 */
export async function executePoApprovalAtomically(
  { po_id, approval_instance_id, approval_instance_step_id, approver_user_id, action, comment = '' },
  { conn = db, writeDocument, postAction, afterCommit } = {}
) {
  if (!writeDocument) throw new Error('executePoApprovalAtomically requires a writeDocument dependency');

  const normalizedAction = String(action || '').toUpperCase();

  const result = await conn.tx(async (t) => {
    // 0. Lock order: the PO row, then the approval instance (see lockPo), and
    //    the same guards as a rejection (R25). Before them, an APPROVE on an
    //    instance that had already concluded came back from the engine as
    //    `already_completed` and still ran steps 2 and 3: on a REJECTED or
    //    CANCELLED instance it rewrote the document of a dead PO and answered
    //    200 ("approved" in the trail); on an APPROVED one (a late ANY
    //    approver, a double-click) it re-ran the post-action, which put an
    //    accepted, dispatched or received PO back to acceptance_pending and
    //    emailed the vendor again.
    const po = await lockPo(t, po_id);
    if (!po) throw new PoDecisionError('Purchase order not found.', { code: 'PO_NOT_FOUND', httpStatus: 404 });
    const instance = await lockCurrentPoInstance(t, po, approval_instance_id);
    const noun = normalizedAction === 'APPROVE' ? 'approval' : 'rejection';
    if (instance.status !== 'PENDING') {
      // The one concluded instance that answers success: an APPROVED one this
      // approver approved (double-click, refresh). Nothing runs.
      if (normalizedAction === 'APPROVE' && instance.status === 'APPROVED'
          && await hasOwnApproval(t, instance.id, approver_user_id)) {
        return {
          status: 'APPROVED',
          instance_status: 'APPROVED',
          message: 'Already approved, no action taken',
          already_completed: true,
        };
      }
      throw decisionNotRecorded(instance, noun);
    }
    if (po.status !== 'pending_approval') {
      throw poNotPendingApproval(po, normalizedAction === 'APPROVE' ? 'approved' : 'rejected');
    }

    // 1. Record the decision on THIS transaction.
    const actionResult = await submitApprovalAction(
      { approval_instance_id: instance.id, approval_instance_step_id, approver_user_id, action: normalizedAction, comment },
      t
    );

    // The instance is PENDING and locked, so the engine's instance-level
    // `already_completed` cannot happen here. Its approver-level repeat check
    // compares the approver row's status ('APPROVED') with the action
    // ('APPROVE') and never matches, so a same-user repeat on a still-PENDING
    // ALL step is refused by the engine ("User has already acted on this step
    // with status: APPROVED"), the transaction rolls back, and nothing runs
    // twice. Kept as a guard: if the engine ever does answer
    // `already_completed` here, nothing new was decided, so neither the
    // document nor the post-action runs.
    if (actionResult.already_completed) return actionResult;

    // 2. Rewrite the document.
    //
    // Runs on every approve that records a decision, not only the terminal
    // one: the approver table inside the PDF lists every step, so an
    // intermediate approval leaves it wrong too. A retry that records nothing
    // (above) no longer rewrites it (R25).
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

  // 4. COMMIT has happened. Only now does anything leave the building, and
  //    only for a decision that was recorded now: a retry announces nothing.
  //
  // Failures here are logged, not thrown: the approval is durable and correct,
  // and telling the approver their approval failed because an email bounced
  // would be a lie. This is the one place where carrying on is right.
  if (afterCommit && !result.already_completed) {
    try {
      await afterCommit(result);
    } catch (err) {
      logError('executePoApprovalAtomically: post-commit side effects failed', err);
    }
  }

  logger.info(
    { poId: po_id, approvalInstanceId: approval_instance_id, action: normalizedAction, outcome: result.instance_status, alreadyCompleted: !!result.already_completed },
    result.already_completed ? 'PO approval retry: nothing recorded' : 'PO approval committed with its document'
  );

  return result;
}

/**
 * This approver's own, already-committed rejection of this instance, or null.
 * What stands is read back from the send-back the rejection wrote (route and
 * reason), so a retry reports the original outcome, not the retry's request.
 */
async function ownRejection(t, { poId, instanceId, userId }) {
  const row = await t.oneOrNone(
    `SELECT a.id AS action_id,
            sb.id AS send_back_id, sb.route, sb.reason_category
       FROM tbl_approval_actions a
       LEFT JOIN LATERAL (
         SELECT s.id, s.route, s.reason_category
           FROM tbl_po_send_backs s
          WHERE s.purchase_order_id = $1 AND s.approval_instance_id = $2
            AND s.requested_by = $3 AND s.route <> 'INFO_REQUEST'
          ORDER BY s.id DESC LIMIT 1
       ) sb ON TRUE
      WHERE a.approval_instance_id = $2 AND a.approver_user_id = $3 AND a.action = 'REJECT'
      ORDER BY a.id DESC LIMIT 1`,
    [poId, instanceId, userId]
  );
  if (!row) return null;
  return {
    send_back_id: row.send_back_id ?? null,
    route: row.route ?? null,
    reason_category: row.reason_category ?? null,
    result: {
      status: 'REJECTED',
      instance_status: 'REJECTED',
      message: 'Already rejected, no action taken',
      already_completed: true,
    },
  };
}

/**
 * A PO rejection as one unit, on the caller's transaction.
 *
 * In order, all on `t`:
 *   0. lock the PO row, then the approval instance; refuse (409) unless the
 *      instance is the PO's current one (INSTANCE_NOT_CURRENT), still PENDING
 *      (STEP_NOT_PENDING) and the PO is pending_approval
 *      (PO_NOT_PENDING_APPROVAL)
 *   1. the decision (REJECT)
 *   2. PO status 'rejected', or 'cancelled' for the CANCEL route
 *   3. the vendor-scoped de-finalization (handlePORejectionByInstance)
 *   4. a CLOSED tbl_po_send_backs row recording route, reason and comment
 *      (with the REJECT lifecycle row from step 1, the whole record)
 *
 * Any failure throws and the caller's transaction rolls ALL of it back.
 * Nothing is sent from here; see rejectPurchaseOrder for the post-commit side.
 *
 * The only non-PENDING instance that answers success is this approver's own
 * earlier rejection of it (a retry): nothing changes, and it comes back with
 * `alreadyCompleted: true` and `standing` = the route and reason that stand.
 * Every other concluded instance (approved first by someone else, cancelled)
 * is a PoDecisionError 409 STEP_NOT_PENDING.
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
 * @returns {Promise<{po:Object, sendBackId:number|null, result:Object, alreadyCompleted:boolean, standing?:Object}>}
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
  const instance = await lockCurrentPoInstance(t, po, approvalInstanceId);
  const instanceId = instance.id;
  if (instance.status !== 'PENDING') {
    // A retry of this approver's own rejection (double-click, refresh) is the
    // one case that answers success: nothing changes and what stands is
    // reported back. Anything else (another approver approved first, the
    // approval was cancelled) is a refusal; answering 200 there told the
    // approver, and the activity trail, that a PO now approved was rejected.
    const own = instance.status === 'REJECTED'
      ? await ownRejection(t, { poId: po.id, instanceId, userId: user.id })
      : null;
    if (own) return { po, sendBackId: own.send_back_id, result: own.result, alreadyCompleted: true, standing: own };
    throw decisionNotRecorded(instance, 'rejection');
  }
  if (po.status !== 'pending_approval') throw poNotPendingApproval(po, 'rejected');
  const text = comment == null ? '' : String(comment);

  // 1. The decision, on the instance locked above.
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
  // The instance is PENDING and locked, so the engine cannot report it
  // concluded; its approver-level "already submitted" is the only way here,
  // and it is not a rejection that happened now.
  if (result.already_completed) {
    throw new PoDecisionError(
      `${result.message || 'This decision was already recorded'}. Refresh to see where it stands.`,
      { code: 'STEP_NOT_PENDING', httpStatus: 409 }
    );
  }
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

  // No second lifecycle row (ruling R21): submitApprovalAction already wrote
  // the REJECT row (stage 'REJECTED') on this transaction, and the send-back
  // above holds route, reason and comment. A PO-specific row as well would be
  // counted twice by the activity backfill, which maps every lifecycle row to
  // an event.

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

  // A retry reports what stands (the first rejection's route and reason), not
  // what the retry asked for.
  const route_ = out.alreadyCompleted ? (out.standing?.route || decision.route) : decision.route;
  const reason_ = out.alreadyCompleted ? (out.standing?.reason_category || decision.reasonCategory) : decision.reasonCategory;

  logger.info(
    { poId, route: route_, reasonCategory: reason_, alreadyCompleted: out.alreadyCompleted },
    out.alreadyCompleted ? 'PO rejection retry: already rejected by this approver' : 'PO rejection committed'
  );

  return { ...out, route: route_, reasonCategory: reason_ };
}
