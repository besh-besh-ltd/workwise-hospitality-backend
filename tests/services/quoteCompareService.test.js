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

  // A vendor's `global_charges` is stored once on tbl_quotes and the model
  // query duplicates the same array onto each product's quotation row. The
  // enricher must NOT apply absolute amounts in full per product — that would
  // inflate the vendor's leaderboard total by N × charge. Absolute charges
  // are split proportionally by each product's line subtotal; percentage
  // charges already distribute naturally and are unaffected.
  it("splits absolute global_charges proportionally across a vendor's products (does not duplicate per product)", () => {
    // Per-product engine totals for vendor v1:
    //   product 1: 100 × 20 = 2000
    //   product 2: 100 × 30 = 3000
    //   product 3: 100 × 50 = 5000
    //   doc subtotal = 10,000
    const globals = [
      { name: "Document Fee", slug: "doc_fee", amount: 1000, amount_mode: "absolute" },
      { name: "TCS", slug: "tcs", amount: 5, amount_mode: "percentage" },
    ];
    const mk = (id, qty) => productFixture({
      id,
      product_specs: [{ title: "Quantity", value: qty }, { title: "Unit", value: "pcs" }],
      all_vendors: [{ id: "v1", organization_name: "Vendor One", payment_terms: [] }],
      quotations: [
        quoteFixture({
          id,
          created_by: "v1",
          global_charges: globals,
          quote_details: [{ unit_price: 100, quantity: qty, tax: 0, tax_mode: "percentage" }],
        }),
      ],
    });
    const out = enrichQuoteCompareData([mk(1, 20), mk(2, 30), mk(3, 50)]);

    const q1 = out.products[0].quotations[0];
    const q2_ = out.products[1].quotations[0];
    const q3 = out.products[2].quotations[0];

    // Per-product engine_total (line only, no globals) is unchanged.
    expect(q1.engine_total).toBe(2000);
    expect(q2_.engine_total).toBe(3000);
    expect(q3.engine_total).toBe(5000);

    // Absolute share by line ratio (2000/10000, 3000/10000, 5000/10000) of 1000.
    // Percentage share is 5% of each product's line total — naturally proportional.
    // Per product: absolute_share + pct_share.
    //   product 1: 200 +  100 =  300
    //   product 2: 300 +  150 =  450
    //   product 3: 500 +  250 =  750
    //   total globals across the vendor's doc = 1500 (1000 absolute + 500 from TCS 5% of 10k)
    expect(q1.engine_global_charges_total).toBeCloseTo(300, 2);
    expect(q2_.engine_global_charges_total).toBeCloseTo(450, 2);
    expect(q3.engine_global_charges_total).toBeCloseTo(750, 2);

    // Per-charge breakdown — absolute is split, percentage is naturally proportional.
    const docFeeOf = (q) => q.engine_global_charges.find((c) => c.slug === "doc_fee").amount;
    const tcsOf = (q) => q.engine_global_charges.find((c) => c.slug === "tcs").amount;
    expect(docFeeOf(q1)).toBeCloseTo(200, 2);
    expect(docFeeOf(q2_)).toBeCloseTo(300, 2);
    expect(docFeeOf(q3)).toBeCloseTo(500, 2);
    expect(docFeeOf(q1) + docFeeOf(q2_) + docFeeOf(q3)).toBeCloseTo(1000, 2);
    expect(tcsOf(q1)).toBeCloseTo(100, 2);
    expect(tcsOf(q2_)).toBeCloseTo(150, 2);
    expect(tcsOf(q3)).toBeCloseTo(250, 2);

    // Per-product engine_grand_total = line + its share of globals.
    expect(q1.engine_grand_total).toBeCloseTo(2300, 2);
    expect(q2_.engine_grand_total).toBeCloseTo(3450, 2);
    expect(q3.engine_grand_total).toBeCloseTo(5750, 2);

    // The vendor's leaderboard total = lines (10,000) + globals once (1500),
    // NOT lines + 3×1000 (= 13,000) which is what the duplication bug produced.
    const v1 = out.vendor_totals.find((v) => String(v.vendor_id) === "v1");
    expect(v1.total).toBeCloseTo(11500, 2);
  });

  it("falls back to zero share when the vendor's document subtotal is zero", () => {
    // A vendor with no priced quotes (everything zero) has no basis to
    // allocate against — absolute globals contribute 0 per product, which
    // also keeps the vendor's grand total at 0 instead of N × charge.
    const products = [
      productFixture({
        id: 1,
        all_vendors: [{ id: "v1", organization_name: "Vendor One", payment_terms: [] }],
        quotations: [
          quoteFixture({
            created_by: "v1",
            global_charges: [{ name: "Document Fee", amount: 500, amount_mode: "absolute" }],
            quote_details: [{ unit_price: 0, quantity: 10, tax: 0, tax_mode: "percentage" }],
          }),
        ],
      }),
    ];
    const out = enrichQuoteCompareData(products);
    const q = out.products[0].quotations[0];
    expect(q.engine_total).toBe(0);
    expect(q.engine_global_charges_total).toBe(0);
    expect(q.engine_grand_total).toBe(0);
  });

  it("uses per-vendor doc subtotals (vendor A's absolute charge does not bleed into vendor B's products)", () => {
    // Two vendors, two products. Vendor A has an absolute global charge,
    // vendor B does not. The split denominator for A must be A's own doc
    // subtotal, not the combined RFQ subtotal.
    const mk = (id, qty) => productFixture({
      id,
      product_specs: [{ title: "Quantity", value: qty }, { title: "Unit", value: "pcs" }],
      all_vendors: [
        { id: "vA", organization_name: "Vendor A", payment_terms: [] },
        { id: "vB", organization_name: "Vendor B", payment_terms: [] },
      ],
      quotations: [
        quoteFixture({
          id: `A${id}`,
          created_by: "vA",
          global_charges: [{ name: "Document Fee", slug: "doc_fee", amount: 600, amount_mode: "absolute" }],
          quote_details: [{ unit_price: 100, quantity: qty, tax: 0, tax_mode: "percentage" }],
        }),
        quoteFixture({
          id: `B${id}`,
          created_by: "vB",
          global_charges: [],
          quote_details: [{ unit_price: 80, quantity: qty, tax: 0, tax_mode: "percentage" }],
        }),
      ],
    });
    const out = enrichQuoteCompareData([mk(1, 10), mk(2, 20)]);

    // Vendor A's doc subtotal = 1000 + 2000 = 3000.
    // Shares of 600: product 1 → 200, product 2 → 400.
    const aQuotes = out.products.map((p) => p.quotations.find((q) => q.created_by === "vA"));
    expect(aQuotes[0].engine_global_charges_total).toBeCloseTo(200, 2);
    expect(aQuotes[1].engine_global_charges_total).toBeCloseTo(400, 2);
    expect(aQuotes[0].engine_grand_total).toBeCloseTo(1200, 2);
    expect(aQuotes[1].engine_grand_total).toBeCloseTo(2400, 2);

    // Vendor B has no globals, so per-product grand total = line total.
    const bQuotes = out.products.map((p) => p.quotations.find((q) => q.created_by === "vB"));
    expect(bQuotes[0].engine_grand_total).toBe(800);
    expect(bQuotes[1].engine_grand_total).toBe(1600);

    const vA = out.vendor_totals.find((v) => v.vendor_id === "vA");
    const vB = out.vendor_totals.find((v) => v.vendor_id === "vB");
    expect(vA.total).toBeCloseTo(3600, 2); // 3000 lines + 600 globals once
    expect(vB.total).toBe(2400);           // 800 + 1600
  });
});
