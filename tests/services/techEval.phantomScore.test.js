// A technical evaluation must only ever act on assessments a buyer actually made.
//
// CONFIRMED DEFECT, reproduced from RFQ 536405 (The Orchid Hotel Pune, wallpaper
// installation in the Mirage Wing), reported 27 Aug 2026 by the client.
//
// Nothing in the schema records "this clause has been scored". The production
// queries inferred it by comparing two timestamps on the vendor's answer row:
//
//     score_timestamp IS NOT NULL AND score_timestamp <> timestamp
//
// Both columns take the same value at insert. But the vendor re-submit path runs
// `SET vendor_response = $1, timestamp = NOW()` and never touches
// score_timestamp — so ANY duplicate vendor submission moves `timestamp` past
// `score_timestamp` and permanently marks the clause "scored" at whatever
// buyer_marks holds, which defaults to 0.
//
// On 536405 vendor Sushil Sunil Khot (494) re-submitted the identical "I Agree"
// eight seconds after first submitting (audit_log_temp 89044-89047). He had
// never been shown to a buyer — he never bid, and the grid hides non-bidders.
// The platform recorded him FAILED at 0% against a 60% pass mark, put him in an
// approved round, and then, because a failure existed and the (hardcoded)
// requirement of five passed vendors was unreachable with two bidders, the
// auto-replacement engine substituted ANOTHER vendor who had never bid. That
// vendor now had to be scored before the evaluation could close, so the RFQ
// froze in "technical evaluating" and every resubmit returned HTTP 500.
//
// Across production the inference was wrong on 234 of 2,105 answer rows: 35
// vendor entries technically failed without assessment (9 of them real, priced
// bidders) and 17 technically passed the same way.
//
// The rules these tests pin:
//   1. buyer_id is the record of a human assessment. Timestamps are not.
//   2. A vendor who never submitted a priced quote is never pulled into an
//      evaluation as a replacement.
//   3. When there is nothing left to submit, the evaluator is told why — 400
//      with the reason, never a blanket 500.

import {
  describe, it, expect, afterAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import rfqController from "../../app/controllers/rfq/rfqController.js";
import rfqModel from "../../app/models/rfqModel.js";
import { makeRFQ } from "../factories/rfq.js";
import {
  attachVendorToRfqProduct,
  seedTechEvalWithClauses,
  recordVendorScores,
} from "../factories/techEval.js";

afterAll(async () => {
  await closeDb();
});

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: {
      user: opts.user,
      params: opts.params || {},
      body: opts.body || {},
      query: opts.query || {},
    },
    res,
    next: jest.fn(),
    calls,
  };
}

const inserted = { rfqIds: [] };
beforeEach(() => { inserted.rfqIds = []; });

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  const teRows = await db.any(
    `SELECT te.id, te.tbl_rfq_product_id
       FROM tbl_rfq_product_tech_evaluation te
      WHERE te.rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  const teIds = teRows.map((r) => r.id);

  if (teIds.length) {
    const roundIds = (await db.any(
      `SELECT id FROM tbl_tech_evaluation_rounds
        WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`,
      [teIds]
    )).map((r) => r.id);

    if (roundIds.length) {
      await db.none(
        `DELETE FROM tbl_approval_actions WHERE approval_instance_id IN (
           SELECT id FROM tbl_approval_instances
            WHERE entity_type='TECHNICAL' AND entity_id = ANY($1::int[]))`,
        [roundIds]
      );
      await db.none(
        `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
           SELECT s.id FROM tbl_approval_instance_steps s
            JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
           WHERE i.entity_type='TECHNICAL' AND i.entity_id = ANY($1::int[]))`,
        [roundIds]
      );
      await db.none(
        `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (
           SELECT id FROM tbl_approval_instances
            WHERE entity_type='TECHNICAL' AND entity_id = ANY($1::int[]))`,
        [roundIds]
      );
      await db.none(
        `DELETE FROM tbl_tech_evaluation_rounds WHERE id = ANY($1::int[])`,
        [roundIds]
      );
      await db.none(
        `DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors
          WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`,
        [teIds]
      );
      await db.none(
        `DELETE FROM tbl_approval_instances
          WHERE entity_type='TECHNICAL' AND entity_id = ANY($1::int[])`,
        [roundIds]
      );
    }
    await db.none(
      `DELETE FROM tbl_tech_evaluation_rounds
        WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`,
      [teIds]
    );

    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors
        WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`,
      [teIds]
    );
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response
        WHERE tbl_rfq_product_tech_evaluation_clauses_id IN (
          SELECT id FROM tbl_rfq_product_tech_evaluation_clauses
           WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[]))`,
      [teIds]
    );
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_clauses
        WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`,
      [teIds]
    );
  }

  await db.none(
    `DELETE FROM tbl_rfq_product_tech_eval_vendor_replacements WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_quote_items WHERE quote_id IN (
                   SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  inserted.rfqIds = [];
});

// ---------------------------------------------------------------------------
//  Setup helpers — all shapes taken from RFQ 536405
// ---------------------------------------------------------------------------

const PRODUCT_VARIANT = 1;

async function makeRfqWithProduct(overrides = {}) {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
  const fiveDaysHence = new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    tender_publish_date: oneDayAgo,
    vendor_clarification_date: oneHourAgo,
    bid_end_date: fiveDaysHence,
    ...overrides,
  });
  inserted.rfqIds.push(rfq_id);
  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0)
     RETURNING id`,
    [rfq_id, PRODUCT_VARIANT]
  );
  return { rfq_id, rfq_product_id: product.id };
}

/**
 * The exact production shape that forged a score: the vendor answered every
 * clause, then re-submitted, which bumped `timestamp` past `score_timestamp`.
 * No buyer ever touched these rows — buyer_id is NULL, buyer_marks is 0.
 */
async function vendorAnsweredThenResubmitted({ clause_ids, vendor_id }) {
  for (const clause_id of clause_ids) {
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
         (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response,
          buyer_id, buyer_marks, score_timestamp, "timestamp")
       VALUES ($1, $2, 'I Agree', NULL, 0, NOW(), NOW())`,
      [clause_id, vendor_id]
    );
  }
  // The re-submit, eight seconds later. Only `timestamp` moves.
  await db.none(
    `UPDATE tbl_rfq_product_tech_evaluation_vendors_response
        SET vendor_response = 'I Agree', "timestamp" = score_timestamp + INTERVAL '8 seconds'
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = ANY($1::int[])
        AND vendor_id = $2`,
    [clause_ids, vendor_id]
  );
}

/** A vendor who answered the clauses once and was never scored or re-submitted. */
async function vendorAnsweredOnly({ clause_ids, vendor_id }) {
  for (const clause_id of clause_ids) {
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
         (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response,
          buyer_id, buyer_marks, score_timestamp, "timestamp")
       VALUES ($1, $2, 'I Agree', NULL, 0, NOW(), NOW())`,
      [clause_id, vendor_id]
    );
  }
}

async function submitPricedQuote({ rfq_id, vendor_id, total_price = 100000 }) {
  const rfq = await db.one(`SELECT rfq_no FROM tbl_rfq WHERE id = $1`, [rfq_id]);
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, is_regret)
     VALUES ($1, $2, 1, $3, $3, 0) RETURNING id`,
    [rfq_id, rfq.rfq_no, vendor_id]
  );
  await db.none(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, variant, quantity,
        unit_price, total_price, comment, delivery_period, pricing_method)
     VALUES ($1, $2, $3, $4, 0, '1', $5, $5, '', '7 days', 'TRADITIONAL')`,
    [rfq_id, rfq.rfq_no, quote.id, PRODUCT_VARIANT, total_price]
  );
  return quote.id;
}

// ===========================================================================
//  1. buyer_id is the record of an assessment. A timestamp is not.
// ===========================================================================
describe("what counts as a scored clause", () => {
  it("does not treat a vendor's re-submission as a buyer's assessment", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct();
    const { eval_id, clause_ids } = await seedTechEvalWithClauses({
      rfq_id, rfq_product_id, weightages: [25, 25, 25, 25], minimum_passing_score: 60,
    });
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_gamma,
    });
    await vendorAnsweredThenResubmitted({ clause_ids, vendor_id: IDS.users.vendor_gamma });

    const scores = await rfqModel.getVendorScoresForTechEval(eval_id, 60);
    const gamma = scores.find((s) => s.vendor_id === IDS.users.vendor_gamma);

    expect(gamma).toBeDefined();
    // Nobody scored this vendor, so there is no verdict to report.
    expect(gamma.is_fully_evaluated).toBe(false);
    expect(gamma.has_marks).toBe(false);
    expect(gamma.is_passed).toBeNull();
    expect(Number(gamma.evaluated_clauses_count)).toBe(0);
  });

  it("counts a buyer's marks even when both timestamps happen to match", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct();
    const { eval_id, clause_ids } = await seedTechEvalWithClauses({
      rfq_id, rfq_product_id, weightages: [50, 50], minimum_passing_score: 60,
    });
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_alpha,
    });
    for (const clause_id of clause_ids) {
      await db.none(
        `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
           (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response,
            buyer_id, buyer_marks, score_timestamp, "timestamp")
         VALUES ($1, $2, 'OK', $3, 40, NOW(), NOW())`,
        [clause_id, IDS.users.vendor_alpha, IDS.users.a1_proc_buyer]
      );
    }

    const scores = await rfqModel.getVendorScoresForTechEval(eval_id, 60);
    const alpha = scores.find((s) => s.vendor_id === IDS.users.vendor_alpha);

    // 80/100 = 80% — a real assessment, recorded in the same instant the row
    // was created (the sampling-clause insert path does exactly this).
    expect(alpha.is_fully_evaluated).toBe(true);
    expect(Number(alpha.calculated_score)).toBe(80);
    expect(alpha.is_passed).toBe(true);
  });

  it("reports a vendor as partly evaluated when only some clauses were marked", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct();
    const { eval_id, clause_ids } = await seedTechEvalWithClauses({
      rfq_id, rfq_product_id, weightages: [50, 50], minimum_passing_score: 60,
    });
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_beta,
    });
    await recordVendorScores({
      vendor_id: IDS.users.vendor_beta,
      buyer_id: IDS.users.a1_proc_buyer,
      marksByClause: { [clause_ids[0]]: 45 },
    });
    await vendorAnsweredOnly({ clause_ids: [clause_ids[1]], vendor_id: IDS.users.vendor_beta });

    const scores = await rfqModel.getVendorScoresForTechEval(eval_id, 60);
    const beta = scores.find((s) => s.vendor_id === IDS.users.vendor_beta);

    expect(beta.has_marks).toBe(true);
    expect(beta.is_fully_evaluated).toBe(false);
    expect(beta.is_passed).toBeNull();
  });
});

// ===========================================================================
//  2. The round carries only the vendors a buyer actually judged.
// ===========================================================================
describe("submitTechEvalForApproval — which vendors reach the round", () => {
  it("leaves an unassessed re-submitter out of the round instead of failing them", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct();
    const { eval_id, clause_ids } = await seedTechEvalWithClauses({
      rfq_id, rfq_product_id, weightages: [25, 25, 25, 25], minimum_passing_score: 60,
    });

    // The two vendors who bid and were scored 76/100 — as on RFQ 536405.
    for (const vendor_id of [IDS.users.vendor_alpha, IDS.users.vendor_beta]) {
      await attachVendorToRfqProduct({ rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id });
      await submitPricedQuote({ rfq_id, vendor_id });
      await recordVendorScores({
        vendor_id,
        buyer_id: IDS.users.a1_proc_buyer,
        marksByClause: {
          [clause_ids[0]]: 25, [clause_ids[1]]: 25, [clause_ids[2]]: 25, [clause_ids[3]]: 1,
        },
      });
    }
    // The vendor who never bid, was never shown to the buyer, and re-submitted.
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_gamma,
    });
    await vendorAnsweredThenResubmitted({ clause_ids, vendor_id: IDS.users.vendor_gamma });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, rfq_product_id },
    });
    await rfqController.submitTechEvalForApproval(m.req, m.res);

    expect(m.calls.status).toBe(200);
    const round = await db.one(
      `SELECT round_number, passed_count, failed_count, vendors_evaluated
         FROM tbl_tech_evaluation_rounds
        WHERE tbl_rfq_product_tech_evaluation_id = $1`,
      [eval_id]
    );
    expect(round.passed_count).toBe(2);
    // The bug put gamma here as a FAILED vendor at 0%.
    expect(round.failed_count).toBe(0);
    const judged = round.vendors_evaluated.map((v) => v.vendor_id);
    expect(judged.sort()).toEqual([IDS.users.vendor_alpha, IDS.users.vendor_beta].sort());
    expect(judged).not.toContain(IDS.users.vendor_gamma);
  });

  it("records no rejection against a vendor no buyer assessed", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct();
    const { eval_id, clause_ids } = await seedTechEvalWithClauses({
      rfq_id, rfq_product_id, weightages: [25, 25, 25, 25], minimum_passing_score: 60,
    });
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_alpha,
    });
    await submitPricedQuote({ rfq_id, vendor_id: IDS.users.vendor_alpha });
    await recordVendorScores({
      vendor_id: IDS.users.vendor_alpha,
      buyer_id: IDS.users.a1_proc_buyer,
      marksByClause: Object.fromEntries(clause_ids.map((c) => [c, 25])),
    });
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_gamma,
    });
    await vendorAnsweredThenResubmitted({ clause_ids, vendor_id: IDS.users.vendor_gamma });

    const submit = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, rfq_product_id },
    });
    await rfqController.submitTechEvalForApproval(submit.req, submit.res);
    expect(submit.calls.status).toBe(200);

    const approve = mockExpress({
      user: { id: IDS.users.a1_proc_techApp },
      body: {
        approval_instance_id: submit.calls.body.data.approval_instance_id,
        action: "APPROVE",
        comment: "ok",
      },
    });
    await rfqController.techEvalApprovalAction(approve.req, approve.res);
    expect(approve.calls.status).toBe(200);

    const verdicts = await db.any(
      `SELECT vendor_id, status, reject_message
         FROM tbl_rfq_product_tech_evaluation_cleared_vendors
        WHERE tbl_rfq_product_tech_evaluation_id = $1`,
      [eval_id]
    );
    expect(verdicts.map((v) => v.vendor_id)).toEqual([IDS.users.vendor_alpha]);
    expect(verdicts[0].status).toBe(1);
  });
});

// ===========================================================================
//  3. The evaluation closes instead of hunting for a vendor it cannot judge.
// ===========================================================================
describe("after approval, with every bidder assessed", () => {
  it("completes the evaluation rather than substituting a vendor who never bid", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct();
    const { eval_id, clause_ids } = await seedTechEvalWithClauses({
      rfq_id, rfq_product_id, weightages: [25, 25, 25, 25], minimum_passing_score: 60,
    });
    for (const vendor_id of [IDS.users.vendor_alpha, IDS.users.vendor_beta]) {
      await attachVendorToRfqProduct({ rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id });
      await submitPricedQuote({ rfq_id, vendor_id });
      await recordVendorScores({
        vendor_id,
        buyer_id: IDS.users.a1_proc_buyer,
        marksByClause: Object.fromEntries(clause_ids.map((c) => [c, 25])),
      });
    }
    // Two non-bidders holding clause answers — one re-submitted, one did not.
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_gamma,
    });
    await vendorAnsweredThenResubmitted({ clause_ids, vendor_id: IDS.users.vendor_gamma });
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_delta,
    });
    await vendorAnsweredOnly({ clause_ids, vendor_id: IDS.users.vendor_delta });

    const submit = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, rfq_product_id },
    });
    await rfqController.submitTechEvalForApproval(submit.req, submit.res);
    expect(submit.calls.status).toBe(200);

    const approve = mockExpress({
      user: { id: IDS.users.a1_proc_techApp },
      body: {
        approval_instance_id: submit.calls.body.data.approval_instance_id,
        action: "APPROVE",
        comment: "ok",
      },
    });
    await rfqController.techEvalApprovalAction(approve.req, approve.res);
    expect(approve.calls.status).toBe(200);

    const te = await db.one(
      `SELECT is_complete, current_round, total_passed_verified
         FROM tbl_rfq_product_tech_evaluation WHERE id = $1`,
      [eval_id]
    );
    // Both bidders passed and there is no third bidder to judge, so the
    // evaluation is finished. The bug left is_complete false and bumped
    // current_round to 2 in pursuit of five passed vendors it could never find.
    expect(te.is_complete).toBe(true);
    expect(te.current_round).toBe(1);
    expect(te.total_passed_verified).toBe(2);

    const replacements = await db.any(
      `SELECT old_vendor_id, new_vendor_id
         FROM tbl_rfq_product_tech_eval_vendor_replacements WHERE rfq_id = $1`,
      [rfq_id]
    );
    expect(replacements).toEqual([]);
  });

  it("does not offer a non-bidder as a replacement for a vendor who genuinely failed", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct();
    const { eval_id, clause_ids } = await seedTechEvalWithClauses({
      rfq_id, rfq_product_id, weightages: [50, 50], minimum_passing_score: 60,
    });
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_alpha,
    });
    await submitPricedQuote({ rfq_id, vendor_id: IDS.users.vendor_alpha });
    await recordVendorScores({
      vendor_id: IDS.users.vendor_alpha,
      buyer_id: IDS.users.a1_proc_buyer,
      marksByClause: Object.fromEntries(clause_ids.map((c) => [c, 10])), // 20% — fails
    });
    // Available in the reserve pool only because they answered clauses.
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_gamma,
    });
    await vendorAnsweredOnly({ clause_ids, vendor_id: IDS.users.vendor_gamma });

    const reserves = await rfqModel.getReserveTechEvalVendors(
      eval_id, rfq_id, rfq_product_id, [IDS.users.vendor_alpha], 10
    );

    expect(reserves.map((v) => v.vendor_id)).not.toContain(IDS.users.vendor_gamma);
  });

  it("still offers a reserve vendor who did submit a priced quote", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct();
    const { eval_id, clause_ids } = await seedTechEvalWithClauses({
      rfq_id, rfq_product_id, weightages: [50, 50], minimum_passing_score: 60,
    });
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_alpha,
    });
    await submitPricedQuote({ rfq_id, vendor_id: IDS.users.vendor_alpha });
    await recordVendorScores({
      vendor_id: IDS.users.vendor_alpha,
      buyer_id: IDS.users.a1_proc_buyer,
      marksByClause: Object.fromEntries(clause_ids.map((c) => [c, 10])),
    });
    // A real bidder waiting in reserve — must remain available.
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_beta,
    });
    await submitPricedQuote({ rfq_id, vendor_id: IDS.users.vendor_beta, total_price: 120000 });
    await vendorAnsweredOnly({ clause_ids, vendor_id: IDS.users.vendor_beta });

    const reserves = await rfqModel.getReserveTechEvalVendors(
      eval_id, rfq_id, rfq_product_id, [IDS.users.vendor_alpha], 10
    );

    expect(reserves.map((v) => v.vendor_id)).toContain(IDS.users.vendor_beta);
  });
});

// ===========================================================================
//  4. A refusal must arrive as a refusal.
// ===========================================================================
describe("submitTechEvalForApproval — nothing new to submit", () => {
  it("answers 400 with the reason, not 500 with a blanket message", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct();
    const { eval_id, clause_ids } = await seedTechEvalWithClauses({
      rfq_id, rfq_product_id, weightages: [50, 50], minimum_passing_score: 60,
    });
    // A bidder the buyer scored below the pass mark.
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_alpha,
    });
    await submitPricedQuote({ rfq_id, vendor_id: IDS.users.vendor_alpha });
    await recordVendorScores({
      vendor_id: IDS.users.vendor_alpha,
      buyer_id: IDS.users.a1_proc_buyer,
      marksByClause: Object.fromEntries(clause_ids.map((c) => [c, 10])), // 20% — fails
    });
    // A second bidder waiting in reserve, with answers but no marks yet. The
    // replacement engine will legitimately promote them after round 1.
    await attachVendorToRfqProduct({
      rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: IDS.users.vendor_beta,
    });
    await submitPricedQuote({ rfq_id, vendor_id: IDS.users.vendor_beta, total_price: 120000 });
    await vendorAnsweredOnly({ clause_ids, vendor_id: IDS.users.vendor_beta });

    const first = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, rfq_product_id },
    });
    await rfqController.submitTechEvalForApproval(first.req, first.res);
    expect(first.calls.status).toBe(200);

    const approve = mockExpress({
      user: { id: IDS.users.a1_proc_techApp },
      body: {
        approval_instance_id: first.calls.body.data.approval_instance_id,
        action: "APPROVE",
        comment: "ok",
      },
    });
    await rfqController.techEvalApprovalAction(approve.req, approve.res);
    expect(approve.calls.status).toBe(200);

    // Round 2 is open, but the buyer has not scored the promoted vendor yet.
    // Submitting is a valid no-op and must say so. In production this fell
    // through to a 500 because the handler substring-matched the message
    // "No vendors have been evaluated" against "No NEW vendors have been...".
    const second = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, rfq_product_id },
    });
    await rfqController.submitTechEvalForApproval(second.req, second.res);

    expect(second.calls.status).toBe(400);
    expect(second.calls.body.message).not.toMatch(/^Error submitting/i);
    expect(second.calls.body.message).toMatch(/score at least one vendor/i);

    // And no phantom second round was opened.
    const rounds = await db.any(
      `SELECT id FROM tbl_tech_evaluation_rounds
        WHERE tbl_rfq_product_tech_evaluation_id = $1`,
      [eval_id]
    );
    expect(rounds).toHaveLength(1);
  });
});
