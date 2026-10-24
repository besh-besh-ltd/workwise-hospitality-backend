// HTTP for stock (task C3): the stock list, item card and ledger, mark out /
// return to stock, adjustments and the inventory overview. The work is in
// app/services/inventory/{stockQueries,outService,adjustmentService}.js.
//
// Every route is passportSignIn + noAcl([3]) (guards.js). Tenant scope comes
// from req.user and the hotel / document row inside the service, never from
// the body. Each handler runs its transaction to completion, THEN answers (no
// response inside a transaction: check:tx-response) and THEN notifies.
//
// Answers: success {status:1, message, data}; refusals via sendInventoryError
// (HTTP 4xx {status, message, code, details}). A replayed clientEventId
// answers 200 with the original document plus {replayed:true, no_op:true}
// (no_op: the activity trail records nothing for it).

import db from '../../config/dbConn.js';
import { sendInventoryError, InventoryError } from '../../services/inventory/errors.js';
import { notifyApprovalNeeded } from '../../services/inventory/notifier.js';
import {
  getStock as stockList,
  getStockItem as stockItem,
  getLedger,
  getOverview,
} from '../../services/inventory/stockQueries.js';
import {
  postOut as postOutService,
  listOut as listOutService,
  getOut as getOutService,
  replayOut,
} from '../../services/inventory/outService.js';
import {
  createAdjustment as createAdjustmentService,
  listAdjustments as listAdjustmentsService,
  getAdjustment as getAdjustmentService,
  approveAdjustment as approveAdjustmentService,
  rejectAdjustment as rejectAdjustmentService,
  replayAdjustment,
} from '../../services/inventory/adjustmentService.js';

const positiveId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const bodyOf = (req) => req.value?.body ?? req.body ?? {};

/** A unique violation on a client_event_id index: a concurrent request with the same key won. */
const isRace = (err, constraint) => err?.code === '23505' && err?.constraint === constraint;

/** Activity trail scope for a stock document. */
function activity(res, doc, entityLabel, metadata) {
  if (!doc) return;
  res.locals.activityDetail = {
    scope: { hospitalityCompanyId: doc.companyId ?? null, hotelId: doc.hotelId ?? null, entityLabel: entityLabel ?? null },
    ...(metadata ? { metadata } : {}),
  };
}

/** Replays carry the original document, flagged so the trail skips them. */
const replayData = (doc) => ({ ...doc, replayed: true, no_op: true });

/**
 * Run `work` in a transaction; on a client-event race, answer from the winner.
 * @returns {Promise<object>} the service result
 */
async function withReplay(work, constraint, replay) {
  try {
    return await db.tx(work);
  } catch (err) {
    if (!isRace(err, constraint)) throw err;
    const result = await db.task(replay);
    if (!result) throw err;
    return result;
  }
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/** GET /stock?hotelId&search&belowReorder&page */
export const getStock = async (req, res) => {
  try {
    const { hotelId, search, belowReorder, page } = req.query;
    const data = await db.task((t) => stockList(t, req.user, { hotelId, search, belowReorder, page }));
    return res.status(200).json({ status: 1, message: 'Stock', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** GET /stock/:hotelId/items/:invItemId */
export const getStockItem = async (req, res) => {
  try {
    const { hotelId, invItemId } = req.params;
    const data = await db.task((t) => stockItem(t, req.user, { hotelId, invItemId }));
    return res.status(200).json({ status: 1, message: 'Stock item', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** GET /stock/:hotelId/items/:invItemId/ledger?from&to&page */
export const getStockLedger = async (req, res) => {
  try {
    const { hotelId, invItemId } = req.params;
    const { from, to, page } = req.query;
    const data = await db.task((t) => getLedger(t, req.user, { hotelId, invItemId, from, to, page }));
    return res.status(200).json({ status: 1, message: 'Stock ledger', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** GET /overview?hotelId */
export const getInventoryOverview = async (req, res) => {
  try {
    const data = await db.task((t) => getOverview(t, req.user, { hotelId: req.query.hotelId }));
    return res.status(200).json({ status: 1, message: 'Inventory overview', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

// ---------------------------------------------------------------------------
// Mark out / return to stock
// ---------------------------------------------------------------------------

/** POST /out: 201 with the new document, 200 for a replayed clientEventId. */
export const postOut = async (req, res) => {
  const input = bodyOf(req);
  let result;
  try {
    result = await withReplay(
      (t) => postOutService(t, req.user, input),
      'ux_inv_out_client_event',
      (t) => replayOut(t, req.user, input.clientEventId)
    );
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { doc, replayed } = result;
  if (replayed) {
    return res.status(200).json({ status: 1, message: 'Already recorded', data: replayData(doc) });
  }
  activity(res, doc, doc.outNumber, { docType: doc.docType, lineCount: doc.lines.length, value: doc.totalValue });
  return res.status(201).json({
    status: 1,
    message: doc.docType === 'RETURN' ? 'Returned to stock' : 'Marked out',
    data: doc,
  });
};

/** GET /out?hotelId&departmentId&docType&from&to&page */
export const listOut = async (req, res) => {
  try {
    const { hotelId, departmentId, docType, from, to, page } = req.query;
    const data = await db.task((t) => listOutService(t, req.user, { hotelId, departmentId, docType, from, to, page }));
    return res.status(200).json({ status: 1, message: 'Mark-outs', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** GET /out/:id */
export const getOut = async (req, res) => {
  try {
    const id = positiveId(req.params.id);
    if (!id) throw new InventoryError('NOT_FOUND', 'Document not found');
    const data = await db.task((t) => getOutService(t, req.user, id));
    return res.status(200).json({ status: 1, message: 'Mark-out', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

/**
 * POST /adjustments: 201 with the adjustment ('posted' when under the
 * auto-approve limit, else 'pending_approval' and the approvers are told),
 * 200 for a replayed clientEventId.
 */
export const createAdjustment = async (req, res) => {
  const input = bodyOf(req);
  let result;
  try {
    result = await withReplay(
      (t) => createAdjustmentService(t, req.user, input),
      'ux_inv_adjustment_client_event',
      (t) => replayAdjustment(t, req.user, input.clientEventId)
    );
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { adjustment, replayed, needsApproval } = result;
  if (replayed) {
    return res.status(200).json({ status: 1, message: 'Already recorded', data: replayData(adjustment) });
  }
  activity(res, adjustment, adjustment.adjustmentNumber, {
    reasonCode: adjustment.reasonCode, status: adjustment.status, value: adjustment.value,
  });
  res.status(201).json({
    status: 1,
    message: adjustment.status === 'posted' ? 'Adjustment posted' : 'Adjustment sent for approval',
    data: adjustment,
  });
  if (needsApproval) await notifyApprovalNeeded(db, { kind: 'adjustment', id: adjustment.id, actorUserId: req.user?.id });
  return undefined;
};

/** GET /adjustments?hotelId&status&page */
export const listAdjustments = async (req, res) => {
  try {
    const { hotelId, status, page } = req.query;
    const data = await db.task((t) => listAdjustmentsService(t, req.user, { hotelId, status, page }));
    return res.status(200).json({ status: 1, message: 'Adjustments', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** GET /adjustments/:id */
export const getAdjustment = async (req, res) => {
  try {
    const id = positiveId(req.params.id);
    if (!id) throw new InventoryError('NOT_FOUND', 'Adjustment not found');
    const data = await db.task((t) => getAdjustmentService(t, req.user, id));
    return res.status(200).json({ status: 1, message: 'Adjustment', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** POST /adjustments/:id/approve */
export const approveAdjustment = async (req, res) => {
  let data;
  try {
    const id = positiveId(req.params.id);
    if (!id) throw new InventoryError('NOT_FOUND', 'Adjustment not found');
    data = await db.tx((t) => approveAdjustmentService(t, req.user, id));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  activity(res, data, data.adjustmentNumber, { reasonCode: data.reasonCode, value: data.value });
  return res.status(200).json({ status: 1, message: 'Adjustment approved and posted', data });
};

/** POST /adjustments/:id/reject {reason} */
export const rejectAdjustment = async (req, res) => {
  let data;
  try {
    const id = positiveId(req.params.id);
    if (!id) throw new InventoryError('NOT_FOUND', 'Adjustment not found');
    data = await db.tx((t) => rejectAdjustmentService(t, req.user, id, bodyOf(req).reason));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  activity(res, data, data.adjustmentNumber, { reasonCode: data.reasonCode, rejectionReason: data.rejectionReason });
  return res.status(200).json({ status: 1, message: 'Adjustment rejected', data });
};
