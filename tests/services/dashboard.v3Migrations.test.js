// Buyer dashboard V3 — the migrations that make the role-aware dashboard
// reachable: the v1 widget catalogue (20260928100000) and the capability-based
// default grants (20260928102000). See docs/dashboard_v3/SPEC.md.
//
// The test DB applies both through tests/setup/pendingMigrations.json, exactly
// as a real environment would. These tests assert what an administrator and a
// buyer can observe afterwards: which widgets exist, which role holds which
// widget, and that the down migrations undo exactly what the up ones did.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const runMigration = (file) => db.none(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));

const CATALOGUE_UP = "20260928100000_dashboard_v3_widget_catalogue.sql";
const CATALOGUE_DOWN = "20260928100000_dashboard_v3_widget_catalogue.down.sql";
const SEED_UP = "20260928102000_dashboard_v3_seed_grants.sql";
const SEED_DOWN = "20260928102000_dashboard_v3_seed_grants.down.sql";

const CROSS_ROLE = [
  "action_center", "procurement_snapshot", "negotiation_savings", "cost_intelligence",
  "category_insights", "abc_analysis", "workflow_efficiency", "smart_insights",
];

const V1_CATALOGUE = [
  ...CROSS_ROLE,
  "my_drafts", "my_active_rfqs", "my_no_response_rfqs", "my_rfqs_bid_closed_no_quotes",
  "my_tech_evals_pending", "tech_evals_with_vendor_disagreements",
  "my_tech_approvals_pending",
  "my_quote_compares", "my_active_negotiations", "savings_pipeline",
  "my_commercial_approvals_pending",
  "my_award_approvals_pending", "recent_awards", "award_value_pipeline",
  "my_rfq_approvals_pending",
  "approval_turnaround",
];

const CUT = [
  "tech_approval_oldest_pending", "deals_with_price_anomalies", "tech_eval_throughput",
  "tech_approval_throughput", "commercial_approval_throughput",
];

// The grant rules, restated independently of the SQL so a change to either
// side shows up here. widget → capabilities that earn it.
const RULES = {
  my_drafts: ["rfq.create"],
  my_active_rfqs: ["rfq.create"],
  my_no_response_rfqs: ["rfq.create"],
  my_rfqs_bid_closed_no_quotes: ["rfq.create"],
  my_tech_evals_pending: ["te.create", "te.update"],
  tech_evals_with_vendor_disagreements: ["te.create", "te.update"],
  my_tech_approvals_pending: ["te.approve"],
  my_quote_compares: ["quote-compare.create", "negotiation.create"],
  my_active_negotiations: ["quote-compare.create", "negotiation.create"],
  savings_pipeline: ["quote-compare.create", "negotiation.create"],
  my_commercial_approvals_pending: ["negotiation.approve", "quote-compare.approve"],
  my_award_approvals_pending: ["awarding.approve"],
  recent_awards: ["awarding.approve", "awarding.create"],
  award_value_pipeline: ["awarding.approve", "awarding.create"],
  my_rfq_approvals_pending: ["rfq.approve", "tender.approve", "boq.approve"],
  approval_turnaround: [
    "rfq.approve", "tender.approve", "boq.approve", "te.approve",
    "negotiation.approve", "quote-compare.approve", "awarding.approve",
  ],
};
const PROCUREMENT_RESOURCES = new Set([
  "rfq", "tender", "te", "quote-compare", "po", "commercial", "negotiation", "awarding",
  "boq", "arc", "arc-tech", "arc-comm", "arc-committee", "mr",
]);

function expectedWidgets(caps) {
  if (caps.includes("company.admin")) return [...V1_CATALOGUE].sort();
  const out = new Set();
  if (caps.some((c) => PROCUREMENT_RESOURCES.has(c.split(".")[0]))) CROSS_ROLE.forEach((w) => out.add(w));
  for (const [widget, needs] of Object.entries(RULES)) {
    if (needs.some((n) => caps.includes(n))) out.add(widget);
  }
  return [...out].sort();
}

async function rolePermissionMatrix() {
  const rows = await db.any(
    `SELECT r.id AS role_id,
            array_remove(array_agg(DISTINCT CASE WHEN p.resource::text <> 'dashboard'
                                 THEN p.resource::text || '.' || p.action::text END), NULL) AS caps,
            array_remove(array_agg(DISTINCT CASE WHEN p.resource::text = 'dashboard'
                                 THEN p.action::text END), NULL) AS widgets
       FROM tbl_roles r
       LEFT JOIN tbl_role_permissions rp ON rp.role_id = r.id
       LEFT JOIN tbl_permissions p ON p.id = rp.permission_id
      GROUP BY r.id
      ORDER BY r.id`
  );
  return rows.map((r) => ({ ...r, widgets: [...r.widgets].sort() }));
}

const dashboardCodes = async () =>
  (await db.any(`SELECT action::text AS action FROM tbl_permissions WHERE resource::text = 'dashboard'`))
    .map((r) => r.action)
    .sort();

const dashActions = (res) => {
  const d = res.body?.data?.permissions?.dashboard;
  return Array.isArray(d) ? d : d?.actions || [];
};

// Fixture roles bundle capabilities (every fixture role with awarding.create
// also holds awarding.approve), so they cannot tell the rules apart. One probe
// role per capability, each holding exactly that permission, makes every rule
// observable on its own. The seed is re-run so it sees them.
const PROBE_CAPABILITIES = [
  ...new Set(Object.values(RULES).flat()),
  "rfq.read", "mr.read", "arc.read", "reports.spend_summary", "company.admin",
];
const probeRoleIds = {};

beforeAll(async () => {
  for (const cap of PROBE_CAPABILITIES) {
    const [resource, action] = cap.split(".");
    const perm = await db.one(
      `SELECT id FROM tbl_permissions WHERE resource::text = $1 AND action::text = $2 ORDER BY id LIMIT 1`,
      [resource, action]
    );
    const role = await db.one(
      `INSERT INTO tbl_roles (title, description, created_by) VALUES ($1, 'dashboard v3 seed probe', NULL) RETURNING id`,
      [`probe ${cap}`]
    );
    await db.none(`INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2)`, [role.id, perm.id]);
    probeRoleIds[cap] = role.id;
  }
  await runMigration(SEED_DOWN);
  await runMigration(SEED_UP);
});

afterAll(async () => {
  const ids = Object.values(probeRoleIds);
  if (ids.length) {
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id IN ($1:csv)`, [ids]);
    await db.none(`DELETE FROM tbl_dashboard_seed_grants WHERE role_id IN ($1:csv)`, [ids]);
    await db.none(`DELETE FROM tbl_roles WHERE id IN ($1:csv)`, [ids]);
  }
  await closeDb();
});

describe("dashboard v3 — widget catalogue", () => {
  it("registers exactly the v1 widgets: the two new ones in, the five cut ones out", async () => {
    expect(await dashboardCodes()).toEqual([...V1_CATALOGUE].sort());
  });

  it("the admin role editor lists the v1 dashboard widgets in persona order", async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [IDS.users.companyA_admin]);
    try {
      const client = await httpClient(IDS.users.companyA_admin);
      const res = await client.get("/api/v1/rbac/permissions");
      expect(res.status).toBe(200);
      const dashboard = res.body.data.dashboard.map((p) => p.action);
      expect([...dashboard].sort()).toEqual([...V1_CATALOGUE].sort());
      // Persona order, not enum order: cross-role cards first, the approval
      // turnaround card last.
      expect(dashboard.slice(0, CROSS_ROLE.length)).toEqual(CROSS_ROLE);
      expect(dashboard[dashboard.length - 1]).toBe("approval_turnaround");
      for (const cut of CUT) expect(dashboard).not.toContain(cut);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [IDS.users.companyA_admin]);
    }
  });
});

describe("dashboard v3 — default grants follow capability", () => {
  it("every role holds exactly the widgets its capabilities earn", async () => {
    const matrix = await rolePermissionMatrix();
    expect(matrix.length).toBeGreaterThan(10);
    for (const role of matrix) {
      expect({ role: role.role_id, widgets: role.widgets }).toEqual({
        role: role.role_id,
        widgets: expectedWidgets(role.caps),
      });
    }
  });

  it("each capability, held alone, earns exactly its widgets", async () => {
    const byRole = Object.fromEntries((await rolePermissionMatrix()).map((r) => [r.role_id, r.widgets]));
    const earned = (cap) => byRole[probeRoleIds[cap]];

    expect(earned("rfq.create")).toEqual(expectedWidgets(["rfq.create"]));
    expect(earned("rfq.create")).toContain("my_drafts");
    // PO approvals need the approve capability; initiating POs is not enough.
    expect(earned("awarding.create")).not.toContain("my_award_approvals_pending");
    expect(earned("awarding.create")).toEqual(expect.arrayContaining(["recent_awards", "award_value_pipeline"]));
    expect(earned("awarding.approve")).toContain("my_award_approvals_pending");
    expect(earned("te.update")).toContain("my_tech_evals_pending");
    expect(earned("te.approve")).not.toContain("my_tech_evals_pending");
    expect(earned("boq.approve")).toContain("my_rfq_approvals_pending");
    expect(earned("quote-compare.approve")).toContain("my_commercial_approvals_pending");
    expect(earned("quote-compare.approve")).not.toContain("my_quote_compares");
    // Any procurement read earns the cross-role cards; reports alone does not.
    expect(earned("rfq.read")).toEqual([...CROSS_ROLE].sort());
    expect(earned("mr.read")).toEqual([...CROSS_ROLE].sort());
    expect(earned("reports.spend_summary")).toEqual([]);
    expect(earned("company.admin")).toEqual([...V1_CATALOGUE].sort());

    for (const cap of PROBE_CAPABILITIES) {
      expect({ cap, widgets: earned(cap) }).toEqual({ cap, widgets: expectedWidgets([cap]) });
    }
  });

  it("spot-checks the personas a buyer will recognise", async () => {
    const byRole = Object.fromEntries((await rolePermissionMatrix()).map((r) => [r.role_id, r.widgets]));

    // RFQ creator: their own RFQs plus the cross-role cards, no approval queues.
    expect(byRole[ROLE_IDS.TENDER_CREATOR]).toEqual(expect.arrayContaining(["my_drafts", ...CROSS_ROLE]));
    expect(byRole[ROLE_IDS.TENDER_CREATOR]).not.toContain("my_rfq_approvals_pending");

    // Technical approver: their queue and turnaround, not RFQ creation.
    expect(byRole[ROLE_IDS.TECH_APPROVER]).toEqual(
      expect.arrayContaining(["my_tech_approvals_pending", "approval_turnaround", ...CROSS_ROLE])
    );
    expect(byRole[ROLE_IDS.TECH_APPROVER]).not.toContain("my_drafts");

    // Tender approver: the RFQ approval queue the old catalogue never had.
    expect(byRole[ROLE_IDS.TENDER_APPROVER]).toContain("my_rfq_approvals_pending");

    // Final awarding approves POs.
    expect(byRole[ROLE_IDS.FINAL_AWARDING_P1]).toEqual(
      expect.arrayContaining(["my_award_approvals_pending", "recent_awards", "award_value_pipeline"])
    );

    // Read-only observer: parity with the legacy dashboard, nothing persona-specific.
    expect(byRole[ROLE_IDS.RFQ_OBSERVER]).toEqual([...CROSS_ROLE].sort());

    // Company Administrator: everything.
    const admin = await db.one(`SELECT id FROM tbl_roles WHERE title = 'Company Administrator' AND created_by IS NULL`);
    expect(byRole[admin.id]).toEqual([...V1_CATALOGUE].sort());
  });

  it("a tender approver's permission call now returns the new RFQ approval and turnaround widgets", async () => {
    const client = await httpClient(IDS.users.a1_proc_finance);
    const res = await client
      .post("/api/v1/rbac/me/permissions/bulk")
      .send({ key: "dashboard", hotel_ids: [IDS.hotels.A1] });
    expect(res.status).toBe(200);
    expect(dashActions(res)).toEqual(
      expect.arrayContaining(["my_rfq_approvals_pending", "approval_turnaround", "action_center"])
    );
    for (const cut of CUT) expect(dashActions(res)).not.toContain(cut);
  });
});

describe("dashboard v3 — down migrations undo exactly what the up ones did", () => {
  it("seed down removes only the seeded grants; an administrator's own grant survives; up restores", async () => {
    // An administrator gives RFQ Observer a widget its capabilities do not earn.
    const myDrafts = await db.one(
      `SELECT id FROM tbl_permissions WHERE resource::text = 'dashboard' AND action::text = 'my_drafts'`
    );
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2)`,
      [ROLE_IDS.RFQ_OBSERVER, myDrafts.id]
    );
    const before = await rolePermissionMatrix();

    try {
      await runMigration(SEED_DOWN);
      const after = Object.fromEntries((await rolePermissionMatrix()).map((r) => [r.role_id, r.widgets]));
      expect(after[ROLE_IDS.TENDER_CREATOR]).toEqual([]);
      expect(after[ROLE_IDS.TECH_APPROVER]).toEqual([]);
      expect(after[ROLE_IDS.RFQ_OBSERVER]).toEqual(["my_drafts"]);
      const table = await db.oneOrNone(`SELECT to_regclass('public.tbl_dashboard_seed_grants') AS t`);
      expect(table.t).toBeNull();
    } finally {
      await runMigration(SEED_UP);
    }

    // Re-applying reproduces the same matrix (idempotent, nothing doubled).
    expect(await rolePermissionMatrix()).toEqual(before);

    await db.none(
      `DELETE FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [ROLE_IDS.RFQ_OBSERVER, myDrafts.id]
    );
  });

  it("catalogue down restores the cut widgets with their grants and removes the two new ones; up re-applies", async () => {
    // A role that held a cut widget before the catalogue migration (as staging's
    // custom "All Dashboards" role did) gets it back on rollback.
    await db.none(
      `INSERT INTO tbl_dashboard_v3_cut_grants (role_id, action) VALUES ($1, 'tech_eval_throughput')`,
      [ROLE_IDS.TECH_EVAL]
    );

    try {
      await runMigration(SEED_DOWN);
      await runMigration(CATALOGUE_DOWN);

      const codes = await dashboardCodes();
      for (const cut of CUT) expect(codes).toContain(cut);
      expect(codes).not.toContain("my_rfq_approvals_pending");
      expect(codes).not.toContain("approval_turnaround");

      const restored = await db.oneOrNone(
        `SELECT 1 FROM tbl_role_permissions rp JOIN tbl_permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = $1 AND p.resource::text = 'dashboard' AND p.action::text = 'tech_eval_throughput'`,
        [ROLE_IDS.TECH_EVAL]
      );
      expect(restored).not.toBeNull();
    } finally {
      await runMigration(CATALOGUE_UP);
      await runMigration(SEED_UP);
    }

    expect(await dashboardCodes()).toEqual([...V1_CATALOGUE].sort());
    // The re-applied catalogue backed the restored grant up again before removing it.
    const backedUp = await db.oneOrNone(
      `SELECT 1 FROM tbl_dashboard_v3_cut_grants WHERE role_id = $1 AND action = 'tech_eval_throughput'`,
      [ROLE_IDS.TECH_EVAL]
    );
    expect(backedUp).not.toBeNull();
    await db.none(`DELETE FROM tbl_dashboard_v3_cut_grants WHERE role_id = $1`, [ROLE_IDS.TECH_EVAL]);
  });
});
