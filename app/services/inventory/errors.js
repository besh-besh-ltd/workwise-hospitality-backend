// Typed refusals for the inventory module, and the one place that turns them
// into HTTP answers.
//
// Services throw InventoryError inside db.tx (the throw rolls the transaction
// back); controllers catch AFTER the transaction and call sendInventoryError,
// so no response is ever sent from inside a transaction (check:tx-response).
//
// Envelope for a refusal: HTTP 4xx + {status, message, code, details}, where
// status follows the house codes (backend CLAUDE.md): 2 for NOT_FOUND (as
// PoAccessError → 404 {status:2}), 0 for every other business refusal.
// Business failures always carry a 4xx code: the frontend axios interceptor
// unwraps response.data, so a 200 {status:0} would read as success. 403, not
// 401, for "not allowed" (401 opens the session-expired modal).

import { logError } from '../../helper/common.js';

/** HTTP status for each code, used when the thrower does not pass one. */
export const INVENTORY_ERROR_STATUS = Object.freeze({
  NOT_FOUND: 404, // missing, foreign or out-of-scope record
  FORBIDDEN: 403, // a record the caller can see, an action they lack
  VALIDATION: 400,
  NEGATIVE_STOCK: 409,
  OVER_RECEIPT: 409,
  LOCKED: 409, // e.g. plan locked, count freeze
  CONFLICT: 409,
});

export class InventoryError extends Error {
  /**
   * @param {keyof typeof INVENTORY_ERROR_STATUS|string} code
   * @param {string} message  safe to show to the user
   * @param {object} [details] structured context for the UI (ids, quantities)
   * @param {number} [httpStatus] defaults to the code's status, else 400
   */
  constructor(code, message, details = {}, httpStatus = INVENTORY_ERROR_STATUS[code] ?? 400) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
    this.details = details ?? {};
    this.httpStatus = httpStatus;
  }
}

/**
 * Answer a request that failed. InventoryError → its HTTP status with
 * {status, message, code, details} (status 2 for NOT_FOUND, else 0); anything
 * else is logged and answered with the house 500 {status:3, message:'Something
 * went wrong'} (internals never reach the client).
 */
export function sendInventoryError(res, err) {
  if (err instanceof InventoryError) {
    return res.status(err.httpStatus).json({
      status: err.code === 'NOT_FOUND' ? 2 : 0,
      message: err.message,
      code: err.code,
      details: err.details,
    });
  }
  logError('inventory request failed', err);
  return res.status(500).json({ status: 3, message: 'Something went wrong' });
}

export default { InventoryError, sendInventoryError, INVENTORY_ERROR_STATUS };
