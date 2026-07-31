// SECURITY + P0 — GET /general/hospitality/approval/processes company bridging.
// ----------------------------------------------------------------------------
// Two ID spaces are conflated on this endpoint:
//
//   tbl_approval_policies.hospitality_company_id -> tbl_hospitality_companies.id
//   tbl_approval_processes.company_id            -> tbl_company.id  (BUYER company)
//
// The Approval Hierarchy admin page (?companyId=<hospitality id>) sends the SAME
// id to both. Policies match; processes match zero rows, so the workflow list
// renders blank while the KPI row (fed by policies) reports 7 stages / 13 levels.
// Verified in production: hospitality company 4 -> buyer_company_id 13; all 7 of
// its active policies carry process_id 2, owned by tbl_company 13; tbl_company
// has no id 4. Every hospitality company is affected (none has id = its own
// buyer_company_id).
//
// The same line is a cross-tenant leak: the query param was parsed straight into
// the WHERE clause with NO ownership check, so a user_type=7 admin could
// enumerate any buyer company's process catalog. In production hospitality
// company 13 ("Workwise Hotels", buyer 90) collides numerically with buyer
// company 13 (Phileein Hospitality) and renders Phileein's process names.
//
// Fix: treat an incoming company_id as a HOSPITALITY id, verify ownership
// against the request's server-derived scope (404 on miss), then translate via
// tbl_hospitality_companies.buyer_company_id before querying processes. With no
// param, the req.user.company_id fallback is unchanged (CreateRFQ.js relies on
// it and the user_type=2 branch must not move).
//
// Product-level tests over real HTTP.

import { describe, it, expect, afterAll, beforeAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { getApprovalProcesses } from "../../app/models/generalModel.js";

const URL = "/api/v1/general/hospitality/approval/processes";

// Fixture users carry user_type NULL; the route is acl([7, 2]). Stamp per-test.
const prevUserTypes = {};
const STAMPED = [IDS.users.companyA_admin, IDS.users.companyB_admin, IDS.users.superAdmin];

async function asUserType(userId, userType) {
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [userId, userType]);
  return httpClient(userId);
}

beforeAll(async () => {
  for (const uid of STAMPED) {
    const row = await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [uid]);
    prevUserTypes[uid] = row.user_type;
  }
});

afterAll(async () => {
  for (const uid of STAMPED) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [uid, prevUserTypes[uid]]);
  }
  await closeDb();
});

const ids = (res) => (res.body?.data || []).map((r) => Number(r.id));

// ---------------------------------------------------------------------------
describe("GET approval/processes — hospitality → buyer company bridge (P0)", () => {
  it("a user_type=7 admin passing a HOSPITALITY company id gets that tenant's processes", async () => {
    // Hospitality A (10001) belongs to buyer company A (90001), which owns
    // processes A_P1 + A_P2. Today the id is used verbatim as a buyer id, so
    // `WHERE p.company_id = 10001` matches nothing and the page renders blank.
    const client = await asUserType(IDS.users.companyA_admin, 7);
    const res = await client.get(`${URL}?company_id=${IDS.hospitality.A}`);

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(expect.arrayContaining([IDS.processes.A_P1, IDS.processes.A_P2]));
    expect(ids(res)).not.toContain(IDS.processes.B_P1);
  });

  it("every returned row belongs to the bridged BUYER company, not the hospitality id", async () => {
    const client = await asUserType(IDS.users.companyA_admin, 7);
    const res = await client.get(`${URL}?company_id=${IDS.hospitality.A}`);

    expect(res.status).toBe(200);
    const rows = res.body?.data || [];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Number(r.company_id)).toBe(IDS.companies.A);
  });
});

// ---------------------------------------------------------------------------
describe("GET approval/processes — ownership check (P1, cross-tenant)", () => {
  it("404s when a user_type=7 admin asks for a hospitality company under another buyer", async () => {
    const client = await asUserType(IDS.users.companyA_admin, 7);
    const res = await client.get(`${URL}?company_id=${IDS.hospitality.B}`);

    expect(res.status).toBe(404);
    expect(res.body?.status).not.toBe(1);
    // No process names / ids from the other tenant may appear in the body.
    const body = JSON.stringify(res.body || {});
    expect(body).not.toContain("Company B's mainline process");
    expect(body).not.toContain(String(IDS.processes.B_P1));
  });

  it("does NOT leak a buyer company's catalog when its id numerically collides with a hospitality id", async () => {
    // Production shape: hospitality company 13 is owned by buyer 90, yet buyer
    // company 13 also exists — the unchecked param rendered buyer 13's rows.
    // Here: buyer company B (90002) is not a hospitality id A's admin owns.
    const client = await asUserType(IDS.users.companyA_admin, 7);
    const res = await client.get(`${URL}?company_id=${IDS.companies.B}`);

    expect(res.status).toBe(404);
    expect(ids(res)).not.toContain(IDS.processes.B_P1);
  });

  it("the other tenant's own admin still sees their own processes", async () => {
    const client = await asUserType(IDS.users.companyB_admin, 7);
    const res = await client.get(`${URL}?company_id=${IDS.hospitality.B}`);

    expect(res.status).toBe(200);
    expect(ids(res)).toContain(IDS.processes.B_P1);
    expect(ids(res)).not.toContain(IDS.processes.A_P1);
  });
});

// ---------------------------------------------------------------------------
describe("GET approval/processes — untouched branches", () => {
  it("user_type=2 ignores the company_id param and returns its OWN company's processes", async () => {
    const client = await asUserType(IDS.users.companyA_admin, 2);
    const res = await client.get(`${URL}?company_id=${IDS.hospitality.B}`);

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(expect.arrayContaining([IDS.processes.A_P1, IDS.processes.A_P2]));
    expect(ids(res)).not.toContain(IDS.processes.B_P1);
  });

  it("no param at all falls back to req.user.company_id (CreateRFQ.js contract)", async () => {
    for (const ut of [2, 7]) {
      const client = await asUserType(IDS.users.companyA_admin, ut);
      const res = await client.get(URL);

      expect(res.status).toBe(200);
      expect(ids(res)).toEqual(expect.arrayContaining([IDS.processes.A_P1, IDS.processes.A_P2]));
      expect(ids(res)).not.toContain(IDS.processes.B_P1);
    }
  });

  it("existing filters (include_inactive, process_type) still apply after bridging", async () => {
    const client = await asUserType(IDS.users.companyA_admin, 7);
    const res = await client.get(`${URL}?company_id=${IDS.hospitality.A}&process_type=RFQ`);

    expect(res.status).toBe(200);
    const rows = res.body?.data || [];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.process_type).toBe("RFQ");
  });
});

// ---------------------------------------------------------------------------
// The no-param path had a second, independent fail-OPEN: the controller passed
// `undefined` when req.user.company_id was NULL, and the model's `if (company_id)`
// then dropped the company predicate entirely and returned every tenant's
// catalog. Production has one active user_type-7 admin with company_id NULL, so
// this was live, not theoretical — and it is the same shape already closed in
// getApprovalPolicies (which used to seed its WHERE with 'TRUE'). Keeping the two
// consistent is what stops the defect reappearing.
describe("GET approval/processes — fail closed when no company can be derived", () => {
  it("a user_type=7 caller with a NULL company_id gets NOTHING, not every tenant's catalog", async () => {
    const client = await asUserType(IDS.users.superAdmin, 7); // fixture user with company_id NULL
    const res = await client.get(URL);

    expect(res.status).toBe(200);
    expect(res.body?.data || []).toEqual([]);
    expect(ids(res)).not.toContain(IDS.processes.A_P1);
    expect(ids(res)).not.toContain(IDS.processes.A_P2);
    expect(ids(res)).not.toContain(IDS.processes.B_P1);
  });

  it("a caller WITH a parent company still gets exactly their own catalog", async () => {
    const client = await asUserType(IDS.users.companyA_admin, 2);
    const res = await client.get(URL);

    expect(res.status).toBe(200);
    expect(ids(res).sort((a, b) => a - b)).toEqual([IDS.processes.A_P1, IDS.processes.A_P2]);
  });

  it("the model refuses a missing scope and bypasses only on an EXPLICIT null", async () => {
    // Mirrors the getApprovalPolicies contract: undefined = programming error,
    // null = deliberate super-admin bypass. Asserted at the model boundary
    // because the route's acl([7, 2]) gate does not admit user_type 8.
    await expect(getApprovalProcesses({})).rejects.toThrow();

    const all = (await getApprovalProcesses({ company_id: null })).map((r) => Number(r.id));
    expect(all).toEqual(expect.arrayContaining([IDS.processes.A_P1, IDS.processes.B_P1]));
  });
});
