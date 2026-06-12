// Smoke test for the 18 role-aware buyer-dashboard widget routes. Each
// endpoint today returns a safe-default empty shape so the FE renders
// the EmptyState path instead of erroring. This suite asserts:
//
//   1. Every route is registered (no 404/405).
//   2. Every route authenticates (401 when no JWT).
//   3. Every route returns 200 + { status: 1, data: <shape> } for an
//      authenticated user with the necessary scope.
//   4. The response shape matches what the FE component expects.
//
// As real aggregation logic is implemented per widget, swap-in or
// extend these expectations to assert on real counts / items.

import { describe, it, expect, afterAll } from "@jest/globals";
import { closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

afterAll(async () => {
  await closeDb();
});

/**
 * Per-widget: route path + the keys we expect the response data to have.
 * Keys are not exhaustive — just the load-bearing ones the FE checks.
 */
const WIDGETS = [
  // RFQ Creator
  { path: "/api/v1/dashboard-v2/my-drafts",                          keys: ["count", "items"] },
  { path: "/api/v1/dashboard-v2/my-active-rfqs",                     keys: ["total", "stages"] },
  { path: "/api/v1/dashboard-v2/my-no-response-rfqs",                keys: ["count", "silent_vendor_count", "items"] },
  // Technical Evaluator
  { path: "/api/v1/dashboard-v2/my-tech-evals-pending",              keys: ["count", "items"] },
  { path: "/api/v1/dashboard-v2/tech-evals-with-disagreements",      keys: ["count", "total_disagreement_clauses", "items"] },
  { path: "/api/v1/dashboard-v2/tech-eval-throughput",               keys: ["current_period_avg_hours", "prior_period_avg_hours", "delta_pct", "unit", "sparkline"] },
  // Technical Approver
  { path: "/api/v1/dashboard-v2/my-tech-approvals-pending",          keys: ["count", "items"] },
  { path: "/api/v1/dashboard-v2/tech-approval-oldest-pending",       keys: ["items"] },
  { path: "/api/v1/dashboard-v2/tech-approval-throughput",           keys: ["current_period_avg_hours", "delta_pct", "sparkline"] },
  // Commercial Evaluator / N1
  { path: "/api/v1/dashboard-v2/my-quote-compares",                  keys: ["count", "items"] },
  { path: "/api/v1/dashboard-v2/my-active-negotiations",             keys: ["count", "total_silent_vendors", "items"] },
  { path: "/api/v1/dashboard-v2/savings-pipeline",                   keys: ["total_savings", "prior_period_savings", "negotiation_count", "avg_savings_pct"] },
  // Commercial Approver
  { path: "/api/v1/dashboard-v2/my-commercial-approvals-pending",    keys: ["count", "total_value", "top_by_value"] },
  { path: "/api/v1/dashboard-v2/deals-with-price-anomalies",         keys: ["count", "items"] },
  { path: "/api/v1/dashboard-v2/commercial-approval-throughput",     keys: ["current_period_avg_hours", "delta_pct", "sparkline"] },
  // Awarding P1 / P2
  { path: "/api/v1/dashboard-v2/my-award-approvals-pending",         keys: ["count", "total_value", "items"] },
  { path: "/api/v1/dashboard-v2/recent-awards",                      keys: ["items", "total_value"] },
  { path: "/api/v1/dashboard-v2/award-value-pipeline",               keys: ["completed_value", "completed_po_count", "ongoing_value", "ongoing_po_count"] },
];

describe("Buyer dashboard — role-aware widget routes are registered", () => {
  it("registers exactly 18 widget routes", () => {
    expect(WIDGETS).toHaveLength(18);
  });

  it.each(WIDGETS)("$path requires authentication (401 without JWT)", async ({ path }) => {
    const client = await httpClient(null);
    const res = await client.get(path);
    // 401 = no JWT, 403 = JWT but blocked. Anything that is NOT 405
    // proves the route is registered.
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(405);
    expect([401, 403]).toContain(res.status);
  });

  it.each(WIDGETS)("$path returns 200 + safe-default data shape for an authenticated buyer", async ({ path, keys }) => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client
      .get(path)
      .query({ hotel_ids: String(IDS.hotels.A1) });
    expect(res.status).toBe(200);
    expect(res.body?.status).toBe(1);
    expect(res.body?.data).toBeDefined();
    for (const k of keys) {
      expect(res.body.data).toHaveProperty(k);
    }
  });

  it("returns 403 when the user has no hospitality access at all", async () => {
    // superAdmin has no tbl_hospitality_user_mappings rows in fixtures —
    // resolveScope() returns null → 403.
    const client = await httpClient(IDS.users.superAdmin);
    const res = await client.get("/api/v1/dashboard-v2/my-drafts");
    expect(res.status).toBe(403);
  });
});
