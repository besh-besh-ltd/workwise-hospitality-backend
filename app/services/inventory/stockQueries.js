// Stock reads (Task C3): the stock list per hotel, the item card, the ledger
// (bin card) and the inventory overview. No writes.
//
// Scope: inventory.read at the hotel (company + hotel axes, spec §6.1). A
// hotel the caller cannot read, in their company or not, is NOT_FOUND; an
// item of another company is NOT_FOUND. The overview also opens to grn.read:
// stock figures come from the hotels with inventory.read, delivery counts
// from the hotels with grn.read.
//
// Stock list rows are the company's items that have a balance row or a
// level row (tbl_inv_hotel_item) at the hotel; inactive items only while they
// still hold stock. belowReorder = qty ≤ reorder_level (no level, never).

import { hotelIdsWithPermission } from './scope.js';
import { RECEIVABLE_PO_STATUSES } from './grnService.js';
import { NO_EXPIRY_DATE } from './ledger.js';
import {
  PAGE_SIZE, IST_TODAY, IST_MONTH_START, positiveInt, notFound, num, money, iso, pageOf, flag, optionalDay,
  assertDocAccess,
} from './stockCommon.js';

const RECENT_MOVEMENTS = 10;
/** Adjustment reasons that count as wastage on the overview. */
export const WASTAGE_REASONS = Object.freeze(['WASTAGE', 'BREAKAGE', 'EXPIRY']);

const likeTerm = (search) =>
  typeof search === 'string' && search.trim() ? `%${search.trim().replace(/[\\%_]/g, '\\$&')}%` : null;

async function hotelOptions(t, ids) {
  if (!ids.length) return [];
  const rows = await t.any(
    `SELECT id, name FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[]) ORDER BY name, id`,
    [ids]
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

async function stockStartedAt(t, hotelId) {
  const row = await t.oneOrNone(`SELECT stock_started_at FROM tbl_inv_hotel_settings WHERE hotel_id = $1`, [hotelId]);
  return iso(row?.stock_started_at);
}

// The company's items present at a hotel ($1 hotel, $2 company).
const STOCK_BASE = `
  SELECT i.id, i.display_name, i.item_code, i.stock_uom,
         COALESCE(b.qty, 0) AS qty, COALESCE(b.avg_cost, 0) AS avg_cost, COALESCE(b.value, 0) AS value,
         hi.min_qty, hi.reorder_level, hi.max_qty, hi.bin_label, b.last_movement_at,
         (hi.reorder_level IS NOT NULL AND COALESCE(b.qty, 0) <= hi.reorder_level) AS below_reorder
    FROM tbl_inv_item i
    LEFT JOIN tbl_inv_balance b     ON b.hotel_id = $1 AND b.inv_item_id = i.id
    LEFT JOIN tbl_inv_hotel_item hi ON hi.hotel_id = $1 AND hi.inv_item_id = i.id
   WHERE i.hospitality_company_id = $2
     AND (b.inv_item_id IS NOT NULL OR hi.inv_item_id IS NOT NULL)
     AND (i.is_active OR COALESCE(b.qty, 0) <> 0)`;

/**
 * GET /stock?hotelId&search&belowReorder&page
 *
 * @returns {Promise<{hotelId:number|null, stockStartedAt:string|null,
 *   hotels:Array<{id,name}>, totals:{qtyItems:number, value:number},
 *   rows:Array<{invItemId, displayName, itemCode, stockUom, qty, avgCost, value,
 *   minQty, reorderLevel, maxQty, binLabel, belowReorder, lastMovementAt}>, total:number}>}
 *   hotels = every hotel the caller can read (the picker). Without hotelId,
 *   the first of them. totals cover the whole hotel; total counts the rows
 *   that match the filters (PAGE_SIZE a page).
 */
export async function getStock(t, user, { hotelId, search, belowReorder, page } = {}) {
  const readable = await hotelIdsWithPermission(t, user, 'inventory', 'read');
  const hotels = await hotelOptions(t, readable);
  let hotel;
  let companyId;
  if (hotelId != null && hotelId !== '') {
    hotel = positiveInt(hotelId);
    if (!hotel) throw notFound('Hotel not found');
    ({ companyId } = await assertDocAccess(t, user, hotel, 'read'));
  } else {
    if (!hotels.length) {
      return { hotelId: null, stockStartedAt: null, hotels, totals: { qtyItems: 0, value: 0 }, rows: [], total: 0 };
    }
    hotel = hotels[0].id;
    ({ companyId } = await assertDocAccess(t, user, hotel, 'read'));
  }

  const p = pageOf(page);
  const rows = await t.any(
    `SELECT s.*, count(*) OVER () AS total FROM (${STOCK_BASE}) s
      WHERE ($3::text IS NULL OR s.display_name ILIKE $3 OR s.item_code ILIKE $3)
        AND (NOT $4::boolean OR s.below_reorder)
      ORDER BY s.display_name, s.id
      LIMIT $5 OFFSET $6`,
    [hotel, companyId, likeTerm(search), flag(belowReorder), PAGE_SIZE, (p - 1) * PAGE_SIZE]
  );
  const totals = await t.one(
    `SELECT count(*) FILTER (WHERE s.qty > 0) AS qty_items, COALESCE(sum(s.value), 0)::text AS value
       FROM (${STOCK_BASE}) s`,
    [hotel, companyId]
  );
  return {
    hotelId: hotel,
    stockStartedAt: await stockStartedAt(t, hotel),
    hotels,
    totals: { qtyItems: Number(totals.qty_items), value: money(totals.value) },
    rows: rows.map((r) => ({
      invItemId: Number(r.id),
      displayName: r.display_name,
      itemCode: r.item_code ?? null,
      stockUom: r.stock_uom,
      qty: Number(r.qty),
      avgCost: Number(r.avg_cost),
      value: money(r.value),
      minQty: num(r.min_qty),
      reorderLevel: num(r.reorder_level),
      maxQty: num(r.max_qty),
      binLabel: r.bin_label ?? null,
      belowReorder: r.below_reorder === true,
      lastMovementAt: iso(r.last_movement_at),
    })),
    total: rows.length ? Number(rows[0].total) : 0,
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

// Movements of one (hotel, item) with their document numbers. $1 hotel, $2 item.
const MOVEMENT_SELECT = `
  SELECT m.id::text AS id, m.posted_at, m.movement_type, m.qty::text AS qty, m.unit_cost::text AS unit_cost,
         m.value::text AS value, m.qty_after::text AS qty_after, m.avg_cost_after::text AS avg_cost_after,
         m.department_id, d.title AS department_name, m.source_type, m.source_id::text AS source_id,
         m.source_line_id::text AS source_line_id, m.reason_code, m.batch_no, m.expiry_date::text AS expiry_date,
         m.posted_by, COALESCE(u.name, tk.name) AS posted_by_name,
         CASE m.source_type
           WHEN 'GRN' THEN g.grn_number
           WHEN 'RTV' THEN r.rtv_number
           WHEN 'OUT' THEN o.out_number
           WHEN 'ADJ' THEN a.adjustment_number
           WHEN 'CNT' THEN c.count_number
         END AS doc_number
    FROM tbl_inv_movement m
    LEFT JOIN tbl_department d ON d.id = m.department_id
    LEFT JOIN tbl_users u      ON u.id = m.posted_by
    LEFT JOIN tbl_grn g
      ON m.source_type = 'GRN' AND g.id = m.source_id AND g.hospitality_company_id = m.hospitality_company_id
    LEFT JOIN tbl_token_login_data tk ON tk.id = g.received_by_token_id
    LEFT JOIN tbl_rtv r
      ON m.source_type = 'RTV' AND r.id = m.source_id AND r.hospitality_company_id = m.hospitality_company_id
    LEFT JOIN tbl_inv_out o
      ON m.source_type = 'OUT' AND o.id = m.source_id AND o.hospitality_company_id = m.hospitality_company_id
    LEFT JOIN tbl_inv_adjustment a
      ON m.source_type = 'ADJ' AND a.id = m.source_id AND a.hospitality_company_id = m.hospitality_company_id
    LEFT JOIN tbl_inv_count c
      ON m.source_type = 'CNT' AND c.id = m.source_id AND c.hospitality_company_id = m.hospitality_company_id
   WHERE m.hotel_id = $1 AND m.inv_item_id = $2`;

function toMovement(r) {
  return {
    id: Number(r.id),
    postedAt: iso(r.posted_at),
    type: r.movement_type,
    qty: Number(r.qty),
    unitCost: Number(r.unit_cost),
    value: Number(r.value),
    qtyAfter: Number(r.qty_after),
    avgCostAfter: Number(r.avg_cost_after),
    departmentId: r.department_id == null ? null : Number(r.department_id),
    departmentName: r.department_name ?? null,
    sourceType: r.source_type,
    sourceId: Number(r.source_id),
    sourceLineId: num(r.source_line_id),
    docNumber: r.doc_number ?? null,
    reasonCode: r.reason_code ?? null,
    batchNo: r.batch_no || null,
    expiryDate: r.expiry_date ?? null,
    postedBy: r.posted_by == null ? null : Number(r.posted_by),
    postedByName: r.posted_by_name ?? null,
  };
}

/** Hotel readable + item of its company, else NOT_FOUND. */
async function itemAtHotel(t, user, hotelId, invItemId) {
  const hotel = positiveInt(hotelId);
  if (!hotel) throw notFound('Hotel not found');
  const { companyId } = await assertDocAccess(t, user, hotel, 'read');
  const id = positiveInt(invItemId);
  const item = id
    ? await t.oneOrNone(
        `SELECT id, display_name, item_code, stock_uom, track_expiry, min_shelf_life_days,
                over_receipt_tolerance_pct::text AS tol, is_active
           FROM tbl_inv_item WHERE id = $1 AND hospitality_company_id = $2`,
        [id, companyId]
      )
    : null;
  if (!item) throw notFound('Item not found');
  return { hotel, companyId, item };
}

/**
 * GET /stock/:hotelId/items/:invItemId/ledger?from&to&page: newest first,
 * PAGE_SIZE a page; from / to are IST days on posted_at.
 * @returns {Promise<{rows:Movement[], total:number}>}
 */
export async function getLedger(t, user, { hotelId, invItemId, from, to, page } = {}) {
  const { hotel, item } = await itemAtHotel(t, user, hotelId, invItemId);
  const fromDay = optionalDay(from, 'from');
  const toDay = optionalDay(to, 'to');
  const p = pageOf(page);
  const rows = await t.any(
    `SELECT x.*, count(*) OVER () AS total FROM (${MOVEMENT_SELECT}
        AND ($3::date IS NULL OR m.posted_at >= ($3::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND ($4::date IS NULL OR m.posted_at < ($4::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')) x
      ORDER BY x.posted_at DESC, x.id::bigint DESC
      LIMIT $5 OFFSET $6`,
    [hotel, Number(item.id), fromDay, toDay, PAGE_SIZE, (p - 1) * PAGE_SIZE]
  );
  return { rows: rows.map(toMovement), total: rows.length ? Number(rows[0].total) : 0 };
}

/**
 * GET /stock/:hotelId/items/:invItemId: the item card.
 * @returns {Promise<{item, hotel:{id,name,stockStartedAt}, balance:{qty, avgCost, value, lastMovementAt},
 *   levels:{minQty, reorderLevel, maxQty, binLabel, belowReorder}, barcodes:[{id, code, packFactor, source}],
 *   batches:[{batchNo, expiryDate, qty}], recentMovements:Movement[]}>}
 */
export async function getStockItem(t, user, { hotelId, invItemId } = {}) {
  const { hotel, item } = await itemAtHotel(t, user, hotelId, invItemId);
  const id = Number(item.id);
  const [hotelRow, balance, levels, barcodes, variants, batches, recent] = [
    await t.one(`SELECT id, name FROM tbl_hospitality_company_hotels WHERE id = $1`, [hotel]),
    await t.oneOrNone(
      `SELECT qty::text AS qty, avg_cost::text AS avg_cost, value::text AS value, last_movement_at
         FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = $2`,
      [hotel, id]
    ),
    await t.oneOrNone(
      `SELECT min_qty::text AS min_qty, reorder_level::text AS reorder_level, max_qty::text AS max_qty, bin_label
         FROM tbl_inv_hotel_item WHERE hotel_id = $1 AND inv_item_id = $2`,
      [hotel, id]
    ),
    await t.any(
      `SELECT id, code, pack_factor::text AS pack_factor, source FROM tbl_inv_item_barcode
        WHERE inv_item_id = $1 ORDER BY id`,
      [id]
    ),
    await t.any(
      `SELECT iv.product_variant_id, pv.name FROM tbl_inv_item_variant iv
         LEFT JOIN tbl_product_variant pv ON pv.id = iv.product_variant_id
        WHERE iv.inv_item_id = $1 ORDER BY iv.id`,
      [id]
    ),
    await t.any(
      // Stock on hand per batch, in the order FEFO takes it: undated first
      // (an unknown expiry counts as the soonest), then by expiry, then batch.
      // A deficit (negative stock allowed) is not a batch: the balance shows it.
      `SELECT batch_no, expiry_date::text AS expiry_date, qty::text AS qty FROM tbl_inv_batch
        WHERE hotel_id = $1 AND inv_item_id = $2 AND qty > 0
        ORDER BY (expiry_date <> $3::date), expiry_date, batch_no`,
      [hotel, id, NO_EXPIRY_DATE]
    ),
    await t.any(`${MOVEMENT_SELECT} ORDER BY m.posted_at DESC, m.id DESC LIMIT ${RECENT_MOVEMENTS}`, [hotel, id]),
  ];
  const qty = balance ? Number(balance.qty) : 0;
  const reorderLevel = num(levels?.reorder_level);
  return {
    item: {
      id,
      displayName: item.display_name,
      itemCode: item.item_code ?? null,
      stockUom: item.stock_uom,
      trackExpiry: item.track_expiry === true,
      minShelfLifeDays: item.min_shelf_life_days == null ? null : Number(item.min_shelf_life_days),
      overReceiptTolerancePct: num(item.tol),
      isActive: item.is_active === true,
      variants: variants.map((v) => ({ productVariantId: Number(v.product_variant_id), name: v.name ?? null })),
    },
    hotel: { id: hotel, name: hotelRow.name, stockStartedAt: await stockStartedAt(t, hotel) },
    balance: {
      qty,
      avgCost: balance ? Number(balance.avg_cost) : 0,
      value: balance ? money(balance.value) : 0,
      lastMovementAt: iso(balance?.last_movement_at),
    },
    levels: {
      minQty: num(levels?.min_qty),
      reorderLevel,
      maxQty: num(levels?.max_qty),
      binLabel: levels?.bin_label ?? null,
      belowReorder: reorderLevel != null && qty <= reorderLevel,
    },
    barcodes: barcodes.map((b) => ({ id: Number(b.id), code: b.code, packFactor: Number(b.pack_factor), source: b.source })),
    // the ledger's undated bucket (no expiry recorded) is stored at NO_EXPIRY_DATE
    batches: batches.map((b) => ({
      batchNo: b.batch_no || null,
      expiryDate: b.expiry_date === NO_EXPIRY_DATE ? null : b.expiry_date,
      qty: Number(b.qty),
    })),
    recentMovements: recent.map(toMovement),
  };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/**
 * GET /overview?hotelId (optional): stock figures over the hotels with
 * inventory.read, delivery counts over the hotels with grn.read (both
 * narrowed to hotelId when given).
 *
 * - stockValueByHotel: Σ balance value per hotel (every readable hotel, 0 when empty)
 * - lowStockCount: (hotel, item) pairs at or below their reorder level (as the
 *   stock list's belowReorder), at hotels whose stock has started only (spec
 *   §13: reorder alerts are off until then)
 * - deliveries: open / partial plan rows (tbl_po_delivery) of live, non-legacy
 *   POs by IST due date: dueToday, dueThisWeek (today … today+6), overdue
 *   (unallocated rows belong to no hotel and are not counted)
 * - outThisMonthByDept: mark-outs net of returns this IST month, at movement
 *   value, per department (departments netting to 0 are left out)
 * - wastageThisMonth: value written off this IST month by WASTAGE, BREAKAGE
 *   and EXPIRY adjustments
 * - stockNotStartedHotels: readable hotels without stock_started_at
 */
export async function getOverview(t, user, { hotelId } = {}) {
  let invHotels = await hotelIdsWithPermission(t, user, 'inventory', 'read');
  let grnHotels = await hotelIdsWithPermission(t, user, 'grn', 'read');
  if (hotelId != null && hotelId !== '') {
    const h = positiveInt(hotelId);
    if (!h) throw notFound('Hotel not found');
    // Neither right here (another company's hotel, or one out of the caller's scope).
    if (!invHotels.includes(h) && !grnHotels.includes(h)) throw notFound('Hotel not found');
    invHotels = invHotels.filter((x) => x === h);
    grnHotels = grnHotels.filter((x) => x === h);
  }
  const hotels = await hotelOptions(t, [...new Set([...invHotels, ...grnHotels])]);

  const [values, low, byDept, wastage, notStarted, deliveries] = [
    invHotels.length
      ? await t.any(
          `SELECT h.id, h.name, COALESCE(sum(b.value), 0)::text AS value
             FROM tbl_hospitality_company_hotels h
             LEFT JOIN tbl_inv_balance b ON b.hotel_id = h.id
            WHERE h.id = ANY($1::int[])
            GROUP BY h.id, h.name
            ORDER BY COALESCE(sum(b.value), 0) DESC, h.name, h.id`,
          [invHotels]
        )
      : [],
    invHotels.length
      ? await t.one(
          `SELECT count(*) AS n
             FROM tbl_inv_hotel_item hi
             JOIN tbl_inv_item i ON i.id = hi.inv_item_id
             JOIN tbl_inv_hotel_settings hs ON hs.hotel_id = hi.hotel_id AND hs.stock_started_at IS NOT NULL
             LEFT JOIN tbl_inv_balance b ON b.hotel_id = hi.hotel_id AND b.inv_item_id = hi.inv_item_id
            WHERE hi.hotel_id = ANY($1::int[])
              AND hi.reorder_level IS NOT NULL
              AND COALESCE(b.qty, 0) <= hi.reorder_level
              AND (i.is_active OR COALESCE(b.qty, 0) <> 0)`,
          [invHotels]
        )
      : { n: 0 },
    invHotels.length
      ? await t.any(
          `SELECT m.department_id, d.title, (-sum(m.value))::text AS value
             FROM tbl_inv_movement m
             LEFT JOIN tbl_department d ON d.id = m.department_id
            WHERE m.hotel_id = ANY($1::int[])
              AND m.movement_type IN ('MARK_OUT', 'RETURN_IN')
              AND m.posted_at >= ${IST_MONTH_START}
            GROUP BY m.department_id, d.title
           HAVING sum(m.value) <> 0
            ORDER BY -sum(m.value) DESC, d.title`,
          [invHotels]
        )
      : [],
    invHotels.length
      ? await t.one(
          `SELECT COALESCE(-sum(m.value), 0)::text AS value
             FROM tbl_inv_movement m
            WHERE m.hotel_id = ANY($1::int[])
              AND m.source_type = 'ADJ'
              AND m.movement_type IN ('ADJUST_OUT', 'ADJUST_IN')
              AND m.reason_code = ANY($2::text[])
              AND m.posted_at >= ${IST_MONTH_START}`,
          [invHotels, WASTAGE_REASONS]
        )
      : { value: '0' },
    invHotels.length
      ? await t.any(
          `SELECT h.id, h.name
             FROM tbl_hospitality_company_hotels h
             LEFT JOIN tbl_inv_hotel_settings hs ON hs.hotel_id = h.id
            WHERE h.id = ANY($1::int[]) AND hs.stock_started_at IS NULL
            ORDER BY h.name, h.id`,
          [invHotels]
        )
      : [],
    grnHotels.length
      ? await t.one(
          `SELECT count(*) FILTER (WHERE d.due_date = ${IST_TODAY}) AS due_today,
                  count(*) FILTER (WHERE d.due_date >= ${IST_TODAY} AND d.due_date < ${IST_TODAY} + 7) AS due_this_week,
                  count(*) FILTER (WHERE d.due_date < ${IST_TODAY}) AS overdue
             FROM tbl_po_delivery d
             JOIN tbl_rfq_purchase_order po ON po.id = d.po_id
            WHERE d.hotel_id = ANY($1::int[])
              AND d.status IN ('open', 'partial')
              AND d.due_date IS NOT NULL
              AND NOT po.receipt_legacy
              AND po.status::text = ANY($2::text[])
              AND po.receipt_status NOT IN ('received', 'closed_short')`,
          [grnHotels, RECEIVABLE_PO_STATUSES]
        )
      : { due_today: 0, due_this_week: 0, overdue: 0 },
  ];

  return {
    hotels,
    stockValueByHotel: values.map((r) => ({ hotelId: Number(r.id), hotelName: r.name, value: money(r.value) })),
    lowStockCount: Number(low.n),
    deliveries: {
      dueToday: Number(deliveries.due_today),
      dueThisWeek: Number(deliveries.due_this_week),
      overdue: Number(deliveries.overdue),
    },
    outThisMonthByDept: byDept.map((r) => ({
      departmentId: r.department_id == null ? null : Number(r.department_id),
      departmentName: r.title ?? null,
      value: money(r.value),
    })),
    wastageThisMonth: money(wastage.value),
    stockNotStartedHotels: notStarted.map((r) => ({ hotelId: Number(r.id), hotelName: r.name })),
  };
}

export default { getStock, getStockItem, getLedger, getOverview, WASTAGE_REASONS };
