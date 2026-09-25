// Group ARC — the wizard's pickers.
//
// Picking hotels for a group rate contract needs two things the single-hotel
// wizard did not: the departments the buyer holds at EVERY selected hotel (a
// group ARC has one department), and which hotel is the Head Office, so the
// wizard can suggest it as the lead hotel.

import { db } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { ROLE_IDS } from "../../fixtures/users.js";
import { grantRoleScope, revokeRoleScopes } from "../../helpers/roleScope.js";

const { A1, A2, A3 } = IDS.hotels;
const HC_A = IDS.hospitality.A;
const PROC = IDS.departments.proc;

const MULTI = IDS.users.multiHotel;       // A1 + A2, Procurement
const A1_ONLY = IDS.users.a1_proc_buyer;  // A1, Procurement
const SPLIT = IDS.users.a1_eng_buyer;     // A1 Engineering; + A2 Procurement below
const ADMIN_A = IDS.users.companyA_admin; // every hotel, every department

const deptIds = (res) => res.body.data.departments.map((d) => Number(d.id)).sort((a, b) => a - b);

describe("Group ARC pickers", () => {
  let typesBefore;
  const scopeIds = [];

  beforeAll(async () => {
    const users = [MULTI, A1_ONLY, SPLIT, ADMIN_A];
    typesBefore = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [users]);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [users]);
    scopeIds.push(await grantRoleScope(db, {
      userId: SPLIT, roleId: ROLE_IDS.TENDER_CREATOR, companyId: HC_A, hotelId: A2, departmentId: PROC,
    }));
  });

  afterAll(async () => {
    await revokeRoleScopes(db, scopeIds);
    for (const u of typesBefore) {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
    }
  });

  const departments = async (userId, query) => (await httpClient(userId)).get(`/api/v1/arc-v2/hotel-departments?${query}`);

  test("departments shared by every selected hotel", async () => {
    const res = await departments(MULTI, `hotel_ids=${A1},${A2}`);
    expect(res.status).toBe(200);
    expect(deptIds(res)).toEqual([PROC]);
  });

  test("a buyer with different departments at each hotel shares none", async () => {
    const res = await departments(SPLIT, `hotel_ids=${A1},${A2}`);
    expect(res.status).toBe(200);
    expect(res.body.data.departments).toEqual([]);
  });

  test("a company-wide buyer shares every department across the hotels", async () => {
    const all = await db.one(`SELECT COUNT(*)::int AS c FROM tbl_department`);
    const res = await departments(ADMIN_A, `hotel_ids=${A1},${A2},${A3}`);
    expect(res.status).toBe(200);
    expect(res.body.data.departments).toHaveLength(all.c);
  });

  test("asking about a hotel outside the buyer's scope is refused", async () => {
    const res = await departments(A1_ONLY, `hotel_ids=${A1},${A2}`);
    expect(res.status).toBe(403);
  });

  test("the single-hotel form is unchanged", async () => {
    const res = await departments(MULTI, `hotel_id=${A1}`);
    expect(res.status).toBe(200);
    expect(deptIds(res)).toEqual([PROC]);
  });

  test("the hotel picker says which hotel is the Head Office, and its state", async () => {
    const client = await httpClient(ADMIN_A);
    const res = await client.get(`/api/v1/arc-v2/hotels`);
    expect(res.status).toBe(200);
    const a1 = res.body.data.hotels.find((h) => Number(h.id) === A1);
    expect(a1).toHaveProperty("is_head_office");
    expect(typeof a1.is_head_office).toBe("boolean");
    expect(a1).toHaveProperty("state");
  });
});
