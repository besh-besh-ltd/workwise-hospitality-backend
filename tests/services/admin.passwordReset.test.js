/**
 * An administrator helping a locked-out employee (T0).
 *
 * The password routes are strictly self-service — `forgot-password-otp-*`
 * needs the user's own inbox, `change-password` needs their old password —
 * and `update_user_detail` never touches a password. So an admin could not
 * help somebody locked out at all, which in a business with high floor-staff
 * turnover is the most frequent request there is. It went to Workwise instead.
 *
 * The admin triggers the reset; they never see or choose the password. That
 * reuses the existing OTP flow rather than inventing a second credential path,
 * and it keeps the property that matters: an administrator can restore access
 * without ever being able to impersonate the person.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

const ADMIN = IDS.users.companyA_admin;
const SAME_COMPANY = IDS.users.a1_proc_buyer;
const OTHER_COMPANY = IDS.users.companyB_admin;

let restoreAdminType;

beforeAll(async () => {
  const row = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [ADMIN]);
  restoreAdminType = row.user_type;
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [ADMIN, restoreAdminType]);
  await db.none("UPDATE tbl_users SET otp = NULL WHERE id = ANY($1)", [[SAME_COMPANY, OTHER_COMPANY]]);
  await db.none("DELETE FROM tbl_audit_row_changes WHERE table_name = 'tbl_users'");
  await db.none("DELETE FROM tbl_activity_events");
  await closeDb();
});

const otpOf = (id) =>
  db.oneOrNone("SELECT otp FROM tbl_users WHERE id = $1", [id]).then((r) => r?.otp ?? null);

describe("admin-initiated password reset", () => {
  it("sends a reset to somebody in the admin's own company", async () => {
    await db.none("UPDATE tbl_users SET otp = NULL WHERE id = $1", [SAME_COMPANY]);
    const client = await httpClient(ADMIN);

    const res = await client.post(`/api/v1/users/${SAME_COMPANY}/send-password-reset`).send({});
    expect(res.status).toBe(200);

    // A fresh single-use code now exists for that user to redeem themselves.
    expect(await otpOf(SAME_COMPANY)).not.toBeNull();
  });

  it("never returns the code to the administrator", async () => {
    // The whole point: an admin can restore access without being able to use
    // it. Returning the OTP would make this an impersonation tool.
    const client = await httpClient(ADMIN);
    const res = await client.post(`/api/v1/users/${SAME_COMPANY}/send-password-reset`).send({});

    const code = await otpOf(SAME_COMPANY);
    expect(JSON.stringify(res.body)).not.toContain(String(code));
  });

  it("refuses somebody outside the admin's company", async () => {
    await db.none("UPDATE tbl_users SET otp = NULL WHERE id = $1", [OTHER_COMPANY]);
    const client = await httpClient(ADMIN);

    const res = await client.post(`/api/v1/users/${OTHER_COMPANY}/send-password-reset`).send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await otpOf(OTHER_COMPANY)).toBeNull();
  });

  it("refuses a caller who is not an administrator", async () => {
    const client = await httpClient(SAME_COMPANY);
    const res = await client.post(`/api/v1/users/${SAME_COMPANY}/send-password-reset`).send({});
    expect(res.status).toBe(403);
  });

  it("reports a user who does not exist as not found", async () => {
    const client = await httpClient(ADMIN);
    const res = await client.post("/api/v1/users/97999999/send-password-reset").send({});
    expect(res.status).toBe(404);
  });

  it("records the reset as a critical event", async () => {
    // Restoring access to an account is exactly the kind of act a trail exists
    // for — and the actor is the admin, not the person reset.
    await db.none("DELETE FROM tbl_activity_events");
    const client = await httpClient(ADMIN);
    await client.post(`/api/v1/users/${SAME_COMPANY}/send-password-reset`).send({});

    const deadline = Date.now() + 4000;
    let event = null;
    while (!event && Date.now() < deadline) {
      event = await db.oneOrNone(
        "SELECT severity, actor_user_id, summary FROM tbl_activity_events WHERE event_key = 'password_reset_sent'"
      );
      if (!event) await new Promise((r) => setTimeout(r, 100));
    }

    expect(event).not.toBeNull();
    expect(event.severity).toBe("critical");
    expect(Number(event.actor_user_id)).toBe(ADMIN);
  });
});
