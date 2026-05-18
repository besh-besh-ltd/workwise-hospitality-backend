// Pure-function unit tests for the pricing engine — the single source of
// truth for quote/PO money math.
//
// No DB, no fixtures, no controllers. Each `it(...)` exercises the engine
// directly, so a regression that changes a formula will fail here loudly.

import { describe, it, expect } from "@jest/globals";
import {
  applyChargeMode,
  calculateLineTotal,
  calculateDocumentTotals,
  applyPaymentTermNormalization,
  fillMissingChargesFromPeers,
  computeComparisonBands,
  pickLowestQuote,
  computeFreightAdvantage,
  normalizeChargesMeta,
} from "../../app/services/pricingEngine.js";

describe("pricingEngine.applyChargeMode", () => {
  it("returns percentage of base when mode is 'percentage'", () => {
    expect(applyChargeMode(10, "percentage", 1000)).toBe(100);
    expect(applyChargeMode(2.5, "percentage", 200)).toBe(5);
  });

  it("returns the raw value when mode is 'absolute'", () => {
    expect(applyChargeMode(50, "absolute", 1000)).toBe(50);
    expect(applyChargeMode(0, "absolute", 1000)).toBe(0);
  });

  it("defaults to 'percentage' when mode is undefined or null", () => {
    expect(applyChargeMode(10, undefined, 1000)).toBe(100);
    expect(applyChargeMode(10, null, 1000)).toBe(100);
  });

  it("coerces string numerics", () => {
    expect(applyChargeMode("18", "percentage", 100)).toBe(18);
    expect(applyChargeMode("18.5", "percentage", 100)).toBe(18.5);
  });

  it("treats invalid/blank values as 0", () => {
    expect(applyChargeMode("", "percentage", 1000)).toBe(0);
    expect(applyChargeMode(undefined, "percentage", 1000)).toBe(0);
    expect(applyChargeMode("not-a-number", "absolute", 1000)).toBe(0);
  });
});

describe("pricingEngine.calculateLineTotal", () => {
  it("returns zero shape when base is zero or negative", () => {
    expect(calculateLineTotal({ unit_price: 0, quantity: 10 })).toEqual({
      base: 0,
      base_tax: 0,
      charges: [],
      charges_total: 0,
      total: 0,
    });
    expect(calculateLineTotal({ unit_price: 100, quantity: 0 })).toEqual({
      base: 0,
      base_tax: 0,
      charges: [],
      charges_total: 0,
      total: 0,
    });
  });

  it("applies percentage tax to base and rounds the total", () => {
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: 18,
      tax_mode: "percentage",
    });
    // base = 1000, tax = 180, total = 1180
    expect(out.base).toBe(1000);
    expect(out.base_tax).toBe(180);
    expect(out.total).toBe(1180);
    expect(out.charges).toEqual([]);
    expect(out.charges_total).toBe(0);
  });

  it("applies absolute tax as a flat amount", () => {
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: 50,
      tax_mode: "absolute",
    });
    // base = 1000, tax = 50, total = 1050
    expect(out.base_tax).toBe(50);
    expect(out.total).toBe(1050);
  });

  it("treats null/missing tax as zero", () => {
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: null,
      tax_mode: "percentage",
    });
    expect(out.base_tax).toBe(0);
    expect(out.total).toBe(1000);
  });

  it("handles a single percentage charge with its own percentage tax", () => {
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: 18,
      tax_mode: "percentage",
      other_charges: [
        {
          name: "Freight",
          amount: 5,
          amount_mode: "percentage", // 5% of base = 50
          tax: 18,
          tax_mode: "percentage", // 18% of 50 = 9
        },
      ],
    });
    // base = 1000, base_tax = 180, freight = 50, freight_tax = 9
    // total = 1000 + 180 + 50 + 9 = 1239
    expect(out.base).toBe(1000);
    expect(out.base_tax).toBe(180);
    expect(out.charges).toHaveLength(1);
    expect(out.charges[0]).toEqual({
      name: "Freight",
      amount: 50,
      tax: 9,
      subtotal: 59,
    });
    expect(out.charges_total).toBe(59);
    expect(out.total).toBe(1239);
  });

  it("handles an absolute charge with absolute tax", () => {
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: 0,
      tax_mode: "percentage",
      other_charges: [
        {
          name: "Setup",
          amount: 200,
          amount_mode: "absolute",
          tax: 36,
          tax_mode: "absolute",
        },
      ],
    });
    // base 1000, base_tax 0, setup 200, setup_tax 36 → 1236
    expect(out.charges[0]).toEqual({
      name: "Setup",
      amount: 200,
      tax: 36,
      subtotal: 236,
    });
    expect(out.total).toBe(1236);
  });

  it("inherits the base tax rate when a charge has no explicit tax (tax: null)", () => {
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: 18,
      tax_mode: "percentage",
      other_charges: [
        {
          name: "Freight",
          amount: 100,
          amount_mode: "absolute",
          tax: null, // null → inherit base 18%
          tax_mode: "percentage",
        },
      ],
    });
    // base 1000, base_tax 180, freight 100, inherited tax 18 → 1298
    expect(out.charges[0].tax).toBe(18);
    expect(out.total).toBe(1298);
  });

  it("does NOT inherit base rate when base tax_mode is absolute (tax: null)", () => {
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: 50,
      tax_mode: "absolute", // absolute base tax → no inheritance for charges
      other_charges: [
        {
          name: "Freight",
          amount: 100,
          amount_mode: "absolute",
          tax: null,
          tax_mode: "percentage",
        },
      ],
    });
    // base 1000, base_tax 50, freight 100, no inherited tax → 1150
    expect(out.charges[0].tax).toBe(0);
    expect(out.total).toBe(1150);
  });

  it("treats tax: '' as 'inherit' (parity with null)", () => {
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: 18,
      tax_mode: "percentage",
      other_charges: [
        {
          name: "Freight",
          amount: 100,
          amount_mode: "absolute",
          tax: "", // blank → inherit base 18%
          tax_mode: "percentage",
        },
      ],
    });
    expect(out.charges[0].tax).toBe(18);
  });

  it("treats tax: undefined as 'inherit' (parity with null)", () => {
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: 18,
      tax_mode: "percentage",
      other_charges: [
        // tax field omitted entirely → still inherit
        { name: "Freight", amount: 100, amount_mode: "absolute", tax_mode: "percentage" },
      ],
    });
    expect(out.charges[0].tax).toBe(18);
  });

  it("treats tax: 0 as 'explicit no tax' — does NOT inherit base rate", () => {
    // The whole point of tri-state. A vendor who types 0 in the tax field is
    // saying "this charge has no tax", which must override base inheritance.
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: 18,
      tax_mode: "percentage",
      other_charges: [
        // explicit zero → no tax even though base is 18%
        { name: "Freight", amount: 100, amount_mode: "absolute", tax: 0, tax_mode: "percentage" },
      ],
    });
    // base 1000, base_tax 180, freight 100, NO inherited tax → 1280
    expect(out.charges[0].tax).toBe(0);
    expect(out.total).toBe(1280);
  });

  it("handles multiple other_charges mixing explicit, inherit, and explicit-zero", () => {
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: 12,
      tax_mode: "percentage",
      other_charges: [
        // explicit own tax → wins
        { name: "Freight", amount: 5, amount_mode: "percentage", tax: 12, tax_mode: "percentage" },
        // tax: null → inherits base 12%
        { name: "Packaging", amount: 200, amount_mode: "absolute", tax: null, tax_mode: "percentage" },
        // tax: 0 → explicit no tax
        { name: "Insurance", amount: 1, amount_mode: "percentage", tax: 0, tax_mode: "absolute" },
      ],
    });
    // base = 1000, base_tax = 120
    // freight:    amount 50,  own tax 6        → 56
    // packaging:  amount 200, inherited 12% 24 → 224
    // insurance:  amount 10,  no tax (explicit 0) → 10
    // charges_total = 56 + 224 + 10 = 290
    // total = 1000 + 120 + 290 = 1410
    expect(out.charges_total).toBe(290);
    expect(out.total).toBe(1410);
  });

  it("quantises output fields to 2dp (intermediates stay raw)", () => {
    const out = calculateLineTotal({
      unit_price: 1.1,
      quantity: 3,
      tax: 5,
      tax_mode: "percentage",
    });
    // base = 3.3, base_tax = 0.165, total = 3.465 → q2 → 3.47
    expect(out.base).toBe(3.3);
    expect(out.base_tax).toBe(0.17);
    expect(out.total).toBe(3.47);
  });

  it("quantises vendor-supplied 2dp prices to clean 2dp output", () => {
    // Vendor types 100.55, qty 1, GST 18% → base 100.55, tax 18.099 → 18.10,
    // total 118.649 → q2 118.65. No 14-digit float drift in response.
    const out = calculateLineTotal({
      unit_price: 100.55,
      quantity: 1,
      tax: 18,
      tax_mode: "percentage",
    });
    expect(out.base).toBe(100.55);
    expect(out.base_tax).toBe(18.10);
    expect(out.total).toBe(118.65);
  });

  it("quantises charge breakdowns to 2dp (the freight 0.8% drift case)", () => {
    // Replicates RFQ 234 vendor 419: 500.47 × 56, freight 5.2% with 0.8% tax.
    // Without q2: charge.tax = 11.658949119999999. With q2: 11.66.
    const out = calculateLineTotal({
      unit_price: 500.47,
      quantity: 56,
      tax: 18,
      tax_mode: "percentage",
      other_charges: [
        { name: "Freight", amount: 5.2, amount_mode: "percentage", tax: 0.8, tax_mode: "percentage", slug: "freight" },
      ],
    });
    expect(out.base).toBe(28026.32);
    expect(out.base_tax).toBe(5044.74);
    expect(out.charges[0].amount).toBe(1457.37);
    expect(out.charges[0].tax).toBe(11.66);
    expect(out.charges[0].subtotal).toBe(1469.03);
    expect(out.charges_total).toBe(1469.03);
    expect(out.total).toBe(34540.09);
  });

  it("quantises multi-line + global charge totals to 2dp", () => {
    const out = calculateDocumentTotals(
      [
        { unit_price: 100.55, quantity: 3, tax: 18, tax_mode: "percentage" },
        { unit_price: 50.25,  quantity: 2, tax: 12, tax_mode: "percentage" },
      ],
      [{ name: "Insurance", amount: 1, amount_mode: "percentage" }]
    );
    // Line 1: 100.55 × 3 = 301.65, tax 54.297 → total 355.947 → q2 355.95
    // Line 2: 50.25 × 2 = 100.50, tax 12.06 → total 112.56
    // Lines feed q2'd totals into the document sum: 355.95 + 112.56 = 468.51.
    // Insurance 1% of 468.51 = 4.6851 → q2 4.69. Grand total raw = 473.1951
    // → q2 473.20 (banker-style 0.005 rounds up at scale 2).
    expect(out.lines[0].total).toBe(355.95);
    expect(out.lines[1].total).toBe(112.56);
    expect(out.grand_subtotal).toBe(468.51);
    expect(out.global_charges[0].amount).toBe(4.69);
    expect(out.grand_total).toBe(473.20);
  });

  it("defaults missing modes to 'percentage'", () => {
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: 18, // no tax_mode → defaults to 'percentage'
      other_charges: [
        { name: "Freight", amount: 5 }, // no amount_mode → defaults to 'percentage'
      ],
    });
    // base 1000, base_tax 180, freight 50, freight_tax inherited 18% of 50 = 9 → 1239
    expect(out.total).toBe(1239);
  });

  it("returns empty charges array if other_charges is undefined or non-array", () => {
    expect(calculateLineTotal({ unit_price: 10, quantity: 1, tax: 0 }).charges).toEqual([]);
    expect(
      calculateLineTotal({ unit_price: 10, quantity: 1, tax: 0, other_charges: null }).charges
    ).toEqual([]);
  });
});

describe("pricingEngine.calculateDocumentTotals", () => {
  it("aggregates line totals into grand_subtotal and grand_total", () => {
    const out = calculateDocumentTotals([
      { unit_price: 100, quantity: 10, tax: 18, tax_mode: "percentage" }, // 1180
      { unit_price: 200, quantity: 5, tax: 18, tax_mode: "percentage" }, // 1180
    ]);
    expect(out.grand_subtotal).toBe(2360);
    expect(out.grand_total).toBe(2360);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0].total).toBe(1180);
  });

  it("applies percentage global charges on top of subtotal", () => {
    const out = calculateDocumentTotals(
      [{ unit_price: 100, quantity: 10, tax: 0 }],
      [{ name: "Insurance", amount: 2, amount_mode: "percentage" }]
    );
    // subtotal 1000, insurance 20, grand 1020
    expect(out.grand_subtotal).toBe(1000);
    expect(out.global_charges_total).toBe(20);
    expect(out.grand_total).toBe(1020);
  });

  it("applies absolute global charges as flat amount", () => {
    const out = calculateDocumentTotals(
      [{ unit_price: 100, quantity: 10, tax: 0 }],
      [{ name: "Handling", amount: 500, amount_mode: "absolute" }]
    );
    expect(out.global_charges_total).toBe(500);
    expect(out.grand_total).toBe(1500);
  });

  it("handles empty inputs cleanly", () => {
    const out = calculateDocumentTotals([], []);
    expect(out.grand_subtotal).toBe(0);
    expect(out.grand_total).toBe(0);
    expect(out.lines).toEqual([]);
    expect(out.global_charges).toEqual([]);
  });
});

describe("pricingEngine.applyPaymentTermNormalization", () => {
  it("returns the input total when no terms are provided", () => {
    expect(applyPaymentTermNormalization(1000, [])).toBe(1000);
    expect(applyPaymentTermNormalization(1000, null)).toBe(1000);
  });

  it("returns 0 if total is non-positive", () => {
    expect(applyPaymentTermNormalization(0, [])).toBe(0);
    expect(applyPaymentTermNormalization(-100, [])).toBe(0);
  });

  it("applies the advance factor using delivery_days", () => {
    // 100% advance, 30 delivery days → factor = 1 + (30/30)*0.01 = 1.01
    const out = applyPaymentTermNormalization(
      1000,
      [{ type: "advance", value: 100, days: 0 }],
      30
    );
    expect(out).toBeCloseTo(1010, 10);
  });

  it("applies the credit factor using term days", () => {
    // 100% credit @ 60 days → factor = 1 - (60/30)*0.01 = 0.98
    const out = applyPaymentTermNormalization(
      1000,
      [{ type: "credit", value: 100, days: 60 }],
      0
    );
    expect(out).toBeCloseTo(980, 10);
  });

  it("clamps the credit factor at zero (never negative)", () => {
    // Extremely long credit term — factor = 1 - (10000/30)*0.01 ≈ -2.33 → clamped to 0
    const out = applyPaymentTermNormalization(
      1000,
      [{ type: "credit", value: 100, days: 10000 }],
      0
    );
    expect(out).toBe(0);
  });

  it("blends multiple terms by their percentage weights", () => {
    // 10% advance, 20% credit @ 30, 70% credit @ 60, delivery 30 days
    // advance:  10% * 1000 * (1 + (30/30)*0.01) = 100 * 1.01 = 101
    // 30 days:  20% * 1000 * (1 - (30/30)*0.01) = 200 * 0.99 = 198
    // 60 days:  70% * 1000 * (1 - (60/30)*0.01) = 700 * 0.98 = 686
    // total = 985
    const out = applyPaymentTermNormalization(
      1000,
      [
        { type: "advance", value: 10, days: 0 },
        { type: "credit", value: 20, days: 30 },
        { type: "credit", value: 70, days: 60 },
      ],
      30
    );
    expect(out).toBeCloseTo(985, 10);
  });

  it("adds the leftover percentage at factor 1 when terms don't sum to 100", () => {
    // 50% advance @ delivery 30 → 50% * 1000 * 1.01 = 505
    // leftover 50% → 500
    // total = 1005
    const out = applyPaymentTermNormalization(
      1000,
      [{ type: "advance", value: 50, days: 0 }],
      30
    );
    expect(out).toBeCloseTo(1005, 10);
  });

  it("treats unknown types as leftover (factor 1)", () => {
    // 30% 'other' is leftover, 70% advance
    // advance: 70% * 1000 * 1.01 = 707
    // leftover: 30% * 1000 * 1 = 300
    // total = 1007
    const out = applyPaymentTermNormalization(
      1000,
      [
        { type: "other", value: 30 },
        { type: "advance", value: 70, days: 0 },
      ],
      30
    );
    expect(out).toBeCloseTo(1007, 10);
  });
});

describe("pricingEngine.fillMissingChargesFromPeers", () => {
  it("fills zero freight/package with peer averages and zero tax with peer median", () => {
    const data = [
      {
        id: 1,
        all_vendors: [{ id: "v1", payment_terms: [] }, { id: "v2", payment_terms: [] }, { id: "v3", payment_terms: [] }],
        quotations: [
          {
            created_by: "v1",
            quote_details: [
              {
                unit_price: 100,
                quantity: 10,
                freight_price: 5, freight_mode: "percentage",
                package_price: 2, package_mode: "percentage",
                tax: 18, tax_mode: "percentage",
              },
            ],
          },
          {
            created_by: "v2",
            quote_details: [
              {
                unit_price: 100,
                quantity: 10,
                freight_price: 7, freight_mode: "percentage",
                package_price: 4, package_mode: "percentage",
                tax: 12, tax_mode: "percentage",
              },
            ],
          },
          {
            created_by: "v3", // didn't quote freight/package/tax — should get filled
            quote_details: [
              {
                unit_price: 100,
                quantity: 10,
                freight_price: 0, freight_mode: "percentage",
                package_price: 0, package_mode: "percentage",
                tax: 0, tax_mode: "percentage",
              },
            ],
          },
        ],
      },
    ];

    const out = fillMissingChargesFromPeers(data);
    const v3 = out[0].quotations[2].quote_details[0];
    // averageFreight = (5 + 7) / 2 = 6
    // averagePackage = (2 + 4) / 2 = 3
    // medianTax = median([18, 12, 0]) = 12 (after sort: [0, 12, 18])
    expect(v3.freight_price).toBe(6);
    expect(v3.package_price).toBe(3);
    expect(v3.tax).toBe(12);
  });

  it("converts absolute charges to percentage before pooling", () => {
    const data = [
      {
        id: 1,
        all_vendors: [{ id: "v1", payment_terms: [] }, { id: "v2", payment_terms: [] }],
        quotations: [
          {
            created_by: "v1",
            quote_details: [
              {
                unit_price: 100,
                quantity: 10,
                // 50 absolute on base of 1000 → 5%
                freight_price: 50, freight_mode: "absolute",
                package_price: 0, package_mode: "percentage",
                tax: 0, tax_mode: "percentage",
              },
            ],
          },
          {
            created_by: "v2",
            quote_details: [
              {
                unit_price: 100,
                quantity: 10,
                freight_price: 0, freight_mode: "percentage",
                package_price: 0, package_mode: "percentage",
                tax: 0, tax_mode: "percentage",
              },
            ],
          },
        ],
      },
    ];

    const out = fillMissingChargesFromPeers(data);
    expect(out[0].quotations[0].quote_details[0].freight_mode).toBe("percentage");
    expect(out[0].quotations[0].quote_details[0].freight_price).toBe(5);
    // v2 had freight 0 → fills with average of pool [5] = 5
    expect(out[0].quotations[1].quote_details[0].freight_price).toBe(5);
  });

  it("excludes regret quotes from the pool", () => {
    const data = [
      {
        id: 1,
        all_vendors: [{ id: "v1", payment_terms: [] }, { id: "v2", payment_terms: [] }],
        quotations: [
          {
            created_by: "v1",
            is_regret: 1,
            quote_details: [
              { unit_price: 100, quantity: 10, freight_price: 99, freight_mode: "percentage", tax: 99 },
            ],
          },
          {
            created_by: "v2",
            quote_details: [
              { unit_price: 100, quantity: 10, freight_price: 5, freight_mode: "percentage", tax: 18 },
            ],
          },
        ],
      },
    ];

    const out = fillMissingChargesFromPeers(data);
    // The regret quote shouldn't poison the pool — average should be 5, not (99+5)/2.
    // Insert another zero-vendor to verify the fill value.
    expect(out[0].quotations[1].quote_details[0].freight_price).toBe(5);
  });

  it("attaches per-vendor payment_terms onto each quote_detail", () => {
    const data = [
      {
        id: 1,
        all_vendors: [
          { id: "v1", payment_terms: [{ type: "advance", value: 30, days: 0 }] },
        ],
        quotations: [
          {
            created_by: "v1",
            quote_details: [{ unit_price: 100, quantity: 10, tax: 18, tax_mode: "percentage" }],
          },
        ],
      },
    ];
    const out = fillMissingChargesFromPeers(data);
    expect(out[0].quotations[0].quote_details[0].payment_terms).toEqual([
      { type: "advance", value: 30, days: 0 },
    ]);
  });
});

describe("pricingEngine.computeComparisonBands", () => {
  it("returns empty stats when no positive values", () => {
    expect(computeComparisonBands([])).toEqual({
      min: 0,
      max: 0,
      bands: {},
      normalizedScores: {},
    });
    expect(computeComparisonBands([{ key: "a", value: 0 }])).toEqual({
      min: 0,
      max: 0,
      bands: {},
      normalizedScores: {},
    });
  });

  it("buckets values into best/competitive/neutral/high", () => {
    const out = computeComparisonBands([
      { key: "a", value: 100 }, // min
      { key: "b", value: 101 }, // within 1% of min → "best"
      { key: "c", value: 130 }, // (130-100)/100 = 0.3 → "competitive" (<=0.4)
      { key: "d", value: 160 }, // 0.6 → "neutral"
      { key: "e", value: 200 }, // 1.0 → "high"
    ]);
    expect(out.min).toBe(100);
    expect(out.max).toBe(200);
    expect(out.bands.a).toBe("best");
    expect(out.bands.b).toBe("best"); // within 1% tolerance
    expect(out.bands.c).toBe("competitive");
    expect(out.bands.d).toBe("neutral");
    expect(out.bands.e).toBe("high");
  });

  it("clamps spread at 1 when min equals max", () => {
    const out = computeComparisonBands([
      { key: "a", value: 100 },
      { key: "b", value: 100 },
    ]);
    // both equal min → both 'best'
    expect(out.bands.a).toBe("best");
    expect(out.bands.b).toBe("best");
  });
});

describe("pricingEngine.pickLowestQuote", () => {
  it("returns null on empty input", () => {
    expect(pickLowestQuote([])).toBeNull();
    expect(pickLowestQuote(null)).toBeNull();
  });

  it("picks the cheapest total", () => {
    const out = pickLowestQuote([
      { vendorId: "a", total: 1000 },
      { vendorId: "b", total: 800 },
      { vendorId: "c", total: 900 },
    ]);
    expect(out.vendorId).toBe("b");
  });

  it("breaks ties by prev_worked === 1", () => {
    const out = pickLowestQuote([
      { vendorId: "a", total: 1000, prev_worked: 0, timestamp: "2025-01-01" },
      { vendorId: "b", total: 1000, prev_worked: 1, timestamp: "2025-01-02" },
    ]);
    expect(out.vendorId).toBe("b");
  });

  it("breaks remaining ties by earliest timestamp", () => {
    const out = pickLowestQuote([
      { vendorId: "a", total: 1000, prev_worked: 0, timestamp: "2025-01-05" },
      { vendorId: "b", total: 1000, prev_worked: 0, timestamp: "2025-01-02" },
      { vendorId: "c", total: 1000, prev_worked: 0, timestamp: "2025-01-08" },
    ]);
    expect(out.vendorId).toBe("b");
  });
});

describe("pricingEngine.computeFreightAdvantage", () => {
  it("flags vendors with freight within 1% of the lowest", () => {
    const out = computeFreightAdvantage([
      { vendorId: "a", price: 1000, freightCost: 100, isRegret: false, missingParts: [] },
      { vendorId: "b", price: 1000, freightCost: 101, isRegret: false, missingParts: [] }, // within 1% tolerance
      { vendorId: "c", price: 1000, freightCost: 200, isRegret: false, missingParts: [] },
    ]);
    expect(out).toEqual(["a", "b"]);
  });

  it("excludes regret quotes, unpriced quotes, and quotes with missing parts", () => {
    const out = computeFreightAdvantage([
      { vendorId: "a", price: 1000, freightCost: 100, isRegret: false, missingParts: [] },
      { vendorId: "b", price: 1000, freightCost: 90, isRegret: true, missingParts: [] }, // regret → excluded
      { vendorId: "c", price: 0, freightCost: 90, isRegret: false, missingParts: [] }, // no price → excluded
      { vendorId: "d", price: 1000, freightCost: 90, isRegret: false, missingParts: ["tax"] }, // missing → excluded
    ]);
    expect(out).toEqual(["a"]);
  });

  it("returns empty when no eligible vendors", () => {
    expect(computeFreightAdvantage([])).toEqual([]);
    expect(
      computeFreightAdvantage([
        { vendorId: "a", price: 1000, freightCost: 0, isRegret: false, missingParts: [] },
      ])
    ).toEqual([]);
  });
});

describe("pricingEngine.normalizeChargesMeta", () => {
  it("passes through canonical shape unchanged", () => {
    const meta = {
      tax: 18,
      tax_mode: "percentage",
      other_charges: [{ name: "Freight", amount: 5, amount_mode: "percentage" }],
    };
    const out = normalizeChargesMeta(meta);
    expect(out.tax).toBe(18);
    expect(out.tax_mode).toBe("percentage");
    expect(out.other_charges).toEqual(meta.other_charges);
  });

  it("converts legacy flat shape to canonical other_charges entries", () => {
    const out = normalizeChargesMeta({
      tax: 18,
      tax_mode: "percentage",
      freight_price: 5,
      freight_mode: "percentage",
      package_price: 200,
      package_mode: "absolute",
    });
    expect(out.other_charges).toHaveLength(2);
    expect(out.other_charges[0]).toMatchObject({
      name: "Freight",
      amount: 5,
      amount_mode: "percentage",
    });
    expect(out.other_charges[1]).toMatchObject({
      name: "Packaging",
      amount: 200,
      amount_mode: "absolute",
    });
  });

  it("omits charges that are zero or absent in the legacy shape", () => {
    const out = normalizeChargesMeta({
      tax: 18,
      tax_mode: "percentage",
      freight_price: 5,
      freight_mode: "percentage",
      package_price: 0, // skipped
    });
    expect(out.other_charges).toHaveLength(1);
    expect(out.other_charges[0].name).toBe("Freight");
  });

  it("returns a sane shape on completely empty input", () => {
    const out = normalizeChargesMeta({});
    expect(out).toEqual({
      tax: 0,
      tax_mode: "percentage",
      other_charges: [],
    });
  });

  it("is end-to-end equivalent: legacy meta → engine produces same total as PO formula", () => {
    // Legacy PO charges_meta with freight + package + tax. After adapting via
    // normalizeChargesMeta, the engine should produce the canonical
    // (tax-on-base-only) total — NOT the legacy compound-tax PO total. This is
    // the documented behavior change: PO calculations align with the quote
    // formula going forward.
    const legacy = {
      tax: 18,
      tax_mode: "percentage",
      freight_price: 5,
      freight_mode: "percentage",
      package_price: 2,
      package_mode: "percentage",
    };
    const meta = normalizeChargesMeta(legacy);
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: meta.tax,
      tax_mode: meta.tax_mode,
      other_charges: meta.other_charges,
    });
    // base = 1000, base_tax = 180
    // freight = 50, freight_tax inherits 18% = 9 → 59
    // package = 20, package_tax inherits 18% = 3.6 → 23.6
    // total = 1000 + 180 + 59 + 23.6 = 1262.6 → q2 → 1262.6
    expect(out.total).toBe(1262.6);
  });
});

describe("pricingEngine — integration scenarios", () => {
  it("matches the legacy quote formula on a typical send-quote line", () => {
    // Replicate a realistic vendor quote: ₹100 unit, qty 10, 18% GST on base,
    // 5% freight (with 18% own tax), ₹200 packaging absolute (tax: null →
    // inherits 18%).
    const out = calculateLineTotal({
      unit_price: 100,
      quantity: 10,
      tax: 18,
      tax_mode: "percentage",
      other_charges: [
        { name: "Freight", amount: 5, amount_mode: "percentage", tax: 18, tax_mode: "percentage" },
        { name: "Packaging", amount: 200, amount_mode: "absolute", tax: null, tax_mode: "percentage" },
      ],
    });
    // base 1000, base_tax 180
    // freight 50 + own tax 9 = 59
    // packaging 200 + inherited 18% = 36 → 236
    // total 1000 + 180 + 59 + 236 = 1475
    expect(out.total).toBe(1475);
  });

  it("aggregates a multi-line quote with global insurance charge", () => {
    const out = calculateDocumentTotals(
      [
        {
          unit_price: 100,
          quantity: 10,
          tax: 18,
          tax_mode: "percentage",
          other_charges: [
            { name: "Freight", amount: 5, amount_mode: "percentage", tax: 18, tax_mode: "percentage" },
          ],
        },
        {
          unit_price: 50,
          quantity: 20,
          tax: 12,
          tax_mode: "percentage",
        },
      ],
      [{ name: "Insurance", amount: 1, amount_mode: "percentage" }]
    );
    // Line 1: base 1000, base_tax 180, freight 50+9=59 → 1239
    // Line 2: base 1000, base_tax 120 → 1120
    // subtotal = 2359
    // insurance = 23.59
    // grand total = 2382.59 → q2 → 2382.59
    expect(out.lines[0].total).toBe(1239);
    expect(out.lines[1].total).toBe(1120);
    expect(out.grand_subtotal).toBe(2359);
    expect(out.global_charges_total).toBe(23.59);
    expect(out.grand_total).toBe(2382.59);
  });
});
