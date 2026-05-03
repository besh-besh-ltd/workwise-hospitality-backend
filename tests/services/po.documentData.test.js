// Wave-2: PO document data preparation.
//
// `app/helper/poTemplateDataBuilder.js#buildPOTemplateData` is the function
// that assembles the data fed to the Handlebars PDF template. Every
// printed PO that goes to a vendor — vendor name, billing/shipping
// address, GSTIN, line items, prices, taxes, freight, packaging, totals,
// payment terms, T&Cs — derives from this function's return shape. A bug
// here means every PO PDF has wrong data on it.
//
// The companion `getPODetailsById` (purchaseOrderModel.js) drives the
// buyer-facing PO Details API.
//
// Both were untested before this file. We lock the data-shape contract by
// constructing a realistic PO end-to-end (RFQ + product + quote with
// charges_meta + finalised PO + PO line items) and asserting every field
// the templates rely on.
//
// Per CONVENTIONS.md §1: the production helpers are invoked directly. No
// SQL is duplicated in the test.

import { describe, it, expect, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { buildPOTemplateData } from "../../app/helper/poTemplateDataBuilder.js";
import { getPODetailsById } from "../../app/models/purchaseOrderModel.js";

afterAll(async () => {
  await closeDb();
});

const inserted = {
  rfqIds: [], poIds: [], quoteIds: [], productRowIds: [],
  poLineIds: [], rfqProductIds: [], hsnRowIds: [],
  paymentTermIds: [], buyerLocationIds: [], supplierLocationIds: [],
  termsMapIds: [],
};

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.poIds = [];
  inserted.quoteIds = [];
  inserted.productRowIds = [];
  inserted.poLineIds = [];
  inserted.rfqProductIds = [];
  inserted.hsnRowIds = [];
  inserted.paymentTermIds = [];
  inserted.buyerLocationIds = [];
  inserted.supplierLocationIds = [];
  inserted.termsMapIds = [];
});

afterEach(async () => {
  if (inserted.poLineIds.length) {
    await db.none(
      `DELETE FROM tbl_purchase_order_product WHERE id = ANY($1::int[])`,
      [inserted.poLineIds]
    );
  }
  if (inserted.hsnRowIds.length) {
    await db.none(
      `DELETE FROM tbl_purchase_order_hsn_mapping WHERE id = ANY($1::int[])`,
      [inserted.hsnRowIds]
    );
  }
  if (inserted.poIds.length) {
    await db.none(
      `DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`,
      [inserted.poIds]
    );
  }
  if (inserted.paymentTermIds.length) {
    await db.none(
      `DELETE FROM tbl_quotes_payment_terms WHERE id = ANY($1::int[])`,
      [inserted.paymentTermIds]
    );
  }
  if (inserted.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [inserted.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [inserted.quoteIds]);
  }
  if (inserted.termsMapIds.length) {
    await db.none(`DELETE FROM tbl_rfq_terms_map WHERE id = ANY($1::int[])`, [inserted.termsMapIds]);
  }
  if (inserted.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY((SELECT array_agg(rfq_id) FROM tbl_rfq_products WHERE id = ANY($1::int[]))::int[])`, [inserted.rfqProductIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [inserted.rfqProductIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  if (inserted.buyerLocationIds.length || inserted.supplierLocationIds.length) {
    const allLocs = [...inserted.buyerLocationIds, ...inserted.supplierLocationIds];
    await db.none(`DELETE FROM tbl_company_location WHERE id = ANY($1::int[])`, [allLocs]);
  }
});

// ---- Helpers --------------------------------------------------------------

const isoNow = () => new Date().toISOString().replace("T", " ").slice(0, 19);

// Deterministic rfq_no counter for this suite. Picks a range above the
// generic factory's (8_000_000) and the other suites' (8_300_000+) to keep
// collisions impossible regardless of Jest run order.
let PO_DOC_RFQ_COUNTER = 8_700_000;
const nextRfqNo = () => ++PO_DOC_RFQ_COUNTER;

async function buildFullPOScenario({
  unitPrice = 500,
  quantity = 10,
  taxPercent = 18,
  otherCharges = [],
  poStatus = "approved",
  buyerAddress = "Mumbai BKC, Tower 1, Floor 5",
  supplierAddress = "Pune, Industrial Estate Block B",
} = {}) {
  // Buyer location (drives buyer.address + state in the template).
  const buyerLoc = await db.one(
    `INSERT INTO tbl_company_location (company_id, address, postal_code, created_by, created_at)
     VALUES ($1, $2, '400051', $3, NOW()) RETURNING id`,
    [IDS.companies.A, buyerAddress, IDS.users.a1_proc_buyer]
  );
  inserted.buyerLocationIds.push(buyerLoc.id);

  // Supplier location.
  const supplierLoc = await db.one(
    `INSERT INTO tbl_company_location (company_id, address, postal_code, created_by, created_at)
     VALUES ($1, $2, '411019', $3, NOW()) RETURNING id`,
    [IDS.companies.vendorAlpha, supplierAddress, IDS.users.vendor_alpha]
  );
  inserted.supplierLocationIds.push(supplierLoc.id);

  // RFQ — closed bid window, single product, vendor mapped.
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const rfqRow = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, process_id, is_tender, title)
     VALUES ($1, '<p>Standard procurement comment.</p>', '', 'buyer@a.test', 'A1 Buyer', '+91-99-1', $2, 'Mumbai',
             1, 1, $3, $3, NOW(), $4, $5, $6, 0, 'PO Doc Test RFQ')
     RETURNING id, rfq_no`,
    [
      nextRfqNo(),
      oneDayAgo,
      IDS.users.a1_proc_buyer,
      IDS.hospitality.A,
      IDS.hotels.A1,
      IDS.processes.A_P1,
    ]
  );
  inserted.rfqIds.push(rfqRow.id);

  // RFQ product + specs (Size, Spec — read by buildPOTemplateData).
  const rfqProduct = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
    [rfqRow.id]
  );
  inserted.rfqProductIds.push(rfqProduct.id);
  await db.none(
    `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
     VALUES ($1, 1, 'Size', '500ml', 0), ($1, 1, 'Spec', 'Glass Bottle, Pack of 12', 0)`,
    [rfqRow.id]
  );

  // Vendor mapping.
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, 1, $2, 0)`,
    [rfqRow.id, IDS.users.vendor_alpha]
  );

  // Quote (parent).
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp",
                             global_payment_term, global_comment, gstin)
     VALUES ($1, $2, $3, $3, 1, NOW(), '50% advance, 50% post-delivery',
             'Per attached terms', '27AAAAA0000A1Z5')
     RETURNING id`,
    [rfqRow.id, rfqRow.rfq_no, IDS.users.vendor_alpha]
  );
  inserted.quoteIds.push(quote.id);

  // Payment terms.
  for (const t of [
    { type: "advance", value: 50, days: null, comment: null },
    { type: "credit", value: 50, days: 30, comment: "post delivery" },
  ]) {
    const r = await db.one(
      `INSERT INTO tbl_quotes_payment_terms (quote_id, type, value, days, comment, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [quote.id, t.type, t.value, t.days, t.comment, IDS.users.vendor_alpha]
    );
    inserted.paymentTermIds.push(r.id);
  }

  // Quote item — base price + comment + delivery_period that
  // buildDeliveryTermsLabel can parse.
  const totalPrice = unitPrice * quantity;
  const quoteItem = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
        package_price, tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
     VALUES ($1, $2, $3, 1, $4, $5, 0, $6, 0, 0, 'Best market rate', '15', $7, 'percentage', $8)
     RETURNING id`,
    [
      rfqRow.id, rfqRow.rfq_no, quote.id, unitPrice, totalPrice,
      taxPercent, String(quantity), JSON.stringify(otherCharges),
    ]
  );

  // PO row.
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, gstin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '27AAAAA0000A1Z5')
     RETURNING id, po_number`,
    [
      rfqRow.id, IDS.companies.A, `PO-${rfqRow.rfq_no}-001`, poStatus,
      [rfqProduct.id], quantity, unitPrice,
      IDS.users.vendor_alpha, totalPrice, [quote.id], IDS.users.a1_proc_buyer,
    ]
  );
  inserted.poIds.push(po.id);

  // PO line item — charges_meta carries the snapshot of the charges at
  // finalisation. This is what the printed PO reads.
  const poLine = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, charges_meta, total_price)
     VALUES ($1, $2, $3, $4, 'pcs', $5, $6, $7) RETURNING id`,
    [
      po.id, rfqProduct.id, quoteItem.id, quantity, unitPrice,
      JSON.stringify({
        tax: taxPercent,
        tax_mode: "percentage",
        freight_price: 0, freight_mode: null,
        package_price: 0, package_mode: null,
        other_charges: otherCharges,
      }),
      totalPrice,
    ]
  );
  inserted.poLineIds.push(poLine.id);

  // HSN code on the line item.
  const hsn = await db.one(
    `INSERT INTO tbl_purchase_order_hsn_mapping (rfq_item_id, hsn_code)
     VALUES ($1, '22019090') RETURNING id`,
    [rfqProduct.id]
  );
  inserted.hsnRowIds.push(hsn.id);

  return { rfq_id: rfqRow.id, rfq_no: rfqRow.rfq_no, po_id: po.id, po_number: po.po_number, quote_id: quote.id };
}

const REALISTIC_CHARGES = [
  { name: "Freight", slug: "freight", amount: 100, amount_mode: "absolute", tax: 0, tax_mode: "absolute" },
  { name: "Packaging", slug: "packaging", amount: 50, amount_mode: "absolute", tax: 0, tax_mode: "absolute",
    comment: "ply box per crate" },
];

// ===========================================================================
//  buildPOTemplateData — full data assembly
// ===========================================================================

describe("buildPOTemplateData — full data assembly for the PDF template", () => {
  it("assembles every field the printed PO PDF relies on (supplier + buyer identity, items, totals, terms, hierarchy)", async () => {
    const scenario = await buildFullPOScenario({
      unitPrice: 500, quantity: 10, taxPercent: 18,
      otherCharges: REALISTIC_CHARGES,
    });

    const data = await buildPOTemplateData(scenario.po_id);
    expect(data).not.toBeNull();

    // ----- Identity blocks --------------------------------------------------
    expect(data.po_number).toBe(scenario.po_number);
    expect(data.rfq_no).toBe(scenario.rfq_no);
    expect(data.rfq_title).toBe("PO Doc Test RFQ");
    expect(data.created_at).toBeTruthy();

    // Supplier block — name, address, gstin from quote take precedence.
    expect(data.supplier).toBeDefined();
    expect(data.supplier.name).toBeTruthy();
    expect(data.supplier.email).toBe("alpha@vendor.test");
    // Quote.gstin overrides company gstin per the model SELECT.
    expect(data.supplier.gstin).toBe("27AAAAA0000A1Z5");
    expect(typeof data.supplier.address).toBe("string");
    expect(data.supplier.address).toMatch(/Pune/);

    // Buyer block — hotel name + hotel gstin + buyer address.
    expect(data.buyer).toBeDefined();
    expect(data.buyer.business_unit_name).toBeTruthy();
    expect(typeof data.buyer.address).toBe("string");
    expect(data.buyer.address).toMatch(/Mumbai/);
    expect(data.buyer.contact_person).toBe("A1 Buyer");
    expect(data.buyer.email).toBe("buyer@a.test");

    // ----- Items + pricing --------------------------------------------------
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items.length).toBe(1);
    const item = data.items[0];
    expect(item.product_name).toBeTruthy();
    expect(Number(item.quantity)).toBe(10);
    expect(Number(item.unit_price)).toBe(500);
    expect(item.hsn_code).toBe("22019090");
    expect(item.size).toBe("500ml");
    expect(item.specification).toBe("Glass Bottle, Pack of 12");
    expect(item.comment).toBe("Best market rate");
    expect(item.basic_amount).toBeDefined();
    expect(item.taxable_amount).toBeDefined();
    expect(item.tax_amount).toBeDefined();

    // other_charges round-trip from charges_meta:
    const charges = Array.isArray(item.other_charges)
      ? item.other_charges
      : JSON.parse(item.other_charges || "[]");
    const slugs = charges.map((c) => c.slug).sort();
    expect(slugs).toEqual(["freight", "packaging"]);

    // charge_details should be computed (one entry per charge).
    expect(Array.isArray(item.charge_details)).toBe(true);
    expect(item.charge_details.length).toBeGreaterThanOrEqual(2);

    // ----- Tax-mode resolution + per-item tax breakdown ---------------------
    expect(["gst", "split", "igst"]).toContain(data.tax_mode);
    expect(Array.isArray(item.tax_detail_lines)).toBe(true);

    // ----- Payment terms ----------------------------------------------------
    expect(Array.isArray(data.paymentTermsList)).toBe(true);
    expect(data.paymentTermsList.length).toBe(2);
    const termsByType = Object.fromEntries(data.paymentTermsList.map((t) => [t.type, t]));
    expect(Number(termsByType["advance"].value)).toBe(50);
    expect(Number(termsByType["credit"].value)).toBe(50);
    expect(termsByType["credit"].days).toBe(30);

    // ----- RFQ terms (from rfq.comment HTML) -------------------------------
    expect(Array.isArray(data.rfqTerms)).toBe(true);
    // The RFQ.comment contains a <p> — should produce at least one term row.
    expect(data.rfqTerms.length).toBeGreaterThanOrEqual(1);

    // ----- Misc -------------------------------------------------------------
    expect(data.global_comment).toBe("Per attached terms");
    expect(data.deliveryterms).toBeTruthy();
  });

  it("throws a clear error for a non-existent PO id", async () => {
    await expect(buildPOTemplateData(999999999)).rejects.toThrow(/not found/i);
  });

  it("legacy charges path: freight_price/package_price get adapted into engine charges via normalizeChargesMeta", async () => {
    // Old data shape — other_charges=[], freight_price=200 absolute.
    // Build a scenario but override charges_meta to legacy shape.
    const scenario = await buildFullPOScenario({
      unitPrice: 500, quantity: 10, taxPercent: 18,
      otherCharges: [],
    });
    // Patch the PO line's charges_meta to legacy.
    await db.none(
      `UPDATE tbl_purchase_order_product
         SET charges_meta = $2
       WHERE purchase_order_id = $1`,
      [scenario.po_id, JSON.stringify({
        tax: 18, tax_mode: "percentage",
        freight_price: 200, freight_mode: "absolute",
        package_price: 100, package_mode: "absolute",
        other_charges: [],
      })]
    );

    const data = await buildPOTemplateData(scenario.po_id);
    const item = data.items[0];
    // pricingEngine.normalizeChargesMeta converts the legacy flat shape into
    // engine other_charges entries → charge_details has Freight + Packaging.
    expect(Array.isArray(item.charge_details)).toBe(true);
    expect(item.charge_details.length).toBe(2);
    const names = item.charge_details.map((c) => c.name).sort();
    expect(names).toEqual(["Freight", "Packaging"]);
  });
});

// ===========================================================================
//  END-TO-END money path: vendor quote → finalize → drafted PO →
//  buildPOTemplateData. The printed PO total MUST match what the vendor
//  quoted, including every other_charge.
//
// This is the test that catches the real-world failure observed on
// staging RFQ 189 / PO 19, where the printed total was ₹32,500 but the
// vendor's quote total was ₹49,225 — a ₹16,725 underpayment. The bug
// upstream of this test: charges_meta on the drafted PO line was missing
// `other_charges`, so the PDF renderer computed only basic + tax.
// ===========================================================================

describe("Vendor quote → drafted PO: other_charges MUST round-trip into charges_meta", () => {
  it("draftPO via the production buildAuthoritativePOPayload path preserves the quote's other_charges into the PO line's charges_meta", async () => {
    // Mirror RFQ 189's vendor 419 charge shape: percentage Freight + percentage
    // Insurance, each with their own per-charge tax rate.
    const charges = [
      { name: "Freight",   slug: "freight",   amount: 10, amount_mode: "percentage", tax: 9,  tax_mode: "percentage" },
      { name: "Insurance", slug: "insurance", amount: 50, amount_mode: "percentage", tax: 12, tax_mode: "percentage" },
    ];

    // Set up everything BUT the PO — we drive PO creation via the production
    // helpers that the finalize controller calls.
    const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const buyerLoc = await db.one(
      `INSERT INTO tbl_company_location (company_id, address, postal_code, created_by, created_at)
       VALUES ($1, 'Mumbai', '400051', $2, NOW()) RETURNING id`,
      [IDS.companies.A, IDS.users.a1_proc_buyer]
    );
    inserted.buyerLocationIds.push(buyerLoc.id);
    const supplierLoc = await db.one(
      `INSERT INTO tbl_company_location (company_id, address, postal_code, created_by, created_at)
       VALUES ($1, 'Pune', '411019', $2, NOW()) RETURNING id`,
      [IDS.companies.vendorAlpha, IDS.users.vendor_alpha]
    );
    inserted.supplierLocationIds.push(supplierLoc.id);

    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, process_id, is_tender, title)
       VALUES ($1, '<p>e2e</p>', '', 'b@a', 'A1', '+91', $2, 'Mumbai', 1, 1, $3, $3, NOW(),
               $4, $5, $6, 0, 'E2E money path')
       RETURNING id, rfq_no`,
      [nextRfqNo(), oneDayAgo, IDS.users.a1_proc_buyer,
       IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1]
    );
    inserted.rfqIds.push(rfq.id);

    const rfqProd = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
      [rfq.id]
    );
    inserted.rfqProductIds.push(rfqProd.id);

    const quote = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
       VALUES ($1, $2, $3, $3, 1, NOW()) RETURNING id`,
      [rfq.id, rfq.rfq_no, IDS.users.vendor_alpha]
    );
    inserted.quoteIds.push(quote.id);

    // Vendor's actual quote item — unit 500, qty 50, tax 30%, with the two
    // other_charges. Vendor-stamped total_price 49225 (mirrors RFQ 189).
    const qi = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
          package_price, tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
       VALUES ($1, $2, $3, 1, 500, 49225, 0, 30, 0, 0, 'realistic', '15', '50', 'percentage', $4)
       RETURNING id`,
      [rfq.id, rfq.rfq_no, quote.id, JSON.stringify(charges)]
    );

    // Drive the production drafting path EXACTLY like rfqController.finalize
    // does at line 9211: buildAuthoritativePOPayload({...}, t) → draftPO.
    const { buildAuthoritativePOPayload, draftPO } = await import(
      "../../app/controllers/po/purchaseOrderController.js"
    );

    const poId = await db.tx(async (t) => {
      const authPayload = await buildAuthoritativePOPayload(
        {
          rfq_id: rfq.id,
          project_id: null,
          total_value: 49225,
          quote_id: qi.id,
          quote_item_id: qi.id,
          product_info: {
            rfq_product_id: rfqProd.id,
            quantity: 50,
            unit: "pcs",
            unit_price: 500,
            finalized_vendor_id: IDS.users.vendor_alpha,
          },
        },
        t
      );

      const result = await draftPO(
        authPayload,
        { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        t
      );
      return result.po_id;
    });
    inserted.poIds.push(poId);

    // ----- ASSERT 1: charges_meta on the PO line carries other_charges --
    const popRow = await db.one(
      `SELECT charges_meta, total_price FROM tbl_purchase_order_product
       WHERE purchase_order_id = $1`,
      [poId]
    );
    inserted.poLineIds.push(popRow.id);
    const meta = typeof popRow.charges_meta === "string"
      ? JSON.parse(popRow.charges_meta)
      : popRow.charges_meta;

    expect(Array.isArray(meta.other_charges)).toBe(true);
    expect(meta.other_charges.length).toBe(2);
    const slugs = meta.other_charges.map((c) => c.slug).sort();
    expect(slugs).toEqual(["freight", "insurance"]);

    // Each charge: name, slug, amount, amount_mode, tax, tax_mode preserved.
    const bySlug = Object.fromEntries(meta.other_charges.map((c) => [c.slug, c]));
    expect(bySlug["freight"].amount).toBe(10);
    expect(bySlug["freight"].amount_mode).toBe("percentage");
    expect(bySlug["freight"].tax).toBe(9);
    expect(bySlug["freight"].tax_mode).toBe("percentage");
    expect(bySlug["insurance"].amount).toBe(50);
    expect(bySlug["insurance"].tax).toBe(12);

    // ----- ASSERT 2: PDF total matches the math from the vendor's charges -
    // Hand math (engine's per-line formula, line 95 of pricingEngine.js:
    // `total = round(base + base_tax + charges_total)`):
    //   base       = 50 × 500 = 25000
    //   base_tax   = 25000 × 0.30 = 7500       (tax applied to BASE only)
    //   Freight    = 25000 × 0.10 = 2500       (charge tax 9% on 2500 = 225 → subtotal 2725)
    //   Insurance  = 25000 × 0.50 = 12500      (charge tax 12% on 12500 = 1500 → subtotal 14000)
    //   charges_total = 2725 + 14000 = 16725
    //   line total = 25000 + 7500 + 16725 = 49225  (matches vendor's qi.total_price)
    //
    // PO PDF (buildPOTemplatePricing rollup):
    //   basicAmount   = 25000
    //   totalCharges  = 2500 + 12500 = 15000   (charge AMOUNTS only, excl. their tax)
    //   gstAmount     = 7500 + 1725 = 9225     (base_tax + sum of per-charge tax)
    //   totalSubtotal = 49225
    //   totalPrice    = 49225 (no PO-level global charges)
    const data = await buildPOTemplateData(poId);
    expect(parseFloat(data.basicAmount)).toBe(25000);
    expect(parseFloat(data.totalCharges)).toBe(15000);
    expect(parseFloat(data.gstAmount)).toBe(9225);
    expect(parseFloat(data.totalSubtotal)).toBe(49225);
    expect(parseFloat(data.totalPrice)).toBe(49225);

    // Per-line subtotal lock — same engine total = vendor quote total.
    const item = data.items[0];
    expect(parseFloat(item.subtotal)).toBe(49225);

    // Per-charge breakdown for the row's description column.
    const cdByName = Object.fromEntries(item.charge_details.map((c) => [c.name, c]));
    expect(parseFloat(cdByName["Freight"].amount)).toBe(2500);
    expect(parseFloat(cdByName["Freight"].tax)).toBe(225);
    expect(cdByName["Freight"].has_tax).toBe(true);
    expect(parseFloat(cdByName["Insurance"].amount)).toBe(12500);
    expect(parseFloat(cdByName["Insurance"].tax)).toBe(1500);
    expect(cdByName["Insurance"].has_tax).toBe(true);

    // The PRINTED grand total must NOT collapse to "basic + tax only" —
    // that's the F-PO-CHARGES-LOST staging PO 19 bug shape (₹32,500
    // instead of the real ₹49,225). Lock explicitly:
    const wrongTotalIfChargesDropped = 25000 + 25000 * 0.30; // = 32500
    expect(parseFloat(data.totalPrice)).not.toBe(wrongTotalIfChargesDropped);
  });
});

// (F-PO-CHARGES-LOST: legacy POs render with wrong totals because their
// stored `charges_meta` lacks `other_charges`. This was observed in
// production on PO 19 (RFQ 189): printed total ₹32,500 vs vendor quote
// total ₹49,225. Defect logged in AUDIT_REPORT.md §F-PO-CHARGES-LOST.
// Fix path is engineering-side: renderer fallback to `tbl_quote_items.
// other_charges` via `POP.quote_id` + a one-time data backfill. Locking
// it here as a permanently-failing test would block CI; tracked as a
// defect ticket instead.)

// ===========================================================================
//  STRICT money-path verification — every Rupee on the printed PO
// ===========================================================================
//
// The user-facing PO PDF must reflect the vendor's quote exactly, including
// other_charges (Freight, Packaging, custom charges) and the totals derived
// from them. The flow is:
//
//   tbl_quote_items.other_charges (vendor)  →
//   tbl_purchase_order_product.charges_meta.other_charges (PO snapshot) →
//   buildPOTemplatePricing inside buildPOTemplateData →
//   `data.items[i].{basic,other_charges_total,taxable,tax,gst/cgst/sgst}` →
//   PO PDF
//
// We hand-compute every Rupee for a deterministic scenario and assert it.
// If any number drifts, the printed PO is wrong and the test catches it.

describe("buildPOTemplateData — STRICT money path: every Rupee in the PO PDF (engine math)", () => {
  // Scenario A: unit=500 × qty=10, tax=18%, Freight=100 abs no-tax,
  // Packaging=50 abs no-tax. Both explicit-tax-zero charges INHERIT the
  // base 18% per pricingEngine.calculateLineTotal's inheritance rule.
  //
  // Engine math:
  //   base         = 5000
  //   base_tax     = 5000 × 0.18 = 900
  //   Freight      = 100 (abs); explicit tax = 0 → inherits 18% → 100 × 0.18 = 18
  //   Packaging    = 50  (abs); explicit tax = 0 → inherits 18% → 50  × 0.18 = 9
  //   charges_total= (100+18) + (50+9) = 177
  //   line total   = 5000 + 900 + 177 = 6077
  //
  // PDF rollup (buildPOTemplatePricing):
  //   basicAmount   = 5000
  //   totalCharges  = 100 + 50 = 150           (charge AMOUNTS only)
  //   gstAmount     = 900 + 27 = 927           (base_tax + per-charge tax)
  //   totalSubtotal = 6077
  //   totalPrice    = 6077                     (no PO-level global)
  it("Scenario A — explicit-zero per-charge tax INHERITS item.tax (the F-CHARGE-TAX-FALLBACK rule)", async () => {
    const charges = [
      { name: "Freight", slug: "freight", amount: 100, amount_mode: "absolute", tax: 0, tax_mode: "absolute",
        comment: "no-tax stub" },
      { name: "Packaging", slug: "packaging", amount: 50, amount_mode: "absolute", tax: 0, tax_mode: "absolute",
        comment: "no-tax stub" },
    ];
    const scenario = await buildFullPOScenario({
      unitPrice: 500, quantity: 10, taxPercent: 18, otherCharges: charges,
    });
    const data = await buildPOTemplateData(scenario.po_id);

    // Top-level rollup.
    expect(parseFloat(data.basicAmount)).toBe(5000);
    expect(parseFloat(data.totalCharges)).toBe(150);
    expect(parseFloat(data.gstAmount)).toBe(927);
    expect(parseFloat(data.totalSubtotal)).toBe(6077);
    expect(parseFloat(data.totalPrice)).toBe(6077);

    // Per-line.
    const item = data.items[0];
    expect(parseFloat(item.basic_amount)).toBe(5000);
    expect(parseFloat(item.subtotal)).toBe(6077);
    expect(parseFloat(item.tax_amount)).toBe(927);

    // Per-charge breakdown — tax INHERITED 18% from item.tax for both.
    const cdByName = Object.fromEntries(item.charge_details.map((c) => [c.name, c]));
    expect(parseFloat(cdByName["Freight"].amount)).toBe(100);
    expect(parseFloat(cdByName["Freight"].tax)).toBe(18);  // inherited
    expect(cdByName["Freight"].has_tax).toBe(true);
    expect(parseFloat(cdByName["Packaging"].amount)).toBe(50);
    expect(parseFloat(cdByName["Packaging"].tax)).toBe(9);  // inherited

    // Tax-detail lines for PDF render.
    expect(Array.isArray(item.tax_detail_lines)).toBe(true);
    expect(item.tax_detail_lines.length).toBeGreaterThan(0);
  });

  // Scenario B: explicit non-zero per-charge tax overrides inheritance.
  //   unit=1000, qty=5, tax=12%, Freight=10% pct + 18% pct tax, Insurance=200 abs no-tax
  //   base       = 5000, base_tax = 600
  //   Freight    = 5000 × 0.10 = 500  → tax 500 × 0.18 = 90 → subtotal 590
  //   Insurance  = 200 abs → tax inherits 12% → 200 × 0.12 = 24 → subtotal 224
  //   charges_total = 814
  //   line total = 5000 + 600 + 814 = 6414
  //
  // PDF rollup:
  //   basicAmount   = 5000
  //   totalCharges  = 500 + 200 = 700
  //   gstAmount     = 600 + 90 + 24 = 714
  //   totalSubtotal = 6414
  //   totalPrice    = 6414
  it("Scenario B — explicit non-zero charge tax wins; charges with no explicit tax still inherit", async () => {
    const charges = [
      { name: "Freight", slug: "freight", amount: 10, amount_mode: "percentage", tax: 18, tax_mode: "percentage",
        comment: "Pune→Mumbai" },
      { name: "Insurance", slug: "insurance", amount: 200, amount_mode: "absolute", tax: 0, tax_mode: "absolute" },
    ];
    const scenario = await buildFullPOScenario({
      unitPrice: 1000, quantity: 5, taxPercent: 12, otherCharges: charges,
    });
    const data = await buildPOTemplateData(scenario.po_id);

    expect(parseFloat(data.basicAmount)).toBe(5000);
    expect(parseFloat(data.totalCharges)).toBe(700);
    expect(parseFloat(data.gstAmount)).toBe(714);
    expect(parseFloat(data.totalSubtotal)).toBe(6414);
    expect(parseFloat(data.totalPrice)).toBe(6414);

    const cdByName = Object.fromEntries(
      data.items[0].charge_details.map((c) => [c.name, c])
    );
    expect(parseFloat(cdByName["Freight"].amount)).toBe(500);
    expect(parseFloat(cdByName["Freight"].tax)).toBe(90);   // explicit 18% wins
    expect(parseFloat(cdByName["Insurance"].amount)).toBe(200);
    expect(parseFloat(cdByName["Insurance"].tax)).toBe(24); // inherited 12%
  });

  // Scenario C: empty other_charges — basic + tax only.
  //   unit=750, qty=4, tax=18%, no charges
  //   base = 3000, base_tax = 540, total = 3540
  it("Scenario C — empty other_charges: PO totals are basic + base_tax with no charge rows", async () => {
    const scenario = await buildFullPOScenario({
      unitPrice: 750, quantity: 4, taxPercent: 18, otherCharges: [],
    });
    const data = await buildPOTemplateData(scenario.po_id);
    const item = data.items[0];

    expect(parseFloat(item.basic_amount)).toBe(3000);
    expect(item.charge_details).toEqual([]);
    expect(parseFloat(item.subtotal)).toBe(3540);
    expect(parseFloat(item.tax_amount)).toBe(540);

    // Top-level totals.
    expect(parseFloat(data.basicAmount)).toBe(3000);
    expect(data.totalCharges).toBeNull();      // no charges → null
    expect(parseFloat(data.gstAmount)).toBe(540);
    expect(parseFloat(data.totalSubtotal)).toBe(3540);
    expect(parseFloat(data.totalPrice)).toBe(3540);
    expect(data.globalCharges).toBeNull();
  });
});

// ===========================================================================
//  getPODetailsById — buyer-side PO Details API
// ===========================================================================

describe("getPODetailsById — buyer PO Details API exposes the same data", () => {
  it("returns PO-level totals + supplier identity + per-product line items with charges_meta intact", async () => {
    const scenario = await buildFullPOScenario({
      unitPrice: 500, quantity: 10, taxPercent: 18,
      otherCharges: REALISTIC_CHARGES,
    });

    const data = await getPODetailsById(scenario.po_id, IDS.users.a1_proc_buyer);
    expect(data).not.toBeNull();

    expect(data.po_number).toBe(scenario.po_number);
    expect(Number(data.quantity)).toBe(10);
    expect(Number(data.unit_price)).toBe(500);
    expect(Number(data.total_value)).toBe(5000);
    expect(data.finalized_vendor_email).toBe("alpha@vendor.test");
    expect(data.buyer_business_unit).toBeTruthy();
    expect(data.rfq_no).toBe(scenario.rfq_no);
    expect(data.rfq_title).toBe("PO Doc Test RFQ");

    // Per-product list lands under `product_details` in the model SELECT.
    const products = Array.isArray(data.product_details)
      ? data.product_details
      : JSON.parse(data.product_details || "[]");
    expect(products.length).toBe(1);
    expect(Number(products[0].quantity)).toBe(10);
    expect(Number(products[0].unit_price)).toBe(500);
    expect(Number(products[0].total_price)).toBe(5000);

    const meta = typeof products[0].charges_meta === "string"
      ? JSON.parse(products[0].charges_meta)
      : products[0].charges_meta;
    expect(meta.tax).toBe(18);
    expect(meta.tax_mode).toBe("percentage");
    expect(Array.isArray(meta.other_charges)).toBe(true);
    expect(meta.other_charges.length).toBe(2);
    const slugs = meta.other_charges.map((c) => c.slug).sort();
    expect(slugs).toEqual(["freight", "packaging"]);
  });
});
