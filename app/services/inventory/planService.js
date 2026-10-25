// Delivery plans (spec §7): a PO split into deliveries (hotel × phase), each
// with a planned quantity per PO line, a due date and remarks.
//
//   getDeliveries   the buyer's Deliveries tab: plan + receipt roll-up + the
//                   documents raised against the PO (GRNs, dispatch notes,
//                   returns, short-closes) + what the caller may do.
//   savePlan        replaces the whole plan, until the first dispatch or receipt.
//   patchDueDate    moves one delivery's date while it has received nothing.
//   fillDefaultDueDates  dates an untouched default plan when the vendor accepts.
//   ensureCurrentPlan    gives a live PO its default plan, and rebuilds a stale
//                        one (lines added, moved or re-quantified by a path that
//                        did not drop it) while the plan can still change shape.
//                        Called on every read, at submit for approval and at
//                        call-off release.
//
// Buyer staff only: a vendor or a site-rep token is NOT_FOUND here even if a
// route lets one through (defence in depth; vendors use dispatchService).
// Edits use the PO initiate gate (PO_INITIATE_PERMISSIONS, i.e. awarding.create)
// on the PO's own scope tuple; reads use assertPoAccess. Both come from the
// caller and the PO row, never from the request body.
//
// Side effects (vendor notice, PDF rewrite) run after commit: the controller
// takes planChangeFollowUp(t, …) inside the transaction and hands it to
// queuePlanChangeFollowUp once it has answered. Follow-ups of one PO run one
// after another, so the last PDF written prints the last plan saved.

import db from '../../config/dbConn.js';
import { logError } from '../../helper/common.js';
import { InventoryError } from './errors.js';
import { getPoContext, listPoLines, ensureDefaultPlan, defaultDueDate } from './planCore.js';
import { recomputePoReceipt } from './receiptRollup.js';
import { hotelIdsWithPermission } from './scope.js';
import { listGrnSummariesForPo } from './grnRead.js';
import { listShortCloses } from './shortCloseService.js';
import { loadInvoices } from './invoiceService.js';
import { LEGACY_PO_STATUS_ORDER } from './poStatus.js';
import { notifyPlanChanged } from './notices/planNotices.js';
import { RECEIVABLE_PO_STATUSES } from './grnCommon.js';
import { LIVE_TOKEN_SQL, RECEIVE_TOKEN_TTL_DAYS } from '../../helper/receiveToken.js';
import { assertPoAccess, assertPoInitiateAccess, canInitiateOnTuple } from '../../models/purchaseOrderModel.js';
import { writePoDocument } from '../poDocumentService.js';
import { generateCallOffPoPdf } from '../../helper/arc_v2/callOffPoRenderer.js';

// ─── small helpers ──────────────────────────────────────────────────────────

const SCALE = 10000; // NUMERIC(18,4): quantities are handled as integers of 1/10000
const toQ = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * SCALE) : 0;
};
const qNum = (q) => q / SCALE;
const qStr = (q) => {
  const a = Math.abs(q);
  return `${q < 0 ? '-' : ''}${Math.floor(a / SCALE)}.${String(a % SCALE).padStart(4, '0')}`;
};

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** A PO the vendor and buyer have walked away from: nothing moves on it any more. */
export const CLOSED_PO_STATUSES = Object.freeze(['cancelled', 'rejected', 'rejected_by_vendor', 'completed']);
/** The vendor has accepted the PO (spec §6.14: approved < dispatched < GRN < invoice_raised). */
const isAccepted = (status) => LEGACY_PO_STATUS_ORDER.includes(String(status));
/** The vendor holds the PO document from here on. */
const vendorHoldsDocument = (status) => isAccepted(status) || ['acceptance_pending', 'sent'].includes(String(status));
const DONE_RECEIPT = ['received', 'closed_short'];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' of a real calendar day, else null. */
export function parseDay(value) {
  if (typeof value !== 'string') return null;
  const m = DAY.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * A quantity with at most 4 decimals, as an integer of 1/10000, or null.
 * Accepts numbers and decimal strings.
 */
export function parseQty(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const s = String(value).trim();
  if (!/^-?\d+(\.\d{1,4})?$/.test(s)) return null;
  const q = Math.round(Number(s) * SCALE);
  return Number.isSafeInteger(q) ? q : null;
}

const fmtQty = (q) => String(qNum(q));

/** The PO's date, as the IST calendar day it was raised. */
async function poDay(t, poId) {
  const row = await t.one(
    `SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS d FROM tbl_rfq_purchase_order WHERE id = $1`,
    [poId]
  );
  return row.d;
}

function validDueDate(raw, minDay, details) {
  if (raw == null || raw === '') return null;
  const day = parseDay(raw);
  if (!day) {
    throw new InventoryError('VALIDATION', 'Due date must be a date (YYYY-MM-DD)', { field: 'dueDate', ...details });
  }
  if (minDay && day < minDay) {
    throw new InventoryError('VALIDATION', 'A delivery cannot be due before the purchase order was raised', {
      field: 'dueDate', dueDate: day, poDate: minDay, ...details,
    });
  }
  return day;
}

// ─── readers shared by the buyer and vendor views ───────────────────────────

/** Has anything been received against this PO's plan (a non-draft GRN allocation, or a short-close)? */
async function planHasActivity(t, poId) {
  const row = await t.one(
    `SELECT EXISTS (
              SELECT 1 FROM tbl_grn_line_alloc a
                JOIN tbl_po_delivery_line dl ON dl.id = a.delivery_line_id
                JOIN tbl_po_delivery d ON d.id = dl.delivery_id
               WHERE d.po_id = $1) AS allocated,
            EXISTS (SELECT 1 FROM tbl_po_short_close sc WHERE sc.po_id = $1) AS short_closed`,
    [poId]
  );
  return row.allocated || row.short_closed;
}

/**
 * Is the stored plan out of step with the PO's lines? True when a line is not
 * planned at exactly its ordered quantity (a line appended, or re-quantified,
 * by a path that did not drop the plan), or when a plan line points at a line
 * that now sits on another PO (merged away). A plan the buyer saved always
 * totals the ordered quantities, so this never flags a deliberate split.
 */
async function planIsStale(t, poId) {
  const row = await t.one(
    `SELECT EXISTS (
              SELECT 1
                FROM tbl_purchase_order_product pop
                LEFT JOIN (SELECT dl.po_line_id, SUM(dl.planned_qty) AS planned
                             FROM tbl_po_delivery_line dl
                             JOIN tbl_po_delivery d ON d.id = dl.delivery_id
                            WHERE d.po_id = $1
                            GROUP BY dl.po_line_id) p ON p.po_line_id = pop.id
               WHERE pop.purchase_order_id = $1
                 AND COALESCE(p.planned, 0) <> ROUND(GREATEST(pop.quantity, 0)::numeric, 4)
            ) OR EXISTS (
              SELECT 1
                FROM tbl_po_delivery_line dl
                JOIN tbl_po_delivery d ON d.id = dl.delivery_id
                JOIN tbl_purchase_order_product pop ON pop.id = dl.po_line_id
               WHERE d.po_id = $1 AND pop.purchase_order_id <> $1
            ) AS stale`,
    [poId]
  );
  return row.stale === true;
}

/**
 * Bring a live PO's plan in line with its lines (ctx = getPoContext, unlocked).
 * No plan: the default one. A stale plan (planIsStale) that can still change
 * shape (not locked by a dispatch, nothing received or short-closed, not a
 * legacy received PO): dropped and replaced by the default. A stale plan that
 * can no longer change is left as it is. The PO row is locked only when there
 * is something to write, so a read of a current plan stays lock-free.
 */
async function refreshPlan(t, ctx, userId) {
  if (CLOSED_PO_STATUSES.includes(String(ctx.status))) return;
  const id = Number(ctx.po.id);
  const has = await t.oneOrNone(`SELECT 1 FROM tbl_po_delivery WHERE po_id = $1 LIMIT 1`, [id]);
  if (has) {
    if (!(await planIsStale(t, id))) return;
    const locked = await getPoContext(t, id, { forUpdate: true });
    if (locked.planLockedAt || (locked.receiptLegacy && locked.receiptStatus === 'received')) return;
    if ((await planHasActivity(t, id)) || !(await planIsStale(t, id))) return;
    await t.none(`DELETE FROM tbl_po_delivery WHERE po_id = $1`, [id]);
  }
  await ensureDefaultPlan(t, id, { userId: userId ?? null });
}

/**
 * The PO's plan, current: see refreshPlan. For callers outside the read path
 * (submit for approval, call-off release, dispatch). Run it in a savepoint
 * where a plan problem must not cost the caller its own change.
 * @throws InventoryError NOT_FOUND (no such PO) | CONFLICT (company unresolved).
 */
export async function ensureCurrentPlan(t, poId, { userId = null } = {}) {
  const ctx = await getPoContext(t, poId);
  await refreshPlan(t, ctx, positiveInt(userId));
}

/** A vendor or a site-rep token never reads or edits a buyer's plan: NOT_FOUND, as for a PO out of scope. */
function assertBuyerStaff(user) {
  if (!user || Number(user.user_type) === 3 || user.is_token_user) {
    throw new InventoryError('NOT_FOUND', 'Purchase order not found');
  }
}

/** Line roll-up of one delivery line, from its stored counters. */
function planLine(r) {
  const planned = toQ(r.planned_qty);
  const accepted = toQ(r.accepted_qty);
  const rr = toQ(r.returned_replace_qty);
  const rc = toQ(r.returned_credit_qty);
  const sc = toQ(r.short_closed_qty);
  return {
    id: Number(r.id),
    poLineId: Number(r.po_line_id),
    productName: r.product_name ?? null,
    unit: r.unit ?? null,
    plannedQty: qNum(planned),
    acceptedQty: qNum(accepted),
    rejectedQty: qNum(toQ(r.rejected_qty)),
    returnedReplaceQty: qNum(rr),
    returnedCreditQty: qNum(rc),
    shortClosedQty: qNum(sc),
    openQty: qNum(Math.max(0, planned - (accepted - rr - rc) - sc)),
    status: r.status,
  };
}

const lineIsLive = (l) =>
  l.plannedQty !== 0 || l.acceptedQty !== 0 || l.rejectedQty !== 0 ||
  l.returnedReplaceQty !== 0 || l.returnedCreditQty !== 0 || l.shortClosedQty !== 0;

/**
 * Delivery[] for a PO, ordered hotel id (unallocated last) → phase. Deliveries
 * with nothing planned and nothing booked (an unallocated row drained into
 * hotel rows) are left out, as are such lines inside a delivery.
 */
export async function loadDeliveries(t, ctx) {
  const poId = Number(ctx.po.id);
  const [rows, lines] = await Promise.all([
    t.any(
      `SELECT d.id, d.hotel_id, h.name AS hotel_name, d.phase_no, d.due_date::text AS due_date, d.status, d.remarks,
              (d.due_date < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date) AS past_due,
              EXISTS (SELECT 1
                        FROM tbl_grn_line_alloc a
                        JOIN tbl_po_delivery_line dl ON dl.id = a.delivery_line_id
                        JOIN tbl_grn_line gl ON gl.id = a.grn_line_id
                        JOIN tbl_grn g ON g.id = gl.grn_id
                       WHERE dl.delivery_id = d.id AND g.status <> 'draft') AS has_receipts
         FROM tbl_po_delivery d
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = d.hotel_id
        WHERE d.po_id = $1
        ORDER BY d.hotel_id IS NULL, d.hotel_id, d.phase_no, d.id`,
      [poId]
    ),
    t.any(
      `SELECT dl.id, dl.delivery_id, dl.po_line_id, pop.unit, pv.name AS product_name,
              dl.planned_qty::text AS planned_qty, dl.accepted_qty::text AS accepted_qty,
              dl.rejected_qty::text AS rejected_qty, dl.returned_replace_qty::text AS returned_replace_qty,
              dl.returned_credit_qty::text AS returned_credit_qty, dl.short_closed_qty::text AS short_closed_qty,
              dl.status
         FROM tbl_po_delivery_line dl
         JOIN tbl_po_delivery d ON d.id = dl.delivery_id
         JOIN tbl_purchase_order_product pop ON pop.id = dl.po_line_id
         LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
         LEFT JOIN tbl_product_variant pv ON pv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
        WHERE d.po_id = $1
        ORDER BY dl.delivery_id, dl.po_line_id`,
      [poId]
    ),
  ]);
  const byDelivery = new Map();
  for (const r of lines) {
    const key = Number(r.delivery_id);
    if (!byDelivery.has(key)) byDelivery.set(key, []);
    byDelivery.get(key).push(planLine(r));
  }
  const poDone = DONE_RECEIPT.includes(ctx.receiptStatus) || CLOSED_PO_STATUSES.includes(String(ctx.status));
  const out = [];
  for (const d of rows) {
    const live = (byDelivery.get(Number(d.id)) || []).filter(lineIsLive);
    if (!live.length) continue;
    const open = d.status === 'open' || d.status === 'partial';
    out.push({
      id: Number(d.id),
      hotelId: d.hotel_id == null ? null : Number(d.hotel_id),
      hotelName: d.hotel_id == null ? null : (d.hotel_name ?? null),
      phaseNo: Number(d.phase_no),
      dueDate: d.due_date ?? null,
      status: d.status,
      remarks: d.remarks ?? null,
      overdue: Boolean(d.due_date && d.past_due && open && !poDone),
      hasReceipts: d.has_receipts === true,
      lines: live,
    });
  }
  return out;
}

/** PoLineRoll[] from the PO lines' stored counters (no prices). */
export async function loadPoLineRolls(t, poId) {
  const rows = await t.any(
    `SELECT pop.id, pop.unit, pv.name AS product_name, pop.quantity::text AS quantity,
            pop.received_qty::text AS received_qty, pop.accepted_qty::text AS accepted_qty,
            pop.rejected_qty::text AS rejected_qty, pop.returned_replace_qty::text AS returned_replace_qty,
            pop.returned_credit_qty::text AS returned_credit_qty, pop.short_closed_qty::text AS short_closed_qty,
            pop.receipt_status
       FROM tbl_purchase_order_product pop
       LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       LEFT JOIN tbl_product_variant pv ON pv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
      WHERE pop.purchase_order_id = $1
      ORDER BY pop.id`,
    [poId]
  );
  return rows.map((r) => {
    const ordered = toQ(r.quantity);
    const accepted = toQ(r.accepted_qty);
    const rr = toQ(r.returned_replace_qty);
    const rc = toQ(r.returned_credit_qty);
    const sc = toQ(r.short_closed_qty);
    return {
      id: Number(r.id),
      productName: r.product_name ?? null,
      unit: r.unit ?? null,
      orderedQty: qNum(ordered),
      receivedQty: qNum(toQ(r.received_qty)),
      acceptedQty: qNum(accepted),
      rejectedQty: qNum(toQ(r.rejected_qty)),
      returnedReplaceQty: qNum(rr),
      returnedCreditQty: qNum(rc),
      shortClosedQty: qNum(sc),
      openQty: qNum(Math.max(0, ordered - (accepted - rr - rc) - sc)),
      receiptStatus: r.receipt_status,
    };
  });
}

/** The PO's hotel set, [{id, name}] by id. */
async function loadHotels(t, hotelIds) {
  if (!hotelIds.length) return [];
  const rows = await t.any(
    `SELECT id, name FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[]) ORDER BY id`,
    [hotelIds]
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

/**
 * DispatchSummary[] of a PO (every status), oldest first; one dispatch when
 * `dispatchId` is given.
 */
export async function loadDispatches(t, poId, { dispatchId = null } = {}) {
  const heads = await t.any(
    `SELECT pd.id, pd.dispatch_number, pd.hotel_id, h.name AS hotel_name, pd.delivery_id, d.phase_no,
            pd.status, pd.challan_no, pd.challan_date::text AS challan_date,
            pd.expected_delivery_date::text AS expected_delivery_date,
            pd.eway_bill_no, pd.vehicle_no, pd.transporter, pd.remarks, pd.created_at
       FROM tbl_po_dispatch pd
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = pd.hotel_id
       LEFT JOIN tbl_po_delivery d ON d.id = pd.delivery_id
      WHERE pd.po_id = $1 AND ($2::int IS NULL OR pd.id = $2)
      ORDER BY pd.id`,
    [poId, dispatchId]
  );
  if (!heads.length) return [];
  const lines = await t.any(
    `SELECT l.dispatch_id, l.po_line_id, pv.name AS product_name, l.qty::text AS qty
       FROM tbl_po_dispatch_line l
       JOIN tbl_purchase_order_product pop ON pop.id = l.po_line_id
       LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       LEFT JOIN tbl_product_variant pv ON pv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
      WHERE l.dispatch_id = ANY($1::int[])
      ORDER BY l.dispatch_id, l.po_line_id`,
    [heads.map((h) => Number(h.id))]
  );
  const byDispatch = new Map();
  for (const l of lines) {
    const key = Number(l.dispatch_id);
    if (!byDispatch.has(key)) byDispatch.set(key, []);
    byDispatch.get(key).push({ poLineId: Number(l.po_line_id), productName: l.product_name ?? null, qty: Number(l.qty) });
  }
  return heads.map((h) => ({
    id: Number(h.id),
    dispatchNumber: h.dispatch_number,
    hotelId: h.hotel_id == null ? null : Number(h.hotel_id),
    hotelName: h.hotel_name ?? null,
    deliveryId: h.delivery_id == null ? null : Number(h.delivery_id),
    phaseNo: h.phase_no == null ? null : Number(h.phase_no),
    status: h.status,
    challanNo: h.challan_no ?? null,
    challanDate: h.challan_date ?? null,
    expectedDeliveryDate: h.expected_delivery_date ?? null,
    ewayBillNo: h.eway_bill_no ?? null,
    vehicleNo: h.vehicle_no ?? null,
    transporter: h.transporter ?? null,
    remarks: h.remarks ?? null,
    createdAt: h.created_at ? new Date(h.created_at).toISOString() : null,
    lines: byDispatch.get(Number(h.id)) || [],
  }));
}

/** RtvSummary[] of a PO (B5's tables), oldest first. */
async function loadRtvSummaries(t, poId) {
  const rows = await t.any(
    `SELECT r.id, r.rtv_number, r.grn_id, r.hotel_id, h.name AS hotel_name, r.disposition, r.status,
            r.challan_no, r.credit_note_ref, r.remarks, r.created_at
       FROM tbl_rtv r
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = r.hotel_id
      WHERE r.po_id = $1
      ORDER BY r.id`,
    [poId]
  );
  if (!rows.length) return [];
  const lines = await rtvLines(t, rows.map((r) => Number(r.id)));
  return rows.map((r) => ({
    id: Number(r.id),
    rtvNumber: r.rtv_number ?? null,
    grnId: Number(r.grn_id),
    hotelId: Number(r.hotel_id),
    hotelName: r.hotel_name ?? null,
    disposition: r.disposition,
    status: r.status,
    challanNo: r.challan_no ?? null,
    creditNoteRef: r.credit_note_ref ?? null,
    remarks: r.remarks ?? null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    lines: lines.get(Number(r.id)) || [],
  }));
}

async function rtvLines(t, rtvIds) {
  const rows = await t.any(
    `SELECT rl.rtv_id, rl.grn_line_id, pv.name AS product_name, rl.qty::text AS qty, rl.reason
       FROM tbl_rtv_line rl
       JOIN tbl_grn_line gl ON gl.id = rl.grn_line_id
       JOIN tbl_purchase_order_product pop ON pop.id = gl.po_line_id
       LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       LEFT JOIN tbl_product_variant pv ON pv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
      WHERE rl.rtv_id = ANY($1::int[])
      ORDER BY rl.rtv_id, rl.id`,
    [rtvIds]
  );
  const out = new Map();
  for (const l of rows) {
    const key = Number(l.rtv_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({ grnLineId: Number(l.grn_line_id), productName: l.product_name ?? null, qty: Number(l.qty), reason: l.reason ?? null });
  }
  return out;
}

/** The vendor-safe views of the receiving documents: no prices, no buyer staff names. */
export async function loadVendorDocuments(t, poId) {
  const [grns, rtvs, shortCloses] = await Promise.all([
    t.any(
      `SELECT g.id, g.grn_number, h.name AS hotel_name, g.received_at::text AS received_at, g.doc_type, g.status
         FROM tbl_grn g
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = g.hotel_id
        WHERE g.po_id = $1 AND g.status <> 'draft'
        ORDER BY g.id`,
      [poId]
    ),
    loadRtvSummaries(t, poId),
    listShortCloses(t, poId),
  ]);
  const grnLines = grns.length
    ? await t.any(
      `SELECT gl.grn_id, pv.name AS product_name, gl.accepted_qty::text AS accepted_qty,
              gl.rejected_qty::text AS rejected_qty, gl.rejection_reason
         FROM tbl_grn_line gl
         JOIN tbl_purchase_order_product pop ON pop.id = gl.po_line_id
         LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
         LEFT JOIN tbl_product_variant pv ON pv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
        WHERE gl.grn_id = ANY($1::int[])
        ORDER BY gl.grn_id, gl.id`,
      [grns.map((g) => Number(g.id))]
    )
    : [];
  const linesByGrn = new Map();
  for (const l of grnLines) {
    const key = Number(l.grn_id);
    if (!linesByGrn.has(key)) linesByGrn.set(key, []);
    linesByGrn.get(key).push({
      productName: l.product_name ?? null,
      acceptedQty: Number(l.accepted_qty),
      rejectedQty: Number(l.rejected_qty),
      rejectionReason: l.rejection_reason ?? null,
    });
  }
  return {
    grns: grns.map((g) => ({
      grnNumber: g.grn_number ?? null,
      hotelName: g.hotel_name ?? null,
      receivedAt: g.received_at,
      docType: g.doc_type,
      status: g.status,
      lines: linesByGrn.get(Number(g.id)) || [],
    })),
    rtvs: rtvs
      .filter((r) => r.status === 'dispatched' || r.status === 'closed')
      .map((r) => ({
        rtvNumber: r.rtvNumber,
        hotelName: r.hotelName,
        disposition: r.disposition,
        status: r.status,
        challanNo: r.challanNo,
        creditNoteRef: r.creditNoteRef,
        createdAt: r.createdAt,
        lines: r.lines.map((l) => ({ productName: l.productName, qty: l.qty, reason: l.reason })),
      })),
    shortCloses: shortCloses.map((s) => ({
      productName: s.productName,
      hotelName: s.hotelName,
      phaseNo: s.phaseNo,
      qty: s.qty,
      action: s.action,
      reasonCode: s.reasonCode,
      remarks: s.remarks,
      actedAt: s.actedAt,
    })),
  };
}

// ─── buyer payload ──────────────────────────────────────────────────────────

/** What the caller may do on this PO's Deliveries tab. */
async function canFlags(t, user, tenancy, ctx) {
  const tuple = {
    hospitality_company_id: tenancy.hospitality_company_id,
    hotel_id: tenancy.hotel_id,
    department_id: tenancy.department_id,
    process_id: tenancy.process_id,
  };
  const [canInitiate, receiveHotels, reverseHotels] = await Promise.all([
    canInitiateOnTuple(user, tuple, t),
    hotelIdsWithPermission(t, user, 'grn', 'create'),
    hotelIdsWithPermission(t, user, 'grn', 'approve'),
  ]);
  const status = String(ctx.status);
  const open = !CLOSED_PO_STATUSES.includes(status);
  const atPoHotel = (ids) => ids.some((h) => ctx.hotelIds.includes(h));
  // The PO's hotels where the caller may receive (grn.create): the gate of
  // receiving, and of site-rep links (siteRepService issues and revokes on
  // grn.create at the link's hotel).
  const receiveAt = ctx.hotelIds.filter((h) => receiveHotels.includes(h));
  return {
    editPlan: canInitiate && open,
    shortClose: canInitiate && open,
    receive: receiveAt.length > 0 && RECEIVABLE_PO_STATUSES.includes(status),
    reverse: atPoHotel(reverseHotels),
    manageSiteRep: receiveAt.length > 0 && open,
    siteRepHotelIds: receiveAt,
  };
}

/**
 * The PO's site-rep receiving links, newest first, without the token: who,
 * where, until when. `live` is LIVE_TOKEN_SQL, the predicate token auth uses;
 * `revoked` means the buyer (or a newer link at that hotel) revoked it.
 */
async function loadSiteReps(t, poId) {
  const rows = await t.any(
    `SELECT tl.id, tl.name, tl.email, tl.phone, tl.hotel_id, h.name AS hotel_name,
            COALESCE(tl.expires_at, tl.created_at + interval '${RECEIVE_TOKEN_TTL_DAYS} days') AS expires_at,
            tl.last_used_at, tl.created_at,
            (tl.revoked_at IS NOT NULL) AS revoked,
            (${LIVE_TOKEN_SQL}) AS live
       FROM tbl_token_login_data tl
       JOIN tbl_rfq_purchase_order po ON po.id = tl.entity_id
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = tl.hotel_id
      WHERE tl.token_type = 'GRN' AND tl.entity_id = $1
      ORDER BY tl.id DESC`,
    [poId]
  );
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  return rows.map((r) => ({
    tokenId: Number(r.id),
    name: r.name,
    email: r.email ?? null,
    phone: r.phone ?? null,
    hotelId: r.hotel_id == null ? null : Number(r.hotel_id),
    hotelName: r.hotel_name ?? null,
    expiresAt: iso(r.expires_at),
    lastUsedAt: iso(r.last_used_at),
    createdAt: iso(r.created_at),
    revoked: r.revoked === true,
    live: r.live === true,
  }));
}

async function buyerPayload(t, user, poId, tenancy) {
  const ctx = await getPoContext(t, poId);
  const [hotels, deliveries, poLines, grns, dispatches, rtvs, invoices, shortCloses, siteReps, can, active] = await Promise.all([
    loadHotels(t, ctx.hotelIds),
    loadDeliveries(t, ctx),
    loadPoLineRolls(t, poId),
    listGrnSummariesForPo(t, poId),
    loadDispatches(t, poId),
    loadRtvSummaries(t, poId),
    loadInvoices(t, poId),
    listShortCloses(t, poId),
    loadSiteReps(t, poId),
    canFlags(t, user, tenancy, ctx),
    planHasActivity(t, poId),
  ]);
  const planLocked = Boolean(ctx.planLockedAt) || active ||
    (ctx.receiptLegacy && ctx.receiptStatus === 'received');
  return {
    poId,
    receiptStatus: ctx.receiptStatus,
    receiptLegacy: ctx.receiptLegacy,
    planLocked,
    planLockedAt: ctx.planLockedAt,
    editable: planLocked || CLOSED_PO_STATUSES.includes(String(ctx.status)) ? 'dates_only' : 'all',
    hotels,
    deliveries,
    poLines,
    grns,
    dispatches,
    rtvs,
    invoices,
    shortCloses,
    siteReps,
    can,
  };
}

/**
 * The buyer's Deliveries tab for a PO (contract: GET /po/:poId/deliveries).
 * Gives the PO its default plan on first read.
 * @throws PoAccessError (404) when the caller cannot see the PO.
 */
export async function getDeliveries(t, user, poId) {
  assertBuyerStaff(user);
  const tenancy = await assertPoAccess(user, poId, t);
  const id = Number(tenancy.id);
  const ctx = await getPoContext(t, id);
  await refreshPlan(t, ctx, positiveInt(user?.id));
  return buyerPayload(t, user, id, tenancy);
}

// ─── editing ────────────────────────────────────────────────────────────────

/** Refuse an edit on a PO whose plan can no longer change shape. */
async function assertPlanEditable(t, ctx) {
  const status = String(ctx.status);
  if (CLOSED_PO_STATUSES.includes(status)) {
    throw new InventoryError('LOCKED', `This purchase order is ${status.replace(/_/g, ' ')}; its delivery plan cannot change`, { poStatus: status });
  }
  if (ctx.planLockedAt) {
    throw new InventoryError('LOCKED', 'Goods have been dispatched or received against this purchase order, so its delivery quantities are fixed. Due dates of phases with nothing received can still move.', { planLockedAt: ctx.planLockedAt });
  }
  if (ctx.receiptLegacy && ctx.receiptStatus === 'received') {
    throw new InventoryError('LOCKED', 'This purchase order was received before delivery plans existed', { receiptLegacy: true });
  }
  if (await planHasActivity(t, Number(ctx.po.id))) {
    throw new InventoryError('LOCKED', 'Goods have been received or short-closed against this purchase order, so its delivery quantities are fixed', {});
  }
}

/**
 * Validate a full plan against the PO. Returns normalised deliveries with
 * quantities as 1/10000 integers.
 */
function validatePlan(input, { hotelIds, lines, minDay }) {
  if (!Array.isArray(input) || !input.length) {
    throw new InventoryError('VALIDATION', 'A delivery plan needs at least one delivery', { field: 'deliveries' });
  }
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const seenPhase = new Set();
  const totals = new Map(lines.map((l) => [l.id, 0]));
  const out = [];

  input.forEach((raw, index) => {
    const d = raw && typeof raw === 'object' ? raw : {};
    let hotelId = null;
    if (d.hotelId != null && d.hotelId !== '') {
      hotelId = positiveInt(d.hotelId);
      if (!hotelId || !hotelIds.includes(hotelId)) {
        throw new InventoryError('VALIDATION', 'This purchase order is not delivered to that hotel', {
          field: 'hotelId', index, hotelId: hotelId ?? d.hotelId,
        });
      }
    }
    const phaseNo = positiveInt(d.phaseNo);
    if (!phaseNo || phaseNo > 999) {
      throw new InventoryError('VALIDATION', 'Each delivery needs a phase number (1 or more)', { field: 'phaseNo', index });
    }
    const phaseKey = `${hotelId ?? 0}:${phaseNo}`;
    if (seenPhase.has(phaseKey)) {
      throw new InventoryError('VALIDATION', `Phase ${phaseNo} appears twice for the same hotel`, {
        field: 'phaseNo', index, hotelId, phaseNo,
      });
    }
    seenPhase.add(phaseKey);
    const dueDate = validDueDate(d.dueDate, minDay, { index });
    let remarks = d.remarks == null ? null : String(d.remarks).trim();
    if (remarks === '') remarks = null;
    if (remarks && remarks.length > 2000) {
      throw new InventoryError('VALIDATION', 'Remarks are limited to 2000 characters', { field: 'remarks', index });
    }
    if (!Array.isArray(d.lines)) {
      throw new InventoryError('VALIDATION', 'Each delivery needs its lines', { field: 'lines', index });
    }
    const seenLine = new Set();
    const planned = [];
    for (const l of d.lines) {
      const poLineId = positiveInt(l?.poLineId);
      if (!poLineId || !lineById.has(poLineId)) {
        throw new InventoryError('VALIDATION', 'That line is not on this purchase order', {
          field: 'lines', index, poLineId: l?.poLineId ?? null,
        });
      }
      if (seenLine.has(poLineId)) {
        throw new InventoryError('VALIDATION', 'A line appears twice in the same delivery', { field: 'lines', index, poLineId });
      }
      seenLine.add(poLineId);
      const q = parseQty(l?.plannedQty);
      if (q == null || q < 0) {
        throw new InventoryError('VALIDATION', 'Planned quantities must be zero or more, with at most 4 decimals', {
          field: 'plannedQty', index, poLineId,
        });
      }
      totals.set(poLineId, totals.get(poLineId) + q);
      planned.push({ poLineId, q });
    }
    if (!planned.some((p) => p.q > 0)) {
      throw new InventoryError('VALIDATION', 'A delivery must carry some quantity', { field: 'lines', index, hotelId, phaseNo });
    }
    out.push({ hotelId, phaseNo, dueDate, remarks, lines: planned });
  });

  for (const line of lines) {
    const planned = totals.get(line.id);
    const ordered = toQ(line.orderedQty);
    if (planned !== ordered) {
      const unit = line.unit ? ` ${line.unit}` : '';
      throw new InventoryError(
        'VALIDATION',
        `${line.productName || 'A line'}: the plan totals ${fmtQty(planned)}${unit} but ${fmtQty(ordered)}${unit} were ordered`,
        { field: 'lines', poLineId: line.id, productName: line.productName, plannedQty: qNum(planned), orderedQty: qNum(ordered) }
      );
    }
  }
  return out;
}

/**
 * Replace a PO's delivery plan (contract: PUT /po/:poId/deliveries). Every PO
 * line must be planned in full across the deliveries (unallocated included).
 * Allowed until the first dispatch or receipt, on a PO that is still live.
 *
 * @returns the GET payload after the change.
 * @throws PoAccessError (404), PoWritePermissionError (403),
 *   InventoryError LOCKED | VALIDATION.
 */
export async function savePlan(t, user, poId, deliveries) {
  assertBuyerStaff(user);
  const tenancy = await assertPoInitiateAccess(user, poId, t);
  const id = Number(tenancy.id);
  const ctx = await getPoContext(t, id, { forUpdate: true });
  await assertPlanEditable(t, ctx);

  const [lines, minDay] = await Promise.all([listPoLines(t, id), poDay(t, id)]);
  const plan = validatePlan(deliveries, { hotelIds: ctx.hotelIds, lines, minDay });
  if (!ctx.companyId) {
    throw new InventoryError('CONFLICT', "The purchase order's company could not be resolved", { poId: id });
  }

  const userId = positiveInt(user?.id);
  await t.none(`DELETE FROM tbl_po_delivery WHERE po_id = $1`, [id]);
  for (const d of plan) {
    const row = await t.one(
      `INSERT INTO tbl_po_delivery (hospitality_company_id, po_id, hotel_id, phase_no, due_date, remarks, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
      [ctx.companyId, id, d.hotelId, d.phaseNo, d.dueDate, d.remarks, userId]
    );
    const live = d.lines.filter((l) => l.q > 0);
    await t.none(
      `INSERT INTO tbl_po_delivery_line (hospitality_company_id, delivery_id, po_line_id, planned_qty, created_by, updated_by)
       SELECT $1, $2, v.po_line_id, v.planned_qty, $5, $5
         FROM unnest($3::int[], $4::numeric[]) AS v(po_line_id, planned_qty)`,
      [ctx.companyId, row.id, live.map((l) => l.poLineId), live.map((l) => qStr(l.q)), userId]
    );
  }
  await recomputePoReceipt(t, id);
  return buyerPayload(t, user, id, tenancy);
}

/**
 * Move one delivery's due date (contract: PATCH /po/:poId/deliveries/:deliveryId).
 * Works on a locked plan, for a delivery that has received nothing.
 * `dueDate` null clears it.
 *
 * @returns the GET payload after the change.
 * @throws PoAccessError (404), PoWritePermissionError (403),
 *   InventoryError NOT_FOUND (delivery of another PO) | LOCKED | VALIDATION.
 */
export async function patchDueDate(t, user, poId, deliveryId, dueDate) {
  assertBuyerStaff(user);
  const tenancy = await assertPoInitiateAccess(user, poId, t);
  const id = Number(tenancy.id);
  const ctx = await getPoContext(t, id, { forUpdate: true });
  const status = String(ctx.status);
  if (CLOSED_PO_STATUSES.includes(status)) {
    throw new InventoryError('LOCKED', `This purchase order is ${status.replace(/_/g, ' ')}; its delivery dates cannot change`, { poStatus: status });
  }
  const did = positiveInt(deliveryId);
  const delivery = did
    ? await t.oneOrNone(`SELECT id, status FROM tbl_po_delivery WHERE id = $1 AND po_id = $2 FOR UPDATE`, [did, id])
    : null;
  if (!delivery) throw new InventoryError('NOT_FOUND', 'Delivery not found', { deliveryId: deliveryId ?? null });

  const received = await t.one(
    `SELECT EXISTS (SELECT 1
                      FROM tbl_grn_line_alloc a
                      JOIN tbl_po_delivery_line dl ON dl.id = a.delivery_line_id
                      JOIN tbl_grn_line gl ON gl.id = a.grn_line_id
                      JOIN tbl_grn g ON g.id = gl.grn_id
                     WHERE dl.delivery_id = $1 AND g.status <> 'draft') AS v`,
    [did]
  );
  if (received.v || delivery.status === 'received' || delivery.status === 'short_closed') {
    throw new InventoryError('LOCKED', 'Goods have been received against this delivery, so its date is fixed', { deliveryId: did });
  }
  const day = validDueDate(dueDate, await poDay(t, id), { deliveryId: did });
  await t.none(
    `UPDATE tbl_po_delivery SET due_date = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
    [did, day, positiveInt(user?.id)]
  );
  return buyerPayload(t, user, id, tenancy);
}

/**
 * Called in the vendor-accept transaction, after status → approved: dates the
 * PO's untouched default plan (phase 1 only, one unallocated row or one row
 * per hotel, nothing received) with defaultDueDate, where no date is set.
 * A plan the buyer reshaped is left alone. No plan yet: nothing to do (the
 * first read creates it, dated). Returns the number of deliveries dated.
 */
export async function fillDefaultDueDates(t, poId) {
  const id = positiveInt(poId);
  if (!id) return 0;
  const rows = await t.any(`SELECT id, hotel_id, phase_no FROM tbl_po_delivery WHERE po_id = $1`, [id]);
  if (!rows.length) return 0;
  const allPhaseOne = rows.every((r) => Number(r.phase_no) === 1);
  const unallocated = rows.filter((r) => r.hotel_id == null).length;
  const untouched = allPhaseOne && ((rows.length === 1 && unallocated === 1) || unallocated === 0);
  if (!untouched || (await planHasActivity(t, id))) return 0;
  const due = await defaultDueDate(t, id);
  if (!due) return 0;
  const res = await t.result(
    `UPDATE tbl_po_delivery SET due_date = $2, updated_at = now() WHERE po_id = $1 AND due_date IS NULL`,
    [id, due]
  );
  return res.rowCount;
}

// ─── after commit ───────────────────────────────────────────────────────────

/**
 * What a committed plan change must set off, read inside the transaction:
 * the vendor is told once they have accepted the PO; the PO document they
 * hold is rewritten (it prints the plan) once they hold one.
 */
export async function planChangeFollowUp(t, poId, actorUserId) {
  const ctx = await getPoContext(t, poId);
  return {
    poId: Number(ctx.po.id),
    actorUserId: positiveInt(actorUserId),
    isCallOff: ctx.isCallOff,
    notifyVendor: isAccepted(ctx.status),
    regeneratePdf: vendorHoldsDocument(ctx.status),
  };
}

/** Run a plan change's follow-up after commit. Never throws. */
export async function runPlanChangeFollowUp(followUp) {
  if (!followUp) return;
  const { poId, actorUserId, isCallOff, notifyVendor, regeneratePdf } = followUp;
  if (regeneratePdf) {
    try {
      if (isCallOff) await generateCallOffPoPdf(poId);
      else await writePoDocument(poId, db);
    } catch (err) {
      logError(`[po ${poId}] PO document rewrite after a delivery plan change failed`, err);
    }
  }
  if (notifyVendor) {
    try {
      await notifyPlanChanged(db, { poId, actorUserId });
    } catch (err) {
      logError(`[po ${poId}] delivery plan notice failed`, err);
    }
  }
}

// Follow-ups queued per PO, so a PDF rendered from an older plan can never
// land after one rendered from a newer plan (in this process).
const followUpChains = new Map();

/**
 * Run a plan change's follow-up after the response has gone, behind any
 * earlier follow-up of the same PO. Never rejects.
 * @returns {Promise<void>} settles when this follow-up has run.
 */
export function queuePlanChangeFollowUp(followUp) {
  const key = positiveInt(followUp?.poId);
  if (!key) return Promise.resolve();
  const next = (followUpChains.get(key) || Promise.resolve()).then(() => runPlanChangeFollowUp(followUp));
  followUpChains.set(key, next);
  next.then(() => {
    if (followUpChains.get(key) === next) followUpChains.delete(key);
  });
  return next;
}

/** Settles once every queued follow-up has run (tests; graceful shutdown). */
export async function planFollowUpsSettled() {
  while (followUpChains.size) await Promise.allSettled([...followUpChains.values()]);
}

/**
 * The follow-up for a PO whose default plan was just dated at acceptance:
 * rewrite the document the vendor holds; no notice (they just accepted).
 */
export function acceptanceDatesFollowUp(po, actorUserId = null) {
  return {
    poId: positiveInt(po?.id),
    actorUserId: positiveInt(actorUserId),
    isCallOff: po?.is_call_off === true,
    notifyVendor: false,
    regeneratePdf: true,
  };
}

/** Activity-log scope for a PO, from the PO row (never a header). */
export async function poActivityScope(t, poId) {
  const ctx = await getPoContext(t, poId);
  return {
    hospitalityCompanyId: ctx.companyId,
    hotelId: ctx.hotelIds.length === 1 ? ctx.hotelIds[0] : null,
    entityLabel: ctx.po.po_number || null,
  };
}

export default {
  getDeliveries,
  savePlan,
  patchDueDate,
  fillDefaultDueDates,
  ensureCurrentPlan,
  planChangeFollowUp,
  runPlanChangeFollowUp,
  queuePlanChangeFollowUp,
  planFollowUpsSettled,
  acceptanceDatesFollowUp,
  poActivityScope,
  loadDeliveries,
  loadPoLineRolls,
  loadDispatches,
  loadVendorDocuments,
};
