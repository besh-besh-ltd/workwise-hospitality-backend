// Two completions of one approval instance run its handler once.
//
// approvalPropagationService.advanceInstanceToNextStep completes an instance
// whose last step is done. Two propagations (a policy save and a membership
// change, say) can complete the SAME instance at once: both read it PENDING,
// both wrote APPROVED, both reported it completed, and both callers
// dispatched its post-approval handler. A handler that is not idempotent then
// ran twice (ARC_TECH: two tech_eval_approved events, two notifications).
//
// Now the APPROVED write is conditional on the row still being PENDING; the
// second completion waits on the first's row lock, finds it APPROVED, writes
// nothing and reports nothing completed.
//
// And the ARC publish float, reached twice at once, floats once: floatArc's
// status flip is conditional on 'pending_publish_approval'.
//
// Real Postgres, two real concurrent transactions.

import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import {
  advanceInstanceToNextStep,
  handleAutoCompletedInstances,
} from "../../app/services/approvalPropagationService.js";
import { dispatchPostApprovalAction } from "../../app/services/approvalActionService.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const ACTOR = IDS.users.a1_proc_buyer;
const POLICY_ID = 64986; // inactive: never matched by a resolver
const CATEGORY = TEST_CATEGORIES.beverages;

const arcIds = [];
const instanceIds = [];

async function seedArc(status) {
  const row = await db.one(
    `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
                          process_id, status, created_by, eligibility_type,
                          submission_start_at, submission_end_at, contract_start_at, contract_end_at)
     VALUES ($1, 'Completion race', $2, $3, $4, $5, $6, $7, $8, 'open',
             NOW() + INTERVAL '1 day', NOW() + INTERVAL '10 days', NOW() + INTERVAL '20 days', NOW() + INTERVAL '200 days')
     RETURNING id`,
    [`ARC-RACE-${Date.now()}-${arcIds.length}`, CATEGORY, HC, HOTEL, DEPT, PROC, status, ACTOR]
  );
  arcIds.push(Number(row.id));
  await db.none(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
     VALUES ($1, 1, 100, 'litre', 120)`, [row.id]);
  return Number(row.id);
}

async function instanceFor(type, arcId, status = "PENDING") {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances (entity_type, entity_id, approval_policy_id, status, current_step,
                                         initiated_by, hospitality_company_id, hotel_id, department_id, metadata)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, NULL, $8::jsonb) RETURNING id`,
    [type, arcId, POLICY_ID, status, ACTOR, HC, HOTEL, JSON.stringify({ arc_id: arcId })]
  );
  instanceIds.push(Number(inst.id));
  await db.none(
    `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, 'ANY', $2)`, [inst.id, status === "PENDING" ? "APPROVED" : status]);
  return Number(inst.id);
}

const events = async (arcId, types) => (await db.any(
  `SELECT event_type FROM tbl_arc_event_log WHERE arc_id = $1 AND event_type = ANY($2::text[])`,
  [arcId, types])).map((r) => r.event_type);

beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_approval_policies (id, entity_type, hospitality_company_id, hotel_id, department_id,
                                        is_active, created_by, process_id, is_master, is_department_scoped, version)
     VALUES ($1, 'ARC', $2, $3, NULL, false, $4, NULL, false, false, 1)
     ON CONFLICT (id) DO NOTHING`, [POLICY_ID, HC, HOTEL, ACTOR]);
});

afterAll(async () => {
  if (instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE (metadata->>'approval_instance_id') = ANY($1::text[])`,
      [instanceIds.map(String)]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
  }
  for (const id of arcIds) {
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [id]);
    await db.none(`DELETE FROM tbl_arc_invitation_hotel
                    WHERE arc_invitation_id IN (SELECT id FROM tbl_arc_invitation WHERE arc_id = $1)`, [id]);
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [id]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [id]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [id]);
  }
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
});

describe("two completions of one instance", () => {
  it("only the first reports it completed, so its handler is dispatched once", async () => {
    const arcId = await seedArc("tech_eval_in_progress");
    const instanceId = await instanceFor("ARC_TECH", arcId);

    // The first completion takes the instance row and holds its transaction
    // open; the second starts while it is open and waits on the row lock.
    let release;
    const gate = new Promise((r) => { release = r; });
    let firstWrote;
    const wrote = new Promise((r) => { firstWrote = r; });
    const first = db.tx(async (t) => {
      const adv = await advanceInstanceToNextStep(instanceId, t);
      firstWrote();
      await gate;
      return adv;
    });
    await wrote;
    const second = db.tx((t) => advanceInstanceToNextStep(instanceId, t));
    await new Promise((r) => setTimeout(r, 300));
    release();
    const results = await Promise.all([first, second]);

    expect(results.map((r) => r.instanceCompleted)).toEqual([true, false]);
    // Each caller dispatches what it completed, as the propagation callers do.
    for (const r of results) {
      if (r.instanceCompleted) await handleAutoCompletedInstances([instanceId], ACTOR, "test race");
    }
    expect((await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [instanceId])).status).toBe("APPROVED");
    expect(await events(arcId, ["tech_eval_approved"])).toEqual(["tech_eval_approved"]);
  });

  it("an ARC publish reached twice at once floats (or parks) once", async () => {
    const arcId = await seedArc("pending_publish_approval");
    const instanceId = await instanceFor("ARC_PUBLISH", arcId, "APPROVED");

    await Promise.all([
      dispatchPostApprovalAction(instanceId, ACTOR, { status: "APPROVED" }),
      dispatchPostApprovalAction(instanceId, ACTOR, { status: "APPROVED" }),
    ]);

    // 'floated' is the PUBLISHED event; 'publish_rejected' the empty-panel park.
    const outcome = await events(arcId, ["floated", "publish_rejected"]);
    expect(outcome).toHaveLength(1);
    const { status } = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(status).toBe(outcome[0]);
  });
});
