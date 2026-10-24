// Receiving fixtures for Task B5 (short-close, RTV, receiving notices, PDFs).
//
// B5 is built in parallel with B1 (GRN posting), so this branch has no
// postGrn. postReceiptGrn below writes a posted RECEIPT GRN the way B1 posts
// one: tbl_grn + tbl_grn_line + tbl_grn_line_alloc against the PO's delivery
// lines (the plan is created with ensureDefaultPlan), GRN_IN movements through
// postMovements, then recomputePoReceipt. Every helper takes the caller's
// connection, so a suite can run it inside withTx (always rolled back).

import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { ensureDefaultPlan, getPoContext, listPoLines } from "../../app/services/inventory/planCore.js";
import { recomputePoReceipt } from "../../app/services/inventory/receiptRollup.js";
import { resolveItemForVariant } from "../../app/services/inventory/items.js";
import { nextDocNumber } from "../../app/services/inventory/docNumber.js";
import { postMovements } from "../../app/services/inventory/ledger.js";

export const CO = IDS.hospitality.A;
export const A1 = IDS.hotels.A1;
export const A2 = IDS.hotels.A2;
export const BUYER = IDS.users.a1_proc_buyer;
export const VENDOR = IDS.users.vendor_alpha;

let seq = 0;
const tag = () => `inv-b5-${process.pid}-${++seq}`;

/**
 * An RFQ PO with real lines at `hotel`. `lines` = [{qty, unit, variantId,
 * unitPrice}]; each line gets an RFQ product and a quote item. The PO is
 * initiated by `initiatedBy` and finalised to `vendorId`.
 */
export async function makeRfqPo(t, {
  status = "approved", hotel = A1, mappedHotels = [], initiatedBy = BUYER, vendorId = VENDOR,
  lines = [{ qty: 10, unit: "kg", variantId: 1 }], department = IDS.departments.proc,
} = {}) {
  const { rfq_id, rfq_no } = await makeRFQ(t, { createdBy: initiatedBy, status: 1, is_published: 1, hotel, department });
  for (const h of mappedHotels) {
    await t.none(`INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`, [rfq_id, h, initiatedBy]);
  }
  const quote = await t.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, vendorId]
  );
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, vendor_action_at)
     VALUES ($1, $2, $3, $4, '{}', 1, 100, $5, 100, '{}', $6, now()) RETURNING id, po_number`,
    [rfq_id, IDS.companies.A, `INV-B5-${tag()}`, status, vendorId, initiatedBy]
  );
  const lineIds = [];
  for (const l of lines) {
    const variantId = l.variantId ?? 1;
    const price = l.unitPrice ?? 100;
    const rp = await t.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfq_id, variantId]
    );
    const qi = await t.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, comment, delivery_period, quantity)
       VALUES ($1, $2, $3, $4, $5, $6, '', '', $7) RETURNING id`,
      [rfq_id, rfq_no, quote.id, variantId, price, price * l.qty, String(l.qty)]
    );
    const pop = await t.one(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price, product_variant_id,
          charges_meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{"tax":5,"tax_mode":"percentage"}'::jsonb) RETURNING id`,
      [po.id, rp.id, qi.id, l.qty, l.unit ?? "kg", price, price * l.qty, variantId]
    );
    lineIds.push(Number(pop.id));
  }
  return { poId: Number(po.id), poNumber: po.po_number, rfqId: rfq_id, lineIds };
}

/**
 * Replace a PO's plan with explicit deliveries:
 * [{hotelId, phaseNo, dueDate, lines: {[poLineId]: plannedQty}}].
 * Returns [{deliveryId, lines: {[poLineId]: deliveryLineId}}] in input order.
 */
export async function setPlan(t, poId, deliveries) {
  const ctx = await getPoContext(t, poId, { forUpdate: true });
  await t.none(`DELETE FROM tbl_po_delivery WHERE po_id = $1`, [poId]);
  const out = [];
  for (const d of deliveries) {
    const row = await t.one(
      `INSERT INTO tbl_po_delivery (hospitality_company_id, po_id, hotel_id, phase_no, due_date)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ctx.companyId, poId, d.hotelId ?? null, d.phaseNo ?? 1, d.dueDate ?? null]
    );
    const lines = {};
    for (const [poLineId, qty] of Object.entries(d.lines)) {
      const dl = await t.one(
        `INSERT INTO tbl_po_delivery_line (hospitality_company_id, delivery_id, po_line_id, planned_qty)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [ctx.companyId, row.id, Number(poLineId), qty]
      );
      lines[poLineId] = Number(dl.id);
    }
    out.push({ deliveryId: Number(row.id), lines });
  }
  return out;
}

/** The PO's delivery lines in id order. */
export async function deliveryLinesOf(t, poId) {
  return t.any(
    `SELECT dl.id, dl.delivery_id, d.hotel_id, d.phase_no, dl.po_line_id,
            dl.planned_qty::float AS planned, dl.accepted_qty::float AS accepted,
            dl.returned_replace_qty::float AS returned_replace, dl.returned_credit_qty::float AS returned_credit,
            dl.short_closed_qty::float AS short_closed, dl.status
       FROM tbl_po_delivery_line dl JOIN tbl_po_delivery d ON d.id = dl.delivery_id
      WHERE d.po_id = $1 ORDER BY dl.id`,
    [poId]
  );
}

/**
 * Post a RECEIPT GRN at `hotelId`.
 * lines = [{poLineId, accepted, rejected = 0, rejectionReason, unitCost = 100,
 *           uomFactor = 1, batchNo, expiryDate, deliveryLineId?}]
 * Each line is allocated to `deliveryLineId`, else to the first delivery line
 * of that PO line at the hotel (then the unallocated row), earliest due first.
 * Returns {grnId, grnNumber, lines: [{grnLineId, poLineId, invItemId, deliveryLineId}]}.
 */
export async function postReceiptGrn(t, { poId, hotelId = A1, postedBy = BUYER, receivedAt = "2026-10-24",
  vendorChallanNo = null, remarks = null, lines }) {
  await ensureDefaultPlan(t, poId);
  const ctx = await getPoContext(t, poId, { forUpdate: true });
  const poLines = new Map((await listPoLines(t, poId)).map((l) => [l.id, l]));
  const grnNumber = await nextDocNumber(t, { hotelId, docType: "GRN", date: receivedAt });
  const grn = await t.one(
    `INSERT INTO tbl_grn (grn_number, hospitality_company_id, hotel_id, po_id, doc_type, status, received_at,
                          received_by, posted_at, posted_by, vendor_challan_no, remarks)
     VALUES ($1, $2, $3, $4, 'RECEIPT', 'posted', $5, $6, now(), $6, $7, $8) RETURNING id`,
    [grnNumber, ctx.companyId, hotelId, poId, receivedAt, postedBy, vendorChallanNo, remarks]
  );
  const written = [];
  const movements = [];
  for (const l of lines) {
    const poLine = poLines.get(l.poLineId);
    const item = await resolveItemForVariant(t, {
      companyId: ctx.companyId, productVariantId: poLine.productVariantId, createIfMissing: true,
      defaultUom: poLine.unit,
    });
    const rejected = l.rejected ?? 0;
    const factor = l.uomFactor ?? 1;
    const unitCost = l.unitCost ?? 100;
    const gl = await t.one(
      `INSERT INTO tbl_grn_line (hospitality_company_id, grn_id, po_line_id, product_variant_id, inv_item_id, po_uom,
                                 received_qty, accepted_qty, rejected_qty, rejection_reason, uom_factor, stock_qty,
                                 unit_cost, batch_no, expiry_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [ctx.companyId, grn.id, l.poLineId, poLine.productVariantId, item.id, poLine.unit,
        l.accepted + rejected, l.accepted, rejected, rejected > 0 ? (l.rejectionReason ?? "damaged") : null,
        factor, l.accepted * factor, unitCost, l.batchNo ?? null, l.expiryDate ?? null]
    );
    const deliveryLineId = l.deliveryLineId ?? Number((await t.one(
      `SELECT dl.id FROM tbl_po_delivery_line dl JOIN tbl_po_delivery d ON d.id = dl.delivery_id
        WHERE d.po_id = $1 AND dl.po_line_id = $2 AND (d.hotel_id = $3 OR d.hotel_id IS NULL)
        ORDER BY (d.hotel_id IS NULL), d.due_date ASC NULLS LAST, d.phase_no, dl.id LIMIT 1`,
      [poId, l.poLineId, hotelId]
    )).id);
    // One receipt line split over several delivery lines (phases), as B1 does
    // when a receipt covers more than one phase: [{deliveryLineId, accepted}].
    const allocations = l.allocations ?? [{ deliveryLineId, accepted: l.accepted, rejected }];
    for (const a of allocations) {
      await t.none(
        `INSERT INTO tbl_grn_line_alloc (hospitality_company_id, grn_line_id, delivery_line_id, accepted_qty, rejected_qty)
         VALUES ($1, $2, $3, $4, $5)`,
        [ctx.companyId, gl.id, a.deliveryLineId, a.accepted, a.rejected ?? 0]
      );
    }
    if (l.accepted > 0) {
      movements.push({
        companyId: ctx.companyId, hotelId, invItemId: item.id, type: "GRN_IN", qty: l.accepted * factor, unitCost,
        productVariantId: poLine.productVariantId, batchNo: l.batchNo ?? null, expiryDate: l.expiryDate ?? null,
        sourceType: "GRN", sourceId: Number(grn.id), sourceLineId: Number(gl.id), postedBy,
      });
    }
    written.push({ grnLineId: Number(gl.id), poLineId: l.poLineId, invItemId: item.id, deliveryLineId });
  }
  await postMovements(t, movements);
  await recomputePoReceipt(t, poId);
  return { grnId: Number(grn.id), grnNumber, lines: written };
}

/** Mark stock out to a department (e.g. consumed before a return). */
export async function markOut(t, { hotelId = A1, invItemId, qty, postedBy = BUYER }) {
  const companyId = Number((await t.one(
    `SELECT hospitality_company_id FROM tbl_hospitality_company_hotels WHERE id = $1`, [hotelId]
  )).hospitality_company_id);
  await postMovements(t, [{
    companyId, hotelId, invItemId, type: "MARK_OUT", qty: -qty, departmentId: IDS.departments.fb,
    sourceType: "OUT", sourceId: 1, postedBy,
  }]);
}

/** On-hand qty of an item at a hotel. */
export async function balanceOf(t, hotelId, invItemId) {
  const row = await t.oneOrNone(
    `SELECT qty::float AS qty FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = $2`,
    [hotelId, invItemId]
  );
  return row ? row.qty : 0;
}
