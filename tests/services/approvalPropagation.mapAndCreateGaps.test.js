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

// ---- Hotels under IDS.hospitality.A (83101-83199) ----
const HOTEL_MAP = 83101;    // scenario 1: mapUsers
const HOTEL_CREATE = 83102; // scenario 2: create_buyer_company_users

// ---- Policies / policy steps (63001-63199) ----
const POLICY_MAP = 63001;
const STEP_MAP = 63101;
const POLICY_CREATE = 63002;
const STEP_CREATE = 63102;

// ---- Instances (83201-83299), created per-test ----
const INSTANCE_MAP = 83201;
const INSTANCE_CREATE = 83202;

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
  await db.none(
    `INSERT INTO tbl_approval_instance_steps
       (id, approval_instance_id, policy_step_id, step_order, decision_rule, status)
     VALUES ($1, $2, $3, 1, 'ANY', 'PENDING')`,
    [stepId + 900000, instanceId, stepId]
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
     VALUES ($1, 'Gap B Admin',     'gapb.admin@test.local',     '9830000001', 'x', 7, 1, $4),
            ($2, 'Gap B Non-Admin', 'gapb.nonadmin@test.local',  '9830000002', 'x', 2, 1, $4),
            ($3, 'Gap B Target',    'gapb.target@test.local',    '9830000003', 'x', 2, 1, $4)
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_ID, NON_ADMIN_ID, TARGET_ID, IDS.companies.A]
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
     VALUES ($1, $2, $3, $4, NULL, NULL)
     ON CONFLICT DO NOTHING`,
    [TARGET_ID, ROLE_MAP_SCOPE, IDS.hospitality.A, HOTEL_MAP]
  );

  const policies = [
    [POLICY_MAP, HOTEL_MAP, STEP_MAP, ROLE_MAP_SCOPE],
    [POLICY_CREATE, HOTEL_CREATE, STEP_CREATE, ROLE_CREATE_SCOPE],
  ];
  for (const [policyId, hotelId, stepId, roleId] of policies) {
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by)
       VALUES ($1, 'PO', $2, $3, NULL, true, $4)
       ON CONFLICT (id) DO NOTHING`,
      [policyId, IDS.hospitality.A, hotelId, ADMIN_ID]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (id, approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, $2, 1, 'ANY', 'ROLE', $3)
       ON CONFLICT (id) DO NOTHING`,
      [stepId, policyId, roleId]
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

  // Undo the mapUsers test's mapping so re-running it in the same file stays
  // idempotent (the endpoint itself is ON CONFLICT DO UPDATE, not additive).
  await db.none(
    `DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1 AND hospitality_company_id = $2 AND hospitality_hotel_id = $3`,
    [TARGET_ID, IDS.hospitality.A, HOTEL_MAP]
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
  await db.none(
    `DELETE FROM tbl_approval_policy_steps WHERE id = ANY($1::int[])`,
    [[STEP_MAP, STEP_CREATE]]
  );
  await db.none(
    `DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`,
    [[POLICY_MAP, POLICY_CREATE]]
  );
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [TARGET_ID]);
  await db.none(
    `DELETE FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[])`,
    [[HOTEL_MAP, HOTEL_CREATE]]
  );
  await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [[ADMIN_ID, NON_ADMIN_ID, TARGET_ID]]);
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
