// Controller-level smoke test for /pricing/preview. Exercises the actual
// production controller (`pricingController.previewTotals`) with a mocked
// req/res, matching the pattern used by `quote.submission.test.js`. No DB.

import { describe, it, expect } from "@jest/globals";
import pricingController from "../../app/controllers/pricing/pricingController.js";

function mockExpress(body = {}) {
  const captured = { status: null, body: null };
  const res = {
    status(code) {
      captured.status = code;
      return this;
    },
    json(payload) {
      captured.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
  return { req: { body }, res, captured };
}

describe("pricingController.previewTotals", () => {
  it("rejects when items is not an array", async () => {
    const { req, res, captured } = mockExpress({ items: "nope" });
    await pricingController.previewTotals(req, res);
    expect(captured.status).toBe(400);
    expect(captured.body.status).toBe(0);
  });

  it("returns engine output for a valid payload", async () => {
    const { req, res, captured } = mockExpress({
      items: [
        {
          unit_price: 100,
          quantity: 10,
          tax: 18,
          tax_mode: "percentage",
          other_charges: [
            {
              name: "Freight",
              amount: 5,
              amount_mode: "percentage",
              tax: 18,
              tax_mode: "percentage",
            },
          ],
        },
      ],
    });

    await pricingController.previewTotals(req, res);
    expect(captured.status).toBe(200);
    expect(captured.body.status).toBe(1);
    // Line: base 1000, base_tax 180, freight 50 + own tax 9 = 59 → 1239
    expect(captured.body.data.lines[0].total).toBe(1239);
    expect(captured.body.data.grand_total).toBe(1239);
  });

  it("treats missing global_charges as empty array", async () => {
    const { req, res, captured } = mockExpress({
      items: [{ unit_price: 100, quantity: 1, tax: 0 }],
    });
    await pricingController.previewTotals(req, res);
    expect(captured.body.data.global_charges).toEqual([]);
    expect(captured.body.data.grand_total).toBe(100);
  });

  it("applies percentage global charges to subtotal", async () => {
    const { req, res, captured } = mockExpress({
      items: [{ unit_price: 100, quantity: 10, tax: 0 }],
      global_charges: [{ name: "Insurance", amount: 2, amount_mode: "percentage" }],
    });
    await pricingController.previewTotals(req, res);
    // subtotal 1000, insurance 20, grand 1020
    expect(captured.body.data.global_charges_total).toBe(20);
    expect(captured.body.data.grand_total).toBe(1020);
  });

  it("returns 200 with empty result for empty items", async () => {
    const { req, res, captured } = mockExpress({ items: [] });
    await pricingController.previewTotals(req, res);
    expect(captured.status).toBe(200);
    expect(captured.body.data.grand_total).toBe(0);
    expect(captured.body.data.lines).toEqual([]);
  });
});

// ============================================================================
// MRP (tax-inclusive) quoting — /pricing/preview (spec .pipeline/spec.md §3, §9)
// ============================================================================
//
// The endpoint is stateless and MRP support is additive/opt-in per item:
// an item carrying pricing_method === 'MRP' is resolved (entered_mrp/discount
// → derived exclusive base) BEFORE the engine runs; an item without
// pricing_method (PO edit, Traditional) passes through untouched.

describe("pricingController.previewTotals — MRP (tax-inclusive) items", () => {
  it("an MRP item returns the SAME grand total as an equivalent Traditional item whose base == the derived base", async () => {
    // MRP item: entered_mrp 1180 @ 18% GST, no discount → derived base 1000.
    const mrpReq = mockExpress({
      items: [
        {
          pricing_method: "MRP",
          entered_mrp: 1180,
          mrp_discount: "",
          mrp_discount_mode: "percentage",
          unit_price: 999999, // garbage — must be ignored, overwritten by the derived base
          quantity: 10,
          tax: 18,
          tax_mode: "percentage",
          other_charges: [],
        },
      ],
    });
    await pricingController.previewTotals(mrpReq.req, mrpReq.res);

    // Traditional item with the equivalent already-exclusive base (1000).
    const tradReq = mockExpress({
      items: [
        { unit_price: 1000, quantity: 10, tax: 18, tax_mode: "percentage", other_charges: [] },
      ],
    });
    await pricingController.previewTotals(tradReq.req, tradReq.res);

    expect(mrpReq.captured.status).toBe(200);
    expect(tradReq.captured.status).toBe(200);
    expect(mrpReq.captured.body.data.grand_total).toBe(tradReq.captured.body.data.grand_total);
    expect(mrpReq.captured.body.data.lines[0].total).toBe(tradReq.captured.body.data.lines[0].total);
    // Sanity: 1000 base * 10 qty * 1.18 = 11800.
    expect(mrpReq.captured.body.data.grand_total).toBe(11800);
  });

  it("an MRP item with a discount resolves to the discounted base before the engine runs", async () => {
    // mrp 1180, 10% discount → net 1062 → base 900 exactly.
    const { req, res, captured } = mockExpress({
      items: [
        {
          pricing_method: "MRP",
          entered_mrp: 1180,
          mrp_discount: 10,
          mrp_discount_mode: "percentage",
          quantity: 1,
          tax: 18,
          tax_mode: "percentage",
          other_charges: [],
        },
      ],
    });
    await pricingController.previewTotals(req, res);
    expect(captured.status).toBe(200);
    // base 900 + 18% tax = 1062.
    expect(captured.body.data.lines[0].total).toBe(1062);
    expect(captured.body.data.grand_total).toBe(1062);
  });

  it("a plain item with no pricing_method is unchanged — backward compatible with the PO-edit path", async () => {
    const { req, res, captured } = mockExpress({
      items: [
        { unit_price: 250, quantity: 4, tax: 12, tax_mode: "percentage", other_charges: [] },
      ],
    });
    await pricingController.previewTotals(req, res);
    expect(captured.status).toBe(200);
    // base 1000, tax 120 → 1120 — same formula as before the MRP feature existed.
    expect(captured.body.data.lines[0].total).toBe(1120);
    expect(captured.body.data.grand_total).toBe(1120);
  });

  // DISCRIMINATING — previewTotals's MRP branch explicitly sets
  // `tax_mode: "percentage"` (pricingController.js L38) on the resolved item,
  // overriding whatever tax_mode the client sent. WITHOUT that force, an MRP
  // item sent with `tax_mode: 'absolute'` would flow `tax_mode: 'absolute'`
  // straight into `calculateDocumentTotals`, and the base-tax would be a flat
  // ₹18 (not 18%) — grand_total 1018, not 1180. WITH the force, the absolute
  // tax_mode is discarded and the percentage total (1180) is returned.
  it("forces percentage GST on an MRP item even when the client sends tax_mode='absolute' — DISCRIMINATING (grand_total must equal the percentage total, not the absolute one)", async () => {
    const { req, res, captured } = mockExpress({
      items: [
        {
          pricing_method: "MRP",
          entered_mrp: 1180,
          mrp_discount: "",
          mrp_discount_mode: "percentage",
          quantity: 1,
          tax: 18,
          tax_mode: "absolute", // client tampers with an absolute GST mode
          other_charges: [],
        },
      ],
    });
    await pricingController.previewTotals(req, res);
    expect(captured.status).toBe(200);

    // Equivalent Traditional item at the derived base (1000), percentage mode
    // — this is what the response SHOULD match.
    const percReq = mockExpress({
      items: [{ unit_price: 1000, quantity: 1, tax: 18, tax_mode: "percentage", other_charges: [] }],
    });
    await pricingController.previewTotals(percReq.req, percReq.res);

    // Same base, but absolute tax mode — what the response WOULD equal
    // without the guard (flat ₹18, not 18%).
    const absReq = mockExpress({
      items: [{ unit_price: 1000, quantity: 1, tax: 18, tax_mode: "absolute", other_charges: [] }],
    });
    await pricingController.previewTotals(absReq.req, absReq.res);

    expect(absReq.captured.body.data.grand_total).toBe(1018);
    expect(percReq.captured.body.data.grand_total).toBe(1180);

    expect(captured.body.data.grand_total).toBe(percReq.captured.body.data.grand_total);
    expect(captured.body.data.grand_total).not.toBe(absReq.captured.body.data.grand_total);
    expect(captured.body.data.grand_total).toBe(1180);
  });

  it("a mixed document (one MRP line + one Traditional line) totals both correctly", async () => {
    const { req, res, captured } = mockExpress({
      items: [
        {
          pricing_method: "MRP",
          entered_mrp: 1180, mrp_discount: "", mrp_discount_mode: "percentage",
          quantity: 1, tax: 18, tax_mode: "percentage", other_charges: [],
        },
        { unit_price: 500, quantity: 2, tax: 0, tax_mode: "percentage", other_charges: [] },
      ],
    });
    await pricingController.previewTotals(req, res);
    expect(captured.status).toBe(200);
    // Line 1 (MRP): base 1000 * 1 * 1.18 = 1180. Line 2 (Traditional): 500*2 = 1000.
    expect(captured.body.data.lines[0].total).toBe(1180);
    expect(captured.body.data.lines[1].total).toBe(1000);
    expect(captured.body.data.grand_total).toBe(2180);
  });
});
