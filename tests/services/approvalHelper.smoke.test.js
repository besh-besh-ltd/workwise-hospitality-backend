// Smoke test for tests/helpers/approval.js. Drives the production engine end
// to end — useful both as the helper's own correctness check AND as a
// reference for how follow-up tests (Tasks 26, 27, 29, 30) will use it.

import { describe, it, expect, afterAll } from "@jest/globals";
import { db, withTx, closeDb } from "../setup/db.js";
import { createApprovalInstance, getApprovalWorkflowUsers } from "../../app/models/generalModel.js";
import { IDS } from "../fixtures/ids.js";
import {
  approveStep, rejectStep, approveFully, getInstanceState, getLatestAction,
} from "../helpers/approval.js";

let ENTITY_ID = 7_000_000;
const nextEntityId = () => ++ENTITY_ID;

// Most engine calls accept a txContext, but executeApprovalAction's underlying
// `submitApprovalAction` opens its own `db.tx` — we cannot pass our test
// transaction in. Tests that drive the production engine therefore use a
// commit + cleanup pattern instead of withTx (see CONVENTIONS.md §2 Pattern B).
//
// We commit the approval instance via a real createApprovalInstance call (no
// txContext), let the helper drive it to terminal state, assert, then clean
// up via afterEach.

const insertedInstanceIds = [];
async function createInstanceCommitted({ entity_type = "RFQ", policy_id }) {
  const entity_id = nextEntityId();
  const result = await createApprovalInstance({
    entity_type,
    entity_id,
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: IDS.hotels.A1,
    department_id: null, // master policy
    process_id: IDS.processes.A_P1,
    approval_policy_id: policy_id,
    initiated_by: IDS.users.a1_proc_buyer,
  });
  insertedInstanceIds.push(result.instance.id);
  return result.instance.id;
}

afterAll(async () => {
  if (insertedInstanceIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`,
      [insertedInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_step_approvers
       WHERE approval_instance_step_id IN (
         SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])
       )`,
      [insertedInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`,
      [insertedInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`,
      [insertedInstanceIds]
    );
  }
  // closeDb LAST so cleanup queries above can still use the pool.
  await closeDb();
});

describe("approval helper — single-step instance (PO at A1/P1, 1 step)", () => {
  // Use the engineering RFQ ANY-policy fixture? Or the smaller PO in fixtures?
  // A1_P1_NEGOTIATION is a 1-step ANY policy by USER (a1_proc_commApp) — perfect.
  it("approveStep flips a 1-step ANY-policy instance APPROVED", async () => {
    const instanceId = await createInstanceCommitted({
      entity_type: "NEGOTIATION",
      policy_id: IDS.policies.A1_P1_NEGOTIATION,
    });

    // The 1-step policy has TECH_APPROVER role at step 1; resolved approvers
    // include any user with that role. We just need ONE acting approver.
    const before = await getInstanceState(instanceId);
    expect(before.instance.status).toBe("PENDING");
    expect(before.steps.length).toBe(1);

    const approverId = before.steps[0].approvers.find((a) => a.status === "PENDING").approver_user_id;
    const result = await approveStep(instanceId, approverId);

    expect(result.instance_status).toBe("APPROVED");
    const after = await getInstanceState(instanceId);
    expect(after.instance.status).toBe("APPROVED");
    expect(after.instance.completed_at).not.toBeNull();
  });

  it("rejectStep flips a 1-step instance REJECTED", async () => {
    const instanceId = await createInstanceCommitted({
      entity_type: "NEGOTIATION",
      policy_id: IDS.policies.A1_P1_NEGOTIATION,
    });
    const before = await getInstanceState(instanceId);
    const approverId = before.steps[0].approvers.find((a) => a.status === "PENDING").approver_user_id;
    const result = await rejectStep(instanceId, approverId, { comment: "no thanks" });

    expect(result.instance_status).toBe("REJECTED");
    const after = await getInstanceState(instanceId);
    expect(after.instance.status).toBe("REJECTED");

    const action = await getLatestAction(instanceId);
    expect(action.action).toBe("REJECT");
    expect(action.comment).toBe("no thanks");
  });
});

describe("approval helper — multi-step instance (PO at A1/P1, 3 steps ALL)", () => {
  it("approveFully walks every step until APPROVED", async () => {
    // A1_P1_PO has 3 steps in the policy, but the engine SKIPs ROLE-based
    // steps whose role lacks `awarding.read` + `awarding.approve` permissions.
    // We don't assert on step count — we assert the helper drives the
    // instance to terminal APPROVED regardless of how many materialised.
    const instanceId = await createInstanceCommitted({
      entity_type: "PO",
      policy_id: IDS.policies.A1_P1_PO,
    });
    const before = await getInstanceState(instanceId);
    expect(before.instance.status).toBe("PENDING");
    expect(before.steps.length).toBeGreaterThanOrEqual(1);

    const final = await approveFully(instanceId);
    expect(final.instance.status).toBe("APPROVED");

    // Every step that was created should terminate APPROVED.
    for (const step of final.steps) {
      expect(step.status).toBe("APPROVED");
    }
    const actions = await db.any(
      `SELECT action FROM tbl_approval_actions WHERE approval_instance_id=$1 ORDER BY id`,
      [instanceId]
    );
    expect(actions.filter((a) => a.action === "APPROVE").length).toBe(final.steps.length);
  });

  it("rejection at step 1 terminates a multi-step instance immediately (REJECTED)", async () => {
    const instanceId = await createInstanceCommitted({
      entity_type: "PO",
      policy_id: IDS.policies.A1_P1_PO,
    });
    const state = await getInstanceState(instanceId);
    expect(state.steps.length).toBeGreaterThanOrEqual(1);
    const step1ApproverId = state.steps[0].approvers.find((a) => a.status === "PENDING").approver_user_id;

    const result = await rejectStep(instanceId, step1ApproverId, { comment: "vetoed at step 1" });
    expect(result.instance_status).toBe("REJECTED");

    const after = await getInstanceState(instanceId);
    expect(after.instance.status).toBe("REJECTED");
    expect(after.steps[0].status).toBe("REJECTED");
    // Any later steps must NOT have been processed (no APPROVED/REJECTED past step 1).
    for (let i = 1; i < after.steps.length; i++) {
      expect(["PENDING", "SKIPPED", "CANCELLED"]).toContain(after.steps[i].status);
    }
  });
});

describe("approval helper — getInstanceState shape", () => {
  it("returns null for non-existent instance", async () => {
    expect(await getInstanceState(999999999)).toBeNull();
  });
});

// getApprovalWorkflowUsers is the informational-notification recipient list
// (fanout to "everyone in the approval hierarchy" — rfqController.js,
// cronManager.js, arcNotificationService.js). It had no status predicate at
// all: a user whose ONLY row on the whole instance is a REMOVED tombstone
// (role revoked, mid-flight reconciler) would still get emailed about a live
// procurement they no longer have any say in. The fix must not, however,
// drop someone who is REMOVED on one step but still has a genuine
// (non-REMOVED) row on another step of the SAME instance.
describe("getApprovalWorkflowUsers — REMOVED-only involvement excluded, but retained via any other non-REMOVED row", () => {
  it("drops a user whose sole row is REMOVED, keeps a live approver, and keeps a user with a REMOVED row on one step + a live row on another", async () => {
    const entityId = nextEntityId();
    const userIds = await withTx(async (t) => {
      const inst = await t.one(
        `INSERT INTO tbl_approval_instances
           (entity_type, entity_id, approval_policy_id, status, current_step,
            hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
         VALUES ('RFQ', $1, $2, 'PENDING', 2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          entityId, IDS.policies.A1_P1_RFQ, IDS.hospitality.A, IDS.hotels.A1,
          IDS.departments.proc, IDS.users.a1_proc_buyer, IDS.processes.A_P1,
        ]
      );
      const step1 = await t.one(
        `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
         VALUES ($1, 1, 'ANY', 'APPROVED') RETURNING id`,
        [inst.id]
      );
      const step2 = await t.one(
        `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
         VALUES ($1, 2, 'ANY', 'PENDING') RETURNING id`,
        [inst.id]
      );

      // Step 1: A (only-ever REMOVED) + C (REMOVED here, but live elsewhere).
      await t.none(
        `INSERT INTO tbl_approval_step_approvers
           (approval_instance_step_id, approver_user_id, status, removed_at, removal_reason)
         VALUES ($1, $2, 'REMOVED', NOW(), 'role_removed')`,
        [step1.id, IDS.users.a1_proc_poApp]
      );
      await t.none(
        `INSERT INTO tbl_approval_step_approvers
           (approval_instance_step_id, approver_user_id, status, removed_at, removal_reason)
         VALUES ($1, $2, 'REMOVED', NOW(), 'role_removed')`,
        [step1.id, IDS.users.a1_proc_commApp]
      );
      // Step 2: B (live PENDING) + C reappears live APPROVED.
      await t.none(
        `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
         VALUES ($1, $2, 'PENDING')`,
        [step2.id, IDS.users.a1_proc_finance]
      );
      await t.none(
        `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
         VALUES ($1, $2, 'APPROVED')`,
        [step2.id, IDS.users.a1_proc_commApp]
      );

      const rows = await getApprovalWorkflowUsers("RFQ", entityId, t);
      return rows.map((r) => Number(r.user_id));
    });

    // A's only row anywhere on the instance is REMOVED -> excluded.
    expect(userIds).not.toContain(IDS.users.a1_proc_poApp);
    // B is a live PENDING approver -> included.
    expect(userIds).toContain(IDS.users.a1_proc_finance);
    // C has a REMOVED row on step 1 but a live APPROVED row on step 2 ->
    // still included (retention property — REMOVED on ONE step must not
    // drop a user who is genuinely active on another).
    expect(userIds).toContain(IDS.users.a1_proc_commApp);
    // The initiator is always included via the separate UNION branch.
    expect(userIds).toContain(IDS.users.a1_proc_buyer);
  });
});
