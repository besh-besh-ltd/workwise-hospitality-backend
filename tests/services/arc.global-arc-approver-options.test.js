// Phase 9 — endpoint test for the Global ARC approver-options API.
//
// What the wizard caller expects:
//   GET /hospitality/approval/global-arc/approver-options/:entity_type
//   → { roles: [...], users: [...] }
//
//   - entity_type ∈ {TENDER, TECHNICAL, NEGOTIATION, NEGOTIATION_QUOTE, ARC}.
//     Anything else → 400.
//   - roles: only roles holding the matching <entity>.approve perm.
//   - users: only users holding <entity>.approve via NETWORK-scope grants.
//   - Both lists deterministic-ordered; missing inputs → empty arrays.
//
// This isolates the wiring between the route, the controller, the
// rbacModel helpers (already tested in the rbac suite), and the
// ENTITY_APPROVE_RESOURCE_MAP.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import rbacModel from "../../app/models/rbacModel.js";
import { globalArcApproverOptionsController } from "../../app/controllers/general/generalController.js";

const PERM_TENDER_APPROVE = 9701;
const PERM_TE_APPROVE = 9702;
const PERM_ARC_APPROVE_TEST = 9703;

beforeAll(async () => {
  // TENDER entity_type maps to the 'boq' resource (single source of
  // truth: ENTITY_APPROVE_RESOURCE_MAP). The TENDER_APPROVER role in
  // production seed binds to boq.read / boq.approve, so the controller's
  // permission lookup uses 'boq.approve' for entity_type='TENDER'.
  await db.none(
    `INSERT INTO tbl_permissions (id, resource, action) VALUES
       ($1, 'boq', 'approve'),
       ($2, 'te', 'approve'),
       ($3, 'arc', 'approve')
     ON CONFLICT (id) DO NOTHING`,
    [PERM_TENDER_APPROVE, PERM_TE_APPROVE, PERM_ARC_APPROVE_TEST]
  );
});

afterAll(async () => {
  await db.none(
    `DELETE FROM tbl_role_permissions WHERE permission_id = ANY($1::int[])`,
    [[PERM_TENDER_APPROVE, PERM_TE_APPROVE, PERM_ARC_APPROVE_TEST]]
  );
  await db.none(
    `DELETE FROM tbl_permissions WHERE id = ANY($1::int[])`,
    [[PERM_TENDER_APPROVE, PERM_TE_APPROVE, PERM_ARC_APPROVE_TEST]]
  );
  await closeDb();
});

const inserted = { rolePerms: [], scopeIds: [] };
afterEach(async () => {
  if (inserted.rolePerms.length) {
    for (const [rid, pid] of inserted.rolePerms) {
      await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2`, [rid, pid]);
    }
    inserted.rolePerms = [];
  }
  if (inserted.scopeIds.length) {
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = ANY($1::int[])`, [inserted.scopeIds]);
    inserted.scopeIds = [];
  }
});

const grantPerm = async (roleId, permId) => {
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [roleId, permId]
  );
  inserted.rolePerms.push([roleId, permId]);
};
const grantNetworkRole = async (userId, roleId) => {
  await rbacModel.assignUserRoleScopes([
    { user_id: userId, role_id: roleId, is_network_scope: 1 },
  ]);
  const rows = await db.any(
    `SELECT id FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2 AND is_network_scope = 1`,
    [userId, roleId]
  );
  rows.forEach((r) => inserted.scopeIds.push(r.id));
};

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: { user: opts.user, params: opts.params || {} },
    res, next: jest.fn(), calls,
  };
}

describe("GET /hospitality/approval/global-arc/approver-options — input validation", () => {
  it("rejects an invalid entity_type with a structured 400", async () => {
    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "RFQ" }, // not in the tender chain
    });
    await globalArcApproverOptionsController.getGlobalArcApproverOptions(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Invalid entity_type/i);
  });

  it("rejects an entirely unknown entity_type", async () => {
    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "BOGUS_ENTITY" },
    });
    await globalArcApproverOptionsController.getGlobalArcApproverOptions(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });
});

describe("GET /hospitality/approval/global-arc/approver-options — happy paths per stage", () => {
  it("TENDER → returns roles holding boq.approve and network-scope users with same perm", async () => {
    await grantPerm(ROLE_IDS.TENDER_APPROVER, PERM_TENDER_APPROVE);
    await grantNetworkRole(IDS.users.companyA_admin, ROLE_IDS.TENDER_APPROVER);

    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "TENDER" },
    });
    await globalArcApproverOptionsController.getGlobalArcApproverOptions(m.req, m.res);
    expect([200, null]).toContain(m.calls.status);
    expect(m.calls.body.status).toBe(1);
    expect(m.calls.body.data.entity_type).toBe("TENDER");
    expect(m.calls.body.data.permission).toBe("boq.approve");

    const roleIds = m.calls.body.data.roles.map((r) => r.id);
    expect(roleIds).toContain(ROLE_IDS.TENDER_APPROVER);

    const userIds = m.calls.body.data.users.map((u) => u.id);
    expect(userIds).toContain(IDS.users.companyA_admin);
  });

  it("TECHNICAL → te.approve filter", async () => {
    await grantPerm(ROLE_IDS.TECH_APPROVER, PERM_TE_APPROVE);
    await grantNetworkRole(IDS.users.a1_proc_techApp, ROLE_IDS.TECH_APPROVER);

    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "TECHNICAL" },
    });
    await globalArcApproverOptionsController.getGlobalArcApproverOptions(m.req, m.res);
    expect(m.calls.body.status).toBe(1);
    expect(m.calls.body.data.permission).toBe("te.approve");

    const roleIds = m.calls.body.data.roles.map((r) => r.id);
    expect(roleIds).toContain(ROLE_IDS.TECH_APPROVER);

    const userIds = m.calls.body.data.users.map((u) => u.id);
    expect(userIds).toContain(IDS.users.a1_proc_techApp);
  });

  it("ARC → arc.approve filter, BU-only users are excluded from the user list", async () => {
    await grantPerm(ROLE_IDS.COMM_APPROVER, PERM_ARC_APPROVE_TEST);
    // a1_proc_commApp has COMM_APPROVER via BU-scoped grant only — they
    // must NOT appear in the user list (network-scope filter).
    await grantNetworkRole(IDS.users.companyA_admin, ROLE_IDS.COMM_APPROVER);

    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "ARC" },
    });
    await globalArcApproverOptionsController.getGlobalArcApproverOptions(m.req, m.res);
    expect(m.calls.body.data.permission).toBe("arc.approve");

    const userIds = m.calls.body.data.users.map((u) => u.id);
    expect(userIds).toContain(IDS.users.companyA_admin); // network-scope
    expect(userIds).not.toContain(IDS.users.a1_proc_commApp); // BU-only — excluded
  });

  it("each role row carries its per-role network-scope users[] for the wizard's ROLE-picker preview", async () => {
    // Wizard contract: when admin picks a role, the live preview shows
    // which users will resolve. Without per-role users[], the FE has no
    // way to map roles → eligible users and falls back to "No users
    // available". This test pins the enriched shape.
    await grantPerm(ROLE_IDS.COMM_APPROVER, PERM_ARC_APPROVE_TEST);
    await grantNetworkRole(IDS.users.companyA_admin, ROLE_IDS.COMM_APPROVER);

    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "ARC" },
    });
    await globalArcApproverOptionsController.getGlobalArcApproverOptions(m.req, m.res);

    const commRole = m.calls.body.data.roles.find((r) => r.id === ROLE_IDS.COMM_APPROVER);
    expect(commRole).toBeTruthy();
    expect(Array.isArray(commRole.users)).toBe(true);
    const commRoleUserIds = commRole.users.map((u) => u.id);
    expect(commRoleUserIds).toContain(IDS.users.companyA_admin);
    // The user has a BU-scoped COMM_APPROVER grant too (a1_proc_commApp) —
    // must NOT leak into the role's network-scope users[].
    expect(commRoleUserIds).not.toContain(IDS.users.a1_proc_commApp);
  });

  it("end-to-end: assignUserRoleScopes (network-scope) → endpoint returns the user under the role's users[]", async () => {
    // Reproduces the buyer's exact bug report:
    //   1. Grant a user a role at network scope (via the same model the
    //      controller uses on save).
    //   2. Hit the wizard endpoint.
    //   3. Expect the user to surface under the role's users[] AND
    //      under the top-level users[] (Specific User dropdown).
    // If this test passes but the user still sees empty users[], the
    // bug is in the persistence path, not in the read path.
    await grantPerm(ROLE_IDS.COMM_APPROVER, PERM_ARC_APPROVE_TEST);

    // Use the rbacModel write path that the controller actually calls
    // on save. We pass the EXACT shape the controller forwards for a
    // network-scope payload: only role_id + is_network_scope, no BU
    // columns.
    const rbacModel = (await import("../../app/models/rbacModel.js")).default;
    await rbacModel.assignUserRoleScopes([
      { user_id: IDS.users.companyA_admin, role_id: ROLE_IDS.COMM_APPROVER, is_network_scope: 1 },
    ]);
    // Track for cleanup.
    const written = await db.any(
      `SELECT id FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2 AND is_network_scope = 1`,
      [IDS.users.companyA_admin, ROLE_IDS.COMM_APPROVER]
    );
    written.forEach((r) => inserted.scopeIds.push(r.id));

    // Also confirm the row landed correctly — exposes a persistence
    // bug if the row is BU-shaped instead of network.
    expect(written.length).toBe(1);
    const row = await db.one(
      `SELECT * FROM tbl_user_role_scopes WHERE id = $1`,
      [written[0].id]
    );
    expect(row.is_network_scope).toBe(1);
    expect(row.company_id).toBeNull();
    expect(row.hotel_id).toBeNull();
    expect(row.department_id).toBeNull();

    // Now hit the endpoint as the same admin would.
    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "ARC" },
    });
    await globalArcApproverOptionsController.getGlobalArcApproverOptions(m.req, m.res);

    const data = m.calls.body.data;
    // Top-level users[] (Specific User dropdown) — must include the user.
    expect(data.users.map((u) => u.id)).toContain(IDS.users.companyA_admin);
    // Role-scoped users[] (User Role picker preview) — must include them too.
    const commRole = data.roles.find((r) => r.id === ROLE_IDS.COMM_APPROVER);
    expect(commRole).toBeTruthy();
    expect(commRole.users.map((u) => u.id)).toContain(IDS.users.companyA_admin);
  });

  it("for a stage with no network-scope grants, the user list is empty even if the perm has BU-only holders (proves the network filter)", async () => {
    // NEGOTIATION_QUOTE → quote-compare.approve. The seed reference may
    // grant this to one or more roles via BU scopes, so the role list
    // may be non-empty. The user list, however, must be empty unless
    // someone has a network-scope grant with that perm — which we
    // never seed in this test.
    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "NEGOTIATION_QUOTE" },
    });
    await globalArcApproverOptionsController.getGlobalArcApproverOptions(m.req, m.res);
    expect(m.calls.body.data.permission).toBe("quote-compare.approve");
    expect(Array.isArray(m.calls.body.data.users)).toBe(true);
    expect(m.calls.body.data.users).toEqual([]);
  });

  it("entity_type accepted case-insensitively (lowercase normalized)", async () => {
    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "tender" }, // lowercase
    });
    await globalArcApproverOptionsController.getGlobalArcApproverOptions(m.req, m.res);
    expect(m.calls.body.status).toBe(1);
    expect(m.calls.body.data.entity_type).toBe("TENDER");
  });
});
