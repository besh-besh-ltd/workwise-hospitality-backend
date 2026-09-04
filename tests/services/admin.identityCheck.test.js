/**
 * Real-time duplicate checking on account creation (UM-1).
 *
 * Duplicates were only caught on submit, after the whole form had been filled
 * in, and the message came back as a generic error. Production already holds
 * four duplicated emails and six duplicated mobile numbers — one of them on
 * four separate accounts — so this is not hypothetical.
 *
 * The check is also case-insensitive, which the submit-time one is not: it
 * compares `email = $1` against a lowercased input, so a stored
 * "Priya@example.com" never matches "priya@example.com" and both accounts are
 * created.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

const ADMIN = IDS.users.companyA_admin;
const PROBE_ID = 979001;
let restoreUserType;

beforeAll(async () => {
  const row = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [ADMIN]);
  restoreUserType = row.user_type;
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);

  await db.none(
    `INSERT INTO tbl_users (id, name, email, mobile, user_type, status, is_deleted)
     VALUES ($1, 'Identity Probe', 'Probe.Person@Example.com', '+91-9000000001', 2, 1, 0)
     ON CONFLICT (id) DO NOTHING`,
    [PROBE_ID]
  );
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [ADMIN, restoreUserType]);
  await db.none("DELETE FROM tbl_users WHERE id = $1", [PROBE_ID]);
  await db.none("DELETE FROM tbl_audit_row_changes WHERE table_name = 'tbl_users'");
  await db.none("DELETE FROM tbl_activity_events");
  await closeDb();
});

describe("identity availability", () => {
  it("reports an email that is already in use", async () => {
    const client = await httpClient(ADMIN);
    const res = await client.get(
      "/api/v1/users/check-identity?email=Probe.Person@Example.com"
    );
    expect(res.status).toBe(200);
    expect(res.body.data.email.taken).toBe(true);
  });

  it("matches regardless of case, which the submit-time check does not", async () => {
    // The stored value is "Probe.Person@Example.com". Comparing it to a
    // lowercased input with `=` misses, and two accounts get created.
    const client = await httpClient(ADMIN);
    const res = await client.get(
      "/api/v1/users/check-identity?email=probe.person@example.com"
    );
    expect(res.body.data.email.taken).toBe(true);
  });

  it("reports a mobile number that is already in use", async () => {
    const client = await httpClient(ADMIN);
    const res = await client.get(
      "/api/v1/users/check-identity?mobile=%2B91-9000000001"
    );
    expect(res.body.data.mobile.taken).toBe(true);
  });

  it("says an unused address is free", async () => {
    const client = await httpClient(ADMIN);
    const res = await client.get(
      "/api/v1/users/check-identity?email=nobody-at-all@example.com&mobile=%2B91-9000000999"
    );
    expect(res.body.data.email.taken).toBe(false);
    expect(res.body.data.mobile.taken).toBe(false);
  });

  it("does not flag a user against their own details when editing", async () => {
    // Otherwise every edit of an existing account reports its own email as
    // taken, and the admin learns to ignore the warning.
    const client = await httpClient(ADMIN);
    const res = await client.get(
      `/api/v1/users/check-identity?email=Probe.Person@Example.com&exclude_user_id=${PROBE_ID}`
    );
    expect(res.body.data.email.taken).toBe(false);
  });

  it("answers with nothing asked rather than erroring", async () => {
    const client = await httpClient(ADMIN);
    const res = await client.get("/api/v1/users/check-identity");
    expect(res.status).toBe(200);
    expect(res.body.data.email.taken).toBe(false);
    expect(res.body.data.mobile.taken).toBe(false);
  });

  it("never returns anything about the account it found", async () => {
    // This endpoint answers "is this taken", nothing more. Returning the
    // matching user would make an authenticated directory-enumeration tool
    // out of a form-validation helper.
    const client = await httpClient(ADMIN);
    const res = await client.get(
      "/api/v1/users/check-identity?email=Probe.Person@Example.com"
    );
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/Identity Probe/);
    expect(body).not.toMatch(String(PROBE_ID));
  });

  it("refuses a caller who is not a company admin", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get("/api/v1/users/check-identity?email=x@y.z");
    expect(res.status).toBe(403);
  });
});
