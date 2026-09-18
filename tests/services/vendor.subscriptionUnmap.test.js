// WH-74 regression: removing a FREE sub-category must not strip the vendor of
// products the PAID parent category still covers.
//
// Production incident (2026-09-17, RFQ 536603): vendor 908 registered with
// ENGINEERING (paid, ₹3000) + its ELECTRICAL ITEMS sub-category (free). The
// next day they removed just the sub-category. `_unmapProductsForCategories`
// then hard-DELETED all 1,296 of their ELECTRICAL ITEMS product mappings even
// though ENGINEERING was still active and paid for. Eight of the eleven
// products on RFQ 536603 are ELECTRICAL ITEMS, so the vendor saw 2 of 11.
//
// Removal was the ONLY place a sub-category filtered anything: registration
// mapped every sub-category of the parent, the new-product mapper kept mapping
// new ELECTRICAL products to them afterwards, and the RFQ eligibility gate
// reads item_type='category' only. 58 vendors and ~22.3k mappings were hit.
//
// Locked-in semantics: a variant is unmapped only when NO category it belongs
// to survives the modification with an active subscription. That covers three
// cases, one test each:
//   1. sub-category removed, parent kept   -> mappings SURVIVE
//   2. parent category removed             -> mappings GO (incl. via cascade)
//   3. product shared with a kept category -> mappings SURVIVE
//
// Isolation: Pattern B (commit + cleanup) — the flow runs over real HTTP and
// the production code queries `db` directly.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

// Dedicated vendor + company, outside every fixture block so no other suite
// touches them. Vendor-user range is 80101..80199 (fixtures use 80101..80105).
const VENDOR_ID = 80161;
const COMPANY_ID = 90061;

// Seeded reference categories (tests/setup/seed_reference.sql):
//   215 BEVERAGES (parent)  -> 218 JUICE, 216 AERATED WATERS (children)
//   222 LIQUOR   (parent)
const CAT_PARENT = 215;
const SUBCAT = 218;
const CAT_OTHER = 222;

const created = { mappingIds: [], subscriptionIds: [] };

let subcatVariantId; // variant whose product sits under the SUBCAT
let sharedVariantId; // variant whose product sits under CAT_PARENT *and* CAT_OTHER

async function addSub(itemType, itemId) {
  const row = await db.one(
    `INSERT INTO tbl_vendor_hotel_category_subscription
       (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
     VALUES ($1, $2, $3, 500,
             (now() - interval '30 days')::date,
             (now() + interval '335 days')::date,
             'active')
     RETURNING id`,
    [VENDOR_ID, itemType, itemId]
  );
  created.subscriptionIds.push(row.id);
  return row.id;
}

async function mapVariant(variantId) {
  const row = await db.one(
    `INSERT INTO tbl_product_variant_vendor_mapping
       (product_variant_id, vendor_id, status, is_approved, created_by, created_at, updated_at)
     VALUES ($1, $2, true, true, $2, now(), now())
     RETURNING id`,
    [variantId, VENDOR_ID]
  );
  created.mappingIds.push(row.id);
  return row.id;
}

async function isMapped(variantId) {
  const row = await db.oneOrNone(
    `SELECT 1 FROM tbl_product_variant_vendor_mapping
      WHERE vendor_id = $1 AND product_variant_id = $2`,
    [VENDOR_ID, variantId]
  );
  return row !== null;
}

/** Final-state modify call: the vendor sends what they want to be left with. */
async function modify({ categories, subcategories }) {
  const client = await httpClient(VENDOR_ID);
  return client.post("/api/v1/hospitality/vendor/subscription/modify").send({
    target_categories: categories,
    target_subcategories: subcategories,
    target_hotels: [IDS.hotels.A1],
    confirm_removals: true,
  });
}

beforeAll(async () => {
  // A hospitality vendor company — modifySubscription rejects non-hospitality.
  await db.none(
    `INSERT INTO tbl_company (id, company_name, is_hospitality, "createdAt")
     VALUES ($1, 'Sub-category Unmap Vendor Pvt Ltd', 1, now())
     ON CONFLICT (id) DO NOTHING`,
    [COMPANY_ID]
  );
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'Sub-category Unmap Vendor', 'subcat.unmap@vendor.test', 1, 3, $2, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [VENDOR_ID, COMPANY_ID]
  );

  // A seeded variant under the sub-category, whose product ALSO carries the
  // parent category — the real shape: tbl_product_categories holds both rows.
  const sub = await db.one(
    `SELECT pv.id
       FROM tbl_product_variant pv
       JOIN tbl_product_categories child  ON child.product_id  = pv.product_id AND child.category_id  = $1
       JOIN tbl_product_categories parent ON parent.product_id = pv.product_id AND parent.category_id = $2
      ORDER BY pv.id
      LIMIT 1`,
    [SUBCAT, CAT_PARENT]
  );
  subcatVariantId = sub.id;

  // A seeded variant sitting under the parent category only — reused in the
  // "shared with a kept category" test by adding the second category to it.
  const shared = await db.one(
    `SELECT pv.id
       FROM tbl_product_variant pv
       JOIN tbl_product_categories pc ON pc.product_id = pv.product_id AND pc.category_id = $1
      WHERE pv.id <> $2
        AND NOT EXISTS (
          SELECT 1 FROM tbl_product_categories x
           WHERE x.product_id = pv.product_id AND x.category_id = $3
        )
      ORDER BY pv.id
      LIMIT 1`,
    [CAT_PARENT, subcatVariantId, CAT_OTHER]
  );
  sharedVariantId = shared.id;
});

beforeEach(async () => {
  // Fresh subscription + mapping state per test; each test mutates both.
  await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`, [VENDOR_ID]);
  await db.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE vendor_id = $1`, [VENDOR_ID]);
  created.subscriptionIds = [];
  created.mappingIds = [];

  // Two paid categories from the start, so every test below is a PURE removal
  // and stays on the free path. A removal paired with an addition would be a
  // swap and route to Razorpay, which tests cannot reach.
  await addSub("category", CAT_PARENT);
  await addSub("category", CAT_OTHER);
  await addSub("subcategory", SUBCAT);
  await addSub("hotel", IDS.hotels.A1);
  await mapVariant(subcatVariantId);
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`, [VENDOR_ID]);
  await db.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE vendor_id = $1`, [VENDOR_ID]);
  await db.none(`DELETE FROM tbl_vendor_payments WHERE vendor_id = $1`, [VENDOR_ID]);
  await db.none(`DELETE FROM tbl_product_categories WHERE product_id = (SELECT product_id FROM tbl_product_variant WHERE id = $1) AND category_id = $2`, [
    sharedVariantId,
    CAT_OTHER,
  ]);
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [VENDOR_ID]);
  await db.none(`DELETE FROM tbl_company WHERE id = $1`, [COMPANY_ID]);
  await closeDb();
});

describe("vendor subscription modify — product unmapping", () => {
  it("keeps the product mappings when only a sub-category is removed and its parent category stays", async () => {
    const res = await modify({ categories: [CAT_PARENT, CAT_OTHER], subcategories: [] });

    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(true);
    await expect(isMapped(subcatVariantId)).resolves.toBe(true);
  });

  it("removes the product mappings when the parent category itself is removed", async () => {
    // Drop CAT_PARENT (which cascades SUBCAT); keep CAT_OTHER, a category the
    // product does not belong to, so the request stays valid.
    const res = await modify({ categories: [CAT_OTHER], subcategories: [] });

    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(true);
    await expect(isMapped(subcatVariantId)).resolves.toBe(false);
  });

  it("keeps a product that also belongs to a category the vendor kept", async () => {
    // Put the shared product under CAT_OTHER as well, then drop CAT_PARENT.
    // CAT_OTHER still covers the product, so the mapping must survive.
    await db.none(
      `INSERT INTO tbl_product_categories (product_id, category_name, category_id)
       SELECT pv.product_id, 'LIQUOR', $2 FROM tbl_product_variant pv WHERE pv.id = $1`,
      [sharedVariantId, CAT_OTHER]
    );
    await mapVariant(sharedVariantId);

    const res = await modify({ categories: [CAT_OTHER], subcategories: [] });

    expect(res.status).toBe(200);
    await expect(isMapped(sharedVariantId)).resolves.toBe(true);
  });
});
