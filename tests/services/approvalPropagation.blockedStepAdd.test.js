// A policy step added to a LIVE instance that resolves to nobody must BLOCK
// the approval, not disappear from it.
//
// THE INCIDENT THIS PINS (production, Aug 2026)
//   Policy 92 (PO, Kamat Hotels / Lotus Murud) gained a 4th level — "Final
//   Awarding P4" — at 20:57. Propagation pushed it into two live PO instances,
//   resolved zero approvers at that instant because the role had not been
//   granted yet, and wrote the step as status='SKIPPED', completed_at=NOW().
//   Ten hours later the role WAS granted, but the add-approver reconciler only
//   looks at steps with status='PENDING', so a SKIPPED step was invisible to it
//   and the approver was never attached. Both POs (138699 ₹18,644 and
//   138701 ₹9,156.80) then completed their chains and went to the vendor
//   without their final authority ever seeing them.
//
// Two behaviours keep that closed, and both are asserted here:
//   1. the unfillable step is inserted PENDING, so the instance stalls on it;
//   2. because it is PENDING, the ordinary add-approver reconciler can later
//      fill it — the escape hatch the SKIPPED row did not have.
//
// Plus the trap that would have quietly undone (1): reEvaluateInstanceStep
// auto-approves a PENDING step with no live approvers. A step that NEVER had
// an approver must not take that path, or the block becomes a fake approval on
// the next membership change.

import { describe, it, expect, beforeAll, afterEach } from "@jest/globals";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ensureApprovable } from "../helpers/arcApproverPerms.js";
import {
  applyDiffToInstance,
  reEvaluateInstanceStep,
  advanceInstanceToNextStep,
} from "../../app/services/approvalPropagationService.js";

const BUYER = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_finance;

// A role nobody in this scope holds, so the added step resolves to zero users.
const UNHELD_ROLE = 21; // PO_REGENERATOR — not granted to anyone in hospitality A

const made = { instanceIds: [], stepIds: [], policyStepIds: [], policyIds: [] };

// Deterministic, collision-free synthetic PO ids. A clock-derived id would
// repeat for two tests landing in the same tick.
let entitySeq = 0;
const nextEntityId = () => 900000 + ++entitySeq;

/** Own policy per test — never mutate the shared fixture policy's step set. */
async function makeOwnPolicy() {
  const p = await db.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id, process_id, created_by)
     VALUES ('PO', $1, $2, $3, $4, $5) RETURNING id`,
    [IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P1, BUYER]
  );
  made.policyIds.push(p.id);
  return p.id;
}

async function seedLiveInstance() {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
     VALUES ('PO', $1, $2, 'PENDING', 1, $3, $4, $5, $6, $7) RETURNING *`,
    [nextEntityId(), IDS.policies.A1_P1_PO, IDS.hospitality.A,
     IDS.hotels.A1, IDS.departments.proc, BUYER, IDS.processes.A_P1]
  );
  made.instanceIds.push(inst.id);

  const step1 = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`,
    [inst.id]
  );
  made.stepIds.push(step1.id);
  await db.none(
    `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING')`,
    [step1.id, APPROVER]
  );
  return { inst, step1Id: step1.id };
}

/** A policy step, in the shape applyDiffToInstance's additions expect. */
async function makePolicyStep(stepOrder, roleId) {
  const policyId = await makeOwnPolicy();
  const ps = await db.one(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, approval_type, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, $2, 'STANDARD', 'ANY', 'ROLE', $3) RETURNING *`,
    [policyId, stepOrder, roleId]
  );
  made.policyStepIds.push(ps.id);
  const policy = await db.one(`SELECT * FROM tbl_approval_policies WHERE id = $1`, [policyId]);
  return { step: ps, policy };
}

const stepsOf = (instanceId) =>
  db.any(
    `SELECT s.*, (SELECT count(*)::int FROM tbl_approval_step_approvers a
                   WHERE a.approval_instance_step_id = s.id) AS approver_count
       FROM tbl_approval_instance_steps s
      WHERE s.approval_instance_id = $1 ORDER BY s.step_order`,
    [instanceId]
  );

beforeAll(async () => {
  // The role must genuinely resolve to nobody in this scope, or the test is
  // asserting the wrong branch.
  const holders = await db.one(
    `SELECT count(*)::int AS n FROM tbl_user_role_scopes
      WHERE role_id = $1 AND company_id = $2`,
    [UNHELD_ROLE, IDS.hospitality.A]
  );
  expect(holders.n).toBe(0);
});

afterEach(async () => {
  if (made.stepIds.length || made.instanceIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
         (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [made.instanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [made.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [made.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [made.instanceIds]);
  }
  if (made.policyStepIds.length) {
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE id = ANY($1::int[])`, [made.policyStepIds]);
  }
  if (made.policyIds.length) {
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [made.policyIds]);
  }
  made.instanceIds = []; made.stepIds = []; made.policyStepIds = []; made.policyIds = [];
});

// ===========================================================================
//  Creation and policy-edit propagation must agree on WHO may hold authority.
//
//  Creation gates every approver source on read+approve for the entity's
//  resource. Propagation gated NEITHER source type — it called resolveApprovers
//  directly — so editing a live policy could install an approver that creating
//  the same instance one second later would have dropped. Two instances of the
//  same policy, opposite approver sets, and the mid-flight one is BINDING:
//  submitApprovalAction re-checks nothing, the snapshot IS the authorization.
//
//  Both paths now ask policyStepApproverEligibility. What they do with a "no"
//  still differs on purpose — creation drops the step (no instance exists yet),
//  propagation stalls it (an instance exists, and silently removing an
//  authority level from a live approval is worse than blocking on it).
// ===========================================================================
describe("policy-edit propagation applies the same eligibility gate as creation", () => {
  /** A USER-source step naming someone with no permission on this entity. */
  async function makeUserPolicyStep(stepOrder, userId) {
    const policyId = await makeOwnPolicy();
    const ps = await db.one(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, approval_type, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, $2, 'STANDARD', 'ANY', 'USER', $3) RETURNING *`,
      [policyId, stepOrder, userId]
    );
    made.policyStepIds.push(ps.id);
    const policy = await db.one(`SELECT * FROM tbl_approval_policies WHERE id = $1`, [policyId]);
    return { step: ps, policy };
  }

  it("does NOT install a USER approver that creation would have dropped", async () => {
    const { inst } = await seedLiveInstance();
    // A vendor holds no buyer-side read+approve on this entity's resource.
    const { step: newPolicyStep, policy } = await makeUserPolicyStep(2, IDS.users.vendor_alpha);

    await db.tx((t) =>
      applyDiffToInstance(inst, [{ type: "STEP_ADDED", step_order: 2, newStep: newPolicyStep }], policy, BUYER, t)
    );

    const steps = await stepsOf(inst.id);
    const added = steps.find((s) => s.step_order === 2);
    expect(added).toBeTruthy();
    // Stalls rather than granting authority: PENDING, nobody on it.
    expect(added.status).toBe("PENDING");
    expect(added.approver_count).toBe(0);

    // And specifically NOT the ineligible user.
    const rows = await db.any(
      `SELECT approver_user_id FROM tbl_approval_step_approvers
        WHERE approval_instance_step_id = $1`,
      [added.id]
    );
    expect(rows.map((r) => r.approver_user_id)).not.toContain(IDS.users.vendor_alpha);
  });

  it("still installs a USER approver who IS eligible", async () => {
    const { inst } = await seedLiveInstance();
    // These instances are entity_type PO, which resolves against `awarding`.
    // APPROVER is seeded onto step 1 by raw INSERT, which bypasses every gate,
    // so holding a step does NOT imply holding the permission — grant it
    // explicitly, exactly as production would, or this asserts nothing.
    await ensureApprovable(
      db, [APPROVER], "awarding", IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc
    );
    const { step: newPolicyStep, policy } = await makeUserPolicyStep(2, APPROVER);

    await db.tx((t) =>
      applyDiffToInstance(inst, [{ type: "STEP_ADDED", step_order: 2, newStep: newPolicyStep }], policy, BUYER, t)
    );

    const steps = await stepsOf(inst.id);
    const added = steps.find((s) => s.step_order === 2);
    expect(added.status).toBe("PENDING");
    expect(added.approver_count).toBe(1);
    const rows = await db.any(
      `SELECT approver_user_id FROM tbl_approval_step_approvers
        WHERE approval_instance_step_id = $1`,
      [added.id]
    );
    expect(rows.map((r) => r.approver_user_id)).toContain(APPROVER);
  });
});

describe("a policy step added to a live instance that resolves to nobody", () => {
  it("is inserted PENDING and blocks, instead of being written off as SKIPPED", async () => {
    const { inst } = await seedLiveInstance();
    const { step: newPolicyStep, policy } = await makePolicyStep(2, UNHELD_ROLE);

    const result = await db.tx((t) =>
      applyDiffToInstance(inst, [{ type: "STEP_ADDED", step_order: 2, newStep: newPolicyStep }], policy, BUYER, t)
    );

    const steps = await stepsOf(inst.id);
    const added = steps.find((s) => s.step_order === 2);

    // THE assertion. SKIPPED here is what let two POs bypass their final level.
    expect(added.status).toBe("PENDING");
    expect(added.status).not.toBe("SKIPPED");
    expect(added.approver_count).toBe(0);
    // A blocking step is not a finished step.
    expect(added.completed_at).toBeNull();

    // and it is reported as blocked, not as an ordinary addition
    const reported = result.stepsAdded.find((s) => s.step_order === 2);
    expect(reported.blocked).toBe(true);
    expect(reported.reason).toBe("NO_APPROVERS_RESOLVED");
  });

  it("leaves an audit row saying why the approval is stuck", async () => {
    const { inst } = await seedLiveInstance();
    const { step: newPolicyStep, policy } = await makePolicyStep(2, UNHELD_ROLE);
    await db.tx((t) =>
      applyDiffToInstance(inst, [{ type: "STEP_ADDED", step_order: 2, newStep: newPolicyStep }], policy, BUYER, t)
    );

    // The old path emitted nothing at all — no log, no audit row — which is why
    // the incident went unnoticed for a week.
    const actions = await db.any(
      `SELECT action, comment FROM tbl_approval_actions WHERE approval_instance_id = $1`,
      [inst.id]
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("STEP_ADDED");
    expect(actions[0].comment).toMatch(/resolves to no approver/i);
  });

  it("stops the instance completing — the whole point", async () => {
    const { inst, step1Id } = await seedLiveInstance();
    const { step: newPolicyStep, policy } = await makePolicyStep(2, UNHELD_ROLE);
    await db.tx((t) =>
      applyDiffToInstance(inst, [{ type: "STEP_ADDED", step_order: 2, newStep: newPolicyStep }], policy, BUYER, t)
    );

    // Clear level 1 the way a real approval would.
    await db.none(`UPDATE tbl_approval_step_approvers SET status='APPROVED', acted_at=NOW()
                    WHERE approval_instance_step_id = $1`, [step1Id]);
    await db.none(`UPDATE tbl_approval_instance_steps SET status='APPROVED', completed_at=NOW()
                    WHERE id = $1`, [step1Id]);

    const adv = await db.tx((t) => advanceInstanceToNextStep(inst.id, t));

    // Previously: no PENDING step remained, so the instance was declared
    // APPROVED and the PO went to the vendor. Now it stalls on level 2.
    expect(adv.instanceCompleted).toBe(false);
    expect(adv.nextStepOrder).toBe(2);

    const after = await db.one(`SELECT status, current_step FROM tbl_approval_instances WHERE id=$1`, [inst.id]);
    expect(after.status).toBe("PENDING");
    expect(after.current_step).toBe(2);
  });

  it("can still be filled later, once somebody holds the role", async () => {
    const { inst } = await seedLiveInstance();
    const { step: newPolicyStep, policy } = await makePolicyStep(2, UNHELD_ROLE);
    await db.tx((t) =>
      applyDiffToInstance(inst, [{ type: "STEP_ADDED", step_order: 2, newStep: newPolicyStep }], policy, BUYER, t)
    );

    const steps = await stepsOf(inst.id);
    const blocked = steps.find((s) => s.step_order === 2);

    // The recoverability property: the add-approver reconciler only considers
    // steps with status='PENDING'. A SKIPPED step was permanently unreachable —
    // in production only a direct DB write could undo it. PENDING keeps the
    // door open.
    expect(blocked.status).toBe("PENDING");

    const visible = await db.oneOrNone(
      `SELECT ais.id FROM tbl_approval_instance_steps ais
         JOIN tbl_approval_instances ai ON ai.id = ais.approval_instance_id
        WHERE ais.id = $1 AND ai.status = 'PENDING' AND ais.status = 'PENDING'`,
      [blocked.id]
    );
    expect(visible).not.toBeNull();
  });
});

describe("re-evaluating a step that has nobody on it", () => {
  it("does NOT auto-approve a step that never had an approver", async () => {
    const { inst } = await seedLiveInstance();
    const { step: newPolicyStep, policy } = await makePolicyStep(2, UNHELD_ROLE);
    await db.tx((t) =>
      applyDiffToInstance(inst, [{ type: "STEP_ADDED", step_order: 2, newStep: newPolicyStep }], policy, BUYER, t)
    );
    const steps = await stepsOf(inst.id);
    const blocked = steps.find((s) => s.step_order === 2);

    const res = await db.tx((t) => reEvaluateInstanceStep(blocked.id, t));

    // Without this guard the blocking step is converted to APPROVED the first
    // time any membership change touches the instance — manufacturing an
    // approval nobody granted and silently restoring the original defect.
    expect(res.completed).toBe(false);
    expect(res.blocked).toBe(true);

    const after = await db.one(`SELECT status, completed_at FROM tbl_approval_instance_steps WHERE id=$1`, [blocked.id]);
    expect(after.status).toBe("PENDING");
    expect(after.completed_at).toBeNull();
  });

  it("still auto-completes a step whose approvers were all removed mid-flight", async () => {
    // The other way a step ends up with nobody on it. That one HAS been
    // exercised and overtaken by a membership change, and auto-completing it is
    // the established behaviour — this guard must not change it.
    const { inst } = await seedLiveInstance();
    const step2 = await db.one(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, 2, 'ANY', 'PENDING') RETURNING id`,
      [inst.id]
    );
    await db.none(
      `INSERT INTO tbl_approval_step_approvers
         (approval_instance_step_id, approver_user_id, status, removed_at, removal_reason)
       VALUES ($1, $2, 'REMOVED', NOW(), 'role_removed')`,
      [step2.id, APPROVER]
    );

    const res = await db.tx((t) => reEvaluateInstanceStep(step2.id, t));

    expect(res.completed).toBe(true);
    expect(res.status).toBe("APPROVED");
  });
});
