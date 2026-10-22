// "On hold" for a purchase order: an OPEN row in tbl_po_send_backs.
//
// There is no hold status on the PO or on its approval. The approval instance
// stays PENDING at the same step, and a PO counts as held exactly while an
// OPEN send-back exists for it (at most one: ux_po_send_back_one_open). Every
// reader asks the same question through the helpers below, so the approve and
// reject guards, the pending-for-me counts and the lists cannot disagree.

import { PoDecisionError } from './poDecisionError.js';

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
