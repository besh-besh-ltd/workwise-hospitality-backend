/**
 * Reading company-wide events.
 *
 * A company-wide event — a role, an approval workflow, the company profile —
 * names a buyer company and no hospitality company. The reads used to be
 * scoped by hospitality company alone, so such a row would have been written
 * and then shown to nobody. These tests pin both halves: the company's own
 * administrators see it in the list, the facets and the detail; another
 * company's administrator sees none of it, whatever they put in the query.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

const ADMIN_A = IDS.users.companyA_admin;
const ADMIN_B = IDS.users.companyB_admin;
const BUYER_A = IDS.companies.A;

let restore;

const seed = ({ hospitality = null, buyer = null, hotel = null, summary, category = "Roles & Access", requestId = null }) =>
  db.one(
    `INSERT INTO tbl_activity_events
       (source, event_key, category, severity, actor_type, actor_user_id, actor_label,
        hospitality_company_id, buyer_company_id, hotel_id, summary, request_id)
     VALUES ('HTTP', 'probe', $1, 'critical', 'USER', $2, 'Probe Admin', $3, $4, $5, $6, $7)
     RETURNING id`,
    [category, ADMIN_A, hospitality, buyer, hotel, summary, requestId]
  );

beforeAll(async () => {
  restore = await db.any(
    `SELECT id, user_type FROM tbl_users WHERE id IN ($1, $2)`, [ADMIN_A, ADMIN_B]
  );
  await db.none(`UPDATE tbl_users SET user_type = 7 WHERE id IN ($1, $2)`, [ADMIN_A, ADMIN_B]);
});

beforeEach(() => db.none(`DELETE FROM tbl_activity_events WHERE event_key = 'probe'`));

afterAll(async () => {
  await db.none(`DELETE FROM tbl_activity_events WHERE event_key = 'probe'`);
  for (const r of restore) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [r.id, r.user_type]);
  }
  await closeDb();
});

describe("company-wide events in the activity feed", () => {
  it("can only be written when they name a company of some kind", async () => {
    await expect(seed({ summary: "belongs nowhere" })).rejects.toThrow(/chk_activity_company_scope/);
  });

  it("fills the buyer company on every hospitality-scoped row", async () => {
    // Written by hand, the way the backfill sources and system events write —
    // the trigger supplies what they do not know to set.
    const { id } = await seed({ hospitality: IDS.hospitality.A, summary: "unit-level" });
    const row = await db.one(`SELECT buyer_company_id FROM tbl_activity_events WHERE id = $1`, [id]);
    expect(row.buyer_company_id).toBe(BUYER_A);
  });

  it("appear for the company's own administrator, alongside unit events", async () => {
    await seed({ buyer: BUYER_A, summary: "A changed the role Probe" });
    await seed({ hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, summary: "A did something at A1" });

    const client = await httpClient(ADMIN_A);
    const res = await client.get("/api/v1/activity");
    expect(res.status).toBe(200);
    const summaries = res.body.data.rows.filter((r) => r.event_key === "probe").map((r) => r.summary);
    expect(summaries).toEqual(expect.arrayContaining(["A changed the role Probe", "A did something at A1"]));
  });

  it("never appear for another company's administrator, whatever the query", async () => {
    await seed({ buyer: BUYER_A, summary: "A company-wide secret" });
    const client = await httpClient(ADMIN_B);

    for (const qs of [
      {},
      { company_id: BUYER_A },
      { buyer_company_id: BUYER_A },
      { hospitality_company_id: IDS.hospitality.A },
      { q: "secret" },
    ]) {
      const res = await client.get("/api/v1/activity").query(qs);
      expect(res.status).toBe(200);
      expect(res.body.data.rows.filter((r) => r.event_key === "probe")).toEqual([]);
    }
    const facets = await client.get("/api/v1/activity/facets");
    const roles = facets.body.data.categories.find((c) => c.category === "Roles & Access");
    expect(roles).toBeUndefined();
  });

  it("are left out when filtering by business unit — they happened at no unit", async () => {
    await seed({ buyer: BUYER_A, summary: "company-wide" });
    await seed({ hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, summary: "at A1" });

    const client = await httpClient(ADMIN_A);
    const res = await client.get("/api/v1/activity").query({ hotel_id: IDS.hotels.A1 });
    const summaries = res.body.data.rows.filter((r) => r.event_key === "probe").map((r) => r.summary);
    expect(summaries).toEqual(["at A1"]);
  });

  it("count towards the category and severity facets", async () => {
    await seed({ buyer: BUYER_A, summary: "company-wide", category: "Approval Setup" });
    const client = await httpClient(ADMIN_A);
    const res = await client.get("/api/v1/activity/facets");
    expect(res.status).toBe(200);
    const setup = res.body.data.categories.find((c) => c.category === "Approval Setup");
    expect(setup?.count).toBeGreaterThanOrEqual(1);
    const critical = res.body.data.severities.find((s) => s.severity === "critical");
    expect(critical?.count).toBeGreaterThanOrEqual(1);
  });

  it("open their row-level detail for their own company and 404 for anyone else", async () => {
    const requestId = "11111111-2222-4333-8444-555555555555";
    const { id } = await seed({ buyer: BUYER_A, summary: "company-wide with changes", requestId });
    await db.none(
      `INSERT INTO tbl_audit_row_changes (table_name, operation, record_id, new_data, request_id)
       VALUES ('tbl_roles', 'INSERT', 1, '{"title":"Probe"}'::jsonb, $1)`,
      [requestId]
    );
    try {
      const own = await (await httpClient(ADMIN_A)).get(`/api/v1/activity/${id}/changes`);
      expect(own.status).toBe(200);
      expect(own.body.data.changes.map((c) => c.table_name)).toContain("tbl_roles");

      const other = await (await httpClient(ADMIN_B)).get(`/api/v1/activity/${id}/changes`);
      expect(other.status).toBe(404);
    } finally {
      await db.none(`DELETE FROM tbl_audit_row_changes WHERE request_id = $1`, [requestId]);
    }
  });
});
