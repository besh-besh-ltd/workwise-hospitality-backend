// Smoke test for tests/helpers/approval.js. Drives the production engine end
// to end — useful both as the helper's own correctness check AND as a
// reference for how follow-up tests (Tasks 26, 27, 29, 30) will use it.

import { describe, it, expect, afterAll } from "@jest/globals";
import { db, withTx, closeDb } from "../setup/db.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";
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
