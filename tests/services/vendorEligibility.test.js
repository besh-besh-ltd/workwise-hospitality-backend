// Wave-1 step-3.5 tests: vendor-eligibility query for RFQ publish.
//
// Policy: this suite calls the **production** function
// `hospitalityModel.getEligibleVendorsForVariant(variantId, hotelIds)` — the
// same function the publish path runs at app/helper/cronManager.js:391+. We do
// NOT replicate its SQL in the test. If production changes the query and
// breaks the contract, this suite catches it.
//
// Architectural rules locked in:
//   - Vendor mapping is at product CATEGORY level, NOT subcategory.
//   - Lapsed-was-active vendors (status='expired') STILL receive inquiries
//     (Wave 2 step 1).
//   - Cancelled / pending / never-subscribed vendors are excluded.
//   - Multi-hotel: OR semantics on the hotelIds array.
//
// Isolation strategy: `getEligibleVendorsForVariant` does NOT accept a
// txContext — it queries `db` directly. Tests therefore use a
// **commit + cleanup** pattern: insert prerequisite rows into the production
// `db`, call the function, assert, and clean up affected rows in afterEach.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import hospitalityModel from "../../app/models/hospitalityModel.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";

afterAll(async () => {
  await closeDb();
});

// Real seeded product variant in BEVERAGES (category 215). variant_id=1 is the
// canonical fixture variant tests pin themselves to; if staging ever changes
// the smallest variant id, update here.
const TEST_VARIANT_ID = 1;

// Track every row this test inserts so afterEach can clean it up. We don't
// truncate dynamic tables wholesale because fixture vendors' subscriptions
// must survive across tests.
const inserted = {
  variantVendorRowIds: [],
  subscriptionRowIds: [],
};

beforeEach(() => {
  inserted.variantVendorRowIds = [];
  inserted.subscriptionRowIds = [];
});

afterEach(async () => {
  if (inserted.variantVendorRowIds.length) {
    await db.none(
      `DELETE FROM tbl_product_variant_vendor_mapping WHERE id = ANY($1::int[])`,
      [inserted.variantVendorRowIds]
    );
  }
  if (inserted.subscriptionRowIds.length) {
    await db.none(
      `DELETE FROM tbl_vendor_hotel_category_subscription WHERE id = ANY($1::int[])`,
      [inserted.subscriptionRowIds]
    );
  }
});

// ---- Setup helpers (commit + remember-id) ----------------------------------

async function attachVendorToVariant(vendorId, { variantId = TEST_VARIANT_ID, status = true, isApproved = true } = {}) {
  const row = await db.one(
    `INSERT INTO tbl_product_variant_vendor_mapping
       (product_variant_id, vendor_id, status, is_approved, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     RETURNING id`,
    [variantId, vendorId, status, isApproved, vendorId]
  );
  inserted.variantVendorRowIds.push(row.id);
  return row.id;
}

// Inserts a subscription. ON CONFLICT DO NOTHING — if a fixture already
// owns that (vendor, item_type, item_id, end_date) tuple, we DO NOT track the
// id (it isn't ours to delete). Returns null if fixture already had it.
async function addSub(vendorId, { itemType, itemId, status = "active", startOffsetDays = -30, endOffsetDays = 335 }) {
  const result = await db.oneOrNone(
    `INSERT INTO tbl_vendor_hotel_category_subscription
       (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
     VALUES ($1, $2, $3, 500,
             (now() + ($4 || ' days')::interval)::date,
             (now() + ($5 || ' days')::interval)::date,
             $6)
     ON CONFLICT ON CONSTRAINT uq_vendor_hotel_category_subscription DO NOTHING
     RETURNING id`,
    [vendorId, itemType, itemId, String(startOffsetDays), String(endOffsetDays), status]
  );
  if (result?.id) {
    inserted.subscriptionRowIds.push(result.id);
  }
  return result?.id ?? null;
}

// Tests rely on fixture-seeded CATEGORY subs (vendor_alpha=215 active,
// vendor_gamma=215 expired, vendor_delta=215 cancelled, vendor_epsilon=217
// pending). Tests that need a different category use this helper.
const addCategorySub = (vendorId, { status = "active", categoryId = TEST_CATEGORIES.beverages } = {}) =>
  addSub(vendorId, { itemType: "category", itemId: categoryId, status });

// Hotel subs are NOT seeded in fixtures — every call here inserts fresh.
const addHotelSub = (vendorId, hotelId, { status = "active" } = {}) =>
  addSub(vendorId, { itemType: "hotel", itemId: hotelId, status });

// ---- Tests -----------------------------------------------------------------

describe("getEligibleVendorsForVariant — happy path", () => {
  it("returns a vendor with BOTH active category + active hotel subscription", async () => {
    const vendorId = IDS.users.vendor_alpha; // fixtures: active beverages cat sub
    await attachVendorToVariant(vendorId);
    await addHotelSub(vendorId, IDS.hotels.A1);

    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID,
      [IDS.hotels.A1]
    );

    expect(rows.map((r) => r.vendor_id)).toContain(vendorId);
  });

  it("includes a vendor whose subscriptions are EXPIRED (lapsed-was-active rule)", async () => {
    // Wave-2 step-1 architectural rule: lapsed-was-active vendors STILL receive
    // inquiries. The eligibility query allows status IN ('active', 'expired').
    const vendorId = IDS.users.vendor_gamma; // fixtures: expired beverages cat sub
    await attachVendorToVariant(vendorId);
    await addHotelSub(vendorId, IDS.hotels.A1, { status: "expired" });

    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID,
      [IDS.hotels.A1]
    );

    expect(rows.map((r) => r.vendor_id)).toContain(vendorId);
  });
});

describe("getEligibleVendorsForVariant — exclusions", () => {
  it("excludes a vendor with CANCELLED category subscription", async () => {
    const vendorId = IDS.users.vendor_delta; // fixtures: cancelled cat sub
    await attachVendorToVariant(vendorId);
    await addHotelSub(vendorId, IDS.hotels.A1);

    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID,
      [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).not.toContain(vendorId);
  });

  it("excludes a vendor with NO hotel subscription (only category)", async () => {
    const vendorId = IDS.users.vendor_alpha;
    await attachVendorToVariant(vendorId);
    // Deliberately omit addHotelSub.
    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID,
      [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).not.toContain(vendorId);
  });

  it("excludes a vendor whose hotel subscription is for a DIFFERENT hotel", async () => {
    const vendorId = IDS.users.vendor_alpha;
    await attachVendorToVariant(vendorId);
    await addHotelSub(vendorId, IDS.hotels.A2); // RFQ asks for A1
    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID,
      [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).not.toContain(vendorId);
  });

  it("excludes a vendor with PENDING (never-paid) subscription", async () => {
    const vendorId = IDS.users.vendor_epsilon; // fixtures: pending cat sub
    await attachVendorToVariant(vendorId);
    await addHotelSub(vendorId, IDS.hotels.A1, { status: "pending" });
    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID,
      [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).not.toContain(vendorId);
  });

  it("excludes a vendor whose category subscription is for a DIFFERENT category", async () => {
    // vendor_epsilon's only fixture sub is `pending` — excluded by the active|
    // expired filter, so we start with NO eligible category sub. Adding a sub
    // for category 999999 (no row in tbl_product_categories) means the join
    // through product_categories returns nothing.
    const vendorId = IDS.users.vendor_epsilon;
    await attachVendorToVariant(vendorId);
    await addCategorySub(vendorId, { categoryId: 999999, status: "active" });
    await addHotelSub(vendorId, IDS.hotels.A1);
    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID,
      [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).not.toContain(vendorId);
  });

  it("excludes a vendor whose mapping row is unapproved (is_approved=false)", async () => {
    const vendorId = IDS.users.vendor_alpha;
    await attachVendorToVariant(vendorId, { isApproved: false });
    await addHotelSub(vendorId, IDS.hotels.A1);
    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID,
      [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).not.toContain(vendorId);
  });

  it("excludes a vendor whose mapping row is inactive (status=false)", async () => {
    const vendorId = IDS.users.vendor_alpha;
    await attachVendorToVariant(vendorId, { status: false });
    await addHotelSub(vendorId, IDS.hotels.A1);
    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID,
      [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).not.toContain(vendorId);
  });
});

describe("getEligibleVendorsForVariant — multi-hotel + idempotency", () => {
  it("returns the vendor when ANY of the requested hotels matches their hotel sub (OR semantics)", async () => {
    const vendorId = IDS.users.vendor_alpha;
    await attachVendorToVariant(vendorId);
    await addHotelSub(vendorId, IDS.hotels.A2);

    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID,
      [IDS.hotels.A1, IDS.hotels.A2]
    );
    expect(rows.map((r) => r.vendor_id)).toContain(vendorId);
  });

  it("returns identical results on repeated calls (idempotency)", async () => {
    const vendorId = IDS.users.vendor_alpha;
    await attachVendorToVariant(vendorId);
    await addHotelSub(vendorId, IDS.hotels.A1);

    const r1 = (await hospitalityModel.getEligibleVendorsForVariant(TEST_VARIANT_ID, [IDS.hotels.A1]))
      .map((r) => r.vendor_id).sort();
    const r2 = (await hospitalityModel.getEligibleVendorsForVariant(TEST_VARIANT_ID, [IDS.hotels.A1]))
      .map((r) => r.vendor_id).sort();
    expect(r1).toEqual(r2);
  });
});
