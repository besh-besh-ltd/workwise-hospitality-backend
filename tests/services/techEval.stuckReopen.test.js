// A technical evaluation in which nobody passed must not be a permanent dead end.
//
// CONFIRMED DEFECT, reproduced from RFQ #536894 (tbl_rfq 1488, tech eval 537),
// Oct 2026. One line, five clauses (one of them `sampling`), minimum passing
// score 100%. Two vendors quoted and answered; the buyer scored them 80% and
// 72%. A third vendor answered every clause but never quoted.
//
// Round 1 (tbl_tech_evaluation_rounds 404) carried the two quoted vendors and
// was approved. handleTechnicalPostApproval then looked for a replacement; the
// reserve and next-vendor lookups both require a priced quote, so it found
// none and wrote
//
//     is_complete = TRUE, blocked_insufficient_vendors = TRUE,
//     total_passed_verified = 0
//
// and nothing anywhere ever set is_complete back. Submitting again answered
// TECH_EVAL_ALREADY_COMPLETE, the grid locked, and the banner told the buyer to
// "extend the deadline and refresh vendors". The client extended the deadline
// (the restricted edit is unlocked for exactly this state) and the RFQ stayed
// stuck: extending changed bid_end_date and nothing else.
//
// What these tests pin, over real HTTP and real Postgres:
//   1. Stuck means stuck NOW: blocked, nobody passed, bidding closed, and no
//      vendor waiting to be evaluated. It is one predicate used by every screen.
//   2. Extending the deadline on a stuck line reopens its evaluation in the
//      same transaction, and leaves every approved verdict alone.
//   3. A vendor who quotes in the new window is evaluated in the next round,
//      and if they pass the line reaches commercial evaluation.
//   4. No new dead end: a reopened line nobody quotes on is stuck again, and
//      editable again, so the buyer can extend once more.
//   5. A line that is not stuck is never reopened.
//   6. An empty or ISO-form bid_end_date never breaks the predicate.
//   7. An evaluation locked before this fix (blocked, nobody passed,
//      is_complete still TRUE) is recoverable: an extension reopens it, and a
//      vendor waiting to be evaluated can be submitted without one.
//
// Vendors quote through SQL here: createQuote gates on user_type (3, 4) and the
// shared fixture vendors deliberately carry user_type NULL (see the note in
// techEval.regretConversionGate.test.js). Everything the BUYER and APPROVER do
// goes through the real endpoints.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import rfqModel from "../../app/models/rfqModel.js";

const BUYER = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_techApp;
const EVALUATOR = IDS.users.a1_proc_techEval;
const A = IDS.users.vendor_alpha;
const B = IDS.users.vendor_beta;
const C = IDS.users.vendor_gamma;
const D = IDS.users.vendor_delta;
const VARIANT = 1;
const TAG = "TE-STUCK-REOPEN";

const stamped = {};

beforeAll(async () => {
  // acl([2, 8]) guards submit, status and edit (and acl([2, 3, 8, 9, 10]) the
  // sidebar). Fixture users carry user_type NULL, so stamp the buyer-side
  // actors as Buyers for this file only.
  for (const id of [BUYER, APPROVER, EVALUATOR]) {
    stamped[id] = (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [id])).user_type;
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [id]);
  }
});

afterAll(async () => {
  for (const [id, type] of Object.entries(stamped)) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [Number(id), type]);
  }
  await closeDb();
});

const inserted = { rfqIds: [] };
beforeEach(() => { inserted.rfqIds = []; });

afterEach(async () => {
  const rfqIds = inserted.rfqIds;
  if (!rfqIds.length) return;
  const tes = await db.any(
    `SELECT id, tbl_rfq_product_id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[])`,
    [rfqIds]
  );
  const teIds = tes.map((r) => r.id);
  const productIds = (await db.any(`SELECT id FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]))
    .map((r) => r.id);
  const instanceIds = (await db.any(
    `SELECT id FROM tbl_approval_instances
      WHERE entity_type = 'TECHNICAL' AND (metadata->>'rfq_id')::int = ANY($1::int[])`,
    [rfqIds]
  )).map((r) => r.id);

  if (teIds.length) {
    await db.none(`DELETE FROM tbl_tech_evaluation_rounds WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`, [teIds]);
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`, [teIds]);
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response
        WHERE tbl_rfq_product_tech_evaluation_clauses_id IN (
          SELECT id FROM tbl_rfq_product_tech_evaluation_clauses
           WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[]))`,
      [teIds]
    );
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation_clauses WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`, [teIds]);
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE id = ANY($1::int[])`, [teIds]);
  }
  if (instanceIds.length) {
    // steps / actions cascade from the instance.
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [instanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
  }
  await db.none(`DELETE FROM tbl_rfq_product_tech_eval_vendor_replacements WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  if (productIds.length) {
    await db.none(
      `DELETE FROM tbl_lifecycle_history WHERE entity_type = 'TECHNICAL' AND entity_id = ANY($1::int[])`,
      [productIds]
    );
  }
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type IN ('RFQ', 'TENDER') AND entity_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_change_history WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
  inserted.rfqIds = [];
});

// ---------------------------------------------------------------------------
//  Time — bid_end_date is naive IST wall-clock text.
// ---------------------------------------------------------------------------

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** IST wall-clock, `YYYY-MM-DD HH:mm:ss`. */
function ist(offsetMs) {
  return new Date(Date.now() + offsetMs + 5.5 * HOUR).toISOString().replace("T", " ").slice(0, 19);
}
/** IST wall-clock in the datetime-local form the edit form sends: `YYYY-MM-DDTHH:mm`. */
function istIsoLocal(offsetMs) {
  return new Date(Date.now() + offsetMs + 5.5 * HOUR).toISOString().slice(0, 16);
}

// ---------------------------------------------------------------------------
//  The RFQ 536894 shape
// ---------------------------------------------------------------------------

/**
 * One tech-eval line: four 25-mark clauses plus one 25-mark sampling clause
 * (125 marks), minimum passing score 100%. Vendors A and B quoted and answered;
 * vendor C answered every clause and did not quote.
 */
async function seedIncidentRfq({ bidEnd = ist(-DAY), quoted = [A, B], answeredOnly = [C], disagree = [] } = {}) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER,
    status: 1,
    is_published: 1,
    tender_publish_date: ist(-5 * DAY),
    vendor_clarification_date: ist(-4 * DAY),
    bid_end_date: bidEnd,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
    title: `${TAG} ${Date.now()}`,
  });
  inserted.rfqIds.push(rfq_id);
  await db.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
    [rfq_id, IDS.hotels.A1, BUYER]
  );
  const { id: rfq_product_id } = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
    [rfq_id, VARIANT]
  );
  await db.none(
    `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
     VALUES ($1, $2, 'Quantity', '10', 0), ($1, $2, 'Unit', 'NOS', 0)`,
    [rfq_id, VARIANT]
  );
  const { id: eval_id } = await db.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation
       (rfq_id, tbl_rfq_product_id, minimum_passing_score, required_passed_vendors)
     VALUES ($1, $2, 100, 5) RETURNING id`,
    [rfq_id, rfq_product_id]
  );
  const clause_ids = [];
  for (const [text, type] of [
    ["Brand as specified", "clause"],
    ["Warranty 2 years", "clause"],
    ["ISI marked", "clause"],
    ["Delivery within 15 days", "clause"],
    ["Physical sample", "sampling"],
  ]) {
    const { id } = await db.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation_clauses
         (tbl_rfq_product_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1, $2, 25, $3) RETURNING id`,
      [eval_id, text, type]
    );
    clause_ids.push(id);
  }
  const shape = { rfq_id, rfq_no, rfq_product_id, eval_id, clause_ids, sampling_id: clause_ids[4] };
  for (const v of [...quoted, ...answeredOnly]) {
    await invite(shape, v);
    await answerClauses(shape, v, { disagreeFirst: disagree.includes(v) });
  }
  for (const v of quoted) await quote(shape, v);
  return shape;
}

async function invite({ rfq_id }, vendor_id) {
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, VARIANT, vendor_id]
  );
}

/**
 * The vendor answers every clause they are asked — the sampling clause is never
 * put to them. `disagreeFirst` stores prod's negative ('I Dont Agree') on clause 1.
 */
async function answerClauses({ clause_ids }, vendor_id, { disagreeFirst = false } = {}) {
  for (const [i, clause_id] of clause_ids.slice(0, 4).entries()) {
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
         (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response, "timestamp")
       VALUES ($1, $2, $3, NOW())`,
      [clause_id, vendor_id, disagreeFirst && i === 0 ? "I Dont Agree" : "I Agree"]
    );
  }
}

/** A priced, non-regret quote for the line — the shape createQuote writes. */
async function quote({ rfq_id, rfq_no }, vendor_id, total_price = 100000) {
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, is_regret)
     VALUES ($1, $2, 1, $3, $3, 0) RETURNING id`,
    [rfq_id, rfq_no, vendor_id]
  );
  await db.none(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, variant, quantity,
        unit_price, total_price, comment, delivery_period, pricing_method)
     VALUES ($1, $2, $3, $4, 0, '10', $5, $5, '', '7 days', 'TRADITIONAL')`,
    [rfq_id, rfq_no, q.id, VARIANT, total_price]
  );
}

/** Time passes: the bidding window shuts. */
async function closeBidding({ rfq_id }) {
  await db.none(`UPDATE tbl_rfq SET bid_end_date = $2 WHERE id = $1`, [rfq_id, ist(-HOUR)]);
}

// ---------------------------------------------------------------------------
//  The buyer and the approver, over HTTP
// ---------------------------------------------------------------------------

/** Buyer scores all five clauses (the sampling row is created by this call). */
async function score(shape, vendor_id, marks) {
  const client = await httpClient(BUYER);
  for (let i = 0; i < shape.clause_ids.length; i++) {
    const res = await client.post("/api/v1/rfq/update-buyer-marks").send({
      clause_id: shape.clause_ids[i],
      vendor_id,
      buyer_marks: marks[i],
      ...(shape.clause_ids[i] === shape.sampling_id ? { buyer_remark: "sample checked" } : {}),
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
  }
}

async function submit({ rfq_id, rfq_product_id }) {
  const client = await httpClient(BUYER);
  return client.post("/api/v1/rfq/tech-eval/submit-for-approval").send({ rfq_id, rfq_product_id });
}

async function approve(approval_instance_id) {
  const client = await httpClient(APPROVER);
  const res = await client.post("/api/v1/rfq/tech-eval/approval/action").send({
    approval_instance_id, action: "APPROVE", comment: "ok",
  });
  expect(res.status).toBe(200);
  expect(res.body.data.instance_status).toBe("APPROVED");
  return res;
}

/** Submit + approve one round, returning the round number the server assigned. */
async function runRound(shape) {
  const res = await submit(shape);
  expect(res.status).toBe(200);
  await approve(res.body.data.approval_instance_id);
  return res.body.data.round_number;
}

async function status({ rfq_product_id }) {
  const client = await httpClient(BUYER);
  const res = await client.get(`/api/v1/rfq/tech-eval/status/${rfq_product_id}`);
  expect(res.status).toBe(200);
  return res.body.data;
}

async function rfqView({ rfq_id }) {
  const client = await httpClient(BUYER);
  const res = await client.get(`/api/v1/rfq/getRfqById/${rfq_id}`);
  expect(res.status).toBe(200);
  return res.body.data;
}

async function listRow({ rfq_id }) {
  const client = await httpClient(BUYER);
  const res = await client.post("/api/v1/rfq/list-view").send({ tab: "all", search: TAG, limit: 100 });
  expect(res.status).toBe(200);
  return res.body.data.rows.find((r) => Number(r.id) === rfq_id);
}

/** The snapshot the edit form sends (see vendorNetwork.rfqRouting.test.js). */
async function editSnapshot(rfq_id) {
  const snap = JSON.parse(JSON.stringify(await rfqModel.getFullRfqForEdit(rfq_id)));
  const idOf = (v) => (v && typeof v === "object" ? Number(v.user_id ?? v.terms_id ?? v.term_id ?? v.id) : v);
  snap.terms = (snap.terms || []).map(idOf);
  for (const p of snap.products) {
    p.vendors = (p.vendors || []).map(idOf);
    delete p.routed_vendors;
  }
  return snap;
}

async function edit({ rfq_id }, changes) {
  const snap = await editSnapshot(rfq_id);
  const client = await httpClient(BUYER);
  return client.put("/api/v1/rfq/update").send({ rfq_id, snapshot: { ...snap, ...changes } });
}

async function evaluatorQueue() {
  const client = await httpClient(EVALUATOR);
  const res = await client.get("/api/v1/dashboard-v2/my-tech-evals-pending").query({ hotel_ids: String(IDS.hotels.A1) });
  expect(res.status).toBe(200);
  return res.body.data.items.map((i) => i.id);
}

async function disagreementQueue() {
  const client = await httpClient(EVALUATOR);
  const res = await client.get("/api/v1/dashboard-v2/tech-evals-with-disagreements").query({ hotel_ids: String(IDS.hotels.A1) });
  expect(res.status).toBe(200);
  return res.body.data.items.map((i) => i.id);
}

async function disagreementListIds() {
  const client = await httpClient(BUYER);
  const res = await client.post("/api/v1/rfq/list-view")
    .send({ tab: "all", search: TAG, limit: 100, filters: { vendor_disagreement: true } });
  expect(res.status).toBe(200);
  return res.body.data.rows.map((r) => Number(r.id));
}

/** The technical-evaluation sidebar list (GET /rfq/get-rfqs?tech_eval=true) — te.read holders only. */
async function techEvalSidebarRow({ rfq_id }) {
  const client = await httpClient(EVALUATOR);
  const res = await client.get("/api/v1/rfq/get-rfqs").query({ page: 1, limit: 100, tech_eval: true, search: TAG });
  expect(res.status).toBe(200);
  return res.body.data.find((r) => Number(r.id) === rfq_id);
}

/** An evaluation locked as complete before the keep-open rule existed. */
const lockAsComplete = ({ eval_id }) =>
  db.none(`UPDATE tbl_rfq_product_tech_evaluation SET is_complete = TRUE WHERE id = $1`, [eval_id]);

async function commercialVendors({ rfq_id }) {
  const client = await httpClient(BUYER);
  const res = await client.get(`/api/v1/rfq/quote-compare/${rfq_id}`);
  expect(res.status).toBe(200);
  expect(res.body.meta.quoteVisibility.locked).toBe(false);
  // created_by sits on the quotation or on its quote_details, depending on shape
  // (quoteCompareService.mergedQuoteRow).
  const vendorOf = (q) => {
    const d = Array.isArray(q.quote_details) ? q.quote_details[0] : q.quote_details;
    return Number(q.created_by ?? d?.created_by);
  };
  return [...new Set(res.body.data.products.flatMap((p) => (p.quotations || []).map(vendorOf)))].sort();
}

const evalRow = ({ eval_id }) => db.one(
  `SELECT is_complete, blocked_insufficient_vendors, total_passed_verified, current_round
     FROM tbl_rfq_product_tech_evaluation WHERE id = $1`,
  [eval_id]
);

const verdicts = ({ eval_id }) => db.any(
  `SELECT vendor_id, status, is_verified, evaluation_round, calculated_score::float AS calculated_score,
          approval_instance_id, reject_message
     FROM tbl_rfq_product_tech_evaluation_cleared_vendors
    WHERE tbl_rfq_product_tech_evaluation_id = $1
    ORDER BY vendor_id`,
  [eval_id]
);

const rounds = ({ eval_id }) => db.any(
  `SELECT round_number, status, passed_count, failed_count, vendors_evaluated, approval_instance_id
     FROM tbl_tech_evaluation_rounds
    WHERE tbl_rfq_product_tech_evaluation_id = $1
    ORDER BY round_number`,
  [eval_id]
);

const reopenEvents = ({ rfq_product_id }) => db.any(
  `SELECT stage, action, remarks, metadata
     FROM tbl_lifecycle_history
    WHERE entity_type = 'TECHNICAL' AND entity_id = $1 AND action = 'REOPEN'
    ORDER BY id`,
  [rfq_product_id]
);

// 80% = 100/125 and 72% = 90/125, as on 536894. 100% = 125/125.
const MARKS_80 = [20, 20, 20, 20, 20];
const MARKS_72 = [18, 18, 18, 18, 18];
const MARKS_100 = [25, 25, 25, 25, 25];

/** Round 1 exactly as on 536894: A 80%, B 72%, C answered but not quoted. */
async function reachIncidentState(opts) {
  const shape = await seedIncidentRfq(opts);
  await score(shape, A, MARKS_80);
  await score(shape, B, MARKS_72);
  const round = await runRound(shape);
  expect(round).toBe(1);
  return shape;
}

// ===========================================================================
//  The incident, end to end
// ===========================================================================

describe("RFQ 536894 — a line where nobody passed", () => {
  it("is stuck after round 1: the status, the lifecycle, the listing and the edit unlock agree", async () => {
    const shape = await reachIncidentState();

    const te = await evalRow(shape);
    expect(te).toMatchObject({ is_complete: true, blocked_insufficient_vendors: true, total_passed_verified: 0 });

    const s = await status(shape);
    expect(s.is_stuck).toBe(true);
    expect(s.bid_window_open).toBe(false);
    expect(s.reopened).toBe(false);
    // C answered but never quoted, so C cannot be evaluated.
    expect(s.eligible_unscored_vendors).toEqual([]);

    const view = await rfqView(shape);
    expect(view.lifecycle_stage).toBe("RFQ_STUCK_TECHNICAL");
    expect(view.has_tech_stuck_product).toBe(true);
    expect(view.products[0].is_tech_stuck).toBe(true);

    const row = await listRow(shape);
    expect(row.has_tech_stuck_product).toBe(true);
    expect(row.pending_reasons.map((r) => r.label)).toContain("No vendor passed — extend deadline or close");

    // Nothing for an evaluator to do.
    expect(await evaluatorQueue()).not.toContain(shape.eval_id);

    // Nothing to submit: the lock stays.
    const resubmit = await submit(shape);
    expect(resubmit.status).toBe(400);
    expect(resubmit.body.code).toBe("TECH_EVAL_ALREADY_COMPLETE");

    // Restricted edit: alongside a valid new deadline, any other field is
    // refused — and the refused edit reopens nothing (one transaction).
    const res = await edit(shape, { comment: "anything else", bid_end_date: istIsoLocal(3 * DAY) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Restricted edit/i);
    expect((await evalRow(shape)).is_complete).toBe(true);
    expect(await reopenEvents(shape)).toEqual([]);
  });

  it("extending the deadline reopens the evaluation and leaves round 1's verdicts alone", async () => {
    const shape = await reachIncidentState();
    const verdictsBefore = await verdicts(shape);
    const roundsBefore = await rounds(shape);
    expect(verdictsBefore.map((v) => [v.vendor_id, v.status])).toEqual([[A, 0], [B, 0]]);

    const res = await edit(shape, { bid_end_date: istIsoLocal(3 * DAY) });
    expect(res.status).toBe(200);

    const te = await evalRow(shape);
    expect(te.is_complete).toBe(false);
    // Reopening keeps the block and the round counter; only the lock lifts.
    expect(te.blocked_insufficient_vendors).toBe(true);
    expect(te.current_round).toBe(1);
    expect(te.total_passed_verified).toBe(0);

    const s = await status(shape);
    expect(s.reopened).toBe(true);
    expect(s.bid_window_open).toBe(true);
    expect(s.is_stuck).toBe(false);

    const view = await rfqView(shape);
    expect(view.lifecycle_stage).not.toBe("RFQ_STUCK_TECHNICAL");
    expect(view.lifecycle_stage).toBe("TECHNICAL_AWAITING_QUOTES");
    expect(view.has_tech_stuck_product).toBe(false);

    expect(await verdicts(shape)).toEqual(verdictsBefore);
    expect(await rounds(shape)).toEqual(roundsBefore);

    const events = await reopenEvents(shape);
    expect(events).toHaveLength(1);
    expect(events[0].remarks).toBe("Technical evaluation reopened — bid deadline extended");
    expect(events[0].metadata).toMatchObject({ rfq_id: shape.rfq_id, tech_evaluation_id: shape.eval_id });
  });

  it("a vendor who quotes in the new window is evaluated in round 2 and, passing, reaches commercial", async () => {
    const shape = await reachIncidentState();
    expect((await edit(shape, { bid_end_date: istIsoLocal(3 * DAY) })).status).toBe(200);

    // C quotes in the reopened window; then bidding closes.
    await quote(shape, C);
    await closeBidding(shape);

    let s = await status(shape);
    expect(s.eligible_unscored_vendors).toEqual([
      { vendor_id: C, vendor_name: expect.any(String), company_name: expect.anything() },
    ]);
    expect(s.is_stuck).toBe(false);
    expect(s.bid_window_open).toBe(false);
    expect(s.reopened).toBe(true);
    expect((await rfqView(shape)).lifecycle_stage).toBe("TECHNICAL_EVALUATING");
    expect(await evaluatorQueue()).toContain(shape.eval_id);

    // The buyer scores C, sampling clause included, and submits.
    await score(shape, C, MARKS_100);
    const sub = await submit(shape);
    expect(sub.status).toBe(200);
    expect(sub.body.data.round_number).toBe(2);
    const r2 = (await rounds(shape)).find((r) => r.round_number === 2);
    expect(r2.vendors_evaluated.map((v) => v.vendor_id)).toEqual([C]);

    await approve(sub.body.data.approval_instance_id);

    const te = await evalRow(shape);
    expect(te.total_passed_verified).toBe(1);
    expect(te.is_complete).toBe(true);

    s = await status(shape);
    expect(s.is_stuck).toBe(false);
    expect(s.reopened).toBe(false);
    expect(s.total_passed_verified).toBe(1);

    // Round 1's verdicts survived round 2 untouched.
    const v = await verdicts(shape);
    expect(v.map((x) => [x.vendor_id, x.status, x.evaluation_round])).toEqual([[A, 0, 1], [B, 0, 1], [C, 1, 2]]);

    expect((await rfqView(shape)).lifecycle_stage).toBe("COMMERCIAL_EVALUATION");
    // Only the vendor who passed is visible commercially.
    expect(await commercialVendors(shape)).toEqual([C]);
  });
});

// ===========================================================================
//  Review Focus 1 — no new dead end
// ===========================================================================

describe("a reopened line nobody quotes on", () => {
  it("is stuck again once bidding closes, and the buyer can extend once more", async () => {
    // A disagreed with a clause in round 1, as vendors on prod do.
    const shape = await reachIncidentState({ disagree: [A] });
    expect((await edit(shape, { bid_end_date: istIsoLocal(3 * DAY) })).status).toBe(200);

    // While reopened and open, the evaluation is open work again.
    expect(await disagreementQueue()).toContain(shape.eval_id);
    expect(await disagreementListIds()).toContain(shape.rfq_id);

    // Nobody new quotes against the clauses. C still has not quoted; D quotes
    // without answering a single clause, so D cannot be evaluated either.
    await invite(shape, D);
    await quote(shape, D);
    await closeBidding(shape);

    const s = await status(shape);
    expect(s.is_stuck).toBe(true);
    expect(s.bid_window_open).toBe(false);
    expect(s.eligible_unscored_vendors).toEqual([]);

    const view = await rfqView(shape);
    expect(view.lifecycle_stage).toBe("RFQ_STUCK_TECHNICAL");
    expect(view.has_tech_stuck_product).toBe(true);
    // A reopened evaluation that is stuck again is not work anybody can do —
    // on any surface that reads is_complete = false as "open".
    expect(await evaluatorQueue()).not.toContain(shape.eval_id);
    expect(await disagreementQueue()).not.toContain(shape.eval_id);
    expect(await disagreementListIds()).not.toContain(shape.rfq_id);
    const sidebar = await techEvalSidebarRow(shape);
    expect(sidebar.has_tech_stuck_product).toBe(true);
    expect(sidebar.has_pending_evaluation).toBe(false);

    // Still restricted …
    const refused = await edit(shape, { comment: "anything else", bid_end_date: istIsoLocal(5 * DAY) });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/Restricted edit/i);
    // … and the deadline can be extended again, which reopens it again.
    const again = await edit(shape, { bid_end_date: istIsoLocal(5 * DAY) });
    expect(again.status).toBe(200);
    const after = await status(shape);
    expect(after.is_stuck).toBe(false);
    expect(after.bid_window_open).toBe(true);
    expect(after.reopened).toBe(true);
    expect(await reopenEvents(shape)).toHaveLength(2);
  });
});

// ===========================================================================
//  A round that blocks while bidding is still open
// ===========================================================================

describe("a round approved before bidding closes, in which nobody passed", () => {
  it("leaves the evaluation open, so a vendor who quotes later can be evaluated in round 2", async () => {
    const shape = await seedIncidentRfq({ bidEnd: ist(3 * DAY) });
    await score(shape, A, MARKS_80);
    await score(shape, B, MARKS_72);
    expect(await runRound(shape)).toBe(1);

    // Nobody passed and there is no replacement — but bidding is still open,
    // so "every eligible vendor has been evaluated" is not yet true.
    let te = await evalRow(shape);
    expect(te.blocked_insufficient_vendors).toBe(true);
    expect(te.total_passed_verified).toBe(0);
    expect(te.is_complete).toBe(false);
    let s = await status(shape);
    expect(s.is_stuck).toBe(false);
    expect(s.bid_window_open).toBe(true);

    // D quotes and answers before the deadline; bidding closes.
    await invite(shape, D);
    await answerClauses(shape, D);
    await quote(shape, D);
    await closeBidding(shape);

    s = await status(shape);
    expect(s.eligible_unscored_vendors.map((v) => v.vendor_id)).toEqual([D]);
    expect(s.is_stuck).toBe(false);

    await score(shape, D, MARKS_100);
    expect(await runRound(shape)).toBe(2);
    te = await evalRow(shape);
    expect(te.total_passed_verified).toBe(1);
    expect(te.is_complete).toBe(true);
    expect(await commercialVendors(shape)).toEqual([D]);
  });
});

// ===========================================================================
//  Evaluations locked before this fix
// ===========================================================================

describe("an evaluation locked as complete while bidding was still open (pre-fix shape)", () => {
  /**
   * Round 1 approved during the bid window with nobody passing; before the
   * keep-open rule the evaluation was then locked (is_complete TRUE). 536894
   * reaches this shape if the client extends again before this deploys.
   */
  async function lockedWhileOpen() {
    const shape = await seedIncidentRfq({ bidEnd: ist(3 * DAY) });
    await score(shape, A, MARKS_80);
    await score(shape, B, MARKS_72);
    expect(await runRound(shape)).toBe(1);
    await lockAsComplete(shape);
    expect(await evalRow(shape)).toMatchObject({
      is_complete: true, blocked_insufficient_vendors: true, total_passed_verified: 0,
    });
    return shape;
  }

  it("L1 — is not stuck (bidding is open), and the next extension reopens it", async () => {
    const shape = await lockedWhileOpen();
    let s = await status(shape);
    expect(s).toMatchObject({ is_stuck: false, bid_window_open: true, reopened: false });
    const verdictsBefore = await verdicts(shape);

    const res = await edit(shape, { bid_end_date: istIsoLocal(5 * DAY) });
    expect(res.status).toBe(200);

    expect((await evalRow(shape)).is_complete).toBe(false);
    s = await status(shape);
    expect(s).toMatchObject({ is_stuck: false, bid_window_open: true, reopened: true });
    expect(await verdicts(shape)).toEqual(verdictsBefore);
    expect(await reopenEvents(shape)).toHaveLength(1);

    // And the reopened evaluation does its job: C quotes, bidding closes, C is
    // evaluated in round 2.
    await quote(shape, C);
    await closeBidding(shape);
    await score(shape, C, MARKS_100);
    expect(await runRound(shape)).toBe(2);
    expect((await evalRow(shape)).total_passed_verified).toBe(1);
  });

  it("L2 — a vendor then quotes and bidding closes: the buyer can still evaluate and submit them", async () => {
    const shape = await lockedWhileOpen();
    await quote(shape, C);
    await closeBidding(shape);

    // Not stuck — C is waiting to be evaluated — so the edit stays shut …
    const s = await status(shape);
    expect(s).toMatchObject({ is_stuck: false, bid_window_open: false, reopened: false });
    expect(s.eligible_unscored_vendors.map((v) => v.vendor_id)).toEqual([C]);
    const refusedEdit = await edit(shape, { bid_end_date: istIsoLocal(3 * DAY) });
    expect(refusedEdit.status).toBe(400);
    expect(refusedEdit.body.message).toMatch(/bid window has closed/i);

    // … and submitting before C is scored is refused for THAT reason, with the
    // lock left exactly as it was (the lift is rolled back with the refusal).
    const early = await submit(shape);
    expect(early.status).toBe(400);
    expect(early.body.code).toBe("TECH_EVAL_NO_NEW_VENDORS_SCORED");
    expect((await evalRow(shape)).is_complete).toBe(true);

    // The buyer scores C and submits: round 2, carrying only C.
    await score(shape, C, MARKS_100);
    const sub = await submit(shape);
    expect(sub.status).toBe(200);
    expect(sub.body.data.round_number).toBe(2);
    const r2 = (await rounds(shape)).find((r) => r.round_number === 2);
    expect(r2.vendors_evaluated.map((v) => v.vendor_id)).toEqual([C]);
    expect((await evalRow(shape)).is_complete).toBe(false);

    await approve(sub.body.data.approval_instance_id);
    expect(await evalRow(shape)).toMatchObject({ is_complete: true, total_passed_verified: 1 });
    expect(await commercialVendors(shape)).toEqual([C]);
  });
});

// ===========================================================================
//  Review Focus 3 — a line that is not stuck is never reopened
// ===========================================================================

describe("extending the deadline on a line that is not stuck", () => {
  it("blocked but one vendor passed: nothing reopens", async () => {
    const shape = await seedIncidentRfq({ bidEnd: ist(3 * DAY) });
    await score(shape, A, MARKS_100);
    await score(shape, B, MARKS_72);
    await runRound(shape);
    const before = await evalRow(shape);
    expect(before).toMatchObject({ is_complete: true, blocked_insufficient_vendors: true, total_passed_verified: 1 });

    const res = await edit(shape, { bid_end_date: istIsoLocal(5 * DAY) });
    expect(res.status).toBe(200);

    expect(await evalRow(shape)).toEqual(before);
    const s = await status(shape);
    expect(s.reopened).toBe(false);
    expect(s.is_stuck).toBe(false);
    expect(await reopenEvents(shape)).toEqual([]);
  });

  it("not blocked at all: nothing reopens", async () => {
    const shape = await seedIncidentRfq({ bidEnd: ist(3 * DAY) });
    await score(shape, A, MARKS_100);
    await score(shape, B, MARKS_100);
    await runRound(shape);
    const before = await evalRow(shape);
    expect(before).toMatchObject({ is_complete: true, blocked_insufficient_vendors: false, total_passed_verified: 2 });

    const res = await edit(shape, { bid_end_date: istIsoLocal(5 * DAY) });
    expect(res.status).toBe(200);

    expect(await evalRow(shape)).toEqual(before);
    expect((await status(shape)).reopened).toBe(false);
    expect(await reopenEvents(shape)).toEqual([]);

    // A genuinely complete evaluation still refuses another round.
    const again = await submit(shape);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe("TECH_EVAL_ALREADY_COMPLETE");
  });
});

// ===========================================================================
//  NULL safety — the predicate is always TRUE or FALSE
// ===========================================================================

describe("blocked_insufficient_vendors stored NULL", () => {
  it("reads as not blocked: the evaluation stays in the evaluator's queue", async () => {
    // Bidding closed, nobody scored, one real quote from a vendor who answered
    // nothing — so nobody is an eligible unscored responder either. Under a
    // `= TRUE` predicate a NULL here made `NOT stuck` NULL and dropped the row.
    const shape = await seedIncidentRfq({ quoted: [], answeredOnly: [C] });
    await invite(shape, D);
    await quote(shape, D);
    await db.none(
      `UPDATE tbl_rfq_product_tech_evaluation SET blocked_insufficient_vendors = NULL WHERE id = $1`,
      [shape.eval_id]
    );

    expect(await evaluatorQueue()).toContain(shape.eval_id);
    expect((await status(shape)).is_stuck).toBe(false);
  });
});

// ===========================================================================
//  Review Focus 2 — the stored deadline's shape never breaks the predicate
// ===========================================================================

describe("bid_end_date stored empty or in ISO form", () => {
  it("empty counts as closed; ISO forms parse; every surface still answers", async () => {
    const shape = await reachIncidentState();
    const setBid = (v) => db.none(`UPDATE tbl_rfq SET bid_end_date = $2 WHERE id = $1`, [shape.rfq_id, v]);
    const future = new Date(Date.now() + 2 * DAY + 5.5 * HOUR).toISOString(); // 'YYYY-MM-DDTHH:mm:ss.sssZ'
    const past = new Date(Date.now() - 2 * DAY + 5.5 * HOUR).toISOString();

    // [stored value, window open?, also drive the listing + detail page?]
    // Whitespace-only is not a shape production holds, and older SQL elsewhere
    // in getRfqById (lowest_quotation) casts any non-'' value — so only the
    // predicate's own endpoint is asked about it.
    for (const [stored, open, everySurface] of [
      ["", false, true],
      ["   ", false, false],
      [istIsoLocal(2 * DAY), true, true],
      [istIsoLocal(-2 * DAY), false, true],
      [future, true, true],
      [past, false, true],
    ]) {
      await setBid(stored);
      const s = await status(shape);
      expect({ stored, bid_window_open: s.bid_window_open, is_stuck: s.is_stuck })
        .toEqual({ stored, bid_window_open: open, is_stuck: !open });
      if (!everySurface) continue;

      // The listing and the detail page run the same predicate in bigger queries.
      const view = await rfqView(shape);
      expect({ stored, stuck: view.has_tech_stuck_product }).toEqual({ stored, stuck: !open });
      const row = await listRow(shape);
      expect({ stored, stuck: row.has_tech_stuck_product }).toEqual({ stored, stuck: !open });
    }
  });
});
