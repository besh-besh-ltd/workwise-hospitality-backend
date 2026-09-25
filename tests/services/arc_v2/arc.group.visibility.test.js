// Group ARC — who can SEE a group rate contract, and who can MANAGE it.
//
// A group ARC covers several hotels. Staff at every covered hotel are bound by
// its rates, so they must be able to read it. Running it — editing,
// publishing, evaluating, approving — stays with the lead hotel
// (tbl_arc.hotel_id), which is where HO runs the tender.
//
//   visibility → the lead hotel OR any hotel in tbl_arc_hotel_mappings
//   authority  → the lead hotel only
//
// Fixture shape: Company A has hotels A1, A2, A3. The group ARC is led by A1
// and covers A1 + A2 + A3 in Procurement. a1_eng_buyer normally holds only an
// A1 / Engineering scope; this suite grants them A3 / Procurement, so the ONLY
// thing connecting them to the group ARC is the A3 coverage row.
//
// Product-level: real Express app + Postgres over HTTP.

import { db } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { ROLE_IDS } from "../../fixtures/users.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { grantRoleScope, revokeRoleScopes } from "../../helpers/roleScope.js";

const { A1, A2, A3 } = IDS.hotels;
const HC_A = IDS.hospitality.A;
const PROC = IDS.departments.proc;
const TAG = `GRPVIS-${Date.now()}`;

const A3_USER = IDS.users.a1_eng_buyer;     // + A3/proc grant below
const A1_USER = IDS.users.a1_proc_buyer;    // A1/proc only
const B_ADMIN = IDS.users.companyB_admin;   // Company B, all hotels

async function insertArc({ title, hotelId, isGroup }) {
  const row = await db.one(
    `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id,
                          department_id, created_by, is_group, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
     RETURNING id`,
    [`${TAG}-${title}`.slice(0, 40), `${TAG} ${title}`, TEST_CATEGORIES.beverages, HC_A, hotelId,
     PROC, A1_USER, isGroup]
  );
  return Number(row.id);
}

describe("Group ARC — covered hotels read it, the lead hotel manages it", () => {
  let groupArcId;
  let singleA3ArcId;
  let scopeIds = [];
  let userTypesBefore;

  beforeAll(async () => {
    userTypesBefore = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`,
      [[A3_USER, A1_USER, B_ADMIN]]);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [[A3_USER, A1_USER, B_ADMIN]]);
    scopeIds.push(await grantRoleScope(db, {
      userId: A3_USER, roleId: ROLE_IDS.TENDER_CREATOR, companyId: HC_A, hotelId: A3, departmentId: PROC,
    }));

    groupArcId = await insertArc({ title: "group", hotelId: A1, isGroup: true });
    await db.none(
      `INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id, created_by)
       SELECT $1, h, $2 FROM unnest($3::int[]) AS h`,
      [groupArcId, A1_USER, [A1, A2, A3]]
    );
    singleA3ArcId = await insertArc({ title: "single-a3", hotelId: A3, isGroup: false });
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [[groupArcId, singleA3ArcId]]);
    await revokeRoleScopes(db, scopeIds);
    for (const u of userTypesBefore) {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
    }
  });

  const listIds = async (userId) => {
    const client = await httpClient(userId);
    const res = await client.post("/api/v1/arc-v2/list-view").send({ tab: "all", search: TAG, limit: 100 });
    expect(res.status).toBe(200);
    return res.body.data.rows.map((r) => Number(r.id));
  };

  test("staff at a covered hotel see the group ARC in their list", async () => {
    const ids = await listIds(A3_USER);
    expect(ids).toEqual(expect.arrayContaining([groupArcId, singleA3ArcId]));
  });

  test("staff at a covered hotel can open the group ARC and its lifecycle", async () => {
    const client = await httpClient(A3_USER);
    expect((await client.get(`/api/v1/arc-v2/${groupArcId}`)).status).toBe(200);
    const lifecycle = await client.get(`/api/v1/arc-v2/${groupArcId}/lifecycle`);
    expect(lifecycle.status).toBe(200);
    // Reading does not make them an evaluator: permissions resolve at the lead hotel.
    expect(lifecycle.body.data.permissions["arc-tech"]).toEqual([]);
    expect(lifecycle.body.data.permissions["arc-comm"]).toEqual([]);
    // The page names the hotels the contract covers, lead first.
    expect(lifecycle.body.data.arc.hotels.map((h) => [h.hotel_id, h.is_lead])).toEqual([[A1, true], [A2, false], [A3, false]]);
  });

  test("staff at a covered hotel cannot edit or publish it — that stays with the lead hotel", async () => {
    const client = await httpClient(A3_USER);
    expect((await client.patch(`/api/v1/arc-v2/${groupArcId}`).send({ title: "hijack" })).status).toBe(403);
    expect((await client.post(`/api/v1/arc-v2/${groupArcId}/publish`).send({})).status).toBe(403);
  });

  test("the lead hotel's buyer sees the group ARC but not another hotel's single ARC", async () => {
    const ids = await listIds(A1_USER);
    expect(ids).toContain(groupArcId);
    expect(ids).not.toContain(singleA3ArcId);
  });

  test("another company sees nothing and cannot open the group ARC", async () => {
    const ids = await listIds(B_ADMIN);
    expect(ids).not.toContain(groupArcId);
    const client = await httpClient(B_ADMIN);
    expect((await client.get(`/api/v1/arc-v2/${groupArcId}`)).status).toBe(403);
  });

  test("KPI counts include a group ARC only through its coverage", async () => {
    const client = await httpClient(A3_USER);
    const withCoverage = (await client.get(`/api/v1/arc-v2/kpis`)).body.data.counts.all;
    await db.none(`DELETE FROM tbl_arc_hotel_mappings WHERE arc_id = $1 AND hotel_id = $2`, [groupArcId, A3]);
    try {
      const withoutCoverage = (await client.get(`/api/v1/arc-v2/kpis`)).body.data.counts.all;
      expect(withCoverage - withoutCoverage).toBe(1);
    } finally {
      await db.none(`INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
        [groupArcId, A3, A1_USER]);
    }
  });

  test("a single-hotel ARC with a stray coverage row is not widened", async () => {
    // Coverage only counts for is_group ARCs; a mapping row on a single ARC
    // must never leak it to another hotel.
    await db.none(`INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
      [singleA3ArcId, A1, A1_USER]);
    try {
      expect(await listIds(A1_USER)).not.toContain(singleA3ArcId);
      const client = await httpClient(A1_USER);
      expect((await client.get(`/api/v1/arc-v2/${singleA3ArcId}`)).status).toBe(403);
    } finally {
      await db.none(`DELETE FROM tbl_arc_hotel_mappings WHERE arc_id = $1`, [singleA3ArcId]);
    }
  });
});
