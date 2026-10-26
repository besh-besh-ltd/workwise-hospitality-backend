// Short-close and reopen (spec §6.12). Gate: the PO initiate permissions
// (assertPoInitiateAccess inside the service). The response is the PO's
// Deliveries payload (same as GET /po/:poId/deliveries); notices go out after commit.

import db from '../../config/dbConn.js';
import { sendInventoryError } from '../../services/inventory/errors.js';
import {
  shortClose as shortCloseService,
  reopenShortClose as reopenShortCloseService,
} from '../../services/inventory/shortCloseService.js';
import { getDeliveries } from '../../services/inventory/planService.js';
import { notifyShortClose } from '../../services/inventory/notices/receivingNotices.js';
import { notifyArcEvent } from '../../services/arcNotificationService.js';
import { ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';

const activityDetail = (out, metadata) => ({
  scope: {
    hospitalityCompanyId: out.companyId,
    hotelId: out.hotelIds?.length === 1 ? out.hotelIds[0] : null,
    entityLabel: out.poNumber,
  },
  metadata,
});

/** Run a short-close service call and answer with the PO's Deliveries payload, in one transaction. */
const runWithDeliveries = (user, fn) =>
  db.tx(async (t) => {
    const out = await fn(t);
    return { out, deliveries: await getDeliveries(t, user, out.poId) };
  });

/** POST /inventory/po/:poId/short-close */
export const shortClosePo = async (req, res) => {
  let result;
  try {
    result = await runWithDeliveries(req.user, (t) => shortCloseService(t, req.user, req.params.poId, req.body ?? {}));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { out, deliveries } = result;
  res.locals.activityDetail = activityDetail(out, {
    reason_code: req.body?.reasonCode ?? null,
    target: req.body?.target?.type ?? null,
    short_close_ids: out.shortCloseIds,
    closed: out.closed,
    call_off_give_back: out.callOffGiveBack,
  });
  notifyShortClose(db, { poId: out.poId, shortCloseIds: out.shortCloseIds });
  return res.status(200).json({ status: 1, message: 'Short-closed', data: deliveries });
};

/** POST /inventory/po/:poId/short-close/reopen */
export const reopenShortClose = async (req, res) => {
  let result;
  try {
    result = await runWithDeliveries(req.user, (t) => reopenShortCloseService(t, req.user, req.params.poId, req.body ?? {}));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { out, deliveries } = result;
  res.locals.activityDetail = activityDetail(out, {
    short_close_ids: out.shortCloseIds,
    reopened: out.reopened,
    call_off_reconsume: out.callOffReconsume,
    call_off_over_share: out.callOffOverShare,
  });
  notifyShortClose(db, { poId: out.poId, shortCloseIds: out.shortCloseIds });
  // Group rate contract: tell head office when the reopen took a hotel past
  // its share, as the call-off release does (mrController, after commit).
  for (const { arcId, payload: entry } of out.callOffOverShare || []) {
    notifyArcEvent({
      arcId, eventType: ARC_EVENT_TYPES.CALL_OFF_OVER_HOTEL_SHARE, actorId: req.user?.id ?? null, payload: entry,
    }).catch(() => {});
  }
  return res.status(200).json({ status: 1, message: 'Reopened', data: deliveries });
};
