// Buyer dashboard V3 — the runtime rollout switch and the server-side widget
// guard (docs/dashboard_v3/SPEC.md, "Access & rollout").
//
//   GET /dashboard-v2/config        tells the frontend which layout to render
//                                   for the caller's buyer company.
//   every widget endpoint           with the company's switch OFF behaves as
//                                   before (legacy layout, no widget gate); with
//                                   it ON requires the widget's dashboard.<code>
//                                   grant in the caller's role scopes for the
//                                   business units in view.
//
// Grants come from the seed migration (capability-based). Real HTTP + Postgres.

import { describe, it, expect, afterEach, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";

const setV3 = (companyId, on) =>
  db.none(`UPDATE tbl_company SET buyer_dashboard_v3 = $2 WHERE id = $1`, [companyId, on]);

const get = async (userId, path, query = {}) => {
  const client = await httpClient(userId);
  return client.get(`/api/v1/dashboard-v2${path}`).query(query);
};

/** Point every role scope a user holds at an empty custom role for the duration of fn. */
async function withNoGrants(userId, fn) {
  const empty = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by) VALUES ('empty probe', 'no permissions', $1) RETURNING id`,
    [userId]
  );
  const scopes = await db.any(`SELECT id, role_id FROM tbl_user_role_scopes WHERE user_id = $1`, [userId]);
  await db.none(`UPDATE tbl_user_role_scopes SET role_id = $1 WHERE user_id = $2`, [empty.id, userId]);
  try {
    return await fn();
  } finally {
    for (const s of scopes) {
      await db.none(`UPDATE tbl_user_role_scopes SET role_id = $1 WHERE id = $2`, [s.role_id, s.id]);
    }
    await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [empty.id]);
  }
}

afterEach(async () => {
  await setV3(IDS.companies.A, false);
  await setV3(IDS.companies.B, false);
});

afterAll(async () => {
  await closeDb();
});

describe("GET /dashboard-v2/config", () => {
  it("is off by default — every company keeps the legacy dashboard until switched", async () => {
    const res = await get(IDS.users.a1_proc_buyer, "/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 1, data: { v3_enabled: false } });
  });

  it("switching one company on changes only that company's users", async () => {
    await setV3(IDS.companies.A, true);
    const a = await get(IDS.users.a1_proc_buyer, "/config");
    const b = await get(IDS.users.companyB_admin, "/config");
    expect(a.body.data.v3_enabled).toBe(true);
    expect(b.body.data.v3_enabled).toBe(false);
  });

  it("names an active company administrator as the contact once V3 is on", async () => {
    const adminRole = await db.one(
      `SELECT id FROM tbl_roles WHERE title = 'Company Administrator' AND created_by IS NULL`
    );
    await setV3(IDS.companies.A, true);

    const none = await get(IDS.users.a1_proc_buyer, "/config");
    expect(none.body.data).toEqual({ v3_enabled: true });

    const scope = await db.one(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id) VALUES ($1, $2, $3) RETURNING id`,
      [IDS.users.companyA_admin, adminRole.id, IDS.hospitality.A]
    );
    try {
      const res = await get(IDS.users.a1_proc_buyer, "/config");
      expect(res.body.data).toEqual({ v3_enabled: true, admin_contact_email: "admin.a@test.local" });

      // Another company's buyers never see company A's administrator.
      await setV3(IDS.companies.B, true);
      const other = await get(IDS.users.companyB_admin, "/config");
      expect(other.body.data.admin_contact_email).toBeUndefined();
    } finally {
      await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [scope.id]);
    }
  });

  it("a vendor is refused", async () => {
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [IDS.users.vendor_alpha]);
    try {
      const res = await get(IDS.users.vendor_alpha, "/config");
      expect(res.status).toBe(403);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [IDS.users.vendor_alpha]);
    }
  });

  it("requires a signed-in user", async () => {
    const res = await get(null, "/config");
    expect(res.status).toBe(401);
  });
});

describe("widget guard — company switch OFF (legacy)", () => {
  it("serves widgets without checking dashboard grants, exactly as before", async () => {
    // A technical approver holds no RFQ-creator widgets…
    const res = await get(IDS.users.a1_proc_techApp, "/my-drafts");
    // …but the legacy layout never gated on them.
    expect(res.status).toBe(200);

    await withNoGrants(IDS.users.a1_proc_techApp, async () => {
      expect((await get(IDS.users.a1_proc_techApp, "/cost-intelligence")).status).toBe(200);
    });
  });
});

describe("widget guard — company switch ON", () => {
  it("refuses a widget the caller's roles do not grant, serves one they do", async () => {
    await setV3(IDS.companies.A, true);
    const denied = await get(IDS.users.a1_proc_techApp, "/my-drafts");
    expect(denied.status).toBe(403);
    expect(denied.body.status).toBe(0);

    expect((await get(IDS.users.a1_proc_techApp, "/my-tech-approvals-pending")).status).toBe(200);
    expect((await get(IDS.users.a1_proc_buyer, "/my-drafts")).status).toBe(200);
  });

  it("the switch is per company: company B's switch does not gate company A", async () => {
    await setV3(IDS.companies.B, true);
    expect((await get(IDS.users.a1_proc_techApp, "/my-drafts")).status).toBe(200);
  });

  it("a grant counts only in the business units it is scoped to; All BUs is the union", async () => {
    await setV3(IDS.companies.A, true);
    // dualRole: RFQ creator at A1, technical evaluator at A2.
    const u = IDS.users.dualRole;
    expect((await get(u, "/my-drafts", { hotel_ids: `${IDS.hotels.A1}` })).status).toBe(200);
    expect((await get(u, "/my-drafts", { hotel_ids: `${IDS.hotels.A2}` })).status).toBe(403);
    expect((await get(u, "/my-tech-evals-pending", { hotel_ids: `${IDS.hotels.A2}` })).status).toBe(200);
    expect((await get(u, "/my-tech-evals-pending", { hotel_ids: `${IDS.hotels.A1}` })).status).toBe(403);

    // Both BUs selected, or none (All BUs): the union of both roles' grants.
    const both = `${IDS.hotels.A1},${IDS.hotels.A2}`;
    expect((await get(u, "/my-drafts", { hotel_ids: both })).status).toBe(200);
    expect((await get(u, "/my-tech-evals-pending", { hotel_ids: both })).status).toBe(200);
    expect((await get(u, "/my-drafts")).status).toBe(200);
    expect((await get(u, "/my-tech-evals-pending")).status).toBe(200);
  });

  it("naming another tenant's business unit cannot borrow a grant", async () => {
    await setV3(IDS.companies.A, true);
    const res = await get(IDS.users.dualRole, "/my-drafts", { hotel_ids: `${IDS.hotels.B1}` });
    expect(res.status).toBe(403);
  });

  it("drill-down lists follow the Action Centre grant; the banner and config are never gated", async () => {
    await setV3(IDS.companies.A, true);
    await withNoGrants(IDS.users.a1_proc_techApp, async () => {
      const u = IDS.users.a1_proc_techApp;
      expect((await get(u, "/action-center")).status).toBe(403);
      expect((await get(u, "/pending-approvals")).status).toBe(403);
      expect((await get(u, "/rejected-pos")).status).toBe(403);
      expect((await get(u, "/no-response")).status).toBe(403);
      expect((await get(u, "/cost-intelligence")).status).toBe(403);

      expect((await get(u, "/buyer-status-banner")).status).toBe(200);
      const config = await get(u, "/config");
      expect(config.status).toBe(200);
      expect(config.body.data.v3_enabled).toBe(true);
    });

    // With its seeded grants back, the same user reaches the Action Centre and its lists.
    expect((await get(IDS.users.a1_proc_techApp, "/action-center")).status).toBe(200);
    expect((await get(IDS.users.a1_proc_techApp, "/pending-approvals")).status).toBe(200);
  });

  it("revoking a widget from a role takes effect on the next request", async () => {
    await setV3(IDS.companies.A, true);
    const perm = await db.one(
      `SELECT id FROM tbl_permissions WHERE resource::text = 'dashboard' AND action::text = 'cost_intelligence'`
    );
    const removed = await db.result(
      `DELETE FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [ROLE_IDS.TENDER_CREATOR, perm.id]
    );
    try {
      expect((await get(IDS.users.a1_proc_buyer, "/cost-intelligence")).status).toBe(403);
    } finally {
      if (removed.rowCount) {
        await db.none(
          `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2)`,
          [ROLE_IDS.TENDER_CREATOR, perm.id]
        );
      }
    }
    expect((await get(IDS.users.a1_proc_buyer, "/cost-intelligence")).status).toBe(200);
  });

  it("a vendor is still refused", async () => {
    await setV3(IDS.companies.A, true);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [IDS.users.vendor_alpha]);
    try {
      expect((await get(IDS.users.vendor_alpha, "/action-center")).status).toBe(403);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [IDS.users.vendor_alpha]);
    }
  });
});
