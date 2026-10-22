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
// Any response that hands a raw tbl_rfq_purchase_order row (SELECT * /
// RETURNING * / PO.*) to someone who might be a vendor passes it through here,
// rather than each query listing columns.

export const BUYER_ONLY_PO_FIELDS = Object.freeze(['replaces_po_id', 'hold']);

// Approval-history actions that record a request for information on the PO:
// who was asked, about what, and what they answered. Internal to the buyer,
// so they come out of `approval_history` (GET /po/:po_id) for these callers.
export const BUYER_ONLY_APPROVAL_ACTIONS = Object.freeze([
  'SEND_BACK', 'SEND_BACK_ANSWERED', 'SEND_BACK_WITHDRAWN',
]);

/** True for a caller who must not see buyer-only PO fields. */
export const isVendorOrTokenViewer = (user) =>
  !!user && (Number(user.user_type) === 3 || !!user.is_token_user);

const isBuyerOnlyAction = (a) =>
  !!a && BUYER_ONLY_APPROVAL_ACTIONS.includes(String(a.action || '').toUpperCase());

const stripOne = (row) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const history = Array.isArray(row.approval_history) ? row.approval_history : null;
  const historyLeaks = !!history && history.some(isBuyerOnlyAction);
  if (!historyLeaks && !BUYER_ONLY_PO_FIELDS.some((f) => f in row)) return row;
  const out = { ...row };
  for (const f of BUYER_ONLY_PO_FIELDS) delete out[f];
  if (historyLeaks) out.approval_history = history.filter((a) => !isBuyerOnlyAction(a));
  return out;
};

/**
 * A copy of `value` (one PO row or an array of them) without the buyer-only
 * fields, and without the buyer-only actions in its `approval_history`.
 * Anything that is not an object comes back as it is.
 */
export function stripBuyerOnlyPoFields(value) {
  return Array.isArray(value) ? value.map(stripOne) : stripOne(value);
}

/** stripBuyerOnlyPoFields when `user` is a vendor or token user; otherwise `value` unchanged. */
export const poFieldsFor = (user, value) =>
  isVendorOrTokenViewer(user) ? stripBuyerOnlyPoFields(value) : value;

/**
 * For lifecycle payloads: a copy of `phases` (an array of phases or stages,
 * each with `purchase_orders` directly or under `phase`) with the buyer-only
 * fields removed from every PO, when `user` is a vendor or token user.
 * Otherwise `phases` unchanged.
 */
export function stripLifecyclePoFields(user, phases) {
  if (!isVendorOrTokenViewer(user) || !Array.isArray(phases)) return phases;
  const fix = (holder) =>
    holder && Array.isArray(holder.purchase_orders)
      ? { ...holder, purchase_orders: stripBuyerOnlyPoFields(holder.purchase_orders) }
      : holder;
  return phases.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const out = fix(p);
    return out.phase ? { ...out, phase: fix(out.phase) } : out;
  });
}
