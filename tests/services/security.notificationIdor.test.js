// SECURITY — notification detail / read IDOR (P0, cross-tenant).
// ----------------------------------------------------------------------------
// `GET /users/notifications/notification-detail/:id` and
// `POST /users/notifications/read-notification/:id` were `passportSignIn`-only
// with NO owner filter in the SQL (`select * from tbl_notifications where
// id = $1`). Notification ids are sequential, so any authenticated user —
// including a VENDOR — could walk the whole table and read every tenant's
// notification titles/messages/payloads.
//
// These are product-level tests over real HTTP: two users, one notification
// each, and the cross-user fetch must not return the row.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";

afterAll(async () => {
  await closeDb();
});

const inserted = { notificationIds: [] };

beforeEach(() => {
  inserted.notificationIds = [];
});

afterEach(async () => {
  if (inserted.notificationIds.length) {
    await db.none(`DELETE FROM tbl_notifications WHERE id = ANY($1::int[])`, [
      inserted.notificationIds,
    ]);
  }
});

// Legacy rows in prod carry ownership on sender_user_id; ARC-era rows use
// recipient_user_id. Both must be honoured by the owner filter, so the
// factory takes an explicit shape.
async function makeNotification({ recipient = null, sender = null, title = "Test notification" }) {
  const row = await db.one(
    `INSERT INTO tbl_notifications
       (sender_user_id, recipient_user_id, type, title, message, category, is_read, created_at)
     VALUES ($1, $2, 'TEST', $3, 'secret body', 'TEST', 0, NOW())
     RETURNING id`,
    [sender, recipient, title]
  );
  inserted.notificationIds.push(row.id);
  return row.id;
}

describe("SECURITY: GET /users/notifications/notification-detail/:id", () => {
  it("returns the caller's own notification (recipient_user_id shape)", async () => {
    const id = await makeNotification({ recipient: IDS.users.a1_proc_buyer, title: "Mine" });

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/users/notifications/notification-detail/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const rows = Array.isArray(res.body.data) ? res.body.data : [res.body.data];
    expect(rows.map((r) => r.id)).toContain(id);
  });

  it("returns the caller's own notification (legacy sender_user_id shape)", async () => {
    const id = await makeNotification({ sender: IDS.users.a1_proc_buyer, title: "Mine legacy" });

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/users/notifications/notification-detail/${id}`);

    expect(res.status).toBe(200);
    const rows = Array.isArray(res.body.data) ? res.body.data : [res.body.data];
    expect(rows.map((r) => r.id)).toContain(id);
  });

  it("does NOT return another user's notification (cross-tenant IDOR)", async () => {
    // Owned by a Company-B user; requested by a Company-A user.
    const id = await makeNotification({ recipient: IDS.users.companyB_admin, title: "Company B secret" });

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/users/notifications/notification-detail/${id}`);

    expect([400, 403, 404]).toContain(res.status);
    expect(res.body.status).not.toBe(1);
    expect(JSON.stringify(res.body)).not.toContain("Company B secret");
  });

  it("does NOT let a VENDOR enumerate a buyer's notification", async () => {
    const id = await makeNotification({ recipient: IDS.users.a1_proc_buyer, title: "Buyer only secret" });

    const prev = await db.one(`SELECT user_type FROM tbl_users WHERE id=$1`, [IDS.users.vendor_alpha]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id=$1`, [IDS.users.vendor_alpha]);
    try {
      const client = await httpClient(IDS.users.vendor_alpha);
      const res = await client.get(`/api/v1/users/notifications/notification-detail/${id}`);
      expect([400, 403, 404]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain("Buyer only secret");
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id=$1`, [
        IDS.users.vendor_alpha,
        prev.user_type,
      ]);
    }
  });
});

describe("SECURITY: POST /users/notifications/read-notification/:id", () => {
  it("marks the caller's own notification read", async () => {
    const id = await makeNotification({ recipient: IDS.users.a1_proc_buyer });

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.post(`/api/v1/users/notifications/read-notification/${id}`).send({});

    expect(res.status).toBe(200);
    const after = await db.one(`SELECT is_read FROM tbl_notifications WHERE id=$1`, [id]);
    expect(Number(after.is_read)).toBe(1);
  });

  it("does NOT mark another user's notification read (write-side IDOR)", async () => {
    const id = await makeNotification({ recipient: IDS.users.companyB_admin });

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.post(`/api/v1/users/notifications/read-notification/${id}`).send({});

    expect([400, 403, 404]).toContain(res.status);
    const after = await db.one(`SELECT is_read FROM tbl_notifications WHERE id=$1`, [id]);
    expect(Number(after.is_read ?? 0)).toBe(0);
  });
});

describe("notification LISTING stays scoped (regression guard)", () => {
  it("only returns notifications the caller owns", async () => {
    const mine = await makeNotification({ sender: IDS.users.a1_proc_buyer, title: "List mine" });
    const theirs = await makeNotification({ sender: IDS.users.companyB_admin, title: "List theirs" });

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/users/notifications/notification-list?page=1&limit=100`);

    // 400/status:2 is the "no notifications" shape — acceptable; what must
    // never happen is another user's row appearing.
    const ids = Array.isArray(res.body?.data) ? res.body.data.map((r) => r.id) : [];
    expect(ids).not.toContain(theirs);
    expect(ids).toContain(mine);
  });
});
