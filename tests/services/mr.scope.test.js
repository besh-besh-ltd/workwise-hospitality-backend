// SECURITY — Material Requisition read/act scope (P0-latent).
// ----------------------------------------------------------------------------
// The MR listing/dashboard already applies the (company × hotel × department)
// role-scope matrix (`scopeMatrixPredicate` in mrModel). Three endpoints did
// not, and answered a strictly wider question:
//
//   GET /v1/mr/form/hotels             → every BU under any company the user is
//                                        *mapped* to, ignoring the role-scope
//                                        matrix that governs everything else
//   GET /v1/mr/search-contracted-items → `department_id` came from the query
//                                        string and was never authorized, so
//                                        contracted unit rates + vendor names
//                                        for any department leaked
//   GET /v1/mr/:id                     → hotel axis checked, department axis not
//
// The distinction these tests pin: a hospitality *mapping* (company-level) is
// broader than a role *scope* (hotel + department). The matrix is the contract;
// the pickers and the detail read must not exceed it.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";

const priorUserTypes = new Map();
const seeded = {
  mrIds: [],
  arcIds: [],
  contractIds: [],
  mappingIds: [],
};

let variantId;
let engMrId; // MR at (A1, Engineering) — same hotel, different department
let procMrId; // MR at (A1, Procurement) — the caller's own cell
let b1MrId; // MR at (B1, Procurement) — different tenant entirely

async function setUserType(userId, value) {
  const row = await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [userId]);
  if (!priorUserTypes.has(userId)) priorUserTypes.set(userId, row.user_type);
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [userId, value]);
}

async function makeMr({ hospitality, hotel, department, raisedBy, title }) {
  const row = await db.one(
    `INSERT INTO tbl_material_requisition
       (mr_number, title, hospitality_company_id, hotel_id, department_id, status, raised_by)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6)
     RETURNING id`,
    [`MR-TEST-${Math.random().toString(36).slice(2, 10).toUpperCase()}`, title,
     hospitality, hotel, department, raisedBy]
  );
  seeded.mrIds.push(Number(row.id));
  return Number(row.id);
}

// A live ARC contract line at (hotel × department) — what
// search-contracted-items returns: unit rate + vendor name.
async function makeContractedItem({ hospitality, hotel, department, rate, title }) {
  const category = await db.one(`SELECT id FROM tbl_category ORDER BY id LIMIT 1`);
  const arc = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
        status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'contract_active', $7)
     RETURNING id`,
    [`ARC-TEST-${Math.random().toString(36).slice(2, 10).toUpperCase()}`, title,
     category.id, hospitality, hotel, department, IDS.users.companyA_admin]
  );
  seeded.arcIds.push(Number(arc.id));

  const item = await db.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
     VALUES ($1, $2, 100, 'kg') RETURNING id`,
    [arc.id, variantId]
  );
  const contract = await db.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status)
     VALUES ($1, $2, 'active') RETURNING id`,
    [arc.id, IDS.users.vendor_alpha]
  );
  seeded.contractIds.push(Number(contract.id));
  await db.none(
    `INSERT INTO tbl_arc_contract_line
       (arc_contract_id, arc_item_id, unit_rate, committed_qty, consumed_qty)
     VALUES ($1, $2, $3, 100, 0)`,
    [contract.id, item.id, rate]
  );
  return Number(arc.id);
}

beforeAll(async () => {
  // MR routes gate on acl([2, 8]); fixture users carry user_type NULL.
  await setUserType(IDS.users.a1_proc_buyer, 2);
  await setUserType(IDS.users.a1_eng_buyer, 2);
  await setUserType(IDS.users.companyB_admin, 2);

  const variant = await db.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`);
  variantId = variant.id;

  // THE SETUP THAT EXPOSES THE GAP: a1_proc_buyer keeps their single hotel-level
  // role scope (A1 × Procurement) but also gains a COMPANY-level hospitality
  // mapping. Mapping-derived helpers now see A1+A2+A3; the role-scope matrix
  // still sees only A1 × Procurement. The MR form must follow the matrix.
  const mapping = await db.one(
    `INSERT INTO tbl_hospitality_user_mappings
       (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
     VALUES ($1, $2, NULL, 0, $1)
     RETURNING id`,
    [IDS.users.a1_proc_buyer, IDS.hospitality.A]
  );
  seeded.mappingIds.push(mapping.id);

  procMrId = await makeMr({
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, department: IDS.departments.proc,
    raisedBy: IDS.users.a1_proc_commEval, title: "Procurement dept requisition",
  });
  engMrId = await makeMr({
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, department: IDS.departments.eng,
    raisedBy: IDS.users.a1_eng_buyer, title: "ENGINEERING DEPT SECRET REQUISITION",
  });
  b1MrId = await makeMr({
    hospitality: IDS.hospitality.B, hotel: IDS.hotels.B1, department: IDS.departments.proc,
    raisedBy: IDS.users.companyB_admin, title: "TENANT B SECRET REQUISITION",
  });

  await makeContractedItem({
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, department: IDS.departments.eng,
    rate: 4242.42, title: "Engineering-only rate contract",
  });
  await makeContractedItem({
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, department: IDS.departments.proc,
    rate: 1111.11, title: "Procurement rate contract",
  });
});

afterAll(async () => {
  if (seeded.contractIds.length) {
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = ANY($1::bigint[])`, [seeded.contractIds]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = ANY($1::bigint[])`, [seeded.contractIds]);
  }
  if (seeded.arcIds.length) {
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[])`, [seeded.arcIds]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [seeded.arcIds]);
  }
  if (seeded.mrIds.length) {
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE mr_id = ANY($1::bigint[])`, [seeded.mrIds]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::bigint[])`, [seeded.mrIds]);
  }
  if (seeded.mappingIds.length) {
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE id = ANY($1::int[])`, [seeded.mappingIds]);
  }
  for (const [userId, value] of priorUserTypes.entries()) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [userId, value]);
  }
  await closeDb();
});

const DENIED = [400, 403, 404];

// ---------------------------------------------------------------------------
// 1. GET /v1/mr/form/hotels — must follow the role-scope matrix
// ---------------------------------------------------------------------------
describe("GET /v1/mr/form/hotels", () => {
  it("returns only the business units inside the caller's role scope", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/mr/form/hotels`);

    expect(res.status).toBe(200);
    const ids = res.body.data.hotels.map((h) => Number(h.id));
    expect(ids).toContain(IDS.hotels.A1);
    expect(ids).not.toContain(IDS.hotels.A2);
    expect(ids).not.toContain(IDS.hotels.A3);
    expect(ids).not.toContain(IDS.hotels.B1);
  });

  it("agrees with the dashboard filter options, which derive from the same matrix", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const [form, filters] = await Promise.all([
      client.get(`/api/v1/mr/form/hotels`),
      client.get(`/api/v1/mr/dashboard/filter-options`),
    ]);

    const formIds = form.body.data.hotels.map((h) => Number(h.id)).sort();
    const filterIds = filters.body.data.hotels.map((h) => Number(h.id)).sort();
    expect(formIds).toEqual(filterIds);
  });
});

// ---------------------------------------------------------------------------
// 2. GET /v1/mr/search-contracted-items — department_id must be authorized
// ---------------------------------------------------------------------------
describe("GET /v1/mr/search-contracted-items", () => {
  it("cannot widen to another department via the query string", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(
      `/api/v1/mr/search-contracted-items?hotel_id=${IDS.hotels.A1}&department_id=${IDS.departments.eng}`
    );

    expect(DENIED).toContain(res.status);
    expect(JSON.stringify(res.body ?? {})).not.toContain("4242.42");
  });

  it("cannot enumerate another tenant's business unit", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(
      `/api/v1/mr/search-contracted-items?hotel_id=${IDS.hotels.B1}&department_id=${IDS.departments.proc}`
    );
    expect(DENIED).toContain(res.status);
  });

  it("still returns the caller's own (hotel × department) contracted items", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(
      `/api/v1/mr/search-contracted-items?hotel_id=${IDS.hotels.A1}&department_id=${IDS.departments.proc}`
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const rates = res.body.data.items.map((i) => String(i.current_rate));
    expect(rates.some((r) => r.startsWith("1111.11"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. GET /v1/mr/:id — the department axis counts
// ---------------------------------------------------------------------------
describe("GET /v1/mr/:id", () => {
  it("refuses an MR in another department of the same business unit", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/mr/${engMrId}`);

    expect(DENIED).toContain(res.status);
    expect(JSON.stringify(res.body ?? {})).not.toContain("ENGINEERING DEPT SECRET REQUISITION");
  });

  it("refuses an MR belonging to another tenant", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/mr/${b1MrId}`);

    expect(DENIED).toContain(res.status);
    expect(JSON.stringify(res.body ?? {})).not.toContain("TENANT B SECRET REQUISITION");
  });

  it("still returns an MR inside the caller's own (hotel × department) cell", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/mr/${procMrId}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.mr.title).toBe("Procurement dept requisition");
  });

  it("still lets the raiser read their own MR", async () => {
    const client = await httpClient(IDS.users.a1_eng_buyer);
    const res = await client.get(`/api/v1/mr/${engMrId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.mr.id).toBe(String(engMrId) === String(res.body.data.mr.id) ? res.body.data.mr.id : engMrId);
  });
});

// ---------------------------------------------------------------------------
// 4. POST /v1/mr — creation must respect the same cell
// ---------------------------------------------------------------------------
describe("POST /v1/mr (create draft)", () => {
  it("refuses a department the caller has no role scope for", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.post(`/api/v1/mr`).send({
      title: "Cross-department requisition",
      hotel_id: IDS.hotels.A1,
      department_id: IDS.departments.eng,
      items: [],
    });

    expect(DENIED).toContain(res.status);
    const rows = await db.any(
      `SELECT id FROM tbl_material_requisition WHERE title = 'Cross-department requisition'`
    );
    for (const r of rows) seeded.mrIds.push(Number(r.id));
    expect(rows.length).toBe(0);
  });

  it("refuses a business unit outside the caller's role scope", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.post(`/api/v1/mr`).send({
      title: "Cross-BU requisition",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.proc,
      items: [],
    });

    expect(DENIED).toContain(res.status);
    const rows = await db.any(
      `SELECT id FROM tbl_material_requisition WHERE title = 'Cross-BU requisition'`
    );
    for (const r of rows) seeded.mrIds.push(Number(r.id));
    expect(rows.length).toBe(0);
  });

  it("still creates a draft inside the caller's own cell", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.post(`/api/v1/mr`).send({
      title: "In-scope requisition",
      hotel_id: IDS.hotels.A1,
      department_id: IDS.departments.proc,
      items: [],
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    seeded.mrIds.push(Number(res.body.data.mr.id));
    expect(Number(res.body.data.mr.hospitality_company_id)).toBe(IDS.hospitality.A);
  });
});
