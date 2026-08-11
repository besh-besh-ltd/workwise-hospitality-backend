// ARC — post-approval side effects when the engine AUTO-APPROVES at creation.
//
// createApprovalInstance auto-approves every step whose only required (ANY)
// approver is the initiator, returning an instance that is born APPROVED —
// executeApprovalAction never runs, so the entity hooks (status flips,
// contract generation) used to be silently skipped. This is exactly how
// staging ARC-5 stranded in committee_review with zero contracts.
//
// Proves both ARC creation points dispatch the hooks on auto-approval:
//   1. submitTechEval  — submitter == ARC_TECH approver → tech_eval_approved.
//   2. finalizeCommEval — finalizer == ARC_COMMITTEE approver → contracts
//      generated, status awaiting_vendor_acceptance, events logged, and the
//      lifecycle's Contract Active stage opens.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";
import { ensureApprovable } from "../../helpers/arcApproverPerms.js";

const HC     = IDS.hospitality.A;
const HOTEL  = IDS.hotels.A1;
const DEPT   = IDS.departments.proc;
const PROC   = IDS.processes.A_P1;
const BUYER  = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const TECH_POLICY_ID = 64914;      // ARC_TECH — sole approver IS the buyer
const COMMITTEE_POLICY_ID = 64915; // ARC_COMMITTEE — sole approver IS the buyer

describe("ARC — auto-approved instances still fire post-approval hooks", () => {
  let buyerClient;
  let arcId, itemId, quoteLineId, responseId;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    buyerClient = await httpClient(BUYER);
    await seedArcEvalPerms(db, [BUYER]);

    for (const [pid, entity] of [[TECH_POLICY_ID, 'ARC_TECH'], [COMMITTEE_POLICY_ID, 'ARC_COMMITTEE']]) {
      await db.none(
        `INSERT INTO tbl_approval_policies
           (id, entity_type, hospitality_company_id, hotel_id, department_id,
            is_active, created_by, process_id, is_master, is_department_scoped, version)
         VALUES ($1, $2, $3, $4, NULL, true, $5, $6, false, false, 1)
         ON CONFLICT (id) DO NOTHING`,
        [pid, entity, HC, HOTEL, BUYER, PROC]
      );
      await db.none(
        `INSERT INTO tbl_approval_policy_steps
           (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
         VALUES ($1, 1, 'ANY', 'USER', $2)`,
        [pid, BUYER]
      );
    }
    // BUYER is the sole USER-source approver on both ARC_TECH and ARC_COMMITTEE
    // steps above — grant read+approve on their mapped resources at the ARC's
    // own hotel+department.
    await ensureApprovable(db, BUYER, "arc-tech", HC, HOTEL, DEPT);
    await ensureApprovable(db, BUYER, "arc-committee", HC, HOTEL, DEPT);

    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-AUTO-1', 'Auto-approve hooks', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '10 days', NOW() + INTERVAL '180 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    itemId = (await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, 1, 500, 'litre') RETURNING id`, [arcId])).id;
    const q = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at)
       VALUES ($1, $2, NOW()) RETURNING *`, [arcId, VENDOR]);
    quoteLineId = (await db.one(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
       VALUES ($1, $2, 90, 5) RETURNING id`, [q.id, itemId])).id;

    // One clause, scored 8/10 (passes the 60% bar) so vendor A qualifies and
    // the technical stage is submittable.
    const te = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [itemId]);
    const clause = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1, 'Spec compliance', 10, 'compliance') RETURNING id`, [te.id]);
    responseId = (await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
         (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response, buyer_id, buyer_marks)
       VALUES ($1, $2, 'Attached', $3, 8) RETURNING id`,
      [clause.id, VENDOR, BUYER])).id;
  });

  afterAll(async () => {
    const instanceIds = (await db.any(
      `SELECT id FROM tbl_approval_instances
        WHERE entity_type IN ('ARC_TECH','ARC_COMMITTEE') AND entity_id = $1`, [arcId]
    )).map((r) => r.id);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers
                      WHERE approval_instance_step_id IN
                        (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    for (const pid of [TECH_POLICY_ID, COMMITTEE_POLICY_ID]) {
      await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [pid]);
      await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [pid]);
    }
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = $1)`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  test("submitTechEval auto-approves AND flips the ARC to tech_eval_approved", async () => {
    const submit = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/submit`).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.auto_approved).toBe(true);

    const inst = await db.one(
      `SELECT status FROM tbl_approval_instances WHERE id = $1`,
      [submit.body.data.approval_instance_id]);
    expect(inst.status).toBe("APPROVED");

    // THE hook effect that used to be skipped:
    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arc.status).toBe("tech_eval_approved");

    const lc = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(lc.body.data.stages.find((s) => s.key === "technical")).toMatchObject({ state: "complete" });
  });

  test("finalizeCommEval auto-approves AND generates contracts + activates the contract stage", async () => {
    const alloc = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [{
        awarded_vendor_id: VENDOR, awarded_quote_line_id: quoteLineId,
        allocated_qty: 500, allocated_share_pct: 100, l_rank: "L1", is_l1_default: true,
        awarded_quote_snapshot: { rate: 90, gst_pct: 5 },
      }],
    });
    expect(alloc.status).toBe(200);

    const fin = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/finalize`).send({});
    expect(fin.status).toBe(200);

    const inst = await db.one(
      `SELECT status FROM tbl_approval_instances WHERE id = $1`,
      [fin.body.data.approval_instance_id]);
    expect(inst.status).toBe("APPROVED");

    // The hook effects that used to be skipped — exactly the staging strand:
    const contracts = await db.any(`SELECT id, vendor_id FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
    expect(contracts.length).toBe(1);
    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arc.status).toBe("awaiting_vendor_acceptance");

    const events = (await db.any(
      `SELECT event_type FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId])).map((e) => e.event_type);
    expect(events).toContain("committee_decision");
    expect(events).toContain("contract_generated");

    const lc = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(lc.body.data.stages.find((s) => s.key === "awarding")).toMatchObject({ state: "complete" });
    expect(lc.body.data.stages.find((s) => s.key === "active")).toMatchObject({ state: "active" });
    expect(lc.body.data.default_stage).toBe("active");
  });
});
