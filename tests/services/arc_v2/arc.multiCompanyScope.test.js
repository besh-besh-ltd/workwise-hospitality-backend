// ARC v2 — multi-company list scope (the "single-company collapse" fix).
//
// resolveHospitalityCompanyScope returns EVERY company the user is mapped to, so
// a multi-company user's listing spans all of them (narrowed in-page by the BU
// facet) instead of silently collapsing to one — which is what hid a
// multi-company user's own data before the fix. A single-company user still
// only ever sees their own company's contracts.
//
// Product-level: real Express app + Postgres, observable HTTP behaviour.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";

const HC_A = IDS.hospitality.A;
const HC_B = IDS.hospitality.B;
const A1   = IDS.hotels.A1;
const B1   = IDS.hotels.B1;
const CAT  = 215; // beverages (seeded category)

describe("ARC v2 — multi-company list spans every mapped company (collapse fix)", () => {
  let crossClient; // crossCompany: mapped to Hospitality A AND B
  let buyerClient; // a1_proc_buyer: mapped to Hospitality A only
  let arcA, arcB;

  const insertArc = async (num, hc, hotel) =>
    Number((await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, 'draft',
               NOW(), NOW() + INTERVAL '7 days', NOW() + INTERVAL '8 days', NOW() + INTERVAL '180 days',
               $7)
       RETURNING id`,
      [num, `Multi-co ${num}`, CAT, hc, hotel, IDS.departments.proc, IDS.users.crossCompany]
    )).id);

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`,
      [[IDS.users.crossCompany, IDS.users.a1_proc_buyer]]);
    crossClient = await httpClient(IDS.users.crossCompany);
    buyerClient = await httpClient(IDS.users.a1_proc_buyer);
    arcA = await insertArc("ARC-MC-A", HC_A, A1);
    arcB = await insertArc("ARC-MC-B", HC_B, B1);
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [[arcA, arcB].filter(Boolean)]);
  });

  test("a multi-company user's list includes contracts from BOTH companies", async () => {
    const res = await crossClient.get(`/api/v1/arc-v2?statusGroup=all&limit=200`);
    expect(res.status).toBe(200);
    const ids = res.body.data.data.map((r) => Number(r.id));
    expect(ids).toContain(arcA); // Hospitality A
    expect(ids).toContain(arcB); // Hospitality B
  });

  test("a single-company user sees only their company's contract, never the other's", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2?statusGroup=all&limit=200`);
    expect(res.status).toBe(200);
    const ids = res.body.data.data.map((r) => Number(r.id));
    expect(ids).toContain(arcA);     // company A — theirs
    expect(ids).not.toContain(arcB); // company B — not theirs
  });
});
