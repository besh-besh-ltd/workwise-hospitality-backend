// ARC v2 — authorization sweep: cross-tenant object reads + intra-company
// (cross-hotel / cross-department) listing scope.
//
// SECURITY MANDATE (mirrors mr.dashboard.scope.test.js):
//   1. Every per-ARC read endpoint derives scope from the ARC ROW (never from
//      a client-supplied id/hotel/company) and refuses a foreign tenant's id.
//   2. The listing surfaces (rows AND the buId facet AND tab_counts) are
//      filtered by the caller's 4-axis RBAC scope matrix in
//      tbl_user_role_scopes — NULL on an axis means "all" for that axis.
//      A facet that enumerates inaccessible hotels with exact counts is itself
//      a leak, so facets and counts are asserted alongside rows.
//   3. A client-supplied hotel_id / arc_id / company can NARROW within the
//      matrix but can NEVER widen it.
//   4. Legitimately-scoped access still returns 200 with data.
//
// Seeds a GRID of ARCs across (hotel × department) cells under Hospitality A
// plus one under Hospitality B, and three purpose-built users:
//   · SCOPED_A1_PROC  — one cell  (A1, proc)
//   · OFFDIAG         — two cells (A1, proc) + (A2, eng)   ← the sharp case
//   · SCOPED_B1       — foreign tenant (B1, proc)
// so every off-diagonal combination is directly observable.

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
const CAT = 215; // beverages (seeded reference category)

const PFX = "ARC-SCOPEAUTHZ-";

// Purpose-built users (8008x block — outside the fixture range 80001..80105).
const U_A1_PROC = 80081; // (A1, proc) only
const U_OFFDIAG = 80082; // (A1, proc) + (A2, eng)
const U_B1 = 80083;      // Hospitality B, (B1, proc)
const U_PROCESS = 80084; // (A1, proc) but BOUND to a specific approval process
const TEMP_USERS = [U_A1_PROC, U_OFFDIAG, U_B1, U_PROCESS];

// Role 2 = TENDER_CREATOR (any role works — the matrix, not the role, is what
// this suite asserts on).
const ROLE = 2;

// (key, hospitality, hotel, dept)
const GRID = [
  { key: "A1-PROC", hc: HC_A, hotel: A1, dept: PROC },
  { key: "A1-ENG", hc: HC_A, hotel: A1, dept: ENG },
  { key: "A1-FB", hc: HC_A, hotel: A1, dept: FB },
  { key: "A2-PROC", hc: HC_A, hotel: A2, dept: PROC },
  { key: "A2-ENG", hc: HC_A, hotel: A2, dept: ENG },
  { key: "A3-PROC", hc: HC_A, hotel: A3, dept: PROC },
  { key: "B1-PROC", hc: HC_B, hotel: B1, dept: PROC }, // foreign tenant
];

const arcIds = {}; // key → id

function numsOf(rows) {
  return (rows || [])
    .map((r) => r.arc_number)
    .filter((n) => typeof n === "string" && n.startsWith(PFX));
}

describe("ARC v2 — cross-tenant object reads + intra-company listing scope", () => {
  let cA1Proc;   // scoped (A1, proc)
  let cOffDiag;  // scoped (A1, proc) + (A2, eng)
  let cB1;       // scoped Hospitality B
  let cAdminA;   // company-wide A (NULL hotel, NULL dept)
  let cSuper;    // super admin

  beforeAll(async () => {
    // Buyer role gate (acl([2, 8])).
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [
      [IDS.users.companyA_admin, IDS.users.a1_proc_buyer],
    ]);
    await db.none(`UPDATE tbl_users SET user_type = 8 WHERE id = $1`, [IDS.users.superAdmin]);

    // --- purpose-built users -------------------------------------------------
    for (const uid of TEMP_USERS) {
      await db.none(
        `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
         VALUES ($1, $2, $3, 1, 2, $4, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [uid, `Scope User ${uid}`, `scope.${uid}@test.local`, IDS.companies.A]
      );
      await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [uid]);
    }

    // Hospitality mappings (company resolution reads this table).
    const MAPPINGS = [
      [U_A1_PROC, HC_A, A1],
      [U_OFFDIAG, HC_A, A1],
      [U_OFFDIAG, HC_A, A2],
      [U_B1, HC_B, B1],
      [U_PROCESS, HC_A, A1],
    ];
    for (const [uid, hc, hotel] of MAPPINGS) {
      await db.none(
        `INSERT INTO tbl_hospitality_user_mappings
           (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
         VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
        [uid, hc, hotel, IDS.users.superAdmin]
      );
    }

    // RBAC scope rows — the authoritative matrix.
    const SCOPES = [
      [U_A1_PROC, HC_A, A1, PROC],
      [U_OFFDIAG, HC_A, A1, PROC],
      [U_OFFDIAG, HC_A, A2, ENG],
      [U_B1, HC_B, B1, PROC],
    ];
    for (const [uid, hc, hotel, dept] of SCOPES) {
      await db.none(
        `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [uid, ROLE, hc, hotel, dept]
      );
    }
    // The fourth axis: a grant BOUND to one approval process. ARCs are
    // process-free by design (tbl_arc.process_id IS NULL), so under the
    // canonical strict semantics this grant must not reach them.
    await db.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [U_PROCESS, ROLE, HC_A, A1, PROC, IDS.processes.A_P1]
    );

    // --- ARC grid ------------------------------------------------------------
    for (const g of GRID) {
      const row = await db.one(
        `INSERT INTO tbl_arc
           (arc_number, title, category_id, hospitality_company_id, hotel_id,
            department_id, process_id, status,
            submission_start_at, submission_end_at, contract_start_at, contract_end_at,
            created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, 'floated',
                 NOW() - INTERVAL '1 day', NOW() + INTERVAL '7 days',
                 NOW() + INTERVAL '8 days', NOW() + INTERVAL '180 days',
                 $7, NOW(), NOW())
         RETURNING id`,
        [`${PFX}${g.key}`, `Scope grid ${g.key}`, CAT, g.hc, g.hotel, g.dept, IDS.users.superAdmin]
      );
      arcIds[g.key] = Number(row.id);
    }

    cA1Proc = await httpClient(U_A1_PROC);
    cOffDiag = await httpClient(U_OFFDIAG);
    cB1 = await httpClient(U_B1);
    cAdminA = await httpClient(IDS.users.companyA_admin);
    cSuper = await httpClient(IDS.users.superAdmin);
  });

  afterAll(async () => {
    const ids = Object.values(arcIds);
    if (ids.length) {
      await db.none(`DELETE FROM tbl_approval_instances WHERE entity_type = 'ARC_PUBLISH' AND entity_id = ANY($1::int[])`, [ids]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [ids]);
    }
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [TEMP_USERS]);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [TEMP_USERS]);
    await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [TEMP_USERS]);
  });

  // ==========================================================================
  // CROSS-TENANT (4 endpoints, foreign-tenant id must be refused)
  // ==========================================================================

  describe("cross-tenant object reads", () => {
    test("XT-1 — GET /:id/publish-approval refuses a foreign tenant's ARC", async () => {
      const res = await cB1.get(`/api/v1/arc-v2/${arcIds["A1-PROC"]}/publish-approval`);
      expect([403, 404]).toContain(res.status);
    });

    test("XT-1b — publish-approval is refused for an in-company but out-of-scope hotel", async () => {
      const res = await cA1Proc.get(`/api/v1/arc-v2/${arcIds["A2-PROC"]}/publish-approval`);
      expect([403, 404]).toContain(res.status);
    });

    test("XT-1c — publish-approval succeeds for an in-scope ARC (200)", async () => {
      const res = await cA1Proc.get(`/api/v1/arc-v2/${arcIds["A1-PROC"]}/publish-approval`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
    });

    test("XT-2 — GET /evaluation/:arcId/tech-eval/approval refuses a foreign tenant's ARC", async () => {
      const res = await cB1.get(`/api/v1/arc-v2/evaluation/${arcIds["A1-PROC"]}/tech-eval/approval`);
      expect([403, 404]).toContain(res.status);
    });

    test("XT-2b — tech-eval/approval refused for an in-company out-of-scope hotel", async () => {
      const res = await cA1Proc.get(`/api/v1/arc-v2/evaluation/${arcIds["A2-PROC"]}/tech-eval/approval`);
      expect([403, 404]).toContain(res.status);
    });

    test("XT-2c — tech-eval/approval succeeds for an in-scope ARC (200)", async () => {
      const res = await cA1Proc.get(`/api/v1/arc-v2/evaluation/${arcIds["A1-PROC"]}/tech-eval/approval`);
      expect(res.status).toBe(200);
    });

    test("XT-3 — GET /amendments?arc_id= refuses a foreign tenant's arc_id", async () => {
      const res = await cB1.get(`/api/v1/arc-v2/amendments?arc_id=${arcIds["A1-PROC"]}`);
      expect([403, 404]).toContain(res.status);
    });

    test("XT-3b — amendments refused for an in-company out-of-scope hotel", async () => {
      const res = await cA1Proc.get(`/api/v1/arc-v2/amendments?arc_id=${arcIds["A2-PROC"]}`);
      expect([403, 404]).toContain(res.status);
    });

    test("XT-3c — amendments succeeds for an in-scope ARC (200)", async () => {
      const res = await cA1Proc.get(`/api/v1/arc-v2/amendments?arc_id=${arcIds["A1-PROC"]}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.amendments)).toBe(true);
    });

    test("XT-4 — GET /eligible-vendors refuses a client-supplied out-of-scope hotel_id", async () => {
      const foreign = await cA1Proc.get(`/api/v1/arc-v2/eligible-vendors?category_id=${CAT}&hotel_id=${B1}`);
      expect([403, 404]).toContain(foreign.status);
      const otherBu = await cA1Proc.get(`/api/v1/arc-v2/eligible-vendors?category_id=${CAT}&hotel_id=${A2}`);
      expect([403, 404]).toContain(otherBu.status);
    });

    test("XT-4b — eligible-vendors succeeds for the caller's own hotel (200)", async () => {
      const res = await cA1Proc.get(`/api/v1/arc-v2/eligible-vendors?category_id=${CAT}&hotel_id=${A1}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.vendors)).toBe(true);
    });

    test("XT-5 — GET /:id (detail) stays refused cross-hotel inside the same company", async () => {
      const res = await cA1Proc.get(`/api/v1/arc-v2/${arcIds["A2-PROC"]}`);
      expect([403, 404]).toContain(res.status);
      const own = await cA1Proc.get(`/api/v1/arc-v2/${arcIds["A1-PROC"]}`);
      expect(own.status).toBe(200);
    });
  });

  // ==========================================================================
  // INTRA-COMPANY / CROSS-HOTEL LISTING SCOPE
  // ==========================================================================

  describe("listing scope — rows, buId facet, tab_counts", () => {
    test("L-1 — list-view rows for (A1,proc) contain only that cell", async () => {
      const res = await cA1Proc.post(`/api/v1/arc-v2/list-view`).send({ tab: "all", page: 1, limit: 200 });
      expect(res.status).toBe(200);
      const nums = new Set(numsOf(res.body.data.rows));
      expect(nums.has(`${PFX}A1-PROC`)).toBe(true);
      for (const bad of ["A1-ENG", "A1-FB", "A2-PROC", "A2-ENG", "A3-PROC", "B1-PROC"]) {
        expect(nums.has(`${PFX}${bad}`)).toBe(false);
      }
    });

    test("L-2 — the buId facet never enumerates an inaccessible hotel", async () => {
      const res = await cA1Proc.post(`/api/v1/arc-v2/list-view`).send({ tab: "all", page: 1, limit: 200 });
      const buIds = new Set((res.body.data.facets.buId || []).map((f) => Number(f.key)));
      expect(buIds.has(A1)).toBe(true);
      expect(buIds.has(A2)).toBe(false);
      expect(buIds.has(A3)).toBe(false);
      expect(buIds.has(B1)).toBe(false);
      // Department facet must not enumerate out-of-scope departments either.
      const deptIds = new Set((res.body.data.facets.departmentId || []).map((f) => Number(f.key)));
      expect(deptIds.has(PROC)).toBe(true);
      expect(deptIds.has(ENG)).toBe(false);
      expect(deptIds.has(FB)).toBe(false);
    });

    test("L-3 — tab_counts are consistent with the scoped row set", async () => {
      const res = await cA1Proc.post(`/api/v1/arc-v2/list-view`).send({ tab: "all", page: 1, limit: 200 });
      const d = res.body.data;
      // 'all' count must equal the number of rows the caller can actually see.
      expect(d.tab_counts.all).toBe(d.total);
      // The scoped user must never be counted for the 5 grid cells they cannot read.
      const adminRes = await cAdminA.post(`/api/v1/arc-v2/list-view`).send({ tab: "all", page: 1, limit: 500 });
      expect(adminRes.body.data.tab_counts.all).toBeGreaterThan(d.tab_counts.all);
    });

    test("L-4 — sharp off-diagonal: (A1,proc)+(A2,eng) sees exactly those two cells", async () => {
      const res = await cOffDiag.post(`/api/v1/arc-v2/list-view`).send({ tab: "all", page: 1, limit: 200 });
      expect(res.status).toBe(200);
      const nums = new Set(numsOf(res.body.data.rows));
      expect(nums.has(`${PFX}A1-PROC`)).toBe(true);
      expect(nums.has(`${PFX}A2-ENG`)).toBe(true);
      // The two off-diagonal cells (same hotels/depts, wrong pairing) stay hidden.
      expect(nums.has(`${PFX}A2-PROC`)).toBe(false);
      expect(nums.has(`${PFX}A1-ENG`)).toBe(false);
      expect(nums.has(`${PFX}A1-FB`)).toBe(false);
      expect(nums.has(`${PFX}A3-PROC`)).toBe(false);
      expect(nums.has(`${PFX}B1-PROC`)).toBe(false);
      // Facets follow the same matrix — both hotels appear (each via one cell).
      const buIds = new Set((res.body.data.facets.buId || []).map((f) => Number(f.key)));
      expect(buIds.has(A1)).toBe(true);
      expect(buIds.has(A2)).toBe(true);
      expect(buIds.has(A3)).toBe(false);
      expect(buIds.has(B1)).toBe(false);
    });

    test("L-5 — GET / (list) honours the same matrix", async () => {
      const res = await cA1Proc.get(`/api/v1/arc-v2?statusGroup=all&limit=200`);
      expect(res.status).toBe(200);
      const nums = new Set(numsOf(res.body.data.data));
      expect(nums.has(`${PFX}A1-PROC`)).toBe(true);
      for (const bad of ["A1-ENG", "A2-PROC", "A2-ENG", "A3-PROC", "B1-PROC"]) {
        expect(nums.has(`${PFX}${bad}`)).toBe(false);
      }
    });

    test("L-6 — a client-supplied hotel_ids cannot widen the list", async () => {
      const res = await cA1Proc.get(`/api/v1/arc-v2?statusGroup=all&limit=200&hotel_ids=${A2},${A3},${B1}`);
      expect(res.status).toBe(200);
      const nums = new Set(numsOf(res.body.data.data));
      // Intersection of {A1} (scope) with {A2,A3,B1} (filter) = ∅.
      expect(nums.size).toBe(0);
    });

    test("L-7 — /kpis counts are scoped (and a widened hotel filter yields zero)", async () => {
      const own = await cA1Proc.get(`/api/v1/arc-v2/kpis`);
      expect(own.status).toBe(200);
      const admin = await cAdminA.get(`/api/v1/arc-v2/kpis`);
      expect(admin.body.data.counts.all).toBeGreaterThan(own.body.data.counts.all);

      const widened = await cA1Proc.get(`/api/v1/arc-v2/kpis?hotel_ids=${A2}`);
      expect(widened.status).toBe(200);
      expect(widened.body.data.counts.all).toBe(0);
    });

    test("L-8 — /hotels lists only hotels inside the caller's scope matrix", async () => {
      const res = await cA1Proc.get(`/api/v1/arc-v2/hotels`);
      expect(res.status).toBe(200);
      const ids = new Set(res.body.data.hotels.map((h) => Number(h.id)));
      expect(ids.has(A1)).toBe(true);
      expect(ids.has(A2)).toBe(false);
      expect(ids.has(A3)).toBe(false);
      expect(ids.has(B1)).toBe(false);

      // Off-diagonal user gets exactly their two hotels.
      const off = await cOffDiag.get(`/api/v1/arc-v2/hotels`);
      const offIds = new Set(off.body.data.hotels.map((h) => Number(h.id)));
      expect(offIds.has(A1)).toBe(true);
      expect(offIds.has(A2)).toBe(true);
      expect(offIds.has(A3)).toBe(false);
      expect(offIds.has(B1)).toBe(false);
    });

    test("L-9 — /category-departments cannot enumerate departments outside the hotel scope", async () => {
      // The off-diagonal user is proc@A1 and eng@A2. Asked about hotel A1 they
      // must be offered Procurement only — never Engineering (that grant lives
      // at A2), which is what an unscoped company-wide answer would leak.
      const res = await cOffDiag.get(
        `/api/v1/arc-v2/category-departments?category_id=${CAT}&hotel_id=${A1}`
      );
      expect(res.status).toBe(200);
      const ids = new Set(res.body.data.departments.map((d) => Number(d.id)));
      expect(ids.has(ENG)).toBe(false);
    });

    test("L-10 — a spoofed hospitality_company_id cannot widen the list", async () => {
      const spoofed = await cA1Proc.get(`/api/v1/arc-v2?statusGroup=all&limit=200&hospitality_company_id=${HC_B}`);
      expect(spoofed.status).toBe(200);
      const nums = new Set(numsOf(spoofed.body.data.data));
      expect(nums.has(`${PFX}B1-PROC`)).toBe(false);
    });

    test("L-11 — company-wide admin sees every A cell but never company B", async () => {
      const res = await cAdminA.post(`/api/v1/arc-v2/list-view`).send({ tab: "all", page: 1, limit: 500 });
      expect(res.status).toBe(200);
      const nums = new Set(numsOf(res.body.data.rows));
      for (const ok of ["A1-PROC", "A1-ENG", "A1-FB", "A2-PROC", "A2-ENG", "A3-PROC"]) {
        expect(nums.has(`${PFX}${ok}`)).toBe(true);
      }
      expect(nums.has(`${PFX}B1-PROC`)).toBe(false);
      const buIds = new Set((res.body.data.facets.buId || []).map((f) => Number(f.key)));
      expect(buIds.has(B1)).toBe(false);
    });

    test("P-1 — the process axis is enforced: a process-bound grant does not reach a process-free ARC", async () => {
      const cProcess = await httpClient(U_PROCESS);
      const res = await cProcess.get(`/api/v1/arc-v2?statusGroup=all&limit=200`);
      expect(res.status).toBe(200);
      // Same company/hotel/department as U_A1_PROC — only the process axis differs.
      expect(new Set(numsOf(res.body.data.data)).has(`${PFX}A1-PROC`)).toBe(false);
      // …and the object-level gate agrees with the listing.
      const detail = await cProcess.get(`/api/v1/arc-v2/${arcIds["A1-PROC"]}`);
      expect([403, 404]).toContain(detail.status);
    });

    test("P-2 — …and it is NOT a deny-all: a process-NULL grant (100% of production rows) still matches", async () => {
      const res = await cA1Proc.get(`/api/v1/arc-v2?statusGroup=all&limit=200`);
      expect(res.status).toBe(200);
      expect(new Set(numsOf(res.body.data.data)).has(`${PFX}A1-PROC`)).toBe(true);
    });

    test("L-12 — super admin still sees across companies (no regression)", async () => {
      const res = await cSuper.post(`/api/v1/arc-v2/list-view`).send({ tab: "all", page: 1, limit: 500 });
      expect(res.status).toBe(200);
      const nums = new Set(numsOf(res.body.data.rows));
      expect(nums.has(`${PFX}A1-PROC`)).toBe(true);
      expect(nums.has(`${PFX}B1-PROC`)).toBe(true);
    });
  });
});
