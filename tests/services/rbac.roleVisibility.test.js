/**
 * A custom role belongs to the company, not to whoever happened to create it.
 *
 * `GET /rbac/roles` filtered on `created_by IS NULL OR created_by = $1`, where
 * $1 is the CALLING user. So a role Admin A created was invisible to Admin B
 * of the same company: the Access page's "Your roles" section read 0 for
 * everyone except the author, while the same role still appeared in the
 * assignment dropdowns — which is what made the roles screen look broken when
 * it was actually the query.
 *
 * Visibility widens rather than narrows: system roles, roles you created, and
 * roles created by anyone in your company. Nobody loses sight of a role they
 * could see before — including the legacy rows whose creator has no company at
 * all.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

const ADMIN_A = IDS.users.companyA_admin;
const BUYER_A = IDS.users.a1_proc_buyer;
const ADMIN_B = IDS.users.companyB_admin;

const made = [];
const restoredTypes = new Map();

/**
 * The route is gated acl([7, 2]). Fixture users are not administrators by
 * default, so promote the callers for the duration — otherwise every
 * assertion here would pass or fail on a 403 from the route gate rather than
 * on the visibility rule under test.
 */
const asAdmin = async (userId) => {
  if (restoredTypes.has(userId)) return;
  const { user_type } = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [userId]);
  restoredTypes.set(userId, user_type);
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [userId]);
};

const makeRole = async (title, createdBy) => {
  const row = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by)
     VALUES ($1, 'Created by a role-visibility test', $2) RETURNING id`,
    [title, createdBy]
  );
  made.push(Number(row.id));
  return Number(row.id);
};

const roleIdsVisibleTo = async (userId) => {
  const client = await httpClient(userId);
  const res = await client.get("/api/v1/rbac/roles");
  expect(res.status).toBe(200);
  return (res.body.data || []).map((r) => Number(r.id));
};

beforeAll(async () => {
  await asAdmin(ADMIN_A);
  await asAdmin(ADMIN_B);
  await asAdmin(BUYER_A);
});

afterAll(async () => {
  if (made.length) {
    await db.none(`DELETE FROM tbl_roles WHERE id = ANY($1::int[])`, [made]);
  }
  for (const [userId, userType] of restoredTypes) {
    await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [userId, userType]);
  }
  await closeDb();
});

describe("who can see a custom role", () => {
  it("shows a colleague's custom role to another admin in the same company", async () => {
    const roleId = await makeRole("Visibility probe — made by a buyer", BUYER_A);

    // The defect: this was visible only to BUYER_A.
    expect(await roleIdsVisibleTo(ADMIN_A)).toContain(roleId);
  });

  it("still shows you the role you created yourself", async () => {
    const roleId = await makeRole("Visibility probe — made by admin A", ADMIN_A);
    expect(await roleIdsVisibleTo(ADMIN_A)).toContain(roleId);
  });

  it("does not leak a custom role across companies", async () => {
    const roleId = await makeRole("Visibility probe — company A only", ADMIN_A);
    expect(await roleIdsVisibleTo(ADMIN_B)).not.toContain(roleId);
  });

  it("keeps showing the built-in roles to everyone", async () => {
    const visible = await roleIdsVisibleTo(ADMIN_B);
    const systemIds = await db.map(
      `SELECT id FROM tbl_roles WHERE created_by IS NULL`, [], (r) => Number(r.id)
    );
    expect(systemIds.length).toBeGreaterThan(0);
    systemIds.forEach((id) => expect(visible).toContain(id));
  });

  it("does not hide a legacy role whose creator has no company", async () => {
    // Widening must not cost anyone a role they can see today. A creator with
    // a NULL company_id would drop out of a plain company join.
    const orphanCreator = await db.oneOrNone(
      `SELECT id FROM tbl_users WHERE company_id IS NULL ORDER BY id LIMIT 1`
    );
    if (!orphanCreator) return; // nothing to prove on this dataset

    await asAdmin(orphanCreator.id);
    const roleId = await makeRole("Visibility probe — creator has no company", orphanCreator.id);
    expect(await roleIdsVisibleTo(orphanCreator.id)).toContain(roleId);
  });
});
