// Removing a sub-category must be confirmed like any other removal.
//
// `confirm_removals` existed to stop a client deleting paid-for items on a
// vendor's behalf, but it only counted categories and hotels. Sub-category
// removals cost nothing, so they slipped through: net_cost 0 rendered as
// "Free", the button read "Apply Changes", and the server applied it without
// asking.
//
// That is precisely how the Edit drawer could have wiped 864 sub-category rows
// across 154 production vendors — it sent target_subcategories: [] because the
// category API never gave it the metadata to do otherwise, and nothing in the
// write path objected. The drawer no longer does that, but a client bug must
// not be able to delete a vendor's items silently ever again.
//
// Isolation: Pattern B (commit + cleanup) — the flow runs over real HTTP and
// the production code queries `db` directly.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

const VENDOR_ID = 80163;
const COMPANY_ID = 90063;

// Seeded reference categories (tests/setup/seed_reference.sql):
//   215 BEVERAGES (parent) -> 218 JUICE (child)
const CAT_PARENT = 215;
const SUBCAT = 218;

async function addSub(itemType, itemId) {
  await db.none(
    `INSERT INTO tbl_vendor_hotel_category_subscription
       (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
     VALUES ($1, $2, $3, 500,
             (now() - interval '30 days')::date,
             (now() + interval '335 days')::date,
             'active')`,
    [VENDOR_ID, itemType, itemId]
  );
}

/** Drop the sub-category, keep the paid parent. */
async function removeSubcategory({ confirm }) {
  const client = await httpClient(VENDOR_ID);
  const body = {
    target_categories: [CAT_PARENT],
    target_subcategories: [],
    target_hotels: [IDS.hotels.A1],
  };
  if (confirm) body.confirm_removals = true;
  return client.post("/api/v1/hospitality/vendor/subscription/modify").send(body);
}

const activeSubcategoryCount = async () => {
  const row = await db.one(
    `SELECT COUNT(*)::int AS n
       FROM tbl_vendor_hotel_category_subscription
      WHERE vendor_id = $1 AND item_type = 'subcategory' AND status = 'active'`,
    [VENDOR_ID]
  );
  return row.n;
};

beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_company (id, company_name, is_hospitality, "createdAt")
     VALUES ($1, 'Removal Confirm Vendor Pvt Ltd', 1, now())
     ON CONFLICT (id) DO NOTHING`,
    [COMPANY_ID]
  );
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'Removal Confirm Vendor', 'removal.confirm@vendor.test', 1, 3, $2, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [VENDOR_ID, COMPANY_ID]
  );
});

beforeEach(async () => {
  await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`, [VENDOR_ID]);
  await addSub("category", CAT_PARENT);
  await addSub("subcategory", SUBCAT);
  await addSub("hotel", IDS.hotels.A1);
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`, [VENDOR_ID]);
  await db.none(`DELETE FROM tbl_vendor_payments WHERE vendor_id = $1`, [VENDOR_ID]);
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [VENDOR_ID]);
  await db.none(`DELETE FROM tbl_company WHERE id = $1`, [COMPANY_ID]);
  await closeDb();
});

describe("vendor subscription modify — removal confirmation", () => {
  it("refuses to drop a sub-category when the client did not confirm", async () => {
    const res = await removeSubcategory({ confirm: false });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/confirm/i);
  });

  it("leaves the sub-category in place after an unconfirmed attempt", async () => {
    await removeSubcategory({ confirm: false });

    expect(await activeSubcategoryCount()).toBe(1);
  });

  it("drops the sub-category once the client confirms", async () => {
    const res = await removeSubcategory({ confirm: true });

    expect(res.status).toBe(200);
    expect(await activeSubcategoryCount()).toBe(0);
  });
});
