// Printable documents. GET /inventory/grn/:id/pdf renders the goods receipt
// note on demand (grn.read at the GRN's hotel; drafts have none). The rows are
// read in a short task and the render + upload run after it, so Chromium never
// holds a database connection.

import db from '../../config/dbConn.js';
import { sendInventoryError } from '../../services/inventory/errors.js';
import {
  assertGrnDocumentAccess, loadGrnDocument, renderGrnDocument,
} from '../../services/inventory/grnPdf.js';

/** GET /inventory/grn/:id/pdf → {url} */
export const getGrnPdf = async (req, res) => {
  let url;
  try {
    const doc = await db.task(async (t) => {
      await assertGrnDocumentAccess(t, req.user, req.params.id);
      return loadGrnDocument(t, Number(req.params.id));
    });
    url = await renderGrnDocument(doc);
  } catch (err) {
    return sendInventoryError(res, err);
  }
  return res.status(200).json({ status: 1, message: 'Success', data: { url } });
};
