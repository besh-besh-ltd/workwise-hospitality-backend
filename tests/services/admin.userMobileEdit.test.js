/**
 * A company admin editing a user's details must not be broken by the shape of
 * the mobile number already on file.
 *
 * Reported 2026-10-13: an admin changing a user's employee ID and contact
 * number got "An internal error has occurred. Please try again later." The
 * employee ID was not the problem. The production trace shows the UPDATE
 * failing with Postgres 22001 —
 *
 *     mobile = '9876500001-9876500001'
 *     value too long for type character varying(15)
 *
 * — at the end of a chain three screens and eight months long:
 *
 *   1. A bulk HR import stored bare numbers ("9876500001"), not the
 *      "+91-9876500001" every edit screen assumes. 87 users, one tenant.
 *   2. The self-profile page splits on "-": a bare number became country code
 *      "9876500001" with a blank number field, and saving wrote "9876500001-".
 *   3. The admin modal splits on "-" too. "9876500001-" gave it the same bogus
 *      country code and a blank field; the admin typed the number in and the
 *      form glued them back together into 21 characters.
 *
 * Every layer trusted the next one: the frontend had no length rule, the Joi
 * schema was a bare `Joi.string()`, and the database — the only real check —
 * had its error caught and re-worded into a generic sentence.
 *
 * Nothing here was caught before because the fixture users have NO mobile at
 * all, and the one test that sent one sent a clean "9000000057". These tests
 * use the exact shapes found in production.
 *
 * Isolation: Pattern B (commit + cleanup) over real HTTP + Postgres.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import Config from "../../app/config/app.config.js";
import { schemas } from "../../app/validations/paramValidation/userValidation.js";

const ADMIN = IDS.users.companyA_admin;
const TARGET = IDS.users.a1_proc_techEval;
const GENERIC = Config.errorText.value;

let restoreAdminType;
let original;

const setStored = (fields) =>
  db.none(
    `UPDATE tbl_users SET ${Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`,
    [TARGET, ...Object.values(fields)]
  );
const stored = () =>
  db.one("SELECT mobile, employee_code, employee_type, name FROM tbl_users WHERE id = $1", [TARGET]);

const adminEdit = async (body) => {
  const client = await httpClient(ADMIN);
  return client.put("/api/v1/users/update-user-detail").send({ user_id: TARGET, ...body });
};

beforeAll(async () => {
  ({ user_type: restoreAdminType } = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [ADMIN]));
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);
  original = await db.one(
    "SELECT mobile, employee_code, employee_type, name, email FROM tbl_users WHERE id = $1",
    [TARGET]
  );
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [ADMIN, restoreAdminType]);
  await db.none(
    `UPDATE tbl_users SET mobile = $2, employee_code = $3, employee_type = $4, name = $5, email = $6 WHERE id = $1`,
    [TARGET, original.mobile, original.employee_code, original.employee_type, original.name, original.email]
  );
  await db.none("DELETE FROM tbl_users WHERE email LIKE 'mobile-probe-%@example.com'");
  await db.none("DELETE FROM tbl_audit_row_changes WHERE table_name = 'tbl_users'");
  await db.none("DELETE FROM tbl_activity_events");
  await closeDb();
});

describe("an admin edits a user whose stored mobile is in a legacy shape", () => {
  it("refuses the exact production payload with a sentence about the mobile, not 'an internal error'", async () => {
    await setStored({ mobile: "9876500001-", employee_code: "EMP0001" });

    // The same shape as the failing request's UPDATE statement.
    const res = await adminEdit({
      name: "Test Account",
      email: "tech.evaluator@example.com",
      mobile: "9876500001-9876500001",
      employee_type: "full-time",
      employee_code: "EMP0002",
      status: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).not.toBe(GENERIC);
    expect(res.body.message).toMatch(/mobile/i);
    // Refused before the database: nothing half-applied.
    const row = await stored();
    expect(row.mobile).toBe("9876500001-");
    expect(row.employee_code).toBe("EMP0001");
  });

  it("saves what the admin meant: the corrected number AND the new employee ID", async () => {
    await setStored({ mobile: "9876500001-", employee_code: "EMP0001" });

    const res = await adminEdit({ mobile: "+91-9876500001", employee_code: "EMP0002" });

    expect(res.status).toBe(200);
    const row = await stored();
    expect(row.mobile).toBe("+91-9876500001");
    expect(row.employee_code).toBe("EMP0002");
  });

  it.each([
    ["bare number from the bulk import", "9876500001", "+91-9876500001"],
    ["trailing hyphen written by the self-profile page", "9876500001-", "+91-9876500001"],
    ["space-formatted", "+91-75077 69010", "+91-7507769010"],
    ["space instead of hyphen after the code", "+91 9876543210", "+91-9876543210"],
    ["domestic trunk prefix", "09876543210", "+91-9876543210"],
    ["non-Indian code", "+1-9540095143", "+1-9540095143"],
    // Offered by the country picker (tbl_country_code), so it must be accepted.
    ["six-digit country code", "+441481-123456", "+441481-123456"],
  ])("stores a %s as the canonical form", async (_label, sent, expected) => {
    const res = await adminEdit({ mobile: sent });

    expect(res.status).toBe(200);
    expect((await stored()).mobile).toBe(expected);
  });

  it("clears the number when the field is left blank, instead of storing '+91-'", async () => {
    await setStored({ mobile: "+91-9876543210" });

    const res = await adminEdit({ mobile: "+91-" });

    expect(res.status).toBe(200);
    expect((await stored()).mobile).toBeNull();
  });
});

describe("the user editing their own profile — the page that wrote the corrupt value", () => {
  it("heals '9876500001-' into the canonical form instead of storing it", async () => {
    // What the old self-profile page sends for a bare-number user who saves
    // without retyping the number. An already-open browser keeps sending it
    // until it reloads, so the server has to cope, not just the new screen.
    await setStored({ mobile: "9876500001" });
    const client = await httpClient(TARGET);

    const res = await client.put("/api/v1/users/update-user-detail/").send({ mobile: "9876500001-" });

    expect(res.status).toBe(200);
    expect((await stored()).mobile).toBe("+91-9876500001");
  });
});

describe("values the columns cannot hold are refused before the database", () => {
  it("rejects an employee code longer than the column, naming the field", async () => {
    const res = await adminEdit({ employee_code: "E".repeat(100) });

    expect(res.status).toBe(400);
    expect(res.body.message).not.toBe(GENERIC);
    expect(res.body.message).toMatch(/employee code/i);
  });

  it("rejects an employee type the enum does not have", async () => {
    const res = await adminEdit({ employee_type: "intern" });

    expect(res.status).toBe(400);
    expect(res.body.message).not.toBe(GENERIC);
    expect(res.body.message).toMatch(/employee type/i);
  });
});

describe("creating a user", () => {
  const newAccount = (mobile) => ({
    name: "Mobile Probe",
    email: `mobile-probe-${Math.random().toString(36).slice(2, 10)}@example.com`,
    mobile,
    password: "Str0ng!Pass1",
  });
  const mobileOf = async (email) =>
    (await db.oneOrNone("SELECT mobile FROM tbl_users WHERE email = $1", [email]))?.mobile;

  it("refuses a mobile the column cannot hold, with a mobile sentence", async () => {
    const client = await httpClient(ADMIN);
    const payload = newAccount("9876500001-9876500001");

    const res = await client.post("/api/v1/users/create-buyer-company-user").send(payload);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/mobile/i);
    expect(await mobileOf(payload.email)).toBeUndefined();
  });

  it("stores a bare number in the canonical form", async () => {
    const client = await httpClient(ADMIN);
    const payload = newAccount("9876543210");

    const res = await client.post("/api/v1/users/create-buyer-company-user").send(payload);

    expect(res.status).toBeLessThan(300);
    expect(await mobileOf(payload.email)).toBe("+91-9876543210");
  });
});

// The structural guard. The bug existed because a request schema let through
// values its database column could not hold, and the only thing between them
// was an error message. This reads the REAL column sizes from the test
// database, so if either side changes without the other, it fails here
// instead of in front of an admin.
describe("request schemas never accept more than tbl_users can store", () => {
  const FIELDS = ["name", "mobile", "employee_code", "designation"];
  let columnLength;

  beforeAll(async () => {
    const rows = await db.any(
      `SELECT column_name, character_maximum_length AS len
         FROM information_schema.columns
        WHERE table_name = 'tbl_users' AND column_name = ANY($1)`,
      [FIELDS]
    );
    columnLength = Object.fromEntries(rows.map((r) => [r.column_name, Number(r.len)]));
  });

  // A value exactly at the limit, and one character over. Mobile has to be a
  // valid number to be accepted at all, so it gets its own pair.
  const atLimit = (field, len) => (field === "mobile" ? "+91-12345678901" : "x".repeat(len));
  const overLimit = (field, len) => (field === "mobile" ? "+91-123456789012" : "x".repeat(len + 1));

  it.each([
    ["update_profile", {}],
    ["create_buyer_company_user", { name: "n", email: "a@b.co", mobile: "+91-9876543210" }],
  ])("%s", (schemaName, base) => {
    const schema = schemas[schemaName];
    for (const field of FIELDS) {
      if (!schema.describe().keys[field]) continue;
      const len = columnLength[field];
      expect(len).toBeGreaterThan(0);

      const ok = schema.validate({ ...base, [field]: atLimit(field, len) }, { abortEarly: false });
      expect({ field, error: ok.error?.message }).toEqual({ field, error: undefined });

      const tooLong = schema.validate({ ...base, [field]: overLimit(field, len) }, { abortEarly: false });
      expect({ field, rejected: Boolean(tooLong.error) }).toEqual({ field, rejected: true });
    }
  });
});
