// A refused PO decision, carrying the HTTP status and error code to answer with.
//
// Its own module so the approval engine (generalModel.submitApprovalAction)
// can throw it for a PO on hold without importing poApprovalService, which
// itself imports the engine. poApprovalService re-exports it, so every
// existing `instanceof PoDecisionError` sees this one class.

export class PoDecisionError extends Error {
  constructor(message, { code, httpStatus = 400 } = {}) {
    super(message);
    this.name = 'PoDecisionError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
