// Performance indexes (migrations/20261003100000_perf_indexes.sql).
//
// An index only helps if the planner can match it, and an expression index is
// matched TEXTUALLY: `(COALESCE(recipient_user_id, sender_user_id))` with a
// `WHERE dismissed_at IS NULL` predicate is only usable by a query whose
// filter carries that exact expression and implies that predicate. If someone
// later rewrites the bell queries (say to `recipient_user_id = $1 OR ...`),
// the index silently stops being used and the unread-count poll goes back to
// a seq scan on every call. Nothing functional would fail, so this suite is
// the only thing that would notice.
//
// The notification checks capture the EXACT SQL each production model function
// sends (by spying on the shared pg-promise instance), then ask the planner for
// a plan with seq scans disabled. With enable_seqscan=off a usable index is
// always chosen over the (penalised) seq scan, so "plan does not mention the
// index" means "the index cannot serve this query" — not "the table is small".

import { describe, it, expect, afterAll, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import appDb, { pgp } from "../../app/config/dbConn.js";
import notificationModel from "../../app/models/notificationModel.js";

afterAll(async () => {
  await closeDb();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const USER = IDS.users.a1_proc_buyer;

// Runs `fn`, recording every statement it sends through the app's db handle.
async function captureSql(fn) {
  const captured = [];
  for (const method of ["any", "oneOrNone", "one", "result", "none", "manyOrNone"]) {
    const original = appDb[method].bind(appDb);
    jest.spyOn(appDb, method).mockImplementation((sql, params) => {
      captured.push(pgp.as.format(sql, params));
      return original(sql, params);
    });
  }
  await fn();
  return captured;
}

async function planUsesIndex(sql, indexName) {
  return db.tx(async (t) => {
    await t.none("SET LOCAL enable_seqscan = off");
    const rows = await t.any(`EXPLAIN (FORMAT JSON) ${sql}`);
    const plan = JSON.stringify(rows[0]["QUERY PLAN"]);
    return plan.includes(`"${indexName}"`);
  });
}

describe("perf indexes exist with the intended definitions", () => {
  it.each([
    ["idx_pop_rfq_product_id_inc", /\(rfq_product_id\) INCLUDE \(purchase_order_id\)/],
    ["idx_pop_purchase_order_id", /tbl_purchase_order_product USING btree \(purchase_order_id\)$/],
    [
      "idx_notif_owner_active",
      /\(COALESCE\(recipient_user_id, sender_user_id\), created_at DESC\) INCLUDE \(delivered_at, is_read\) WHERE \(dismissed_at IS NULL\)/,
    ],
    ["idx_company_location_company_id", /tbl_company_location USING btree \(company_id\)$/],
  ])("%s", async (name, shape) => {
    const row = await db.oneOrNone(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [name]);
    expect(row).not.toBeNull();
    expect(row.indexdef).toMatch(shape);
  });
});

describe("every bell query can be served by idx_notif_owner_active", () => {
  const cases = [
    ["getByRecipient", () => notificationModel.getByRecipient(USER, 20, 0)],
    ["getByRecipient (category + unread)", () =>
      notificationModel.getByRecipient(USER, 20, 0, { category: "rfq", unreadOnly: true })],
    ["getCounts", () => notificationModel.getCounts(USER)],
    ["getCategoryCounts", () => notificationModel.getCategoryCounts(USER)],
    ["getUnreadCount", () => notificationModel.getUnreadCount(USER)],
    ["markDelivered", () => notificationModel.markDelivered(USER)],
    ["markAllRead", () => notificationModel.markAllRead(USER)],
  ];

  it.each(cases)("%s", async (_label, call) => {
    const statements = await captureSql(call);
    const owned = statements.filter((s) => /COALESCE\(recipient_user_id, sender_user_id\)/.test(s));
    expect(owned.length).toBeGreaterThan(0);
    for (const sql of owned) {
      expect(await planUsesIndex(sql, "idx_notif_owner_active")).toBe(true);
    }
  });
});
