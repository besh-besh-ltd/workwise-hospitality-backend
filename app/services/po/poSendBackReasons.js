// Reasons and routes an approver can give when turning a PO down.
//
// The codes match the CHECK constraints on tbl_po_send_backs
// (migrations/20261022100000_po_send_backs.sql). The labels are the exact
// client-facing wording; the frontend carries the same table.

export const REASON_LABELS = Object.freeze({
  EVIDENCE_MISSING: 'Photos or documents missing',
  INFO_MISSING: 'Need more details or justification',
  TECH_QUERY: 'Question on the technical evaluation',
  PRICE_TAX_QUERY: 'Question on price, GST or calculation',
  QTY_SPEC_CHANGE: 'Quantity or specification needs a change',
  RENEGOTIATE: 'Re-negotiate or change the vendor',
  NOT_REQUIRED: 'Not needed any more',
  OTHER: 'Something else',
});

export const REASON_CODES = Object.freeze(Object.keys(REASON_LABELS));

/** Reasons that may accompany a CANCEL ("not needed any more"). */
export const CANCEL_REASONS = Object.freeze(['NOT_REQUIRED', 'OTHER']);

/** Routes a rejection can take today. TECHNICAL is reserved, not built. */
export const REJECTION_ROUTES = Object.freeze(['COMMERCIAL', 'CANCEL']);

export const reasonLabel = (code) => REASON_LABELS[code] || REASON_LABELS.OTHER;
