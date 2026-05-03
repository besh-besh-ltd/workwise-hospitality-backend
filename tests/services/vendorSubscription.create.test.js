// Wave-2A subscription registration / renewal entrypoint.
//
// Covers the public POST /api/v1/hospitality/subscription-payment endpoint
// (`UsersController.hospitalitySubscriptionPayment`). This is the
// initial-purchase + post-expiry-renewal counterpart to modifySubscription /
// extendSubscription, and unlike them it runs WITHOUT passportSignIn: the
// vendor identifies themselves via an AES-encrypted `user_key` body param
// (cryptr) which the handler decrypts to recover the vendor_id. Tests
// reproduce that envelope by encrypting test vendor IDs with the same
// CRYPT_SECRET the controller decrypts against (sourced from .env.test).
//
// Surface tested:
//   POST /api/v1/hospitality/subscription-payment → hospitalitySubscriptionPayment
//
// Defect locks added in this file:
//   - F-SUB-002 (registration): re-submitted subscription-payment with an
//     in-flight pending Razorpay order MUST return the existing order_id.
//     Same idempotency contract that landed for modifySubscription (4cdfb5e)
//     and extendSubscription (ef97662). The fix is NOT yet applied in the
//     registration entrypoint — this test currently exercises the failure
//     mode and will turn GREEN once the production patch lands.
//   - F-SUB-009 (NEW — free-renewal crash): the free-renewal branch
//     (totalAmount === 0, e.g. hotels-only renewal) treats the result of
//     `createVendorPayment(...)` as a payment_id integer when the model
//     actually returns the row object `{ id: N }`. The subsequent
//     `createVendorHotelCategorySubscription` insert sends `{"id":N}` as
//     payment_id, and Postgres rejects with `invalid input syntax for type
//     integer`. Result: HTTP 500 + the vendor's free-renewal subscription
//     rows never get written. The test asserts the post-fix happy-path
//     (200, free_renewal=true, rows inserted, vendor.status flipped). It
//     fails today — the crash surfaces as 400 from the catch-all error
//     handler.

import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { mockExpress } from "../helpers/mockExpress.js";
import { makeRazorpayMock } from "../helpers/razorpayMock.js";
import {
  resetVendorSubscriptionState as resetVendorSubscriptionStateShared,
  restoreBaseVendorFixture,
} from "../helpers/subscriptionFixture.js";
import Cryptr from "cryptr";
import Config from "../../app/config/app.config.js";

// ---------------------------------------------------------------------------
// Module mocks — must run BEFORE the controller is imported.
// ---------------------------------------------------------------------------
const razorpay = makeRazorpayMock({ orderIdPrefix: "order_create_test" });
jest.unstable_mockModule("razorpay", razorpay.factory);

jest.unstable_mockModule("@aws-sdk/client-scheduler", () => ({
  SchedulerClient: class { send = async () => ({}); },
  CreateScheduleCommand: class {},
  UpdateScheduleCommand: class {},
  DeleteScheduleCommand: class {},
  GetScheduleCommand: class {},
  ListSchedulesCommand: class {},
  CreateScheduleGroupCommand: class {},
}));

const usersModule = await import("../../app/controllers/users/usersController.js");
const usersController = usersModule.default;

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

// Match the controller's cryptr instance (Config.cryptR.secret <- CRYPT_SECRET).
// We construct our own here rather than importing the controller's instance
// because the controller doesn't export it — but the secret is the same.
const cryptr = new Cryptr(Config.cryptR.secret);
const encryptId = (id) => cryptr.encrypt(String(id));

const VENDOR_ALPHA    = IDS.users.vendor_alpha;    // active sub  → already-active path
const VENDOR_GAMMA    = IDS.users.vendor_gamma;    // expired sub → renewal path
const VENDOR_DELTA    = IDS.users.vendor_delta;    // cancelled  → free renewal / NO_RENEWABLE_ITEMS
const NON_VENDOR_USER = IDS.users.companyA_admin;  // user_type !== 3 path
const HOTEL_A1        = IDS.hotels.A1;
const CATEGORY_BEVERAGES = 215;

afterAll(async () => {
  // Clean each vendor we touched, restore base fixture, restore mutated
  // user.status (we flip vendor_delta to 0 in one test). All three are
  // necessary for cross-suite hygiene — vendorEligibility and
  // rfq.create.flow both read from these tables.
  await resetVendorSubscriptionStateShared(db, VENDOR_ALPHA);
  await resetVendorSubscriptionStateShared(db, VENDOR_GAMMA);
  await resetVendorSubscriptionStateShared(db, VENDOR_DELTA);
  await db.none(`UPDATE tbl_users SET status = 1 WHERE id = $1`, [VENDOR_DELTA]);
  await restoreBaseVendorFixture(db);
  await closeDb();
});

beforeEach(() => {
  razorpay.captured.instances.length = 0;
  razorpay.captured.orders_create.length = 0;
});

// ===========================================================================
// Input validation
// ===========================================================================
describe("hospitalitySubscriptionPayment — input validation", () => {
  it("rejects missing user_key with 400", async () => {
    const m = mockExpress({ body: {} });
    await usersController.hospitalitySubscriptionPayment(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/missing required user key/i);
    expect(razorpay.captured.orders_create.length).toBe(0);
  });

  it("rejects malformed cryptr token with 400 'Invalid user token'", async () => {
    const m = mockExpress({ body: { user_key: "not-a-valid-cryptr-blob" } });
    await usersController.hospitalitySubscriptionPayment(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/invalid user token/i);
  });

  it("rejects user_key that decrypts to an unknown user_id with 'User not found'", async () => {
    const m = mockExpress({ body: { user_key: encryptId(99999999) } });
    await usersController.hospitalitySubscriptionPayment(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/user not found/i);
  });

  it("rejects non-vendor caller (user_type !== 3) with 'Only vendors can purchase'", async () => {
    // companyA_admin is a buyer — fixture leaves user_type NULL on purpose,
    // and the handler's `userRecord.user_type !== 3` check rejects anything
    // that isn't explicitly a vendor (3). This is the defensive guard that
    // stops a leaked CRYPT_SECRET from being used to forge tokens for
    // arbitrary buyer users.
    const m = mockExpress({ body: { user_key: encryptId(NON_VENDOR_USER) } });
    await usersController.hospitalitySubscriptionPayment(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/only vendors/i);
    expect(razorpay.captured.orders_create.length).toBe(0);
  });

  it("rejects vendor that already has an active subscription", async () => {
    // vendor_alpha has an in-window beverages sub seeded by the base fixture
    // with payment_id NULL — hasValidPaidSubscription returns true via the
    // NULL-payment branch, so the registration endpoint blocks this.
    const m = mockExpress({ body: { user_key: encryptId(VENDOR_ALPHA) } });
    await usersController.hospitalitySubscriptionPayment(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/already have an active subscription/i);
    expect(razorpay.captured.orders_create.length).toBe(0);
  });
});

// ===========================================================================
// Renewal happy path (paid)
// ===========================================================================
describe("hospitalitySubscriptionPayment — paid renewal happy path", () => {
  beforeEach(async () => {
    // Wipe gamma's payments + product mappings, then re-seed gamma's
    // expired beverages row from the base fixture. Without the wipe we
    // accumulate pending payment rows from earlier tests and can't assert
    // a clean "one new pending row" outcome.
    await resetVendorSubscriptionStateShared(db, VENDOR_GAMMA);
    await restoreBaseVendorFixture(db);
  });

  it("with empty body and an expired sub, pulls categories from getExpiredSubscriptionsForVendor and creates a Razorpay order", async () => {
    const m = mockExpress({ body: { user_key: encryptId(VENDOR_GAMMA) } });
    await usersController.hospitalitySubscriptionPayment(m.req, m.res);

    expect(m.calls.status).toBe(200);
    expect(m.calls.body.status).toBe(1);
    // Per-controller contract: `data` is the order_id string (NOT an object —
    // unlike the modify/extend handlers which return { order_id, amount, ... }).
    expect(typeof m.calls.body.data).toBe("string");
    expect(m.calls.body.data).toMatch(/^order_create_test_\d+$/);

    // Razorpay called once with INR + receipt PAY-prefixed.
    expect(razorpay.captured.orders_create.length).toBe(1);
    const orderCall = razorpay.captured.orders_create[0];
    expect(orderCall.currency).toBe("INR");
    expect(orderCall.receipt).toMatch(/^PAY/);
    expect(orderCall.amount).toBeGreaterThan(0);

    // tbl_vendor_payments row written with payment_status='created' and
    // metadata.subscription_items containing the renewable categories.
    const pending = await db.oneOrNone(
      `SELECT payment_status, razorpay_order_id, metadata
       FROM tbl_vendor_payments
       WHERE vendor_id = $1 AND payment_status = 'created'
       ORDER BY id DESC LIMIT 1`,
      [VENDOR_GAMMA]
    );
    expect(pending).not.toBeNull();
    expect(pending.razorpay_order_id).toBe(orderCall.__returned.id);
    const meta = typeof pending.metadata === "string"
      ? JSON.parse(pending.metadata)
      : pending.metadata;
    expect(Array.isArray(meta.subscription_items)).toBe(true);
    expect(
      meta.subscription_items.some(
        (i) => i.item_type === "category" && i.item_id === CATEGORY_BEVERAGES
      )
    ).toBe(true);

    // No new ACTIVE subscription rows yet — those wait for verifyPayment.
    // Gamma's only existing row is still status='expired'.
    const newRows = await db.any(
      `SELECT id, status FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND status = 'active'`,
      [VENDOR_GAMMA]
    );
    expect(newRows.length).toBe(0);
  });
});

// ===========================================================================
// F-SUB-002 (registration) — defect lock
// ===========================================================================
describe("hospitalitySubscriptionPayment — F-SUB-002 (registration) defect lock", () => {
  beforeEach(async () => {
    await resetVendorSubscriptionStateShared(db, VENDOR_GAMMA);
    await restoreBaseVendorFixture(db);
  });

  it("F-SUB-002 (registration) — re-submitted call with an in-flight pending Razorpay order MUST return the existing order_id (no duplicate Razorpay order)", async () => {
    // First call mints the order.
    const first = mockExpress({ body: { user_key: encryptId(VENDOR_GAMMA) } });
    await usersController.hospitalitySubscriptionPayment(first.req, first.res);
    expect(first.calls.status).toBe(200);
    const firstOrderId = first.calls.body.data;
    expect(razorpay.captured.orders_create.length).toBe(1);

    // Second call — should NOT mint a fresh Razorpay order. POST-FIX:
    // detect the pending tbl_vendor_payments row for this vendor (payment_status
    // IN ('created','pending') AND no metadata.kind, since registration
    // metadata is left kind-less to distinguish from modification/extension)
    // and short-circuit by returning its existing order_id. The fix mirrors
    // the modify-flow F-SUB-002 fix (4cdfb5e: getPendingModificationForVendor)
    // and the extend-flow fix (ef97662: getPendingExtensionForVendor) — at
    // present the registration entrypoint has no idempotency guard, so a
    // resubmit creates a brand-new Razorpay order on every call. Vendor
    // double-charge risk is the same shape as modify/extend.
    const second = mockExpress({ body: { user_key: encryptId(VENDOR_GAMMA) } });
    await usersController.hospitalitySubscriptionPayment(second.req, second.res);
    expect(second.calls.status).toBe(200);
    expect(razorpay.captured.orders_create.length).toBe(1);
    expect(second.calls.body.data).toBe(firstOrderId);
  });
});

// ===========================================================================
// Free renewal path (totalAmount === 0)
// ===========================================================================
describe("hospitalitySubscriptionPayment — free renewal (totalAmount === 0)", () => {
  beforeEach(async () => {
    // Reset delta and drop status to 0 so the post-renewal flip to 1 is
    // observable. Strip its existing cancelled row so the test asserts
    // clean inserts (no other 'active' rows in the way).
    await resetVendorSubscriptionStateShared(db, VENDOR_DELTA);
    await db.none(`UPDATE tbl_users SET status = 0 WHERE id = $1`, [VENDOR_DELTA]);
  });

  it("with an explicit hotels-only body (no categories), bypasses Razorpay, inserts active subscription rows, and flips vendor.status to 1", async () => {
    const m = mockExpress({
      body: { user_key: encryptId(VENDOR_DELTA), hotels: [HOTEL_A1] },
    });
    await usersController.hospitalitySubscriptionPayment(m.req, m.res);

    expect(m.calls.status).toBe(200);
    expect(m.calls.body.status).toBe(1);
    expect(m.calls.body.free_renewal).toBe(true);

    // No Razorpay order minted on the free path.
    expect(razorpay.captured.orders_create.length).toBe(0);

    // Active subscription row inserted for the hotel; fee_amount = 0
    // (hotels are zero-priced under the current pricing model).
    const newRow = await db.oneOrNone(
      `SELECT status, item_type, item_id, fee_amount, payment_id
       FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND item_type = 'hotel' AND item_id = $2`,
      [VENDOR_DELTA, HOTEL_A1]
    );
    expect(newRow).not.toBeNull();
    expect(newRow.status).toBe("active");
    expect(Number(newRow.fee_amount)).toBe(0);
    expect(newRow.payment_id).not.toBeNull();

    // Free-path payment row: amount=0, payment_status='success',
    // metadata.type='free_renewal' (the marker analogous to the
    // 'modification_free' marker on modifySubscription's free path).
    const freePayment = await db.oneOrNone(
      `SELECT amount, payment_status, metadata
       FROM tbl_vendor_payments
       WHERE id = $1`,
      [newRow.payment_id]
    );
    expect(freePayment).not.toBeNull();
    expect(Number(freePayment.amount)).toBe(0);
    expect(freePayment.payment_status).toBe("success");
    const meta = typeof freePayment.metadata === "string"
      ? JSON.parse(freePayment.metadata)
      : freePayment.metadata;
    expect(meta.type).toBe("free_renewal");

    // Vendor approval status flipped to 1 so subsequent login proceeds
    // down the normal authenticated path.
    const u = await db.one(`SELECT status FROM tbl_users WHERE id = $1`, [VENDOR_DELTA]);
    expect(u.status).toBe(1);
  });
});

// ===========================================================================
// NO_RENEWABLE_ITEMS code path
// ===========================================================================
describe("hospitalitySubscriptionPayment — NO_RENEWABLE_ITEMS", () => {
  beforeEach(async () => {
    // Wipe delta's only sub row (cancelled) so getExpiredSubscriptionsForVendor
    // and getPendingSubscriptionsForVendor both return empty for this vendor.
    // Cancelled rows aren't picked up by getExpiredSubscriptionsForVendor
    // anyway (it filters status IN ('active','expired')), but the wipe
    // makes the test self-evidently clean.
    await resetVendorSubscriptionStateShared(db, VENDOR_DELTA);
  });

  it("returns 400 with code='NO_RENEWABLE_ITEMS' when vendor has no pending/expired subs and empty body", async () => {
    const m = mockExpress({ body: { user_key: encryptId(VENDOR_DELTA) } });
    await usersController.hospitalitySubscriptionPayment(m.req, m.res);

    expect(m.calls.status).toBe(400);
    expect(m.calls.body.code).toBe("NO_RENEWABLE_ITEMS");
    expect(m.calls.body.message).toMatch(/no subscription items/i);
    expect(razorpay.captured.orders_create.length).toBe(0);
  });
});
