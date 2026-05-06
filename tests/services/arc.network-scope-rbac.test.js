// Phase 9 — RBAC management for network-scope grants.
//
// What this locks in: the management API around tbl_user_role_scopes
// understands the new is_network_scope axis end-to-end:
//
//   - assignUserRoleScopes can WRITE network-scope rows
//     (with all-NULL BU columns, sanitised so the CHECK constraint
//     can't be smuggled past with mixed payloads).
//   - getUserRoleScopes / getUserRoleScopesBatch SURFACE the
//     is_network_scope flag so admin UIs can render and edit.
//   - getUserNetworkPermissions returns the (resource, action) set a
//     user has via network-scope role grants only — used by Group ARC
//     entity controllers.
//   - userHasAnyNetworkPermission is the boolean used to gate Group
//     ARC list/detail endpoints (te.read, quote-compare.read, etc.).
//   - getRolesWithAllPermissions / getUsersWithAllNetworkPermissions
//     are the wizard filters that restrict the picker per stage to
//     candidates actually holding the matching <entity>.approve
//     permission.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import rbacModel from "../../app/models/rbacModel.js";

// We seed two custom permissions for clean isolation from the
// production seed. test_arc.read + test_arc.approve.
const PERM_TEST_ARC_READ = 9501;
const PERM_TEST_ARC_APPROVE = 9502;
const PERM_TEST_ARC_RESOURCE = 'arc';

beforeAll(async () => {
  // Reuse 'arc' resource (already in resource_type enum). Add the
  // missing read action so we can test the role/user filters.
  await db.none(
    `INSERT INTO tbl_permissions (id, resource, action) VALUES
       ($1, $3, 'read'),
       ($2, $3, 'approve')
     ON CONFLICT (id) DO NOTHING`,
    [PERM_TEST_ARC_READ, PERM_TEST_ARC_APPROVE, PERM_TEST_ARC_RESOURCE]
  );
});

afterAll(async () => {
  await db.none(
    `DELETE FROM tbl_role_permissions WHERE permission_id = ANY($1::int[])`,
    [[PERM_TEST_ARC_READ, PERM_TEST_ARC_APPROVE]]
  );
  await db.none(
    `DELETE FROM tbl_permissions WHERE id = ANY($1::int[])`,
    [[PERM_TEST_ARC_READ, PERM_TEST_ARC_APPROVE]]
  );
  await closeDb();
});

const inserted = { scopeIds: [], rolePermIds: [] };
afterEach(async () => {
  if (inserted.scopeIds.length) {
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = ANY($1::int[])`, [inserted.scopeIds]);
    inserted.scopeIds = [];
  }
  if (inserted.rolePermIds.length) {
    await db.none(
      `DELETE FROM tbl_role_permissions WHERE role_id = ANY($1::int[]) AND permission_id = ANY($2::int[])`,
      [inserted.rolePermIds, [PERM_TEST_ARC_READ, PERM_TEST_ARC_APPROVE]]
    );
    inserted.rolePermIds = [];
  }
});

const grantPerms = async (roleId, permIds) => {
  for (const pid of permIds) {
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [roleId, pid]
    );
  }
  inserted.rolePermIds.push(roleId);
};

describe("assignUserRoleScopes — network-scope writes", () => {
  it("writes a clean network-scope row with all-NULL BU columns", async () => {
    await rbacModel.assignUserRoleScopes([
      { user_id: IDS.users.companyA_admin, role_id: ROLE_IDS.COMM_APPROVER, is_network_scope: 1 },
    ]);
    const rows = await db.any(
      `SELECT * FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2 AND is_network_scope = 1`,
      [IDS.users.companyA_admin, ROLE_IDS.COMM_APPROVER]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].company_id).toBeNull();
    expect(rows[0].hotel_id).toBeNull();
    expect(rows[0].department_id).toBeNull();
    inserted.scopeIds.push(rows[0].id);
  });

  it("sanitises a sloppy payload that mixes is_network_scope=1 with BU columns — BU columns are forced NULL", async () => {
    // Caller smuggles a hotel_id along with is_network_scope=1.
    // The model sanitises it to NULL so the row passes the CHECK
    // constraint AND there's no risk of a quirky shape if the
    // constraint is ever relaxed.
    await rbacModel.assignUserRoleScopes([
      {
        user_id: IDS.users.companyB_admin,
        role_id: ROLE_IDS.COMM_APPROVER,
        is_network_scope: 1,
        company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
      },
    ]);
    const rows = await db.any(
      `SELECT * FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2 AND is_network_scope = 1`,
      [IDS.users.companyB_admin, ROLE_IDS.COMM_APPROVER]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].company_id).toBeNull();
    expect(rows[0].hotel_id).toBeNull();
    expect(rows[0].department_id).toBeNull();
    inserted.scopeIds.push(rows[0].id);
  });

  it("BU-scoped writes still work as before", async () => {
    await rbacModel.assignUserRoleScopes([
      {
        user_id: IDS.users.a1_proc_techApp,
        role_id: ROLE_IDS.COMM_APPROVER,
        company_id: IDS.hospitality.B,
        hotel_id: IDS.hotels.B1,
      },
    ]);
    const rows = await db.any(
      `SELECT * FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2 AND hotel_id = $3 AND is_network_scope = 0`,
      [IDS.users.a1_proc_techApp, ROLE_IDS.COMM_APPROVER, IDS.hotels.B1]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].company_id).toBe(IDS.hospitality.B);
    inserted.scopeIds.push(rows[0].id);
  });
});

describe("getUserRoleScopes — surfaces is_network_scope", () => {
  it("returns is_network_scope on each row for the admin UI", async () => {
    await rbacModel.assignUserRoleScopes([
      { user_id: IDS.users.companyA_admin, role_id: ROLE_IDS.COMM_APPROVER, is_network_scope: 1 },
    ]);
    const scopes = await rbacModel.getUserRoleScopes(IDS.users.companyA_admin);
    const network = scopes.filter((s) => s.is_network_scope === 1);
    expect(network.length).toBeGreaterThan(0);
    network.forEach((s) => {
      expect(s.company_id).toBeNull();
      expect(s.hotel_id).toBeNull();
      expect(s.department_id).toBeNull();
    });
    // Track for cleanup.
    const all = await db.any(
      `SELECT id FROM tbl_user_role_scopes WHERE user_id = $1 AND is_network_scope = 1`,
      [IDS.users.companyA_admin]
    );
    inserted.scopeIds.push(...all.map((r) => r.id));
  });
});

describe("getUserNetworkPermissions / userHasAnyNetworkPermission", () => {
  it("returns ONLY network-scope permissions (BU-scoped grants are excluded)", async () => {
    // Grant arc.read + arc.approve to COMM_APPROVER.
    await grantPerms(ROLE_IDS.COMM_APPROVER, [PERM_TEST_ARC_READ, PERM_TEST_ARC_APPROVE]);

    // Network-scope grant to companyA_admin.
    await rbacModel.assignUserRoleScopes([
      { user_id: IDS.users.companyA_admin, role_id: ROLE_IDS.COMM_APPROVER, is_network_scope: 1 },
    ]);

    const perms = await rbacModel.getUserNetworkPermissions(IDS.users.companyA_admin);
    const keys = perms.map((p) => `${p.resource}.${p.action}`);
    expect(keys).toContain('arc.read');
    expect(keys).toContain('arc.approve');

    // Track network-scope row for cleanup.
    const network = await db.any(
      `SELECT id FROM tbl_user_role_scopes WHERE user_id = $1 AND is_network_scope = 1`,
      [IDS.users.companyA_admin]
    );
    inserted.scopeIds.push(...network.map((r) => r.id));

    // Boolean helper agrees.
    expect(await rbacModel.userHasAnyNetworkPermission(IDS.users.companyA_admin, ['arc.read'])).toBe(true);
    expect(await rbacModel.userHasAnyNetworkPermission(IDS.users.companyA_admin, ['arc.approve'])).toBe(true);
    expect(await rbacModel.userHasAnyNetworkPermission(IDS.users.companyA_admin, ['arc.delete_universe'])).toBe(false);
  });

  it("returns nothing for a user who has the permission only via BU-scoped grants", async () => {
    // a1_proc_commApp holds COMM_APPROVER via BU grants (from fixtures).
    // No network-scope grant — must return zero perms.
    await grantPerms(ROLE_IDS.COMM_APPROVER, [PERM_TEST_ARC_READ, PERM_TEST_ARC_APPROVE]);
    const perms = await rbacModel.getUserNetworkPermissions(IDS.users.a1_proc_commApp);
    expect(perms).toEqual([]);
    expect(await rbacModel.userHasAnyNetworkPermission(IDS.users.a1_proc_commApp, ['arc.read'])).toBe(false);
  });
});

describe("Wizard filters — getRolesWithAllPermissions / getUsersWithAllNetworkPermissions", () => {
  it("getRolesWithAllPermissions returns only roles holding ALL given permissions", async () => {
    // Grant arc.approve to COMM_APPROVER but NOT to TECH_APPROVER.
    await grantPerms(ROLE_IDS.COMM_APPROVER, [PERM_TEST_ARC_APPROVE]);

    const roles = await rbacModel.getRolesWithAllPermissions(['arc.approve']);
    const ids = roles.map((r) => r.id);
    expect(ids).toContain(ROLE_IDS.COMM_APPROVER);
    expect(ids).not.toContain(ROLE_IDS.TECH_APPROVER);
  });

  it("getUsersWithAllNetworkPermissions returns only network-scope holders", async () => {
    await grantPerms(ROLE_IDS.COMM_APPROVER, [PERM_TEST_ARC_APPROVE]);
    await rbacModel.assignUserRoleScopes([
      { user_id: IDS.users.companyA_admin, role_id: ROLE_IDS.COMM_APPROVER, is_network_scope: 1 },
    ]);
    const network = await db.any(
      `SELECT id FROM tbl_user_role_scopes WHERE user_id = $1 AND is_network_scope = 1`,
      [IDS.users.companyA_admin]
    );
    inserted.scopeIds.push(...network.map((r) => r.id));

    const users = await rbacModel.getUsersWithAllNetworkPermissions(['arc.approve']);
    const ids = users.map((u) => u.id);
    expect(ids).toContain(IDS.users.companyA_admin);
    // a1_proc_commApp holds the role only at BU scope → excluded.
    expect(ids).not.toContain(IDS.users.a1_proc_commApp);
  });

  it("empty/missing permKeys → empty result (defensive)", async () => {
    expect(await rbacModel.getRolesWithAllPermissions([])).toEqual([]);
    expect(await rbacModel.getRolesWithAllPermissions()).toEqual([]);
    expect(await rbacModel.getUsersWithAllNetworkPermissions([])).toEqual([]);
    expect(await rbacModel.userHasAnyNetworkPermission(IDS.users.companyA_admin, [])).toBe(false);
    expect(await rbacModel.userHasAnyNetworkPermission(null, ['arc.read'])).toBe(false);
  });
});
