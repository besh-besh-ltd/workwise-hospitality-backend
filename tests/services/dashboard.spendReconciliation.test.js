// D1 — one definition of spend across the product.
//
// On prod (user 125, FYTD) the same "spend" read ₹33.96 Cr on the dashboard,
// ₹29.84 Cr in Reports and ₹35.54 Cr on the PO dashboard: the dashboard summed
// every PO that was not draft/cancelled, so rejected, pending-approval,
// acceptance-pending and vendor-rejected POs counted as money spent. Spend is
// now Reports 1.1's committed-spend population everywhere, and every card that
// sums it (Snapshot, Category, ABC) must reconcile to the rupee with Reports.
//
// Also pins the category rule: a product mapped to BOTH a parent and a leaf
// category lands under the LEAF (subcategory) / its PARENT (category) — never
// under whichever title sorts first.

import { describe, it, expect, afterAll, beforeAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { spendTotals } from "../../app/models/reportsModel.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  makePO,
  cleanupPurchaseOrders,
} from "../helpers/dashboardSeed.js";

const BUYER = IDS.users.a1_proc_buyer;
const WIDE = { start_date: "2020-01-01", end_date: "2999-01-01" };
const TOKEN = "SR" + String(Date.now()).slice(-6);

const seeded = { rfqIds: [], poIds: [], categoryIds: [], productId: null, variantId: null };
let before;

// Each status with the amount it would add if it (wrongly) counted.
const STATUSES = {
  approved: 1000,
  dispatched: 200,
  invoice_raised: 30,
  pending_approval: 4,
  acceptance_pending: 50000,
  rejected: 600000,
  rejected_by_vendor: 7000000,
  cancelled: 80000000,
  draft: 900000000,
};
const COMMITTED = 1000 + 200 + 30;

async function get(path, query = {}) {
  const client = await httpClient(BUYER);
  const res = await client.get(`/api/v1/dashboard-v2/${path}`).query({ hotel_ids: String(IDS.hotels.A1), ...WIDE, ...query });
  expect(res.status).toBe(200);
  return res.body.data;
}

async function reportsSpend() {
  const r = await spendTotals(
    {
      userId: BUYER,
      hospitalityCompanyIds: [IDS.hospitality.A],
      companyId: IDS.companies.A,
      hotelIds: [IDS.hotels.A1],
      departmentId: null,
    },
    { from: WIDE.start_date, to: WIDE.end_date, priorFrom: "2019-01-01", priorTo: "2019-12-31" }
  );
  return Number(r.amount);
}

async function snapshotAll() {
  const [snap, cat, sub, abc] = await Promise.all([
    get("procurement-snapshot"),
    get("category-insights", { dimension: "category" }),
    get("category-insights", { dimension: "subcategory" }),
    get("abc-analysis"),
  ]);
  return { snap, cat, sub, abc, reports: await reportsSpend() };
}

beforeAll(async () => {
  before = await snapshotAll();

  // Parent + leaf category; the product is mapped to BOTH (as 11,405 of 11,500
  // staging products are). "Aaa" sorts first so the old DISTINCT ON … ORDER BY
  // title rule would have picked the parent for subcategory.
  const parent = await db.one(
    `INSERT INTO tbl_category (title, parent_id, created_by) VALUES ($1, 0, $2) RETURNING id`,
    [`Aaa ${TOKEN} Parent`, BUYER]
  );
  const leaf = await db.one(
    `INSERT INTO tbl_category (title, parent_id, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [`Zzz ${TOKEN} Leaf`, parent.id, BUYER]
  );
  seeded.categoryIds.push(leaf.id, parent.id);
  const product = await db.one(
    `INSERT INTO tbl_product (name, slug, added_by) VALUES ($1, $2, $3) RETURNING id`,
    [`${TOKEN} Product`, `${TOKEN}-p`, BUYER]
  );
  seeded.productId = product.id;
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

  for (const [status, amount] of Object.entries(STATUSES)) {
    const rp = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
       VALUES ($1, '', '0', '', '', $2, 0) RETURNING id`,
      [rfq_id, variant.id]
    );
    const { po_id } = await makePO(db, {
      rfq_id, rfq_product_id: rp.id, vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A, status, unit_price: amount, quantity: 1, total_value: amount,
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

describe("committed spend only (D1)", () => {
  it("counts approved/dispatched/invoice_raised; never pending, acceptance-pending, rejected, cancelled or draft", async () => {
    const after = await snapshotAll();
    expect(after.snap.total_spend - before.snap.total_spend).toBeCloseTo(COMMITTED, 2);
    expect(after.snap.pos_issued - before.snap.pos_issued).toBe(3);
  });

  it("Snapshot = Category = Subcategory = ABC = Reports 1.1, to the rupee", async () => {
    const after = await snapshotAll();
    const d = {
      snapshot: after.snap.total_spend - before.snap.total_spend,
      category: after.cat.total_spend - before.cat.total_spend,
      subcategory: after.sub.total_spend - before.sub.total_spend,
      abc: after.abc.total_value - before.abc.total_value,
      reports: after.reports - before.reports,
    };
    for (const v of Object.values(d)) expect(v).toBeCloseTo(COMMITTED, 2);
    // Absolute totals agree too, not just the deltas.
    expect(after.snap.total_spend).toBeCloseTo(after.reports, 2);
    expect(after.abc.total_value).toBeCloseTo(after.snap.total_spend, 2);
  });
});

describe("one category per PO line (Reports' LEAF_CATEGORY_JOIN)", () => {
  it("subcategory = the leaf; category = the leaf's parent", async () => {
    const after = await snapshotAll();
    const leaf = after.sub.categories.find((c) => c.category_name === `Zzz ${TOKEN} Leaf`);
    const parent = after.cat.categories.find((c) => c.category_name === `Aaa ${TOKEN} Parent`);
    expect(leaf?.spend_amount).toBeCloseTo(COMMITTED, 2);
    expect(parent?.spend_amount).toBeCloseTo(COMMITTED, 2);
    expect(after.sub.categories.find((c) => c.category_name === `Aaa ${TOKEN} Parent`)).toBeUndefined();
    // Three committed POs on one RFQ: one distinct RFQ, three POs.
    expect(leaf.rfq_count).toBe(1);
    expect(leaf.po_count).toBe(3);
  });
});
