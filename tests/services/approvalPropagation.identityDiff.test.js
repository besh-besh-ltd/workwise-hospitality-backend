/**
 * A policy level is WHO approves, not WHERE it sits.
 *
 * computePolicyStepDiff used to pair old and new policy steps by `step_order`
 * alone. Removing Level 1 of [A, B] therefore read as "Level 1 changed from A
 * to B, Level 2 removed" — and every instance waiting on B at Level 2 had that
 * step REMOVED, advanced past the end, and auto-completed. The post-approval
 * handler then fired as if B had approved (for a PO: the PO was drafted).
 *
 * The diff now pairs levels by approver identity first and only falls back to
 * position for levels whose approver genuinely changed. Matching a diff entry
 * onto a live instance step follows the link captured BEFORE the policy steps
 * are deleted, and refuses to guess (fails closed) when no link exists and the
 * instance's shape does not line up with the old policy.
 *
 * Every product test drives the real admin endpoint
 * (POST /general/hospitality/approval/policies) through the full middleware
 * chain against instances built by the real createApprovalInstance.
 */

import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { approveStep } from "../helpers/approval.js";
import { makeRFQ } from "../factories/rfq.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";
import { pairPolicySteps, computePolicyStepDiff } from "../../app/services/approvalPropagationService.js";

// ===========================================================================
// Pure pairing / diff
// ===========================================================================
const ps = (id, order, sourceType, sourceId, rule = "ALL") => ({
  id,
  step_order: order,
  decision_rule: rule,
  approver_source_type: sourceType,
  approver_source_id: sourceId,
});

describe("pairPolicySteps / computePolicyStepDiff pair levels by approver identity", () => {
  it("[R8, R12] -> [R12]: R8 is removed and R12 moves up, nothing is modified", () => {
    const oldSteps = [ps(101, 1, "ROLE", 8), ps(102, 2, "ROLE", 12)];
    const newSteps = [ps(201, 1, "ROLE", 12)];

    expect(pairPolicySteps(oldSteps, newSteps)).toEqual({
      pairs: [{ oldStep: oldSteps[1], newStep: newSteps[0], kind: "identity" }],
      removed: [oldSteps[0]],
      added: [],
    });
    expect(computePolicyStepDiff(oldSteps, newSteps)).toEqual([
      { type: "STEP_REMOVED", step_order: 1, oldStep: oldSteps[0] },
      { type: "STEP_MOVED", from: 2, to: 1, oldStep: oldSteps[1], newStep: newSteps[0] },
    ]);
  });

  it("[R2, R4] -> [R4]: the dead level is removed and R4 moves up", () => {
    const oldSteps = [ps(111, 1, "ROLE", 2), ps(112, 2, "ROLE", 4)];
    const newSteps = [ps(211, 1, "ROLE", 4)];

    expect(computePolicyStepDiff(oldSteps, newSteps)).toEqual([
      { type: "STEP_REMOVED", step_order: 1, oldStep: oldSteps[0] },
      { type: "STEP_MOVED", from: 2, to: 1, oldStep: oldSteps[1], newStep: newSteps[0] },
    ]);
  });

  it("[A, B] -> [A, C]: a changed approver at the same level is a source modification", () => {
    const oldSteps = [ps(121, 1, "USER", 501), ps(122, 2, "USER", 502)];
    const newSteps = [ps(221, 1, "USER", 501), ps(222, 2, "USER", 503)];

    expect(pairPolicySteps(oldSteps, newSteps).pairs).toEqual([
      { oldStep: oldSteps[0], newStep: newSteps[0], kind: "identity" },
      { oldStep: oldSteps[1], newStep: newSteps[1], kind: "position" },
    ]);
    expect(computePolicyStepDiff(oldSteps, newSteps)).toEqual([
      {
        type: "STEP_MODIFIED",
        step_order: 2,
        oldStep: oldSteps[1],
        newStep: newSteps[1],
        sourceChanged: true,
        ruleChanged: false,
        oldRule: "ALL",
        newRule: "ALL",
      },
    ]);
  });

  it("[A ANY] -> [A ALL]: same approver, new rule, is a rule-only modification", () => {
    const oldSteps = [ps(131, 1, "USER", 501, "ANY")];
    const newSteps = [ps(231, 1, "USER", 501, "ALL")];

    expect(computePolicyStepDiff(oldSteps, newSteps)).toEqual([
      {
        type: "STEP_MODIFIED",
        step_order: 1,
        oldStep: oldSteps[0],
        newStep: newSteps[0],
        sourceChanged: false,
        ruleChanged: true,
        oldRule: "ANY",
        newRule: "ALL",
      },
    ]);
  });

  it("[A, B, A] -> [A, A]: occurrences of one approver pair in order and never cross-match", () => {
    const oldSteps = [ps(141, 1, "USER", 501), ps(142, 2, "USER", 502), ps(143, 3, "USER", 501)];
    const newSteps = [ps(241, 1, "USER", 501), ps(242, 2, "USER", 501)];

    expect(pairPolicySteps(oldSteps, newSteps)).toEqual({
      pairs: [
        { oldStep: oldSteps[0], newStep: newSteps[0], kind: "identity" },
        { oldStep: oldSteps[2], newStep: newSteps[1], kind: "identity" },
      ],
      removed: [oldSteps[1]],
      added: [],
    });
    // The first A is untouched: no entry at all.
    expect(computePolicyStepDiff(oldSteps, newSteps)).toEqual([
      { type: "STEP_REMOVED", step_order: 2, oldStep: oldSteps[1] },
      { type: "STEP_MOVED", from: 3, to: 2, oldStep: oldSteps[2], newStep: newSteps[1] },
    ]);
  });

  it("pairs a request-body step (string ids) with the stored row it names", () => {
    // The pre-flight warning diffs the stored rows against the raw request body,
    // where ids can arrive as strings. Same approver = same level.
    const oldSteps = [ps(151, 1, "ROLE", 4)];
    const newSteps = [{ step_order: "1", decision_rule: "ALL", approver_source_type: "ROLE", approver_source_id: "4" }];

    expect(computePolicyStepDiff(oldSteps, newSteps)).toEqual([]);
  });
});

// ===========================================================================
// Product tests: policy edits through the admin endpoint
// ===========================================================================

// Local ID block — 854xx users, 654xx policies/steps — unused elsewhere.
const ADMIN_ID = 85401; // performs every edit; user_type 7 for requireCompanyAdmin; approves nothing
const A_ID = 85402;
const B_ID = 85403;
const C_ID = 85404;
const ALL_USERS = [ADMIN_ID, A_ID, B_ID, C_ID];

// Role 4 (Tender Approver) holds rfq.read + rfq.approve; role 2 (Tender
// Creator) holds rfq.read only — a ROLE step naming it is DROPPED when an
// instance is created. Both asserted in beforeAll.
const ROLE_CAN_APPROVE = ROLE_IDS.TENDER_APPROVER; // 4
const ROLE_CANNOT_APPROVE = ROLE_IDS.TENDER_CREATOR; // 2

// One policy per test. Each needs its own (entity_type, company, hotel, dept,
// process) tuple — uq_approval_policy_scope_process — but the tuple is otherwise
// irrelevant: every instance names its policy via `approval_policy_id`.
const POLICIES = {
  removeLevel1: { id: 65401, hotel: IDS.hotels.A2, dept: IDS.departments.fb },
  deadRole: { id: 65402, hotel: IDS.hotels.A2, dept: IDS.departments.hk },
  deadRoleUnlinked: { id: 65403, hotel: IDS.hotels.A3, dept: IDS.departments.fb },
  ordinal: { id: 65404, hotel: IDS.hotels.A3, dept: IDS.departments.hk },
  published: { id: 65405, hotel: IDS.hotels.A2, dept: IDS.departments.eng },
  sameApproverTwice: { id: 65406, hotel: IDS.hotels.A3, dept: IDS.departments.eng },
  resave: { id: 65407, hotel: IDS.hotels.A1, dept: IDS.departments.fb },
};
const POLICY_IDS = Object.values(POLICIES).map((p) => p.id);

// [policy, [[stepId, order, sourceType, sourceId], ...]] — all rules ALL.
const POLICY_STEPS = [
  [POLICIES.removeLevel1, [[65411, 1, "USER", A_ID], [65412, 2, "USER", B_ID]]],
  [POLICIES.deadRole, [[65421, 1, "ROLE", ROLE_CANNOT_APPROVE], [65422, 2, "ROLE", ROLE_CAN_APPROVE]]],
  [POLICIES.deadRoleUnlinked, [[65431, 1, "ROLE", ROLE_CANNOT_APPROVE], [65432, 2, "ROLE", ROLE_CAN_APPROVE]]],
  [POLICIES.ordinal, [[65441, 1, "USER", A_ID], [65442, 2, "USER", B_ID]]],
  [POLICIES.published, [[65451, 1, "USER", A_ID], [65452, 2, "USER", B_ID]]],
  [POLICIES.sameApproverTwice, [[65461, 1, "USER", A_ID], [65462, 2, "USER", B_ID], [65463, 3, "USER", A_ID]]],
  [POLICIES.resave, [[65471, 1, "USER", A_ID], [65472, 2, "USER", B_ID]]],
];

// Instances are built at A2 / Procurement whatever the policy's own tuple.
const INSTANCE_HOTEL = IDS.hotels.A2;
const INSTANCE_DEPT = IDS.departments.proc;

let nextEntityId = 8540001; // no tbl_rfq row has an id this high → an unpublished RFQ
const made = { instanceIds: [], entityIds: [], rfqIds: [] };

const step = (order, sourceType, sourceId) => ({
  step_order: order,
  decision_rule: "ALL",
  approver_source_type: sourceType,
  approver_source_id: sourceId,
});

/** POST the payload the Approval Wizard posts when an admin saves a policy. */
async function editPolicy(client, policy, steps, { confirmed = true } = {}) {
  return client.post("/api/v1/general/hospitality/approval/policies").send({
    id: policy.id,
    entity_type: "RFQ",
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: policy.hotel,
    department_id: policy.dept,
    is_active: true,
    ...(confirmed ? { confirmed_approval_impact: true } : {}),
    steps,
  });
}

/** A PENDING RFQ approval built by the production creator. */
async function makeInstance(policy, { entityId } = {}) {
  const id = entityId ?? nextEntityId++;
  const res = await createApprovalInstance({
    entity_type: "RFQ",
    entity_id: id,
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: INSTANCE_HOTEL,
    department_id: INSTANCE_DEPT,
    process_id: null,
    approval_policy_id: policy.id,
    initiated_by: ADMIN_ID,
    metadata: { rfq_number: `RFQ-ID-${id}` },
  });
  made.instanceIds.push(res.instance.id);
  made.entityIds.push(id);
  return res.instance;
}

async function instanceRow(instanceId) {
  return db.one(`SELECT id, status, current_step FROM tbl_approval_instances WHERE id = $1`, [instanceId]);
}

async function instanceStepsOf(instanceId) {
  return db.any(
    `SELECT id, step_order, status, policy_step_id
       FROM tbl_approval_instance_steps
      WHERE approval_instance_id = $1
      ORDER BY step_order ASC`,
    [instanceId]
  );
}

/** Every approver row on the instance, as [instance step id, user, status]. */
async function approverRows(instanceId) {
  return (
    await db.any(
      `SELECT asa.approval_instance_step_id AS step_id, asa.approver_user_id AS user_id, asa.status
         FROM tbl_approval_step_approvers asa
         JOIN tbl_approval_instance_steps ais ON ais.id = asa.approval_instance_step_id
        WHERE ais.approval_instance_id = $1
        ORDER BY asa.approval_instance_step_id, asa.approver_user_id`,
      [instanceId]
    )
  ).map((r) => [r.step_id, r.user_id, r.status]);
}

async function approverStatusAt(instanceId, instanceStepOrder, userId) {
  const row = await db.oneOrNone(
    `SELECT asa.status
       FROM tbl_approval_step_approvers asa
       JOIN tbl_approval_instance_steps ais ON ais.id = asa.approval_instance_step_id
      WHERE ais.approval_instance_id = $1 AND ais.step_order = $2 AND asa.approver_user_id = $3`,
    [instanceId, instanceStepOrder, userId]
  );
  return row?.status;
}

/** The live policy steps, keyed by step_order → id. */
async function policyStepIds(policyId) {
  const rows = await db.any(
    `SELECT id, step_order FROM tbl_approval_policy_steps WHERE approval_policy_id = $1 ORDER BY step_order`,
    [policyId]
  );
  return Object.fromEntries(rows.map((r) => [r.step_order, r.id]));
}

/** The propagation record written for this instance by the last edit. */
async function lastChangeSummary(instanceId) {
  const row = await db.oneOrNone(
    `SELECT change_summary FROM tbl_approval_instance_change_log
      WHERE approval_instance_id = $1 ORDER BY id DESC LIMIT 1`,
    [instanceId]
  );
  return row?.change_summary ?? null;
}

async function cleanupInstances() {
  const instanceIds = (
    await db.any(
      `SELECT id FROM tbl_approval_instances
        WHERE id = ANY($1::int[]) OR approval_policy_id = ANY($2::int[])`,
      [made.instanceIds, POLICY_IDS]
    )
  ).map((r) => r.id);
  if (instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [instanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_change_log WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
  }
  const entityIds = [...made.entityIds, ...made.rfqIds];
  if (entityIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'RFQ' AND entity_id = ANY($1::int[])`, [entityIds]);
  }
  if (made.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [made.rfqIds]);
  }
  made.instanceIds = [];
  made.entityIds = [];
  made.rfqIds = [];
}

beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_users (id, name, email, mobile, password, user_type, status, company_id)
     VALUES ($1, 'Identity Admin', 'identity.admin@test.local', '9000085401', 'x', 7, 1, $5),
            ($2, 'Identity A',     'identity.a@test.local',     '9000085402', 'x', 2, 1, $5),
            ($3, 'Identity B',     'identity.b@test.local',     '9000085403', 'x', 2, 1, $5),
            ($4, 'Identity C',     'identity.c@test.local',     '9000085404', 'x', 2, 1, $5)
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_ID, A_ID, B_ID, C_ID, IDS.companies.A]
  );
  await db.none(`UPDATE tbl_users SET user_type = 7, status = 1 WHERE id = $1`, [ADMIN_ID]);

  // Admin: company-level mapping (derives the policy-edit scope). Approvers:
  // mapped to the instance hotel and holding the RFQ-approving role there, so
  // a USER step naming them qualifies and a ROLE step on role 4 resolves them.
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
     VALUES ($1, $5, NULL, 0), ($2, $5, $6, 1), ($3, $5, $6, 1), ($4, $5, $6, 1)
     ON CONFLICT DO NOTHING`,
    [ADMIN_ID, A_ID, B_ID, C_ID, IDS.hospitality.A, INSTANCE_HOTEL]
  );
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [[A_ID, B_ID, C_ID]]);
  for (const userId of [A_ID, B_ID, C_ID]) {
    await db.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
       VALUES ($1, $2, $3, NULL, $4, NULL)`,
      [userId, ROLE_CAN_APPROVE, IDS.hospitality.A, INSTANCE_DEPT]
    );
  }

  // Guard the seed premise: if role 2 ever gained rfq.approve (or role 4 lost
  // either permission) the dead-level tests would pass vacuously.
  const perms = await db.any(
    `SELECT rp.role_id, array_agg(DISTINCT p.action::text ORDER BY p.action::text) AS actions
       FROM tbl_role_permissions rp
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ANY($1::int[]) AND p.resource::text = 'rfq' AND p.action IN ('read', 'approve')
      GROUP BY rp.role_id ORDER BY rp.role_id`,
    [[ROLE_CANNOT_APPROVE, ROLE_CAN_APPROVE]]
  );
  expect(perms).toEqual([
    { role_id: ROLE_CANNOT_APPROVE, actions: ["read"] },
    { role_id: ROLE_CAN_APPROVE, actions: ["approve", "read"] },
  ]);

  // Idempotent reset: a run killed before afterAll leaves policies whose steps
  // were replaced by serial ids. Clear everything hanging off them first.
  await cleanupInstances();
  await db.none(`DELETE FROM tbl_approval_policy_change_log WHERE approval_policy_id = ANY($1::int[])`, [POLICY_IDS]);
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [POLICY_IDS]);

  for (const [policy, rows] of POLICY_STEPS) {
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id, process_id, is_active, created_by)
       VALUES ($1, 'RFQ', $2, $3, $4, NULL, true, $5)
       ON CONFLICT (id) DO NOTHING`,
      [policy.id, IDS.hospitality.A, policy.hotel, policy.dept, ADMIN_ID]
    );
    for (const [stepId, order, sourceType, sourceId] of rows) {
      await db.none(
        `INSERT INTO tbl_approval_policy_steps
           (id, approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
         VALUES ($1, $2, $3, 'ALL', $4, $5)`,
        [stepId, policy.id, order, sourceType, sourceId]
      );
    }
  }
});

afterEach(async () => {
  await cleanupInstances();
});

afterAll(async () => {
  await cleanupInstances();
  await db.none(`DELETE FROM tbl_approval_policy_change_log WHERE approval_policy_id = ANY($1::int[])`, [POLICY_IDS]);
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [POLICY_IDS]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [POLICY_IDS]);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [ALL_USERS]);
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [ALL_USERS]);
  await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [ALL_USERS]);
});

describe("editing a live policy never auto-completes an in-flight approval", () => {
  it("removing level 1 keeps an instance pending at level 2", async () => {
    const policy = POLICIES.removeLevel1;
    const instance = await makeInstance(policy);
    await approveStep(instance.id, A_ID);
    expect(await instanceRow(instance.id)).toMatchObject({ status: "PENDING", current_step: 2 });

    const client = await httpClient(ADMIN_ID);
    const res = await editPolicy(client, policy, [step(1, "USER", B_ID)]);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    // Pairing by position read this edit as "level 1 A→B, level 2 removed":
    // the step B was waiting on was REMOVED, the instance ran off the end and
    // was APPROVED with nobody at level 2 having approved it.
    expect(await instanceRow(instance.id)).toMatchObject({ status: "PENDING", current_step: 2 });
    expect(await approverStatusAt(instance.id, 2, B_ID)).toBe("PENDING");
    expect(await approverStatusAt(instance.id, 1, A_ID)).toBe("APPROVED");

    // B's step now points at B's (renumbered) level in the edited policy.
    const newIds = await policyStepIds(policy.id);
    const steps = await instanceStepsOf(instance.id);
    expect(steps.map((s) => [s.step_order, s.status])).toEqual([
      [1, "APPROVED"],
      [2, "PENDING"],
    ]);
    expect(steps[1].policy_step_id).toBe(newIds[1]);
  });

  it("removing a dropped role level re-points and changes nothing", async () => {
    // The production shape (296 pending instances): level 1 names a role that
    // cannot approve, so the instance was born with ONE step — numbered 1 but
    // built from policy level 2.
    const policy = POLICIES.deadRole;
    const instance = await makeInstance(policy);
    const before = await instanceStepsOf(instance.id);
    expect(before.map((s) => [s.step_order, s.status, s.policy_step_id])).toEqual([[1, "PENDING", 65422]]);
    const approversBefore = await approverRows(instance.id);
    expect(approversBefore.length).toBeGreaterThan(0);

    const client = await httpClient(ADMIN_ID);
    const res = await editPolicy(client, policy, [step(1, "ROLE", ROLE_CAN_APPROVE)]);
    expect(res.status).toBe(200);

    const newIds = await policyStepIds(policy.id);
    const after = await instanceStepsOf(instance.id);
    expect(after.map((s) => [s.id, s.step_order, s.status])).toEqual(before.map((s) => [s.id, s.step_order, s.status]));
    expect(after[0].policy_step_id).toBe(newIds[1]);
    expect(await approverRows(instance.id)).toEqual(approversBefore);
    expect(await instanceRow(instance.id)).toMatchObject({ status: "PENDING", current_step: 1 });

    // Recorded as what it is: the dead level was not on this instance, and the
    // live level only moved. No approver re-resolution happened.
    const summary = await lastChangeSummary(instance.id);
    expect(summary.stepsModified).toEqual([]);
    expect(summary.stepsMoved).toEqual([
      expect.objectContaining({ instance_step_id: before[0].id, from: 2, to: 1 }),
    ]);
    expect(summary.unmatchedDiffEntries).toEqual([
      expect.objectContaining({ type: "UNMATCHED_SKIPPED", diff_type: "STEP_REMOVED", step_order: 1 }),
    ]);
  });

  it("unlinked legacy instance with misaligned shape is left alone", async () => {
    const policy = POLICIES.deadRoleUnlinked;
    const instance = await makeInstance(policy);
    // A legacy instance whose link was lost to an earlier save: one step, the
    // policy has two, nothing says which level it came from.
    await db.none(`UPDATE tbl_approval_instance_steps SET policy_step_id = NULL WHERE approval_instance_id = $1`, [
      instance.id,
    ]);
    const before = await instanceStepsOf(instance.id);
    const approversBefore = await approverRows(instance.id);

    const client = await httpClient(ADMIN_ID);
    const res = await editPolicy(client, policy, [step(1, "ROLE", ROLE_CAN_APPROVE)]);
    expect(res.status).toBe(200);

    // Guessing by ordinal would claim this step for "policy level 1" — the dead
    // role — which is exactly the wrong level. Fail closed: touch nothing.
    expect(await instanceStepsOf(instance.id)).toEqual(before);
    expect(await approverRows(instance.id)).toEqual(approversBefore);
    expect(await instanceRow(instance.id)).toMatchObject({ status: "PENDING", current_step: 1 });

    const summary = await lastChangeSummary(instance.id);
    expect(summary.unmatchedDiffEntries.map((u) => [u.type, u.diff_type, u.step_order])).toEqual([
      ["UNMATCHED_SKIPPED", "STEP_REMOVED", 1],
      ["UNMATCHED_SKIPPED", "STEP_MOVED", 2],
    ]);
  });

  it("ordinal fallback still works for aligned unlinked instances", async () => {
    const policy = POLICIES.ordinal;
    const instance = await makeInstance(policy);
    await approveStep(instance.id, A_ID);
    await db.none(`UPDATE tbl_approval_instance_steps SET policy_step_id = NULL WHERE approval_instance_id = $1`, [
      instance.id,
    ]);

    const client = await httpClient(ADMIN_ID);
    const res = await editPolicy(client, policy, [step(1, "USER", A_ID), step(2, "USER", C_ID)]);
    expect(res.status).toBe(200);

    // Two instance steps, two policy levels, no links: the ordinal IS the
    // mapping, and level 2's approver change reaches step 2.
    expect(await approverStatusAt(instance.id, 2, B_ID)).toBe("REMOVED");
    expect(await approverStatusAt(instance.id, 2, C_ID)).toBe("PENDING");
    expect(await approverStatusAt(instance.id, 1, A_ID)).toBe("APPROVED");
    expect(await instanceRow(instance.id)).toMatchObject({ status: "PENDING", current_step: 2 });

    // And the instance leaves the edit fully linked, so the next edit no longer
    // depends on the ordinal at all.
    const newIds = await policyStepIds(policy.id);
    expect((await instanceStepsOf(instance.id)).map((s) => s.policy_step_id)).toEqual([newIds[1], newIds[2]]);
  });

  it("the same approver at two levels pairs in order and never cross-matches", async () => {
    const policy = POLICIES.sameApproverTwice;
    const instance = await makeInstance(policy);
    await approveStep(instance.id, A_ID);
    expect(await instanceRow(instance.id)).toMatchObject({ status: "PENDING", current_step: 2 });

    // [A, B, A] -> [A, A]: B's level goes; the SECOND A is the one that moves up.
    const client = await httpClient(ADMIN_ID);
    const res = await editPolicy(client, policy, [step(1, "USER", A_ID), step(2, "USER", A_ID)]);
    expect(res.status).toBe(200);

    const newIds = await policyStepIds(policy.id);
    const steps = await instanceStepsOf(instance.id);
    expect(steps.map((s) => [s.step_order, s.status, s.policy_step_id])).toEqual([
      [1, "APPROVED", newIds[1]], // first A — untouched, re-linked to new level 1
      [2, "REMOVED", null], // B — removed with its level
      [3, "PENDING", newIds[2]], // second A — still owed, re-linked to new level 2
    ]);
    expect(await approverStatusAt(instance.id, 3, A_ID)).toBe("PENDING");
    expect(await instanceRow(instance.id)).toMatchObject({ status: "PENDING", current_step: 3 });
  });

  it("re-saving a policy without changing its levels keeps every instance link", async () => {
    // The wizard always sends `steps`, so ANY save (toggle, scope edit) deletes
    // and re-inserts every level. The link the matcher relies on must survive.
    const policy = POLICIES.resave;
    const instance = await makeInstance(policy);
    expect((await instanceStepsOf(instance.id)).map((s) => s.policy_step_id)).toEqual([65471, 65472]);

    const client = await httpClient(ADMIN_ID);
    const res = await editPolicy(client, policy, [step(1, "USER", A_ID), step(2, "USER", B_ID)]);
    expect(res.status).toBe(200);

    const newIds = await policyStepIds(policy.id);
    expect(newIds[1]).not.toBe(65471);
    expect((await instanceStepsOf(instance.id)).map((s) => s.policy_step_id)).toEqual([newIds[1], newIds[2]]);
  });
});

describe("the impact warning describes what propagation will touch", () => {
  it("impact warning counts only instances propagation will touch", async () => {
    const policy = POLICIES.published;
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      status: 1,
      is_published: 1,
      hospitality: IDS.hospitality.A,
      hotel: INSTANCE_HOTEL,
      department: INSTANCE_DEPT,
    });
    made.rfqIds.push(rfq_id);
    const instance = await makeInstance(policy, { entityId: rfq_id });
    const before = await approverRows(instance.id);

    const client = await httpClient(ADMIN_ID);

    // The only pending instance belongs to a published RFQ, which propagation
    // skips — so there is nothing to warn about, here or in the preview.
    const impact = await client.get(`/api/v1/general/hospitality/approval/policies/${policy.id}/pending-impact`);
    expect(impact.status).toBe(200);
    expect(impact.body.data.pending_count).toBe(0);

    const res = await editPolicy(client, policy, [step(1, "USER", A_ID), step(2, "USER", C_ID)], { confirmed: false });
    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    expect(res.body.status).toBe(1);

    // Saved, and the published RFQ's approval was left exactly as it was.
    expect(Object.keys(await policyStepIds(policy.id))).toHaveLength(2);
    expect(await approverRows(instance.id)).toEqual(before);
  });
});
