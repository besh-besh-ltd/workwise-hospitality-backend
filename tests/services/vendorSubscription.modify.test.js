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
import { makeRazorpayMock } from "../helpers/razorpayMock.js";
import { seedVendorSubscriptions } from "../fixtures/vendors.js";

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
  // Restore the base vendor-subscription fixture state before closing.
  // Cross-suite hygiene — tests that follow (harness.smoke compares
  // before/after counts of tbl_vendor_hotel_category_subscription, and
  // rfq.create.flow's eligibility query depends on the seeded shape) need
  // the original 6-row fixture state, not whatever this test left behind.
  await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`, [VENDOR_ID]);
  await db.none(`DELETE FROM tbl_vendor_payments WHERE vendor_id = $1`, [VENDOR_ID]);
  await db.tx((t) => seedVendorSubscriptions(t));

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

// Helper: clear vendor_alpha's subscription rows and the matching payment
// rows, so each test starts with a known shape.
async function resetVendorSubscriptionState() {
  await db.none(
    `DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`,
    [VENDOR_ID]
  );
  await db.none(`DELETE FROM tbl_vendor_payments WHERE vendor_id = $1`, [VENDOR_ID]);
}

// Helper: seed a "paid" baseline subscription with `categories` + `hotels`
// arrays. Returns { paymentId, sharedEndDate, subRows }.
async function seedPaidSubscription({ categories = [], subcategories = [], hotels = [] } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const endDate = new Date(Date.now() + 300 * 86400_000).toISOString().slice(0, 10);

  // 1. tbl_vendor_payments — one paid record covering the whole subscription.
  const payment = await db.one(
    `INSERT INTO tbl_vendor_payments
       (vendor_id, razorpay_order_id, razorpay_payment_id, razorpay_signature,
        amount, currency, payment_status, payment_type, receipt, before_payment_response, metadata)
     VALUES ($1, $2, $3, $4, $5, 'INR', 'success', 'hospitality', $6, '{}'::jsonb, $7::jsonb)
     RETURNING id`,
    [
      VENDOR_ID,
      `order_seed_${VENDOR_ID}`,
      `pay_seed_${VENDOR_ID}`,
      `sig_seed_${VENDOR_ID}`,
      categories.length * 500 + hotels.length * 1000, // fee math doesn't matter for the test
      `rcpt_seed_${VENDOR_ID}`,
      JSON.stringify({ type: "registration", seeded_by: "vendorSubscription.modify.test.js" }),
    ]
  );

  // 2. tbl_vendor_hotel_category_subscription rows
  const inserted = [];
  const insertOne = async (item_type, item_id) => {
    const row = await db.one(
      `INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status, payment_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
       RETURNING id`,
      [VENDOR_ID, item_type, item_id, 500, today, endDate, payment.id]
    );
    inserted.push({ id: row.id, item_type, item_id });
  };

  for (const cid of categories) await insertOne("category", cid);
  for (const sid of subcategories) await insertOne("subcategory", sid);
  for (const hid of hotels) await insertOne("hotel", hid);

  return { paymentId: payment.id, sharedEndDate: endDate, subRows: inserted };
}

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
});
