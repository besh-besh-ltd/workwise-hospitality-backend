// Fixtures for the delivery-plan and dispatch suites (inventory Task B2).
//
// makeRfqPo / makeCallOffPo build a PO with real lines on the connection they
// are given: a withTx transaction (rolled back) for service-level tests, or a
// committed db.tx for tests that go through HTTP or a model function that
// opens its own transaction. Committed rows are recorded on a tracker and
// removed, children first, by cleanupTracked.

import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

export const CO = IDS.hospitality.A;
export const A1 = IDS.hotels.A1;
export const A2 = IDS.hotels.A2;
export const BUYER = IDS.users.a1_proc_buyer;
export const VENDOR = IDS.users.vendor_alpha;

let seq = 0;
const tag = () => `ib2-${process.pid}-${++seq}`;

export function newTracker() {
  return { poIds: [], rfqIds: [], quoteIds: [], rfqProductIds: [], mrIds: [], contractIds: [], arcIds: [] };
}

/**
 * An RFQ PO with real lines. `lines` = [{qty, unit?, deliveryPeriod?}]; each
 * line gets an RFQ product and a quote item (which carries the vendor's
 * delivery_period). `mappedHotels` adds tbl_rfq_hotel_mappings rows (a
 * multi-hotel PO).
 */
export async function makeRfqPo(t, {
  status = "approved", hotel = A1, mappedHotels = [], lines = [{ qty: 10, unit: "kg" }],
  vendorActionAt = null, department = IDS.departments.proc, initiatedBy = BUYER,
  vendor = VENDOR, createdAt = null, tracker = null,
} = {}) {
  const { rfq_id, rfq_no } = await makeRFQ(t, { createdBy: BUYER, status: 1, is_published: 1, hotel, department });
  tracker?.rfqIds.push(rfq_id);
  for (const h of mappedHotels) {
    await t.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
      [rfq_id, h, BUYER]
    );
  }
  const quote = await t.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, vendor]
  );
  tracker?.quoteIds.push(quote.id);
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, vendor_action_at, created_at)
     VALUES ($1, $2, $3, $4, '{}', 1, 100, $5, 100, '{}', $6, $7, COALESCE($8::timestamptz, now()))
     RETURNING id, po_number`,
    [rfq_id, IDS.companies.A, `INV-B2-${tag()}`, status, vendor, initiatedBy, vendorActionAt, createdAt]
  );
  tracker?.poIds.push(Number(po.id));
  const lineIds = [];
  const rfqProductIds = [];
  for (const l of lines) {
    const rp = await t.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
      [rfq_id]
    );
    tracker?.rfqProductIds.push(rp.id);
    rfqProductIds.push(Number(rp.id));
    const qi = await t.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, comment, delivery_period, quantity)
       VALUES ($1, $2, $3, 1, 100, 100, '', $4, $5) RETURNING id`,
      [rfq_id, rfq_no, quote.id, l.deliveryPeriod ?? "", String(l.qty)]
    );
    const pop = await t.one(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price,
          charges_meta)
       VALUES ($1, $2, $3, $4, $5, 100, $6, '{"tax":18,"tax_mode":"percentage"}'::jsonb) RETURNING id`,
      [po.id, rp.id, qi.id, l.qty, l.unit ?? "kg", 100 * l.qty]
    );
    lineIds.push(Number(pop.id));
  }
  return { poId: Number(po.id), poNumber: po.po_number, rfqId: rfq_id, lineIds, rfqProductIds, quoteId: Number(quote.id) };
}

/** A call-off PO raised by an MR at `hotel` (no RFQ), with `lines` = [{qty}] contracted lines. */
export async function makeCallOffPo(t, {
  hotel = A2, requiredBy = "2030-11-15", lines = [{ qty: 6 }], status = "approved", tracker = null,
} = {}) {
  const t0 = tag();
  const arc = await t.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
     VALUES ($1, 'Delivery plan ARC', (SELECT id FROM tbl_category ORDER BY id LIMIT 1), $2, $3, $4, $5,
             'contract_active', NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
             NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6)
     RETURNING id`,
    [`ARC-${t0}`.slice(0, 40), CO, A1, IDS.departments.proc, IDS.processes.A_P1, BUYER]
  );
  tracker?.arcIds.push(arc.id);
  const contract = await t.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
    [arc.id, VENDOR]
  );
  tracker?.contractIds.push(contract.id);
  const mr = await t.one(
    `INSERT INTO tbl_material_requisition
       (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, required_by_date)
     VALUES ($1, 'Delivery plan MR', $2, $3, $4, 'normal', $5, 'po_released', $6) RETURNING id`,
    [`MR-${t0}`.slice(0, 40), CO, hotel, IDS.departments.fb, BUYER, requiredBy]
  );
  tracker?.mrIds.push(mr.id);
  const total = lines.reduce((s, l) => s + l.qty, 0);
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id,
        total_value, quote_id, arc_contract_id, source_mr_id, is_call_off, initiated_by)
     VALUES (NULL, $1, $2, $3, '{}', $4, 90, $5, 0, '{}', $6, $7, TRUE, $8) RETURNING id, po_number`,
    [IDS.companies.A, `CO-${t0}`, status, total, VENDOR, contract.id, mr.id, BUYER]
  );
  tracker?.poIds.push(Number(po.id));
  const lineIds = [];
  for (const [i, l] of lines.entries()) {
    // One ARC item per product (unique per ARC): line i takes the i-th seeded variant.
    const arcItem = await t.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, (SELECT id FROM tbl_product_variant ORDER BY id OFFSET $2 LIMIT 1), 100, 'litre')
       RETURNING id, product_variant_id`,
      [arc.id, i]
    );
    const contractLine = await t.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 90, 5, 1000) RETURNING id`,
      [contract.id, arcItem.id]
    );
    const pop = await t.one(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, quantity, unit, unit_price, charges_meta, total_price, product_variant_id, arc_contract_line_id)
       VALUES ($1, $2, 'litre', 90, '{"tax":5,"tax_mode":"percentage","other_charges":[]}'::jsonb, $3, $5, $4)
       RETURNING id`,
      [po.id, l.qty, 94.5 * l.qty, contractLine.id, arcItem.product_variant_id]
    );
    lineIds.push(Number(pop.id));
  }
  return { poId: Number(po.id), poNumber: po.po_number, lineIds, mrId: Number(mr.id) };
}

/** The PO's plan as stored. */
export async function planRows(t, poId) {
  return t.any(
    `SELECT d.id, d.hotel_id, d.phase_no, d.due_date::text AS due_date, d.status, d.remarks,
            COALESCE(json_agg(json_build_object('po_line_id', dl.po_line_id, 'planned_qty', dl.planned_qty::text)
                              ORDER BY dl.po_line_id) FILTER (WHERE dl.id IS NOT NULL), '[]') AS lines
       FROM tbl_po_delivery d
       LEFT JOIN tbl_po_delivery_line dl ON dl.delivery_id = d.id
      WHERE d.po_id = $1
      GROUP BY d.id
      ORDER BY d.hotel_id NULLS LAST, d.phase_no`,
    [poId]
  );
}

/**
 * A posted RECEIPT GRN at `hotelId` with one line per `lines` entry
 * ({poLineId, deliveryLineId, accepted, rejected?, unitCost?}), allocated to
 * the given delivery lines. Written straight to the B1 tables.
 */
export async function postedGrn(t, { poId, hotelId = A1, grnNumber = null, lines }) {
  const grn = await t.one(
    `INSERT INTO tbl_grn (grn_number, hospitality_company_id, hotel_id, po_id, status, received_at, posted_at, posted_by)
     VALUES ($1, $2, $3, $4, 'posted', '2030-01-05', now(), $5) RETURNING id`,
    [grnNumber ?? `GRN/${hotelId}/2030-31/${tag()}`.slice(0, 40), CO, hotelId, poId, BUYER]
  );
  const grnLineIds = [];
  for (const l of lines) {
    const rejected = l.rejected ?? 0;
    const line = await t.one(
      `INSERT INTO tbl_grn_line (hospitality_company_id, grn_id, po_line_id, po_uom, received_qty, accepted_qty,
                                 rejected_qty, rejection_reason, uom_factor, stock_qty, unit_cost)
       VALUES ($1, $2, $3, 'kg', $4, $5, $6, $7, 1, $5, $8) RETURNING id`,
      [CO, grn.id, l.poLineId, l.accepted + rejected, l.accepted, rejected, rejected > 0 ? "damaged" : null,
       l.unitCost ?? 100]
    );
    grnLineIds.push(Number(line.id));
    await t.none(
      `INSERT INTO tbl_grn_line_alloc (hospitality_company_id, grn_line_id, delivery_line_id, accepted_qty, rejected_qty)
       VALUES ($1, $2, $3, $4, $5)`,
      [CO, line.id, l.deliveryLineId, l.accepted, rejected]
    );
  }
  return { grnId: Number(grn.id), grnLineIds };
}

/** Delete everything a committed test created, children first. */
export async function cleanupTracked(db, tr) {
  const poIds = tr.poIds;
  if (poIds.length) {
    await db.none(`DELETE FROM tbl_rtv WHERE po_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_po_short_close WHERE po_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_grn WHERE po_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_purchase_order_document WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_po_dispatch WHERE po_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_po_delivery WHERE po_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);
  }
  if (tr.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [tr.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [tr.quoteIds]);
  }
  if (tr.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [tr.rfqProductIds]);
  }
  if (tr.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [tr.rfqIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[]) AND entity_type <> 'PO'`, [tr.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [tr.rfqIds]);
  }
  if (tr.mrIds.length) await db.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::bigint[])`, [tr.mrIds]);
  if (tr.contractIds.length) await db.none(`DELETE FROM tbl_arc_contract WHERE id = ANY($1::bigint[])`, [tr.contractIds]);
  if (tr.arcIds.length) await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [tr.arcIds]);
  for (const k of Object.keys(tr)) tr[k] = [];
}
