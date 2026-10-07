// Smart insights: deterministic output and HTTP/model agreement on a wide,
// perf-shaped world (portal perf plan 2026-10, item 1.2).
//
// The perf release proved its scoped-CTE rewrite against a frozen copy of the
// pre-rewrite queries. Buyer dashboard V3 then redefined every insight on
// purpose (committed-PO spend, regret quotes excluded from price stats,
// spec-variant benchmark guard, action keys instead of URLs, spend-trend
// floor/ceiling), so that frozen oracle no longer describes the intended
// output and its parity case was retired in the qa merge. The definitions
// are pinned by dashboard.smartInsights.test.js and
// dashboard.definitions.test.js; scope is resolved once per statement by
// dashboardMetrics.scopeTuplesFilter (an InitPlan), which is what the perf
// rewrite was for.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { seedPerfWorld } from "../helpers/perfParityWorld.js";
import dashboardModel from "../../app/models/dashboardModel.js";

let world;

beforeAll(async () => {
  world = await seedPerfWorld(db);
}, 180000);

afterAll(async () => {
  if (world) await world.cleanup();
  await closeDb();
});

describe("getSmartInsightsData on a perf-shaped world", () => {
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
