// Wave-style integration test: role-aware buyer dashboard widget permissions.
//
// Validates the contract that the new frontend dashboard depends on:
//   POST /rbac/me/permissions/bulk { key: "dashboard", hotel_ids: [N] }
//   → { permissions: { dashboard: [granted_widget_codes...] } }
//
// What the FE expects this endpoint to do:
//   1. Return ONLY dashboard widget permissions the user has been granted
//      in at least one of the supplied hotels (BU scope).
//   2. Respect the user's department mapping when present.
//   3. Stay isolated across users / BUs — no cross-leakage.
//
// Per CONVENTIONS: tests hit real HTTP, real Postgres, observable behaviour
// only (no internal call-count assertions). Dynamic rows we insert get
// cleaned up in afterAll so the seeded fixture state is preserved for
// subsequent suites.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";

// The 7 cross-role + 18 persona-targeted widget actions the FE declares in
// components/dashboard/buyer/DashboardRegistry.js. Keep this in sync.
const DASHBOARD_WIDGETS = [
  // Cross-role
  "action_center",
  "procurement_snapshot",
  "negotiation_savings",
  "cost_intelligence",
  "category_insights",
  "abc_analysis",
  "workflow_efficiency",
  "smart_insights",
  // RFQ Creator
  "my_drafts",
  "my_active_rfqs",
  "my_no_response_rfqs",
  // Tech Evaluator
  "my_tech_evals_pending",
  "tech_evals_with_vendor_disagreements",
  "tech_eval_throughput",
  // Tech Approver
  "my_tech_approvals_pending",
  "tech_approval_oldest_pending",
  "tech_approval_throughput",
  // Commercial Evaluator / N1
  "my_quote_compares",
  "my_active_negotiations",
  "savings_pipeline",
  // Commercial Approver
  "my_commercial_approvals_pending",
  "deals_with_price_anomalies",
  "commercial_approval_throughput",
  // Awarding P1/P2
  "my_award_approvals_pending",
  "recent_awards",
  "award_value_pipeline",
];

// Recommended preset bundles per persona. Mirrors the admin doc tooltip
// the plan calls for — used by these tests to grant role-appropriate
// widgets and then assert the right subset surfaces.
const PRESETS = {
  RFQ_CREATOR: ["my_drafts", "my_active_rfqs", "my_no_response_rfqs", "action_center"],
  TECH_EVAL:   ["my_tech_evals_pending", "tech_evals_with_vendor_disagreements", "tech_eval_throughput"],
  TECH_APP:    ["my_tech_approvals_pending", "tech_approval_oldest_pending", "tech_approval_throughput"],
  COMM_EVAL:   ["my_quote_compares", "my_active_negotiations", "savings_pipeline", "negotiation_savings"],
  COMM_APP:    ["my_commercial_approvals_pending", "deals_with_price_anomalies", "commercial_approval_throughput"],
  AWARDING:    ["my_award_approvals_pending", "recent_awards", "award_value_pipeline", "procurement_snapshot"],
};

// Track inserted permission/role-permission IDs for clean teardown.
const insertedPermissionIds = [];
const insertedRolePermissionPairs = []; // { role_id, permission_id }

beforeAll(async () => {
  // 0) Extend the `resource_type` + `permission_action_type` enums so the
  //    25 dashboard widget codes are valid values. The real schema
  //    migration backing this feature will add them permanently; here we
  //    extend the per-run test DB so the suite is self-contained. ALTER
  //    TYPE ADD VALUE can't run inside a tx — pg handles it as a stand-
  //    alone DDL.
  await db.none(`ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'dashboard'`);
  for (const action of DASHBOARD_WIDGETS) {
    await db.none(
      `ALTER TYPE permission_action_type ADD VALUE IF NOT EXISTS '${action}'`
    );
  }

  // 1) Seed the dashboard widget catalogue. The migration that owns this
  //    long-term will live backend-side; this beforeAll is a test-time
  //    stand-in so the suite is self-contained.
  for (const action of DASHBOARD_WIDGETS) {
    const existing = await db.oneOrNone(
      `SELECT id FROM tbl_permissions WHERE resource = $1 AND action = $2`,
      ["dashboard", action]
    );
    if (existing) continue;
    const inserted = await db.one(
      `INSERT INTO tbl_permissions (resource, action)
       VALUES ($1, $2) RETURNING id`,
      ["dashboard", action]
    );
    insertedPermissionIds.push(inserted.id);
  }

  // 2) Apply recommended preset bundles to the fixture roles.
  const grantBundle = async (roleId, actions) => {
    for (const action of actions) {
      const p = await db.one(
        `SELECT id FROM tbl_permissions WHERE resource = 'dashboard' AND action = $1`,
        [action]
      );
      const existing = await db.oneOrNone(
        `SELECT 1 FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2`,
        [roleId, p.id]
      );
      if (existing) continue;
      await db.none(
        `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2)`,
        [roleId, p.id]
      );
      insertedRolePermissionPairs.push({ role_id: roleId, permission_id: p.id });
    }
  };
  await grantBundle(ROLE_IDS.TENDER_CREATOR,    PRESETS.RFQ_CREATOR);
  await grantBundle(ROLE_IDS.TECH_EVAL,         PRESETS.TECH_EVAL);
  await grantBundle(ROLE_IDS.TECH_APPROVER,     PRESETS.TECH_APP);
  await grantBundle(ROLE_IDS.COMM_NEGO_N1,      PRESETS.COMM_EVAL);
  await grantBundle(ROLE_IDS.COMM_APPROVER,     PRESETS.COMM_APP);
  await grantBundle(ROLE_IDS.FINAL_AWARDING_P1, PRESETS.AWARDING);
});

afterAll(async () => {
  // Tear down role-permission grants we created.
  for (const pair of insertedRolePermissionPairs) {
    await db.none(
      `DELETE FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [pair.role_id, pair.permission_id]
    );
  }
  // Tear down permission rows we inserted.
  for (const id of insertedPermissionIds) {
    await db.none(`DELETE FROM tbl_permissions WHERE id = $1`, [id]);
  }
  await closeDb();
});

async function getDashboardPerms(userId, hotelIds) {
  const client = await httpClient(userId);
  const res = await client
    .post("/api/v1/rbac/me/permissions/bulk")
    .send({ key: "dashboard", hotel_ids: hotelIds });
  return res;
}

// Shape A: permissions.dashboard = { actions: [...], scope: {...} }.
// Legacy: permissions.dashboard = [...]. Widgets live in `actions` either way
// (dashboard grants are not process-scoped). Extract the flat widget list.
function dashActions(res) {
  const d = res.body?.data?.permissions?.dashboard;
  return Array.isArray(d) ? d : (d?.actions || []);
}

describe("Role-aware buyer dashboard — permission resolution", () => {
  it("RFQ creator in Hotel A1 sees only their persona's widgets", async () => {
    const res = await getDashboardPerms(IDS.users.a1_proc_buyer, [IDS.hotels.A1]);
    expect(res.status).toBe(200);
    const perms = dashActions(res);
    expect(perms).toEqual(expect.arrayContaining(PRESETS.RFQ_CREATOR));
    // Negative: should NOT see persona widgets they weren't granted.
    expect(perms).not.toContain("my_tech_approvals_pending");
    expect(perms).not.toContain("savings_pipeline");
    expect(perms).not.toContain("award_value_pipeline");
  });

  it("Technical Evaluator in Hotel A1 sees only their persona's widgets", async () => {
    const res = await getDashboardPerms(IDS.users.a1_proc_techEval, [IDS.hotels.A1]);
    expect(res.status).toBe(200);
    const perms = dashActions(res);
    expect(perms).toEqual(expect.arrayContaining(PRESETS.TECH_EVAL));
    expect(perms).not.toContain("my_drafts");
    expect(perms).not.toContain("my_commercial_approvals_pending");
  });

  it("Technical Approver sees their persona's widgets", async () => {
    const res = await getDashboardPerms(IDS.users.a1_proc_techApp, [IDS.hotels.A1]);
    expect(res.status).toBe(200);
    const perms = dashActions(res);
    expect(perms).toEqual(expect.arrayContaining(PRESETS.TECH_APP));
    expect(perms).not.toContain("my_drafts");
    expect(perms).not.toContain("my_tech_evals_pending");
  });

  it("Commercial Evaluator (N1) sees their persona's widgets", async () => {
    const res = await getDashboardPerms(IDS.users.a1_proc_commEval, [IDS.hotels.A1]);
    expect(res.status).toBe(200);
    const perms = dashActions(res);
    expect(perms).toEqual(expect.arrayContaining(PRESETS.COMM_EVAL));
    expect(perms).not.toContain("my_tech_evals_pending");
  });

  it("Commercial Approver sees their persona's widgets", async () => {
    const res = await getDashboardPerms(IDS.users.a1_proc_commApp, [IDS.hotels.A1]);
    expect(res.status).toBe(200);
    const perms = dashActions(res);
    expect(perms).toEqual(expect.arrayContaining(PRESETS.COMM_APP));
    expect(perms).not.toContain("savings_pipeline");
  });

  it("Awarding P1 user sees their persona's widgets", async () => {
    const res = await getDashboardPerms(IDS.users.a1_proc_poApp, [IDS.hotels.A1]);
    expect(res.status).toBe(200);
    const perms = dashActions(res);
    expect(perms).toEqual(expect.arrayContaining(PRESETS.AWARDING));
    expect(perms).not.toContain("my_drafts");
    expect(perms).not.toContain("my_quote_compares");
  });

  it("user with no dashboard.* grants gets an empty (or missing) dashboard array — drives the EmptyDashboard UI", async () => {
    // companyB_admin has CEO role but we never granted any dashboard.* perms
    // to CEO — so their dashboard permission list should be empty in B1.
    const res = await getDashboardPerms(IDS.users.companyB_admin, [IDS.hotels.B1]);
    expect(res.status).toBe(200);
    const perms = dashActions(res);
    expect(perms).toEqual([]);
  });

  it("respects BU scope — RFQ creator at A1 sees no grants when filtering to a hotel they aren't mapped to", async () => {
    // a1_proc_buyer is only scoped to A1. Asking for permissions in A3 (which
    // belongs to Hospitality A but the user has no scope there) should return
    // an empty dashboard array — they have no widget grant in that BU.
    const res = await getDashboardPerms(IDS.users.a1_proc_buyer, [IDS.hotels.A3]);
    expect(res.status).toBe(200);
    const perms = dashActions(res);
    // urs.hotel_id IS NULL → also matches; a1_proc_buyer has hotel_id=A1,
    // not NULL, so A3 filter returns nothing.
    expect(perms).toEqual([]);
  });

  it("multi-hotel user — sees union of grants across selected BUs", async () => {
    // multiHotel user has TENDER_CREATOR in BOTH A1 and A2 (per fixtures).
    // Selecting [A1, A2] should include the RFQ Creator persona widgets.
    const res = await getDashboardPerms(IDS.users.multiHotel, [IDS.hotels.A1, IDS.hotels.A2]);
    expect(res.status).toBe(200);
    const perms = dashActions(res);
    expect(perms).toEqual(expect.arrayContaining(PRESETS.RFQ_CREATOR));
  });

  it("dual-role user — sees widgets from BOTH roles when in multi-BU view", async () => {
    // dualRole = TENDER_CREATOR in A1 + TECH_EVAL in A2.
    const res = await getDashboardPerms(IDS.users.dualRole, [IDS.hotels.A1, IDS.hotels.A2]);
    expect(res.status).toBe(200);
    const perms = dashActions(res);
    // RFQ Creator widgets (from A1) AND Tech Evaluator widgets (from A2)
    expect(perms).toEqual(expect.arrayContaining(PRESETS.RFQ_CREATOR));
    expect(perms).toEqual(expect.arrayContaining(PRESETS.TECH_EVAL));
  });

  it("dual-role user — narrowing to a single BU only shows that BU's role widgets", async () => {
    // Same user, A1 only → should see RFQ Creator persona widgets, NOT Tech Evaluator.
    const res = await getDashboardPerms(IDS.users.dualRole, [IDS.hotels.A1]);
    expect(res.status).toBe(200);
    const perms = dashActions(res);
    expect(perms).toEqual(expect.arrayContaining(PRESETS.RFQ_CREATOR));
    // Tech-eval widgets should NOT appear (only granted in A2).
    expect(perms).not.toContain("my_tech_evals_pending");
    expect(perms).not.toContain("tech_evals_with_vendor_disagreements");
  });

  it("cross-company user — sees grants from each hospitality company independently", async () => {
    // crossCompany has TENDER_CREATOR at company-level in BOTH Hospitality A
    // and Hospitality B (hotel_id NULL on both scope rows). Selecting any
    // hotel from either company should resolve through to those grants.
    const resA = await getDashboardPerms(IDS.users.crossCompany, [IDS.hotels.A1]);
    expect(resA.status).toBe(200);
    expect(dashActions(resA)).toEqual(
      expect.arrayContaining(PRESETS.RFQ_CREATOR)
    );

    const resB = await getDashboardPerms(IDS.users.crossCompany, [IDS.hotels.B1]);
    expect(resB.status).toBe(200);
    expect(dashActions(resB)).toEqual(
      expect.arrayContaining(PRESETS.RFQ_CREATOR)
    );
  });

  it("permissions live update — revoking a role-permission removes the widget on the next call", async () => {
    // Snapshot: RFQ creator has my_drafts grant via TENDER_CREATOR role.
    const before = await getDashboardPerms(IDS.users.a1_proc_buyer, [IDS.hotels.A1]);
    expect(dashActions(before)).toContain("my_drafts");

    // Revoke just that single permission.
    const perm = await db.one(
      `SELECT id FROM tbl_permissions WHERE resource = 'dashboard' AND action = 'my_drafts'`
    );
    await db.none(
      `DELETE FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [ROLE_IDS.TENDER_CREATOR, perm.id]
    );

    try {
      const after = await getDashboardPerms(IDS.users.a1_proc_buyer, [IDS.hotels.A1]);
      const perms = dashActions(after);
      expect(perms).not.toContain("my_drafts");
      // Sibling widgets in the same persona bundle should still be present.
      expect(perms).toContain("my_active_rfqs");
    } finally {
      // Restore the grant so subsequent test suites see the seeded state.
      await db.none(
        `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [ROLE_IDS.TENDER_CREATOR, perm.id]
      );
    }
  });

  it("inactive user cannot authenticate to fetch dashboard permissions", async () => {
    // The HTTP login helper refuses inactive users — this asserts the
    // dashboard surface inherits the platform-wide auth contract.
    const { loginAs } = await import("../helpers/auth.js");
    await expect(loginAs(IDS.users.inactive)).rejects.toThrow(/inactive/i);
  });

  it("empty hotel_ids array expands to all the user's accessible BUs — dashboard 'All Business Units' selector", async () => {
    // a1_proc_buyer is mapped only to A1 → expanding [] should resolve to
    // [A1] and return their RFQ Creator persona widget grants.
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client
      .post("/api/v1/rbac/me/permissions/bulk")
      .send({ key: "dashboard", hotel_ids: [] });
    expect(res.status).toBe(200);
    const perms = dashActions(res);
    expect(perms).toEqual(expect.arrayContaining(PRESETS.RFQ_CREATOR));
    // Meta should signal the expansion happened so the FE can render an
    // "(All Business Units)" hint if it wants.
    expect(res.body?.data?.meta?.expanded_from_all_bus).toBe(true);
  });

  it("empty hotel_ids for a multi-hotel user resolves to all their hotels", async () => {
    // multiHotel is mapped to A1 + A2 → expansion should cover both.
    const client = await httpClient(IDS.users.multiHotel);
    const res = await client
      .post("/api/v1/rbac/me/permissions/bulk")
      .send({ key: "dashboard", hotel_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body?.data?.meta?.expanded_from_all_bus).toBe(true);
    // Both hotels should appear in valid_hotel_ids meta.
    const validIds = res.body?.data?.meta?.valid_hotel_ids || [];
    expect(validIds).toEqual(expect.arrayContaining([IDS.hotels.A1, IDS.hotels.A2]));
  });

  it("empty hotel_ids for a company-level user expands to every hotel under their hospitality companies", async () => {
    // companyA_admin has a company-level mapping (mapping_type=0, hotel_id NULL).
    // Expansion should pull in every hotel under Hospitality A.
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client
      .post("/api/v1/rbac/me/permissions/bulk")
      .send({ key: "dashboard", hotel_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body?.data?.meta?.expanded_from_all_bus).toBe(true);
    const validIds = res.body?.data?.meta?.valid_hotel_ids || [];
    // Hospitality A operates A1, A2, A3 — all should be in scope.
    expect(validIds).toEqual(expect.arrayContaining([IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3]));
  });

  it("empty hotel_ids for a user with no mappings returns an empty permission set (drives EmptyDashboard)", async () => {
    // superAdmin has CEO-level role scopes (company_id but no hotel mapping)
    // — there's no entry in tbl_hospitality_user_mappings for them in the
    // fixture set. Expansion yields zero hotels → empty payload.
    const client = await httpClient(IDS.users.superAdmin);
    const res = await client
      .post("/api/v1/rbac/me/permissions/bulk")
      .send({ key: "dashboard", hotel_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body?.data?.permissions).toEqual({});
    expect(res.body?.data?.meta?.expanded_from_all_bus).toBe(true);
  });

  it("rejects requests with no hotel_ids field at all", async () => {
    // hotel_ids must be present (empty array is OK and means 'all BUs').
    // Omitting the field entirely is still a 400.
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client
      .post("/api/v1/rbac/me/permissions/bulk")
      .send({ key: "dashboard" });
    expect(res.status).toBe(400);
  });
});
