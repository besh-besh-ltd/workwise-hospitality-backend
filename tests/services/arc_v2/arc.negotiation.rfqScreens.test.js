// ARC negotiation rounds on the RFQ negotiation screens.
//
// Production ticket (Phileein, 22 Oct 2026): an ARC approver could not see the
// target price while approving a round. The ARC screens read the legacy
// tbl_negotiation_rounds.target_price column, which the create wizard stopped
// writing — targets now live per vendor and per item in
// products[].vendor_targets[].fields, keyed by arc_item_id / is_arc_level.
//
// ARC rounds now open on the shared RFQ screens (the command center at
// /negotiation/rounds/:id/detail and the approval page). This suite pins what
// those screens read for an ARC round:
//   - the command center reads ARC targets (item and ARC-level);
//   - ARC users reach it without a negotiation role (arc-comm.* in the ARC's
//     scope, or a seat on one of the ARC's round approvals), outsiders do not;
//   - the actions it offers are ones the ARC API honours (no per-line verdicts,
//     no withdraw), and POST /negotiation/rounds/:id/withdraw refuses ARC rounds;
//
// The round needs a real PENDING approval step, so the ARC_NEGOTIATION policy
// names an approver who is not the creator (same shape as
// arc.negotiation.approverDisplay.test.js).

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
const BUYER    = IDS.users.a1_proc_buyer;   // creator: arc-comm.read/evaluate, no negotiation.read
const APPROVER = IDS.users.a1_proc_commApp; // policy approver: also holds negotiation.read (role 12)
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const CATEGORY = TEST_CATEGORIES.beverages;

// Fresh users with no roles at all. OUTSIDER is mapped to the ARC's hotel but
// holds nothing; SEATED_ONLY is written onto the round's approval step after
// creation — a policy approver whose role was revoked mid-flight.
const OUTSIDER    = 649901;
const SEATED_ONLY = 649902;

const POLICY_ID = 64991;
const E = "/api/v1/arc-v2/evaluation";
const H = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();

describe("ARC negotiation on the RFQ screens", () => {
  let buyerClient, approverClient, outsiderClient, seatedOnlyClient;
  let arcId, itemAId, itemBId, roundId;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type=2, status=1 WHERE id = ANY($1::int[])`, [[BUYER, APPROVER]]);
    await db.none(`UPDATE tbl_users SET user_type=3, status=1 WHERE id = ANY($1::int[])`, [[VENDOR_A, VENDOR_B]]);

    await db.none(`INSERT INTO tbl_category_department (category_id, department_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [CATEGORY, DEPT]);
    await seedArcEvalPerms(db, [BUYER]);

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
    await ensureApprovable(db, APPROVER, "arc-comm", HC, HOTEL, DEPT);

    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number,title,category_id,hospitality_company_id,hotel_id,department_id,process_id,status,
          submission_start_at,submission_end_at,contract_start_at,contract_end_at,created_by,eligibility_type)
       VALUES ('ARC-NEG-RFQS-1','RFQ Screens Test',$1,$2,$3,$4,$5,'comm_eval_in_progress',
               NOW()-INTERVAL '10 days',NOW()-INTERVAL '1 day',NOW()+INTERVAL '7 days',NOW()+INTERVAL '180 days',$6,'open')
       RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = Number(arc.id);
    itemAId = Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id,product_variant_id,indicative_qty,uom,target_price)
       VALUES ($1,1,1000,'litre',120) RETURNING id`, [arcId]
    )).id);
    itemBId = Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id,product_variant_id,indicative_qty,uom,target_price)
       VALUES ($1,2,500,'kg',300) RETURNING id`, [arcId]
    )).id);
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id,vendor_id,status)
       VALUES ($1,$2,'invited'),($1,$3,'invited') ON CONFLICT DO NOTHING`,
      [arcId, VENDOR_A, VENDOR_B]
    );
    const qA = await db.one(`INSERT INTO tbl_arc_quote (arc_id,vendor_id,submitted_at) VALUES ($1,$2,NOW()) RETURNING id`, [arcId, VENDOR_A]);
    await db.none(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id,arc_item_id,rate,gst_pct) VALUES ($1,$2,90,18),($1,$3,310,18)`,
      [qA.id, itemAId, itemBId]
    );
    const qB = await db.one(`INSERT INTO tbl_arc_quote (arc_id,vendor_id,submitted_at) VALUES ($1,$2,NOW()) RETURNING id`, [arcId, VENDOR_B]);
    await db.none(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id,arc_item_id,rate,gst_pct) VALUES ($1,$2,95,18),($1,$3,305,18)`,
      [qB.id, itemAId, itemBId]
    );

    for (const [id, name] of [[OUTSIDER, "RFQS Outsider"], [SEATED_ONLY, "RFQS Seated Only"]]) {
      await db.none(
        `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
         VALUES ($1, $2, $3, 1, 2, $4, now(), now())
         ON CONFLICT (id) DO UPDATE SET user_type = 2, status = 1`,
        [id, name, `arcrfqs.${id}@test.local`, IDS.companies.A]
      );
      await db.none(
        `INSERT INTO tbl_hospitality_user_mappings
           (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
         VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
        [id, HC, HOTEL, IDS.users.superAdmin]
      );
    }

    buyerClient      = await httpClient(BUYER);
    approverClient   = await httpClient(APPROVER);
    outsiderClient   = await httpClient(OUTSIDER);
    seatedOnlyClient = await httpClient(SEATED_ONLY);

    // Item A targets vendor A only; an ARC-level ask (payment terms) to vendor A.
    const res = await buyerClient
      .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
      .send({
        end_date: H(24),
        products: [
          { arc_item_id: itemAId, vendor_targets: [{ vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "80" }] }] },
          { is_arc_level: true, vendor_targets: [{ vendor_id: VENDOR_A, fields: [{ name: "payment_terms", target: "45 days" }] }] },
        ],
      });
    expect(res.status).toBe(200);
    roundId = Number(res.body.data.id);

    await db.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
       SELECT s.id, $2, 'PENDING'
         FROM tbl_approval_instance_steps s
         JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
        WHERE i.entity_type = 'ARC_NEGOTIATION' AND i.entity_id = $1
        ORDER BY s.step_order LIMIT 1`,
      [roundId, SEATED_ONLY]
    );
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
    await cleanupArcEvalPerms(db, [BUYER]);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [[OUTSIDER, SEATED_ONLY]]);
    await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [[OUTSIDER, SEATED_ONLY]]);
  });

  const detail = (client, id = roundId) => client.get(`/api/v1/negotiation/rounds/${id}/detail`);

  describe("command center targets", () => {
    test("the item line carries the vendor's base price target", async () => {
      const res = await detail(approverClient);
      expect(res.status).toBe(200);
      const line = res.body.data.lines.find((l) => l.arc_item_id === itemAId && l.vendor_id === VENDOR_A);
      expect(line).toBeDefined();
      expect(line.target_unit).toBe(80);
      expect(line.numeric_targets).toEqual(expect.arrayContaining([expect.objectContaining({ name: "base_price", target: 80 })]));
    });

    test("the ARC-level line carries the payment terms ask", async () => {
      const res = await detail(approverClient);
      expect(res.status).toBe(200);
      const line = res.body.data.lines.find((l) => l.is_rfq_level && l.vendor_id === VENDOR_A);
      expect(line).toBeDefined();
      expect(line.text_targets).toEqual(expect.arrayContaining([expect.objectContaining({ name: "payment_terms", target: "45 days" })]));
    });
  });

  describe("command center access", () => {
    test("an ARC commercial evaluator with no negotiation role can open the round", async () => {
      const res = await detail(buyerClient);
      expect(res.status).toBe(200);
      expect(res.body.data.round.round_id).toBe(roundId);
    });

    test("an approver seated on the round whose roles were revoked can still open it", async () => {
      const res = await detail(seatedOnlyClient);
      expect(res.status).toBe(200);
    });

    test("a seat removed from the approval no longer opens the round", async () => {
      const seat = `UPDATE tbl_approval_step_approvers SET removed_at = $2
                     WHERE approver_user_id = $1
                       AND approval_instance_step_id IN (
                         SELECT s.id FROM tbl_approval_instance_steps s
                           JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
                          WHERE i.entity_type = 'ARC_NEGOTIATION' AND i.entity_id = $3)`;
      await db.none(seat, [SEATED_ONLY, new Date(), roundId]);
      try {
        const res = await detail(seatedOnlyClient);
        expect(res.status).toBe(403);
      } finally {
        await db.none(seat, [SEATED_ONLY, null, roundId]);
      }
    });

    test("a user with no ARC scope and no seat is refused", async () => {
      const res = await detail(outsiderClient);
      expect(res.status).toBe(403);
    });

    test("the seat on this ARC does not open rounds of another ARC", async () => {
      // Same hotel, department and process — only the seat differs.
      const otherArc = await db.one(
        `INSERT INTO tbl_arc
           (arc_number,title,category_id,hospitality_company_id,hotel_id,department_id,process_id,status,
            submission_start_at,submission_end_at,contract_start_at,contract_end_at,created_by,eligibility_type)
         SELECT 'ARC-NEG-RFQS-2','Other ARC',category_id,hospitality_company_id,hotel_id,department_id,process_id,status,
                submission_start_at,submission_end_at,contract_start_at,contract_end_at,created_by,eligibility_type
           FROM tbl_arc WHERE id = $1
         RETURNING id`,
        [arcId]
      );
      const other = await db.one(
        `INSERT INTO tbl_negotiation_rounds (source_type, source_id, round_number, status, end_date, created_by, products)
         VALUES ('ARC', $1, 1, 'PENDING_APPROVAL', NOW() + INTERVAL '1 day', $2, '[]'::jsonb)
         RETURNING id, source_id`,
        [otherArc.id, BUYER]
      );
      try {
        const res = await detail(seatedOnlyClient, Number(other.id));
        expect(res.status).toBe(403);
      } finally {
        await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = $1`, [other.id]);
        await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [other.source_id]);
      }
    });
  });

  describe("command center actions", () => {
    test("the pending approver may approve or reject the round, but not per line and not withdraw", async () => {
      const res = await detail(approverClient);
      expect(res.status).toBe(200);
      const a = res.body.data.actions;
      expect(a.can_approve).toBe(true);
      expect(a.can_reject).toBe(true);
      expect(a.can_approve_line).toBe(false);
      expect(a.can_reject_line).toBe(false);
      expect(a.can_withdraw).toBe(false);
      expect(a.can_approve_vendor).toBe(false);
      expect(a.can_reject_vendor).toBe(false);
      expect(a.can_resubmit_vendor).toBe(false);
      expect(a.can_submit_quotes_for_approval).toBe(false);
    });

    test("a seated approver whose roles were revoked still gets approve (the ARC approve API is engine-gated)", async () => {
      const res = await detail(seatedOnlyClient);
      expect(res.body.data.actions.can_approve).toBe(true);
    });

    test("the creator who is not an approver gets no approve, no withdraw, and no next round while pending", async () => {
      const res = await detail(buyerClient);
      const a = res.body.data.actions;
      expect(a.can_approve).toBe(false);
      expect(a.can_reject).toBe(false);
      expect(a.can_withdraw).toBe(false);
      expect(a.can_create_next_round).toBe(false);
    });
  });

  describe("withdraw", () => {
    test("POST /negotiation/rounds/:id/withdraw refuses an ARC round and leaves it awaiting approval", async () => {
      const res = await buyerClient
        .post(`/api/v1/negotiation/rounds/${roundId}/withdraw`)
        .send({ remarks: "changed my mind" });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/rate contract/i);
      const round = await db.one(`SELECT status FROM tbl_negotiation_rounds WHERE id = $1`, [roundId]);
      expect(round.status).toBe("PENDING_APPROVAL");
      const inst = await db.one(
        `SELECT status FROM tbl_approval_instances WHERE entity_type = 'ARC_NEGOTIATION' AND entity_id = $1`,
        [roundId]
      );
      expect(inst.status).toBe("PENDING");
    });
  });
});
