// Inbox controls — dismiss, re-open, and filtering.
//
// The notification centre had three verbs: list, mark one read, mark everything
// read. There was no way to clear a single item you had dealt with, and no way
// to undo opening one by accident. The only tool for a cluttered inbox was
// "mark all read", which destroys the read/unread distinction wholesale — so
// people used it once and then stopped trusting the panel.
//
// Filtering also ran over the loaded page rather than the inbox, so "Unread"
// showed however many of the most recent 20 happened to be unread.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";

afterAll(async () => {
  await closeDb();
});

const BUYER = IDS.users.a1_proc_buyer;
const OTHER = IDS.users.a1_proc_poApp;
const inserted = { ids: [] };

beforeEach(async () => {
  inserted.ids = [];
  await db.none(
    `DELETE FROM tbl_notifications
      WHERE COALESCE(recipient_user_id, sender_user_id) = ANY($1::int[])`,
    [[BUYER, OTHER]]
  );
});

afterEach(async () => {
  await db.none(
    `DELETE FROM tbl_notifications
      WHERE COALESCE(recipient_user_id, sender_user_id) = ANY($1::int[])`,
    [[BUYER, OTHER]]
  );
});

async function makeNotification({
  recipient = BUYER,
  title = "Test",
  category = "rfq",
  read = false,
} = {}) {
  const row = await db.one(
    `INSERT INTO tbl_notifications
       (recipient_user_id, type, title, message, category, action_url,
        is_read, is_read_at, delivered_at, created_at)
     VALUES ($1, 'TEST', $2, 'body', $3, '/dashboard/buyer', $4, $5, NOW(), NOW())
     RETURNING id`,
    [recipient, title, category, read ? 1 : 0, read ? new Date() : null]
  );
  inserted.ids.push(row.id);
  return row.id;
}

describe("dismissing an item", () => {
  it("removes it from the inbox and the counts", async () => {
    const a = await makeNotification({ title: "Keep" });
    const b = await makeNotification({ title: "Dismiss me" });

    const client = await httpClient(BUYER);
    const res = await client.post(`/api/v1/users/notifications/dismiss/${b}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.unread).toBe(1);

    const list = await client.get("/api/v1/users/notifications/list");
    expect(list.body.data.map((n) => n.id)).toEqual([a]);
  });

  it("keeps the row — these are the audit trail of who was asked to act", async () => {
    const id = await makeNotification();

    const client = await httpClient(BUYER);
    await client.post(`/api/v1/users/notifications/dismiss/${id}`).send({});

    const row = await db.oneOrNone(
      `SELECT id, dismissed_at FROM tbl_notifications WHERE id = $1`,
      [id]
    );
    expect(row).not.toBeNull();
    expect(row.dismissed_at).not.toBeNull();
  });

  it("stops a dismissed item driving the badge", async () => {
    const id = await db.one(
      `INSERT INTO tbl_notifications
         (recipient_user_id, type, title, message, is_read, delivered_at, created_at)
       VALUES ($1, 'TEST', 'Undelivered', 'body', 0, NULL, NOW()) RETURNING id`,
      [BUYER]
    );
    inserted.ids.push(id.id);

    const client = await httpClient(BUYER);
    const before = await client.get("/api/v1/users/notifications/unread-count");
    expect(before.body.data.undelivered).toBe(1);

    await client.post(`/api/v1/users/notifications/dismiss/${id.id}`).send({});

    const after = await client.get("/api/v1/users/notifications/unread-count");
    expect(after.body.data.undelivered).toBe(0);
    expect(after.body.data.unread).toBe(0);
  });

  it("404s on another user's notification", async () => {
    const theirs = await makeNotification({ recipient: OTHER });

    const client = await httpClient(BUYER);
    const res = await client.post(`/api/v1/users/notifications/dismiss/${theirs}`).send({});

    expect(res.status).toBe(404);
    const row = await db.one(`SELECT dismissed_at FROM tbl_notifications WHERE id = $1`, [theirs]);
    expect(row.dismissed_at).toBeNull();
  });

  it("404s on a second dismissal rather than reporting a fresh one", async () => {
    const id = await makeNotification();
    const client = await httpClient(BUYER);

    expect((await client.post(`/api/v1/users/notifications/dismiss/${id}`).send({})).status).toBe(200);
    expect((await client.post(`/api/v1/users/notifications/dismiss/${id}`).send({})).status).toBe(404);
  });
});

describe("re-opening an item", () => {
  it("puts it back to unread", async () => {
    const id = await makeNotification({ read: true });

    const client = await httpClient(BUYER);
    const res = await client.post(`/api/v1/users/notifications/mark-unread/${id}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.unread).toBe(1);

    const row = await db.one(
      `SELECT is_read, is_read_at, delivered_at FROM tbl_notifications WHERE id = $1`,
      [id]
    );
    expect(row.is_read).toBe(0);
    expect(row.is_read_at).toBeNull();
    // Delivery is NOT reset — the user has demonstrably seen the row, so
    // resurrecting the badge would be a lie.
    expect(row.delivered_at).not.toBeNull();
  });

  it("does not resurrect the badge", async () => {
    const id = await makeNotification({ read: true });

    const client = await httpClient(BUYER);
    const res = await client.post(`/api/v1/users/notifications/mark-unread/${id}`).send({});

    expect(res.body.data.undelivered).toBe(0);
  });

  it("404s on another user's notification", async () => {
    const theirs = await makeNotification({ recipient: OTHER, read: true });

    const client = await httpClient(BUYER);
    const res = await client.post(`/api/v1/users/notifications/mark-unread/${theirs}`).send({});

    expect(res.status).toBe(404);
  });
});

describe("filtering happens in SQL, not over the loaded page", () => {
  it("filters unread across the whole inbox", async () => {
    for (let i = 0; i < 25; i += 1) await makeNotification({ read: true, title: `Read ${i}` });
    await makeNotification({ read: false, title: "The only unread one" });

    const client = await httpClient(BUYER);
    const res = await client.get("/api/v1/users/notifications/list?unread=1&limit=20");

    // Filtering the first page client-side would have returned nothing: the
    // unread row is the 26th by recency in that scenario.
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe("The only unread one");
  });

  it("filters by category", async () => {
    await makeNotification({ category: "rfq", title: "An RFQ" });
    await makeNotification({ category: "po", title: "A PO" });
    await makeNotification({ category: "arc", title: "An ARC" });

    const client = await httpClient(BUYER);
    const res = await client.get("/api/v1/users/notifications/list?category=po");

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe("A PO");
  });

  it("groups categories case-insensitively", async () => {
    // Emitters wrote 'po' and 'PO' for the same module, plus 'ARC' and
    // 'CALL_OFF'. A filter listing "po" and "PO" separately is worse than none.
    await makeNotification({ category: "po", title: "lower" });
    await makeNotification({ category: "PO", title: "upper" });

    const client = await httpClient(BUYER);
    const res = await client.get("/api/v1/users/notifications/list?category=po");
    expect(res.body.data).toHaveLength(2);

    const cats = await client.get("/api/v1/users/notifications/categories");
    const po = cats.body.data.filter((c) => c.category === "po");
    expect(po).toHaveLength(1);
    expect(po[0].total).toBe(2);
  });

  it("reports per-category counts for the filter itself", async () => {
    await makeNotification({ category: "rfq", read: false });
    await makeNotification({ category: "rfq", read: true });
    await makeNotification({ category: "approval", read: false });

    const client = await httpClient(BUYER);
    const res = await client.get("/api/v1/users/notifications/categories");

    const byCat = Object.fromEntries(res.body.data.map((c) => [c.category, c]));
    expect(byCat.rfq.total).toBe(2);
    expect(byCat.rfq.unread).toBe(1);
    expect(byCat.approval.unread).toBe(1);
  });

  it("excludes dismissed items from the category counts", async () => {
    const id = await makeNotification({ category: "rfq" });
    await makeNotification({ category: "rfq" });

    const client = await httpClient(BUYER);
    await client.post(`/api/v1/users/notifications/dismiss/${id}`).send({});

    const res = await client.get("/api/v1/users/notifications/categories");
    expect(res.body.data.find((c) => c.category === "rfq").total).toBe(1);
  });

  it("buckets an uncategorised row rather than dropping it", async () => {
    const row = await db.one(
      `INSERT INTO tbl_notifications (recipient_user_id, type, title, message, category, created_at)
       VALUES ($1, 'TEST', 'No category', 'body', NULL, NOW()) RETURNING id`,
      [BUYER]
    );
    inserted.ids.push(row.id);

    const client = await httpClient(BUYER);
    const res = await client.get("/api/v1/users/notifications/categories");
    expect(res.body.data.map((c) => c.category)).toContain("other");
  });
});

describe("dispatch normalises category on the way in", () => {
  it("stores a lowercase category regardless of what the caller passed", async () => {
    const { dispatch } = await import("../../app/services/notificationService.js");
    await dispatch({
      userIds: [BUYER],
      category: "CALL_OFF",
      type: "TEST_UPPER",
      title: "Uppercase category",
      body: "body",
      actionUrl: "/dashboard/buyer",
    });

    const row = await db.one(
      `SELECT category FROM tbl_notifications WHERE recipient_user_id = $1 AND type = 'TEST_UPPER'`,
      [BUYER]
    );
    expect(row.category).toBe("call_off");
  });
});
