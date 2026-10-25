// ARC negotiation — a round whose approval completed without its handler.
//
// An ARC_NEGOTIATION round goes ACTIVE (and its vendors are invited) only in
// handleArcNegotiationApproval. Two ways an instance completes left that
// handler unrun:
//   - approvalPropagationService auto-completing it after a policy or
//     membership change: its dispatch registry had no ARC_NEGOTIATION entry;
//   - a handler that failed after the instance was APPROVED.
// The round then sat PENDING_APPROVAL under an APPROVED instance. Clicking
// Approve used to "fix" it by replaying APPROVE on the concluded instance
// (approveRound fell back to `instances[0]`); once replays stopped running
// handlers, that answered "Vote recorded" with allApproved:true while the
// round stayed stuck.
//
// Pinned here, through HTTP and the propagation entry point:
//   - propagation completing the instance activates the round, once;
//   - Approve on a stuck round, by someone who could approve it, finishes it;
//     Reject on it, and a second Approve, are refused, never a success;
//   - another company's caller gets the answer a missing round gets (404).
//
// Real HTTP + Postgres, the real ARC Commercial Evaluator role.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { handleAutoCompletedInstances } from "../../../app/services/approvalPropagationService.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const EVAL_1   = IDS.users.a1_proc_buyer;    // creates the round
const EVAL_2   = IDS.users.a1_proc_commEval;
const EVAL_3   = IDS.users.a1_proc_commApp;
const OUTSIDER = IDS.users.companyB_admin;   // company B only
const VENDOR_A = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT  = 1;

const POLICY_ALL = 64996; // hotel A1, [ROLE ARC Commercial Evaluator, ALL]
const SCOPE_BASE = 64996; // tbl_user_role_scopes ids 64996..64998
const E = "/api/v1/arc-v2/evaluation";
const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();

describe("ARC negotiation — a round stuck under an APPROVED instance", () => {
  let roleId;
  const arcIds = [];
  let originalUsers = [];
  let insertedCategoryDept = false;
  let seq = 0;

  async function seedArc() {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ($1, 'Round recovery', $2, $3, $4, $5, $6, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days', $7, 'open')
       RETURNING id`,
      [`ARC-RECOVER-${Date.now()}-${seq++}`, CATEGORY, HC, HOTEL, DEPT, PROC, EVAL_1]
    );
    arcIds.push(arc.id);
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 1000, 'litre', 120) RETURNING id`,
      [arc.id, VARIANT]
    );
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1, $2, 'invited')
       ON CONFLICT DO NOTHING`, [arc.id, VENDOR_A]
    );
    const q = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at) VALUES ($1, $2, NOW()) RETURNING id`,
      [arc.id, VENDOR_A]
    );
    await db.none(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct) VALUES ($1, $2, 90, 18)`,
      [q.id, item.id]
    );
    return { arcId: Number(arc.id), itemId: Number(item.id) };
  }

  /** A round awaiting EVAL_2 and EVAL_3 (rule ALL; the creator's slot is auto-approved). */
  async function launchRound(arc) {
    const res = await (await httpClient(EVAL_1)).post(`${E}/${arc.arcId}/comm-eval/negotiation/rounds`).send({
      end_date: D(1),
      products: [{ arc_item_id: arc.itemId, vendor_targets: [{ vendor_id: VENDOR_A, target_rate: 80 }] }],
    });
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    const roundId = Number(res.body.data.id);
    const instance = await db.one(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_NEGOTIATION' AND entity_id = $1`, [roundId]);
    return { roundId, instanceId: Number(instance.id) };
  }

  /** What propagation (or an older handler failure) left behind: the instance APPROVED, the round untouched. */
  async function completeWithoutHandler(instanceId) {
    await db.none(
      `UPDATE tbl_approval_step_approvers SET status = 'APPROVED'
        WHERE status = 'PENDING' AND approval_instance_step_id IN
              (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1)`, [instanceId]);
    await db.none(
      `UPDATE tbl_approval_instance_steps SET status = 'APPROVED' WHERE approval_instance_id = $1`, [instanceId]);
    await db.none(
      `UPDATE tbl_approval_instances SET status = 'APPROVED', completed_at = NOW() WHERE id = $1`, [instanceId]);
  }

  const round = async (id) => db.one(
    `SELECT status, approved_at, published_at, vendor_approvals FROM tbl_negotiation_rounds WHERE id = $1`, [id]);
  const startedEvents = async (arcId, roundId) => (await db.one(
    `SELECT count(*)::int AS n FROM tbl_arc_event_log
      WHERE arc_id = $1 AND event_type = 'negotiation_round_started' AND (payload->>'round_id')::int = $2`,
    [arcId, roundId])).n;
  const approve = async (userId, arcId, roundId) =>
    (await httpClient(userId)).post(`${E}/${arcId}/comm-eval/negotiation/rounds/${roundId}/approve`).send({});
  const reject = async (userId, arcId, roundId) =>
    (await httpClient(userId)).post(`${E}/${arcId}/comm-eval/negotiation/rounds/${roundId}/reject`)
      .send({ comment: "not now" });

  beforeAll(async () => {
    originalUsers = await db.any(
      `SELECT id, user_type, status FROM tbl_users WHERE id = ANY($1::int[])`,
      [[EVAL_1, EVAL_2, EVAL_3, VENDOR_A, OUTSIDER]]
    );
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`,
      [[EVAL_1, EVAL_2, EVAL_3, OUTSIDER]]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR_A]);
    insertedCategoryDept = !(await db.oneOrNone(
      `SELECT 1 FROM tbl_category_department WHERE category_id=$1 AND department_id=$2`, [CATEGORY, DEPT]));
    if (insertedCategoryDept) {
      await db.none(
        `INSERT INTO tbl_category_department (category_id, department_id) VALUES ($1, $2)`, [CATEGORY, DEPT]);
    }

    roleId = (await db.one(
      `SELECT id FROM tbl_roles WHERE created_by IS NULL AND title='ARC Commercial Evaluator'`
    )).id;
    const evaluators = [EVAL_1, EVAL_2, EVAL_3];
    for (let i = 0; i < evaluators.length; i++) {
      await db.none(
        `INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id)
         VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (id) DO NOTHING`,
        [SCOPE_BASE + i, evaluators[i], roleId, HC, HOTEL]
      );
    }

    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id, is_active,
          created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_NEGOTIATION', $2, $3, NULL, true, $4, NULL, false, false, 1)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [POLICY_ALL, HC, HOTEL, EVAL_1]
    );
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [POLICY_ALL]);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'ROLE', $2)`,
      [POLICY_ALL, roleId]
    );
  });

  afterAll(async () => {
    for (const u of originalUsers) {
      await db.none(`UPDATE tbl_users SET user_type=$2, status=$3 WHERE id=$1`, [u.id, u.user_type, u.status]);
    }
    if (insertedCategoryDept) {
      await db.none(`DELETE FROM tbl_category_department WHERE category_id=$1 AND department_id=$2`, [CATEGORY, DEPT]);
    }
    for (const aid of arcIds) {
      const rids = (await db.any(
        `SELECT id FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1`, [aid])).map((r) => r.id);
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
      await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id=$1)`, [aid]);
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id=$1`, [aid]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id=$1`, [aid]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id=$1`, [aid]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [aid]);
      await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [aid]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [POLICY_ALL]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id=$1`, [POLICY_ALL]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id >= $1 AND id < $2`, [SCOPE_BASE, SCOPE_BASE + 3]);
  });

  test("propagation completing the instance activates the round, once", async () => {
    const arc = await seedArc();
    const { roundId, instanceId } = await launchRound(arc);
    expect((await round(roundId)).status).toBe("PENDING_APPROVAL");

    await completeWithoutHandler(instanceId);
    await handleAutoCompletedInstances([instanceId], EVAL_1, "approver membership change");

    const after = await round(roundId);
    expect(after.status).toBe("ACTIVE");
    expect(after.approved_at).not.toBeNull();
    expect(after.vendor_approvals.map((v) => v.status)).toEqual(["APPROVED"]);
    expect(await startedEvents(arc.arcId, roundId)).toBe(1);

    // A second completion (another surface reaching the handler) changes nothing.
    await handleAutoCompletedInstances([instanceId], EVAL_1, "approver membership change");
    expect((await round(roundId)).approved_at).toEqual(after.approved_at);
    expect(await startedEvents(arc.arcId, roundId)).toBe(1);
  });

  test("Approve on a stuck round finishes it; a second Approve and a Reject are refused, never a success", async () => {
    const arc = await seedArc();
    const { roundId, instanceId } = await launchRound(arc);
    await completeWithoutHandler(instanceId);
    expect((await round(roundId)).status).toBe("PENDING_APPROVAL");

    const rejected = await reject(EVAL_3, arc.arcId, roundId);
    expect(rejected.status).toBe(409);
    expect(rejected.body.status).not.toBe(1);
    expect((await round(roundId)).status).toBe("PENDING_APPROVAL");

    const recovered = await approve(EVAL_2, arc.arcId, roundId);
    expect(recovered.status).toBe(200);
    expect(recovered.body.data).toMatchObject({ allApproved: true, recovered: true });
    expect((await round(roundId)).status).toBe("ACTIVE");
    expect(await startedEvents(arc.arcId, roundId)).toBe(1);

    const again = await approve(EVAL_3, arc.arcId, roundId);
    expect(again.status).toBe(400);
    expect(await startedEvents(arc.arcId, roundId)).toBe(1);
  });

  test("another company's caller is answered like a missing round, and nothing changes", async () => {
    const arc = await seedArc();
    const { roundId, instanceId } = await launchRound(arc);
    const { missing } = await db.one(`SELECT COALESCE(MAX(id), 0) + 100000 AS missing FROM tbl_negotiation_rounds`);

    for (const act of [approve, reject]) {
      const foreign = await act(OUTSIDER, arc.arcId, roundId);
      const nonexistent = await act(OUTSIDER, arc.arcId, Number(missing));
      expect(foreign.status).toBe(404);
      expect(foreign.status).toBe(nonexistent.status);
      expect(foreign.body).toEqual(nonexistent.body);
    }
    expect((await round(roundId)).status).toBe("PENDING_APPROVAL");

    // Stuck under an APPROVED instance: the recovery is not theirs either.
    await completeWithoutHandler(instanceId);
    const foreign = await approve(OUTSIDER, arc.arcId, roundId);
    expect(foreign.status).toBe(404);
    expect((await round(roundId)).status).toBe("PENDING_APPROVAL");
    expect(await startedEvents(arc.arcId, roundId)).toBe(0);
  });
});
