// Integration: GET /rfq/quote-compare/:id (rfqController.getQuoteComparison).
//
// This is the new server-computed Quote Compare view — the SINGLE SOURCE
// OF TRUTH the frontend renders straight from. It runs the model query
// (rfqModel.getQuotesByRfqById2), pipes the raw products+quotations
// through the pricing engine via quoteCompareService.enrichQuoteCompareData,
// and returns:
//   {
//     status: 1,
//     data: {
//       products: [{
//         ...productFields,
//         quotations: [{ ...quote, quote_details:[{ ...detail, engine }],
//                        engine_total }],
//         comparison: { bands:{ basePrice, subtotal, gst, total, delivery },
//                       freight_advantage_vendor_ids, lowest_vendor_id },
//         aggregates: { l1_total, finalized_total, baseline_total,
//                       regret_count, eligible_count }
//       }],
//       metrics: { l1_total, finalized_total, baseline_total, ... }
//     },
//     meta: { quoteVisibility, normalize_applied }
//   }
//
// Scope:
//   1. Locked-state visibility (bid window still open) — quotations redacted
//      regardless of how many vendors quoted.
//   2. Unlocked-state engine output per detail row matches hand math AND
//      matches `pricingEngine.calculateLineTotal(...)` exactly.
//   3. comparison.lowest_vendor_id picks the cheaper of two vendors.
//   4. comparison.bands.total tags each vendor as best/competitive/neutral/high.
//   5. aggregates.l1_total = engine total of the lowest vendor.
//   6. ?normalize=1 flips meta.normalize_applied + applies payment-term
//      normalization on top of the engine's per-line total.
//   7. pageSource=quote_compare logs a tbl_quote_activity row (deduplicated).

import { describe, it, expect, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { mockExpress } from "../helpers/mockExpress.js";
import rfqController from "../../app/controllers/rfq/rfqController.js";
import pricingEngine from "../../app/services/pricingEngine.js";
import { makeRFQ } from "../factories/rfq.js";

afterAll(async () => { await closeDb(); });


const inserted = { rfqIds: [], quoteIds: [] };

beforeEach(() => { inserted.rfqIds = []; inserted.quoteIds = []; });

afterEach(async () => {
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

// ---- Helpers --------------------------------------------------------------

const istString = (offsetMs) =>
  new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);

async function makeRfqWithProduct({ bidEndOffsetMs = -3600_000 } = {}) {
  const oneDayAgo = istString(-86400_000);
  const oneHourAgo = istString(-3600_000);
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1, is_published: 1,
    tender_publish_date: oneDayAgo,
    vendor_clarification_date: oneHourAgo,
    bid_end_date: istString(bidEndOffsetMs),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);
  await db.none(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0)`,
    [rfq_id]
  );
  return rfq_id;
}

async function plantVendorQuote(rfq_id, vendorId, { unitPrice, quantity = 10, tax = 18, otherCharges = [] }) {
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, 1, $2, 0)
     ON CONFLICT DO NOTHING`,
    [rfq_id, vendorId]
  );
  const rfq = await db.one(`SELECT rfq_no FROM tbl_rfq WHERE id=$1`, [rfq_id]);
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
     VALUES ($1, $2, $3, $3, 1, NOW()) RETURNING id`,
    [rfq_id, rfq.rfq_no, vendorId]
  );
  inserted.quoteIds.push(q.id);
  await db.none(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
        package_price, tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
     VALUES ($1, $2, $3, 1, $4, $5, 0, $6, 0, 0, '', '7', $7, 'percentage', $8)`,
    [
      rfq_id, rfq.rfq_no, q.id, unitPrice, unitPrice * quantity, tax,
      String(quantity), JSON.stringify(otherCharges),
    ]
  );
  return q.id;
}

// ===========================================================================
//  Locked-state visibility
// ===========================================================================

describe("getQuoteComparison — locked state (bid window still open)", () => {
  it("redacts quotations + comparison data when the deadline hasn't passed", async () => {
    const rfq_id = await makeRfqWithProduct({ bidEndOffsetMs: 5 * 86400_000 });
    await plantVendorQuote(rfq_id, IDS.users.vendor_alpha, { unitPrice: 500 });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, user_type: 1, company_id: IDS.companies.A },
      params: { id: String(rfq_id) },
      query: {},
    });
    await rfqController.getQuoteComparison(m.req, m.res);

    expect(m.calls.status).toBe(200);
    expect(m.calls.body.meta.quoteVisibility.locked).toBe(true);
    // Locked: products[0].quotations is empty (sanitised).
    const products = m.calls.body.data.products;
    expect(Array.isArray(products)).toBe(true);
    expect(products[0].quotations).toEqual([]);
  });
});

// ===========================================================================
//  Engine output per detail row
// ===========================================================================

describe("getQuoteComparison — unlocked state: engine totals match pricingEngine exactly", () => {
  it("each quotation's quote_details[i].engine output matches pricingEngine.calculateLineTotal for the same input", async () => {
    const rfq_id = await makeRfqWithProduct();
    const charges = [
      { name: "Freight", slug: "freight", amount: 10, amount_mode: "percentage", tax: 9, tax_mode: "percentage", comment: "ok" },
      { name: "Insurance", slug: "insurance", amount: 50, amount_mode: "percentage", tax: 12, tax_mode: "percentage", comment: "ok" },
    ];
    await plantVendorQuote(rfq_id, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 50, tax: 30, otherCharges: charges,
    });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, user_type: 1, company_id: IDS.companies.A },
      params: { id: String(rfq_id) },
      query: {},
    });
    await rfqController.getQuoteComparison(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.meta.quoteVisibility.locked).toBe(false);

    const product = m.calls.body.data.products.find((p) => p.product_variant_id === 1);
    const quote = product.quotations[0];
    const detail = Array.isArray(quote.quote_details) ? quote.quote_details[0] : quote.quote_details;
    expect(detail.engine).toBeDefined();

    // The same input reconciles to the engine's published math: 49225.
    const expected = pricingEngine.calculateLineTotal({
      unit_price: 500, quantity: 50, tax: 30, tax_mode: "percentage",
      other_charges: charges,
    });
    expect(expected.total).toBe(49225);
    expect(detail.engine.total).toBe(expected.total);
    expect(detail.engine.base).toBe(expected.base);
    expect(detail.engine.base_tax).toBe(expected.base_tax);
    expect(detail.engine.charges_total).toBe(expected.charges_total);

    // Per-charge: Freight + Insurance with computed tax.
    const cdByName = Object.fromEntries(detail.engine.charges.map((c) => [c.name, c]));
    expect(cdByName["Freight"].amount).toBe(2500);
    expect(cdByName["Freight"].tax).toBe(225);
    expect(cdByName["Insurance"].amount).toBe(12500);
    expect(cdByName["Insurance"].tax).toBe(1500);

    // engine_total at the quotation level = sum of detail engine totals.
    expect(quote.engine_total).toBe(49225);
  });
});

// ===========================================================================
//  Comparison aggregates: lowest pick + bands
// ===========================================================================

describe("getQuoteComparison — comparison aggregates pick the lowest correctly", () => {
  it("two vendors quote different prices; the cheaper one wins lowest_vendor_id and l1_total", async () => {
    const rfq_id = await makeRfqWithProduct();
    // Vendor alpha: ₹500 × 10 + 18% = 5900
    await plantVendorQuote(rfq_id, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: [],
    });
    // Vendor beta: ₹450 × 10 + 18% = 5310
    await plantVendorQuote(rfq_id, IDS.users.vendor_beta, {
      unitPrice: 450, quantity: 10, tax: 18, otherCharges: [],
    });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, user_type: 1, company_id: IDS.companies.A },
      params: { id: String(rfq_id) },
      query: {},
    });
    await rfqController.getQuoteComparison(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const product = m.calls.body.data.products.find((p) => p.product_variant_id === 1);
    expect(product.comparison.lowest_vendor_id).toBe(IDS.users.vendor_beta);
    expect(product.aggregates.l1_total).toBe(5310);
    expect(product.aggregates.eligible_count).toBe(2);
    expect(product.aggregates.regret_count).toBe(0);

    // Bands tag each vendor on the `total` metric. The cheapest is "best".
    const totalBands = product.comparison.bands.total.bands;
    expect(totalBands[IDS.users.vendor_beta]).toBe("best");
    // The pricier vendor lands somewhere ≠ "best" (depends on spread, but
    // it's NOT the best).
    expect(totalBands[IDS.users.vendor_alpha]).not.toBe("best");
  });
});

// ===========================================================================
//  Normalize filter
// ===========================================================================

describe("getQuoteComparison — ?normalize=1 applies payment-term normalization", () => {
  it("default (no query) → meta.normalize_applied = false", async () => {
    const rfq_id = await makeRfqWithProduct();
    await plantVendorQuote(rfq_id, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: [],
    });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, user_type: 1, company_id: IDS.companies.A },
      params: { id: String(rfq_id) }, query: {},
    });
    await rfqController.getQuoteComparison(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.meta.normalize_applied).toBe(false);
  });

  it("?normalize=1 → meta.normalize_applied = true; engine still emits per-line totals through the peer-fill path", async () => {
    // Two vendors so the peer-fill pool has data. Without the fix to
    // pricingEngine.fillMissingChargesFromPeers (detailsAsArray helper),
    // this would crash with TypeError because the model returns
    // quote.quote_details as a single object, not an array.
    const rfq_id = await makeRfqWithProduct();
    await plantVendorQuote(rfq_id, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: [],
    });
    await plantVendorQuote(rfq_id, IDS.users.vendor_beta, {
      unitPrice: 480, quantity: 10, tax: 18, otherCharges: [],
    });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, user_type: 1, company_id: IDS.companies.A },
      params: { id: String(rfq_id) }, query: { normalize: "1" },
    });
    await rfqController.getQuoteComparison(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.meta.normalize_applied).toBe(true);

    // Engine still ran for every vendor; no crash on object-shape
    // quote_details from the model.
    const product = m.calls.body.data.products[0];
    expect(product.quotations.length).toBe(2);
    for (const q of product.quotations) {
      const detail = Array.isArray(q.quote_details) ? q.quote_details[0] : q.quote_details;
      expect(detail.engine).toBeDefined();
      expect(detail.engine.total).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
//  Quote-activity logging side-effect (mirrors getQuotesByRfqById)
// ===========================================================================

describe("getQuoteComparison — pageSource=quote_compare side effect", () => {
  it("inserts a tbl_quote_activity row on first visit; deduplicates on second visit", async () => {
    const rfq_id = await makeRfqWithProduct();
    await plantVendorQuote(rfq_id, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: [],
    });

    const v1 = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, user_type: 1, company_id: IDS.companies.A },
      params: { id: String(rfq_id) },
      query: { pageSource: "quote_compare" },
    });
    await rfqController.getQuoteComparison(v1.req, v1.res);
    expect(v1.calls.status).toBe(200);

    const after1 = await db.any(
      `SELECT id FROM tbl_quote_activity
       WHERE rfq_id=$1 AND created_by=$2 AND current_status='QC'`,
      [rfq_id, IDS.users.a1_proc_buyer]
    );
    expect(after1.length).toBe(1);

    const v2 = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, user_type: 1, company_id: IDS.companies.A },
      params: { id: String(rfq_id) },
      query: { pageSource: "quote_compare" },
    });
    await rfqController.getQuoteComparison(v2.req, v2.res);
    expect(v2.calls.status).toBe(200);

    const after2 = await db.any(
      `SELECT id FROM tbl_quote_activity
       WHERE rfq_id=$1 AND created_by=$2 AND current_status='QC'`,
      [rfq_id, IDS.users.a1_proc_buyer]
    );
    expect(after2.length).toBe(1);
  });
});
