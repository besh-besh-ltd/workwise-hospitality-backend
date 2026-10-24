// GRN reversal (part of the GRN service; import from grnService.js): a posted
// REVERSAL document with negative allocations, latest phase first, and the
// ledger rows that undo the receipt. Same lock order as posting (see
// grnService.js).

import { InventoryError } from './errors.js';
import { nextDocNumber } from './docNumber.js';
import { postMovements } from './ledger.js';
import { getPoContext } from './planCore.js';
import { loadPlan } from './allocation.js';
import {
  IST_TODAY, positiveInt, toQ, qNum, qStr, round4, numOrNull, textOrNull, invalid, quantityQ, assertGrnAccess,
  loadGrnRow, insertGrnLine, afterReceiptChange,
} from './grnCommon.js';
import { getGrnPayload } from './grnRead.js';

// ---------------------------------------------------------------------------
// reversal
// ---------------------------------------------------------------------------

/**
 * Reverse a posted receipt in full (lines 'all') or in part
 * ([{grnLineId, qty}], accepted qty in PO units). Creates a posted REVERSAL
 * GRN whose lines name the receipt line they reverse (reverses_grn_line_id)
 * and whose allocations are negative, latest phase first; posts GRN_REVERSAL
 * at the receipt's unit cost (a line marked out on arrival first takes its
 * mark-out back with RETURN_IN at the mark-out cost, same batch and expiry,
 * reason GRN_REVERSAL). Refused (NEGATIVE_STOCK, details name the
 * item and the shortfall) when the stock has already been marked out, and
 * (CONFLICT) below what returns to vendor already cover.
 *
 * @returns {Promise<{grn:object, original:{id, status, companyId, hotelId, grnNumber}}>}
 */
export async function reverseGrn(t, user, { grnId, reason, lines } = {}) {
  const why = textOrNull(reason);
  if (!why) throw invalid('Give a reason for the reversal', { field: 'reason' });
  const first = await loadGrnRow(t, grnId);
  await assertGrnAccess(t, user, first, 'approve');
  const userId = positiveInt(user?.id);

  // Lock order: PO row → delivery lines → GRN → sequence → balances.
  const ctx = await getPoContext(t, first.po_id, { forUpdate: true });
  const plan = await loadPlan(t, ctx.po.id, { lock: true });
  const grn = await loadGrnRow(t, first.id, { forUpdate: true });
  if (grn.doc_type !== 'RECEIPT' || !['posted', 'partially_reversed'].includes(grn.status)) {
    throw new InventoryError('CONFLICT', 'Only a posted receipt can be reversed', { grnId: grn.id, status: grn.status });
  }

  const original = await t.any(
    `SELECT gl.id, gl.po_line_id, gl.product_variant_id, gl.inv_item_id, gl.po_uom,
            gl.accepted_qty::text AS accepted, gl.rejected_qty::text AS rejected, gl.rejection_reason,
            gl.uom_factor::text AS uom_factor, gl.unit_cost::text AS unit_cost, gl.mark_out_department_id,
            gl.batch_no, gl.mfg_date::text AS mfg_date, gl.expiry_date::text AS expiry_date,
            COALESCE((SELECT SUM(rl.accepted_qty) FROM tbl_grn_line rl JOIN tbl_grn rg ON rg.id = rl.grn_id
                       WHERE rl.reverses_grn_line_id = gl.id AND rg.status <> 'draft'), 0)::text AS rev_accepted,
            COALESCE((SELECT SUM(rl.rejected_qty) FROM tbl_grn_line rl JOIN tbl_grn rg ON rg.id = rl.grn_id
                       WHERE rl.reverses_grn_line_id = gl.id AND rg.status <> 'draft'), 0)::text AS rev_rejected,
            COALESCE((SELECT SUM(vl.qty) FROM tbl_rtv_line vl JOIN tbl_rtv v ON v.id = vl.rtv_id
                       WHERE vl.grn_line_id = gl.id AND v.status <> 'cancelled'), 0)::text AS rtv_qty,
            pv.name AS product_name
       FROM tbl_grn_line gl
       LEFT JOIN tbl_product_variant pv ON pv.id = gl.product_variant_id
      WHERE gl.grn_id = $1
      ORDER BY gl.id`,
    [grn.id]
  );
  const byId = new Map(original.map((l) => [Number(l.id), l]));
  const remaining = (l) => ({
    acceptedQ: toQ(l.accepted) - toQ(l.rev_accepted),
    rejectedQ: toQ(l.rejected) - toQ(l.rev_rejected),
    rtvQ: toQ(l.rtv_qty),
  });

  // What to reverse, per receipt line.
  const wanted = new Map();
  if (lines === 'all') {
    for (const l of original) {
      const r = remaining(l);
      if (r.acceptedQ > 0 || r.rejectedQ > 0) wanted.set(Number(l.id), { acceptedQ: Math.max(0, r.acceptedQ), rejectedQ: Math.max(0, r.rejectedQ) });
    }
  } else if (Array.isArray(lines)) {
    for (const [index, item] of lines.entries()) {
      const lineId = positiveInt(item?.grnLineId);
      if (!lineId || !byId.has(lineId)) throw invalid('A line is not on this GRN', { field: 'grnLineId', index });
      const q = quantityQ(item.qty, 'qty', index);
      if (q <= 0) throw invalid('Enter a quantity to reverse', { field: 'qty', index, grnLineId: lineId });
      const cur = wanted.get(lineId) || { acceptedQ: 0, rejectedQ: 0 };
      cur.acceptedQ += q;
      wanted.set(lineId, cur);
    }
  } else {
    throw invalid("lines must be 'all' or a list of {grnLineId, qty}", { field: 'lines' });
  }
  if (!wanted.size) throw invalid('Nothing is left to reverse on this GRN', { field: 'lines' });

  for (const [lineId, w] of wanted) {
    const l = byId.get(lineId);
    const r = remaining(l);
    if (w.acceptedQ > r.acceptedQ) {
      throw invalid(`Only ${qNum(Math.max(0, r.acceptedQ))} of ${l.product_name ?? 'this line'} is left to reverse`, {
        field: 'qty', grnLineId: lineId, maxReversible: qNum(Math.max(0, r.acceptedQ)),
      });
    }
    if (r.acceptedQ - w.acceptedQ < r.rtvQ) {
      throw new InventoryError(
        'CONFLICT',
        `${qNum(r.rtvQ)} of ${l.product_name ?? 'this line'} is being returned to the vendor; reverse at most ${qNum(Math.max(0, r.acceptedQ - r.rtvQ))}`,
        { reason: 'RTV_COVERED', grnLineId: lineId, returnedQty: qNum(r.rtvQ), maxReversible: qNum(Math.max(0, r.acceptedQ - r.rtvQ)) }
      );
    }
  }

  // The receipt's allocations, net of earlier reversals, latest phase first.
  const allocRows = await t.any(
    `SELECT COALESCE(gl.reverses_grn_line_id, gl.id) AS receipt_line_id, a.delivery_line_id,
            SUM(CASE WHEN g.doc_type = 'REVERSAL' THEN -ABS(a.accepted_qty) ELSE a.accepted_qty END)::text AS accepted,
            SUM(CASE WHEN g.doc_type = 'REVERSAL' THEN -ABS(a.rejected_qty) ELSE a.rejected_qty END)::text AS rejected,
            MAX(a.id) FILTER (WHERE g.doc_type = 'RECEIPT') AS last_alloc_id
       FROM tbl_grn_line_alloc a
       JOIN tbl_grn_line gl ON gl.id = a.grn_line_id
       JOIN tbl_grn g ON g.id = gl.grn_id
      WHERE COALESCE(gl.reverses_grn_line_id, gl.id) = ANY($1::int[]) AND g.status <> 'draft'
      GROUP BY 1, 2`,
    [[...wanted.keys()]]
  );
  const planLine = new Map(plan.lines.map((l) => [l.id, l]));
  const allocsByLine = new Map();
  for (const a of allocRows) {
    const key = Number(a.receipt_line_id);
    if (!allocsByLine.has(key)) allocsByLine.set(key, []);
    const dl = planLine.get(Number(a.delivery_line_id));
    allocsByLine.get(key).push({
      deliveryLineId: Number(a.delivery_line_id),
      acceptedQ: toQ(a.accepted),
      rejectedQ: toQ(a.rejected),
      phaseNo: dl?.phaseNo ?? 0,
      dueDate: dl?.dueDate ?? null,
      lastAllocId: Number(a.last_alloc_id) || 0,
    });
  }
  const latestFirst = (x, y) => y.phaseNo - x.phaseNo ||
    (x.dueDate === y.dueDate ? 0 : x.dueDate == null ? -1 : y.dueDate == null ? 1 : x.dueDate < y.dueDate ? 1 : -1) ||
    y.lastAllocId - x.lastAllocId;

  // The REVERSAL document.
  const reversal = await t.one(
    `INSERT INTO tbl_grn
       (hospitality_company_id, hotel_id, po_id, doc_type, reverses_grn_id, status, received_at, remarks,
        created_by, updated_by)
     VALUES ($1, $2, $3, 'REVERSAL', $4, 'draft', ${IST_TODAY}, $5, $6, $6)
     RETURNING id, received_at::text AS received_at`,
    [grn.hospitality_company_id, grn.hotel_id, grn.po_id, grn.id, why, userId]
  );
  const reversalId = Number(reversal.id);
  const hotelId = Number(grn.hotel_id);
  const companyId = Number(grn.hospitality_company_id);
  const movements = [];

  for (const [lineId, w] of wanted) {
    const l = byId.get(lineId);
    const factor = numOrNull(l.uom_factor);
    const stockQ = factor == null ? 0 : Math.round(w.acceptedQ * factor);
    const revLineId = await insertGrnLine(t, {
      companyId,
      grnId: reversalId,
      userId,
      line: {
        poLineId: Number(l.po_line_id),
        productVariantId: numOrNull(l.product_variant_id),
        invItemId: numOrNull(l.inv_item_id),
        reversesGrnLineId: lineId,
        poUom: l.po_uom,
        receivedQ: w.acceptedQ + w.rejectedQ,
        acceptedQ: w.acceptedQ,
        rejectedQ: w.rejectedQ,
        rejectionReason: w.rejectedQ > 0 ? l.rejection_reason : null,
        uomFactor: factor,
        stockQ: l.inv_item_id == null ? null : stockQ,
        unitCost: numOrNull(l.unit_cost),
        markOutDepartmentId: numOrNull(l.mark_out_department_id),
        batchNo: l.batch_no,
        mfgDate: l.mfg_date,
        expiryDate: l.expiry_date,
        remarks: null,
      },
    });

    // Negative allocations mirroring the receipt's, latest phase first.
    let accLeft = w.acceptedQ;
    let rejLeft = w.rejectedQ;
    for (const a of (allocsByLine.get(lineId) || []).sort(latestFirst)) {
      const takeA = Math.min(accLeft, Math.max(0, a.acceptedQ));
      const takeR = Math.min(rejLeft, Math.max(0, a.rejectedQ));
      if (takeA > 0 || takeR > 0) {
        await t.none(
          `INSERT INTO tbl_grn_line_alloc (hospitality_company_id, grn_line_id, delivery_line_id, accepted_qty, rejected_qty, created_by)
           VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6)`,
          [companyId, revLineId, a.deliveryLineId, qStr(-takeA), qStr(-takeR), userId]
        );
        accLeft -= takeA;
        rejLeft -= takeR;
      }
      if (accLeft <= 0 && rejLeft <= 0) break;
    }
    if (accLeft > 0 || rejLeft > 0) {
      throw new InventoryError('CONFLICT', 'The receipt allocations do not cover this reversal', {
        grnLineId: lineId, unallocatedQty: qNum(accLeft + rejLeft),
      });
    }

    if (stockQ > 0 && l.inv_item_id != null) {
      const base = {
        companyId,
        hotelId,
        invItemId: Number(l.inv_item_id),
        productVariantId: numOrNull(l.product_variant_id),
        unitCost: numOrNull(l.unit_cost) ?? undefined,
        sourceType: 'GRN',
        sourceId: reversalId,
        sourceLineId: revLineId,
        postedBy: userId,
      };
      const batch = { batchNo: l.batch_no, expiryDate: l.expiry_date };
      if (l.mark_out_department_id != null) {
        // Marked out on arrival: the department hands it back first, at the
        // cost it was marked out at (the average then, not the receipt cost),
        // so RETURN_IN + GRN_REVERSAL undo GRN_IN + MARK_OUT exactly.
        const markOut = await t.oneOrNone(
          `SELECT unit_cost::text AS unit_cost
             FROM tbl_inv_movement
            WHERE source_type = 'GRN' AND source_id = $1 AND source_line_id = $2
              AND movement_type = 'MARK_OUT' AND hospitality_company_id = $3
            ORDER BY id
            LIMIT 1`,
          [grn.id, lineId, companyId]
        );
        if (!markOut) {
          throw new InventoryError('CONFLICT', 'Original mark-out for this line not found', {
            grnId: Number(grn.id), grnLineId: lineId,
          });
        }
        movements.push({
          ...base,
          ...batch,
          type: 'RETURN_IN',
          qty: qStr(stockQ),
          unitCost: Number(markOut.unit_cost),
          departmentId: Number(l.mark_out_department_id),
          reasonCode: 'GRN_REVERSAL',
        });
      }
      movements.push({ ...base, ...batch, type: 'GRN_REVERSAL', qty: qStr(-stockQ) });
    }
  }

  const grnNumber = await nextDocNumber(t, { hotelId, docType: 'GRN', date: reversal.received_at });
  try {
    await postMovements(t, movements);
  } catch (err) {
    if (err instanceof InventoryError && err.code === 'NEGATIVE_STOCK') {
      const d = err.details || {};
      const shortfall = round4(Number(d.requested) - Number(d.available));
      throw new InventoryError(
        'NEGATIVE_STOCK',
        `Cannot reverse: ${shortfall} of ${d.itemName ?? 'this item'} has already left the store ` +
          `(${d.available} in stock, ${d.requested} to reverse)`,
        { ...d, shortfall }
      );
    }
    throw err;
  }

  await t.none(
    `UPDATE tbl_grn SET status = 'posted', grn_number = $2, posted_at = now(), posted_by = $3, received_by = $3,
            updated_at = now(), updated_by = $3
      WHERE id = $1`,
    [reversalId, grnNumber, userId]
  );

  // The receipt is reversed once nothing of it is left.
  const left = await t.one(
    `SELECT bool_and(gl.accepted_qty <= COALESCE(r.acc, 0) AND gl.rejected_qty <= COALESCE(r.rej, 0)) AS fully
       FROM tbl_grn_line gl
       LEFT JOIN (SELECT rl.reverses_grn_line_id AS id, SUM(rl.accepted_qty) AS acc, SUM(rl.rejected_qty) AS rej
                    FROM tbl_grn_line rl JOIN tbl_grn rg ON rg.id = rl.grn_id
                   WHERE rg.reverses_grn_id = $1 AND rg.status <> 'draft'
                   GROUP BY rl.reverses_grn_line_id) r ON r.id = gl.id
      WHERE gl.grn_id = $1`,
    [grn.id]
  );
  const status = left.fully ? 'reversed' : 'partially_reversed';
  await t.none(`UPDATE tbl_grn SET status = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [grn.id, status, userId]);

  await afterReceiptChange(t, Number(grn.po_id), { userId });
  return {
    grn: await getGrnPayload(t, reversalId),
    original: { id: Number(grn.id), status, companyId, hotelId, grnNumber: grn.grn_number },
  };
}
