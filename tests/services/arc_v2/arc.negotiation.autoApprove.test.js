// ARC negotiation — an auto-approved round is ACTIVE when createRound commits.
//
// When the creator is the only approver (INITIATOR_ONLY), the round must be
// active and its vendor rows approved in the same transaction that creates it.
// Fix round 3 had moved that activation to the after-commit dispatch, so any
// failure between the commit and the handler (the dispatch throwing, the
// process dying) left a round PENDING_APPROVAL under an APPROVED instance.
//
// Pinned here with the after-commit steps failing on purpose: the post-approval
// dispatch throws, and the "round started" vendor notification throws. The
// request still answers 200 with a round that is ACTIVE, its vendors APPROVED
// and one negotiation_round_started event.
//
// Real HTTP + Postgres, the real ARC Commercial Evaluator role and policy engine.

import { describe, test, expect, beforeAll, afterAll, jest } from "@jest/globals";

const actualNotify = await import("../../../app/services/arcNotificationService.js");
jest.unstable_mockModule("../../../app/services/arcNotificationService.js", () => ({
  ...actualNotify,
  notifyArcEvent: async (args) => {
    if (args?.eventType === "negotiation_round_started") throw new Error("notify failed (test)");
    return actualNotify.notifyArcEvent(args);
  },
}));
const actualDispatch = await import("../../../app/services/approvalActionService.js");
jest.unstable_mockModule("../../../app/services/approvalActionService.js", () => ({
  ...actualDispatch,
  dispatchPostApprovalAction: async () => { throw new Error("dispatch failed (test)"); },
}));

const { httpClient } = await import("../../helpers/http.js");
const { db } = await import("../../setup/db.js");
const { IDS } = await import("../../fixtures/ids.js");
const { TEST_CATEGORIES } = await import("../../fixtures/vendors.js");

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const CREATOR  = IDS.users.a1_proc_buyer;   // the only ARC Commercial Evaluator at the hotel
const VENDOR_A = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT  = 1;

const POLICY_ID = 64988; // hotel A1, [ROLE ARC Commercial Evaluator, ALL]
const SCOPE_ID  = 64987;
const E = "/api/v1/arc-v2/evaluation";
const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();

describe("ARC negotiation — auto-approved round activates in the creating transaction", () => {
  let arcId;
  let itemId;
  let originalUsers = [];
  let insertedCategoryDept = false;

  beforeAll(async () => {
    originalUsers = await db.any(`SELECT id, user_type, status FROM tbl_users WHERE id = ANY($1::int[])`, [[CREATOR, VENDOR_A]]);
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [CREATOR]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR_A]);
    insertedCategoryDept = !(await db.oneOrNone(
      `SELECT 1 FROM tbl_category_department WHERE category_id=$1 AND department_id=$2`, [CATEGORY, DEPT]));
    if (insertedCategoryDept) {
      await db.none(`INSERT INTO tbl_category_department (category_id, department_id) VALUES ($1, $2)`, [CATEGORY, DEPT]);
    }
    const roleId = (await db.one(
      `SELECT id FROM tbl_roles WHERE created_by IS NULL AND title='ARC Commercial Evaluator'`)).id;
    await db.none(
      `INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (id) DO NOTHING`,
      [SCOPE_ID, CREATOR, roleId, HC, HOTEL]);
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id, is_active,
          created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_NEGOTIATION', $2, $3, NULL, true, $4, NULL, false, false, 1)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [POLICY_ID, HC, HOTEL, CREATOR]);
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [POLICY_ID]);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'ROLE', $2)`, [POLICY_ID, roleId]);

    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ($1, 'Auto-approved round', $2, $3, $4, $5, $6, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days', $7, 'open')
       RETURNING id`,
      [`ARC-AUTO-${Date.now()}`, CATEGORY, HC, HOTEL, DEPT, PROC, CREATOR]);
    arcId = Number(arc.id);
    itemId = Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 1000, 'litre', 120) RETURNING id`, [arcId, VARIANT])).id);
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1, $2, 'invited') ON CONFLICT DO NOTHING`,
      [arcId, VENDOR_A]);
    const q = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at) VALUES ($1, $2, NOW()) RETURNING id`, [arcId, VENDOR_A]);
    await db.none(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct) VALUES ($1, $2, 90, 18)`, [q.id, itemId]);
  });

  afterAll(async () => {
    const rids = (await db.any(
      `SELECT id FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1`, [arcId])).map((r) => r.id);
    if (rids.length) {
      const iids = (await db.any(
        `SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=ANY($1::int[])`,
        [rids])).map((i) => i.id);
      if (iids.length) {
        await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=ANY($1::int[])`, [iids]);
        await db.none(
          `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
             (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[]))`, [iids]);
        await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[])`, [iids]);
        await db.none(`DELETE FROM tbl_approval_instances WHERE id=ANY($1::int[])`, [iids]);
      }
      await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id=ANY($1::int[])`, [rids]);
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=ANY($1::int[])`, [rids]);
    }
    await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id=$1)`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id=$1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id=$1`, [SCOPE_ID]);
    if (insertedCategoryDept) {
      await db.none(`DELETE FROM tbl_category_department WHERE category_id=$1 AND department_id=$2`, [CATEGORY, DEPT]);
    }
    for (const u of originalUsers) {
      await db.none(`UPDATE tbl_users SET user_type=$2, status=$3 WHERE id=$1`, [u.id, u.user_type, u.status]);
    }
  });

  test("the round is ACTIVE, its vendors approved and its start logged, though everything after commit failed", async () => {
    const res = await (await httpClient(CREATOR)).post(`${E}/${arcId}/comm-eval/negotiation/rounds`).send({
      end_date: D(1),
      products: [{ arc_item_id: itemId, vendor_targets: [{ vendor_id: VENDOR_A, target_rate: 80 }] }],
    });
    expect(res.status).toBe(200);
    const roundId = Number(res.body.data.id);

    const round = await db.one(
      `SELECT status, approved_at, published_at, vendor_approvals FROM tbl_negotiation_rounds WHERE id = $1`, [roundId]);
    expect(round.status).toBe("ACTIVE");
    expect(round.approved_at).not.toBeNull();
    expect(round.published_at).not.toBeNull();
    expect(round.vendor_approvals.map((v) => v.status)).toEqual(["APPROVED"]);

    const inst = await db.one(
      `SELECT status, metadata FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=$1`, [roundId]);
    expect(inst.status).toBe("APPROVED");
    expect(inst.metadata.auto_approval.case).toBe("INITIATOR_ONLY");

    const started = await db.one(
      `SELECT count(*)::int AS n FROM tbl_arc_event_log
        WHERE arc_id = $1 AND event_type = 'negotiation_round_started' AND (payload->>'round_id')::int = $2`,
      [arcId, roundId]);
    expect(started.n).toBe(1);
  });
});
