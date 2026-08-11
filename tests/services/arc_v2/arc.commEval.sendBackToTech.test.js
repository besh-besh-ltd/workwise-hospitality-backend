// ARC v2 — Commercial "Send back to Technical evaluation".
//
// The commercial evaluator can bounce the ARC UPSTREAM to technical when the
// qualified-vendor set is wrong. This proves the real, observable behaviour:
//   - the ARC reopens technical (status tech_eval_in_progress, ARC_TECH cancelled)
//     and parks commercial (comm status sent_back) with the award allocation KEPT;
//   - lifecycle surfaces it distinctly (technical reopened_from_commercial,
//     commercial locked/sent_back_to_tech);
//   - the round-trip works: tech re-submit + re-approve reopens commercial with
//     the award still present;
//   - it is refused when technical was skipped (no clauses) — nothing to send to.
//
// State is built by driving the real endpoints (score → submit → approve →
// allocate), the same way an operator would, never by hand-poking status columns.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";
import { ensureArcApprovable } from "../../helpers/arcApproverPerms.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer;          // commercial evaluator + drives tech eval
const TECH_APPROVER = IDS.users.a1_proc_techApp;
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const CATEGORY = TEST_CATEGORIES.beverages;
const COMMITTEE_APPROVER = IDS.users.a1_proc_finance;
const TECH_POLICY_ID = 64920;
const COMMITTEE_POLICY_ID = 64921;
const E = "/api/v1/arc-v2/evaluation";
const stageOf = (body, key) => body.data.stages.find((s) => s.key === key);

describe("ARC v2 — commercial send-back to technical", () => {
  let buyerClient, techApproverClient;
  let arcId, skipArcId, bareArcId, itemId, commEvalId;
  const responseIdsA = [], responseIdsB = [];

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id IN ($1,$2,$3)`, [BUYER, TECH_APPROVER, COMMITTEE_APPROVER]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id IN ($1,$2)`, [VENDOR_A, VENDOR_B]);
    buyerClient = await httpClient(BUYER);
    techApproverClient = await httpClient(TECH_APPROVER);
    await db.none(`INSERT INTO tbl_category_department (category_id, department_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [CATEGORY, DEPT]);
    await seedArcEvalPerms(db, [BUYER]);

    // 1-step ARC_TECH policy (tech approver) + 1-step ARC_COMMITTEE policy (finance) —
    // the committee is needed only for the finalized-state branch (test 7).
    for (const [pid, entity, approver] of [
      [TECH_POLICY_ID, 'ARC_TECH', TECH_APPROVER],
      [COMMITTEE_POLICY_ID, 'ARC_COMMITTEE', COMMITTEE_APPROVER],
    ]) {
      await db.none(
        `INSERT INTO tbl_approval_policies
           (id, entity_type, hospitality_company_id, hotel_id, department_id,
            is_active, created_by, process_id, is_master, is_department_scoped, version)
         VALUES ($1,$2,$3,$4,NULL,true,$5,$6,false,false,1)
         ON CONFLICT (id) DO NOTHING`,
        [pid, entity, HC, HOTEL, BUYER, PROC]
      );
      await db.none(
        `INSERT INTO tbl_approval_policy_steps
           (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
         VALUES ($1,1,'ALL','USER',$2)`,
        [pid, approver]
      );
    }
    // USER-source steps are permission-gated at instance creation: only the
    // named approvers (TECH_APPROVER on ARC_TECH, COMMITTEE_APPROVER on
    // ARC_COMMITTEE) need read+approve, not BUYER or anyone else.
    await ensureArcApprovable(db, [TECH_APPROVER, COMMITTEE_APPROVER], HC);

    // Main ARC — window closed, 1 item, 1 clause, both vendors quoted + responded.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
          process_id, status, submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-SBT-1','Send back to tech',$1,$2,$3,$4,$5,'submission_closed',
               NOW()-INTERVAL '7 days', NOW()-INTERVAL '1 day', NOW()+INTERVAL '7 days', NOW()+INTERVAL '180 days',$6)
       RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    await db.none(`INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1,$2,'invited'),($1,$3,'invited')`, [arcId, VENDOR_A, VENDOR_B]);
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1,1,1000,'litre',100) RETURNING *`, [arcId]);
    itemId = item.id;
    const te = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score) VALUES ($1,60) RETURNING *`, [item.id]);
    const clause = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1,'ISO certification on file',10,'compliance') RETURNING *`, [te.id]);
    for (const [vendor, bucket] of [[VENDOR_A, responseIdsA], [VENDOR_B, responseIdsB]]) {
      const resp = await db.one(
        `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
           (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response)
         VALUES ($1,$2,'Attached') RETURNING *`, [clause.id, vendor]);
      bucket.push(Number(resp.id));
    }
    for (const [vendor, rate] of [[VENDOR_A, 90], [VENDOR_B, 95]]) {
      const q = await db.one(
        `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at)
         VALUES ($1,$2,NOW()) ON CONFLICT (arc_id, vendor_id) DO UPDATE SET updated_at = NOW() RETURNING *`, [arcId, vendor]);
      await db.none(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
         VALUES ($1,$2,$3,5) ON CONFLICT (arc_quote_id, arc_item_id) DO NOTHING`, [q.id, item.id, rate]);
    }

    // Skip ARC — item but ZERO clauses, sitting at commercial with a comm eval row.
    skipArcId = (await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
          process_id, status, submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-SBT-SKIP','Skip tech',$1,$2,$3,$4,$5,'comm_eval_in_progress',
               NOW()-INTERVAL '7 days', NOW()-INTERVAL '1 day', NOW()+INTERVAL '7 days', NOW()+INTERVAL '180 days',$6) RETURNING id`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER])).id;
    await db.none(`INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1,3,100,'kg')`, [skipArcId]);
    await db.none(`INSERT INTO tbl_arc_comm_evaluation (arc_id, status) VALUES ($1,'in_progress') ON CONFLICT (arc_id) DO NOTHING`, [skipArcId]);

    // Bare ARC — clauses exist but NO comm eval row (404 path).
    bareArcId = (await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
          process_id, status, submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-SBT-BARE','Bare tech',$1,$2,$3,$4,$5,'tech_eval_in_progress',
               NOW()-INTERVAL '7 days', NOW()-INTERVAL '1 day', NOW()+INTERVAL '7 days', NOW()+INTERVAL '180 days',$6) RETURNING id`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER])).id;
    const bareItem = await db.one(`INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1,1,100,'litre') RETURNING *`, [bareArcId]);
    const bareTe = await db.one(`INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score) VALUES ($1,60) RETURNING *`, [bareItem.id]);
    await db.none(`INSERT INTO tbl_arc_item_tech_evaluation_clauses (arc_item_tech_evaluation_id, clause_text, weightage, clause_type) VALUES ($1,'x',10,'compliance')`, [bareTe.id]);
  });

  afterAll(async () => {
    const ids = [arcId, skipArcId, bareArcId].filter(Boolean);
    const instanceIds = (await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type IN ('ARC_TECH','ARC_COMMITTEE') AND entity_id = ANY($1::bigint[])`, [ids]
    )).map((r) => r.id);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [ids]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [ids]);
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [[TECH_POLICY_ID, COMMITTEE_POLICY_ID]]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [[TECH_POLICY_ID, COMMITTEE_POLICY_ID]]);
    await db.none(`DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`, [CATEGORY, DEPT]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  test("0. reach commercial: score → submit → approve → allocate (award recorded)", async () => {
    // Score both vendors 10/10 (>= 60% min) so both qualify.
    for (const rid of [...responseIdsA, ...responseIdsB]) {
      const s = await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: rid, buyer_marks: 10, buyer_remark: "ok" });
      expect(s.status).toBe(200);
    }
    const submit = await buyerClient.post(`${E}/${arcId}/tech-eval/submit`).send({});
    expect(submit.status).toBe(200);
    const decide = await techApproverClient.post(`${E}/${arcId}/tech-eval/decide`).send({ decision: "approve", comment: "clean" });
    expect(decide.status).toBe(200);
    expect(decide.body.data.approval.status).toBe("APPROVED");

    const ql = await db.one(
      `SELECT ql.id FROM tbl_arc_quote_line ql JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
        WHERE q.arc_id = $1 AND q.vendor_id = $2 AND ql.arc_item_id = $3`, [arcId, VENDOR_A, itemId]);
    const alloc = await buyerClient.post(`${E}/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [{ awarded_vendor_id: VENDOR_A, awarded_quote_line_id: ql.id, allocated_qty: 1000, l_rank: "L1", is_l1_default: true, awarded_quote_snapshot: { rate: 90 } }],
    });
    expect(alloc.status).toBe(200);
    expect(alloc.body.data.awards.length).toBe(1);

    commEvalId = (await db.one(`SELECT id FROM tbl_arc_comm_evaluation WHERE arc_id = $1`, [arcId])).id;

    // Precondition: technical complete, commercial partial (all items allocated).
    const lc = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(stageOf(lc.body, "technical").state).toBe("complete");
    expect(stageOf(lc.body, "commercial").state).toBe("partial");
  });

  test("1. send-back-to-tech reopens technical and parks commercial, KEEPING the award", async () => {
    const awardsBefore = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_comm_evaluation_award WHERE arc_comm_evaluation_id = $1`, [commEvalId]);
    expect(awardsBefore.n).toBeGreaterThan(0);

    const res = await buyerClient.post(`${E}/${arcId}/comm-eval/send-back-to-tech`).send({ reason: "Vendor A was wrongly disqualified on clause 1" });
    expect(res.status).toBe(200);

    const arcRow = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arcRow.status).toBe("tech_eval_in_progress");
    const comm = await db.one(`SELECT status FROM tbl_arc_comm_evaluation WHERE arc_id = $1`, [arcId]);
    expect(comm.status).toBe("sent_back");
    const techInst = await db.one(
      `SELECT status FROM tbl_approval_instances WHERE entity_type='ARC_TECH' AND entity_id=$1 ORDER BY created_at DESC LIMIT 1`, [arcId]);
    expect(techInst.status).toBe("CANCELLED");

    // Award allocation preserved for the return trip.
    const awardsAfter = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_comm_evaluation_award WHERE arc_comm_evaluation_id = $1`, [commEvalId]);
    expect(awardsAfter.n).toBe(awardsBefore.n);

    // History records the upstream bounce.
    const hist = await db.any(`SELECT action FROM tbl_arc_comm_evaluation_history WHERE arc_comm_evaluation_id = $1`, [commEvalId]);
    expect(hist.map((r) => r.action)).toContain("sent_back_to_tech");
  });

  test("2. lifecycle surfaces it distinctly on both stages", async () => {
    const lc = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    const tech = stageOf(lc.body, "technical");
    const comm = stageOf(lc.body, "commercial");
    // Technical reopened (no longer complete/skipped/locked).
    expect(["partial", "active"]).toContain(tech.state);
    expect(tech.reason).toBe("reopened_from_commercial");
    // Commercial parked, awaiting the re-evaluation — award kept, not lost.
    expect(comm.state).toBe("locked");
    expect(comm.reason).toBe("sent_back_to_tech");
  });

  test("3. round-trip: re-submit + re-approve reopens commercial with the award intact", async () => {
    // Re-submit is allowed (the cancelled instance no longer blocks it).
    const submit = await buyerClient.post(`${E}/${arcId}/tech-eval/submit`).send({});
    expect(submit.status).toBe(200);
    const decide = await techApproverClient.post(`${E}/${arcId}/tech-eval/decide`).send({ decision: "approve", comment: "re-checked, A qualifies" });
    expect(decide.status).toBe(200);
    expect(decide.body.data.approval.status).toBe("APPROVED");

    const lc = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(stageOf(lc.body, "technical").state).toBe("complete");
    expect(stageOf(lc.body, "commercial").state).not.toBe("locked"); // reopened

    // The award the evaluator made before the bounce is still there.
    const awards = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_comm_evaluation_award WHERE arc_comm_evaluation_id = $1`, [commEvalId]);
    expect(awards.n).toBeGreaterThan(0);
  });

  test("4. refused when technical was skipped (no clauses) — nothing to send back to", async () => {
    const res = await buyerClient.post(`${E}/${skipArcId}/comm-eval/send-back-to-tech`).send({ reason: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Technical evaluation was not performed/i);
  });

  test("5. a blank reason is rejected", async () => {
    const res = await buyerClient.post(`${E}/${arcId}/comm-eval/send-back-to-tech`).send({ reason: "   " });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/reason is required/i);
  });

  test("6. 404 when there is no commercial evaluation yet", async () => {
    const res = await buyerClient.post(`${E}/${bareArcId}/comm-eval/send-back-to-tech`).send({ reason: "x" });
    expect(res.status).toBe(404);
  });

  test("7. from a FINALIZED state, send-back-to-tech cancels the pending committee vote and reopens technical", async () => {
    // Main ARC is back at commercial-partial after the round-trip; finalize sends
    // it to the committee.
    const fin = await buyerClient.post(`${E}/${arcId}/comm-eval/finalize`).send({});
    expect(fin.status).toBe(200);
    const committeeId = Number(fin.body.data.approval_instance_id);
    expect(committeeId).toBeGreaterThan(0);

    const res = await buyerClient.post(`${E}/${arcId}/comm-eval/send-back-to-tech`).send({ reason: "committee flagged qualification" });
    expect(res.status).toBe(200);

    // The pending committee vote is moot — cancelled; technical reopened again.
    const committee = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [committeeId]);
    expect(committee.status).toBe("CANCELLED");
    const arcRow = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arcRow.status).toBe("tech_eval_in_progress");
    const comm = await db.one(`SELECT status FROM tbl_arc_comm_evaluation WHERE arc_id = $1`, [arcId]);
    expect(comm.status).toBe("sent_back");
  });
});
