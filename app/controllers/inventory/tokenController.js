// HTTP for the site-rep receive link (spec §10.3, task C5). The work is in
// app/services/inventory/tokenReceive.js.
//
// Every route is receiveTokenRateLimit + receiveTokenAuth (tokenRoutes.js), so
// req.receiveToken = {tokenId, poId, hotelId} is a live link. The PO, the hotel
// and the GRNs come from it, never from params or the body. Each handler runs
// its transaction to completion, THEN answers (check:tx-response), THEN sends
// notices. Refusals go through sendInventoryError (4xx {status, message, code,
// details}).

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import db from '../../config/dbConn.js';
import s3Client from '../../config/s3config.js';
import { logError } from '../../helper/common.js';
import { sendInventoryError, InventoryError } from '../../services/inventory/errors.js';
import { notifyGrnPosted, notifyGrnRejections } from '../../services/inventory/notifier.js';
import {
  getTokenReceiveContext as tokenContext,
  postTokenGrn as postTokenGrnService,
  assertTokenGrn,
  addTokenGrnAttachment,
} from '../../services/inventory/tokenReceive.js';

const bodyOf = (req) => req.value?.body ?? req.body ?? {};

/** Unique violation on tbl_grn.client_event_id: a concurrent request with the same key won. */
const isClientEventRace = (err) => err?.code === '23505' && err?.constraint === 'ux_grn_client_event';

/**
 * After COMMIT: the receipt notice (initiator + vendor, one vendor email) and
 * the vendor's in-app rejection notice. Both handle a NULL posted_by. Never throws.
 */
async function afterPost(grnId) {
  try {
    await notifyGrnPosted(db, { grnId });
    await notifyGrnRejections(db, { grnId });
  } catch (err) {
    logError('inventory: token GRN posted notice failed', err);
  }
}

/** An upload that was not recorded is removed again (best effort). */
async function discardUpload(file) {
  if (!file?.key || !file?.bucket) return;
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: file.bucket, Key: file.key }));
  } catch (err) {
    logError('inventory: could not remove an unused token GRN upload', err);
  }
}

/** GET /token/receive-context (may create the PO's default plan). */
export const getTokenReceiveContext = async (req, res) => {
  try {
    const data = await db.tx((t) => tokenContext(t, req.receiveToken));
    return res.status(200).json({ status: 1, message: 'Receive context', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/**
 * POST /token/grn: record and post a receipt at the link's hotel. 201 for a
 * new GRN; 200 with the original plus {replayed:true, no_op:true} for a
 * replayed clientEventId.
 */
export const postTokenGrn = async (req, res) => {
  const input = bodyOf(req);
  let result;
  try {
    result = await db.tx((t) => postTokenGrnService(t, req.receiveToken, input));
  } catch (err) {
    if (!isClientEventRace(err)) return sendInventoryError(res, err);
    // The other request committed first: answer with what it posted.
    try {
      result = await db.tx((t) => postTokenGrnService(t, req.receiveToken, input));
    } catch (replayErr) {
      return sendInventoryError(res, replayErr);
    }
  }
  const { grn, replayed, activity } = result;
  // A replay records nothing new: no activity detail, no second notice.
  if (!replayed) {
    res.locals.activityDetail = {
      scope: { hospitalityCompanyId: activity.companyId, hotelId: activity.hotelId, entityLabel: activity.grnNumber },
      metadata: { po_id: req.receiveToken.poId, token_id: req.receiveToken.tokenId },
    };
  }
  res.status(replayed ? 200 : 201).json({
    status: 1,
    message: replayed ? 'GRN already recorded' : 'GRN posted',
    data: replayed ? { ...grn, replayed: true, no_op: true } : grn,
  });
  if (!replayed) await afterPost(activity.grnId);
  return undefined;
};

/**
 * Route guard for POST /token/grn/:id/attachments, BEFORE the upload
 * middleware: nothing is stored unless the GRN is one this link posted.
 */
export const guardTokenGrnAttachmentUpload = async (req, res, next) => {
  try {
    await db.task((t) => assertTokenGrn(t, req.receiveToken, req.params.id));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  return next();
};

/** POST /token/grn/:id/attachments (multipart file, kind) → {id, fileName, kind, url} */
export const uploadTokenGrnAttachment = async (req, res) => {
  const file = req.file;
  let out;
  try {
    if (!file?.key) throw new InventoryError('VALIDATION', 'Choose a file to attach', { field: 'file' });
    const kind = req.body?.kind || 'OTHER';
    out = await db.tx((t) => addTokenGrnAttachment(t, req.receiveToken, req.params.id, {
      s3Key: file.key, fileName: file.originalname || null, kind,
    }));
  } catch (err) {
    await discardUpload(file);
    return sendInventoryError(res, err);
  }
  res.locals.activityDetail = {
    scope: { hospitalityCompanyId: out.companyId, hotelId: out.hotelId, entityLabel: out.grnNumber },
    metadata: { attachment_id: out.attachment.id, kind: out.attachment.kind, token_id: req.receiveToken.tokenId },
  };
  return res.status(201).json({ status: 1, message: 'Attachment added', data: out.attachment });
};
