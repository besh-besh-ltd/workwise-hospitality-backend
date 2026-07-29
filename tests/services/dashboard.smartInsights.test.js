// Integration tests for GET /api/v1/dashboard-v2/smart-insights.
//
// Client feedback Sr 299: Smart Insights must include a price-benchmark signal
// — items recently paid ABOVE the best price previously paid for them. We seed
// a dominant item bought cheap once (benchmark) then expensive in-period.

import { describe, it, expect, afterAll, beforeAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { makeRfqVisibleToDashboard, cleanupRfqs, makePO, cleanupPurchaseOrders } from "../helpers/dashboardSeed.js";

const ENDPOINT = "/api/v1/dashboard-v2/smart-insights";
const WIDE = { start_date: "2020-01-01", end_date: "2999-01-01" };
const TOKEN = "SI" + String(Date.now()).slice(-6);
const ITEM = `${TOKEN} Benchmark Item`;

const seeded = { rfqIds: [], poIds: [], productId: null, variantId: null };

beforeAll(async () => {
  const u = IDS.users.a1_proc_buyer;
  const product = await db.one(
    `INSERT INTO tbl_product (name, slug, added_by) VALUES ($1, $2, $3) RETURNING id`,
    [`${TOKEN} P`, `${TOKEN}-p`, u]
  );
  seeded.productId = product.id;
  const variant = await db.one(
    `INSERT INTO tbl_product_variant (name, slug, added_by, product_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ITEM, `${TOKEN}-v`, u, product.id]
  );
  seeded.variantId = variant.id;
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
  // Cheap earlier purchase = benchmark; expensive latest purchase = overpaying.
  const a = await makePO(db, {
    rfq_id, rfq_product_id: rp.id, vendor_user_id: IDS.users.vendor_alpha,
    company_id: IDS.companies.A, status: "approved", unit_price: 1000000, quantity: 1, total_value: 1000000, created_ago_days: 20,
  });
  seeded.poIds.push(a.po_id);
  const b = await makePO(db, {
    rfq_id, rfq_product_id: rp.id, vendor_user_id: IDS.users.vendor_alpha,
    company_id: IDS.companies.A, status: "approved", unit_price: 2000000, quantity: 1, total_value: 2000000,
  });
  seeded.poIds.push(b.po_id);
});

afterAll(async () => {
  await cleanupPurchaseOrders(db, seeded.poIds);
  if (seeded.variantId) await db.none(`DELETE FROM tbl_rfq_products WHERE product_variant_id = $1`, [seeded.variantId]);
  await cleanupRfqs(db, seeded.rfqIds);
  if (seeded.variantId) await db.none(`DELETE FROM tbl_product_variant WHERE id = $1`, [seeded.variantId]);
  if (seeded.productId) await db.none(`DELETE FROM tbl_product WHERE id = $1`, [seeded.productId]);
  await closeDb();
});

describe("GET /dashboard-v2/smart-insights — price benchmark insight (Sr 299)", () => {
  it("flags an item paid above its best previously-paid price", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(ENDPOINT).query({ hotel_ids: String(IDS.hotels.A1), ...WIDE });
    expect(res.status).toBe(200);
    expect(res.body?.status).toBe(1);
    const insights = res.body.data.insights || [];
    const hit = insights.find((i) => i.type === "benchmark_alert" && i.title.includes(ITEM));
    expect(hit).toBeDefined();
    expect(hit.severity).toBe("high"); // 100% above benchmark
  });
});
