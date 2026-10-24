// Return to vendor (spec §6.13).
//
// An RTV returns accepted goods from one posted RECEIPT GRN. Each line names a
// GRN line and a qty in the PO unit, up to what that line still has:
//   returnable = accepted − reversed (posted REVERSAL lines) − already on
//                another RTV that is not cancelled (drafts hold their qty).
//
// Lifecycle: draft → dispatched → closed, or draft → cancelled.
//   create    each line's GRN line must carry its stock item and unit
//             conversion (VALIDATION naming the product), so a draft can
//             always be dispatched.
//   dispatch  numbers the RTV (RTV/{doc_code}/{FY}/{seq}), posts RTV_OUT at
//             the GRN line's unit cost (NEGATIVE_STOCK when the goods are no
//             longer there; the ledger guards RTV_OUT always; the stock qty is
//             qty × factor in SQL numeric, rounded to 4 dp, sent as a decimal
//             string), then rolls the PO up. The roll-up counts dispatched/
//             closed RTVs, spread in rtv line id order:
//               REPLACE  returned_replace_qty → the qty is open again;
//               CREDIT   returned_credit_qty, plus tbl_po_short_close rows
//                        (rtv_id set, reason 'other', remarks "RTV <number>
//                        credit") on the same delivery lines the roll-up spread
//                        the credit over, sized by each line's increase in
//                        returned_credit_qty, so the qty does not come back as
//                        open; a call-off gives that qty back to its rate
//                        contract (shortCloseService.closeForCreditReturn).
//             Because of that order, an older draft dispatched after newer
//             returns on the same receipt line would re-spread their credit
//             (moving it off the lines already short-closed for it). After the
//             roll-up, no line's credit may fall and the credit added must be
//             exactly this RTV's CREDIT qty (0 for REPLACE); otherwise CONFLICT
//             and the whole dispatch rolls back. Cancel and raise it again.
//             A credit the roll-up could book nowhere (the receipt line has no
//             delivery allocation) is its own CONFLICT, saying just that.
//   close     CREDIT: records the vendor's credit-note reference.
//             REPLACE: only once every delivery line the returned goods were
//             booked to is received again or short-closed.
//
// Permissions: grn.approve at the GRN's hotel for every action, grn.read to
// view (assertHotelPermission: NOT_FOUND outside the company, FORBIDDEN
// inside it). Lock order (planCore): PO row → delivery lines → balances, and
// nextDocNumber before postMovements (ledger rule b).

import { InventoryError } from './errors.js';
import { assertHotelPermission } from './scope.js';
import { getPoContext } from './planCore.js';
import { recomputePoReceipt } from './receiptRollup.js';
import { nextDocNumber } from './docNumber.js';
import { postMovements } from './ledger.js';
import { closeForCreditReturn } from './shortCloseService.js';

export const RTV_DISPOSITIONS = Object.freeze(['REPLACE', 'CREDIT']);

const TEXT_MAX = 2000;
const REF_MAX = 64;

const SCALE = 10000;
const toQ = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * SCALE) : 0;
};
const qNum = (q) => q / SCALE;
const qStr = (q) => `${Math.floor(q / SCALE)}.${String(q % SCALE).padStart(4, '0')}`; // q > 0 here

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const invalid = (message, details) => new InventoryError('VALIDATION', message, details);
const notFound = () => new InventoryError('NOT_FOUND', 'Return to vendor not found');

function cleanText(v, field, { required = false, max = TEXT_MAX, label = 'This field' } = {}) {
  if (v != null && typeof v !== 'string') throw invalid(`${label} must be text`, { field });
  const s = (v ?? '').trim();
  if (required && !s) throw invalid(`${label} is required`, { field });
  if (s.length > max) throw invalid(`${label} can be at most ${max} characters`, { field });
  return s || null;
}

/** A quantity > 0 with at most 4 decimals, as an integer of 1/10000. */
function parseQty(v, field) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw invalid('Enter a quantity above 0', { field });
  const q = Math.round(n * SCALE);
  if (Math.abs(q / SCALE - n) > 1e-9) throw invalid('Quantities can have at most 4 decimals', { field });
  return q;
}

async function loadRtvRow(t, rtvId, { forUpdate = false } = {}) {
  const id = positiveInt(rtvId);
  if (!id) throw notFound();
  const row = await t.oneOrNone(
    `SELECT id, rtv_number, hospitality_company_id, po_id, grn_id, hotel_id, disposition, status,
            challan_no, credit_note_ref, remarks
       FROM tbl_rtv WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id]
  );
  if (!row) throw notFound();
  return row;
}

/** Gate on the RTV's (or GRN's) hotel; a refusal outside the company reads as "not found". */
async function gate(t, user, hotelId, action) {
  try {
    return await assertHotelPermission(t, user, { resource: 'grn', action, hotelId });
  } catch (err) {
    if (err instanceof InventoryError && err.code === 'NOT_FOUND') throw notFound();
    throw err;
  }
}

/**
 * Returnable qty per GRN line: accepted − reversed − on other live RTVs.
 * @returns {Promise<Map<number, {accepted:number, returnable:number}>>} in 1/10000
 */
async function returnableByLine(t, grnId, { excludeRtvId = null } = {}) {
  const rows = await t.any(
    `SELECT gl.id, gl.accepted_qty::text AS accepted,
            COALESCE((SELECT SUM(ABS(r.accepted_qty))
                        FROM tbl_grn_line r JOIN tbl_grn rg ON rg.id = r.grn_id
                       WHERE r.reverses_grn_line_id = gl.id AND rg.doc_type = 'REVERSAL'
                         AND rg.status <> 'draft'), 0)::text AS reversed,
            COALESCE((SELECT SUM(rl.qty)
                        FROM tbl_rtv_line rl JOIN tbl_rtv rv ON rv.id = rl.rtv_id
                       WHERE rl.grn_line_id = gl.id AND rv.status <> 'cancelled'
                         AND ($2::int IS NULL OR rv.id <> $2)), 0)::text AS returned
       FROM tbl_grn_line gl
      WHERE gl.grn_id = $1`,
    [grnId, excludeRtvId]
  );
  return new Map(rows.map((r) => [
    Number(r.id),
    { accepted: toQ(r.accepted), returnable: Math.max(0, toQ(r.accepted) - toQ(r.reversed) - toQ(r.returned)) },
  ]));
}

/**
 * The product name the documents use (grnPdf): the catalogue variant, else the
 * stock item's display name. PRODUCT_JOINS expects the GRN line as `gl`.
 */
const PRODUCT_JOINS = `
       JOIN tbl_purchase_order_product pop ON pop.id = gl.po_line_id
       LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       LEFT JOIN tbl_product_variant pv
              ON pv.id = COALESCE(gl.product_variant_id, pop.product_variant_id, rp.product_variant_id)
       LEFT JOIN tbl_inv_item ii ON ii.id = gl.inv_item_id`;
const PRODUCT_NAME = 'COALESCE(pv.name, ii.display_name)';

/** The GRN line's PO-unit → stock-unit factor (SQL; NULL when it has none). Never a silent 1. */
const STOCK_FACTOR = `CASE WHEN gl.uom_factor > 0 THEN gl.uom_factor
                           WHEN gl.stock_qty > 0 AND gl.accepted_qty > 0 THEN gl.stock_qty / gl.accepted_qty
                      END`;

/** Every line returned must say which stock item it moves and how to convert its qty. */
async function assertStockable(t, lines) {
  const rows = await t.any(
    `SELECT gl.id, gl.inv_item_id, (${STOCK_FACTOR}) IS NOT NULL AS has_factor, ${PRODUCT_NAME} AS product_name
       FROM tbl_grn_line gl
       ${PRODUCT_JOINS}
      WHERE gl.id = ANY($1::int[])`,
    [lines.map((l) => l.grnLineId)]
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  lines.forEach((l, i) => {
    const r = byId.get(l.grnLineId);
    if (r && r.inv_item_id != null && r.has_factor) return;
    const name = r?.product_name || 'This product';
    throw invalid(`${name} has no stock item or unit conversion on this receipt, so it can't be returned`, {
      field: `lines[${i}].grnLineId`, grnLineId: l.grnLineId,
    });
  });
}

function assertReturnable(lines, returnable) {
  const missing = lines.filter((l) => !returnable.has(l.grnLineId)).map((l) => l.grnLineId);
  if (missing.length) {
    throw new InventoryError('NOT_FOUND', 'Some lines are not on this goods receipt', { grnLineIds: missing });
  }
  for (const l of lines) {
    const left = returnable.get(l.grnLineId).returnable;
    if (l.qty > left) {
      throw invalid(`Only ${qNum(left)} of this line can be returned`, {
        field: 'lines', grnLineId: l.grnLineId, returnable: qNum(left), requested: qNum(l.qty),
      });
    }
  }
}

/**
 * The RTV as the API returns it (contract `Rtv`). pdfUrl is filled by the
 * controller, which renders the challan outside the transaction.
 */
export async function rtvView(t, rtvId) {
  const rtv = await t.oneOrNone(
    `SELECT r.id, r.rtv_number, r.hospitality_company_id, r.po_id, po.po_number, r.grn_id, g.grn_number,
            r.hotel_id, h.name AS hotel_name, r.disposition, r.status, r.challan_no, r.credit_note_ref,
            r.remarks, r.created_at, r.updated_at
       FROM tbl_rtv r
       JOIN tbl_grn g ON g.id = r.grn_id
       JOIN tbl_rfq_purchase_order po ON po.id = r.po_id
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = r.hotel_id
      WHERE r.id = $1`,
    [rtvId]
  );
  if (!rtv) throw notFound();
  const lines = await t.any(
    `SELECT rl.id, rl.grn_line_id, gl.po_line_id, ${PRODUCT_NAME} AS product_name, gl.po_uom AS unit,
            rl.qty::text AS qty, rl.reason
       FROM tbl_rtv_line rl
       JOIN tbl_grn_line gl ON gl.id = rl.grn_line_id
       ${PRODUCT_JOINS}
      WHERE rl.rtv_id = $1
      ORDER BY rl.id`,
    [rtvId]
  );
  return {
    id: Number(rtv.id),
    rtvNumber: rtv.rtv_number ?? null,
    companyId: Number(rtv.hospitality_company_id),
    poId: Number(rtv.po_id),
    poNumber: rtv.po_number ?? null,
    grnId: Number(rtv.grn_id),
    grnNumber: rtv.grn_number ?? null,
    hotelId: Number(rtv.hotel_id),
    hotelName: rtv.hotel_name ?? null,
    disposition: rtv.disposition,
    status: rtv.status,
    challanNo: rtv.challan_no ?? null,
    creditNoteRef: rtv.credit_note_ref ?? null,
    remarks: rtv.remarks ?? null,
    createdAt: new Date(rtv.created_at).toISOString(),
    updatedAt: new Date(rtv.updated_at).toISOString(),
    lines: lines.map((l) => ({
      id: Number(l.id),
      grnLineId: Number(l.grn_line_id),
      poLineId: Number(l.po_line_id),
      productName: l.product_name ?? null,
      unit: l.unit ?? null,
      qty: Number(l.qty),
      reason: l.reason ?? null,
    })),
    pdfUrl: null,
  };
}

/**
 * Draft an RTV against a posted receipt.
 * @param {{grnId:number, disposition:'REPLACE'|'CREDIT', remarks?:string,
 *          lines:Array<{grnLineId:number, qty:number, reason:string}>}} input
 * @returns {Promise<Rtv>}
 * @throws InventoryError NOT_FOUND (GRN / line / out of company), FORBIDDEN
 *   (no grn.approve at the hotel), VALIDATION (shape, qty above returnable, a
 *   line with no stock item or unit conversion, named), CONFLICT (not a posted
 *   receipt).
 */
export async function createRtv(t, user, { grnId, disposition, remarks, lines } = {}) {
  const gid = positiveInt(grnId);
  const grn = gid
    ? await t.oneOrNone(
      `SELECT id, hospitality_company_id, po_id, hotel_id, doc_type, status FROM tbl_grn WHERE id = $1`,
      [gid]
    )
    : null;
  if (!grn) throw new InventoryError('NOT_FOUND', 'Goods receipt not found');
  const { companyId } = await gate(t, user, grn.hotel_id, 'approve');
  if (Number(grn.hospitality_company_id) !== companyId) throw new InventoryError('NOT_FOUND', 'Goods receipt not found');

  if (!RTV_DISPOSITIONS.includes(disposition)) {
    throw invalid('Choose REPLACE or CREDIT', { field: 'disposition', allowed: RTV_DISPOSITIONS });
  }
  const note = cleanText(remarks, 'remarks', { label: 'Remarks' });
  if (!Array.isArray(lines) || !lines.length) throw invalid('Add at least one line to return', { field: 'lines' });
  const parsed = lines.map((l, i) => {
    const grnLineId = positiveInt(l?.grnLineId);
    if (!grnLineId) throw invalid('Each line needs its goods receipt line', { field: `lines[${i}].grnLineId` });
    return {
      grnLineId,
      qty: parseQty(l?.qty, `lines[${i}].qty`),
      reason: cleanText(l?.reason, `lines[${i}].reason`, { required: true, label: 'The reason for the return' }),
    };
  });
  if (new Set(parsed.map((l) => l.grnLineId)).size !== parsed.length) {
    throw invalid('Each goods receipt line can appear once', { field: 'lines' });
  }
  if (grn.doc_type !== 'RECEIPT' || !['posted', 'partially_reversed'].includes(grn.status)) {
    throw new InventoryError('CONFLICT', 'Only a posted goods receipt can be returned to the vendor', {
      grnId: gid, docType: grn.doc_type, status: grn.status,
    });
  }

  await getPoContext(t, grn.po_id, { forUpdate: true }); // serialise with receipts, reversals and other returns
  assertReturnable(parsed, await returnableByLine(t, gid));
  await assertStockable(t, parsed);

  const userId = positiveInt(user?.id);
  const rtv = await t.one(
    `INSERT INTO tbl_rtv (hospitality_company_id, po_id, grn_id, hotel_id, disposition, status, remarks, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $7) RETURNING id`,
    [companyId, grn.po_id, gid, grn.hotel_id, disposition, note, userId]
  );
  await t.none(
    `INSERT INTO tbl_rtv_line (hospitality_company_id, rtv_id, grn_line_id, qty, reason, created_by)
     SELECT $1, $2, v.grn_line_id, v.qty, v.reason, $6
       FROM unnest($3::int[], $4::numeric[], $5::text[]) WITH ORDINALITY AS v(grn_line_id, qty, reason, ord)
      ORDER BY v.ord`,
    [companyId, rtv.id, parsed.map((l) => l.grnLineId), parsed.map((l) => qStr(l.qty)), parsed.map((l) => l.reason), userId]
  );
  return rtvView(t, Number(rtv.id));
}

/** Load, gate, lock the PO and then the RTV, in that order. Returns the locked RTV row and the PO context. */
async function lockForAction(t, user, rtvId, action) {
  const first = await loadRtvRow(t, rtvId);
  const { companyId } = await gate(t, user, first.hotel_id, action);
  if (Number(first.hospitality_company_id) !== companyId) throw notFound();
  const ctx = await getPoContext(t, first.po_id, { forUpdate: true });
  return { rtv: await loadRtvRow(t, first.id, { forUpdate: true }), ctx };
}

const wrongStatus = (rtv, verb) =>
  new InventoryError('CONFLICT', `A ${rtv.status} return cannot be ${verb}`, { rtvId: Number(rtv.id), status: rtv.status });

async function deliveryCredits(t, poId) {
  const rows = await t.any(
    `SELECT dl.id, dl.returned_credit_qty::text AS credit
       FROM tbl_po_delivery_line dl JOIN tbl_po_delivery d ON d.id = dl.delivery_id
      WHERE d.po_id = $1`,
    [poId]
  );
  return new Map(rows.map((r) => [Number(r.id), toQ(r.credit)]));
}

/**
 * Send the goods back: number the RTV, post RTV_OUT, roll the PO up.
 * @param {{challanNo?:string}} input the hotel's own gate pass / challan number
 * @returns {Promise<Rtv>}
 * @throws InventoryError CONFLICT (not a draft; later returns on the same
 *   receipt were dispatched first; a CREDIT on a receipt line booked to no
 *   delivery; nothing written), VALIDATION (returnable
 *   shrank since the draft), NEGATIVE_STOCK (goods already marked out), and the gate's.
 */
export async function dispatchRtv(t, user, rtvId, { challanNo } = {}) {
  const { rtv, ctx } = await lockForAction(t, user, rtvId, 'approve');
  if (rtv.status !== 'draft') throw wrongStatus(rtv, 'dispatched');
  const challan = cleanText(challanNo, 'challanNo', { max: REF_MAX, label: 'The challan number' });
  const rtvIdN = Number(rtv.id);
  const poId = Number(rtv.po_id);

  // Stock qty = qty × factor in numeric, 4 dp half-up (the ledger's scale).
  const lines = await t.any(
    `SELECT rl.id, rl.grn_line_id, rl.qty::text AS qty, gl.inv_item_id, gl.product_variant_id,
            ROUND(rl.qty * (${STOCK_FACTOR}), 4)::text AS stock_out,
            gl.unit_cost::text AS unit_cost, gl.batch_no, gl.expiry_date::text AS expiry_date
       FROM tbl_rtv_line rl JOIN tbl_grn_line gl ON gl.id = rl.grn_line_id
      WHERE rl.rtv_id = $1
      ORDER BY rl.id`,
    [rtvIdN]
  );
  assertReturnable(
    lines.map((l) => ({ grnLineId: Number(l.grn_line_id), qty: toQ(l.qty) })),
    await returnableByLine(t, Number(rtv.grn_id), { excludeRtvId: rtvIdN })
  );

  // The delivery lines' credit before this return, from fresh source rows.
  await recomputePoReceipt(t, poId);
  const creditBefore = await deliveryCredits(t, poId);

  const rtvNumber = await nextDocNumber(t, { hotelId: Number(rtv.hotel_id), docType: 'RTV' });
  const movements = lines.map((l) => {
    // createRtv refuses such lines; a draft from before that check still stops here.
    if (l.stock_out == null || l.inv_item_id == null) {
      throw new InventoryError('CONFLICT', 'This receipt line has no stock item or unit conversion to return against', {
        grnLineId: Number(l.grn_line_id),
      });
    }
    return {
      companyId: Number(rtv.hospitality_company_id),
      hotelId: Number(rtv.hotel_id),
      invItemId: Number(l.inv_item_id),
      productVariantId: l.product_variant_id == null ? null : Number(l.product_variant_id),
      type: 'RTV_OUT',
      qty: `-${l.stock_out}`,
      unitCost: l.unit_cost == null ? undefined : Number(l.unit_cost),
      batchNo: l.batch_no ?? null,
      expiryDate: l.expiry_date ?? null,
      sourceType: 'RTV',
      sourceId: rtvIdN,
      sourceLineId: Number(l.id),
      postedBy: positiveInt(user?.id),
    };
  });
  await postMovements(t, movements);

  await t.none(
    `UPDATE tbl_rtv SET status = 'dispatched', rtv_number = $2, challan_no = $3, updated_at = now(), updated_by = $4
      WHERE id = $1`,
    [rtvIdN, rtvNumber, challan, positiveInt(user?.id)]
  );
  await recomputePoReceipt(t, poId);

  // The roll-up spread the credit over the returned receipt line's delivery
  // lines (latest allocation first, RTV lines in id order). Only this RTV may
  // add credit, and exactly its own CREDIT qty: an older draft dispatched after
  // newer returns re-spreads theirs, which would over-close (and over-give-back).
  const after = await deliveryCredits(t, poId);
  const deltas = [...new Set([...creditBefore.keys(), ...after.keys()])]
    .map((deliveryLineId) => ({ deliveryLineId, qty: (after.get(deliveryLineId) || 0) - (creditBefore.get(deliveryLineId) || 0) }));
  const added = deltas.reduce((sum, d) => sum + Math.max(d.qty, 0), 0);
  const expected = rtv.disposition === 'CREDIT' ? lines.reduce((sum, l) => sum + toQ(l.qty), 0) : 0;
  const moved = deltas.some((d) => d.qty < 0);
  if (!moved && added < expected) {
    // The roll-up had no delivery line to book the credit to: the receipt line
    // has no allocation (e.g. a legacy-received PO with no deliveries).
    throw new InventoryError(
      'CONFLICT',
      "This receipt line isn't booked to any delivery, so the credit can't be closed against the PO",
      { rtvId: rtvIdN, grnId: Number(rtv.grn_id) }
    );
  }
  if (moved || added !== expected) {
    throw new InventoryError(
      'CONFLICT',
      'Later returns on this receipt were dispatched first. Cancel this draft and raise it again to dispatch it.',
      { rtvId: rtvIdN, grnId: Number(rtv.grn_id) }
    );
  }

  if (rtv.disposition === 'CREDIT') {
    // Short-close exactly those increases.
    const rows = deltas
      .filter((r) => r.qty > 0)
      .map((r) => ({ deliveryLineId: r.deliveryLineId, qty: qNum(r.qty) }));
    if (rows.length) {
      await closeForCreditReturn(t, ctx, { rtvId: rtvIdN, rtvNumber, userId: positiveInt(user?.id), rows });
      await recomputePoReceipt(t, poId);
    }
  }
  return rtvView(t, rtvIdN);
}

/**
 * Close a dispatched RTV.
 * @param {{creditNoteRef?:string}} input required for CREDIT
 * @throws InventoryError CONFLICT (not dispatched; REPLACE not yet replaced,
 *   details.openLines), VALIDATION (creditNoteRef), and the gate's.
 */
export async function closeRtv(t, user, rtvId, { creditNoteRef } = {}) {
  const { rtv } = await lockForAction(t, user, rtvId, 'approve');
  if (rtv.status !== 'dispatched') throw wrongStatus(rtv, 'closed');
  const rtvIdN = Number(rtv.id);

  if (rtv.disposition === 'CREDIT') {
    const ref = cleanText(creditNoteRef, 'creditNoteRef', { required: true, max: REF_MAX, label: "The vendor's credit note reference" });
    await t.none(
      `UPDATE tbl_rtv SET status = 'closed', credit_note_ref = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
      [rtvIdN, ref, positiveInt(user?.id)]
    );
    return rtvView(t, rtvIdN);
  }

  // REPLACE: every delivery line the returned goods were booked to must be
  // received again or short-closed.
  await recomputePoReceipt(t, Number(rtv.po_id));
  const open = await t.any(
    `SELECT DISTINCT dl.id, dl.po_line_id, d.phase_no, d.hotel_id, h.name AS hotel_name,
            GREATEST(dl.planned_qty - (dl.accepted_qty - dl.returned_replace_qty - dl.returned_credit_qty)
                     - dl.short_closed_qty, 0)::float AS open_qty
       FROM tbl_rtv_line rl
       JOIN tbl_grn_line_alloc a ON a.grn_line_id = rl.grn_line_id AND a.accepted_qty > 0
       JOIN tbl_po_delivery_line dl ON dl.id = a.delivery_line_id
       JOIN tbl_po_delivery d ON d.id = dl.delivery_id
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = d.hotel_id
      WHERE rl.rtv_id = $1 AND dl.status NOT IN ('received', 'short_closed')
      ORDER BY d.phase_no, dl.id`,
    [rtvIdN]
  );
  if (open.length) {
    const where = [...new Set(open.map((r) => (r.hotel_name ? `Phase ${r.phase_no} at ${r.hotel_name}` : `Phase ${r.phase_no}`)))];
    throw new InventoryError('CONFLICT', `Receive or short-close the remaining qty on ${where.join(', ')} before closing this return`, {
      rtvId: rtvIdN,
      openLines: open.map((r) => ({
        deliveryLineId: Number(r.id),
        poLineId: Number(r.po_line_id),
        phaseNo: Number(r.phase_no),
        hotelId: r.hotel_id == null ? null : Number(r.hotel_id),
        hotelName: r.hotel_name ?? null,
        openQty: r.open_qty,
      })),
    });
  }
  await t.none(
    `UPDATE tbl_rtv SET status = 'closed', updated_at = now(), updated_by = $2 WHERE id = $1`,
    [rtvIdN, positiveInt(user?.id)]
  );
  return rtvView(t, rtvIdN);
}

/** Cancel a draft RTV (it never moved stock). */
export async function cancelRtv(t, user, rtvId) {
  const { rtv } = await lockForAction(t, user, rtvId, 'approve');
  if (rtv.status !== 'draft') throw wrongStatus(rtv, 'cancelled');
  await t.none(
    `UPDATE tbl_rtv SET status = 'cancelled', updated_at = now(), updated_by = $2 WHERE id = $1`,
    [Number(rtv.id), positiveInt(user?.id)]
  );
  return rtvView(t, Number(rtv.id));
}

/** View an RTV (grn.read at its hotel). */
export async function getRtv(t, user, rtvId) {
  const rtv = await loadRtvRow(t, rtvId);
  const { companyId } = await gate(t, user, rtv.hotel_id, 'read');
  if (Number(rtv.hospitality_company_id) !== companyId) throw notFound();
  return rtvView(t, Number(rtv.id));
}

export default { createRtv, dispatchRtv, closeRtv, cancelRtv, getRtv, rtvView, RTV_DISPOSITIONS };
