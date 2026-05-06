// Phase 9 — controller-level regression: the update_user_detail endpoint
// must persist a network-scope role grant exactly as the admin wizard
// emits it.
//
// Reported bug: admin opens Edit Account for a user, picks "ARC Approver"
// with the Network-Wide toggle ON, hits Update. DB row lands as
// is_network_scope=0, company_id=<admin's company>. The wizard's "Live
// flow preview" then never resolves the user under that role.
//
// This pins the entire HTTP boundary: req.body shape (the exact thing
// updateUserAccount() in services/Auth.js puts on the wire) → controller
// → rbacModel → DB row. If any step strips is_network_scope, this fails.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import UsersController from "../../app/controllers/users/usersController.js";

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: { user: opts.user, body: opts.body || {} },
    res, next: jest.fn(), calls,
  };
}

const cleanup = { scopeIds: [] };

beforeAll(async () => {
  // Ensure target user (the editee) starts with no role scopes.
  await db.none(
    `DELETE FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2`,
    [IDS.users.a1_proc_techApp, ROLE_IDS.COMM_APPROVER]
  );
  // Admin (the editor) needs user_type=7 to pass the isAdmin gate in
  // update_user_detail. The fixture leaves user_type NULL, so we patch
  // it for the duration of this suite and restore in afterAll.
  await db.none(`UPDATE tbl_users SET user_type = 7 WHERE id = $1`, [IDS.users.companyA_admin]);
});

afterEach(async () => {
  if (cleanup.scopeIds.length) {
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = ANY($1::int[])`, [cleanup.scopeIds]);
    cleanup.scopeIds = [];
  }
  await db.none(
    `DELETE FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2`,
    [IDS.users.a1_proc_techApp, ROLE_IDS.COMM_APPROVER]
  );
});

afterAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [IDS.users.companyA_admin]);
  await closeDb();
});

describe("PUT /users/update-user-detail — network-scope role round-trip", () => {
  it("persists is_network_scope=1 with all-NULL BU columns when the FE marks the role as Network-Wide", async () => {
    // Exact body shape the admin wizard wires through services/Auth.js
    // → updateUserAccount → axios.put. EditAccountModal.handleSave emits
    //   roles: [{ role_id, role_title, is_network_scope: 1, permissions }]
    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A, user_type: 7 },
      body: {
        user_id: IDS.users.a1_proc_techApp,
        name: "TechApp User",
        email: "techapp@test.local",
        mobile: "+91-9999900000",
        status: 1,
        roles: [
          {
            role_id: ROLE_IDS.COMM_APPROVER,
            role_title: "Commercial Approver",
            is_network_scope: 1,
            permissions: {},
          },
        ],
        department_ids: [],
        confirmed_approval_impact: true, // skip the pre-flight warning loop
      },
    });

    await UsersController.update_user_detail(m.req, m.res);

    expect(m.calls.body.status).toBe(true);

    const rows = await db.any(
      `SELECT id, user_id, role_id, company_id, hotel_id, department_id, is_network_scope
         FROM tbl_user_role_scopes
        WHERE user_id = $1 AND role_id = $2`,
      [IDS.users.a1_proc_techApp, ROLE_IDS.COMM_APPROVER]
    );
    expect(rows.length).toBe(1);
    rows.forEach((r) => cleanup.scopeIds.push(r.id));

    expect(rows[0].is_network_scope).toBe(1);
    expect(rows[0].company_id).toBeNull();
    expect(rows[0].hotel_id).toBeNull();
    expect(rows[0].department_id).toBeNull();
  });

  it("BU-scoped role payload still persists with is_network_scope=0 and a real company_id (no regression)", async () => {
    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A, user_type: 7 },
      body: {
        user_id: IDS.users.a1_proc_techApp,
        roles: [
          {
            role_id: ROLE_IDS.COMM_APPROVER,
            role_title: "Commercial Approver",
            company_id: IDS.companies.A,
            hotel_id: IDS.hotels.A1,
            department_id: IDS.departments.proc,
            permissions: {},
          },
        ],
        department_ids: [IDS.departments.proc],
        confirmed_approval_impact: true,
      },
    });

    await UsersController.update_user_detail(m.req, m.res);
    expect(m.calls.body.status).toBe(true);

    const rows = await db.any(
      `SELECT * FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2`,
      [IDS.users.a1_proc_techApp, ROLE_IDS.COMM_APPROVER]
    );
    expect(rows.length).toBe(1);
    rows.forEach((r) => cleanup.scopeIds.push(r.id));

    expect(rows[0].is_network_scope).toBe(0);
    expect(rows[0].company_id).toBe(IDS.companies.A);
    expect(rows[0].hotel_id).toBe(IDS.hotels.A1);
    expect(rows[0].department_id).toBe(IDS.departments.proc);
  });

  it("a single payload mixing one network-scope row + one BU-scoped row writes both correctly", async () => {
    const m = mockExpress({
      user: { id: IDS.users.companyA_admin, company_id: IDS.companies.A, user_type: 7 },
      body: {
        user_id: IDS.users.a1_proc_techApp,
        roles: [
          {
            role_id: ROLE_IDS.COMM_APPROVER,
            role_title: "Commercial Approver",
            is_network_scope: 1,
            permissions: {},
          },
          {
            role_id: ROLE_IDS.TECH_APPROVER,
            role_title: "Technical Approver",
            company_id: IDS.companies.A,
            hotel_id: IDS.hotels.A1,
            department_id: IDS.departments.proc,
            permissions: {},
          },
        ],
        department_ids: [IDS.departments.proc],
        confirmed_approval_impact: true,
      },
    });

    await UsersController.update_user_detail(m.req, m.res);
    expect(m.calls.body.status).toBe(true);

    const rows = await db.any(
      `SELECT * FROM tbl_user_role_scopes WHERE user_id = $1 ORDER BY role_id`,
      [IDS.users.a1_proc_techApp]
    );
    rows.forEach((r) => cleanup.scopeIds.push(r.id));

    const network = rows.find((r) => r.role_id === ROLE_IDS.COMM_APPROVER);
    const bu = rows.find((r) => r.role_id === ROLE_IDS.TECH_APPROVER);

    expect(network).toBeTruthy();
    expect(network.is_network_scope).toBe(1);
    expect(network.company_id).toBeNull();

    expect(bu).toBeTruthy();
    expect(bu.is_network_scope).toBe(0);
    expect(bu.company_id).toBe(IDS.companies.A);
    expect(bu.hotel_id).toBe(IDS.hotels.A1);
  });
});
