// The technical-evaluation quote gate, exercised over the path the production
// incident actually took: REGRET → REPRICED QUOTE.
//
// CONFIRMED DEFECT, reproduced from RFQ 536289 (Orchid Hotel Panchgani, Aug 2026).
// The existing suite for this gate (techEval.submissionGate.test.js) stubs the
// transaction and asserts on the SQL that findUnansweredTechEvalLines builds. It
// never runs updateQuoteItems, and updateQuoteItems is where the quote got in:
//
//   04:59 UTC  createQuote with is_regret=1 — 14 lines, all zero-priced, no
//              comments, no attachments. A regret carries no quotable line, so
//              techEvalQuoteGate's isMeaningful() correctly skips every one and
//              the gate lets it through. Right answer.
//   05:11 UTC  updateQuoteItems flipped is_regret to 0, wrote a GSTIN and priced
//              all 14 lines — six of them on products carrying an unanswered
//              technical clause. That endpoint had NO technical check of any
//              kind, not even the reverse-auction one.
//              (audit_log_temp #82311: {"is_regret": [1, 0]})
//
// So the gate's own unit tests were green while the incident was live. These
// tests close that gap: they drive the real endpoint over real HTTP against real
// Postgres, per CONVENTIONS.md §3, and assert on what the vendor is actually
// allowed to persist.
//
// createQuote cannot be driven from here — it gates on user_type in (3,4) and the
// shared fixture users deliberately leave tbl_users.user_type NULL (see the same
// note in rfq.quoteUpdate.security.test.js). The regret is therefore seeded in
// the exact shape createQuote wrote it, and the conversion — the unguarded step,
// and the one under test — goes through the endpoint.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";

const VENDOR = IDS.users.vendor_alpha;
const BUYER = IDS.users.a1_proc_buyer;

afterAll(async () => {
  await closeDb();
});

const inserted = { rfqIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
});

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  await db.none(
    `DELETE FROM tbl_quote_item_history
      WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(
    `DELETE FROM tbl_quotes_payment_terms
      WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(
    `DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response
      WHERE tbl_rfq_product_tech_evaluation_clauses_id IN (
        SELECT c.id FROM tbl_rfq_product_tech_evaluation_clauses c
          JOIN tbl_rfq_product_tech_evaluation te
            ON te.id = c.tbl_rfq_product_tech_evaluation_id
         WHERE te.rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_rfq_product_tech_evaluation_clauses
      WHERE tbl_rfq_product_tech_evaluation_id IN (
        SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

// ---- fixtures -------------------------------------------------------------

const ts = (msFromNow) =>
  new Date(Date.now() + msFromNow).toISOString().replace("T", " ").slice(0, 19);

/**
 * Published RFQ, bid window OPEN, two products mapped to the vendor. Variant 1
 * carries a technical clause; variant 2 carries none — the same mix as 536289,
 * where 6 of 14 lines were clause-bearing. The gate must refuse the first and
 * pass the second.
 */
async function makeRfqWithOneClausedProduct() {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER,
    status: 1,
    is_published: 1,
    tender_publish_date: ts(-2 * 86400_000),
    vendor_clarification_date: ts(-3600_000),
    bid_end_date: ts(5 * 86400_000),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
    // 536289 was reverse_auction = 0, as are 623 of 675 production RFQs — the
    // exact reason createQuote's old technical check never ran.
    reverse_auction: 0,
  });
  inserted.rfqIds.push(rfq_id);

  const rfqProductIds = {};
  for (const variantId of [1, 2]) {
    const { id } = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfq_id, variantId]
    );
    rfqProductIds[variantId] = id;
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, $2, 'Quantity', '10', 0), ($1, $2, 'Unit', 'NOS', 0)`,
      [rfq_id, variantId]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
       VALUES ($1, $2, $3, 0)`,
      [rfq_id, variantId, VENDOR]
    );
  }

  return { rfq_id, rfq_no, rfqProductIds };
}

async function addTechEvalClause(rfq_id, rfqProductId, { clauseType = "clause" } = {}) {
  const { id: evalId } = await db.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation
       (rfq_id, tbl_rfq_product_id, minimum_passing_score, required_passed_vendors)
     VALUES ($1, $2, 50, 5) RETURNING id`,
    [rfq_id, rfqProductId]
  );
  const { id: clauseId } = await db.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation_clauses
       (tbl_rfq_product_tech_evaluation_id, clause_text, weightage, clause_type)
     VALUES ($1, 'Ocean Brand', 20, $2) RETURNING id`,
    [evalId, clauseType]
  );
  return { evalId, clauseId };
}

/**
 * The regret exactly as createQuote wrote it in the incident: is_regret=1, every
 * line present but zero-priced, no comment, no delivery period.
 */
async function seedRegret(rfq_id, rfq_no, variantIds) {
  const { id: quoteId } = await db.one(
    `INSERT INTO tbl_quotes
       (rfq_id, rfq_no, status, created_by, updated_by, is_regret, regret_reason,
        global_payment_term, global_comment, global_charges, pricing_method)
     VALUES ($1, $2, 1, $3, $3, 1, 'not participating', '', '', '[]'::jsonb, 'TRADITIONAL')
     RETURNING id`,
    [rfq_id, rfq_no, VENDOR]
  );
  for (const variantId of variantIds) {
    await db.none(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, tax, total_price,
          comment, delivery_period, quantity, variant, tax_mode, other_charges, pricing_method)
       VALUES ($1,$2,$3,$4,0,0,0,'','','10',0,'percentage','[]'::jsonb,'TRADITIONAL')`,
      [rfq_id, rfq_no, quoteId, variantId]
    );
  }
  return quoteId;
}

function line(product_id, overrides = {}) {
  return {
    product_id,
    variant: 0,
    unit_price: 230,
    tax: 18,
    tax_mode: "percentage",
    total_price: 2714,
    comment: "",
    delivery_period: "7",
    quantity: "10",
    other_charges: [],
    document_files: [],
    ...overrides,
  };
}

function updateBody(rfq_id, rfq_no, products) {
  return {
    rfq_id,
    rfq_no,
    products,
    globalPaymentTerms: "Net 30",
    globalComment: "all is brand items",
    global_payment_term_list: { createdTerms: [], updatedTerms: [], deletedTerms: [] },
    global_charges: [],
  };
}

async function putQuote(quoteId, body) {
  const client = await httpClient(VENDOR);
  return client.put(`/api/v1/rfq/quote/update/${quoteId}`).send(body);
}

async function answerClause(clauseId, response = "I Agree") {
  await db.none(
    `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
       (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response, "timestamp")
     VALUES ($1, $2, $3, NOW())`,
    [clauseId, VENDOR, response]
  );
}

const storedPrices = (quoteId) =>
  db.any(
    `SELECT product_variant_id, unit_price::float AS unit_price, total_price::float AS total_price
       FROM tbl_quote_items WHERE quote_id = $1 ORDER BY product_variant_id`,
    [quoteId]
  );

// ===========================================================================
//  The incident path
// ===========================================================================

describe("regret → repriced quote, on a product with an unanswered clause", () => {
  it("refuses the conversion, and the stored prices stay at zero", async () => {
    const { rfq_id, rfq_no, rfqProductIds } = await makeRfqWithOneClausedProduct();
    await addTechEvalClause(rfq_id, rfqProductIds[1]);
    const quoteId = await seedRegret(rfq_id, rfq_no, [1, 2]);

    const res = await putQuote(quoteId, updateBody(rfq_id, rfq_no, [line(1), line(2)]));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Technical evaluation must be completed/i);

    // The refusal has to be total: a partial write would leave the buyer with a
    // priced line they still cannot evaluate, which is the deadlock itself.
    const rows = await storedPrices(quoteId);
    expect(rows.map((r) => r.unit_price)).toEqual([0, 0]);
    expect(rows.map((r) => r.total_price)).toEqual([0, 0]);
  });

  it("names the offending product so the vendor knows what to answer", async () => {
    const { rfq_id, rfq_no, rfqProductIds } = await makeRfqWithOneClausedProduct();
    await addTechEvalClause(rfq_id, rfqProductIds[1]);
    const quoteId = await seedRegret(rfq_id, rfq_no, [1, 2]);

    const res = await putQuote(quoteId, updateBody(rfq_id, rfq_no, [line(1), line(2)]));

    expect(res.status).toBe(400);
    // "(0/1 answered)" — the count the vendor needs, not a bare product id.
    expect(res.body.message).toMatch(/0\/1 answered/);
  });

  it("still refuses when only the clause-bearing line is priced", async () => {
    const { rfq_id, rfq_no, rfqProductIds } = await makeRfqWithOneClausedProduct();
    await addTechEvalClause(rfq_id, rfqProductIds[1]);
    const quoteId = await seedRegret(rfq_id, rfq_no, [1, 2]);

    const res = await putQuote(
      quoteId,
      updateBody(rfq_id, rfq_no, [
        line(1),
        line(2, { unit_price: "", total_price: 0, comment: "" }), // not submitting this one
      ])
    );

    expect(res.status).toBe(400);
  });

  it("accepts the conversion once the vendor has answered the clause", async () => {
    const { rfq_id, rfq_no, rfqProductIds } = await makeRfqWithOneClausedProduct();
    const { clauseId } = await addTechEvalClause(rfq_id, rfqProductIds[1]);
    const quoteId = await seedRegret(rfq_id, rfq_no, [1, 2]);

    await answerClause(clauseId);

    const res = await putQuote(quoteId, updateBody(rfq_id, rfq_no, [line(1), line(2)]));

    expect(res.status).toBe(200);
    const rows = await storedPrices(quoteId);
    expect(rows.every((r) => r.unit_price > 0)).toBe(true);
  });
});

// ===========================================================================
//  Which lines the gate is entitled to refuse
// ===========================================================================

describe("the gate refuses only what the vendor is actually submitting", () => {
  it("passes a line whose product carries no technical evaluation", async () => {
    const { rfq_id, rfq_no, rfqProductIds } = await makeRfqWithOneClausedProduct();
    await addTechEvalClause(rfq_id, rfqProductIds[1]);
    const quoteId = await seedRegret(rfq_id, rfq_no, [1, 2]);

    // Only variant 2 — the unclaused product. Of surya's 14 lines the gate had
    // to refuse exactly 6 and pass the other 8; this is that second half.
    const res = await putQuote(
      quoteId,
      updateBody(rfq_id, rfq_no, [
        line(1, { unit_price: "", total_price: 0, comment: "" }),
        line(2),
      ])
    );

    expect(res.status).toBe(200);
    const rows = await storedPrices(quoteId);
    expect(rows.find((r) => r.product_variant_id === 2).unit_price).toBe(230);
    expect(rows.find((r) => r.product_variant_id === 1).unit_price).toBe(0);
  });

  it("does not refuse over a sampling clause — the vendor is never asked those", async () => {
    const { rfq_id, rfq_no, rfqProductIds } = await makeRfqWithOneClausedProduct();
    await addTechEvalClause(rfq_id, rfqProductIds[1], { clauseType: "sampling" });
    const quoteId = await seedRegret(rfq_id, rfq_no, [1, 2]);

    const res = await putQuote(quoteId, updateBody(rfq_id, rfq_no, [line(1), line(2)]));

    expect(res.status).toBe(200);
  });

  it("treats an empty response row as unanswered, not as an answer", async () => {
    // createEmptyVendorResponses plants placeholder rows with vendor_response ''
    // for replacement vendors. A placeholder is not a technical position, so it
    // must not buy passage through the gate.
    const { rfq_id, rfq_no, rfqProductIds } = await makeRfqWithOneClausedProduct();
    const { clauseId } = await addTechEvalClause(rfq_id, rfqProductIds[1]);
    const quoteId = await seedRegret(rfq_id, rfq_no, [1, 2]);

    await answerClause(clauseId, "");

    const res = await putQuote(quoteId, updateBody(rfq_id, rfq_no, [line(1), line(2)]));

    expect(res.status).toBe(400);
  });

  it("treats 'N/A' the same way", async () => {
    const { rfq_id, rfq_no, rfqProductIds } = await makeRfqWithOneClausedProduct();
    const { clauseId } = await addTechEvalClause(rfq_id, rfqProductIds[1]);
    const quoteId = await seedRegret(rfq_id, rfq_no, [1, 2]);

    await answerClause(clauseId, "N/A");

    const res = await putQuote(quoteId, updateBody(rfq_id, rfq_no, [line(1), line(2)]));

    expect(res.status).toBe(400);
  });

  it("refuses a comment-only line too — a comment is a submission", async () => {
    const { rfq_id, rfq_no, rfqProductIds } = await makeRfqWithOneClausedProduct();
    await addTechEvalClause(rfq_id, rfqProductIds[1]);
    const quoteId = await seedRegret(rfq_id, rfq_no, [1, 2]);

    const res = await putQuote(
      quoteId,
      updateBody(rfq_id, rfq_no, [
        line(1, { unit_price: "", total_price: 0, comment: "can supply Ocean equivalent" }),
        line(2, { unit_price: "", total_price: 0, comment: "" }),
      ])
    );

    expect(res.status).toBe(400);
  });

  it("another vendor's answers do not clear this vendor", async () => {
    const { rfq_id, rfq_no, rfqProductIds } = await makeRfqWithOneClausedProduct();
    const { clauseId } = await addTechEvalClause(rfq_id, rfqProductIds[1]);
    const quoteId = await seedRegret(rfq_id, rfq_no, [1, 2]);

    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
         (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response, "timestamp")
       VALUES ($1, $2, 'I Agree', NOW())`,
      [clauseId, IDS.users.vendor_beta]
    );

    const res = await putQuote(quoteId, updateBody(rfq_id, rfq_no, [line(1), line(2)]));

    expect(res.status).toBe(400);
  });
});
