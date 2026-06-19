// ARC v2 — create + publish + detail + KPIs integration test.
//
// Exercises POST /v1/arc-v2, PATCH, POST /:id/publish, GET /:id, GET /kpis
// against the real Express app and Postgres. Proves the Phase A foundation
// (services + models + controllers + routes + permissions + migrations) is
// wired correctly end-to-end.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

describe("ARC v2 — create → publish → detail flow", () => {
  const BUYER = IDS.users.a1_proc_buyer;
  const HOTEL = IDS.hotels.A1;
  const DEPT  = IDS.departments.proc;
  const HC    = IDS.hospitality.A;
  const PROC  = IDS.processes.A_P1;
  const CATEGORY = TEST_CATEGORIES.beverages;
  const VARIANT_ID = 1; // '7 UP PEPSI 1.5 LTR' — seeded in seed_reference.sql
  let client;

  beforeAll(async () => {
    // Seed the category → department mapping so the wizard's department
    // resolution picker has something to return for our test category.
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );
    // The platform's acl() middleware gates on tbl_users.user_type — the
    // fixtures intentionally leave it NULL (since RBAC is the source of
    // truth), but acl() still enforces user_type in route guards. Set the
    // buyer to user_type=2 (the platform's buyer type) for this test
    // suite so the route auth passes. This matches the assumption baked
    // into every acl([2,8]) route in the existing codebase.
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    // Publish now refuses to float to zero vendors (audit M2). Ensure the
    // beverages-subscribed vendor is an active vendor user so the open ARC
    // resolves ≥1 eligible vendor on publish (self-sufficient, no cross-suite
    // dependency).
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [IDS.users.vendor_alpha]);
    client = await httpClient(BUYER);
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_arc_event_log WHERE 1=1`);
    await db.none(`DELETE FROM tbl_arc WHERE 1=1`);
    await db.none(
      `DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`,
      [CATEGORY, DEPT]
    );
  });

  test("creates an ARC draft with items", async () => {
    const res = await client.post("/api/v1/arc-v2").send({
      title: "F&B Beverages · BAB · Q3 2026",
      description: "Test ARC for integration smoke",
      category_id: CATEGORY,
      hospitality_company_id: HC,
      hotel_id: HOTEL,
      department_id: DEPT,
      process_id: PROC,
      eligibility_type: "open",
      items: [
        { product_variant_id: VARIANT_ID, indicative_qty: 1000, uom: "litre", target_price: 120 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.arc).toMatchObject({
      title: "F&B Beverages · BAB · Q3 2026",
      category_id: CATEGORY,
      department_id: DEPT,
      hotel_id: HOTEL,
      status: "draft",
    });
    expect(res.body.data.items.length).toBe(1);
  });

  test("rejects publish when required dates are missing", async () => {
    // Create a fresh minimal draft (without dates) and try to publish.
    const createRes = await client.post("/api/v1/arc-v2").send({
      title: "Draft without dates",
      category_id: CATEGORY,
      hospitality_company_id: HC,
      hotel_id: HOTEL,
      department_id: DEPT,
      process_id: PROC,
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(createRes.status).toBe(200);
    const arcId = createRes.body.data.arc.id;
    const pubRes = await client.post(`/api/v1/arc-v2/${arcId}/publish`).send({});
    expect(pubRes.status).toBe(400);
    expect(pubRes.body.message).toMatch(/Missing|invalid/);
  });

  test("publishes a complete draft to floated", async () => {
    const today = new Date();
    const subStart = new Date(today.getTime() + 1 * 86400_000);
    const subEnd   = new Date(today.getTime() + 7 * 86400_000);
    const ctStart  = new Date(today.getTime() + 14 * 86400_000);
    const ctEnd    = new Date(today.getTime() + 200 * 86400_000);
    const createRes = await client.post("/api/v1/arc-v2").send({
      title: "Publishable ARC",
      category_id: CATEGORY,
      hospitality_company_id: HC,
      hotel_id: HOTEL,
      department_id: DEPT,
      process_id: PROC,
      submission_start_at: subStart.toISOString(),
      submission_end_at:   subEnd.toISOString(),
      contract_start_at:   ctStart.toISOString(),
      contract_end_at:     ctEnd.toISOString(),
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "litre" }],
    });
    expect(createRes.status).toBe(200);
    const arcId = createRes.body.data.arc.id;
    const pubRes = await client.post(`/api/v1/arc-v2/${arcId}/publish`).send({});
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.data.arc.status).toBe("floated");
    // Event log should record the float.
    const events = await db.any(
      `SELECT * FROM tbl_arc_event_log WHERE arc_id = $1 ORDER BY at`,
      [arcId]
    );
    const types = events.map(e => e.event_type);
    expect(types).toContain("created");
    expect(types).toContain("floated");
  });

  test("dashboard KPI counts reflect created ARCs", async () => {
    const res = await client.get(`/api/v1/arc-v2/kpis?hospitality_company_id=${HC}&hotel_ids=${HOTEL}`);
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toMatchObject({
      drafts:   expect.any(Number),
      ongoing:  expect.any(Number),
      approved: expect.any(Number),
      active:   expect.any(Number),
      ended:    expect.any(Number),
      all:      expect.any(Number),
    });
    expect(res.body.data.counts.all).toBeGreaterThan(0);
  });

  test("category-departments returns the seeded mapping ∩ user scope", async () => {
    const res = await client.get(
      `/api/v1/arc-v2/category-departments?category_id=${CATEGORY}&hospitality_company_id=${HC}`
    );
    expect(res.status).toBe(200);
    const ids = res.body.data.departments.map(d => d.id);
    expect(ids).toContain(DEPT);
  });
});
