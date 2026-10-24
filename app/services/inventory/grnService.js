// Goods receipt (mark in): the receive context, GRN drafts, posting with
// allocation to the delivery plan, reversals, attachments and the legacy
// markGRN full receipt (spec §6).
//
// One posting runs in ONE transaction: GRN document, plan allocations, PO
// counters, ledger rows and balances commit together or not at all. Lock order
// inside that transaction, the same for every receiving action:
//   1. the PO row            (getPoContext {forUpdate})
//   2. its delivery lines    (SELECT … FOR UPDATE ORDER BY id)
//   3. the doc sequence row  (nextDocNumber)
//   4. stock balances        (postMovements, called once)
// Over-receipt is checked on the locked delivery lines, so two receivers
// posting against the same PO line serialise and the second sees the first's
// receipt (Review Focus 1).
//
// Quantities are handled as integers of 1/10000 (NUMERIC(18,4)) so sums and
// tolerance checks have no float drift. Plan quantities (planned, accepted,
// rejected) are in PO units; ledger quantities are in the item's stock unit.
//
// Tenancy comes from the PO row (getPoContext → resolvePoTenancy) and the
// user's role scopes (assertHotelPermission, company + hotel axes). A hotel
// outside the PO's hotel set, a foreign PO or a foreign GRN is NOT_FOUND.
//
// Services never respond. Notifications (notifyGrnPosted / notifyGrnRejections)
// are sent by the caller AFTER commit.

import { InventoryError } from './errors.js';
import { assertHotelPermission, hotelIdsWithPermission } from './scope.js';
import { getEffectiveSettings } from './settings.js';
import { nextDocNumber } from './docNumber.js';
import { postMovements } from './ledger.js';
import { getPoContext, listPoLines, ensureDefaultPlan } from './planCore.js';
import { resolveItemForVariant, mapVariantToItem, suggestItems } from './items.js';
import { resolveUomFactor, setUomFactor, sameUom, normalizeUomLabel } from './uom.js';
import { resolvePoLineUnitCost } from './cost.js';
import { recomputePoReceipt } from './receiptRollup.js';
import { advanceLegacyPoStatus } from './poStatus.js';

/** po.status values a PO can be received in (spec §6.2). */
export const RECEIVABLE_PO_STATUSES = Object.freeze(['approved', 'dispatched', 'GRN', 'invoice_raised']);
/** po.receipt_status values with nothing left to receive. */
const CLOSED_RECEIPT_STATUSES = new Set(['received', 'closed_short']);
export const REJECTION_REASONS = Object.freeze([
  'damaged', 'quality', 'wrong_item', 'short_shelf_life', 'temperature', 'excess', 'other',
]);
export const ATTACHMENT_KINDS = Object.freeze(['CHALLAN', 'INVOICE', 'PHOTO', 'OTHER']);
/** Name stamped on site-rep (token) receipts, which have no user. */
export const SITE_REP_ACTOR = Object.freeze({ id: null, name: 'Site representative' });

const IST_TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`;
const LIST_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const SCALE = 10000;
const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
/** NUMERIC(18,4) value (number or decimal string) → integer of 1/10000. */
const toQ = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * SCALE) : NaN;
};
const qNum = (q) => q / SCALE;
/** Exact decimal string of a 1/10000 integer, for NUMERIC parameters. */
const qStr = (q) => {
  const a = Math.abs(q);
  return `${q < 0 ? '-' : ''}${Math.floor(a / SCALE)}.${String(a % SCALE).padStart(4, '0')}`;
};
const sum = (list) => list.reduce((a, b) => a + b, 0);
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const toIso = (v) => (v == null ? null : new Date(v).toISOString());
const numOrNull = (v) => (v == null ? null : Number(v));
const textOrNull = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const notFound = (what = 'Not found', details = {}) => new InventoryError('NOT_FOUND', what, details);
const invalid = (message, details = {}) => new InventoryError('VALIDATION', message, details);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A 'YYYY-MM-DD' calendar day, or null. Throws VALIDATION on anything else. */
function isoDay(value, field) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (!DAY_RE.test(s)) throw invalid(`${field} must be a date (YYYY-MM-DD)`, { field });
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw invalid(`${field} is not a valid date`, { field });
  }
  return s;
}
const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function clientEventIdOf(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!UUID_RE.test(s)) throw invalid('clientEventId must be a UUID', { field: 'clientEventId' });
  return s.toLowerCase();
}

function quantityQ(value, field, index) {
  const q = value == null || value === '' ? 0 : toQ(value);
  if (!Number.isFinite(q) || q < 0) {
    throw invalid(`${field} must be a number of 0 or more`, { field, index });
  }
  return q;
}

/** S3 location of a stored attachment key (legacy rows may hold a full URL). */
export function attachmentUrl(s3Key) {
  if (!s3Key) return null;
  if (/^https?:\/\//i.test(s3Key)) return s3Key;
  return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;
}

/** The key to store for an S3 URL: the object key when it is our bucket, else the URL itself. */
export function attachmentKeyFromUrl(url) {
  const s = textOrNull(url);
  if (!s) return null;
  try {
    const u = new URL(s);
    const bucket = process.env.AWS_S3_BUCKET;
    if (bucket && u.hostname.startsWith(`${bucket}.s3.`)) return decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    // not a URL: stored as given
  }
  return s;
}

// ---------------------------------------------------------------------------
// input normalisation (services are also called without the Joi layer)
// ---------------------------------------------------------------------------

const HEADER_TEXT = [
  ['vendorChallanNo', 64],
  ['vendorInvoiceNo', 64],
  ['ewayBillNo', 64],
  ['vehicleNo', 32],
];

/**
 * GrnInput (api-contract) → normalised header + lines. Quantities become
 * 1/10000 integers; dates are checked 'YYYY-MM-DD'.
 */
export function normalizeGrnInput(raw = {}, { requirePoId = false } = {}) {
  const header = {
    poId: positiveInt(raw.poId),
    hotelId: raw.hotelId == null ? null : positiveInt(raw.hotelId),
    dispatchId: raw.dispatchId == null || raw.dispatchId === '' ? null : positiveInt(raw.dispatchId),
    receivedAt: isoDay(raw.receivedAt, 'receivedAt'),
    vendorChallanDate: isoDay(raw.vendorChallanDate, 'vendorChallanDate'),
    vendorInvoiceDate: isoDay(raw.vendorInvoiceDate, 'vendorInvoiceDate'),
    remarks: textOrNull(raw.remarks),
    clientEventId: clientEventIdOf(raw.clientEventId),
  };
  if (requirePoId && !header.poId) throw invalid('A purchase order is required', { field: 'poId' });
  if (raw.hotelId != null && !header.hotelId) throw invalid('Invalid hotel', { field: 'hotelId' });
  if (raw.dispatchId != null && raw.dispatchId !== '' && !header.dispatchId) {
    throw invalid('Invalid dispatch', { field: 'dispatchId' });
  }
  for (const [key, max] of HEADER_TEXT) {
    const v = textOrNull(raw[key]);
    if (v && v.length > max) throw invalid(`${key} is too long`, { field: key });
    header[key] = v;
  }
  const lines = (Array.isArray(raw.lines) ? raw.lines : []).map((l, index) => normalizeLine(l || {}, index));
  return { header, lines };
}

function normalizeLine(l, index) {
  const poLineId = positiveInt(l.poLineId);
  if (!poLineId) throw invalid('Each line needs its PO line', { field: 'poLineId', index });
  const receivedQ = quantityQ(l.receivedQty, 'receivedQty', index);
  const acceptedQ = quantityQ(l.acceptedQty, 'acceptedQty', index);
  const rejectedQ = quantityQ(l.rejectedQty, 'rejectedQty', index);
  const reason = textOrNull(l.rejectionReason);
  if (reason && !REJECTION_REASONS.includes(reason)) {
    throw invalid('Unknown rejection reason', { field: 'rejectionReason', index, poLineId });
  }
  let uomFactor = null;
  if (l.uomFactor != null && l.uomFactor !== '') {
    uomFactor = Number(l.uomFactor);
    if (!Number.isFinite(uomFactor) || uomFactor <= 0) {
      throw invalid('The unit conversion must be greater than 0', { field: 'uomFactor', index, poLineId });
    }
  }
  const mapTo = l.mapToInvItemId == null || l.mapToInvItemId === '' ? null : positiveInt(l.mapToInvItemId);
  if (l.mapToInvItemId != null && l.mapToInvItemId !== '' && !mapTo) {
    throw invalid('Invalid item', { field: 'mapToInvItemId', index, poLineId });
  }
  const dept = l.markOutDepartmentId == null || l.markOutDepartmentId === '' ? null : positiveInt(l.markOutDepartmentId);
  if (l.markOutDepartmentId != null && l.markOutDepartmentId !== '' && !dept) {
    throw invalid('Invalid department', { field: 'markOutDepartmentId', index, poLineId });
  }
  const batchNo = textOrNull(l.batchNo);
  if (batchNo && batchNo.length > 64) throw invalid('Batch number is too long', { field: 'batchNo', index, poLineId });
  const mfgDate = isoDay(l.mfgDate, 'mfgDate');
  const expiryDate = isoDay(l.expiryDate, 'expiryDate');
  if (mfgDate && expiryDate && mfgDate > expiryDate) {
    throw invalid('The manufacturing date is after the expiry date', { field: 'mfgDate', index, poLineId });
  }
  return {
    index,
    poLineId,
    receivedQ,
    acceptedQ,
    rejectedQ,
    rejectionReason: reason,
    uomFactor,
    mapToInvItemId: mapTo,
    markOutDepartmentId: dept,
    batchNo,
    mfgDate,
    expiryDate,
    remarks: textOrNull(l.remarks),
  };
}

function assertSplit(line) {
  if (line.acceptedQ + line.rejectedQ !== line.receivedQ) {
    throw invalid('Accepted and rejected must add up to the received quantity', {
      field: 'receivedQty', index: line.index, poLineId: line.poLineId,
    });
  }
}

// ---------------------------------------------------------------------------
// access
// ---------------------------------------------------------------------------

function assertReceivable(ctx) {
  if (!RECEIVABLE_PO_STATUSES.includes(ctx.status) || CLOSED_RECEIPT_STATUSES.has(ctx.receiptStatus)) {
    const message = CLOSED_RECEIPT_STATUSES.has(ctx.receiptStatus)
      ? 'Nothing is left to receive on this purchase order'
      : 'This purchase order cannot be received yet';
    throw new InventoryError('CONFLICT', message, {
      reason: 'PO_NOT_RECEIVABLE', status: ctx.status, receiptStatus: ctx.receiptStatus,
    });
  }
}

/** A site-rep token must be a GRN token for this PO (and its hotel, when bound). */
async function assertToken(t, viaToken, poId, hotelId) {
  const tokenId = positiveInt(viaToken?.tokenId);
  const row = tokenId
    ? await t.oneOrNone(
      `SELECT id, entity_id, hotel_id FROM tbl_token_login_data WHERE id = $1 AND token_type = 'GRN'`,
      [tokenId]
    )
    : null;
  if (!row || Number(row.entity_id) !== Number(poId)) throw notFound('Purchase order not found');
  // The hotel stored on the token wins; a caller-side hotel may only agree with it.
  const stored = numOrNull(row.hotel_id);
  const asked = positiveInt(viaToken.hotelId);
  if (stored && asked && stored !== asked) throw notFound('Purchase order not found');
  const bound = stored ?? asked;
  if (bound && hotelId && bound !== Number(hotelId)) throw notFound('Purchase order not found');
  return { tokenId, hotelId: bound };
}

/** The hotel a site-rep token is bound to (stored on the token, else the caller's), or null. */
async function tokenHotelId(t, viaToken) {
  const tokenId = positiveInt(viaToken?.tokenId);
  const row = tokenId
    ? await t.oneOrNone(`SELECT hotel_id FROM tbl_token_login_data WHERE id = $1`, [tokenId])
    : null;
  return numOrNull(row?.hotel_id) ?? positiveInt(viaToken?.hotelId);
}

/**
 * Who may receive this PO at this hotel: the hotel must be in the PO's hotel
 * set (else NOT_FOUND), and the user must hold grn.<action> there
 * (assertHotelPermission: NOT_FOUND outside the company, FORBIDDEN inside).
 * A site-rep token is bound to its PO (and hotel) instead.
 */
async function assertReceiveAccess(t, actor, ctx, hotelId, { viaToken = null, action = 'create' } = {}) {
  const hotel = positiveInt(hotelId);
  if (!hotel || !ctx.companyId || !ctx.hotelIds.includes(hotel)) {
    throw notFound('Purchase order not found');
  }
  if (viaToken) {
    await assertToken(t, viaToken, ctx.po.id, hotel);
    return;
  }
  await assertHotelPermission(t, actor, { resource: 'grn', action, hotelId: hotel });
}

/**
 * Access to an existing GRN: no grn.read on its hotel = NOT_FOUND (the caller
 * cannot see it); grn.read but not grn.<action> = FORBIDDEN. A token may only
 * touch GRNs of its own PO and hotel.
 */
async function assertGrnAccess(t, user, grn, action = 'read', { viaToken = null } = {}) {
  if (viaToken) {
    await assertToken(t, viaToken, grn.po_id, grn.hotel_id);
    return;
  }
  try {
    await assertHotelPermission(t, user, { resource: 'grn', action: 'read', hotelId: grn.hotel_id });
  } catch (err) {
    if (err instanceof InventoryError && err.code === 'FORBIDDEN') throw notFound('GRN not found');
    throw err;
  }
  if (action !== 'read') {
    await assertHotelPermission(t, user, { resource: 'grn', action, hotelId: grn.hotel_id });
  }
}

async function loadGrnRow(t, grnId, { forUpdate = false } = {}) {
  const id = positiveInt(grnId);
  if (!id) throw notFound('GRN not found');
  const row = await t.oneOrNone(
    `SELECT id, grn_number, hospitality_company_id, hotel_id, po_id, dispatch_id, doc_type, reverses_grn_id,
            status, received_at::text AS received_at, received_by, received_by_token_id,
            vendor_challan_no, vendor_challan_date::text AS vendor_challan_date, vendor_invoice_no,
            vendor_invoice_date::text AS vendor_invoice_date, eway_bill_no, vehicle_no, remarks,
            client_event_id
       FROM tbl_grn WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id]
  );
  if (!row) throw notFound('GRN not found');
  return row;
}

/** Lazily checked inventory.update (unit conversions, variant mapping). */
function inventoryUpdateGate(t, actor, hotelId, viaToken) {
  let granted = false;
  return async () => {
    if (granted) return;
    if (viaToken) {
      throw new InventoryError('FORBIDDEN', 'Ask your inventory controller to set the unit conversion', {
        resource: 'inventory', action: 'update', hotelId,
      });
    }
    await assertHotelPermission(t, actor, { resource: 'inventory', action: 'update', hotelId });
    granted = true;
  };
}

// ---------------------------------------------------------------------------
// delivery plan state
// ---------------------------------------------------------------------------

/**
 * The PO's delivery lines with their delivery, as 1/10000 integers. `lock`
 * takes FOR UPDATE on the lines, ordered by id (step 2 of the lock order).
 */
async function loadPlan(t, poId, { lock = false } = {}) {
  const rows = await t.any(
    `SELECT dl.id, dl.delivery_id, dl.po_line_id,
            dl.planned_qty::text AS planned, dl.accepted_qty::text AS accepted, dl.rejected_qty::text AS rejected,
            dl.returned_replace_qty::text AS rr, dl.returned_credit_qty::text AS rc,
            dl.short_closed_qty::text AS sc,
            d.hotel_id, d.phase_no, d.due_date::text AS due_date, d.status AS delivery_status
       FROM tbl_po_delivery_line dl
       JOIN tbl_po_delivery d ON d.id = dl.delivery_id
      WHERE d.po_id = $1
      ORDER BY dl.id
      ${lock ? 'FOR UPDATE OF dl' : ''}`,
    [poId]
  );
  const deliveries = await t.any(
    `SELECT id, hotel_id, phase_no, due_date::text AS due_date, status FROM tbl_po_delivery WHERE po_id = $1 ORDER BY id`,
    [poId]
  );
  const lines = rows.map((r) => {
    const l = {
      id: Number(r.id),
      deliveryId: Number(r.delivery_id),
      poLineId: Number(r.po_line_id),
      hotelId: numOrNull(r.hotel_id),
      phaseNo: Number(r.phase_no),
      dueDate: r.due_date,
      plannedQ: toQ(r.planned),
      acceptedQ: toQ(r.accepted),
      rejectedQ: toQ(r.rejected),
      rrQ: toQ(r.rr),
      rcQ: toQ(r.rc),
      scQ: toQ(r.sc),
    };
    l.openQ = Math.max(0, l.plannedQ - (l.acceptedQ - l.rrQ - l.rcQ) - l.scQ);
    return l;
  });
  return {
    lines,
    deliveries: deliveries.map((d) => ({
      id: Number(d.id), hotelId: numOrNull(d.hotel_id), phaseNo: Number(d.phase_no), dueDate: d.due_date, status: d.status,
    })),
  };
}

/** Earliest due date first (no date last), then phase, then id. */
function byDue(a, b) {
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate == null) return 1;
    if (b.dueDate == null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return a.phaseNo - b.phaseNo || a.id - b.id;
}

const netOf = (l) => l.acceptedQ - l.rrQ - l.rcQ;

/**
 * Receiving headroom for one PO line at one hotel (spec §6.5), PO units:
 *   per hotel  net accepted + new ≤ (planned at hotel − short-closed + unallocated open) × (1 + tol)
 *   per line   net accepted + new ≤ (ordered − short-closed) × (1 + tol)
 * maxQ is the most that can still be accepted; openAtHotelQ what is expected.
 */
function capacityFor(plan, { poLineId, hotelId, orderedQ, tolPct }) {
  const lines = plan.lines.filter((l) => l.poLineId === poLineId);
  const atHotel = lines.filter((l) => l.hotelId === hotelId);
  const unallocated = lines.filter((l) => l.hotelId == null);
  const hotelNet = sum(atHotel.map(netOf));
  const hotelPlanned = sum(atHotel.map((l) => Math.max(0, l.plannedQ - l.scQ)));
  const unallocatedOpen = sum(unallocated.map((l) => l.openQ));
  const lineNet = sum(lines.map(netOf));
  const lineEffective = Math.max(0, orderedQ - sum(lines.map((l) => l.scQ)));
  const tolerance = 1 + (Number(tolPct) || 0) / 100;
  const hotelCap = Math.round((hotelPlanned + unallocatedOpen) * tolerance);
  const lineCap = Math.round(lineEffective * tolerance);
  return {
    maxQ: Math.max(0, Math.min(hotelCap - hotelNet, lineCap - lineNet)),
    plannedAtHotelQ: sum(atHotel.map((l) => l.plannedQ)),
    openAtHotelQ: Math.max(0, Math.min(
      sum(atHotel.map((l) => l.openQ)) + unallocatedOpen,
      lineEffective - lineNet
    )),
  };
}

/**
 * Allocator for one GRN at one hotel (spec §6.4): a dispatch-linked delivery
 * first, then the hotel's open rows by due date / phase, then the unallocated
 * rows, materialised into a row for the hotel (a reused latest undated hotel
 * delivery, else a new one at phase max+1 with no due date). Mutates `plan`
 * as it goes, so several GRN lines for one PO line share the headroom.
 */
function makeAllocator(t, { plan, ctx, hotelId, dispatchDeliveryId, userId }) {
  let targetDelivery = null;

  async function targetDeliveryFor() {
    if (targetDelivery) return targetDelivery;
    const mine = plan.deliveries.filter((d) => d.hotelId === hotelId);
    const maxPhase = mine.reduce((m, d) => Math.max(m, d.phaseNo), 0);
    const latest = mine.find((d) => d.phaseNo === maxPhase);
    if (latest && latest.dueDate == null && latest.status !== 'short_closed') {
      targetDelivery = latest;
      return latest;
    }
    const row = await t.one(
      `INSERT INTO tbl_po_delivery (hospitality_company_id, po_id, hotel_id, phase_no, due_date, created_by, updated_by)
       VALUES ($1, $2, $3, $4, NULL, $5, $5) RETURNING id`,
      [ctx.companyId, ctx.po.id, hotelId, maxPhase + 1, userId]
    );
    targetDelivery = { id: Number(row.id), hotelId, phaseNo: maxPhase + 1, dueDate: null, status: 'open' };
    plan.deliveries.push(targetDelivery);
    return targetDelivery;
  }

  /** The hotel's materialisation row for a PO line, created with planned 0 if needed. */
  async function targetLineFor(poLineId) {
    const d = await targetDeliveryFor();
    let line = plan.lines.find((l) => l.deliveryId === d.id && l.poLineId === poLineId);
    if (line) return line;
    const row = await t.one(
      `INSERT INTO tbl_po_delivery_line
         (hospitality_company_id, delivery_id, po_line_id, planned_qty, created_by, updated_by)
       VALUES ($1, $2, $3, 0, $4, $4) RETURNING id`,
      [ctx.companyId, d.id, poLineId, userId]
    );
    line = {
      id: Number(row.id), deliveryId: d.id, poLineId, hotelId, phaseNo: d.phaseNo, dueDate: d.dueDate,
      plannedQ: 0, acceptedQ: 0, rejectedQ: 0, rrQ: 0, rcQ: 0, scQ: 0, openQ: 0,
    };
    plan.lines.push(line);
    return line;
  }

  function candidates(poLineId) {
    const atHotel = plan.lines.filter((l) => l.poLineId === poLineId && l.hotelId === hotelId).sort(byDue);
    if (!dispatchDeliveryId) return atHotel;
    const first = atHotel.filter((l) => l.deliveryId === dispatchDeliveryId);
    return [...first, ...atHotel.filter((l) => l.deliveryId !== dispatchDeliveryId)];
  }

  /** @returns {Promise<Array<{deliveryLineId:number, acceptedQ:number, rejectedQ:number}>>} */
  return async function allocate({ poLineId, acceptedQ, rejectedQ }) {
    const out = new Map();
    const add = (line, a, r) => {
      const cur = out.get(line.id) || { deliveryLineId: line.id, acceptedQ: 0, rejectedQ: 0 };
      cur.acceptedQ += a;
      cur.rejectedQ += r;
      out.set(line.id, cur);
    };
    const list = candidates(poLineId);
    let left = acceptedQ;
    let first = null;
    let last = null;

    for (const line of list) {
      if (left <= 0) break;
      const take = Math.min(left, line.openQ);
      if (take > 0) {
        add(line, take, 0);
        line.openQ -= take;
        line.acceptedQ += take;
        left -= take;
        first = first ?? line;
        last = line;
      }
    }

    if (left > 0) {
      // Draw on the unallocated rows: move the planned qty to this hotel.
      let moved = 0;
      const unallocated = plan.lines.filter((l) => l.poLineId === poLineId && l.hotelId == null).sort(byDue);
      for (const u of unallocated) {
        const m = Math.min(left - moved, u.openQ);
        if (m <= 0) continue;
        await t.none(
          `UPDATE tbl_po_delivery_line SET planned_qty = planned_qty - $2::numeric, updated_at = now(), updated_by = $3
            WHERE id = $1`,
          [u.id, qStr(m), userId]
        );
        u.plannedQ -= m;
        u.openQ -= m;
        moved += m;
        if (moved >= left) break;
      }
      if (moved > 0) {
        const target = await targetLineFor(poLineId);
        await t.none(
          `UPDATE tbl_po_delivery_line SET planned_qty = planned_qty + $2::numeric, updated_at = now(), updated_by = $3
            WHERE id = $1`,
          [target.id, qStr(moved), userId]
        );
        target.plannedQ += moved;
        add(target, moved, 0);
        target.acceptedQ += moved;
        left -= moved;
        first = first ?? target;
        last = target;
      }
    }

    if (left > 0) {
      // Within tolerance beyond the plan: book it on the latest row used.
      const sink = last ?? list[list.length - 1] ?? (await targetLineFor(poLineId));
      add(sink, left, 0);
      sink.acceptedQ += left;
      first = first ?? sink;
      left = 0;
    }

    if (rejectedQ > 0) {
      const sink = first ?? list[0] ?? (await targetLineFor(poLineId));
      add(sink, 0, rejectedQ);
    }
    return [...out.values()];
  };
}

// ---------------------------------------------------------------------------
// items, categories, costs
// ---------------------------------------------------------------------------

/**
 * Company category defaults for variants (any category or ancestor counts,
 * as lazy item creation reads them): {trackExpiry, markOutOnArrival}.
 */
async function categoryDefaults(t, companyId, variantIds) {
  const ids = [...new Set(variantIds.filter(Boolean))];
  const out = new Map(ids.map((id) => [id, { trackExpiry: false, markOutOnArrival: false }]));
  if (!ids.length) return out;
  const rows = await t.any(
    `WITH RECURSIVE cats AS (
       SELECT pv.id AS variant_id, pc.category_id AS id, 1 AS depth
         FROM tbl_product_variant pv
         JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
        WHERE pv.id = ANY($2::int[]) AND pc.category_id IS NOT NULL
       UNION
       SELECT cats.variant_id, c.parent_id, cats.depth + 1
         FROM cats JOIN tbl_category c ON c.id = cats.id
        WHERE c.parent_id IS NOT NULL AND c.parent_id > 0 AND cats.depth < 6
     )
     SELECT cats.variant_id,
            bool_or(cd.track_expiry) AS track_expiry,
            bool_or(cd.default_mark_out_on_arrival) AS mark_out
       FROM cats
       JOIN tbl_inv_category_default cd ON cd.category_id = cats.id AND cd.hospitality_company_id = $1
      GROUP BY cats.variant_id`,
    [companyId, ids]
  );
  for (const r of rows) {
    out.set(Number(r.variant_id), { trackExpiry: r.track_expiry === true, markOutOnArrival: r.mark_out === true });
  }
  return out;
}

async function assertDepartments(t, ids) {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return;
  const rows = await t.any(`SELECT id FROM tbl_department WHERE id = ANY($1::int[])`, [wanted]);
  const found = new Set(rows.map((r) => Number(r.id)));
  const missing = wanted.find((id) => !found.has(id));
  if (missing) throw invalid('Unknown department', { field: 'markOutDepartmentId', departmentId: missing });
}

async function assertCompanyItem(t, companyId, invItemId) {
  const row = await t.oneOrNone(
    `SELECT id FROM tbl_inv_item WHERE id = $1 AND hospitality_company_id = $2`,
    [invItemId, companyId]
  );
  if (!row) throw notFound('Item not found', { invItemId });
}

/**
 * Resolve one GRN line for posting: stock item (mapped on request, else
 * lazily created), unit conversion, cost per stock unit, expiry rules.
 */
async function resolvePostLine(t, { ctx, hotelId, poLine, line, receivedAt, userId, requireInventoryUpdate, warnings, settings }) {
  const companyId = ctx.companyId;
  const variantId = poLine.productVariantId;
  const poUnit = poLine.unit ?? '';
  const accepting = line.acceptedQ > 0;

  if (!variantId) {
    throw invalid(`"${poLine.productName ?? `Line ${poLine.id}`}" has no catalogue product and cannot be stocked`, {
      code_detail: 'NO_PRODUCT', poLineId: poLine.id,
    });
  }

  if (line.mapToInvItemId) {
    await assertCompanyItem(t, companyId, line.mapToInvItemId);
    const current = await resolveItemForVariant(t, { companyId, productVariantId: variantId });
    if (!current || current.id !== line.mapToInvItemId) {
      await requireInventoryUpdate();
      await mapVariantToItem(t, { companyId, productVariantId: variantId, invItemId: line.mapToInvItemId, userId });
    }
  }

  const item = await resolveItemForVariant(t, {
    companyId, productVariantId: variantId, createIfMissing: accepting, userId, defaultUom: poUnit,
  });
  if (!item) {
    // Rejected-only line of a product never stocked: nothing to convert or value.
    return { ...line, poLine, item: null, factor: null, stockQ: 0, unitCost: null };
  }

  let factor = await resolveUomFactor(t, { invItemId: item.id, uomLabel: poUnit });
  if (line.uomFactor != null && !sameUom(poUnit, item.stockUom)) {
    const supplied = round6(line.uomFactor);
    if (factor == null || Math.abs(factor - supplied) > 1e-9) {
      await requireInventoryUpdate();
      const saved = await setUomFactor(t, { invItemId: item.id, uomLabel: poUnit, factor: supplied, userId });
      factor = saved.factor;
    }
  }
  if (factor == null && accepting) {
    throw invalid(
      `Set how many ${item.stockUom} are in one ${normalizeUomLabel(poUnit) || 'PO unit'} of ${item.displayName} ` +
        '(ask your inventory controller to set the unit conversion)',
      { code_detail: 'UOM_FACTOR_REQUIRED', poLineId: poLine.id, poUnit, stockUom: item.stockUom }
    );
  }

  if (accepting && item.trackExpiry && !line.expiryDate) {
    throw invalid(`Enter the expiry date for ${item.displayName}`, {
      code_detail: 'EXPIRY_REQUIRED', poLineId: poLine.id,
    });
  }
  if (accepting && line.expiryDate) {
    const shelfLifeDays = dayDiff(receivedAt, line.expiryDate);
    if (shelfLifeDays < 0) {
      warnings.push({
        code: 'EXPIRED', poLineId: poLine.id, shelfLifeDays,
        message: `${item.displayName} expired on ${line.expiryDate}; consider rejecting it (short shelf life)`,
      });
    } else if (item.minShelfLifeDays != null && shelfLifeDays < item.minShelfLifeDays) {
      warnings.push({
        code: 'SHORT_SHELF_LIFE', poLineId: poLine.id, shelfLifeDays, minShelfLifeDays: item.minShelfLifeDays,
        message: `${item.displayName} has ${shelfLifeDays} days of shelf life left (minimum ${item.minShelfLifeDays}); consider rejecting it (short shelf life)`,
      });
    }
  }

  let unitCost = null;
  let stockQ = 0;
  if (accepting) {
    const cost = await resolvePoLineUnitCost(t, { poLineId: poLine.id, hotelId, companyId });
    unitCost = round4(cost.costPerPoUnit / factor);
    stockQ = Math.round(line.acceptedQ * factor);
  }
  return {
    ...line,
    poLine,
    item,
    factor,
    stockQ,
    unitCost,
    tolPct: item.overReceiptTolerancePct ?? settings.overReceiptTolerancePct,
  };
}

// ---------------------------------------------------------------------------
// GRN header / line writes
// ---------------------------------------------------------------------------

async function insertGrnHeader(t, { ctx, hotelId, header, clientEventId, userId }) {
  const row = await t.one(
    `INSERT INTO tbl_grn
       (hospitality_company_id, hotel_id, po_id, dispatch_id, doc_type, status, received_at,
        vendor_challan_no, vendor_challan_date, vendor_invoice_no, vendor_invoice_date, eway_bill_no, vehicle_no,
        remarks, client_event_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'RECEIPT', 'draft', COALESCE($5::date, ${IST_TODAY}),
             $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
     RETURNING id`,
    [
      ctx.companyId, hotelId, ctx.po.id, header.dispatchId, header.receivedAt,
      header.vendorChallanNo, header.vendorChallanDate, header.vendorInvoiceNo, header.vendorInvoiceDate,
      header.ewayBillNo, header.vehicleNo, header.remarks, clientEventId, userId,
    ]
  );
  return Number(row.id);
}

async function updateGrnHeader(t, grnId, { hotelId, header, clientEventId, userId }) {
  await t.none(
    `UPDATE tbl_grn
        SET hotel_id = $2, dispatch_id = $3, received_at = COALESCE($4::date, received_at),
            vendor_challan_no = $5, vendor_challan_date = $6, vendor_invoice_no = $7, vendor_invoice_date = $8,
            eway_bill_no = $9, vehicle_no = $10, remarks = $11,
            client_event_id = COALESCE(client_event_id, $12::uuid),
            updated_at = now(), updated_by = $13
      WHERE id = $1`,
    [
      grnId, hotelId, header.dispatchId, header.receivedAt,
      header.vendorChallanNo, header.vendorChallanDate, header.vendorInvoiceNo, header.vendorInvoiceDate,
      header.ewayBillNo, header.vehicleNo, header.remarks, clientEventId, userId,
    ]
  );
}

async function insertGrnLine(t, { companyId, grnId, userId, line }) {
  const row = await t.one(
    `INSERT INTO tbl_grn_line
       (hospitality_company_id, grn_id, po_line_id, product_variant_id, inv_item_id, reverses_grn_line_id, po_uom,
        received_qty, accepted_qty, rejected_qty, rejection_reason, uom_factor, stock_qty, unit_cost,
        mark_out_department_id, batch_no, mfg_date, expiry_date, remarks, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11, $12, $13, $14,
             $15, $16, $17, $18, $19, $20, $20)
     RETURNING id`,
    [
      companyId, grnId, line.poLineId, line.productVariantId ?? null, line.invItemId ?? null,
      line.reversesGrnLineId ?? null, String(line.poUom ?? '').slice(0, 99),
      qStr(line.receivedQ), qStr(line.acceptedQ), qStr(line.rejectedQ), line.rejectionReason ?? null,
      line.uomFactor ?? null, line.stockQ == null ? null : qStr(line.stockQ), line.unitCost ?? null,
      line.markOutDepartmentId ?? null, line.batchNo ?? null, line.mfgDate ?? null, line.expiryDate ?? null,
      line.remarks ?? null, userId,
    ]
  );
  return Number(row.id);
}

/** Draft lines → normalised input lines (draft inv_item_id / uom_factor are requests). */
async function draftLines(t, grnId) {
  const rows = await t.any(
    `SELECT id, po_line_id, inv_item_id, received_qty::text AS received, accepted_qty::text AS accepted,
            rejected_qty::text AS rejected, rejection_reason, uom_factor::text AS uom_factor,
            mark_out_department_id, batch_no, mfg_date::text AS mfg_date, expiry_date::text AS expiry_date, remarks
       FROM tbl_grn_line WHERE grn_id = $1 ORDER BY id`,
    [grnId]
  );
  return rows.map((r, index) => ({
    index,
    poLineId: Number(r.po_line_id),
    receivedQ: toQ(r.received),
    acceptedQ: toQ(r.accepted),
    rejectedQ: toQ(r.rejected),
    rejectionReason: r.rejection_reason,
    uomFactor: numOrNull(r.uom_factor),
    mapToInvItemId: numOrNull(r.inv_item_id),
    markOutDepartmentId: numOrNull(r.mark_out_department_id),
    batchNo: r.batch_no,
    mfgDate: r.mfg_date,
    expiryDate: r.expiry_date,
    remarks: r.remarks,
  }));
}

function headerFromRow(row) {
  return {
    dispatchId: numOrNull(row.dispatch_id),
    receivedAt: row.received_at,
    vendorChallanNo: row.vendor_challan_no,
    vendorChallanDate: row.vendor_challan_date,
    vendorInvoiceNo: row.vendor_invoice_no,
    vendorInvoiceDate: row.vendor_invoice_date,
    ewayBillNo: row.eway_bill_no,
    vehicleNo: row.vehicle_no,
    remarks: row.remarks,
  };
}

async function loadDispatch(t, ctx, dispatchId, hotelId) {
  if (!dispatchId) return null;
  const row = await t.oneOrNone(
    `SELECT p.id, p.status, p.hotel_id, p.delivery_id, d.hotel_id AS delivery_hotel_id
       FROM tbl_po_dispatch p
       LEFT JOIN tbl_po_delivery d ON d.id = p.delivery_id
      WHERE p.id = $1 AND p.po_id = $2`,
    [dispatchId, ctx.po.id]
  );
  if (!row) throw invalid('That dispatch is not for this purchase order', { field: 'dispatchId' });
  if (row.status === 'cancelled') throw invalid('That dispatch was cancelled', { field: 'dispatchId' });
  if (row.hotel_id != null && Number(row.hotel_id) !== hotelId) {
    throw invalid('That dispatch is for another hotel', { field: 'dispatchId' });
  }
  return {
    id: Number(row.id),
    status: row.status,
    deliveryId: row.delivery_id != null && Number(row.delivery_hotel_id) === hotelId ? Number(row.delivery_id) : null,
  };
}

async function todayIst(t) {
  const row = await t.one(`SELECT ${IST_TODAY}::text AS d`);
  return row.d;
}

// ---------------------------------------------------------------------------
// replay (clientEventId)
// ---------------------------------------------------------------------------

async function findByClientEvent(t, clientEventId) {
  if (!clientEventId) return null;
  return t.oneOrNone(
    `SELECT id, po_id, hotel_id, status, doc_type FROM tbl_grn WHERE client_event_id = $1`,
    [clientEventId]
  );
}

/**
 * The GRN an earlier request with this clientEventId produced, as the caller
 * may see it, or null. A key that belongs to a GRN the caller cannot read is
 * a NOT_FOUND (never another tenant's document).
 */
export async function replayByClientEvent(t, actor, clientEventId, { viaToken = null, hidePrices = !!viaToken } = {}) {
  const key = clientEventIdOf(clientEventId);
  const row = await findByClientEvent(t, key);
  if (!row) return null;
  await assertGrnAccess(t, actor, row, 'read', { viaToken });
  return { grn: await getGrnPayload(t, row.id, { hidePrices }), replayed: true, created: false, draft: row.status === 'draft' };
}

// ---------------------------------------------------------------------------
// posting
// ---------------------------------------------------------------------------

/**
 * Post a receipt (steps after the PO row lock and the access check).
 * Writes header + lines, allocates, numbers, posts the ledger, rolls up.
 */
async function postCore(t, actor, { ctx, hotelId, header, lines, grnId = null, clientEventId = null, viaToken = null }) {
  const userId = viaToken ? null : positiveInt(actor?.id);
  const poId = Number(ctx.po.id);

  // Plan rows (lazily created for POs from before the module), then lock them.
  const hasPlan = await t.oneOrNone(`SELECT 1 FROM tbl_po_delivery WHERE po_id = $1 LIMIT 1`, [poId]);
  if (!hasPlan) await ensureDefaultPlan(t, poId, { userId });
  const plan = await loadPlan(t, poId, { lock: true });

  const poLines = new Map((await listPoLines(t, poId)).map((l) => [l.id, l]));
  const settings = await getEffectiveSettings(t, { companyId: ctx.companyId, hotelId });
  const receivedAt = header.receivedAt ?? (await todayIst(t));
  if (receivedAt > (await todayIst(t))) throw invalid('The received date cannot be in the future', { field: 'receivedAt' });
  const dispatch = await loadDispatch(t, ctx, header.dispatchId, hotelId);

  const active = lines.filter((l) => l.receivedQ > 0 || l.acceptedQ > 0 || l.rejectedQ > 0);
  if (!active.length) throw invalid('Enter at least one received quantity', { field: 'lines' });
  for (const line of active) {
    if (!poLines.has(line.poLineId)) {
      throw invalid('A line is not on this purchase order', { field: 'poLineId', index: line.index, poLineId: line.poLineId });
    }
    assertSplit(line);
    if (line.rejectedQ > 0 && !line.rejectionReason) {
      throw invalid('Give a reason for the rejected quantity', {
        field: 'rejectionReason', index: line.index, poLineId: line.poLineId,
      });
    }
  }
  await assertDepartments(t, active.filter((l) => l.acceptedQ > 0).map((l) => l.markOutDepartmentId));

  const requireInventoryUpdate = inventoryUpdateGate(t, actor, hotelId, viaToken);
  const warnings = [];
  const resolved = [];
  for (const line of active) {
    resolved.push(await resolvePostLine(t, {
      ctx, hotelId, poLine: poLines.get(line.poLineId), line, receivedAt, userId,
      requireInventoryUpdate, warnings, settings,
    }));
  }

  // Over-receipt, per PO line across the whole GRN, on the locked plan.
  const perPoLine = new Map();
  for (const r of resolved) {
    const cur = perPoLine.get(r.poLineId) || { acceptedQ: 0, tolPct: r.tolPct ?? settings.overReceiptTolerancePct };
    cur.acceptedQ += r.acceptedQ;
    perPoLine.set(r.poLineId, cur);
  }
  for (const [poLineId, { acceptedQ, tolPct }] of perPoLine) {
    if (acceptedQ === 0) continue;
    const poLine = poLines.get(poLineId);
    const { maxQ } = capacityFor(plan, { poLineId, hotelId, orderedQ: toQ(poLine.orderedQty), tolPct });
    if (acceptedQ > maxQ) {
      throw new InventoryError(
        'OVER_RECEIPT',
        `Only ${qNum(maxQ)} ${normalizeUomLabel(poLine.unit)} more of ${poLine.productName ?? 'this item'} can be accepted ` +
          'here; record the extra as rejected (excess)',
        { poLineId, maxAcceptable: qNum(maxQ), requested: qNum(acceptedQ) }
      );
    }
  }

  // Header and lines.
  let id = grnId;
  if (id) {
    await updateGrnHeader(t, id, { hotelId, header: { ...header, receivedAt }, clientEventId, userId });
    await t.none(`DELETE FROM tbl_grn_line WHERE grn_id = $1`, [id]);
  } else {
    id = await insertGrnHeader(t, { ctx, hotelId, header: { ...header, receivedAt }, clientEventId, userId });
  }
  for (const r of resolved) {
    r.grnLineId = await insertGrnLine(t, {
      companyId: ctx.companyId,
      grnId: id,
      userId,
      line: {
        poLineId: r.poLineId,
        productVariantId: r.poLine.productVariantId,
        invItemId: r.item?.id ?? null,
        poUom: r.poLine.unit,
        receivedQ: r.receivedQ,
        acceptedQ: r.acceptedQ,
        rejectedQ: r.rejectedQ,
        rejectionReason: r.rejectedQ > 0 ? r.rejectionReason : null,
        uomFactor: r.factor,
        stockQ: r.item ? r.stockQ : null,
        unitCost: r.unitCost,
        markOutDepartmentId: r.acceptedQ > 0 ? r.markOutDepartmentId : null,
        batchNo: r.batchNo,
        mfgDate: r.mfgDate,
        expiryDate: r.expiryDate,
        remarks: r.remarks,
      },
    });
  }

  // Allocate to the plan (materialising unallocated rows for this hotel).
  const allocate = makeAllocator(t, { plan, ctx, hotelId, dispatchDeliveryId: dispatch?.deliveryId ?? null, userId });
  for (const r of resolved) {
    const allocs = await allocate({ poLineId: r.poLineId, acceptedQ: r.acceptedQ, rejectedQ: r.rejectedQ });
    for (const a of allocs) {
      await t.none(
        `INSERT INTO tbl_grn_line_alloc (hospitality_company_id, grn_line_id, delivery_line_id, accepted_qty, rejected_qty, created_by)
         VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6)`,
        [ctx.companyId, r.grnLineId, a.deliveryLineId, qStr(a.acceptedQ), qStr(a.rejectedQ), userId]
      );
    }
  }

  // Number (sequence lock), then the ledger (balance locks), once.
  const grnNumber = await nextDocNumber(t, { hotelId, docType: 'GRN', date: receivedAt });
  const movements = [];
  for (const r of resolved) {
    if (r.acceptedQ <= 0 || !r.item) continue;
    const base = {
      companyId: ctx.companyId,
      hotelId,
      invItemId: r.item.id,
      productVariantId: r.poLine.productVariantId,
      batchNo: r.batchNo,
      expiryDate: r.expiryDate,
      sourceType: 'GRN',
      sourceId: id,
      sourceLineId: r.grnLineId,
      postedBy: userId,
    };
    movements.push({ ...base, type: 'GRN_IN', qty: qStr(r.stockQ), unitCost: r.unitCost });
    if (r.markOutDepartmentId) {
      movements.push({ ...base, type: 'MARK_OUT', qty: qStr(-r.stockQ), departmentId: r.markOutDepartmentId });
    }
  }
  await postMovements(t, movements);

  await t.none(
    `UPDATE tbl_grn
        SET status = 'posted', grn_number = $2, received_at = $3::date, posted_at = now(), posted_by = $4,
            received_by = $4, received_by_token_id = $5, client_event_id = COALESCE(client_event_id, $6::uuid),
            updated_at = now(), updated_by = $4
      WHERE id = $1`,
    [id, grnNumber, receivedAt, userId, viaToken ? positiveInt(viaToken.tokenId) : null, clientEventId]
  );

  await afterReceiptChange(t, poId, { dispatchId: dispatch?.id ?? null, userId });
  const grn = await getGrnPayload(t, id, { hidePrices: !!viaToken });
  return { grn: { ...grn, warnings }, replayed: false, created: !grnId };
}

/** Roll-ups and side effects of any posted receipt or reversal (same tx). */
async function afterReceiptChange(t, poId, { dispatchId = null, userId = null } = {}) {
  await recomputePoReceipt(t, poId);
  await advanceLegacyPoStatus(t, poId, 'GRN');
  await t.none(
    `UPDATE tbl_rfq_purchase_order SET delivery_plan_locked_at = now()
      WHERE id = $1 AND delivery_plan_locked_at IS NULL`,
    [poId]
  );
  if (dispatchId) {
    await t.none(
      `UPDATE tbl_po_dispatch SET status = 'received', updated_at = now(), updated_by = $2
        WHERE id = $1 AND status = 'in_transit'`,
      [dispatchId, userId]
    );
  }
}

/**
 * Post a GRN.
 *
 * @param {object} t transaction
 * @param {{id:number|null, name?:string, user_type?:number}} actor  req.user for
 *   buyers; SITE_REP_ACTOR ({id:null, name:'Site representative'}) for tokens.
 * @param {{grnId:number, clientEventId?:string}|{input:object}} target
 *   grnId posts a saved draft; input (GrnInput) creates and posts in one go.
 * @param {{viaToken?:{tokenId:number, hotelId:number}}} [opts] site-rep receipt:
 *   posted_by NULL, received_by_token_id set, hotel forced to the token's.
 * @returns {Promise<{grn:object, replayed:boolean, created:boolean}>} grn is
 *   the Grn payload plus `warnings[]`. replayed = the clientEventId (or the
 *   GRN) was already posted and the original is returned unchanged.
 */
export async function postGrn(t, actor, target = {}, { viaToken = null } = {}) {
  if (target.grnId != null) return postDraftGrn(t, actor, target, { viaToken });
  const { header, lines } = normalizeGrnInput(target.input || {}, { requirePoId: true });
  const hotelId = viaToken ? (await tokenHotelId(t, viaToken)) ?? header.hotelId : header.hotelId;
  if (!hotelId) throw invalid('Pick the hotel receiving the goods', { field: 'hotelId' });
  const key = header.clientEventId;

  const early = await replayIfPosted(t, actor, key, viaToken);
  if (early) return early;

  const ctx = await getPoContext(t, header.poId, { forUpdate: true });
  await assertReceiveAccess(t, actor, ctx, hotelId, { viaToken, action: 'create' });

  // Re-check under the PO lock: a concurrent replay has committed by now.
  let draftId = null;
  const existing = await findByClientEvent(t, key);
  if (existing) {
    if (existing.status !== 'draft') return replayByClientEvent(t, actor, key, { viaToken });
    if (Number(existing.po_id) !== Number(ctx.po.id)) {
      throw new InventoryError('CONFLICT', 'This scan session belongs to another receipt', { field: 'clientEventId' });
    }
    await assertGrnAccess(t, actor, existing, 'update', { viaToken });
    draftId = Number(existing.id);
  }
  assertReceivable(ctx);
  return postCore(t, actor, { ctx, hotelId, header, lines, grnId: draftId, clientEventId: key, viaToken });
}

async function replayIfPosted(t, actor, key, viaToken) {
  if (!key) return null;
  const row = await findByClientEvent(t, key);
  if (!row || row.status === 'draft') return null;
  return replayByClientEvent(t, actor, key, { viaToken });
}

async function postDraftGrn(t, actor, { grnId, clientEventId }, { viaToken }) {
  const key = clientEventIdOf(clientEventId);
  const first = await loadGrnRow(t, grnId);
  await assertGrnAccess(t, actor, first, 'read', { viaToken });

  const ctx = await getPoContext(t, first.po_id, { forUpdate: true });
  const grn = await loadGrnRow(t, first.id, { forUpdate: true });
  await assertGrnAccess(t, actor, grn, 'create', { viaToken });
  if (grn.doc_type !== 'RECEIPT') throw new InventoryError('CONFLICT', 'A reversal cannot be posted again', { grnId: grn.id });
  if (grn.status !== 'draft') {
    // Posting twice is a replay: answer with the posted GRN.
    return { grn: await getGrnPayload(t, grn.id, { hidePrices: !!viaToken }), replayed: true, created: false };
  }
  if (key) {
    const other = await findByClientEvent(t, key);
    if (other && Number(other.id) !== Number(grn.id)) {
      throw new InventoryError('CONFLICT', 'This scan session belongs to another receipt', { field: 'clientEventId' });
    }
  }
  if (viaToken) await assertReceiveAccess(t, actor, ctx, grn.hotel_id, { viaToken });
  else if (!ctx.hotelIds.includes(Number(grn.hotel_id))) throw notFound('GRN not found');
  assertReceivable(ctx);
  return postCore(t, actor, {
    ctx,
    hotelId: Number(grn.hotel_id),
    header: headerFromRow(grn),
    lines: await draftLines(t, grn.id),
    grnId: grn.id,
    clientEventId: key ?? grn.client_event_id,
    viaToken,
  });
}

// ---------------------------------------------------------------------------
// drafts
// ---------------------------------------------------------------------------

/**
 * Create (no grnId) or replace (grnId) a draft GRN. Drafts hold the receiver's
 * work in progress: quantities, reasons, batches, and requested unit
 * conversions / item mappings (applied, with their permission check, at post).
 * Nothing touches the plan or the ledger.
 *
 * @returns {Promise<{grn:object, replayed:boolean, created:boolean}>}
 */
export async function saveGrnDraft(t, user, input = {}, { grnId = null, viaToken = null } = {}) {
  const { header, lines } = normalizeGrnInput(input, { requirePoId: grnId == null });
  const userId = viaToken ? null : positiveInt(user?.id);
  let ctx;
  let hotelId;
  let id = grnId == null ? null : positiveInt(grnId);

  if (grnId != null) {
    const grn = await loadGrnRow(t, grnId, { forUpdate: true });
    await assertGrnAccess(t, user, grn, 'update', { viaToken });
    if (grn.status !== 'draft' || grn.doc_type !== 'RECEIPT') {
      throw new InventoryError('CONFLICT', 'Only a draft GRN can be edited', { grnId: grn.id, status: grn.status });
    }
    ctx = await getPoContext(t, grn.po_id);
    hotelId = viaToken ? Number(grn.hotel_id) : header.hotelId ?? Number(grn.hotel_id);
    if (hotelId !== Number(grn.hotel_id)) await assertReceiveAccess(t, user, ctx, hotelId, { action: 'update' });
    if (header.clientEventId && grn.client_event_id && header.clientEventId !== grn.client_event_id) {
      header.clientEventId = null; // a draft keeps the key it was created with
    }
  } else {
    if (header.clientEventId) {
      const replay = await replayByClientEvent(t, user, header.clientEventId, { viaToken });
      if (replay) return replay;
    }
    hotelId = viaToken ? (await tokenHotelId(t, viaToken)) ?? header.hotelId : header.hotelId;
    if (!hotelId) throw invalid('Pick the hotel receiving the goods', { field: 'hotelId' });
    ctx = await getPoContext(t, header.poId);
    await assertReceiveAccess(t, user, ctx, hotelId, { viaToken, action: 'create' });
  }
  assertReceivable(ctx);

  const poLines = new Map((await listPoLines(t, ctx.po.id)).map((l) => [l.id, l]));
  for (const line of lines) {
    if (!poLines.has(line.poLineId)) {
      throw invalid('A line is not on this purchase order', { field: 'poLineId', index: line.index, poLineId: line.poLineId });
    }
    assertSplit(line);
    if (line.mapToInvItemId) await assertCompanyItem(t, ctx.companyId, line.mapToInvItemId);
  }
  await assertDepartments(t, lines.map((l) => l.markOutDepartmentId));
  if (header.dispatchId) await loadDispatch(t, ctx, header.dispatchId, hotelId);

  if (id) {
    await updateGrnHeader(t, id, { hotelId, header, clientEventId: header.clientEventId, userId });
    await t.none(`DELETE FROM tbl_grn_line WHERE grn_id = $1`, [id]);
  } else {
    id = await insertGrnHeader(t, { ctx, hotelId, header, clientEventId: header.clientEventId, userId });
  }
  for (const line of lines) {
    const poLine = poLines.get(line.poLineId);
    await insertGrnLine(t, {
      companyId: ctx.companyId,
      grnId: id,
      userId,
      line: {
        ...line,
        productVariantId: poLine.productVariantId,
        invItemId: line.mapToInvItemId,
        poUom: poLine.unit,
        stockQ: null,
        unitCost: null,
      },
    });
  }
  return { grn: { ...(await getGrnPayload(t, id, { hidePrices: !!viaToken })), warnings: [] }, replayed: false, created: grnId == null };
}

/** Delete a draft GRN (grn.update). */
export async function discardGrn(t, user, grnId) {
  const grn = await loadGrnRow(t, grnId, { forUpdate: true });
  await assertGrnAccess(t, user, grn, 'update');
  if (grn.status !== 'draft') {
    throw new InventoryError('CONFLICT', 'Only a draft GRN can be discarded', { grnId: grn.id, status: grn.status });
  }
  await t.none(`DELETE FROM tbl_grn WHERE id = $1`, [grn.id]);
  return {
    deleted: true, grnId: Number(grn.id), companyId: Number(grn.hospitality_company_id), hotelId: Number(grn.hotel_id),
  };
}

// ---------------------------------------------------------------------------
// reversal
// ---------------------------------------------------------------------------

/**
 * Reverse a posted receipt in full (lines 'all') or in part
 * ([{grnLineId, qty}], accepted qty in PO units). Creates a posted REVERSAL
 * GRN whose lines name the receipt line they reverse (reverses_grn_line_id)
 * and whose allocations are negative, latest phase first; posts GRN_REVERSAL
 * at the receipt's unit cost (a line marked out on arrival first takes its
 * mark-out back with RETURN_IN). Refused (NEGATIVE_STOCK, details name the
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
      if (l.mark_out_department_id != null) {
        // Marked out on arrival: the department hands it back first.
        movements.push({ ...base, type: 'RETURN_IN', qty: qStr(stockQ), departmentId: Number(l.mark_out_department_id) });
      }
      movements.push({ ...base, type: 'GRN_REVERSAL', qty: qStr(-stockQ), batchNo: l.batch_no, expiryDate: l.expiry_date });
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

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

/** The GRN an attachment request targets, after grn.update (before any upload). */
export async function assertGrnAttachmentAccess(t, user, grnId, { viaToken = null } = {}) {
  const grn = await loadGrnRow(t, grnId);
  await assertGrnAccess(t, user, grn, 'update', { viaToken });
  return { grnId: Number(grn.id), companyId: Number(grn.hospitality_company_id), hotelId: Number(grn.hotel_id), grnNumber: grn.grn_number };
}

/** Record an uploaded file against a GRN (grn.update; any status). */
export async function addGrnAttachment(t, user, grnId, { s3Key, fileName = null, kind = 'OTHER' } = {}, { viaToken = null } = {}) {
  const grn = await loadGrnRow(t, grnId);
  await assertGrnAccess(t, user, grn, 'update', { viaToken });
  const k = String(kind || 'OTHER').toUpperCase();
  if (!ATTACHMENT_KINDS.includes(k)) throw invalid('Unknown attachment kind', { field: 'kind' });
  if (!textOrNull(s3Key)) throw invalid('A file is required', { field: 'file' });
  const row = await t.one(
    `INSERT INTO tbl_grn_attachment (hospitality_company_id, grn_id, s3_key, file_name, kind, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, file_name, kind, s3_key`,
    [grn.hospitality_company_id, grn.id, s3Key, textOrNull(fileName)?.slice(0, 255) ?? null, k,
      viaToken ? null : positiveInt(user?.id)]
  );
  return {
    attachment: { id: Number(row.id), fileName: row.file_name, kind: row.kind, url: attachmentUrl(row.s3_key) },
    companyId: Number(grn.hospitality_company_id),
    hotelId: Number(grn.hotel_id),
    grnNumber: grn.grn_number,
  };
}

/** Remove an attachment from a draft GRN (grn.update). */
export async function deleteGrnAttachment(t, user, grnId, attachmentId) {
  const grn = await loadGrnRow(t, grnId);
  await assertGrnAccess(t, user, grn, 'update');
  if (grn.status !== 'draft') {
    throw new InventoryError('CONFLICT', 'Attachments can only be removed from a draft GRN', { grnId: grn.id });
  }
  const res = await t.result(`DELETE FROM tbl_grn_attachment WHERE id = $1 AND grn_id = $2`, [positiveInt(attachmentId), grn.id]);
  if (!res.rowCount) throw notFound('Attachment not found');
  return { deleted: true, companyId: Number(grn.hospitality_company_id), hotelId: Number(grn.hotel_id), grnNumber: grn.grn_number };
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

const SUMMARY_SELECT = `
  SELECT g.id, g.grn_number, g.hotel_id, h.name AS hotel_name, g.status, g.doc_type,
         g.received_at::text AS received_at, g.posted_at, COALESCE(pu.name, tk.name) AS posted_by_name,
         (SELECT COUNT(*) FROM tbl_grn_line gl WHERE gl.grn_id = g.id)::int AS line_count,
         (SELECT COALESCE(SUM(gl.stock_qty * gl.unit_cost), 0) FROM tbl_grn_line gl WHERE gl.grn_id = g.id)::text AS accepted_value
    FROM tbl_grn g
    JOIN tbl_hospitality_company_hotels h ON h.id = g.hotel_id
    LEFT JOIN tbl_users pu ON pu.id = g.posted_by
    LEFT JOIN tbl_token_login_data tk ON tk.id = g.received_by_token_id`;

function toSummary(r, { hidePrices = false } = {}) {
  const s = {
    id: Number(r.id),
    grnNumber: r.grn_number,
    hotelId: Number(r.hotel_id),
    hotelName: r.hotel_name,
    status: r.status,
    docType: r.doc_type,
    receivedAt: r.received_at,
    postedAt: toIso(r.posted_at),
    postedByName: r.posted_by_name ?? null,
    lineCount: Number(r.line_count),
    acceptedValue: round4(Number(r.accepted_value)),
  };
  if (hidePrices) delete s.acceptedValue;
  return s;
}

/**
 * The Grn payload (api-contract): header, PO/hotel/vendor names, lines with
 * allocations and reversed qty, attachments, reversals and the reversed GRN.
 * No access check: callers check first. hidePrices drops costs and values.
 */
export async function getGrnPayload(t, grnId, { hidePrices = false } = {}) {
  const g = await t.oneOrNone(
    `SELECT g.*, g.received_at::text AS received_at_d, g.vendor_challan_date::text AS vendor_challan_date_d,
            g.vendor_invoice_date::text AS vendor_invoice_date_d,
            h.name AS hotel_name, po.po_number, COALESCE(vc.company_name, vu.organization_name, vu.name) AS vendor_name,
            COALESCE(pu.name, tk.name) AS posted_by_name, ru.name AS received_by_name
       FROM tbl_grn g
       JOIN tbl_hospitality_company_hotels h ON h.id = g.hotel_id
       JOIN tbl_rfq_purchase_order po ON po.id = g.po_id
       LEFT JOIN tbl_users vu ON vu.id = po.finalized_vendor_id
       LEFT JOIN tbl_company vc ON vc.id = vu.company_id
       LEFT JOIN tbl_users pu ON pu.id = g.posted_by
       LEFT JOIN tbl_users ru ON ru.id = g.received_by
       LEFT JOIN tbl_token_login_data tk ON tk.id = g.received_by_token_id
      WHERE g.id = $1`,
    [grnId]
  );
  if (!g) throw notFound('GRN not found');

  const lines = await t.any(
    `SELECT gl.*, gl.mfg_date::text AS mfg_date_d, gl.expiry_date::text AS expiry_date_d,
            COALESCE(pv.name, ppv.name) AS product_name, i.display_name AS item_name, i.stock_uom,
            dep.title AS mark_out_department_name,
            COALESCE((SELECT SUM(rl.accepted_qty) FROM tbl_grn_line rl JOIN tbl_grn rg ON rg.id = rl.grn_id
                       WHERE rl.reverses_grn_line_id = gl.id AND rg.status <> 'draft'), 0)::text AS reversed_qty
       FROM tbl_grn_line gl
       LEFT JOIN tbl_product_variant pv ON pv.id = gl.product_variant_id
       LEFT JOIN tbl_purchase_order_product pop ON pop.id = gl.po_line_id
       LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       LEFT JOIN tbl_product_variant ppv ON ppv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
       LEFT JOIN tbl_inv_item i ON i.id = gl.inv_item_id
       LEFT JOIN tbl_department dep ON dep.id = gl.mark_out_department_id
      WHERE gl.grn_id = $1
      ORDER BY gl.id`,
    [grnId]
  );
  const allocs = lines.length
    ? await t.any(
      `SELECT a.grn_line_id, d.id AS delivery_id, d.phase_no, d.hotel_id,
              a.accepted_qty::text AS accepted, a.rejected_qty::text AS rejected
         FROM tbl_grn_line_alloc a
         JOIN tbl_po_delivery_line dl ON dl.id = a.delivery_line_id
         JOIN tbl_po_delivery d ON d.id = dl.delivery_id
        WHERE a.grn_line_id = ANY($1::int[])
        ORDER BY a.id`,
      [lines.map((l) => l.id)]
    )
    : [];
  const attachments = await t.any(
    `SELECT id, file_name, kind, s3_key FROM tbl_grn_attachment WHERE grn_id = $1 ORDER BY id`,
    [grnId]
  );
  const reversals = await t.any(`${SUMMARY_SELECT} WHERE g.reverses_grn_id = $1 ORDER BY g.id`, [grnId]);
  const reverses = g.reverses_grn_id
    ? await t.oneOrNone(`${SUMMARY_SELECT} WHERE g.id = $1`, [g.reverses_grn_id])
    : null;

  const allocsByLine = new Map();
  for (const a of allocs) {
    const key = Number(a.grn_line_id);
    if (!allocsByLine.has(key)) allocsByLine.set(key, []);
    allocsByLine.get(key).push({
      deliveryId: Number(a.delivery_id),
      phaseNo: Number(a.phase_no),
      hotelId: numOrNull(a.hotel_id),
      acceptedQty: Number(a.accepted),
      rejectedQty: Number(a.rejected),
    });
  }

  return {
    id: Number(g.id),
    grnNumber: g.grn_number,
    companyId: Number(g.hospitality_company_id),
    hotelId: Number(g.hotel_id),
    hotelName: g.hotel_name,
    poId: Number(g.po_id),
    poNumber: g.po_number,
    vendorName: g.vendor_name ?? null,
    dispatchId: numOrNull(g.dispatch_id),
    docType: g.doc_type,
    reversesGrnId: numOrNull(g.reverses_grn_id),
    status: g.status,
    receivedAt: g.received_at_d,
    receivedBy: numOrNull(g.received_by),
    receivedByName: g.received_by_name ?? null,
    receivedByTokenId: numOrNull(g.received_by_token_id),
    vendorChallanNo: g.vendor_challan_no,
    vendorChallanDate: g.vendor_challan_date_d,
    vendorInvoiceNo: g.vendor_invoice_no,
    vendorInvoiceDate: g.vendor_invoice_date_d,
    ewayBillNo: g.eway_bill_no,
    vehicleNo: g.vehicle_no,
    remarks: g.remarks,
    postedAt: toIso(g.posted_at),
    postedBy: numOrNull(g.posted_by),
    postedByName: g.posted_by_name ?? null,
    clientEventId: g.client_event_id ?? null,
    createdAt: toIso(g.created_at),
    updatedAt: toIso(g.updated_at),
    lines: lines.map((l) => {
      const line = {
        id: Number(l.id),
        poLineId: Number(l.po_line_id),
        productVariantId: numOrNull(l.product_variant_id),
        productName: l.product_name ?? null,
        invItemId: numOrNull(l.inv_item_id),
        itemName: l.item_name ?? null,
        stockUom: l.stock_uom ?? null,
        reversesGrnLineId: numOrNull(l.reverses_grn_line_id),
        poUom: l.po_uom,
        receivedQty: Number(l.received_qty),
        acceptedQty: Number(l.accepted_qty),
        rejectedQty: Number(l.rejected_qty),
        rejectionReason: l.rejection_reason,
        uomFactor: numOrNull(l.uom_factor),
        stockQty: numOrNull(l.stock_qty),
        unitCost: numOrNull(l.unit_cost),
        markOutDepartmentId: numOrNull(l.mark_out_department_id),
        markOutDepartmentName: l.mark_out_department_name ?? null,
        batchNo: l.batch_no,
        mfgDate: l.mfg_date_d,
        expiryDate: l.expiry_date_d,
        remarks: l.remarks,
        reversedQty: Number(l.reversed_qty),
        allocations: allocsByLine.get(Number(l.id)) || [],
      };
      if (hidePrices) delete line.unitCost;
      return line;
    }),
    attachments: attachments.map((a) => ({
      id: Number(a.id), fileName: a.file_name, kind: a.kind, url: attachmentUrl(a.s3_key),
    })),
    reversals: reversals.map((r) => toSummary(r, { hidePrices })),
    reverses: reverses ? toSummary(reverses, { hidePrices }) : null,
    pdfUrl: null,
  };
}

/** GET /grn/:id — grn.read on the GRN's hotel (else NOT_FOUND). */
export async function getGrn(t, user, grnId, { hidePrices = false, viaToken = null } = {}) {
  const grn = await loadGrnRow(t, grnId);
  await assertGrnAccess(t, user, grn, 'read', { viaToken });
  return getGrnPayload(t, grn.id, { hidePrices: hidePrices || !!viaToken });
}

/**
 * GET /grn — GRNs at hotels where the user holds grn.read. Drafts only when
 * asked for (status=draft). Newest receipt first, 50 a page.
 * @returns {Promise<{rows:object[], total:number}>} rows are GrnSummary.
 */
export async function listGrns(t, user, { hotelId, poId, from, to, status, page } = {}) {
  let hotels = await hotelIdsWithPermission(t, user, 'grn', 'read');
  if (hotelId != null && hotelId !== '') {
    const h = positiveInt(hotelId);
    hotels = hotels.filter((x) => x === h);
  }
  if (!hotels.length) return { rows: [], total: 0 };
  const where = ['g.hotel_id = ANY($1::int[])'];
  const params = [hotels];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('$?', `$${params.length}`));
  };
  if (poId != null && poId !== '') add('g.po_id = $?', positiveInt(poId) ?? 0);
  if (from) add('g.received_at >= $?::date', isoDay(from, 'from'));
  if (to) add('g.received_at <= $?::date', isoDay(to, 'to'));
  if (status) add('g.status = $?', String(status));
  else where.push(`g.status <> 'draft'`);
  const p = Math.max(1, positiveInt(page) ?? 1);
  params.push(LIST_PAGE_SIZE, (p - 1) * LIST_PAGE_SIZE);
  const rows = await t.any(
    `SELECT s.*, COUNT(*) OVER () AS total FROM (${SUMMARY_SELECT} WHERE ${where.join(' AND ')}) s
      ORDER BY s.received_at DESC, s.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: rows.map((r) => toSummary(r)), total: rows.length ? Number(rows[0].total) : 0 };
}

// ---------------------------------------------------------------------------
// receive context
// ---------------------------------------------------------------------------

/**
 * Everything the Receive screen needs for one PO at one hotel
 * (api-contract ReceiveContext). The hotel is the one asked for, else the only
 * one the user can receive at; with several and none asked for, `hotel` is
 * null and `lines` empty (the screen asks the user to pick).
 *
 * @param {object} t transaction (a default plan may be created)
 * @param {object} user req.user (ignored with viaToken)
 * @param {{poId:number, hotelId?:number|null}} args
 * @param {{viaToken?:{tokenId, hotelId}, hidePrices?:boolean}} [opts] token
 *   views hide prices and are bound to the token's PO and hotel.
 */
export async function getReceiveContext(t, user, { poId, hotelId = null } = {}, { viaToken = null, hidePrices = !!viaToken } = {}) {
  const ctx = await getPoContext(t, poId);
  if (!ctx.companyId) throw notFound('Purchase order not found');
  const askedHotel = hotelId == null || hotelId === '' ? null : positiveInt(hotelId);
  if (hotelId != null && hotelId !== '' && !askedHotel) throw notFound('Purchase order not found');

  let choices;
  if (viaToken) {
    const token = await assertToken(t, viaToken, ctx.po.id, askedHotel);
    const forced = token.hotelId ?? (ctx.hotelIds.length === 1 ? ctx.hotelIds[0] : null);
    if (!forced || !ctx.hotelIds.includes(forced)) throw notFound('Purchase order not found');
    choices = [forced];
  } else {
    const allowed = new Set(await hotelIdsWithPermission(t, user, 'grn', 'create'));
    choices = ctx.hotelIds.filter((h) => allowed.has(h));
    if (askedHotel) {
      await assertReceiveAccess(t, user, ctx, askedHotel, { action: 'create' });
    } else if (!choices.length) {
      // Explain the refusal the way a direct attempt would (404 outside the
      // company, 403 inside it).
      if (!ctx.hotelIds.length) throw notFound('Purchase order not found');
      await assertReceiveAccess(t, user, ctx, ctx.hotelIds[0], { action: 'create' });
      throw new InventoryError('FORBIDDEN', "You can't receive this purchase order at any of its hotels", {
        resource: 'grn', action: 'create',
      });
    }
  }
  const hotel = viaToken ? choices[0] : askedHotel ?? (choices.length === 1 ? choices[0] : null);
  assertReceivable(ctx);

  const names = await t.any(
    `SELECT id, name FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[]) ORDER BY id`,
    [[...new Set([...choices, ...(hotel ? [hotel] : [])])]]
  );
  const nameOf = new Map(names.map((r) => [Number(r.id), r.name]));
  const head = await t.one(
    `SELECT po.po_number, COALESCE(vc.company_name, vu.organization_name, vu.name) AS vendor_name
       FROM tbl_rfq_purchase_order po
       LEFT JOIN tbl_users vu ON vu.id = po.finalized_vendor_id
       LEFT JOIN tbl_company vc ON vc.id = vu.company_id
      WHERE po.id = $1`,
    [ctx.po.id]
  );
  const departments = await t.any(`SELECT id, title FROM tbl_department ORDER BY title, id`);

  const out = {
    po: {
      id: Number(ctx.po.id),
      poNumber: head.po_number,
      vendorName: head.vendor_name ?? null,
      isCallOff: ctx.isCallOff,
      departmentId: ctx.departmentId,
    },
    hotel: hotel ? { id: hotel, name: nameOf.get(hotel) ?? null } : null,
    hotelChoices: choices.map((id) => ({ id, name: nameOf.get(id) ?? null })),
    lines: [],
    dispatches: [],
    departments: departments.map((d) => ({ id: Number(d.id), title: d.title })),
    itemSuggestions: {},
    draft: null,
  };
  if (!hotel) return out;

  const hasPlan = await t.oneOrNone(`SELECT 1 FROM tbl_po_delivery WHERE po_id = $1 LIMIT 1`, [ctx.po.id]);
  if (!hasPlan) await ensureDefaultPlan(t, ctx.po.id, { userId: viaToken ? null : positiveInt(user?.id) });
  const plan = await loadPlan(t, ctx.po.id);
  const poLines = await listPoLines(t, ctx.po.id);
  const settings = await getEffectiveSettings(t, { companyId: ctx.companyId, hotelId: hotel });
  const variantIds = poLines.map((l) => l.productVariantId).filter(Boolean);
  const defaults = await categoryDefaults(t, ctx.companyId, variantIds);

  const items = new Map(
    (await t.any(
      `SELECT iv.product_variant_id, i.id, i.display_name, i.stock_uom, i.track_expiry, i.min_shelf_life_days,
              i.over_receipt_tolerance_pct::text AS tol
         FROM tbl_inv_item_variant iv
         JOIN tbl_inv_item i ON i.id = iv.inv_item_id AND i.hospitality_company_id = iv.hospitality_company_id
        WHERE iv.hospitality_company_id = $1 AND iv.product_variant_id = ANY($2::int[])`,
      [ctx.companyId, variantIds]
    )).map((r) => [Number(r.product_variant_id), r])
  );
  const itemIds = [...items.values()].map((r) => Number(r.id));
  const barcodes = itemIds.length
    ? await t.any(
      `SELECT inv_item_id, code, pack_factor::text AS pack_factor FROM tbl_inv_item_barcode
        WHERE inv_item_id = ANY($1::int[]) AND hospitality_company_id = $2 ORDER BY id`,
      [itemIds, ctx.companyId]
    )
    : [];

  for (const l of poLines) {
    const item = l.productVariantId ? items.get(l.productVariantId) : null;
    const cat = defaults.get(l.productVariantId) || { trackExpiry: false, markOutOnArrival: false };
    let uomFactor = null;
    if (item) uomFactor = await resolveUomFactor(t, { invItemId: Number(item.id), uomLabel: l.unit });
    else if (l.productVariantId) uomFactor = 1; // a new item takes the PO unit as its stock unit
    const tolPct = item?.tol != null ? Number(item.tol) : settings.overReceiptTolerancePct;
    const cap = capacityFor(plan, { poLineId: l.id, hotelId: hotel, orderedQ: toQ(l.orderedQty), tolPct });
    const line = {
      poLineId: l.id,
      productVariantId: l.productVariantId,
      productName: l.productName,
      unit: l.unit,
      invItemId: item ? Number(item.id) : null,
      stockUom: item ? item.stock_uom : null,
      uomFactor,
      needsUomFactor: !!item && uomFactor == null,
      trackExpiry: item ? item.track_expiry === true : cat.trackExpiry,
      minShelfLifeDays: item?.min_shelf_life_days == null ? null : Number(item.min_shelf_life_days),
      plannedAtHotel: qNum(cap.plannedAtHotelQ),
      openAtHotel: qNum(cap.openAtHotelQ),
      maxAcceptable: qNum(cap.maxQ),
      defaultMarkOutOnArrival: cat.markOutOnArrival,
      barcodes: item
        ? barcodes.filter((b) => Number(b.inv_item_id) === Number(item.id))
          .map((b) => ({ code: b.code, packFactor: Number(b.pack_factor) }))
        : [],
    };
    if (!hidePrices && l.productVariantId) {
      const cost = await resolvePoLineUnitCost(t, { poLineId: l.id, hotelId: hotel, companyId: ctx.companyId });
      line.unitCost = cost.costPerPoUnit;
    }
    out.lines.push(line);
    if (!item && l.productVariantId) {
      const suggestions = await suggestItems(t, { companyId: ctx.companyId, productVariantId: l.productVariantId });
      if (suggestions.length) {
        out.itemSuggestions[l.id] = suggestions.map((s) => ({ invItemId: s.invItemId, name: s.displayName }));
      }
    }
  }

  out.dispatches = await inTransitDispatches(t, ctx.po.id, hotel);
  const draft = await t.oneOrNone(
    `SELECT id FROM tbl_grn
      WHERE po_id = $1 AND hotel_id = $2 AND status = 'draft' AND doc_type = 'RECEIPT'
      ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [ctx.po.id, hotel]
  );
  if (draft) out.draft = await getGrnPayload(t, draft.id, { hidePrices });
  return out;
}

/** In-transit dispatch notes a hotel can receive against (DispatchSummary[]). */
async function inTransitDispatches(t, poId, hotelId) {
  const rows = await t.any(
    `SELECT p.id, p.dispatch_number, p.hotel_id, h.name AS hotel_name, p.delivery_id, d.phase_no, p.status,
            p.challan_no, p.expected_delivery_date::text AS expected_delivery_date
       FROM tbl_po_dispatch p
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = p.hotel_id
       LEFT JOIN tbl_po_delivery d ON d.id = p.delivery_id
      WHERE p.po_id = $1 AND p.status = 'in_transit' AND (p.hotel_id IS NULL OR p.hotel_id = $2)
      ORDER BY p.expected_delivery_date NULLS LAST, p.id`,
    [poId, hotelId]
  );
  if (!rows.length) return [];
  const lines = await t.any(
    `SELECT dl.dispatch_id, dl.po_line_id, dl.qty::text AS qty, pv.name AS product_name
       FROM tbl_po_dispatch_line dl
       JOIN tbl_purchase_order_product pop ON pop.id = dl.po_line_id
       LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       LEFT JOIN tbl_product_variant pv ON pv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
      WHERE dl.dispatch_id = ANY($1::int[])
      ORDER BY dl.id`,
    [rows.map((r) => r.id)]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    dispatchNumber: r.dispatch_number,
    hotelId: numOrNull(r.hotel_id),
    hotelName: r.hotel_name ?? null,
    deliveryId: numOrNull(r.delivery_id),
    phaseNo: numOrNull(r.phase_no),
    status: r.status,
    challanNo: r.challan_no,
    expectedDeliveryDate: r.expected_delivery_date,
    lines: lines.filter((l) => Number(l.dispatch_id) === Number(r.id))
      .map((l) => ({ poLineId: Number(l.po_line_id), productName: l.product_name ?? null, qty: Number(l.qty) })),
  }));
}

// ---------------------------------------------------------------------------
// legacy POST /po/markGRN
// ---------------------------------------------------------------------------

const useReceive = (message, details = {}) =>
  new InventoryError('USE_RECEIVE', message, details, 409);

/**
 * The legacy one-click "mark GRN": a posted GRN accepting every open qty at
 * the PO's single receiving hotel. Refuses with 409 USE_RECEIVE when that is
 * not a safe guess: open quantity at more than one hotel (an unsplit
 * multi-hotel PO), an item whose unit conversion is unknown (factor 1 is used
 * only when the PO unit IS the stock unit, as for a lazily created item), an
 * expiry-tracked item, or a line with no catalogue product.
 *
 * @param {object} t transaction
 * @param {object} user req.user: a buyer, or a legacy GRN-token user
 *   ({id:-1, is_token_user:true, tokenLoginId}).
 * @returns {Promise<{grn:object, ctx:object}>}
 */
export async function postLegacyFullReceipt(t, user, { poId, remarks = null } = {}) {
  const ctx = await getPoContext(t, poId, { forUpdate: true });
  if (!ctx.companyId) throw notFound('Purchase order not found');
  const viaToken = user?.is_token_user ? { tokenId: user.tokenLoginId } : null;
  const actor = viaToken ? SITE_REP_ACTOR : user;
  assertReceivable(ctx);

  const hasPlan = await t.oneOrNone(`SELECT 1 FROM tbl_po_delivery WHERE po_id = $1 LIMIT 1`, [ctx.po.id]);
  if (!hasPlan) await ensureDefaultPlan(t, ctx.po.id, { userId: viaToken ? null : positiveInt(user?.id) });
  const plan = await loadPlan(t, ctx.po.id, { lock: true });

  // Where is anything still open? Unallocated qty is open at every PO hotel.
  const openHotels = new Set();
  for (const l of plan.lines) {
    if (l.openQ <= 0) continue;
    if (l.hotelId == null) ctx.hotelIds.forEach((h) => openHotels.add(h));
    else openHotels.add(l.hotelId);
  }
  if (ctx.hotelIds.length !== 1 && (openHotels.size !== 1 || plan.lines.some((l) => l.hotelId == null && l.openQ > 0))) {
    throw useReceive('This purchase order is delivered to more than one hotel: use Receive to record what arrived at each', {
      hotelIds: ctx.hotelIds,
    });
  }
  const hotelId = ctx.hotelIds.length === 1 ? ctx.hotelIds[0] : [...openHotels][0];
  if (!hotelId) throw useReceive('Use Receive to record this delivery');
  if (viaToken) await assertReceiveAccess(t, actor, ctx, hotelId, { viaToken: { ...viaToken, hotelId } });
  else await assertReceiveAccess(t, actor, ctx, hotelId, { action: 'create' });

  const lines = [];
  for (const l of await listPoLines(t, ctx.po.id)) {
    if (!l.productVariantId) {
      throw useReceive(`"${l.productName ?? `Line ${l.id}`}" has no catalogue product: use Receive`, { poLineId: l.id });
    }
    const item = await resolveItemForVariant(t, { companyId: ctx.companyId, productVariantId: l.productVariantId });
    if (item) {
      const factor = await resolveUomFactor(t, { invItemId: item.id, uomLabel: l.unit });
      if (factor == null) {
        throw useReceive(`The unit conversion for ${item.displayName} is not set: use Receive`, {
          code_detail: 'UOM_FACTOR_REQUIRED', poLineId: l.id, poUnit: l.unit, stockUom: item.stockUom,
        });
      }
    }
    // Full receipt = what is still open, never the tolerance on top.
    const { openAtHotelQ, maxQ } = capacityFor(plan, { poLineId: l.id, hotelId, orderedQ: toQ(l.orderedQty), tolPct: 0 });
    const q = Math.min(openAtHotelQ, maxQ);
    if (q <= 0) continue;
    const expiryTracked = item ? item.trackExpiry
      : (await categoryDefaults(t, ctx.companyId, [l.productVariantId])).get(l.productVariantId)?.trackExpiry;
    if (expiryTracked) {
      throw useReceive(`${item?.displayName ?? l.productName ?? 'An item'} needs an expiry date: use Receive`, {
        code_detail: 'EXPIRY_REQUIRED', poLineId: l.id,
      });
    }
    lines.push({
      index: lines.length, poLineId: l.id, receivedQ: q, acceptedQ: q, rejectedQ: 0, rejectionReason: null,
      uomFactor: null, mapToInvItemId: null, markOutDepartmentId: null, batchNo: null, mfgDate: null,
      expiryDate: null, remarks: null,
    });
  }
  if (!lines.length) {
    throw new InventoryError('CONFLICT', 'Nothing is left to receive on this purchase order', {
      reason: 'PO_NOT_RECEIVABLE', status: ctx.status, receiptStatus: ctx.receiptStatus,
    });
  }
  const header = {
    dispatchId: null, receivedAt: null, vendorChallanNo: null, vendorChallanDate: null, vendorInvoiceNo: null,
    vendorInvoiceDate: null, ewayBillNo: null, vehicleNo: null, remarks: textOrNull(remarks),
  };
  const res = await postCore(t, actor, {
    ctx, hotelId, header, lines, viaToken: viaToken ? { ...viaToken, hotelId } : null,
  });
  return { grn: res.grn, ctx };
}

export default {
  getReceiveContext,
  saveGrnDraft,
  postGrn,
  reverseGrn,
  getGrn,
  getGrnPayload,
  listGrns,
  discardGrn,
  addGrnAttachment,
  deleteGrnAttachment,
  assertGrnAttachmentAccess,
  replayByClientEvent,
  postLegacyFullReceipt,
  normalizeGrnInput,
};
