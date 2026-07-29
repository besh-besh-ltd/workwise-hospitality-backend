// Integration tests for GET /api/v1/dashboard-v2/abc-analysis.
//
// Client feedback Sr 297/298/303: classify procured items into ABC tiers by
// cumulative contribution — A (~top 70%), B (~next 20%), C (~bottom 10%) — on
// either Value (spend) or Volume (quantity), respecting the selected period.
//
// We seed a dominant item (huge value + volume) and a negligible one; the
// dominant item must land in class A under both metrics.

import { describe, it, expect, afterAll, beforeAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { makeRfqVisibleToDashboard, cleanupRfqs, makePO, cleanupPurchaseOrders } from "../helpers/dashboardSeed.js";

const ENDPOINT = "/api/v1/dashboard-v2/abc-analysis";
const WIDE = { start_date: "2020-01-01", end_date: "2999-01-01" };
const TOKEN = "ABC" + String(Date.now()).slice(-6);

const seeded = { rfqIds: [], poIds: [], productIds: [], variantIds: [], bigVariant: null, smallVariant: null };

async function seedItem(name, unitPrice, qty) {
  const u = IDS.users.a1_proc_buyer;
  const product = await db.one(
    `INSERT INTO tbl_product (name, slug, added_by) VALUES ($1, $2, $3) RETURNING id`,
    [`${name} P`, `${name}-p`, u]
  );
  seeded.productIds.push(product.id);
  const variant = await db.one(
    `INSERT INTO tbl_product_variant (name, slug, added_by, product_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, `${name}-v`, u, product.id]
  );
  seeded.variantIds.push(variant.id);

  const { rfq_id } = await makeRfqVisibleToDashboard(db, {
    createdBy: u, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    is_published: 1, status: 1, title: `${name} RFQ`,
  });
  seeded.rfqIds.push(rfq_id);
  const rp = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', $2, 1) RETURNING id`,
    [rfq_id, variant.id]
  );
  const total = unitPrice * qty;
  const { po_id } = await makePO(db, {
    rfq_id, rfq_product_id: rp.id, vendor_user_id: IDS.users.vendor_alpha,
    company_id: IDS.companies.A, status: "approved", unit_price: unitPrice, quantity: qty, total_value: total,
  });
  seeded.poIds.push(po_id);
  return variant.id;
}

beforeAll(async () => {
  // Dominant item — overwhelmingly the largest by both value and volume.
  seeded.bigVariant = await seedItem(`${TOKEN}-BIG`, 1000000, 1000000);
  // Negligible item.
  seeded.smallVariant = await seedItem(`${TOKEN}-SMALL`, 1, 1);
});

afterAll(async () => {
  await cleanupPurchaseOrders(db, seeded.poIds);
  if (seeded.variantIds.length) await db.none(`DELETE FROM tbl_rfq_products WHERE product_variant_id = ANY($1)`, [seeded.variantIds]);
  await cleanupRfqs(db, seeded.rfqIds);
  if (seeded.variantIds.length) await db.none(`DELETE FROM tbl_product_variant WHERE id = ANY($1)`, [seeded.variantIds]);
  if (seeded.productIds.length) await db.none(`DELETE FROM tbl_product WHERE id = ANY($1)`, [seeded.productIds]);
  await closeDb();
});

async function fetchAbc(metric) {
  const client = await httpClient(IDS.users.a1_proc_buyer);
  const res = await client.get(ENDPOINT).query({ hotel_ids: String(IDS.hotels.A1), metric, ...WIDE });
  expect(res.status).toBe(200);
  expect(res.body?.status).toBe(1);
  return res.body.data;
}

describe("GET /dashboard-v2/abc-analysis — auth", () => {
  it("returns 401/403 without a JWT", async () => {
    const client = await httpClient(null);
    const res = await client.get(ENDPOINT);
    expect([401, 403]).toContain(res.status);
  });
});

describe("GET /dashboard-v2/abc-analysis — classification (Sr 297/298/303)", () => {
  it("returns A/B/C class summary and a ranked item list (by value)", async () => {
    const data = await fetchAbc("value");
    expect(data.metric).toBe("value");
    expect(Array.isArray(data.classes)).toBe(true);
    expect(data.classes.map((c) => c.class).sort()).toEqual(["A", "B", "C"]);
    // The dominant item must be class A.
    const big = data.items.find((i) => i.product_variant_id === seeded.bigVariant);
    expect(big).toBeDefined();
    expect(big.class).toBe("A");
    // Items are ranked descending by the chosen metric.
    expect(data.items[0].product_variant_id).toBe(seeded.bigVariant);
  });

  it("classifies by volume when metric=volume", async () => {
    const data = await fetchAbc("volume");
    expect(data.metric).toBe("volume");
    const big = data.items.find((i) => i.product_variant_id === seeded.bigVariant);
    expect(big).toBeDefined();
    expect(big.class).toBe("A");
  });
});
