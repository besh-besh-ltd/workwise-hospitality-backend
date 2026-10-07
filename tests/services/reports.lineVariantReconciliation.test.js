// Reports reach a PO line's item through its rfq_product — and agree with the
// dashboard by category, not just in total.
//
// On prod every RFQ PO line (2,387 of 2,387) carries product_variant_id NULL:
// the RFQ award path never wrote it, only the ARC call-off path does. Reports
// joined the variant through that column alone, so Report 1.1's category sheet,
// Report 1.2, Report 1.3's rate variance, Report 1.4's primary category and
// Report 2.2 all came back empty on prod while every test (which seeded the
// column) passed. The dashboard already resolved the variant through the
// rfq_product, so the two surfaces disagreed about where money went.
//
// Lines here are seeded exactly as prod stores them — no variant on the line.

import { describe, it, expect, afterAll, beforeAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { spendByCategory, categoryVendorSpend } from "../../app/models/reportsModel.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  makePO,
  cleanupPurchaseOrders,
} from "../helpers/dashboardSeed.js";

const BUYER = IDS.users.a1_proc_buyer;
const WIDE = { start_date: "2020-01-01", end_date: "2999-01-01" };
const TOKEN = "LV" + String(Date.now()).slice(-6);
const PARENT = `Aaa ${TOKEN} Parent`;
const LEAF = `Zzz ${TOKEN} Leaf`;
// Large enough to rank inside the dashboard's top-12 buckets (the rest fold
// into "Others") whatever else the shared seed DB holds.
const AMOUNTS = [120000000, 34550000.5];
const TOTAL = AMOUNTS.reduce((a, b) => a + b, 0);

const SCOPE = {
  userId: BUYER,
  hospitalityCompanyIds: [IDS.hospitality.A],
  companyId: IDS.companies.A,
  hotelIds: [IDS.hotels.A1],
  departmentId: null,
};
const WINDOW = { from: WIDE.start_date, to: WIDE.end_date, priorFrom: "2019-01-01", priorTo: "2019-12-31" };

const seeded = { rfqIds: [], poIds: [], categoryIds: [], productId: null, variantId: null, parentId: null, leafId: null };

async function dashboard(dimension) {
  const client = await httpClient(BUYER);
  const res = await client
    .get("/api/v1/dashboard-v2/category-insights")
    .query({ hotel_ids: String(IDS.hotels.A1), dimension, ...WIDE });
  expect(res.status).toBe(200);
  return res.body.data;
}

beforeAll(async () => {
  const parent = await db.one(
    `INSERT INTO tbl_category (title, parent_id, created_by) VALUES ($1, 0, $2) RETURNING id`,
    [PARENT, BUYER]
  );
  const leaf = await db.one(
    `INSERT INTO tbl_category (title, parent_id, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [LEAF, parent.id, BUYER]
  );
  seeded.parentId = parent.id;
  seeded.leafId = leaf.id;
  seeded.categoryIds.push(leaf.id, parent.id);
  const product = await db.one(
    `INSERT INTO tbl_product (name, slug, added_by) VALUES ($1, $2, $3) RETURNING id`,
    [`${TOKEN} Product`, `${TOKEN}-p`, BUYER]
  );
  seeded.productId = product.id;
  // Mapped to BOTH parent and leaf, as nearly every catalogue product is.
  await db.none(
    `INSERT INTO tbl_product_categories (product_id, category_id) VALUES ($1, $2), ($1, $3)`,
    [product.id, parent.id, leaf.id]
  );
  const variant = await db.one(
    `INSERT INTO tbl_product_variant (name, slug, added_by, product_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`${TOKEN} Item`, `${TOKEN}-v`, BUYER, product.id]
  );
  seeded.variantId = variant.id;

  const { rfq_id } = await makeRfqVisibleToDashboard(db, {
    createdBy: BUYER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    is_published: 1, status: 1, title: `${TOKEN} RFQ`,
  });
  seeded.rfqIds.push(rfq_id);

  for (const amount of AMOUNTS) {
    const rp = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
       VALUES ($1, '', '0', '', '', $2, 0) RETURNING id`,
      [rfq_id, variant.id]
    );
    // makePO writes the line WITHOUT product_variant_id — the prod shape.
    const { po_id } = await makePO(db, {
      rfq_id, rfq_product_id: rp.id, vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A, status: "approved", unit_price: amount, quantity: 1, total_value: amount,
    });
    seeded.poIds.push(po_id);
  }
});

afterAll(async () => {
  await cleanupPurchaseOrders(db, seeded.poIds);
  if (seeded.rfqIds.length) await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [seeded.rfqIds]);
  await cleanupRfqs(db, seeded.rfqIds);
  if (seeded.variantId) await db.none(`DELETE FROM tbl_product_variant WHERE id = $1`, [seeded.variantId]);
  if (seeded.productId) {
    await db.none(`DELETE FROM tbl_product_categories WHERE product_id = $1`, [seeded.productId]);
    await db.none(`DELETE FROM tbl_product WHERE id = $1`, [seeded.productId]);
  }
  if (seeded.categoryIds.length) await db.none(`DELETE FROM tbl_category WHERE id = ANY($1)`, [seeded.categoryIds]);
  await closeDb();
});

describe("PO lines without a stored variant (the prod shape)", () => {
  it("the seeded lines really are prod-shaped: no variant on the line", async () => {
    const rows = await db.any(
      `SELECT product_variant_id FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1)`,
      [seeded.poIds]
    );
    expect(rows).toHaveLength(AMOUNTS.length);
    for (const r of rows) expect(r.product_variant_id).toBeNull();
  });

  it("Report 1.2 files the spend under the leaf, and under its parent at the parent grain", async () => {
    const leafRows = await spendByCategory(SCOPE, WINDOW, { level: "leaf" });
    const parentRows = await spendByCategory(SCOPE, WINDOW, { level: "parent" });
    const leaf = leafRows.find((r) => r.category_id === seeded.leafId);
    const parent = parentRows.find((r) => r.category_id === seeded.parentId);
    expect(leaf?.amount).toBeCloseTo(TOTAL, 2);
    expect(leaf?.po_count).toBe(AMOUNTS.length);
    expect(parent?.amount).toBeCloseTo(TOTAL, 2);
    // Never double-counted under the parent at the leaf grain.
    expect(leafRows.find((r) => r.category_id === seeded.parentId)).toBeUndefined();
  });

  it("Report 2.2 attributes the category's spend to the vendor", async () => {
    const rows = await categoryVendorSpend(SCOPE, WINDOW);
    const row = rows.find((r) => r.category_id === seeded.parentId && r.vendor_id === IDS.users.vendor_alpha);
    expect(row?.amount).toBeCloseTo(TOTAL, 2);
  });

  it("RECONCILES by category: Reports = dashboard Spend-by-category, for the seeded category and in total", async () => {
    const [sub, cat, leafRows, parentRows] = await Promise.all([
      dashboard("subcategory"),
      dashboard("category"),
      spendByCategory(SCOPE, WINDOW, { level: "leaf" }),
      spendByCategory(SCOPE, WINDOW, { level: "parent" }),
    ]);

    const dashLeaf = sub.categories.find((c) => c.category_name === LEAF);
    const dashParent = cat.categories.find((c) => c.category_name === PARENT);
    const repLeaf = leafRows.find((r) => r.category_id === seeded.leafId);
    const repParent = parentRows.find((r) => r.category_id === seeded.parentId);
    expect(dashLeaf?.spend_amount).toBeCloseTo(repLeaf.amount, 2);
    expect(dashParent?.spend_amount).toBeCloseTo(repParent.amount, 2);

    // Whole-scope agreement: every categorised rupee in Reports, plus the
    // dashboard's "Uncategorized" bucket, is exactly the dashboard's total.
    const repCategorised = parentRows.reduce((s, r) => s + Number(r.amount), 0);
    const repLeafCategorised = leafRows.reduce((s, r) => s + Number(r.amount), 0);
    expect(repLeafCategorised).toBeCloseTo(repCategorised, 2);
    if (!cat.categories.some((c) => c.category_name === "Others")) {
      const uncategorised = cat.categories.find((c) => c.category_name === "Uncategorized")?.spend_amount || 0;
      expect(repCategorised + uncategorised).toBeCloseTo(cat.total_spend, 2);
    }
  });
});
