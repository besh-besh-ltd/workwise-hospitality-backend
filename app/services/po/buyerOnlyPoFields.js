// PO columns a vendor (user_type 3) or a token user (GRN site representative)
// must never receive.
//
// replaces_po_id points at the rejected PO a re-award replaces, usually another
// vendor's. Its id leads to that vendor's PO and the approver's reason for
// turning it down, which is internal.
//
// hold is the open request for information an approver put the PO on hold
// with (who was asked, why, by whom): internal to the buyer.
//
// approval_history (GET /po/:po_id) is the buyer's approval log: every
// approver's comment, the reasons a PO was sent back or rejected, and the
// questions asked while it was on hold. No vendor screen reads it.
//
// Any response that hands a raw tbl_rfq_purchase_order row (SELECT * /
// RETURNING * / PO.*) to someone who might be a vendor passes it through here,
// rather than each query listing columns.

export const BUYER_ONLY_PO_FIELDS = Object.freeze(['replaces_po_id', 'hold', 'approval_history']);

/** True for a caller who must not see buyer-only PO fields. */
export const isVendorOrTokenViewer = (user) =>
  !!user && (Number(user.user_type) === 3 || !!user.is_token_user);

const stripOne = (row) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  if (!BUYER_ONLY_PO_FIELDS.some((f) => f in row)) return row;
  const out = { ...row };
  for (const f of BUYER_ONLY_PO_FIELDS) delete out[f];
  return out;
};

/**
 * A copy of `value` (one PO row or an array of them) without the buyer-only
 * fields. Anything that is not an object comes back as it is.
 */
export function stripBuyerOnlyPoFields(value) {
  return Array.isArray(value) ? value.map(stripOne) : stripOne(value);
}

/** stripBuyerOnlyPoFields when `user` is a vendor or token user; otherwise `value` unchanged. */
export const poFieldsFor = (user, value) =>
  isVendorOrTokenViewer(user) ? stripBuyerOnlyPoFields(value) : value;
