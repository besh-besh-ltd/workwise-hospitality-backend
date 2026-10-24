// Vendor dispatch notes (spec §7.3): the vendor records what left their
// warehouse against an accepted PO: which lines, how much, for which hotel
// and phase, with the challan, e-way bill and vehicle. The receiving hotel
// sees it as "in transit" and receives against it (task B1).
//
// The first dispatch locks the plan's quantities (delivery_plan_locked_at)
// and moves the legacy po.status forward to 'dispatched' (never back).
//
// The legacy "Mark dispatched" button (purchaseOrderModel.handleMarkDispatched)
// is a dispatch note with no lines, raised by { system: true }: it used to
// crash on every PO with more than one line and on every call-off PO (D1).
//
// Ownership: a vendor acts only on a PO whose finalized_vendor_id is their
// own user id; any other PO is NOT_FOUND. Nothing here returns a price or the
// name of a buyer's staff.

import { InventoryError } from './errors.js';
import { getPoContext, listPoLines } from './planCore.js';
import { advanceLegacyPoStatus, LEGACY_PO_STATUS_ORDER } from './poStatus.js';
import { nextDocNumber } from './docNumber.js';
import {
  loadDeliveries, loadPoLineRolls, loadDispatches, loadVendorDocuments, parseDay, parseQty, ensureCurrentPlan,
} from './planService.js';
import { INVALID_PO_STATUSES_FOR_VENDOR } from '../../util/constants.js';
import { loadInvoices } from './invoiceService.js';

const SCALE = 10000;
const toQ = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * SCALE) : 0;
};
const qNum = (q) => q / SCALE;
const qStr = (q) => `${Math.floor(q / SCALE)}.${String(q % SCALE).padStart(4, '0')}`;

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const notFound = (poId) => new InventoryError('NOT_FOUND', 'Purchase order not found', { poId: poId ?? null });

/**
 * The PO, locked or not, when `actor` is its vendor (or the system); NOT_FOUND
 * otherwise. Like the vendor's PO list, a vendor does not see a PO that has
 * not been released to them (draft, pending approval) or was withdrawn.
 */
async function ownedPo(t, actor, poId, { forUpdate = false } = {}) {
  const id = positiveInt(poId);
  if (!id) throw notFound(poId);
  let ctx;
  try {
    ctx = await getPoContext(t, id, { forUpdate });
  } catch (err) {
    if (err instanceof InventoryError && err.code === 'NOT_FOUND') throw notFound(id);
    throw err;
  }
  if (actor?.system === true) return ctx;
  const userId = positiveInt(actor?.id);
  if (!userId || Number(actor?.user_type) !== 3 || ctx.vendorId !== userId) throw notFound(id);
  if (INVALID_PO_STATUSES_FOR_VENDOR.includes(String(ctx.status))) throw notFound(id);
  return ctx;
}

function text(value, field, max, { required = false } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (!s) {
    if (required) throw new InventoryError('VALIDATION', `${field} is required`, { field });
    return null;
  }
  if (s.length > max) throw new InventoryError('VALIDATION', `${field} is limited to ${max} characters`, { field });
  return s;
}

function day(value, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new InventoryError('VALIDATION', `${field} is required`, { field });
    return null;
  }
  const d = parseDay(value);
  if (!d) throw new InventoryError('VALIDATION', `${field} must be a date (YYYY-MM-DD)`, { field });
  return d;
}

/** Open qty per PO line, overall or for one hotel (its rows plus the unallocated ones). */
async function openQtyByLine(t, poId, hotelId) {
  if (hotelId == null) {
    const rows = await t.any(
      `SELECT id, quantity::text AS ordered, accepted_qty::text AS accepted, returned_replace_qty::text AS rr,
              returned_credit_qty::text AS rc, short_closed_qty::text AS sc
         FROM tbl_purchase_order_product WHERE purchase_order_id = $1`,
      [poId]
    );
    return new Map(rows.map((r) => [
      Number(r.id),
      Math.max(0, toQ(r.ordered) - (toQ(r.accepted) - toQ(r.rr) - toQ(r.rc)) - toQ(r.sc)),
    ]));
  }
  const rows = await t.any(
    `SELECT dl.po_line_id, dl.planned_qty::text AS planned, dl.accepted_qty::text AS accepted,
            dl.returned_replace_qty::text AS rr, dl.returned_credit_qty::text AS rc, dl.short_closed_qty::text AS sc
       FROM tbl_po_delivery_line dl
       JOIN tbl_po_delivery d ON d.id = dl.delivery_id
      WHERE d.po_id = $1 AND (d.hotel_id = $2 OR d.hotel_id IS NULL)`,
    [poId, hotelId]
  );
  const out = new Map();
  for (const r of rows) {
    const open = Math.max(0, toQ(r.planned) - (toQ(r.accepted) - toQ(r.rr) - toQ(r.rc)) - toQ(r.sc));
    out.set(Number(r.po_line_id), (out.get(Number(r.po_line_id)) || 0) + open);
  }
  return out;
}

/**
 * Record a dispatch note (contract: POST /vendor/po/:poId/dispatches).
 *
 * @param {object} t transaction
 * @param {object} actor the vendor user (req.user), or {system:true, userId}
 *   for the legacy Mark-dispatched button (no lines, no challan needed).
 * @param {number} poId
 * @param {{hotelId?, deliveryId?, challanNo, challanDate, ewayBillNo?, vehicleNo?,
 *   transporter?, expectedDeliveryDate, remarks?, lines:[{poLineId, qty}]}} payload
 * @returns {Promise<object>} DispatchSummary
 * @throws InventoryError NOT_FOUND (not the vendor's PO) | CONFLICT (PO not
 *   accepted, closed or fully received) | VALIDATION (fields, hotel, delivery,
 *   lines; a qty above the open qty names {poLineId, openQty}).
 */
export async function createDispatch(t, actor, poId, payload = {}) {
  const system = actor?.system === true;
  const ctx = await ownedPo(t, actor, poId, { forUpdate: true });
  const id = Number(ctx.po.id);
  const actorUserId = system ? positiveInt(actor.userId) : positiveInt(actor.id);

  const status = String(ctx.status);
  if (!LEGACY_PO_STATUS_ORDER.includes(status)) {
    throw new InventoryError('CONFLICT', status === 'cancelled' || status.startsWith('rejected') || status === 'completed'
      ? `This purchase order is ${status.replace(/_/g, ' ')}; nothing can be dispatched against it`
      : 'Goods can be dispatched once the purchase order has been accepted', { poStatus: status });
  }
  if (ctx.receiptStatus === 'received' || ctx.receiptStatus === 'closed_short') {
    throw new InventoryError('CONFLICT', 'Everything on this purchase order has been received or closed', { receiptStatus: ctx.receiptStatus });
  }

  const p = payload && typeof payload === 'object' ? payload : {};
  const fields = {
    challanNo: text(p.challanNo, 'Challan number', 64, { required: !system }),
    challanDate: day(p.challanDate, 'Challan date', { required: !system }),
    expectedDeliveryDate: day(p.expectedDeliveryDate, 'Expected delivery date', { required: !system }),
    ewayBillNo: text(p.ewayBillNo, 'E-way bill number', 64),
    vehicleNo: text(p.vehicleNo, 'Vehicle number', 32),
    transporter: text(p.transporter, 'Transporter', 255),
    remarks: text(p.remarks, 'Remarks', 2000),
  };
  if (fields.challanDate && fields.expectedDeliveryDate && fields.expectedDeliveryDate < fields.challanDate) {
    throw new InventoryError('VALIDATION', 'Expected delivery cannot be before the challan date', { field: 'expectedDeliveryDate' });
  }

  await ensureCurrentPlan(t, id, { userId: actorUserId });

  // Where it is going: a delivery (hotel × phase) of this PO, or a hotel of it, or not said.
  let hotelId = null;
  if (p.hotelId != null && p.hotelId !== '') {
    hotelId = positiveInt(p.hotelId);
    if (!hotelId || !ctx.hotelIds.includes(hotelId)) {
      throw new InventoryError('VALIDATION', 'This purchase order is not delivered to that hotel', { field: 'hotelId', hotelId: p.hotelId });
    }
  }
  let deliveryId = null;
  if (p.deliveryId != null && p.deliveryId !== '') {
    deliveryId = positiveInt(p.deliveryId);
    const delivery = deliveryId
      ? await t.oneOrNone(`SELECT id, hotel_id, status FROM tbl_po_delivery WHERE id = $1 AND po_id = $2`, [deliveryId, id])
      : null;
    if (!delivery) {
      throw new InventoryError('VALIDATION', 'That delivery is not part of this purchase order', { field: 'deliveryId', deliveryId: p.deliveryId });
    }
    const deliveryHotel = delivery.hotel_id == null ? null : Number(delivery.hotel_id);
    if (hotelId != null && deliveryHotel != null && deliveryHotel !== hotelId) {
      throw new InventoryError('VALIDATION', 'That delivery is for another hotel', { field: 'deliveryId', deliveryId, hotelId });
    }
    if (delivery.status === 'received' || delivery.status === 'short_closed') {
      throw new InventoryError('VALIDATION', 'That delivery has nothing left to send', { field: 'deliveryId', deliveryId });
    }
    hotelId = hotelId ?? deliveryHotel;
  }

  // What is on the truck.
  const rawLines = Array.isArray(p.lines) ? p.lines : [];
  if (!system && !rawLines.length) {
    throw new InventoryError('VALIDATION', 'Add at least one line to the dispatch', { field: 'lines' });
  }
  const lines = [];
  if (rawLines.length) {
    const poLines = new Map((await listPoLines(t, id)).map((l) => [l.id, l]));
    const open = await openQtyByLine(t, id, hotelId);
    const seen = new Set();
    for (const l of rawLines) {
      const poLineId = positiveInt(l?.poLineId);
      if (!poLineId || !poLines.has(poLineId)) {
        throw new InventoryError('VALIDATION', 'That line is not on this purchase order', { field: 'lines', poLineId: l?.poLineId ?? null });
      }
      if (seen.has(poLineId)) {
        throw new InventoryError('VALIDATION', 'A line appears twice in the dispatch', { field: 'lines', poLineId });
      }
      seen.add(poLineId);
      const q = parseQty(l?.qty);
      if (q == null || q <= 0) {
        throw new InventoryError('VALIDATION', 'Dispatch quantities must be more than zero, with at most 4 decimals', { field: 'qty', poLineId });
      }
      const openQ = open.get(poLineId) || 0;
      if (q > openQ) {
        const line = poLines.get(poLineId);
        throw new InventoryError(
          'VALIDATION',
          `${line.productName || 'This line'}: only ${qNum(openQ)}${line.unit ? ` ${line.unit}` : ''} is still to be delivered${hotelId ? ' at this hotel' : ''}`,
          { field: 'qty', poLineId, qty: qNum(q), openQty: qNum(openQ), hotelId }
        );
      }
      lines.push({ poLineId, q });
    }
  }

  const numberHotel = hotelId ?? ctx.hotelIds[0] ?? null;
  if (!numberHotel || !ctx.companyId) {
    throw new InventoryError('CONFLICT', "The purchase order's delivery hotel could not be resolved", { poId: id });
  }
  const dispatchNumber = await nextDocNumber(t, { hotelId: numberHotel, docType: 'DSP' });
  const row = await t.one(
    `INSERT INTO tbl_po_dispatch
       (dispatch_number, hospitality_company_id, po_id, vendor_id, delivery_id, hotel_id, status,
        challan_no, challan_date, eway_bill_no, vehicle_no, transporter, expected_delivery_date, remarks,
        created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'in_transit', $7, $8, $9, $10, $11, $12, $13, $14, $14)
     RETURNING id`,
    [dispatchNumber, ctx.companyId, id, ctx.vendorId, deliveryId, hotelId,
     fields.challanNo, fields.challanDate, fields.ewayBillNo, fields.vehicleNo, fields.transporter,
     fields.expectedDeliveryDate, fields.remarks, actorUserId]
  );
  if (lines.length) {
    await t.none(
      `INSERT INTO tbl_po_dispatch_line (hospitality_company_id, dispatch_id, po_line_id, qty, created_by)
       SELECT $1, $2, v.po_line_id, v.qty, $5 FROM unnest($3::int[], $4::numeric[]) AS v(po_line_id, qty)`,
      [ctx.companyId, row.id, lines.map((l) => l.poLineId), lines.map((l) => qStr(l.q)), actorUserId]
    );
  }
  await advanceLegacyPoStatus(t, id, 'dispatched');
  await t.none(
    `UPDATE tbl_rfq_purchase_order SET delivery_plan_locked_at = COALESCE(delivery_plan_locked_at, now()) WHERE id = $1`,
    [id]
  );
  const [summary] = await loadDispatches(t, id, { dispatchId: Number(row.id) });
  return summary;
}

/**
 * Withdraw a dispatch note while it is on the road
 * (contract: POST /vendor/po/:poId/dispatches/:id/cancel). The PO status and
 * the plan lock stay where they are.
 * @throws InventoryError NOT_FOUND | CONFLICT (not in transit, or received against).
 */
export async function cancelDispatch(t, vendorUser, poId, dispatchId) {
  const ctx = await ownedPo(t, vendorUser, poId, { forUpdate: true });
  const id = Number(ctx.po.id);
  const did = positiveInt(dispatchId);
  const row = did
    ? await t.oneOrNone(`SELECT id, status FROM tbl_po_dispatch WHERE id = $1 AND po_id = $2 FOR UPDATE`, [did, id])
    : null;
  if (!row) throw new InventoryError('NOT_FOUND', 'Dispatch not found', { dispatchId: dispatchId ?? null });
  if (row.status !== 'in_transit') {
    throw new InventoryError('CONFLICT', `This dispatch is already ${row.status.replace(/_/g, ' ')}`, { status: row.status });
  }
  const received = await t.oneOrNone(
    `SELECT 1 FROM tbl_grn WHERE dispatch_id = $1 AND status <> 'draft' LIMIT 1`,
    [did]
  );
  if (received) throw new InventoryError('CONFLICT', 'Goods have been received against this dispatch', { dispatchId: did });
  // A billed dispatch stays: withdrawing it would leave its invoice billing a
  // delivery that never went. (raiseInvoice takes the same PO lock.)
  const billed = await t.oneOrNone(
    `SELECT invoice_number FROM tbl_purchase_order_document
      WHERE dispatch_id = $1 AND document_type = 'invoice'
      ORDER BY id
      LIMIT 1`,
    [did]
  );
  if (billed) {
    throw new InventoryError(
      'CONFLICT',
      billed.invoice_number
        ? `Invoice ${billed.invoice_number} has been raised against this dispatch, so it can't be withdrawn`
        : "An invoice has been raised against this dispatch, so it can't be withdrawn",
      { dispatchId: did }
    );
  }
  await t.none(
    `UPDATE tbl_po_dispatch SET status = 'cancelled', updated_at = now(), updated_by = $2 WHERE id = $1`,
    [did, positiveInt(vendorUser?.id)]
  );
  const [summary] = await loadDispatches(t, id, { dispatchId: did });
  return summary;
}

/**
 * The vendor's Deliveries tab (contract: GET /vendor/po/:poId/deliveries):
 * the plan, the PO lines' open quantities, dispatch notes, GRNs, returns,
 * short-closes and the vendor's own invoices (C4). No prices, rates, costs or
 * values; no buyer staff names.
 * @throws InventoryError NOT_FOUND when the PO is not the vendor's.
 */
export async function getVendorDeliveries(t, vendorUser, poId) {
  const ctx = await ownedPo(t, vendorUser, poId);
  const id = Number(ctx.po.id);
  // Closed POs are left as they are; a live one gets its plan, current.
  await ensureCurrentPlan(t, id, { userId: positiveInt(vendorUser?.id) });
  const fresh = await getPoContext(t, id);
  const hotels = fresh.hotelIds.length
    ? await t.any(`SELECT id, name FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[]) ORDER BY id`, [fresh.hotelIds])
    : [];
  const [deliveries, poLines, dispatches, docs, invoices] = await Promise.all([
    loadDeliveries(t, fresh),
    loadPoLineRolls(t, id),
    loadDispatches(t, id),
    loadVendorDocuments(t, id),
    loadInvoices(t, id),
  ]);
  return {
    poId: id,
    poNumber: fresh.po.po_number ?? null,
    poStatus: fresh.status,
    receiptStatus: fresh.receiptStatus,
    planLocked: Boolean(fresh.planLockedAt),
    hotels: hotels.map((h) => ({ id: Number(h.id), name: h.name })),
    deliveries,
    poLines,
    dispatches,
    grns: docs.grns,
    rtvs: docs.rtvs,
    shortCloses: docs.shortCloses,
    invoices,
  };
}

/** Activity-log scope of a dispatch's PO. */
export async function dispatchActivityScope(t, poId, hotelId = null) {
  const ctx = await getPoContext(t, poId);
  return {
    hospitalityCompanyId: ctx.companyId,
    hotelId: hotelId ?? (ctx.hotelIds.length === 1 ? ctx.hotelIds[0] : null),
    entityLabel: ctx.po.po_number || null,
  };
}

export default { createDispatch, cancelDispatch, getVendorDeliveries, dispatchActivityScope };
