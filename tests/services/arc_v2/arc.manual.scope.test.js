// ARC v2 — Manual entry: tenant-scope security (spec §6.6, §11 arc.manual.scope).
//
// Asserts the observable security contract: the hotel derives the company; a
// body-supplied company is ignored; a non-accessible hotel is rejected; and
// reload-and-verify guards every PATCH.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

describe("ARC v2 manual — tenant-scope security", () => {
  const BUYER = IDS.users.a1_proc_buyer;     // Hotel A1 / Hospitality A only
  const HOTEL_A1 = IDS.hotels.A1;
  const HOTEL_B1 = IDS.hotels.B1;            // Hospitality B — buyer has NO access
  const DEPT = IDS.departments.proc;
  const HC_A = IDS.hospitality.A;
  const HC_B = IDS.hospitality.B;
  const CATEGORY = TEST_CATEGORIES.beverages;
  let client;
  const createdArcIds = [];

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    client = await httpClient(BUYER);
  });

  afterAll(async () => {
    if (createdArcIds.length) {
      await db.none(`DELETE FROM tbl_arc_manual_entry WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [createdArcIds]);
    }
  });

  function payload(extra = {}) {
    return {
      header: { title: "Manual scope ARC", type: "product" },
      scope: { hotel_id: HOTEL_A1, category_id: CATEGORY, department_id: DEPT, ...extra },
      provenance: { target_stage: "draft", created_at: "2024-04-01T00:00:00Z" },
    };
  }

  test("derives hospitality_company_id from the hotel (no body company)", async () => {
    const res = await client.post("/api/v1/arc-v2/manual/draft").send(payload());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(Number(res.body.data.arc.hospitality_company_id)).toBe(HC_A);
    createdArcIds.push(res.body.data.arc.id);
  });

  test("ignores a spoofed company id in the scope body", async () => {
    const res = await client.post("/api/v1/arc-v2/manual/draft").send(
      payload({ hospitality_company_id: HC_B }) // attacker tries Hospitality B
    );
    expect(res.status).toBe(200);
    expect(Number(res.body.data.arc.hospitality_company_id)).toBe(HC_A);
    createdArcIds.push(res.body.data.arc.id);
  });

  test("rejects creating for a hotel the caller cannot access (403)", async () => {
    const res = await client.post("/api/v1/arc-v2/manual/draft").send({
      header: { title: "cross-tenant" },
      scope: { hotel_id: HOTEL_B1, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: "draft", created_at: "2024-04-01T00:00:00Z" },
    });
    expect(res.status).toBe(403);
  });

  test("reload-and-verify: PATCH on a foreign ARC is rejected (403)", async () => {
    // Seed a manual draft owned by Hospitality B directly.
    const arc = await db.one(
      `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, status, created_by)
       VALUES ($1, 'B-side manual', $2, $3, $4, $5, 'draft', $6) RETURNING *`,
      [`ARC-MAN-B-${Date.now()}`, CATEGORY, HC_B, HOTEL_B1, DEPT, IDS.users.companyB_admin]
    );
    createdArcIds.push(arc.id);
    await db.none(
      `INSERT INTO tbl_arc_manual_entry (arc_id, target_stage, entered_by) VALUES ($1, 'draft', $2)`,
      [arc.id, IDS.users.companyB_admin]
    );
    const res = await client.patch(`/api/v1/arc-v2/manual/draft/${arc.id}`).send({ header: { title: "hijack" } });
    expect(res.status).toBe(403);
    const row = await db.one(`SELECT title FROM tbl_arc WHERE id = $1`, [arc.id]);
    expect(row.title).toBe("B-side manual");
  });
});
