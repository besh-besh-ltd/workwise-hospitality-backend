// Auth helper for tests. Mirrors the production login JWT format used by
// `passport.use('jwtUsr', ...)` in app/middleware/passport.js — that strategy
// expects:
//   - payload.user truthy
//   - payload.sub  = cryptr.encrypt(user_id)
//   - payload.ag   = cryptr.encrypt(user_agent) AND must equal tbl_users.user_agent
//   - payload.exp  > now
//
// Per architectural rule, NO scope headers are needed. loginAs(userId) returns
// only an Authorization header. Scope is derived by the controller from the
// target entity row's hotel_id/department_id/process_id.

import JWT from "jsonwebtoken";
import Cryptr from "cryptr";
import Config from "../../app/config/app.config.js";
import { db } from "../setup/db.js";

const cryptr = new Cryptr(Config.cryptR.secret);
const TEST_USER_AGENT = "jest-test-agent";

/**
 * Sign a JWT for the given fixture user. The first call for each user updates
 * `tbl_users.user_agent` to the canonical test value so passport's user-agent
 * comparison succeeds.
 *
 * Returns { token, headers, userAgent }.
 */
export async function loginAs(userId) {
  if (!Number.isInteger(userId)) {
    throw new Error(`loginAs: userId must be an integer (got ${userId})`);
  }
  // Ensure the fixture user has the canonical test user-agent on row.
  await db.none(
    `UPDATE tbl_users SET user_agent = $1 WHERE id = $2`,
    [TEST_USER_AGENT, userId]
  );
  const user = await db.oneOrNone(
    `SELECT id, name, status FROM tbl_users WHERE id = $1`,
    [userId]
  );
  if (!user) throw new Error(`loginAs: user ${userId} not found`);
  if (user.status !== 1) throw new Error(`loginAs: user ${userId} is inactive`);

  const now = Math.round(Date.now() / 1000);
  const token = JWT.sign(
    {
      iss: "Des Technico",
      sub: cryptr.encrypt(String(user.id)),
      name: user.name,
      session: "",
      user: true,
      ag: cryptr.encrypt(TEST_USER_AGENT),
      iat: now,
      exp: now + 60 * 60,
    },
    Config.jwt.secret
  );
  return {
    token,
    headers: { Authorization: `Bearer ${token}`, "User-Agent": TEST_USER_AGENT },
    userAgent: TEST_USER_AGENT,
  };
}

/** Convenience: returns the headers object directly. */
export async function authHeadersFor(userId) {
  const { headers } = await loginAs(userId);
  return headers;
}

/**
 * Sign a JWT for the admin panel. Mirrors `passport.use('jwtAdm', ...)`, which
 * differs from the user strategy in two ways that matter: the payload flag is
 * `admin` rather than `user`, and the row is loaded via adminModel, whose
 * predicate is `user_type NOT IN (2,3,4)`.
 *
 * Fixture users carry user_type NULL, and `NULL NOT IN (2,3,4)` is NULL — not
 * true — so an un-stamped fixture user is invisible to every admin query.
 * Callers must stamp an admin user_type first; `stampAdmin` below does it.
 */
export async function loginAsAdmin(userId) {
  if (!Number.isInteger(userId)) {
    throw new Error(`loginAsAdmin: userId must be an integer (got ${userId})`);
  }
  const user = await db.oneOrNone(
    `SELECT id, name, status FROM tbl_users WHERE id = $1`,
    [userId]
  );
  if (!user) throw new Error(`loginAsAdmin: user ${userId} not found`);

  const now = Math.round(Date.now() / 1000);
  const token = JWT.sign(
    {
      iss: "Des Technico",
      sub: cryptr.encrypt(String(user.id)),
      name: user.name,
      admin: true,
      ag: cryptr.encrypt(TEST_USER_AGENT),
      iat: now,
      exp: now + 60 * 60,
    },
    Config.jwt.secret
  );
  return {
    token,
    headers: { Authorization: `Bearer ${token}`, "User-Agent": TEST_USER_AGENT },
  };
}

/** Give a fixture user an admin user_type. Returns the previous value. */
export async function stampAdmin(userId, userType = 1) {
  const row = await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [userId]);
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [userId, userType]);
  return row.user_type;
}
