/**
 * Revoking a role's permissions must also revoke the live approvals it backs.
 *
 * THE ASYMMETRY. Approval instances snapshot their approvers into
 * `tbl_approval_step_approvers`, and THE SNAPSHOT IS THE AUTHORIZATION:
 * `generalModel.submitApprovalAction` (~:2780) validates only that the acting
 * user has a row on the current step with `status = 'PENDING'`. It re-checks no
 * role, no permission and no scope. Anything surviving in that table keeps real
 * authority over POs, RFQs and ARCs.
 *
 * Creation gates that snapshot. `createApprovalInstance` (generalModel.js:2235-2239)
 * skips a ROLE-source policy step ENTIRELY when the role lacks BOTH `read` and
 * `approve` on the entity's resource — via `roleHasReadAndApprovePermission`,
 * against the resource named by `ENTITY_APPROVE_RESOURCE_MAP` (`ARC`→`arc`,
 * `PO`→`awarding`, `TECHNICAL`→`te`, …).
 *
 * Reconciliation never applied that gate. `approvalPropagationService` imported
 * `roleHasReadAndApprovePermission` at line 20 and that import was its ONLY
 * occurrence in the file; `resolveApprovers` — the only check the reconciler
 * ran — reads `tbl_user_role_scopes` (who HOLDS the role) and never
 * `tbl_role_permissions` (what the role may DO). And `rbacController` imported
 * only `rbacModel`, `logError` and `logger`: no propagation of any kind.
 *
 * So `PUT /api/v1/rbac/roles/:roleId` could strip `approve` from a live role and
 * every already-created PENDING approver row backed by it stayed live and could
 * still approve. Reachable by a plain buyer or buyer-admin (`acl([7, 2])`) —
 * blocked only for system roles and non-creators, and a self-serve custom role
 * a buyer-admin creates and then uses as an approver source is exactly the
 * reachable case (see arc_v2/admin.selfServe.e2e.test.js).
 *
 * WHY IT WAS INVISIBLE. Nothing observable changes at the moment of revocation:
 * no error, no log, no status transition. The approver row simply keeps a
 * `PENDING` it should have lost, and it only converts into a wrong outcome later,
 * when that person clicks Approve — at which point the audit trail records a
 * perfectly ordinary approval by a perfectly ordinary user. Production exposure
 * was measured read-only on 2026-08-03 at ZERO live PENDING approver rows whose
 * backing role currently lacks read+approve, so this is latent hardening rather
 * than an active incident — which is why NOT breaking currently-correct
 * behaviour is weighted above the fix itself here, and why two of the six tests
 * below assert that nothing happens.
 *
 * WHY THE INSTANCES ARE BUILT THROUGH THE REAL `createApprovalInstance`.
 * Hand-inserted steps cannot reproduce this: the entire defect is that the
 * creation-time gate ran and the revocation-time gate did not. An instance
 * whose steps never passed through the gate proves nothing about the pair.
 *
 * STEP-REMOVED, NOT APPROVERS-REMOVED. When the gate now fires, the STEP is
 * marked `REMOVED` (mirroring `applyDiffToInstance`'s STEP_REMOVED branch),
 * NOT merely its approvers. Marking only the approvers also advances the
 * instance — via `reEvaluateInstanceStep`'s "no non-REMOVED approvers left"
 * branch — but that branch writes `status = 'APPROVED', completed_at = NOW()`,
 * leaving a step recorded as approved with zero approval actions behind it.
 * Both outcomes advance the instance; they differ in what the audit trail
 * claims happened, and an approval nobody granted is the worse artifact. The
 * tests below therefore assert the AUDIT TRAIL, not just the end state.
 *
 * Everything runs over real HTTP through the full middleware chain
 * (POST/PUT /api/v1/rbac/roles) against real Postgres.
 */

import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { createApprovalInstance, ENTITY_APPROVE_RESOURCE_MAP } from "../../app/models/generalModel.js";
import { roleStepPermissionVerdict } from "../../app/services/approvalPropagationService.js";

// Fresh private ID block — 86xxx / 66xxx. 88xxx/68xxx belong to
// approvalPropagation.scopedImpact.test.js and 87xxx/67xxx to
// approvalPropagation.stepOrderDivergence.test.js.
const ADMIN_ID = 86001;  // creates + owns every custom role here; user_type 7 for acl([7, 2])
const TARGET_ID = 86002; // holds the role whose permissions get cut
const CO_ID = 86003;     // holds the CONTROL role — the "left completely untouched" witness

// Two ARC policies. Each owns a distinct (hotel, department) tuple because
// uq_approval_policy_scope_process is UNIQUE on
// (entity_type, company, COALESCE(hotel,0), COALESCE(dept,0), COALESCE(process,0)).
// The scope is otherwise irrelevant — every instance names its policy explicitly.
const TWO_STEP_POLICY = 66001; // A2 / Engineering — step 1 dies, step 2 must survive
const ONE_STEP_POLICY = 66002; // A3 / Engineering — the retired step is the only one
const COMMITTEE_POLICY = 66003; // A2 / F&B — ARC_COMMITTEE, for the resource-map test
const TECH_POLICY = 66004; // A3 / F&B — ARC_TECH, for the resource-map test
const ALL_POLICIES = [TWO_STEP_POLICY, ONE_STEP_POLICY, COMMITTEE_POLICY, TECH_POLICY];

// Explicit policy-step ids (+ ON CONFLICT / delete-first) so a run killed before
// afterEach cannot leave rows that trip idx_unique_step_order next time.
const TWO_STEP_IDS = [66101, 66102];
const ONE_STEP_IDS = [66201];
const COMMITTEE_STEP_IDS = [66301];
const TECH_STEP_IDS = [66401];
const ALL_STEP_IDS = [...TWO_STEP_IDS, ...ONE_STEP_IDS, ...COMMITTEE_STEP_IDS, ...TECH_STEP_IDS];

let ARC_READ_ID;
let ARC_APPROVE_ID;
let COMMITTEE_READ_ID;
let COMMITTEE_APPROVE_ID;
let TECH_READ_ID;
let TECH_APPROVE_ID;
let CONTROL_ROLE_ID;          // permissions never touched — the untouched witness
let createdRoleIds = [];      // per-test custom roles, torn down in afterEach
let createdInstanceIds = [];
let nextEntityId = 8600001;

async function ensurePermission(resource, action) {
  const existing = await db.oneOrNone(
    `SELECT id FROM tbl_permissions WHERE resource = $1 AND action = $2`,
    [resource, action]
  );
  if (existing) return existing.id;
  const ins = await db.one(
    `INSERT INTO tbl_permissions (resource, action) VALUES ($1, $2) RETURNING id`,
    [resource, action]
  );
  return ins.id;
}

/** Create a custom role through the real admin endpoint and track it for teardown. */
async function createRoleViaApi(client, title, permissionIds) {
  const res = await client.post("/api/v1/rbac/roles").send({
    title,
    description: "role-permission revocation suite",
    permission_ids: permissionIds,
  });
  expect([200, 201]).toContain(res.status);
  const roleId = res.body?.data?.role_id;
  expect(roleId).toBeTruthy();
  createdRoleIds.push(roleId);
  return roleId;
}

/** The payload the role-editor UI PUTs. It does NOT send confirmed_approval_impact. */
async function updateRoleViaApi(client, roleId, permissionIds, title = "Suite Role") {
  return client.put(`/api/v1/rbac/roles/${roleId}`).send({
    title,
    description: "role-permission revocation suite",
    permission_ids: permissionIds,
  });
}

async function grantRole(userId, roleId) {
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
     VALUES ($1, $2, $3, NULL, $4, NULL)`,
    [userId, roleId, IDS.hospitality.A, IDS.departments.proc]
  );
}

async function insertPolicySteps(policyId, rows) {
  for (const [id, order, sourceType, sourceId] of rows) {
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (id, approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, $2, $3, 'ALL', $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [id, policyId, order, sourceType, sourceId]
    );
  }
}

/** Build a PENDING approval instance through the production creator. */
async function makeInstance(policyId, hotelId, entityType = "ARC") {
  const entityId = nextEntityId++;
  const res = await createApprovalInstance({
    entity_type: entityType,
    entity_id: entityId,
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: hotelId,
    department_id: IDS.departments.proc,
    process_id: null,
    approval_policy_id: policyId,
    initiated_by: ADMIN_ID, // never an approver here, so nothing auto-approves
    metadata: { arc_number: `ARC-PERM-${entityId}` },
  });
  createdInstanceIds.push(res.instance.id);
  return res.instance;
}

async function stepsOf(instanceId) {
  return db.any(
    `SELECT id, step_order, status, removed_mid_flight, completed_at
       FROM tbl_approval_instance_steps
      WHERE approval_instance_id = $1
      ORDER BY step_order ASC`,
    [instanceId]
  );
}

async function approverStatusAt(instanceId, stepOrder, userId) {
  const row = await db.oneOrNone(
    `SELECT asa.status, asa.removal_reason
       FROM tbl_approval_step_approvers asa
       JOIN tbl_approval_instance_steps ais ON ais.id = asa.approval_instance_step_id
      WHERE ais.approval_instance_id = $1
        AND ais.step_order = $2
        AND asa.approver_user_id = $3`,
    [instanceId, stepOrder, userId]
  );
  return row || {};
}

async function auditTrail(instanceId) {
  return db.any(
    `SELECT aa.action, aa.approver_user_id, ais.step_order
       FROM tbl_approval_actions aa
       LEFT JOIN tbl_approval_instance_steps ais ON ais.id = aa.approval_instance_step_id
      WHERE aa.approval_instance_id = $1
      ORDER BY aa.id ASC`,
    [instanceId]
  );
}

async function instanceRow(instanceId) {
  return db.one(
    `SELECT status, current_step, completed_at FROM tbl_approval_instances WHERE id = $1`,
    [instanceId]
  );
}

async function permissionKeysOf(roleId) {
  const rows = await db.any(
    `SELECT p.resource, p.action
       FROM tbl_role_permissions rp
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1`,
    [roleId]
  );
  return rows.map((r) => `${r.resource}.${r.action}`).sort();
}

beforeAll(async () => {
  // Permission CATALOGUE rows (product data, shipped by migration 20260608100800;
  // the test DB's dump predates it). Admins pick from the catalogue — the role
  // and its grants below are created only through the HTTP API.
  ARC_READ_ID = await ensurePermission("arc", "read");
  ARC_APPROVE_ID = await ensurePermission("arc", "approve");
  // 'arc-committee' read + approve — seeded together by the same migration
  // (20260608100800:56-57). Re-created here because the test DB's catalogue is a
  // pg_dump that PREDATES that migration (it holds only 34 rows, up to
  // 'arc.approve'), which is also why `arc-tech` cannot be checked empirically
  // here; the migrations/ tree is the authority for what production carries.
  COMMITTEE_READ_ID = await ensurePermission("arc-committee", "read");
  COMMITTEE_APPROVE_ID = await ensurePermission("arc-committee", "approve");
  // 'arc-tech' read (20260611100000) + approve (20260803110000). Both exist in
  // the reference seed now, so these resolve rather than insert.
  TECH_READ_ID = await ensurePermission("arc-tech", "read");
  TECH_APPROVE_ID = await ensurePermission("arc-tech", "approve");

  await db.none(
    `INSERT INTO tbl_users (id, name, email, mobile, password, user_type, status, company_id)
     VALUES ($1, 'Role Perm Admin',   'roleperm.admin@test.local',   '9000086001', 'x', 7, 1, $4),
            ($2, 'Role Perm Target',  'roleperm.target@test.local',  '9000086002', 'x', 2, 1, $4),
            ($3, 'Role Perm Control', 'roleperm.control@test.local', '9000086003', 'x', 2, 1, $4)
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_ID, TARGET_ID, CO_ID, IDS.companies.A]
  );
  // acl([7, 2]) on PUT/POST /rbac/roles gates on user_type.
  await db.none(`UPDATE tbl_users SET user_type = 7, status = 1 WHERE id = $1`, [ADMIN_ID]);

  // resolveApprovers joins tbl_hospitality_user_mappings; without a mapping the
  // ROLE step would resolve to zero approvers and be dropped at creation,
  // making every test below pass vacuously.
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
     VALUES ($1, $4, NULL, 0),
            ($2, $4, $5, 1), ($2, $4, $6, 1),
            ($3, $4, $5, 1), ($3, $4, $6, 1)
     ON CONFLICT DO NOTHING`,
    [ADMIN_ID, TARGET_ID, CO_ID, IDS.hospitality.A, IDS.hotels.A2, IDS.hotels.A3]
  );

  await db.none(
    `INSERT INTO tbl_user_department (user_id, department_id) VALUES ($1, $3), ($2, $3)
     ON CONFLICT DO NOTHING`,
    [TARGET_ID, CO_ID, IDS.departments.proc]
  );

  // Idempotent reset for a run killed before afterAll.
  await db.none(
    `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
       SELECT ais.id FROM tbl_approval_instance_steps ais
       JOIN tbl_approval_instances ai ON ai.id = ais.approval_instance_id
       WHERE ai.approval_policy_id = ANY($1::int[]))`,
    [ALL_POLICIES]
  );
  await db.none(
    `DELETE FROM tbl_approval_actions WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances WHERE approval_policy_id = ANY($1::int[]))`,
    [ALL_POLICIES]
  );
  await db.none(
    `DELETE FROM tbl_approval_instance_change_log WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances WHERE approval_policy_id = ANY($1::int[]))`,
    [ALL_POLICIES]
  );
  await db.none(
    `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances WHERE approval_policy_id = ANY($1::int[]))`,
    [ALL_POLICIES]
  );
  await db.none(`DELETE FROM tbl_approval_instances WHERE approval_policy_id = ANY($1::int[])`, [ALL_POLICIES]);
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [ALL_POLICIES]);

  const policySpecs = [
    [TWO_STEP_POLICY, IDS.hotels.A2, IDS.departments.eng, "ARC"],
    [ONE_STEP_POLICY, IDS.hotels.A3, IDS.departments.eng, "ARC"],
    [COMMITTEE_POLICY, IDS.hotels.A2, IDS.departments.fb, "ARC_COMMITTEE"],
    [TECH_POLICY, IDS.hotels.A3, IDS.departments.fb, "ARC_TECH"],
  ];
  for (const [policyId, hotelId, deptId, entityType] of policySpecs) {
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id, process_id, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, NULL, true, $6)
       ON CONFLICT (id) DO NOTHING`,
      [policyId, entityType, IDS.hospitality.A, hotelId, deptId, ADMIN_ID]
    );
  }

  // The CONTROL role is created once, through the API, and its permissions are
  // never edited. It backs step 2 of every two-step instance and is the witness
  // for "a role that kept both permissions is left completely untouched".
  const client = await httpClient(ADMIN_ID);
  const res = await client.post("/api/v1/rbac/roles").send({
    title: "Role Perm Control",
    description: "keeps arc.read + arc.approve throughout",
    permission_ids: [ARC_READ_ID, ARC_APPROVE_ID],
  });
  expect([200, 201]).toContain(res.status);
  CONTROL_ROLE_ID = res.body?.data?.role_id;
  expect(CONTROL_ROLE_ID).toBeTruthy();
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [CO_ID]);
  await grantRole(CO_ID, CONTROL_ROLE_ID);
});

afterEach(async () => {
  if (createdInstanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [createdInstanceIds]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [createdInstanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [createdInstanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_change_log WHERE approval_instance_id = ANY($1::int[])`, [createdInstanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [createdInstanceIds]);
    createdInstanceIds = [];
  }
  await db.none(`DELETE FROM tbl_approval_policy_change_log WHERE changed_by = $1`, [ADMIN_ID]);
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE id = ANY($1::int[])`, [ALL_STEP_IDS]);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [TARGET_ID]);
  if (createdRoleIds.length) {
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = ANY($1::int[])`, [createdRoleIds]);
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = ANY($1::int[])`, [createdRoleIds]);
    await db.none(`DELETE FROM tbl_roles WHERE id = ANY($1::int[])`, [createdRoleIds]);
    createdRoleIds = [];
  }
});

afterAll(async () => {
  // An instance the retirement auto-completes runs handleAutoCompletedInstances
  // post-commit, which records a lifecycle event attributed to the admin.
  // tbl_lifecycle_history.performed_by FKs to tbl_users, so it has to go first.
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE performed_by = ANY($1::int[])`, [[ADMIN_ID, TARGET_ID, CO_ID]]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [ALL_POLICIES]);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [[TARGET_ID, CO_ID]]);
  await db.none(`DELETE FROM tbl_user_department WHERE user_id = ANY($1::int[])`, [[TARGET_ID, CO_ID]]);
  if (CONTROL_ROLE_ID) {
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [CONTROL_ROLE_ID]);
    await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [CONTROL_ROLE_ID]);
  }
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [[ADMIN_ID, TARGET_ID, CO_ID]]);
  await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [[ADMIN_ID, TARGET_ID, CO_ID]]);
});

/**
 * Standard arrangement: a role with arc.read + arc.approve, granted to TARGET,
 * backing step 1 of a two-step ARC policy whose step 2 is the CONTROL role.
 * The instance is built by the production creator, so the creation-time gate
 * demonstrably passed before anything is revoked.
 */
async function arrangeTwoStep(client) {
  const roleId = await createRoleViaApi(client, "Role Perm Subject", [ARC_READ_ID, ARC_APPROVE_ID]);
  await grantRole(TARGET_ID, roleId);
  await insertPolicySteps(TWO_STEP_POLICY, [
    [TWO_STEP_IDS[0], 1, "ROLE", roleId],
    [TWO_STEP_IDS[1], 2, "ROLE", CONTROL_ROLE_ID],
  ]);
  const instance = await makeInstance(TWO_STEP_POLICY, IDS.hotels.A2);

  // Precondition: the gate PASSED at creation. Both ROLE steps exist and both
  // approvers are live. Without this the suite could pass vacuously.
  const steps = await stepsOf(instance.id);
  expect(steps.map((s) => [s.step_order, s.status])).toEqual([[1, "PENDING"], [2, "PENDING"]]);
  expect((await approverStatusAt(instance.id, 1, TARGET_ID)).status).toBe("PENDING");
  expect((await approverStatusAt(instance.id, 2, CO_ID)).status).toBe("PENDING");

  return { roleId, instance };
}

describe("stripping a permission from a role revokes the approvals it backs", () => {
  it("kills the live approver row when the role loses arc.approve", async () => {
    const client = await httpClient(ADMIN_ID);
    const { roleId, instance } = await arrangeTwoStep(client);

    // The revocation: keep arc.read, drop arc.approve. The role-editor UI sends
    // no confirmation flag, so this must NOT be gated behind one.
    const res = await updateRoleViaApi(client, roleId, [ARC_READ_ID]);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(await permissionKeysOf(roleId)).toEqual(["arc.read"]);

    // Red before the fix: the snapshot row stayed PENDING, and PENDING is the
    // whole of what submitApprovalAction checks.
    const approver = await approverStatusAt(instance.id, 1, TARGET_ID);
    expect(approver.status).toBe("REMOVED");
    expect(approver.removal_reason).toBe("role_permissions_changed");
  });

  it("fires on losing arc.read too, not only arc.approve", async () => {
    // The creation-time gate demands BOTH. A role that can approve but cannot
    // read the entity is exactly as disqualified — mirror that here rather than
    // special-casing the `approve` verb.
    const client = await httpClient(ADMIN_ID);
    const { roleId, instance } = await arrangeTwoStep(client);

    const res = await updateRoleViaApi(client, roleId, [ARC_APPROVE_ID]);
    expect(res.status).toBe(200);
    expect(await permissionKeysOf(roleId)).toEqual(["arc.approve"]);

    expect((await approverStatusAt(instance.id, 1, TARGET_ID)).status).toBe("REMOVED");
  });

  it("records STEP_REMOVED, never an APPROVE nobody granted", async () => {
    const client = await httpClient(ADMIN_ID);
    const { roleId, instance } = await arrangeTwoStep(client);

    expect((await updateRoleViaApi(client, roleId, [ARC_READ_ID])).status).toBe(200);

    const steps = await stepsOf(instance.id);
    const step1 = steps.find((s) => s.step_order === 1);

    // THE DECISION, pinned. Marking only the approvers REMOVED would let
    // reEvaluateInstanceStep auto-complete this step as 'APPROVED' — a step
    // recorded as approved with zero approval actions behind it, which reads to
    // every downstream query, and to an auditor, exactly like a real approval.
    // The step is retired instead, the way applyDiffToInstance retires a policy
    // step that ceased to exist.
    expect(step1.status).toBe("REMOVED");
    expect(step1.removed_mid_flight).toBe(true);

    const trail = await auditTrail(instance.id);
    const onStep1 = trail.filter((a) => a.step_order === 1);
    expect(onStep1.map((a) => a.action)).toEqual(["STEP_REMOVED"]);
    expect(onStep1[0].approver_user_id).toBe(ADMIN_ID); // attributed to the admin who did it

    // The claim that matters: nowhere in this instance's history does an
    // approval appear that nobody performed.
    expect(trail.filter((a) => a.action === "APPROVE")).toEqual([]);

    // And the instance advanced past the dead step rather than completing.
    const inst = await instanceRow(instance.id);
    expect(inst.status).toBe("PENDING");
    expect(inst.current_step).toBe(2);
  });

  it("leaves the step backed by a role that kept both permissions completely untouched", async () => {
    // The regression that matters most: a permission edit must not produce
    // collateral removals anywhere else in the instance.
    const client = await httpClient(ADMIN_ID);
    const { roleId, instance } = await arrangeTwoStep(client);

    expect((await updateRoleViaApi(client, roleId, [ARC_READ_ID])).status).toBe(200);

    const steps = await stepsOf(instance.id);
    const step2 = steps.find((s) => s.step_order === 2);
    expect(step2.status).toBe("PENDING");
    expect(step2.removed_mid_flight).toBe(false);
    expect(step2.completed_at).toBeNull();

    const co = await approverStatusAt(instance.id, 2, CO_ID);
    expect(co.status).toBe("PENDING");
    expect(co.removal_reason).toBeNull();

    const trail = await auditTrail(instance.id);
    expect(trail.filter((a) => a.step_order === 2)).toEqual([]);
  });

  it("is a total no-op when the role keeps read+approve", async () => {
    const client = await httpClient(ADMIN_ID);
    const { roleId, instance } = await arrangeTwoStep(client);

    // A rename plus a permission ADD — the everyday edit. Nothing about the
    // approval may move.
    const res = await updateRoleViaApi(client, roleId, [ARC_READ_ID, ARC_APPROVE_ID], "Role Perm Subject Renamed");
    expect(res.status).toBe(200);
    expect(await permissionKeysOf(roleId)).toEqual(["arc.approve", "arc.read"]);

    const steps = await stepsOf(instance.id);
    expect(steps.map((s) => [s.step_order, s.status])).toEqual([[1, "PENDING"], [2, "PENDING"]]);
    expect((await approverStatusAt(instance.id, 1, TARGET_ID)).status).toBe("PENDING");
    expect((await approverStatusAt(instance.id, 2, CO_ID)).status).toBe("PENDING");
    expect(await auditTrail(instance.id)).toEqual([]);

    const inst = await instanceRow(instance.id);
    expect(inst.status).toBe("PENDING");
    expect(inst.current_step).toBe(1);

    // No change-log noise either — an untouched instance must not appear to
    // have been reconciled.
    const changeLog = await db.any(
      `SELECT id FROM tbl_approval_instance_change_log WHERE approval_instance_id = $1`,
      [instance.id]
    );
    expect(changeLog).toEqual([]);
  });

  it("completes the instance when the retired step was the only one, and says so in the trail", async () => {
    const client = await httpClient(ADMIN_ID);
    const roleId = await createRoleViaApi(client, "Role Perm Solo", [ARC_READ_ID, ARC_APPROVE_ID]);
    await grantRole(TARGET_ID, roleId);
    await insertPolicySteps(ONE_STEP_POLICY, [[ONE_STEP_IDS[0], 1, "ROLE", roleId]]);
    const instance = await makeInstance(ONE_STEP_POLICY, IDS.hotels.A3);
    expect((await approverStatusAt(instance.id, 1, TARGET_ID)).status).toBe("PENDING");

    expect((await updateRoleViaApi(client, roleId, [ARC_READ_ID])).status).toBe(200);

    const inst = await instanceRow(instance.id);
    expect(inst.status).toBe("APPROVED"); // no steps left to collect — the engine's existing semantics
    expect(inst.completed_at).not.toBeNull();

    // But the reason it completed is legible: the only step is REMOVED, and the
    // sole audit row is STEP_REMOVED. Nothing in this instance claims anyone
    // approved anything.
    const steps = await stepsOf(instance.id);
    expect(steps.map((s) => [s.step_order, s.status])).toEqual([[1, "REMOVED"]]);
    expect((await auditTrail(instance.id)).map((a) => a.action)).toEqual(["STEP_REMOVED"]);

    // And the reconciliation is countable rather than invisible.
    const changeLog = await db.any(
      `SELECT change_summary FROM tbl_approval_instance_change_log WHERE approval_instance_id = $1`,
      [instance.id]
    );
    expect(changeLog).toHaveLength(1);
    const summary = typeof changeLog[0].change_summary === "string"
      ? JSON.parse(changeLog[0].change_summary)
      : changeLog[0].change_summary;
    expect(summary.reason).toBe("role_permissions_changed");
    expect(summary.role_id).toBe(roleId);
    expect(summary.steps_removed).toHaveLength(1);
    expect(summary.approvers_removed.map((a) => a.user_id)).toEqual([TARGET_ID]);
  });
});

/**
 * ENTITY_APPROVE_RESOURCE_MAP holes are not a cosmetic gap.
 *
 * `tbl_permissions.resource` is the `resource_type` ENUM. An unmapped entity
 * type falls back to `entity_type.toLowerCase()`, which produces UNDERSCORES
 * (`arc_committee`) while the enum members use HYPHENS (`arc-committee`). So
 * `roleHasReadAndApprovePermission`'s `p.resource = $2` does not return false —
 * Postgres raises `invalid input value for enum resource_type` and the whole
 * createApprovalInstance call fails. The comment that used to sit on that map
 * claimed those approvers were "silently dropped"; they were not, and the
 * distinction decides what the right fix is.
 */
describe("ARC entity types resolve against the right permission resource", () => {
  it("creates an ARC_COMMITTEE instance with a ROLE step, gated on arc-committee", async () => {
    // Before the mapping this threw on the enum cast; the step is now gated on
    // 'arc-committee', which carries BOTH read and approve.
    expect(ENTITY_APPROVE_RESOURCE_MAP.ARC_COMMITTEE).toBe("arc-committee");

    const client = await httpClient(ADMIN_ID);
    const roleId = await createRoleViaApi(client, "Role Perm Committee", [COMMITTEE_READ_ID, COMMITTEE_APPROVE_ID]);
    await grantRole(TARGET_ID, roleId);
    await insertPolicySteps(COMMITTEE_POLICY, [[COMMITTEE_STEP_IDS[0], 1, "ROLE", roleId]]);

    const instance = await makeInstance(COMMITTEE_POLICY, IDS.hotels.A2, "ARC_COMMITTEE");

    // It gated on 'arc-committee' rather than falling back: the role holds only
    // arc-committee.read/approve and nothing named 'arc_committee' exists, so a
    // surviving step proves which resource was consulted.
    expect((await approverStatusAt(instance.id, 1, TARGET_ID)).status).toBe("PENDING");

    // And the mid-flight gate agrees with the creation gate on the same resource.
    const verdict = await roleStepPermissionVerdict(roleId, "ARC_COMMITTEE", db);
    expect(verdict).toMatchObject({ permitted: true, resource: "arc-committee", reason: "OK" });

    // Revocation still reaches it — the whole point of mapping it correctly.
    expect((await updateRoleViaApi(client, roleId, [COMMITTEE_READ_ID])).status).toBe(200);
    expect((await approverStatusAt(instance.id, 1, TARGET_ID)).status).toBe("REMOVED");
  });

  it("now maps ARC_TECH to arc-tech, and the reconciler judges it on that resource", async () => {
    // THE PRODUCT DECISION THIS TEST USED TO WAIT FOR HAS BEEN MADE.
    // The previous version of this case asserted `ARC_TECH` was deliberately
    // UNMAPPED, because 'arc-tech' had no `approve` row and mapping it would
    // have turned a loud crash into a silent step-skip. It said in as many words
    // that it should fail and be rewritten once the decision landed.
    //
    // It landed: migration 20260803110000 seeds `arc-tech.approve` and the
    // system role 'ARC Technical Approver' (arc-tech.read + arc-tech.approve),
    // mirroring RFQ's role 7 'Technical Approver'. So the resource is now
    // complete and the mapping is safe — see arc.approvers.stageRoles.test.js
    // for the end-to-end ROLE path.
    expect(ENTITY_APPROVE_RESOURCE_MAP.ARC_TECH).toBe("arc-tech");

    const client = await httpClient(ADMIN_ID);
    // A role holding arc.read + arc.approve is the WRONG resource for ARC_TECH:
    // the verdict must judge it against 'arc-tech', where it holds nothing.
    const wrongResourceRole = await createRoleViaApi(client, "Role Perm Tech Wrong", [ARC_READ_ID, ARC_APPROVE_ID]);
    expect(await roleStepPermissionVerdict(wrongResourceRole, "ARC_TECH", db)).toEqual({
      permitted: false,
      resource: "arc-tech",
      reason: "MISSING_READ_OR_APPROVE",
    });

    // Now the full round trip, to the same depth as the ARC_COMMITTEE case
    // above: create → live PENDING approver → revoke → step REMOVED. Anything
    // shallower proves the map entry but not that the pair of gates agrees on it.
    const roleId = await createRoleViaApi(client, "Role Perm Tech", [TECH_READ_ID, TECH_APPROVE_ID]);
    await grantRole(TARGET_ID, roleId);
    await insertPolicySteps(TECH_POLICY, [[TECH_STEP_IDS[0], 1, "ROLE", roleId]]);

    const instance = await makeInstance(TECH_POLICY, IDS.hotels.A3, "ARC_TECH");

    // It gated on 'arc-tech' rather than falling back: the role holds ONLY
    // arc-tech.read/approve, and nothing named 'arc_tech' exists in the enum at
    // all — under the old uncast comparison this call RAISED rather than
    // producing a step. A surviving PENDING approver proves both.
    expect((await approverStatusAt(instance.id, 1, TARGET_ID)).status).toBe("PENDING");
    expect(await roleStepPermissionVerdict(roleId, "ARC_TECH", db)).toMatchObject({
      permitted: true,
      resource: "arc-tech",
      reason: "OK",
    });

    // Revocation reaches it — creation gate and reconciliation gate agree.
    expect((await updateRoleViaApi(client, roleId, [TECH_READ_ID])).status).toBe(200);
    expect((await approverStatusAt(instance.id, 1, TARGET_ID)).status).toBe("REMOVED");

    const steps = await stepsOf(instance.id);
    expect(steps.map((s) => [s.step_order, s.status])).toEqual([[1, "REMOVED"]]);
    expect((await auditTrail(instance.id)).map((a) => a.action)).toEqual(["STEP_REMOVED"]);

    // The defensive `::text` catalogue probe still protects genuinely unmapped
    // types: it never reaches the enum comparison, so it cannot throw, and it
    // declines to retire a live step on the strength of a map hole.
    const unknown = await roleStepPermissionVerdict(roleId, "SOME_NEW_ENTITY", db);
    expect(unknown).toEqual({
      permitted: true,
      resource: "some_new_entity",
      reason: "RESOURCE_NOT_IN_CATALOGUE",
    });
  });
});

describe("the permission replace is atomic", () => {
  it("never exposes a state where the role holds zero permissions", async () => {
    // The window: deleteRolePermissions ran on the root db, then
    // assignPermissionsToRole opened its OWN db.tx. Between the two commits any
    // concurrent createApprovalInstance sees a role with no permissions, fails
    // roleHasReadAndApprovePermission (generalModel.js:2237) and silently drops
    // that role's step — permanently, because instance steps are a snapshot and
    // nothing ever rebuilds them.
    //
    // Sampled from a SEPARATE connection while the PUT is in flight, so it
    // observes only committed states. Under the old two-transaction shape the
    // empty state is committed and therefore visible; under one transaction it
    // cannot be.
    const client = await httpClient(ADMIN_ID);
    const roleId = await createRoleViaApi(client, "Role Perm Atomic", [ARC_READ_ID, ARC_APPROVE_ID]);

    let sampling = true;
    const observed = [];
    const sampler = (async () => {
      // Bounded so a slow request cannot turn this into an unbounded hammer.
      for (let i = 0; sampling && i < 4000; i++) {
        const row = await db.one(
          `SELECT count(*)::int AS n FROM tbl_role_permissions WHERE role_id = $1`,
          [roleId]
        );
        observed.push(row.n);
      }
    })();

    const res = await updateRoleViaApi(client, roleId, [ARC_READ_ID, ARC_APPROVE_ID]);
    sampling = false;
    await sampler;

    expect(res.status).toBe(200);
    expect(observed.length).toBeGreaterThan(0);
    // This is opportunistic — it can only ever catch the window if a sample
    // lands inside it. The deterministic proof is the next test, which turns
    // the window into a permanent state and then asserts it cannot happen.
    expect(observed).not.toContain(0);
    expect(await permissionKeysOf(roleId)).toEqual(["arc.approve", "arc.read"]);
  });

  it("rolls the DELETE back with a failing INSERT instead of stranding the role at zero permissions", async () => {
    // The window, made permanent and therefore deterministic. Under the old
    // two-transaction shape `deleteRolePermissions` COMMITS on its own; if the
    // following `assignPermissionsToRole` then fails, the role is left holding
    // NOTHING — the transient window frozen forever, and every subsequent
    // createApprovalInstance silently drops this role's step.
    //
    // The failure is forced with a permission id outside int4 range, so the
    // INSERT (not the request handling) is what breaks, mid-replace.
    const client = await httpClient(ADMIN_ID);
    const roleId = await createRoleViaApi(client, "Role Perm Rollback", [ARC_READ_ID, ARC_APPROVE_ID]);

    const res = await updateRoleViaApi(client, roleId, [ARC_READ_ID, 9999999999]);
    expect(res.status).toBe(500);

    // One transaction: the DELETE went back with the INSERT and the role still
    // holds exactly what it held before the failed edit.
    expect(await permissionKeysOf(roleId)).toEqual(["arc.approve", "arc.read"]);
  });
});
