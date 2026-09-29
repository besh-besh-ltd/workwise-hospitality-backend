// Integration tests for GET /api/v1/dashboard-v2/smart-insights.
//
// Client feedback Sr 299: Smart Insights must include a price-benchmark signal
// — items recently paid ABOVE the best price previously paid for them. We seed
// a dominant item bought cheap once (benchmark) then expensive in-period.

import { describe, it, expect, afterAll, beforeAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import moment from "moment-timezone";
import { makeRfqVisibleToDashboard, cleanupRfqs, makePO, cleanupPurchaseOrders } from "../helpers/dashboardSeed.js";

const ENDPOINT = "/api/v1/dashboard-v2/smart-insights";
const WIDE = { start_date: "2020-01-01", end_date: "2999-01-01" };
const TOKEN = "SI" + String(Date.now()).slice(-6);
const ITEM = `${TOKEN} Benchmark Item`;
const QITEM = `${TOKEN} Quoted Item`;
const istDate = (d) => moment.tz("Asia/Kolkata").add(d, "days").format("YYYY-MM-DD");

const seeded = { rfqIds: [], poIds: [], productId: null, variantId: null, qVariantId: null, quoteIds: [] };

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
  seeded.latestPoId = b.po_id;

  // Price alert: the caller's own history for QITEM is ₹1,000 (two quotes 60
  // days ago, on an older RFQ); this week a vendor quoted ₹1,500 on a newer
  // RFQ. "Review quotes" must open THAT RFQ's comparison — the old action
  // searched the RFQ list by product name, which only matches titles.
  const qv = await db.one(
    `INSERT INTO tbl_product_variant (name, slug, added_by, product_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [QITEM, `${TOKEN}-qv`, u, product.id]
  );
  seeded.qVariantId = qv.id;
  const quoteOn = async (rfqId, vendor, price, agoDays) => {
    const r = await db.one(`SELECT rfq_no FROM tbl_rfq WHERE id = $1`, [rfqId]);
    const q = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, "timestamp", is_regret)
       VALUES ($1, $2, 1, $3, $3, now() - ($4 || ' days')::interval, 0) RETURNING id`,
      [rfqId, r.rfq_no, vendor, String(agoDays)]
    );
    seeded.quoteIds.push(q.id);
    await db.none(
      `INSERT INTO tbl_quote_items (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, comment, delivery_period, quantity, variant)
       VALUES ($1, $2, $3, $4, $5, $5, '', '', '1', 1)`,
      [rfqId, r.rfq_no, q.id, qv.id, price]
    );
  };
  const older = await makeRfqVisibleToDashboard(db, {
    createdBy: u, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, is_published: 1, status: 1, title: `${TOKEN} old RFQ`,
  });
  const newer = await makeRfqVisibleToDashboard(db, {
    createdBy: u, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, is_published: 1, status: 1, title: `${TOKEN} new RFQ`,
  });
  seeded.rfqIds.push(older.rfq_id, newer.rfq_id);
  seeded.alertRfqId = newer.rfq_id;
  // A small purchase 35 days ago (₹50,000) on a separate item, so the spend
  // trend has a near-empty previous period to compare against.
  const small = await makeRfqVisibleToDashboard(db, {
    createdBy: u, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, is_published: 1, status: 1, title: `${TOKEN} small RFQ`,
  });
  seeded.rfqIds.push(small.rfq_id);
  const smallRp = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', $2, 1) RETURNING id`,
    [small.rfq_id, qv.id]
  );
  const c = await makePO(db, {
    rfq_id: small.rfq_id, rfq_product_id: smallRp.id, vendor_user_id: IDS.users.vendor_alpha,
    company_id: IDS.companies.A, status: "approved", unit_price: 50000, quantity: 1, total_value: 50000, created_ago_days: 35,
  });
  seeded.poIds.push(c.po_id);

  await quoteOn(older.rfq_id, IDS.users.vendor_alpha, 1000, 60);
  await quoteOn(older.rfq_id, IDS.users.vendor_beta, 1000, 60);
  await quoteOn(newer.rfq_id, IDS.users.vendor_alpha, 1500, 1);
});

afterAll(async () => {
  await cleanupPurchaseOrders(db, seeded.poIds);
  if (seeded.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [seeded.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [seeded.quoteIds]);
  }
  if (seeded.qVariantId) await db.none(`DELETE FROM tbl_product_variant WHERE id = $1`, [seeded.qVariantId]);
  if (seeded.variantId) await db.none(`DELETE FROM tbl_rfq_products WHERE product_variant_id = ANY($1::int[])`, [[seeded.variantId, seeded.qVariantId].filter(Boolean)]);
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
    // Opens the purchase that tripped the alert, not a product-name search.
    expect(hit.action).toEqual({ type: "poDetail", params: { poId: seeded.latestPoId } });
  });

  it("'Review quotes' on a price alert opens the RFQ that carried the high quote", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(ENDPOINT).query({ hotel_ids: String(IDS.hotels.A1), start_date: istDate(-6), end_date: istDate(0) });
    expect(res.status).toBe(200);
    const hit = (res.body.data.insights || []).find((i) => i.type === "price_alert" && i.title.includes(QITEM));
    expect(hit).toBeDefined();
    expect(hit.action_label).toBe("Review quotes");
    expect(hit.action).toEqual({ type: "quoteCompare", params: { rfqId: seeded.alertRfqId } });
  });
});

describe("GET /dashboard-v2/smart-insights — spend trend", () => {
  const trendFor = async (range) => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(ENDPOINT).query({ hotel_ids: String(IDS.hotels.A1), ...range });
    expect(res.status).toBe(200);
    return (res.body.data.insights || []).find((i) => i.type === "spend_trend");
  };

  it("compares against a previous period that has comparable spend", async () => {
    // Current −14..0 = ₹20L; previous −29..−15 = ₹10L → +100%.
    const hit = await trendFor({ start_date: istDate(-14), end_date: istDate(0) });
    expect(hit).toBeDefined();
    expect(hit.title).toBe("Spend increased by 100%");
  });

  it("stays silent when the previous period had no spend", async () => {
    // Previous −13..−7 has no committed PO.
    expect(await trendFor({ start_date: istDate(-6), end_date: istDate(0) })).toBeUndefined();
  });

  it("stays silent when the previous period is under 10% of the current one", async () => {
    // Current −29..0 = ₹30L; previous −59..−30 = ₹50,000 (1.7%): a "+5,900%"
    // headline would only say the platform was new, not that spend jumped.
    expect(await trendFor({ start_date: istDate(-29), end_date: istDate(0) })).toBeUndefined();
  });
});
