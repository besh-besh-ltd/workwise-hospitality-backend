// SECURITY — approval policy / instance tenant scoping (P0, cross-tenant).
// ----------------------------------------------------------------------------
// Two defects, one cluster:
//
//  (a) GET /general/hospitality/approval/policies seeded its WHERE with
//      `TRUE` and only added the company filter `if (hospitality_company_id)`.
//      Omitting the query param dumped EVERY tenant's policies (137 active
//      policies / 10 hospitality companies / 2 tenants in production),
//      including company + hotel + creator names.
//
//  (b) The per-id endpoints (/policies/:id, /:id/department-preview,
//      /:id/pending-impact, /instance/:id, /instance/:id/change-history,
//      /entity/:type/:id) filtered on `WHERE p.id = $1` / `WHERE i.id = $1`
//      with no tenant column — a classic IDOR over 3,846 live approval
//      instances that expose approver names + emails.
//
// Scope must be derived from req.user, never from the query string. These are
// product-level tests over real HTTP.

import { describe, it, expect, afterAll, beforeAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { getApprovalPolicies } from "../../app/models/generalModel.js";

// acl([7, 2]) keys off tbl_users.user_type; fixture users have it NULL.
// Stamp the two admins as buyers (2) for the whole suite, restore afterwards.
const prevUserTypes = {};
const AS_BUYER = [IDS.users.companyA_admin, IDS.users.companyB_admin, IDS.users.a1_proc_buyer];

beforeAll(async () => {
  for (const uid of AS_BUYER) {
    const row = await db.one(`SELECT user_type FROM tbl_users WHERE id=$1`, [uid]);
    prevUserTypes[uid] = row.user_type;
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id=$1`, [uid]);
  }
});

// Single afterAll: the restore must complete BEFORE the pool is destroyed.
afterAll(async () => {
  for (const uid of AS_BUYER) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id=$1`, [uid, prevUserTypes[uid]]);
  }
  await closeDb();
});

const inserted = { instanceIds: [], stepIds: [], approverIds: [] };

afterEach(async () => {
  if (inserted.approverIds.length) {
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE id = ANY($1::int[])`, [inserted.approverIds]);
  }
  if (inserted.stepIds.length) {
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE id = ANY($1::int[])`, [inserted.stepIds]);
  }
  if (inserted.instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [inserted.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inserted.instanceIds]);
  }
  inserted.instanceIds = [];
  inserted.stepIds = [];
  inserted.approverIds = [];
});

async function makeInstance({ hospitality, hotel, policyId, entityType = "RFQ", entityId = 999001 }) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by)
     VALUES ($1, $2, $3, 'PENDING', 1, $4, $5, NULL, $6)
     RETURNING id`,
    [entityType, entityId, policyId, hospitality, hotel, IDS.users.companyA_admin]
  );
  inserted.instanceIds.push(inst.id);

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`,
    [inst.id]
  );
  inserted.stepIds.push(step.id);

  const appr = await db.one(
    `INSERT INTO tbl_approval_step_approvers
       (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING') RETURNING id`,
    [step.id, IDS.users.companyB_admin]
  );
  inserted.approverIds.push(appr.id);

  return inst.id;
}

const B_POLICY = IDS.policies.B1_P1_RFQ;
const A_POLICY = IDS.policies.A1_P1_RFQ;

// ---------------------------------------------------------------------------
describe("SECURITY: GET /general/hospitality/approval/policies", () => {
  it("with NO query param returns ONLY the caller's own company policies", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get("/api/v1/general/hospitality/approval/policies");

    expect(res.status).toBe(200);
    const rows = res.body.data || [];
    expect(rows.length).toBeGreaterThan(0);

    const companies = [...new Set(rows.map((r) => r.hospitality_company_id))];
    expect(companies).toEqual([IDS.hospitality.A]);
    expect(rows.map((r) => r.id)).not.toContain(B_POLICY);
  });

  it("explicitly passing another tenant's company id does NOT widen the result", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(
      `/api/v1/general/hospitality/approval/policies?hospitality_company_id=${IDS.hospitality.B}`
    );

    const rows = res.body?.data || [];
    // Either refused outright, or scoped back to A — never B's rows.
    expect(rows.map((r) => r.id)).not.toContain(B_POLICY);
    for (const r of rows) {
      expect(r.hospitality_company_id).not.toBe(IDS.hospitality.B);
    }
  });

  it("the Approval Wizard happy path (own company_id + hotel_id + include=steps) still works", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(
      `/api/v1/general/hospitality/approval/policies?hospitality_company_id=${IDS.hospitality.A}&hotel_id=${IDS.hotels.A1}&include=steps`
    );

    expect(res.status).toBe(200);
    const rows = res.body.data || [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.id === A_POLICY)).toBe(true);
    expect(rows.some((r) => Array.isArray(r.steps) && r.steps.length > 0)).toBe(true);
  });

  it("a company-B admin sees B's policies and none of A's", async () => {
    const client = await httpClient(IDS.users.companyB_admin);
    const res = await client.get("/api/v1/general/hospitality/approval/policies");

    expect(res.status).toBe(200);
    const rows = res.body.data || [];
    const companies = [...new Set(rows.map((r) => r.hospitality_company_id))];
    expect(companies).toEqual([IDS.hospitality.B]);
    expect(rows.map((r) => r.id)).not.toContain(A_POLICY);
  });

  it("the model fails CLOSED when no company scope is supplied (no accidental TRUE seed)", async () => {
    await expect(getApprovalPolicies({})).rejects.toThrow();
    await expect(getApprovalPolicies({ hospitality_company_ids: [] })).resolves.toEqual([]);
  });

  it("super admin scope (null company set) still sees every tenant", async () => {
    // user_type 8 is the documented super-admin bypass; assert it at the model
    // boundary because the route's acl([7, 2]) gate does not admit type 8.
    const rows = await getApprovalPolicies({ hospitality_company_ids: null });
    const companies = new Set(rows.map((r) => r.hospitality_company_id));
    expect(companies.has(IDS.hospitality.A)).toBe(true);
    expect(companies.has(IDS.hospitality.B)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("SECURITY: approval policy IDOR (per-id endpoints)", () => {
  it("GET /policies/:id 404s for another tenant's policy", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/general/hospitality/approval/policies/${B_POLICY}`);
    expect(res.status).toBe(404);
    expect(res.body.status).not.toBe(1);
  });

  it("GET /policies/:id still returns the caller's OWN policy", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/general/hospitality/approval/policies/${A_POLICY}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(A_POLICY);
  });

  it("GET /policies/:id/department-preview 404s across tenants", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(
      `/api/v1/general/hospitality/approval/policies/${B_POLICY}/department-preview`
    );
    expect(res.status).toBe(404);
  });

  it("GET /policies/:id/pending-impact 404s across tenants", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(
      `/api/v1/general/hospitality/approval/policies/${B_POLICY}/pending-impact`
    );
    expect(res.status).toBe(404);
  });

  it("DELETE /policies/:id 404s across tenants and leaves the policy active", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.delete(`/api/v1/general/hospitality/approval/policies/${B_POLICY}`);
    expect(res.status).toBe(404);
    const after = await db.one(`SELECT is_active FROM tbl_approval_policies WHERE id=$1`, [B_POLICY]);
    expect(after.is_active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("SECURITY: approval instance IDOR", () => {
  it("GET /instance/:id 404s for another tenant's instance", async () => {
    const instId = await makeInstance({
      hospitality: IDS.hospitality.B, hotel: IDS.hotels.B1, policyId: B_POLICY,
    });

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/general/hospitality/approval/instance/${instId}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("admin.b@test.local");
  });

  it("GET /instance/:id still returns the caller's OWN instance", async () => {
    const instId = await makeInstance({
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, policyId: A_POLICY,
    });

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/general/hospitality/approval/instance/${instId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(instId);
  });

  it("GET /instance/:id/change-history 404s across tenants", async () => {
    const instId = await makeInstance({
      hospitality: IDS.hospitality.B, hotel: IDS.hotels.B1, policyId: B_POLICY,
    });

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(
      `/api/v1/general/hospitality/approval/instance/${instId}/change-history`
    );
    expect(res.status).toBe(404);
  });

  it("GET /entity/:type/:id hides another tenant's instances", async () => {
    const bInst = await makeInstance({
      hospitality: IDS.hospitality.B, hotel: IDS.hotels.B1, policyId: B_POLICY,
      entityType: "RFQ", entityId: 999042,
    });

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/general/hospitality/approval/entity/RFQ/999042`);
    const rows = res.body?.data || [];
    expect(rows.map((r) => r.id)).not.toContain(bInst);
  });

  it("GET /entity/:type/:id still returns the caller's OWN instances", async () => {
    const aInst = await makeInstance({
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, policyId: A_POLICY,
      entityType: "RFQ", entityId: 999043,
    });

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/general/hospitality/approval/entity/RFQ/999043`);
    expect(res.status).toBe(200);
    expect((res.body.data || []).map((r) => r.id)).toContain(aInst);
  });
});

// ---------------------------------------------------------------------------
describe("SECURITY: role gates on the previously ungated approval routes", () => {
  it("a VENDOR is blocked from /policies/match", async () => {
    const prev = await db.one(`SELECT user_type FROM tbl_users WHERE id=$1`, [IDS.users.vendor_alpha]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id=$1`, [IDS.users.vendor_alpha]);
    try {
      const client = await httpClient(IDS.users.vendor_alpha);
      const res = await client.get(
        `/api/v1/general/hospitality/approval/policies/match?entity_type=RFQ&hospitality_company_id=${IDS.hospitality.A}`
      );
      expect(res.status).toBe(403);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id=$1`, [IDS.users.vendor_alpha, prev.user_type]);
    }
  });

  it("a VENDOR is blocked from /entity/:type/:id", async () => {
    const prev = await db.one(`SELECT user_type FROM tbl_users WHERE id=$1`, [IDS.users.vendor_alpha]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id=$1`, [IDS.users.vendor_alpha]);
    try {
      const client = await httpClient(IDS.users.vendor_alpha);
      const res = await client.get(`/api/v1/general/hospitality/approval/entity/RFQ/1`);
      expect(res.status).toBe(403);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id=$1`, [IDS.users.vendor_alpha, prev.user_type]);
    }
  });

  it("/policies/match does not resolve a policy in another tenant", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(
      `/api/v1/general/hospitality/approval/policies/match?entity_type=RFQ&hospitality_company_id=${IDS.hospitality.B}&hotel_id=${IDS.hotels.B1}`
    );
    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body || {})).not.toContain(`"id":${B_POLICY}`);
  });

  it("/policies/match still resolves the caller's own policy", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(
      `/api/v1/general/hospitality/approval/policies/match?entity_type=RFQ&hospitality_company_id=${IDS.hospitality.A}&hotel_id=${IDS.hotels.A1}&process_id=${IDS.processes.A_P1}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.hospitality_company_id).toBe(IDS.hospitality.A);
  });
});
