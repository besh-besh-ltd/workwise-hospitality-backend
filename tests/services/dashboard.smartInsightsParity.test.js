// Smart insights: the scoped-CTE rewrite returns what the old queries returned
// (portal perf plan 2026-10, item 1.2).
//
// The old price-deviation query evaluated the company + hotel + 3-way RBAC
// EXISTS per quote-item row, twice (once more inside a per-row market
// LATERAL) — 17% of all prod DB time. All four smart-insight queries now
// resolve the in-scope RFQ ids once (`scoped AS MATERIALIZED`) and semi-join
// the fact rows to it; the market average is computed once per variant.
//
// Oracle: tests/helpers/legacy/smartInsightsLegacy.js, a frozen copy of the
// origin/main implementation. Two of the old LIMITs had no ORDER BY (price
// deviations, and the best vendor on a count tie), so the old output was an
// arbitrary pick from a candidate set. The rewrite makes those picks
// deterministic. The suite therefore requires, per user x scope x window:
//   - spend trend:      identical;
//   - benchmark alerts: the same top-3-by-period-value from the same candidates;
//   - price alerts:     drawn from exactly the old candidate set, the largest
//                       deviations first; identical to the old output whenever
//                       the old LIMIT was not cutting anything;
//   - best vendor:      one of the old max-count vendors; identical when the
//                       max was unique.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { seedPerfWorld } from "../helpers/perfParityWorld.js";
import dashboardModel from "../../app/models/dashboardModel.js";
import { getSmartInsightsDataLegacy } from "../helpers/legacy/smartInsightsLegacy.js";

let world;

beforeAll(async () => {
  world = await seedPerfWorld(db);
}, 180000);

afterAll(async () => {
  if (world) await world.cleanup();
  await closeDb();
});

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const WINDOWS = () => [
  ["wide", "2020-01-01", "2999-01-01"],
  ["last 180d", day(-180), day(0)],
  ["last 400d", day(-400), day(1)],
  ["FY 2025-26", "2025-04-01", "2026-03-31"],
];

const ofType = (ins, type) => ins.filter((i) => i.type === type);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function checkTopK(newRows, fullRows, metric, k, label) {
  expect(newRows.length).toBe(Math.min(k, fullRows.length));
  const picked = [];
  for (const n of newRows) {
    const idx = fullRows.findIndex((f, i) => !picked.includes(i) && same(f.insight, n));
    if (idx < 0) throw new Error(`${label}: insight not in the old candidate set: ${JSON.stringify(n)}`);
    picked.push(idx);
  }
  const chosen = picked.map((i) => metric(fullRows[i].raw));
  for (let i = 1; i < chosen.length; i++) expect(chosen[i]).toBeLessThanOrEqual(chosen[i - 1]);
  const rest = fullRows.filter((_, i) => !picked.includes(i)).map((f) => metric(f.raw));
  if (chosen.length && rest.length) expect(Math.max(...rest)).toBeLessThanOrEqual(Math.min(...chosen));
}

describe("getSmartInsightsData parity with the pre-rewrite implementation", () => {
  it("matches for every user x window", async () => {
    const users = [
      ...Object.values(world.users),
      IDS.users.companyA_admin, IDS.users.a1_proc_buyer, IDS.users.multiHotel, IDS.users.crossCompany, IDS.users.a1_eng_buyer,
    ];
    const seen = { price: 0, priceCut: 0, bench: 0, vendor: 0, spend: 0, cases: 0 };

    for (const user of users) {
      const scope = await dashboardModel.resolveUserScope(user, []);
      if (!scope) continue;
      for (const hotelSel of [scope.hotel_ids, scope.hotel_ids.slice(0, 1)]) {
        for (const [wlabel, start, end] of WINDOWS()) {
          const label = `user=${user} hotels=${hotelSel.join(",")} window=${wlabel}`;
          const args = [scope.buyer_company_id, user, hotelSel, start, end];
          const [fresh, old, full] = await Promise.all([
            dashboardModel.getSmartInsightsData(...args),
            getSmartInsightsDataLegacy(...args),
            getSmartInsightsDataLegacy(...args, { unlimited: true }),
          ]);
          seen.cases++;
          try {
            // spend trend: identical
            expect(ofType(fresh.insights, "spend_trend")).toEqual(ofType(old.insights, "spend_trend"));
            if (ofType(old.insights, "spend_trend").length) seen.spend++;

            // benchmark alerts: same top-3 by in-period value
            const fullBench = ofType(full.insights, "benchmark_alert").map((insight, i) => ({ insight, raw: full.raw.benchmarkDeviations[i] }));
            checkTopK(ofType(fresh.insights, "benchmark_alert"), fullBench, (r) => Number(r.period_value), 3, `${label} benchmark`);
            if (fullBench.length) seen.bench++;

            // price alerts: largest deviations from the same candidates
            const fullPrice = ofType(full.insights, "price_alert").map((insight, i) => ({ insight, raw: full.raw.priceDeviations[i] }));
            const freshPrice = ofType(fresh.insights, "price_alert");
            checkTopK(freshPrice, fullPrice, (r) => Number(r.deviation_pct), 3, `${label} price`);
            if (fullPrice.length <= 3) {
              const key = (x) => JSON.stringify(x);
              expect(freshPrice.map(key).sort()).toEqual(ofType(old.insights, "price_alert").map(key).sort());
            } else {
              seen.priceCut++;
            }
            if (fullPrice.length) seen.price++;

            // best vendor: one of the max-count vendors; exact when unique
            const vendors = full.raw.bestVendor;
            const freshV = ofType(fresh.insights, "vendor_optimization");
            if (!vendors.length) {
              expect(freshV).toEqual([]);
            } else {
              seen.vendor++;
              const max = Math.max(...vendors.map((v) => Number(v.best_price_count)));
              const top = vendors.filter((v) => Number(v.best_price_count) === max);
              expect(freshV).toHaveLength(1);
              const titles = top.map((v) => `${v.company_name || v.vendor_name} offers best pricing`);
              expect(titles).toContain(freshV[0].title);
              if (top.length === 1) expect(freshV).toEqual(ofType(old.insights, "vendor_optimization"));
            }

            // nothing else appears, and the type order is unchanged
            const typeOrder = (ins) => ins.map((i) => i.type).filter((t, i, a) => a.indexOf(t) === i);
            expect(typeOrder(fresh.insights)).toEqual(typeOrder(old.insights));
          } catch (e) {
            e.message = `${label}\n${e.message}`;
            throw e;
          }
        }
      }
    }

    console.log("[smart-insights parity coverage]", JSON.stringify(seen));
    // the world must exercise every insight, including a LIMIT that cuts
    expect(seen.cases).toBeGreaterThan(40);
    expect(seen.price).toBeGreaterThan(5);
    expect(seen.bench).toBeGreaterThan(3);
    expect(seen.vendor).toBeGreaterThan(5);
    expect(seen.spend).toBeGreaterThan(0);
    expect(seen.priceCut).toBeGreaterThan(0);
  }, 180000);

  it("is deterministic across repeated calls", async () => {
    const scope = await dashboardModel.resolveUserScope(world.users.wide, []);
    const args = [scope.buyer_company_id, world.users.wide, scope.hotel_ids, "2020-01-01", "2999-01-01"];
    const a = await dashboardModel.getSmartInsightsData(...args);
    const b = await dashboardModel.getSmartInsightsData(...args);
    expect(b).toEqual(a);
  });

  it("GET /dashboard-v2/smart-insights serves the rewritten result", async () => {
    const client = await httpClient(world.users.wide);
    const res = await client.get("/api/v1/dashboard-v2/smart-insights").query({ start_date: "2020-01-01", end_date: "2999-01-01" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const scope = await dashboardModel.resolveUserScope(world.users.wide, []);
    const direct = await dashboardModel.getSmartInsightsData(scope.buyer_company_id, world.users.wide, scope.hotel_ids, "2020-01-01", "2999-01-01");
    expect(res.body.data).toEqual(direct);
  });
});
