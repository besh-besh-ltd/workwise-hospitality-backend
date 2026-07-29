// ARC v2 — setupTechEval server-side value validation (GROUP C).
//
// Proves the value-validation block the coder added to
// `arcEvaluationController.setupTechEval` (before the assertStageWritable /
// db.tx block) rejects bad tech-eval setup payloads with 400, and that the
// happy path still writes + reads back correctly. Covers:
//   Sr 13 — minimum_passing_score < 1 rejected.
//   Sr 45 — minimum_passing_score > 100 rejected; boundary 100 accepted.
//   Sr 46 — malformed/non-numeric min-pass rejected; a clean numeric string
//           ("040") normalises via Number() and is accepted.
//   Sr 15 (in-scope slice) — per-item clause weightage must sum to exactly
//           100; a single out-of-range clause weightage is rejected too.
//
// Product-level: real Express app + local Postgres (per repo convention —
// no assertions on internal call counts/helper wiring). Every rejection
// scenario also asserts NO tbl_arc_item_tech_evaluation row was written.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";

const HC      = IDS.hospitality.A;
const HOTEL   = IDS.hotels.A1;
const DEPT    = IDS.departments.proc;
const PROC    = IDS.processes.A_P1;
const BUYER   = IDS.users.a1_proc_buyer;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

const E = "/api/v1/arc-v2/evaluation";

describe("ARC v2 — setupTechEval value validation (Sr 13, 15-slice, 44, 45, 46)", () => {
  let buyerClient;
  let arcId;
  const itemIds = [];
  let nextVariantId = VARIANT_ID;

  // tbl_arc_item has a UNIQUE(arc_id, product_variant_id) constraint — each
  // item under this shared ARC needs its own variant id.
  async function newItem() {
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 100, 'litre') RETURNING id`,
      [arcId, nextVariantId++]
    );
    const id = Number(item.id);
    itemIds.push(id);
    return id;
  }

  async function techEvalRowFor(itemId) {
    return db.oneOrNone(
      `SELECT * FROM tbl_arc_item_tech_evaluation WHERE arc_item_id = $1`,
      [itemId]
    );
  }

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    buyerClient = await httpClient(BUYER);
    // Evaluation endpoints are gated by requireArcPermission (arc-tech.*).
    await seedArcEvalPerms(db, [BUYER]);

    // Fresh ARC, submission window closed, no allocations/finalize yet —
    // both technical and commercial stages are writable (mirrors
    // arc.lifecycle.immutability.test.js's seed pattern).
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-TECHVAL-1', 'Tech-eval setup validation', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = Number(arc.id);
  });

  afterAll(async () => {
    if (itemIds.length) {
      await db.none(
        `DELETE FROM tbl_arc_item_tech_evaluation_clauses
          WHERE arc_item_tech_evaluation_id IN
            (SELECT id FROM tbl_arc_item_tech_evaluation WHERE arc_item_id = ANY($1::bigint[]))`,
        [itemIds]
      );
      await db.none(
        `DELETE FROM tbl_arc_item_tech_evaluation WHERE arc_item_id = ANY($1::bigint[])`,
        [itemIds]
      );
      await db.none(`DELETE FROM tbl_arc_item WHERE id = ANY($1::bigint[])`, [itemIds]);
    }
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  // ── Sr 13 — reject 0 ──
  test("minimum_passing_score: 0 → 400", async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: 0,
      clauses: [{ clause_text: "Quality", weightage: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least 1/i);
    expect(await techEvalRowFor(itemId)).toBeNull();
  });

  // ── Sr 45 — reject > 100; boundary 100 accepted ──
  test("minimum_passing_score: 500 → 400 (Sr 45)", async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: 500,
      clauses: [{ clause_text: "Quality", weightage: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot exceed 100/i);
    expect(await techEvalRowFor(itemId)).toBeNull();
  });

  test("minimum_passing_score: 101 → 400; boundary 100 with clauses summing to 100 → 200", async () => {
    const rejectItem = await newItem();
    const reject = await buyerClient.post(`${E}/items/${rejectItem}/tech-eval`).send({
      minimum_passing_score: 101,
      clauses: [{ clause_text: "Quality", weightage: 100 }],
    });
    expect(reject.status).toBe(400);
    expect(reject.body.message).toMatch(/cannot exceed 100/i);
    expect(await techEvalRowFor(rejectItem)).toBeNull();

    const boundaryItem = await newItem();
    const accept = await buyerClient.post(`${E}/items/${boundaryItem}/tech-eval`).send({
      minimum_passing_score: 100,
      clauses: [{ clause_text: "Quality", weightage: 100 }],
    });
    expect(accept.status).toBe(200);
    expect(Number(accept.body.data.tech_evaluation.minimum_passing_score)).toBe(100);
  });

  // ── Sr 46 — malformed / non-integer min-pass ──
  test('minimum_passing_score: "040" normalises to 40 → 200 (Sr 46 happy path)', async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: "040",
      clauses: [{ clause_text: "Quality", weightage: 100 }],
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.tech_evaluation.minimum_passing_score)).toBe(40);
  });

  test('minimum_passing_score: "abc" → 400', async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: "abc",
      clauses: [{ clause_text: "Quality", weightage: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid minimum passing score/i);
    expect(await techEvalRowFor(itemId)).toBeNull();
  });

  test("minimum_passing_score: null → 400", async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: null,
      clauses: [{ clause_text: "Quality", weightage: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid minimum passing score/i);
    expect(await techEvalRowFor(itemId)).toBeNull();
  });

  test("minimum_passing_score: missing entirely → 400", async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      clauses: [{ clause_text: "Quality", weightage: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid minimum passing score/i);
    expect(await techEvalRowFor(itemId)).toBeNull();
  });

  // ── Sr 15 in-scope slice — clause weights must sum to exactly 100 ──
  test("clauses summing to 90 (not 100) → 400, message mentions actual sum", async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: 60,
      clauses: [{ clause_text: "Quality", weightage: 90 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/total exactly 100/i);
    expect(res.body.message).toMatch(/90/);
    expect(await techEvalRowFor(itemId)).toBeNull();
  });

  test("clauses summing to 110 (not 100) → 400, message mentions actual sum", async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: 60,
      clauses: [
        { clause_text: "Quality", weightage: 60 },
        { clause_text: "Delivery", weightage: 50 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/total exactly 100/i);
    expect(res.body.message).toMatch(/110/);
    expect(await techEvalRowFor(itemId)).toBeNull();
  });

  // ── Per-clause weightage out of range ──
  test("a clause with weightage: 0 → 400", async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: 60,
      clauses: [{ clause_text: "Quality", weightage: 0 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/weightage must be a whole number between 1 and 100/i);
    expect(await techEvalRowFor(itemId)).toBeNull();
  });

  test("a clause with weightage: 150 → 400", async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: 60,
      clauses: [{ clause_text: "Quality", weightage: 150 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/weightage must be a whole number between 1 and 100/i);
    expect(await techEvalRowFor(itemId)).toBeNull();
  });

  // ── Blank clause text ──
  test("a clause with blank clause_text → 400", async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: 60,
      clauses: [{ clause_text: "   ", weightage: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/non-empty clause text/i);
    expect(await techEvalRowFor(itemId)).toBeNull();
  });

  // ── Empty clauses array ──
  test("clauses: [] → 400 (At least one clause is required)", async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: 60,
      clauses: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least one clause is required/i);
    expect(await techEvalRowFor(itemId)).toBeNull();
  });

  // ── Happy path — valid setup persists, GET readback confirms ──
  test("valid setup (min-pass 1–100, clauses summing to 100) → 200; GET readback confirms persistence", async () => {
    const itemId = await newItem();
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: 65,
      clauses: [
        { clause_text: "Quality SOP", weightage: 60 },
        { clause_text: "Safety cert", weightage: 40 },
      ],
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.tech_evaluation.minimum_passing_score)).toBe(65);
    expect(res.body.data.clauses).toHaveLength(2);

    const read = await buyerClient.get(`${E}/items/${itemId}/tech-eval`);
    expect(read.status).toBe(200);
    expect(Number(read.body.data.tech_evaluation.minimum_passing_score)).toBe(65);
    const texts = read.body.data.clauses.map((c) => c.clause_text).sort();
    expect(texts).toEqual(["Quality SOP", "Safety cert"].sort());
    const weights = read.body.data.clauses.map((c) => Number(c.weightage)).sort((a, b) => a - b);
    expect(weights).toEqual([40, 60]);
  });
});
