// HTTP for stock counts (task C3). The work is in
// app/services/inventory/countService.js.
//
// Every route is passportSignIn + noAcl([3]) (guards.js). Tenant scope comes
// from req.user and the count row inside the service, never from the body.
// Each handler runs its transaction to completion, THEN answers (no response
// inside a transaction: check:tx-response) and THEN notifies.
//
// Answers: success {status:1, message, data:Count}; refusals via
// sendInventoryError (HTTP 4xx {status, message, code, details}).

import db from '../../config/dbConn.js';
import { sendInventoryError, InventoryError } from '../../services/inventory/errors.js';
import { notifyApprovalNeeded } from '../../services/inventory/notifier.js';
import {
  startCount as startCountService,
  listCounts as listCountsService,
  getCount as getCountService,
  saveCountLines as saveCountLinesService,
  submitCount as submitCountService,
  approveCount as approveCountService,
  cancelCount as cancelCountService,
} from '../../services/inventory/countService.js';

const positiveId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const bodyOf = (req) => req.value?.body ?? req.body ?? {};

function countId(req) {
  const id = positiveId(req.params.id);
  if (!id) throw new InventoryError('NOT_FOUND', 'Count not found');
  return id;
}

/** Activity trail scope for a count. */
function activity(res, count, metadata) {
  if (!count) return;
  res.locals.activityDetail = {
    scope: { hospitalityCompanyId: count.companyId ?? null, hotelId: count.hotelId ?? null, entityLabel: count.countNumber ?? null },
    ...(metadata ? { metadata } : {}),
  };
}

/** POST /counts {hotelId, scope, isBlind, invItemIds}: 201. */
export const startCount = async (req, res) => {
  let data;
  try {
    data = await db.tx((t) => startCountService(t, req.user, bodyOf(req)));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  activity(res, data, { scope: data.scope, isBlind: data.isBlind, lineCount: data.summary?.lineCount ?? 0 });
  return res.status(201).json({ status: 1, message: 'Count started', data });
};

/** GET /counts?hotelId&status&page */
export const listCounts = async (req, res) => {
  try {
    const { hotelId, status, page } = req.query;
    const data = await db.task((t) => listCountsService(t, req.user, { hotelId, status, page }));
    return res.status(200).json({ status: 1, message: 'Counts', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** GET /counts/:id */
export const getCount = async (req, res) => {
  try {
    const id = countId(req);
    const data = await db.task((t) => getCountService(t, req.user, id));
    return res.status(200).json({ status: 1, message: 'Count', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/**
 * PUT /counts/:id/lines {lines:[{invItemId, countedQty, clientEventId}]}.
 * A save whose every line was already applied answers {replayed:true, no_op:true}.
 */
export const saveCountLines = async (req, res) => {
  let result;
  try {
    const id = countId(req);
    result = await db.tx((t) => saveCountLinesService(t, req.user, id, bodyOf(req).lines));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { count, replayed } = result;
  if (replayed) {
    return res.status(200).json({ status: 1, message: 'Already saved', data: { ...count, replayed: true, no_op: true } });
  }
  const lines = bodyOf(req).lines;
  activity(res, count, { lineCount: Array.isArray(lines) ? lines.length : 0 });
  return res.status(200).json({ status: 1, message: 'Counted quantities saved', data: count });
};

/** POST /counts/:id/submit: the hotel's approvers are told. */
export const submitCount = async (req, res) => {
  let data;
  try {
    const id = countId(req);
    data = await db.tx((t) => submitCountService(t, req.user, id));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  activity(res, data, { countedCount: data.summary?.countedCount ?? 0 });
  res.status(200).json({ status: 1, message: 'Count submitted for approval', data });
  await notifyApprovalNeeded(db, { kind: 'count', id: data.id, actorUserId: req.user?.id });
  return undefined;
};

/** POST /counts/:id/approve {reasons:{[lineId]: text}}: posts the differences. */
export const approveCount = async (req, res) => {
  let data;
  try {
    const id = countId(req);
    data = await db.tx((t) => approveCountService(t, req.user, id, bodyOf(req).reasons ?? {}));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  activity(res, data, { varianceLines: data.summary?.varianceLines ?? 0, varianceValue: data.summary?.varianceValue ?? 0 });
  return res.status(200).json({ status: 1, message: 'Count approved and posted', data });
};

/** POST /counts/:id/cancel */
export const cancelCount = async (req, res) => {
  let data;
  try {
    const id = countId(req);
    data = await db.tx((t) => cancelCountService(t, req.user, id));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  activity(res, data);
  return res.status(200).json({ status: 1, message: 'Count cancelled', data });
};
