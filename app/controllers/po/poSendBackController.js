// HTTP for putting a PO on hold to ask someone for information (client ticket
// T3). The work is in app/services/po/poSendBackService.js.
//
// Every route is passportSignIn + noAcl([3]): vendors get 403 before anything
// here runs. Tenant, caller and the person asked come from req.user and the
// PO, never from the body. Out of scope, missing, or (for an answer) not the
// person asked is 404.
//
// The guards (guardAsker, guardResponder) run BEFORE the upload middleware, so
// nothing is stored for a request that would be refused anyway; the service
// re-checks everything under the locks.
//
// Answers: success {status:1, message, data}; refusal HTTP 4xx
// {status:0, message, code}.
//
// Uploads: the service throws only when nothing was committed, so a throw is
// the one case where the files are removed again (discardUploads). After
// COMMIT it never throws; if it cannot read the result back, send_back is
// null and the answer is still a success, because the change happened.

import { assertPoAccess, PoAccessError } from '../../models/purchaseOrderModel.js';
import { PoDecisionError } from '../../services/po/poDecisionError.js';
import { logError } from '../../helper/common.js';
import {
  precheckAsker,
  precheckResponder,
  listTargets,
  listSendBacks,
  createInfoRequest,
  respondToInfoRequest,
  withdrawInfoRequest,
  discardUploads,
} from '../../services/po/poSendBackService.js';

const positiveId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function sendError(res, err, what) {
  if (err instanceof PoAccessError) {
    return res.status(404).json({ status: 0, message: 'Purchase order not found.', code: err.code });
  }
  if (err instanceof PoDecisionError) {
    return res.status(err.httpStatus || 400).json({ status: 0, message: err.message, code: err.code });
  }
  logError(`poSendBack ${what} failed`, err);
  return res.status(500).json({ status: 0, message: 'Something went wrong. Nothing was changed.', code: 'SEND_BACK_FAILED' });
}

const notFound = (res) => res.status(404).json({ status: 0, message: 'Purchase order not found.', code: 'PO_NOT_FOUND_OR_OUT_OF_SCOPE' });

/** Before the upload on POST /po/:po_id/send-back. */
export const guardAsker = async (req, res, next) => {
  const poId = positiveId(req.params.po_id);
  if (!poId) return notFound(res);
  try {
    await precheckAsker(req.user, poId, { forCreate: true });
    return next();
  } catch (err) {
    return sendError(res, err, 'guard');
  }
};

/** Before the upload on POST /po/send-back/:id/respond. */
export const guardResponder = async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) return notFound(res);
  try {
    await precheckResponder(req.user, id);
    return next();
  } catch (err) {
    return sendError(res, err, 'guard');
  }
};

/** GET /po/:po_id/send-back/targets */
export const getTargets = async (req, res) => {
  const poId = positiveId(req.params.po_id);
  if (!poId) return notFound(res);
  try {
    await precheckAsker(req.user, poId);
    const targets = await listTargets(req.user, poId);
    return res.status(200).json({ status: 1, message: 'People you can ask.', data: { targets } });
  } catch (err) {
    return sendError(res, err, 'targets');
  }
};

/** GET /po/:po_id/send-backs */
export const getSendBacks = async (req, res) => {
  const poId = positiveId(req.params.po_id);
  if (!poId) return notFound(res);
  try {
    // Readers of the PO (assertPoAccess): the thread is part of its record.
    await assertPoAccess(req.user, poId);
    const data = await listSendBacks(poId);
    return res.status(200).json({ status: 1, message: 'Send-backs.', data });
  } catch (err) {
    return sendError(res, err, 'list');
  }
};

/** POST /po/:po_id/send-back (multipart: target_role, reason_category, comment, files) */
export const createSendBack = async (req, res) => {
  const poId = positiveId(req.params.po_id);
  const files = Array.isArray(req.files) ? req.files : [];
  try {
    const sendBack = await createInfoRequest({
      user: req.user,
      poId,
      targetRole: req.body?.target_role,
      reasonCategory: req.body?.reason_category,
      comment: req.body?.comment,
      route: req.body?.route,
      files,
    });
    return res.status(201).json({
      status: 1,
      message: `On hold. ${sendBack?.target?.name || 'They'} will be asked to answer.`,
      data: { send_back: sendBack, po_id: poId },
    });
  } catch (err) {
    // Not committed (see the header): nothing points at these files.
    await discardUploads(files);
    return sendError(res, err, 'create');
  }
};

/** POST /po/send-back/:id/respond (multipart: response_text, files) */
export const respondSendBack = async (req, res) => {
  const id = positiveId(req.params.id);
  const files = Array.isArray(req.files) ? req.files : [];
  try {
    const out = await respondToInfoRequest({
      user: req.user,
      sendBackId: id,
      responseText: req.body?.response_text,
      files,
    });
    return res.status(200).json({
      status: 1,
      message: 'Answer sent. The approval can continue.',
      data: { send_back: out.sendBack, po_id: out.poId },
    });
  } catch (err) {
    // Not committed (see the header): nothing points at these files.
    await discardUploads(files);
    return sendError(res, err, 'respond');
  }
};

/** POST /po/send-back/:id/withdraw ({note?}) */
export const withdrawSendBack = async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return notFound(res);
  try {
    const out = await withdrawInfoRequest({ user: req.user, sendBackId: id, note: req.body?.note });
    return res.status(200).json({
      status: 1,
      message: 'Request withdrawn. The approval can continue.',
      data: { send_back: out.sendBack, po_id: out.poId },
    });
  } catch (err) {
    return sendError(res, err, 'withdraw');
  }
};
