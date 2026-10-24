// The Receive screen context for one PO at one hotel (part of the GRN
// service; import from grnService.js): open quantities per line, unit
// conversions, category defaults, departments, dispatches in transit and the
// caller's open draft. Token views hide prices.

import { InventoryError } from './errors.js';
import { hotelIdsWithPermission } from './scope.js';
import { getEffectiveSettings } from './settings.js';
import { getPoContext, listPoLines, ensureDefaultPlan } from './planCore.js';
import { suggestItems } from './items.js';
import { resolveUomFactor } from './uom.js';
import { resolvePoLineUnitCost } from './cost.js';
import { loadPlan, capacityFor } from './allocation.js';
import {
  positiveInt, toQ, qNum, numOrNull, notFound, assertReceivable, assertToken, assertReceiveAccess,
  categoryDefaults,
} from './grnCommon.js';
import { getGrnPayload } from './grnRead.js';

// ---------------------------------------------------------------------------
// receive context
// ---------------------------------------------------------------------------

/**
 * Everything the Receive screen needs for one PO at one hotel
 * (api-contract ReceiveContext). The hotel is the one asked for, else the only
 * one the user can receive at; with several and none asked for, `hotel` is
 * null and `lines` empty (the screen asks the user to pick). Each line carries
 * `costPerPoUnit` (stock cost per PO unit, GST in when the hotel says so;
 * omitted when prices are hidden).
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
      line.costPerPoUnit = cost.costPerPoUnit;
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
