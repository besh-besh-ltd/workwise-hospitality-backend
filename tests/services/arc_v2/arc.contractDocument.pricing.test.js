// ARC v2 — the contract document's Schedule of Rates is EXCLUSIVE of GST.
//
// Regression: the schedule used to print the pricing engine's all-in figure
// (base + GST + charges with their GST) under "Awarded Rate" and "Value (excl.
// tax)". A ₹1,180 line at 18% GST printed as ₹1,392.4, and the total
// "exclusive of taxes" was really the GST-inclusive amount (₹7,94,848 instead
// of ₹6,73,600 on the local demo ARC). Clause 2 says GST is charged extra, so
// the schedule must be built from the pre-tax parts: basic rate + pre-tax
// freight/charges.

import { renderContractDocumentHtml } from "../../../app/controllers/arc_v2/arcContractController.js";

const CTX = {
  arc_id: 1, arc_number: "ARC-TEST-PRICING-1", title: "Pricing test", is_group: false,
  contract_start_at: "2026-11-12", contract_end_at: "2027-11-12", eligibility_type: "invitation",
  payment_terms_expected: "Net 30 from GRN", delivery_expected: "Within 7 days", penalty_clause: null,
  escalation_clause_json: {}, category_title: "HOUSEKEEPING SUPPLY",
  hotel_name: "Burj Al Arab", hotel_city: "Dubai", hotel_state: null, company_name: "Workwise Hotels",
  purchaser_gstin: null, buyer_name: "Kushal Shah", buyer_designation: null, buyer_email: null,
};
const VENDOR = { name: "Nexon Ventures", email: "nexon@example.test", gstin: null };

const line = (over) => ({
  id: 1, arc_item_id: 1, variant_name: "Item", variant_slug: "item", uom: "pcs",
  unit_rate: "0.00", gst_pct: "18.00", committed_qty: "0", charges: [], ...over,
});

/** Schedule of Rates rows as arrays of cell texts (header excluded). */
function scheduleRows(html) {
  const table = html.match(/<table class="sch">([\s\S]*?)<\/table>/)[1];
  const body = table.split("</thead>")[1];
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      c[1].replace(/<div class="sub"[\s\S]*?<\/div>/g, "").replace(/<[^>]+>/g, "").trim()));
}

describe("contract document — schedule of rates excludes GST", () => {
  test("awarded rate and value are the pre-tax figures; the total matches the buyer-side committed value", () => {
    // The two Nexon lines from the local demo ARC-2026-27-0021.
    const html = renderContractDocumentHtml(CTX, VENDOR, [
      line({ id: 1, arc_item_id: 1, variant_name: "3M Nomad Aqua 85", unit_rate: "1180.00", committed_qty: "400" }),
      line({ id: 2, arc_item_id: 2, variant_name: "3M Nomad Terra Loop", unit_rate: "840.00", committed_qty: "240" }),
    ]);
    const rows = scheduleRows(html);
    // # | item | uom | basic | freight | awarded | gst | qty | value
    expect(rows[0].slice(3)).toEqual(["₹1,180", "—", "₹1,180", "18%", "400", "₹4,72,000"]);
    expect(rows[1].slice(3)).toEqual(["₹840", "—", "₹840", "18%", "240", "₹2,01,600"]);
    expect(rows[2]).toEqual(["Total committed value (exclusive of taxes)", "₹6,73,600"]);
    expect(html).toContain("Six Lakh Seventy Three Thousand Six Hundred Rupees Only");
    // The GST-inclusive figures must not appear anywhere.
    expect(html).not.toContain("1,392.4");
    expect(html).not.toContain("7,94,848");
  });

  test("freight is added to the awarded rate before tax; GST on freight stays out", () => {
    const html = renderContractDocumentHtml(CTX, VENDOR, [
      line({
        unit_rate: "100.00", committed_qty: "50",
        // Freight with no explicit tax inherits the line's 18% GST in the engine.
        charges: [{ name: "Freight", amount: 10, amount_mode: "absolute", tax: null }],
      }),
    ]);
    const rows = scheduleRows(html);
    expect(rows[0].slice(3)).toEqual(["₹100", "₹10", "₹110", "18%", "50", "₹5,500"]);
    expect(rows[1]).toEqual(["Total committed value (exclusive of taxes)", "₹5,500"]);
    // 110 × 1.18 = 129.8 would be the tax-inclusive rate.
    expect(html).not.toContain("129.8");
  });

  test("a percentage charge is taken on the basic rate, still before tax", () => {
    const html = renderContractDocumentHtml(CTX, VENDOR, [
      line({
        unit_rate: "200.00", gst_pct: "12.00", committed_qty: "10",
        charges: [{ name: "Freight", amount: 5, amount_mode: "percentage", tax: 18, tax_mode: "percentage" }],
      }),
    ]);
    const rows = scheduleRows(html);
    expect(rows[0].slice(3)).toEqual(["₹200", "₹10", "₹210", "12%", "10", "₹2,100"]);
    expect(rows[1][1]).toBe("₹2,100");
  });

  test("a zero-GST line is unchanged", () => {
    const html = renderContractDocumentHtml(CTX, VENDOR, [
      line({ unit_rate: "75.50", gst_pct: "0", committed_qty: "3" }),
    ]);
    expect(scheduleRows(html)[0].slice(3)).toEqual(["₹75.5", "—", "₹75.5", "0%", "3", "₹226.5"]);
  });
});
