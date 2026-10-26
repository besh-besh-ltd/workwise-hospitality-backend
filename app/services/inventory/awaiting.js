// "Awaiting delivery": the receiver's worklist (spec §6.1). One row per
// (PO, hotel) that still has quantity to receive at a hotel the user may see
// receipts at (grn.read).
//
// Open quantity per PO line comes from the delivery plan:
//   open = planned − (accepted − returned for replacement − returned for credit) − short-closed
// The hotel's own plan rows count with their due date; unallocated rows
// (hotel_id NULL) count at every hotel of the PO, with no due date. A PO that
// has no plan rows yet (created before the module, or not planned) counts its
// lines' outstanding qty at every PO hotel, unscheduled.
//
// Buckets (IST calendar days; production Postgres runs in UTC, so "today" is
// always computed in Asia/Kolkata):
//   due_today    a delivery due today
//   overdue      a delivery due before today
//   this_week    a delivery due from today to today + 6
//   unscheduled  open qty with no due date (undated, unallocated or unplanned)
//   older        POs from before the inventory module (receipt_legacy)
//   all          every non-legacy PO
// Legacy POs appear only under `older`, and are never overdue.

import { hotelIdsWithPermission, hotelOptions } from './scope.js';
import { RECEIVABLE_PO_STATUSES } from './grnService.js';
import { InventoryError } from './errors.js';

const IST_TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`;
export const AWAITING_FILTERS = Object.freeze(['due_today', 'overdue', 'this_week', 'unscheduled', 'older', 'all']);
export const AWAITING_PAGE_SIZE = 25;

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const FILTER_SQL = {
  due_today: `NOT ph.receipt_legacy AND a.has_due_today`,
  overdue: `NOT ph.receipt_legacy AND a.has_overdue`,
  this_week: `NOT ph.receipt_legacy AND a.has_this_week`,
  unscheduled: `NOT ph.receipt_legacy AND a.has_unscheduled`,
  older: `ph.receipt_legacy`,
  all: `NOT ph.receipt_legacy`,
};

/**
 * @param {object} t db or transaction
 * @param {object} user req.user
 * @param {{hotelId?:number, filter?:string, search?:string, page?:number}} [query]
 * @returns {Promise<{rows:Array<{poId:number, poNumber:string, vendorName:string|null,
 *   hotelId:number, hotelName:string, nextDueDate:string|null, overdue:boolean,
 *   openLineCount:number, openValue:number, isCallOff:boolean, receiptLegacy:boolean,
 *   hasInTransitDispatch:boolean}>, total:number, hotels:Array<{id:number, name:string}>}>}
 *   hotels: every hotel the user may read receipts at (the filter's choices).
 */
export async function getAwaitingDeliveries(t, user, { hotelId = null, filter = 'all', search = null, page = 1 } = {}) {
  const f = filter == null || filter === '' ? 'all' : String(filter);
  if (!AWAITING_FILTERS.includes(f)) {
    throw new InventoryError('VALIDATION', 'Unknown filter', { field: 'filter', allowed: AWAITING_FILTERS });
  }
  const readable = await hotelIdsWithPermission(t, user, 'grn', 'read');
  // The hotel filter offers exactly these (not the user's company mappings).
  const hotelList = await hotelOptions(t, readable);
  let hotels = readable;
  if (hotelId != null && hotelId !== '') {
    const h = positiveInt(hotelId);
    hotels = hotels.filter((x) => x === h);
  }
  if (!hotels.length) return { rows: [], total: 0, hotels: hotelList };

  const term = typeof search === 'string' && search.trim() ? `%${search.trim().replace(/[\\%_]/g, '\\$&')}%` : null;
  const p = Math.max(1, positiveInt(page) ?? 1);

  const rows = await t.any(
    `WITH po_base AS (
       SELECT po.id, po.po_number, po.finalized_vendor_id, po.is_call_off, po.receipt_legacy,
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
        WHERE po.status::text = ANY($2::text[])
          AND po.receipt_status NOT IN ('received', 'closed_short')
     ),
     po_hotel AS (
       SELECT b.*, h.id AS hotel_id, h.name AS hotel_name
         FROM po_base b
         CROSS JOIN LATERAL unnest(b.hotel_ids) AS x(hid)
         JOIN tbl_hospitality_company_hotels h ON h.id = x.hid AND h.hospitality_company_id = b.company_id
        WHERE x.hid = ANY($1::int[])
     ),
     plan_open AS (
       SELECT d.po_id, d.hotel_id, d.due_date, dl.po_line_id,
              GREATEST(0, dl.planned_qty - (dl.accepted_qty - dl.returned_replace_qty - dl.returned_credit_qty)
                          - dl.short_closed_qty) AS open_qty
         FROM tbl_po_delivery d
         JOIN tbl_po_delivery_line dl ON dl.delivery_id = d.id
        WHERE d.po_id IN (SELECT id FROM po_hotel) AND d.status <> 'short_closed'
     ),
     open_rows AS (
       -- the hotel's own plan rows, dated or not
       SELECT ph.id AS po_id, ph.hotel_id, po.due_date, po.po_line_id, po.open_qty
         FROM po_hotel ph JOIN plan_open po ON po.po_id = ph.id AND po.hotel_id = ph.hotel_id
       UNION ALL
       -- unallocated rows: open at every hotel of the PO, unscheduled
       SELECT ph.id, ph.hotel_id, NULL::date, po.po_line_id, po.open_qty
         FROM po_hotel ph JOIN plan_open po ON po.po_id = ph.id AND po.hotel_id IS NULL
       UNION ALL
       -- POs with no plan yet: the lines' outstanding qty, unscheduled
       SELECT ph.id, ph.hotel_id, NULL::date, pop.id,
              GREATEST(0, pop.quantity - (COALESCE(pop.accepted_qty, 0) - COALESCE(pop.returned_replace_qty, 0)
                          - COALESCE(pop.returned_credit_qty, 0)) - COALESCE(pop.short_closed_qty, 0))
         FROM po_hotel ph
         JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = ph.id
        WHERE NOT EXISTS (SELECT 1 FROM tbl_po_delivery d WHERE d.po_id = ph.id)
     ),
     agg AS (
       SELECT o.po_id, o.hotel_id,
              MIN(o.due_date) AS next_due_date,
              COUNT(DISTINCT o.po_line_id) AS open_line_count,
              SUM(o.open_qty * COALESCE(pop.unit_price, 0)) AS open_value,
              bool_or(o.due_date = ${IST_TODAY}) AS has_due_today,
              bool_or(o.due_date < ${IST_TODAY}) AS has_overdue,
              bool_or(o.due_date >= ${IST_TODAY} AND o.due_date < ${IST_TODAY} + 7) AS has_this_week,
              bool_or(o.due_date IS NULL) AS has_unscheduled
         FROM open_rows o
         JOIN tbl_purchase_order_product pop ON pop.id = o.po_line_id
        WHERE o.open_qty > 0
        GROUP BY o.po_id, o.hotel_id
     )
     SELECT ph.id AS po_id, ph.po_number, ph.hotel_id, ph.hotel_name, ph.is_call_off, ph.receipt_legacy,
            COALESCE(vc.company_name, vu.organization_name, vu.name) AS vendor_name,
            a.next_due_date::text AS next_due_date, a.has_overdue, a.open_line_count, a.open_value::text AS open_value,
            EXISTS (SELECT 1 FROM tbl_po_dispatch pd
                     WHERE pd.po_id = ph.id AND pd.status = 'in_transit'
                       AND (pd.hotel_id IS NULL OR pd.hotel_id = ph.hotel_id)) AS has_in_transit,
            COUNT(*) OVER () AS total
       FROM agg a
       JOIN po_hotel ph ON ph.id = a.po_id AND ph.hotel_id = a.hotel_id
       LEFT JOIN tbl_users vu   ON vu.id = ph.finalized_vendor_id
       LEFT JOIN tbl_company vc ON vc.id = vu.company_id
      WHERE ${FILTER_SQL[f]}
        AND ($3::text IS NULL OR ph.po_number ILIKE $3
             OR COALESCE(vc.company_name, vu.organization_name, vu.name) ILIKE $3)
      ORDER BY a.next_due_date ASC NULLS LAST, ph.id DESC, ph.hotel_id
      LIMIT $4 OFFSET $5`,
    [hotels, RECEIVABLE_PO_STATUSES, term, AWAITING_PAGE_SIZE, (p - 1) * AWAITING_PAGE_SIZE]
  );

  return {
    rows: rows.map((r) => ({
      poId: Number(r.po_id),
      poNumber: r.po_number,
      vendorName: r.vendor_name ?? null,
      hotelId: Number(r.hotel_id),
      hotelName: r.hotel_name,
      nextDueDate: r.next_due_date,
      overdue: !r.receipt_legacy && r.has_overdue === true,
      openLineCount: Number(r.open_line_count),
      openValue: Math.round(Number(r.open_value) * 100) / 100,
      isCallOff: r.is_call_off === true,
      receiptLegacy: r.receipt_legacy === true,
      hasInTransitDispatch: r.has_in_transit === true,
    })),
    total: rows.length ? Number(rows[0].total) : 0,
    hotels: hotelList,
  };
}

export default { getAwaitingDeliveries, AWAITING_FILTERS };
