// HTTP for RFQ items closed without award (app/services/rfq/rfqItemClosure.js).
//
//   GET  /rfq/:id/close-preview   what Close RFQ / Close items would do
//   POST /rfq/:id/items/close     close items without award, with a reason
//   POST /rfq/:id/items/reopen    reopen closed items, with remarks
//
// The service throws inside db.tx; the response is sent after the
// transaction (check:tx-response). Lifecycle, vendor notices and PO
// auto-initiation run after commit and never fail the request.

import db from '../../config/dbConn.js';
import { logError } from '../../helper/common.js';
import { recordLifecycleEvent } from '../../models/generalModel.js';
import { autoInitiateRFQPOs, isRfqFullyAwarded } from '../../models/purchaseOrderModel.js';
import { dispatch as dispatchNotification } from '../../services/notificationService.js';
import { vendorRfqDetail } from '../../services/notificationLinks.js';
import {
  closeItems,
  reopenItems,
  getClosePreview,
  sendItemClosureError,
} from '../../services/rfq/rfqItemClosure.js';

const fail = (res, err, what) => {
  if (sendItemClosureError(res, err)) return;
  logError(`[rfqItemClosure] ${what} failed`, err);
  res.status(500).json({ status: 3, message: 'Something went wrong' });
};

const rfqLabel = (rfq) => (rfq?.rfq_no ? `${rfq.is_tender ? 'Tender' : 'RFQ'} #${rfq.rfq_no}` : 'RFQ');

export const closePreview = async (req, res) => {
  try {
    const data = await getClosePreview(req.user, req.params.id);
    return res.status(200).json({ status: 1, message: 'Close preview', data });
  } catch (err) {
    return fail(res, err, 'close preview');
  }
};

export const closeRfqItems = async (req, res) => {
  let out;
  try {
    out = await db.tx((t) => closeItems(t, req.user, req.params.id, req.body ?? {}));
  } catch (err) {
    return fail(res, err, 'close items');
  }

  const rfqId = out.rfq.id;
  let autoInitiate = null;
  if (out.closed.length) {
    try {
      await recordLifecycleEvent({
        entity_type: out.rfq.is_tender ? 'TENDER' : 'RFQ',
        entity_id: rfqId,
        stage: 'AWARD',
        action: 'RFQ_ITEMS_CLOSED',
        performed_by: req.user.id,
        metadata: { rfq_product_ids: out.closed, reason_code: req.body?.reason_code },
        remarks: typeof req.body?.remarks === 'string' ? req.body.remarks.trim() || null : null,
      });
    } catch (lifecycleErr) {
      logError(`[rfqItemClosure] lifecycle event failed for RFQ ${rfqId}`, lifecycleErr);
    }

    if (out.notify_vendor_ids.length) {
      const names = out.closed_items.map((i) => i.product_name).join(', ');
      dispatchNotification({
        userIds: out.notify_vendor_ids,
        senderUserId: req.user.id,
        category: 'rfq',
        type: 'rfq_items_closed',
        title: `${rfqLabel(out.rfq)}: items closed without award`,
        body: `The buyer closed ${out.closed.length === 1 ? 'an item' : `${out.closed.length} items`} without awarding them: ${names}.`,
        data: { rfq_id: rfqId, rfq_product_ids: out.closed },
        actionUrl: vendorRfqDetail(rfqId),
      }).catch((notifyErr) => logError(`[rfqItemClosure] vendor notice failed for RFQ ${rfqId}`, notifyErr));
    }

    // Closing the last open item can settle the RFQ, exactly as an award does.
    try {
      if (await isRfqFullyAwarded(rfqId)) {
        autoInitiate = await autoInitiateRFQPOs(rfqId, req.user.id);
      }
    } catch (initErr) {
      logError(`[rfqItemClosure] auto-initiate failed for RFQ ${rfqId}`, initErr);
    }
  }

  let preview = null;
  try {
    preview = await getClosePreview(req.user, rfqId);
  } catch (previewErr) {
    logError(`[rfqItemClosure] preview after close failed for RFQ ${rfqId}`, previewErr);
  }

  return res.status(200).json({
    status: 1,
    message: out.closed.length
      ? `${out.closed.length === 1 ? 'Item' : `${out.closed.length} items`} closed without award`
      : 'Nothing to close: the items were already closed',
    data: {
      closed: out.closed,
      already_closed: out.already_closed,
      auto_initiate_summary: autoInitiate,
      preview,
    },
  });
};

export const reopenRfqItems = async (req, res) => {
  let out;
  try {
    out = await db.tx((t) => reopenItems(t, req.user, req.params.id, req.body ?? {}));
  } catch (err) {
    return fail(res, err, 'reopen items');
  }

  if (out.reopened.length) {
    try {
      await recordLifecycleEvent({
        entity_type: out.rfq.is_tender ? 'TENDER' : 'RFQ',
        entity_id: out.rfq.id,
        stage: 'AWARD',
        action: 'RFQ_ITEMS_REOPENED',
        performed_by: req.user.id,
        metadata: { rfq_product_ids: out.reopened },
        remarks: typeof req.body?.remarks === 'string' ? req.body.remarks.trim() || null : null,
      });
    } catch (lifecycleErr) {
      logError(`[rfqItemClosure] lifecycle event failed for RFQ ${out.rfq.id}`, lifecycleErr);
    }
  }

  let preview = null;
  try {
    preview = await getClosePreview(req.user, out.rfq.id);
  } catch (previewErr) {
    logError(`[rfqItemClosure] preview after reopen failed for RFQ ${out.rfq.id}`, previewErr);
  }

  return res.status(200).json({
    status: 1,
    message: out.reopened.length
      ? `${out.reopened.length === 1 ? 'Item' : `${out.reopened.length} items`} reopened`
      : 'Nothing to reopen: the items were already open',
    data: { reopened: out.reopened, already_open: out.already_open, preview },
  });
};

export default { closePreview, closeRfqItems, reopenRfqItems };
