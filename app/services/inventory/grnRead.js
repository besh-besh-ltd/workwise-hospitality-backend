// GRN reads (part of the GRN service; import from grnService.js): the Grn
// payload (api-contract Grn: header, lines with allocations, attachments,
// reversals), one GRN behind its access check, and the paged GRN list
// scoped to the hotels the user may read GRNs at.

import { hotelIdsWithPermission } from './scope.js';
import {
  LIST_PAGE_SIZE, positiveInt, round4, toIso, numOrNull, notFound, isoDay, attachmentUrl, assertGrnAccess,
  loadGrnRow,
} from './grnCommon.js';

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

/** GrnSummary[] of one PO, oldest first (the Deliveries tab's GRN list). */
export async function listGrnSummariesForPo(t, poId) {
  const rows = await t.any(`${SUMMARY_SELECT} WHERE g.po_id = $1 ORDER BY g.id`, [poId]);
  return rows.map((r) => toSummary(r));
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

/**
 * RtvSummary[] (returns to vendor), oldest first: a PO's (the Deliveries tab)
 * or one receipt's (its GRN page). No prices. No access check: callers check.
 * @param {{poId?:number, grnId?:number}} by exactly one of them
 */
export async function listRtvSummaries(t, { poId = null, grnId = null } = {}) {
  const rows = await t.any(
    `SELECT r.id, r.rtv_number, r.grn_id, r.hotel_id, h.name AS hotel_name, r.disposition, r.status,
            r.challan_no, r.credit_note_ref, r.remarks, r.created_at
       FROM tbl_rtv r
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = r.hotel_id
      WHERE ${grnId != null ? 'r.grn_id' : 'r.po_id'} = $1
      ORDER BY r.id`,
    [grnId != null ? grnId : poId]
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

/** GET /grn/:id — grn.read on the GRN's hotel (else NOT_FOUND); with its rtvs. */
export async function getGrn(t, user, grnId, { hidePrices = false, viaToken = null } = {}) {
  const grn = await loadGrnRow(t, grnId);
  await assertGrnAccess(t, user, grn, 'read', { viaToken });
  const payload = await getGrnPayload(t, grn.id, { hidePrices: hidePrices || !!viaToken });
  if (viaToken) return payload;
  // Its returns, under the same check: whoever may read the receipt finds
  // them here, PO visibility or not (the Deliveries tab needs the PO).
  return { ...payload, rtvs: await listRtvSummaries(t, { grnId: grn.id }) };
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
