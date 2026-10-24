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

const POLICY_ID = 64991;
const E = "/api/v1/arc-v2/evaluation";
const H = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();

describe("ARC negotiation on the RFQ screens", () => {
  let buyerClient, approverClient;
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

    buyerClient    = await httpClient(BUYER);
    approverClient = await httpClient(APPROVER);

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
});
