// ARC technical evaluation — approver decide endpoint (approve/reject/AMEND).
//
// Proves:
//   1. Engine gating: non-approvers 400; reject demands a comment.
//   2. Reject → ARC tech_eval_rejected, technical stage editable again,
//      and a fresh submit spawns a NEW instance.
//   3. Amend-then-approve: the approver edits a vendor's marks inline —
//      marks persisted, tbl_arc_tech_eval_edit_history diff rows written,
//      cleared-vendor qualification RECOMPUTED (vendor flips to qualified),
//      and the engine comment carries "[Edited before approval] …".
//   4. Terminal approve → tech_eval_approved; further scoring 409s.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";
import { ensureArcApprovable } from "../../helpers/arcApproverPerms.js";

const HC     = IDS.hospitality.A;
const HOTEL  = IDS.hotels.A1;
const DEPT   = IDS.departments.proc;
const PROC   = IDS.processes.A_P1;
const BUYER  = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_techApp;
const VENDOR = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const POLICY_ID = 64912;

describe("ARC tech-eval — approver approve/reject/amend", () => {
  let buyerClient, approverClient;
  let arcId, itemId, teId, responseId;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id IN ($1,$2)`, [BUYER, APPROVER]);
    buyerClient = await httpClient(BUYER);
    approverClient = await httpClient(APPROVER);
    // Submit/score endpoints are gated by requireArcPermission (arc-tech.*).
    // The decide endpoint stays engine-gated, so APPROVER needs no module role.
    await seedArcEvalPerms(db, [BUYER]);

    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_TECH', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [POLICY_ID, APPROVER]
    );
    // USER-source steps are permission-gated at instance creation: only
    // APPROVER is named on this policy's step, so only APPROVER gets
    // read+approve on 'arc-tech' — BUYER stays unqualified (asserted as a
    // non-approver below).
    await ensureArcApprovable(db, APPROVER, HC);

    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-TED-1', 'Tech decide', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '10 days', NOW() + INTERVAL '180 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    itemId = (await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, 1, 500, 'litre') RETURNING id`, [arcId])).id;
    // One clause, weight 10, min pass 60% — vendor scored 5/10 = 50% (fails).
    teId = (await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [itemId])).id;
    const clause = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1, 'Spec compliance', 10, 'compliance') RETURNING *`, [teId]);
    responseId = (await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
         (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response, buyer_id, buyer_marks, buyer_remark)
       VALUES ($1, $2, 'Attached', $3, 5, 'borderline') RETURNING id`,
      [clause.id, VENDOR, BUYER])).id;
  });

  afterAll(async () => {
    const instanceIds = (await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_TECH' AND entity_id = $1`,
      [arcId]
    )).map((r) => r.id);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers
                      WHERE approval_instance_step_id IN
                        (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  test("decide without an instance 404s; submit creates one", async () => {
    const early = await approverClient
      .post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/decide`)
      .send({ decision: "approve" });
    expect(early.status).toBe(404);

    const submit = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/submit`).send({});
    expect(submit.status).toBe(200);

    // Submitted record: vendor failed (50% < 60%).
    const cleared = await db.one(
      `SELECT status FROM tbl_arc_item_tech_evaluation_cleared_vendors
        WHERE arc_item_tech_evaluation_id = $1 AND vendor_id = $2 AND evaluation_round = 1`,
      [teId, VENDOR]);
    expect(cleared.status).toBe("not_qualified");
  });

  test("non-approver is stopped by the engine; reject demands a comment", async () => {
    const outsider = await buyerClient
      .post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/decide`)
      .send({ decision: "approve" });
    expect(outsider.status).toBeGreaterThanOrEqual(400);

    const noComment = await approverClient
      .post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/decide`)
      .send({ decision: "reject" });
    expect(noComment.status).toBe(400);
    expect(noComment.body.message).toMatch(/comment|reason/i);
  });

  test("reject re-opens technical; a fresh submit spawns a new instance", async () => {
    const reject = await approverClient
      .post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/decide`)
      .send({ decision: "reject", comment: "Scores look too generous — re-evaluate" });
    expect(reject.status).toBe(200);
    expect(reject.body.data.approval.status).toBe("REJECTED");

    const arcRow = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arcRow.status).toBe("tech_eval_rejected");

    const lifecycle = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    const tech = lifecycle.body.data.stages.find((s) => s.key === "technical");
    expect(["active", "partial"]).toContain(tech.state);
    expect(tech.reason).toBe("approval_rejected");

    // Editable again, and resubmittable.
    const rescore = await buyerClient.post(`/api/v1/arc-v2/evaluation/tech-eval/score`).send({
      response_id: responseId, buyer_marks: 5, buyer_remark: "re-checked",
    });
    expect(rescore.status).toBe(200);
    const resubmit = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/submit`).send({});
    expect(resubmit.status).toBe(200);
    const instances = await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_TECH' AND entity_id = $1`, [arcId]);
    expect(instances.length).toBe(2);
  });

  test("amend-then-approve: marks edited, history written, qualification recomputed", async () => {
    const decide = await approverClient
      .post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/decide`)
      .send({
        decision: "approve",
        comment: "Raising to reflect the attached certificate",
        amend: { marks: [{ response_id: responseId, buyer_marks: 8, buyer_remark: "cert verified" }] },
      });
    expect(decide.status).toBe(200);
    expect(decide.body.data.approval.status).toBe("APPROVED");
    expect(decide.body.data.amended.length).toBe(2); // buyer_marks + buyer_remark

    // Marks persisted on the response row.
    const resp = await db.one(
      `SELECT buyer_marks, buyer_remark FROM tbl_arc_item_tech_evaluation_vendors_response WHERE id = $1`,
      [responseId]);
    expect(Number(resp.buyer_marks)).toBe(8);
    expect(resp.buyer_remark).toBe("cert verified");

    // Edit history diff rows.
    const edits = await db.any(
      `SELECT field_changed, before_value, after_value, changed_by
         FROM tbl_arc_tech_eval_edit_history WHERE arc_id = $1 ORDER BY id`, [arcId]);
    expect(edits.length).toBe(2);
    const marksEdit = edits.find((e) => e.field_changed === "buyer_marks");
    expect(Number(marksEdit.before_value)).toBe(5);
    expect(Number(marksEdit.after_value)).toBe(8);
    expect(marksEdit.changed_by).toBe(APPROVER);

    // Qualification flipped: 8/10 = 80% >= 60%.
    const cleared = await db.one(
      `SELECT status, calculated_score FROM tbl_arc_item_tech_evaluation_cleared_vendors
        WHERE arc_item_tech_evaluation_id = $1 AND vendor_id = $2 AND evaluation_round = 1`,
      [teId, VENDOR]);
    expect(cleared.status).toBe("qualified");
    expect(Number(cleared.calculated_score)).toBe(80);

    // The engine comment carries the fold-in.
    const action = await db.one(
      `SELECT comment FROM tbl_approval_actions
        WHERE approval_instance_id = (SELECT approval_instance_id FROM tbl_arc_item_tech_evaluation WHERE id = $1)
        ORDER BY id DESC LIMIT 1`, [teId]);
    expect(action.comment).toMatch(/Edited before approval/);
    expect(action.comment).toMatch(/buyer_marks/);

    const arcRow = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arcRow.status).toBe("tech_eval_approved");
  });

  test("after approval the technical stage is immutable (409 STAGE_IMMUTABLE)", async () => {
    const res = await buyerClient.post(`/api/v1/arc-v2/evaluation/tech-eval/score`).send({
      response_id: responseId, buyer_marks: 9,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STAGE_IMMUTABLE");
  });
});
