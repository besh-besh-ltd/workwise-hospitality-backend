// Per-hotel permission breakdown for picker UIs.
//
// The /vendor/all hotel-picker dropdown filters out hotels the user
// can't read on, and disables those they can read but not create on.
// That requires per-hotel granularity — the existing bulk endpoint
// returns the union across the set, which is the wrong shape for
// individual-option enable/disable decisions.
//
// What we lock in:
//   - the rbacModel resolver returns one row per (hotel_id, resource,
//     action) combination, ZERO rows for hotels the user has no scope on;
//   - network-scope grants (is_network_scope=1) are EXCLUDED — they
//     govern Group ARC, not BU pickers;
//   - the controller groups the rows into permissions_by_hotel and
//     marks hotels with no rows as empty buckets (not absent).

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import rbacModel from "../../app/models/rbacModel.js";
import rbacController from "../../app/controllers/rbac/rbacController.js";

// We use 'boq' as the canonical tender-side resource.
let savedRolePerms = [];

beforeAll(async () => {
  // Snapshot existing role-permission rows for boq.* and clear them so
  // the seed matrix doesn't pollute per-hotel assertions. Restored in
  // afterAll.
  savedRolePerms = await db.any(
    `SELECT rp.role_id, rp.permission_id
       FROM tbl_role_permissions rp
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE p.resource = 'boq'`
  );
  await db.none(
    `DELETE FROM tbl_role_permissions
      WHERE permission_id IN (SELECT id FROM tbl_permissions WHERE resource = 'boq')`
  );
});

afterAll(async () => {
  for (const r of savedRolePerms) {
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [r.role_id, r.permission_id]
    );
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

const grantBoqPermToRole = async (roleId, action) => {
  const perm = await db.oneOrNone(
    `SELECT id FROM tbl_permissions WHERE resource = 'boq' AND action = $1 LIMIT 1`,
    [action]
  );
  if (!perm) return; // resource enum should already include boq.read/boq.create per seed
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [roleId, perm.id]
  );
  inserted.rolePerms.push([roleId, perm.id]);
};

const grantBuRole = async (userId, roleId, hospitalityCompanyId, hotelId) => {
  const row = await db.one(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, is_network_scope)
     VALUES ($1, $2, $3, $4, NULL, 0)
     RETURNING id`,
    [userId, roleId, hospitalityCompanyId, hotelId]
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
  return { req: { user: opts.user, body: opts.body || {} }, res, next: jest.fn(), calls };
}

describe("getUserPermissionsPerHotel — model", () => {
  it("returns zero rows when the user has no BU-scope grants matching any hotel", async () => {
    const rows = await rbacModel.getUserPermissionsPerHotel(
      IDS.users.companyA_admin,
      [IDS.hotels.A1, IDS.hotels.A2],
      "boq"
    );
    expect(rows).toEqual([]);
  });

  it("returns rows ONLY for hotels the user has BU-scope grants on", async () => {
    // Grant TENDER_APPROVER both boq.read + boq.create.
    await grantBoqPermToRole(ROLE_IDS.TENDER_APPROVER, "read");
    await grantBoqPermToRole(ROLE_IDS.TENDER_APPROVER, "create");
    // User holds the role at A1 only.
    await grantBuRole(IDS.users.a1_proc_techApp, ROLE_IDS.TENDER_APPROVER, IDS.hospitality.A, IDS.hotels.A1);

    const rows = await rbacModel.getUserPermissionsPerHotel(
      IDS.users.a1_proc_techApp,
      [IDS.hotels.A1, IDS.hotels.A2],
      "boq"
    );
    const hotelIds = [...new Set(rows.map((r) => r.hotel_id))];
    expect(hotelIds).toEqual([IDS.hotels.A1]);
    const a1Actions = rows.filter((r) => r.hotel_id === IDS.hotels.A1).map((r) => r.action).sort();
    expect(a1Actions).toEqual(["create", "read"]);
  });

  it("excludes network-scope grants — Group ARC roles don't bleed into BU pickers", async () => {
    await grantBoqPermToRole(ROLE_IDS.TENDER_APPROVER, "read");
    await grantBoqPermToRole(ROLE_IDS.TENDER_APPROVER, "create");
    // Network-only grant — should NOT match either hotel.
    await grantNetworkRole(IDS.users.companyA_admin, ROLE_IDS.TENDER_APPROVER);

    const rows = await rbacModel.getUserPermissionsPerHotel(
      IDS.users.companyA_admin,
      [IDS.hotels.A1, IDS.hotels.A2],
      "boq"
    );
    expect(rows).toEqual([]);
  });

  it("a company-wide BU grant (urs.hotel_id IS NULL) covers ALL hotels in that hospitality company", async () => {
    await grantBoqPermToRole(ROLE_IDS.CEO, "read");
    // companyA_admin has CEO at company A with hotel=NULL (per fixture seed)
    const rows = await rbacModel.getUserPermissionsPerHotel(
      IDS.users.companyA_admin,
      [IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3],
      "boq"
    );
    const hotelIds = [...new Set(rows.map((r) => r.hotel_id))].sort();
    expect(hotelIds).toEqual([IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3].sort());
  });
});

describe("POST /rbac/me/permissions/per-hotel — controller", () => {
  it("groups the per-hotel rows into permissions_by_hotel keyed by hotel_id", async () => {
    await grantBoqPermToRole(ROLE_IDS.TENDER_APPROVER, "read");
    await grantBoqPermToRole(ROLE_IDS.TENDER_APPROVER, "create");
    await grantBuRole(IDS.users.a1_proc_techApp, ROLE_IDS.TENDER_APPROVER, IDS.hospitality.A, IDS.hotels.A1);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_techApp, company_id: IDS.companies.A },
      body: { hotel_ids: [IDS.hotels.A1, IDS.hotels.A2], key: "boq" },
    });
    await rbacController.getMyPermissionsPerHotel(m.req, m.res);
    expect(m.calls.body.status).toBe(true);
    const perms = m.calls.body.data.permissions_by_hotel;

    // Both hotels appear (so the FE knows they were valid lookups);
    // A2 is an empty bucket because the user has no scope there.
    expect(perms[IDS.hotels.A1].boq.sort()).toEqual(["create", "read"]);
    expect(perms[IDS.hotels.A2]).toEqual({});
  });

  it("rejects missing or empty hotel_ids with 400", async () => {
    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      body: { hotel_ids: [], key: "boq" },
    });
    await rbacController.getMyPermissionsPerHotel(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });

  it("flags invalid hotel ids in meta.invalid_hotel_ids without failing the response", async () => {
    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A },
      body: { hotel_ids: [IDS.hotels.A1, 9999999], key: "boq" },
    });
    await rbacController.getMyPermissionsPerHotel(m.req, m.res);
    expect(m.calls.body.status).toBe(true);
    expect(m.calls.body.data.meta.invalid_hotel_ids).toEqual([9999999]);
    expect(m.calls.body.data.meta.valid_hotel_ids).toEqual([IDS.hotels.A1]);
  });
});
