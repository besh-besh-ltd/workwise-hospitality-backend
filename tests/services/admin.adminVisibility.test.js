/**
 * Administrators must be visible and must not be removable to zero (T0).
 *
 * Three separate filters hid them — `userModel.js:2209`, `:2286`, and
 * `usersController.js:1303` — so an admin created by the module could not be
 * listed, counted, searched or edited from the People screen. There was
 * nothing to guard a last administrator *from*, and Part One's stat cards
 * under-counted.
 *
 * Promotion needs no new endpoint now that administration is a capability:
 * granting the "Company Administrator" role through the existing
 * role-assignment flow *is* the promotion, and revoking it is the demotion.
 * What is new is the floor — a company must never reach zero administrators,
 * because nobody inside it could then restore one.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import userModel from "../../app/models/userModel.js";
import { isCompanyAdmin } from "../../app/middleware/companyAdmin.js";
import { IDS } from "../fixtures/ids.js";

const ADMIN = IDS.users.companyA_admin;
const BUYER = IDS.users.a1_proc_buyer;

let restoreAdminType;
let adminRoleId;
const grants = [];

const grant = async (userId) => {
  const row = await db.oneOrNone(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
    [userId, adminRoleId, IDS.hospitality.A]
  );
  if (row) grants.push(row.id);
  return row?.id ?? null;
};

beforeAll(async () => {
  const row = await db.one("SELECT user_type, company_id FROM tbl_users WHERE id = $1", [ADMIN]);
  restoreAdminType = row.user_type;
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);
  adminRoleId = (
    await db.one("SELECT id FROM tbl_roles WHERE title = 'Company Administrator'")
  ).id;
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [ADMIN, restoreAdminType]);
  for (const id of grants) await db.none("DELETE FROM tbl_user_role_scopes WHERE id = $1", [id]);
  await db.none("DELETE FROM tbl_audit_row_changes WHERE table_name IN ('tbl_users','tbl_user_role_scopes')");
  await db.none("DELETE FROM tbl_activity_events");
  await closeDb();
});

describe("administrators are visible in People", () => {
  it("lists an administrator alongside everyone else", async () => {
    const { company_id } = await db.one("SELECT company_id FROM tbl_users WHERE id = $1", [ADMIN]);
    const { users } = await userModel.getCompanyUsersDetailed(company_id, {});
    expect(users.map((u) => Number(u.id))).toContain(ADMIN);
  });

  it("counts an administrator in the stats the cards read", async () => {
    // Part One wired the stat cards to these numbers (UM-8). Excluding admins
    // made "Total Users" quietly wrong.
    const { company_id } = await db.one("SELECT company_id FROM tbl_users WHERE id = $1", [ADMIN]);
    const stats = await userModel.getCompanyUsersStats(company_id);
    const { users } = await userModel.getCompanyUsersDetailed(company_id, {});
    expect(Number(stats.total_count)).toBeGreaterThanOrEqual(users.length);

    const listed = await db.one(
      "SELECT count(*)::int AS n FROM tbl_users WHERE company_id = $1 AND is_deleted = 0",
      [company_id]
    );
    expect(Number(stats.total_count)).toBe(listed.n);
  });

  it("returns an administrator through the API the screen calls", async () => {
    const client = await httpClient(ADMIN);
    const res = await client.get("/api/v1/users/company-users-detailed");
    expect(res.status).toBe(200);
    const ids = (res.body?.data?.users || []).map((u) => Number(u.id));
    expect(ids).toContain(ADMIN);
  });
});

describe("a company cannot be left with no administrator", () => {
  it("recognises the capability granted through the ordinary role flow", async () => {
    // Promotion is not a special endpoint: it is the Company Administrator
    // role, assigned the way every other role is.
    expect(await isCompanyAdmin({ id: BUYER, user_type: 2 })).toBe(false);
    await grant(BUYER);
    expect(await isCompanyAdmin({ id: BUYER, user_type: 2 })).toBe(true);
  });

  it("counts the administrators a company has", async () => {
    const { company_id } = await db.one("SELECT company_id FROM tbl_users WHERE id = $1", [ADMIN]);
    const n = await userModel.countCompanyAdmins(company_id);
    // The legacy user_type 7 account and the newly granted buyer.
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("does not count a soft-deleted administrator", async () => {
    const { company_id } = await db.one("SELECT company_id FROM tbl_users WHERE id = $1", [ADMIN]);
    const before = await userModel.countCompanyAdmins(company_id);

    await db.none("UPDATE tbl_users SET is_deleted = 1 WHERE id = $1", [BUYER]);
    const after = await userModel.countCompanyAdmins(company_id);
    await db.none("UPDATE tbl_users SET is_deleted = 0 WHERE id = $1", [BUYER]);

    expect(after).toBe(before - 1);
  });

  it("refuses to remove the last administrator's capability", async () => {
    const { company_id } = await db.one("SELECT company_id FROM tbl_users WHERE id = $1", [ADMIN]);
    // Reduce the company to exactly one administrator: the granted buyer.
    await db.none("UPDATE tbl_users SET user_type = 2 WHERE id = $1", [ADMIN]);
    expect(await userModel.countCompanyAdmins(company_id)).toBe(1);

    await expect(
      userModel.assertNotLastCompanyAdmin(company_id, BUYER)
    ).rejects.toMatchObject({ code: "LAST_COMPANY_ADMIN" });

    await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);
  });

  it("refuses over HTTP when an administrator would deactivate the last one", async () => {
    // The scenario that actually happens: the only administrator switches
    // themselves off. Nobody left could switch them back on.
    const { company_id } = await db.one("SELECT company_id FROM tbl_users WHERE id = $1", [ADMIN]);
    await db.none(
      "DELETE FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2",
      [BUYER, adminRoleId]
    );
    expect(await userModel.countCompanyAdmins(company_id)).toBe(1);

    const client = await httpClient(ADMIN);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: ADMIN,
      status: 0,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LAST_COMPANY_ADMIN");

    const after = await db.one("SELECT status FROM tbl_users WHERE id = $1", [ADMIN]);
    expect(Number(after.status)).toBe(1);

    await grant(BUYER);
  });

  it("allows removing one when another remains", async () => {
    const { company_id } = await db.one("SELECT company_id FROM tbl_users WHERE id = $1", [ADMIN]);
    expect(await userModel.countCompanyAdmins(company_id)).toBeGreaterThanOrEqual(2);
    await expect(
      userModel.assertNotLastCompanyAdmin(company_id, BUYER)
    ).resolves.toBeUndefined();
  });
});
