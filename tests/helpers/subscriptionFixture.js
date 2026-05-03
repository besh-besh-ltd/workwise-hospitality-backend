// Shared subscription-fixture helpers for Wave-2A vendor flow tests
// (modify / extend / create / cancel / expiry). Each test file seeds a
// vendor's tbl_vendor_hotel_category_subscription state programmatically
// + a paid tbl_vendor_payments row to satisfy hasValidPaidSubscription.
//
// USAGE:
//   import {
//     seedPaidSubscription,
//     resetVendorSubscriptionState,
//     restoreBaseVendorFixture,
//   } from "../helpers/subscriptionFixture.js";
//
//   beforeEach(async () => {
//     await resetVendorSubscriptionState(db, VENDOR_ID);
//   });
//
//   afterAll(async () => {
//     // Restore the seed_fixtures state so cross-suite tests (harness.smoke,
//     // rfq.create.flow eligibility) see the original 6-row subscription set.
//     await restoreBaseVendorFixture(db);
//   });
//
//   it("...", async () => {
//     await seedPaidSubscription(db, {
//       vendorId: VENDOR_ID,
//       categories: [CATEGORY_BEVERAGES],
//       hotels: [HOTEL_A1, HOTEL_A2],
//     });
//     // ... drive the controller
//   });

import { seedVendorSubscriptions } from "../fixtures/vendors.js";

/**
 * Seed an active paid subscription for `vendorId`. Inserts:
 *   - One row in `tbl_vendor_payments` with payment_status='success' and
 *     payment_type='hospitality'.
 *   - One `tbl_vendor_hotel_category_subscription` row per category /
 *     subcategory / hotel id, all status='active', end_date `endDays`
 *     in the future (default 300).
 *
 * Returns { paymentId, sharedEndDate, subRows: [{id, item_type, item_id}] }.
 */
export async function seedPaidSubscription(db, opts = {}) {
  const {
    vendorId,
    categories = [],
    subcategories = [],
    hotels = [],
    endDays = 300,
    feePerItem = 500,
  } = opts;
  if (!vendorId) throw new Error("seedPaidSubscription: vendorId is required");

  const today = new Date().toISOString().slice(0, 10);
  const endDate = new Date(Date.now() + endDays * 86400_000)
    .toISOString()
    .slice(0, 10);

  const payment = await db.one(
    `INSERT INTO tbl_vendor_payments
       (vendor_id, razorpay_order_id, razorpay_payment_id, razorpay_signature,
        amount, currency, payment_status, payment_type, receipt, before_payment_response, metadata)
     VALUES ($1, $2, $3, $4, $5, 'INR', 'success', 'hospitality', $6, '{}'::jsonb, $7::jsonb)
     RETURNING id`,
    [
      vendorId,
      `order_seed_${vendorId}_${Date.now()}`,
      `pay_seed_${vendorId}_${Date.now()}`,
      `sig_seed_${vendorId}_${Date.now()}`,
      categories.length * feePerItem + hotels.length * feePerItem * 2,
      `rcpt_seed_${vendorId}_${Date.now()}`,
      JSON.stringify({ type: "registration", seeded_by: "subscriptionFixture.js" }),
    ]
  );

  const inserted = [];
  const insertOne = async (item_type, item_id) => {
    const row = await db.one(
      `INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status, payment_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
       RETURNING id`,
      [vendorId, item_type, item_id, feePerItem, today, endDate, payment.id]
    );
    inserted.push({ id: row.id, item_type, item_id });
  };

  for (const cid of categories) await insertOne("category", cid);
  for (const sid of subcategories) await insertOne("subcategory", sid);
  for (const hid of hotels) await insertOne("hotel", hid);

  return { paymentId: payment.id, sharedEndDate: endDate, subRows: inserted };
}

/**
 * Wipe a single vendor's subscription + payment rows. Use in beforeEach
 * to start each test with a known empty state for that vendor.
 */
export async function resetVendorSubscriptionState(db, vendorId) {
  if (!vendorId) throw new Error("resetVendorSubscriptionState: vendorId is required");
  await db.none(
    `DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`,
    [vendorId]
  );
  await db.none(`DELETE FROM tbl_vendor_payments WHERE vendor_id = $1`, [vendorId]);
}

/**
 * Re-seed the BASE vendor-subscription fixture (the 6-row set from
 * tests/fixtures/vendors.js) for ALL fixture vendors. Use in afterAll so
 * cross-suite tests that count tbl_vendor_hotel_category_subscription rows
 * (notably harness.smoke's truncateDynamic test, and rfq.create.flow's
 * eligibility query) see the original shape.
 *
 * Caller is responsible for first DELETE'ing the vendors that THIS suite
 * touched — restoreBaseVendorFixture only ON CONFLICT-ignores so existing
 * rows are kept. The pattern is:
 *
 *   afterAll(async () => {
 *     await resetVendorSubscriptionState(db, VENDOR_ID);
 *     await db.tx((t) => seedVendorSubscriptions(t));  // <- this helper
 *   });
 */
export async function restoreBaseVendorFixture(db) {
  await db.tx((t) => seedVendorSubscriptions(t));
}
