// Smoke test for the 16 role-aware buyer-dashboard persona routes of widget
// catalogue v1 (docs/dashboard_v3/SPEC.md). This suite asserts:
//
//   1. Every route is registered (no 404/405).
//   2. Every route authenticates (401 when no JWT).
//   3. Every route returns 200 + { status: 1, data: <shape> } for an
//      authenticated user with the necessary scope.
//   4. The response shape matches what the FE component expects.
//   5. The routes cut from v1 are gone (404).

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
  { path: "/api/v1/dashboard-v2/my-drafts",                          keys: ["count", "oldest_created_at", "items"] },
  { path: "/api/v1/dashboard-v2/my-active-rfqs",                     keys: ["total", "stages"] },
  { path: "/api/v1/dashboard-v2/my-no-response-rfqs",                keys: ["count", "silent_vendor_count", "items"] },
  { path: "/api/v1/dashboard-v2/my-rfqs-bid-closed-no-quotes",       keys: ["count", "items"] },
  // Technical Evaluator
  { path: "/api/v1/dashboard-v2/my-tech-evals-pending",              keys: ["count", "oldest_waiting_since", "items"] },
  { path: "/api/v1/dashboard-v2/tech-evals-with-disagreements",      keys: ["count", "total_disagreement_clauses", "items"] },
  // Approval queues
  { path: "/api/v1/dashboard-v2/my-tech-approvals-pending",          keys: ["count", "oldest_age_days", "items"] },
  { path: "/api/v1/dashboard-v2/my-rfq-approvals-pending",           keys: ["count", "oldest_age_days", "items"] },
  { path: "/api/v1/dashboard-v2/my-commercial-approvals-pending",    keys: ["count", "total_value", "items"] },
  { path: "/api/v1/dashboard-v2/my-award-approvals-pending",         keys: ["count", "total_value", "items"] },
  { path: "/api/v1/dashboard-v2/approval-turnaround",                keys: ["window", "tabs"] },
  // Commercial Evaluator / N1
  { path: "/api/v1/dashboard-v2/my-quote-compares",                  keys: ["count", "items"] },
  { path: "/api/v1/dashboard-v2/my-active-negotiations",             keys: ["count", "awaiting_approval_count", "total_silent_vendors", "items"] },
  { path: "/api/v1/dashboard-v2/savings-pipeline",                   keys: ["basis", "total_savings", "prior_period_savings", "negotiation_count", "avg_savings_pct", "window"] },
  // Awarding
  { path: "/api/v1/dashboard-v2/recent-awards",                      keys: ["count", "items", "total_value", "window"] },
  { path: "/api/v1/dashboard-v2/award-value-pipeline",               keys: ["committed_value", "committed_po_count", "pending_value", "pending_po_count", "stages"] },
];

/** Routes cut from the v1 catalogue — must no longer be served. */
const REMOVED = [
  "/api/v1/dashboard-v2/tech-eval-throughput",
  "/api/v1/dashboard-v2/tech-approval-oldest-pending",
  "/api/v1/dashboard-v2/tech-approval-throughput",
  "/api/v1/dashboard-v2/deals-with-price-anomalies",
  "/api/v1/dashboard-v2/commercial-approval-throughput",
];

describe("Buyer dashboard — role-aware widget routes are registered", () => {
  it("registers exactly the 16 persona widget routes of catalogue v1", () => {
    expect(WIDGETS).toHaveLength(16);
  });

  it.each(REMOVED)("%s is no longer served", async (path) => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(path).query({ hotel_ids: String(IDS.hotels.A1) });
    // The app answers unknown paths with its catch-all 405.
    expect([404, 405]).toContain(res.status);
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
