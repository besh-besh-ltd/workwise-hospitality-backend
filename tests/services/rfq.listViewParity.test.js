// POST /rfq/list-view: the slim/heavy split returns byte-identical payloads
// (portal perf plan 2026-10, item 1.3).
//
// The listing used to call getAllBuyerRfq(1000, ...) — ~50 correlated
// subqueries for EVERY scoped RFQ — and then paginate to 20 in JS: 32% of all
// prod DB time, 4.1 s for a wide-scope user. It now reads a slim scoped set
// for tabs / buckets / facets / counts / sorting, and computes the heavy
// per-card columns (flags, vendors json, counts, can_edit) for the visible
// page only.
//
// Oracle: tests/helpers/legacy/rfqListViewLegacy.js, the pre-split controller
// verbatim. It runs on the LIVE getAllBuyerRfq (left untouched for its other
// callers), so this suite also fails if the two visibility predicates ever
// drift apart.
//
// The matrix crosses 12 users of very different RBAC shape with every tab x
// sort, then layers pages / page sizes / every facet filter (values taken
// from the response's own facets) / search / hotel selection / date windows on
// top. Every comparison is a deep equality of the complete response body.
// A coverage block at the end proves the world actually exercised every flag
// and branch on both sides, so "equal" cannot mean "both empty".

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { seedPerfWorld } from "../helpers/perfParityWorld.js";
import { getRfqListViewLegacy } from "../helpers/legacy/rfqListViewLegacy.js";

let world;
const clients = new Map();
let separatedTies = [];

beforeAll(async () => {
  world = await seedPerfWorld(db);
  // The listing sorts on tbl_rfq.timestamp, and the OLD query had no
  // tie-break: for equal timestamps its order was whatever the plan emitted
  // (on prod, the backward idx_rfq_timestamp scan, which the new query
  // reproduces with `ctid DESC`; on this tiny test table, a quicksort). The
  // world's own RFQs have distinct timestamps, but suites that ran earlier in
  // this worker can leave committed RFQs created in one transaction, i.e. with
  // identical now(). Where the old order is undefined there is nothing to be
  // equal to, so those leftovers are pulled 1 ms apart for the duration of
  // this suite and restored afterwards.
  separatedTies = await db.any(
    `WITH ties AS (
       SELECT id, "timestamp",
              ROW_NUMBER() OVER (PARTITION BY "timestamp" ORDER BY id) - 1 AS k,
              COUNT(*) OVER (PARTITION BY "timestamp") AS n
         FROM tbl_rfq
     )
     UPDATE tbl_rfq r SET "timestamp" = r."timestamp" + (t.k * interval '1 millisecond')
       FROM ties t
      WHERE t.id = r.id AND t.n > 1 AND t.k > 0
     RETURNING r.id, t.k`
  );
  // eslint-disable-next-line no-console
  if (separatedTies.length) console.log(`[list-view parity] separated ${separatedTies.length} tied leftover timestamps`);
}, 180000);

afterAll(async () => {
  for (const { id, k } of separatedTies) {
    await db.none(`UPDATE tbl_rfq SET "timestamp" = "timestamp" - ($2 * interval '1 millisecond') WHERE id = $1`, [id, k]);
  }
  if (world) await world.cleanup();
  await closeDb();
});

const TABS = ["all", "pending", "drafts", "approval", "ongoing", "approved", "closed"];
const SORTS = ["recent", "oldest", "deadline"];

async function viaHttp(userId, body) {
  if (!clients.has(userId)) clients.set(userId, await httpClient(userId));
  const res = await clients.get(userId).post("/api/v1/rfq/list-view").send(body);
  expect(res.status).toBe(200);
  return res.body;
}

async function viaOracle(userId, body) {
  let payload;
  const res = {
    status() { return this; },
    json(p) { payload = p; return this; },
  };
  await getRfqListViewLegacy({ user: { id: userId }, body }, res);
  return JSON.parse(JSON.stringify(payload));
}

const coverage = {
  calls: 0, rows: 0, nonEmptyPending: 0,
  flags: { has_dead_end_product: new Set(), has_tech_stuck_product: new Set(), has_tech_unstartable_product: new Set(),
           po_completed: new Set(), can_edit: new Set(), is_finalized: new Set(), is_quotes_present: new Set(), can_approve: new Set() },
  buckets: new Set(), poRejection: 0, invited: 0, submitted: 0, unseen: 0, vendorFallback: 0, statusKeys: new Set(),
};

function record(body) {
  coverage.calls++;
  const d = body.data;
  if (!d || !Array.isArray(d.rows)) return;
  if (d.tab_counts && d.tab_counts.pending > 0) coverage.nonEmptyPending++;
  for (const r of d.rows) {
    coverage.rows++;
    for (const f of Object.keys(coverage.flags)) coverage.flags[f].add(String(r[f]));
    coverage.buckets.add(r.bucket);
    coverage.statusKeys.add(r.status_key);
    if (r.po_rejection) coverage.poRejection++;
    if (r.invited_count > 0) coverage.invited++;
    if (r.submitted_count > 0) coverage.submitted++;
    if (Number(r.unseen_query_count) > 0) coverage.unseen++;
    if (r.vendors.some((v) => /^Vendor \d+$/.test(v.name))) coverage.vendorFallback++;
  }
}

async function expectParity(userId, body, label) {
  const [fresh, old] = await Promise.all([viaHttp(userId, body), viaOracle(userId, body)]);
  try {
    expect(fresh).toEqual(old);
  } catch (e) {
    e.message = `user=${userId} body=${JSON.stringify(body)} ${label || ""}\n${e.message}`;
    throw e;
  }
  record(fresh);
  return fresh;
}

function users() {
  return [
    ...Object.values(world.users),
    IDS.users.a1_proc_buyer, IDS.users.companyA_admin, IDS.users.crossCompany,
    IDS.users.multiHotel, IDS.users.a1_eng_buyer, IDS.users.a1_proc_poApp,
  ];
}

describe("list-view parity with the pre-split implementation", () => {
  it("every user x tab x sort (page 1, default limit)", async () => {
    for (const u of users()) {
      for (const tab of TABS) {
        for (const sort of SORTS) {
          await expectParity(u, { tab, sort });
        }
      }
    }
  }, 300000);

  it("pagination: later pages, small and large page sizes, past the end", async () => {
    for (const u of [world.users.wide, world.users.hotel, IDS.users.companyA_admin, IDS.users.crossCompany]) {
      for (const tab of ["all", "ongoing", "pending"]) {
        for (const [page, limit] of [[1, 5], [2, 5], [3, 5], [2, 20], [1, 100], [1, 500], [50, 20], [0, 0], ["2", "7"]]) {
          await expectParity(u, { tab, sort: "recent", page, limit });
          await expectParity(u, { tab, sort: "deadline", page, limit });
        }
      }
    }
  }, 300000);

  it("every facet filter, single and multi-valued, plus combinations", async () => {
    for (const u of [world.users.wide, world.users.hotel, world.users.process, IDS.users.companyA_admin, IDS.users.crossCompany]) {
      for (const tab of ["all", "ongoing", "drafts"]) {
        const base = await expectParity(u, { tab });
        const facets = base.data.facets;
        const keys = (f) => facets[f].map((x) => x.key);
        for (const f of ["status", "buId", "categoryId", "departmentId", "productId", "vendorId"]) {
          const k = keys(f);
          if (!k.length) continue;
          await expectParity(u, { tab, filters: { [f]: [k[0]] } }, f);
          await expectParity(u, { tab, filters: { [f]: k.slice(-2) } }, f);
          await expectParity(u, { tab, sort: "oldest", page: 2, limit: 3, filters: { [f]: k.slice(0, 3) } }, f);
        }
        await expectParity(u, {
          tab,
          filters: { buId: keys("buId").slice(0, 1), vendorId: keys("vendorId").slice(0, 3), categoryId: keys("categoryId").slice(0, 4) },
        });
        await expectParity(u, { tab, filters: { productId: ["999999999"], status: ["NOPE"] } });
        // non-array / junk filter values are ignored identically
        await expectParity(u, { tab, filters: { status: "DRAFT", buId: null, vendorId: [1, "x"] } });
      }
    }
  }, 300000);

  it("search, hotel selection and creation-date windows", async () => {
    const day = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
    const someRfqNo = (await db.one(`SELECT rfq_no FROM tbl_rfq WHERE id = $1`, [world.rfqIds[5]])).rfq_no;
    const bodies = [
      { search: "Beverage" }, { search: "linen" }, { search: String(someRfqNo) }, { search: "1" },
      { search: "%" }, { search: "  " }, { search_val: "Kitchen" }, { search: "zzzz-nothing" },
      { hotel_ids: [IDS.hotels.A1] }, { hotel_ids: [IDS.hotels.A2, IDS.hotels.A3] }, { hotel_ids: [IDS.hotels.B1, IDS.hotels.B2] },
      { hotel_ids: [] }, { hotel_ids: ["abc"] }, { hotel_ids: String(IDS.hotels.A1) },
      { filters: { dateFrom: day(-120), dateTo: day(0) } }, { filters: { dateFrom: "2025-04-01", dateTo: "2026-03-31" } },
      { filters: { dateFrom: day(-30) } }, { filters: { dateTo: day(-200) } }, { filters: { dateFrom: "not-a-date" } },
      { tab: "bogus", sort: "bogus" },
      { tab: "pending", search: "e", hotel_ids: [IDS.hotels.A1, IDS.hotels.A2], filters: { dateFrom: day(-400) } },
    ];
    for (const u of [world.users.wide, world.users.dept, world.users.hotelB, IDS.users.crossCompany]) {
      for (const b of bodies) {
        await expectParity(u, b);
        await expectParity(u, { ...b, tab: "ongoing", sort: "oldest" });
      }
    }
  }, 300000);

  it("the world exercised every branch on both sides", () => {
    // eslint-disable-next-line no-console
    console.log("[list-view parity coverage]", JSON.stringify({
      ...coverage,
      flags: Object.fromEntries(Object.entries(coverage.flags).map(([k, v]) => [k, [...v]])),
      buckets: [...coverage.buckets], statusKeys: [...coverage.statusKeys],
    }));
    expect(coverage.calls).toBeGreaterThan(600);
    expect(coverage.rows).toBeGreaterThan(2000);
    for (const [flag, values] of Object.entries(coverage.flags)) {
      expect({ flag, values: [...values].sort() }).toEqual({ flag, values: ["false", "true"] });
    }
    for (const b of ["drafts", "approval", "ongoing", "approved", "closed"]) expect(coverage.buckets).toContain(b);
    expect(coverage.nonEmptyPending).toBeGreaterThan(0);
    expect(coverage.poRejection).toBeGreaterThan(0);
    expect(coverage.invited).toBeGreaterThan(0);
    expect(coverage.submitted).toBeGreaterThan(0);
    expect(coverage.unseen).toBeGreaterThan(0);
    expect(coverage.vendorFallback).toBeGreaterThan(0);
  });
});
