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

// ── Buyer-authored reference documents on a clause ──────────────────────────
//
// Client feedback item 4: "enable clause-wise document upload (images /
// attachments against each clause)".
//
// The storage has existed since the ARC core migration —
// tbl_arc_item_tech_evaluation_clauses_files and its universal twin — but NO
// application code ever wrote to either, and the wizard carried a dead
// "Attach reference document" placeholder: a plain <span> with no handler. The
// RFQ side has had the same feature working end to end all along.
//
// The subtle part is WHERE the urls live in the payload. setupTechEval clears
// and re-inserts the entire clause set on every draft save (replace
// semantics), and the files table cascades from the clause — so a file
// attached to a clause id held from an earlier save is gone on the next one.
// The urls therefore travel INSIDE each clause object and are re-attached with
// it. These tests pin that.

describe("ARC v2 — clause reference documents", () => {
  let buyerClient;
  let arcId;
  const itemIds = [];
  let variantSeq = 900;

  const E2 = "/api/v1/arc-v2/evaluation";
  const FILE_A = "https://s3.example.com/arc/clause-drawing-a.pdf";
  const FILE_B = "https://s3.example.com/arc/clause-photo-b.png";

  const newItem = async () => {
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 100, 'litre') RETURNING id`,
      [arcId, variantSeq++]
    );
    const id = Number(item.id);
    itemIds.push(id);
    return id;
  };

  const setup = (itemId, clauses) =>
    buyerClient.post(`${E2}/items/${itemId}/tech-eval`)
      .send({ minimum_passing_score: 50, clauses });

  const filesFor = (itemId) => db.any(
    `SELECT f.file_url
       FROM tbl_arc_item_tech_evaluation_clauses_files f
       JOIN tbl_arc_item_tech_evaluation_clauses c ON c.id = f.arc_item_tech_evaluation_clauses_id
       JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
      WHERE te.arc_item_id = $1
      ORDER BY f.id`, [itemId]);

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    buyerClient = await httpClient(BUYER);
    await seedArcEvalPerms(db, [BUYER]);
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-CLAUSEFILE-1', 'Clause reference documents', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = Number(arc.id);
  });

  afterAll(async () => {
    if (itemIds.length) {
      await db.none(
        `DELETE FROM tbl_arc_item_tech_evaluation WHERE arc_item_id = ANY($1::bigint[])`,
        [itemIds]);
      await db.none(`DELETE FROM tbl_arc_item WHERE id = ANY($1::bigint[])`, [itemIds]);
    }
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  test("stores the documents attached to a clause", async () => {
    const itemId = await newItem();
    const res = await setup(itemId, [
      { clause_text: "Conforms to the attached drawing", weightage: 100, file_urls: [FILE_A, FILE_B] },
    ]);

    expect(res.status).toBe(200);
    expect((await filesFor(itemId)).map((f) => f.file_url)).toEqual([FILE_A, FILE_B]);
  });

  test("returns them on the clause, under a key distinct from vendor evidence", async () => {
    const itemId = await newItem();
    await setup(itemId, [
      { clause_text: "Conforms to the attached drawing", weightage: 100, file_urls: [FILE_A] },
    ]);

    const res = await buyerClient.get(`${E2}/items/${itemId}/tech-eval`);
    expect(res.status).toBe(200);
    const clause = res.body.data.clauses[0];
    // `files` on a clause is the VENDOR's evidence; conflating the two would
    // offer a vendor a delete button on the buyer's drawing.
    expect(clause.reference_files.map((f) => f.file_url)).toEqual([FILE_A]);
  });

  test("survives a re-save, which replaces the whole clause set", async () => {
    // The failure mode this guards: clauses are cleared and re-inserted on
    // every draft save and the files table cascades, so an implementation that
    // attached files to a clause id from an earlier save loses them here.
    const itemId = await newItem();
    await setup(itemId, [
      { clause_text: "Original", weightage: 100, file_urls: [FILE_A] },
    ]);

    const again = await setup(itemId, [
      { clause_text: "Edited on resume", weightage: 100, file_urls: [FILE_A] },
    ]);
    expect(again.status).toBe(200);

    expect((await filesFor(itemId)).map((f) => f.file_url)).toEqual([FILE_A]);
  });

  test("a re-save that drops a document actually drops it", async () => {
    const itemId = await newItem();
    await setup(itemId, [
      { clause_text: "Two docs", weightage: 100, file_urls: [FILE_A, FILE_B] },
    ]);
    await setup(itemId, [
      { clause_text: "Two docs", weightage: 100, file_urls: [FILE_A] },
    ]);

    expect((await filesFor(itemId)).map((f) => f.file_url)).toEqual([FILE_A]);
  });

  test("a clause with no documents is still fine", async () => {
    const itemId = await newItem();
    const res = await setup(itemId, [{ clause_text: "No docs", weightage: 100 }]);

    expect(res.status).toBe(200);
    expect(await filesFor(itemId)).toEqual([]);

    const read = await buyerClient.get(`${E2}/items/${itemId}/tech-eval`);
    expect(read.body.data.clauses[0].reference_files).toEqual([]);
  });

  test("rejects a file list that is not a list of urls", async () => {
    const itemId = await newItem();
    const res = await setup(itemId, [
      { clause_text: "Bad", weightage: 100, file_urls: "not-an-array" },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/file/i);
  });

  test("rejects an empty string masquerading as a document", async () => {
    const itemId = await newItem();
    const res = await setup(itemId, [
      { clause_text: "Bad", weightage: 100, file_urls: ["  "] },
    ]);
    expect(res.status).toBe(400);
  });

  test("caps how many documents one clause can carry", async () => {
    // The list is re-inserted verbatim on every save, so an unbounded array is
    // an unbounded write.
    const itemId = await newItem();
    const res = await setup(itemId, [
      { clause_text: "Too many", weightage: 100, file_urls: Array.from({ length: 11 }, (_, i) => `${FILE_A}?${i}`) },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at most/i);
  });

  test("a rejected payload writes no documents at all", async () => {
    const itemId = await newItem();
    await setup(itemId, [
      { clause_text: "Good", weightage: 100, file_urls: [FILE_A] },
    ]);
    // now a payload that fails validation AFTER the first clause looks fine
    const res = await setup(itemId, [
      { clause_text: "Good", weightage: 50, file_urls: [FILE_B] },
      { clause_text: "Bad", weightage: 50, file_urls: ["  "] },
    ]);
    expect(res.status).toBe(400);

    // unchanged from the first, successful save
    expect((await filesFor(itemId)).map((f) => f.file_url)).toEqual([FILE_A]);
  });

  test("the wizard can repaint them when a draft is resumed", async () => {
    const itemId = await newItem();
    await setup(itemId, [
      { clause_text: "Conforms to the attached drawing", weightage: 100, file_urls: [FILE_A] },
    ]);

    const res = await buyerClient.get(`/api/v1/arc-v2/${arcId}`);
    expect(res.status).toBe(200);
    const item = res.body.data.items.find((i) => Number(i.id) === itemId);
    expect(item.tech_eval.clauses[0].reference_files.map((f) => f.file_url)).toEqual([FILE_A]);
  });
});
