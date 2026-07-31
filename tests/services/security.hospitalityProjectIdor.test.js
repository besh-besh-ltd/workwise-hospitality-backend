// SECURITY — cross-tenant IDORs on the hospitality + project surfaces (P0).
// ----------------------------------------------------------------------------
// Every endpoint below took an id straight from the URL and answered without
// ever asking "does this row belong to the caller's tenant?":
//
//   GET  /hospitality/hotels/:hotel_id/documents   → GST / PAN / cancelled-cheque
//                                                    / MSME docs of ANY business
//                                                    unit (highest severity)
//   GET  /hospitality/rfq-hotels/:rfq_id           → BU roster of ANY RFQ
//   GET  /hospitality/user/:user_id/mappings       → org chart of ANY user
//   GET  /hospitality/project/:project_id/mappings → hospitality context of ANY project
//   POST /project/:project_id                      → full project detail
//   GET  /project/:project_id                      → project table data
//   GET  /project/project-budget/:project_id       → budget lines
//   GET  /project/available-budget/:project_id     → budget totals
//   GET  /project/:project_id/team                 → team roster (names/emails)
//   GET  /project/:project_id/hospitality-context  → hospitality mapping
//   GET  /project/user/:user_id/projects           → another user's project list
//
// The project handlers additionally conflated ROLE with MEMBERSHIP: a
// `user_type = 7` admin short-circuited every ownership check, so Tenant A's
// admin could read Tenant B's projects. Role is not membership — these tests
// pin that distinction.
//
// Product-level: real HTTP through the full middleware chain, real Postgres.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";

// Fixture users carry user_type NULL; the hospitality routes gate on acl([7])
// and the project routes on acl([2, 7, 8]). Patch the two company admins to 7
// for the duration of this suite (and the buyer to 2), restore afterwards.
const priorUserTypes = new Map();

const seeded = {
  hotelDocIds: [],
  projectIds: [],
  rfqIds: [],
};

// Company B objects (the victim tenant) + Company A objects (the control).
let projectB;
let projectA;
let rfqB;

async function setUserType(userId, value) {
  const row = await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [userId]);
  if (!priorUserTypes.has(userId)) priorUserTypes.set(userId, row.user_type);
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [userId, value]);
}

async function makeProject(ownerId, name) {
  const row = await db.one(
    `INSERT INTO tbl_projects (name, description, location, user_id, status, budget)
     VALUES ($1, 'idor fixture', 'nowhere', $2, 1, 100000)
     RETURNING id`,
    [name, ownerId]
  );
  seeded.projectIds.push(row.id);
  return row.id;
}

async function makeRfq(createdBy, hospitalityCompanyId, hotelId) {
  const row = await db.one(
    `INSERT INTO tbl_rfq
       (comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, created_by, updated_by, status,
        hospitality_company_id, hotel_id, department_id, title)
     VALUES ('idor fixture', 'Tenant B', 'b@test.local', 'B Contact', '9999999999',
             '2099-01-01', 'B City', $1, $1, 1, $2, $3, $4, 'Tenant B RFQ')
     RETURNING id`,
    [createdBy, hospitalityCompanyId, hotelId, IDS.departments.proc]
  );
  seeded.rfqIds.push(row.id);
  await db.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
    [row.id, hotelId, createdBy]
  );
  return row.id;
}

beforeAll(async () => {
  await setUserType(IDS.users.companyA_admin, 7);
  await setUserType(IDS.users.companyB_admin, 7);
  await setUserType(IDS.users.a1_proc_buyer, 2);

  // A GST + bank document on a Company-B business unit — the crown jewels.
  for (const [type, number] of [["gst", "B-GST-SECRET-0001"], ["pan", "BPANQ1234B"]]) {
    const row = await db.one(
      `INSERT INTO tbl_hospitality_hotel_documents
         (hospitality_hotel_id, document_type, document_url, document_number)
       VALUES ($1, $2, 'https://s3.test/secret.pdf', $3)
       ON CONFLICT (hospitality_hotel_id, document_type)
       DO UPDATE SET document_number = EXCLUDED.document_number
       RETURNING id`,
      [IDS.hotels.B1, type, number]
    );
    seeded.hotelDocIds.push(row.id);
  }
  // Control: a document on a Company-A business unit.
  const aDoc = await db.one(
    `INSERT INTO tbl_hospitality_hotel_documents
       (hospitality_hotel_id, document_type, document_url, document_number)
     VALUES ($1, 'gst', 'https://s3.test/a.pdf', 'A-GST-OWN-0001')
     ON CONFLICT (hospitality_hotel_id, document_type)
     DO UPDATE SET document_number = EXCLUDED.document_number
     RETURNING id`,
    [IDS.hotels.A1]
  );
  seeded.hotelDocIds.push(aDoc.id);

  // Give the Company-B business units an email + fee so the payment-link
  // endpoints would otherwise succeed — otherwise they 400 on "no email
  // configured" and the tenant test would pass for the wrong reason.
  await db.none(
    `UPDATE tbl_hospitality_company_hotels
        SET email = 'bu-' || id || '@tenantb.test', fee_amount = 500
      WHERE id = ANY($1::int[])`,
    [[IDS.hotels.B1, IDS.hotels.B2]]
  );

  projectB = await makeProject(IDS.users.companyB_admin, "Tenant B Secret Project");
  projectA = await makeProject(IDS.users.companyA_admin, "Tenant A Own Project");
  await db.none(
    `INSERT INTO tbl_hospitality_project_mappings
       (project_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
     VALUES ($1, $2, NULL, 0, $3)`,
    [projectB, IDS.hospitality.B, IDS.users.companyB_admin]
  );
  await db.none(
    `INSERT INTO tbl_hospitality_project_mappings
       (project_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
     VALUES ($1, $2, NULL, 0, $3)`,
    [projectA, IDS.hospitality.A, IDS.users.companyA_admin]
  );

  rfqB = await makeRfq(IDS.users.companyB_admin, IDS.hospitality.B, IDS.hotels.B1);
});

afterAll(async () => {
  await db.none(
    `UPDATE tbl_hospitality_company_hotels SET email = NULL WHERE id = ANY($1::int[])`,
    [[IDS.hotels.B1, IDS.hotels.B2]]
  );
  if (seeded.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [seeded.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [seeded.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [seeded.rfqIds]);
  }
  if (seeded.projectIds.length) {
    await db.none(`DELETE FROM tbl_hospitality_project_mappings WHERE project_id = ANY($1::int[])`, [seeded.projectIds]);
    await db.none(`DELETE FROM tbl_project_team WHERE project_id = ANY($1::int[])`, [seeded.projectIds]);
    await db.none(`DELETE FROM tbl_projects WHERE id = ANY($1::int[])`, [seeded.projectIds]);
  }
  if (seeded.hotelDocIds.length) {
    await db.none(`DELETE FROM tbl_hospitality_hotel_documents WHERE id = ANY($1::int[])`, [seeded.hotelDocIds]);
  }
  for (const [userId, value] of priorUserTypes.entries()) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [userId, value]);
  }
  await closeDb();
});

const DENIED = [400, 403, 404];

// ---------------------------------------------------------------------------
// 1. GET /hospitality/hotels/:hotel_id/documents  — HIGHEST PRIORITY
// ---------------------------------------------------------------------------
describe("SECURITY: GET /hospitality/hotels/:hotel_id/documents", () => {
  it("does NOT return another tenant's GST/PAN/bank documents", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/hospitality/hotels/${IDS.hotels.B1}/documents`);

    expect(DENIED).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain("B-GST-SECRET-0001");
    expect(JSON.stringify(res.body)).not.toContain("BPANQ1234B");
  });

  it("still returns the caller's OWN business-unit documents", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/hospitality/hotels/${IDS.hotels.A1}/documents`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(JSON.stringify(res.body)).toContain("A-GST-OWN-0001");
  });

  it("404s a non-existent business unit instead of leaking existence", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/hospitality/hotels/99999999/documents`);
    expect(DENIED).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// 1b. Payment-link admin actions — same missing tenant check, write side.
// These email another tenant's business unit and flip its payment_status.
// (The PUBLIC /hotel-payment/* endpoints are a separate, deliberate product
// decision and are intentionally left alone.)
// ---------------------------------------------------------------------------
describe("SECURITY: payment-link admin actions are tenant-scoped", () => {
  it("send-payment-link refuses another tenant's business unit", async () => {
    const before = await db.one(
      `SELECT payment_status FROM tbl_hospitality_company_hotels WHERE id = $1`,
      [IDS.hotels.B1]
    );

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client
      .post(`/api/v1/hospitality/company/${IDS.hospitality.A}/hotels/${IDS.hotels.B1}/send-payment-link`)
      .send({});

    expect(DENIED).toContain(res.status);
    const after = await db.one(
      `SELECT payment_status FROM tbl_hospitality_company_hotels WHERE id = $1`,
      [IDS.hotels.B1]
    );
    expect(after.payment_status).toBe(before.payment_status);
  });

  it("send-batch-payment-links refuses another tenant's business units", async () => {
    const before = await db.one(
      `SELECT payment_status FROM tbl_hospitality_company_hotels WHERE id = $1`,
      [IDS.hotels.B2]
    );

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post(`/api/v1/hospitality/company/send-batch-payment-links`).send({
      company_id: IDS.hospitality.B,
      payment_mode: "bu",
      hotel_ids: [IDS.hotels.B1, IDS.hotels.B2],
    });

    expect(DENIED).toContain(res.status);
    const after = await db.one(
      `SELECT payment_status FROM tbl_hospitality_company_hotels WHERE id = $1`,
      [IDS.hotels.B2]
    );
    expect(after.payment_status).toBe(before.payment_status);
  });
});

// ---------------------------------------------------------------------------
// 2. GET /hospitality/rfq-hotels/:rfq_id
// ---------------------------------------------------------------------------
describe("SECURITY: GET /hospitality/rfq-hotels/:rfq_id", () => {
  it("does NOT expose another tenant's RFQ business units", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/hospitality/rfq-hotels/${rfqB}`);

    expect(DENIED).toContain(res.status);
    expect(JSON.stringify(res.body ?? {})).not.toContain("Hotel B-1");
  });

  it("returns the RFQ's business units to the owning tenant", async () => {
    const client = await httpClient(IDS.users.companyB_admin);
    const res = await client.get(`/api/v1/hospitality/rfq-hotels/${rfqB}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.map((r) => Number(r.hotel_id))).toContain(IDS.hotels.B1);
  });

  it("returns the RFQ's business units to a vendor invited on that RFQ", async () => {
    const variant = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`);
    expect(variant).toBeTruthy();
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id)
       VALUES ($1, $2, $3)`,
      [rfqB, variant.id, IDS.users.vendor_alpha]
    );

    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(`/api/v1/hospitality/rfq-hotels/${rfqB}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => Number(r.hotel_id))).toContain(IDS.hotels.B1);
  });
});

// ---------------------------------------------------------------------------
// 3. GET /hospitality/user/:user_id/mappings
// ---------------------------------------------------------------------------
describe("SECURITY: GET /hospitality/user/:user_id/mappings", () => {
  it("does NOT return another tenant's user mappings", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/hospitality/user/${IDS.users.companyB_admin}/mappings`);

    expect(DENIED).toContain(res.status);
    const payload = JSON.stringify(res.body ?? {});
    expect(payload).not.toContain(`"hospitality_company_id":${IDS.hospitality.B}`);
  });

  it("still returns mappings for a user inside the caller's own tenant", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/hospitality/user/${IDS.users.a1_proc_buyer}/mappings`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const m of res.body.data) {
      expect(Number(m.hospitality_company_id)).toBe(IDS.hospitality.A);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. GET /hospitality/project/:project_id/mappings
// ---------------------------------------------------------------------------
describe("SECURITY: GET /hospitality/project/:project_id/mappings", () => {
  it("does NOT return another tenant's project mappings", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/hospitality/project/${projectB}/mappings`);

    expect(DENIED).toContain(res.status);
    expect(JSON.stringify(res.body ?? {})).not.toContain("Hospitality B");
  });

  it("still returns the caller's own project mappings", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/hospitality/project/${projectA}/mappings`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Project detail family — role is NOT membership
// ---------------------------------------------------------------------------
describe("SECURITY: project endpoints — a user_type=7 admin is not a member of every tenant", () => {
  const cases = [
    ["POST project detail", (c, id) => c.post(`/api/v1/project/${id}`).send({})],
    ["GET project table data", (c, id) => c.get(`/api/v1/project/${id}`)],
    ["GET project budget", (c, id) => c.get(`/api/v1/project/project-budget/${id}`)],
    ["GET available budget", (c, id) => c.get(`/api/v1/project/available-budget/${id}`)],
    ["GET project team", (c, id) => c.get(`/api/v1/project/${id}/team`)],
    ["GET hospitality context", (c, id) => c.get(`/api/v1/project/${id}/hospitality-context`)],
  ];

  for (const [label, call] of cases) {
    it(`${label}: Tenant A admin is refused on a Tenant B project`, async () => {
      const client = await httpClient(IDS.users.companyA_admin);
      const res = await call(client, projectB);

      expect(DENIED).toContain(res.status);
      expect(JSON.stringify(res.body ?? {})).not.toContain("Tenant B Secret Project");
    });
  }

  it("POST project detail: the owning tenant's admin still gets 200", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post(`/api/v1/project/${projectA}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
  });

  it("GET project team: the owning tenant's admin still gets 200", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/project/${projectA}/team`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Project write-side — same role-vs-membership defect
// ---------------------------------------------------------------------------
describe("SECURITY: project write endpoints reject cross-tenant callers", () => {
  it("PUT /project/update/:id does not let Tenant A rewrite a Tenant B project", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.put(`/api/v1/project/update/${projectB}`).send({
      name: "HIJACKED",
      description: "x",
      location: "x",
      status: 1,
      budget: 1,
    });

    expect(DENIED).toContain(res.status);
    const after = await db.one(`SELECT name FROM tbl_projects WHERE id = $1`, [projectB]);
    expect(after.name).toBe("Tenant B Secret Project");
  });

  it("POST /project/:id/team does not let Tenant A add itself to a Tenant B project", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post(`/api/v1/project/${projectB}/team`).send({
      user_id: IDS.users.companyA_admin,
      role: 1,
    });

    expect(DENIED).toContain(res.status);
    const rows = await db.any(
      `SELECT 1 FROM tbl_project_team WHERE project_id = $1 AND user_id = $2`,
      [projectB, IDS.users.companyA_admin]
    );
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. GET /project/user/:user_id/projects
// ---------------------------------------------------------------------------
describe("SECURITY: GET /project/user/:user_id/projects", () => {
  it("does NOT return another tenant's user's projects", async () => {
    await db.none(
      `INSERT INTO tbl_project_team (project_id, user_id, role, created_by) VALUES ($1, $2, 1, $2)`,
      [projectB, IDS.users.companyB_admin]
    );

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/project/user/${IDS.users.companyB_admin}/projects`);

    expect(DENIED).toContain(res.status);
    expect(JSON.stringify(res.body ?? {})).not.toContain("Tenant B Secret Project");
  });

  it("still returns projects for a user inside the caller's own tenant", async () => {
    await db.none(
      `INSERT INTO tbl_project_team (project_id, user_id, role, created_by) VALUES ($1, $2, 1, $2)`,
      [projectA, IDS.users.a1_proc_buyer]
    );

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/project/user/${IDS.users.a1_proc_buyer}/projects`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
  });
});
