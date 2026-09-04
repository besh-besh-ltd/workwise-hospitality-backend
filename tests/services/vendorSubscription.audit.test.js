// Subscription changes must leave a trail.
// ----------------------------------------------------------------------------
// tbl_vendor_hotel_category_subscription is the single source of truth for
// which vendors can be reached for which hotel and category. It decides whether
// a vendor sees an RFQ at all. It was also the only table of its importance
// carrying NO audit trigger, while twenty-three others have one.
//
// That gap turned an ordinary support question into an unanswerable one. On RFQ
// 536445 (The Orchid Manali) the buyer reported: "I removed the Engineering
// category and Manali unit and added the same again, and it is still not
// showing." The vendor had no Manali subscription and no row had been created
// since May, but with no trail there was no way to tell whether the edit was
// never made, silently failed, was applied to a different vendor, or was
// abandoned before payment. Those four have four different fixes.
//
// INSERT is audited as well as UPDATE and DELETE, because a re-add IS an
// insert — the exact event the buyer believed had happened.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";

afterAll(async () => {
  await closeDb();
});

const TABLE = "tbl_vendor_hotel_category_subscription";
const inserted = { subIds: [] };

beforeEach(async () => {
  inserted.subIds = [];
  await db.none(`DELETE FROM audit_log_temp WHERE table_name = $1`, [TABLE]);
});

afterEach(async () => {
  if (inserted.subIds.length) {
    await db.none(`DELETE FROM ${TABLE} WHERE id = ANY($1::int[])`, [inserted.subIds]);
  }
  await db.none(`DELETE FROM audit_log_temp WHERE table_name = $1`, [TABLE]);
  inserted.subIds = [];
});

async function addSub({ status = "active", endOffsetDays = 335 } = {}) {
  const row = await db.one(
    `INSERT INTO ${TABLE}
       (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
     VALUES ($1, 'category', $2, 500, (now() - interval '30 days')::date,
             (now() + ($3 || ' days')::interval)::date, $4)
     RETURNING id`,
    [IDS.users.vendor_alpha, TEST_CATEGORIES.juice, String(endOffsetDays), status]
  );
  inserted.subIds.push(row.id);
  return row.id;
}

const trail = (recordId) =>
  db.any(
    `SELECT operation, record_id, old_data, new_data, changed_by, changed_at
       FROM audit_log_temp WHERE table_name = $1 AND record_id = $2
      ORDER BY id`,
    [TABLE, recordId]
  );

describe("the subscription table is audited", () => {
  it("carries an audit trigger, like every other table of its importance", async () => {
    const rows = await db.any(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = $1::regclass AND NOT tgisinternal`,
      [TABLE]
    );
    expect(rows.map((r) => r.tgname)).toContain(`${TABLE}_audit`);
  });

  it("records a new subscription, with what was created", async () => {
    const id = await addSub();
    const rows = await trail(id);

    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe("INSERT");
    // The payload is the point: "a row was created" without its contents
    // cannot answer which hotel or category the buyer actually added.
    expect(rows[0].new_data).toBeTruthy();
    expect(rows[0].new_data.item_type).toBe("category");
    expect(rows[0].new_data.item_id).toBe(TEST_CATEGORIES.juice);
    expect(rows[0].new_data.status).toBe("active");
    expect(rows[0].new_data.vendor_id).toBe(IDS.users.vendor_alpha);
    expect(rows[0].old_data).toBeNull();
    expect(rows[0].changed_at).toBeTruthy();
  });

  it("records a cancellation as a status transition, both sides", async () => {
    const id = await addSub();
    await db.none(
      `UPDATE ${TABLE} SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2
        WHERE id = $1`,
      [id, IDS.users.companyA_admin]
    );

    const rows = await trail(id);
    const update = rows.find((r) => r.operation === "UPDATE");
    expect(update).toBeTruthy();
    expect(update.old_data.status).toBe("active");
    expect(update.new_data.status).toBe("cancelled");
    expect(update.new_data.cancelled_by).toBe(IDS.users.companyA_admin);
  });

  it("records a deletion, with what was removed", async () => {
    const id = await addSub();
    await db.none(`DELETE FROM ${TABLE} WHERE id = $1`, [id]);
    inserted.subIds = inserted.subIds.filter((x) => x !== id);

    const rows = await trail(id);
    const del = rows.find((r) => r.operation === "DELETE");
    expect(del).toBeTruthy();
    expect(del.old_data.item_id).toBe(TEST_CATEGORIES.juice);
    expect(del.new_data).toBeNull();
  });

  it("reconstructs a remove-then-re-add in order, which is the reported story", async () => {
    // Exactly what the buyer described. With this trail, the answer to
    // "did my edit happen?" is a query, not a guess.
    const first = await addSub({ endOffsetDays: 335 });
    await db.none(`UPDATE ${TABLE} SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [first]);
    const second = await addSub({ endOffsetDays: 400 });

    const all = await db.any(
      `SELECT operation, record_id, new_data->>'status' AS status
         FROM audit_log_temp WHERE table_name = $1 ORDER BY id`,
      [TABLE]
    );
    expect(all.map((r) => `${r.operation}:${r.status ?? '-'}`)).toEqual([
      "INSERT:active",
      "UPDATE:cancelled",
      "INSERT:active",
    ]);
    // record_id is bigint, so the driver hands it back as a string.
    expect(Number(all[0].record_id)).toBe(first);
    expect(Number(all[2].record_id)).toBe(second);
  });
});

describe("auditing does not change subscription behaviour", () => {
  it("leaves the inserted row exactly as written", async () => {
    const id = await addSub({ status: "pending" });
    const row = await db.one(`SELECT * FROM ${TABLE} WHERE id = $1`, [id]);
    expect(row.status).toBe("pending");
    expect(row.item_id).toBe(TEST_CATEGORIES.juice);
    expect(row.fee_amount).toBe(500);
  });

  it("still enforces the one-active-row-per-item constraint", async () => {
    await addSub({ endOffsetDays: 335 });
    await expect(addSub({ endOffsetDays: 335 })).rejects.toThrow();
  });
});
