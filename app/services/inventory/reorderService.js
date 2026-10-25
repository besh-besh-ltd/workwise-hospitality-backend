// Reorder (Task D3, spec §9): the reorder worklist, "Create MR draft" for
// contracted items, and the daily low-stock digest.
//
// Below reorder: on hand ≤ tbl_inv_hotel_item.reorder_level, for active items
// (an item with no level is never below: the same rule as the stock list and
// the overview). Quantities are in the item's stock unit.
//
// On order at hotel H, per item (spec §9):
//   - open qty on H's delivery-plan rows of live, non-legacy POs (status
//     approved / dispatched / GRN / invoice_raised, not fully received or
//     short-closed), for every variant mapped to the item:
//       open = max(0, planned − (accepted − returned for replacement −
//                  returned for credit) − short-closed)
//     A PO with no plan rows yet counts its lines' outstanding qty at H when
//     H is its only hotel (that is where its default plan will put it).
//   - plus approved MR lines at H not yet released to a call-off PO.
//   Unallocated plan rows (hotel_id NULL), and unplanned multi-hotel POs,
//   count for no hotel: they come back as groupOrdersOpen, a hint.
//   PO and MR units are converted to the stock unit (same unit, or a
//   tbl_inv_item_uom factor). A unit with no factor is left out and the row
//   says onOrderIncomplete; it is never taken at factor 1.
// suggestedQty = max(0, maxQty − qty − onOrder), rounded up to the smallest
//   barcode pack factor above 1, else to 0.01; null when the item has no max.
// Contracted: an active ARC contract line for a mapped variant at the hotel,
//   per department (mrModel.searchContractedItems). Only departments the
//   caller may raise an MR for are looked at (rates are commercial terms).
//
// Security: the hotel comes from the query but is gated against the caller's
// own role scopes (inventory.read for the list; inventory.update plus an MR
// cell for the draft). A foreign or out-of-scope hotel or department is
// NOT_FOUND. Never can().

import cron from 'node-cron';
import db from '../../config/dbConn.js';
import { logError } from '../../helper/common.js';
import mrModel from '../../models/mr/mrModel.js';
import { logger } from '../../util/logger.js';
import { hotelIdsWithPermission } from './scope.js';
import { RECEIVABLE_PO_STATUSES } from './grnService.js';
import { uomKey } from './uom.js';
import { notifyLowStockDigest, LOW_STOCK_DIGEST_TYPE } from './notices/digestNotices.js';
import {
  MAX_LINES, IST_TODAY, positiveInt, invalid, notFound, num, iso, toQty, assertDocAccess, loadCompanyItems,
} from './stockCommon.js';
import { InventoryError } from './errors.js';

const SUPER_ADMIN = 8;
const MR_USER_TYPES = [2, SUPER_ADMIN];
/** Every contracted line of a department at a hotel (the picker's own cap is 100). */
const CONTRACT_SCAN_LIMIT = 10000;

export const LOW_STOCK_SWEEP_LOCK_NS = 950701; // B6's namespace, another key
export const LOW_STOCK_SWEEP_LOCK_KEY = 'inventory:low_stock_sweep';

const OPEN_PLAN_QTY = `GREATEST(0, dl.planned_qty - (dl.accepted_qty - dl.returned_replace_qty - dl.returned_credit_qty)
                                   - dl.short_closed_qty)`;
const OPEN_LINE_QTY = `GREATEST(0, pop.quantity - (COALESCE(pop.accepted_qty, 0) - COALESCE(pop.returned_replace_qty, 0)
                                   - COALESCE(pop.returned_credit_qty, 0)) - COALESCE(pop.short_closed_qty, 0))`;

const round4 = (n) => Math.round(n * 10000) / 10000;
/** Up to the next multiple of `step` (4 dp safe). */
function ceilTo(n, step) {
  const units = Math.round(n * 10000);
  const s = Math.round(step * 10000);
  return (Math.ceil(units / s) * s) / 10000;
}

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

/** Active items at or below their reorder level at a hotel, by name. */
async function belowReorderItems(t, { hotelId, companyId }) {
  return t.any(
    `SELECT i.id, i.display_name, i.item_code, i.stock_uom,
            hi.reorder_level::text AS reorder_level, hi.max_qty::text AS max_qty, hi.min_qty::text AS min_qty,
            hi.bin_label, COALESCE(b.qty, 0)::text AS qty
       FROM tbl_inv_hotel_item hi
       JOIN tbl_inv_item i ON i.id = hi.inv_item_id AND i.hospitality_company_id = $2 AND i.is_active
       LEFT JOIN tbl_inv_balance b ON b.hotel_id = hi.hotel_id AND b.inv_item_id = hi.inv_item_id
      WHERE hi.hotel_id = $1
        AND hi.reorder_level IS NOT NULL
        AND COALESCE(b.qty, 0) <= hi.reorder_level
      ORDER BY i.display_name, i.id`,
    [hotelId, companyId]
  );
}

/** item id → { factorOf(label) → stock units per label, or null } */
async function unitConverters(t, items) {
  const ids = items.map((i) => i.id);
  const rows = ids.length
    ? await t.any(
        `SELECT inv_item_id, uom_label, factor_to_stock::text AS factor FROM tbl_inv_item_uom
          WHERE inv_item_id = ANY($1::int[]) ORDER BY id`,
        [ids]
      )
    : [];
  const factors = new Map();
  for (const r of rows) {
    const id = Number(r.inv_item_id);
    if (!factors.has(id)) factors.set(id, new Map());
    const key = uomKey(r.uom_label);
    if (!factors.get(id).has(key)) factors.get(id).set(key, Number(r.factor));
  }
  const stockUom = new Map(items.map((i) => [i.id, i.stockUom]));
  return (invItemId, label) => {
    const key = uomKey(label);
    if (!key) return null;
    if (key === uomKey(stockUom.get(invItemId))) return 1;
    return factors.get(invItemId)?.get(key) ?? null;
  };
}

/**
 * Open quantity on order for these items at the hotel, in stock units.
 * @returns {Promise<{onOrder:Map<number,number>, incomplete:Set<number>, group:Map<number,number>}>}
 */
async function onOrderAt(t, { hotelId, companyId, items, factorOf }) {
  const ids = items.map((i) => i.id);
  const onOrder = new Map();
  const group = new Map();
  const incomplete = new Set();
  if (!ids.length) return { onOrder, group, incomplete };

  const add = (map, invItemId, unit, qty, { flagMissing }) => {
    const factor = factorOf(invItemId, unit);
    if (factor == null) {
      if (flagMissing) incomplete.add(invItemId);
      return;
    }
    map.set(invItemId, round4((map.get(invItemId) ?? 0) + qty * factor));
  };

  const poRows = await t.any(
    `WITH po_base AS (
       SELECT po.id,
              COALESCE(r.hospitality_company_id, rh.hospitality_company_id, a.hospitality_company_id) AS company_id,
              CASE WHEN po.is_call_off THEN ARRAY[COALESCE(mr.hotel_id, a.hotel_id)]
                   ELSE COALESCE(
                     (SELECT array_agg(DISTINCT m.hotel_id) FROM tbl_rfq_hotel_mappings m WHERE m.rfq_id = r.id),
                     ARRAY[r.hotel_id])
              END AS hotel_ids
         FROM tbl_rfq_purchase_order po
         LEFT JOIN tbl_rfq r                         ON r.id = po.rfq_id
         LEFT JOIN tbl_hospitality_company_hotels rh ON rh.id = r.hotel_id
         LEFT JOIN tbl_arc_contract ac               ON ac.id = po.arc_contract_id
         LEFT JOIN tbl_arc a                         ON a.id = ac.arc_id
         LEFT JOIN tbl_material_requisition mr       ON mr.id = po.source_mr_id
        WHERE po.status::text = ANY($3::text[])
          AND po.receipt_legacy IS NOT TRUE
          AND po.receipt_status NOT IN ('received', 'closed_short')
     ),
     po_here AS (
       SELECT id, hotel_ids FROM po_base WHERE company_id = $2 AND $1 = ANY(hotel_ids)
     ),
     open_rows AS (
       -- this hotel's plan rows, and the unallocated ones (a hint only)
       SELECT d.hotel_id IS NULL AS unallocated, dl.po_line_id, ${OPEN_PLAN_QTY} AS open_qty
         FROM po_here p
         JOIN tbl_po_delivery d       ON d.po_id = p.id AND (d.hotel_id = $1 OR d.hotel_id IS NULL)
                                     AND d.status <> 'short_closed'
         JOIN tbl_po_delivery_line dl ON dl.delivery_id = d.id
       UNION ALL
       -- not planned yet: here when this is the PO's only hotel, else a hint
       SELECT cardinality(p.hotel_ids) > 1, pop.id, ${OPEN_LINE_QTY}
         FROM po_here p
         JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = p.id
        WHERE NOT EXISTS (SELECT 1 FROM tbl_po_delivery d WHERE d.po_id = p.id)
     )
     SELECT o.unallocated, iv.inv_item_id, pop.unit, sum(o.open_qty)::text AS open_qty
       FROM open_rows o
       JOIN tbl_purchase_order_product pop ON pop.id = o.po_line_id
       LEFT JOIN tbl_rfq_products rp       ON rp.id = pop.rfq_product_id
       JOIN tbl_inv_item_variant iv
         ON iv.hospitality_company_id = $2
        AND iv.product_variant_id = COALESCE(pop.product_variant_id, rp.product_variant_id)
      WHERE o.open_qty > 0 AND iv.inv_item_id = ANY($4::int[])
      GROUP BY o.unallocated, iv.inv_item_id, pop.unit`,
    [hotelId, companyId, [...RECEIVABLE_PO_STATUSES], ids]
  );
  for (const r of poRows) {
    const id = Number(r.inv_item_id);
    if (r.unallocated) add(group, id, r.unit, Number(r.open_qty), { flagMissing: false });
    else add(onOrder, id, r.unit, Number(r.open_qty), { flagMissing: true });
  }

  // Approved MRs not yet released to a call-off PO (release flips them to po_released).
  const mrRows = await t.any(
    `SELECT iv.inv_item_id, COALESCE(NULLIF(btrim(mi.uom), ''), ai.uom) AS unit, sum(mi.quantity)::text AS qty
       FROM tbl_material_requisition mr
       JOIN tbl_material_requisition_item mi ON mi.mr_id = mr.id
       LEFT JOIN tbl_arc_contract_line cl     ON cl.id = mi.arc_contract_line_id
       LEFT JOIN tbl_arc_item ai              ON ai.id = cl.arc_item_id
       JOIN tbl_inv_item_variant iv
         ON iv.hospitality_company_id = $2 AND iv.product_variant_id = mi.product_variant_id
      WHERE mr.hotel_id = $1 AND mr.hospitality_company_id = $2 AND mr.status = 'approved'
        AND iv.inv_item_id = ANY($3::int[])
      GROUP BY iv.inv_item_id, COALESCE(NULLIF(btrim(mi.uom), ''), ai.uom)`,
    [hotelId, companyId, ids]
  );
  for (const r of mrRows) add(onOrder, Number(r.inv_item_id), r.unit, Number(r.qty), { flagMissing: true });

  return { onOrder, group, incomplete };
}

/** Departments the user may raise an MR for at the hotel (super admin: all). */
async function mrDepartments(t, user, hotelId) {
  if (Number(user?.user_type) === SUPER_ADMIN) {
    return t.any(`SELECT id, title FROM tbl_department ORDER BY title`);
  }
  if (!MR_USER_TYPES.includes(Number(user?.user_type))) return [];
  return mrModel.hotelDepartmentsForUser(positiveInt(user.id), hotelId, t);
}

/**
 * Active contract lines at the hotel for these variants, per department the
 * caller may raise an MR for.
 * @returns {Promise<Array<object>>} searchContractedItems rows plus department_id
 */
async function contractedLines(t, { hotelId, companyId, departmentIds, variantIds }) {
  if (!departmentIds.length || !variantIds.size) return [];
  const withArcs = await t.any(
    `SELECT DISTINCT a.department_id
       FROM tbl_arc a
       JOIN tbl_arc_contract c ON c.arc_id = a.id AND c.status IN ('active', 'expiring_soon')
      WHERE a.hospitality_company_id = $1 AND (a.hotel_id = $2 OR a.is_group)
        AND a.department_id = ANY($3::int[])
      ORDER BY a.department_id`,
    [companyId, hotelId, departmentIds]
  );
  const out = [];
  for (const { department_id: dept } of withArcs) {
    const lines = await mrModel.searchContractedItems(
      { hotel_id: hotelId, department_id: Number(dept), limit: CONTRACT_SCAN_LIMIT },
      t
    );
    for (const l of lines) {
      if (variantIds.has(Number(l.product_variant_id))) out.push({ ...l, department_id: Number(dept) });
    }
  }
  return out;
}

/** Cheapest first, then the lowest line id: the line a reorder uses by default. */
const byRate = (a, b) =>
  Number(a.current_rate) - Number(b.current_rate) || Number(a.arc_contract_line_id) - Number(b.arc_contract_line_id);

async function variantsOf(t, companyId, itemIds) {
  const rows = itemIds.length
    ? await t.any(
        `SELECT inv_item_id, product_variant_id FROM tbl_inv_item_variant
          WHERE hospitality_company_id = $1 AND inv_item_id = ANY($2::int[])
          ORDER BY product_variant_id`,
        [companyId, itemIds]
      )
    : [];
  const map = new Map();
  for (const r of rows) {
    const id = Number(r.inv_item_id);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(Number(r.product_variant_id));
  }
  return map;
}

const toContracted = (l) => ({
  departmentId: l.department_id,
  arcId: Number(l.arc_id),
  arcNumber: l.arc_number ?? null,
  arcContractId: Number(l.arc_contract_id),
  arcContractLineId: Number(l.arc_contract_line_id),
  productVariantId: Number(l.product_variant_id),
  variantName: l.variant_name ?? null,
  unitRate: Number(l.current_rate),
  uom: l.uom ?? null,
  vendorId: l.vendor_id == null ? null : Number(l.vendor_id),
  vendorName: l.vendor_name ?? null,
});

// ---------------------------------------------------------------------------
// GET /reorder
// ---------------------------------------------------------------------------

/**
 * The reorder worklist at one hotel (default: the caller's first hotel with
 * inventory.read).
 *
 * @returns {Promise<{hotelId:number|null, hotels:Array<{id,name}>, stockStartedAt:string|null,
 *   departments:Array<{id,title}>, rows:Array<{invItemId, displayName, itemCode, stockUom, qty,
 *   minQty, reorderLevel, maxQty, binLabel, onOrder, onOrderIncomplete, suggestedQty, packFactor,
 *   avgDailyUse90d, productVariantId, variantIds, contracted, contractedLines}>,
 *   groupOrdersOpen:Array<{invItemId, openQty}>}>}
 *   contracted: the cheapest line over the caller's departments (null when
 *   none); contractedLines: the cheapest per department.
 * @throws {InventoryError} NOT_FOUND for a hotel the caller cannot read
 */
export async function getReorderList(t, user, { hotelId } = {}) {
  const readable = await hotelIdsWithPermission(t, user, 'inventory', 'read');
  let hotel;
  if (hotelId != null && hotelId !== '') {
    hotel = positiveInt(hotelId);
    if (!hotel) throw notFound('Hotel not found');
  } else {
    hotel = readable[0] ?? null;
  }
  const hotels = readable.length
    ? await t.any(`SELECT id, name FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[]) ORDER BY name, id`, [
        readable,
      ])
    : [];
  const empty = { hotelId: null, hotels: [], stockStartedAt: null, departments: [], rows: [], groupOrdersOpen: [] };
  if (!hotel) return empty;
  const { companyId } = await assertDocAccess(t, user, hotel, 'read');

  const started = await t.oneOrNone(`SELECT stock_started_at FROM tbl_inv_hotel_settings WHERE hotel_id = $1`, [hotel]);
  const base = await belowReorderItems(t, { hotelId: hotel, companyId });
  const items = base.map((r) => ({ id: Number(r.id), stockUom: r.stock_uom }));
  const ids = items.map((i) => i.id);

  const factorOf = await unitConverters(t, items);
  const { onOrder, group, incomplete } = await onOrderAt(t, { hotelId: hotel, companyId, items, factorOf });
  const variants = await variantsOf(t, companyId, ids);
  const departments = (await mrDepartments(t, user, hotel)).map((d) => ({ id: Number(d.id), title: d.title }));
  const lines = await contractedLines(t, {
    hotelId: hotel,
    companyId,
    departmentIds: departments.map((d) => d.id),
    variantIds: new Set([...variants.values()].flat()),
  });

  const packs = new Map(
    (ids.length
      ? await t.any(
          `SELECT inv_item_id, min(pack_factor)::text AS pack_factor FROM tbl_inv_item_barcode
            WHERE inv_item_id = ANY($1::int[]) AND pack_factor > 1 GROUP BY inv_item_id`,
          [ids]
        )
      : []
    ).map((r) => [Number(r.inv_item_id), Number(r.pack_factor)])
  );
  // Consumption hint: mark-outs net of returns over the last 90 IST days.
  const use = new Map(
    (ids.length
      ? await t.any(
          `SELECT inv_item_id, (-sum(qty))::text AS used FROM tbl_inv_movement
            WHERE hotel_id = $1 AND inv_item_id = ANY($2::int[])
              AND movement_type IN ('MARK_OUT', 'RETURN_IN')
              AND posted_at >= ((${IST_TODAY} - 89)::timestamp AT TIME ZONE 'Asia/Kolkata')
            GROUP BY inv_item_id`,
          [hotel, ids]
        )
      : []
    ).map((r) => [Number(r.inv_item_id), Math.max(0, Number(r.used))])
  );

  const rows = base.map((r) => {
    const id = Number(r.id);
    const qty = Number(r.qty);
    const maxQty = num(r.max_qty);
    const ordered = onOrder.get(id) ?? 0;
    let suggestedQty = null;
    if (maxQty != null) {
      const need = round4(maxQty - qty - ordered);
      suggestedQty = need <= 0 ? 0 : ceilTo(need, packs.get(id) ?? 0.01);
    }
    const mapped = variants.get(id) ?? [];
    const mine = lines.filter((l) => mapped.includes(Number(l.product_variant_id))).sort(byRate);
    const perDept = new Map();
    for (const l of mine) if (!perDept.has(l.department_id)) perDept.set(l.department_id, l);
    const best = mine[0] ?? null;
    return {
      invItemId: id,
      displayName: r.display_name,
      itemCode: r.item_code ?? null,
      stockUom: r.stock_uom,
      qty,
      minQty: num(r.min_qty),
      reorderLevel: num(r.reorder_level),
      maxQty,
      binLabel: r.bin_label ?? null,
      onOrder: ordered,
      onOrderIncomplete: incomplete.has(id),
      suggestedQty,
      packFactor: packs.get(id) ?? null,
      avgDailyUse90d: round4((use.get(id) ?? 0) / 90),
      productVariantId: best ? Number(best.product_variant_id) : mapped[0] ?? null,
      variantIds: mapped,
      contracted: best ? toContracted(best) : null,
      contractedLines: [...perDept.values()].map(toContracted),
    };
  });

  return {
    hotelId: hotel,
    hotels: hotels.map((h) => ({ id: Number(h.id), name: h.name })),
    stockStartedAt: iso(started?.stock_started_at),
    departments,
    rows,
    groupOrdersOpen: [...group.entries()]
      .filter(([, q]) => q > 0)
      .map(([invItemId, openQty]) => ({ invItemId, openQty }))
      .sort((a, b) => a.invItemId - b.invItemId),
  };
}

// ---------------------------------------------------------------------------
// POST /reorder/mr-draft
// ---------------------------------------------------------------------------

/** Same shape as the MR module's numbers (mrController.generateMrNumber, not exported). */
function generateMrNumber(now = new Date()) {
  const stamp = now.getTime().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  return `MR-${now.getFullYear()}-${stamp}${rand}`;
}

function parseDraftItems(items) {
  if (!Array.isArray(items) || !items.length) throw invalid('Choose at least one item', { field: 'items' });
  if (items.length > MAX_LINES) throw invalid(`At most ${MAX_LINES} items per requisition`, { field: 'items' });
  const seen = new Set();
  return items.map((it, index) => {
    const invItemId = positiveInt(it?.invItemId);
    if (!invItemId) throw invalid('Choose an item', { field: 'items', index });
    const qty = toQty(it?.qty);
    if (qty == null || qty <= 0) throw invalid('Quantity must be more than 0', { field: 'items', index, invItemId });
    if (seen.has(invItemId)) throw invalid('The same item is on two lines: combine them', { field: 'items', index, invItemId });
    seen.add(invItemId);
    let arcContractLineId = null;
    if (it?.arcContractLineId != null && it.arcContractLineId !== '') {
      arcContractLineId = positiveInt(it.arcContractLineId);
      if (!arcContractLineId) throw invalid('Invalid contract line', { field: 'items', index, invItemId });
    }
    return { index, invItemId, qty, arcContractLineId };
  });
}

/**
 * Create a draft MR at the hotel for the given department, one MR line per
 * item, each against an active ARC contract line of that hotel and department
 * for a variant mapped to the item (the cheapest, or `arcContractLineId` when
 * given and eligible). Quantities arrive in stock units and are converted to
 * the contract's unit (rounded up to 2 dp, the MR column's scale).
 * The MR is created through mrModel.createDraft / addItem; the buyer reviews
 * and submits it on the MR page.
 *
 * @param {{hotelId:number, departmentId:number,
 *   items:Array<{invItemId:number, qty:number, arcContractLineId?:number}>}} input
 * @returns {Promise<{mrId:number, mrNumber:string, companyId:number, hotelId:number, departmentId:number,
 *   items:Array<{invItemId, productVariantId, arcContractId, arcContractLineId, quantity, uom, unitRate}>}>}
 * @throws {InventoryError} NOT_FOUND (hotel or department out of the caller's
 *   scope, or a foreign item) | FORBIDDEN (no inventory.update, or not a buyer)
 *   | VALIDATION ({field:'items', index, invItemId, reason:'NOT_CONTRACTED' |
 *   'UOM_FACTOR_REQUIRED', lines:[...every refused item]})
 */
export async function createReorderMrDraft(t, user, input = {}) {
  const hotelId = positiveInt(input.hotelId);
  if (!hotelId) throw invalid('Choose a hotel', { field: 'hotelId' });
  const { companyId } = await assertDocAccess(t, user, hotelId, 'update');
  const superAdmin = Number(user?.user_type) === SUPER_ADMIN;
  if (!MR_USER_TYPES.includes(Number(user?.user_type))) {
    throw new InventoryError('FORBIDDEN', 'Only buyers can raise a material requisition', { hotelId });
  }

  const departmentId = positiveInt(input.departmentId);
  if (!departmentId) throw invalid('Choose a department', { field: 'departmentId' });
  const department = await t.oneOrNone(`SELECT id, title FROM tbl_department WHERE id = $1`, [departmentId]);
  const inCell =
    department &&
    (superAdmin ||
      (await mrModel.hasScopeForCell(
        positiveInt(user.id),
        { hotel_id: hotelId, department_id: departmentId, hospitality_company_id: companyId },
        t
      )));
  if (!inCell) throw notFound('Department not found', { field: 'departmentId' });

  const wanted = parseDraftItems(input.items);
  const items = await loadCompanyItems(t, companyId, wanted.map((w) => w.invItemId));
  const variants = await variantsOf(t, companyId, [...items.keys()]);
  const lines = (
    await mrModel.searchContractedItems({ hotel_id: hotelId, department_id: departmentId, limit: CONTRACT_SCAN_LIMIT }, t)
  ).sort(byRate);
  const factorOf = await unitConverters(t, [...items.values()].map((i) => ({ id: i.id, stockUom: i.stockUom })));

  const refused = [];
  const planned = [];
  for (const w of wanted) {
    const item = items.get(w.invItemId);
    const mapped = variants.get(w.invItemId) ?? [];
    const eligible = lines.filter((l) => mapped.includes(Number(l.product_variant_id)));
    const line = w.arcContractLineId
      ? eligible.find((l) => Number(l.arc_contract_line_id) === w.arcContractLineId)
      : eligible[0];
    if (!line) {
      refused.push({ index: w.index, invItemId: w.invItemId, displayName: item.displayName, reason: 'NOT_CONTRACTED' });
      continue;
    }
    const factor = factorOf(w.invItemId, line.uom);
    if (factor == null) {
      refused.push({
        index: w.index, invItemId: w.invItemId, displayName: item.displayName, reason: 'UOM_FACTOR_REQUIRED',
        uom: line.uom ?? null, stockUom: item.stockUom,
      });
      continue;
    }
    const quantity = Math.max(0.01, ceilTo(w.qty / factor, 0.01));
    planned.push({ w, line, quantity });
  }
  if (refused.length) {
    const [first] = refused;
    let message;
    if (first.reason === 'NOT_CONTRACTED') {
      message = `${first.displayName} has no active contract for this department at this hotel: copy it to an RFQ instead`;
    } else if (!first.uom) {
      message = `The contract for ${first.displayName} has no unit: raise it from the MR page`;
    } else {
      message = `Set how many ${first.stockUom} make one ${first.uom} of ${first.displayName} (item units) first`;
    }
    throw invalid(refused.length === 1 ? message : `${refused.length} items cannot go on a requisition: ${message}`, {
      field: 'items', index: first.index, invItemId: first.invItemId, reason: first.reason, lines: refused,
    });
  }

  const hotel = await t.one(`SELECT name FROM tbl_hospitality_company_hotels WHERE id = $1`, [hotelId]);
  const { day } = await t.one(`SELECT to_char(${IST_TODAY}, 'DD Mon YYYY') AS day`);
  const mr = await mrModel.createDraft(
    {
      mr_number: generateMrNumber(),
      title: `Reorder: ${hotel.name} (${day})`.slice(0, 255),
      hospitality_company_id: companyId,
      hotel_id: hotelId,
      department_id: departmentId,
      justification: 'Items at or below their reorder level (inventory reorder list)',
      raised_by: positiveInt(user.id),
    },
    t
  );
  const written = [];
  for (const { w, line, quantity } of planned) {
    // The rate as the MR module stores it (mrController.createDraft): the contract line's.
    const detail = await mrModel.getContractLineDetail(line.arc_contract_line_id, hotelId, t);
    await mrModel.addItem(
      mr.id,
      {
        product_variant_id: Number(line.product_variant_id),
        quantity,
        uom: line.uom,
        arc_contract_id: Number(line.arc_contract_id),
        arc_contract_line_id: Number(line.arc_contract_line_id),
        matched_unit_rate: detail?.unit_rate ?? null,
      },
      t
    );
    written.push({
      invItemId: w.invItemId,
      productVariantId: Number(line.product_variant_id),
      arcContractId: Number(line.arc_contract_id),
      arcContractLineId: Number(line.arc_contract_line_id),
      quantity,
      uom: line.uom,
      unitRate: detail?.unit_rate == null ? null : Number(detail.unit_rate),
    });
  }
  return {
    mrId: Number(mr.id),
    mrNumber: mr.mr_number,
    companyId,
    hotelId,
    departmentId,
    items: written,
  };
}

// ---------------------------------------------------------------------------
// Daily low-stock digest
// ---------------------------------------------------------------------------

/**
 * One run of the low-stock sweeper: for every hotel whose stock has started
 * (stock_started_at set, spec §13), its active items at or below the reorder
 * level go to notify() as one digest. A hotel counts as digested for `today`
 * (IST) only when the digest reached someone; a hotel already digested today
 * is skipped, so a second run or a second instance sends nothing new. One run
 * at a time across instances (session advisory lock): a run that cannot take
 * it returns {skipped:true}. The sweep reads on a plain task (no
 * transaction); notify() writes the notifications on its own connection.
 *
 * @param {{conn?:object, today?:string|null, notify?:Function}} [opts]
 *   today 'YYYY-MM-DD' (default today in IST); notify defaults to
 *   notifyLowStockDigest, which resolves {sent, recipients}.
 * @returns {Promise<{skipped:true}|{date:string, hotels:number, digests:number, alreadyDigested:number}>}
 */
export async function runLowStockSweep({ conn = db, today = null, notify = notifyLowStockDigest } = {}) {
  return conn.task(async (c) => {
    const { locked } = await c.one(`SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS locked`, [
      LOW_STOCK_SWEEP_LOCK_NS,
      LOW_STOCK_SWEEP_LOCK_KEY,
    ]);
    if (!locked) return { skipped: true };
    try {
      return await lowStockSweep(c, { today, notify });
    } finally {
      try {
        await c.one(`SELECT pg_advisory_unlock($1::int, hashtext($2)) AS unlocked`, [
          LOW_STOCK_SWEEP_LOCK_NS,
          LOW_STOCK_SWEEP_LOCK_KEY,
        ]);
      } catch (err) {
        logError('[Low Stock Sweeper] unlock failed', err);
      }
    }
  });
}

async function lowStockSweep(c, { today, notify }) {
  const { date } = await c.one(`SELECT COALESCE($1::date, ${IST_TODAY})::text AS date`, [today]);
  const rows = await c.any(
    `SELECT hi.hotel_id, h.name AS hotel_name, h.hospitality_company_id,
            i.id, i.display_name, i.stock_uom, COALESCE(b.qty, 0)::text AS qty, hi.reorder_level::text AS reorder_level
       FROM tbl_inv_hotel_item hi
       JOIN tbl_inv_hotel_settings s           ON s.hotel_id = hi.hotel_id AND s.stock_started_at IS NOT NULL
       JOIN tbl_hospitality_company_hotels h   ON h.id = hi.hotel_id AND COALESCE(h.is_deleted, 0) = 0
       JOIN tbl_inv_item i                     ON i.id = hi.inv_item_id AND i.is_active
                                              AND i.hospitality_company_id = h.hospitality_company_id
       LEFT JOIN tbl_inv_balance b             ON b.hotel_id = hi.hotel_id AND b.inv_item_id = hi.inv_item_id
      WHERE hi.reorder_level IS NOT NULL
        AND COALESCE(b.qty, 0) <= hi.reorder_level
      ORDER BY hi.hotel_id, i.display_name, i.id`
  );
  const byHotel = new Map();
  for (const r of rows) {
    const hotelId = Number(r.hotel_id);
    if (!byHotel.has(hotelId)) {
      byHotel.set(hotelId, {
        hotelId, hotelName: r.hotel_name, companyId: Number(r.hospitality_company_id), date, items: [],
      });
    }
    byHotel.get(hotelId).items.push({
      invItemId: Number(r.id),
      displayName: r.display_name,
      stockUom: r.stock_uom,
      qty: Number(r.qty),
      reorderLevel: Number(r.reorder_level),
    });
  }
  const out = { date, hotels: byHotel.size, digests: 0, alreadyDigested: 0 };
  if (!byHotel.size) return out;

  const done = await c.any(
    `SELECT DISTINCT (additional_data->>'hotelId')::int AS hotel_id
       FROM tbl_notifications
      WHERE type = $1
        AND created_at >= now() - interval '3 days'
        AND additional_data->>'date' = $2`,
    [LOW_STOCK_DIGEST_TYPE, date]
  );
  const already = new Set(done.map((r) => Number(r.hotel_id)));
  for (const digest of byHotel.values()) {
    if (already.has(digest.hotelId)) {
      out.alreadyDigested += 1;
      continue;
    }
    try {
      const result = await notify(digest, { conn: c });
      if (result?.sent) out.digests += 1;
    } catch (err) {
      logError(`[Low Stock Sweeper] digest for hotel ${digest.hotelId} failed`, err);
    }
  }
  return out;
}

/**
 * Daily at 07:30 IST: the low-stock digest (runLowStockSweep). Database-driven,
 * so a restart loses nothing; safe with several app instances (advisory lock,
 * once per hotel per day). Registered in server.js next to the phase-due sweeper.
 */
export function startLowStockSweeper() {
  cron.schedule(
    '30 7 * * *',
    async () => {
      try {
        const out = await runLowStockSweep();
        logger.info({ ...out }, '[Low Stock Sweeper] run complete');
      } catch (err) {
        logError('[Low Stock Sweeper] Cron tick failed', err);
      }
    },
    { timezone: 'Asia/Kolkata' }
  );
  logger.info('[Low Stock Sweeper] Cron scheduled: daily at 07:30 IST');
}

export default { getReorderList, createReorderMrDraft, runLowStockSweep, startLowStockSweeper };
