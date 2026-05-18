// Pure-function smoke tests for the quote-compare enricher. The function
// transforms the raw quotes-by-rfq payload (an array of products with
// quotations + quote_details) into the engine-enriched view model the
// frontend renders. No DB.

import { describe, it, expect } from "@jest/globals";
import { enrichQuoteCompareData } from "../../app/services/quoteCompareService.js";

const productFixture = (overrides = {}) => ({
  id: 1,
  product_id: 100,
  variant: "default",
  product_details: [{ name: "Widget", category_name: "Tools" }],
  product_specs: [{ title: "Quantity", value: 10 }, { title: "Unit", value: "pcs" }],
  all_vendors: [
    { id: "v1", organization_name: "Vendor One", payment_terms: [] },
    { id: "v2", organization_name: "Vendor Two", payment_terms: [] },
  ],
  ...overrides,
});

const quoteFixture = (overrides = {}) => ({
  id: 1,
  created_by: "v1",
  timestamp: "2026-01-01T10:00:00Z",
  is_regret: 0,
  global_payment_term: null,
  global_charges: [],
  vendor_details: [{ id: "v1", organization_name: "Vendor One" }],
  ...overrides,
});

describe("enrichQuoteCompareData", () => {
  it("returns empty shape when no products", () => {
    const out = enrichQuoteCompareData([]);
    expect(out.products).toEqual([]);
    expect(out.metrics.l1_total).toBe(0);
    expect(out.metrics.products_count).toBe(0);
  });

  it("attaches engine output to each quote_details row", () => {
    const products = [
      productFixture({
        quotations: [
          quoteFixture({
            quote_details: [
              {
                unit_price: 100,
                quantity: 10,
                tax: 18,
                tax_mode: "percentage",
                other_charges: [
                  { name: "Freight", amount: 5, amount_mode: "percentage", tax: 18, tax_mode: "percentage" },
                ],
              },
            ],
          }),
        ],
      }),
    ];

    const out = enrichQuoteCompareData(products);
    const detail = out.products[0].quotations[0].quote_details[0];
    // base 1000, base_tax 180, freight 50 + 9 = 59 → 1239
    expect(detail.engine.total).toBe(1239);
    expect(detail.engine.base).toBe(1000);
    expect(detail.engine.charges).toHaveLength(1);
    expect(detail.engine.charges[0].name).toBe("Freight");
    expect(detail.engine.charges[0].subtotal).toBe(59);
    expect(out.products[0].quotations[0].engine_total).toBe(1239);
  });

  it("computes engine output when pricing fields live on the parent quote and quote_details is a metadata-only object", () => {
    // Regression: getQuotesByRfqById2 returns a shape where the line-item
    // pricing fields (unit_price, tax, other_charges, quantity) sit on the
    // top-level quotation and `quote_details` is a single object holding
    // only status/created_by/timestamp/vendor_details. The enricher must
    // merge both before reading pricing — same precedence the legacy
    // frontend's getQuoteDetails uses.
    const products = [
      productFixture({
        product_specs: [{ title: "Quantity", value: 50 }, { title: "Unit", value: "pcs" }],
        quotations: [
          {
            quote_id: 72,
            quote_item_id: 108,
            unit_price: 500,
            tax: 30,
            tax_mode: "percentage",
            quantity: "50",
            other_charges: [
              { name: "Freight", amount: 10, amount_mode: "percentage", tax: 9, tax_mode: "percentage" },
              { name: "Insurance", amount: 50, amount_mode: "percentage", tax: 12, tax_mode: "percentage" },
            ],
            total_price: 49225, // client-supplied; the enricher should ignore and recompute
            comment: "",
            delivery_period: "",
            quote_details: {
              // Note: NO pricing fields here. Only metadata.
              status: 1,
              created_by: "v1",
              is_regret: 0,
              timestamp: "2026-04-24T12:43:17Z",
              vendor_details: { id: "v1", organization_name: "Vendor One", prev_worked: 1 },
            },
          },
        ],
      }),
    ];

    const out = enrichQuoteCompareData(products);
    const enrichedDetail = out.products[0].quotations[0].quote_details;
    // base = 500 * 50 = 25000
    // base_tax = 30% of 25000 = 7500
    // Freight: amount = 10% of 25000 = 2500; tax = 9% of 2500 = 225 → 2725
    // Insurance: amount = 50% of 25000 = 12500; tax = 12% of 12500 = 1500 → 14000
    // total = 25000 + 7500 + 2725 + 14000 = 49225
    expect(enrichedDetail.engine.base).toBe(25000);
    expect(enrichedDetail.engine.base_tax).toBe(7500);
    expect(enrichedDetail.engine.charges).toHaveLength(2);
    expect(enrichedDetail.engine.total).toBe(49225);
    expect(out.products[0].quotations[0].engine_total).toBe(49225);
    // Comparison band should populate now that there's a non-zero total.
    expect(Object.keys(out.products[0].comparison.bands.total.bands)).toContain("v1");
    expect(out.products[0].comparison.lowest_vendor_id).toBe("v1");
  });

  it("synthesises other_charges from legacy flat freight/packaging fields", () => {
    const products = [
      productFixture({
        quotations: [
          quoteFixture({
            quote_details: [
              {
                unit_price: 100,
                quantity: 10,
                tax: 18,
                tax_mode: "percentage",
                freight_price: 5,
                freight_mode: "percentage",
                package_price: 200,
                package_mode: "absolute",
                other_charges: [],
              },
            ],
          }),
        ],
      }),
    ];

    const out = enrichQuoteCompareData(products);
    const charges = out.products[0].quotations[0].quote_details[0].engine.charges;
    expect(charges).toHaveLength(2);
    expect(charges.map((c) => c.name)).toEqual(["Freight", "Packaging"]);
  });

  it("computes comparison bands across vendors", () => {
    const products = [
      productFixture({
        quotations: [
          quoteFixture({
            id: 1,
            created_by: "v1",
            quote_details: [{ unit_price: 100, quantity: 10, tax: 0, tax_mode: "percentage" }],
          }),
          quoteFixture({
            id: 2,
            created_by: "v2",
            timestamp: "2026-01-02T10:00:00Z",
            quote_details: [{ unit_price: 200, quantity: 10, tax: 0, tax_mode: "percentage" }],
          }),
        ],
      }),
    ];

    const out = enrichQuoteCompareData(products);
    const bands = out.products[0].comparison.bands.total.bands;
    expect(bands.v1).toBe("best");
    expect(bands.v2).toBe("high");
  });

  it("breaks lowest-quote ties by prev_worked then earliest timestamp", () => {
    const products = [
      productFixture({
        all_vendors: [
          { id: "a", payment_terms: [], prev_worked: 0 },
          { id: "b", payment_terms: [], prev_worked: 1 },
          { id: "c", payment_terms: [], prev_worked: 0 },
        ],
        quotations: [
          quoteFixture({ id: 1, created_by: "a", timestamp: "2026-01-01T10:00:00Z",
            quote_details: [{ unit_price: 100, quantity: 10, tax: 0, tax_mode: "percentage" }] }),
          quoteFixture({ id: 2, created_by: "b", timestamp: "2026-01-02T10:00:00Z",
            quote_details: [{ unit_price: 100, quantity: 10, tax: 0, tax_mode: "percentage" }] }),
          quoteFixture({ id: 3, created_by: "c", timestamp: "2026-01-01T08:00:00Z",
            quote_details: [{ unit_price: 100, quantity: 10, tax: 0, tax_mode: "percentage" }] }),
        ],
      }),
    ];

    const out = enrichQuoteCompareData(products);
    // All three quote 1000. 'b' has prev_worked=1 → wins tiebreak.
    expect(out.products[0].comparison.lowest_vendor_id).toBe("b");
  });

  it("excludes regret quotes from L1 + comparison stats", () => {
    const products = [
      productFixture({
        quotations: [
          quoteFixture({ created_by: "v1", is_regret: 1,
            quote_details: [{ unit_price: 50, quantity: 10, tax: 0, tax_mode: "percentage" }] }),
          quoteFixture({ created_by: "v2",
            quote_details: [{ unit_price: 100, quantity: 10, tax: 0, tax_mode: "percentage" }] }),
        ],
      }),
    ];

    const out = enrichQuoteCompareData(products);
    expect(out.products[0].comparison.lowest_vendor_id).toBe("v2");
    expect(out.products[0].aggregates.l1_total).toBe(1000);
    expect(out.products[0].aggregates.regret_count).toBe(1);
  });

  it("rolls up RFQ-level metrics: l1_total, baseline, savings, vendor counts", () => {
    const products = [
      productFixture({
        last_purchase_rate: { unit_price: 200, quantity: 10, tax: 0, tax_mode: "percentage" },
        quotations: [
          quoteFixture({ created_by: "v1",
            quote_details: [{ unit_price: 100, quantity: 10, tax: 0, tax_mode: "percentage" }] }),
        ],
      }),
    ];

    const out = enrichQuoteCompareData(products);
    expect(out.metrics.l1_total).toBe(1000);
    expect(out.metrics.baseline_total).toBe(2000);
    expect(out.metrics.savings).toBe(1000);
    expect(out.metrics.vendors_count).toBeGreaterThanOrEqual(1);
  });

  it("flags freight-advantage vendors based on Freight charge subtotal", () => {
    const products = [
      productFixture({
        quotations: [
          quoteFixture({ created_by: "v1",
            quote_details: [{
              unit_price: 100, quantity: 10, tax: 0, tax_mode: "percentage",
              other_charges: [{ name: "Freight", amount: 5, amount_mode: "percentage", tax: 0 }],
            }] }),
          quoteFixture({ created_by: "v2",
            quote_details: [{
              unit_price: 100, quantity: 10, tax: 0, tax_mode: "percentage",
              other_charges: [{ name: "Freight", amount: 10, amount_mode: "percentage", tax: 0 }],
            }] }),
        ],
      }),
    ];

    const out = enrichQuoteCompareData(products);
    expect(out.products[0].comparison.freight_advantage_vendor_ids).toEqual(["v1"]);
  });

  it("aggregates per-vendor totals across multiple products", () => {
    const productOne = productFixture({
      id: 1,
      quotations: [
        quoteFixture({ created_by: "v1",
          quote_details: [{ unit_price: 100, quantity: 10, tax: 0, tax_mode: "percentage" }] }),
      ],
    });
    const productTwo = productFixture({
      id: 2,
      product_specs: [{ title: "Quantity", value: 5 }],
      quotations: [
        quoteFixture({ created_by: "v1",
          quote_details: [{ unit_price: 200, quantity: 5, tax: 0, tax_mode: "percentage" }] }),
      ],
    });
    const out = enrichQuoteCompareData([productOne, productTwo]);
    const v1 = out.vendor_totals.find((v) => String(v.vendor_id) === "v1");
    expect(v1.total).toBe(2000); // 1000 + 1000
  });
});
