// ARC v2 — create/publish TENANT-SCOPE security (audit findings C1 + C4).
//
// Asserts the observable, end-to-end contract that the wizard relies on and
// that the security model demands:
//   C1 — a draft can be created WITHOUT the client supplying
//        hospitality_company_id; the server derives it from the hotel.
//   C4 — the server NEVER trusts a client-supplied company, rejects creating
//        or publishing for a hotel the caller cannot access, and so cannot be
//        used to mint/float a contract in another tenant.
//
// Product-level: real Express app + real Postgres, via supertest. No mocks.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import arcModel from "../../../app/models/arc_v2/arcModel.js";

describe("ARC v2 — create/publish tenant-scope security (C1 + C4)", () => {
  const BUYER = IDS.users.a1_proc_buyer; // mapped to Hotel A1 under Hospitality A only
  const HOTEL_A1 = IDS.hotels.A1;
  const HOTEL_B1 = IDS.hotels.B1; // under Hospitality B — buyer has NO access
  const DEPT = IDS.departments.proc;
  const HC_A = IDS.hospitality.A;
  const HC_B = IDS.hospitality.B;
  const PROC_A = IDS.processes.A_P1;
  const PROC_B = IDS.processes.B_P1;
  const CATEGORY = TEST_CATEGORIES.beverages;
  const VARIANT_ID = 1;
  let client;
  const createdArcIds = [];

  beforeAll(async () => {
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    client = await httpClient(BUYER);
  });

  afterAll(async () => {
    if (createdArcIds.length) {
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [createdArcIds]);
    }
    await db.none(
      `DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`,
      [CATEGORY, DEPT]
    );
  });

  test("C1 — creates a draft WITHOUT a client-supplied hospitality_company_id, deriving it from the hotel", async () => {
    const res = await client.post("/api/v1/arc-v2").send({
      title: "Scope C1 — derive company from hotel",
      category_id: CATEGORY,
      hotel_id: HOTEL_A1,
      department_id: DEPT,
      process_id: PROC_A,
      // NOTE: deliberately NO hospitality_company_id in the body.
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(Number(res.body.data.arc.hospitality_company_id)).toBe(HC_A);
    if (res.body?.data?.arc?.id) createdArcIds.push(res.body.data.arc.id);
  });

  test("H5 — creates a draft with NULL process_id when none is supplied", async () => {
    const res = await client.post("/api/v1/arc-v2").send({
      title: "H5 — null process",
      category_id: CATEGORY,
      hotel_id: HOTEL_A1,
      department_id: DEPT,
      // no process_id — ARC approval routes via the committee/hierarchy model
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.process_id).toBeNull();
    if (res.body?.data?.arc?.id) createdArcIds.push(res.body.data.arc.id);
  });

  test("C4 — ignores a spoofed hospitality_company_id in the body; uses the hotel's true company", async () => {
    const res = await client.post("/api/v1/arc-v2").send({
      title: "Scope C4 — spoofed company ignored",
      category_id: CATEGORY,
      hotel_id: HOTEL_A1,                 // truly under Hospitality A
      hospitality_company_id: HC_B,       // attacker tries to claim Hospitality B
      department_id: DEPT,
      process_id: PROC_A,
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.arc.hospitality_company_id)).toBe(HC_A);
    if (res.body?.data?.arc?.id) createdArcIds.push(res.body.data.arc.id);
  });

  test("L1 — ignores a client-supplied arc_number and generates one server-side", async () => {
    const res = await client.post("/api/v1/arc-v2").send({
      title: "L1 — client arc_number ignored",
      arc_number: "CLIENT-HACK-0001",
      category_id: CATEGORY,
      hotel_id: HOTEL_A1,
      department_id: DEPT,
      process_id: PROC_A,
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.arc_number).not.toBe("CLIENT-HACK-0001");
    expect(res.body.data.arc.arc_number).toMatch(/^ARC-/);
    if (res.body?.data?.arc?.id) createdArcIds.push(res.body.data.arc.id);
  });

  test("L3 — rejects a blank/whitespace-only title", async () => {
    const res = await client.post("/api/v1/arc-v2").send({
      title: "   ",
      category_id: CATEGORY,
      hotel_id: HOTEL_A1,
      department_id: DEPT,
      process_id: PROC_A,
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(res.status).toBe(400);
  });

  test("C4 — rejects creating an ARC for a hotel the caller cannot access", async () => {
    const res = await client.post("/api/v1/arc-v2").send({
      title: "Scope C4 — cross-tenant create",
      category_id: CATEGORY,
      hotel_id: HOTEL_B1,                 // Hospitality B — buyer has no access
      department_id: DEPT,
      process_id: PROC_B,
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(res.status).toBe(403);
    if (res.body?.data?.arc?.id) createdArcIds.push(res.body.data.arc.id);
  });

  test("C4 — rejects publishing an ARC that belongs to a tenant the caller cannot access", async () => {
    // Seed a complete, publishable draft owned by Hospitality B / Hotel B1.
    const today = new Date();
    const draft = await arcModel.createDraft({
      arc_number: `ARC-SCOPE-${today.getTime()}`,
      title: "B-side draft (foreign)",
      category_id: CATEGORY,
      hospitality_company_id: HC_B,
      hotel_id: HOTEL_B1,
      department_id: DEPT,
      process_id: PROC_B,
      submission_start_at: new Date(today.getTime() + 1 * 86400_000).toISOString(),
      submission_end_at:   new Date(today.getTime() + 7 * 86400_000).toISOString(),
      contract_start_at:   new Date(today.getTime() + 14 * 86400_000).toISOString(),
      contract_end_at:     new Date(today.getTime() + 200 * 86400_000).toISOString(),
      eligibility_type: "open",
      created_by: IDS.users.companyB_admin,
    });
    createdArcIds.push(draft.id);
    await arcModel.addItem(draft.id, { product_variant_id: VARIANT_ID, indicative_qty: 50, uom: "litre" });

    const res = await client.post(`/api/v1/arc-v2/${draft.id}/publish`).send({});
    expect(res.status).toBe(403);

    // And it must NOT have been floated.
    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [draft.id]);
    expect(row.status).toBe("draft");
  });
});
