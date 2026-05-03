// Wave-2A subscription modify flow — Phase A.
//
// Covers WH-74 self-service subscription modification (preview + free-path
// commit). Phase B will land paid-path + verifyPayment + the F-SUB defect
// locks (F-SUB-002, F-SUB-003, F-SUB-004, F-SUB-006, F-SUB-008).
//
// Surface tested:
//   POST /api/v1/hospitality/vendor/subscription/preview  → previewSubscriptionModification
//   POST /api/v1/hospitality/vendor/subscription/modify   → modifySubscription (free path only this phase)
//
// We mock approvalEmails, generalReminderEmails, and the Razorpay client so
// nothing leaks to network. Tests seed the vendor's active subscription
// state directly into tbl_vendor_hotel_category_subscription + a "paid"
// tbl_vendor_payments row, then drive the controllers end-to-end.

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

// The free path uses an inline `_sendSubscriptionConfirmationEmail` helper
// inside hospitalityController.js that calls common.js `sendMail` — already
// stubbed by tests/setup/jestEnv.js (no-op nodemailer transport). No email
// module mocking needed for Phase A. Phase B may add captureApprovalEmails
// when paid-path notification side-effects matter.

// ---------------------------------------------------------------------------
// Module mocks — must run BEFORE the controller is imported.
// ---------------------------------------------------------------------------
const razorpay = makeRazorpayMock({ orderIdPrefix: "order_modify_test" });
jest.unstable_mockModule("razorpay", razorpay.factory);

// AWS Scheduler client — quiet the import graph.
jest.unstable_mockModule("@aws-sdk/client-scheduler", () => ({
  SchedulerClient: class {
    send = async () => ({});
  },
  CreateScheduleCommand: class {},
  UpdateScheduleCommand: class {},
  DeleteScheduleCommand: class {},
  GetScheduleCommand: class {},
  ListSchedulesCommand: class {},
  CreateScheduleGroupCommand: class {},
}));

// Nodemailer is already stubbed by tests/setup/jestEnv.js (no-op transport).

const hospitalityModule = await import("../../app/controllers/users/hospitalityController.js");
const hospitalityController = hospitalityModule.default;

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

afterAll(async () => {
  // Cross-suite hygiene — restore the base vendor-subscription fixture so
  // tests that follow (harness.smoke compares before/after counts of
  // tbl_vendor_hotel_category_subscription; rfq.create.flow's eligibility
  // query depends on the seeded shape) see the original 6-row state, not
  // whatever this test left behind.
  await resetVendorSubscriptionState();
  await restoreBaseVendorFixture(db);
  await closeDb();
});

// We use vendor_alpha (active subscription, beverages category) as our
// modify-target. The base fixture seeds one category-only subscription for
// them; modify needs at least one HOTEL subscription too (controller's
// _computeModificationPreview rejects when the target_hotels array is empty
// AND no current hotels exist). We also need a real paid tbl_vendor_payments
// row so hasValidPaidSubscription returns true.
const VENDOR_ID = IDS.users.vendor_alpha;
const HOTEL_A1 = IDS.hotels.A1;
const HOTEL_A2 = IDS.hotels.A2;

// Stable category IDs from seed_reference.sql (staging snapshot). These are
// the parent + sub-cat shape WH-74's modify flow exercises:
//   215 BEVERAGES                (parent)
//   216 AERATED WATERS           (sub-cat of BEVERAGES)
//   217 OTHER BEVERAGES          (sub-cat of BEVERAGES)
//   218 JUICE                    (sub-cat of BEVERAGES)
//   222 LIQUOR                   (parent — distinct from BEVERAGES, used as the swap-in)
//   225 MEAT & POULTRY           (parent)
const CATEGORY_BEVERAGES = 215;
const CATEGORY_LIQUOR = 222; // a distinct parent we can swap in / out
const CATEGORY_MEAT = 225; // another distinct parent for multi-add tests
const SUBCATEGORY_AERATED_WATERS = 216; // child of BEVERAGES

beforeAll(async () => {
  // Verify the seed actually contains the IDs we hardcoded. If the seed ever
  // gets re-snapshotted from a different staging cut, this fails loudly
  // instead of producing confusing modify-flow failures downstream.
  const expected = [CATEGORY_BEVERAGES, CATEGORY_LIQUOR, CATEGORY_MEAT, SUBCATEGORY_AERATED_WATERS];
  const found = await db.any(
    `SELECT id, title, parent_id FROM tbl_category WHERE id = ANY($1::int[])`,
    [expected]
  );
  if (found.length !== expected.length) {
    throw new Error(
      `Seed mismatch: expected categories ${expected.join(",")} present, got ${found.map((r) => r.id).join(",")}. Re-snapshot seed_reference.sql or update the constants in this test file.`
    );
  }
  // Sanity: the sub-cat's parent_id must match BEVERAGES, otherwise the
  // cascade-cancel cannot fire under modify.
  const subRow = found.find((r) => r.id === SUBCATEGORY_AERATED_WATERS);
  if (subRow.parent_id !== CATEGORY_BEVERAGES) {
    throw new Error(
      `Seed mismatch: SUBCATEGORY_AERATED_WATERS (216) parent_id=${subRow.parent_id}, expected ${CATEGORY_BEVERAGES}.`
    );
  }
});

// Thin wrappers that bind the shared fixture helpers to this suite's
// vendor + the `db` connection.
const resetVendorSubscriptionState = () =>
  resetVendorSubscriptionStateShared(db, VENDOR_ID);
const seedPaidSubscription = (opts = {}) =>
  seedPaidSubscriptionShared(db, { vendorId: VENDOR_ID, ...opts });

beforeEach(async () => {
  await resetVendorSubscriptionState();
});

function vendorReq(extra = {}) {
  return {
    user: { id: VENDOR_ID, user_type: 3, vendor_id: VENDOR_ID },
    ...extra,
  };
}

// ===========================================================================
// preview — pure-read diff calculator
// ===========================================================================
describe("previewSubscriptionModification (POST /vendor/subscription/preview)", () => {
  it("returns a clean diff when the target adds one category to an existing 1-cat / 1-hotel subscription", async () => {
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1],
    });

    const m = mockExpress(
      vendorReq({
        body: {
          target_categories: [CATEGORY_BEVERAGES, CATEGORY_LIQUOR],
          target_subcategories: [],
          target_hotels: [HOTEL_A1],
        },
      })
    );
    await hospitalityController.previewSubscriptionModification(m.req, m.res);

    expect(m.calls.status).toBe(200);
    const data = m.calls.body.data;
    expect(data).toBeDefined();
    expect(data.diff).toBeDefined();

    // Added one category, removed nothing.
    const addedCatIds = data.diff.added_categories.map((c) => c.id);
    expect(addedCatIds).toContain(CATEGORY_LIQUOR);
    expect(addedCatIds).not.toContain(CATEGORY_BEVERAGES);
    expect(data.diff.removed_categories).toEqual([]);
    expect(data.diff.added_hotels).toEqual([]);
    expect(data.diff.removed_hotels).toEqual([]);

    // Pricing is positive (one new category × one hotel).
    expect(data.pricing.net_cost).toBeGreaterThan(0);
  });

  it("rejects a target where a sub-category's parent isn't in the target categories", async () => {
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1],
    });

    const m = mockExpress(
      vendorReq({
        body: {
          target_categories: [CATEGORY_LIQUOR], // beverages dropped, food added
          target_subcategories: [SUBCATEGORY_AERATED_WATERS], // sub-cat of beverages, but beverages removed → orphan
          target_hotels: [HOTEL_A1],
        },
      })
    );
    await hospitalityController.previewSubscriptionModification(m.req, m.res);

    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/parent category|sub-category/i);
  });

  it("rejects when target_categories is empty (at-least-one-category invariant)", async () => {
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1],
    });

    const m = mockExpress(
      vendorReq({
        body: {
          target_categories: [],
          target_subcategories: [],
          target_hotels: [HOTEL_A1],
        },
      })
    );
    await hospitalityController.previewSubscriptionModification(m.req, m.res);

    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/category is required/i);
  });

  it("rejects when target_hotels is empty (at-least-one-hotel invariant)", async () => {
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1],
    });

    const m = mockExpress(
      vendorReq({
        body: {
          target_categories: [CATEGORY_BEVERAGES],
          target_subcategories: [],
          target_hotels: [],
        },
      })
    );
    await hospitalityController.previewSubscriptionModification(m.req, m.res);

    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/business unit|hotel.*required/i);
  });
});

// ===========================================================================
// modify (free path) — net_cost === 0
// ===========================================================================
describe("modifySubscription — free path (no money moved)", () => {
  it("removing one hotel + adding nothing == net_cost 0; commits cancel + writes a free-path payment audit row", async () => {
    // Seed: 1 category + 2 hotels (so the hotel removal is the only change).
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1, HOTEL_A2],
    });

    const m = mockExpress(
      vendorReq({
        body: {
          target_categories: [CATEGORY_BEVERAGES],
          target_subcategories: [],
          target_hotels: [HOTEL_A1], // dropped HOTEL_A2
          confirm_removals: true,
        },
      })
    );
    await hospitalityController.modifySubscription(m.req, m.res);

    expect(m.calls.status).toBe(200);
    expect(m.calls.body.status).toBe(1);
    expect(m.calls.body.data?.applied).toBe(true);

    // HOTEL_A2 row is now status='cancelled' (or has cancelled_at set).
    const droppedRows = await db.any(
      `SELECT status, cancelled_at, cancelled_by
       FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND item_type = 'hotel' AND item_id = $2`,
      [VENDOR_ID, HOTEL_A2]
    );
    expect(droppedRows.length).toBe(1);
    expect(droppedRows[0].status).toBe("cancelled");

    // HOTEL_A1 + CATEGORY_BEVERAGES still active.
    const activeRows = await db.any(
      `SELECT item_type, item_id FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND status = 'active'`,
      [VENDOR_ID]
    );
    expect(activeRows.length).toBe(2);

    // Free-path payment audit row recorded with amount=0.
    const freePayment = await db.oneOrNone(
      `SELECT amount, payment_status, razorpay_order_id, razorpay_payment_id, metadata
       FROM tbl_vendor_payments
       WHERE vendor_id = $1 AND amount = 0
       ORDER BY id DESC LIMIT 1`,
      [VENDOR_ID]
    );
    expect(freePayment).not.toBeNull();
    expect(parseFloat(freePayment.amount)).toBe(0);
    expect(freePayment.payment_status).toBe("success");
    expect(freePayment.razorpay_order_id).toBeNull();
    expect(freePayment.razorpay_payment_id).toBeNull();
    const meta = typeof freePayment.metadata === "string"
      ? JSON.parse(freePayment.metadata)
      : freePayment.metadata;
    expect(meta.type).toBe("modification");
    expect(meta.removed_hotel_names).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  it("rejects a free-path removal without confirm_removals: true", async () => {
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1, HOTEL_A2],
    });

    const m = mockExpress(
      vendorReq({
        body: {
          target_categories: [CATEGORY_BEVERAGES],
          target_subcategories: [],
          target_hotels: [HOTEL_A1], // dropping HOTEL_A2
          // confirm_removals NOT set
        },
      })
    );
    await hospitalityController.modifySubscription(m.req, m.res);

    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/confirm_removals/i);

    // No state changes — both hotels still active.
    const stillActive = await db.any(
      `SELECT item_id FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND item_type = 'hotel' AND status = 'active'
       ORDER BY item_id`,
      [VENDOR_ID]
    );
    expect(stillActive.map((r) => r.item_id).sort()).toEqual([HOTEL_A1, HOTEL_A2].sort());
  });

  it("rejects when the vendor has no active subscription (modify requires a baseline)", async () => {
    // No seeding — vendor has zero rows.
    const m = mockExpress(
      vendorReq({
        body: {
          target_categories: [CATEGORY_BEVERAGES],
          target_subcategories: [],
          target_hotels: [HOTEL_A1],
        },
      })
    );
    await hospitalityController.modifySubscription(m.req, m.res);

    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/active subscription|renew/i);
  });

  it("cascades sub-category cancellations when the parent category is removed", async () => {
    // Seed: BEVERAGES (parent) + AERATED WATERS (sub-cat of BEVERAGES) +
    // LIQUOR (a 2nd parent we keep so the target has ≥1 category) + 1 hotel.
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES, CATEGORY_LIQUOR],
      subcategories: [SUBCATEGORY_AERATED_WATERS],
      hotels: [HOTEL_A1],
    });

    const m = mockExpress(
      vendorReq({
        body: {
          target_categories: [CATEGORY_LIQUOR], // dropped BEVERAGES parent
          target_subcategories: [], // explicit empty — sub-cat of BEVERAGES must cascade-cancel
          target_hotels: [HOTEL_A1],
          confirm_removals: true,
        },
      })
    );
    await hospitalityController.modifySubscription(m.req, m.res);

    expect(m.calls.status).toBe(200);

    // Parent BEVERAGES cancelled (explicit removal via diff.removed_categories).
    const bevRow = await db.oneOrNone(
      `SELECT status FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND item_type = 'category' AND item_id = $2`,
      [VENDOR_ID, CATEGORY_BEVERAGES]
    );
    expect(bevRow?.status).toBe("cancelled");

    // Sub-cat AERATED WATERS no longer active — even though it wasn't
    // explicitly listed in removed_subcategories. The combined effect of
    // cancelSubscriptionItems (explicit-removal path, since target_subcategories
    // is empty) followed by cancelSubcategoriesByParentCategoryIds (the
    // cascade) is implementation-defined (the row may be either marked
    // 'cancelled' or DELETE'd by the cascade's pre-update cleanup of
    // same-day cancelled duplicates). The contract this test locks is the
    // user-observable outcome: NO active sub-cat row remains for AERATED
    // WATERS after the modify.
    const subRow = await db.oneOrNone(
      `SELECT status FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND item_type = 'subcategory' AND item_id = $2 AND status = 'active'`,
      [VENDOR_ID, SUBCATEGORY_AERATED_WATERS]
    );
    expect(subRow).toBeNull();

    // LIQUOR (the surviving target) still active.
    const liquorRow = await db.oneOrNone(
      `SELECT status FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND item_type = 'category' AND item_id = $2`,
      [VENDOR_ID, CATEGORY_LIQUOR]
    );
    expect(liquorRow?.status).toBe("active");

    // Hotel A1 also still active.
    const hotelRow = await db.oneOrNone(
      `SELECT status FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND item_type = 'hotel' AND item_id = $2`,
      [VENDOR_ID, HOTEL_A1]
    );
    expect(hotelRow?.status).toBe("active");
  });

  // F-SUB-004 (P2) — locks the post-fix expectation that a free-path
  // tbl_vendor_payments row is distinguishable from a real paid record. The
  // current implementation writes razorpay_*=NULL + payment_status='success'
  // with metadata.type='modification' and NO marker that uniquely identifies
  // the row as a free modification (vs. a real paid payment that happened to
  // have NULL Razorpay fields for some other reason). This test asserts the
  // INTENDED post-fix shape: either a dedicated `payment_kind` / sub-type
  // column, or at minimum metadata.kind === 'modification_free'.
  it("F-SUB-004 — free-path payment row carries a marker distinguishing it from paid records", async () => {
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1, HOTEL_A2],
    });

    const m = mockExpress(
      vendorReq({
        body: {
          target_categories: [CATEGORY_BEVERAGES],
          target_subcategories: [],
          target_hotels: [HOTEL_A1], // dropped HOTEL_A2 → free
          confirm_removals: true,
        },
      })
    );
    await hospitalityController.modifySubscription(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const freePayment = await db.one(
      `SELECT amount, payment_status, razorpay_order_id, metadata
       FROM tbl_vendor_payments
       WHERE vendor_id = $1 AND amount = 0
       ORDER BY id DESC LIMIT 1`,
      [VENDOR_ID]
    );
    expect(parseFloat(freePayment.amount)).toBe(0);

    const meta = typeof freePayment.metadata === "string"
      ? JSON.parse(freePayment.metadata)
      : freePayment.metadata;

    // POST-FIX expectation: the row carries an unambiguous marker. Either:
    //   (a) a dedicated DB column (e.g. tbl_vendor_payments.payment_kind),
    //   (b) metadata.kind === 'modification_free' (or similar),
    //   (c) hasValidPaidSubscription's contract is tightened so this row
    //       cannot satisfy the "paid subscription" check.
    // Today: the only marker is metadata.type='modification' which is shared
    // with PAID modifications — no distinction.
    const isExplicitlyMarkedFree =
      meta?.kind === "modification_free" ||
      meta?.is_free === true ||
      freePayment.payment_kind === "free_modification";
    expect(isExplicitlyMarkedFree).toBe(true);
  });
});

// ===========================================================================
// modify — paid path (Razorpay order created; commit deferred to verifyPayment)
// ===========================================================================
describe("modifySubscription — paid path (Razorpay)", () => {
  beforeEach(() => {
    razorpay.captured.instances.length = 0;
    razorpay.captured.orders_create.length = 0;
    razorpay.captured.payments_fetch.length = 0;
  });

  it("creates a Razorpay order with the correct amount (paise) + metadata when net cost > 0", async () => {
    // Seed: 1 category + 1 hotel; modify adds a 2nd category + 2nd hotel.
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1],
    });

    const m = mockExpress(
      vendorReq({
        body: {
          target_categories: [CATEGORY_BEVERAGES, CATEGORY_LIQUOR],
          target_subcategories: [],
          target_hotels: [HOTEL_A1, HOTEL_A2],
        },
      })
    );
    await hospitalityController.modifySubscription(m.req, m.res);

    expect(m.calls.status).toBe(200);
    expect(m.calls.body.status).toBe(1);
    expect(m.calls.body.data?.requires_payment).toBe(true);
    expect(m.calls.body.data?.order_id).toMatch(/^order_modify_test_\d+$/);

    // Razorpay was called exactly once.
    expect(razorpay.captured.orders_create.length).toBe(1);
    const orderCall = razorpay.captured.orders_create[0];
    // Amount is in paise (Math.round(rupees * 100)).
    const expectedPaise = Math.round((m.calls.body.data.amount || 0) * 100);
    expect(orderCall.amount).toBe(expectedPaise);
    expect(orderCall.currency).toBe("INR");
    expect(orderCall.receipt).toMatch(/^MOD/);

    // tbl_vendor_payments row written in 'created' state with metadata
    // carrying the diff for verifyPayment to later commit.
    const pendingPayment = await db.oneOrNone(
      `SELECT payment_status, razorpay_order_id, metadata
       FROM tbl_vendor_payments
       WHERE vendor_id = $1 AND payment_status = 'created'
       ORDER BY id DESC LIMIT 1`,
      [VENDOR_ID]
    );
    expect(pendingPayment).not.toBeNull();
    expect(pendingPayment.razorpay_order_id).toBe(orderCall.__returned.id);
    const meta = typeof pendingPayment.metadata === "string"
      ? JSON.parse(pendingPayment.metadata)
      : pendingPayment.metadata;
    expect(meta.type).toBe("modification");
    expect(Array.isArray(meta.add_subscription_items)).toBe(true);
    // The added LIQUOR + HOTEL_A2 should be in the metadata's add list.
    const addedItemIds = meta.add_subscription_items.map((r) => r.item_id);
    expect(addedItemIds).toContain(CATEGORY_LIQUOR);
    expect(addedItemIds).toContain(HOTEL_A2);

    // Subscription rows NOT yet inserted — that happens at verifyPayment time.
    const beforeVerifyActive = await db.any(
      `SELECT item_type, item_id FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND status = 'active'
       ORDER BY item_type, item_id`,
      [VENDOR_ID]
    );
    const itemPairs = beforeVerifyActive.map((r) => `${r.item_type}:${r.item_id}`);
    expect(itemPairs).not.toContain(`category:${CATEGORY_LIQUOR}`);
    expect(itemPairs).not.toContain(`hotel:${HOTEL_A2}`);
  });

  it("F-SUB-002 — re-submitted modify with an in-flight pending order MUST return the existing order_id (no duplicate Razorpay order)", async () => {
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1],
    });
    const body = {
      target_categories: [CATEGORY_BEVERAGES, CATEGORY_LIQUOR],
      target_subcategories: [],
      target_hotels: [HOTEL_A1],
    };

    // First call — should create the order.
    const first = mockExpress(vendorReq({ body }));
    await hospitalityController.modifySubscription(first.req, first.res);
    expect(first.calls.status).toBe(200);
    const firstOrderId = first.calls.body.data.order_id;
    expect(razorpay.captured.orders_create.length).toBe(1);

    // Second call with the same target — should NOT create a new Razorpay
    // order. POST-FIX: handler detects the pending tbl_vendor_payments row
    // and returns the existing order_id. Today: handler creates a fresh
    // order, abandoning the prior pending payment (vendor double-charge
    // risk if both orders happen to get paid).
    const second = mockExpress(vendorReq({ body }));
    await hospitalityController.modifySubscription(second.req, second.res);
    expect(second.calls.status).toBe(200);
    expect(razorpay.captured.orders_create.length).toBe(1);
    expect(second.calls.body.data.order_id).toBe(firstOrderId);
  });
});

// ===========================================================================
// verifyPayment — public signature-verified endpoint that commits the diff
// ===========================================================================
describe("verifyPayment (POST /verify-payment) — modification commit", () => {
  // The controller reads Config.razorpay.razorpay_secret which originates
  // from process.env.RAZORPAY_SECRET. .env.test sets it; mirror that value
  // here so signPayment generates a matching HMAC.
  const RAZORPAY_SECRET = process.env.RAZORPAY_SECRET || "test_secret";

  // Helper: drive modifySubscription with a paid-path body, then return
  // { orderId, paymentRowId, expectedAddedItems } so verifyPayment tests
  // can build a signed body.
  async function setupPendingModification({ targetCategories, targetHotels }) {
    razorpay.captured.orders_create.length = 0;
    await seedPaidSubscription({
      categories: [CATEGORY_BEVERAGES],
      hotels: [HOTEL_A1],
    });
    const m = mockExpress(
      vendorReq({
        body: {
          target_categories: targetCategories,
          target_subcategories: [],
          target_hotels: targetHotels,
        },
      })
    );
    await hospitalityController.modifySubscription(m.req, m.res);
    expect(m.calls.status).toBe(200);
    const orderId = m.calls.body.data.order_id;
    return { orderId, modifyResponse: m.calls.body.data };
  }

  it("happy path: valid signature commits the diff and flips payment_status to 'success'", async () => {
    const { orderId } = await setupPendingModification({
      targetCategories: [CATEGORY_BEVERAGES, CATEGORY_LIQUOR],
      targetHotels: [HOTEL_A1],
    });

    const paymentId = "pay_test_abc";
    const sig = signPayment(orderId, paymentId, RAZORPAY_SECRET);

    const m = mockExpress({
      // Note: verifyPayment is the public signature-auth endpoint — no JWT.
      body: {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: sig,
      },
    });
    await hospitalityController.verifyPayment(m.req, m.res);

    expect(m.calls.status).toBe(200);
    expect(m.calls.body.status).toBe(1);
    expect(m.calls.body.data.is_modification).toBe(true);

    // Payment row flipped to 'success' with the captured payment id + sig.
    const paid = await db.one(
      `SELECT payment_status, razorpay_payment_id, razorpay_signature
       FROM tbl_vendor_payments WHERE razorpay_order_id = $1`,
      [orderId]
    );
    expect(paid.payment_status).toBe("success");
    expect(paid.razorpay_payment_id).toBe(paymentId);
    expect(paid.razorpay_signature).toBe(sig);

    // The added category (LIQUOR) is now an active subscription row.
    const liquorRow = await db.oneOrNone(
      `SELECT status FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND item_type = 'category' AND item_id = $2 AND status = 'active'`,
      [VENDOR_ID, CATEGORY_LIQUOR]
    );
    expect(liquorRow).not.toBeNull();
  });

  it("F-SUB-005 — malformed-length signature is rejected cleanly (no 500 from constant-time compare)", async () => {
    const { orderId } = await setupPendingModification({
      targetCategories: [CATEGORY_BEVERAGES, CATEGORY_LIQUOR],
      targetHotels: [HOTEL_A1],
    });

    const m = mockExpress({
      body: {
        razorpay_order_id: orderId,
        razorpay_payment_id: "pay_test_short_sig",
        // Deliberately short / non-hex string. crypto.timingSafeEqual would
        // throw RangeError on length mismatch; the handler must catch and
        // treat as invalid → 400, not surface the throw as an HTTP 500.
        razorpay_signature: "deadbeef",
      },
    });
    await hospitalityController.verifyPayment(m.req, m.res);

    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/invalid signature/i);
  });

  it("rejects an invalid signature with 400 and leaves payment + subscription state unchanged", async () => {
    const { orderId } = await setupPendingModification({
      targetCategories: [CATEGORY_BEVERAGES, CATEGORY_LIQUOR],
      targetHotels: [HOTEL_A1],
    });

    const paymentId = "pay_test_tampered";
    // Wrong secret produces a wrong signature.
    const badSig = signPayment(orderId, paymentId, "WRONG_SECRET");

    const m = mockExpress({
      body: {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: badSig,
      },
    });
    await hospitalityController.verifyPayment(m.req, m.res);

    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/invalid signature/i);

    // Payment row still 'created' — no state change.
    const stillCreated = await db.one(
      `SELECT payment_status, razorpay_payment_id
       FROM tbl_vendor_payments WHERE razorpay_order_id = $1`,
      [orderId]
    );
    expect(stillCreated.payment_status).toBe("created");
    expect(stillCreated.razorpay_payment_id).toBeNull();

    // LIQUOR not in active subscription rows.
    const liquorRow = await db.oneOrNone(
      `SELECT id FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND item_type = 'category' AND item_id = $2 AND status = 'active'`,
      [VENDOR_ID, CATEGORY_LIQUOR]
    );
    expect(liquorRow).toBeNull();
  });

  it("F-SUB-006 — duplicate verifyPayment with the same signature must NOT apply the modification twice", async () => {
    const { orderId } = await setupPendingModification({
      targetCategories: [CATEGORY_BEVERAGES, CATEGORY_LIQUOR],
      targetHotels: [HOTEL_A1],
    });

    const paymentId = "pay_test_double_fire";
    const sig = signPayment(orderId, paymentId, RAZORPAY_SECRET);
    const verifyBody = {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: sig,
    };

    // First verify: commits.
    const first = mockExpress({ body: verifyBody });
    await hospitalityController.verifyPayment(first.req, first.res);
    expect(first.calls.status).toBe(200);

    // Snapshot the active subscription rows after the first commit.
    const afterFirst = await db.any(
      `SELECT item_type, item_id FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND status = 'active'
       ORDER BY item_type, item_id`,
      [VENDOR_ID]
    );

    // Second verify with the SAME signature (Razorpay webhook retry / double
    // call). POST-FIX: the controller detects payment_status is already
    // 'success' and skips _applyModificationFromMetadata. It either
    // returns 200 with a "already-applied" flag OR returns 409 — what it
    // MUST NOT do is re-run _applyModificationFromMetadata (which would
    // re-cancel and re-insert rows, churning the audit log + risking
    // duplicate keys on the underlying unique constraint).
    const second = mockExpress({ body: verifyBody });
    await hospitalityController.verifyPayment(second.req, second.res);
    // Acceptable post-fix outcomes: 200 with already_applied indicator, OR
    // 409 Conflict. Today's implementation re-applies, returning 200.
    expect([200, 409]).toContain(second.calls.status);

    // The active subscription row set must be IDENTICAL to the first commit.
    // No new rows inserted, no rows churned.
    const afterSecond = await db.any(
      `SELECT item_type, item_id FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND status = 'active'
       ORDER BY item_type, item_id`,
      [VENDOR_ID]
    );
    expect(afterSecond).toEqual(afterFirst);

    // Beyond the row set, the payment_actions audit history (tbl_vendor_payments
    // metadata or any related audit table) should NOT show two modifications.
    // We assert the simpler invariant: only ONE non-cancelled subscription
    // row exists for the added LIQUOR category — no duplicates.
    const liquorRows = await db.any(
      `SELECT id, status FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND item_type = 'category' AND item_id = $2 AND status = 'active'`,
      [VENDOR_ID, CATEGORY_LIQUOR]
    );
    expect(liquorRows.length).toBe(1);
  });
});
