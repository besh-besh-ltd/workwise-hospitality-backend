// ARC Negotiation — approver-display fix (can_user_approve).
//
// Reproduces the production bug: a user was SHOWN the Approve/Reject action on a
// negotiation round but the API returned 400 "User is not an approver for this
// step". Root cause = the FE gated the action on the arc-comm.evaluate PERMISSION
// (canEvaluate) instead of the round's DESIGNATED approver. The fix surfaces a
// server-computed `can_user_approve` (+ `pending_approver`) on the round read, so
// the FE gates on the real approver. The backend approve/reject is unchanged
// (it correctly 400s a non-approver).
//
// This suite uses a NON-auto-approve ARC_NEGOTIATION policy (approver != creator) so
// a real PENDING approval step exists — the path arc.negotiation.flow.test.js
// (auto-approve, creator == sole approver) never exercised. That gap is exactly why
// the bug shipped.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";
import { ensureApprovable } from "../../helpers/arcApproverPerms.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;   // ROUND CREATOR — has arc-comm.* but is NOT the approver
const APPROVER = IDS.users.a1_proc_commApp; // the designated ARC_NEGOTIATION approver
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID_A = 1;

// Distinct policy id + process-scoped (PROC) so it is the most-specific ARC_NEGOTIATION
// match for this ARC even if a process-null policy from another suite coexists.
const POLICY_ID = 64971;
const E = "/api/v1/arc-v2/evaluation";
const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();

describe("ARC Negotiation — approver-display (can_user_approve)", () => {
  let buyerClient, approverClient;
  let arcId, itemAId, roundId, approverName;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type=2, status=1 WHERE id = ANY($1::int[])`, [[BUYER, APPROVER]]);
    await db.none(`UPDATE tbl_users SET user_type=3, status=1 WHERE id = ANY($1::int[])`, [[VENDOR_A, VENDOR_B]]);
    approverName = (await db.one(`SELECT name FROM tbl_users WHERE id=$1`, [APPROVER])).name;

    await db.none(`INSERT INTO tbl_category_department (category_id, department_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [CATEGORY, DEPT]);
    // BOTH need arc-comm.read to list rounds; BUYER also has arc-comm.evaluate (the
    // permission the buggy FE fell back to) yet is NOT the approver — the exact case.
    await seedArcEvalPerms(db, [BUYER, APPROVER]);

    // NON-auto-approve ARC_NEGOTIATION policy: approver = APPROVER (!= creator BUYER).
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1,'ARC_NEGOTIATION',$2,$3,NULL,true,$4,$5,false,false,1)
       ON CONFLICT (id) DO UPDATE SET is_active=true, process_id=$5`,
      [POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [POLICY_ID]);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [POLICY_ID, APPROVER]
    );
    // APPROVER is the USER-source approver on this ARC_NEGOTIATION step — grant
    // read+approve on 'arc-comm' (the entity_type's mapped resource) at the
    // ARC's own hotel+department, or createApprovalInstance drops the step.
    await ensureApprovable(db, APPROVER, "arc-comm", HC, HOTEL, DEPT);

    // ARC at comm_eval_in_progress + 1 item + 2 invited vendors with submitted quotes.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number,title,category_id,hospitality_company_id,hotel_id,department_id,process_id,status,
          submission_start_at,submission_end_at,contract_start_at,contract_end_at,created_by,eligibility_type)
       VALUES ('ARC-NEG-APPR-1','Approver Display Test',$1,$2,$3,$4,$5,'comm_eval_in_progress',
               NOW()-INTERVAL '10 days',NOW()-INTERVAL '1 day',NOW()+INTERVAL '7 days',NOW()+INTERVAL '180 days',$6,'open')
       RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    const itemA = await db.one(
      `INSERT INTO tbl_arc_item (arc_id,product_variant_id,indicative_qty,uom,target_price)
       VALUES ($1,$2,1000,'litre',120) RETURNING *`,
      [arcId, VARIANT_ID_A]
    );
    itemAId = itemA.id;
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id,vendor_id,status)
       VALUES ($1,$2,'invited'),($1,$3,'invited') ON CONFLICT DO NOTHING`,
      [arcId, VENDOR_A, VENDOR_B]
    );
    const qA = await db.one(`INSERT INTO tbl_arc_quote (arc_id,vendor_id,submitted_at) VALUES ($1,$2,NOW()) RETURNING *`, [arcId, VENDOR_A]);
    await db.none(`INSERT INTO tbl_arc_quote_line (arc_quote_id,arc_item_id,rate,gst_pct) VALUES ($1,$2,90,18)`, [qA.id, itemAId]);
    const qB = await db.one(`INSERT INTO tbl_arc_quote (arc_id,vendor_id,submitted_at) VALUES ($1,$2,NOW()) RETURNING *`, [arcId, VENDOR_B]);
    await db.none(`INSERT INTO tbl_arc_quote_line (arc_quote_id,arc_item_id,rate,gst_pct) VALUES ($1,$2,95,18)`, [qB.id, itemAId]);

    buyerClient    = await httpClient(BUYER);
    approverClient = await httpClient(APPROVER);
  });

  afterAll(async () => {
    if (arcId) {
      const rids = (await db.any(`SELECT id FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1`, [arcId])).map(r => r.id);
      if (rids.length) {
        const insts = (await db.any(`SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=ANY($1::int[])`, [rids])).map(r => r.id);
        if (insts.length) {
          await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=ANY($1::int[])`, [insts]);
          await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[]))`, [insts]);
          await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[])`, [insts]);
          await db.none(`DELETE FROM tbl_approval_instances WHERE id=ANY($1::int[])`, [insts]);
        }
        await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id=ANY($1::int[])`, [rids]);
        await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=ANY($1::int[])`, [rids]);
      }
      await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id=$1)`, [arcId]);
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id=$1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id=$1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id=$1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id=$1`, [POLICY_ID]);
    await cleanupArcEvalPerms(db, [BUYER, APPROVER]);
  });

  test("1. createRound with a non-auto-approve policy stays PENDING_APPROVAL (approver != creator)", async () => {
    const res = await buyerClient
      .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
      .send({ end_date: D(2), products: [{ arc_item_id: itemAId, vendor_targets: [{ vendor_id: VENDOR_A, target_rate: 80 }] }] });
    expect(res.status).toBe(200);
    roundId = Number(res.body.data.id);
    expect(roundId).toBeGreaterThan(0);
    const row = await db.one(`SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [roundId]);
    expect(row.status).toBe("PENDING_APPROVAL"); // did NOT auto-approve — a real approval step exists
  });

  test("2. the DESIGNATED approver's round read carries can_user_approve=true + pending_approver name", async () => {
    const res = await approverClient.get(`${E}/${arcId}/comm-eval/negotiation/rounds`);
    expect(res.status).toBe(200);
    const round = (res.body.data || []).find((r) => Number(r.id) === roundId);
    expect(round).toBeTruthy();
    expect(round.can_user_approve).toBe(true);
    expect(round.pending_approver).toBe(approverName);
  });

  test("3. a NON-approver who HAS arc-comm.evaluate (the creator) gets can_user_approve=false (FE hides the button)", async () => {
    const res = await buyerClient.get(`${E}/${arcId}/comm-eval/negotiation/rounds`);
    expect(res.status).toBe(200);
    const round = (res.body.data || []).find((r) => Number(r.id) === roundId);
    expect(round).toBeTruthy();
    expect(round.can_user_approve).toBe(false);        // the fix: not the approver → no button
    expect(round.pending_approver).toBe(approverName); // still told who to reach
  });

  test("4. the NON-approver's approve call is correctly rejected 400 (backend unchanged), round stays PENDING", async () => {
    const res = await buyerClient.post(`${E}/${arcId}/comm-eval/negotiation/rounds/${roundId}/approve`).send({});
    expect(res.status).toBe(400);
    const row = await db.one(`SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [roundId]);
    expect(row.status).toBe("PENDING_APPROVAL");
  });

  test("5. the DESIGNATED approver CAN approve → 200, round goes ACTIVE", async () => {
    const res = await approverClient.post(`${E}/${arcId}/comm-eval/negotiation/rounds/${roundId}/approve`).send({});
    expect(res.status).toBe(200);
    const row = await db.one(`SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [roundId]);
    expect(row.status).toBe("ACTIVE");
  });
});
