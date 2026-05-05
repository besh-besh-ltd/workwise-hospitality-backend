// Integration: POST /negotiation/quotes/:rfq_product_id/approve
// (negotiationController.approveQuotes) → drafted PO must preserve
// `other_charges` from tbl_quote_items into tbl_purchase_order_product.charges_meta.
//
// Bug shape (production, RFQ /finalize → NEGOTIATION_QUOTE approval flow):
//   1. The buyer's UI (quote-compare.js) constructs `product_info.charges_meta`
//      WITHOUT `other_charges`, posts to /rfq/finalize.
//   2. rfqController.finalize stores `req.body` as approval metadata.po_payload.
//   3. The final approver hits POST /negotiation/quotes/:id/approve, which
//      calls draftPO(metadata.po_payload, ...) DIRECTLY — without first calling
//      buildAuthoritativePOPayload to enrich charges_meta from tbl_quote_items.
//   4. The drafted PO line ships with the partial charges_meta — `other_charges`
//      is missing — and the printed PO total drops by the missing charges.
//
// Live data: tbl_purchase_order_product.charges_meta = `{"tax": 50, "tax_mode": "absolute"}`,
// when the vendor's quote on tbl_quote_items.other_charges has freight + insurance rows.
//
// The companion test in po.documentData.test.js:399 covers the GOOD path
// (buildAuthoritativePOPayload + draftPO). This file locks the contract on
// the HTTP path that production actually uses (the buggy one until fixed).
//
// Per CONVENTIONS.md §3 & §1: production controller invoked directly with
// mock req/res — same shape the route's middleware would hand it.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";
import negotiationController from "../../app/controllers/negotiation/negotiationController.js";

afterAll(async () => { await closeDb(); });

let RFQ_NO_COUNTER = 8_750_000;
const nextRfqNo = () => ++RFQ_NO_COUNTER;

const inserted = {
  rfqIds: [],
  rfqProductIds: [],
  quoteIds: [],
  approvalInstanceIds: [],
  poIds: [],
  poLineIds: [],
};

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.rfqProductIds = [];
  inserted.quoteIds = [];
  inserted.approvalInstanceIds = [];
  inserted.poIds = [];
  inserted.poLineIds = [];
});

afterEach(async () => {
  if (inserted.poLineIds.length) {
    await db.none(
      `DELETE FROM tbl_purchase_order_product WHERE id = ANY($1::int[])`,
      [inserted.poLineIds]
    );
  }
  if (inserted.poIds.length) {
    await db.none(
      `DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`,
      [inserted.poIds]
    );
  }
  if (inserted.approvalInstanceIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`,
      [inserted.approvalInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_step_approvers
        WHERE approval_instance_step_id IN
          (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [inserted.approvalInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`,
      [inserted.approvalInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`,
      [inserted.approvalInstanceIds]
    );
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

function mockResponse() {
  const calls = { status: 200, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
    calls,
  };
  return res;
}

describe("POST /negotiation/quotes/:rfq_product_id/approve — drafted PO preserves vendor's other_charges", () => {
  it("when finalize stored a partial charges_meta (no other_charges, mirroring quote-compare.js), the BE must enrich the drafted PO from tbl_quote_items", async () => {
    // Vendor's actual quote: percentage Freight + percentage Insurance, each
    // with their own per-charge tax. Same shape that drives the F-PO-CHARGES-LOST
    // RFQ 189 case — missing these from charges_meta drops the printed total
    // by ₹16,725 on a ₹49,225 PO.
    const charges = [
      { name: "Freight",   slug: "freight",   amount: 10, amount_mode: "percentage", tax: 9,  tax_mode: "percentage" },
      { name: "Insurance", slug: "insurance", amount: 50, amount_mode: "percentage", tax: 12, tax_mode: "percentage" },
    ];

    // ---- Setup: RFQ + product + vendor mapping + quote with other_charges ----
    const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, process_id, is_tender, title)
       VALUES ($1, '<p>e2e</p>', '', 'b@a', 'A1', '+91', $2, 'Mumbai', 1, 1, $3, $3, NOW(),
               $4, $5, $6, 0, 'approveQuotes charges-preservation test')
       RETURNING id, rfq_no`,
      [
        nextRfqNo(), oneDayAgo, IDS.users.a1_proc_buyer,
        IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1,
      ]
    );
    inserted.rfqIds.push(rfq.id);

    const rfqProd = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
      [rfq.id]
    );
    inserted.rfqProductIds.push(rfqProd.id);

    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
       VALUES ($1, 1, $2, 0)`,
      [rfq.id, IDS.users.vendor_alpha]
    );

    const quote = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
       VALUES ($1, $2, $3, $3, 1, NOW()) RETURNING id`,
      [rfq.id, rfq.rfq_no, IDS.users.vendor_alpha]
    );
    inserted.quoteIds.push(quote.id);

    const qi = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
          package_price, tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
       VALUES ($1, $2, $3, 1, 500, 49225, 0, 30, 0, 0, 'realistic', '15', '50', 'percentage', $4)
       RETURNING id`,
      [rfq.id, rfq.rfq_no, quote.id, JSON.stringify(charges)]
    );

    // ---- Stage the approval that rfqController.finalize would have created ----
    // metadata.po_payload mirrors the partial shape FE sends today (no
    // other_charges; matches quote-compare.js:1642). buildAuthoritativePOPayload
    // is the ONLY thing that recovers other_charges from tbl_quote_items —
    // skipping it (which the buggy approveQuotes path does) leaks the partial
    // charges_meta straight into the PO line.
    const partialPoPayload = {
      rfq_id: rfq.id,
      rfq_no: rfq.rfq_no,
      product_variant_id: 1,
      vendor_id: IDS.users.vendor_alpha,
      // rfqController.finalize stores `quote_id: quote_item_id` deliberately.
      quote_id: qi.id,
      quote_item_id: qi.id,
      variant: 0,
      route_type: "PO",
      project_id: null,
      total_value: 49225,
      product_info: {
        rfq_product_id: rfqProd.id,
        quantity: 50,
        unit: "pcs",
        unit_price: 500,
        // Partial — exactly what FE sends. `other_charges` deliberately absent.
        charges_meta: { tax: 30, tax_mode: "percentage" },
        finalized_vendor_id: IDS.users.vendor_alpha,
      },
    };

    const approvalResult = await createApprovalInstance({
      entity_type: "NEGOTIATION_QUOTE",
      entity_id: rfqProd.id,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      department_id: null,
      process_id: IDS.processes.A_P1,
      initiated_by: IDS.users.a1_proc_buyer,
      metadata: {
        rfq_id: rfq.id,
        rfq_number: rfq.rfq_no,
        rfq_product_id: rfqProd.id,
        is_tender: 0,
        product_variant_id: 1,
        variant: 0,
        vendor_id: IDS.users.vendor_alpha,
        quote_id: qi.id,
        quote_item_id: qi.id,
        po_payload: partialPoPayload,
        po_user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      },
    });
    inserted.approvalInstanceIds.push(approvalResult.instance.id);
    // Buyer ≠ commApp, and the A1/P1 NEGOTIATION_QUOTE policy requires commApp
    // (a1_proc_commApp). Auto-approval must NOT fire — we want the inline
    // post-approval block in approveQuotes to run.
    expect(approvalResult.autoApproved).toBeFalsy();
    expect(approvalResult.instance.status).toBe("PENDING");

    // ---- Act: final approver approves via the production HTTP controller ----
    const req = {
      user: { id: IDS.users.a1_proc_commApp, company_id: IDS.companies.A },
      params: { rfq_product_id: String(rfqProd.id) },
      body: {},
    };
    const res = mockResponse();
    await negotiationController.approveQuotes(req, res);
    expect(res.calls.status).toBe(200);

    // ---- Assert: drafted PO line carries other_charges from tbl_quote_items ----
    const poRow = await db.oneOrNone(
      `SELECT pop.id, pop.charges_meta, pop.purchase_order_id
       FROM tbl_purchase_order_product pop
       JOIN tbl_rfq_purchase_order rpo ON pop.purchase_order_id = rpo.id
       WHERE rpo.rfq_id = $1
       ORDER BY pop.id DESC LIMIT 1`,
      [rfq.id]
    );
    expect(poRow).not.toBeNull();
    inserted.poLineIds.push(poRow.id);
    inserted.poIds.push(poRow.purchase_order_id);

    const meta = typeof poRow.charges_meta === "string"
      ? JSON.parse(poRow.charges_meta)
      : poRow.charges_meta;

    expect(Array.isArray(meta.other_charges)).toBe(true);
    expect(meta.other_charges.length).toBe(2);
    const slugs = meta.other_charges.map((c) => c.slug).sort();
    expect(slugs).toEqual(["freight", "insurance"]);
    const bySlug = Object.fromEntries(meta.other_charges.map((c) => [c.slug, c]));
    expect(bySlug["freight"].amount).toBe(10);
    expect(bySlug["freight"].amount_mode).toBe("percentage");
    expect(bySlug["freight"].tax).toBe(9);
    expect(bySlug["insurance"].amount).toBe(50);
    expect(bySlug["insurance"].tax).toBe(12);
  });

  it("when the source quote has document-level global_charges (TCS), the drafted PO snapshots them onto the header and rolls them into total_value", async () => {
    // Locks the contract that the negotiation-quote approval path doesn't
    // just preserve per-line `other_charges` (covered above) but also
    // snapshots quote-level `global_charges` from tbl_quotes.global_charges
    // onto tbl_rfq_purchase_order.global_charges, with the grand total
    // (line subtotal + globals) reflected on po.total_value. Without this
    // guarantee, a 5% TCS on a ₹25,000 quote silently disappears at the
    // moment of PO drafting.
    const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, process_id, is_tender, title)
       VALUES ($1, '<p>e2e</p>', '', 'b@a', 'A1', '+91', $2, 'Mumbai', 1, 1, $3, $3, NOW(),
               $4, $5, $6, 0, 'approveQuotes global_charges snapshot test')
       RETURNING id, rfq_no`,
      [
        nextRfqNo(), oneDayAgo, IDS.users.a1_proc_buyer,
        IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1,
      ]
    );
    inserted.rfqIds.push(rfq.id);
    const rfqProd = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
      [rfq.id]
    );
    inserted.rfqProductIds.push(rfqProd.id);
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
       VALUES ($1, 1, $2, 0)`,
      [rfq.id, IDS.users.vendor_alpha]
    );
    // Quote with TCS 5% global charge stamped on tbl_quotes.global_charges
    // — exactly the legacy `{tax, tax_mode, is_global: true}` shape the
    // production vendor send-quote screen emits.
    const globalCharges = [
      { name: "TCS", slug: "tcs", tax: 5, tax_mode: "percentage", is_global: true },
    ];
    const quote = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp", global_charges)
       VALUES ($1, $2, $3, $3, 1, NOW(), $4) RETURNING id`,
      [rfq.id, rfq.rfq_no, IDS.users.vendor_alpha, JSON.stringify(globalCharges)]
    );
    inserted.quoteIds.push(quote.id);
    const qi = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
          package_price, tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
       VALUES ($1, $2, $3, 1, 500, 25000, 0, 0, 0, 0, 'realistic', '15', '50', 'absolute', '[]'::jsonb)
       RETURNING id`,
      [rfq.id, rfq.rfq_no, quote.id]
    );

    // The approval metadata stores a partial po_payload (matching what
    // rfqController.finalize stores today). global_charges is NOT in it —
    // the BE must enrich from tbl_quotes via the quote_item_id at draft.
    const partialPoPayload = {
      rfq_id: rfq.id,
      rfq_no: rfq.rfq_no,
      product_variant_id: 1,
      vendor_id: IDS.users.vendor_alpha,
      quote_id: qi.id,
      quote_item_id: qi.id,
      variant: 0,
      route_type: "PO",
      project_id: null,
      total_value: 25000,
      product_info: {
        rfq_product_id: rfqProd.id,
        quantity: 50,
        unit: "pcs",
        unit_price: 500,
        charges_meta: {},
        finalized_vendor_id: IDS.users.vendor_alpha,
      },
    };

    const approvalResult = await createApprovalInstance({
      entity_type: "NEGOTIATION_QUOTE",
      entity_id: rfqProd.id,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      department_id: null,
      process_id: IDS.processes.A_P1,
      initiated_by: IDS.users.a1_proc_buyer,
      metadata: {
        rfq_id: rfq.id, rfq_number: rfq.rfq_no, rfq_product_id: rfqProd.id,
        is_tender: 0, product_variant_id: 1, variant: 0,
        vendor_id: IDS.users.vendor_alpha, quote_id: qi.id, quote_item_id: qi.id,
        po_payload: partialPoPayload,
        po_user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      },
    });
    inserted.approvalInstanceIds.push(approvalResult.instance.id);
    expect(approvalResult.autoApproved).toBeFalsy();

    const req = {
      user: { id: IDS.users.a1_proc_commApp, company_id: IDS.companies.A },
      params: { rfq_product_id: String(rfqProd.id) },
      body: {},
    };
    const res = mockResponse();
    await negotiationController.approveQuotes(req, res);
    expect(res.calls.status).toBe(200);

    const poRow = await db.oneOrNone(
      `SELECT id, total_value, global_charges
       FROM tbl_rfq_purchase_order
       WHERE rfq_id = $1
       ORDER BY id DESC LIMIT 1`,
      [rfq.id]
    );
    expect(poRow).not.toBeNull();
    inserted.poIds.push(poRow.id);
    const popRow = await db.one(
      `SELECT id FROM tbl_purchase_order_product WHERE purchase_order_id = $1`,
      [poRow.id]
    );
    inserted.poLineIds.push(popRow.id);

    const snapshot = typeof poRow.global_charges === "string"
      ? JSON.parse(poRow.global_charges)
      : poRow.global_charges;
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot.length).toBe(1);
    expect(snapshot[0].slug).toBe("tcs");
    expect(snapshot[0].tax).toBe(5);

    // Hand math: line = 50 × 500 = 25,000; TCS 5% = 1,250; grand = 26,250.
    expect(Number(poRow.total_value)).toBe(26250);
  });
});
