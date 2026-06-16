// Integration tests for GET /api/v1/dashboard-v2/cost-intelligence (the
// "Price benchmarking" widget).
//
// Client feedback Sr 299/300/301/302: benchmark each item's purchase price
// against the BEST price previously paid for it, focused on high-value items.
// We seed three approved POs for one item at unit prices 100/60/80 → the
// benchmark (best previously paid) must be 60.

import { describe, it, expect, afterAll, beforeAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { makeRfqVisibleToDashboard, cleanupRfqs, makePO, cleanupPurchaseOrders } from "../helpers/dashboardSeed.js";

const ENDPOINT = "/api/v1/dashboard-v2/cost-intelligence";
const WIDE = { start_date: "2020-01-01", end_date: "2999-01-01" };
const TOKEN = "CI" + String(Date.now()).slice(-6);

const seeded = { rfqIds: [], poIds: [], productId: null, variantId: null };

beforeAll(async () => {
  const u = IDS.users.a1_proc_buyer;
  const product = await db.one(
    `INSERT INTO tbl_product (name, slug, added_by) VALUES ($1, $2, $3) RETURNING id`,
    [`${TOKEN} Product`, `${TOKEN}-p`, u]
  );
  seeded.productId = product.id;
  const variant = await db.one(
    `INSERT INTO tbl_product_variant (name, slug, added_by, product_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`${TOKEN} Item`, `${TOKEN}-v`, u, product.id]
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

  // Three approved POs at unit prices 100, 60, 80 → best previously paid = 60.
  for (const price of [100, 60, 80]) {
    const { po_id } = await makePO(db, {
      rfq_id, rfq_product_id: rp.id, vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A, status: "approved", unit_price: price, quantity: 1, total_value: price,
    });
    seeded.poIds.push(po_id);
  }

  // A vendor quote where UNIT price (50) and LINE TOTAL (5000 = 50 × 100 qty)
  // differ sharply — so the trend/benchmark must use the per-UNIT basis.
  const rfqRow = await db.one(`SELECT rfq_no FROM tbl_rfq WHERE id = $1`, [rfq_id]);
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
     VALUES ($1, $2, $3, $3, 1, now()) RETURNING id`,
    [rfq_id, rfqRow.rfq_no, IDS.users.vendor_alpha]
  );
  seeded.quoteId = quote.id;
  await db.none(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, comment, delivery_period, quantity)
     VALUES ($1, $2, $3, $4, 50, 5000, '', '', '100')`,
    [rfq_id, rfqRow.rfq_no, quote.id, variant.id]
  );
});

afterAll(async () => {
  await cleanupPurchaseOrders(db, seeded.poIds);
  if (seeded.rfqIds.length) await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1)`, [seeded.rfqIds]);
  if (seeded.variantId) await db.none(`DELETE FROM tbl_rfq_products WHERE product_variant_id = $1`, [seeded.variantId]);
  await cleanupRfqs(db, seeded.rfqIds);
  if (seeded.variantId) await db.none(`DELETE FROM tbl_product_variant WHERE id = $1`, [seeded.variantId]);
  if (seeded.productId) await db.none(`DELETE FROM tbl_product WHERE id = $1`, [seeded.productId]);
  await closeDb();
});

describe("GET /dashboard-v2/cost-intelligence — price benchmark (Sr 299/301)", () => {
  it("returns benchmark_price = best (lowest) unit price previously paid for the item", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(ENDPOINT).query({
      hotel_ids: String(IDS.hotels.A1),
      product_variant_id: seeded.variantId,
      ...WIDE,
    });
    expect(res.status).toBe(200);
    expect(res.body?.status).toBe(1);
    const d = res.body.data;
    expect(d.benchmark).toBeDefined();
    expect(d.benchmark.benchmark_price).toBeCloseTo(60, 1);
    expect(d.benchmark.product_variant_id).toBe(seeded.variantId);
  });

  it("trend, latest avg and benchmark all use the per-UNIT basis (not line totals)", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(ENDPOINT).query({
      hotel_ids: String(IDS.hotels.A1),
      product_variant_id: seeded.variantId,
      ...WIDE,
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    // Quote was unit_price=50, total_price=5000. The trend must reflect the
    // UNIT price (50), never the line total (5000).
    const avgPoints = (d.price_trend.avg || []).filter((v) => v > 0);
    expect(avgPoints.length).toBeGreaterThan(0);
    avgPoints.forEach((v) => expect(v).toBeCloseTo(50, 0));
    // "Latest avg" in the benchmark banner is per-unit too — comparable to the
    // per-unit benchmark, never an order-of-magnitude apart.
    expect(d.benchmark.current_price).toBeCloseTo(50, 0);
  });
});
