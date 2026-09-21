// A soft-deleted business unit must not lock a vendor out of their own
// subscription.
//
// Production (2026-09-21): hotel 33 "Demo Business Unit" was soft-deleted while
// 11 vendors still held an active subscription row pointing at it — including
// service@nejyra.com (vendor 908). Two queries disagree about whether that row
// exists:
//
//   read  — getActiveSubscriptionItemsForVendor LEFT JOINs the hotel with NO
//           is_deleted filter, so the summary lists it and the Edit drawer
//           pre-selects it;
//   write — _computeModificationPreview validates hotels with `is_deleted = 0`
//           and answers 400 "One or more selected business units are no longer
//           available."
//
// So the drawer sent back exactly what the server had just given it and was
// rejected. Those 11 vendors could never modify their subscription again: the
// preview fails before they can change anything, including removing the dead
// unit. (The 400 then reached the browser as an unrendered AxiosError and
// white-screened the page — fixed separately on the frontend.)
//
// Both sides are pinned here: the read stops offering vanished items, and the
// write tolerates them if an older client still sends one.
//
// Isolation: Pattern B (commit + cleanup) — the flow runs over real HTTP and
// the production code queries `db` directly.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

// Vendor-user range is 80101..80199 (80161 belongs to the unmap suite).
const VENDOR_ID = 80162;
const COMPANY_ID = 90062;
// Business-unit range is 10101..10199; 10191 is ours alone.
const DEAD_HOTEL_ID = 10191;

const CAT_PARENT = 215; // BEVERAGES — seeded in tests/setup/seed_reference.sql

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

const summary = async () => {
  const client = await httpClient(VENDOR_ID);
  return client.get("/api/v1/hospitality/vendor/subscription-summary");
};

const preview = async (hotels) => {
  const client = await httpClient(VENDOR_ID);
  return client.post("/api/v1/hospitality/vendor/subscription/preview").send({
    target_categories: [CAT_PARENT],
    target_subcategories: [],
    target_hotels: hotels,
  });
};

beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_company (id, company_name, is_hospitality, "createdAt")
     VALUES ($1, 'Deleted Unit Vendor Pvt Ltd', 1, now())
     ON CONFLICT (id) DO NOTHING`,
    [COMPANY_ID]
  );
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'Deleted Unit Vendor', 'deleted.unit@vendor.test', 1, 3, $2, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [VENDOR_ID, COMPANY_ID]
  );

  // The production shape: a business unit that still exists as a row but is
  // soft-deleted, exactly like hotel 33.
  await db.none(
    `INSERT INTO tbl_hospitality_company_hotels
       (id, hospitality_company_id, name, city, is_deleted, fee_amount)
     VALUES ($1, (SELECT hospitality_company_id FROM tbl_hospitality_company_hotels WHERE id = $2),
             'Demo Business Unit (deleted)', 'Mumbai', 1, 500)
     ON CONFLICT (id) DO UPDATE SET is_deleted = 1`,
    [DEAD_HOTEL_ID, IDS.hotels.A1]
  );
});

beforeEach(async () => {
  await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`, [VENDOR_ID]);
  await addSub("category", CAT_PARENT);
  await addSub("hotel", IDS.hotels.A1);
  await addSub("hotel", DEAD_HOTEL_ID); // the orphaned row
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`, [VENDOR_ID]);
  await db.none(`DELETE FROM tbl_hospitality_company_hotels WHERE id = $1`, [DEAD_HOTEL_ID]);
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [VENDOR_ID]);
  await db.none(`DELETE FROM tbl_company WHERE id = $1`, [COMPANY_ID]);
  await closeDb();
});

describe("vendor subscription — soft-deleted items", () => {
  it("leaves a soft-deleted business unit out of the subscription summary", async () => {
    const res = await summary();

    expect(res.status).toBe(200);
    const hotelIds = (res.body.data?.subscription?.hotels || []).map((h) => h.id);
    expect(hotelIds).toContain(IDS.hotels.A1);
    expect(hotelIds).not.toContain(DEAD_HOTEL_ID);
  });

  it("does not count a soft-deleted business unit in the hotel total", async () => {
    const res = await summary();

    expect(res.body.data?.subscription?.total_hotels).toBe(1);
  });

  it("previews successfully when an older client still sends the deleted unit", async () => {
    const res = await preview([IDS.hotels.A1, DEAD_HOTEL_ID]);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
  });

  it("treats the deleted unit as already gone rather than a removal to confirm", async () => {
    const res = await preview([IDS.hotels.A1, DEAD_HOTEL_ID]);

    const diff = res.body.data?.diff || {};
    expect(diff.removed_hotels || []).toHaveLength(0);
    expect(diff.added_hotels || []).toHaveLength(0);
    // Only the surviving unit is priced.
    expect(res.body.data?.pricing?.new_total_hotels_count).toBe(1);
  });

  it("still lets the vendor edit the rest of their subscription", async () => {
    const res = await preview([IDS.hotels.A1]);

    expect(res.status).toBe(200);
    expect(res.body.data?.pricing?.net_cost).toBe(0);
  });
});
