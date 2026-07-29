// Financial Year filter — product-level HTTP tests.
//
// Covers spec §4.1 tests 1-10 for all three modules:
//   RFQ  → POST /api/v1/rfq/list-view    (creation field: r.timestamp)
//   ARC  → POST /api/v1/arc-v2/list-view  (creation field: r.created_at)
//   MR   → POST /api/v1/mr/list-view      (creation field: r.created_at)
//
// Pattern B (commit + cleanup): these controllers query db directly (no txContext).
// All inserted IDs are tracked and deleted in afterEach, never by date range.
//
// Timezone note: timestamps are inserted without TZ (server-local) so they are
// consistent with the server's `new Date("YYYY-MM-DDT00:00:00").getTime()` math.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { makeRFQ } from "../factories/rfq.js";

// ─── Shared fixture constants ────────────────────────────────────────────────
const HC    = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT  = IDS.departments.proc;
const PROC  = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer;
const CAT   = TEST_CATEGORIES.beverages;

// Calendar dates used across all three modules.
// FY 2025-26: 2025-04-01 → 2026-03-31
// FY 2026-27: 2026-04-01 → 2027-03-31
const D_IN_FY2526     = "2025-06-15";   // inside FY 2025-26 (excluded by 2026-27 filter)
const D_LOWER_BOUND   = "2026-04-01";   // first day FY 2026-27 (lower-boundary inclusive)
const D_UPPER_BOUND   = "2027-03-31";   // last  day FY 2026-27 (upper-boundary inclusive)
const D_UPPER_TIME    = "2027-03-31T23:30:00"; // late that same day — whole-day test
const D_JUST_OUTSIDE  = "2027-04-01";   // first day FY 2027-28 (excluded)
const D_EMPTY_FY_FROM = "2024-04-01";   // FY 2024-25 — no records seeded there
const D_EMPTY_FY_TO   = "2025-03-31";

// ─────────────────────────────────────────────────────────────────────────────
// RFQ MODULE
// ─────────────────────────────────────────────────────────────────────────────
describe("RFQ list-view — FY date filter (§4.1)", () => {
  let client;
  const insertedRfqIds = [];

  beforeAll(async () => {
    // The ACL gate on POST /rfq/list-view checks user_type. Set buyer to 2.
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    client = await httpClient(BUYER);
  });

  // Insert four RFQs with specific timestamps using the extended makeRFQ factory.
  // Each test tracks its own IDs and cleans up in afterEach.
  // We use a shared beforeEach+afterEach pair per suite; the IDs array is reset
  // between tests via afterEach.

  afterEach(async () => {
    if (insertedRfqIds.length) {
      await db.none(
        `DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`,
        [insertedRfqIds]
      );
      insertedRfqIds.length = 0;
    }
  });

  // Helper: create RFQ with a specific timestamp (ISO string).
  // Returns the id as a Number (pg-promise returns BIGSERIAL as string; we
  // normalise here so toContain comparisons against rowIds() are consistent).
  async function seedRfq(isoTs) {
    const { rfq_id } = await makeRFQ(db, {
      createdBy: BUYER,
      hospitality: HC,
      hotel: HOTEL,
      timestamp: isoTs,
    });
    const id = Number(rfq_id);
    insertedRfqIds.push(id);
    return id;
  }

  // Seed the standard 4-record set for FY window tests and return their IDs.
  async function seedFySet() {
    const r2526   = await seedRfq(`${D_IN_FY2526}T12:00:00`);
    const rLower  = await seedRfq(`${D_LOWER_BOUND}T00:00:00`);
    const rUpper  = await seedRfq(`${D_UPPER_BOUND}T12:00:00`);
    const rOut    = await seedRfq(`${D_JUST_OUTSIDE}T00:00:00`);
    return { r2526, rLower, rUpper, rOut };
  }

  function rowIds(res) {
    return res.body.data.rows.map((r) => Number(r.id));
  }

  test("§4.1-1 FY window returns only in-range rows", async () => {
    const { r2526, rLower, rUpper, rOut } = await seedFySet();

    const res = await client.post("/api/v1/rfq/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const ids = rowIds(res);
    expect(ids).toContain(rLower);
    expect(ids).toContain(rUpper);
    expect(ids).not.toContain(r2526);
    expect(ids).not.toContain(rOut);
  });

  test("§4.1-2 lower boundary inclusive (2026-04-01 00:00 IS included)", async () => {
    const rLower = await seedRfq(`${D_LOWER_BOUND}T00:00:00`);

    const res = await client.post("/api/v1/rfq/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
    });
    expect(res.status).toBe(200);
    expect(rowIds(res)).toContain(rLower);
  });

  test("§4.1-3 upper boundary inclusive of whole day (2027-03-31 23:30 IS included)", async () => {
    const rLateNight = await seedRfq(D_UPPER_TIME);

    const res = await client.post("/api/v1/rfq/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
    });
    expect(res.status).toBe(200);
    expect(rowIds(res)).toContain(rLateNight);
  });

  test("§4.1-4 just-outside excluded (2027-04-01 00:00 is NOT included)", async () => {
    const rOut = await seedRfq(`${D_JUST_OUTSIDE}T00:00:00`);

    const res = await client.post("/api/v1/rfq/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
    });
    expect(res.status).toBe(200);
    expect(rowIds(res)).not.toContain(rOut);
  });

  test("§4.1-5a open-ended lower bound only (dateFrom with no dateTo)", async () => {
    const { r2526, rLower, rUpper, rOut } = await seedFySet();

    const res = await client.post("/api/v1/rfq/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND },
    });
    expect(res.status).toBe(200);
    const ids = rowIds(res);
    expect(ids).toContain(rLower);
    expect(ids).toContain(rUpper);
    expect(ids).toContain(rOut);
    expect(ids).not.toContain(r2526);
  });

  test("§4.1-5b open-ended upper bound only (dateTo with no dateFrom)", async () => {
    const { r2526, rLower, rOut } = await seedFySet();

    const res = await client.post("/api/v1/rfq/list-view").send({
      filters: { dateTo: "2026-03-31" },
    });
    expect(res.status).toBe(200);
    const ids = rowIds(res);
    expect(ids).toContain(r2526);
    expect(ids).not.toContain(rLower);
    expect(ids).not.toContain(rOut);
  });

  test("§4.1-6 no-filter parity — omitting dates returns same total as no-filters at all", async () => {
    const { r2526, rLower, rUpper, rOut } = await seedFySet();

    const [resNoFilter, resEmptyDates] = await Promise.all([
      client.post("/api/v1/rfq/list-view").send({}),
      client.post("/api/v1/rfq/list-view").send({ filters: { dateFrom: "", dateTo: "" } }),
    ]);
    expect(resNoFilter.status).toBe(200);
    expect(resEmptyDates.status).toBe(200);
    expect(resEmptyDates.body.data.total).toBe(resNoFilter.body.data.total);
  });

  test("§4.1-7 empty-range result — FY with no records returns total 0", async () => {
    // Seed records only in FY 2026-27; query FY 2024-25.
    await seedRfq(`${D_LOWER_BOUND}T10:00:00`);

    const res = await client.post("/api/v1/rfq/list-view").send({
      filters: { dateFrom: D_EMPTY_FY_FROM, dateTo: D_EMPTY_FY_TO },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.rows).toEqual([]);
    // facets and tab_counts must still be present
    expect(res.body.data.facets).toBeDefined();
    expect(res.body.data.tab_counts).toBeDefined();
  });

  test("§4.1-8 facets unchanged by date window", async () => {
    await seedFySet();

    const [resAll, resDated] = await Promise.all([
      client.post("/api/v1/rfq/list-view").send({ tab: "all" }),
      client.post("/api/v1/rfq/list-view").send({
        tab: "all",
        filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
      }),
    ]);
    expect(resAll.status).toBe(200);
    expect(resDated.status).toBe(200);
    // Facet maps must be identical (same tab scope, only filtered changes).
    const facetsAll   = resAll.body.data.facets;
    const facetsDated = resDated.body.data.facets;
    expect(facetsDated).toEqual(facetsAll);
  });

  test("§4.1-9 malformed input ignored — garbage dateFrom acts as no-filter", async () => {
    await seedRfq(`${D_LOWER_BOUND}T10:00:00`);

    const [resGarbage, res13, resNumber, resNoFilter] = await Promise.all([
      client.post("/api/v1/rfq/list-view").send({ filters: { dateFrom: "garbage" } }),
      client.post("/api/v1/rfq/list-view").send({ filters: { dateFrom: "2026-13-40" } }),
      client.post("/api/v1/rfq/list-view").send({ filters: { dateFrom: 20260401 } }),
      client.post("/api/v1/rfq/list-view").send({}),
    ]);
    expect(resGarbage.status).toBe(200);
    expect(res13.status).toBe(200);
    expect(resNumber.status).toBe(200);
    // All malformed variants should yield the same total as no filter
    expect(resGarbage.body.data.total).toBe(resNoFilter.body.data.total);
    expect(res13.body.data.total).toBe(resNoFilter.body.data.total);
    expect(resNumber.body.data.total).toBe(resNoFilter.body.data.total);
  });

  test("§4.1-10 AND with another facet (buId + dateFrom/dateTo = intersection)", async () => {
    // Seed one RFQ in FY 2026-27 on hotel A1 and one in FY 2025-26 on hotel A2.
    const rA1FY27 = await seedRfq(`${D_LOWER_BOUND}T10:00:00`);
    const rA2FY26Id = await (async () => {
      const { rfq_id } = await makeRFQ(db, {
        createdBy: BUYER,
        hospitality: HC,
        hotel: IDS.hotels.A2,
        timestamp: `${D_IN_FY2526}T10:00:00`,
      });
      const id = Number(rfq_id);
      insertedRfqIds.push(id);
      return id;
    })();

    const res = await client.post("/api/v1/rfq/list-view").send({
      filters: {
        dateFrom: D_LOWER_BOUND,
        dateTo: D_UPPER_BOUND,
        buId: [String(HOTEL)],
      },
    });
    expect(res.status).toBe(200);
    const ids = rowIds(res);
    expect(ids).toContain(rA1FY27);
    expect(ids).not.toContain(rA2FY26Id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ARC MODULE
// ─────────────────────────────────────────────────────────────────────────────
describe("ARC list-view — FY date filter (§4.1)", () => {
  let client;
  const insertedArcIds = [];

  // Monotonic suffix to make arc_number unique across test runs.
  let arcSeq = 0;
  function nextArcNumber() {
    return `ARC-FYTEST-${Date.now()}-${++arcSeq}`;
  }

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    client = await httpClient(BUYER);
  });

  afterEach(async () => {
    if (insertedArcIds.length) {
      await db.none(
        `DELETE FROM tbl_arc WHERE id = ANY($1::int[])`,
        [insertedArcIds]
      );
      insertedArcIds.length = 0;
    }
  });

  async function seedArc(isoTs) {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9::timestamptz, $9::timestamptz)
       RETURNING id`,
      [
        nextArcNumber(),
        "FY Filter Test ARC",
        CAT,
        HC,
        HOTEL,
        DEPT,
        PROC,
        BUYER,
        isoTs,
      ]
    );
    const id = Number(arc.id);
    insertedArcIds.push(id);
    return id;
  }

  async function seedFySet() {
    const a2526  = await seedArc(`${D_IN_FY2526}T12:00:00`);
    const aLower = await seedArc(`${D_LOWER_BOUND}T00:00:00`);
    const aUpper = await seedArc(`${D_UPPER_BOUND}T12:00:00`);
    const aOut   = await seedArc(`${D_JUST_OUTSIDE}T00:00:00`);
    return { a2526, aLower, aUpper, aOut };
  }

  function rowIds(res) {
    return res.body.data.rows.map((r) => Number(r.id));
  }

  test("§4.1-1 FY window returns only in-range rows", async () => {
    const { a2526, aLower, aUpper, aOut } = await seedFySet();

    const res = await client.post("/api/v1/arc-v2/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const ids = rowIds(res);
    expect(ids).toContain(aLower);
    expect(ids).toContain(aUpper);
    expect(ids).not.toContain(a2526);
    expect(ids).not.toContain(aOut);
  });

  test("§4.1-2 lower boundary inclusive (2026-04-01 00:00 IS included)", async () => {
    const aLower = await seedArc(`${D_LOWER_BOUND}T00:00:00`);

    const res = await client.post("/api/v1/arc-v2/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
    });
    expect(res.status).toBe(200);
    expect(rowIds(res)).toContain(aLower);
  });

  test("§4.1-3 upper boundary inclusive of whole day (2027-03-31 23:30 IS included)", async () => {
    const aLate = await seedArc(D_UPPER_TIME);

    const res = await client.post("/api/v1/arc-v2/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
    });
    expect(res.status).toBe(200);
    expect(rowIds(res)).toContain(aLate);
  });

  test("§4.1-4 just-outside excluded (2027-04-01 00:00 is NOT included)", async () => {
    const aOut = await seedArc(`${D_JUST_OUTSIDE}T00:00:00`);

    const res = await client.post("/api/v1/arc-v2/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
    });
    expect(res.status).toBe(200);
    expect(rowIds(res)).not.toContain(aOut);
  });

  test("§4.1-5a open-ended lower bound only", async () => {
    const { a2526, aLower, aUpper, aOut } = await seedFySet();

    const res = await client.post("/api/v1/arc-v2/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND },
    });
    expect(res.status).toBe(200);
    const ids = rowIds(res);
    expect(ids).toContain(aLower);
    expect(ids).toContain(aUpper);
    expect(ids).toContain(aOut);
    expect(ids).not.toContain(a2526);
  });

  test("§4.1-5b open-ended upper bound only", async () => {
    const { a2526, aLower } = await seedFySet();

    const res = await client.post("/api/v1/arc-v2/list-view").send({
      filters: { dateTo: "2026-03-31" },
    });
    expect(res.status).toBe(200);
    const ids = rowIds(res);
    expect(ids).toContain(a2526);
    expect(ids).not.toContain(aLower);
  });

  test("§4.1-6 no-filter parity", async () => {
    await seedFySet();

    const [resNoFilter, resEmptyDates] = await Promise.all([
      client.post("/api/v1/arc-v2/list-view").send({}),
      client.post("/api/v1/arc-v2/list-view").send({ filters: { dateFrom: "", dateTo: "" } }),
    ]);
    expect(resNoFilter.status).toBe(200);
    expect(resEmptyDates.status).toBe(200);
    expect(resEmptyDates.body.data.total).toBe(resNoFilter.body.data.total);
  });

  test("§4.1-7 empty-range result — FY with no records returns total 0, rows []", async () => {
    await seedArc(`${D_LOWER_BOUND}T10:00:00`);

    const res = await client.post("/api/v1/arc-v2/list-view").send({
      filters: { dateFrom: D_EMPTY_FY_FROM, dateTo: D_EMPTY_FY_TO },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.rows).toEqual([]);
    expect(res.body.data.facets).toBeDefined();
    expect(res.body.data.tab_counts).toBeDefined();
  });

  test("§4.1-8 facets unchanged by date window", async () => {
    await seedFySet();

    const [resAll, resDated] = await Promise.all([
      client.post("/api/v1/arc-v2/list-view").send({ tab: "all" }),
      client.post("/api/v1/arc-v2/list-view").send({
        tab: "all",
        filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
      }),
    ]);
    expect(resAll.status).toBe(200);
    expect(resDated.status).toBe(200);
    expect(resDated.body.data.facets).toEqual(resAll.body.data.facets);
  });

  test("§4.1-9 malformed input ignored — acts as no-filter", async () => {
    await seedArc(`${D_LOWER_BOUND}T10:00:00`);

    const [resGarbage, res13, resNumber, resNoFilter] = await Promise.all([
      client.post("/api/v1/arc-v2/list-view").send({ filters: { dateFrom: "garbage" } }),
      client.post("/api/v1/arc-v2/list-view").send({ filters: { dateFrom: "2026-13-40" } }),
      client.post("/api/v1/arc-v2/list-view").send({ filters: { dateFrom: 20260401 } }),
      client.post("/api/v1/arc-v2/list-view").send({}),
    ]);
    expect(resGarbage.status).toBe(200);
    expect(res13.status).toBe(200);
    expect(resNumber.status).toBe(200);
    expect(resGarbage.body.data.total).toBe(resNoFilter.body.data.total);
    expect(res13.body.data.total).toBe(resNoFilter.body.data.total);
    expect(resNumber.body.data.total).toBe(resNoFilter.body.data.total);
  });

  test("§4.1-10 AND with another facet (departmentId + dateFrom/dateTo = intersection)", async () => {
    // One ARC in FY 2026-27 under DEPT, one in FY 2025-26 under DEPT.
    const aIn  = await seedArc(`${D_LOWER_BOUND}T10:00:00`);
    const aOut = await seedArc(`${D_IN_FY2526}T10:00:00`);

    const res = await client.post("/api/v1/arc-v2/list-view").send({
      filters: {
        dateFrom: D_LOWER_BOUND,
        dateTo: D_UPPER_BOUND,
        departmentId: [String(DEPT)],
      },
    });
    expect(res.status).toBe(200);
    const ids = rowIds(res);
    expect(ids).toContain(aIn);
    expect(ids).not.toContain(aOut);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MR MODULE
// ─────────────────────────────────────────────────────────────────────────────
describe("MR list-view — FY date filter (§4.1)", () => {
  let client;
  const insertedMrIds = [];

  let mrSeq = 0;
  function nextMrNumber() {
    return `MR-FYTEST-${Date.now()}-${++mrSeq}`;
  }

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    client = await httpClient(BUYER);
  });

  afterEach(async () => {
    if (insertedMrIds.length) {
      await db.none(
        `DELETE FROM tbl_material_requisition WHERE id = ANY($1::int[])`,
        [insertedMrIds]
      );
      insertedMrIds.length = 0;
    }
  });

  async function seedMr(isoTs) {
    const mr = await db.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id,
          raised_by, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7::timestamptz, $7::timestamptz)
       RETURNING id`,
      [
        nextMrNumber(),
        "FY Filter Test MR",
        HC,
        HOTEL,
        DEPT,
        BUYER,
        isoTs,
      ]
    );
    const id = Number(mr.id);
    insertedMrIds.push(id);
    return id;
  }

  async function seedFySet() {
    const m2526  = await seedMr(`${D_IN_FY2526}T12:00:00`);
    const mLower = await seedMr(`${D_LOWER_BOUND}T00:00:00`);
    const mUpper = await seedMr(`${D_UPPER_BOUND}T12:00:00`);
    const mOut   = await seedMr(`${D_JUST_OUTSIDE}T00:00:00`);
    return { m2526, mLower, mUpper, mOut };
  }

  function rowIds(res) {
    return res.body.data.rows.map((r) => Number(r.id));
  }

  test("§4.1-1 FY window returns only in-range rows", async () => {
    const { m2526, mLower, mUpper, mOut } = await seedFySet();

    const res = await client.post("/api/v1/mr/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const ids = rowIds(res);
    expect(ids).toContain(mLower);
    expect(ids).toContain(mUpper);
    expect(ids).not.toContain(m2526);
    expect(ids).not.toContain(mOut);
  });

  test("§4.1-2 lower boundary inclusive (2026-04-01 00:00 IS included)", async () => {
    const mLower = await seedMr(`${D_LOWER_BOUND}T00:00:00`);

    const res = await client.post("/api/v1/mr/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
    });
    expect(res.status).toBe(200);
    expect(rowIds(res)).toContain(mLower);
  });

  test("§4.1-3 upper boundary inclusive of whole day (2027-03-31 23:30 IS included)", async () => {
    const mLate = await seedMr(D_UPPER_TIME);

    const res = await client.post("/api/v1/mr/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
    });
    expect(res.status).toBe(200);
    expect(rowIds(res)).toContain(mLate);
  });

  test("§4.1-4 just-outside excluded (2027-04-01 00:00 is NOT included)", async () => {
    const mOut = await seedMr(`${D_JUST_OUTSIDE}T00:00:00`);

    const res = await client.post("/api/v1/mr/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
    });
    expect(res.status).toBe(200);
    expect(rowIds(res)).not.toContain(mOut);
  });

  test("§4.1-5a open-ended lower bound only", async () => {
    const { m2526, mLower, mUpper, mOut } = await seedFySet();

    const res = await client.post("/api/v1/mr/list-view").send({
      filters: { dateFrom: D_LOWER_BOUND },
    });
    expect(res.status).toBe(200);
    const ids = rowIds(res);
    expect(ids).toContain(mLower);
    expect(ids).toContain(mUpper);
    expect(ids).toContain(mOut);
    expect(ids).not.toContain(m2526);
  });

  test("§4.1-5b open-ended upper bound only", async () => {
    const { m2526, mLower } = await seedFySet();

    const res = await client.post("/api/v1/mr/list-view").send({
      filters: { dateTo: "2026-03-31" },
    });
    expect(res.status).toBe(200);
    const ids = rowIds(res);
    expect(ids).toContain(m2526);
    expect(ids).not.toContain(mLower);
  });

  test("§4.1-6 no-filter parity", async () => {
    await seedFySet();

    const [resNoFilter, resEmptyDates] = await Promise.all([
      client.post("/api/v1/mr/list-view").send({}),
      client.post("/api/v1/mr/list-view").send({ filters: { dateFrom: "", dateTo: "" } }),
    ]);
    expect(resNoFilter.status).toBe(200);
    expect(resEmptyDates.status).toBe(200);
    expect(resEmptyDates.body.data.total).toBe(resNoFilter.body.data.total);
  });

  test("§4.1-7 empty-range result — FY with no records returns total 0, rows []", async () => {
    await seedMr(`${D_LOWER_BOUND}T10:00:00`);

    const res = await client.post("/api/v1/mr/list-view").send({
      filters: { dateFrom: D_EMPTY_FY_FROM, dateTo: D_EMPTY_FY_TO },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.rows).toEqual([]);
    expect(res.body.data.facets).toBeDefined();
    expect(res.body.data.tab_counts).toBeDefined();
  });

  test("§4.1-8 facets unchanged by date window", async () => {
    await seedFySet();

    const [resAll, resDated] = await Promise.all([
      client.post("/api/v1/mr/list-view").send({ tab: "all" }),
      client.post("/api/v1/mr/list-view").send({
        tab: "all",
        filters: { dateFrom: D_LOWER_BOUND, dateTo: D_UPPER_BOUND },
      }),
    ]);
    expect(resAll.status).toBe(200);
    expect(resDated.status).toBe(200);
    expect(resDated.body.data.facets).toEqual(resAll.body.data.facets);
  });

  test("§4.1-9 malformed input ignored — acts as no-filter", async () => {
    await seedMr(`${D_LOWER_BOUND}T10:00:00`);

    const [resGarbage, res13, resNumber, resNoFilter] = await Promise.all([
      client.post("/api/v1/mr/list-view").send({ filters: { dateFrom: "garbage" } }),
      client.post("/api/v1/mr/list-view").send({ filters: { dateFrom: "2026-13-40" } }),
      client.post("/api/v1/mr/list-view").send({ filters: { dateFrom: 20260401 } }),
      client.post("/api/v1/mr/list-view").send({}),
    ]);
    expect(resGarbage.status).toBe(200);
    expect(res13.status).toBe(200);
    expect(resNumber.status).toBe(200);
    expect(resGarbage.body.data.total).toBe(resNoFilter.body.data.total);
    expect(res13.body.data.total).toBe(resNoFilter.body.data.total);
    expect(resNumber.body.data.total).toBe(resNoFilter.body.data.total);
  });

  test("§4.1-10 AND with another facet (buId + dateFrom/dateTo = intersection)", async () => {
    const mIn  = await seedMr(`${D_LOWER_BOUND}T10:00:00`);
    // Seed one outside the date window so there's a contrast.
    const mOutOfRange = await seedMr(`${D_IN_FY2526}T10:00:00`);

    const res = await client.post("/api/v1/mr/list-view").send({
      filters: {
        dateFrom: D_LOWER_BOUND,
        dateTo: D_UPPER_BOUND,
        buId: [String(HOTEL)],
      },
    });
    expect(res.status).toBe(200);
    const ids = rowIds(res);
    expect(ids).toContain(mIn);
    expect(ids).not.toContain(mOutOfRange);
  });
});
