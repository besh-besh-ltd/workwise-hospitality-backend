/**
 * Does access actually end when an account does? (T0)
 *
 * `user_detail_check` (`userModel.js:793`) is `select * from tbl_users where
 * id = $1` — no `status`, no `is_deleted` — and it runs on every
 * authenticated request. So a removed account keeps working for the full
 * 24-hour JWT life, and a soft-deleted one keeps working indefinitely.
 *
 * Only the `is_deleted` half is enforced here, and the reason is data rather
 * than code. Filtering on `status = 1` as well would be a one-line change and
 * would immediately lock out **nine people who are working today**: production
 * holds nine `status = 0` accounts with recent logins — one with 40 in ninety
 * days, one active sixteen days ago — all with role scopes.
 *
 * Which surfaces something worth stating plainly: deactivation is currently
 * partial. `resolveApprovers` filters `status = 1`, so a deactivated user
 * stops being offered as an approver, but nothing stops them signing in and
 * working. Making status mean what it says needs those nine accounts resolved
 * first, so it is a decision with a remediation attached, not a predicate.
 */
import { db, closeDb } from "../setup/db.js";
import userModel from "../../app/models/userModel.js";
import { IDS } from "../fixtures/ids.js";

const PROBE = 978001;

beforeAll(() =>
  db.none(
    `INSERT INTO tbl_users (id, name, email, mobile, user_type, status, is_deleted)
     VALUES ($1, 'Session Probe', 'session-probe@example.com', '+91-9000000009', 2, 1, 0)
     ON CONFLICT (id) DO NOTHING`,
    [PROBE]
  )
);

afterAll(async () => {
  await db.none("DELETE FROM tbl_users WHERE id = $1", [PROBE]);
  await db.none("DELETE FROM tbl_audit_row_changes WHERE table_name = 'tbl_users'");
  await closeDb();
});

describe("authentication stops resolving a removed account", () => {
  it("resolves a live account", async () => {
    const rows = await userModel.user_detail_check(PROBE);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(PROBE);
  });

  it("stops resolving a soft-deleted account", async () => {
    await db.none("UPDATE tbl_users SET is_deleted = 1 WHERE id = $1", [PROBE]);
    expect(await userModel.user_detail_check(PROBE)).toHaveLength(0);
    await db.none("UPDATE tbl_users SET is_deleted = 0 WHERE id = $1", [PROBE]);
  });

  it("still resolves an inactive account, deliberately", async () => {
    // Not an oversight. Nine production accounts carry status = 0 and are in
    // daily use; enforcing status here would lock them out mid-shift. The
    // predicate is withheld until those accounts are resolved.
    await db.none("UPDATE tbl_users SET status = 0 WHERE id = $1", [PROBE]);
    expect(await userModel.user_detail_check(PROBE)).toHaveLength(1);
    await db.none("UPDATE tbl_users SET status = 1 WHERE id = $1", [PROBE]);
  });

  it("resolves nothing for an unknown id", async () => {
    expect(await userModel.user_detail_check(97999999)).toHaveLength(0);
  });
});
