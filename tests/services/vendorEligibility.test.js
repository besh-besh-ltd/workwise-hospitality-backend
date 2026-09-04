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
import { makeRFQ } from "../factories/rfq.js";

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

// A subscription with explicit day offsets, so tests can state precisely which
// row for an item is the LATER one. Ordering is (end_date, id) — see
// subscriptionEligibility.js for why that is the definition of "current".
const addSubDated = (vendorId, { itemType, itemId, status, startOffsetDays, endOffsetDays }) =>
  addSub(vendorId, { itemType, itemId, status, startOffsetDays, endOffsetDays });

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


// ===========================================================================
//  A cancellation must not be overridden by an older expired subscription.
//
//  CONFIRMED DEFECT, from RFQ 536445 (The Orchid Manali — LED Smart TV).
//
//  Eligibility accepted any row with status IN ('active','expired'), evaluated
//  one row at a time, with no notion of which row is current. A vendor whose
//  subscription history for one item reads
//
//      expired    2026-02-25 .. 2026-03-31     (the original term, lapsed)
//      cancelled  2026-03-24 .. 2026-05-30     (they later cancelled)
//
//  therefore stayed eligible forever on the strength of the older lapsed row.
//
//  Vendor 220 (Fluidos) cancelled 23 Orchid properties in one self-service
//  modification on 2026-05-30, keeping only one unit. Three months later they
//  were still receiving Orchid Pune RFQs — because Pune happened to retain an
//  older expired row — while Manali, which had no such row, correctly went
//  dark. That inconsistency is what made the reported bug so hard to read:
//  same vendor, same category, two units, two different answers.
//
//  The rule pinned here: for one (vendor, item_type, item_id), the CURRENT row
//  is the latest by (end_date, id). Eligibility is decided by that row alone.
//  A later cancellation supersedes an earlier lapse; an earlier cancellation
//  followed by a fresh subscription does not.
// ===========================================================================
describe("getEligibleVendorsForVariant — a cancellation supersedes an older lapse", () => {
  it("excludes a vendor who cancelled the hotel AFTER an earlier subscription lapsed", async () => {
    const vendorId = IDS.users.vendor_alpha; // fixtures: active beverages cat sub
    await attachVendorToVariant(vendorId);
    // The original term, lapsed 200 days ago.
    await addSubDated(vendorId, {
      itemType: "hotel", itemId: IDS.hotels.A1, status: "expired",
      startOffsetDays: -300, endOffsetDays: -200,
    });
    // Then they cancelled, 100 days ago — the later, current statement.
    await addSubDated(vendorId, {
      itemType: "hotel", itemId: IDS.hotels.A1, status: "cancelled",
      startOffsetDays: -250, endOffsetDays: -100,
    });

    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID, [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).not.toContain(vendorId);
  });

  it("still includes a vendor who cancelled and then took a fresh term that lapsed", async () => {
    // The mirror image. The cancellation is the OLDER row, so it must not
    // suppress the newer subscription. Over-correcting here would silently cut
    // off every vendor who ever cancelled and came back.
    const vendorId = IDS.users.vendor_alpha;
    await attachVendorToVariant(vendorId);
    await addSubDated(vendorId, {
      itemType: "hotel", itemId: IDS.hotels.A1, status: "cancelled",
      startOffsetDays: -300, endOffsetDays: -200,
    });
    await addSubDated(vendorId, {
      itemType: "hotel", itemId: IDS.hotels.A1, status: "expired",
      startOffsetDays: -150, endOffsetDays: -30,
    });

    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID, [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).toContain(vendorId);
  });

  it("keeps a vendor whose live subscription outlasts an earlier cancellation", async () => {
    // The shape every renewing vendor has: they cancelled once, then bought a
    // current term. This is the production shape of vendor 834, who must keep
    // receiving RFQs.
    const vendorId = IDS.users.vendor_alpha;
    await attachVendorToVariant(vendorId);
    await addSubDated(vendorId, {
      itemType: "hotel", itemId: IDS.hotels.A1, status: "cancelled",
      startOffsetDays: -60, endOffsetDays: -60,
    });
    await addSubDated(vendorId, {
      itemType: "hotel", itemId: IDS.hotels.A1, status: "active",
      startOffsetDays: -60, endOffsetDays: 200,
    });

    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID, [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).toContain(vendorId);
  });

  it("applies the same rule to the category axis, not just the hotel", async () => {
    // A vendor of our own, so no fixture-seeded beverages subscription can
    // legitimately keep them eligible and mask the assertion.
    const vendorId = 80153;
    await db.none(
      `INSERT INTO tbl_users (id, name, email, status, company_id, created_at, updated_at)
       VALUES ($1, 'Category Rule Vendor', 'category.rule@vendor.test', 1, $2, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [vendorId, IDS.companies.vendorAlpha]
    );
    await attachVendorToVariant(vendorId);
    await addHotelSub(vendorId, IDS.hotels.A1);
    await addSubDated(vendorId, {
      itemType: "category", itemId: TEST_CATEGORIES.beverages, status: "expired",
      startOffsetDays: -300, endOffsetDays: -200,
    });
    await addSubDated(vendorId, {
      itemType: "category", itemId: TEST_CATEGORIES.beverages, status: "cancelled",
      startOffsetDays: -250, endOffsetDays: -100,
    });

    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID, [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).not.toContain(vendorId);
  });

  it("keeps that same vendor eligible while only the lapsed category term is on file", async () => {
    // The control for the test above: proves the exclusion came from the
    // cancellation, not from a missing subscription.
    const vendorId = 80154;
    await db.none(
      `INSERT INTO tbl_users (id, name, email, status, company_id, created_at, updated_at)
       VALUES ($1, 'Category Control Vendor', 'category.control@vendor.test', 1, $2, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [vendorId, IDS.companies.vendorAlpha]
    );
    await attachVendorToVariant(vendorId);
    await addHotelSub(vendorId, IDS.hotels.A1);
    await addSubDated(vendorId, {
      itemType: "category", itemId: TEST_CATEGORIES.beverages, status: "expired",
      startOffsetDays: -300, endOffsetDays: -200,
    });

    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID, [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).toContain(vendorId);
  });

  it("does not let a cancellation for ONE hotel suppress a live subscription to another", async () => {
    const vendorId = IDS.users.vendor_alpha;
    await attachVendorToVariant(vendorId);
    await addSubDated(vendorId, {
      itemType: "hotel", itemId: IDS.hotels.A2, status: "cancelled",
      startOffsetDays: -60, endOffsetDays: -30,
    });
    await addHotelSub(vendorId, IDS.hotels.A1);

    const rows = await hospitalityModel.getEligibleVendorsForVariant(
      TEST_VARIANT_ID, [IDS.hotels.A1]
    );
    expect(rows.map((r) => r.vendor_id)).toContain(vendorId);
  });
});

// ===========================================================================
//  The inflight backfill must honour the same rule.
//
//  A published RFQ whose deadline has not passed pulls newly-eligible vendors
//  in as their subscriptions change. The backfill carries its OWN copy of the
//  status predicate, so if the two disagree a vendor who cancelled gets
//  re-added to live RFQs minutes after being correctly left off at creation.
// ===========================================================================
describe("getMatchingOpenRfqsForVendor — same rule as creation-time eligibility", () => {
  const BACKFILL_VENDOR_ID = 80152; // outside the fixture block (80101..80105)
  let openRfqId;
  let backfillVariantId;
  const owned = { rfqIds: [], mappingIds: [], subIds: [] };

  beforeEach(async () => {
    const v = await db.one(
      `SELECT pv.id FROM tbl_product_variant pv
         JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
        WHERE pc.category_id = $1 ORDER BY pv.id LIMIT 1`,
      [TEST_CATEGORIES.beverages]
    );
    backfillVariantId = v.id;

    await db.none(
      `INSERT INTO tbl_users (id, name, email, status, company_id, created_at, updated_at)
       VALUES ($1, 'Backfill Rule Vendor', 'backfill.rule@vendor.test', 1, $2, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [BACKFILL_VENDOR_ID, IDS.companies.vendorAlpha]
    );
    const m = await db.one(
      `INSERT INTO tbl_product_variant_vendor_mapping
         (product_variant_id, vendor_id, status, is_approved, created_by, created_at, updated_at)
       VALUES ($1, $2, true, true, $2, now(), now()) RETURNING id`,
      [backfillVariantId, BACKFILL_VENDOR_ID]
    );
    owned.mappingIds.push(m.id);

    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 1,
      bid_end_date: new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19),
    });
    openRfqId = rfq_id;
    owned.rfqIds.push(rfq_id);
    await db.none(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0)`,
      [rfq_id, backfillVariantId]
    );
    await db.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT uq_rfq_hotel_mapping DO NOTHING`,
      [rfq_id, IDS.hotels.A1, IDS.users.a1_proc_buyer]
    );

    // A live category subscription, so only the HOTEL axis is under test.
    const cat = await db.one(
      `INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
       VALUES ($1, 'category', $2, 500, (now() - interval '30 days')::date,
               (now() + interval '335 days')::date, 'active') RETURNING id`,
      [BACKFILL_VENDOR_ID, TEST_CATEGORIES.beverages]
    );
    owned.subIds.push(cat.id);
  });

  afterEach(async () => {
    if (owned.subIds.length) {
      await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE id = ANY($1::int[])`, [owned.subIds]);
    }
    if (owned.rfqIds.length) {
      await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [owned.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [owned.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [owned.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [owned.rfqIds]);
    }
    if (owned.mappingIds.length) {
      await db.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE id = ANY($1::int[])`, [owned.mappingIds]);
    }
    owned.subIds = []; owned.rfqIds = []; owned.mappingIds = [];
  });

  async function addDatedHotelSub(status, startOffsetDays, endOffsetDays) {
    const row = await db.one(
      `INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
       VALUES ($1, 'hotel', $2, 0,
               (now() + ($3 || ' days')::interval)::date,
               (now() + ($4 || ' days')::interval)::date, $5)
       RETURNING id`,
      [BACKFILL_VENDOR_ID, IDS.hotels.A1, String(startOffsetDays), String(endOffsetDays), status]
    );
    owned.subIds.push(row.id);
    return row.id;
  }

  // Control: without this the test below could pass vacuously.
  it("offers the open RFQ while the hotel subscription is live", async () => {
    await addDatedHotelSub("active", -30, 335);
    const rfqs = await hospitalityModel.getMatchingOpenRfqsForVendor(BACKFILL_VENDOR_ID);
    expect(rfqs.map((r) => r.rfq_id)).toContain(openRfqId);
  });

  it("stops offering it once the vendor cancels, even with an older lapsed term on file", async () => {
    await addDatedHotelSub("expired", -300, -200);
    await addDatedHotelSub("cancelled", -250, -100);
    const rfqs = await hospitalityModel.getMatchingOpenRfqsForVendor(BACKFILL_VENDOR_ID);
    expect(rfqs.map((r) => r.rfq_id)).not.toContain(openRfqId);
  });

  it("keeps offering it to a vendor who cancelled and then resubscribed", async () => {
    await addDatedHotelSub("cancelled", -300, -200);
    await addDatedHotelSub("active", -30, 335);
    const rfqs = await hospitalityModel.getMatchingOpenRfqsForVendor(BACKFILL_VENDOR_ID);
    expect(rfqs.map((r) => r.rfq_id)).toContain(openRfqId);
  });
});
