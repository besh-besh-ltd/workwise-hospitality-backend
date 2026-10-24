/**
 * Auth for the site-rep token routes (/api/v1/inventory/token/*), spec §10.3.
 *
 * The token travels ONLY in the X-Receive-Token header: the token page lifts it
 * out of the URL on load, so it never sits in a query string, a referrer or an
 * access log. A query-string `token` is ignored here (the legacy GET /po/:id and
 * /po/markGRN keep accepting it through auth.authUserOrGRNToken).
 *
 * On success:
 *   req.receiveToken = { tokenId, poId, hotelId }  (hotelId null = no single
 *                                                   hotel; posting must refuse)
 *   req.user         = the token-user shape (is_token_user, entityId = poId),
 *                      so assertPoAccess and the activity log treat it as the
 *                      GRN site representative bound to that one PO.
 * Otherwise 401 {status:0, message:'Invalid or expired link'}: unknown,
 * malformed, expired, revoked, or the PO is closed/cancelled.
 *
 * The token itself is never logged.
 */
import { logger } from '../util/logger.js';
import { findLiveReceiveToken, tokenRequestUser, RECEIVE_TOKEN_HEADER } from '../helper/receiveToken.js';

const deny = (res) => res.status(401).json({ status: 0, message: 'Invalid or expired link' });

export const receiveTokenAuth = async (req, res, next) => {
  const presented = req.get(RECEIVE_TOKEN_HEADER);
  if (!presented) return deny(res);
  try {
    const tok = await findLiveReceiveToken(presented);
    if (!tok) {
      logger.info({ route: req.originalUrl?.split('?')[0], method: req.method }, '[receive-token] refused');
      return deny(res);
    }
    req.receiveToken = { tokenId: tok.id, poId: tok.poId, hotelId: tok.hotelId };
    req.user = tokenRequestUser(tok);
    logger.info(
      { tokenId: tok.id, poId: tok.poId, hotelId: tok.hotelId, route: req.originalUrl?.split('?')[0], method: req.method },
      '[receive-token] used'
    );
    return next();
  } catch (err) {
    return next(err);
  }
};

export default receiveTokenAuth;
