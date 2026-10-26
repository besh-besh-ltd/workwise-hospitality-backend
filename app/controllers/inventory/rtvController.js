// Return to vendor (spec §6.13). Gate: grn.approve at the GRN's hotel for
// every write, grn.read to view (inside the service). The delivery challan is
// rendered after commit for dispatched / closed RTVs (there is no stored PDF
// column), so a render never holds a database connection; a render failure
// leaves pdfUrl null rather than failing the request.

import db from '../../config/dbConn.js';
import { logError } from '../../helper/common.js';
import { sendInventoryError } from '../../services/inventory/errors.js';
import * as rtvService from '../../services/inventory/rtvService.js';
import { loadRtvDocument, renderRtvDocument } from '../../services/inventory/grnPdf.js';
import { notifyRtvDispatched } from '../../services/inventory/notices/receivingNotices.js';

const HAS_CHALLAN = new Set(['dispatched', 'closed']);

/** Run fn(t) → Rtv; also load the challan context when the RTV has one. */
const run = (fn) =>
  db.tx(async (t) => {
    const rtv = await fn(t);
    const doc = HAS_CHALLAN.has(rtv.status) ? await loadRtvDocument(t, rtv.id) : null;
    return { rtv, doc };
  });

/** Render the challan outside the transaction; null on failure (logged). */
async function withPdf({ rtv, doc }) {
  if (!doc) return rtv;
  try {
    return { ...rtv, pdfUrl: await renderRtvDocument(doc) };
  } catch (err) {
    logError('RTV challan render failed', err);
    return rtv;
  }
}

const activityDetail = (rtv, metadata = {}) => ({
  scope: { hospitalityCompanyId: rtv.companyId, hotelId: rtv.hotelId, entityLabel: rtv.rtvNumber ?? `RTV #${rtv.id}` },
  metadata: {
    rtv_id: rtv.id, po_id: rtv.poId, grn_id: rtv.grnId, disposition: rtv.disposition, status: rtv.status, ...metadata,
  },
});

const ok = (res, message, data) => res.status(200).json({ status: 1, message, data });

/** POST /inventory/rtv */
export const createRtv = async (req, res) => {
  let result;
  try {
    result = await run((t) => rtvService.createRtv(t, req.user, req.body ?? {}));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { rtv } = result;
  res.locals.activityDetail = activityDetail(rtv, {
    lines: rtv.lines.map((l) => ({ grn_line_id: l.grnLineId, qty: l.qty })),
  });
  return ok(res, 'Return to vendor created', rtv);
};

/** GET /inventory/rtv/:id */
export const getRtv = async (req, res) => {
  let result;
  try {
    result = await run((t) => rtvService.getRtv(t, req.user, req.params.id));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  return ok(res, 'Success', await withPdf(result));
};

/** POST /inventory/rtv/:id/dispatch */
export const dispatchRtv = async (req, res) => {
  let result;
  try {
    result = await run((t) => rtvService.dispatchRtv(t, req.user, req.params.id, req.body ?? {}));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { rtv } = result;
  res.locals.activityDetail = activityDetail(rtv, { challan_no: rtv.challanNo });
  notifyRtvDispatched(db, { rtvId: rtv.id });
  return ok(res, 'Return to vendor dispatched', await withPdf(result));
};

/** POST /inventory/rtv/:id/close */
export const closeRtv = async (req, res) => {
  let result;
  try {
    result = await run((t) => rtvService.closeRtv(t, req.user, req.params.id, req.body ?? {}));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { rtv } = result;
  res.locals.activityDetail = activityDetail(rtv, { credit_note_ref: rtv.creditNoteRef });
  return ok(res, 'Return to vendor closed', await withPdf(result));
};

/** POST /inventory/rtv/:id/cancel */
export const cancelRtv = async (req, res) => {
  let result;
  try {
    result = await run((t) => rtvService.cancelRtv(t, req.user, req.params.id));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  res.locals.activityDetail = activityDetail(result.rtv);
  return ok(res, 'Return to vendor cancelled', result.rtv);
};
