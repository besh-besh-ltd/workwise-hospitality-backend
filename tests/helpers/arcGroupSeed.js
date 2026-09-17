// Test helpers for group rate contracts (one ARC, several hotels).
//
// Vendor eligibility for ARC needs BOTH a category subscription and a hotel
// subscription (the RFQ rule). Fixture vendors only hold category
// subscriptions, and fixture users carry a NULL user_type, so a suite that
// needs vendors to qualify for an ARC grants hotel subscriptions and the vendor
// user type here — per suite, never in the global fixtures that RFQ suites share.
//
// Every grant returns what it created so the suite can undo exactly that.

import { db } from "../setup/db.js";

const iso = (daysFromToday) =>
  new Date(Date.now() + daysFromToday * 86400_000).toISOString().slice(0, 10);

/**
 * Grant each vendor a hotel subscription for each hotel.
 * status 'active' runs from 30 days ago to 335 days ahead; 'expired' ended
 * 10 days ago. Returns the inserted subscription ids.
 */
export async function grantVendorHotelSubs(vendorIds, hotelIds, { status = "active" } = {}, runner = db) {
  const [start, end] = status === "active" ? [iso(-30), iso(335)] : [iso(-375), iso(-10)];
  const ids = [];
  for (const vendorId of vendorIds) {
    for (const hotelId of hotelIds) {
      // ON CONFLICT: a row left behind by a crashed run is already an
      // equivalent grant — reuse it rather than failing the suite, and don't
      // claim it for cleanup (it is not ours).
      const row = await runner.oneOrNone(
        `INSERT INTO tbl_vendor_hotel_category_subscription
           (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
         VALUES ($1, 'hotel', $2, 500, $3, $4, $5)
         ON CONFLICT ON CONSTRAINT uq_vendor_hotel_category_subscription DO NOTHING
         RETURNING id`,
        [vendorId, hotelId, start, end, status]
      );
      if (row) ids.push(row.id);
    }
  }
  return ids;
}

// Every fixture vendor (alpha, beta, gamma, delta, epsilon). Suites written
// before ARC required a hotel subscription relied on the CATEGORY subscription
// alone to decide who qualifies. Granting all of them an ACTIVE hotel
// subscription for the suite's hotels restores exactly that intent: each
// vendor's category subscription (active / expired / cancelled / pending /
// none) still decides the outcome.
export const FIXTURE_VENDOR_IDS = Object.freeze([80101, 80102, 80103, 80104, 80105]);

export async function grantFixtureVendorHotelSubs(hotelIds, runner = db) {
  return grantVendorHotelSubs(FIXTURE_VENDOR_IDS, hotelIds, { status: "active" }, runner);
}

/** Grant a category subscription. Returns the inserted id. */
export async function grantVendorCategorySub(vendorId, categoryId, { status = "active" } = {}, runner = db) {
  const [start, end] = status === "active" ? [iso(-30), iso(335)] : [iso(-375), iso(-10)];
  const row = await runner.one(
    `INSERT INTO tbl_vendor_hotel_category_subscription
       (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
     VALUES ($1, 'category', $2, 500, $3, $4, $5)
     RETURNING id`,
    [vendorId, categoryId, start, end, status]
  );
  return row.id;
}

export async function revokeVendorSubs(ids, runner = db) {
  if (!ids?.length) return;
  await runner.none(
    `DELETE FROM tbl_vendor_hotel_category_subscription WHERE id = ANY($1::int[])`,
    [ids]
  );
}

/**
 * Mark users as vendors (user_type 3). Returns their previous user_type so
 * restoreUserTypes can put them back.
 */
export async function markAsVendors(userIds, runner = db) {
  const before = await runner.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [userIds]);
  await runner.none(`UPDATE tbl_users SET user_type = 3 WHERE id = ANY($1::int[])`, [userIds]);
  return before;
}

export async function restoreUserTypes(before, runner = db) {
  for (const row of before || []) {
    await runner.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [row.id, row.user_type]);
  }
}
