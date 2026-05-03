// Controller-level smoke test for /pricing/preview. Exercises the actual
// production controller (`pricingController.previewTotals`) with a mocked
// req/res, matching the pattern used by `quote.submission.test.js`. No DB.

import { describe, it, expect } from "@jest/globals";
import pricingController from "../../app/controllers/pricing/pricingController.js";
import { mockExpress } from "../helpers/mockExpress.js";

describe("pricingController.previewTotals", () => {
  it("rejects when items is not an array", async () => {
    const { req, res, calls } = mockExpress({ body: { items: "nope" } });
    await pricingController.previewTotals(req, res);
    expect(calls.status).toBe(400);
    expect(calls.body.status).toBe(0);
  });

  it("returns engine output for a valid payload", async () => {
    const { req, res, calls } = mockExpress({
      body: {
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
      },
    });

    await pricingController.previewTotals(req, res);
    expect(calls.status).toBe(200);
    expect(calls.body.status).toBe(1);
    // Line: base 1000, base_tax 180, freight 50 + own tax 9 = 59 → 1239
    expect(calls.body.data.lines[0].total).toBe(1239);
    expect(calls.body.data.grand_total).toBe(1239);
  });

  it("treats missing global_charges as empty array", async () => {
    const { req, res, calls } = mockExpress({
      body: {
        items: [{ unit_price: 100, quantity: 1, tax: 0 }],
      },
    });
    await pricingController.previewTotals(req, res);
    expect(calls.body.data.global_charges).toEqual([]);
    expect(calls.body.data.grand_total).toBe(100);
  });

  it("applies percentage global charges to subtotal", async () => {
    const { req, res, calls } = mockExpress({
      body: {
        items: [{ unit_price: 100, quantity: 10, tax: 0 }],
        global_charges: [{ name: "Insurance", amount: 2, amount_mode: "percentage" }],
      },
    });
    await pricingController.previewTotals(req, res);
    // subtotal 1000, insurance 20, grand 1020
    expect(calls.body.data.global_charges_total).toBe(20);
    expect(calls.body.data.grand_total).toBe(1020);
  });

  it("returns 200 with empty result for empty items", async () => {
    const { req, res, calls } = mockExpress({ body: { items: [] } });
    await pricingController.previewTotals(req, res);
    expect(calls.status).toBe(200);
    expect(calls.body.data.grand_total).toBe(0);
    expect(calls.body.data.lines).toEqual([]);
  });
});
