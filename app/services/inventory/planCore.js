// Delivery-plan core: who a PO belongs to, where it is delivered, and the
// default plan every PO gets (spec §5.3, §6.3, §7).
//
// tbl_po_delivery (hotel × phase, hotel_id NULL = unallocated) and
// tbl_po_delivery_line (planned qty per PO line) are the source of truth for
// receiving. The PO's hotel set is:
//   - RFQ POs: the RFQ's mapped hotels (tbl_rfq_hotel_mappings; tbl_rfq.hotel_id
//     only holds the first, rfqController.js:2339), else tbl_rfq.hotel_id;
//   - call-off POs: the hotel of the MR that released them (po.source_mr_id).
//
// Lock order for everything that touches a PO's receipt state, to stay
// deadlock-free: the PO row (getPoContext {forUpdate}) → its delivery lines →
// stock balances (ledger.postMovements).

import { InventoryError } from './errors.js';
import { resolvePoTenancy } from '../../models/purchaseOrderModel.js';

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const toIso = (v) => (v == null ? null : new Date(v).toISOString());

function requirePoId(poId) {
  const id = positiveInt(poId);
  if (!id) throw new InventoryError('VALIDATION', 'Invalid purchase order', { field: 'poId' });
  return id;
}

/**
 * Everything the inventory module needs to know about a PO.
 *
 * @param {object} t transaction
 * @param {number} poId
 * @param {{forUpdate?:boolean}} [opts] forUpdate locks the PO row (FOR UPDATE)
 *   first; take it before locking delivery lines or balances.
 * @returns {Promise<{po:object, isCallOff:boolean, companyId:number|null,
 *   hotelIds:number[], departmentId:number|null, vendorId:number,
 *   status:string, receiptStatus:string, receiptLegacy:boolean,
 *   planLockedAt:string|null}>}
 *   po = the tbl_rfq_purchase_order row (snake_case, as stored).
 *   companyId = the hospitality company (resolvePoTenancy, the same tenancy
 *   assertPoAccess uses). hotelIds ascending, limited to that company's hotels.
 * @throws InventoryError NOT_FOUND when the PO does not exist.
 */
export async function getPoContext(t, poId, { forUpdate = false } = {}) {
  const id = requirePoId(poId);
  const po = await t.oneOrNone(
    `SELECT * FROM tbl_rfq_purchase_order WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id]
  );
  if (!po) throw new InventoryError('NOT_FOUND', 'Purchase order not found', { poId: id });

  const tenancy = await resolvePoTenancy(id, t);
  const companyId = positiveInt(tenancy?.hospitality_company_id);
  const isCallOff = po.is_call_off === true;

  const src = await t.one(
    `SELECT r.hotel_id AS rfq_hotel_id, r.department_id AS rfq_department_id,
            mr.hotel_id AS mr_hotel_id, mr.department_id AS mr_department_id,
            COALESCE((SELECT array_agg(DISTINCT m.hotel_id)
                        FROM tbl_rfq_hotel_mappings m WHERE m.rfq_id = r.id), '{}') AS mapped_hotel_ids
       FROM (SELECT $1::int AS po_id) k
       LEFT JOIN tbl_rfq_purchase_order po ON po.id = k.po_id
       LEFT JOIN tbl_rfq r ON r.id = po.rfq_id
       LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id`,
    [id]
  );

  let candidates;
  let departmentId;
  if (isCallOff) {
    // The requisition's hotel owns a call-off (Group ARC: the ordering hotel);
    // tenancy.hotel_id falls back to the ARC's hotel when the MR is gone.
    candidates = [src.mr_hotel_id ?? tenancy?.hotel_id];
    departmentId = src.mr_department_id ?? tenancy?.department_id ?? null;
  } else {
    const mapped = (src.mapped_hotel_ids || []).map(Number);
    candidates = mapped.length ? mapped : [src.rfq_hotel_id];
    departmentId = src.rfq_department_id ?? tenancy?.department_id ?? null;
  }
  const wanted = [...new Set(candidates.map(positiveInt).filter(Boolean))];
  let hotelIds = [];
  if (wanted.length && companyId) {
    const rows = await t.any(
      `SELECT id FROM tbl_hospitality_company_hotels
        WHERE id = ANY($1::int[]) AND hospitality_company_id = $2 ORDER BY id`,
      [wanted, companyId]
    );
    hotelIds = rows.map((r) => Number(r.id));
  }

  return {
    po,
    isCallOff,
    companyId,
    hotelIds,
    departmentId: positiveInt(departmentId),
    vendorId: Number(po.finalized_vendor_id),
    status: po.status,
    receiptStatus: po.receipt_status,
    receiptLegacy: po.receipt_legacy === true,
    planLockedAt: toIso(po.delivery_plan_locked_at),
  };
}

/**
 * The PO's lines, ordered by id.
 *
 * @returns {Promise<Array<{id:number, productVariantId:number|null,
 *   productName:string|null, unit:string, orderedQty:number,
 *   arcContractLineId:number|null}>>} unit is the raw free-text PO unit.
 *   productVariantId is the line's own variant, else its RFQ product's.
 */
export async function listPoLines(t, poId) {
  const id = requirePoId(poId);
  const rows = await t.any(
    `SELECT pop.id, pop.unit, pop.quantity::text AS quantity, pop.arc_contract_line_id,
            COALESCE(pop.product_variant_id, rp.product_variant_id) AS product_variant_id,
            pv.name AS product_name
       FROM tbl_purchase_order_product pop
       LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       LEFT JOIN tbl_product_variant pv ON pv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
      WHERE pop.purchase_order_id = $1
      ORDER BY pop.id`,
    [id]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    productVariantId: r.product_variant_id == null ? null : Number(r.product_variant_id),
    productName: r.product_name ?? null,
    unit: r.unit,
    orderedQty: Number(r.quantity),
    arcContractLineId: r.arc_contract_line_id == null ? null : Number(r.arc_contract_line_id),
  }));
}

// "7", "7 days", "7d", " 7 Days " — whole days only (spec §5.3).
const WHOLE_DAYS = /^\s*(\d+)\s*(day|days|d)?\s*$/i;

/**
 * The date a PO's default delivery is expected, 'YYYY-MM-DD' or null.
 *   - call-off: the MR's required_by_date;
 *   - RFQ: the vendor's acceptance date (vendor_action_at, as an IST day) plus
 *     the quote's delivery_period in whole days. With several lines, the
 *     latest one governs (one delivery carries them all). Null when the PO is
 *     not accepted yet, no line has a period, or any line's period is not
 *     whole days ("2 weeks", "ASAP"): the date is then unknown, not guessed.
 *
 * @param {object} t
 * @param {object|number} po a getPoContext result, a PO row ({id}) or an id.
 */
export async function defaultDueDate(t, po) {
  const id = requirePoId(po?.po?.id ?? po?.id ?? po);
  const head = await t.oneOrNone(
    `SELECT po.is_call_off,
            mr.required_by_date::text AS required_by,
            (po.vendor_action_at AT TIME ZONE 'Asia/Kolkata')::date::text AS accepted_on
       FROM tbl_rfq_purchase_order po
       LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
      WHERE po.id = $1`,
    [id]
  );
  if (!head) throw new InventoryError('NOT_FOUND', 'Purchase order not found', { poId: id });
  if (head.is_call_off) return head.required_by ?? null;
  if (!head.accepted_on) return null;

  const periods = await t.any(
    `SELECT qi.delivery_period
       FROM tbl_purchase_order_product pop
       JOIN tbl_quote_items qi ON qi.id = pop.quote_id
      WHERE pop.purchase_order_id = $1`,
    [id]
  );
  const given = periods.map((p) => (p.delivery_period ?? '').trim()).filter(Boolean);
  if (!given.length) return null;
  let days = 0;
  for (const p of given) {
    const m = WHOLE_DAYS.exec(p);
    if (!m) return null;
    days = Math.max(days, Number(m[1]));
  }
  const due = await t.one(`SELECT ($1::date + $2::int)::text AS d`, [head.accepted_on, days]);
  return due.d;
}

/**
 * Give a PO its default delivery plan, once. Does nothing when the PO already
 * has any tbl_po_delivery row (a plan, default or edited, is never
 * overwritten), when it is a legacy PO received before the module
 * (receipt_legacy && receipt_status='received'), or when it has no lines.
 *   - single hotel: one delivery at that hotel, phase 1, due defaultDueDate;
 *   - several hotels (or none resolvable): one unallocated delivery
 *     (hotel_id NULL), phase 1, same due date, for the buyer to split.
 * Every line is planned at its full ordered quantity. Locks the PO row, so
 * concurrent callers create one plan.
 *
 * @param {object} t transaction
 * @param {number} poId
 * @param {{userId?:number|null}} [opts] stamped as created_by
 * @returns {Promise<void>}
 */
export async function ensureDefaultPlan(t, poId, { userId = null } = {}) {
  const ctx = await getPoContext(t, poId, { forUpdate: true });
  const id = Number(ctx.po.id);

  const planned = await t.oneOrNone(`SELECT 1 FROM tbl_po_delivery WHERE po_id = $1 LIMIT 1`, [id]);
  if (planned) return;
  if (ctx.receiptLegacy && ctx.receiptStatus === 'received') return;

  const lines = await listPoLines(t, id);
  if (!lines.length) return;
  if (!ctx.companyId) {
    throw new InventoryError('CONFLICT', "The purchase order's company could not be resolved", { poId: id });
  }

  const hotelId = ctx.hotelIds.length === 1 ? ctx.hotelIds[0] : null;
  const dueDate = await defaultDueDate(t, ctx);
  const delivery = await t.one(
    `INSERT INTO tbl_po_delivery (hospitality_company_id, po_id, hotel_id, phase_no, due_date, created_by, updated_by)
     VALUES ($1, $2, $3, 1, $4, $5, $5) RETURNING id`,
    [ctx.companyId, id, hotelId, dueDate, userId ?? null]
  );
  await t.none(
    `INSERT INTO tbl_po_delivery_line
       (hospitality_company_id, delivery_id, po_line_id, planned_qty, created_by, updated_by)
     SELECT $1, $2, pop.id, GREATEST(pop.quantity, 0), $4, $4
       FROM tbl_purchase_order_product pop
      WHERE pop.purchase_order_id = $3
      ORDER BY pop.id`,
    [ctx.companyId, delivery.id, id, userId ?? null]
  );
}

export default { getPoContext, listPoLines, defaultDueDate, ensureDefaultPlan };
