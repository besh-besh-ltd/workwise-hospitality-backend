// Technical evaluation must be enforced by the SERVER, on every RFQ.
//
// CONFIRMED DEFECT, reproduced from RFQ 536289 (Orchid Hotel Panchgani).
// Six products each carried one technical-evaluation clause. 31 vendors were
// invited; one — surya enterprises (id 497) — quoted all six TE-bearing lines on
// 8 Aug, inside the bid window and ten days after the clauses were created, and
// answered none of them. The buyer's Technical Evaluation screen was then blank,
// correctly: there was nothing to score, and the RFQ could not proceed.
//
// It was allowed because enforcement was effectively browser-only:
//
//   * createQuote's technical check sat inside `if (isReverseAuction && ...)`.
//     536289 has reverse_auction = 0, as do 623 of 675 RFQs, so it never ran.
//   * updateQuoteItems had no technical check at all.
//   * Both vendor clients gate on `product.tech_evaluation_status` and both FAIL
//     OPEN when it is missing — the wizard drops the whole Technical evaluation
//     step and `evalGateOk` returns true; the legacy page enables Send.
//
// The rule these tests pin: a line whose product has unanswered non-sampling
// clauses cannot be quoted, regardless of RFQ type, and lines the vendor is not
// actually submitting never block them.

import { jest } from "@jest/globals";
import {
  findUnansweredTechEvalLines,
  unansweredTechEvalMessage,
} from "../../app/services/techEvalQuoteGate.js";

// Capture what reaches SQL without needing a database.
const fakeTx = (rows = []) => {
  const calls = [];
  return { calls, any: async (sql, params) => { calls.push({ sql, params }); return rows; } };
};

const line = (product_id, extra = {}) => ({ product_id, variant: 0, unit_price: "100.00", ...extra });

describe("which lines the gate examines", () => {
  it("sends only lines the vendor is actually quoting", async () => {
    const t = fakeTx();
    await findUnansweredTechEvalLines(
      {
        rfq_id: 747,
        vendor_id: 497,
        products: [
          line(1),                                                   // priced
          { product_id: 2, variant: 0, unit_price: "", comment: "" }, // skipped line
          { product_id: 3, variant: 0, unit_price: 0, comment: "note" },        // comment only
          { product_id: 4, variant: 0, unit_price: 0, document_files: ["a.pdf"] }, // file only
        ],
      },
      t
    );
    const keys = JSON.parse(t.calls[0].params[2]).map((k) => k.pv);
    // 2 carries nothing at all — blocking on it would refuse a vendor for a line
    // they never submitted.
    expect(keys).toEqual([1, 3, 4]);
  });

  it("does not query at all when no line is meaningful", async () => {
    const t = fakeTx();
    const out = await findUnansweredTechEvalLines(
      { rfq_id: 747, vendor_id: 497, products: [{ product_id: 9, variant: 0, unit_price: "" }] },
      t
    );
    expect(out).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });

  it("excludes sampling clauses, matching every other count in the codebase", async () => {
    const t = fakeTx();
    await findUnansweredTechEvalLines({ rfq_id: 747, vendor_id: 497, products: [line(1)] }, t);
    expect(t.calls[0].sql).toMatch(/clause_type <> 'sampling'/);
  });

  it("counts a blank or N/A response as unanswered", async () => {
    const t = fakeTx();
    await findUnansweredTechEvalLines({ rfq_id: 747, vendor_id: 497, products: [line(1)] }, t);
    expect(t.calls[0].sql).toMatch(/NOT IN \('', 'N\/A'\)/);
  });

  it("scopes responses to the submitting vendor", async () => {
    const t = fakeTx();
    await findUnansweredTechEvalLines({ rfq_id: 747, vendor_id: 497, products: [line(1)] }, t);
    expect(t.calls[0].sql).toMatch(/vr\.vendor_id = \$2/);
    expect(t.calls[0].params[1]).toBe(497);
  });

  it("returns empty on a malformed rfq/vendor rather than querying", async () => {
    const t = fakeTx();
    expect(await findUnansweredTechEvalLines({ rfq_id: null, vendor_id: 497, products: [line(1)] }, t)).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });
});

describe("the refusal the vendor sees", () => {
  it("names every offending product and its progress", () => {
    // The six lines from RFQ 536289, as the gate reports them.
    const msg = unansweredTechEvalMessage([
      { product_name: "GLASS MARTINI", clauses: 1, answered: 0 },
      { product_name: "JUICE GLASS", clauses: 2, answered: 1 },
    ]);
    expect(msg).toContain("GLASS MARTINI (0/1 answered)");
    expect(msg).toContain("JUICE GLASS (1/2 answered)");
    expect(msg).toMatch(/these products/);
  });

  it("reads naturally for a single product", () => {
    const msg = unansweredTechEvalMessage([{ product_name: "PASTA PLATE", clauses: 1, answered: 0 }]);
    expect(msg).toMatch(/this product/);
    expect(msg).not.toMatch(/these products/);
  });
});
