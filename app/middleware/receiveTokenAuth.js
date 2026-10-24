/**
 * STUB (Task A4). B6 rewrites this file in place with real hashed-token
 * validation (lookup, expiry, hotel + PO binding, req.user for the token).
 * Keep the export name and path: tokenRoutes.js imports it from here.
 */
export const receiveTokenAuth = (req, res) => {
  if (!req.get('X-Receive-Token')) {
    return res.status(401).json({ status: 0, message: 'Invalid or expired link' });
  }
  return res.status(501).json({ status: 0, message: 'not implemented' });
};

export default receiveTokenAuth;
