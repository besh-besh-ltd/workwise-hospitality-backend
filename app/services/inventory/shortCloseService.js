// Short-close and reopen (spec §6.12).
//
// The buyer closes the undelivered remainder of a PO (the whole PO, one
// delivery/phase, one hotel, or chosen delivery lines) with a reason. Each
// affected delivery line gets one tbl_po_short_close 'close' row sized by its
// open qty at that moment; the roll-up (recomputePoReceipt) then reads the
// line as short_closed. The log is append-only: a reopen is a new 'reopen'
// row for the line's net manually-closed qty.
//
// Call-off POs give the closed qty back to the rate contract in the same
// transaction (callOffPoService.giveBackCallOffQty: contract line + the
// ordering hotel's Group-ARC ledger row); a reopen takes it again by the
// release's rules (reconsumeCallOffQty): the contract line is a hard cap
// (CONFLICT when it is used up), the hotel's share is soft (an over-share is
// logged and returned as callOffOverShare for head office, as at release).
// Contract columns are NUMERIC(15,2): each delivery line's delta is rounded to
// 2 dp half-up once (contractCents), and that same value is given back,
// re-consumed and reported, so a close and its reopen net to zero.
//
// A CREDIT return to vendor closes its returned qty through the same log
// (closeForCreditReturn): rows carry rtv_id, and a call-off gives that qty
// back to the contract too. Credited qty stays closed for good: reopen skips
// rows with rtv_id (turning a credit into a replacement is a decision about
// the return, not a short-close reopen).
//
// Who: the PO's owners, through the PO initiate gate (assertPoInitiateAccess:
// PO read scope → 404, then PO_INITIATE_PERMISSIONS → 403). When: once the
// vendor has accepted the PO. While a PO is 'sent' or 'acceptance_pending'
// the vendor can still reject it (rejectPO), and a rejected call-off gives
// back its full released qty, so a short-close then would hand the same qty
// back twice: VALIDATION until the vendor accepts.
//
// Lock order (planCore): PO row → delivery lines → contract ledger rows.

import { InventoryError } from './errors.js';
import { getPoContext, ensureDefaultPlan } from './planCore.js';
import { recomputePoReceipt } from './receiptRollup.js';
import { assertPoInitiateAccess } from '../../models/purchaseOrderModel.js';
import { giveBackCallOffQty, reconsumeCallOffQty } from '../callOffPoService.js';

export const SHORT_CLOSE_REASONS = Object.freeze([
  'vendor_cannot_supply', 'no_longer_needed', 'substituted', 'price_dispute', 'other',
]);

/** PO statuses that can be short-closed or reopened: accepted by the vendor. */
export const SHORT_CLOSABLE_PO_STATUSES = Object.freeze([
  'approved', 'dispatched', 'GRN', 'invoice_raised', 'completed',
]);

/** Issued but the vendor can still reject it (purchaseOrderController.rejectPO). */
const AWAITING_VENDOR_STATUSES = Object.freeze(['sent', 'acceptance_pending']);

const TARGET_TYPES = ['po', 'delivery', 'hotel', 'lines'];
const REMARKS_MAX = 2000;

const SCALE = 10000;
const toQ = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * SCALE) : 0;
};
const qNum = (q) => q / SCALE;
const qStr = (q) => `${Math.floor(q / SCALE)}.${String(q % SCALE).padStart(4, '0')}`; // q ≥ 0 here

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const invalid = (message, details) => new InventoryError('VALIDATION', message, details);

/** The PO owner gate, with copy that names the action. */
async function assertPoOwner(t, user, poId) {
  try {
    return await assertPoInitiateAccess(user, poId, t);
  } catch (err) {
    if (err?.name === 'PoWritePermissionError') {
      err.message = "Only the purchase order's owners can short-close or reopen its deliveries.";
    }
    throw err;
  }
}

function cleanRemarks(remarks) {
  if (remarks == null) return null;
  if (typeof remarks !== 'string') throw invalid('Remarks must be text', { field: 'remarks' });
  const s = remarks.trim();
  if (s.length > REMARKS_MAX) throw invalid(`Remarks can be at most ${REMARKS_MAX} characters`, { field: 'remarks' });
  return s || null;
}

function idList(v, field) {
  if (!Array.isArray(v) || !v.length) throw invalid('Choose at least one delivery line', { field });
  const ids = v.map(positiveInt);
  if (ids.some((id) => id == null)) throw invalid('Delivery line ids must be positive integers', { field });
  return [...new Set(ids)];
}

function parseTarget(target) {
  if (!target || typeof target !== 'object' || !TARGET_TYPES.includes(target.type)) {
    throw invalid(`Say what to short-close: one of ${TARGET_TYPES.join(', ')}`, { field: 'target' });
  }
  switch (target.type) {
    case 'delivery': {
      const deliveryId = positiveInt(target.deliveryId);
      if (!deliveryId) throw invalid('Choose the delivery to short-close', { field: 'target.deliveryId' });
      return { type: 'delivery', deliveryId };
    }
    case 'hotel': {
      const hotelId = positiveInt(target.hotelId);
      if (!hotelId) throw invalid('Choose the hotel to short-close', { field: 'target.hotelId' });
      return { type: 'hotel', hotelId };
    }
    case 'lines':
      return { type: 'lines', deliveryLineIds: idList(target.deliveryLineIds, 'target.deliveryLineIds') };
    default:
      return { type: 'po' };
  }
}

/** Lock the PO, check it can be short-closed, and return its context. */
async function lockClosablePo(t, poId) {
  const ctx = await getPoContext(t, poId, { forUpdate: true });
  if (AWAITING_VENDOR_STATUSES.includes(ctx.status)) {
    throw invalid('Short-close is available once the vendor accepts the PO', {
      poId: Number(ctx.po.id), status: ctx.status,
    });
  }
  if (!SHORT_CLOSABLE_PO_STATUSES.includes(ctx.status)) {
    throw new InventoryError(
      'CONFLICT',
      ctx.status === 'cancelled' || String(ctx.status).startsWith('rejected')
        ? 'This purchase order is no longer live, so nothing on it can be short-closed or reopened'
        : 'A purchase order can be short-closed once the vendor has accepted it',
      { poId: Number(ctx.po.id), status: ctx.status }
    );
  }
  return ctx;
}

/** The PO's delivery lines with their open qty, locked (FOR UPDATE), in id order. */
async function lockDeliveryLines(t, poId) {
  const rows = await t.any(
    `SELECT dl.id, dl.delivery_id, d.hotel_id, d.phase_no, dl.po_line_id, pop.arc_contract_line_id,
            GREATEST(dl.planned_qty - (dl.accepted_qty - dl.returned_replace_qty - dl.returned_credit_qty)
                     - dl.short_closed_qty, 0)::text AS open_qty
       FROM tbl_po_delivery_line dl
       JOIN tbl_po_delivery d ON d.id = dl.delivery_id
       JOIN tbl_purchase_order_product pop ON pop.id = dl.po_line_id
      WHERE d.po_id = $1
      ORDER BY dl.id
        FOR UPDATE OF dl`,
    [poId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    deliveryId: Number(r.delivery_id),
    hotelId: r.hotel_id == null ? null : Number(r.hotel_id),
    phaseNo: Number(r.phase_no),
    poLineId: Number(r.po_line_id),
    arcContractLineId: r.arc_contract_line_id == null ? null : Number(r.arc_contract_line_id),
    open: toQ(r.open_qty),
  }));
}

function selectTarget(lines, target) {
  switch (target.type) {
    case 'delivery': {
      const picked = lines.filter((l) => l.deliveryId === target.deliveryId);
      if (!picked.length) throw new InventoryError('NOT_FOUND', 'That delivery is not on this purchase order', { deliveryId: target.deliveryId });
      return picked;
    }
    case 'hotel': {
      const picked = lines.filter((l) => l.hotelId === target.hotelId);
      if (!picked.length) throw new InventoryError('NOT_FOUND', 'This purchase order has no deliveries for that hotel', { hotelId: target.hotelId });
      return picked;
    }
    case 'lines':
      return pickLines(lines, target.deliveryLineIds);
    default:
      return lines;
  }
}

function pickLines(lines, ids) {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new InventoryError('NOT_FOUND', 'Some delivery lines are not on this purchase order', { deliveryLineIds: missing });
  }
  return ids.map((id) => byId.get(id)).sort((a, b) => a.id - b.id);
}

/** The ordering hotel of a call-off PO: the requisition's hotel, whose contract share was consumed. */
async function callOffHotelId(t, ctx) {
  const row = await t.oneOrNone(`SELECT hotel_id FROM tbl_material_requisition WHERE id = $1`, [ctx.po.source_mr_id]);
  return positiveInt(row?.hotel_id) ?? ctx.hotelIds[0] ?? null;
}

/** A delivery line's qty (1/10000 units, ≥ 0) in contract cents: 2 dp, half-up. */
const contractCents = (q) => Math.floor((q + 50) / 100);

/**
 * Σ per contract line, for the give-back / re-consume helpers. Each row is
 * rounded to cents once (r.cents when the caller already knows it, else
 * contractCents(r.qty)); lines that round to nothing are left out.
 */
function perContractLine(rows, hotelId) {
  const sums = new Map();
  for (const r of rows) {
    if (!r.arcContractLineId) continue;
    const cents = r.cents ?? contractCents(r.qty);
    sums.set(r.arcContractLineId, (sums.get(r.arcContractLineId) || 0) + cents);
  }
  return [...sums.entries()]
    .filter(([, cents]) => cents > 0)
    .sort(([a], [b]) => a - b)
    .map(([arcContractLineId, cents]) => ({ arcContractLineId, hotelId, qty: cents / 100 }));
}

async function writeLog(t, { companyId, poId, rows, reasonCode, remarks, action, userId, rtvId = null }) {
  const inserted = await t.any(
    `INSERT INTO tbl_po_short_close
       (hospitality_company_id, po_id, delivery_line_id, qty, reason_code, remarks, action, acted_by, rtv_id)
     SELECT $1, $2, v.delivery_line_id, v.qty, $5, $6, $7, $8, $9
       FROM unnest($3::int[], $4::numeric[]) WITH ORDINALITY AS v(delivery_line_id, qty, ord)
      ORDER BY v.ord
     RETURNING id`,
    [companyId, poId, rows.map((r) => r.deliveryLineId), rows.map((r) => qStr(r.qty)), reasonCode, remarks, action, userId, rtvId]
  );
  return inserted.map((r) => Number(r.id));
}

const publicRows = (rows) => rows.map((r) => ({ deliveryLineId: r.deliveryLineId, poLineId: r.poLineId, qty: qNum(r.qty) }));

/**
 * Close the undelivered remainder of a PO.
 *
 * @param {object} t transaction
 * @param {object} user req.user
 * @param {number} poId
 * @param {{target:{type:'po'|'delivery'|'hotel'|'lines', deliveryId?, hotelId?, deliveryLineIds?},
 *          reasonCode:string, remarks?:string}} input
 * @returns {Promise<{poId, poNumber, companyId, hotelIds, shortCloseIds:number[],
 *   closed:Array<{deliveryLineId, poLineId, qty}>,
 *   callOffGiveBack:Array<{arcContractLineId, hotelId, qty}>,
 *   receiptStatus:string, poLines:PoLineRoll[]}>}
 * @throws PoAccessError (404) / PoWritePermissionError (403) from the PO gate;
 *   InventoryError VALIDATION (reason, remarks, target, nothing open),
 *   NOT_FOUND (delivery / hotel / lines not on the PO), CONFLICT (PO not accepted or not live).
 */
export async function shortClose(t, user, poId, { target, reasonCode, remarks } = {}) {
  await assertPoOwner(t, user, poId);

  if (!SHORT_CLOSE_REASONS.includes(reasonCode)) {
    throw invalid('Choose a reason for the short-close', { field: 'reasonCode', allowed: SHORT_CLOSE_REASONS });
  }
  const note = cleanRemarks(remarks);
  if (reasonCode === 'other' && !note) throw invalid('Add remarks when the reason is "other"', { field: 'remarks' });
  const scope = parseTarget(target);

  const ctx = await lockClosablePo(t, poId);
  const id = Number(ctx.po.id);
  await ensureDefaultPlan(t, id, { userId: positiveInt(user?.id) });
  await recomputePoReceipt(t, id); // counters fresh from the source rows before reading open qty

  const lines = selectTarget(await lockDeliveryLines(t, id), scope);
  const rows = lines
    .filter((l) => l.open > 0)
    .map((l) => ({ deliveryLineId: l.id, poLineId: l.poLineId, arcContractLineId: l.arcContractLineId, qty: l.open }));
  if (!rows.length) throw invalid('Nothing is left open to short-close here', { field: 'target' });

  const shortCloseIds = await writeLog(t, {
    companyId: ctx.companyId, poId: id, rows, reasonCode, remarks: note, action: 'close', userId: positiveInt(user?.id),
  });

  let callOffGiveBack = [];
  if (ctx.isCallOff) {
    callOffGiveBack = perContractLine(rows, await callOffHotelId(t, ctx));
    await giveBackCallOffQty(t, { poId: id, lines: callOffGiveBack });
  }

  const roll = await recomputePoReceipt(t, id);
  return {
    poId: id,
    poNumber: ctx.po.po_number ?? null,
    companyId: ctx.companyId,
    hotelIds: ctx.hotelIds,
    shortCloseIds,
    closed: publicRows(rows),
    callOffGiveBack,
    receiptStatus: roll.receiptStatus,
    poLines: roll.lines,
  };
}

/**
 * Reopen short-closed quantity on chosen delivery lines: each line gets a
 * 'reopen' row for its net closed qty (Σ close − Σ reopen) over the buyer's
 * own short-closes. Qty a CREDIT return closed (rows with rtv_id) is never
 * reopened; asking only for that gives VALIDATION "Qty credited by RTV <no>
 * can't be reopened".
 *
 * @param {{deliveryLineIds:number[], remarks:string}} input remarks required
 * @returns {Promise<{poId, poNumber, companyId, hotelIds, shortCloseIds,
 *   reopened:Array<{deliveryLineId, poLineId, qty}>,
 *   callOffReconsume:Array<{arcContractLineId, hotelId, qty}>,
 *   callOffOverShare:Array<{arcId, payload}>, receiptStatus, poLines}>}
 *   callOffOverShare: the ordering hotel went past its Group-ARC share (allowed,
 *   as at release; event-logged here, the caller tells head office after commit).
 * @throws as shortClose; plus CONFLICT from reconsumeCallOffQty when the
 *   contract line has too little left.
 */
export async function reopenShortClose(t, user, poId, { deliveryLineIds, remarks } = {}) {
  await assertPoOwner(t, user, poId);

  const ids = idList(deliveryLineIds, 'deliveryLineIds');
  const note = cleanRemarks(remarks);
  if (!note) throw invalid('Say why the short-close is being reopened', { field: 'remarks' });

  const ctx = await lockClosablePo(t, poId);
  const id = Number(ctx.po.id);
  const lines = pickLines(await lockDeliveryLines(t, id), ids);

  // A reopen always takes a line's whole net, so what is closed now is the
  // close rows since the line's last reopen. Their sum is the reopen qty; the
  // sum of their cents (each rounded as it was given back) is what the
  // contract takes again.
  const logRows = await t.any(
    `SELECT sc.delivery_line_id, sc.action, sc.qty::text AS qty
       FROM tbl_po_short_close sc
      WHERE sc.po_id = $1 AND sc.delivery_line_id = ANY($2::int[]) AND sc.rtv_id IS NULL
      ORDER BY sc.id`,
    [id, lines.map((l) => l.id)]
  );
  const openClose = new Map();
  for (const r of logRows) {
    const lineId = Number(r.delivery_line_id);
    if (r.action !== 'close') { openClose.delete(lineId); continue; }
    const q = toQ(r.qty);
    const acc = openClose.get(lineId) || { qty: 0, cents: 0 };
    openClose.set(lineId, { qty: acc.qty + q, cents: acc.cents + contractCents(q) });
  }
  const rows = lines
    .map((l) => ({
      deliveryLineId: l.id, poLineId: l.poLineId, arcContractLineId: l.arcContractLineId,
      qty: openClose.get(l.id)?.qty || 0, cents: openClose.get(l.id)?.cents || 0,
    }))
    .filter((r) => r.qty > 0);
  if (!rows.length) {
    const credited = await t.any(
      `SELECT DISTINCT rv.rtv_number
         FROM tbl_po_short_close sc JOIN tbl_rtv rv ON rv.id = sc.rtv_id
        WHERE sc.po_id = $1 AND sc.delivery_line_id = ANY($2::int[])
        ORDER BY rv.rtv_number`,
      [id, lines.map((l) => l.id)]
    );
    if (credited.length) {
      const rtvNumbers = credited.map((r) => r.rtv_number);
      throw invalid(`Qty credited by RTV ${rtvNumbers.join(', ')} can't be reopened`, { field: 'deliveryLineIds', rtvNumbers });
    }
    throw invalid('Nothing is short-closed on those lines', { field: 'deliveryLineIds' });
  }

  const shortCloseIds = await writeLog(t, {
    companyId: ctx.companyId, poId: id, rows, reasonCode: null, remarks: note, action: 'reopen', userId: positiveInt(user?.id),
  });

  let callOffReconsume = [];
  let callOffOverShare = [];
  if (ctx.isCallOff) {
    callOffReconsume = perContractLine(rows, await callOffHotelId(t, ctx));
    ({ overShare: callOffOverShare } = await reconsumeCallOffQty(t, { poId: id, lines: callOffReconsume }));
  }

  const roll = await recomputePoReceipt(t, id);
  return {
    poId: id,
    poNumber: ctx.po.po_number ?? null,
    companyId: ctx.companyId,
    hotelIds: ctx.hotelIds,
    shortCloseIds,
    reopened: publicRows(rows),
    callOffReconsume,
    callOffOverShare,
    receiptStatus: roll.receiptStatus,
    poLines: roll.lines,
  };
}

/**
 * Close the qty a CREDIT return to vendor sent back, on the delivery lines the
 * roll-up booked the credit to: one 'close' row per line (reason 'other',
 * remarks "RTV <number> credit", rtv_id set), and on a call-off the same qty
 * goes back to the rate contract (line + the ordering hotel's Group-ARC row).
 * Called by rtvService.dispatchRtv inside its transaction, with the PO locked.
 *
 * @param {object} t transaction
 * @param {object} ctx getPoContext(t, poId) of the RTV's PO
 * @param {{rtvId:number, rtvNumber:string, userId:number|null,
 *          rows:Array<{deliveryLineId:number, qty:number}>}} args qty in PO units
 * @returns {Promise<{shortCloseIds:number[], callOffGiveBack:Array<{arcContractLineId, hotelId, qty}>}>}
 */
export async function closeForCreditReturn(t, ctx, { rtvId, rtvNumber, userId = null, rows = [] } = {}) {
  const wanted = rows
    .map((r) => ({ deliveryLineId: positiveInt(r.deliveryLineId), qty: toQ(r.qty) }))
    .filter((r) => r.deliveryLineId && r.qty > 0)
    .sort((a, b) => a.deliveryLineId - b.deliveryLineId);
  if (!wanted.length) return { shortCloseIds: [], callOffGiveBack: [] };
  const poId = Number(ctx.po.id);
  const shortCloseIds = await writeLog(t, {
    companyId: ctx.companyId, poId, rows: wanted, reasonCode: 'other', remarks: `RTV ${rtvNumber} credit`,
    action: 'close', userId, rtvId,
  });

  let callOffGiveBack = [];
  if (ctx.isCallOff) {
    const contractLines = await t.any(
      `SELECT dl.id, pop.arc_contract_line_id
         FROM tbl_po_delivery_line dl JOIN tbl_purchase_order_product pop ON pop.id = dl.po_line_id
        WHERE dl.id = ANY($1::int[])`,
      [wanted.map((r) => r.deliveryLineId)]
    );
    const byLine = new Map(contractLines.map((r) => [Number(r.id), positiveInt(r.arc_contract_line_id)]));
    callOffGiveBack = perContractLine(
      wanted.map((r) => ({ ...r, arcContractLineId: byLine.get(r.deliveryLineId) ?? null })),
      await callOffHotelId(t, ctx)
    );
    await giveBackCallOffQty(t, { poId, lines: callOffGiveBack });
  }
  return { shortCloseIds, callOffGiveBack };
}

/**
 * A PO's short-close log, oldest first, for the deliveries payload and the
 * notices. Buyer-side shape (acting user's name included).
 *
 * @returns {Promise<Array<{id, deliveryLineId, deliveryId, poLineId, productName,
 *   unit, hotelId, hotelName, phaseNo, qty:number, reasonCode, remarks,
 *   action:'close'|'reopen', actedAt:string, actedBy:number|null, actedByName,
 *   rtvId:number|null, rtvNumber:string|null}>>} rtvId/rtvNumber name the
 *   CREDIT return that wrote the row (null for the buyer's own short-closes)
 */
export async function listShortCloses(t, poId, { ids = null } = {}) {
  const rows = await t.any(
    `SELECT sc.id, sc.delivery_line_id, d.id AS delivery_id, dl.po_line_id, pv.name AS product_name, pop.unit,
            d.hotel_id, h.name AS hotel_name, d.phase_no, sc.qty::text AS qty, sc.reason_code, sc.remarks,
            sc.action, sc.acted_at, sc.acted_by, u.name AS acted_by_name, sc.rtv_id, rv.rtv_number
       FROM tbl_po_short_close sc
       JOIN tbl_po_delivery_line dl ON dl.id = sc.delivery_line_id
       JOIN tbl_po_delivery d ON d.id = dl.delivery_id
       JOIN tbl_purchase_order_product pop ON pop.id = dl.po_line_id
       LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       LEFT JOIN tbl_product_variant pv ON pv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = d.hotel_id
       LEFT JOIN tbl_users u ON u.id = sc.acted_by
       LEFT JOIN tbl_rtv rv ON rv.id = sc.rtv_id
      WHERE sc.po_id = $1 AND ($2::int[] IS NULL OR sc.id = ANY($2::int[]))
      ORDER BY sc.id`,
    [poId, ids]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    deliveryLineId: Number(r.delivery_line_id),
    deliveryId: Number(r.delivery_id),
    poLineId: Number(r.po_line_id),
    productName: r.product_name ?? null,
    unit: r.unit ?? null,
    hotelId: r.hotel_id == null ? null : Number(r.hotel_id),
    hotelName: r.hotel_name ?? null,
    phaseNo: Number(r.phase_no),
    qty: Number(r.qty),
    reasonCode: r.reason_code ?? null,
    remarks: r.remarks ?? null,
    action: r.action,
    actedAt: new Date(r.acted_at).toISOString(),
    actedBy: r.acted_by == null ? null : Number(r.acted_by),
    actedByName: r.acted_by_name ?? null,
    rtvId: r.rtv_id == null ? null : Number(r.rtv_id),
    rtvNumber: r.rtv_number ?? null,
  }));
}

export default {
  shortClose, reopenShortClose, closeForCreditReturn, listShortCloses, SHORT_CLOSE_REASONS, SHORT_CLOSABLE_PO_STATUSES,
};
