import db from '../../config/dbConn.js';
import { sendInventoryError } from '../../services/inventory/errors.js';
import {
  getVendorDeliveries,
  createDispatch as createDispatchNote,
  cancelDispatch as cancelDispatchNote,
  dispatchActivityScope,
} from '../../services/inventory/dispatchService.js';
import { notifyDispatchCreated } from '../../services/inventory/notices/planNotices.js';

// The vendor's Deliveries tab and dispatch notes (contract: "Vendor"). The
// routes admit vendors only (acl([3])); the services answer 404 for a PO that
// is not the caller's own (finalized_vendor_id = req.user.id).

/** GET /inventory/vendor/po/:poId/deliveries */
export const getVendorPoDeliveries = async (req, res) => {
  let data;
  try {
    data = await db.tx((t) => getVendorDeliveries(t, req.user, req.params.poId));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  return res.json({ status: 1, message: 'Deliveries', data });
};

/**
 * POST /inventory/vendor/po/:poId/dispatches: 201 with the new dispatch, 200
 * for a replayed clientEventId (the original dispatch plus {replayed:true,
 * no_op:true}, as /out replays: the activity trail records nothing and no
 * notice goes out again).
 */
export const createDispatch = async (req, res) => {
  let out;
  try {
    out = await db.tx(async (t) => {
      const data = await createDispatchNote(t, req.user, req.params.poId, req.body);
      if (data.replayed) return { data };
      const scope = await dispatchActivityScope(t, req.params.poId, data.hotelId);
      return { data, scope };
    });
  } catch (err) {
    return sendInventoryError(res, err);
  }
  if (out.data.replayed) {
    return res.status(200).json({ status: 1, message: 'Dispatch already recorded', data: { ...out.data, replayed: true, no_op: true } });
  }
  res.locals.activityDetail = {
    scope: out.scope,
    metadata: { dispatchId: out.data.id, dispatchNumber: out.data.dispatchNumber, lineCount: out.data.lines.length },
  };
  await notifyDispatchCreated(db, { dispatchId: out.data.id });
  return res.status(201).json({ status: 1, message: 'Dispatch recorded', data: out.data });
};

/** POST /inventory/vendor/po/:poId/dispatches/:id/cancel */
export const cancelDispatch = async (req, res) => {
  let out;
  try {
    out = await db.tx(async (t) => {
      const data = await cancelDispatchNote(t, req.user, req.params.poId, req.params.id);
      const scope = await dispatchActivityScope(t, req.params.poId, data.hotelId);
      return { data, scope };
    });
  } catch (err) {
    return sendInventoryError(res, err);
  }
  res.locals.activityDetail = {
    scope: out.scope,
    metadata: { dispatchId: out.data.id, dispatchNumber: out.data.dispatchNumber },
  };
  return res.json({ status: 1, message: 'Dispatch cancelled', data: out.data });
};
