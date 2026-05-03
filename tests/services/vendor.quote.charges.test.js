// Wave-2 step-3.4 (vendor send-quote charges depth): the per-product
// `other_charges` JSONB IS the new source of truth. The legacy columns
// `freight_price`, `package_price`, `freight_mode`, `package_mode` are
// deprecated — Freight + Packaging now live as named items inside
// `other_charges`. Migration of old data already happened on
// hospitality_stage; new submissions write `other_charges`-only.
//
// Why this matters: every Rupee that flows through a quote, a Quote-Compare
// page, a negotiation round, and a printed PO ultimately came from the
// shape we lock here. A bug in slug enrichment or in mode round-trip means
// a buyer reads "Freight: 500%" instead of "Freight: ₹500", or vice versa.
//
// Real production shape (verified against hospitality_stage RFQ 189 +
// vendor 419, plus quote_items rows 108-110):
//
//   tbl_quote_items.other_charges = [
//     {
//       name: "Freight",                  // string — human-readable
//       slug: "freight",                  // string — controller-enriched
//       amount: 500,                      // number
//       amount_mode: "absolute" | "percentage",
//       tax: 9,                           // number — tax on this charge
//       tax_mode: "absolute" | "percentage",
//       comment: "optional"               // optional string
//     },
//     ...
//   ]
//
// What we lock here:
//   1. Slug enrichment from `tbl_charge_names` for known names.
//   2. Auto-generated slug for custom names (uses `_generateChargeSlug`).
//   3. Round-trip of every charge field to tbl_quote_items.
//   4. Mixed `amount_mode` per charge (percentage + absolute coexist).
//   5. Mixed `tax_mode` per charge (per-charge tax mode independent).
//   6. globalPaymentTerms (advance + credit-with-days + other) → tbl_quotes_payment_terms.
//   7. Buyer's getQuotesByRfqById SURFACES the same charges (the missing
//      round-trip assertion that means a buyer's Quote-Compare reads true).
//   8. updateQuoteItems with REVISED other_charges → tbl_quote_item_history
//      captures the OLD JSONB so the buyer can audit price evolution.
//
// Per CONVENTIONS.md §1: every test calls the production controller. No
// model-level SQL replication.

import { describe, it, expect, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { mockExpress } from "../helpers/mockExpress.js";
import rfqController from "../../app/controllers/rfq/rfqController.js";
import { makeRFQ } from "../factories/rfq.js";

afterAll(async () => {
  await closeDb();
});


function vendorUser(userId = IDS.users.vendor_alpha) {
  return { id: userId, user_type: 3, company_id: IDS.companies.vendorAlpha };
}

const inserted = { rfqIds: [] };

beforeEach(() => { inserted.rfqIds = []; });

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  await db.none(
    `DELETE FROM tbl_quote_item_history
     WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_quote_item_files
     WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(
    `DELETE FROM tbl_quotes_payment_terms
     WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

// ---- Helpers --------------------------------------------------------------

async function makeOpenRfqWithProducts({ variantIds = [1, 2] } = {}) {
  // bid window OPEN, clarification window CLOSED — the canonical "vendor can
  // submit a quote" state. Mirrors RFQ 189: tax_mode percentage is the
  // dominant production case.
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
  const fiveDaysHence = new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    tender_publish_date: oneDayAgo,
    vendor_clarification_date: oneHourAgo,
    bid_end_date: fiveDaysHence,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);

  for (const vid of variantIds) {
    await db.none(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0)`,
      [rfq_id, vid]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
       VALUES ($1, $2, $3, 0)`,
      [rfq_id, vid, IDS.users.vendor_alpha]
    );
  }
  return rfq_id;
}

function buildProduct({
  product_id, variant = 0, unit_price, tax = 18, tax_mode = "percentage",
  total_price, comment = "", delivery_period = "7d", quantity = "10",
  other_charges = [],
}) {
  return {
    product_id, variant, unit_price, tax, tax_mode, total_price, comment,
    delivery_period, quantity, other_charges,
  };
}

// Real charges from staging RFQ 204 / 206 / 216 (vendor 419 + others).
// `slug` is intentionally OMITTED on input — we assert the controller fills
// it in via tbl_charge_names lookup or _generateChargeSlug fallback.
//
// Production rule (rfqController.js:12663-12677): any charge with tax > 0
// MUST carry a non-empty `comment`. Tests that omit the comment get rejected
// at the validateChargeComments gate in updateQuoteItems.
const CHARGE_FREIGHT_PCT = {
  name: "Freight", amount: 500, amount_mode: "percentage", tax: 9, tax_mode: "percentage",
  comment: "Pune → Mumbai trucking",
};
const CHARGE_PACKAGING_ABS = {
  name: "Packaging", amount: 250, amount_mode: "absolute", tax: 18, tax_mode: "percentage",
  comment: "ply box per crate",
};
const CHARGE_INSURANCE_PCT = {
  name: "Insurance", amount: 50, amount_mode: "percentage", tax: 12, tax_mode: "percentage",
  comment: "transit insurance",
};
const CHARGE_LOADING_ABS = {
  // tax: 0 is the deliberate tri-state escape hatch for genuinely
  // non-taxable services (PR #124 Change A). Comment is now mandatory
  // for every per-product charge (PR #124 Change B).
  name: "Loading/Unloading", amount: 1500, amount_mode: "absolute", tax: 0, tax_mode: "absolute",
  comment: "crane + crew",
};
const CHARGE_CUSTOM_NEW = {
  name: "xyz 2.0", amount: 50, amount_mode: "absolute", tax: 50, tax_mode: "absolute",
  comment: "site-specific surcharge",
};

// ===========================================================================
//  createQuote — slug enrichment + charge round-trip
// ===========================================================================

describe("createQuote — other_charges slug enrichment", () => {
  it("known-name charges (Freight, Packaging, Insurance, Loading/Unloading) get slugs filled from tbl_charge_names", async () => {
    const rfq_id = await makeOpenRfqWithProducts({ variantIds: [1] });
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 999001, status: 1,
        products: [buildProduct({
          product_id: 1, unit_price: 500, total_price: 5500, quantity: "10",
          other_charges: [
            { ...CHARGE_FREIGHT_PCT },
            { ...CHARGE_PACKAGING_ABS },
            { ...CHARGE_INSURANCE_PCT },
            { ...CHARGE_LOADING_ABS },
          ],
        })],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const [item] = await db.any(
      `SELECT other_charges FROM tbl_quote_items WHERE rfq_id=$1 ORDER BY id`, [rfq_id]
    );
    const stored = Array.isArray(item.other_charges)
      ? item.other_charges
      : JSON.parse(item.other_charges || "[]");
    expect(stored.length).toBe(4);

    const bySlug = Object.fromEntries(stored.map((c) => [c.slug, c]));
    expect(bySlug["freight"]).toBeDefined();
    expect(bySlug["freight"].name).toBe("Freight");
    expect(bySlug["packaging"]).toBeDefined();
    expect(bySlug["packaging"].name).toBe("Packaging");
    expect(bySlug["insurance"]).toBeDefined();
    expect(bySlug["loading_unloading"]).toBeDefined();
    expect(bySlug["loading_unloading"].name).toBe("Loading/Unloading");
  });

  it("custom-name charge gets an auto-generated slug via _generateChargeSlug", async () => {
    const rfq_id = await makeOpenRfqWithProducts({ variantIds: [1] });
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 999002, status: 1,
        products: [buildProduct({
          product_id: 1, unit_price: 500, total_price: 5500,
          other_charges: [{ ...CHARGE_CUSTOM_NEW }],
        })],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const [item] = await db.any(
      `SELECT other_charges FROM tbl_quote_items WHERE rfq_id=$1`, [rfq_id]
    );
    const stored = Array.isArray(item.other_charges)
      ? item.other_charges
      : JSON.parse(item.other_charges || "[]");
    expect(stored.length).toBe(1);
    // _generateChargeSlug: trim → lowercase → [^a-z0-9]+ → "_" → trim _.
    // "xyz 2.0" → "xyz_2_0" (verified against staging RFQ 204).
    expect(stored[0].slug).toBe("xyz_2_0");
    expect(stored[0].name).toBe("xyz 2.0");
  });
});

// ===========================================================================
//  Round-trip: every charge field persists exactly as sent (minus added slug)
// ===========================================================================

describe("createQuote — every charge field round-trips into tbl_quote_items.other_charges", () => {
  it("preserves amount, amount_mode, tax, tax_mode, comment per charge", async () => {
    const rfq_id = await makeOpenRfqWithProducts({ variantIds: [1] });
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 999003, status: 1,
        products: [buildProduct({
          product_id: 1, unit_price: 500, total_price: 5500,
          other_charges: [
            { ...CHARGE_FREIGHT_PCT },        // amount=500, amount_mode=percentage, tax=9, tax_mode=percentage
            { ...CHARGE_PACKAGING_ABS },      // amount=250, amount_mode=absolute, tax=18, tax_mode=percentage, comment
            { ...CHARGE_LOADING_ABS },        // amount=1500, amount_mode=absolute, tax=0, tax_mode=absolute
          ],
        })],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const [item] = await db.any(
      `SELECT other_charges FROM tbl_quote_items WHERE rfq_id=$1`, [rfq_id]
    );
    const stored = Array.isArray(item.other_charges)
      ? item.other_charges
      : JSON.parse(item.other_charges || "[]");
    const bySlug = Object.fromEntries(stored.map((c) => [c.slug, c]));

    // Freight — percentage amount + percentage tax.
    expect(bySlug["freight"].amount).toBe(500);
    expect(bySlug["freight"].amount_mode).toBe("percentage");
    expect(bySlug["freight"].tax).toBe(9);
    expect(bySlug["freight"].tax_mode).toBe("percentage");

    // Packaging — absolute amount + percentage tax + comment retained.
    expect(bySlug["packaging"].amount).toBe(250);
    expect(bySlug["packaging"].amount_mode).toBe("absolute");
    expect(bySlug["packaging"].tax).toBe(18);
    expect(bySlug["packaging"].tax_mode).toBe("percentage");
    expect(bySlug["packaging"].comment).toBe("ply box per crate");

    // Loading — absolute / absolute combo (rare but valid per staging data).
    expect(bySlug["loading_unloading"].amount).toBe(1500);
    expect(bySlug["loading_unloading"].amount_mode).toBe("absolute");
    expect(bySlug["loading_unloading"].tax).toBe(0);
    expect(bySlug["loading_unloading"].tax_mode).toBe("absolute");
  });

  it("multi-product quote: each product carries its own other_charges array independently", async () => {
    const rfq_id = await makeOpenRfqWithProducts({ variantIds: [1, 2] });
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 999004, status: 1,
        products: [
          buildProduct({
            product_id: 1, unit_price: 500, total_price: 5500,
            other_charges: [{ ...CHARGE_FREIGHT_PCT }],
          }),
          buildProduct({
            product_id: 2, unit_price: 1000, total_price: 11000,
            other_charges: [{ ...CHARGE_PACKAGING_ABS }, { ...CHARGE_INSURANCE_PCT }],
          }),
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const items = await db.any(
      `SELECT product_variant_id, other_charges FROM tbl_quote_items WHERE rfq_id=$1
       ORDER BY product_variant_id`,
      [rfq_id]
    );
    expect(items.length).toBe(2);

    const item1 = Array.isArray(items[0].other_charges)
      ? items[0].other_charges
      : JSON.parse(items[0].other_charges);
    const item2 = Array.isArray(items[1].other_charges)
      ? items[1].other_charges
      : JSON.parse(items[1].other_charges);

    expect(item1.length).toBe(1);
    expect(item1[0].slug).toBe("freight");

    expect(item2.length).toBe(2);
    const item2Slugs = item2.map((c) => c.slug).sort();
    expect(item2Slugs).toEqual(["insurance", "packaging"]);
  });
});

// ===========================================================================
//  globalPaymentTerms via tbl_quotes_payment_terms
// ===========================================================================

describe("createQuote — globalPaymentTerms variants persist to tbl_quotes_payment_terms", () => {
  it("advance, credit (with days), and other types all round-trip with their semantics", async () => {
    const rfq_id = await makeOpenRfqWithProducts({ variantIds: [1] });
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 999005, status: 1,
        global_payment_term_list: [
          { type: "advance", value: 10 },
          { type: "credit", value: 20, days: 30 },
          { type: "other", value: 100, comment: "after PO" },
        ],
        products: [buildProduct({
          product_id: 1, unit_price: 500, total_price: 5500,
          other_charges: [{ ...CHARGE_FREIGHT_PCT }],
        })],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const quote = await db.one(`SELECT id FROM tbl_quotes WHERE rfq_id=$1`, [rfq_id]);
    const terms = await db.any(
      `SELECT type, value, days, comment FROM tbl_quotes_payment_terms
       WHERE quote_id=$1 ORDER BY type`,
      [quote.id]
    );
    expect(terms.length).toBe(3);

    const byType = Object.fromEntries(terms.map((t) => [t.type, t]));
    expect(byType["advance"].value).toBe(10);
    expect(byType["advance"].days).toBeNull();

    expect(byType["credit"].value).toBe(20);
    expect(byType["credit"].days).toBe(30);

    expect(byType["other"].value).toBe(100);
    expect(byType["other"].comment).toBe("after PO");
  });
});

// ===========================================================================
//  Buyer round-trip: getQuotesByRfqById exposes the same charges
// ===========================================================================

describe("getQuoteComparison — buyer Quote-Compare sees the vendor's other_charges shape intact", () => {
  it("after vendor submits a quote with realistic charges + bid window closes, the buyer's response includes every charge per item", async () => {
    // Open RFQ — vendor submits.
    const rfq_id = await makeOpenRfqWithProducts({ variantIds: [1] });
    const submit = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 999006, status: 1,
        products: [buildProduct({
          product_id: 1, unit_price: 500, total_price: 5500,
          other_charges: [
            { ...CHARGE_FREIGHT_PCT },
            { ...CHARGE_PACKAGING_ABS },
            { ...CHARGE_INSURANCE_PCT },
            { ...CHARGE_CUSTOM_NEW },
          ],
        })],
      },
    });
    await rfqController.createQuote(submit.req, submit.res, submit.next);
    expect(submit.calls.status).toBe(200);

    // Close the bid window so getQuotesByRfqById is unlocked.
    await db.none(
      `UPDATE tbl_rfq SET bid_end_date = $2 WHERE id = $1`,
      [rfq_id, new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19)]
    );

    // Buyer fetches the new server-computed Quote-Compare endpoint.
    const fetch = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, user_type: 1, company_id: IDS.companies.A },
      params: { id: String(rfq_id) },
      query: {},
    });
    await rfqController.getQuoteComparison(fetch.req, fetch.res);
    expect(fetch.calls.status).toBe(200);
    expect(fetch.calls.body.meta.quoteVisibility.locked).toBe(false);

    // /rfq/quote-compare's response shape: { products: [...], metrics }.
    const products = fetch.calls.body.data.products;
    const product = products.find((p) => p.product_variant_id === 1);
    expect(product).toBeDefined();
    expect(Array.isArray(product.quotations)).toBe(true);
    expect(product.quotations.length).toBeGreaterThanOrEqual(1);

    const vendorQ = product.quotations[0];
    const charges = Array.isArray(vendorQ.other_charges)
      ? vendorQ.other_charges
      : JSON.parse(vendorQ.other_charges || "[]");
    expect(charges.length).toBe(4);

    const slugs = charges.map((c) => c.slug).sort();
    expect(slugs).toEqual(["freight", "insurance", "packaging", "xyz_2_0"]);

    // Every field the vendor sent flows through to the buyer.
    const freight = charges.find((c) => c.slug === "freight");
    expect(freight.amount).toBe(500);
    expect(freight.amount_mode).toBe("percentage");
    expect(freight.tax).toBe(9);
    expect(freight.tax_mode).toBe("percentage");

    const packaging = charges.find((c) => c.slug === "packaging");
    expect(packaging.comment).toBe("ply box per crate");
  });
});

// ===========================================================================
//  Per-charge tax fallback — when a charge has no explicit `tax`, the
//  buyer-side Quote Compare must show that charge taxed at the item's
//  base tax rate (i.e. the value of `tbl_quote_items.tax`).
//
// Rule: a vendor may submit an `other_charge` without explicitly setting
// the `tax` field on it. In that case the buyer's view should treat the
// charge as taxed at the QUOTE ITEM's base tax rate, not at 0%. Otherwise
// the buyer comparing two vendors' quotes sees a phantom "untaxed" charge
// from one vendor and a fully-taxed charge from another, and ranks them
// incorrectly.
// ===========================================================================

describe("getQuoteComparison — per-charge tax fallback to item.tax when charge.tax is missing", () => {
  it("vendor submits a charge without an explicit tax; engine in /rfq/quote-compare emits the charge with tax inherited from item.tax", async () => {
    const rfq_id = await makeOpenRfqWithProducts({ variantIds: [1] });

    // Submit a quote with TWO charges:
    //   - Freight: explicit tax 9% percentage
    //   - Insurance: NO tax / NO tax_mode set at all
    // Item-level tax is 18% percentage (the product's GST rate).
    const submit = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 999008, status: 1,
        products: [buildProduct({
          product_id: 1, unit_price: 500, total_price: 5500, tax: 18,
          other_charges: [
            { name: "Freight", amount: 10, amount_mode: "percentage", tax: 9, tax_mode: "percentage",
              comment: "Pune → Mumbai trucking" },
            // No tax / no tax_mode → falls through to inheritance (item.tax = 18%).
            // Comment is mandatory under PR #124 Change B even when the test's
            // intent is "no explicit tax".
            { name: "Insurance", amount: 50, amount_mode: "absolute", comment: "transit cover" },
          ],
        })],
      },
    });
    await rfqController.createQuote(submit.req, submit.res, submit.next);
    expect(submit.calls.status).toBe(200);

    // Close the bid window so the comparison view is unlocked.
    await db.none(
      `UPDATE tbl_rfq SET bid_end_date = $2 WHERE id = $1`,
      [rfq_id, new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19)]
    );

    // Buyer hits the NEW /rfq/quote-compare/:id endpoint. The engine runs
    // server-side and emits per-charge `tax` with the item.tax fallback
    // applied for charges that didn't carry an explicit one.
    const fetch = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, user_type: 1, company_id: IDS.companies.A },
      params: { id: String(rfq_id) },
      query: {},
    });
    await rfqController.getQuoteComparison(fetch.req, fetch.res);
    expect(fetch.calls.status).toBe(200);

    const product = fetch.calls.body.data.products.find((p) => p.product_variant_id === 1);
    const vendorQ = product.quotations[0];
    const detail = Array.isArray(vendorQ.quote_details) ? vendorQ.quote_details[0] : vendorQ.quote_details;
    const engineCharges = detail.engine.charges;

    // Engine output names the charges. Look up Freight + Insurance.
    const freight = engineCharges.find((c) => /freight/i.test(c.name));
    const insurance = engineCharges.find((c) => /insurance/i.test(c.name));

    // Hand math (unit 500 × qty 10 = 5000 base):
    //   Freight: 5000 × 10% = 500; explicit charge tax 9% → 500 × 9% = 45
    //   Insurance: 50 absolute → 50; charge has NO tax → INHERITS item.tax 18%
    //              → tax = 50 × 18% = 9
    expect(freight.amount).toBe(500);
    expect(freight.tax).toBe(45);

    expect(insurance.amount).toBe(50);
    // F-CHARGE-TAX-FALLBACK: when charge.tax is unset, engine inherits the
    // item's base tax rate (item.tax = 18%) → tax = 50 × 0.18 = 9.
    expect(insurance.tax).toBe(9);
  });
});

// ===========================================================================
//  updateQuoteItems — revised charges captured in audit trail
// ===========================================================================

describe("updateQuoteItems — revised other_charges + audit trail", () => {
  it("vendor edits a charge → tbl_quote_items.other_charges reflects new shape; tbl_quote_item_history captures the OLD JSONB", async () => {
    const rfq_id = await makeOpenRfqWithProducts({ variantIds: [1] });

    // Initial submission with Freight 500% + Packaging 250 absolute.
    const submit = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 999007, status: 1,
        products: [buildProduct({
          product_id: 1, unit_price: 500, total_price: 5500,
          other_charges: [{ ...CHARGE_FREIGHT_PCT }, { ...CHARGE_PACKAGING_ABS }],
        })],
      },
    });
    await rfqController.createQuote(submit.req, submit.res, submit.next);
    expect(submit.calls.status).toBe(200);
    const quote = await db.one(`SELECT id FROM tbl_quotes WHERE rfq_id=$1`, [rfq_id]);

    // Now revise: Freight drops from 500 → 300, Packaging gets a comment.
    // Both charges have tax > 0 so they MUST carry a non-empty `comment` per
    // validateChargeComments (rfqController.js:12663).
    const update = mockExpress({
      user: vendorUser(),
      params: { quoteId: String(quote.id) },
      body: {
        rfq_id, rfq_no: 999007,
        globalPaymentTerms: null, globalComment: null,
        global_payment_term_list: { createdTerms: [], updatedTerms: [], deletedTerms: [] },
        products: [{
          product_id: 1, variant: 0, unit_price: 500, tax: 18, tax_mode: "percentage",
          total_price: 5300, comment: "revised", delivery_period: "5d", quantity: "10",
          other_charges: [
            // Comment ≤30 chars (PR #124 Change B caps per-product charge comments).
            { name: "Freight", amount: 300, amount_mode: "percentage", tax: 9, tax_mode: "percentage",
              comment: "Pune→Mumbai (revised rate)" },
            { name: "Packaging", amount: 250, amount_mode: "absolute", tax: 18, tax_mode: "percentage",
              comment: "now using cardboard" },
          ],
        }],
      },
    });
    await rfqController.updateQuoteItems(update.req, update.res, update.next);
    // Surface validation rejections explicitly. Without this guard, a
    // future contract change that 400s would silently leak as a "row
    // didn't change" assertion below.
    expect(update.calls.status).toBe(200);

    // tbl_quote_items now holds the revised value.
    const liveItem = await db.one(
      `SELECT other_charges FROM tbl_quote_items WHERE quote_id=$1`, [quote.id]
    );
    const liveCharges = Array.isArray(liveItem.other_charges)
      ? liveItem.other_charges
      : JSON.parse(liveItem.other_charges);
    const liveBySlug = Object.fromEntries(liveCharges.map((c) => [c.slug, c]));
    expect(liveBySlug["freight"].amount).toBe(300);
    expect(liveBySlug["packaging"].comment).toBe("now using cardboard");

    // tbl_quote_item_history captures the PRE-update JSONB (Freight 500).
    const history = await db.any(
      `SELECT other_charges FROM tbl_quote_item_history
       WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE quote_id=$1)
       ORDER BY id ASC`,
      [quote.id]
    );
    expect(history.length).toBeGreaterThan(0);
    const histCharges = Array.isArray(history[0].other_charges)
      ? history[0].other_charges
      : JSON.parse(history[0].other_charges);
    const histBySlug = Object.fromEntries(histCharges.map((c) => [c.slug, c]));
    expect(histBySlug["freight"].amount).toBe(500); // pre-revision value
  });
});
