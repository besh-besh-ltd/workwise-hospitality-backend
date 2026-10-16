/**
 * Logging in, and resetting a password, with an employee code.
 *
 * Every buyer logs in this way, and until this file nothing tested it.
 *
 * Production, 2026-10-15: a buyer reset his password seven times and every
 * login still said "Password not matched". Two live rows shared his code — his
 * active account and his old, deactivated one. Forgot-password wrote to the
 * FIRST row the database returned; login merged all of them with Object.assign,
 * so it checked the LAST. Heap order put the deactivated row last.
 *
 * The legacy-duplicate tests run twice, once in each physical order, because
 * physical order is exactly what flipped in production; a fix that only works
 * in one order is not a fix.
 *
 * Isolation: commit + cleanup over real HTTP + Postgres (ids 97401-97499).
 */
import bcrypt from "bcryptjs";
import { jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { buildTestApp } from "../setup/app.js";
import { boundRequest, httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { logger } from "../../app/util/logger.js";
import { dropEmployeeCodeIndex, restoreEmployeeCodeIndex } from "../helpers/employeeCodeIndex.js";

const UA = "jest-employee-code-login";
const PROFILE = "/api/v1/users/get-profile";
const ADMIN = IDS.users.companyA_admin;

const DEACTIVATED = "Your account has been deactivated. Please contact your administrator.";
const AMBIGUOUS = "This login is linked to more than one account. Please contact your administrator.";
const NOT_MATCHED = "Password not matched";

const ID_MIN = 97401;
const ID_MAX = 97499;

const hash = (pw) => bcrypt.hashSync(pw, 4);

async function seedAccount({
  id,
  code = null,
  password = `Pw-${id}`,
  status = 1,
  user_type = 2,
  company = IDS.companies.A,
  email = `emp-code-${id}@example.com`,
  is_deleted = 0,
}) {
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, is_deleted, user_type, company_id, employee_code, password, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
    [id, `Account ${id}`, email, status, is_deleted, user_type, company, code, hash(password)]
  );
  return { id, code, password, email };
}

const post = async (path, body) =>
  (await boundRequest(await buildTestApp())).post(path).set("User-Agent", UA).send(body);

const loginWithCode = (employee_code, password) =>
  post("/api/v1/users/login?conform=true", { employee_code, password });
const loginWithEmail = (email, password) =>
  post("/api/v1/users/login?conform=true", { email, password });
const forgotWithCode = (employee_code) => post("/api/v1/users/forgot-password-otp-send", { employee_code });
const forgotWithEmail = (email) => post("/api/v1/users/forgot-password-otp-send", { email });
const resetWithOtp = (otp, password) =>
  post("/api/v1/users/forgot-password-otp-authenticate", { otp, password, confirm_password: password });

const withToken = async (token) =>
  (await boundRequest(await buildTestApp()))
    .get(PROFILE)
    .set("Authorization", `Bearer ${token}`)
    .set("User-Agent", UA);

const otpOf = async (id) => (await db.one("SELECT otp FROM tbl_users WHERE id = $1", [id])).otp;
// Who the session belongs to, asked the way the app would: through the token.
const loggedInAs = async (res) => {
  if (!res.body.token) return null;
  const profile = await withToken(res.body.token);
  return Number(profile.body.data?.id);
};

const expectRefused = (res, message) => {
  expect(res.status).toBe(400);
  expect(res.body.token).toBeUndefined();
  if (message) expect(res.body).toEqual({ status: 2, message });
};

let restoreAdminType;

beforeAll(async () => {
  ({ user_type: restoreAdminType } = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [ADMIN]));
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);
});

afterEach(async () => {
  await db.none("DELETE FROM tbl_login_log WHERE user_id BETWEEN $1 AND $2", [ID_MIN, ID_MAX]);
  await db.none("DELETE FROM tbl_notifications WHERE user_id BETWEEN $1 AND $2", [ID_MIN, ID_MAX]).catch(() => {});
  await db.none("DELETE FROM tbl_users WHERE id BETWEEN $1 AND $2", [ID_MIN, ID_MAX]);
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [ADMIN, restoreAdminType]);
  await db.none("DELETE FROM tbl_audit_row_changes WHERE table_name = 'tbl_users'");
  await db.none("DELETE FROM tbl_activity_events");
  await closeDb();
});

describe("a buyer logs in with their employee code", () => {
  it("logs in as that account with the right password", async () => {
    const a = await seedAccount({ id: 97401, code: "TL-0001" });
    const res = await loginWithCode("TL-0001", a.password);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.token).toBeTruthy();
    expect(await loggedInAs(res)).toBe(a.id);
  });

  it("refuses a wrong password", async () => {
    await seedAccount({ id: 97402, code: "TL-0002" });
    expectRefused(await loginWithCode("TL-0002", "Wrong-Pass1"), NOT_MATCHED);
  });

  it("refuses a code nobody holds", async () => {
    expectRefused(await loginWithCode("TL-NOBODY", "Anything-1"));
  });

  it("does not find a deleted account", async () => {
    const a = await seedAccount({ id: 97403, code: "TL-0003", is_deleted: 1 });
    const res = await loginWithCode("TL-0003", a.password);
    expectRefused(res);
    expect(res.body.message).not.toBe(NOT_MATCHED);
  });

  // User 819 in production: created with a leading space, never able to log in,
  // because the form trims what is typed and the lookup was an exact match.
  it("finds a code stored with stray whitespace", async () => {
    const a = await seedAccount({ id: 97404, code: " TL-0004" });
    const res = await loginWithCode("TL-0004", a.password);
    expect(res.status).toBe(200);
    expect(await loggedInAs(res)).toBe(a.id);
  });

  it("matches the code whatever case and surrounding spaces are typed", async () => {
    const a = await seedAccount({ id: 97405, code: "TL-AB05" });
    for (const typed of ["tl-ab05", "  TL-AB05  ", "Tl-Ab05"]) {
      const res = await loginWithCode(typed, a.password);
      expect(res.status).toBe(200);
      expect(await loggedInAs(res)).toBe(a.id);
    }
  });

  it("tells a deactivated buyer their account is deactivated — only once they prove the password", async () => {
    const a = await seedAccount({ id: 97406, code: "TL-0006", status: 0 });
    expectRefused(await loginWithCode("TL-0006", a.password), DEACTIVATED);
    // Without the password, nothing about the account's state is disclosed.
    expectRefused(await loginWithCode("TL-0006", "Wrong-Pass1"), NOT_MATCHED);
  });

  it("tells a deactivated company administrator the same, on their email login", async () => {
    const a = await seedAccount({ id: 97407, user_type: 7, status: 0 });
    expectRefused(await loginWithEmail(a.email, a.password), DEACTIVATED);
  });

  // Codes compare trimmed, so a blank code typed as spaces must mean "no code"
  // — never "every account whose code is blank". Blank codes are legal and
  // deliberately outside the unique index.
  it("treats a code of only spaces as no code at all, never as a match for blank-coded accounts", async () => {
    const solo = await seedAccount({ id: 97409, code: "" });
    expectRefused(await loginWithCode("   ", solo.password));

    await seedAccount({ id: 97410, code: "  " });
    const errorSpy = jest.spyOn(logger, "error");
    try {
      const res = await loginWithCode("   ", solo.password);
      expectRefused(res);
      expect(res.body.message).not.toBe(AMBIGUOUS);
      expect(errorSpy.mock.calls.some(([obj]) => Array.isArray(obj?.accountIds))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }

    const forgot = await forgotWithCode("   ");
    expect(forgot.status).toBe(400);
    expect(await otpOf(solo.id)).toBeNull();
    expect(await otpOf(97410)).toBeNull();
  });

  it("still refuses a buyer's email login (employee code only)", async () => {
    const a = await seedAccount({ id: 97408, code: "TL-0008" });
    const res = await loginWithEmail(a.email, a.password);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Employee Code/);
  });
});

describe("vendors are untouched", () => {
  it("a vendor at status 0 still hears 'not approved by admin', never 'deactivated'", async () => {
    const v = await seedAccount({ id: 97411, user_type: 3, status: 0, company: IDS.companies.vendorAlpha });
    expectRefused(await loginWithEmail(v.email, v.password), "User not approved by admin");
  });

  it("an active vendor logs in by email", async () => {
    const v = await seedAccount({ id: 97412, user_type: 3, company: IDS.companies.vendorAlpha });
    const res = await loginWithEmail(v.email, v.password);
    expect(res.status).toBe(200);
    expect(await loggedInAs(res)).toBe(v.id);
  });
});

describe("rows that share a code, as production held them before the unique index", () => {
  let indexDef;
  beforeAll(async () => {
    indexDef = await dropEmployeeCodeIndex();
  });
  afterAll(async () => {
    await db.none("DELETE FROM tbl_users WHERE id BETWEEN $1 AND $2", [ID_MIN, ID_MAX]);
    await restoreEmployeeCodeIndex(indexDef);
  });

  // Inserted in this order, with ids ascending, so the database returns them in
  // this order: the first case is production's (deactivated row last).
  const ORDERS = [
    ["the deactivated row comes last (production's order)", { active: 97421, deactivated: 97422 }, ["active", "deactivated"]],
    ["the deactivated row comes first", { active: 97424, deactivated: 97423 }, ["deactivated", "active"]],
  ];

  async function seedPair(code, ids, insertOrder) {
    const spec = {
      active: { id: ids.active, code, status: 1 },
      deactivated: { id: ids.deactivated, code, status: 0 },
    };
    const seeded = {};
    for (const which of insertOrder) seeded[which] = await seedAccount(spec[which]);
    // Insertion order alone does not decide where a row lands: earlier suites
    // in the same database leave free space that new rows fill. Rewriting the
    // table in primary-key order makes the heap order the id order — and the
    // ids above are chosen so that is the order each case claims.
    await db.none("CLUSTER tbl_users USING tbl_users_pkey");
    // Prove the setup reproduces the order it claims to.
    const natural = await db.map(
      "SELECT id FROM tbl_users WHERE employee_code = $1",
      [code],
      (r) => Number(r.id)
    );
    expect(natural).toEqual(insertOrder.map((w) => seeded[w].id));
    return seeded;
  }

  describe.each(ORDERS)("when %s", (_label, ids, insertOrder) => {
    it("logs in as the active account with its password", async () => {
      const { active } = await seedPair("TL-PAIR", ids, insertOrder);
      const res = await loginWithCode("TL-PAIR", active.password);
      expect(res.status).toBe(200);
      expect(await loggedInAs(res)).toBe(active.id);
    });

    it("never logs in to the deactivated account", async () => {
      const { deactivated } = await seedPair("TL-PAIR", ids, insertOrder);
      expectRefused(await loginWithCode("TL-PAIR", deactivated.password), NOT_MATCHED);
    });

    // The ticket, end to end. Note that the reset's own UPDATE can move the
    // row it writes to elsewhere in the heap, flipping the order mid-test —
    // the same flip production saw, the other way round. Against the old code
    // this fails in one order or the other; only an order-free rule passes both.
    it("a password reset by code lands on the active account, and that password then logs in", async () => {
      const { active, deactivated } = await seedPair("TL-PAIR", ids, insertOrder);

      const sent = await forgotWithCode("TL-PAIR");
      expect(sent.status).toBe(200);
      const otp = await otpOf(active.id);
      expect(otp).toBeTruthy();
      expect(await otpOf(deactivated.id)).toBeNull();

      const NEW = "Fresh@9876";
      const reset = await resetWithOtp(otp, NEW);
      expect(reset.status).toBe(200);

      const res = await loginWithCode("TL-PAIR", NEW);
      expect(res.status).toBe(200);
      expect(await loggedInAs(res)).toBe(active.id);
    });
  });

  describe("two active accounts share a code", () => {
    it("refuses either password, logs it, and issues no token", async () => {
      const errorSpy = jest.spyOn(logger, "error");
      const a = await seedAccount({ id: 97431, code: "TL-TWIN" });
      const b = await seedAccount({ id: 97432, code: "TL-TWIN" });
      try {
        expectRefused(await loginWithCode("TL-TWIN", a.password), AMBIGUOUS);
        expectRefused(await loginWithCode("TL-TWIN", b.password), AMBIGUOUS);
        const logged = errorSpy.mock.calls.some(
          ([obj]) => obj && Array.isArray(obj.accountIds) && obj.accountIds.includes(a.id) && obj.accountIds.includes(b.id)
        );
        expect(logged).toBe(true);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("refuses a password reset and writes an OTP to neither", async () => {
      const a = await seedAccount({ id: 97433, code: "TL-TWIN2" });
      const b = await seedAccount({ id: 97434, code: "TL-TWIN2" });
      const res = await forgotWithCode("TL-TWIN2");
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ status: 0, code: "LOGIN_AMBIGUOUS", message: AMBIGUOUS });
      expect(await otpOf(a.id)).toBeNull();
      expect(await otpOf(b.id)).toBeNull();
    });
  });

  it("refuses a code shared only by deactivated accounts", async () => {
    const a = await seedAccount({ id: 97435, code: "TL-GONE", status: 0 });
    await seedAccount({ id: 97436, code: "TL-GONE", status: 0 });
    expectRefused(await loginWithCode("TL-GONE", a.password), AMBIGUOUS);
  });
});

describe("forgot-password", () => {
  it("refuses a deactivated buyer and sends nothing", async () => {
    const a = await seedAccount({ id: 97441, code: "TL-0041", status: 0 });
    const res = await forgotWithCode("TL-0041");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ status: 0, code: "ACCOUNT_DEACTIVATED", message: DEACTIVATED });
    expect(await otpOf(a.id)).toBeNull();
  });

  it("still sends a code to an active buyer", async () => {
    const a = await seedAccount({ id: 97442, code: "TL-0042" });
    const res = await forgotWithCode("tl-0042 ");
    expect(res.status).toBe(200);
    expect(await otpOf(a.id)).toBeTruthy();
  });

  it("says a code nobody holds was not found", async () => {
    const res = await forgotWithCode("TL-NOBODY");
    expect(res.status).toBe(400);
    expect(res.body.errors?.user_name).toBe("Employee code not found");
  });

  // The OTP used to be written WHERE email = ..., stamping every row with that
  // address — including a deactivated twin, which the reset then also changed.
  it("writes the OTP to the one resolved account even when another row shares its email", async () => {
    const shared = "shared-inbox@example.com";
    let indexDef;
    try {
      indexDef = await dropEmployeeCodeIndex();
      const active = await seedAccount({ id: 97443, email: shared, user_type: 3, company: IDS.companies.vendorAlpha });
      const twin = await seedAccount({ id: 97444, email: shared, user_type: 3, status: 0, company: IDS.companies.vendorAlpha });
      const res = await forgotWithEmail(shared);
      expect(res.status).toBe(200);
      expect(await otpOf(active.id)).toBeTruthy();
      expect(await otpOf(twin.id)).toBeNull();
    } finally {
      await restoreEmployeeCodeIndex(indexDef);
    }
  });
});

describe("a deactivated company account's session", () => {
  const deactivate = async (id, status) => {
    const client = await httpClient(ADMIN);
    return client
      .put("/api/v1/users/update-user-detail")
      .send({ user_id: id, status, confirmed_approval_impact: true });
  };

  it("ends on the next request once an administrator deactivates the account", async () => {
    const a = await seedAccount({ id: 97451, code: "TL-0051" });
    const { body } = await loginWithCode("TL-0051", a.password);
    expect((await withToken(body.token)).status).toBe(200);

    expect((await deactivate(a.id, 0)).status).toBe(200);

    expect((await withToken(body.token)).status).toBe(401);
  });

  it("comes back after reactivation, with the same password", async () => {
    const a = await seedAccount({ id: 97452, code: "TL-0052", status: 0 });
    expect((await deactivate(a.id, 1)).status).toBe(200);

    const res = await loginWithCode("TL-0052", a.password);
    expect(res.status).toBe(200);
    expect((await withToken(res.body.token)).status).toBe(200);
  });

  it("is not applied to vendors, whose status 0 means pending, not deactivated", async () => {
    const v = await seedAccount({ id: 97453, user_type: 3, company: IDS.companies.vendorAlpha });
    const { body } = await loginWithEmail(v.email, v.password);
    await db.none("UPDATE tbl_users SET status = 0 WHERE id = $1", [v.id]);
    expect((await withToken(body.token)).status).toBe(200);
  });
});
