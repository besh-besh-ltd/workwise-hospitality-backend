// negotiation.minimumWindow.test.js
//
// A negotiation round only reaches a vendor once every approver has signed
// off, and its deadline is fixed when it is CREATED. Production ARC-2026-27-0006
// opened 8 rounds with deadlines 4–64 minutes out; 7 lapsed before the three
// approvers it needed could act, and no vendor ever saw one. So:
//
//   1. a round (RFQ or ARC) must close at least 2 hours after it is opened;
//   2. an ARC round whose deadline has passed can no longer be approved — the
//      RFQ approve path already refuses this; ARC did not.

import { describe, it, expect, afterAll, afterEach, beforeAll, jest } from "@jest/globals";
import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../helpers/arcEvalPerms.js";
import { ensureApprovable } from "../helpers/arcApproverPerms.js";
import negotiationController from "../../app/controllers/negotiation/negotiationController.js";
import { makeRFQ } from "../factories/rfq.js";

const TOO_SHORT =
  "The round deadline must be at least 2 hours from now, so approvers have time to approve and vendors have time to respond.";

const MIN = 60_000;
const inMs = (ms) => new Date(Date.now() + ms).toISOString();
// What an IST browser would send if it serialised local wall clock with its offset.
const inMsIst = (ms) => {
  const d = new Date(Date.now() + ms + 330 * MIN);
  return d.toISOString().replace("Z", "+05:30");
};

// ── RFQ ─────────────────────────────────────────────────────────────────────
const RFQ_CREATOR = IDS.users.a1_proc_buyer;
const NEGOTIATOR = IDS.users.a1_proc_commEval;
const VA = IDS.users.vendor_alpha;
const rfqIds = [];

function mockExpress(body) {
  const calls = { status: null, body: null };
  const res = {
    status(code) { calls.status = code; return this; },
    json(b) { calls.body = b; return this; },
    end() { return this; },
  };
  return { req: { user: { id: NEGOTIATOR }, params: {}, body, query: {} }, res, calls };
}

const ago = (d) => new Date(Date.now() - d * 86400_000).toISOString().replace("T", " ").slice(0, 19);

async function rfqWithProduct() {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: RFQ_CREATOR,
    status: 1,
    is_published: 1,
    tender_publish_date: ago(3),
    vendor_clarification_date: ago(2),
    bid_end_date: ago(1),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
  });
  const rfqId = Number(rfq_id);
  rfqIds.push(rfqId);
  const p = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '', '', '', 1, 0) RETURNING id`,
    [rfqId]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, 1, $2, 0)`,
    [rfqId, VA]
  );
  return { rfqId, productId: Number(p.id) };
}

async function openRfqRound(endDate) {
  const { rfqId, productId } = await rfqWithProduct();
  const m = mockExpress({
    rfq_id: rfqId,
    rfq_product_id: productId,
    end_date: endDate,
    vendor_targets: [{ vendor_id: VA, fields: [{ name: "base_price", target: 10 }] }],
  });
  await negotiationController.createRound(m.req, m.res);
  return { ...m.calls, rfqId };
}

// ── ARC ─────────────────────────────────────────────────────────────────────
const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_commApp;
const CATEGORY = TEST_CATEGORIES.beverages;
const POLICY_ID = 64981;
const E = "/api/v1/arc-v2/evaluation";

describe("negotiation rounds need at least two hours before their deadline", () => {
  let typesBefore = {};
  let buyerClient, approverClient, arcId, itemId;

  beforeAll(async () => {
    for (const r of await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [[VA, NEGOTIATOR, BUYER, APPROVER]])) {
      typesBefore[r.id] = r.user_type;
    }
    await db.none(`UPDATE tbl_users SET user_type=3, status=1 WHERE id=$1`, [VA]);
    await db.none(`UPDATE tbl_users SET user_type=2, status=1 WHERE id = ANY($1::int[])`, [[NEGOTIATOR, BUYER, APPROVER]]);

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
       VALUES ('ARC-NEG-WIN-1','Minimum Window Test',$1,$2,$3,$4,$5,'comm_eval_in_progress',
               NOW()-INTERVAL '10 days',NOW()-INTERVAL '1 day',NOW()+INTERVAL '7 days',NOW()+INTERVAL '180 days',$6,'open')
       RETURNING id`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    itemId = (await db.one(
      `INSERT INTO tbl_arc_item (arc_id,product_variant_id,indicative_qty,uom,target_price)
       VALUES ($1,1,1000,'kg',120) RETURNING id`, [arcId]
    )).id;
    await db.none(`INSERT INTO tbl_arc_invitation (arc_id,vendor_id,status) VALUES ($1,$2,'invited') ON CONFLICT DO NOTHING`, [arcId, VA]);
    const q = await db.one(`INSERT INTO tbl_arc_quote (arc_id,vendor_id,submitted_at) VALUES ($1,$2,NOW()) RETURNING id`, [arcId, VA]);
    await db.none(`INSERT INTO tbl_arc_quote_line (arc_quote_id,arc_item_id,rate,gst_pct) VALUES ($1,$2,240,5)`, [q.id, itemId]);

    buyerClient = await httpClient(BUYER);
    approverClient = await httpClient(APPROVER);
  });

  afterEach(async () => {
    if (!rfqIds.length) return;
    const roundIds = (await db.any(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`, [rfqIds])).map((r) => Number(r.id));
    if (roundIds.length) {
      const insts = (await db.any(`SELECT id FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[])`, [roundIds])).map((r) => r.id);
      if (insts.length) {
        await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [insts]);
        await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [insts]);
        await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [insts]);
        await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [insts]);
      }
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [roundIds]);
    }
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
    rfqIds.length = 0;
  });

  afterAll(async () => {
    if (arcId) {
      const rids = (await db.any(`SELECT id FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1`, [arcId])).map((r) => r.id);
      if (rids.length) {
        const insts = (await db.any(`SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=ANY($1::int[])`, [rids])).map((r) => r.id);
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
    for (const [id, t] of Object.entries(typesBefore)) {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [Number(id), t]);
    }
  });

  describe("RFQ rounds", () => {
    it("refuses a deadline 90 minutes out, and stores no round", async () => {
      const { status, body, rfqId } = await openRfqRound(inMs(90 * MIN));
      expect(status).toBe(400);
      expect(body.message).toBe(TOO_SHORT);
      const n = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_negotiation_rounds WHERE rfq_id=$1`, [rfqId]);
      expect(n.n).toBe(0);
    });

    it("refuses 1 h 59 min — the floor is two full hours", async () => {
      const { status, body } = await openRfqRound(inMs(119 * MIN));
      expect(status).toBe(400);
      expect(body.message).toBe(TOO_SHORT);
    });

    it("accepts 2 h 1 min", async () => {
      const { status } = await openRfqRound(inMs(121 * MIN));
      expect(status).toBe(200);
    });

    it("measures the window on the instant, not the digits, when the browser sends +05:30", async () => {
      expect((await openRfqRound(inMsIst(121 * MIN))).status).toBe(200);
      const tooSoon = await openRfqRound(inMsIst(100 * MIN));
      expect(tooSoon.status).toBe(400);
      expect(tooSoon.body.message).toBe(TOO_SHORT);
    });

    it("still answers a past deadline with the existing message", async () => {
      const { status, body } = await openRfqRound(inMs(-10 * MIN));
      expect(status).toBe(400);
      expect(body.message).toBe("End date must be in the future");
    });
  });

  describe("ARC rounds", () => {
    const createArcRound = (endDate) =>
      buyerClient.post(`${E}/${arcId}/comm-eval/negotiation/rounds`).send({
        end_date: endDate,
        products: [{ arc_item_id: itemId, vendor_targets: [{ vendor_id: VA, fields: [{ name: "base_price", target: "200" }] }] }],
      });

    const clearArcRounds = async () => {
      const rids = (await db.any(`SELECT id FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1`, [arcId])).map((r) => r.id);
      if (!rids.length) return;
      // A live round on the item blocks the next one, so each test starts clean.
      await db.none(`UPDATE tbl_negotiation_rounds SET status='CANCELLED' WHERE id = ANY($1::int[])`, [rids]);
      await db.none(`UPDATE tbl_approval_instances SET status='CANCELLED' WHERE entity_type='ARC_NEGOTIATION' AND entity_id = ANY($1::int[]) AND status='PENDING'`, [rids]);
    };

    afterEach(clearArcRounds);

    it("refuses a deadline 90 minutes out with the same message", async () => {
      const res = await createArcRound(inMs(90 * MIN));
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(TOO_SHORT);
      const n = await db.one(
        `SELECT COUNT(*)::int AS n FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1 AND status <> 'CANCELLED'`,
        [arcId]
      );
      expect(n.n).toBe(0);
    });

    it("accepts three hours and leaves the round awaiting its approver", async () => {
      const res = await createArcRound(inMs(180 * MIN));
      expect(res.status).toBe(200);
      const row = await db.one(`SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [res.body.data.id]);
      expect(row.status).toBe("PENDING_APPROVAL");
    });

    it("cannot be approved once its deadline has passed — it stays awaiting approval", async () => {
      const res = await createArcRound(inMs(180 * MIN));
      expect(res.status).toBe(200);
      const roundId = Number(res.body.data.id);
      // end_date is a naive UTC column.
      await db.none(
        `UPDATE tbl_negotiation_rounds SET end_date = (now() AT TIME ZONE 'UTC') - INTERVAL '5 minutes' WHERE id=$1`,
        [roundId]
      );
      const approve = await approverClient.post(`${E}/${arcId}/comm-eval/negotiation/rounds/${roundId}/approve`).send({});
      expect(approve.status).toBe(400);
      expect(approve.body.message).toMatch(/deadline has passed/i);
      const row = await db.one(`SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [roundId]);
      expect(row.status).toBe("PENDING_APPROVAL");
    });
  });
});
