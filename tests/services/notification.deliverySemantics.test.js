// Notification delivery semantics — delivered vs read.
// ----------------------------------------------------------------------------
// The bell used to model a single boolean, `is_read`, which had to answer both
// "has the user had a chance to see this?" (badge) and "has the user acted on
// it?" (highlight). The badge therefore only cleared once every item had been
// individually clicked, so it stayed permanently lit.
//
// `delivered_at` splits the two:
//   opening the bell  → everything outstanding becomes DELIVERED (badge clears)
//   clicking an item  → that row becomes READ (highlight clears, badge already 0)
//
// These are product-level tests over real HTTP against a local Postgres: they
// assert what a caller observes from the endpoints, never how it is wired.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";

afterAll(async () => {
  await closeDb();
});

const inserted = { notificationIds: [] };

const BUYER = IDS.users.a1_proc_buyer;
const OTHER = IDS.users.a1_proc_poApp;

beforeEach(async () => {
  inserted.notificationIds = [];
  // Fixture users may carry rows from other suites; the counters below are
  // absolute, so start each test from a known-empty inbox.
  await db.none(
    `DELETE FROM tbl_notifications
      WHERE COALESCE(recipient_user_id, sender_user_id) = ANY($1::int[])`,
    [[BUYER, OTHER]]
  );
});

afterEach(async () => {
  if (inserted.notificationIds.length) {
    await db.none(`DELETE FROM tbl_notifications WHERE id = ANY($1::int[])`, [
      inserted.notificationIds,
    ]);
  }
});

async function makeNotification({
  recipient = null,
  sender = null,
  title = "Test notification",
  delivered = false,
  read = false,
} = {}) {
  const row = await db.one(
    `INSERT INTO tbl_notifications
       (sender_user_id, recipient_user_id, type, title, message, category,
        action_url, is_read, is_read_at, delivered_at, created_at)
     VALUES ($1, $2, 'TEST', $3, 'body', 'test',
             '/dashboard/buyer', $4, $5, $6, NOW())
     RETURNING id`,
    [
      sender,
      recipient,
      title,
      read ? 1 : 0,
      read ? new Date() : null,
      delivered || read ? new Date() : null,
    ]
  );
  inserted.notificationIds.push(row.id);
  return row.id;
}

describe("GET /users/notifications/unread-count", () => {
  it("counts a brand-new notification as undelivered AND unread", async () => {
    await makeNotification({ recipient: BUYER });

    const client = await httpClient(BUYER);
    const res = await client.get("/api/v1/users/notifications/unread-count");

    expect(res.status).toBe(200);
    expect(res.body.data.undelivered).toBe(1);
    expect(res.body.data.unread).toBe(1);
    // `count` is what the badge has always read — it must track undelivered.
    expect(res.body.data.count).toBe(1);
  });

  it("counts only the caller's own notifications", async () => {
    await makeNotification({ recipient: BUYER });
    await makeNotification({ recipient: OTHER });
    await makeNotification({ recipient: OTHER });

    const client = await httpClient(BUYER);
    const res = await client.get("/api/v1/users/notifications/unread-count");

    expect(res.body.data.undelivered).toBe(1);
  });

  it("includes legacy rows that carry the recipient in sender_user_id", async () => {
    // Production holds ~1,718 of these. They were visible on the old
    // /notification-list endpoint but invisible to the bell, so one user saw
    // two different inboxes depending on which surface they opened.
    await makeNotification({ sender: BUYER, title: "Legacy shape" });

    const client = await httpClient(BUYER);
    const res = await client.get("/api/v1/users/notifications/unread-count");

    expect(res.body.data.unread).toBe(1);

    const list = await client.get("/api/v1/users/notifications/list");
    expect(list.body.data.map((n) => n.title)).toContain("Legacy shape");
  });
});

describe("POST /users/notifications/mark-delivered (bell opened)", () => {
  it("clears the badge without marking anything read", async () => {
    await makeNotification({ recipient: BUYER, title: "A" });
    await makeNotification({ recipient: BUYER, title: "B" });

    const client = await httpClient(BUYER);
    const res = await client.post("/api/v1/users/notifications/mark-delivered").send({});

    expect(res.status).toBe(200);
    expect(res.body.data.delivered).toBe(2);
    expect(res.body.data.undelivered).toBe(0);
    // The whole point: they are delivered but still unread, so the list keeps
    // rendering them highlighted.
    expect(res.body.data.unread).toBe(2);

    const list = await client.get("/api/v1/users/notifications/list");
    expect(list.body.data.every((n) => n.is_read === 0)).toBe(true);
    expect(list.body.data.every((n) => n.delivered_at !== null)).toBe(true);
  });

  it("delivers everything outstanding, not just the first page", async () => {
    for (let i = 0; i < 25; i += 1) {
      await makeNotification({ recipient: BUYER, title: `N${i}` });
    }

    const client = await httpClient(BUYER);
    await client.post("/api/v1/users/notifications/mark-delivered").send({});

    const res = await client.get("/api/v1/users/notifications/unread-count");
    expect(res.body.data.undelivered).toBe(0);
  });

  it("honours an explicit id subset", async () => {
    const a = await makeNotification({ recipient: BUYER, title: "A" });
    await makeNotification({ recipient: BUYER, title: "B" });

    const client = await httpClient(BUYER);
    const res = await client.post("/api/v1/users/notifications/mark-delivered").send({ ids: [a] });

    expect(res.body.data.delivered).toBe(1);
    expect(res.body.data.undelivered).toBe(1);
  });

  it("is idempotent — reopening the bell delivers nothing further", async () => {
    await makeNotification({ recipient: BUYER });

    const client = await httpClient(BUYER);
    const first = await client.post("/api/v1/users/notifications/mark-delivered").send({});
    const second = await client.post("/api/v1/users/notifications/mark-delivered").send({});

    expect(first.body.data.delivered).toBe(1);
    expect(second.body.data.delivered).toBe(0);
  });

  it("cannot deliver another user's notifications", async () => {
    const theirs = await makeNotification({ recipient: OTHER });

    const client = await httpClient(BUYER);
    await client.post("/api/v1/users/notifications/mark-delivered").send({ ids: [theirs] });

    const row = await db.one(
      `SELECT delivered_at FROM tbl_notifications WHERE id = $1`,
      [theirs]
    );
    expect(row.delivered_at).toBeNull();
  });
});

describe("POST /users/notifications/mark-read/:id (notification clicked)", () => {
  it("marks the row read and implicitly delivered", async () => {
    const id = await makeNotification({ recipient: BUYER });

    const client = await httpClient(BUYER);
    const res = await client.post(`/api/v1/users/notifications/mark-read/${id}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.unread).toBe(0);
    // Reading implies delivery — otherwise the badge would stay lit for an item
    // the user had just opened.
    expect(res.body.data.undelivered).toBe(0);

    const row = await db.one(
      `SELECT is_read, is_read_at, delivered_at FROM tbl_notifications WHERE id = $1`,
      [id]
    );
    expect(row.is_read).toBe(1);
    expect(row.is_read_at).not.toBeNull();
    expect(row.delivered_at).not.toBeNull();
  });

  it("does not disturb the delivery timestamp of an already-delivered row", async () => {
    const id = await makeNotification({ recipient: BUYER, delivered: true });
    const before = await db.one(
      `SELECT delivered_at FROM tbl_notifications WHERE id = $1`,
      [id]
    );

    const client = await httpClient(BUYER);
    await client.post(`/api/v1/users/notifications/mark-read/${id}`).send({});

    const after = await db.one(
      `SELECT delivered_at FROM tbl_notifications WHERE id = $1`,
      [id]
    );
    expect(after.delivered_at.getTime()).toBe(before.delivered_at.getTime());
  });

  it("404s on someone else's notification instead of reporting success", async () => {
    // A silent 200 made a rejected cross-tenant write indistinguishable from a
    // real one, so the client could never reconcile its optimistic update.
    const theirs = await makeNotification({ recipient: OTHER });

    const client = await httpClient(BUYER);
    const res = await client.post(`/api/v1/users/notifications/mark-read/${theirs}`).send({});

    expect(res.status).toBe(404);

    const row = await db.one(`SELECT is_read FROM tbl_notifications WHERE id = $1`, [theirs]);
    expect(row.is_read).toBe(0);
  });

  it("404s on a notification id that does not exist", async () => {
    const client = await httpClient(BUYER);
    const res = await client.post("/api/v1/users/notifications/mark-read/999999999").send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /users/notifications/mark-all-read", () => {
  it("clears both counters", async () => {
    await makeNotification({ recipient: BUYER });
    await makeNotification({ recipient: BUYER });

    const client = await httpClient(BUYER);
    const res = await client.post("/api/v1/users/notifications/mark-all-read").send({});

    expect(res.body.data.unread).toBe(0);
    expect(res.body.data.undelivered).toBe(0);
  });

  it("leaves other users untouched", async () => {
    await makeNotification({ recipient: BUYER });
    const theirs = await makeNotification({ recipient: OTHER });

    const client = await httpClient(BUYER);
    await client.post("/api/v1/users/notifications/mark-all-read").send({});

    const row = await db.one(`SELECT is_read FROM tbl_notifications WHERE id = $1`, [theirs]);
    expect(row.is_read).toBe(0);
  });
});

describe("GET /users/notifications/list", () => {
  it("reports whether another page exists", async () => {
    for (let i = 0; i < 3; i += 1) {
      await makeNotification({ recipient: BUYER, title: `N${i}` });
    }

    const client = await httpClient(BUYER);

    const full = await client.get("/api/v1/users/notifications/list?page=1&limit=2");
    expect(full.body.data).toHaveLength(2);
    expect(full.body.meta.has_more).toBe(true);

    const last = await client.get("/api/v1/users/notifications/list?page=2&limit=2");
    expect(last.body.data).toHaveLength(1);
    expect(last.body.meta.has_more).toBe(false);
  });

  it("exposes delivered_at so the client can render delivery state", async () => {
    await makeNotification({ recipient: BUYER, delivered: true });

    const client = await httpClient(BUYER);
    const res = await client.get("/api/v1/users/notifications/list");

    expect(res.body.data[0]).toHaveProperty("delivered_at");
    expect(res.body.data[0].delivered_at).not.toBeNull();
  });
});
