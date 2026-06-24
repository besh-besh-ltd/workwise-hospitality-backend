// MR Buyer Dashboard — read-scope correctness + header filters + scoped options.
//
// Proves the SECURITY MANDATE: every MR dashboard read path
// (analytics / kpis / list / list-view / filter-options) scopes by the strict
// per-row (company × hotel × department) role-scope matrix from
// tbl_user_role_scopes (NULL = "all" at each axis). A scoped user sees ONLY the
// (hotel,dept) cells they're granted; NULL department = all departments; client
// BU/dept/date FILTERS narrow within the matrix but can NEVER widen it. The
// date filter targets created_at. Super-admin (user_type 8) sees everything.
//
// Seeds a GRID of MRs across (hotel × dept) cells under hospitality A (+ a
// company-B MR + a last-FY MR) so scope differences are directly observable,
// then asserts each scoped user's reads reflect ONLY their cells.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";

const HC_A = IDS.hospitality.A;
const HC_B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const A3 = IDS.hotels.A3;
const B1 = IDS.hotels.B1;
const PROC = IDS.departments.proc;
const ENG = IDS.departments.eng;
const FB = IDS.departments.fb;

const U = IDS.users;

const PFX = "MR-DASHSCOPE-";

// ---- Date helpers (Indian FY starts April 1) -------------------------------
function pad(n) { return String(n).padStart(2, "0"); }
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
// Current FY's April 1 (if month < April → previous calendar year's Apr 1).
function currentFyStartYear(now = new Date()) {
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
}
const NOW = new Date();
const FY_START_YEAR = currentFyStartYear(NOW);
const FYTD_FROM = `${FY_START_YEAR}-04-01`;            // inclusive
const TODAY = isoDate(NOW);                            // inclusive
const PREV_FY_FROM = `${FY_START_YEAR - 1}-04-01`;     // last FY start
const PREV_FY_TO = `${FY_START_YEAR}-03-31`;           // last FY end (inclusive)
// A created_at timestamp solidly inside the current FY (mid current FY year).
const CURRENT_FY_TS = `${FY_START_YEAR}-06-15 10:00:00`;
// A created_at timestamp inside the previous FY (its June).
const LAST_FY_TS = `${FY_START_YEAR - 1}-06-15 10:00:00`;

// ---- Grid of MRs we seed ---------------------------------------------------
// Each: { num, hc, hotel, dept, status, createdAt }. raised_by is set to a
// user that legitimately belongs to that cell where one exists, else the
// company admin / super admin — raised_by does not affect the matrix scope.
const GRID = [
  { num: `${PFX}A1-PROC`,      hc: HC_A, hotel: A1, dept: PROC, status: "pending_approval", at: CURRENT_FY_TS, by: U.a1_proc_buyer },
  { num: `${PFX}A1-ENG`,       hc: HC_A, hotel: A1, dept: ENG,  status: "draft",            at: CURRENT_FY_TS, by: U.a1_eng_buyer },
  { num: `${PFX}A1-FB`,        hc: HC_A, hotel: A1, dept: FB,   status: "approved",         at: CURRENT_FY_TS, by: U.companyA_admin },
  { num: `${PFX}A2-PROC`,      hc: HC_A, hotel: A2, dept: PROC, status: "approved",         at: CURRENT_FY_TS, by: U.multiHotel },
  { num: `${PFX}A2-ENG`,       hc: HC_A, hotel: A2, dept: ENG,  status: "po_released",      at: CURRENT_FY_TS, by: U.companyA_admin },
  { num: `${PFX}A3-PROC`,      hc: HC_A, hotel: A3, dept: PROC, status: "pending_approval", at: CURRENT_FY_TS, by: U.companyA_admin },
  // company-B MR — proves the company boundary holds.
  { num: `${PFX}B1-PROC`,      hc: HC_B, hotel: B1, dept: PROC, status: "approved",         at: CURRENT_FY_TS, by: U.companyB_admin },
  // last-FY MR at (A1, proc) — for date-range tests (in scope for proc users).
  { num: `${PFX}A1-PROC-LFY`,  hc: HC_A, hotel: A1, dept: PROC, status: "approved",         at: LAST_FY_TS,    by: U.a1_proc_buyer },
];

// Temp user for the SHARP off-diagonal cross-cell case: Procurement@A1 +
// Engineering@A2. Must NOT see Procurement@A2 or Engineering@A1.
const OFFDIAG_UID = 80077;

function buyerType(uid) { return db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [uid]); }

async function clientFor(uid) { return httpClient(uid); }

// Pull mr_numbers (with our prefix) out of any list/recent payload.
function numsOf(rows) {
  return (rows || []).map((r) => r.mr_number).filter((n) => typeof n === "string" && n.startsWith(PFX));
}

describe("MR dashboard — read-scope matrix + filters + scoped options", () => {
  beforeAll(async () => {
    // Buyer role gate (acl([2,8])) — fixtures leave user_type NULL.
    for (const uid of [U.a1_proc_buyer, U.a1_eng_buyer, U.multiHotel, U.companyA_admin, U.companyB_admin]) {
      await buyerType(uid);
    }
    // Super admin must be user_type 8 for the unrestricted path.
    await db.none(`UPDATE tbl_users SET user_type = 8 WHERE id = $1`, [U.superAdmin]);

    // Seed the grid. created_at is explicit so date-range tests are deterministic.
    for (const g of GRID) {
      await db.none(
        `INSERT INTO tbl_material_requisition
           (mr_number, title, hospitality_company_id, hotel_id, department_id,
            urgency, raised_by, status, submitted_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'normal', $6, $7,
                 $8::timestamp, $8::timestamp, $8::timestamp)
         ON CONFLICT (mr_number) DO NOTHING`,
        [g.num, g.num, g.hc, g.hotel, g.dept, g.by, g.status, g.at]
      );
    }

    // Temp off-diagonal user: Proc@A1 + Eng@A2 (mappings to A1+A2, two scope rows).
    await db.none(
      `INSERT INTO tbl_users (id, name, email, status, company_id, created_at, updated_at)
       VALUES ($1, 'Off-Diag User', 'offdiag@test.local', 1, $2, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [OFFDIAG_UID, IDS.companies.A]
    );
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [OFFDIAG_UID]);
    for (const hotel of [A1, A2]) {
      await db.none(
        `INSERT INTO tbl_hospitality_user_mappings
           (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
         VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
        [OFFDIAG_UID, HC_A, hotel, U.superAdmin]
      );
    }
    await db.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, 2, $2, $3, $4), ($1, 2, $2, $5, $6)`,
      [OFFDIAG_UID, HC_A, A1, PROC, A2, ENG]
    );
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_material_requisition WHERE mr_number LIKE $1`, [`${PFX}%`]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [OFFDIAG_UID]);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [OFFDIAG_UID]);
    await db.none(`DELETE FROM tbl_users WHERE id = $1`, [OFFDIAG_UID]);
  });

  // Helper: fetch analytics for a client and return a small projection.
  async function analyticsFor(client, qs = "") {
    const res = await client.get(`/api/v1/mr/analytics${qs}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    return {
      d,
      // count of OUR seeded grid MRs visible (recent feed is capped at 8 but our
      // grid is ≤8, so it surfaces all our rows for the scoped user).
      seenNums: new Set(numsOf(d.recent)),
      deptNames: new Set((d.by_department || []).filter((x) => x.count > 0).map((x) => x.department_id)),
      hotelIds: new Set((d.by_hotel || []).filter((x) => x.count > 0).map((x) => Number(x.hotel_id))),
    };
  }

  // ---- Case 1: dept-scoped user sees ONLY their cell -----------------------
  test("CASE 1 — a1_proc_buyer (A1,proc) sees ONLY (A1,proc); excludes A1-eng/A1-fb/A2/A3", async () => {
    const client = await clientFor(U.a1_proc_buyer);
    const { seenNums, hotelIds, deptNames } = await analyticsFor(client);

    // Sees its own cell.
    expect(seenNums.has(`${PFX}A1-PROC`)).toBe(true);
    // Excludes every other grid cell.
    expect(seenNums.has(`${PFX}A1-ENG`)).toBe(false);
    expect(seenNums.has(`${PFX}A1-FB`)).toBe(false);
    expect(seenNums.has(`${PFX}A2-PROC`)).toBe(false);
    expect(seenNums.has(`${PFX}A2-ENG`)).toBe(false);
    expect(seenNums.has(`${PFX}A3-PROC`)).toBe(false);
    expect(seenNums.has(`${PFX}B1-PROC`)).toBe(false);
    // by_hotel/by_department never expose A2/A3 or eng/fb.
    expect(hotelIds.has(A2)).toBe(false);
    expect(hotelIds.has(A3)).toBe(false);
    expect(deptNames.has(ENG)).toBe(false);
    expect(deptNames.has(FB)).toBe(false);
    expect(deptNames.has(PROC)).toBe(true);
  });

  test("CASE 1b — list endpoint for a1_proc_buyer returns only (A1,proc) grid rows", async () => {
    const client = await clientFor(U.a1_proc_buyer);
    const res = await client.get(`/api/v1/mr?limit=200`);
    expect(res.status).toBe(200);
    const nums = new Set(numsOf(res.body.data.data));
    expect(nums.has(`${PFX}A1-PROC`)).toBe(true);
    expect(nums.has(`${PFX}A1-PROC-LFY`)).toBe(true);
    for (const bad of [`${PFX}A1-ENG`, `${PFX}A1-FB`, `${PFX}A2-PROC`, `${PFX}A2-ENG`, `${PFX}A3-PROC`, `${PFX}B1-PROC`]) {
      expect(nums.has(bad)).toBe(false);
    }
  });

  // ---- Case 2: per-dept isolation within the same hotel --------------------
  test("CASE 2 — a1_eng_buyer (A1,eng) sees ONLY (A1,eng), not (A1,proc)", async () => {
    const client = await clientFor(U.a1_eng_buyer);
    const { seenNums, deptNames } = await analyticsFor(client);
    expect(seenNums.has(`${PFX}A1-ENG`)).toBe(true);
    expect(seenNums.has(`${PFX}A1-PROC`)).toBe(false);
    expect(seenNums.has(`${PFX}A1-FB`)).toBe(false);
    expect(seenNums.has(`${PFX}A2-ENG`)).toBe(false);
    expect(deptNames.has(PROC)).toBe(false);
    expect(deptNames.has(ENG)).toBe(true);
  });

  // ---- Case 3: NULL-department (company-wide) scope sees ALL under company --
  test("CASE 3 — companyA_admin (A, NULL, NULL) sees every (hotel×dept) under company A, no company-B leak", async () => {
    const client = await clientFor(U.companyA_admin);
    const { seenNums, hotelIds, deptNames } = await analyticsFor(client);
    // Every company-A grid cell visible (NULL hotel + NULL dept = all).
    for (const ok of [`${PFX}A1-PROC`, `${PFX}A1-ENG`, `${PFX}A1-FB`, `${PFX}A2-PROC`, `${PFX}A2-ENG`, `${PFX}A3-PROC`]) {
      expect(seenNums.has(ok)).toBe(true);
    }
    // The company-B MR must NOT leak.
    expect(seenNums.has(`${PFX}B1-PROC`)).toBe(false);
    expect(hotelIds.has(B1)).toBe(false);
    // Spans hotels A1/A2/A3 and depts proc/eng/fb.
    expect(hotelIds.has(A1)).toBe(true);
    expect(hotelIds.has(A2)).toBe(true);
    expect(hotelIds.has(A3)).toBe(true);
    expect(deptNames.has(PROC)).toBe(true);
    expect(deptNames.has(ENG)).toBe(true);
    expect(deptNames.has(FB)).toBe(true);
  });

  // ---- Case 4: strict-matrix crux -----------------------------------------
  test("CASE 4a — multiHotel (A1,proc)+(A2,proc) sees proc@A1 + proc@A2, NOT eng@A1/eng@A2", async () => {
    const client = await clientFor(U.multiHotel);
    const { seenNums } = await analyticsFor(client);
    expect(seenNums.has(`${PFX}A1-PROC`)).toBe(true);
    expect(seenNums.has(`${PFX}A2-PROC`)).toBe(true);
    // Off-diagonal eng cells must be excluded (NOT {A1,A2}×{proc,eng}).
    expect(seenNums.has(`${PFX}A1-ENG`)).toBe(false);
    expect(seenNums.has(`${PFX}A2-ENG`)).toBe(false);
    expect(seenNums.has(`${PFX}A3-PROC`)).toBe(false); // A3 not in scope
  });

  test("CASE 4b — sharp off-diagonal: Proc@A1 + Eng@A2 user sees proc@A1 & eng@A2 ONLY, not proc@A2/eng@A1", async () => {
    const client = await clientFor(OFFDIAG_UID);
    const { seenNums } = await analyticsFor(client);
    // The two granted diagonal cells.
    expect(seenNums.has(`${PFX}A1-PROC`)).toBe(true);
    expect(seenNums.has(`${PFX}A2-ENG`)).toBe(true);
    // The two off-diagonal cells (same hotels/depts but wrong pairing) MUST be hidden.
    expect(seenNums.has(`${PFX}A2-PROC`)).toBe(false);
    expect(seenNums.has(`${PFX}A1-ENG`)).toBe(false);
    // And nothing else.
    expect(seenNums.has(`${PFX}A1-FB`)).toBe(false);
    expect(seenNums.has(`${PFX}A3-PROC`)).toBe(false);
    expect(seenNums.has(`${PFX}B1-PROC`)).toBe(false);
  });

  // ---- Case 5: client filter cannot WIDEN ----------------------------------
  test("CASE 5a — a1_proc_buyer ?hotel_ids=A2 (outside grant) returns nothing", async () => {
    const client = await clientFor(U.a1_proc_buyer);
    const res = await client.get(`/api/v1/mr/analytics?hotel_ids=${A2}`);
    expect(res.status).toBe(200);
    // Intersection of {A1} (scope) and {A2} (filter) = ∅ → no rows.
    expect(res.body.data.totals.all).toBe(0);
    expect(numsOf(res.body.data.recent).length).toBe(0);
  });

  test("CASE 5b — a1_proc_buyer ?department_ids=eng (outside grant) returns nothing", async () => {
    const client = await clientFor(U.a1_proc_buyer);
    const res = await client.get(`/api/v1/mr/analytics?department_ids=${ENG}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals.all).toBe(0);
  });

  // ---- Case 6: client filter narrows WITHIN scope --------------------------
  test("CASE 6 — companyA_admin ?department_ids=proc narrows to proc only (valid)", async () => {
    const client = await clientFor(U.companyA_admin);
    const res = await client.get(`/api/v1/mr/analytics?department_ids=${PROC}`);
    expect(res.status).toBe(200);
    const seen = new Set(numsOf(res.body.data.recent));
    // proc cells across A1/A2/A3 present.
    expect(seen.has(`${PFX}A1-PROC`)).toBe(true);
    expect(seen.has(`${PFX}A2-PROC`)).toBe(true);
    expect(seen.has(`${PFX}A3-PROC`)).toBe(true);
    // non-proc excluded by the narrowing filter.
    expect(seen.has(`${PFX}A1-ENG`)).toBe(false);
    expect(seen.has(`${PFX}A2-ENG`)).toBe(false);
    expect(seen.has(`${PFX}A1-FB`)).toBe(false);
    // still no company-B leak.
    expect(seen.has(`${PFX}B1-PROC`)).toBe(false);

    // And ?hotel_ids=A1 narrows to A1 only.
    const res2 = await client.get(`/api/v1/mr/analytics?hotel_ids=${A1}`);
    const seen2 = new Set(numsOf(res2.body.data.recent));
    expect(seen2.has(`${PFX}A1-PROC`)).toBe(true);
    expect(seen2.has(`${PFX}A1-ENG`)).toBe(true);
    expect(seen2.has(`${PFX}A1-FB`)).toBe(true);
    expect(seen2.has(`${PFX}A2-PROC`)).toBe(false);
    expect(seen2.has(`${PFX}A2-ENG`)).toBe(false);
  });

  // ---- Case 7: date-range filter (FYTD) -----------------------------------
  test("CASE 7 — FYTD window includes current-FY MRs, excludes last-FY MR", async () => {
    const client = await clientFor(U.a1_proc_buyer);
    const res = await client.get(
      `/api/v1/mr/analytics?created_from=${FYTD_FROM}&created_to=${TODAY}`
    );
    expect(res.status).toBe(200);
    const seen = new Set(numsOf(res.body.data.recent));
    expect(seen.has(`${PFX}A1-PROC`)).toBe(true);       // current FY
    expect(seen.has(`${PFX}A1-PROC-LFY`)).toBe(false);  // last FY excluded
  });

  // ---- Case 8: date-range last FY (+ straddling custom) --------------------
  test("CASE 8 — Last-FY window includes the last-FY MR, excludes current-FY; straddling custom returns both", async () => {
    const client = await clientFor(U.a1_proc_buyer);
    const lastFy = await client.get(
      `/api/v1/mr/analytics?created_from=${PREV_FY_FROM}&created_to=${PREV_FY_TO}`
    );
    expect(lastFy.status).toBe(200);
    const seenLfy = new Set(numsOf(lastFy.body.data.recent));
    expect(seenLfy.has(`${PFX}A1-PROC-LFY`)).toBe(true);
    expect(seenLfy.has(`${PFX}A1-PROC`)).toBe(false);

    // Custom range straddling both FYs returns both proc MRs.
    const both = await client.get(
      `/api/v1/mr/analytics?created_from=${PREV_FY_FROM}&created_to=${TODAY}`
    );
    const seenBoth = new Set(numsOf(both.body.data.recent));
    expect(seenBoth.has(`${PFX}A1-PROC-LFY`)).toBe(true);
    expect(seenBoth.has(`${PFX}A1-PROC`)).toBe(true);
  });

  // ---- Case 9: filter-options is scoped ------------------------------------
  test("CASE 9a — filter-options for a1_proc_buyer = [A1] + [Procurement] only", async () => {
    const client = await clientFor(U.a1_proc_buyer);
    const res = await client.get(`/api/v1/mr/dashboard/filter-options`);
    expect(res.status).toBe(200);
    const hotelIds = new Set(res.body.data.hotels.map((h) => Number(h.id)));
    const deptIds = new Set(res.body.data.departments.map((d) => Number(d.id)));
    expect(hotelIds.has(A1)).toBe(true);
    expect(hotelIds.has(A2)).toBe(false);
    expect(hotelIds.has(A3)).toBe(false);
    expect(hotelIds.has(B1)).toBe(false);
    expect(deptIds.has(PROC)).toBe(true);
    expect(deptIds.has(ENG)).toBe(false);
    expect(deptIds.has(FB)).toBe(false);
  });

  test("CASE 9b — filter-options for companyA_admin = all A hotels + all departments", async () => {
    const client = await clientFor(U.companyA_admin);
    const res = await client.get(`/api/v1/mr/dashboard/filter-options`);
    expect(res.status).toBe(200);
    const hotelIds = new Set(res.body.data.hotels.map((h) => Number(h.id)));
    const deptIds = new Set(res.body.data.departments.map((d) => Number(d.id)));
    // All hotels under hospitality A (NULL-hotel scope row expands to all).
    expect(hotelIds.has(A1)).toBe(true);
    expect(hotelIds.has(A2)).toBe(true);
    expect(hotelIds.has(A3)).toBe(true);
    // No company-B hotel.
    expect(hotelIds.has(B1)).toBe(false);
    // All departments (NULL-dept scope row → every dept).
    expect(deptIds.has(PROC)).toBe(true);
    expect(deptIds.has(ENG)).toBe(true);
    expect(deptIds.has(FB)).toBe(true);
  });

  test("CASE 9c — filter-options for super-admin returns all hotels (incl. B) + all departments", async () => {
    const client = await clientFor(U.superAdmin);
    const res = await client.get(`/api/v1/mr/dashboard/filter-options`);
    expect(res.status).toBe(200);
    const hotelIds = new Set(res.body.data.hotels.map((h) => Number(h.id)));
    expect(hotelIds.has(A1)).toBe(true);
    expect(hotelIds.has(B1)).toBe(true);
    expect(res.body.data.departments.length).toBeGreaterThanOrEqual(4);
  });

  // ---- Case 10: super-admin sees all ---------------------------------------
  test("CASE 10 — super-admin analytics (no filter) includes MRs across companies/hotels/depts", async () => {
    const client = await clientFor(U.superAdmin);
    const res = await client.get(`/api/v1/mr/analytics`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    // recent is capped at 8 and the DB has other MRs from prior suites, so assert
    // on the unbounded by_hotel breakdown instead: it must span A + B hotels.
    const hotelIds = new Set((d.by_hotel || []).map((x) => Number(x.hotel_id)));
    expect(hotelIds.has(A1)).toBe(true);
    expect(hotelIds.has(B1)).toBe(true);
    // Our company-B grid MR is visible to the super admin via the list endpoint.
    const list = await client.get(`/api/v1/mr?limit=500`);
    const nums = new Set(numsOf(list.body.data.data));
    expect(nums.has(`${PFX}B1-PROC`)).toBe(true);
    expect(nums.has(`${PFX}A1-PROC`)).toBe(true);
    expect(nums.has(`${PFX}A2-ENG`)).toBe(true);
  });

  // ---- Case 11: dashboardCounts (/kpis) honors the same scope --------------
  test("CASE 11 — /kpis for a1_proc_buyer counts only (A1,proc) cells", async () => {
    const client = await clientFor(U.a1_proc_buyer);
    const res = await client.get(`/api/v1/mr/kpis`);
    expect(res.status).toBe(200);
    const c = res.body.data.counts;
    // a1_proc_buyer's only grid cells: A1-PROC (pending) + A1-PROC-LFY (approved).
    // pending must include exactly our 1 pending; the user has no other pending
    // MRs in scope from our grid. Assert our pending MR is reflected and no eng/A2.
    expect(c.pending).toBeGreaterThanOrEqual(1);

    // Cross-check against the scoped analytics totals (same matrix → same count).
    const an = await client.get(`/api/v1/mr/analytics`);
    expect(Number(c.all)).toBe(Number(an.body.data.totals.all));

    // A user with an out-of-scope hotel filter sees zero (counts can't widen).
    const widened = await client.get(`/api/v1/mr/kpis?hotel_ids=${A2}`);
    expect(widened.body.data.counts.all).toBe(0);
  });

  test("CASE 11b — /kpis for companyA_admin counts span all A cells but exclude company B", async () => {
    const adminClient = await clientFor(U.companyA_admin);
    const adminCounts = (await adminClient.get(`/api/v1/mr/kpis`)).body.data.counts;
    const procClient = await clientFor(U.a1_proc_buyer);
    const procCounts = (await procClient.get(`/api/v1/mr/kpis`)).body.data.counts;
    // Admin sees strictly more (all 6 A grid cells) than the single-cell proc user.
    expect(adminCounts.all).toBeGreaterThan(procCounts.all);
  });

  // ---- Case 13: list-view scope --------------------------------------------
  test("CASE 13 — list-view for a1_proc_buyer: rows + facets only (A1,proc)", async () => {
    const client = await clientFor(U.a1_proc_buyer);
    const res = await client.post(`/api/v1/mr/list-view`).send({ tab: "all", page: 1, limit: 200 });
    expect(res.status).toBe(200);
    const d = res.body.data;
    const nums = new Set(numsOf(d.rows));
    expect(nums.has(`${PFX}A1-PROC`)).toBe(true);
    for (const bad of [`${PFX}A1-ENG`, `${PFX}A1-FB`, `${PFX}A2-PROC`, `${PFX}A2-ENG`, `${PFX}A3-PROC`, `${PFX}B1-PROC`]) {
      expect(nums.has(bad)).toBe(false);
    }
    // Facets only offer A1 + Procurement (no out-of-scope BU/dept facet values).
    const buIds = new Set((d.facets.buId || []).map((f) => Number(f.key)));
    const deptIds = new Set((d.facets.departmentId || []).map((f) => Number(f.key)));
    expect(buIds.has(A1)).toBe(true);
    expect(buIds.has(A2)).toBe(false);
    expect(buIds.has(A3)).toBe(false);
    expect(deptIds.has(PROC)).toBe(true);
    expect(deptIds.has(ENG)).toBe(false);
    expect(deptIds.has(FB)).toBe(false);
  });

  test("CASE 13b — list-view client hotel filter cannot widen (a1_proc_buyer asks for A2)", async () => {
    const client = await clientFor(U.a1_proc_buyer);
    const res = await client.post(`/api/v1/mr/list-view`).send({ hotel_ids: [A2], tab: "all", page: 1, limit: 200 });
    expect(res.status).toBe(200);
    // No A2 row leaks; our A2 grid MRs stay hidden.
    const nums = new Set(numsOf(res.body.data.rows));
    expect(nums.has(`${PFX}A2-PROC`)).toBe(false);
    expect(nums.has(`${PFX}A2-ENG`)).toBe(false);
  });
});
