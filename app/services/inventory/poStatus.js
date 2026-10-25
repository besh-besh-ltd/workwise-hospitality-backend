// The legacy po.status only moves forward (spec §6.14):
//   approved < dispatched < GRN < invoice_raised
// The first posted GRN sets GRN only if that is a step forward; a second
// dispatch note never moves a received PO back to 'dispatched'; an invoice
// raised before the goods arrived is not undone by the GRN. New screens read
// receipt_status instead. The po_status enum is unchanged.
//
// tbl_rfq_purchase_order has no row-audit trigger and no status-history table:
// the legacy handlers (handleMarkGRN / handleRaiseInvoice) record the ACTION in
// tbl_approval_hierarchy_history with the acting user, and the activity log
// records the route. Both stay with the caller, which knows the actor; this
// helper only moves the status (and stamps updated_at, as vendor acceptance does).

import { InventoryError } from './errors.js';

export const LEGACY_PO_STATUS_ORDER = Object.freeze(['approved', 'dispatched', 'GRN', 'invoice_raised']);

/**
 * Move po.status forward to `target` when that is a step forward.
 * POs whose status is outside the order (draft, pending_approval,
 * acceptance_pending, sent, completed, cancelled, rejected, …) are left alone.
 * Locks the PO row.
 *
 * @param {object} t transaction
 * @param {number} poId
 * @param {'approved'|'dispatched'|'GRN'|'invoice_raised'} target
 * @returns {Promise<{from:string, to:string, changed:boolean}>} `to` is the
 *   status after the call (= from when unchanged).
 * @throws InventoryError VALIDATION (poId | target), NOT_FOUND when the PO does not exist.
 */
export async function advanceLegacyPoStatus(t, poId, target) {
  const id = Number(poId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new InventoryError('VALIDATION', 'Invalid purchase order', { field: 'poId' });
  }
  const targetRank = LEGACY_PO_STATUS_ORDER.indexOf(target);
  if (targetRank < 0) {
    throw new InventoryError('VALIDATION', `Unsupported PO status "${target}"`, { field: 'target' });
  }

  const row = await t.oneOrNone(`SELECT status FROM tbl_rfq_purchase_order WHERE id = $1 FOR UPDATE`, [id]);
  if (!row) throw new InventoryError('NOT_FOUND', 'Purchase order not found');

  const from = row.status;
  const rank = LEGACY_PO_STATUS_ORDER.indexOf(from);
  if (rank < 0 || rank >= targetRank) return { from, to: from, changed: false };

  await t.none(
    `UPDATE tbl_rfq_purchase_order
        SET status = $2::public.po_status, updated_at = NOW()
      WHERE id = $1 AND status = $3::public.po_status`,
    [id, target, from]
  );
  return { from, to: target, changed: true };
}

export default { advanceLegacyPoStatus, LEGACY_PO_STATUS_ORDER };
