// HTTP for scan resolve, label sheets and short links (Task B4). The work is in
// app/services/inventory/scanService.js and labelService.js.
//
// Every route is buyerGuard (passportSignIn + noAcl([3])): vendors get 403
// before anything here runs. Scope comes from req.user plus the scanned or
// named record, never from the request: the scan context and a label hotelId
// only name which hotel/PO to look inside, and the services check the caller's
// grant on it.
//
// None of these handlers writes to the database, so none opens a transaction:
// reads go through `db`, and label rendering (Chromium + S3) holds no
// connection. The two label POSTs are in NOT_AN_EVENT (eventRegistry), so no
// activity detail is set. Refusals go through sendInventoryError (4xx with
// {status, message, code, details}); success is {status:1, message, data}.

import db from '../../config/dbConn.js';
import { sendInventoryError } from '../../services/inventory/errors.js';
import {
  resolveScan as resolveScanCode,
  resolveShortLink as resolveShortLinkTarget,
} from '../../services/inventory/scanService.js';
import { renderItemLabels, renderGrnLabels } from '../../services/inventory/labelService.js';

const queryString = (v) => (typeof v === 'string' ? v : undefined);

/** GET /scan/resolve?code&context=po:<id>|hotel:<id> */
export const resolveScan = async (req, res) => {
  try {
    const data = await resolveScanCode(db, req.user, {
      code: queryString(req.query.code),
      context: queryString(req.query.context),
    });
    return res.status(200).json({ status: 1, message: 'Code resolved', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** POST /labels/items {layout, hotelId?, items:[{invItemId, copies, batchNo?, expiryDate?}]} */
export const printItemLabels = async (req, res) => {
  try {
    const data = await renderItemLabels(db, req.user, req.body);
    return res.status(200).json({ status: 1, message: 'Labels ready', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** POST /labels/grn/:grnId {layout, mode:'per_unit'|'per_pack'} */
export const printGrnLabels = async (req, res) => {
  try {
    const data = await renderGrnLabels(db, req.user, req.params.grnId, req.body);
    return res.status(200).json({ status: 1, message: 'Labels ready', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};

/** GET /s/resolve?t&id → {path}; 404 when missing or out of scope. */
export const resolveShortLink = async (req, res) => {
  try {
    const data = await resolveShortLinkTarget(db, req.user, {
      t: queryString(req.query.t),
      id: queryString(req.query.id),
    });
    return res.status(200).json({ status: 1, message: 'Link resolved', data });
  } catch (err) {
    return sendInventoryError(res, err);
  }
};
