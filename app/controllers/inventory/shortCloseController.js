// Short-close and reopen (spec §6.12). Gate: the PO initiate permissions
// (assertPoInitiateAccess inside the service). The response is the PO's
// receipt state plus its short-close log; notices go out after commit.

import db from '../../config/dbConn.js';
import { sendInventoryError } from '../../services/inventory/errors.js';
import {
  shortClose as shortCloseService,
  reopenShortClose as reopenShortCloseService,
  listShortCloses,
} from '../../services/inventory/shortCloseService.js';
import { notifyShortClose } from '../../services/inventory/notices/receivingNotices.js';

/**
 * Same keys as the GET deliveries payload carries for these facts.
 * TODO(wave-B merge): answer with B2's getDeliveries(t, user, poId) instead.
 */
const payload = (out, shortCloses) => ({
  poId: out.poId,
  receiptStatus: out.receiptStatus,
  poLines: out.poLines,
  shortCloses,
});

const activityDetail = (out, metadata) => ({
  scope: {
    hospitalityCompanyId: out.companyId,
    hotelId: out.hotelIds?.length === 1 ? out.hotelIds[0] : null,
    entityLabel: out.poNumber,
  },
  metadata,
});

/** Run a short-close service call and read the log back, in one transaction. */
const runWithLog = (fn) =>
  db.tx(async (t) => {
    const out = await fn(t);
    return { out, shortCloses: await listShortCloses(t, out.poId) };
  });

/** POST /inventory/po/:poId/short-close */
export const shortClosePo = async (req, res) => {
  let result;
  try {
    result = await runWithLog((t) => shortCloseService(t, req.user, req.params.poId, req.body ?? {}));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { out, shortCloses } = result;
  res.locals.activityDetail = activityDetail(out, {
    reason_code: req.body?.reasonCode ?? null,
    target: req.body?.target?.type ?? null,
    short_close_ids: out.shortCloseIds,
    closed: out.closed,
    call_off_give_back: out.callOffGiveBack,
  });
  notifyShortClose(db, { poId: out.poId, shortCloseIds: out.shortCloseIds });
  return res.status(200).json({ status: 1, message: 'Short-closed', data: payload(out, shortCloses) });
};

/** POST /inventory/po/:poId/short-close/reopen */
export const reopenShortClose = async (req, res) => {
  let result;
  try {
    result = await runWithLog((t) => reopenShortCloseService(t, req.user, req.params.poId, req.body ?? {}));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { out, shortCloses } = result;
  res.locals.activityDetail = activityDetail(out, {
    short_close_ids: out.shortCloseIds,
    reopened: out.reopened,
    call_off_reconsume: out.callOffReconsume,
  });
  notifyShortClose(db, { poId: out.poId, shortCloseIds: out.shortCloseIds });
  return res.status(200).json({ status: 1, message: 'Reopened', data: payload(out, shortCloses) });
};
