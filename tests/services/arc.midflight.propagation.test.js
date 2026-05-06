// Phase 9 — product-level test for mid-flight policy propagation on ARC.
//
// What the buyer experiences:
//   - The procurement admin edits the ARC committee approval policy
//     while a tender is in-flight (committee inbox is open with PENDING
//     items). The edit changes step approvers, adds a step, removes a
//     step, or changes a decision rule.
//   - Every PENDING ARC approval instance under that policy is re-
//     evaluated atomically. Approvers added are added, approvers removed
//     are marked REMOVED. Existing APPROVED steps stay APPROVED.
//     Already-completed instances (APPROVED/REJECTED) are not touched.
//
// This is the engine guarantee that protects committees from a stale
// chain after a mid-flight change. Without it, an admin who swaps an
// approver out wouldn't actually unblock the live committee — the
// removed approver would still be the only one in the queue.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  computePolicyStepDiff,
  propagatePolicyChangeToInstances,
} from "../../app/services/approvalPropagationService.js";

const POLICY_ID = 60500;

beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped,
        version, company_id, is_global)
     VALUES ($1, 'ARC', $2, $3, NULL, true, $4, NULL, false, false, 1, $5, 0)
     ON CONFLICT (id) DO NOTHING`,
    [POLICY_ID, IDS.hospitality.A, IDS.hotels.A1,
     IDS.users.companyA_admin, IDS.companies.A]
  );
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_instance_change_log WHERE approval_instance_id IN (SELECT id FROM tbl_approval_instances WHERE approval_policy_id = $1)`, [POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT s.id FROM tbl_approval_instance_steps s JOIN tbl_approval_instances i ON i.id = s.approval_instance_id WHERE i.approval_policy_id = $1)`, [POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (SELECT id FROM tbl_approval_instances WHERE approval_policy_id = $1)`, [POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id IN (SELECT id FROM tbl_approval_instances WHERE approval_policy_id = $1)`, [POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_policy_change_log WHERE approval_policy_id = $1`, [POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_instances WHERE approval_policy_id = $1`, [POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
  await closeDb();
});

const inserted = { instanceIds: [], stepRowIds: [] };

afterEach(async () => {
  // Reset policy steps for the next test.
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
  if (inserted.instanceIds.length) {
    const ids = inserted.instanceIds;
    await db.none(`DELETE FROM tbl_approval_instance_change_log WHERE approval_instance_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [ids]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [ids]);
    inserted.instanceIds = [];
  }
});

/** Insert N policy steps fresh and return their rows with IDs. */
async function setPolicySteps(steps) {
  // steps: [{ step_order, decision_rule, approver_source_type, approver_source_id }, ...]
  const inserted = [];
  for (const s of steps) {
    const row = await db.one(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [POLICY_ID, s.step_order, s.decision_rule, s.approver_source_type, s.approver_source_id]
    );
    inserted.push(row);
  }
  return inserted;
}

/** Create a PENDING ARC instance + per-step rows with seeded approvers. */
async function makePendingArcInstance(policySteps, status = 'PENDING') {
  const arcItemId = 199000000 + Math.floor(Math.random() * 1_000_000);
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, initiated_by, metadata, policy_version)
     VALUES ('ARC', $1, $2, $3, 1, $4, $5, $6, '{}'::jsonb, 1)
     RETURNING id`,
    [arcItemId, POLICY_ID, status, IDS.hospitality.A, IDS.hotels.A1, IDS.users.a1_proc_buyer]
  );
  inserted.instanceIds.push(inst.id);

  for (const step of policySteps) {
    const inststep = await db.one(
      `INSERT INTO tbl_approval_instance_steps
         (approval_instance_id, step_order, decision_rule, status, policy_step_id)
       VALUES ($1, $2, $3, 'PENDING', $4)
       RETURNING id`,
      [inst.id, step.step_order, step.decision_rule, step.id]
    );
    await db.none(
      `INSERT INTO tbl_approval_step_approvers
         (approval_instance_step_id, approver_user_id, status)
       VALUES ($1, $2, 'PENDING')`,
      [inststep.id, step.approver_source_id] // For USER source, approver_source_id is the user id
    );
  }

  return inst;
}

describe("ARC mid-flight policy propagation", () => {
  it("STEP_MODIFIED: swapping the step approver re-resolves the live instance's approver list", async () => {
    const oldSteps = await setPolicySteps([
      { step_order: 1, decision_rule: 'ANY', approver_source_type: 'USER', approver_source_id: IDS.users.a1_proc_commApp },
    ]);
    const inst = await makePendingArcInstance(oldSteps);

    // Admin edits the policy: same step, different approver.
    const newSteps = [{
      ...oldSteps[0],
      approver_source_type: 'USER',
      approver_source_id: IDS.users.a1_proc_finance,
    }];
    const diff = computePolicyStepDiff(oldSteps, newSteps);
    expect(diff.length).toBe(1);
    expect(diff[0].type).toBe('STEP_MODIFIED');

    await db.tx(async (t) => {
      // Update the policy_step row to the new approver before propagating.
      await t.none(
        `UPDATE tbl_approval_policy_steps
            SET approver_source_id = $1
          WHERE approval_policy_id = $2 AND step_order = $3`,
        [IDS.users.a1_proc_finance, POLICY_ID, 1]
      );
      const policy = await t.one(`SELECT * FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
      await propagatePolicyChangeToInstances({
        policyId: POLICY_ID,
        diff,
        changedBy: IDS.users.companyA_admin,
        policy,
        t,
      });
    });

    // The old approver row is REMOVED; the new approver is PENDING.
    const approvers = await db.any(
      `SELECT approver_user_id, status FROM tbl_approval_step_approvers
        WHERE approval_instance_step_id IN (
          SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1
        )
        ORDER BY id`,
      [inst.id]
    );
    const byUser = new Map(approvers.map((r) => [r.approver_user_id, r.status]));
    expect(byUser.get(IDS.users.a1_proc_commApp)).toBe('REMOVED');
    expect(byUser.get(IDS.users.a1_proc_finance)).toBe('PENDING');
  });

  it("STEP_ADDED: a new policy step appears on every PENDING instance", async () => {
    const oldSteps = await setPolicySteps([
      { step_order: 1, decision_rule: 'ANY', approver_source_type: 'USER', approver_source_id: IDS.users.a1_proc_commApp },
    ]);
    const inst = await makePendingArcInstance(oldSteps);

    // Add step 2 = a1_proc_finance.
    const newStepRow = await db.one(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 2, 'ANY', 'USER', $2)
       RETURNING *`,
      [POLICY_ID, IDS.users.a1_proc_finance]
    );
    const newSteps = [...oldSteps, newStepRow];
    const diff = computePolicyStepDiff(oldSteps, newSteps);
    expect(diff.find((d) => d.type === 'STEP_ADDED')).toBeTruthy();

    await db.tx(async (t) => {
      const policy = await t.one(`SELECT * FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
      await propagatePolicyChangeToInstances({
        policyId: POLICY_ID, diff, changedBy: IDS.users.companyA_admin, policy, t,
      });
    });

    const steps = await db.any(
      `SELECT step_order, status FROM tbl_approval_instance_steps
        WHERE approval_instance_id = $1 ORDER BY step_order`,
      [inst.id]
    );
    expect(steps.length).toBe(2);
    expect(steps[1].step_order).toBe(2);
    expect(steps[1].status).toBe('PENDING');
  });

  it("STEP_REMOVED: removing a policy step removes it from the live instance and may auto-complete", async () => {
    const oldSteps = await setPolicySteps([
      { step_order: 1, decision_rule: 'ANY', approver_source_type: 'USER', approver_source_id: IDS.users.a1_proc_commApp },
      { step_order: 2, decision_rule: 'ANY', approver_source_type: 'USER', approver_source_id: IDS.users.a1_proc_finance },
    ]);
    const inst = await makePendingArcInstance(oldSteps);

    // Remove step 2.
    await db.none(
      `DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1 AND step_order = 2`,
      [POLICY_ID]
    );
    const newSteps = oldSteps.slice(0, 1);
    const diff = computePolicyStepDiff(oldSteps, newSteps);
    expect(diff.find((d) => d.type === 'STEP_REMOVED')).toBeTruthy();

    await db.tx(async (t) => {
      const policy = await t.one(`SELECT * FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
      await propagatePolicyChangeToInstances({
        policyId: POLICY_ID, diff, changedBy: IDS.users.companyA_admin, policy, t,
      });
    });

    // Step 2 is removed/skipped — only step 1 remains active on the instance.
    const remainingSteps = await db.any(
      `SELECT step_order, status FROM tbl_approval_instance_steps
        WHERE approval_instance_id = $1
        ORDER BY step_order`,
      [inst.id]
    );
    const step2 = remainingSteps.find((s) => s.step_order === 2);
    // Either deleted or marked SKIPPED depending on engine behavior.
    if (step2) {
      expect(['SKIPPED', 'REMOVED', 'CANCELLED']).toContain(step2.status);
    }
  });

  it("APPROVED instances are NOT touched by propagation (locked decisions are immutable)", async () => {
    const oldSteps = await setPolicySteps([
      { step_order: 1, decision_rule: 'ANY', approver_source_type: 'USER', approver_source_id: IDS.users.a1_proc_commApp },
    ]);
    const approvedInst = await makePendingArcInstance(oldSteps, 'APPROVED');

    // Now the admin swaps the approver.
    const newSteps = [{
      ...oldSteps[0],
      approver_source_id: IDS.users.a1_proc_finance,
    }];
    const diff = computePolicyStepDiff(oldSteps, newSteps);

    await db.tx(async (t) => {
      const policy = await t.one(`SELECT * FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
      await propagatePolicyChangeToInstances({
        policyId: POLICY_ID, diff, changedBy: IDS.users.companyA_admin, policy, t,
      });
    });

    // The APPROVED instance keeps its original approver list — no REMOVED rows,
    // no new PENDING rows. Already-decided trail stays intact.
    const approvers = await db.any(
      `SELECT approver_user_id, status FROM tbl_approval_step_approvers
        WHERE approval_instance_step_id IN (
          SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1
        )`,
      [approvedInst.id]
    );
    expect(approvers.length).toBe(1);
    expect(approvers[0].approver_user_id).toBe(IDS.users.a1_proc_commApp);
    expect(approvers[0].status).not.toBe('REMOVED');
  });

  it("propagation logs the change at policy + instance level (audit trail)", async () => {
    const oldSteps = await setPolicySteps([
      { step_order: 1, decision_rule: 'ANY', approver_source_type: 'USER', approver_source_id: IDS.users.a1_proc_commApp },
    ]);
    const inst = await makePendingArcInstance(oldSteps);

    const newSteps = [{
      ...oldSteps[0],
      decision_rule: 'ALL', // rule changed
    }];
    const diff = computePolicyStepDiff(oldSteps, newSteps);

    await db.tx(async (t) => {
      await t.none(
        `UPDATE tbl_approval_policy_steps SET decision_rule = 'ALL'
           WHERE approval_policy_id = $1 AND step_order = 1`,
        [POLICY_ID]
      );
      const policy = await t.one(`SELECT * FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
      await propagatePolicyChangeToInstances({
        policyId: POLICY_ID, diff, changedBy: IDS.users.companyA_admin, policy, t,
      });
    });

    const policyLog = await db.any(
      `SELECT change_type, affected_instance_ids
         FROM tbl_approval_policy_change_log
        WHERE approval_policy_id = $1 ORDER BY id DESC LIMIT 1`,
      [POLICY_ID]
    );
    expect(policyLog.length).toBe(1);
    expect(policyLog[0].change_type).toBe('POLICY_STEPS_CHANGED');
    expect(policyLog[0].affected_instance_ids).toContain(inst.id);

    const instanceLog = await db.any(
      `SELECT change_summary FROM tbl_approval_instance_change_log
        WHERE approval_instance_id = $1 ORDER BY id DESC LIMIT 1`,
      [inst.id]
    );
    expect(instanceLog.length).toBe(1);
  });
});
