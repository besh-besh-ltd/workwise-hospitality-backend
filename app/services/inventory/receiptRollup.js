// Receipt roll-up: delivery lines → deliveries → PO lines → PO (spec §5.4, §6.6).
//
// tbl_po_delivery_line counters are derived, never incremented: every call to
// recomputePoReceipt rebuilds them from the source rows, so it is safe to call
// after any receiving action, any number of times, and doubles as a repair
// tool:
//   accepted / rejected  Σ tbl_grn_line_alloc of non-draft GRNs (a REVERSAL
//                        GRN's allocations count negative);
//   returned_replace /   Σ tbl_rtv_line of dispatched or closed RTVs, by
//   returned_credit      disposition, spread over the returned GRN line's
//                        allocations (latest allocation first, as reversals);
//   short_closed         Σ tbl_po_short_close close − reopen. A CREDIT return
//                        is short-closed by its own log rows (task B5), so it
//                        is not added here a second time.
// PO line counters are Σ over their delivery lines, and po.receipt_status
// rolls up from the PO line statuses.
//
// Quantities are handled as integers of 1/10000 (NUMERIC(18,4)), so sums and
// comparisons have no float drift.

import { InventoryError } from './errors.js';
import { logger } from '../../util/logger.js';

const SCALE = 10000;

/** A NUMERIC(18,4) value (number or decimal string) as an integer of 1/10000. */
const toQ = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * SCALE) : 0;
};
const qNum = (q) => q / SCALE;
/** Exact decimal string of a 1/10000 integer, for NUMERIC parameters. */
const qStr = (q) => {
  const a = Math.abs(q);
  return `${q < 0 ? '-' : ''}${Math.floor(a / SCALE)}.${String(a % SCALE).padStart(4, '0')}`;
};

function lineStatusQ({ planned, accepted, returnedReplace = 0, returnedCredit = 0, shortClosed = 0 }) {
  const net = accepted - returnedReplace - returnedCredit;
  if (net >= planned) return 'received';
  if (shortClosed > 0 && net + shortClosed >= planned) return 'short_closed';
  if (net > 0) return 'partial';
  return 'open';
}

/**
 * Status of one delivery line (or a PO line, with planned = ordered), spec §6.6.
 * net = accepted − returnedReplace − returnedCredit;
 *   received      net ≥ planned
 *   short_closed  net + shortClosed ≥ planned, shortClosed > 0
 *   partial       net > 0
 *   open          otherwise
 * Inputs are numbers or decimal strings (4 dp).
 * @returns {'open'|'partial'|'received'|'short_closed'}
 */
export function deriveLineStatus({ planned, accepted, returnedReplace = 0, returnedCredit = 0, shortClosed = 0 } = {}) {
  return lineStatusQ({
    planned: toQ(planned),
    accepted: toQ(accepted),
    returnedReplace: toQ(returnedReplace),
    returnedCredit: toQ(returnedCredit),
    shortClosed: toQ(shortClosed),
  });
}

/**
 * PO receipt status from its line statuses:
 *   all received → received; all received/short_closed with ≥ 1 short_closed
 *   → closed_short; any partial, or a mix → partial; else (all open, or no
 *   lines) → not_received.
 * @returns {'not_received'|'partial'|'received'|'closed_short'}
 */
export function derivePoReceiptStatus(lineStatuses = []) {
  const s = new Set(lineStatuses);
  if (!s.size) return 'not_received';
  if (s.size === 1 && s.has('received')) return 'received';
  if ([...s].every((x) => x === 'received' || x === 'short_closed')) return 'closed_short';
  if (s.has('partial') || s.size > 1) return 'partial';
  return 'not_received';
}

const DELIVERY_STATUS = { received: 'received', closed_short: 'short_closed', partial: 'partial', not_received: 'open' };

/**
 * A delivery's status from its lines. Lines with nothing planned and nothing
 * booked (an unallocated row emptied into hotel rows) do not count; a delivery
 * made only of such lines has nothing left to receive.
 */
function deliveryStatus(lines) {
  const live = lines.filter((l) => l.planned !== 0 || l.accepted !== 0 || l.rejected !== 0 ||
    l.returnedReplace !== 0 || l.returnedCredit !== 0 || l.shortClosed !== 0);
  if (!live.length) return 'received';
  return DELIVERY_STATUS[derivePoReceiptStatus(live.map((l) => l.status))];
}

function rollFromStored(r) {
  const ordered = toQ(r.quantity);
  const accepted = toQ(r.accepted_qty);
  const rejected = toQ(r.rejected_qty);
  const rr = toQ(r.returned_replace_qty);
  const rc = toQ(r.returned_credit_qty);
  const sc = toQ(r.short_closed_qty);
  return {
    id: Number(r.id),
    productName: r.product_name ?? null,
    unit: r.unit,
    orderedQty: qNum(ordered),
    receivedQty: qNum(toQ(r.received_qty)),
    acceptedQty: qNum(accepted),
    rejectedQty: qNum(rejected),
    returnedReplaceQty: qNum(rr),
    returnedCreditQty: qNum(rc),
    shortClosedQty: qNum(sc),
    openQty: qNum(Math.max(0, ordered - (accepted - rr - rc) - sc)),
    receiptStatus: r.receipt_status,
  };
}

function clampQ(value, poId, where) {
  if (value >= 0) return value;
  logger.warn({ poId, ...where, value: qNum(value) }, 'inventory roll-up: negative counter clamped to 0');
  return 0;
}

/**
 * Rebuild every receipt counter and status of one PO from its source rows.
 * Locks the PO row (FOR UPDATE). Writes only rows whose values changed.
 *
 * A legacy PO received before the module (receipt_legacy && receipt_status
 * 'received') with no plan rows is left untouched and reported as stored.
 *
 * @returns {Promise<{receiptStatus:string, lines:Array<{id, productName, unit,
 *   orderedQty, receivedQty, acceptedQty, rejectedQty, returnedReplaceQty,
 *   returnedCreditQty, shortClosedQty, openQty, receiptStatus}>}>}
 *   lines = PoLineRoll[] ordered by PO line id; quantities are numbers;
 *   openQty = max(0, ordered − net − shortClosed).
 * @throws InventoryError VALIDATION (poId), NOT_FOUND when the PO does not exist.
 */
export async function recomputePoReceipt(t, poId) {
  const id = Number(poId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new InventoryError('VALIDATION', 'Invalid purchase order', { field: 'poId' });
  }
  const head = await t.oneOrNone(
    `SELECT id, receipt_status, receipt_legacy FROM tbl_rfq_purchase_order WHERE id = $1 FOR UPDATE`,
    [id]
  );
  if (!head) throw new InventoryError('NOT_FOUND', 'Purchase order not found');

  const poLines = await t.any(
    `SELECT pop.id, pop.unit, pop.quantity::text AS quantity,
            pop.received_qty::text AS received_qty, pop.accepted_qty::text AS accepted_qty,
            pop.rejected_qty::text AS rejected_qty, pop.returned_replace_qty::text AS returned_replace_qty,
            pop.returned_credit_qty::text AS returned_credit_qty, pop.short_closed_qty::text AS short_closed_qty,
            pop.receipt_status, pv.name AS product_name
       FROM tbl_purchase_order_product pop
       LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       LEFT JOIN tbl_product_variant pv ON pv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
      WHERE pop.purchase_order_id = $1
      ORDER BY pop.id`,
    [id]
  );
  const deliveries = await t.any(`SELECT id, status FROM tbl_po_delivery WHERE po_id = $1 ORDER BY id`, [id]);

  if (!deliveries.length && head.receipt_legacy && head.receipt_status === 'received') {
    return { receiptStatus: head.receipt_status, lines: poLines.map(rollFromStored) };
  }

  const stored = await t.any(
    `SELECT dl.id, dl.delivery_id, dl.po_line_id, dl.planned_qty::text AS planned_qty,
            dl.accepted_qty::text AS accepted_qty, dl.rejected_qty::text AS rejected_qty,
            dl.returned_replace_qty::text AS returned_replace_qty,
            dl.returned_credit_qty::text AS returned_credit_qty,
            dl.short_closed_qty::text AS short_closed_qty, dl.status
       FROM tbl_po_delivery_line dl
       JOIN tbl_po_delivery d ON d.id = dl.delivery_id
      WHERE d.po_id = $1
      ORDER BY dl.id`,
    [id]
  );
  const dl = new Map(
    stored.map((r) => [
      Number(r.id),
      {
        id: Number(r.id),
        deliveryId: Number(r.delivery_id),
        poLineId: Number(r.po_line_id),
        planned: toQ(r.planned_qty),
        accepted: 0,
        rejected: 0,
        returnedReplace: 0,
        returnedCredit: 0,
        shortClosed: 0,
        status: 'open',
        stored: r,
      },
    ])
  );

  // GRN allocations, net per (receipt line, delivery line). Reversal lines are
  // grouped under the receipt line they reverse, so a return can be spread
  // over what is still accepted from that receipt line.
  const allocs = await t.any(
    `SELECT COALESCE(gl.reverses_grn_line_id, gl.id) AS receipt_line_id,
            a.delivery_line_id,
            MIN(a.id) AS first_alloc_id,
            SUM(CASE WHEN g.doc_type = 'REVERSAL' THEN -ABS(a.accepted_qty) ELSE a.accepted_qty END)::text AS accepted,
            SUM(CASE WHEN g.doc_type = 'REVERSAL' THEN -ABS(a.rejected_qty) ELSE a.rejected_qty END)::text AS rejected
       FROM tbl_grn_line_alloc a
       JOIN tbl_grn_line gl ON gl.id = a.grn_line_id
       JOIN tbl_grn g ON g.id = gl.grn_id
      WHERE g.po_id = $1 AND g.status <> 'draft'
      GROUP BY 1, 2`,
    [id]
  );
  const byReceiptLine = new Map();
  for (const a of allocs) {
    const row = dl.get(Number(a.delivery_line_id));
    if (!row) continue; // not a delivery line of this PO
    const accepted = toQ(a.accepted);
    row.accepted += accepted;
    row.rejected += toQ(a.rejected);
    const key = Number(a.receipt_line_id);
    if (!byReceiptLine.has(key)) byReceiptLine.set(key, []);
    byReceiptLine.get(key).push({ row, firstAllocId: Number(a.first_alloc_id), returnable: Math.max(0, accepted) });
  }
  for (const list of byReceiptLine.values()) list.sort((x, y) => y.firstAllocId - x.firstAllocId);

  // Returns to vendor that have left the building.
  const rtvLines = await t.any(
    `SELECT rl.id, rl.grn_line_id, r.disposition, rl.qty::text AS qty
       FROM tbl_rtv_line rl
       JOIN tbl_rtv r ON r.id = rl.rtv_id
      WHERE r.po_id = $1 AND r.status IN ('dispatched', 'closed')
      ORDER BY rl.id`,
    [id]
  );
  for (const r of rtvLines) {
    const field = r.disposition === 'CREDIT' ? 'returnedCredit' : 'returnedReplace';
    const targets = byReceiptLine.get(Number(r.grn_line_id)) || [];
    let left = toQ(r.qty);
    if (!targets.length) {
      logger.warn({ poId: id, rtvLineId: Number(r.id) }, 'inventory roll-up: RTV line has no GRN allocation to return against');
      continue;
    }
    for (const target of targets) {
      const take = Math.min(left, target.returnable);
      if (take > 0) {
        target.row[field] += take;
        target.returnable -= take;
        left -= take;
      }
      if (left === 0) break;
    }
    if (left > 0) {
      // More returned than is still accepted: keep the total on the latest allocation.
      logger.warn({ poId: id, rtvLineId: Number(r.id), excess: qNum(left) }, 'inventory roll-up: RTV exceeds accepted qty');
      targets[0].row[field] += left;
    }
  }

  // Short-close log: close minus reopen.
  const closes = await t.any(
    `SELECT sc.delivery_line_id,
            SUM(CASE WHEN sc.action = 'close' THEN sc.qty ELSE -sc.qty END)::text AS qty
       FROM tbl_po_short_close sc
      WHERE sc.po_id = $1
      GROUP BY sc.delivery_line_id`,
    [id]
  );
  for (const c of closes) {
    const row = dl.get(Number(c.delivery_line_id));
    if (row) row.shortClosed += toQ(c.qty);
  }

  // Delivery lines.
  const changedLines = [];
  for (const row of dl.values()) {
    for (const f of ['accepted', 'rejected', 'returnedReplace', 'returnedCredit', 'shortClosed']) {
      row[f] = clampQ(row[f], id, { deliveryLineId: row.id, field: f });
    }
    row.status = lineStatusQ(row);
    const s = row.stored;
    if (
      row.accepted !== toQ(s.accepted_qty) || row.rejected !== toQ(s.rejected_qty) ||
      row.returnedReplace !== toQ(s.returned_replace_qty) || row.returnedCredit !== toQ(s.returned_credit_qty) ||
      row.shortClosed !== toQ(s.short_closed_qty) || row.status !== s.status
    ) {
      changedLines.push(row);
    }
  }
  if (changedLines.length) {
    await t.none(
      `UPDATE tbl_po_delivery_line dl
          SET accepted_qty = v.accepted, rejected_qty = v.rejected,
              returned_replace_qty = v.returned_replace, returned_credit_qty = v.returned_credit,
              short_closed_qty = v.short_closed, status = v.status, updated_at = now()
         FROM unnest($1::int[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::text[])
              AS v(id, accepted, rejected, returned_replace, returned_credit, short_closed, status)
        WHERE dl.id = v.id`,
      [
        changedLines.map((r) => r.id),
        changedLines.map((r) => qStr(r.accepted)),
        changedLines.map((r) => qStr(r.rejected)),
        changedLines.map((r) => qStr(r.returnedReplace)),
        changedLines.map((r) => qStr(r.returnedCredit)),
        changedLines.map((r) => qStr(r.shortClosed)),
        changedLines.map((r) => r.status),
      ]
    );
  }

  // Deliveries.
  const linesByDelivery = new Map();
  for (const row of dl.values()) {
    if (!linesByDelivery.has(row.deliveryId)) linesByDelivery.set(row.deliveryId, []);
    linesByDelivery.get(row.deliveryId).push(row);
  }
  const changedDeliveries = [];
  for (const d of deliveries) {
    const lines = linesByDelivery.get(Number(d.id));
    if (!lines) continue; // an empty delivery keeps its status
    const status = deliveryStatus(lines);
    if (status !== d.status) changedDeliveries.push({ id: Number(d.id), status });
  }
  if (changedDeliveries.length) {
    await t.none(
      `UPDATE tbl_po_delivery d SET status = v.status, updated_at = now()
         FROM unnest($1::int[], $2::text[]) AS v(id, status)
        WHERE d.id = v.id`,
      [changedDeliveries.map((d) => d.id), changedDeliveries.map((d) => d.status)]
    );
  }

  // PO lines: Σ over their delivery lines; status against the ordered qty.
  const sums = new Map();
  for (const row of dl.values()) {
    const s = sums.get(row.poLineId) || { accepted: 0, rejected: 0, returnedReplace: 0, returnedCredit: 0, shortClosed: 0 };
    s.accepted += row.accepted;
    s.rejected += row.rejected;
    s.returnedReplace += row.returnedReplace;
    s.returnedCredit += row.returnedCredit;
    s.shortClosed += row.shortClosed;
    sums.set(row.poLineId, s);
  }
  const rolls = [];
  const changedPoLines = [];
  for (const p of poLines) {
    const s = sums.get(Number(p.id)) || { accepted: 0, rejected: 0, returnedReplace: 0, returnedCredit: 0, shortClosed: 0 };
    const ordered = toQ(p.quantity);
    const received = s.accepted + s.rejected;
    const status = lineStatusQ({ planned: ordered, ...s });
    const net = s.accepted - s.returnedReplace - s.returnedCredit;
    rolls.push({
      id: Number(p.id),
      productName: p.product_name ?? null,
      unit: p.unit,
      orderedQty: qNum(ordered),
      receivedQty: qNum(received),
      acceptedQty: qNum(s.accepted),
      rejectedQty: qNum(s.rejected),
      returnedReplaceQty: qNum(s.returnedReplace),
      returnedCreditQty: qNum(s.returnedCredit),
      shortClosedQty: qNum(s.shortClosed),
      openQty: qNum(Math.max(0, ordered - net - s.shortClosed)),
      receiptStatus: status,
    });
    if (
      received !== toQ(p.received_qty) || s.accepted !== toQ(p.accepted_qty) || s.rejected !== toQ(p.rejected_qty) ||
      s.returnedReplace !== toQ(p.returned_replace_qty) || s.returnedCredit !== toQ(p.returned_credit_qty) ||
      s.shortClosed !== toQ(p.short_closed_qty) || status !== p.receipt_status
    ) {
      changedPoLines.push({ id: Number(p.id), received, ...s, status });
    }
  }
  if (changedPoLines.length) {
    await t.none(
      `UPDATE tbl_purchase_order_product p
          SET received_qty = v.received, accepted_qty = v.accepted, rejected_qty = v.rejected,
              returned_replace_qty = v.returned_replace, returned_credit_qty = v.returned_credit,
              short_closed_qty = v.short_closed, receipt_status = v.status
         FROM unnest($1::int[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[],
                     $7::numeric[], $8::text[])
              AS v(id, received, accepted, rejected, returned_replace, returned_credit, short_closed, status)
        WHERE p.id = v.id`,
      [
        changedPoLines.map((r) => r.id),
        changedPoLines.map((r) => qStr(r.received)),
        changedPoLines.map((r) => qStr(r.accepted)),
        changedPoLines.map((r) => qStr(r.rejected)),
        changedPoLines.map((r) => qStr(r.returnedReplace)),
        changedPoLines.map((r) => qStr(r.returnedCredit)),
        changedPoLines.map((r) => qStr(r.shortClosed)),
        changedPoLines.map((r) => r.status),
      ]
    );
  }

  const receiptStatus = derivePoReceiptStatus(rolls.map((r) => r.receiptStatus));
  if (receiptStatus !== head.receipt_status) {
    await t.none(`UPDATE tbl_rfq_purchase_order SET receipt_status = $2 WHERE id = $1`, [id, receiptStatus]);
  }
  return { receiptStatus, lines: rolls };
}

export default { deriveLineStatus, derivePoReceiptStatus, recomputePoReceipt };
