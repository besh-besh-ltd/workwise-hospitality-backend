// Goods receipt (mark in): the receive context, GRN drafts, posting with
// allocation to the delivery plan, reversals, attachments and the legacy
// markGRN full receipt (spec §6).
//
// One posting runs in ONE transaction: GRN document, plan allocations, PO
// counters, ledger rows and balances commit together or not at all. Lock order
// inside that transaction, the same for every receiving action:
//   1. the PO row            (getPoContext {forUpdate})
//   2. its delivery lines    (SELECT … FOR UPDATE ORDER BY id)
//   2a. item rows, FOR NO KEY UPDATE, in product-variant order, only for a
//       line that sets an item's unit conversion (resolvePostLine)
//   3. the doc sequence row  (nextDocNumber)
//   4. stock balances        (postMovements, called once)
// The PO row lock (step 1) is the serialisation point. These entry points take
// it first, before any GRN row lock: postGrn (new receipt or saved draft),
// saveGrnDraft on an existing draft, discardGrn, reverseGrn and
// postLegacyFullReceipt; getReceiveContext takes it only when it creates the
// default plan (ensureDefaultPlan). Saving a NEW draft and the attachment
// calls take no PO lock. So two receivers on the same PO run one after the
// other and the second checks over-receipt against the first's committed
// receipt (Review Focus 1). The delivery-line locks (step 2) are a second
// guard for writers that touch the plan without the PO lock. Step 2a stops
// two receipts on DIFFERENT POs from both setting an item's first conversion.
//
// Quantities are handled as integers of 1/10000 (NUMERIC(18,4)) so sums and
// tolerance checks have no float drift. Plan quantities (planned, accepted,
// rejected) are in PO units; ledger quantities are in the item's stock unit.
//
// Tenancy comes from the PO row (getPoContext → resolvePoTenancy) and the
// user's role scopes (assertHotelPermission, company + hotel axes). A hotel
// outside the PO's hotel set, a foreign PO or a foreign GRN is NOT_FOUND.
//
// Services never respond. The caller sends notifyGrnPosted AFTER commit.
//
// Count freeze (spec §8.5): posting (here, the site-rep link and the legacy
// markGRN) and reversal answer LOCKED while a count freezes the hotel; saving
// a draft does not. A replay of a posted clientEventId is answered first.
//
// This file is the public entry (import from here): posting, drafts,
// attachments and the legacy full receipt live here; the rest is split out
// and re-exported:
//   grnCommon.js       constants, quantity/date helpers, access checks, and
//                      the row writers shared by posting and reversal
//   allocation.js      delivery-plan state, capacity and the allocator
//   grnRead.js         the Grn payload, one GRN, the GRN list
//   receiveContext.js  the Receive screen context
//   grnReverse.js      reversals

import { InventoryError } from './errors.js';
import { hotelIdsWithPermission } from './scope.js';
import { getEffectiveSettings } from './settings.js';
import { nextDocNumber } from './docNumber.js';
import { postMovements } from './ledger.js';
import { getPoContext, listPoLines, ensureDefaultPlan } from './planCore.js';
import { resolveItemForVariant, mapVariantToItem } from './items.js';
import { resolveUomFactor, setUomFactor, sameUom, normalizeUomLabel } from './uom.js';
import { resolvePoLineUnitCost } from './cost.js';
import { loadPlan, capacityFor, makeAllocator } from './allocation.js';
import { assertNotFrozen } from './stockCommon.js';
import {
  RECEIVABLE_PO_STATUSES, REJECTION_REASONS, ATTACHMENT_KINDS, SITE_REP_ACTOR, IST_TODAY, positiveInt, toQ,
  qNum, qStr, round4, round6, numOrNull, textOrNull, notFound, invalid, isoDay, dayDiff, clientEventIdOf,
  quantityQ, attachmentUrl, attachmentKeyFromUrl, assertReceivable, assertToken, tokenHotelId,
  assertReceiveAccess, assertGrnAccess, loadGrnRow, inventoryUpdateGate, categoryDefaults, insertGrnLine,
  afterReceiptChange,
} from './grnCommon.js';
import { getGrnPayload, getGrn, listGrns } from './grnRead.js';
import { reverseGrn } from './grnReverse.js';
import { getReceiveContext } from './receiveContext.js';

// The public API of the split-out modules, re-exported from this entry.
export {
  RECEIVABLE_PO_STATUSES, REJECTION_REASONS, ATTACHMENT_KINDS, SITE_REP_ACTOR, attachmentUrl, attachmentKeyFromUrl,
  getGrnPayload, getGrn, listGrns, getReceiveContext, reverseGrn,
};

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
// items, categories, costs
// ---------------------------------------------------------------------------

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

  const settingFactor = line.uomFactor != null && !sameUom(poUnit, item.stockUom);
  if (settingFactor) {
    // Serialise conversions of this item across POs: a concurrent receipt that
    // sets this unit first commits, and the read below then sees its factor
    // (and refuses a different one) instead of both writing. NO KEY UPDATE, not
    // UPDATE: it still excludes other writers here but not the FK key-share
    // locks ledger inserts take on the item, so it cannot deadlock with them.
    // Lines resolve in variant order, so two receipts take these in one order.
    await t.one(`SELECT 1 FROM tbl_inv_item WHERE id = $1 FOR NO KEY UPDATE`, [item.id]);
  }
  let factor = await resolveUomFactor(t, { invItemId: item.id, uomLabel: poUnit });
  if (settingFactor) {
    const supplied = round6(line.uomFactor);
    if (factor == null) {
      // First receipt in this unit: the receiver may set the conversion.
      await requireInventoryUpdate();
      const saved = await setUomFactor(t, { invItemId: item.id, uomLabel: poUnit, factor: supplied, userId });
      factor = saved.factor;
    } else if (Math.abs(factor - supplied) > 1e-9) {
      // An existing conversion is never overwritten from a receipt: changing it
      // would silently revalue every later receipt in this unit.
      throw invalid(
        `${item.displayName} is already set to ${factor} ${item.stockUom} per ${normalizeUomLabel(poUnit) || 'PO unit'}; ` +
          'ask your inventory controller to change the unit conversion',
        { code_detail: 'UOM_FACTOR_MISMATCH', poLineId: poLine.id, currentFactor: factor, suppliedFactor: supplied }
      );
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
  // A receipt moves stock, so a count freeze at the hotel refuses it (LOCKED).
  // Every caller has answered its replay before getting here; drafts never come here.
  await assertNotFrozen(t, { companyId: ctx.companyId, hotelId });

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
  // Items are resolved (and lazily created / mapped) in product-variant order,
  // so two receipts creating the same items take those row locks in the same
  // order. The lines keep their input order.
  const resolveOrder = active
    .map((line, index) => ({ line, index, variantId: poLines.get(line.poLineId).productVariantId ?? 0 }))
    .sort((a, b) => a.variantId - b.variantId || a.index - b.index);
  const resolved = new Array(active.length);
  for (const { line, index } of resolveOrder) {
    resolved[index] = await resolvePostLine(t, {
      ctx, hotelId, poLine: poLines.get(line.poLineId), line, receivedAt, userId,
      requireInventoryUpdate, warnings, settings,
    });
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
  await recordLegacyGrnTimeline(t, ctx.po, { userId, remarks: header.remarks });
  const grn = await getGrnPayload(t, id, { hidePrices: !!viaToken });
  return { grn: { ...grn, warnings }, replayed: false, created: !grnId };
}

/**
 * PO timeline "GRN Marked" for a PO on the legacy approval flow
 * (approval_instance_id IS NULL): the first posted receipt writes the same
 * 'grn' tbl_approval_hierarchy_history row the old markGRN wrote, so
 * getPODetailsById keeps showing it. Later receipts add nothing (one row per
 * PO approval transaction). approved_by -1 = a GRN-token site rep, as before.
 */
async function recordLegacyGrnTimeline(t, po, { userId, remarks }) {
  if (po.approval_instance_id != null) return;
  const txn = await t.oneOrNone(
    `SELECT id FROM tbl_approval_hierarchy_transactions
      WHERE hierarchy_type = 'po' AND target_entity_id = $1
      ORDER BY id DESC LIMIT 1`,
    [po.id]
  );
  if (!txn) return;
  await t.none(
    `INSERT INTO tbl_approval_hierarchy_history (approval_transaction_id, approved_by, action, remarks)
     SELECT $1, $2, 'grn', $3
      WHERE NOT EXISTS (SELECT 1 FROM tbl_approval_hierarchy_history
                         WHERE approval_transaction_id = $1 AND action = 'grn')`,
    [txn.id, userId ?? -1, remarks ?? null]
  );
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
    // Same lock order as posting (PO row, then the GRN row): PUT {post:true}
    // and POST /:id/post on one draft must not lock in opposite orders.
    const first = await loadGrnRow(t, grnId);
    await assertGrnAccess(t, user, first, 'update', { viaToken });
    ctx = await getPoContext(t, first.po_id, { forUpdate: true });
    const grn = await loadGrnRow(t, first.id, { forUpdate: true });
    if (Number(grn.hotel_id) !== Number(first.hotel_id)) await assertGrnAccess(t, user, grn, 'update', { viaToken });
    if (grn.status !== 'draft' || grn.doc_type !== 'RECEIPT') {
      throw new InventoryError('CONFLICT', 'Only a draft GRN can be edited', { grnId: grn.id, status: grn.status });
    }
    hotelId = viaToken ? Number(grn.hotel_id) : header.hotelId ?? Number(grn.hotel_id);
    // Moving a draft to another hotel starts a receipt there: grn.create at the target.
    if (hotelId !== Number(grn.hotel_id)) await assertReceiveAccess(t, user, ctx, hotelId, { action: 'create' });
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

/** Delete a draft GRN (grn.update). PO row, then GRN row, as posting does. */
export async function discardGrn(t, user, grnId) {
  const first = await loadGrnRow(t, grnId);
  await assertGrnAccess(t, user, first, 'update');
  await getPoContext(t, first.po_id, { forUpdate: true });
  const grn = await loadGrnRow(t, first.id, { forUpdate: true });
  if (Number(grn.hotel_id) !== Number(first.hotel_id)) await assertGrnAccess(t, user, grn, 'update');
  if (grn.status !== 'draft') {
    throw new InventoryError('CONFLICT', 'Only a draft GRN can be discarded', { grnId: grn.id, status: grn.status });
  }
  await t.none(`DELETE FROM tbl_grn WHERE id = $1`, [grn.id]);
  return {
    deleted: true, grnId: Number(grn.id), companyId: Number(grn.hospitality_company_id), hotelId: Number(grn.hotel_id),
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
// legacy POST /po/markGRN
// ---------------------------------------------------------------------------

const useReceive = (message, details = {}) =>
  new InventoryError('USE_RECEIVE', message, details, 409);

/**
 * Early gate for the legacy full receipt, before the receiving hotel is known:
 * a token must be a GRN token of this PO; a buyer must hold grn.create at one
 * of the PO's hotels (else NOT_FOUND outside the company, FORBIDDEN inside).
 * The hotel-level check still runs once the hotel is picked.
 */
async function assertLegacyCaller(t, actor, ctx, viaToken) {
  if (viaToken) {
    await assertToken(t, viaToken, ctx.po.id, null);
    return;
  }
  const allowed = new Set(await hotelIdsWithPermission(t, actor, 'grn', 'create'));
  if (ctx.hotelIds.some((h) => allowed.has(h))) return;
  await assertReceiveAccess(t, actor, ctx, ctx.hotelIds[0], { action: 'create' });
  throw new InventoryError('FORBIDDEN', 'You do not have permission to receive this purchase order');
}

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
  // Who may receive at all comes before what state the PO is in: a caller
  // without access hears 404/403, never the PO's receipt state.
  await assertLegacyCaller(t, actor, ctx, viaToken);
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
