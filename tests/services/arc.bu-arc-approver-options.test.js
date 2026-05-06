// Phase 9 — endpoint test for the BU (per-hotel) approver-options API.
//
// Sister of arc.global-arc-approver-options.test.js. The thing we LOCK
// IN here is the network-scope leak prevention: a user holding the
// permission only via is_network_scope=1 must NOT appear in a BU
// hierarchy picker, no matter the hotel.
//
// Strategy: we operate on the canonical 'boq.approve' permission so
// we exercise the same path the controller uses. To prevent seed-bound
// roles from polluting the assertions, we snapshot+delete every
// pre-existing role_permission row for 'boq.approve' at suite start
// and restore them at suite end.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import rbacModel from "../../app/models/rbacModel.js";
import { buApproverOptionsController } from "../../app/controllers/general/generalController.js";

// Use TENDER_APPROVER — among the fixture role seeds it's bound to
// exactly one user (a1_proc_finance) at exactly one hotel (A1). That
// gives us a clean, predictable starting set for hotel-A1 vs hotel-A2
// assertions.
const TEST_ROLE = ROLE_IDS.TENDER_APPROVER;
let savedRolePermsForTenderApprove = [];

beforeAll(async () => {
  // Snapshot then strip every role_permission row pointing at any
  // 'boq.approve' permission, so the test starts from an empty
  // bind set. We restore in afterAll. This isolates assertions from
  // the seed_reference role-perm matrix.
  savedRolePermsForTenderApprove = await db.any(
    `SELECT rp.role_id, rp.permission_id
       FROM tbl_role_permissions rp
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE p.resource = 'tender' AND p.action = 'approve'`
  );
  await db.none(
    `DELETE FROM tbl_role_permissions
      WHERE permission_id IN (SELECT id FROM tbl_permissions WHERE resource = 'boq' AND action = 'approve')`
  );
});

afterAll(async () => {
  if (savedRolePermsForTenderApprove.length) {
    for (const r of savedRolePermsForTenderApprove) {
      await db.none(
        `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [r.role_id, r.permission_id]
      );
    }
  }
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

// "Tender approve" maps to the canonical 'boq.approve' permission
// because TENDER → resource 'boq' in ENTITY_APPROVE_RESOURCE_MAP.
const grantTenderApproveTo = async (roleId) => {
  const perm = await db.one(
    `SELECT id FROM tbl_permissions WHERE resource = 'boq' AND action = 'approve' LIMIT 1`
  );
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [roleId, perm.id]
  );
  inserted.rolePerms.push([roleId, perm.id]);
};

const grantBuRole = async (userId, roleId, hotelId) => {
  const row = await db.one(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, is_network_scope)
     VALUES ($1, $2, $3, $4, NULL, 0)
     RETURNING id`,
    [userId, roleId, IDS.companies.A, hotelId]
  );
  inserted.scopeIds.push(row.id);
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
    req: { user: opts.user, params: opts.params || {}, query: opts.query || {} },
    res, next: jest.fn(), calls,
  };
}

describe("GET /hospitality/approval/bu-approver-options — input validation", () => {
  it("rejects an unknown entity_type with 400", async () => {
    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "BOGUS" },
      query: { hotel_id: String(IDS.hotels.A1) },
    });
    await buApproverOptionsController.getBuApproverOptions(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });
});

describe("GET /hospitality/approval/bu-approver-options — network-scope leak prevention", () => {
  it("a user whose ONLY boq.approve grant is network-scope does NOT appear in BU users[]", async () => {
    await grantTenderApproveTo(TEST_ROLE);
    await grantNetworkRole(IDS.users.companyA_admin, TEST_ROLE);

    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "TENDER" },
      query: { hotel_id: String(IDS.hotels.A1) },
    });
    await buApproverOptionsController.getBuApproverOptions(m.req, m.res);
    expect(m.calls.body.status).toBe(1);

    const userIds = m.calls.body.data.users.map((u) => u.id);
    expect(userIds).not.toContain(IDS.users.companyA_admin);

    // Per-role users[] for the live preview must also exclude the
    // network-only holder so picking the role doesn't surface them.
    const role = m.calls.body.data.roles.find((r) => r.id === TEST_ROLE);
    expect(role).toBeTruthy();
    expect((role.users || []).map((u) => u.id)).not.toContain(IDS.users.companyA_admin);
  });

  it("the seeded BU holder for hotel A1 appears for A1 but NOT for A2", async () => {
    await grantTenderApproveTo(TEST_ROLE);

    const a1 = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "TENDER" },
      query: { hotel_id: String(IDS.hotels.A1) },
    });
    await buApproverOptionsController.getBuApproverOptions(a1.req, a1.res);
    expect(a1.calls.body.data.users.map((u) => u.id)).toContain(IDS.users.a1_proc_finance);

    const a2 = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "TENDER" },
      query: { hotel_id: String(IDS.hotels.A2) },
    });
    await buApproverOptionsController.getBuApproverOptions(a2.req, a2.res);
    expect(a2.calls.body.data.users.map((u) => u.id)).not.toContain(IDS.users.a1_proc_finance);
  });

  it("the role's per-row users[] is BU-scope-only and matches the requested hotel", async () => {
    await grantTenderApproveTo(TEST_ROLE);
    await grantNetworkRole(IDS.users.companyA_admin, TEST_ROLE);

    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      params: { entity_type: "TENDER" },
      query: { hotel_id: String(IDS.hotels.A1) },
    });
    await buApproverOptionsController.getBuApproverOptions(m.req, m.res);
    const role = m.calls.body.data.roles.find((r) => r.id === TEST_ROLE);
    const ids = role.users.map((u) => u.id);
    // Seeded BU holder at A1 must be in the role's users[].
    expect(ids).toContain(IDS.users.a1_proc_finance);
    // Network-only holder must be excluded.
    expect(ids).not.toContain(IDS.users.companyA_admin);
  });
});
