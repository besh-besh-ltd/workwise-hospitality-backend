// Phase 9 — product-level test for network-scope role grants on Group ARC.
//
// What the architecture is: Group ARC tenders cover hotels possibly
// across hospitality companies. Their approval policy is is_global=1
// with no BU scoping. Approvers under such a policy must therefore
// resolve through a SEPARATE role-grant axis: tbl_user_role_scopes
// rows where is_network_scope=1 (and all of company/hotel/department
// are NULL by CHECK constraint).
//
// What the buyer should observe:
//   - ROLE-source under a Global ARC policy resolves only users who
//     hold that role via a network-scope grant. BU-scoped grants of
//     the same role do NOT count.
//   - USER-source under a Global ARC policy verifies the picked user
//     is active AND holds at least one network-scope role grant.
//     Tampering the body with a user who has only BU-scoped grants
//     → resolves to zero approvers.
//   - The two scopes do NOT cross-pollinate: a user with te.read at
//     hotel A1 cannot evaluate a Group ARC tender that covers A1.
//   - The CHECK constraint on tbl_user_role_scopes enforces the
//     shape (network-scope rows have all-null scope columns; BU rows
//     have non-null company_id).

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";

const POLICY_GLOBAL_ROLE_ARC = 60500;
const POLICY_GLOBAL_USER_ARC = 60501;

// Production seed_reference is missing `arc.read` — only arc.approve,
// arc.create, arc.send_back are seeded. Without read, no role passes
// roleHasReadAndApprovePermission for ARC. We seed it inline for the
// suite so the ROLE-source path can resolve. This is a separate
// production gap to track (filed for the seed reference fixup).
const ARC_READ_PERMISSION_ID = 950;

beforeAll(async () => {
  // Seed arc.read permission + grant to COMM_APPROVER (and arc.approve
  // if not already granted).
  await db.none(
    `INSERT INTO tbl_permissions (id, resource, action)
     VALUES ($1, 'arc', 'read')
     ON CONFLICT (id) DO NOTHING`,
    [ARC_READ_PERMISSION_ID]
  );
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     VALUES ($1, $2), ($1, 33)
     ON CONFLICT DO NOTHING`,
    [ROLE_IDS.COMM_APPROVER, ARC_READ_PERMISSION_ID]
  );

  // Two global ARC policies for company A. One uses ROLE source, the
  // other uses USER source — so we can exercise both resolution paths.
  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped,
        version, company_id, is_global)
     VALUES
       ($1, 'ARC', NULL, NULL, NULL, true, $3, NULL, false, false, 1, $4, 1),
       ($2, 'ARC', NULL, NULL, NULL, true, $3, NULL, false, false, 1, $4, 1)
     ON CONFLICT (id) DO NOTHING`,
    [POLICY_GLOBAL_ROLE_ARC, POLICY_GLOBAL_USER_ARC, IDS.users.companyA_admin, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ANY', 'ROLE', $2)
     ON CONFLICT DO NOTHING`,
    [POLICY_GLOBAL_ROLE_ARC, ROLE_IDS.COMM_APPROVER]
  );
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ANY', 'USER', $2)
     ON CONFLICT DO NOTHING`,
    [POLICY_GLOBAL_USER_ARC, IDS.users.a1_proc_commApp]
  );
});

afterAll(async () => {
  await db.none(
    `DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`,
    [[POLICY_GLOBAL_ROLE_ARC, POLICY_GLOBAL_USER_ARC]]
  );
  await db.none(
    `DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`,
    [[POLICY_GLOBAL_ROLE_ARC, POLICY_GLOBAL_USER_ARC]]
  );
  await db.none(
    `DELETE FROM tbl_role_permissions WHERE role_id = $1 AND permission_id IN ($2, 33)`,
    [ROLE_IDS.COMM_APPROVER, ARC_READ_PERMISSION_ID]
  );
  await db.none(`DELETE FROM tbl_permissions WHERE id = $1`, [ARC_READ_PERMISSION_ID]);
  await closeDb();
});

const inserted = { networkScopeIds: [] };
afterEach(async () => {
  if (inserted.networkScopeIds.length) {
    await db.none(
      `DELETE FROM tbl_user_role_scopes WHERE id = ANY($1::int[])`,
      [inserted.networkScopeIds]
    );
    inserted.networkScopeIds = [];
  }
});

const cleanupInstance = async (instance) => {
  if (!instance?.id) return;
  await db.none(
    `DELETE FROM tbl_approval_step_approvers
      WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1)`,
    [instance.id]
  );
  await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = $1`, [instance.id]);
  await db.none(`DELETE FROM tbl_approval_instances WHERE id = $1`, [instance.id]);
};

const grantNetworkRole = async (userId, roleId) => {
  const row = await db.one(
    `INSERT INTO tbl_user_role_scopes
       (user_id, role_id, company_id, hotel_id, department_id, is_network_scope)
     VALUES ($1, $2, NULL, NULL, NULL, 1)
     RETURNING id`,
    [userId, roleId]
  );
  inserted.networkScopeIds.push(row.id);
  return row.id;
};

let entityIdSeed = 296000000;
const nextEntityId = () => ++entityIdSeed;

describe("Group ARC — schema-level CHECK on network-scope row shape", () => {
  it("rejects a network-scope row that carries any BU column (must be all-NULL)", async () => {
    await expect(
      db.none(
        `INSERT INTO tbl_user_role_scopes
           (user_id, role_id, company_id, hotel_id, department_id, is_network_scope)
         VALUES ($1, $2, $3, NULL, NULL, 1)`,
        [IDS.users.companyA_admin, ROLE_IDS.COMM_APPROVER, IDS.companies.A]
      )
    ).rejects.toThrow(/chk_user_role_scopes_network_shape|violates check constraint/i);
  });

  it("rejects a BU-scoped row missing company_id (legacy invariant preserved)", async () => {
    await expect(
      db.none(
        `INSERT INTO tbl_user_role_scopes
           (user_id, role_id, company_id, hotel_id, department_id, is_network_scope)
         VALUES ($1, $2, NULL, NULL, NULL, 0)`,
        [IDS.users.companyA_admin, ROLE_IDS.COMM_APPROVER]
      )
    ).rejects.toThrow(/chk_user_role_scopes_network_shape|violates check constraint/i);
  });

  it("accepts a properly-shaped network-scope row", async () => {
    const id = await grantNetworkRole(IDS.users.companyA_admin, ROLE_IDS.COMM_APPROVER);
    expect(id).toBeTruthy();
    const row = await db.one(`SELECT * FROM tbl_user_role_scopes WHERE id = $1`, [id]);
    expect(row.is_network_scope).toBe(1);
    expect(row.company_id).toBeNull();
    expect(row.hotel_id).toBeNull();
    expect(row.department_id).toBeNull();
  });
});

describe("Group ARC — ROLE-source resolution under is_global policy", () => {
  it("resolves users who hold the role via a network-scope grant", async () => {
    await grantNetworkRole(IDS.users.companyA_admin, ROLE_IDS.COMM_APPROVER);
    await grantNetworkRole(IDS.users.companyB_admin, ROLE_IDS.COMM_APPROVER);

    const res = await createApprovalInstance({
      entity_type: 'ARC',
      entity_id: nextEntityId(),
      tender_scope: 'GROUP',
      company_id: IDS.companies.A,
      initiated_by: IDS.users.a1_proc_buyer,
      approval_policy_id: POLICY_GLOBAL_ROLE_ARC,
      metadata: { test: 'role_global' },
    });

    const approvers = await db.any(
      `SELECT DISTINCT sa.approver_user_id
         FROM tbl_approval_step_approvers sa
         JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
        WHERE s.approval_instance_id = $1
        ORDER BY sa.approver_user_id`,
      [res.instance.id]
    );
    const ids = approvers.map((r) => r.approver_user_id).sort();
    expect(ids).toEqual([IDS.users.companyA_admin, IDS.users.companyB_admin].sort());

    await cleanupInstance(res.instance);
  });

  it("does NOT resolve users who hold the role only via a BU-scoped grant (cross-scope isolation)", async () => {
    // a1_proc_commApp holds COMM_APPROVER via a BU-scoped grant
    // (see fixtures/users.js). NO network-scope grant for them — so
    // they must NOT resolve under the global policy.
    const res = await createApprovalInstance({
      entity_type: 'ARC',
      entity_id: nextEntityId(),
      tender_scope: 'GROUP',
      company_id: IDS.companies.A,
      initiated_by: IDS.users.a1_proc_buyer,
      approval_policy_id: POLICY_GLOBAL_ROLE_ARC,
      metadata: { test: 'no_network_grant' },
    });

    const approvers = await db.any(
      `SELECT sa.approver_user_id
         FROM tbl_approval_step_approvers sa
         JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
        WHERE s.approval_instance_id = $1`,
      [res.instance.id]
    );
    expect(approvers.map((r) => r.approver_user_id))
      .not.toContain(IDS.users.a1_proc_commApp);

    await cleanupInstance(res.instance);
  });

  it("BU-scoped grants are completely ignored even when the user has many of them", async () => {
    // Even a user who holds the role across MANY hotels via BU-scoped
    // grants should not surface under a network-scope policy.
    const otherUser = IDS.users.a1_proc_techApp;
    // Add extra BU grants — these must NOT make the user resolve.
    const stray1 = (await db.one(
      `INSERT INTO tbl_user_role_scopes
         (user_id, role_id, company_id, hotel_id, department_id, is_network_scope)
       VALUES ($1, $2, $3, $4, NULL, 0) RETURNING id`,
      [otherUser, ROLE_IDS.COMM_APPROVER, IDS.hospitality.A, IDS.hotels.A1]
    )).id;
    const stray2 = (await db.one(
      `INSERT INTO tbl_user_role_scopes
         (user_id, role_id, company_id, hotel_id, department_id, is_network_scope)
       VALUES ($1, $2, $3, $4, NULL, 0) RETURNING id`,
      [otherUser, ROLE_IDS.COMM_APPROVER, IDS.hospitality.A, IDS.hotels.A2]
    )).id;
    inserted.networkScopeIds.push(stray1, stray2);

    const res = await createApprovalInstance({
      entity_type: 'ARC',
      entity_id: nextEntityId(),
      tender_scope: 'GROUP',
      company_id: IDS.companies.A,
      initiated_by: IDS.users.a1_proc_buyer,
      approval_policy_id: POLICY_GLOBAL_ROLE_ARC,
      metadata: { test: 'many_bu_grants_no_network' },
    });

    const approvers = await db.any(
      `SELECT sa.approver_user_id
         FROM tbl_approval_step_approvers sa
         JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
        WHERE s.approval_instance_id = $1`,
      [res.instance.id]
    );
    expect(approvers.map((r) => r.approver_user_id)).not.toContain(otherUser);

    await cleanupInstance(res.instance);
  });
});

describe("Group ARC — USER-source resolution under is_global policy", () => {
  it("resolves the picked user when they hold a network-scope grant", async () => {
    await grantNetworkRole(IDS.users.a1_proc_commApp, ROLE_IDS.COMM_APPROVER);
    const res = await createApprovalInstance({
      entity_type: 'ARC',
      entity_id: nextEntityId(),
      tender_scope: 'GROUP',
      company_id: IDS.companies.A,
      initiated_by: IDS.users.a1_proc_buyer,
      approval_policy_id: POLICY_GLOBAL_USER_ARC,
      metadata: {},
    });

    const approvers = await db.any(
      `SELECT sa.approver_user_id
         FROM tbl_approval_step_approvers sa
         JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
        WHERE s.approval_instance_id = $1`,
      [res.instance.id]
    );
    expect(approvers.map((r) => r.approver_user_id)).toContain(IDS.users.a1_proc_commApp);

    await cleanupInstance(res.instance);
  });

  it("REFUSES to resolve a USER-source pick that lacks any network-scope grant (server-side defence)", async () => {
    // a1_proc_commApp here has only BU-scoped grants (from fixtures).
    // Even though they're a real user, the global policy should not
    // resolve them — the wizard's user picker is supposed to enforce
    // this filter, but the server must double-check on submit.
    const res = await createApprovalInstance({
      entity_type: 'ARC',
      entity_id: nextEntityId(),
      tender_scope: 'GROUP',
      company_id: IDS.companies.A,
      initiated_by: IDS.users.a1_proc_buyer,
      approval_policy_id: POLICY_GLOBAL_USER_ARC,
      metadata: {},
    });

    const approvers = await db.any(
      `SELECT sa.approver_user_id
         FROM tbl_approval_step_approvers sa
         JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
        WHERE s.approval_instance_id = $1`,
      [res.instance.id]
    );
    expect(approvers.map((r) => r.approver_user_id)).not.toContain(IDS.users.a1_proc_commApp);

    await cleanupInstance(res.instance);
  });
});
