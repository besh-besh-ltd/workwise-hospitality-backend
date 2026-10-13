// Approval engine rules for Purchase Requisitions (spec §7).
//
// PR is the first entity type the shared approval engine treats differently,
// so every rule below is asserted against real rows written by the production
// engine (createApprovalInstance, the propagation service and the HTTP policy /
// oversight endpoints), and one test pins that MR — the nearest neighbour —
// still behaves exactly as before.
//
//   amount thresholds   a step with min_amount applies only when amount >= it
//                       (fixed-point paise compare; unknown amount = applies)
//   separation of duty  the requester is never an approver of their own PR:
//                       not at creation, not via a ROLE they hold, not via a
//                       delegation, not on propagation or revalidation, not by
//                       reassignment, and never auto-recorded as approving
//   strict steps        an applicable step resolving to nobody throws
//                       APPROVAL_STEP_UNRESOLVED instead of being dropped
//
// Pattern B (commit + tracked-id cleanup): revalidateApproverMembership,
// the delegation reader and the HTTP endpoints all read committed data.

import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { ensureApprovable } from "../helpers/arcApproverPerms.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import {
  createApprovalInstance,
  checkIfUserIsFinalApprover,
} from "../../app/models/generalModel.js";
import {
  computePolicyStepDiff,
  revalidateApproverMembership,
} from "../../app/services/approvalPropagationService.js";
import { createDelegation } from "../../app/models/approvalDelegationModel.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.eng;
const REQ = IDS.users.a1_eng_buyer;
const A1 = IDS.users.a1_proc_commApp;
const A2 = IDS.users.a1_proc_finance;
const ADMIN = IDS.users.companyA_admin;

// The dedicated pr read+approve role ensureApprovable() creates for 'pr'.
const PR_FIXTURE_ROLE = 89308;
// A role with no pr.* at all (Tender Approver: rfq read+approve).
const ROLE_WITHOUT_PR = 4;

const POLICIES_URL = "/api/v1/general/hospitality/approval/policies";
const SUBMIT_URL = "/api/v1/general/hospitality/approval/submit";
const STUCK_URL = "/api/v1/general/hospitality/approval/stuck";

let PR_APPROVER_ROLE; // system role 'PR Approver' (pr.read + pr.approve), held by nobody in fixtures
let nextEntityId = 990000;
const track = { entityIds: [], policyIds: [], scopeIds: [], delegationIds: [] };
const restoreUserType = {};

const newEntityId = () => {
  nextEntityId += 1;
  track.entityIds.push(nextEntityId);
  return nextEntityId;
};

/** A process-free PR (or other) policy at (company A, hotel A1), committed. */
async function seedPolicy(steps, { entityType = "PR" } = {}) {
  const policy = await db.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id, is_active,
        created_by, process_id, is_master, is_department_scoped, version)
     VALUES ($1, $2, $3, NULL, true, $4, NULL, false, false, 1)
     RETURNING id`,
    [entityType, HC, HOTEL, ADMIN]
  );
  const policyId = Number(policy.id);
  track.policyIds.push(policyId);
  for (const [i, s] of steps.entries()) {
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id, min_amount)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [policyId, i + 1, s.rule || "ANY", s.type, s.id, s.min ?? null]
    );
  }
  return policyId;
}

function createPr(entityId, { amount, strictSteps = true, initiatedBy = REQ } = {}) {
  return createApprovalInstance({
    entity_type: "PR",
    entity_id: entityId,
    hospitality_company_id: HC,
    hotel_id: HOTEL,
    department_id: DEPT,
    process_id: null,
    initiated_by: initiatedBy,
    amount,
    strictSteps,
    metadata: { pr_number: `PR-TEST-${entityId}` },
  });
}

/** Everything the engine wrote for one entity, read back from the DB. */
async function stateOf(entityId, entityType = "PR") {
  const instances = await db.any(
    `SELECT * FROM tbl_approval_instances WHERE entity_type = $1 AND entity_id = $2 ORDER BY id`,
    [entityType, entityId]
  );
  const inst = instances[instances.length - 1] || null;
  if (!inst) return { count: 0, inst: null, steps: [], approvers: [], actions: [] };
  const steps = await db.any(
    `SELECT s.id, s.step_order, s.status, ps.step_order AS policy_step_order
       FROM tbl_approval_instance_steps s
       LEFT JOIN tbl_approval_policy_steps ps ON ps.id = s.policy_step_id
      WHERE s.approval_instance_id = $1
      ORDER BY s.step_order`,
    [inst.id]
  );
  const approvers = await db.any(
    `SELECT s.step_order, sa.approver_user_id, sa.status
       FROM tbl_approval_step_approvers sa
       JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
      WHERE s.approval_instance_id = $1
      ORDER BY s.step_order, sa.approver_user_id`,
    [inst.id]
  );
  const actions = await db.any(
    `SELECT approver_user_id, action FROM tbl_approval_actions WHERE approval_instance_id = $1 ORDER BY id`,
    [inst.id]
  );
  return { count: instances.length, inst, steps, approvers, actions };
}

const activeApproversOf = (state, stepOrder) =>
  state.approvers
    .filter((a) => a.step_order === stepOrder && a.status !== "REMOVED")
    .map((a) => Number(a.approver_user_id))
    .sort((a, b) => a - b);

const everOnInstance = (state, userId) =>
  state.approvers.some((a) => Number(a.approver_user_id) === Number(userId));

const skipped = (state) => state.inst?.metadata?.approval_diagnostics?.skipped_steps || [];

beforeAll(async () => {
  const role = await db.one(
    `SELECT id FROM tbl_roles WHERE title = 'PR Approver' AND created_by IS NULL`
  );
  PR_APPROVER_ROLE = Number(role.id);

  // Fixture buyers carry user_type NULL; the route gates need a real type.
  for (const [uid, type] of [[ADMIN, 7], [REQ, 2]]) {
    const row = await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [uid]);
    restoreUserType[uid] = row.user_type;
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [uid, type]);
  }
});

afterAll(async () => {
  for (const [uid, type] of Object.entries(restoreUserType)) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [Number(uid), type]);
  }
  // Safety net for a failed assertion that created something untracked (e.g.
  // an upsert that should have been refused). Only this suite creates PR
  // policies / synthetic PR entity ids in this shard.
  const strays = (
    await db.any(`SELECT id FROM tbl_approval_instances WHERE entity_type = 'PR' AND entity_id >= 990000`)
  ).map((r) => Number(r.id));
  if (strays.length) {
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [strays]);
  }
  await db.none(
    `DELETE FROM tbl_approval_policies p
      WHERE p.entity_type = 'PR' AND p.hospitality_company_id = $1
        AND NOT EXISTS (SELECT 1 FROM tbl_approval_instances i WHERE i.approval_policy_id = p.id)`,
    [HC]
  );
});

afterEach(async () => {
  const entityIds = track.entityIds.splice(0);
  if (entityIds.length) {
    const ids = (
      await db.any(
        `SELECT id FROM tbl_approval_instances
          WHERE entity_type IN ('PR', 'MR') AND entity_id = ANY($1::int[])`,
        [entityIds]
      )
    ).map((r) => Number(r.id));
    if (ids.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [ids]);
      await db.none(
        `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
           (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
        [ids]
      );
      await db.none(`DELETE FROM tbl_approval_instance_change_log WHERE approval_instance_id = ANY($1::int[])`, [ids]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [ids]);
      await db.none(`DELETE FROM tbl_approval_policy_change_log WHERE affected_instance_ids && $1::int[]`, [ids]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [ids]);
    }
  }

  const policyIds = track.policyIds.splice(0);
  if (policyIds.length) {
    await db.none(`DELETE FROM tbl_approval_policy_change_log WHERE approval_policy_id = ANY($1::int[])`, [policyIds]);
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [policyIds]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [policyIds]);
  }

  const delegationIds = track.delegationIds.splice(0);
  if (delegationIds.length) {
    await db.none(`DELETE FROM tbl_approval_delegations WHERE id = ANY($1::int[])`, [delegationIds]);
  }

  await revokeRoleScopes(db, track.scopeIds.splice(0));
  // Per-test grants of the dedicated fixture role: each test names exactly who
  // holds it, so a ROLE step's resolved set is what that test says it is.
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = $1`, [PR_FIXTURE_ROLE]);
});

const makeApprovable = (userIds, resource = "pr") =>
  ensureApprovable(db, userIds, resource, HC, HOTEL, DEPT);

// ---------------------------------------------------------------------------
describe("PR approval — amount thresholds", () => {
  it("below_threshold: a step whose min_amount exceeds the amount is not created, and is recorded", async () => {
    await makeApprovable([A1, A2, REQ]);
    await seedPolicy([
      { type: "USER", id: A1 },
      { type: "USER", id: A2, min: "50000.00" },
    ]);
    const entityId = newEntityId();

    const result = await createPr(entityId, { amount: "49999.99" });
    expect(result.autoApproved).toBeFalsy();

    const s = await stateOf(entityId);
    expect(s.inst.status).toBe("PENDING");
    expect(s.inst.current_step).toBe(1);
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({ step_order: 1, status: "PENDING", policy_step_order: 1 });
    expect(activeApproversOf(s, 1)).toEqual([A1]);
    expect(s.inst.metadata.amount).toBe("49999.99");
    expect(skipped(s)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step_order: 2, reason: "below_threshold", min_amount: "50000.00" }),
      ])
    );
  });

  it("threshold.boundary-exact: equal applies, one paisa short does not (no float error)", async () => {
    await makeApprovable([A1, A2, REQ]);
    const policyId = await seedPolicy([
      { type: "USER", id: A1 },
      { type: "USER", id: A2, min: "50000.00" },
    ]);
    const setStep2Min = (min) =>
      db.none(
        `UPDATE tbl_approval_policy_steps SET min_amount = $2 WHERE approval_policy_id = $1 AND step_order = 2`,
        [policyId, min]
      );

    const atLimit = newEntityId();
    await createPr(atLimit, { amount: "50000.00" });
    let s = await stateOf(atLimit);
    expect(s.steps.map((x) => x.step_order)).toEqual([1, 2]);
    expect(activeApproversOf(s, 2)).toEqual([A2]);
    expect(skipped(s)).toEqual([]);

    // ₹ 12,50,00,000.75 — the large-value boundary from the spec.
    await setStep2Min("12500000.75");
    const bigEqual = newEntityId();
    await createPr(bigEqual, { amount: "12500000.75" });
    s = await stateOf(bigEqual);
    expect(s.steps).toHaveLength(2);
    expect(s.inst.metadata.amount).toBe("12500000.75");

    await setStep2Min("12500000.76");
    const bigShort = newEntityId();
    await createPr(bigShort, { amount: "12500000.75" });
    s = await stateOf(bigShort);
    expect(s.steps).toHaveLength(1);
    expect(activeApproversOf(s, 1)).toEqual([A1]);
    expect(skipped(s)).toEqual([
      expect.objectContaining({ step_order: 2, reason: "below_threshold", min_amount: "12500000.76" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("PR approval — separation of duties", () => {
  it("sod.requester-never-approver: a ROLE step the requester also holds resolves to everyone else", async () => {
    await makeApprovable([REQ, A1]); // both hold PR_FIXTURE_ROLE at (A, A1, eng)
    await seedPolicy([{ type: "ROLE", id: PR_FIXTURE_ROLE }]);
    const entityId = newEntityId();

    const result = await createPr(entityId, { amount: "1000.00" });
    expect(result.autoApproved).toBeFalsy();

    const s = await stateOf(entityId);
    expect(s.inst.status).toBe("PENDING");
    expect(activeApproversOf(s, 1)).toEqual([A1]);
    expect(everOnInstance(s, REQ)).toBe(false);
    expect(s.actions.filter((a) => Number(a.approver_user_id) === REQ)).toEqual([]);
    expect(skipped(s)).toEqual([]);

    // "Will submitting this auto-approve, because I am the final approver?"
    // (asked by the would-be initiator) — never for a PR, even though REQ
    // holds the only step's role.
    expect(await checkIfUserIsFinalApprover(REQ, "PR", HC, HOTEL, DEPT)).toBe(false);
  });

  it("sod.self-only-step-skipped: a step naming only the requester is skipped as sod_self", async () => {
    await makeApprovable([REQ, A1]);
    await seedPolicy([
      { type: "USER", id: REQ },
      { type: "USER", id: A1 },
    ]);
    const entityId = newEntityId();

    await createPr(entityId, { amount: "1000.00" });

    const s = await stateOf(entityId);
    expect(s.inst.status).toBe("PENDING");
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({ step_order: 1, policy_step_order: 2 });
    expect(s.inst.current_step).toBe(1);
    expect(activeApproversOf(s, 1)).toEqual([A1]);
    expect(everOnInstance(s, REQ)).toBe(false);
    expect(s.actions).toEqual([]);
    expect(skipped(s)).toEqual([expect.objectContaining({ step_order: 1, reason: "sod_self" })]);
  });

  it("sod.no-independent: refuses, writing no instance, when nobody but the requester remains", async () => {
    await makeApprovable([REQ, A1]);
    const policyId = await seedPolicy([{ type: "USER", id: REQ }]);

    const onlyRequester = newEntityId();
    await expect(createPr(onlyRequester, { amount: "1000.00" })).rejects.toMatchObject({
      code: "APPROVAL_NO_INDEPENDENT_APPROVER",
      httpStatus: 422,
    });
    expect((await stateOf(onlyRequester)).count).toBe(0);

    // Every step below the threshold leaves no independent approver either.
    await db.none(
      `UPDATE tbl_approval_policy_steps SET approver_source_id = $2, min_amount = '50000.00'
        WHERE approval_policy_id = $1`,
      [policyId, A1]
    );
    const allBelow = newEntityId();
    await expect(createPr(allBelow, { amount: "100.00" })).rejects.toMatchObject({
      code: "APPROVAL_NO_INDEPENDENT_APPROVER",
      httpStatus: 422,
    });
    expect((await stateOf(allBelow)).count).toBe(0);
  });

  it("sod.delegation: an approver covering via the requester keeps the approval themselves (PR only)", async () => {
    await makeApprovable([A1, A2, REQ]);
    const d = await createDelegation({
      delegatorUserId: A1,
      delegateUserId: REQ,
      startsAt: new Date(Date.now() - 3600_000),
      endsAt: new Date(Date.now() + 86400_000),
      reason: "PR SoD test — A1 on leave, REQ covering",
      createdBy: ADMIN,
    });
    track.delegationIds.push(Number(d.id));
    await seedPolicy([
      { type: "USER", id: A1 },
      { type: "USER", id: A2 },
    ]);
    const entityId = newEntityId();

    await createPr(entityId, { amount: "1000.00" });

    const s = await stateOf(entityId);
    expect(s.inst.status).toBe("PENDING");
    expect(everOnInstance(s, REQ)).toBe(false);
    // The level is not lost: cover that would land on the requester is not applied.
    expect(activeApproversOf(s, 1)).toEqual([A1]);
    expect(activeApproversOf(s, 2)).toEqual([A2]);
    expect(skipped(s)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("PR approval — strict steps", () => {
  it("strict.unresolved: an applicable step resolving to nobody throws, naming the step", async () => {
    await makeApprovable([A1]);
    const policyId = await seedPolicy([
      { type: "ROLE", id: PR_APPROVER_ROLE }, // qualifies, but nobody holds it here
      { type: "USER", id: A1 },
    ]);

    const strict = newEntityId();
    await expect(createPr(strict, { amount: "1000.00" })).rejects.toMatchObject({
      code: "APPROVAL_STEP_UNRESOLVED",
      httpStatus: 422,
      step_order: 1,
    });
    expect((await stateOf(strict)).count).toBe(0);

    // Without strictSteps the same policy silently drops step 1 — which is
    // exactly what strict mode exists to refuse.
    const lenient = newEntityId();
    await createPr(lenient, { amount: "1000.00", strictSteps: false });
    const s = await stateOf(lenient);
    expect(s.steps).toHaveLength(1);
    expect(activeApproversOf(s, 1)).toEqual([A1]);

    // A role that can never approve a PR is unresolved too.
    await db.none(
      `UPDATE tbl_approval_policy_steps SET approver_source_id = $2
        WHERE approval_policy_id = $1 AND step_order = 1`,
      [policyId, ROLE_WITHOUT_PR]
    );
    const gated = newEntityId();
    await expect(createPr(gated, { amount: "1000.00" })).rejects.toMatchObject({
      code: "APPROVAL_STEP_UNRESOLVED",
      httpStatus: 422,
      step_order: 1,
    });
    expect((await stateOf(gated)).count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("Other entity types are unchanged", () => {
  it("non-PR unchanged: an MR initiator who is the sole approver still auto-approves; min_amount is ignored", async () => {
    await makeApprovable([REQ], "mr");
    await seedPolicy([{ type: "USER", id: REQ, min: "1000000.00" }], { entityType: "MR" });
    const entityId = newEntityId();

    const result = await createApprovalInstance({
      entity_type: "MR",
      entity_id: entityId,
      hospitality_company_id: HC,
      hotel_id: HOTEL,
      department_id: DEPT,
      initiated_by: REQ,
      amount: "1.00",
      metadata: { mr_number: `MR-TEST-${entityId}` },
    });

    expect(result.autoApproved).toBe(true);
    const s = await stateOf(entityId, "MR");
    expect(s.inst.status).toBe("APPROVED");
    expect(s.approvers).toEqual([expect.objectContaining({ approver_user_id: REQ, status: "APPROVED" })]);
    expect(s.actions).toEqual([expect.objectContaining({ approver_user_id: REQ, action: "APPROVE" })]);
  });

  it("non-PR delegation unchanged: an MR approver covering via the initiator still hands it to them", async () => {
    await makeApprovable([A1], "mr");
    const d = await createDelegation({
      delegatorUserId: A1,
      delegateUserId: REQ,
      startsAt: new Date(Date.now() - 3600_000),
      endsAt: new Date(Date.now() + 86400_000),
      reason: "MR control — delegation behaves as before",
      createdBy: ADMIN,
    });
    track.delegationIds.push(Number(d.id));
    await seedPolicy([{ type: "USER", id: A1 }], { entityType: "MR" });
    const entityId = newEntityId();

    const result = await createApprovalInstance({
      entity_type: "MR",
      entity_id: entityId,
      hospitality_company_id: HC,
      hotel_id: HOTEL,
      department_id: DEPT,
      initiated_by: REQ,
      metadata: { mr_number: `MR-TEST-${entityId}` },
    });

    expect(result.autoApproved).toBe(true);
    const s = await stateOf(entityId, "MR");
    expect(s.approvers).toEqual([expect.objectContaining({ approver_user_id: REQ, status: "APPROVED" })]);
  });
});

// ---------------------------------------------------------------------------
describe("PR approval — mid-flight changes", () => {
  it("propagation.no-readd: revalidation and policy edits never install the requester; added steps honour min_amount", async () => {
    await makeApprovable([REQ, A1]);
    const policyId = await seedPolicy([{ type: "ROLE", id: PR_FIXTURE_ROLE }]);
    const entityId = newEntityId();
    await createPr(entityId, { amount: "1000.00" });
    let s = await stateOf(entityId);
    expect(activeApproversOf(s, 1)).toEqual([A1]);

    // 1. Membership revalidation: REQ gains another scope of the step's role.
    const extraScope = { role_id: PR_FIXTURE_ROLE, company_id: HC, hotel_id: null, department_id: DEPT, process_id: null };
    track.scopeIds.push(
      await grantRoleScope(db, { userId: REQ, roleId: PR_FIXTURE_ROLE, companyId: HC, hotelId: null, departmentId: DEPT })
    );
    await db.tx((t) =>
      revalidateApproverMembership({
        userId: REQ,
        changedBy: ADMIN,
        changeType: "scope_added",
        changedScopes: [extraScope],
        changedRoleIds: [PR_FIXTURE_ROLE],
        companyId: HC,
        txContext: t,
      })
    );
    s = await stateOf(entityId);
    expect(s.inst.status).toBe("PENDING");
    expect(everOnInstance(s, REQ)).toBe(false);
    expect(s.actions.filter((a) => Number(a.approver_user_id) === REQ)).toEqual([]);

    // 2. Policy edit through the admin endpoint (computePolicyStepDiff +
    //    propagatePolicyChangeToInstances in production):
    //      step 1  source change → PR Approver, held by REQ and A2
    //      step 2  added         → the fixture role, held by REQ and A1
    //      step 3  added         → A2, but only at ₹5,000+ (this PR is ₹1,000)
    for (const userId of [REQ, A2]) {
      track.scopeIds.push(
        await grantRoleScope(db, { userId, roleId: PR_APPROVER_ROLE, companyId: HC, hotelId: HOTEL, departmentId: DEPT })
      );
    }
    const admin = await httpClient(ADMIN);
    const res = await admin.post(POLICIES_URL).send({
      id: policyId,
      entity_type: "PR",
      hotel_id: HOTEL,
      is_active: true,
      confirmed_approval_impact: true,
      steps: [
        { step_order: 1, decision_rule: "ANY", approver_source_type: "ROLE", approver_source_id: PR_APPROVER_ROLE },
        { step_order: 2, decision_rule: "ANY", approver_source_type: "ROLE", approver_source_id: PR_FIXTURE_ROLE },
        { step_order: 3, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: A2, min_amount: "5000.00" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    s = await stateOf(entityId);
    expect(s.inst.status).toBe("PENDING");
    expect(everOnInstance(s, REQ)).toBe(false);
    expect(s.actions.filter((a) => Number(a.approver_user_id) === REQ && a.action === "APPROVE")).toEqual([]);
    expect(activeApproversOf(s, 1)).toEqual([A2]);
    expect(activeApproversOf(s, 2)).toEqual([A1]);
    // The ₹5,000 step was not added to a ₹1,000 PR.
    expect(s.steps.map((x) => x.step_order)).toEqual([1, 2]);
  });

  it("propagation.min_amount-diff: a min_amount change is a step modification (compared in paise)", () => {
    const base = { step_order: 1, approver_source_type: "USER", approver_source_id: A1, decision_rule: "ANY" };

    const diff = computePolicyStepDiff([{ ...base, min_amount: null }], [{ ...base, min_amount: "1000.00" }]);
    expect(diff).toEqual([
      expect.objectContaining({
        type: "STEP_MODIFIED",
        step_order: 1,
        sourceChanged: false,
        ruleChanged: false,
        minAmountChanged: true,
      }),
    ]);

    // Same value, different spelling / absent vs null: no change.
    expect(computePolicyStepDiff([{ ...base, min_amount: "1000.00" }], [{ ...base, min_amount: "1000" }])).toEqual([]);
    expect(computePolicyStepDiff([{ ...base, min_amount: null }], [{ ...base }])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("PR approval — admin and generic endpoints", () => {
  it("policy upsert accepts PR (min_amount stored, process-free) and MR; validates min_amount", async () => {
    const admin = await httpClient(ADMIN);

    const pr = await admin.post(POLICIES_URL).send({
      entity_type: "PR",
      hospitality_company_id: HC,
      hotel_id: HOTEL,
      process_id: IDS.processes.A_P1, // PR is process-free: forced to NULL
      is_active: true,
      steps: [
        { step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: A1 },
        { step_order: 2, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: A2, min_amount: "25000" },
      ],
    });
    expect(pr.status).toBe(201);
    expect(pr.body.status).toBe(1);
    const prPolicyId = Number(pr.body.data.id);
    track.policyIds.push(prPolicyId);
    const prRow = await db.one(`SELECT entity_type, process_id FROM tbl_approval_policies WHERE id = $1`, [prPolicyId]);
    expect(prRow).toEqual({ entity_type: "PR", process_id: null });
    const prSteps = await db.any(
      `SELECT step_order, min_amount FROM tbl_approval_policy_steps WHERE approval_policy_id = $1 ORDER BY step_order`,
      [prPolicyId]
    );
    expect(prSteps).toEqual([
      { step_order: 1, min_amount: null },
      { step_order: 2, min_amount: "25000.00" },
    ]);

    const mr = await admin.post(POLICIES_URL).send({
      entity_type: "MR",
      hospitality_company_id: HC,
      hotel_id: HOTEL,
      is_active: true,
      steps: [
        { step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: A1, min_amount: "25000" },
      ],
    });
    expect(mr.status).toBe(201);
    expect(mr.body.status).toBe(1);
    const mrPolicyId = Number(mr.body.data.id);
    track.policyIds.push(mrPolicyId);
    // Thresholds are a PR rule; on any other entity type the field is ignored, as before.
    const mrStep = await db.one(`SELECT min_amount FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [mrPolicyId]);
    expect(mrStep.min_amount).toBeNull();

    const before = await db.one(`SELECT count(*)::int AS n FROM tbl_approval_policies WHERE entity_type = 'PR'`);
    for (const bad of ["-1", "12.345", "abc"]) {
      const res = await admin.post(POLICIES_URL).send({
        entity_type: "PR",
        hospitality_company_id: HC,
        hotel_id: IDS.hotels.A2,
        is_active: true,
        steps: [{ step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: A1, min_amount: bad }],
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_MIN_AMOUNT");
    }
    const after = await db.one(`SELECT count(*)::int AS n FROM tbl_approval_policies WHERE entity_type = 'PR'`);
    expect(after.n).toBe(before.n);
  });

  it("the generic submit endpoint refuses PR: a PR approval only starts from the PR workflow", async () => {
    await makeApprovable([A1]);
    await seedPolicy([{ type: "USER", id: A1 }]);
    const entityId = newEntityId();

    const client = await httpClient(REQ);
    const res = await client.post(SUBMIT_URL).send({
      entity_type: "PR",
      entity_id: entityId,
      hospitality_company_id: HC,
      hotel_id: HOTEL,
      department_id: DEPT,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("APPROVAL_ENTITY_HAS_OWN_WORKFLOW");
    expect((await stateOf(entityId)).count).toBe(0);
  });

  it("an administrator cannot reassign a PR approval to its requester", async () => {
    await makeApprovable([A1, REQ]); // REQ holds pr read+approve: only SoD can refuse this
    await seedPolicy([{ type: "USER", id: A1 }]);
    const entityId = newEntityId();
    await createPr(entityId, { amount: "1000.00" });
    const { inst } = await stateOf(entityId);

    const admin = await httpClient(ADMIN);
    const candidates = await admin.get(`${STUCK_URL}/${inst.id}/candidates`);
    expect(candidates.status).toBe(200);
    const reqRow = candidates.body.data.find((c) => Number(c.id) === REQ);
    expect(reqRow).toBeTruthy();
    expect(reqRow.eligible).toBe(false);

    const res = await admin.post(`${STUCK_URL}/${inst.id}/reassign`).send({
      from_user_id: A1,
      to_user_id: REQ,
      reason: "Approver on leave — hand it to the department",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOT_ELIGIBLE");

    const s = await stateOf(entityId);
    expect(activeApproversOf(s, 1)).toEqual([A1]);
    expect(everOnInstance(s, REQ)).toBe(false);
  });
});
