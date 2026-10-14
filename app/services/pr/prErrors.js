// Purchase Requisitions — typed errors.
//
// Every PR endpoint answers a refusal as `{ status: 0, code, message, details? }`
// with one of the codes below, so the FE maps codes (not messages) to copy.
// Anything that is not a PrError is an unexpected failure → 500 PR_INTERNAL,
// logged, and never echoed to the client.

export const PR_ERR = Object.freeze({
  STATE_CONFLICT: ['PR_STATE_CONFLICT', 409],
  NOT_FOUND: ['PR_NOT_FOUND', 404],
  FORBIDDEN: ['PR_FORBIDDEN', 403],
  VALIDATION: ['PR_VALIDATION', 422],
  LINE_ON_CONTRACT: ['PR_LINE_ON_CONTRACT', 422],
  VARIANT_NOT_USABLE: ['PR_VARIANT_NOT_USABLE', 422],
  NO_POLICY: ['PR_NO_POLICY', 422],
  STEP_UNRESOLVED: ['PR_STEP_UNRESOLVED', 422],
  NO_INDEPENDENT_APPROVER: ['PR_NO_INDEPENDENT_APPROVER', 422],
  NO_REVIEWER: ['PR_NO_REVIEWER', 422],
  LINE_NOT_CONVERTIBLE: ['PR_LINE_NOT_CONVERTIBLE', 409],
  UNIT_MISMATCH: ['PR_UNIT_MISMATCH', 422],
  HOTEL_MISMATCH: ['PR_HOTEL_MISMATCH', 422],
  SPEC_TOO_LONG: ['PR_SPEC_TOO_LONG', 422],
});

export class PrError extends Error {
  constructor([code, httpStatus], message, details) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export const prError = (kind, message, details) => new PrError(kind, message, details);

export function sendPrError(res, err, logger) {
  if (err instanceof PrError) {
    return res.status(err.httpStatus).json({ status: 0, code: err.code, message: err.message, details: err.details });
  }
  logger?.error?.({ err }, '[PR] unexpected error');
  return res.status(500).json({ status: 3, code: 'PR_INTERNAL', message: 'Something went wrong' });
}
