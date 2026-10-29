// Approval engine rules for Purchase Requisitions (spec §7).
//
// PR is the first entity type the shared approval engine treats differently,
// so every rule below is asserted against real rows written by the production
// engine (createApprovalInstance / resolvePolicyChain, the propagation service
// and the HTTP policy / oversight endpoints), and MR — the nearest neighbour —
// is pinned to its existing behaviour.
//
//   amount thresholds   a step with min_amount applies only when amount >= it
//                       (fixed-point paise compare; unknown amount = applies)
//   separation of duty  the requester is never an approver of their own PR:
//                       not at creation, not via a ROLE they hold, not via
//                       delegation in either direction, not on revalidation,
//                       not by reassignment, never by acting directly, and no
//                       PR step ever completes without an independent APPROVE
//   strict steps        an applicable step resolving to nobody throws
//                       APPROVAL_STEP_UNRESOLVED instead of being dropped
//   pinned instances    a policy edit never touches a pending PR instance
//                       (membership revalidation still does)
//   one chain resolver  resolvePolicyChain is what createApprovalInstance uses,
//                       so a preview built on it cannot disagree with submit
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
  resolvePolicyChain,
  submitApprovalAction,
} from "../../app/models/generalModel.js";
import {
  computePolicyStepDiff,
  revalidateApproverMembership,
  revalidateRolePermissionChange,
  simulateApproverImpact,
} from "../../app/services/approvalPropagationService.js";
import { createDelegation } from "../../app/models/approvalDelegationModel.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const OTHER_HOTEL = IDS.hotels.A2;
const DEPT = IDS.departments.eng;
const REQ = IDS.users.a1_eng_buyer;
const A1 = IDS.users.a1_proc_commApp;
const A2 = IDS.users.a1_proc_finance;
const A3 = IDS.users.a1_proc_poApp;
const A4 = IDS.users.a1_proc_techApp;
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
const restoreUserType = new Map();

const newEntityId = () => {
  nextEntityId += 1;
  track.entityIds.push(nextEntityId);
  return nextEntityId;
};

const fixtureScope = (overrides = {}) => ({
  role_id: PR_FIXTURE_ROLE, company_id: HC, hotel_id: HOTEL, department_id: DEPT, process_id: null, ...overrides,
});

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
  if (!inst) return { count: 0, inst: null, steps: [], approvers: [], actions: [], changeLogs: 0 };
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
  const { n: changeLogs } = await db.one(
    `SELECT count(*)::int AS n FROM tbl_approval_instance_change_log WHERE approval_instance_id = $1`,
    [inst.id]
  );
  return { count: instances.length, inst, steps, approvers, actions, changeLogs };
}

const activeApproversOf = (state, stepOrder) =>
  state.approvers
    .filter((a) => a.step_order === stepOrder && a.status !== "REMOVED")
    .map((a) => Number(a.approver_user_id))
    .sort((a, b) => a - b);

const approverRow = (state, stepOrder, userId) =>
  state.approvers.find((a) => a.step_order === stepOrder && Number(a.approver_user_id) === Number(userId));

const everOnInstance = (state, userId) =>
  state.approvers.some((a) => Number(a.approver_user_id) === Number(userId));

const skipped = (state) => state.inst?.metadata?.approval_diagnostics?.skipped_steps || [];

const makeApprovable = (userIds, resource = "pr") =>
  ensureApprovable(db, userIds, resource, HC, HOTEL, DEPT);

const revalidate = (args) =>
  db.tx((t) => revalidateApproverMembership({ changedBy: ADMIN, companyId: HC, ...args, txContext: t }));

async function delegate(fromUser, toUser, reason) {
  const d = await createDelegation({
    delegatorUserId: fromUser,
    delegateUserId: toUser,
    startsAt: new Date(Date.now() - 3600_000),
    endsAt: new Date(Date.now() + 86400_000),
    reason,
    createdBy: ADMIN,
  });
  track.delegationIds.push(Number(d.id));
}

beforeAll(async () => {
  const role = await db.one(
    `SELECT id FROM tbl_roles WHERE title = 'PR Approver' AND created_by IS NULL`
  );
  PR_APPROVER_ROLE = Number(role.id);

  // Fixture buyers carry user_type NULL; the route gates need a real type.
  // Every original value is recorded BEFORE anything is changed, so the
  // restore in afterAll is complete even if a later update here fails.
  for (const uid of [ADMIN, REQ]) {
    const row = await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [uid]);
    restoreUserType.set(uid, row.user_type);
  }
  await db.none(`UPDATE tbl_users SET user_type = 7 WHERE id = $1`, [ADMIN]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [REQ]);
});

afterAll(async () => {
  for (const [uid, type] of restoreUserType) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [uid, type]);
  }
});

afterEach(async () => {
  // Only tracked ids are touched. Each block runs even if an earlier one
  // throws, so one failed delete cannot leak the rest into later suites.
  const steps = [];
  const entityIds = track.entityIds.splice(0);
  steps.push(async () => {
    if (!entityIds.length) return;
    const ids = (
      await db.any(
        `SELECT id FROM tbl_approval_instances
          WHERE entity_type IN ('PR', 'MR') AND entity_id = ANY($1::int[])`,
        [entityIds]
      )
    ).map((r) => Number(r.id));
    if (!ids.length) return;
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
  });
  const policyIds = track.policyIds.splice(0);
  steps.push(async () => {
    if (!policyIds.length) return;
    await db.none(`DELETE FROM tbl_approval_policy_change_log WHERE approval_policy_id = ANY($1::int[])`, [policyIds]);
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [policyIds]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [policyIds]);
  });
  const delegationIds = track.delegationIds.splice(0);
  steps.push(async () => {
    if (delegationIds.length) {
      await db.none(`DELETE FROM tbl_approval_delegations WHERE id = ANY($1::int[])`, [delegationIds]);
    }
  });
  const scopeIds = track.scopeIds.splice(0);
  steps.push(() => revokeRoleScopes(db, scopeIds));
  // Per-test grants of the dedicated fixture role: each test names exactly
  // who holds it, so a ROLE step's resolved set is what that test says it is.
  steps.push(() => db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = $1`, [PR_FIXTURE_ROLE]));

  const errors = [];
  for (const step of steps) {
    try { await step(); } catch (e) { errors.push(e); }
  }
  if (errors.length) throw errors[0];
});

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
    // POLICY step order, in metadata.approval_diagnostics.skipped_steps.
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
    await delegate(A1, REQ, "PR SoD test — A1 on leave, REQ covering");
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

  it("sod.requester-cover: the requester's own outgoing cover never acts for them (creation and revalidation)", async () => {
    await makeApprovable([REQ, A1]); // PR_FIXTURE_ROLE held by REQ and A1 only
    await delegate(REQ, A2, "PR SoD test — REQ away, A2 covering REQ's approvals");
    await seedPolicy([
      { type: "ROLE", id: PR_FIXTURE_ROLE },
      { type: "USER", id: REQ },
    ]);
    const entityId = newEntityId();

    await createPr(entityId, { amount: "1000.00" });

    let s = await stateOf(entityId);
    // ROLE step held by REQ+A1: REQ's cover (A2) does not stand in for REQ.
    expect(activeApproversOf(s, 1)).toEqual([A1]);
    // USER-REQ step: REQ is not swapped for A2, so the step is sod_self.
    expect(s.steps).toHaveLength(1);
    expect(skipped(s)).toEqual([expect.objectContaining({ step_order: 2, reason: "sod_self" })]);
    expect(everOnInstance(s, A2)).toBe(false);

    // Revalidation: A2 gains the step's role at ANOTHER hotel, which makes
    // PART 2 re-resolve the step (at hotel A1: REQ + A1 hold it). Through REQ's
    // cover A2 would appear in that set — it must not be added.
    track.scopeIds.push(
      await grantRoleScope(db, { userId: A2, roleId: PR_FIXTURE_ROLE, companyId: HC, hotelId: OTHER_HOTEL, departmentId: DEPT })
    );
    await revalidate({
      userId: A2,
      changeType: "scope_added",
      changedScopes: [fixtureScope({ hotel_id: OTHER_HOTEL })],
      changedRoleIds: [PR_FIXTURE_ROLE],
    });
    s = await stateOf(entityId);
    expect(everOnInstance(s, A2)).toBe(false);
    expect(activeApproversOf(s, 1)).toEqual([A1]);
  });

  it("sod.initiator-cannot-act: a requester row written by any other path neither acts nor completes the step", async () => {
    await makeApprovable([A1]); // PR_FIXTURE_ROLE held by A1 only
    await seedPolicy([{ type: "ROLE", id: PR_FIXTURE_ROLE }]);
    const entityId = newEntityId();
    await createPr(entityId, { amount: "1000.00" });
    let s = await stateOf(entityId);

    // Forge an APPROVED row for the requester on the live step.
    await db.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status, acted_at)
       VALUES ($1, $2, 'APPROVED', NOW())`,
      [s.steps[0].id, REQ]
    );

    await expect(
      submitApprovalAction({ approval_instance_id: s.inst.id, approver_user_id: REQ, action: "APPROVE" })
    ).rejects.toMatchObject({ code: "APPROVAL_INITIATOR_CANNOT_ACT" });

    // The only independent approver is removed: the requester's APPROVED row
    // must not complete the step.
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2`, [A1, PR_FIXTURE_ROLE]);
    const result = await revalidate({ userId: A1, changeType: "scope_removed", changedScopes: [fixtureScope()] });

    s = await stateOf(entityId);
    expect(result.autoCompletedInstanceIds).not.toContain(s.inst.id);
    expect(s.inst.status).toBe("PENDING");
    expect(s.steps[0].status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
describe("PR approval — strict steps and the shared chain resolver", () => {
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

  it("chain.preview-parity: resolvePolicyChain reports exactly what createApprovalInstance builds and refuses", async () => {
    await makeApprovable([A1, A2, REQ]);
    const policyId = await seedPolicy([
      { type: "USER", id: A1 },
      { type: "USER", id: A2, min: "50000.00" },
      { type: "USER", id: REQ },
    ]);
    const ask = () =>
      resolvePolicyChain({
        entity_type: "PR",
        policy_id: policyId,
        hospitality_company_id: HC,
        hotel_id: HOTEL,
        department_id: DEPT,
        process_id: null,
        initiated_by: REQ,
        amount: "10000",
      }, db);

    const chain = await ask();
    expect(chain.steps.map((st) => [st.policy_step.step_order, st.approverIds])).toEqual([[1, [A1]]]);
    expect(chain.skipped.map((sk) => [sk.step_order, sk.reason])).toEqual([[2, "below_threshold"], [3, "sod_self"]]);
    expect(chain.problems).toEqual([]);

    const entityId = newEntityId();
    await createPr(entityId, { amount: "10000" });
    const s = await stateOf(entityId);
    expect(s.steps.map((st) => [st.policy_step_order, activeApproversOf(s, st.step_order)])).toEqual([[1, [A1]]]);
    expect(skipped(s).map((sk) => [sk.step_order, sk.reason])).toEqual(chain.skipped.map((sk) => [sk.step_order, sk.reason]));

    // Unresolvable first step: the preview names the same problem submit throws.
    await db.none(
      `UPDATE tbl_approval_policy_steps SET approver_source_type = 'ROLE', approver_source_id = $2
        WHERE approval_policy_id = $1 AND step_order = 1`,
      [policyId, PR_APPROVER_ROLE]
    );
    const broken = await ask();
    expect(broken.steps).toEqual([]);
    expect(broken.problems).toEqual([
      expect.objectContaining({ code: "APPROVAL_STEP_UNRESOLVED", step_order: 1, reason: "NO_APPROVERS_RESOLVED" }),
      { code: "APPROVAL_NO_INDEPENDENT_APPROVER" },
    ]);
    const refused = newEntityId();
    await expect(createPr(refused, { amount: "10000" })).rejects.toMatchObject({
      code: broken.problems[0].code,
      step_order: broken.problems[0].step_order,
    });
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

  it("non-PR refusal unchanged: an MR policy resolving to nobody is still refused with the coded, explained error", async () => {
    // PR never reaches this branch (it refuses with NO_INDEPENDENT_APPROVER
    // first), so it is pinned here on the shared createApprovalInstance path.
    await seedPolicy([{ type: "ROLE", id: PR_FIXTURE_ROLE }], { entityType: "MR" }); // a role with no mr.*
    const entityId = newEntityId();

    const err = await createApprovalInstance({
      entity_type: "MR",
      entity_id: entityId,
      hospitality_company_id: HC,
      hotel_id: HOTEL,
      department_id: DEPT,
      initiated_by: REQ,
      metadata: { mr_number: `MR-TEST-${entityId}` },
    }).then(() => null, (e) => e);

    expect(err).toMatchObject({ code: "APPROVAL_POLICY_RESOLVES_TO_NOBODY", httpStatus: 400 });
    expect(err.message).toMatch(/mr\.read and mr\.approve/);
    expect(err.diagnostics.skipped_steps).toEqual([
      expect.objectContaining({ step_order: 1, reason: "ROLE_LACKS_READ_AND_APPROVE" }),
    ]);
    expect((await stateOf(entityId, "MR")).count).toBe(0);
  });

  it("non-PR delegation unchanged: an MR approver covering via the initiator still hands it to them", async () => {
    await makeApprovable([A1], "mr");
    await delegate(A1, REQ, "MR control — delegation behaves as before");
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
  it("propagation.no-readd: membership revalidation never installs the requester", async () => {
    await makeApprovable([REQ, A1]);
    await seedPolicy([{ type: "ROLE", id: PR_FIXTURE_ROLE }]);
    const entityId = newEntityId();
    await createPr(entityId, { amount: "1000.00" });
    let s = await stateOf(entityId);
    expect(activeApproversOf(s, 1)).toEqual([A1]);

    // REQ gains another scope of the step's role.
    track.scopeIds.push(
      await grantRoleScope(db, { userId: REQ, roleId: PR_FIXTURE_ROLE, companyId: HC, hotelId: null, departmentId: DEPT })
    );
    await revalidate({
      userId: REQ,
      changeType: "scope_added",
      changedScopes: [fixtureScope({ hotel_id: null })],
      changedRoleIds: [PR_FIXTURE_ROLE],
    });

    s = await stateOf(entityId);
    expect(s.inst.status).toBe("PENDING");
    expect(everOnInstance(s, REQ)).toBe(false);
    expect(s.actions.filter((a) => Number(a.approver_user_id) === REQ)).toEqual([]);
    expect(activeApproversOf(s, 1)).toEqual([A1]);
  });

  it("propagation.pinned: editing, removing and adding policy steps never touches a pending PR instance", async () => {
    await makeApprovable([A1, A2, A3, A4, REQ]);
    const policyId = await seedPolicy([
      { type: "USER", id: A1 },
      { type: "USER", id: A2, min: "50000.00" },
      { type: "USER", id: A3 },
    ]);
    const entityId = newEntityId();
    await createPr(entityId, { amount: "10000.00" });

    const before = await stateOf(entityId);
    expect(before.steps.map((st) => [st.step_order, st.policy_step_order, st.status])).toEqual([
      [1, 1, "PENDING"],
      [2, 3, "PENDING"],
    ]);
    expect(activeApproversOf(before, 1)).toEqual([A1]);
    expect(activeApproversOf(before, 2)).toEqual([A3]);
    const snapshot = (st) => ({
      status: st.inst.status,
      current_step: st.inst.current_step,
      policy_version: st.inst.policy_version,
      steps: st.steps.map((x) => [x.id, x.step_order, x.status]),
      approvers: st.approvers.map((a) => [a.step_order, Number(a.approver_user_id), a.status]),
      actions: st.actions.map((a) => [Number(a.approver_user_id), a.action]),
      changeLogs: st.changeLogs,
    });
    const expected = snapshot(before);

    const admin = await httpClient(ADMIN);
    const saveSteps = (steps, extra = {}) =>
      admin.post(POLICIES_URL).send({ id: policyId, entity_type: "PR", hotel_id: HOTEL, is_active: true, steps, ...extra });

    // 1. The reviewer's case: delete the ₹50k step. A pending PR is not an
    //    "affected approval" any more, so no impact confirmation is needed.
    const removed = await saveSteps([
      { step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: A1 },
      { step_order: 2, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: A3 },
    ]);
    expect(removed.status).toBe(200);
    expect(removed.body.status).toBe(1);
    expect(snapshot(await stateOf(entityId))).toEqual(expected);

    // 2. Rewrite every step (step 1 → the requester, step 2 → A4) and add a
    //    third. Applied by ordinal this would empty step 1 and replace A3.
    const rewritten = await saveSteps([
      { step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: REQ },
      { step_order: 2, decision_rule: "ALL", approver_source_type: "USER", approver_source_id: A4 },
      { step_order: 3, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: A2 },
    ], { confirmed_approval_impact: true });
    expect(rewritten.status).toBe(200);
    expect(rewritten.body.status).toBe(1);

    const after = await stateOf(entityId);
    expect(snapshot(after)).toEqual(expected);
    expect(after.inst.status).toBe("PENDING");
    expect(after.steps.every((st) => st.status === "PENDING")).toBe(true);
    expect(everOnInstance(after, REQ)).toBe(false);
  });

  it("sod.blocked-not-auto-completed: losing the only approver blocks the PR step instead of approving it", async () => {
    await makeApprovable([A1]); // PR_FIXTURE_ROLE held by A1 only
    await seedPolicy([{ type: "ROLE", id: PR_FIXTURE_ROLE }]);
    const entityId = newEntityId();
    await createPr(entityId, { amount: "1000.00" });
    let s = await stateOf(entityId);
    const instanceId = s.inst.id;
    expect(activeApproversOf(s, 1)).toEqual([A1]);

    // The pre-flight warning describes what will actually happen: blocked, not approved.
    const sim = await simulateApproverImpact(A1, "scope_removed", { companyId: HC, changedScopes: [fixtureScope()] });
    const simRow = sim.affectedInstances.find((r) => Number(r.instance_id) === Number(instanceId));
    expect(simRow).toMatchObject({ impact: "BLOCK_STEP", wouldBlockStep: true, wouldAutoCompleteStep: false, wouldAutoCompleteInstance: false });
    expect(sim.willAutoComplete).toBe(false);

    // 1. A1's role is revoked.
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2`, [A1, PR_FIXTURE_ROLE]);
    const revoked = await revalidate({ userId: A1, changeType: "scope_removed", changedScopes: [fixtureScope()] });

    s = await stateOf(entityId);
    expect(revoked.autoCompletedInstanceIds).not.toContain(instanceId); // → no post-approval dispatch
    expect(s.inst.status).toBe("PENDING");
    expect(s.inst.current_step).toBe(1);
    expect(s.steps.map((st) => st.status)).toEqual(["PENDING"]);
    expect(approverRow(s, 1, A1).status).toBe("REMOVED");
    expect(activeApproversOf(s, 1)).toEqual([]); // visibly approver-less
    expect(s.actions.filter((a) => a.action === "APPROVE")).toEqual([]);

    // 2. Re-granted: the engine re-adds A1 to the blocked step.
    track.scopeIds.push(
      await grantRoleScope(db, { userId: A1, roleId: PR_FIXTURE_ROLE, companyId: HC, hotelId: HOTEL, departmentId: DEPT })
    );
    await revalidate({
      userId: A1,
      changeType: "scope_added",
      changedScopes: [fixtureScope()],
      changedRoleIds: [PR_FIXTURE_ROLE],
    });
    s = await stateOf(entityId);
    expect(approverRow(s, 1, A1).status).toBe("PENDING");
    expect(s.inst.status).toBe("PENDING");

    // 3. The ROLE itself loses pr.approve: the step is blocked, not retired.
    await db.none(
      `DELETE FROM tbl_role_permissions rp USING tbl_permissions p
        WHERE rp.role_id = $1 AND rp.permission_id = p.id
          AND p.resource::text = 'pr' AND p.action::text = 'approve'`,
      [PR_FIXTURE_ROLE]
    );
    try {
      const permResult = await db.tx((t) =>
        revalidateRolePermissionChange({ roleId: PR_FIXTURE_ROLE, changedBy: ADMIN, txContext: t })
      );
      s = await stateOf(entityId);
      expect(permResult.autoCompletedInstanceIds).not.toContain(instanceId);
      expect(s.inst.status).toBe("PENDING");
      expect(s.steps.map((st) => st.status)).toEqual(["PENDING"]);
      expect(approverRow(s, 1, A1).status).toBe("REMOVED");
      expect(s.actions.filter((a) => a.action === "APPROVE")).toEqual([]);
    } finally {
      await makeApprovable([A1]); // restores the role's read+approve for later tests
    }
  });

  it("pinned.snapshot: after a policy re-save, revalidation resolves PR steps from the creation snapshot, never by position", async () => {
    // Reviewer probe (fix round 2, #1): policy [USER A1, ROLE "PR Approver" ≥₹50k,
    // ROLE fixture], ₹10k PR → instance [A1, holders of the fixture role].
    await makeApprovable([A1, A3]); // fixture role held by A1 and A3
    const policyId = await seedPolicy([
      { type: "USER", id: A1 },
      { type: "ROLE", id: PR_APPROVER_ROLE, min: "50000.00" },
      { type: "ROLE", id: PR_FIXTURE_ROLE },
    ]);
    const entityId = newEntityId();
    await createPr(entityId, { amount: "10000.00" });
    let s = await stateOf(entityId);
    expect(s.steps.map((st) => [st.step_order, st.policy_step_order])).toEqual([[1, 1], [2, 3]]);
    expect(activeApproversOf(s, 2)).toEqual([A1, A3].sort((a, b) => a - b));

    // Re-save the policy with IDENTICAL steps (propagation leaves pinned PRs alone).
    const admin = await httpClient(ADMIN);
    const resave = await admin.post(POLICIES_URL).send({
      id: policyId, entity_type: "PR", hotel_id: HOTEL, is_active: true,
      steps: [
        { step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: A1 },
        { step_order: 2, decision_rule: "ANY", approver_source_type: "ROLE", approver_source_id: PR_APPROVER_ROLE, min_amount: "50000.00" },
        { step_order: 3, decision_rule: "ANY", approver_source_type: "ROLE", approver_source_id: PR_FIXTURE_ROLE },
      ],
    });
    expect(resave.status).toBe(200);
    s = await stateOf(entityId);
    // The save keeps the ids of unchanged steps, so the links survive. Older
    // saves (delete + re-insert) nulled them; clear them to probe that path:
    // resolution must then come from the creation snapshot, never by position.
    expect(s.steps.map((st) => st.policy_step_order)).toEqual([1, 3]);
    await db.none(`UPDATE tbl_approval_instance_steps SET policy_step_id = NULL WHERE approval_instance_id = $1`, [s.inst.id]);
    s = await stateOf(entityId);
    expect(s.steps.map((st) => st.policy_step_order)).toEqual([null, null]); // links gone

    // A2 is granted "PR Approver" — the ₹50k-only role. Position 2 of the
    // policy is that role, but instance step 2 is the fixture-role step.
    track.scopeIds.push(
      await grantRoleScope(db, { userId: A2, roleId: PR_APPROVER_ROLE, companyId: HC, hotelId: HOTEL, departmentId: DEPT })
    );
    await revalidate({
      userId: A2,
      changeType: "scope_added",
      changedScopes: [fixtureScope({ role_id: PR_APPROVER_ROLE })],
      changedRoleIds: [PR_APPROVER_ROLE],
    });
    s = await stateOf(entityId);
    expect(everOnInstance(s, A2)).toBe(false);

    // The other direction: A3 loses the fixture role. Simulation and the
    // reconciler must both find step 2 by its snapshot and remove A3 there.
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2`, [A3, PR_FIXTURE_ROLE]);
    const sim = await simulateApproverImpact(A3, "scope_removed", { companyId: HC, changedScopes: [fixtureScope()] });
    expect(sim.affectedInstances.filter((r) => Number(r.instance_id) === Number(s.inst.id)).map((r) => r.step_order)).toEqual([2]);
    await revalidate({ userId: A3, changeType: "scope_removed", changedScopes: [fixtureScope()] });
    s = await stateOf(entityId);
    expect(approverRow(s, 2, A3).status).toBe("REMOVED");
    expect(activeApproversOf(s, 2)).toEqual([A1]);
    expect(s.inst.status).toBe("PENDING");

    // The snapshot itself, written at creation.
    const snap = await db.any(
      `SELECT step_order, source_approver_type, source_approver_id, source_policy_step_order, source_min_amount
         FROM tbl_approval_instance_steps WHERE approval_instance_id = $1 ORDER BY step_order`,
      [s.inst.id]
    );
    expect(snap).toEqual([
      { step_order: 1, source_approver_type: "USER", source_approver_id: A1, source_policy_step_order: 1, source_min_amount: null },
      { step_order: 2, source_approver_type: "ROLE", source_approver_id: PR_FIXTURE_ROLE, source_policy_step_order: 3, source_min_amount: null },
    ]);
  });

  it("sod.stripped-role-cannot-refill: a role without pr.approve can never put an approver back on a blocked PR step", async () => {
    // Reviewer probe (fix round 2, #2).
    await makeApprovable([A1]); // fixture role held by A1 only
    await seedPolicy([{ type: "ROLE", id: PR_FIXTURE_ROLE }]);
    const entityId = newEntityId();
    await createPr(entityId, { amount: "1000.00" });
    let s = await stateOf(entityId);
    const stepId = s.steps[0].id;

    await db.none(
      `DELETE FROM tbl_role_permissions rp USING tbl_permissions p
        WHERE rp.role_id = $1 AND rp.permission_id = p.id
          AND p.resource::text = 'pr' AND p.action::text = 'approve'`,
      [PR_FIXTURE_ROLE]
    );
    try {
      await db.tx((t) => revalidateRolePermissionChange({ roleId: PR_FIXTURE_ROLE, changedBy: ADMIN, txContext: t }));
      s = await stateOf(entityId);
      expect(s.steps[0].status).toBe("PENDING");
      expect(activeApproversOf(s, 1)).toEqual([]); // blocked

      // A2 is granted the (still-stripped) role: revalidation must not refill the step.
      track.scopeIds.push(
        await grantRoleScope(db, { userId: A2, roleId: PR_FIXTURE_ROLE, companyId: HC, hotelId: HOTEL, departmentId: DEPT })
      );
      await revalidate({
        userId: A2,
        changeType: "scope_added",
        changedScopes: [fixtureScope()],
        changedRoleIds: [PR_FIXTURE_ROLE],
      });
      s = await stateOf(entityId);
      expect(everOnInstance(s, A2)).toBe(false);
      expect(activeApproversOf(s, 1)).toEqual([]);

      // Defence in depth: a PENDING row for A2 written by any other path still
      // cannot approve through a role that cannot approve PRs.
      await db.none(
        `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
         VALUES ($1, $2, 'PENDING')`,
        [stepId, A2]
      );
      await expect(
        submitApprovalAction({ approval_instance_id: s.inst.id, approver_user_id: A2, action: "APPROVE" })
      ).rejects.toMatchObject({ code: "APPROVAL_SOURCE_INELIGIBLE" });
      s = await stateOf(entityId);
      expect(s.inst.status).toBe("PENDING");
      expect(s.steps[0].status).toBe("PENDING");
      expect(s.actions.filter((a) => a.action === "APPROVE")).toEqual([]);
    } finally {
      await makeApprovable([A1]); // restores the role's read+approve for later tests
    }
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
    const trackCreated = (res) => {
      const id = Number(res.body?.data?.id);
      if (Number.isFinite(id) && id > 0) track.policyIds.push(id);
      return id;
    };

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
    const prPolicyId = trackCreated(pr);
    expect(pr.status).toBe(201);
    expect(pr.body.status).toBe(1);
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

    // An UPDATE that does not resend entity_type still cannot attach a process.
    const upd = await admin.post(POLICIES_URL).send({
      id: prPolicyId, hotel_id: HOTEL, process_id: IDS.processes.A_P1, is_active: true,
    });
    expect(upd.status).toBe(200);
    expect((await db.one(`SELECT process_id FROM tbl_approval_policies WHERE id = $1`, [prPolicyId])).process_id).toBeNull();

    const mr = await admin.post(POLICIES_URL).send({
      entity_type: "MR",
      hospitality_company_id: HC,
      hotel_id: HOTEL,
      is_active: true,
      steps: [
        { step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: A1, min_amount: "25000" },
      ],
    });
    const mrPolicyId = trackCreated(mr);
    expect(mr.status).toBe(201);
    expect(mr.body.status).toBe(1);
    // Thresholds are a PR rule; on any other entity type the field is ignored, as before.
    const mrStep = await db.one(`SELECT min_amount FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [mrPolicyId]);
    expect(mrStep.min_amount).toBeNull();

    const newPrAtOtherHotel = (minAmount) =>
      admin.post(POLICIES_URL).send({
        entity_type: "PR",
        hospitality_company_id: HC,
        hotel_id: OTHER_HOTEL,
        is_active: true,
        steps: [{ step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: A1, min_amount: minAmount }],
      });

    const countPr = async () =>
      (await db.one(`SELECT count(*)::int AS n FROM tbl_approval_policies WHERE entity_type = 'PR'`)).n;
    const before = await countPr();
    // NUMERIC(18,2) tops out at 9999999999999999.99 — one paisa more is refused, not a DB overflow.
    for (const bad of ["-1", "12.345", "abc", "10000000000000000.00"]) {
      const res = await newPrAtOtherHotel(bad);
      trackCreated(res);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_MIN_AMOUNT");
    }
    expect(await countPr()).toBe(before);

    const max = await newPrAtOtherHotel("9999999999999999.99");
    const maxId = trackCreated(max);
    expect(max.status).toBe(201);
    expect(
      (await db.one(`SELECT min_amount FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [maxId])).min_amount
    ).toBe("9999999999999999.99");
  });

  it("MR is process-free too (R43): a process sent on create or on an update that omits entity_type is stored NULL", async () => {
    // The MR engine matches with process_id NULL (mrController), so an MR policy
    // saved with a process could never be matched.
    const admin = await httpClient(ADMIN);
    const mr = await admin.post(POLICIES_URL).send({
      entity_type: "MR",
      hospitality_company_id: HC,
      hotel_id: OTHER_HOTEL,
      process_id: IDS.processes.A_P1,
      is_active: true,
      steps: [{ step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: A1 }],
    });
    const mrPolicyId = Number(mr.body?.data?.id);
    if (Number.isFinite(mrPolicyId) && mrPolicyId > 0) track.policyIds.push(mrPolicyId);
    expect(mr.status).toBe(201);
    expect(await db.one(`SELECT entity_type, process_id FROM tbl_approval_policies WHERE id = $1`, [mrPolicyId]))
      .toEqual({ entity_type: "MR", process_id: null });

    const upd = await admin.post(POLICIES_URL).send({
      id: mrPolicyId, hotel_id: OTHER_HOTEL, process_id: IDS.processes.A_P1, is_active: true,
    });
    expect(upd.status).toBe(200);
    expect((await db.one(`SELECT process_id FROM tbl_approval_policies WHERE id = $1`, [mrPolicyId])).process_id).toBeNull();
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

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("APPROVAL_TYPE_SERVER_OWNED");
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
