// Approval notices (Task C3, spec §10): an adjustment waiting for approval or
// a submitted stock count goes to everyone who can approve inventory at its
// hotel (inventory.approve via a role scope covering the hotel; active buyer
// users, super admins left out), except the person who raised it.
//
// In-app only: category 'inventory', type APPROVAL_NEEDED_TYPE, additional
// data {kind, hotelId, adjustmentId | countId, number}.
//
// Call AFTER the transaction commits, with `db` (or a test's transaction).
// Never throws; each call is tracked so tests can wait with
// drainApprovalNotices().

import db from '../../../config/dbConn.js';
import { logError } from '../../../helper/common.js';
import { dispatch } from '../../notificationService.js';
import { inventoryAdjustment, inventoryCount } from '../../notificationLinks.js';
import { approverIds } from '../stockCommon.js';

export const APPROVAL_NEEDED_TYPE = 'inventory_approval_needed';

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const inr = (v) =>
  `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const REASON_LABELS = Object.freeze({
  WASTAGE: 'Wastage',
  BREAKAGE: 'Breakage',
  EXPIRY: 'Expiry',
  THEFT_LOSS: 'Theft / loss',
  CORRECTION: 'Correction',
  FOUND: 'Found',
  OPENING: 'Opening stock',
});

/** (conn, args) with conn optional: notify(t, args), notify(null, args), notify(args). */
function normalize(conn, args) {
  if (conn && typeof conn.oneOrNone === 'function') return [conn, args ?? {}];
  if (args === undefined && conn && typeof conn === 'object') return [db, conn];
  return [db, args ?? {}];
}

const inFlight = new Set();

function track(label, fn) {
  const p = (async () => {
    try {
      await fn();
    } catch (err) {
      logError(`approvalNotices.${label} failed`, err);
    }
  })();
  inFlight.add(p);
  p.then(() => inFlight.delete(p));
  return p;
}

/** Resolves once every notice started so far has settled. Tests only. */
export async function drainApprovalNotices() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

async function adjustmentNotice(conn, id) {
  const row = await conn.oneOrNone(
    `SELECT a.id, a.adjustment_number, a.hotel_id, h.name AS hotel_name, a.reason_code, a.status, a.created_by,
            u.name AS created_by_name,
            (SELECT count(*) FROM tbl_inv_adjustment_line l WHERE l.adjustment_id = a.id) AS line_count,
            (SELECT COALESCE(sum(abs(l.qty * COALESCE(b.avg_cost, 0))), 0)
               FROM tbl_inv_adjustment_line l
               LEFT JOIN tbl_inv_balance b ON b.hotel_id = a.hotel_id AND b.inv_item_id = l.inv_item_id
              WHERE l.adjustment_id = a.id)::text AS value
       FROM tbl_inv_adjustment a
       JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
       LEFT JOIN tbl_users u ON u.id = a.created_by
      WHERE a.id = $1`,
    [id]
  );
  if (!row || row.status !== 'pending_approval') return null;
  const number = row.adjustment_number ?? `#${row.id}`;
  const lines = Number(row.line_count);
  return {
    hotelId: Number(row.hotel_id),
    raisedBy: row.created_by == null ? null : Number(row.created_by),
    title: `Stock adjustment ${number} needs your approval`,
    body: `${REASON_LABELS[row.reason_code] ?? row.reason_code} at ${row.hotel_name}: ${lines} line${lines === 1 ? '' : 's'}, ${inr(row.value)}${row.created_by_name ? `, raised by ${row.created_by_name}` : ''}.`,
    data: { kind: 'adjustment', adjustmentId: Number(row.id), hotelId: Number(row.hotel_id), number: row.adjustment_number },
    actionUrl: inventoryAdjustment(Number(row.id)),
  };
}

async function countNotice(conn, id) {
  const row = await conn.oneOrNone(
    `SELECT c.id, c.count_number, c.hotel_id, h.name AS hotel_name, c.scope, c.status, c.created_by,
            (SELECT count(*) FROM tbl_inv_count_line l WHERE l.count_id = c.id AND l.counted_qty IS NOT NULL) AS counted,
            (SELECT count(*) FROM tbl_inv_count_line l
              WHERE l.count_id = c.id AND COALESCE(l.variance_qty, 0) <> 0) AS variances
       FROM tbl_inv_count c
       JOIN tbl_hospitality_company_hotels h ON h.id = c.hotel_id
      WHERE c.id = $1`,
    [id]
  );
  if (!row || row.status !== 'submitted') return null;
  const number = row.count_number ?? `#${row.id}`;
  const counted = Number(row.counted);
  const variances = Number(row.variances);
  return {
    hotelId: Number(row.hotel_id),
    raisedBy: row.created_by == null ? null : Number(row.created_by),
    title: `Stock count ${number} is ready for approval`,
    body: `${row.scope === 'FULL' ? 'Full count' : 'Spot count'} at ${row.hotel_name}: ${counted} item${counted === 1 ? '' : 's'} counted, ${variances} with a variance.`,
    data: { kind: 'count', countId: Number(row.id), hotelId: Number(row.hotel_id), number: row.count_number },
    actionUrl: inventoryCount(Number(row.id)),
  };
}

/**
 * An adjustment is pending approval, or a count was submitted: tell the
 * hotel's inventory approvers, not the actor (the creator for an adjustment,
 * the submitter for a count; defaults to the document's creator).
 *
 * @param {object} [t] connection (db after commit, or a test transaction)
 * @param {{kind:'adjustment'|'count', id:number, actorUserId?:number}} args
 * @returns {Promise<void>} never rejects
 */
export function notifyApprovalNeeded(t, args) {
  const [conn, { kind, id, actorUserId } = {}] = normalize(t, args);
  return track('notifyApprovalNeeded', async () => {
    const docId = positiveInt(id);
    if (!docId) return;
    let notice = null;
    if (kind === 'adjustment') notice = await adjustmentNotice(conn, docId);
    else if (kind === 'count') notice = await countNotice(conn, docId);
    if (!notice) return;
    const actor = positiveInt(actorUserId) ?? notice.raisedBy;
    const userIds = (await approverIds(conn, notice.hotelId)).filter((u) => u !== actor);
    if (!userIds.length) return;
    await dispatch({
      userIds,
      senderUserId: actor,
      category: 'inventory',
      type: APPROVAL_NEEDED_TYPE,
      title: notice.title,
      body: notice.body,
      data: notice.data,
      actionUrl: notice.actionUrl,
    });
  });
}
