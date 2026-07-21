// PDF totals must reconcile to the persisted total_price (which the engine
// computed on save). These tests pin that contract: PO PDF data builder
// produces the same numbers as the pricing engine.
//
// Layout invariants:
//   - Each row carries `subtotal` = engine.total (basic + charges + tax).
//   - Bottom shows aggregates only: basicAmount, totalCharges, gstAmount,
//     totalSubtotal — not per-charge-name product-level rows.
//   - Global PO-level charges (passed in separately) appear under Subtotal
//     and add to totalPrice; product-level charges never appear at the
//     bottom.

import { describe, it, expect } from "@jest/globals";
import { buildPOTemplatePricing } from "../../app/helper/poTemplatePricing.js";
import pricingEngine from "../../app/services/pricingEngine.js";

describe("buildPOTemplatePricing", () => {
  it("renders a per-line subtotal that matches the engine's per-line total", () => {
    const items = [
      {
        unit_price: 500,
        quantity: 50,
        tax: 30,
        tax_mode: "percentage",
        other_charges: [
          { name: "Freight", amount: 10, amount_mode: "percentage", tax: 9, tax_mode: "percentage" },
          { name: "Insurance", amount: 50, amount_mode: "percentage", tax: 12, tax_mode: "percentage" },
        ],
      },
    ];

    const out = buildPOTemplatePricing(items, "gst");
    const engineTotal = pricingEngine.calculateLineTotal({
      unit_price: 500, quantity: 50, tax: 30, tax_mode: "percentage",
      other_charges: items[0].other_charges,
    }).total;
    // Engine: base 25000 + base_tax 7500 + Freight 2500+225 + Insurance 12500+1500 = 49225
    expect(engineTotal).toBe(49225);
    expect(Number(out.items[0].subtotal)).toBe(49225);
    expect(Number(out.totalSubtotal)).toBe(49225);
    expect(Number(out.totalPrice)).toBe(49225);
  });

  it("aggregates per-line charges into totalCharges (no per-name breakdown at bottom)", () => {
    const items = [
      {
        unit_price: 500,
        quantity: 50,
        tax: 30,
        tax_mode: "percentage",
        other_charges: [
          { name: "Freight", amount: 10, amount_mode: "percentage", tax: 9, tax_mode: "percentage" },
          { name: "Insurance", amount: 50, amount_mode: "percentage", tax: 12, tax_mode: "percentage" },
        ],
      },
    ];

    const out = buildPOTemplatePricing(items, "gst");
    // Post the 2026-06-19 "accurate totals" engine change, charge TAX is
    // attributed to totalCharges (not gstAmount): totalCharges = charge base +
    // charge tax = (2500 + 12500) + (225 + 1500) = 16725; gstAmount holds the
    // BASE tax only (7500). The grand total is unchanged (basic + totalCharges
    // + gstAmount = totalSubtotal), so PO PDF money is correct — only the
    // internal split moved.
    expect(Number(out.totalCharges)).toBe(16725);
    expect(Number(out.gstAmount)).toBe(7500);
    // basicAmount + totalCharges + gstAmount = totalSubtotal (grand total intact)
    expect(
      Number(out.basicAmount) + Number(out.totalCharges) + Number(out.gstAmount)
    ).toBeCloseTo(Number(out.totalSubtotal), 2);
    // No legacy per-name columns at the bottom anymore.
    expect(out).not.toHaveProperty("totalFreight");
    expect(out).not.toHaveProperty("totalPackage");
    expect(out).not.toHaveProperty("otherChargeTotals");
  });

  it("attaches charge_details with has_tax flag for inline row display", () => {
    const items = [
      {
        unit_price: 100,
        quantity: 10,
        tax: 18,
        tax_mode: "percentage",
        other_charges: [
          { name: "Freight", amount: 5, amount_mode: "percentage", tax: 9, tax_mode: "percentage" },
          // tax: null → inherit base 18% (not "explicit no tax")
          { name: "Custom", amount: 100, amount_mode: "absolute", tax: null },
          // tax: 0 → explicit no tax (the new tri-state escape hatch)
          { name: "ZeroFee", amount: 50, amount_mode: "absolute", tax: 0 },
        ],
      },
    ];
    const out = buildPOTemplatePricing(items, "gst");
    const cd = out.items[0].charge_details;
    expect(cd).toHaveLength(3);
    expect(cd[0].name).toBe("Freight");
    expect(cd[0].has_tax).toBe(true);
    // Custom inherits base 18% rate → has_tax true (engine fills in 18%).
    expect(cd[1].name).toBe("Custom");
    expect(cd[1].has_tax).toBe(true);
    // ZeroFee is explicit no-tax → has_tax false, no inheritance.
    expect(cd[2].name).toBe("ZeroFee");
    expect(cd[2].has_tax).toBe(false);
    expect(Number(cd[2].tax)).toBe(0);
  });

  it("includes PO-level global charges in totalPrice but not in totalSubtotal", () => {
    const items = [
      { unit_price: 100, quantity: 10, tax: 0, tax_mode: "percentage", other_charges: [] },
    ];
    const globalCharges = [
      { name: "Global Insurance", amount: 5, amount_mode: "percentage" },
      { name: "Handling Fee", amount: 50, amount_mode: "absolute" },
    ];
    const out = buildPOTemplatePricing(items, "gst", globalCharges);
    // Subtotal of items = 1000 (no tax, no charges)
    expect(Number(out.totalSubtotal)).toBe(1000);
    // Global charges: 5% of 1000 = 50, plus 50 absolute = 100
    expect(out.globalCharges).toHaveLength(2);
    expect(Number(out.globalCharges[0].amount)).toBe(50);
    expect(Number(out.globalCharges[1].amount)).toBe(50);
    // totalPrice = subtotal + globals
    expect(Number(out.totalPrice)).toBe(1100);
  });

  it("omits globalCharges and totalCharges when they're empty", () => {
    const out = buildPOTemplatePricing(
      [{ unit_price: 100, quantity: 1, tax: 0, tax_mode: "percentage", other_charges: [] }],
      "gst",
      []
    );
    expect(out.globalCharges).toBeNull();
    expect(out.totalCharges).toBeNull();
  });

  it("falls back to legacy flat freight/packaging when other_charges is empty", () => {
    const items = [
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
    ];
    const out = buildPOTemplatePricing(items, "gst");
    // Engine: base 1000, base_tax 180, Freight 50+9 (synthesised, inherits 18%),
    // Packaging 200+36 → 1475
    expect(Number(out.items[0].subtotal)).toBe(1475);
    expect(Number(out.totalSubtotal)).toBe(1475);
    expect(Number(out.totalPrice)).toBe(1475);
    // Both Freight and Packaging end up in charge_details, summed into totalCharges.
    // Post-2026-06-19: charge tax (9 + 36 = 45) is attributed to totalCharges
    // (250 + 45 = 295); gstAmount holds the base tax only (180).
    expect(Number(out.totalCharges)).toBe(295);
    expect(Number(out.gstAmount)).toBe(180);
  });

  it("computes per-row tax_amount = base tax only (charge tax lives in the charge amount)", () => {
    const items = [
      {
        unit_price: 100,
        quantity: 10,
        tax: 12,
        tax_mode: "percentage",
        other_charges: [
          { name: "Freight", amount: 5, amount_mode: "percentage", tax: 12, tax_mode: "percentage" },
        ],
      },
    ];
    const out = buildPOTemplatePricing(items, "gst");
    // Post-2026-06-19: per-row tax_amount holds the BASE tax only (120);
    // charge tax (freight 6) is attributed into the charge amount, not tax_amount.
    expect(Number(out.items[0].tax_amount)).toBe(120);
  });
});
