// HTTP for reorder (Task D3, spec §9): the reorder worklist and "Create MR
// draft". The work is in app/services/inventory/reorderService.js.
//
// Routes are passportSignIn + noAcl([3]) (guards.js). The hotel and the MR's
// hotel / department are gated against req.user's own role scopes inside the
// service (never can()). Each handler finishes its transaction, THEN answers
// (check:tx-response).

import db from '../../config/dbConn.js';
import { sendInventoryError } from '../../services/inventory/errors.js';
import {
  getReorderList,
  createReorderMrDraft as createDraftService,
} from '../../services/inventory/reorderService.js';

const bodyOf = (req) => req.value?.body ?? req.body ?? {};

/** GET /reorder?hotelId: the worklist at one hotel (default: the caller's first). */
export const getReorder = async (req, res) => {
  try {
    const data = await db.task((t) => getReorderList(t, req.user, { hotelId: req.query.hotelId }));
    return res.status(200).json({ status: 1, message: 'Reorder list', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/**
 * POST /reorder/mr-draft {hotelId, departmentId, clientEventId?, items:[{invItemId, qty, arcContractLineId?}]}:
 * 201 {mrId, …, warnings}. A repeated clientEventId answers 200 with the first
 * draft (replayed, no_op) and records no second activity row.
 */
export const createReorderMrDraft = async (req, res) => {
  let data;
  try {
    data = await db.tx((t) => createDraftService(t, req.user, bodyOf(req)));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  if (data.replayed) return res.status(200).json({ status: 1, message: 'MR draft already created', data });
  res.locals.activityDetail = {
    scope: { hospitalityCompanyId: data.companyId, hotelId: data.hotelId, entityLabel: data.mrNumber },
    metadata: { departmentId: data.departmentId, itemCount: data.items.length },
  };
  return res.status(201).json({ status: 1, message: 'MR draft created', data });
};

export default { getReorder, createReorderMrDraft };
