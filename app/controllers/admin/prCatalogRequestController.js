// Platform catalog requests (admin console, jwtAdm). Thin: the rules live in
// services/pr/prCatalogAdmin. Success is `{status: 1, data}`; refusals are the
// PR shape `{status: 0, code, message, details?}`. The admin is req.user.id
// (a tbl_users row, loaded by the jwtAdm strategy) — never read from the body.

import { logger } from '../../util/logger.js';
import { sendPrError } from '../../services/pr/prErrors.js';
import prCatalogAdmin from '../../services/pr/prCatalogAdmin.js';

const ok = (res, data) => res.status(200).json({ status: 1, message: 'success', data });

const handler = (fn) => async (req, res) => {
  try {
    return ok(res, await fn(req));
  } catch (err) {
    return sendPrError(res, err, logger);
  }
};

const prCatalogRequestController = {
  list: handler((req) => prCatalogAdmin.listRequests(req.query)),
  fulfil: handler((req) => prCatalogAdmin.fulfilRequest(req.params.id, Number(req.user.id), req.body)),
  reject: handler((req) => prCatalogAdmin.rejectRequest(req.params.id, Number(req.user.id), req.body)),
};

export default prCatalogRequestController;
