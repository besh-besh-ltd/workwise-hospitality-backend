// Only the buyers of an RFQ may score its technical evaluation, and only while
// it is open.
//
// CONFIRMED DEFECT (found while investigating RFQ #536894): POST
// /rfq/update-buyer-marks sat behind passportSignIn alone, so ANY signed-in
// user — a vendor, a buyer of another company — could write marks on any clause
// by id, whether or not the evaluation was complete or awaiting approval. The
// legacy POST /rfq/tech-evaluation-cleared-vendors wrote a verdict straight to
// the cleared-vendors table the same way, and /rfq/tech-eval/submit-for-approval
// checked the role but never that the RFQ was the caller's.
//
// One carve-out is deliberate: an evaluation locked as complete before the
// reopen rule (blocked, nobody passed) with a vendor waiting to be evaluated is
// recoverable — the submit path lifts the lock — so the buyer must be able to
// score THAT vendor first. Nobody else on that evaluation.
//
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
const TAG = "TE-SCORING-GUARDS";
const OTHER_BUYER = IDS.users.companyB_admin;
const VENDOR_USER = IDS.users.vendor_alpha;

const stamped = {};

beforeAll(async () => {
  // acl([2, 8]) guards submit, status and edit (and acl([2, 3, 8, 9, 10]) the
  // sidebar). Fixture users carry user_type NULL, so stamp the buyer-side
  // actors as Buyers for this file only.
  for (const id of [BUYER, APPROVER, EVALUATOR, OTHER_BUYER]) {
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


// ---------------------------------------------------------------------------
//  Helpers for this file
// ---------------------------------------------------------------------------

const MARKS_80 = [20, 20, 20, 20, 20];
const MARKS_72 = [18, 18, 18, 18, 18];
const MARKS_100 = [25, 25, 25, 25, 25];

async function postMarks(user, body) {
  const client = await httpClient(user);
  return client.post("/api/v1/rfq/update-buyer-marks").send(body);
}

async function storedMarks(clause_id, vendor_id) {
  const row = await db.oneOrNone(
    `SELECT buyer_marks FROM tbl_rfq_product_tech_evaluation_vendors_response
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1 AND vendor_id = $2`,
    [clause_id, vendor_id]
  );
  return row ? row.buyer_marks : undefined;
}

const evalRow = ({ eval_id }) =>
  db.one(`SELECT is_complete, blocked_insufficient_vendors, total_passed_verified
            FROM tbl_rfq_product_tech_evaluation WHERE id = $1`, [eval_id]);

async function postVerdict(user, shape, vendor_id, status = 1) {
  const client = await httpClient(user);
  return client.post("/api/v1/rfq/tech-evaluation-cleared-vendors").send({
    rfq_id: shape.rfq_id, vendor_id, rfq_product_tech_evaluation_id: shape.eval_id,
    status, reject_message: status === 0 ? "no" : null,
  });
}

const verdictCount = (shape, vendor_id) =>
  db.one(
    `SELECT COUNT(*)::int AS n FROM tbl_rfq_product_tech_evaluation_cleared_vendors
      WHERE tbl_rfq_product_tech_evaluation_id = $1 AND vendor_id = $2`,
    [shape.eval_id, vendor_id]
  ).then((r) => r.n);

// ===========================================================================
//  /rfq/update-buyer-marks
// ===========================================================================

describe("POST /rfq/update-buyer-marks", () => {
  it("S1 — a legitimate buyer scores an open evaluation (behaviour unchanged), sampling row included", async () => {
    const shape = await seedIncidentRfq();
    const r = await postMarks(BUYER, { clause_id: shape.clause_ids[0], vendor_id: A, buyer_marks: 20 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe(1);
    expect(await storedMarks(shape.clause_ids[0], A)).toBe(20);

    // A sampling clause has no vendor row yet; scoring it creates one.
    expect(await storedMarks(shape.sampling_id, A)).toBeUndefined();
    const s = await postMarks(BUYER, { clause_id: shape.sampling_id, vendor_id: A, buyer_marks: 25, buyer_remark: "ok" });
    expect(s.status).toBe(200);
    expect(await storedMarks(shape.sampling_id, A)).toBe(25);
  });

  it("S2 — a vendor is refused and nothing is written", async () => {
    const shape = await seedIncidentRfq();
    const prev = (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [VENDOR_USER])).user_type;
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [VENDOR_USER]);
    try {
      const r = await postMarks(VENDOR_USER, { clause_id: shape.clause_ids[0], vendor_id: A, buyer_marks: 25 });
      expect(r.status).toBe(403);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [VENDOR_USER, prev]);
    }
    expect(await storedMarks(shape.clause_ids[0], A)).toBe(0);
  });

  it("S3 — a buyer of another company is refused and nothing is written", async () => {
    const shape = await seedIncidentRfq();
    const r = await postMarks(OTHER_BUYER, { clause_id: shape.clause_ids[0], vendor_id: A, buyer_marks: 25 });
    expect(r.status).toBe(403);
    expect(await storedMarks(shape.clause_ids[0], A)).toBe(0);
    // … and cannot mint sampling rows either.
    const s = await postMarks(OTHER_BUYER, { clause_id: shape.sampling_id, vendor_id: A, buyer_marks: 25, buyer_remark: "x" });
    expect(s.status).toBe(403);
    expect(await storedMarks(shape.sampling_id, A)).toBeUndefined();
  });

  it("S4 — a complete evaluation is locked (409)", async () => {
    const shape = await seedIncidentRfq();
    await db.none(`UPDATE tbl_rfq_product_tech_evaluation SET is_complete = TRUE WHERE id = $1`, [shape.eval_id]);
    const r = await postMarks(BUYER, { clause_id: shape.clause_ids[0], vendor_id: A, buyer_marks: 25 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("TECH_EVAL_ALREADY_COMPLETE");
    expect(await storedMarks(shape.clause_ids[0], A)).toBe(0);
  });

  it("S5 — marks are frozen while a round awaits approval (409)", async () => {
    const shape = await seedIncidentRfq();
    await score(shape, A, MARKS_80);
    await score(shape, B, MARKS_72);
    const sub = await submit(shape);
    expect(sub.status).toBe(200);
    const r = await postMarks(BUYER, { clause_id: shape.clause_ids[0], vendor_id: A, buyer_marks: 25 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("TECH_EVAL_ROUND_PENDING");
    expect(await storedMarks(shape.clause_ids[0], A)).toBe(20);
  });

  it("S6 — a vendor who already has a verdict cannot be re-scored (409)", async () => {
    const shape = await seedIncidentRfq({ bidEnd: ist(3 * DAY) });
    await score(shape, A, MARKS_80);
    await score(shape, B, MARKS_72);
    await runRound(shape); // approved: A and B each hold a verdict
    await db.none(`UPDATE tbl_rfq_product_tech_evaluation SET is_complete = FALSE WHERE id = $1`, [shape.eval_id]);
    const r = await postMarks(BUYER, { clause_id: shape.clause_ids[0], vendor_id: A, buyer_marks: 25 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("TECH_EVAL_VENDOR_ALREADY_DECIDED");
    expect(await storedMarks(shape.clause_ids[0], A)).toBe(20);
  });

  it("S7 — marks must be whole numbers within 0..weightage (400)", async () => {
    const shape = await seedIncidentRfq();
    const base = { clause_id: shape.clause_ids[0], vendor_id: A };
    expect((await postMarks(BUYER, { ...base, buyer_marks: 26 })).status).toBe(400);
    expect((await postMarks(BUYER, { ...base, buyer_marks: -1 })).status).toBe(400);
    expect((await postMarks(BUYER, { ...base, buyer_marks: 12.5 })).status).toBe(400);
    expect(await storedMarks(shape.clause_ids[0], A)).toBe(0);
    // the boundaries are valid
    expect((await postMarks(BUYER, { ...base, buyer_marks: 25 })).status).toBe(200);
    expect((await postMarks(BUYER, { ...base, buyer_marks: 0 })).status).toBe(200);
  });

  it("S8 — a clause that does not exist is 404, a vendor who never answered is 400", async () => {
    const shape = await seedIncidentRfq();
    expect((await postMarks(BUYER, { clause_id: 2147000000, vendor_id: A, buyer_marks: 1 })).status).toBe(404);
    const r = await postMarks(BUYER, { clause_id: shape.sampling_id, vendor_id: D, buyer_marks: 1, buyer_remark: "x" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("VENDOR_NOT_IN_EVALUATION");
    expect(await storedMarks(shape.sampling_id, D)).toBeUndefined();
  });
});

// ===========================================================================
//  Evaluations locked before the reopen rule: score the waiting vendor only
// ===========================================================================

describe("an evaluation locked complete with nobody passed (recoverable)", () => {
  async function recoverable() {
    // A, B quoted and scored in round 1 (nobody passed); C quoted since and
    // bidding closed; D answered but never quoted.
    const shape = await seedIncidentRfq({ bidEnd: ist(3 * DAY), answeredOnly: [C, D] });
    await score(shape, A, MARKS_80);
    await score(shape, B, MARKS_72);
    expect(await runRound(shape)).toBe(1);
    await db.none(`UPDATE tbl_rfq_product_tech_evaluation SET is_complete = TRUE WHERE id = $1`, [shape.eval_id]);
    await quote(shape, C);
    await closeBidding(shape);
    expect(await evalRow(shape)).toMatchObject({ is_complete: true, blocked_insufficient_vendors: true, total_passed_verified: 0 });
    return shape;
  }

  it("R1 — the buyer can score the eligible vendor, then submit round 2", async () => {
    const shape = await recoverable();
    await score(shape, C, MARKS_100); // update-buyer-marks answers 200 for every clause
    const sub = await submit(shape);
    expect(sub.status).toBe(200);
    expect(sub.body.data.round_number).toBe(2);
  });

  it("R2 — every other vendor on that evaluation is still refused", async () => {
    const shape = await recoverable();
    // D answered but has no quote: not an eligible unscored responder.
    const d = await postMarks(BUYER, { clause_id: shape.clause_ids[0], vendor_id: D, buyer_marks: 25 });
    expect(d.status).toBe(409);
    expect(d.body.code).toBe("TECH_EVAL_ALREADY_COMPLETE");
    expect(await storedMarks(shape.clause_ids[0], D)).toBe(0);
    // A already holds a verdict from round 1.
    const a = await postMarks(BUYER, { clause_id: shape.clause_ids[0], vendor_id: A, buyer_marks: 25 });
    expect(a.status).toBe(409);
    expect(await storedMarks(shape.clause_ids[0], A)).toBe(20);
  });

  it("R3 — the exemption is for blocked-and-unpassed evaluations only", async () => {
    const shape = await recoverable();
    await db.none(
      `UPDATE tbl_rfq_product_tech_evaluation SET blocked_insufficient_vendors = FALSE WHERE id = $1`,
      [shape.eval_id]
    );
    const r = await postMarks(BUYER, { clause_id: shape.clause_ids[0], vendor_id: C, buyer_marks: 25 });
    expect(r.status).toBe(409);
  });
});

// ===========================================================================
//  /rfq/tech-eval/submit-for-approval
// ===========================================================================

describe("POST /rfq/tech-eval/submit-for-approval", () => {
  it("T1 — a buyer of another company cannot submit someone else's evaluation", async () => {
    const shape = await seedIncidentRfq();
    await score(shape, A, MARKS_80);
    await score(shape, B, MARKS_72);
    const client = await httpClient(OTHER_BUYER);
    const res = await client.post("/api/v1/rfq/tech-eval/submit-for-approval")
      .send({ rfq_id: shape.rfq_id, rfq_product_id: shape.rfq_product_id });
    expect(res.status).toBe(403);
    const rounds = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_tech_evaluation_rounds WHERE tbl_rfq_product_tech_evaluation_id = $1`,
      [shape.eval_id]
    );
    expect(rounds.n).toBe(0);
  });
});

// ===========================================================================
//  /rfq/tech-evaluation-cleared-vendors (legacy accept / reject)
// ===========================================================================

describe("POST /rfq/tech-evaluation-cleared-vendors", () => {
  it("V1 — a vendor and another company's buyer are refused; nothing is written", async () => {
    const shape = await seedIncidentRfq();
    const prev = (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [VENDOR_USER])).user_type;
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [VENDOR_USER]);
    try {
      expect((await postVerdict(VENDOR_USER, shape, A)).status).toBe(403);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [VENDOR_USER, prev]);
    }
    expect((await postVerdict(OTHER_BUYER, shape, A)).status).toBe(403);
    expect(await verdictCount(shape, A)).toBe(0);
  });

  it("V2 — the RFQ's buyer can accept a vendor on an open evaluation, once", async () => {
    const shape = await seedIncidentRfq();
    const r = await postVerdict(BUYER, shape, A, 1);
    expect(r.status).toBe(200);
    expect(await verdictCount(shape, A)).toBe(1);
    const again = await postVerdict(BUYER, shape, A, 0);
    expect(again.status).toBe(409);
    expect(await verdictCount(shape, A)).toBe(1);
  });

  it("V3 — a complete evaluation, or a pending round, refuses a verdict (409)", async () => {
    const shape = await seedIncidentRfq();
    await db.none(`UPDATE tbl_rfq_product_tech_evaluation SET is_complete = TRUE WHERE id = $1`, [shape.eval_id]);
    expect((await postVerdict(BUYER, shape, A)).status).toBe(409);
    await db.none(`UPDATE tbl_rfq_product_tech_evaluation SET is_complete = FALSE WHERE id = $1`, [shape.eval_id]);
    await score(shape, A, MARKS_80);
    await score(shape, B, MARKS_72);
    expect((await submit(shape)).status).toBe(200);
    const r = await postVerdict(BUYER, shape, A);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("TECH_EVAL_ROUND_PENDING");
    expect(await verdictCount(shape, A)).toBe(0);
  });
});
