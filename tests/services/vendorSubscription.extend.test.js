// Wave-2A subscription extend flow.
//
// Covers WH-74 vendor self-service subscription extension. Vendor with an
// active subscription clicks "Extend by 1 FY" → server computes the new
// end_date (snap to March 31), totals the categories × hotels fee for the
// extension period, creates a Razorpay order, and on payment verification
// UPDATEs existing tbl_vendor_hotel_category_subscription rows' end_date
// in place (no new INSERTs — preserves start_date continuity).
//
// Surface tested:
//   POST /api/v1/hospitality/vendor/subscription/extend  → extendSubscription
//   POST /api/v1/hospitality/verify-payment              → verifyPayment (extension branch)
//
// Defect locks added in this file:
//   - F-SUB-002 (extension entrypoint): re-submitted extend MUST return the
//     existing pending order_id, not create a duplicate Razorpay order.
//     Same idempotency contract as F-SUB-002 for modifySubscription
//     (4cdfb5e); fix lands in this file's accompanying production patch.

import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { mockExpress } from "../helpers/mockExpress.js";
import { makeRazorpayMock, signPayment } from "../helpers/razorpayMock.js";
import {
  seedPaidSubscription as seedPaidSubscriptionShared,
  resetVendorSubscriptionState as resetVendorSubscriptionStateShared,
  restoreBaseVendorFixture,
} from "../helpers/subscriptionFixture.js";

// ---------------------------------------------------------------------------
// Module mocks — must run BEFORE the controller is imported.
// ---------------------------------------------------------------------------
const razorpay = makeRazorpayMock({ orderIdPrefix: "order_extend_test" });
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

const hospitalityModule = await import("../../app/controllers/users/hospitalityController.js");
const hospitalityController = hospitalityModule.default;

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const VENDOR_ID = IDS.users.vendor_alpha;
const HOTEL_A1 = IDS.hotels.A1;

// Same stable category IDs from seed_reference.sql staging snapshot.
const CATEGORY_BEVERAGES = 215;
const CATEGORY_LIQUOR = 222;

beforeAll(async () => {
  const expected = [CATEGORY_BEVERAGES, CATEGORY_LIQUOR];
  const found = await db.any(
    `SELECT id FROM tbl_category WHERE id = ANY($1::int[])`,
    [expected]
  );
  if (found.length !== expected.length) {
    throw new Error(
      `Seed mismatch: expected categories ${expected.join(",")} present.`
    );
  }
});

afterAll(async () => {
  await resetVendorSubscriptionStateShared(db, VENDOR_ID);
  await restoreBaseVendorFixture(db);
  await closeDb();
});

const resetVendorSubscriptionState = () =>
  resetVendorSubscriptionStateShared(db, VENDOR_ID);
const seedPaidSubscription = (opts = {}) =>
  seedPaidSubscriptionShared(db, { vendorId: VENDOR_ID, ...opts });

beforeEach(async () => {
  razorpay.captured.instances.length = 0;
  razorpay.captured.orders_create.length = 0;
  await resetVendorSubscriptionState();
});

function vendorReq(extra = {}) {
  return {
    user: { id: VENDOR_ID, user_type: 3, vendor_id: VENDOR_ID, email: "alpha@vendor.test" },
    ...extra,
  };
}

// ===========================================================================
// extendSubscription (POST /vendor/subscription/extend)
// ===========================================================================
describe("extendSubscription", () => {
  it("rejects when vendor has no active subscription", async () => {
    // No seedPaidSubscription — vendor has zero rows.
    const m = mockExpress(vendorReq({ body: {} }));
    await hospitalityController.extendSubscription(m.req, m.res);

    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/no active subscription|please renew/i);
    // No Razorpay order should have been created.
    expect(razorpay.captured.orders_create.length).toBe(0);
  });

  it("happy path: creates a Razorpay order with EXT receipt + extension metadata", async () => {
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1],
    });

    const m = mockExpress(vendorReq({ body: {} }));
    await hospitalityController.extendSubscription(m.req, m.res);

    expect(m.calls.status).toBe(200);
    expect(m.calls.body.status).toBe(1);
    expect(m.calls.body.data?.order_id).toMatch(/^order_extend_test_\d+$/);

    // Razorpay called once with the correct shape.
    expect(razorpay.captured.orders_create.length).toBe(1);
    const orderCall = razorpay.captured.orders_create[0];
    expect(orderCall.amount).toBe(Math.round((m.calls.body.data.amount || 0) * 100));
    expect(orderCall.currency).toBe("INR");
    // Receipt prefix `EXT` distinguishes extension from `MOD` (modification).
    expect(orderCall.receipt).toMatch(/^EXT/);

    // tbl_vendor_payments row written with payment_status='created' +
    // metadata.kind='extension' (load-bearing for verifyPayment dispatch).
    const pending = await db.oneOrNone(
      `SELECT payment_status, razorpay_order_id, metadata
       FROM tbl_vendor_payments
       WHERE vendor_id = $1 AND payment_status = 'created'
       ORDER BY id DESC LIMIT 1`,
      [VENDOR_ID]
    );
    expect(pending).not.toBeNull();
    expect(pending.razorpay_order_id).toBe(orderCall.__returned.id);
    const meta = typeof pending.metadata === "string"
      ? JSON.parse(pending.metadata)
      : pending.metadata;
    expect(meta.kind).toBe("extension");
    expect(Array.isArray(meta.subscription_items)).toBe(true);

    // No new subscription rows yet — extension UPDATEs existing rows on
    // payment verification, doesn't insert.
    const activeRowCount = await db.one(
      `SELECT count(*)::int AS n FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND status = 'active'`,
      [VENDOR_ID]
    );
    expect(activeRowCount.n).toBe(2); // 1 category + 1 hotel from seed
  });

  it("F-SUB-002 (extend) — re-submitted extend with an in-flight pending order MUST return the existing order_id (no duplicate Razorpay order)", async () => {
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1],
    });

    // First call creates the order.
    const first = mockExpress(vendorReq({ body: {} }));
    await hospitalityController.extendSubscription(first.req, first.res);
    expect(first.calls.status).toBe(200);
    const firstOrderId = first.calls.body.data.order_id;
    expect(razorpay.captured.orders_create.length).toBe(1);

    // Second call — should NOT create a fresh Razorpay order. POST-FIX:
    // detect the pending tbl_vendor_payments row for this vendor with
    // metadata.kind='extension' and short-circuit by returning its
    // existing order_id (matches the modify-flow F-SUB-002 fix shape from
    // 4cdfb5e). Today: extendSubscription has no idempotency guard and
    // creates a brand-new Razorpay order on every call — vendor double-
    // charge risk.
    const second = mockExpress(vendorReq({ body: {} }));
    await hospitalityController.extendSubscription(second.req, second.res);
    expect(second.calls.status).toBe(200);
    expect(razorpay.captured.orders_create.length).toBe(1);
    expect(second.calls.body.data.order_id).toBe(firstOrderId);
  });
});

// ===========================================================================
// verifyPayment — extension branch
// ===========================================================================
describe("verifyPayment — extension branch", () => {
  const RAZORPAY_SECRET = process.env.RAZORPAY_SECRET || "test_secret";

  // Drive an extend → return { orderId, originalEndDate, subRowIds }.
  async function setupPendingExtension() {
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1],
    });

    const originalEndDate = await db.one(
      `SELECT end_date::text FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND status = 'active' LIMIT 1`,
      [VENDOR_ID]
    );

    const m = mockExpress(vendorReq({ body: {} }));
    await hospitalityController.extendSubscription(m.req, m.res);
    expect(m.calls.status).toBe(200);
    return {
      orderId: m.calls.body.data.order_id,
      originalEndDate: originalEndDate.end_date,
    };
  }

  it("happy path: valid signature UPDATEs existing rows' end_date in place (no new INSERTs)", async () => {
    const { orderId, originalEndDate } = await setupPendingExtension();

    const beforeRowIds = await db.any(
      `SELECT id FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND status = 'active' ORDER BY id`,
      [VENDOR_ID]
    );

    const paymentId = "pay_extend_abc";
    const sig = signPayment(orderId, paymentId, RAZORPAY_SECRET);

    const m = mockExpress({
      body: {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: sig,
      },
    });
    await hospitalityController.verifyPayment(m.req, m.res);

    expect(m.calls.status).toBe(200);
    expect(m.calls.body.status).toBe(1);

    // Existing rows updated in place — same IDs, new end_date.
    const afterRowIds = await db.any(
      `SELECT id FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND status = 'active' ORDER BY id`,
      [VENDOR_ID]
    );
    expect(afterRowIds.map((r) => r.id)).toEqual(beforeRowIds.map((r) => r.id));

    // end_date now extended past the original.
    const updatedEndDate = await db.one(
      `SELECT end_date::text FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND status = 'active' LIMIT 1`,
      [VENDOR_ID]
    );
    expect(new Date(updatedEndDate.end_date).getTime()).toBeGreaterThan(
      new Date(originalEndDate).getTime()
    );

    // The new end_date should be a March 31 (FY snap).
    expect(updatedEndDate.end_date.slice(5)).toBe("03-31");
  });

  it("rejects an invalid signature with 400 and leaves payment + subscription state unchanged", async () => {
    const { orderId, originalEndDate } = await setupPendingExtension();

    const m = mockExpress({
      body: {
        razorpay_order_id: orderId,
        razorpay_payment_id: "pay_extend_tampered",
        razorpay_signature: signPayment(orderId, "pay_extend_tampered", "WRONG_SECRET"),
      },
    });
    await hospitalityController.verifyPayment(m.req, m.res);

    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/invalid signature/i);

    const stillCreated = await db.one(
      `SELECT payment_status FROM tbl_vendor_payments WHERE razorpay_order_id = $1`,
      [orderId]
    );
    expect(stillCreated.payment_status).toBe("created");

    // end_date unchanged.
    const unchangedEnd = await db.one(
      `SELECT end_date::text FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND status = 'active' LIMIT 1`,
      [VENDOR_ID]
    );
    expect(unchangedEnd.end_date).toBe(originalEndDate);
  });
});
