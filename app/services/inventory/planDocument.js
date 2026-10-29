// The delivery plan and the PO QR code, as printed on the PO documents (spec
// §7.4, §10.1): the RFQ PO Handlebars template (poTemplateDataBuilder) and the
// call-off PO renderer (callOffPoRenderer) both read from here, so the two
// documents print the same plan.
//
// Read-only and import-light on purpose: the PO document is built inside the
// approval transaction, and this module must not pull the PO model graph in
// behind it (poTemplateDataBuilder → planService → purchaseOrderModel →
// poDocumentService → … would close a cycle).

import { qrSvg } from './qr.js';
import { shortUrl } from './shortUrl.js';
import { logger } from '../../util/logger.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' → '05 Nov 2026'; null → null. A DATE has no time zone to shift. */
export function displayDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return null;
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** A NUMERIC(18,4) quantity without trailing zeros: '10.0000' → '10', '2.5000' → '2.5'. */
const qtyText = (v) => String(Number(v));

/**
 * The PO's delivery plan for printing: one entry per delivery (hotel × phase),
 * each with its planned lines, in the order the Deliveries tab shows them
 * (hotel, unallocated last, then phase). Deliveries with nothing planned (an
 * unallocated row drained into hotel rows) are left out. Empty when the PO has
 * no plan yet (plans are created lazily; a PO printed before anyone opened its
 * deliveries has none).
 *
 * @param {object} conn db or the caller's transaction
 * @param {number} poId
 * @returns {Promise<Array<{deliveryId:number, hotelId:number|null, hotelName:string,
 *   phaseNo:number, dueDate:string|null, dueDateDisplay:string, remarks:string|null,
 *   lineCount:number, lines:Array<{productName:string, unit:string, plannedQty:string}>}>>}
 */
export async function loadDeliveryPlanForDocument(conn, poId) {
  const rows = await conn.any(
    `SELECT d.id AS delivery_id, d.hotel_id, h.name AS hotel_name, d.phase_no,
            d.due_date::text AS due_date, d.remarks,
            COALESCE(pv.name, 'Item') AS product_name, pop.unit,
            dl.planned_qty::text AS planned_qty
       FROM tbl_po_delivery d
       JOIN tbl_po_delivery_line dl ON dl.delivery_id = d.id AND dl.planned_qty > 0
       JOIN tbl_purchase_order_product pop ON pop.id = dl.po_line_id
       LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       LEFT JOIN tbl_product_variant pv ON pv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = d.hotel_id
      WHERE d.po_id = $1
      ORDER BY d.hotel_id IS NULL, d.hotel_id, d.phase_no, d.id, pop.id`,
    [poId]
  );
  const byDelivery = new Map();
  for (const r of rows) {
    const key = Number(r.delivery_id);
    if (!byDelivery.has(key)) {
      byDelivery.set(key, {
        deliveryId: key,
        hotelId: r.hotel_id == null ? null : Number(r.hotel_id),
        hotelName: r.hotel_id == null ? 'To be allocated' : (r.hotel_name || `Hotel ${r.hotel_id}`),
        phaseNo: Number(r.phase_no),
        dueDate: r.due_date ?? null,
        dueDateDisplay: displayDate(r.due_date) || 'To be scheduled',
        remarks: r.remarks || null,
        lineCount: 0,
        lines: [],
      });
    }
    const d = byDelivery.get(key);
    d.lines.push({ productName: r.product_name, unit: r.unit || '', plannedQty: qtyText(r.planned_qty) });
    d.lineCount = d.lines.length;
  }
  return [...byDelivery.values()];
}

/**
 * The PO's QR code (an inline SVG string) encoding its short link
 * /s/p/<poId>. Scanning it at the receiving bay opens Receive for the PO.
 * Null if the code cannot be drawn: the QR is printed decoration and must never
 * cost a PO its document.
 */
export function poQrSvg(poId) {
  try {
    return qrSvg(shortUrl('p', poId));
  } catch (err) {
    logger.warn({ poId, err: err?.message }, 'PO QR code could not be drawn');
    return null;
  }
}

export default { loadDeliveryPlanForDocument, poQrSvg, displayDate };
