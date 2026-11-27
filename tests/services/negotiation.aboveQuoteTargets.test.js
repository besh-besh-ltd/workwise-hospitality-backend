// REQ-2026-0104: a buyer may set a negotiation PRICE target above the vendor's
// quote (asking the vendor to raise it, e.g. to a rate approved offline). The
// vendor email used to hide such a row as "worse", so the vendor never heard
// of the ask. It now shows it, marked, and still hides a delivery target with
// more days than quoted (that rule is unchanged).
//
// Drives the real row renderer; only the mail transport is replaced so the
// module imports without touching SMTP.

import { describe, it, expect, jest } from "@jest/globals";

jest.unstable_mockModule("../../app/helper/common.js", () => ({
  sendMail: () => Promise.resolve({ messageId: "<captured>" }),
  logError: () => {},
}));

const { renderFieldRows } = await import("../../app/helper/sendEmailFunctions/negotiationEmails.js");

const quote = {
  unit_price: 100,
  quantity: 5,
  delivery_period: 7,
  other_charges: [{ name: "Freight", slug: "freight", amount: 50, amount_mode: "absolute" }],
};
const vendorRows = (fields) => renderFieldRows(fields, quote, {}, { hideWorseTargets: true });

describe("vendor email rows — price target above the quote (REQ-2026-0104)", () => {
  it("shows a base price target above the quote, marked as a raise", () => {
    const html = vendorRows([{ name: "base_price", target: 110 }]);
    expect(html).toContain("₹100");
    expect(html).toContain("₹110");
    expect(html).toContain("above your quoted price");
  });

  it("shows a charge target above the quote, marked as a raise", () => {
    const html = vendorRows([{ name: "freight", target: 80, mode: "absolute" }]);
    expect(html).toContain("₹80");
    expect(html).toContain("above your quoted price");
  });

  it("a target below the quote is shown as before, with no raise note", () => {
    const html = vendorRows([{ name: "base_price", target: 90 }]);
    expect(html).toContain("₹90");
    expect(html).not.toContain("above your quoted price");
  });

  it("a target equal to the quote is still shown, with no raise note (unchanged)", () => {
    const html = vendorRows([{ name: "base_price", target: 100 }]);
    expect(html).toContain("Base Price");
    expect(html).not.toContain("above your quoted price");
  });

  it("still hides a delivery target with more days than quoted (unchanged)", () => {
    const html = vendorRows([
      { name: "delivery_period", target: 10 },
      { name: "base_price", target: 95 },
    ]);
    expect(html).not.toMatch(/Delivery/i);
    expect(html).toContain("₹95");
  });

  it("the buyer-side render (no hiding) never adds the vendor note", () => {
    const html = renderFieldRows([{ name: "base_price", target: 110 }], quote, {});
    expect(html).toContain("₹110");
    expect(html).not.toContain("above your quoted price");
  });

  it("a mixed-mode charge compares in rupees: 20% of a ₹500 line (₹100) is above a ₹50 quote", () => {
    const html = vendorRows([{ name: "freight", target: 20, mode: "percentage" }]);
    expect(html).toContain("20%");
    expect(html).toContain("above your quoted price");
  });
});
