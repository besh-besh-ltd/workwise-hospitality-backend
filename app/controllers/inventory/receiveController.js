// HTTP for receiving: the awaiting-delivery list, the receive context, GRN
// drafts, posting, reversal and attachments (task B1). The work is in
// app/services/inventory/grnService.js and awaiting.js.
//
// Every route is passportSignIn + noAcl([3]) (guards.js). Tenant scope comes
// from req.user and the PO / GRN row inside the service, never from the body.
// Each handler runs its transaction to completion, THEN answers (no response
// inside a transaction: check:tx-response) and THEN sends notifications.
//
// Answers: success {status:1, message, data}; refusals via sendInventoryError
// (HTTP 4xx {status, message, code, details}).

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import db from '../../config/dbConn.js';
import s3Client from '../../config/s3config.js';
import { logError } from '../../helper/common.js';
import { sendInventoryError, InventoryError } from '../../services/inventory/errors.js';
import { notifyGrnPosted, notifyGrnRejections } from '../../services/inventory/notifier.js';
import { getAwaitingDeliveries as awaitingList } from '../../services/inventory/awaiting.js';
import {
  getReceiveContext as receiveContext,
  saveGrnDraft,
  postGrn as postGrnService,
  reverseGrn as reverseGrnService,
  getGrn as getGrnService,
  listGrns as listGrnsService,
  discardGrn as discardGrnService,
  addGrnAttachment,
  deleteGrnAttachment as deleteGrnAttachmentService,
  assertGrnAttachmentAccess,
  replayByClientEvent,
} from '../../services/inventory/grnService.js';

const positiveId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const notFound = (what) => new InventoryError('NOT_FOUND', what);
const bodyOf = (req) => req.value?.body ?? req.body ?? {};

/** Unique violation on tbl_grn.client_event_id: a concurrent request with the same key won. */
const isClientEventRace = (err) => err?.code === '23505' && err?.constraint === 'ux_grn_client_event';

/** Activity trail scope for a GRN (company + hotel + label). */
function grnActivity(res, grn, extra = {}) {
  if (!grn) return;
  res.locals.activityDetail = {
    scope: {
      hospitalityCompanyId: grn.companyId ?? null,
      hotelId: grn.hotelId ?? null,
      entityLabel: grn.grnNumber || (grn.id ? `GRN draft #${grn.id}` : null),
    },
    ...extra,
  };
}

/** After COMMIT: receipt notices. Never throws; a notice failure is logged. */
async function afterPost(grn) {
  if (!grn?.id || grn.status === 'draft') return;
  try {
    await notifyGrnPosted(db, { grnId: grn.id });
  } catch (err) {
    logError('inventory: GRN posted notice failed', err);
  }
  if (grn.docType === 'RECEIPT' && (grn.lines || []).some((l) => Number(l.rejectedQty) > 0)) {
    try {
      await notifyGrnRejections(db, { grnId: grn.id });
    } catch (err) {
      logError('inventory: GRN rejection notice failed', err);
    }
  }
}

/** An upload that was not recorded is removed again (best effort). */
async function discardUpload(file) {
  if (!file?.key || !file?.bucket) return;
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: file.bucket, Key: file.key }));
  } catch (err) {
    logError('inventory: could not remove an unused GRN upload', err);
  }
}

/** GET /receive/awaiting */
export const getAwaitingDeliveries = async (req, res) => {
  try {
    const { hotelId, filter, search, page } = req.query;
    const data = await db.task((t) => awaitingList(t, req.user, { hotelId, filter, search, page }));
    return res.status(200).json({ status: 1, message: 'Awaiting deliveries', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** GET /receive/po/:poId?hotelId (may create the PO's default plan). */
export const getReceiveContext = async (req, res) => {
  try {
    const poId = positiveId(req.params.poId);
    if (!poId) throw notFound('Purchase order not found');
    const hotelId = req.query.hotelId ?? null;
    const data = await db.tx((t) => receiveContext(t, req.user, { poId, hotelId }));
    return res.status(200).json({ status: 1, message: 'Receive context', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/**
 * POST /grn: save a draft (post:false) or record and post a receipt
 * (post:true). A clientEventId that already produced a posted GRN answers 200
 * with that GRN (nothing is posted twice); a new document answers 201.
 */
export const createGrn = async (req, res) => {
  const input = bodyOf(req);
  let result;
  try {
    result = await db.tx((t) => (input.post
      ? postGrnService(t, req.user, { input })
      : saveGrnDraft(t, req.user, input)));
  } catch (err) {
    if (!isClientEventRace(err)) return sendInventoryError(res, err);
    try {
      result = await db.task((t) => replayByClientEvent(t, req.user, input.clientEventId));
      if (!result) throw err;
    } catch (replayErr) {
      return sendInventoryError(res, replayErr);
    }
  }
  const { grn, replayed } = result;
  grnActivity(res, grn, { replayed: !!replayed, posted: grn.status !== 'draft' });
  res.status(replayed ? 200 : 201).json({
    status: 1,
    message: replayed ? 'GRN already recorded' : grn.status === 'draft' ? 'GRN draft saved' : 'GRN posted',
    data: grn,
  });
  if (!replayed) await afterPost(grn);
  return undefined;
};

/** GET /grn */
export const listGrns = async (req, res) => {
  try {
    const { hotelId, poId, from, to, status, page } = req.query;
    const data = await db.task((t) => listGrnsService(t, req.user, { hotelId, poId, from, to, status, page }));
    return res.status(200).json({ status: 1, message: 'GRNs', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** GET /grn/:id */
export const getGrn = async (req, res) => {
  try {
    const id = positiveId(req.params.id);
    if (!id) throw notFound('GRN not found');
    const data = await db.task((t) => getGrnService(t, req.user, id));
    return res.status(200).json({ status: 1, message: 'GRN', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** PUT /grn/:id: replace a draft; post:true also posts it (grn.create). */
export const updateGrn = async (req, res) => {
  let result;
  try {
    const id = positiveId(req.params.id);
    if (!id) throw notFound('GRN not found');
    const input = bodyOf(req);
    result = await db.tx(async (t) => {
      const saved = await saveGrnDraft(t, req.user, input, { grnId: id });
      if (!input.post) return saved;
      return postGrnService(t, req.user, { grnId: id, clientEventId: input.clientEventId || null });
    });
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { grn } = result;
  grnActivity(res, grn, { posted: grn.status !== 'draft' });
  res.status(200).json({ status: 1, message: grn.status === 'draft' ? 'GRN draft saved' : 'GRN posted', data: grn });
  if (grn.status !== 'draft' && !result.replayed) await afterPost(grn);
  return undefined;
};

/** POST /grn/:id/post {clientEventId} */
export const postGrn = async (req, res) => {
  let result;
  try {
    const id = positiveId(req.params.id);
    if (!id) throw notFound('GRN not found');
    const { clientEventId } = bodyOf(req);
    result = await db.tx((t) => postGrnService(t, req.user, { grnId: id, clientEventId }));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { grn, replayed } = result;
  grnActivity(res, grn, { replayed: !!replayed });
  res.status(200).json({ status: 1, message: replayed ? 'GRN already posted' : 'GRN posted', data: grn });
  if (!replayed) await afterPost(grn);
  return undefined;
};

/** DELETE /grn/:id (draft only) */
export const discardGrn = async (req, res) => {
  try {
    const id = positiveId(req.params.id);
    if (!id) throw notFound('GRN not found');
    const out = await db.tx((t) => discardGrnService(t, req.user, id));
    grnActivity(res, { id: out.grnId, companyId: out.companyId, hotelId: out.hotelId });
    return res.status(200).json({ status: 1, message: 'GRN draft discarded', data: { deleted: true } });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** POST /grn/:id/reverse {reason, lines} → the REVERSAL Grn */
export const reverseGrn = async (req, res) => {
  let result;
  try {
    const id = positiveId(req.params.id);
    if (!id) throw notFound('GRN not found');
    const { reason, lines } = bodyOf(req);
    result = await db.tx((t) => reverseGrnService(t, req.user, { grnId: id, reason, lines }));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  const { grn, original } = result;
  res.locals.activityDetail = {
    scope: {
      hospitalityCompanyId: original.companyId,
      hotelId: original.hotelId,
      entityLabel: original.grnNumber,
    },
    reversal_grn_id: grn.id,
    reversal_grn_number: grn.grnNumber,
    original_status: original.status,
  };
  res.status(201).json({ status: 1, message: 'GRN reversed', data: grn });
  await afterPost(grn);
  return undefined;
};

/**
 * Route guard for POST /grn/:id/attachments, BEFORE the upload middleware:
 * nothing is stored for a caller who may not attach to this GRN.
 */
export const guardGrnAttachmentUpload = async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    if (!id) throw notFound('GRN not found');
    await db.task((t) => assertGrnAttachmentAccess(t, req.user, id));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  return next();
};

/** POST /grn/:id/attachments (multipart file, kind) */
export const uploadGrnAttachment = async (req, res) => {
  const file = req.file;
  let out;
  try {
    const id = positiveId(req.params.id);
    if (!id) throw notFound('GRN not found');
    if (!file?.key) throw new InventoryError('VALIDATION', 'Choose a file to attach', { field: 'file' });
    const kind = req.body?.kind || 'OTHER';
    out = await db.tx((t) => addGrnAttachment(t, req.user, id, {
      s3Key: file.key, fileName: file.originalname || null, kind,
    }));
  } catch (err) {
    await discardUpload(file);
    return sendInventoryError(res, err);
  }
  res.locals.activityDetail = {
    scope: { hospitalityCompanyId: out.companyId, hotelId: out.hotelId, entityLabel: out.grnNumber },
    attachment_id: out.attachment.id,
    kind: out.attachment.kind,
  };
  return res.status(201).json({ status: 1, message: 'Attachment added', data: out.attachment });
};

/** DELETE /grn/:id/attachments/:attId (draft only) */
export const deleteGrnAttachment = async (req, res) => {
  try {
    const id = positiveId(req.params.id);
    const attId = positiveId(req.params.attId);
    if (!id || !attId) throw notFound('Attachment not found');
    const out = await db.tx((t) => deleteGrnAttachmentService(t, req.user, id, attId));
    res.locals.activityDetail = {
      scope: { hospitalityCompanyId: out.companyId, hotelId: out.hotelId, entityLabel: out.grnNumber },
      attachment_id: attId,
    };
    return res.status(200).json({ status: 1, message: 'Attachment removed', data: { deleted: true } });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};
