// Addendum template — pure render coverage for every amendment type, signed +
// unsigned. The Puppeteer→S3 PDF step is skipped under the test harness, so
// this is the closest automated proof that the HTML the renderer feeds to
// Puppeteer never throws and carries the key facts for all five types.

import { renderAddendumHtml, summariseAmendment } from "../../../app/helper/arc_v2/addendumTemplate.js";

const CTX = { arc_number: "ARC-TMPL-1", title: "Beverages rate contract", company_name: "Workwise Hotels", buyer_name: "Procurement Lead" };
const VENDOR = { name: "ALICO Supplies", email: "ops@alico.test" };

const CASES = [
  { type: "price",       payload: { arc_contract_line_id: 5, new_rate: 220 },               from: "2026-07-01", to: "2026-09-30", expect: /unit rate.*220/i },
  { type: "qty",         payload: { arc_contract_line_id: 5, new_qty: 1200 },               from: "2026-07-01", to: "2026-09-30", expect: /committed quantity.*1,?200/i },
  { type: "item_add",    payload: { product_variant_id: 9, new_rate: 80, new_qty: 300 },    from: "2026-07-01", to: "2026-12-31", expect: /new line is added/i },
  { type: "item_remove", payload: { arc_contract_line_id: 7 },                              from: "2026-07-01", to: null,         expect: /is removed/i },
  { type: "term",        payload: {},                                                       from: "2027-03-31", to: null,         expect: /term is extended/i },
];

describe("addendum template — all amendment types render", () => {
  test.each(CASES)("summariseAmendment($type) yields a human clause", ({ type, payload, from, to, expect: re }) => {
    const summary = summariseAmendment({ amendment_type: type, payload, amendment_from: from, amendment_to: to });
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(10);
    expect(summary).toMatch(re);
  });

  test.each(CASES)("renderAddendumHtml($type) — draft + signed produce valid HTML", ({ type, payload, from, to }) => {
    const am = { amendment_type: type, payload, amendment_from: from, amendment_to: to };
    const summary = summariseAmendment(am);

    const draft = renderAddendumHtml(am, CTX, VENDOR, { addendumNumber: 2, changeSummary: summary, signed: false });
    expect(draft).toContain("Addendum No. 2");
    expect(draft).toContain(CTX.arc_number);
    expect(draft).toContain(VENDOR.name);
    expect(draft).toContain("Pending vendor signature");
    expect(draft).toMatch(/^<!doctype html>/i);

    const signed = renderAddendumHtml(am, CTX, VENDOR, { addendumNumber: 2, changeSummary: summary, signed: true, signedAt: new Date("2026-06-15") });
    expect(signed).toContain("Electronically signed");
    expect(signed).not.toContain("Pending vendor signature");
  });

  test("template escapes HTML-unsafe vendor / context fields", () => {
    const am = { amendment_type: "price", payload: { arc_contract_line_id: 1, new_rate: 100 }, amendment_from: "2026-07-01", amendment_to: "2026-08-01" };
    const html = renderAddendumHtml(am, { ...CTX, company_name: "A & B <script>" }, { name: "X<y>" }, { addendumNumber: 1, changeSummary: "x" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("A &amp; B");
  });
});
