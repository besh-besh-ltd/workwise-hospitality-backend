// SECURITY — admin password change and reset (/api/v1/admin/auth/*).
// ----------------------------------------------------------------------------
// The admin panel shipped with no way to change a password: `/admin/auth`
// exposed only login and admin-profile. A locked-out admin needed their row
// edited by hand, and no admin could rotate a credential.
//
// The obvious move was to copy the user-side flow. It should not be copied.
// `POST /user/change-password` overwrites the password on JWT alone with no
// current-password check, and the forgot flow resets by matching a bare 6-digit
// OTP — `update tbl_users set password = $2 where otp = $1` — with no email
// binding, no expiry, and no single-use marker (the clear step is commented
// out). One captured number re-takes that account permanently.
//
// So the admin endpoints are built to a different standard, and these tests pin
// the properties that make them different:
//
//   - change-password proves knowledge of the current password, not just token
//     possession
//   - the reset token is random, stored only as a SHA-256 digest, expiring and
//     single-use
//   - forgot-password answers identically for known and unknown addresses, so
//     it cannot be used to enumerate admin accounts
//
// Product-level tests over real HTTP.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { loginAsInternalStaff, stampAdmin } from "../helpers/auth.js";

const CHANGE = "/api/v1/admin/auth/change-password";
const FORGOT = "/api/v1/admin/auth/forgot-password";
const RESET = "/api/v1/admin/auth/reset-password";

const ADMIN = IDS.users.superAdmin;
const CURRENT_PASSWORD = "CurrentPass123";
const NEW_PASSWORD = "BrandNewPass456";

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

const passwordHashOf = async (userId) => {
  const row = await db.one(`SELECT password FROM tbl_users WHERE id = $1`, [userId]);
  return row.password;
};

const resetStateOf = async (userId) => {
  return db.one(
    `SELECT pwd_reset_token_hash, pwd_reset_expires_at, pwd_reset_used_at,
            pwd_reset_attempts
       FROM tbl_users WHERE id = $1`,
    [userId]
  );
};

let prevUserType;
let prevPassword;
let adminEmail;
let adminClient;

beforeAll(async () => {
  prevUserType = await stampAdmin(ADMIN, 1);
  prevPassword = await passwordHashOf(ADMIN);
  const row = await db.one(`SELECT email FROM tbl_users WHERE id = $1`, [ADMIN]);
  adminEmail = row.email;
  adminClient = await httpClient(null);
  const { headers } = await loginAsInternalStaff(ADMIN);
  adminClient.headers = headers;
});

afterAll(async () => {
  await db.none(
    `UPDATE tbl_users
        SET user_type = $2, password = $3,
            pwd_reset_token_hash = NULL, pwd_reset_expires_at = NULL,
            pwd_reset_used_at = NULL, pwd_reset_attempts = 0
      WHERE id = $1`,
    [ADMIN, prevUserType, prevPassword]
  );
  await closeDb();
});

// Every test starts from a known password and no reset in flight.
beforeEach(async () => {
  await db.none(
    `UPDATE tbl_users
        SET password = $2,
            pwd_reset_token_hash = NULL, pwd_reset_expires_at = NULL,
            pwd_reset_used_at = NULL, pwd_reset_attempts = 0
      WHERE id = $1`,
    [ADMIN, bcrypt.hashSync(CURRENT_PASSWORD, bcrypt.genSaltSync(10))]
  );
});

const asAdmin = (path) => {
  let req = adminClient.post(path);
  for (const [k, v] of Object.entries(adminClient.headers)) req = req.set(k, v);
  return req;
};

// ---------------------------------------------------------------------------
describe("POST /admin/auth/change-password", () => {
  it("changes the password when the current one is proved", async () => {
    const before = await passwordHashOf(ADMIN);

    const res = await asAdmin(CHANGE).send({
      current_password: CURRENT_PASSWORD,
      password: NEW_PASSWORD,
      confirm_password: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const after = await passwordHashOf(ADMIN);
    expect(after).not.toBe(before);
    // The stored value is a bcrypt hash of the new password, never the plaintext.
    expect(after).not.toContain(NEW_PASSWORD);
    expect(await bcrypt.compare(NEW_PASSWORD, after)).toBe(true);
    // The old password stops working the moment the new one lands.
    expect(await bcrypt.compare(CURRENT_PASSWORD, after)).toBe(false);
  });

  it("refuses a wrong current password and leaves the stored hash untouched", async () => {
    const before = await passwordHashOf(ADMIN);

    const res = await asAdmin(CHANGE).send({
      current_password: "NotTheCurrentOne1",
      password: NEW_PASSWORD,
      confirm_password: NEW_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe(0);
    expect(res.body.message).toMatch(/current password is incorrect/i);
    // The regression this guards: a stolen token alone must not rotate the
    // credential, which is exactly what the user-side endpoint permits.
    expect(await passwordHashOf(ADMIN)).toBe(before);
  });

  it("refuses to set the new password equal to the current one", async () => {
    const res = await asAdmin(CHANGE).send({
      current_password: CURRENT_PASSWORD,
      password: CURRENT_PASSWORD,
      confirm_password: CURRENT_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe(0);
    expect(res.body.message).toMatch(/different/i);
  });

  it("refuses a mismatched confirmation", async () => {
    const before = await passwordHashOf(ADMIN);
    const res = await asAdmin(CHANGE).send({
      current_password: CURRENT_PASSWORD,
      password: NEW_PASSWORD,
      confirm_password: "SomethingElse789",
    });

    expect(res.status).toBe(400);
    expect(await passwordHashOf(ADMIN)).toBe(before);
  });

  // The user-side schema is min(3).max(15); admin accounts read every tenant's
  // data, so "abc" must not be reachable here.
  it.each([
    ["too short", "Ab1"],
    ["no uppercase", "lowercase123"],
    ["no lowercase", "UPPERCASE123"],
    ["no digit", "NoDigitsHere"],
  ])("rejects a weak new password (%s)", async (_label, weak) => {
    const before = await passwordHashOf(ADMIN);
    const res = await asAdmin(CHANGE).send({
      current_password: CURRENT_PASSWORD,
      password: weak,
      confirm_password: weak,
    });

    expect(res.status).toBe(400);
    expect(await passwordHashOf(ADMIN)).toBe(before);
  });

  it("requires authentication", async () => {
    const anon = await httpClient(null);
    const before = await passwordHashOf(ADMIN);

    const res = await anon.post(CHANGE).send({
      current_password: CURRENT_PASSWORD,
      password: NEW_PASSWORD,
      confirm_password: NEW_PASSWORD,
    });

    expect(res.status).toBe(401);
    expect(await passwordHashOf(ADMIN)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe("POST /admin/auth/forgot-password", () => {
  it("answers identically for a real admin and an unknown address", async () => {
    const anon = await httpClient(null);

    const known = await anon.post(FORGOT).send({ email: adminEmail });
    const unknown = await anon
      .post(FORGOT)
      .send({ email: "definitely-not-an-admin@example.com" });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    expect(known.body.status).toBe(1);
  });

  it("stores only a digest of the token, never a usable one", async () => {
    const anon = await httpClient(null);
    await anon.post(FORGOT).send({ email: adminEmail });

    const state = await resetStateOf(ADMIN);
    expect(state.pwd_reset_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.pwd_reset_expires_at).not.toBeNull();
    expect(state.pwd_reset_used_at).toBeNull();
    expect(Number(state.pwd_reset_attempts)).toBe(1);
    // A window in the future, and a short one.
    const msLeft = new Date(state.pwd_reset_expires_at).getTime() - Date.now();
    expect(msLeft).toBeGreaterThan(0);
    expect(msLeft).toBeLessThanOrEqual(30 * 60 * 1000 + 5000);
  });

  it("leaves no reset in flight for an unknown address", async () => {
    const anon = await httpClient(null);
    await anon.post(FORGOT).send({ email: "nobody-here@example.com" });

    const state = await resetStateOf(ADMIN);
    expect(state.pwd_reset_token_hash).toBeNull();
  });

  it("issuing a second link invalidates the first", async () => {
    const anon = await httpClient(null);
    await anon.post(FORGOT).send({ email: adminEmail });
    const first = (await resetStateOf(ADMIN)).pwd_reset_token_hash;

    await anon.post(FORGOT).send({ email: adminEmail });
    const second = (await resetStateOf(ADMIN)).pwd_reset_token_hash;

    expect(second).not.toBe(first);
    expect(Number((await resetStateOf(ADMIN)).pwd_reset_attempts)).toBe(2);
  });

  it("stops issuing links once the per-window cap is reached", async () => {
    const anon = await httpClient(null);
    for (let i = 0; i < 5; i += 1) {
      await anon.post(FORGOT).send({ email: adminEmail });
    }
    const atCap = (await resetStateOf(ADMIN)).pwd_reset_token_hash;

    const res = await anon.post(FORGOT).send({ email: adminEmail });

    // Same generic answer, but no new token minted.
    expect(res.body.status).toBe(1);
    expect((await resetStateOf(ADMIN)).pwd_reset_token_hash).toBe(atCap);
    expect(Number((await resetStateOf(ADMIN)).pwd_reset_attempts)).toBe(5);
  });

  it("rejects a malformed email before touching the row", async () => {
    const anon = await httpClient(null);
    const res = await anon.post(FORGOT).send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expect((await resetStateOf(ADMIN)).pwd_reset_token_hash).toBeNull();
  });
});

// The controller only ever mails the raw token, so tests plant a known one.
const plantToken = async ({ minutesFromNow = 30, used = false } = {}) => {
  const token = crypto.randomBytes(32).toString("hex");
  await db.none(
    `UPDATE tbl_users
        SET pwd_reset_token_hash = $2,
            pwd_reset_expires_at = NOW() + ($3 || ' minutes')::interval,
            pwd_reset_used_at = $4,
            pwd_reset_attempts = 1
      WHERE id = $1`,
    [ADMIN, sha256(token), String(minutesFromNow), used ? new Date() : null]
  );
  return token;
};

// ---------------------------------------------------------------------------
describe("POST /admin/auth/reset-password", () => {
  it("resets the password and burns the token", async () => {
    const token = await plantToken();

    const anon = await httpClient(null);
    const res = await anon
      .post(RESET)
      .send({ token, password: NEW_PASSWORD, confirm_password: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(await bcrypt.compare(NEW_PASSWORD, await passwordHashOf(ADMIN))).toBe(true);

    const state = await resetStateOf(ADMIN);
    expect(state.pwd_reset_token_hash).toBeNull();
    expect(state.pwd_reset_used_at).not.toBeNull();
  });

  it("refuses the same link a second time", async () => {
    const token = await plantToken();
    const anon = await httpClient(null);

    const first = await anon
      .post(RESET)
      .send({ token, password: NEW_PASSWORD, confirm_password: NEW_PASSWORD });
    expect(first.body.status).toBe(1);

    const hashAfterFirst = await passwordHashOf(ADMIN);
    const second = await anon.post(RESET).send({
      token,
      password: "YetAnotherPass789",
      confirm_password: "YetAnotherPass789",
    });

    expect(second.status).toBe(400);
    expect(second.body.status).toBe(0);
    // This is the property the user-side flow lacks entirely.
    expect(await passwordHashOf(ADMIN)).toBe(hashAfterFirst);
  });

  it("refuses an expired link", async () => {
    const token = await plantToken({ minutesFromNow: -1 });
    const before = await passwordHashOf(ADMIN);
    const anon = await httpClient(null);

    const res = await anon
      .post(RESET)
      .send({ token, password: NEW_PASSWORD, confirm_password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid or has expired/i);
    expect(await passwordHashOf(ADMIN)).toBe(before);
  });

  it("refuses a token that was already marked used", async () => {
    const token = await plantToken({ used: true });
    const before = await passwordHashOf(ADMIN);
    const anon = await httpClient(null);

    const res = await anon
      .post(RESET)
      .send({ token, password: NEW_PASSWORD, confirm_password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(await passwordHashOf(ADMIN)).toBe(before);
  });

  it("refuses a token belonging to a deactivated admin", async () => {
    const token = await plantToken();
    await db.none(`UPDATE tbl_users SET status = 0 WHERE id = $1`, [ADMIN]);
    const before = await passwordHashOf(ADMIN);

    try {
      const anon = await httpClient(null);
      const res = await anon
        .post(RESET)
        .send({ token, password: NEW_PASSWORD, confirm_password: NEW_PASSWORD });

      expect(res.status).toBe(400);
      expect(await passwordHashOf(ADMIN)).toBe(before);
    } finally {
      await db.none(`UPDATE tbl_users SET status = 1 WHERE id = $1`, [ADMIN]);
    }
  });

  it("rejects a token of the wrong shape without a lookup", async () => {
    const anon = await httpClient(null);
    const res = await anon.post(RESET).send({
      token: "short",
      password: NEW_PASSWORD,
      confirm_password: NEW_PASSWORD,
    });

    expect(res.status).toBe(400);
  });

  it("does not accept the stored digest in place of the token", async () => {
    const token = await plantToken();
    const digest = sha256(token);
    const before = await passwordHashOf(ADMIN);
    const anon = await httpClient(null);

    // Both are 64 hex chars, so the digest passes schema validation. It must
    // still fail the lookup, which hashes whatever it is handed.
    const res = await anon.post(RESET).send({
      token: digest,
      password: NEW_PASSWORD,
      confirm_password: NEW_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(await passwordHashOf(ADMIN)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Single-use is a property of one LINK, not of the account.
//
// Raised in review as "the admin can only ever change their password once".
// It cannot happen, and these tests are here so nobody has to re-derive that
// from the SQL. Two lines carry the guarantee:
//
//   updateAdminPassword  has no guard at all -- it is a plain UPDATE
//   setAdminResetToken   sets `pwd_reset_used_at = NULL` when issuing a link,
//                        clearing the marker the previous reset left behind
//
// The only restriction anywhere is a 30-minute, 5-link throttle on how fast
// links can be mailed, and the last test proves that lifts on its own.
describe("password changes are repeatable", () => {
  it("lets an admin change their password over and over", async () => {
    const chain = ["FirstChange11", "SecondChange22", "ThirdChange33"];
    let current = CURRENT_PASSWORD;

    for (const next of chain) {
      const res = await asAdmin(CHANGE).send({
        current_password: current,
        password: next,
        confirm_password: next,
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(await bcrypt.compare(next, await passwordHashOf(ADMIN))).toBe(true);
      current = next;
    }

    // Three successful changes, and the account is not left in a locked state.
    const state = await resetStateOf(ADMIN);
    expect(state.pwd_reset_used_at).toBeNull();
    expect(Number(state.pwd_reset_attempts)).toBe(0);
  });

  it("issues and honours a second reset link after the first was consumed", async () => {
    const anon = await httpClient(null);

    const first = await plantToken();
    const one = await anon
      .post(RESET)
      .send({ token: first, password: "ResetOnce111", confirm_password: "ResetOnce111" });
    expect(one.body.status).toBe(1);
    // The consumed link left a used-at marker behind.
    expect((await resetStateOf(ADMIN)).pwd_reset_used_at).not.toBeNull();

    // A fresh request must clear it, or every later reset would be refused.
    await anon.post(FORGOT).send({ email: adminEmail });
    const afterReissue = await resetStateOf(ADMIN);
    expect(afterReissue.pwd_reset_used_at).toBeNull();
    expect(afterReissue.pwd_reset_token_hash).not.toBeNull();

    const second = await plantToken();
    const two = await anon
      .post(RESET)
      .send({ token: second, password: "ResetTwice22", confirm_password: "ResetTwice22" });

    expect(two.status).toBe(200);
    expect(two.body.status).toBe(1);
    expect(await bcrypt.compare("ResetTwice22", await passwordHashOf(ADMIN))).toBe(true);
  });

  it("still works after a reset, via the ordinary change form", async () => {
    // Reset, then change again with the reset password as the current one.
    const token = await plantToken();
    const anon = await httpClient(null);
    await anon
      .post(RESET)
      .send({ token, password: "AfterReset123", confirm_password: "AfterReset123" });

    const res = await asAdmin(CHANGE).send({
      current_password: "AfterReset123",
      password: "ChangedAgain45",
      confirm_password: "ChangedAgain45",
    });

    expect(res.status).toBe(200);
    expect(await bcrypt.compare("ChangedAgain45", await passwordHashOf(ADMIN))).toBe(true);
  });

  it("lifts the mail throttle once the window lapses", async () => {
    const anon = await httpClient(null);
    for (let i = 0; i < 5; i += 1) {
      await anon.post(FORGOT).send({ email: adminEmail });
    }
    const capped = (await resetStateOf(ADMIN)).pwd_reset_token_hash;

    // At the cap, no new link.
    await anon.post(FORGOT).send({ email: adminEmail });
    expect((await resetStateOf(ADMIN)).pwd_reset_token_hash).toBe(capped);

    // Age the window out rather than waiting 30 real minutes.
    await db.none(
      `UPDATE tbl_users SET pwd_reset_expires_at = NOW() - interval '1 minute' WHERE id = $1`,
      [ADMIN]
    );

    await anon.post(FORGOT).send({ email: adminEmail });
    const afterLapse = await resetStateOf(ADMIN);

    expect(afterLapse.pwd_reset_token_hash).not.toBe(capped);
    expect(afterLapse.pwd_reset_token_hash).not.toBeNull();
    // The counter restarts rather than staying pinned at the cap forever.
    expect(Number(afterLapse.pwd_reset_attempts)).toBe(1);
  });
});
