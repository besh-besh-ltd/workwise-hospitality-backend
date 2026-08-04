/**
 * Hardening: two "missing authority" gaps where a user who NEWLY qualifies as
 * an approver (via resolveApprovers()'s INNER JOIN on
 * tbl_hospitality_user_mappings, generalModel.js:~2022/2038) was never added
 * to live PENDING approval instances snapshotted before the grant existed.
 *
 * Both paths reuse the existing exported
 * app/services/approvalPropagationService.js#revalidateApproverMembership —
 * neither this test file nor the production code it exercises touches
 * approvalPropagationService.js, rbac/rbacController.js, rbac/rbacModel.js or
 * routes/rbac/ (owned by a concurrent branch).
 *
 * 1. hospitalityController.mapUsers (POST
 *    /api/v1/hospitality/company/:company_id/map-users) — its mirror,
 *    deleteUserMapping, already ran simulateApproverImpact +
 *    revalidateApproverMembership on the REMOVE direction; mapUsers had none
 *    of it on the ADD direction. A user already holding a matching ROLE scope
 *    but not yet mapped into the hospitality company/hotel could not resolve
 *    as an approver until mapped — mapping them should retroactively add them
 *    to any live PENDING instance they now qualify for.
 *
 * 2. usersController.create_buyer_company_users (POST
 *    /api/v1/users/create-buyer-company-user) — wrote tbl_user_role_scopes
 *    and tbl_hospitality_user_mappings for a brand-new user with no
 *    propagation at all. Also closes an ACL gap: the route had no acl(...)
 *    gate and the controller had no user_type check (contrast
 *    update_user_detail's `loggedInUser.user_type === 7`), so ANY
 *    authenticated user of ANY user_type could create buyer-company users and
 *    grant them role scopes. Fixed by adding acl([7]) to the route,
 *    matching every hospitality company-admin route in hospitalityRoutes.js
 *    (all gated acl([7])) and the sibling /company-users-detailed endpoint in
 *    usersRoutes.js.
 *
 * Everything here drives the real HTTP endpoints through the full middleware
 * chain (auth -> acl -> validation -> controller), per tests/CONVENTIONS.md §3.
 *
 * 3. AVAILABILITY (added later): both propagation calls above originally ran
 *    with neither `changedRoleIds` nor `changedDeptIds`, which makes PART 2's
 *    candidate set EVERY PENDING ROLE-/DEPARTMENT-sourced step in the company
 *    — each locked FOR UPDATE and re-resolved before the user is even known to
 *    qualify, once per mapped user, serially, against a 30s frontend timeout.
 *    They now pass the user's own role ids / department memberships (see
 *    approvalPropagationService.js#getApproverSourceScopesForUsers). The three
 *    trailing describes below pin the narrowing from BOTH sides: it must not
 *    drop an add that the sweep would have made (a cheap fix that silently
 *    loses a real approver is worse than the latency it cures), and it must
 *    not add anyone the sweep would not have.
 *
 * PRIVATE ID BLOCK: 83xxx (users / hotels / instances) and 63xxx
 * (policies / policy steps) for this file. 88xxx/68xxx
 * (approvalPropagation.scopedImpact.test.js) and 87xxx/67xxx
 * (approvalPropagation.stepOrderDivergence.test.js) are already taken; 83xxx
 * and 63xxx are grep-confirmed unused as ID blocks anywhere under tests/ at
 * the time this file was written and are chosen to stay clear of whatever
 * range the concurrent approvalPropagationService.js branch claims.
 */

import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";

// ---- Users (83001-83099) ----
const ADMIN_ID = 83001;      // user_type 7 — company admin, calls both endpoints
const NON_ADMIN_ID = 83002;  // user_type 2 — must be rejected by the new acl([7]) gate
const TARGET_ID = 83003;     // has a matching role scope but starts UNMAPPED
// NOROLE_ID is numbered and inserted BETWEEN the two qualifying users on
// purpose. mapUsers does not iterate the request's user_ids — it iterates
// hospitalityModel.filterUsersByCompany's result, which has no ORDER BY — so
// the only way to guarantee the skipped user is processed before a qualifying
// one is to place it before TARGET2 in the fixture INSERT below. Without that,
// a skip implemented as `break` instead of `continue` (silently dropping the
// rest of the batch) passes the multi-user test.
const NOROLE_ID = 83004;     // NO role scopes and NO departments — must be skipped
const TARGET2_ID = 83005;    // same role scope as TARGET — multi-user batch
const DEPT_TARGET_ID = 83006; // department member ONLY (no role scope at all)

// ---- Hotels under IDS.hospitality.A (83101-83199) ----
const HOTEL_MAP = 83101;    // scenario 1: mapUsers
const HOTEL_CREATE = 83102; // scenario 2: create_buyer_company_users

// ---- Policies / policy steps (63001-63199) ----
const POLICY_MAP = 63001;
const STEP_MAP = 63101;
const POLICY_CREATE = 63002;
const STEP_CREATE = 63102;
const POLICY_WRONGROLE = 63003; // ROLE step sourced from a role TARGET does NOT hold
const STEP_WRONGROLE = 63103;
const POLICY_DEPT = 63004;      // DEPARTMENT-sourced step
const STEP_DEPT = 63104;

// ---- Instances (83201-83299), created per-test ----
const INSTANCE_MAP = 83201;
const INSTANCE_CREATE = 83202;
const INSTANCE_WRONGROLE = 83203;
const INSTANCE_DEPT = 83204;

// Both scenarios use FINAL_AWARDING_P1 (role 13): revalidateApproverMembership's
// add path (a concurrently-developed RolePermGate in
// approvalPropagationService.js, see roleStepPermissionVerdict) will silently
// skip adding a ROLE-sourced approver whose role lacks BOTH
// awarding.read AND awarding.approve for entity_type 'PO'
// (ENTITY_APPROVE_RESOURCE_MAP['PO'] === 'awarding'). Verified against
// tests/setup/seed_reference.sql's tbl_role_permissions rows: role 13 holds
// both (permission ids 26 and 29); TENDER_APPROVER(4)/COMM_APPROVER(12) do not
// both qualify, which is what surfaced this gate while writing this suite.
const ROLE_MAP_SCOPE = ROLE_IDS.FINAL_AWARDING_P1;    // 13
const ROLE_CREATE_SCOPE = ROLE_IDS.FINAL_AWARDING_P1; // 13

// A role NOBODY in this file is granted. Backs the negative test: the scoped
// propagation must not reach a step sourced from a role the mapped user does
// not hold — and neither did the unscoped sweep, since resolveApprovers'
// ROLE branch hard-equals urs.role_id to the step's approver_source_id.
const ROLE_NOT_HELD = ROLE_IDS.COMM_APPROVER;         // 12

// DEPARTMENT-sourced steps resolve through tbl_user_department (membership),
// NOT through tbl_user_role_scopes.department_id (a role grant's scope). The
// narrowing reads the former; this fixture proves it, by giving DEPT_TARGET_ID
// a department membership and no role scope whatsoever.
const DEPT_SOURCE = IDS.departments.proc;

// Test-only emails/mobiles — cleaned up in afterAll AND pre-cleaned in
// beforeAll so a re-run against a database left dirty by a crashed prior run
// (same TEST_RUN_ID) doesn't collide on tbl_users' unique email/mobile.
const CREATE_EMAIL = "gapb.create.newuser@test.local";
const CREATE_MOBILE = "9830000101";
const ACL_OK_EMAIL = "gapb.acl.ok@test.local";
const ACL_OK_MOBILE = "9830000102";
const ACL_REJECT_EMAIL = "gapb.acl.reject@test.local";
const ACL_REJECT_MOBILE = "9830000103";

let createdInstanceIds = [];
let createdUserIds = []; // dynamically-created users from create-buyer-company-user

async function insertPendingInstance({ instanceId, policyId, stepId, hotelId, poNumber }) {
  createdInstanceIds.push(instanceId);
  await db.none(
    `INSERT INTO tbl_approval_instances
       (id, entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, metadata)
     VALUES ($1, 'PO', $2, $3, 'PENDING', 1, $4, $5, NULL, $6, $7::jsonb)`,
    [instanceId, 900000 + instanceId, policyId, IDS.hospitality.A, hotelId, ADMIN_ID,
      JSON.stringify({ po_number: poNumber })]
  );
  // Instance-step id is derived from the INSTANCE id, not the policy-step id.
  // Same +900000 offset convention as the entity_id above, but keyed on the
  // thing that is unique per row: a test that stands two instances up against
  // the SAME policy step (the multi-user batch does) would otherwise collide on
  // this primary key.
  await db.none(
    `INSERT INTO tbl_approval_instance_steps
       (id, approval_instance_id, policy_step_id, step_order, decision_rule, status)
     VALUES ($1, $2, $3, 1, 'ANY', 'PENDING')`,
    [instanceId + 900000, instanceId, stepId]
  );
}

async function approverRowFor(instanceId, userId) {
  return db.oneOrNone(
    `SELECT asa.status, asa.added_mid_flight
       FROM tbl_approval_step_approvers asa
       JOIN tbl_approval_instance_steps ais ON ais.id = asa.approval_instance_step_id
      WHERE ais.approval_instance_id = $1 AND asa.approver_user_id = $2`,
    [instanceId, userId]
  );
}

beforeAll(async () => {
  // Pre-clean anything a crashed prior run against the same TEST_RUN_ID DB
  // might have left behind, keyed by the fixed test emails/mobiles above.
  await db.none(
    `DELETE FROM tbl_users WHERE email = ANY($1::text[]) OR mobile = ANY($2::text[])`,
    [[CREATE_EMAIL, ACL_OK_EMAIL, ACL_REJECT_EMAIL], [CREATE_MOBILE, ACL_OK_MOBILE, ACL_REJECT_MOBILE]]
  );

  await db.none(
    `INSERT INTO tbl_users (id, name, email, mobile, password, user_type, status, company_id)
     VALUES ($1, 'Gap B Admin',     'gapb.admin@test.local',     '9830000001', 'x', 7, 1, $7),
            ($2, 'Gap B Non-Admin', 'gapb.nonadmin@test.local',  '9830000002', 'x', 2, 1, $7),
            ($3, 'Gap B Target',    'gapb.target@test.local',    '9830000003', 'x', 2, 1, $7),
            ($4, 'Gap B No Role',   'gapb.norole@test.local',    '9830000004', 'x', 2, 1, $7),
            ($5, 'Gap B Target 2',  'gapb.target2@test.local',   '9830000005', 'x', 2, 1, $7),
            ($6, 'Gap B Dept Only', 'gapb.deptonly@test.local',  '9830000006', 'x', 2, 1, $7)
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_ID, NON_ADMIN_ID, TARGET_ID, NOROLE_ID, TARGET2_ID, DEPT_TARGET_ID, IDS.companies.A]
  );

  await db.none(
    `INSERT INTO tbl_hospitality_company_hotels (id, hospitality_company_id, name)
     VALUES ($1, $3, 'Gap B Hotel (map-users)'), ($2, $3, 'Gap B Hotel (create-user)')
     ON CONFLICT (id) DO NOTHING`,
    [HOTEL_MAP, HOTEL_CREATE, IDS.hospitality.A]
  );

  // TARGET already holds the role scope resolveApprovers() checks — but is
  // deliberately NOT mapped into tbl_hospitality_user_mappings yet, so
  // resolveApprovers' INNER JOIN excludes them until the mapUsers test maps
  // them in.
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
     VALUES ($1, $3, $4, $5, NULL, NULL),
            ($2, $3, $4, $5, NULL, NULL)
     ON CONFLICT DO NOTHING`,
    [TARGET_ID, TARGET2_ID, ROLE_MAP_SCOPE, IDS.hospitality.A, HOTEL_MAP]
  );

  // DEPT_TARGET_ID gets a department MEMBERSHIP and deliberately NO row in
  // tbl_user_role_scopes — the only thing that can make them resolve is the
  // DEPARTMENT branch of resolveApprovers.
  await db.none(
    `INSERT INTO tbl_user_department (user_id, department_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [DEPT_TARGET_ID, DEPT_SOURCE]
  );
  // NOROLE_ID gets neither. Nothing to insert — stated here so its emptiness
  // reads as a fixture decision rather than an omission.

  // The three HOTEL_MAP policies must differ on the policy's own department_id:
  // uq_approval_policy_scope_process is UNIQUE on
  // (entity_type, hospitality_company_id, hotel_id, department_id, process_id)
  // WHERE is_active. That scope column is inert for these tests — every
  // instance below is inserted with department_id NULL, and resolveApprovers is
  // handed the INSTANCE's department_id (`resolveDeptId = row.department_id`),
  // never the policy's. Keeping them on the SAME hotel is what matters: it
  // leaves the step's approver_source_id as the only thing that can decide
  // whether a mapped user resolves.
  const policies = [
    [POLICY_MAP, HOTEL_MAP, null, STEP_MAP, 'ROLE', ROLE_MAP_SCOPE],
    [POLICY_CREATE, HOTEL_CREATE, null, STEP_CREATE, 'ROLE', ROLE_CREATE_SCOPE],
    [POLICY_WRONGROLE, HOTEL_MAP, IDS.departments.eng, STEP_WRONGROLE, 'ROLE', ROLE_NOT_HELD],
    [POLICY_DEPT, HOTEL_MAP, IDS.departments.fb, STEP_DEPT, 'DEPARTMENT', DEPT_SOURCE],
  ];
  for (const [policyId, hotelId, policyDeptId, stepId, sourceType, sourceId] of policies) {
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by)
       VALUES ($1, 'PO', $2, $3, $5, true, $4)
       ON CONFLICT (id) DO NOTHING`,
      [policyId, IDS.hospitality.A, hotelId, ADMIN_ID, policyDeptId]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (id, approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, $2, 1, 'ANY', $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [stepId, policyId, sourceType, sourceId]
    );
  }
});

afterEach(async () => {
  if (createdInstanceIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`,
      [createdInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [createdInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_change_log WHERE approval_instance_id = ANY($1::int[])`,
      [createdInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`,
      [createdInstanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [createdInstanceIds]);
    createdInstanceIds = [];
  }

  // Undo the mapUsers tests' mappings so re-running them in the same file stays
  // idempotent (the endpoint itself is ON CONFLICT DO UPDATE, not additive).
  await db.none(
    `DELETE FROM tbl_hospitality_user_mappings
      WHERE user_id = ANY($1::int[]) AND hospitality_company_id = $2 AND hospitality_hotel_id = $3`,
    [[TARGET_ID, TARGET2_ID, NOROLE_ID, DEPT_TARGET_ID], IDS.hospitality.A, HOTEL_MAP]
  );

  if (createdUserIds.length) {
    await db.none(
      `DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`,
      [createdUserIds]
    );
    await db.none(
      `DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`,
      [createdUserIds]
    );
    await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [createdUserIds]);
    createdUserIds = [];
  }
});

afterAll(async () => {
  const ALL_TEST_USERS = [ADMIN_ID, NON_ADMIN_ID, TARGET_ID, TARGET2_ID, NOROLE_ID, DEPT_TARGET_ID];
  await db.none(
    `DELETE FROM tbl_approval_policy_steps WHERE id = ANY($1::int[])`,
    [[STEP_MAP, STEP_CREATE, STEP_WRONGROLE, STEP_DEPT]]
  );
  await db.none(
    `DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`,
    [[POLICY_MAP, POLICY_CREATE, POLICY_WRONGROLE, POLICY_DEPT]]
  );
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [ALL_TEST_USERS]);
  await db.none(`DELETE FROM tbl_user_department WHERE user_id = ANY($1::int[])`, [ALL_TEST_USERS]);
  await db.none(
    `DELETE FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[])`,
    [[HOTEL_MAP, HOTEL_CREATE]]
  );
  await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [ALL_TEST_USERS]);
});

describe("hospitalityController.mapUsers propagates newly-granted authority", () => {
  it("adds a previously-unmapped, already-role-scoped user to a live PENDING instance", async () => {
    await insertPendingInstance({
      instanceId: INSTANCE_MAP,
      policyId: POLICY_MAP,
      stepId: STEP_MAP,
      hotelId: HOTEL_MAP,
      poNumber: "PO-GAPB-MAP-1",
    });

    // Sanity: before mapping, TARGET is not resolvable (INNER JOIN excludes
    // them), so there must be no approver row for them yet.
    expect(await approverRowFor(INSTANCE_MAP, TARGET_ID)).toBeNull();

    const client = await httpClient(ADMIN_ID);
    const res = await client
      .post(`/api/v1/hospitality/company/${IDS.hospitality.A}/map-users`)
      .send({
        mapping_type: 1,
        hotel_id: HOTEL_MAP,
        user_ids: [TARGET_ID],
        auto_map_projects: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    // The mapping itself was written.
    const mapping = await db.oneOrNone(
      `SELECT 1 FROM tbl_hospitality_user_mappings
        WHERE user_id = $1 AND hospitality_company_id = $2 AND hospitality_hotel_id = $3`,
      [TARGET_ID, IDS.hospitality.A, HOTEL_MAP]
    );
    expect(mapping).not.toBeNull();

    // TARGET now resolves as an approver and was added mid-flight as PENDING
    // (they are not the instance's initiator).
    const approverRow = await approverRowFor(INSTANCE_MAP, TARGET_ID);
    expect(approverRow).not.toBeNull();
    expect(approverRow.status).toBe("PENDING");
    expect(approverRow.added_mid_flight).toBe(true);

    const action = await db.oneOrNone(
      `SELECT action FROM tbl_approval_actions
        WHERE approval_instance_id = $1 AND approver_user_id = $2 AND action = 'APPROVER_ADDED'`,
      [INSTANCE_MAP, TARGET_ID]
    );
    expect(action).not.toBeNull();
  });
});

describe("mapUsers propagation stays scoped to sources the user can actually resolve", () => {
  it("adds the user to the step backed by a role they hold, and NOT to one backed by a role they don't", async () => {
    await insertPendingInstance({
      instanceId: INSTANCE_MAP,
      policyId: POLICY_MAP,
      stepId: STEP_MAP,
      hotelId: HOTEL_MAP,
      poNumber: "PO-GAPB-SCOPE-HELD",
    });
    // Same company, same hotel, same entity type, instance department_id NULL
    // like the one above — the only thing that can decide differently is the
    // step's approver_source_id. Under the old unscoped sweep this instance was
    // locked and re-resolved for nothing; under the narrowing it is never a
    // candidate. Either way the user must not end up on it.
    await insertPendingInstance({
      instanceId: INSTANCE_WRONGROLE,
      policyId: POLICY_WRONGROLE,
      stepId: STEP_WRONGROLE,
      hotelId: HOTEL_MAP,
      poNumber: "PO-GAPB-SCOPE-NOTHELD",
    });

    const client = await httpClient(ADMIN_ID);
    const res = await client
      .post(`/api/v1/hospitality/company/${IDS.hospitality.A}/map-users`)
      .send({
        mapping_type: 1,
        hotel_id: HOTEL_MAP,
        user_ids: [TARGET_ID],
        auto_map_projects: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    // Not regressed: the add the narrowing optimises still happens.
    const held = await approverRowFor(INSTANCE_MAP, TARGET_ID);
    expect(held).not.toBeNull();
    expect(held.status).toBe("PENDING");

    // Not widened: no authority granted through a role they do not hold.
    expect(await approverRowFor(INSTANCE_WRONGROLE, TARGET_ID)).toBeNull();
    const strayAction = await db.oneOrNone(
      `SELECT action FROM tbl_approval_actions
        WHERE approval_instance_id = $1 AND approver_user_id = $2`,
      [INSTANCE_WRONGROLE, TARGET_ID]
    );
    expect(strayAction).toBeNull();
  });

  it("still adds a DEPARTMENT-sourced approver who holds no role scope at all", async () => {
    // The narrowing takes department ids from tbl_user_department, not from
    // tbl_user_role_scopes.department_id. This user has ONLY the former, so if
    // the wrong relation were read their changedDeptIds would come back empty,
    // propagation would be skipped, and they would silently never be added.
    await insertPendingInstance({
      instanceId: INSTANCE_DEPT,
      policyId: POLICY_DEPT,
      stepId: STEP_DEPT,
      hotelId: HOTEL_MAP,
      poNumber: "PO-GAPB-SCOPE-DEPT",
    });

    expect(await approverRowFor(INSTANCE_DEPT, DEPT_TARGET_ID)).toBeNull();

    const client = await httpClient(ADMIN_ID);
    const res = await client
      .post(`/api/v1/hospitality/company/${IDS.hospitality.A}/map-users`)
      .send({
        mapping_type: 1,
        hotel_id: HOTEL_MAP,
        user_ids: [DEPT_TARGET_ID],
        auto_map_projects: false,
      });

    expect(res.status).toBe(200);

    const approverRow = await approverRowFor(INSTANCE_DEPT, DEPT_TARGET_ID);
    expect(approverRow).not.toBeNull();
    expect(approverRow.status).toBe("PENDING");
    expect(approverRow.added_mid_flight).toBe(true);
  });

  it("propagates for every qualifying user in a multi-user batch, and skips one with no sources", async () => {
    await insertPendingInstance({
      instanceId: INSTANCE_MAP,
      policyId: POLICY_MAP,
      stepId: STEP_MAP,
      hotelId: HOTEL_MAP,
      poNumber: "PO-GAPB-SCOPE-BATCH",
    });

    const client = await httpClient(ADMIN_ID);
    const res = await client
      .post(`/api/v1/hospitality/company/${IDS.hospitality.A}/map-users`)
      .send({
        mapping_type: 1,
        hotel_id: HOTEL_MAP,
        // The controller re-derives its own iteration order (see the note at
        // NOROLE_ID), where NOROLE_ID lands ahead of TARGET2_ID — so a skip
        // that short-circuits the batch loses TARGET2_ID and fails below.
        user_ids: [TARGET_ID, NOROLE_ID, TARGET2_ID],
        auto_map_projects: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    // All three mappings written — propagation scoping must not touch the
    // mapping write itself.
    const mappings = await db.any(
      `SELECT user_id FROM tbl_hospitality_user_mappings
        WHERE user_id = ANY($1::int[]) AND hospitality_company_id = $2 AND hospitality_hotel_id = $3`,
      [[TARGET_ID, NOROLE_ID, TARGET2_ID], IDS.hospitality.A, HOTEL_MAP]
    );
    expect(mappings.map((m) => Number(m.user_id)).sort()).toEqual(
      [TARGET_ID, NOROLE_ID, TARGET2_ID].sort()
    );

    // Every user in the list who qualifies is added — not just the first.
    for (const userId of [TARGET_ID, TARGET2_ID]) {
      const row = await approverRowFor(INSTANCE_MAP, userId);
      expect(row).not.toBeNull();
      expect(row.status).toBe("PENDING");
      expect(row.added_mid_flight).toBe(true);
    }

    // The user with no role scope and no department resolves nowhere.
    expect(await approverRowFor(INSTANCE_MAP, NOROLE_ID)).toBeNull();
  });
});

describe("usersController.create_buyer_company_users propagates newly-granted authority", () => {
  it("adds a brand-new user (role scope + mapping given at creation) to a live PENDING instance", async () => {
    await insertPendingInstance({
      instanceId: INSTANCE_CREATE,
      policyId: POLICY_CREATE,
      stepId: STEP_CREATE,
      hotelId: HOTEL_CREATE,
      poNumber: "PO-GAPB-CREATE-1",
    });

    const client = await httpClient(ADMIN_ID);
    const res = await client.post("/api/v1/users/create-buyer-company-user").send({
      name: "Gap B New User",
      email: CREATE_EMAIL,
      mobile: CREATE_MOBILE,
      user_type: 2,
      password: "Passw0rd!23",
      designation: "Tester",
      department_ids: [],
      roles: [
        {
          role_id: ROLE_CREATE_SCOPE,
          company_id: IDS.hospitality.A,
          hotel_id: HOTEL_CREATE,
          department_id: null,
        },
      ],
      mappings: [
        {
          company_id: IDS.hospitality.A,
          mapping_level: "hotel",
          hotel_id: HOTEL_CREATE,
          auto_map_projects: false,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    const newUserId = res.body.data.id;
    expect(newUserId).toBeTruthy();
    createdUserIds.push(newUserId);

    const approverRow = await approverRowFor(INSTANCE_CREATE, newUserId);
    expect(approverRow).not.toBeNull();
    expect(approverRow.status).toBe("PENDING");
    expect(approverRow.added_mid_flight).toBe(true);

    const action = await db.oneOrNone(
      `SELECT action FROM tbl_approval_actions
        WHERE approval_instance_id = $1 AND approver_user_id = $2 AND action = 'APPROVER_ADDED'`,
      [INSTANCE_CREATE, newUserId]
    );
    expect(action).not.toBeNull();
  });
});

describe("POST /api/v1/users/create-buyer-company-user is admin-only (acl gate)", () => {
  it("rejects a non-admin (user_type 2) caller with 403", async () => {
    const client = await httpClient(NON_ADMIN_ID);
    const res = await client.post("/api/v1/users/create-buyer-company-user").send({
      name: "Should Not Be Created",
      email: ACL_REJECT_EMAIL,
      mobile: ACL_REJECT_MOBILE,
      user_type: 2,
      password: "Passw0rd!23",
      designation: "Tester",
    });

    expect(res.status).toBe(403);

    const created = await db.oneOrNone(`SELECT id FROM tbl_users WHERE email = $1`, [ACL_REJECT_EMAIL]);
    expect(created).toBeNull();
  });

  it("admits a company admin (user_type 7) caller", async () => {
    const client = await httpClient(ADMIN_ID);
    const res = await client.post("/api/v1/users/create-buyer-company-user").send({
      name: "Gap B ACL OK User",
      email: ACL_OK_EMAIL,
      mobile: ACL_OK_MOBILE,
      user_type: 2,
      password: "Passw0rd!23",
      designation: "Tester",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    createdUserIds.push(res.body.data.id);
  });
});
