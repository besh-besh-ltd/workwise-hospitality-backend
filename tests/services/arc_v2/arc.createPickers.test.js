// ARC v2 — Create-wizard pickers (departments / catalogue variants / hotels).
//
// Product-level: real Express app + Postgres, fixture users, observable HTTP
// behaviour (never internal call counts). Covers:
//   1. GET /arc-v2/hotel-departments — departments the user is mapped to in the
//      selected hotel, derived from role scopes (NULL-dept = all-departments
//      grant). This replaced the old category→department mapping that dead-ended
//      with "No departments mapped to this category".
//   2. GET /arc-v2/variants — the Items step catalogue for a category (+ optional
//      sub-category narrowing).
//   3. GET /arc-v2/hotels — the BU picker must span ALL the user's companies, so
//      a multi-company user is never collapsed to one company's hotels.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";

const A1   = IDS.hotels.A1;       // hotel under Hospitality A
const B1   = IDS.hotels.B1;       // hotel under Hospitality B
const PROC = IDS.departments.proc;
const ENG  = IDS.departments.eng;

describe("ARC v2 — create-wizard pickers (departments / variants / hotels)", () => {
  let buyerClient;  // a1_proc_buyer: a SPECIFIC department scope (proc) at hotel A1, Hospitality A only
  let crossClient;  // crossCompany: company-wide (NULL-dept) scope in Hospitality A AND B

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`,
      [[IDS.users.a1_proc_buyer, IDS.users.crossCompany]]);
    buyerClient = await httpClient(IDS.users.a1_proc_buyer);
    crossClient = await httpClient(IDS.users.crossCompany);
  });

  // ── hotel-departments ──────────────────────────────────────────────────
  test("hotel-departments: a department-scoped user sees ONLY their mapped department", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/hotel-departments?hotel_id=${A1}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.departments.map((d) => Number(d.id));
    expect(ids).toContain(PROC);
    // A specific-department scope must NOT widen to every department.
    expect(ids).not.toContain(ENG);
  });

  test("hotel-departments: a company-wide (NULL-dept) user sees EVERY department", async () => {
    const res = await crossClient.get(`/api/v1/arc-v2/hotel-departments?hotel_id=${A1}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.departments.map((d) => Number(d.id));
    // NULL-department grant → all departments (proc + eng both present).
    expect(ids).toEqual(expect.arrayContaining([PROC, ENG]));
  });

  test("hotel-departments: a hotel in a company the user isn't mapped to → empty (no leak)", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/hotel-departments?hotel_id=${B1}`);
    expect(res.status).toBe(200);
    expect(res.body.data.departments).toEqual([]);
  });

  test("hotel-departments: missing hotel_id → 400", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/hotel-departments`);
    expect(res.status).toBe(400);
  });

  // ── variants (Items step) ──────────────────────────────────────────────
  test("variants: a category with catalogue returns items", async () => {
    // Resolve a category that actually carries variants in THIS db (the test
    // DB is a staging snapshot) so the assertion isn't tied to a hard-coded id.
    const cat = await db.oneOrNone(
      `SELECT pc.category_id AS id, COUNT(DISTINCT pv.id) AS n
         FROM tbl_product_categories pc
         JOIN tbl_product_variant pv ON pv.product_id = pc.product_id
        WHERE COALESCE(pv.status, 1) = 1
        GROUP BY pc.category_id
        ORDER BY n DESC
        LIMIT 1`
    );
    expect(cat).toBeTruthy();
    const res = await buyerClient.get(`/api/v1/arc-v2/variants?category_id=${cat.id}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.variants)).toBe(true);
    expect(res.body.data.variants.length).toBeGreaterThan(0);
    // The shape the wizard renders.
    expect(res.body.data.variants[0]).toHaveProperty("id");
    expect(res.body.data.variants[0]).toHaveProperty("name");
  });

  test("variants: a sub-category filter narrows to a non-empty subset", async () => {
    // A (root, sub) pair where products live under both and have active variants.
    const pair = await db.oneOrNone(
      `SELECT pc1.category_id AS root, ch.id AS sub
         FROM tbl_product_categories pc1
         JOIN tbl_category ch ON ch.parent_id = pc1.category_id
         JOIN tbl_product_categories pc2 ON pc2.product_id = pc1.product_id AND pc2.category_id = ch.id
         JOIN tbl_product_variant pv ON pv.product_id = pc1.product_id AND COALESCE(pv.status, 1) = 1
        GROUP BY pc1.category_id, ch.id
       HAVING COUNT(DISTINCT pv.id) > 0
        LIMIT 1`
    );
    if (!pair) return; // snapshot without a populated sub-category — nothing to assert
    const all = await buyerClient.get(`/api/v1/arc-v2/variants?category_id=${pair.root}`);
    const sub = await buyerClient.get(`/api/v1/arc-v2/variants?category_id=${pair.root}&sub_category_ids=${pair.sub}`);
    expect(sub.status).toBe(200);
    expect(sub.body.data.variants.length).toBeGreaterThan(0);
    expect(sub.body.data.variants.length).toBeLessThanOrEqual(all.body.data.variants.length);
  });

  test("variants: missing category_id → 400", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/variants`);
    expect(res.status).toBe(400);
  });

  // ── hotels (BU picker — must NOT collapse to one company) ───────────────
  test("hotels: a single-company user sees only their company's hotels", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/hotels`);
    expect(res.status).toBe(200);
    const companies = new Set(res.body.data.hotels.map((h) => Number(h.hospitality_company_id)));
    expect(companies.has(IDS.hospitality.A)).toBe(true);
    expect(companies.has(IDS.hospitality.B)).toBe(false);
  });

  test("hotels: a multi-company user sees hotels from BOTH companies (no collapse)", async () => {
    const res = await crossClient.get(`/api/v1/arc-v2/hotels`);
    expect(res.status).toBe(200);
    const companies = new Set(res.body.data.hotels.map((h) => Number(h.hospitality_company_id)));
    expect(companies.has(IDS.hospitality.A)).toBe(true);
    expect(companies.has(IDS.hospitality.B)).toBe(true);
  });
});
