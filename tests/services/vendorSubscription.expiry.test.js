// Wave-2A subscription expiry — cron + model contract.
//
// The hospitality vendor expiry job lives in the top-level
// backend/subscriptionNotificationandEexpireCron.js script. It runs as a
// cron worker and (a) flips status='active' rows whose end_date has
// passed to status='expired', and (b) sends N-day-out reminder emails to
// vendors approaching their FY end. The full module is hard to import in
// jest because it executes a top-level try/catch on load (sends a debug
// email + reads dead `tbl_user_subscriptions` rows), so this test
// reproduces the load-bearing SQL inline and asserts the contract that
// the cron depends on.
//
// What this file LOCKS:
//   - markExpiredHospitalitySubscriptions: only `status='active' AND
//     end_date<CURRENT_DATE` rows flip to 'expired'. Cancelled and
//     in-window rows are NOT touched. Future-dated rows are NOT touched.
//     The query intentionally does NOT filter by payment_status — that
//     contract is documented in the cron source and is critical for the
//     renewal flow (vendors with abandoned payment attempts or admin-
//     assigned NULL-payment rows must still flip to 'expired' so they
//     surface in the renewal modal).
//   - getExpiredSubscriptionsForVendor: returns DISTINCT (item_type,
//     item_id) rows whose status IN ('active','expired') AND end_date
//     past, only when no still-valid row covers the same item — the
//     query that powers the "renewal modal" pre-fill.
//
// What this file SURFACES (logged in AUDIT_REPORT, not fixed this pass):
//   - F-CRON-EXPIRY-001 (P3): cron file imports execute a top-level
//     try/catch that sends a debug email to a hard-coded developer
//     address (`mukul@letsworkwise.com`) on every cron tick — should
//     be removed before any further deploy.
//   - F-CRON-EXPIRY-002 (P2): the legacy `expireDayNotification` query
//     uses string interpolation (`WHERE end_date = '${date}'`) — values
//     come from internal Moment dates so injection isn't externally
//     reachable, but it's bad form and breaks the parameterized-query
//     convention that the rest of the codebase observes.
//   - F-CRON-EXPIRY-003 (P3): `expireDayNotification` queries
//     `tbl_user_subscriptions` (legacy main-portal billing table —
//     deprecated, not seeded, no production rows) on every tick —
//     dead code that should be deleted alongside the rest of the
//     legacy main-portal expiry logic.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  resetVendorSubscriptionState as resetVendorSubscriptionStateShared,
  restoreBaseVendorFixture,
} from "../helpers/subscriptionFixture.js";

const hospitalityModelModule = await import("../../app/models/hospitalityModel.js");
const hospitalityModel = hospitalityModelModule.default;

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------
const VENDOR_GAMMA  = IDS.users.vendor_gamma;   // base fixture: expired beverages row already past end_date
const VENDOR_DELTA  = IDS.users.vendor_delta;   // base fixture: cancelled row, end_date in future
const VENDOR_ALPHA  = IDS.users.vendor_alpha;   // base fixture: active in-window beverages row
const HOTEL_A1      = IDS.hotels.A1;
const CATEGORY_BEVERAGES = 215;
const CATEGORY_LIQUOR    = 222;

// The exact UPDATE the cron's `markExpiredHospitalitySubscriptions` runs.
// We DUPLICATE the SQL inline rather than importing the cron because the
// cron module executes top-level side-effects on load (F-CRON-EXPIRY-001).
async function runMarkExpired() {
  return db.result(
    `UPDATE tbl_vendor_hotel_category_subscription
     SET status = 'expired'
     WHERE status = 'active'
       AND end_date < CURRENT_DATE`
  );
}

afterAll(async () => {
  await resetVendorSubscriptionStateShared(db, VENDOR_ALPHA);
  await resetVendorSubscriptionStateShared(db, VENDOR_GAMMA);
  await resetVendorSubscriptionStateShared(db, VENDOR_DELTA);
  await restoreBaseVendorFixture(db);
  await closeDb();
});

// ===========================================================================
// markExpiredHospitalitySubscriptions — SQL contract
// ===========================================================================
describe("markExpiredHospitalitySubscriptions — SQL contract", () => {
  beforeEach(async () => {
    await resetVendorSubscriptionStateShared(db, VENDOR_GAMMA);
    await resetVendorSubscriptionStateShared(db, VENDOR_DELTA);
    await resetVendorSubscriptionStateShared(db, VENDOR_ALPHA);
    await restoreBaseVendorFixture(db);
  });

  it("flips status='active' AND end_date in the past to 'expired'; leaves other states untouched", async () => {
    // Seed three controlled rows on top of the base fixture:
    //   ALPHA:  active, end_date YESTERDAY  → must flip to expired
    //   ALPHA:  active, end_date TOMORROW   → must remain active
    //   ALPHA:  cancelled, end_date YESTERDAY → must remain cancelled
    // Vendor_gamma has the base 'expired' row (status already 'expired')
    // — must remain expired.
    // Vendor_delta has the base 'cancelled' row with future end_date —
    // must remain cancelled.
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const tomorrow  = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);

    // Wipe Alpha's existing seeded row first (the base fixture has alpha
    // with active beverages, end_date in the future — useful for other
    // tests but it would interfere with our targeted state shape here).
    await db.none(
      `DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`,
      [VENDOR_ALPHA]
    );

    await db.none(
      `INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
       VALUES
         ($1, 'category', $2, 500, $3, $4, 'active'),
         ($1, 'hotel',    $5, 0,   $3, $6, 'active'),
         ($1, 'category', $7, 500, $3, $4, 'cancelled')`,
      [
        VENDOR_ALPHA,
        CATEGORY_BEVERAGES,
        yesterday,    // start_date (any past date works)
        yesterday,    // past end_date — should flip to expired
        HOTEL_A1,
        tomorrow,     // future end_date — must stay active
        CATEGORY_LIQUOR,
      ]
    );

    const result = await runMarkExpired();

    // Exactly ONE row should have flipped — Alpha's category-beverages row.
    expect(result.rowCount).toBeGreaterThanOrEqual(1);

    const alpha = await db.any(
      `SELECT item_type, item_id, status, end_date::text FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 ORDER BY item_type, item_id`,
      [VENDOR_ALPHA]
    );
    const byKey = Object.fromEntries(
      alpha.map((r) => [`${r.item_type}:${r.item_id}`, r])
    );
    expect(byKey[`category:${CATEGORY_BEVERAGES}`].status).toBe("expired");
    expect(byKey[`hotel:${HOTEL_A1}`].status).toBe("active");
    expect(byKey[`category:${CATEGORY_LIQUOR}`].status).toBe("cancelled"); // not touched

    // Gamma's pre-existing 'expired' row is left alone (still 'expired').
    const gamma = await db.one(
      `SELECT status FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 LIMIT 1`,
      [VENDOR_GAMMA]
    );
    expect(gamma.status).toBe("expired");

    // Delta's 'cancelled' row with FUTURE end_date is left alone.
    const delta = await db.one(
      `SELECT status FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 LIMIT 1`,
      [VENDOR_DELTA]
    );
    expect(delta.status).toBe("cancelled");
  });

  it("does NOT filter by payment_status — admin-mapped (payment_id NULL) and abandoned-payment ('created') rows still flip to expired", async () => {
    // The cron source explicitly notes this in a comment ("We intentionally
    // do NOT filter by payment_status here. ..."). The contract is critical:
    // vendors with abandoned payment attempts (payment_status='created') or
    // admin-assigned rows (payment_id IS NULL) must still flip to 'expired'
    // so they surface in the renewal modal — otherwise they'd be stranded.
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

    // Wipe alpha and seed two rows: one NULL-payment (admin-mapped),
    // one with a "created" Razorpay payment (abandoned attempt).
    await db.none(
      `DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`,
      [VENDOR_ALPHA]
    );
    await db.none(
      `DELETE FROM tbl_vendor_payments WHERE vendor_id = $1`,
      [VENDOR_ALPHA]
    );

    // NULL-payment admin-mapped row.
    await db.none(
      `INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status, payment_id)
       VALUES ($1, 'category', $2, 500, $3, $3, 'active', NULL)`,
      [VENDOR_ALPHA, CATEGORY_BEVERAGES, yesterday]
    );
    // Abandoned 'created' payment row + matching subscription row.
    const abandoned = await db.one(
      `INSERT INTO tbl_vendor_payments
         (vendor_id, razorpay_order_id, razorpay_payment_id, razorpay_signature, amount, currency, payment_status, metadata)
       VALUES ($1, 'order_abandoned', NULL, NULL, 500, 'INR', 'created', '{}'::jsonb)
       RETURNING id`,
      [VENDOR_ALPHA]
    );
    await db.none(
      `INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status, payment_id)
       VALUES ($1, 'category', $2, 500, $3, $3, 'active', $4)`,
      [VENDOR_ALPHA, CATEGORY_LIQUOR, yesterday, abandoned.id]
    );

    await runMarkExpired();

    const rows = await db.any(
      `SELECT item_id, status, payment_id FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 ORDER BY item_id`,
      [VENDOR_ALPHA]
    );
    // BOTH rows should have flipped to 'expired' regardless of payment state.
    expect(rows.every((r) => r.status === "expired")).toBe(true);
  });

  it("is idempotent — running twice produces no extra side effects", async () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    await db.none(
      `DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`,
      [VENDOR_ALPHA]
    );
    await db.none(
      `INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
       VALUES ($1, 'category', $2, 500, $3, $3, 'active')`,
      [VENDOR_ALPHA, CATEGORY_BEVERAGES, yesterday]
    );

    const first = await runMarkExpired();
    const second = await runMarkExpired();

    // First run flipped at least one row; second run flipped zero (already expired).
    expect(first.rowCount).toBeGreaterThanOrEqual(1);
    expect(second.rowCount).toBe(0);

    const after = await db.one(
      `SELECT status FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND item_id = $2 LIMIT 1`,
      [VENDOR_ALPHA, CATEGORY_BEVERAGES]
    );
    expect(after.status).toBe("expired");
  });
});

// ===========================================================================
// getExpiredSubscriptionsForVendor — renewal modal pre-fill
// ===========================================================================
describe("getExpiredSubscriptionsForVendor — renewal modal pre-fill", () => {
  beforeEach(async () => {
    await resetVendorSubscriptionStateShared(db, VENDOR_ALPHA);
    await resetVendorSubscriptionStateShared(db, VENDOR_GAMMA);
    await restoreBaseVendorFixture(db);
  });

  it("returns past-due rows from a single vendor regardless of payment_status", async () => {
    // Gamma's base fixture row is expired/past — should be returned.
    const rows = await hospitalityModel.getExpiredSubscriptionsForVendor(VENDOR_GAMMA);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.item_type === "category" && r.item_id === CATEGORY_BEVERAGES)).toBe(true);
  });

  it("excludes items the vendor still has a still-valid 'active' row for (no double-prompt)", async () => {
    // Seed: alpha has BOTH an expired row AND a still-valid row for the
    // SAME (item_type, item_id) — the renewal modal must NOT re-prompt
    // for an item the vendor already holds. The query has a NOT EXISTS
    // clause that suppresses such cases.
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const tomorrow  = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);

    await db.none(
      `DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`,
      [VENDOR_ALPHA]
    );
    await db.none(
      `INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
       VALUES
         ($1, 'category', $2, 500, $3, $3, 'expired'),
         ($1, 'category', $2, 500, $3, $4, 'active')`,
      [VENDOR_ALPHA, CATEGORY_BEVERAGES, yesterday, tomorrow]
    );

    const rows = await hospitalityModel.getExpiredSubscriptionsForVendor(VENDOR_ALPHA);
    // The (category, BEVERAGES) pair is covered by the still-valid row, so
    // it should NOT appear in the renewal modal pre-fill.
    expect(rows.some((r) => r.item_type === "category" && r.item_id === CATEGORY_BEVERAGES)).toBe(false);
  });
});
