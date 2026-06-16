// Integration tests for GET /api/v1/dashboard-v2/category-insights.
//
// Client feedback Sr 296: the "Spend by category" widget must support a
// dimension drill-down — Category (top-level), Sub-category (child), and Item
// (product variant). We seed ONE dedicated category hierarchy + product + PO so
// the expected bucket label is unique and unambiguous, then query each dimension.

import { describe, it, expect, afterAll, beforeAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { makeRfqVisibleToDashboard, cleanupRfqs, makePO, cleanupPurchaseOrders } from "../helpers/dashboardSeed.js";

const ENDPOINT = "/api/v1/dashboard-v2/category-insights";
const WIDE = { start_date: "2020-01-01", end_date: "2999-01-01" };
const SPEND = 700;

// Unique tokens so seeded buckets never collide with pre-existing seed data.
const TOKEN = "CDD" + String(Date.now()).slice(-6);
const PARENT_CAT = `${TOKEN} Parent Cat`;
const CHILD_CAT = `${TOKEN} Child Cat`;
const ITEM_NAME = `${TOKEN} Widget Item`;

const seeded = { rfqIds: [], poIds: [], productId: null, variantId: null, parentCatId: null, childCatId: null };

beforeAll(async () => {
  const u = IDS.users.a1_proc_buyer;
  const parent = await db.one(
    `INSERT INTO tbl_category (title, parent_id, created_by, slug) VALUES ($1, NULL, $2, $3) RETURNING id`,
    [PARENT_CAT, u, `${TOKEN}-parent`]
  );
  seeded.parentCatId = parent.id;
  const child = await db.one(
    `INSERT INTO tbl_category (title, parent_id, created_by, slug) VALUES ($1, $2, $3, $4) RETURNING id`,
    [CHILD_CAT, parent.id, u, `${TOKEN}-child`]
  );
  seeded.childCatId = child.id;
  const product = await db.one(
    `INSERT INTO tbl_product (name, slug, added_by) VALUES ($1, $2, $3) RETURNING id`,
    [`${TOKEN} Product`, `${TOKEN}-product`, u]
  );
  seeded.productId = product.id;
  const variant = await db.one(
    `INSERT INTO tbl_product_variant (name, slug, added_by, product_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ITEM_NAME, `${TOKEN}-variant`, u, product.id]
  );
  seeded.variantId = variant.id;
  await db.none(
    `INSERT INTO tbl_product_categories (product_id, category_id, category_name) VALUES ($1, $2, $3)`,
    [product.id, child.id, CHILD_CAT]
  );

  const { rfq_id } = await makeRfqVisibleToDashboard(db, {
    createdBy: u, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    is_published: 1, status: 1, title: `${TOKEN} RFQ`,
  });
  seeded.rfqIds.push(rfq_id);
  const rp = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', $2, 1) RETURNING id`,
    [rfq_id, variant.id]
  );
  const { po_id } = await makePO(db, {
    rfq_id, rfq_product_id: rp.id, vendor_user_id: IDS.users.vendor_alpha,
    company_id: IDS.companies.A, status: "approved", unit_price: SPEND, quantity: 1, total_value: SPEND,
  });
  seeded.poIds.push(po_id);
});

afterAll(async () => {
  await cleanupPurchaseOrders(db, seeded.poIds);
  if (seeded.variantId) await db.none(`DELETE FROM tbl_rfq_products WHERE product_variant_id = $1`, [seeded.variantId]);
  await cleanupRfqs(db, seeded.rfqIds);
  if (seeded.productId) await db.none(`DELETE FROM tbl_product_categories WHERE product_id = $1`, [seeded.productId]);
  if (seeded.variantId) await db.none(`DELETE FROM tbl_product_variant WHERE id = $1`, [seeded.variantId]);
  if (seeded.productId) await db.none(`DELETE FROM tbl_product WHERE id = $1`, [seeded.productId]);
  if (seeded.childCatId) await db.none(`DELETE FROM tbl_category WHERE id = $1`, [seeded.childCatId]);
  if (seeded.parentCatId) await db.none(`DELETE FROM tbl_category WHERE id = $1`, [seeded.parentCatId]);
  await closeDb();
});

async function fetchInsights(dimension) {
  const client = await httpClient(IDS.users.a1_proc_buyer);
  const res = await client.get(ENDPOINT).query({ hotel_ids: String(IDS.hotels.A1), dimension, ...WIDE });
  expect(res.status).toBe(200);
  expect(res.body?.status).toBe(1);
  return res.body.data;
}

describe("GET /dashboard-v2/category-insights — dimension drill-down (Sr 296)", () => {
  it("groups spend by Item (product variant)", async () => {
    const data = await fetchInsights("item");
    const bucket = data.categories.find((c) => c.category_name === ITEM_NAME);
    expect(bucket).toBeDefined();
    expect(bucket.spend_amount).toBeCloseTo(SPEND, 1);
  });

  it("groups spend by Sub-category (child category)", async () => {
    const data = await fetchInsights("subcategory");
    const bucket = data.categories.find((c) => c.category_name === CHILD_CAT);
    expect(bucket).toBeDefined();
    expect(bucket.spend_amount).toBeCloseTo(SPEND, 1);
  });

  it("rolls spend up to the top-level Category (parent of the mapped sub-category)", async () => {
    const data = await fetchInsights("category");
    const bucket = data.categories.find((c) => c.category_name === PARENT_CAT);
    expect(bucket).toBeDefined();
    expect(bucket.spend_amount).toBeCloseTo(SPEND, 1);
    // The child label must NOT appear as its own bucket at the category level.
    expect(data.categories.find((c) => c.category_name === CHILD_CAT)).toBeUndefined();
  });
});
