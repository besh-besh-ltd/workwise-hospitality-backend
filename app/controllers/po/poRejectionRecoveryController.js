/**
 * REQ-0032 vendor undo: "Rejected by mistake? Accept this order instead."
 * All logic lives in services/po/poRejectionRecovery.js; this maps it to HTTP.
 */
import { logError } from '../../helper/common.js';
import {
  RecoveryError, getVendorUndoState, withdrawRejectionByVendor, getReinstateState, reinstateByBuyer,
} from '../../services/po/poRejectionRecovery.js';
import { notifyRejectionWithdrawn, notifyPoSentBackToVendor } from '../../services/po/poRejectionRecoveryNotifier.js';

function sendError(res, err) {
  if (err instanceof RecoveryError) {
    return res.status(err.status).json({ status: 0, code: err.code, message: err.message });
  }
  logError('PO rejection recovery failed', err);
  return res.status(500).json({ status: 0, message: 'Something went wrong. Please try again.' });
}

export const getRejectionUndoState = async (req, res) => {
  try {
    const state = await getVendorUndoState(req.params.po_id, req.user.id);
    return res.json({ status: 1, data: state });
  } catch (err) {
    return sendError(res, err);
  }
};

export const withdrawRejection = async (req, res) => {
  try {
    const { po, callOff } = await withdrawRejectionByVendor(req.params.po_id, req.user.id);
    // Post-commit, never throws.
    await notifyRejectionWithdrawn({ po, vendorUserId: req.user.id, callOff });
    return res.json({ status: 1, message: 'Rejection withdrawn. The purchase order is accepted.' });
  } catch (err) {
    return sendError(res, err);
  }
};

/** REQ-0032 buyer send-back: GET the panel state. */
export const getReinstate = async (req, res) => {
  try {
    const state = await getReinstateState(req.params.po_id, req.user);
    return res.json({ status: 1, data: state });
  } catch (err) {
    return sendError(res, err);
  }
};

/** REQ-0032 buyer send-back: POST { note } returns the PO to the same vendor. */
export const reinstate = async (req, res) => {
  try {
    const { po, callOff, note } = await reinstateByBuyer(req.params.po_id, req.user, req.body?.note);
    // Post-commit, never throws.
    await notifyPoSentBackToVendor({
      po, actor: { id: req.user.id, name: req.user.name }, note, callOff,
    });
    return res.json({ status: 1, message: 'Sent back to the vendor for acceptance.' });
  } catch (err) {
    return sendError(res, err);
  }
};
