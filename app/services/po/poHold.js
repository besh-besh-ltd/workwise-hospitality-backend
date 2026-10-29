// "On hold" for a purchase order: an OPEN row in tbl_po_send_backs.
//
// There is no hold status on the PO or on its approval. The approval instance
// stays PENDING at the same step, and a PO counts as held exactly while an
// OPEN send-back exists for it (at most one: ux_po_send_back_one_open). Every
// reader asks the same question through the helpers below, so the approve and
// reject guards, the pending-for-me counts and the lists cannot disagree.

import { PoDecisionError } from './poDecisionError.js';
import { notifySendBackClosed } from './poSendBackNotifier.js';
import { notifyApprovalChanged } from '../approvalEvents.js';

/**
 * The PO's OPEN send-back with the name of the person it waits on, or null.
 * Read on the caller's connection; the decision paths call it while holding
 * the PO row and its approval instance FOR UPDATE, and every path that opens
 * or closes a hold takes the PO lock first, so the answer cannot go stale
 * before the caller's transaction ends.
 */
export async function findOpenHold(t, poId) {
  return t.oneOrNone(
    `SELECT sb.id, sb.target_user_id, u.name AS target_name
       FROM tbl_po_send_backs sb
       LEFT JOIN tbl_users u ON u.id = sb.target_user_id
      WHERE sb.purchase_order_id = $1 AND sb.status = 'OPEN'
      ORDER BY sb.id DESC
      LIMIT 1`,
    [poId]
  );
}

/** 409 PO_ON_HOLD: the step is frozen until the named person answers or the request is withdrawn. */
export const poOnHoldError = (hold) =>
  new PoDecisionError(`Waiting on ${hold?.target_name || 'the person asked for information'}.`, {
    code: 'PO_ON_HOLD',
    httpStatus: 409,
  });

/** Throws PO_ON_HOLD when the PO has an OPEN send-back. */
export async function assertPoNotOnHold(t, poId) {
  const hold = await findOpenHold(t, poId);
  if (hold) throw poOnHoldError(hold);
}

/**
 * SQL: TRUE when the PO whose id is `poIdExpr` is on hold. For list and count
 * queries; `poIdExpr` is a column reference written by the caller, never input.
 */
export const poHeldSql = (poIdExpr) =>
  `EXISTS (SELECT 1 FROM tbl_po_send_backs sb_hold
            WHERE sb_hold.purchase_order_id = ${poIdExpr} AND sb_hold.status = 'OPEN')`;

/**
 * SQL: FALSE for a PO approval instance whose PO is on hold, TRUE for every
 * other instance (any entity type). `alias` is the tbl_approval_instances
 * alias in the caller's query. A held PO's approvers cannot decide it, so it
 * is not waiting on them.
 */
export const instanceNotHeldSql = (alias) =>
  `NOT (${alias}.entity_type = 'PO' AND ${poHeldSql(`${alias}.entity_id`)})`;

// ── Closing a hold the approval no longer needs ──────────────────────────────

/** How a hold ends when the approval it froze is ended or reshaped. */
const CLOSE_STATUSES = Object.freeze(['SUPERSEDED', 'CLOSED']);
const CLOSE_RESOLUTIONS = Object.freeze(['PO_AMENDED_RESTARTED', 'RFQ_CLOSED', 'PO_SUPERSEDED']);

/**
 * Close the PO's OPEN hold because the approval it froze is being ended or
 * reshaped by the caller's transaction. Writes NO approval action: the
 * caller's own record (CANCELLED, STEP_REMOVED, ...) is the event (R21).
 *
 * Call it inside the transaction that ends the approval, while holding the PO
 * row FOR UPDATE (taken before the approval instance). The person asked is
 * told after that transaction commits, never if it rolls back.
 *
 * @param {object} t        the transaction
 * @param {object} args
 * @param {number} args.poId
 * @param {'SUPERSEDED'|'CLOSED'} args.status
 * @param {'PO_AMENDED_RESTARTED'|'RFQ_CLOSED'|'PO_SUPERSEDED'} args.resolution
 * @param {number|null} [args.actorId] who caused it; not notified
 * @param {string|null} [args.note]    completes "was closed because ..." in the
 *                                     notification; defaults from the resolution
 * @returns {Promise<object|null>} the closed row, or null when nothing was open
 */
export async function closeOpenHoldTx(t, { poId, status, resolution, actorId = null, note = null }) {
  if (!CLOSE_STATUSES.includes(status)) throw new Error(`closeOpenHoldTx: invalid status ${status}`);
  if (!CLOSE_RESOLUTIONS.includes(resolution)) throw new Error(`closeOpenHoldTx: invalid resolution ${resolution}`);
  const row = await t.oneOrNone(
    `UPDATE tbl_po_send_backs
        SET status = $2, resolution = $3, closed_at = now()
      WHERE purchase_order_id = $1 AND status = 'OPEN'
  RETURNING id, purchase_order_id, approval_instance_id, approval_instance_step_id,
            target_user_id, requested_by, status, resolution, closed_at`,
    [poId, status, resolution]
  );
  if (!row) return null;
  // The person asked no longer has anything to answer, and the step's
  // approvers have a PO they can decide again (or none): refresh both.
  notifyApprovalChanged({ instanceIds: [row.approval_instance_id], extraUserIds: [row.target_user_id] }, t);
  void notifySendBackClosed({ sendBackId: Number(row.id), actorId, because: note }, t);
  return row;
}

/**
 * After a policy or membership change reshaped these approval instances:
 * close every OPEN hold whose step it ended or moved away from. A hold
 * survives only on a PENDING instance whose held step is still PENDING, is
 * still the current step and was not itself reshaped (`reshapedStepIds`).
 * SUPERSEDED / PO_SUPERSEDED, target told after commit.
 *
 * The caller holds the PO rows of these instances FOR UPDATE (taken before
 * the instance locks).
 *
 * @returns {Promise<object[]>} the closed rows
 */
export async function closeHoldsThatOutlivedTheirStep(t, instanceIds, actorId, { reshapedStepIds = [] } = {}) {
  const ids = [...new Set((instanceIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return [];
  const reshaped = [...new Set((reshapedStepIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const stale = await t.any(
    `SELECT sb.purchase_order_id
       FROM tbl_po_send_backs sb
       JOIN tbl_approval_instances ai ON ai.id = sb.approval_instance_id
       LEFT JOIN tbl_approval_instance_steps st ON st.id = sb.approval_instance_step_id
      WHERE sb.approval_instance_id = ANY($1::int[])
        AND sb.status = 'OPEN'
        AND (ai.status <> 'PENDING'
             OR st.id IS NULL
             OR st.status <> 'PENDING'
             OR st.step_order IS DISTINCT FROM ai.current_step
             OR st.id = ANY($2::int[]))
      ORDER BY sb.purchase_order_id`,
    [ids, reshaped]
  );
  const closed = [];
  for (const { purchase_order_id: poId } of stale) {
    const row = await closeOpenHoldTx(t, { poId, status: 'SUPERSEDED', resolution: 'PO_SUPERSEDED', actorId });
    if (row) closed.push(row);
  }
  return closed;
}

/**
 * Lock, in PO id order, the PO rows of the PO approval instances among
 * `instanceIds` (or of every PENDING PO instance of `policyId`). For the
 * propagation paths, which must take the PO lock BEFORE the instance lock,
 * like every PO decision does.
 */
export async function lockPosOfInstances(t, { instanceIds = null, policyId = null } = {}) {
  if (policyId != null) {
    await t.any(
      `SELECT po.id FROM tbl_rfq_purchase_order po
        WHERE po.id IN (SELECT ai.entity_id FROM tbl_approval_instances ai
                         WHERE ai.approval_policy_id = $1 AND ai.status = 'PENDING' AND ai.entity_type = 'PO')
        ORDER BY po.id
        FOR UPDATE OF po`,
      [policyId]
    );
    return;
  }
  const ids = [...new Set((instanceIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return;
  await t.any(
    `SELECT po.id FROM tbl_rfq_purchase_order po
      WHERE po.id IN (SELECT ai.entity_id FROM tbl_approval_instances ai
                       WHERE ai.id = ANY($1::int[]) AND ai.entity_type = 'PO')
      ORDER BY po.id
      FOR UPDATE OF po`,
    [ids]
  );
}

// ── Re-awarding a product whose PO is held ───────────────────────────────────

/** 409 PO_ON_HOLD for a re-award: it would cancel the held PO under its approver. */
export const heldPoReawardError = (poNumber) =>
  new PoDecisionError(`PO ${poNumber} is waiting for information. Withdraw the request first.`, {
    code: 'PO_ON_HOLD',
    httpStatus: 409,
  });

/**
 * Refuse a re-finalize / re-draft of an RFQ product that a held PO carries:
 * it would cancel that PO while an approver waits on an answer. With `lock`,
 * first takes every pending-approval PO carrying the product FOR UPDATE (PO id
 * order), so a hold cannot be opened between this check and the draft.
 */
export async function assertProductNotOnHeldPo(t, { rfqProductId, lock = false }) {
  const id = Number(rfqProductId);
  if (!Number.isInteger(id) || id <= 0) return;
  const carriers = `
    SELECT po.id, po.po_number
      FROM tbl_rfq_purchase_order po
     WHERE po.status = 'pending_approval'
       AND (EXISTS (SELECT 1 FROM tbl_purchase_order_product pop
                     WHERE pop.purchase_order_id = po.id AND pop.rfq_product_id = $1)
            OR $1 = ANY(COALESCE(po.rfq_product_id, '{}'::int[])))`;
  if (lock) await t.any(`${carriers} ORDER BY po.id FOR UPDATE OF po`, [id]);
  const held = await t.oneOrNone(
    `SELECT c.po_number FROM (${carriers}) c
      WHERE ${poHeldSql('c.id')}
      ORDER BY c.id
      LIMIT 1`,
    [id]
  );
  if (held) throw heldPoReawardError(held.po_number);
}
