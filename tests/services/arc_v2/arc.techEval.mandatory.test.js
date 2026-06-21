// ARC v2 — Mandatory pass/fail gate + weighted scoring math (two-envelope eval).
//
// Proves the mandatory-clause gate the coder added to computeItemScores /
// recordClearedVendors / qualifiedVendorsByItem (RESOLVED DECISION 3):
//
//   5. A vendor who FAILS a mandatory clause (mandatory_passed=false) is
//      not_qualified REGARDLESS of a passing weighted score.
//   6. A vendor with an UNJUDGED mandatory clause (mandatory_passed IS NULL) is
//      still not_qualified until the verdict is recorded.
//   7. A vendor passing all mandatory clauses + weighted >= min-pass → qualified;
//      the mandatory clause's weight still counts in the 100/denominator.
//   8. Technical → commercial gate intact: a mandatory-failed vendor cannot be
//      allocated (saveAllocation → 400 "not technically qualified"); comm-eval
//      redacts their price (technically_disqualified).
//   6b. Weighted-only scoring (no mandatory clauses) still qualifies/disqualifies
//      by score alone (regression guard for computeItemScores).
//  11. Evaluator score path enforces the mandatory verdict: a mandatory clause
//      REQUIRES mandatory_passed (400 if absent); a non-mandatory clause ignores it.
//  12. Evaluator permission gating: a buyer WITHOUT arc-tech perms is rejected
//      on read (arc-tech.read) and score (arc-tech.evaluate).
//  Amend: an approver can flip a mandatory verdict during decide, re-deriving
//      cleared_vendors and writing a field_changed='mandatory_passed' history row.
//
// Product-level: real Express app + local Postgres. Assertions on HTTP +
// resulting DB rows (cleared_vendors.status, comm-eval redaction), never on
// internal call counts.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";

const HC     = IDS.hospitality.A;
const HOTEL  = IDS.hotels.A1;
const DEPT   = IDS.departments.proc;
const PROC   = IDS.processes.A_P1;
const BUYER  = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_techApp;
const NOPERM_BUYER = IDS.users.a1_eng_buyer; // a buyer with NO arc-tech role here
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;
const TECH_POLICY_ID = 64920;

const E = "/api/v1/arc-v2/evaluation";

describe("ARC v2 — mandatory pass/fail gate + scoring math", () => {
  let buyerClient, approverClient, noPermClient;
  // ARC with a mandatory (weight 40) + weighted (weight 60) clause; min pass 60.
  let arcId, itemId, teId, clauseMandatory, clauseWeighted;
  // Vendor A responses (will FAIL the mandatory gate but pass weighted);
  // Vendor B responses (will PASS both).
  let respA_m, respA_w, respB_m, respB_w;
  // Second ARC: weighted-only (regression) — no mandatory clause.
  let woArcId, woItemId, woTeId, woClause, woRespA;

  async function seedClause(teId, text, weight, mandatory, type = "compliance") {
    return Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [teId, text, weight, type, mandatory])).id);
  }
  async function seedResponse(clauseId, vendorId, vendorResponse = "submitted") {
    return Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
         (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response)
       VALUES ($1, $2, $3) RETURNING id`,
      [clauseId, vendorId, vendorResponse])).id);
  }

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`,
      [[BUYER, APPROVER, NOPERM_BUYER]]);
    buyerClient = await httpClient(BUYER);
    approverClient = await httpClient(APPROVER);
    noPermClient = await httpClient(NOPERM_BUYER);
    // Only BUYER gets the arc-tech/comm permissions — NOPERM_BUYER deliberately
    // has none, to prove the permission gate. (Approver stays engine-gated.)
    await seedArcEvalPerms(db, [BUYER]);

    // ARC_TECH policy so submitTechEval can spawn the approval instance.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_TECH', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [TECH_POLICY_ID, HC, HOTEL, BUYER, PROC]);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [TECH_POLICY_ID, APPROVER]);

    // Main ARC — submission closed, ready to score.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-MAND-1', 'Mandatory gate', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    arcId = Number(arc.id);
    itemId = Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 1000, 'litre', 100) RETURNING id`, [arcId, VARIANT_ID])).id);
    teId = Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [itemId])).id);
    // Mandatory clause weight 40, weighted clause weight 60 → total 100.
    clauseMandatory = await seedClause(teId, "Mandatory safety cert", 40, true, "doc");
    clauseWeighted  = await seedClause(teId, "Quality SOP", 60, false, "spec");

    // Vendor-authored responses (two-envelope): both vendors submitted on both.
    respA_m = await seedResponse(clauseMandatory, VENDOR_A);
    respA_w = await seedResponse(clauseWeighted, VENDOR_A);
    respB_m = await seedResponse(clauseMandatory, VENDOR_B);
    respB_w = await seedResponse(clauseWeighted, VENDOR_B);

    // Quotes (so comm-eval has lines + the gate redaction can be checked).
    for (const [vendor, rate] of [[VENDOR_A, 90], [VENDOR_B, 95]]) {
      const q = await db.one(
        `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at)
         VALUES ($1, $2, NOW()) ON CONFLICT (arc_id, vendor_id) DO UPDATE SET updated_at = NOW()
         RETURNING id`, [arcId, vendor]);
      await db.none(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
         VALUES ($1, $2, $3, 5) ON CONFLICT (arc_quote_id, arc_item_id) DO NOTHING`,
        [q.id, itemId, rate]);
    }
    await db.none(`INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
       VALUES ($1,$2,'submitted'),($1,$3,'submitted') ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
      [arcId, VENDOR_A, VENDOR_B]);

    // Weighted-only ARC (regression): single weighted clause, no mandatory.
    const wo = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-MAND-WO', 'Weighted only', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    woArcId = Number(wo.id);
    woItemId = Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 500, 'litre') RETURNING id`, [woArcId, VARIANT_ID])).id);
    woTeId = Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [woItemId])).id);
    woClause = await seedClause(woTeId, "Plain weighted clause", 10, false);
    woRespA = await seedResponse(woClause, VENDOR_A);
  });

  afterAll(async () => {
    const arcIds = [arcId, woArcId];
    const instanceIds = (await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_TECH' AND entity_id = ANY($1::bigint[])`,
      [arcIds])).map((r) => r.id);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers
                      WHERE approval_instance_step_id IN
                        (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [TECH_POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [TECH_POLICY_ID]);
    await db.none(`DELETE FROM tbl_arc_tech_eval_edit_history WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_comm_evaluation_award WHERE arc_comm_evaluation_id IN (SELECT id FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::bigint[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_comm_evaluation_history WHERE arc_comm_evaluation_id IN (SELECT id FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::bigint[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [arcIds]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  // ── Case 11 — score path enforces the mandatory verdict requirement ──
  test("11. scoring a mandatory clause REQUIRES mandatory_passed; non-mandatory ignores it", async () => {
    // Missing verdict on a mandatory clause → 400.
    const missing = await buyerClient.post(`${E}/tech-eval/score`).send({
      response_id: respA_m, buyer_marks: 40,
    });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/mandatory_passed/i);

    // Non-mandatory clause: a stray mandatory_passed is forced to NULL.
    const nonMand = await buyerClient.post(`${E}/tech-eval/score`).send({
      response_id: respA_w, buyer_marks: 60, mandatory_passed: false,
    });
    expect(nonMand.status).toBe(200);
    const row = await db.one(
      `SELECT mandatory_passed FROM tbl_arc_item_tech_evaluation_vendors_response WHERE id = $1`, [respA_w]);
    expect(row.mandatory_passed).toBeNull();
  });

  // ── Cases 5 + 7 — score both vendors, submit, check the gate in cleared_vendors ──
  test("5 + 7. mandatory-fail disqualifies a weighted-passing vendor; mandatory-pass qualifies", async () => {
    // Vendor A: full weighted marks (40 + 60 = 100% >= 60) BUT FAILS the mandatory gate.
    await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: respA_m, buyer_marks: 40, mandatory_passed: false });
    await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: respA_w, buyer_marks: 60 });
    // Vendor B: full weighted marks AND passes the mandatory gate.
    await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: respB_m, buyer_marks: 40, mandatory_passed: true });
    await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: respB_w, buyer_marks: 60 });

    // Submit → records cleared_vendors via computeItemScores (the gate).
    const submit = await buyerClient.post(`${E}/${arcId}/tech-eval/submit`).send({});
    expect(submit.status).toBe(200);

    const clearedA = await db.one(
      `SELECT status, calculated_score, reject_message
         FROM tbl_arc_item_tech_evaluation_cleared_vendors
        WHERE arc_item_tech_evaluation_id = $1 AND vendor_id = $2 AND evaluation_round = 1`,
      [teId, VENDOR_A]);
    // 100% weighted, but mandatory gate fails → not_qualified.
    expect(Number(clearedA.calculated_score)).toBe(100);
    expect(clearedA.status).toBe("not_qualified");
    expect(clearedA.reject_message).toMatch(/mandatory/i);

    const clearedB = await db.one(
      `SELECT status, calculated_score FROM tbl_arc_item_tech_evaluation_cleared_vendors
        WHERE arc_item_tech_evaluation_id = $1 AND vendor_id = $2 AND evaluation_round = 1`,
      [teId, VENDOR_B]);
    expect(Number(clearedB.calculated_score)).toBe(100);
    expect(clearedB.status).toBe("qualified"); // mandatory weight still counts in the 100

    // computeItemScores surfaces mandatory_failed so the UI can explain it.
    const matrix = await buyerClient.get(`${E}/items/${itemId}/tech-eval`);
    const sA = matrix.body.data.scores.find((s) => Number(s.vendor_id) === VENDOR_A);
    expect(sA.mandatory_failed).toBe(true);
    expect(sA.qualifies).toBe(false);
    const sB = matrix.body.data.scores.find((s) => Number(s.vendor_id) === VENDOR_B);
    expect(sB.mandatory_failed).toBe(false);
    expect(sB.qualifies).toBe(true);
  });

  // ── Case 8 — tech → commercial gate: mandatory-failed vendor cannot be allocated ──
  test("8. after tech approval, allocating the mandatory-failed vendor is rejected; price redacted", async () => {
    // Approve the technical evaluation so commercial unlocks.
    const decide = await approverClient.post(`${E}/${arcId}/tech-eval/decide`)
      .send({ decision: "approve", comment: "verified" });
    expect(decide.status).toBe(200);
    expect(decide.body.data.approval.status).toBe("APPROVED");
    const arcRow = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arcRow.status).toBe("tech_eval_approved");

    const qlA = await db.one(
      `SELECT ql.id FROM tbl_arc_quote_line ql JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
        WHERE q.arc_id = $1 AND q.vendor_id = $2 AND ql.arc_item_id = $3`,
      [arcId, VENDOR_A, itemId]);
    // Allocating mandatory-failed vendor A → 400 not technically qualified.
    const dq = await buyerClient.post(`${E}/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [{ awarded_vendor_id: VENDOR_A, awarded_quote_line_id: qlA.id, allocated_qty: 1000, l_rank: "L1", is_l1_default: true, awarded_quote_snapshot: { rate: 90 } }],
    });
    expect(dq.status).toBe(400);
    expect(dq.body.message).toMatch(/not technically qualified/i);

    // REDACTION: A's commercial line is sealed in comm-eval (gate respected).
    const ce = await buyerClient.get(`${E}/${arcId}/comm-eval`);
    const aLines = ce.body.data.quotes.filter((q) => Number(q.vendor_id) === VENDOR_A);
    expect(aLines.length).toBeGreaterThan(0);
    expect(aLines.every((q) => q.rate === null && q.technically_disqualified === true)).toBe(true);
    const bLines = ce.body.data.quotes.filter((q) => Number(q.vendor_id) === VENDOR_B);
    expect(bLines.every((q) => q.rate !== null && !q.technically_disqualified)).toBe(true);

    // Allocating qualified vendor B IS allowed.
    const qlB = await db.one(
      `SELECT ql.id FROM tbl_arc_quote_line ql JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
        WHERE q.arc_id = $1 AND q.vendor_id = $2 AND ql.arc_item_id = $3`,
      [arcId, VENDOR_B, itemId]);
    const okAlloc = await buyerClient.post(`${E}/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [{ awarded_vendor_id: VENDOR_B, awarded_quote_line_id: qlB.id, allocated_qty: 1000, l_rank: "L1", is_l1_default: true, awarded_quote_snapshot: { rate: 95 } }],
    });
    expect(okAlloc.status).toBe(200);
  });

  // ── Case 6 — unjudged mandatory clause gates qualification ──
  test("6. an UNJUDGED mandatory clause keeps the vendor not_qualified", async () => {
    // Fresh ARC: vendor scored full weighted marks, mandatory clause NOT judged.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-MAND-UNJ', 'Unjudged mandatory', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    const uArcId = Number(arc.id);
    const uItemId = Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 100, 'litre') RETURNING id`, [uArcId, VARIANT_ID])).id);
    const uTeId = Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [uItemId])).id);
    const uMand = await seedClause(uTeId, "Unjudged mandatory", 40, true, "doc");
    const uWeighted = await seedClause(uTeId, "Weighted", 60, false);
    const uRespM = await seedResponse(uMand, VENDOR_A);
    const uRespW = await seedResponse(uWeighted, VENDOR_A);

    try {
      // Score the WEIGHTED clause fully but leave the mandatory clause unjudged.
      await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: uRespW, buyer_marks: 60 });
      // Give the mandatory clause marks but NO verdict via direct UPDATE
      // (the score endpoint would 400 without mandatory_passed — that's case 11).
      await db.none(
        `UPDATE tbl_arc_item_tech_evaluation_vendors_response
            SET buyer_marks = 40, score_timestamp = CURRENT_TIMESTAMP
          WHERE id = $1`, [uRespM]);

      const matrix = await buyerClient.get(`${E}/items/${uItemId}/tech-eval`);
      const s = matrix.body.data.scores.find((x) => Number(x.vendor_id) === VENDOR_A);
      // 100% weighted, but the mandatory verdict is NULL → not-yet-passing → not qualified.
      expect(Number(s.calculated_score)).toBe(100);
      expect(s.mandatory_failed).toBe(true);
      expect(s.qualifies).toBe(false);
    } finally {
      await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_vendors_response WHERE id = ANY($1::bigint[])`, [[uRespM, uRespW]]);
      await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_clauses WHERE id = ANY($1::bigint[])`, [[uMand, uWeighted]]);
      await db.none(`DELETE FROM tbl_arc_item_tech_evaluation WHERE id = $1`, [uTeId]);
      await db.none(`DELETE FROM tbl_arc_item WHERE id = $1`, [uItemId]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [uArcId]);
    }
  });

  // ── Case 6c — a vendor who NEVER submitted a response to a mandatory clause ──
  // (the gate must be clause-driven: a missing response is the strongest
  // "not-yet-judged" state and previously slipped through on a diluted score.)
  test("6c. a vendor with NO response row for a mandatory clause is not_qualified despite a passing score", async () => {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-MAND-NOROW', 'No mandatory response', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    const nArcId = Number(arc.id);
    const nItemId = Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 100, 'litre') RETURNING id`, [nArcId, VARIANT_ID])).id);
    const nTeId = Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [nItemId])).id);
    // Mandatory clause weight 30, weighted clause weight 70 → total 100, min pass 60.
    const nMand = await seedClause(nTeId, "Mandatory the vendor skipped", 30, true, "doc");
    const nWeighted = await seedClause(nTeId, "Weighted", 70, false);
    // Vendor A responds ONLY to the weighted clause — NO row for the mandatory one.
    const nRespW = await seedResponse(nWeighted, VENDOR_A);

    try {
      // Full marks on the weighted clause → 70/100 = 70% >= 60 (clearly PASSES on score).
      await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: nRespW, buyer_marks: 70 });

      const matrix = await buyerClient.get(`${E}/items/${nItemId}/tech-eval`);
      const s = matrix.body.data.scores.find((x) => Number(x.vendor_id) === VENDOR_A);
      // Score passes the threshold, but the vendor never submitted the mandatory
      // clause at all → the gate must still disqualify them (the fixed blind spot).
      expect(Number(s.calculated_score)).toBe(70);
      expect(s.mandatory_failed).toBe(true);
      expect(s.qualifies).toBe(false);
    } finally {
      await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_vendors_response WHERE id = $1`, [nRespW]);
      await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_clauses WHERE id = ANY($1::bigint[])`, [[nMand, nWeighted]]);
      await db.none(`DELETE FROM tbl_arc_item_tech_evaluation WHERE id = $1`, [nTeId]);
      await db.none(`DELETE FROM tbl_arc_item WHERE id = $1`, [nItemId]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [nArcId]);
    }
  });

  // ── Case 6b — weighted-only (no mandatory) regression ──
  test("6b. weighted-only scoring still qualifies above min and disqualifies below", async () => {
    // Pass: 8/10 = 80% >= 60.
    await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: woRespA, buyer_marks: 8 });
    let scores = (await buyerClient.get(`${E}/items/${woItemId}/tech-eval`)).body.data.scores;
    let s = scores.find((x) => Number(x.vendor_id) === VENDOR_A);
    expect(Number(s.calculated_score)).toBe(80);
    expect(s.mandatory_failed).toBe(false);
    expect(s.qualifies).toBe(true);

    // Fail: 4/10 = 40% < 60.
    await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: woRespA, buyer_marks: 4 });
    scores = (await buyerClient.get(`${E}/items/${woItemId}/tech-eval`)).body.data.scores;
    s = scores.find((x) => Number(x.vendor_id) === VENDOR_A);
    expect(Number(s.calculated_score)).toBe(40);
    expect(s.qualifies).toBe(false);
    expect(s.mandatory_failed).toBe(false); // disqualified by SCORE, not the gate
  });

  // ── Case 12 — evaluator permission gating ──
  test("12. a buyer WITHOUT arc-tech permission is denied read + score", async () => {
    const read = await noPermClient.get(`${E}/items/${itemId}/tech-eval`);
    expect(read.status).toBe(403);
    const score = await noPermClient.post(`${E}/tech-eval/score`).send({
      response_id: respB_w, buyer_marks: 50,
    });
    expect(score.status).toBe(403);
    // Evidence proxy is permission-checked too (TECH_READ): seed a REAL evidence
    // file on this ARC (the middleware scopes the permission to the file's ARC),
    // then the no-perm buyer is denied. (A non-existent fileId has no ARC to
    // scope against, so it falls through to a plain 404 — not a permission test.)
    const file = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response_files
         (arc_item_tech_evaluation_vendors_response_id, file_url)
       VALUES ($1, 'https://example.invalid/evidence.pdf') RETURNING id`,
      [respB_m]);
    try {
      const ev = await noPermClient.get(`${E}/tech-eval/evidence/${file.id}`);
      expect(ev.status).toBe(403);
      // The permission-holding buyer is NOT blocked by the gate — it reaches the
      // controller (which then 502s because the stub S3 URL can't be fetched).
      const evOk = await buyerClient.get(`${E}/tech-eval/evidence/${file.id}`);
      expect(evOk.status).not.toBe(403);
    } finally {
      await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_vendors_response_files WHERE id = $1`, [file.id]);
    }
  });

  // ── Amend — approver flips a mandatory verdict during decide (re-derives gate) ──
  test("amend: flipping the mandatory verdict at decide re-qualifies the vendor + writes history", async () => {
    // Fresh ARC so this decide is independent of the main ARC's approved instance.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-MAND-AMEND', 'Amend mandatory', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    const amArcId = Number(arc.id);
    const amItemId = Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 100, 'litre') RETURNING id`, [amArcId, VARIANT_ID])).id);
    const amTeId = Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [amItemId])).id);
    const amMand = await seedClause(amTeId, "Mandatory to flip", 40, true, "doc");
    const amWeighted = await seedClause(amTeId, "Weighted", 60, false);
    const amRespM = await seedResponse(amMand, VENDOR_A);
    const amRespW = await seedResponse(amWeighted, VENDOR_A);
    await db.none(`INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1,$2,'submitted')
      ON CONFLICT (arc_id, vendor_id) DO NOTHING`, [amArcId, VENDOR_A]);

    try {
      // Score: full weighted, mandatory initially FAILED.
      await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: amRespM, buyer_marks: 40, mandatory_passed: false });
      await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: amRespW, buyer_marks: 60 });

      const submit = await buyerClient.post(`${E}/${amArcId}/tech-eval/submit`).send({});
      expect(submit.status).toBe(200);
      // Submitted record: not_qualified (mandatory failed).
      let cleared = await db.one(
        `SELECT status FROM tbl_arc_item_tech_evaluation_cleared_vendors
          WHERE arc_item_tech_evaluation_id = $1 AND vendor_id = $2 AND evaluation_round = 1`,
        [amTeId, VENDOR_A]);
      expect(cleared.status).toBe("not_qualified");

      // Approver flips the mandatory verdict to PASS during decide.
      const decide = await approverClient.post(`${E}/${amArcId}/tech-eval/decide`).send({
        decision: "approve",
        comment: "Cert validated offline",
        amend: { marks: [{ response_id: amRespM, mandatory_passed: true }] },
      });
      expect(decide.status).toBe(200);
      expect(decide.body.data.approval.status).toBe("APPROVED");

      // Verdict persisted + qualification recomputed → now qualified.
      const resp = await db.one(
        `SELECT mandatory_passed FROM tbl_arc_item_tech_evaluation_vendors_response WHERE id = $1`, [amRespM]);
      expect(resp.mandatory_passed).toBe(true);
      cleared = await db.one(
        `SELECT status FROM tbl_arc_item_tech_evaluation_cleared_vendors
          WHERE arc_item_tech_evaluation_id = $1 AND vendor_id = $2 AND evaluation_round = 1`,
        [amTeId, VENDOR_A]);
      expect(cleared.status).toBe("qualified");

      // Edit-history row records the mandatory verdict change.
      const edit = await db.oneOrNone(
        `SELECT field_changed, changed_by FROM tbl_arc_tech_eval_edit_history
          WHERE arc_id = $1 AND field_changed = 'mandatory_passed'`, [amArcId]);
      expect(edit).toBeTruthy();
      expect(edit.changed_by).toBe(APPROVER);
    } finally {
      const inst = (await db.any(
        `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_TECH' AND entity_id = $1`, [amArcId])).map(r => r.id);
      if (inst.length) {
        await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [inst]);
        await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [inst]);
        await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [inst]);
        await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inst]);
      }
      await db.none(`DELETE FROM tbl_arc_tech_eval_edit_history WHERE arc_id = $1`, [amArcId]);
      await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_cleared_vendors WHERE arc_item_tech_evaluation_id = $1`, [amTeId]);
      await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_vendors_response WHERE id = ANY($1::bigint[])`, [[amRespM, amRespW]]);
      await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_clauses WHERE id = ANY($1::bigint[])`, [[amMand, amWeighted]]);
      await db.none(`DELETE FROM tbl_arc_item_tech_evaluation WHERE id = $1`, [amTeId]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [amArcId]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [amArcId]);
      await db.none(`DELETE FROM tbl_arc_item WHERE id = $1`, [amItemId]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [amArcId]);
    }
  });
});
