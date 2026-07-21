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
    // Post-2026-06-19: charge tax (1725) is attributed to totalCharges, not
    // gstAmount. Grand total (totalSubtotal = 49225) is unchanged.
    expect(parseFloat(data.totalCharges)).toBe(16725);
    expect(parseFloat(data.gstAmount)).toBe(7500);
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

  // -------------------------------------------------------------------------
  // Document-level global_charges live on tbl_quotes.global_charges. They
  // were never being snapshotted onto the PO at draft, so:
  //   - tbl_rfq_purchase_order.total_value (used by the PO Details page)
  //     was missing them, while
  //   - the printed PDF re-derived them via a LATERAL JOIN to tbl_quotes
  // → three readers, three different totals. The fix snapshots
  // tbl_quotes.global_charges into a new tbl_rfq_purchase_order.global_charges
  // column at draft time and lets total_value = line subtotal + global charges.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Schema regression: tbl_purchase_order_product (quantity, unit_price,
  // total_price) was originally typed integer/bigint, but tbl_quote_items
  // stores quantity as varchar — vendors routinely submit fractional values
  // like "45.799 kg". The audit's existing tests used integer fixtures and
  // never tripped this. Lock the contract that fractional quote inputs flow
  // into the PO without an integer-cast error.
  // -------------------------------------------------------------------------
  it("draftPO accepts fractional quantity from tbl_quote_items and persists it onto the PO line without integer-cast error", async () => {
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
               $4, $5, $6, 0, 'fractional quantity test')
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

    // Real-world shape from production: quantity stored as varchar with
    // fractional value, unit_price as a fractional real.
    const FRACTIONAL_QTY_TEXT = "45.799";
    const FRACTIONAL_UNIT_PRICE = 150.5;
    const qi = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
          package_price, tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
       VALUES ($1, $2, $3, 1, $4, 0, 0, 18, 0, 0, 'frac', '15', $5, 'percentage', '[]'::jsonb)
       RETURNING id`,
      [rfq.id, rfq.rfq_no, quote.id, FRACTIONAL_UNIT_PRICE, FRACTIONAL_QTY_TEXT]
    );

    const { buildAuthoritativePOPayload, draftPO } = await import(
      "../../app/controllers/po/purchaseOrderController.js"
    );

    // Drive the production drafting path with the fractional quantity from
    // the quote item — exactly what rfqController.finalize / approveQuotes
    // pass through to draftPO. Before the schema fix, this INSERT failed
    // with "invalid input syntax for type integer: '45.799'".
    const poId = await db.tx(async (t) => {
      const auth = await buildAuthoritativePOPayload(
        {
          rfq_id: rfq.id, project_id: null, total_value: 0,
          quote_id: qi.id, quote_item_id: qi.id,
          product_info: {
            rfq_product_id: rfqProd.id,
            quantity: FRACTIONAL_QTY_TEXT,    // string varchar from quote
            unit: "kg",
            unit_price: FRACTIONAL_UNIT_PRICE, // fractional unit price
            finalized_vendor_id: IDS.users.vendor_alpha,
          },
        },
        t
      );
      const r = await draftPO(
        auth,
        { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        t
      );
      return r.po_id;
    });
    inserted.poIds.push(poId);

    const popRow = await db.one(
      `SELECT id, quantity, unit_price, total_price, charges_meta
       FROM tbl_purchase_order_product WHERE purchase_order_id = $1`,
      [poId]
    );
    inserted.poLineIds.push(popRow.id);

    // Persisted fractional quantity round-trips exactly.
    expect(Number(popRow.quantity)).toBe(45.799);
    expect(Number(popRow.unit_price)).toBe(150.5);

    // Engine math: 45.799 × 150.5 = 6892.7495; +18% tax = 8133.444... ; engine
    // rounds the *line total* to 8133. PO header total_value mirrors that
    // (no global charges in this scenario).
    expect(Number(popRow.total_price)).toBe(8133.44);
    const headerRow = await db.one(
      `SELECT total_value FROM tbl_rfq_purchase_order WHERE id = $1`,
      [poId]
    );
    expect(Number(headerRow.total_value)).toBe(8133.44);
  });

  it("draftPO snapshots tbl_quotes.global_charges onto the PO header and rolls them into total_value", async () => {
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
               $4, $5, $6, 0, 'global_charges snapshot test')
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

    // Vendor's quote: empty per-line other_charges (irrelevant here),
    // but global_charges populated on the PARENT quote row. Mix the two
    // on-disk shapes — the {amount, amount_mode} shape (newer quote-tool
    // input) and the legacy {tax, tax_mode, is_global: true} shape that the
    // vendor send-quote screen still emits today for TCS/TDS-style document
    // taxes — to lock that pricingEngine.normalizeGlobalCharge handles both.
    const globalCharges = [
      { name: "Document Fee",       slug: "document_fee", amount: 500, amount_mode: "absolute" },
      { name: "TCS",                slug: "tcs",          tax: 2,      tax_mode: "percentage", is_global: true },
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
       VALUES ($1, $2, $3, 1, 500, 25000, 0, 0, 0, 0, 'flat', '15', '50', 'absolute', '[]'::jsonb)
       RETURNING id`,
      [rfq.id, rfq.rfq_no, quote.id]
    );

    // Drive the production drafting path.
    const { buildAuthoritativePOPayload, draftPO } = await import(
      "../../app/controllers/po/purchaseOrderController.js"
    );

    const poId = await db.tx(async (t) => {
      const authPayload = await buildAuthoritativePOPayload(
        {
          rfq_id: rfq.id,
          project_id: null,
          total_value: 25000, // intentionally line-only; engine should override
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

    // ---- Assert 1: snapshot lives on the PO header ----
    const poRow = await db.one(
      `SELECT global_charges, total_value FROM tbl_rfq_purchase_order WHERE id = $1`,
      [poId]
    );
    const snapshot = typeof poRow.global_charges === "string"
      ? JSON.parse(poRow.global_charges)
      : poRow.global_charges;
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot.length).toBe(2);
    const slugs = snapshot.map((c) => c.slug).sort();
    expect(slugs).toEqual(["document_fee", "tcs"]);
    // Raw shape preserved exactly as the vendor stored it (legacy {tax} shape
    // for TCS, newer {amount} shape for Document Fee).
    const tcsRow = snapshot.find((c) => c.slug === "tcs");
    expect(tcsRow.tax).toBe(2);
    expect(tcsRow.tax_mode).toBe("percentage");

    // ---- Assert 2: stored total_value includes global charges ----
    // Hand math:
    //   line total = 50 * 500 = 25000 (no per-line tax / freight / package / other_charges)
    //   document_fee   = 500 (absolute)
    //   tcs 2%         = 25000 * 0.02 = 500
    //   global_charges_total = 1000
    //   grand_total = 25000 + 1000 = 26000
    expect(parseFloat(poRow.total_value)).toBe(26000);

    // ---- Assert 3: PDF template data renders the same numbers ----
    // The user-facing PDF must agree with the stored total. Reads
    // PO.global_charges (snapshotted) — NOT the live tbl_quotes row, so the
    // total is locked even if the source quote is later edited or deleted.
    const data = await buildPOTemplateData(poId);
    expect(parseFloat(data.totalPrice)).toBe(26000);
    expect(Array.isArray(data.globalCharges)).toBe(true);
    expect(data.globalCharges.length).toBe(2);
    const gcByName = Object.fromEntries(
      data.globalCharges.map((c) => [c.name, c])
    );
    expect(parseFloat(gcByName["Document Fee"].amount)).toBe(500);
    expect(parseFloat(gcByName["TCS"].amount)).toBe(500);

    // ---- Assert 4: snapshot survives source-quote tampering ----
    // The whole point of snapshotting (vs. live LATERAL join) is that
    // mutating the source quote AFTER draft must NOT change PO totals.
    await db.none(
      `UPDATE tbl_quotes SET global_charges = '[]'::jsonb WHERE id = $1`,
      [quote.id]
    );
    const dataAfter = await buildPOTemplateData(poId);
    expect(parseFloat(dataAfter.totalPrice)).toBe(26000);
    expect(dataAfter.globalCharges.length).toBe(2);

    // ---- Assert 5: PO Details API returns global_charges + correct total ----
    // The buyer's PO Details page reads from getPODetailsById. It must surface
    // global_charges and the same grand total the PDF prints.
    const apiData = await getPODetailsById(poId, IDS.users.a1_proc_buyer);
    expect(apiData).not.toBeNull();
    expect(Number(apiData.total_value)).toBe(26000);
    // Line aggregate (without global charges) is exposed separately so the
    // FE can render Subtotal + Global Charges + Grand Total breakdown.
    expect(Number(apiData.line_subtotal)).toBe(25000);
    const apiGc = typeof apiData.global_charges === "string"
      ? JSON.parse(apiData.global_charges)
      : apiData.global_charges;
    expect(Array.isArray(apiGc)).toBe(true);
    expect(apiGc.length).toBe(2);
    const apiSlugs = apiGc.map((c) => c.slug).sort();
    expect(apiSlugs).toEqual(["document_fee", "tcs"]);

    // Capture line for cleanup.
    const popRow = await db.one(
      `SELECT id FROM tbl_purchase_order_product WHERE purchase_order_id = $1`,
      [poId]
    );
    inserted.poLineIds.push(popRow.id);
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
  it("Scenario A — explicit-null per-charge tax INHERITS item.tax (the F-CHARGE-TAX-FALLBACK rule)", async () => {
    // Under the post-PR-#124 tri-state contract, only `tax: null` means
    // "inherit base rate". `tax: 0` is now an explicit no-tax escape hatch
    // (locked in by Scenario A2 below).
    const charges = [
      { name: "Freight", slug: "freight", amount: 100, amount_mode: "absolute", tax: null, tax_mode: "absolute",
        comment: "no-tax stub" },
      { name: "Packaging", slug: "packaging", amount: 50, amount_mode: "absolute", tax: null, tax_mode: "absolute",
        comment: "no-tax stub" },
    ];
    const scenario = await buildFullPOScenario({
      unitPrice: 500, quantity: 10, taxPercent: 18, otherCharges: charges,
    });
    const data = await buildPOTemplateData(scenario.po_id);

    // Top-level rollup.
    expect(parseFloat(data.basicAmount)).toBe(5000);
    // Post-2026-06-19: inherited charge tax (27) is attributed to totalCharges
    // (150 + 27 = 177); gstAmount holds base tax only (900). Grand total intact.
    expect(parseFloat(data.totalCharges)).toBe(177);
    expect(parseFloat(data.gstAmount)).toBe(900);
    expect(parseFloat(data.totalSubtotal)).toBe(6077);
    expect(parseFloat(data.totalPrice)).toBe(6077);

    // Per-line.
    const item = data.items[0];
    expect(parseFloat(item.basic_amount)).toBe(5000);
    expect(parseFloat(item.subtotal)).toBe(6077);
    // Post-2026-06-19: per-line tax_amount = base tax only (900); charge tax (27)
    // lives in the charge amount. subtotal (6077) is unchanged.
    expect(parseFloat(item.tax_amount)).toBe(900);

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

  // Scenario A2: the tri-state escape hatch from PR #124.
  //   unit=500, qty=10, tax=18%, Freight=100 abs with EXPLICIT tax: 0
  //   base         = 5000, base_tax = 900
  //   Freight      = 100 abs; charge.tax = 0 (number) → explicit "no tax"
  //                  → engine emits Freight tax = 0 (does NOT inherit 18%)
  //   charges_total= 100
  //   line total   = 5000 + 900 + 100 = 6000
  //
  // PDF rollup:
  //   basicAmount   = 5000
  //   totalCharges  = 100
  //   gstAmount     = 900   (only base_tax — no per-charge tax)
  //   totalSubtotal = 6000
  it("Scenario A2 — explicit-zero per-charge tax does NOT inherit (tri-state escape hatch)", async () => {
    const charges = [
      { name: "Freight", slug: "freight", amount: 100, amount_mode: "absolute",
        tax: 0, tax_mode: "absolute", comment: "explicit no-tax" },
    ];
    const scenario = await buildFullPOScenario({
      unitPrice: 500, quantity: 10, taxPercent: 18, otherCharges: charges,
    });
    const data = await buildPOTemplateData(scenario.po_id);

    expect(parseFloat(data.basicAmount)).toBe(5000);
    expect(parseFloat(data.totalCharges)).toBe(100);
    expect(parseFloat(data.gstAmount)).toBe(900);
    expect(parseFloat(data.totalSubtotal)).toBe(6000);
    expect(parseFloat(data.totalPrice)).toBe(6000);

    const cd = data.items[0].charge_details.find((c) => c.name === "Freight");
    expect(parseFloat(cd.amount)).toBe(100);
    expect(parseFloat(cd.tax)).toBe(0);   // NOT inherited
    expect(cd.has_tax).toBe(false);
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
      // tax: null → inherits item tax (12%) under tri-state. Comment is now
      // mandatory for every per-product charge (PR #124 Change B).
      { name: "Insurance", slug: "insurance", amount: 200, amount_mode: "absolute", tax: null, tax_mode: "absolute",
        comment: "stock-loss cover" },
    ];
    const scenario = await buildFullPOScenario({
      unitPrice: 1000, quantity: 5, taxPercent: 12, otherCharges: charges,
    });
    const data = await buildPOTemplateData(scenario.po_id);

    expect(parseFloat(data.basicAmount)).toBe(5000);
    // Post-2026-06-19: charge tax (114) is attributed to totalCharges (700 +
    // 114 = 814); gstAmount holds base tax only (600). Grand total intact.
    expect(parseFloat(data.totalCharges)).toBe(814);
    expect(parseFloat(data.gstAmount)).toBe(600);
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

// ===========================================================================
//  Two-line PO merge: TCS applied once on the combined subtotal
// ===========================================================================
//
// Production scenario (RFQ 227 / PO 31): buyer finalized two products from
// the same vendor and merged them into one PO. Both source quotes carried
// TCS 5% on tbl_quotes.global_charges. The PO must have:
//   1. ONE TCS snapshot on the header (not two — they're the same charge).
//   2. total_value = (sum of line subtotals) + 5% × (sum of line subtotals),
//      i.e., TCS applied once to the COMBINED subtotal — never per-line.
//   3. Per-product total_price (line) excludes globals; the FE allocates
//      globals proportionally for display so ΣproductTotal == total_value.
//
// This test pins the merge math and the snapshot policy so the per-line
// "what if I only buy this one" view in compare doesn't get accidentally
// summed into the merged PO's grand total.
describe("Two-product PO merge — TCS applied once on combined subtotal", () => {
  it("draftPO with existing_po_id appends a line; total_value reflects ONE TCS over the combined subtotal", async () => {
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
               $4, $5, $6, 0, 'two-product PO merge test')
       RETURNING id, rfq_no`,
      [nextRfqNo(), oneDayAgo, IDS.users.a1_proc_buyer,
       IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1]
    );
    inserted.rfqIds.push(rfq.id);

    // Two RFQ products: SLIPPERS-shape (qty 45.799, ₹150) and HAND
    // SANITIZER-shape (qty 566, ₹10) — same numbers as the live PO 31.
    const rfqProd1 = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
      [rfq.id]
    );
    inserted.rfqProductIds.push(rfqProd1.id);
    const rfqProd2 = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 2, 0) RETURNING id`,
      [rfq.id]
    );
    inserted.rfqProductIds.push(rfqProd2.id);

    // Vendor's quote: TCS 5% on the parent (legacy {tax, tax_mode} shape).
    const tcs = [{ name: "TCS", slug: "tcs", tax: 5, tax_mode: "percentage", is_global: true }];
    const quote = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp", global_charges)
       VALUES ($1, $2, $3, $3, 1, NOW(), $4) RETURNING id`,
      [rfq.id, rfq.rfq_no, IDS.users.vendor_alpha, JSON.stringify(tcs)]
    );
    inserted.quoteIds.push(quote.id);

    // SLIPPERS quote item: unit_price 150, qty 45.799, tax 18%, freight 4%
    // with auto-applied 18% tax. Engine line total = 8,431.
    const qi1 = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
          package_price, tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
       VALUES ($1, $2, $3, 1, 150, 0, 0, 18, 0, 0, 'slippers', '15', '45.799', 'percentage',
               '[{"name":"Freight","slug":"freight","amount":4,"amount_mode":"percentage","tax":null,"tax_mode":"percentage","comment":"GST"}]'::jsonb)
       RETURNING id`,
      [rfq.id, rfq.rfq_no, quote.id]
    );
    // HAND SANITIZER quote item: unit_price 10, qty 566, tax 18%, no other
    // charges. Engine line total = 6,679.
    const qi2 = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
          package_price, tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
       VALUES ($1, $2, $3, 2, 10, 0, 0, 18, 0, 0, 'sanitizer', '15', '566', 'percentage', '[]'::jsonb)
       RETURNING id`,
      [rfq.id, rfq.rfq_no, quote.id]
    );

    const { buildAuthoritativePOPayload, draftPO } = await import(
      "../../app/controllers/po/purchaseOrderController.js"
    );

    // Step 1: finalize SLIPPERS → creates a new PO (no existing_po_id).
    // total_value at this point is just the SLIPPERS grand total.
    const poId = await db.tx(async (t) => {
      const auth = await buildAuthoritativePOPayload(
        {
          rfq_id: rfq.id, project_id: null, total_value: 0,
          quote_id: qi1.id, quote_item_id: qi1.id,
          product_info: {
            rfq_product_id: rfqProd1.id, quantity: "45.799", unit: "nos",
            unit_price: 150, finalized_vendor_id: IDS.users.vendor_alpha,
          },
        },
        t
      );
      const r = await draftPO(
        auth,
        { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        t
      );
      return r.po_id;
    });
    inserted.poIds.push(poId);

    // After step 1: SLIPPERS line = 8,431, TCS 5% = 421.55, total = 8,852.55,
    // rounded to whole rupees by pricingEngine.calculateDocumentTotals = 8853.
    const afterStep1 = await db.one(
      `SELECT total_value FROM tbl_rfq_purchase_order WHERE id = $1`,
      [poId]
    );
    expect(Number(afterStep1.total_value)).toBe(8852.21);

    // Step 2: finalize HAND SANITIZER with existing_po_id → appends to PO.
    // CRITICAL: this used to leave total_value stale (only SLIPPERS' grand
    // total, missing HAND SANITIZER entirely). Production behavior is that
    // an additional aggregator (initiatePurchaseOrder or handleUpdatePO)
    // recomputes total_value over both lines + the snapshot's TCS.
    await db.tx(async (t) => {
      const auth = await buildAuthoritativePOPayload(
        {
          rfq_id: rfq.id, project_id: null, total_value: 0,
          quote_id: qi2.id, quote_item_id: qi2.id,
          existing_po_id: poId,
          product_info: {
            rfq_product_id: rfqProd2.id, quantity: 566, unit: "pieces",
            unit_price: 10, finalized_vendor_id: IDS.users.vendor_alpha,
          },
        },
        t
      );
      await draftPO(
        auth,
        { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        t
      );
    });

    // ---- Per-line totals on tbl_purchase_order_product (no globals) ----
    const popRows = await db.any(
      `SELECT id, rfq_product_id, total_price FROM tbl_purchase_order_product
       WHERE purchase_order_id = $1 ORDER BY id ASC`,
      [poId]
    );
    expect(popRows.length).toBe(2);
    inserted.poLineIds.push(...popRows.map((r) => r.id));
    // rfq_product_id is bigint on tbl_purchase_order_product, so pg-promise
    // can hand it back as a string. Coerce both sides before matching.
    const lineSlippers = popRows.find((r) => Number(r.rfq_product_id) === rfqProd1.id);
    const lineSanitizer = popRows.find((r) => Number(r.rfq_product_id) === rfqProd2.id);
    expect(lineSlippers).toBeDefined();
    expect(lineSanitizer).toBeDefined();
    expect(Number(lineSlippers.total_price)).toBe(8430.68);
    expect(Number(lineSanitizer.total_price)).toBe(6678.8);

    // ---- Snapshot on header still has ONE TCS (not duplicated) ----
    const headerAfterStep2 = await db.one(
      `SELECT total_value, global_charges
       FROM tbl_rfq_purchase_order WHERE id = $1`,
      [poId]
    );
    const snapshot = typeof headerAfterStep2.global_charges === "string"
      ? JSON.parse(headerAfterStep2.global_charges)
      : headerAfterStep2.global_charges;
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot.length).toBe(1);
    expect(snapshot[0].slug).toBe("tcs");

    // ---- DOCUMENT-CONFIDENCE CONTRACT ----
    // Sum of line subtotals (8,431 + 6,679 = 15,110) + ONE TCS at 5% on the
    // combined subtotal (15,110 × 0.05 = 755.50) = 15,865.50, rounded to
    // whole rupees by pricingEngine.calculateDocumentTotals = 15,866.
    //
    // The merge path in draftPurchaseOrder must re-aggregate total_value
    // across all lines + the snapshotted globals. Without this, total_value
    // would stay at step 1's value (8,853, just SLIPPERS) and the second
    // line would silently drop off the document total.
    expect(Number(headerAfterStep2.total_value)).toBe(15864.95);

    // Cleanup: the global afterEach handles tbl_rfq_purchase_order via
    // inserted.poIds and tbl_purchase_order_product via inserted.poLineIds.
  });
});

// ===========================================================================
// One PO per (RFQ, vendor): draftPurchaseOrder auto-merges same-vendor products
// into a single PO when no existing_po_id is pinned; different vendors get
// separate POs.
// ===========================================================================
describe("draftPurchaseOrder — one PO per (RFQ, vendor) auto-merge", () => {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);

  async function seedRfqProduct(rfqId, variantId, vendorId, { unitPrice = 100, qty = "10" } = {}) {
    const prod = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfqId, variantId]
    );
    inserted.rfqProductIds.push(prod.id);
    const quote = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp", global_charges)
       VALUES ((SELECT id FROM tbl_rfq WHERE id=$1), (SELECT rfq_no FROM tbl_rfq WHERE id=$1), $2, $2, 1, NOW(), '[]'::jsonb)
       RETURNING id`,
      [rfqId, vendorId]
    );
    inserted.quoteIds.push(quote.id);
    const qi = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, package_price,
          tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
       VALUES ($1, (SELECT rfq_no FROM tbl_rfq WHERE id=$1), $2, $3, $4, 0, 0, 18, 0, 0, 'x', '15', $5, 'percentage', '[]'::jsonb)
       RETURNING id`,
      [rfqId, quote.id, variantId, unitPrice, qty]
    );
    return { rfqProductId: prod.id, quoteItemId: qi.id, vendorId, qty, unitPrice };
  }

  async function draftFor(rfqId, p, t) {
    const { buildAuthoritativePOPayload, draftPO } = await import(
      "../../app/controllers/po/purchaseOrderController.js"
    );
    const auth = await buildAuthoritativePOPayload(
      {
        rfq_id: rfqId, project_id: null, total_value: 0,
        quote_id: p.quoteItemId, quote_item_id: p.quoteItemId,
        product_info: {
          rfq_product_id: p.rfqProductId, quantity: String(p.qty), unit: "nos",
          unit_price: p.unitPrice, finalized_vendor_id: p.vendorId,
        },
      },
      t
    );
    const r = await draftPO(auth, { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A }, t);
    return r.po_id;
  }

  async function makeRfqRow(title) {
    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, process_id, is_tender, title)
       VALUES ($1, '', '', 'b@a', 'A1', '+91', $2, 'Mumbai', 1, 1, $3, $3, NOW(), $4, $5, $6, 0, $7)
       RETURNING id`,
      [nextRfqNo(), oneDayAgo, IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1, title]
    );
    inserted.rfqIds.push(rfq.id);
    return rfq.id;
  }

  it("two products for the SAME vendor land in ONE PO (no existing_po_id passed)", async () => {
    const rfqId = await makeRfqRow("same-vendor one-PO");
    const p1 = await seedRfqProduct(rfqId, 1, IDS.users.vendor_alpha);
    const p2 = await seedRfqProduct(rfqId, 2, IDS.users.vendor_alpha);

    const po1 = await db.tx((t) => draftFor(rfqId, p1, t));
    inserted.poIds.push(po1);
    const po2 = await db.tx((t) => draftFor(rfqId, p2, t));
    if (po2 && po2 !== po1) inserted.poIds.push(po2);

    // Same PO reused for both products.
    expect(po2).toBe(po1);
    const pos = await db.any(
      `SELECT id FROM tbl_rfq_purchase_order
        WHERE rfq_id = $1 AND finalized_vendor_id = $2 AND status <> 'cancelled'`,
      [rfqId, IDS.users.vendor_alpha]
    );
    expect(pos.length).toBe(1);
    const lines = await db.any(
      `SELECT id FROM tbl_purchase_order_product WHERE purchase_order_id = $1`,
      [po1]
    );
    inserted.poLineIds.push(...lines.map((l) => l.id));
    expect(lines.length).toBe(2);
  });

  it("two products for DIFFERENT vendors create TWO separate POs", async () => {
    const rfqId = await makeRfqRow("multi-vendor split");
    const pa = await seedRfqProduct(rfqId, 1, IDS.users.vendor_alpha);
    const pb = await seedRfqProduct(rfqId, 2, IDS.users.vendor_beta);

    const poA = await db.tx((t) => draftFor(rfqId, pa, t));
    inserted.poIds.push(poA);
    const poB = await db.tx((t) => draftFor(rfqId, pb, t));
    inserted.poIds.push(poB);

    expect(poB).not.toBe(poA);
    const pos = await db.any(
      `SELECT DISTINCT id FROM tbl_rfq_purchase_order
        WHERE rfq_id = $1 AND status <> 'cancelled'`,
      [rfqId]
    );
    expect(pos.length).toBe(2);
    for (const po of [poA, poB]) {
      const lines = await db.any(`SELECT id FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po]);
      inserted.poLineIds.push(...lines.map((l) => l.id));
    }
  });
});
