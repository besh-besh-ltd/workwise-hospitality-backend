/**
 * What kind of account a company admin may create (T0).
 *
 * `POST /users/create-buyer-company-user` is gated `acl([7])` and carries no
 * body validation at all — only a duplicate-identity check. The controller
 * destructures `user_type` straight from the request and inserts it
 * (`usersController.js:954, 975`) with no allow-list.
 *
 * That is a live privilege-escalation hole rather than a missing feature. The
 * code treats `user_type = 8` as unrestricted across every tenant —
 * `if (Number(loggedInUser?.user_type) === 8) return [];`
 * (`usersController.js:151`), whose own comment warns that widening admin
 * checks to include 8 "would hand type-8 a cross-tenant write". Any company
 * admin can currently mint one.
 *
 * It has never been reachable in practice only because the frontend hardcodes
 * `user_type: "2"` (`create-account.js:158`) — which is exactly the protection
 * T0 removes when it lets admins create admins.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

const ADMIN = IDS.users.companyA_admin;
let restoreUserType;
const created = [];

const newAccount = (overrides = {}) => ({
  name: "Account Type Probe",
  email: `probe-${Math.random().toString(36).slice(2, 10)}@example.com`,
  mobile: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
  password: "Str0ng!Pass1",
  ...overrides,
});

beforeAll(async () => {
  const row = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [ADMIN]);
  restoreUserType = row.user_type;
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [ADMIN, restoreUserType]);
  await db.none("DELETE FROM tbl_users WHERE email LIKE 'probe-%@example.com'");
  await db.none("DELETE FROM tbl_audit_row_changes WHERE table_name = 'tbl_users'");
  await db.none("DELETE FROM tbl_activity_events");
  await closeDb();
});

const accountFor = (email) =>
  db.oneOrNone("SELECT id, user_type FROM tbl_users WHERE email = $1", [email]);

describe("account types a company admin may create", () => {
  it("refuses to create a cross-tenant super admin", async () => {
    // user_type 8 bypasses company scoping entirely. No company admin should
    // ever be able to mint one, whatever they put in the request body.
    const client = await httpClient(ADMIN);
    const payload = newAccount({ user_type: 8 });

    const res = await client.post("/api/v1/users/create-buyer-company-user").send(payload);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await accountFor(payload.email)).toBeNull();
  });

  it("refuses a vendor account from the buyer admin screen", async () => {
    // Vendors are onboarded through their own flow; creating one here would
    // put a supplier inside the buyer's own user list.
    const client = await httpClient(ADMIN);
    const payload = newAccount({ user_type: 3 });

    const res = await client.post("/api/v1/users/create-buyer-company-user").send(payload);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await accountFor(payload.email)).toBeNull();
  });

  it("refuses an unrecognised account type rather than storing it", async () => {
    const client = await httpClient(ADMIN);
    const payload = newAccount({ user_type: 99 });

    const res = await client.post("/api/v1/users/create-buyer-company-user").send(payload);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await accountFor(payload.email)).toBeNull();
  });

  it("still creates an ordinary buyer", async () => {
    const client = await httpClient(ADMIN);
    const payload = newAccount({ user_type: 2 });

    const res = await client.post("/api/v1/users/create-buyer-company-user").send(payload);
    expect(res.status).toBeLessThan(400);

    const account = await accountFor(payload.email);
    expect(account).not.toBeNull();
    expect(Number(account.user_type)).toBe(2);
    created.push(account.id);
  });

  it("defaults to a buyer when no type is given", async () => {
    // The frontend has always hardcoded "2". Omitting it must not fall through
    // to NULL, which `acl()` would then compare against every whitelist.
    const client = await httpClient(ADMIN);
    const payload = newAccount();

    const res = await client.post("/api/v1/users/create-buyer-company-user").send(payload);
    expect(res.status).toBeLessThan(400);

    const account = await accountFor(payload.email);
    expect(Number(account.user_type)).toBe(2);
    created.push(account.id);
  });
});
