/**
 * Reading the company activity trail.
 *
 * The trail records who did what across an entire company, which makes this
 * endpoint an information-disclosure risk if the scope can be influenced from
 * outside the session. This codebase has fixed that class of bug more than
 * once. So the tests that matter most here are not about pagination — they are
 * about a filter being unable to widen what it can see.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

const COMPANY_A = IDS.hospitality.A;
const COMPANY_B = IDS.hospitality.B;
const ADMIN_A = IDS.users.companyA_admin;

let restoreUserType;

const seedEvent = (overrides = {}) =>
  db.one(
    `INSERT INTO tbl_activity_events
       (source, event_key, category, severity, actor_type, actor_user_id, actor_label,
        hospitality_company_id, hotel_id, entity_type, entity_id, entity_label,
        summary, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      overrides.source || "HTTP",
      overrides.eventKey || "test_event",
      overrides.category || "Organisation",
      overrides.severity || "routine",
      overrides.actorType || "USER",
      overrides.actorUserId ?? ADMIN_A,
      overrides.actorLabel || "Test Actor",
      overrides.companyId ?? COMPANY_A,
      overrides.hotelId ?? null,
      overrides.entityType || null,
      overrides.entityId ?? null,
      overrides.entityLabel || null,
      overrides.summary || "Something happened",
      overrides.occurredAt || new Date().toISOString(),
    ]
  );

beforeAll(async () => {
  const row = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [ADMIN_A]);
  restoreUserType = row.user_type;
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN_A]);
  await db.none("DELETE FROM tbl_activity_events");
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [ADMIN_A, restoreUserType]);
  await db.none("DELETE FROM tbl_activity_events");
  await closeDb();
});

beforeEach(() => db.none("DELETE FROM tbl_activity_events"));

describe("activity scope", () => {
  it("shows the admin their own company's activity", async () => {
    await seedEvent({ summary: "A thing happened at Company A" });
    const client = await httpClient(ADMIN_A);

    const res = await client.get("/api/v1/activity");
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.rows[0].summary).toBe("A thing happened at Company A");
  });

  it("never shows another company's activity", async () => {
    await seedEvent({ companyId: COMPANY_B, summary: "Company B secret" });
    const client = await httpClient(ADMIN_A);

    const res = await client.get("/api/v1/activity");
    expect(res.body.data.rows).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it("cannot be pointed at another company by a query parameter", async () => {
    await seedEvent({ companyId: COMPANY_B, summary: "Company B secret" });
    const client = await httpClient(ADMIN_A);

    // Both id spaces are tried. tbl_users.company_id / tbl_company is a
    // different space from tbl_hospitality_companies, and an implementation
    // that read the wrong one from the query would be caught by only one of
    // these — so the buyer-company id (IDS.companies.B), which is what
    // companiesVisibleTo actually takes, is the one that matters.
    for (const qs of [
      "?hospitality_company_id=" + COMPANY_B,
      "?company_id=" + COMPANY_B,
      "?company_id=" + IDS.companies.B,
      "?buyer_company_id=" + IDS.companies.B,
      "?companyIds=" + COMPANY_B,
    ]) {
      const res = await client.get(`/api/v1/activity${qs}`);
      expect(res.body.data.rows).toEqual([]);
    }
  });

  it("cannot be pointed at another company by a header", async () => {
    await seedEvent({ companyId: COMPANY_B, summary: "Company B secret" });
    const client = await httpClient(ADMIN_A);

    const res = await client
      .get("/api/v1/activity")
      .set("x-company-id", String(COMPANY_B))
      .set("x-hospitality-company", String(COMPANY_B));
    expect(res.body.data.rows).toEqual([]);
  });

  it("refuses a caller who is not a company admin", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get("/api/v1/activity");
    expect(res.status).toBe(403);
  });
});

describe("activity filters", () => {
  it("narrows by category, severity and business unit", async () => {
    await seedEvent({ category: "People", severity: "critical", summary: "granted a role" });
    await seedEvent({ category: "Sourcing", severity: "routine", summary: "edited an RFQ" });
    await seedEvent({ category: "Sourcing", severity: "routine", hotelId: IDS.hotels.A1, summary: "at unit A1" });
    const client = await httpClient(ADMIN_A);

    expect((await client.get("/api/v1/activity?category=People")).body.data.rows).toHaveLength(1);
    expect((await client.get("/api/v1/activity?severity=critical")).body.data.rows).toHaveLength(1);
    expect(
      (await client.get(`/api/v1/activity?hotel_id=${IDS.hotels.A1}`)).body.data.rows
    ).toHaveLength(1);
  });

  it("searches the sentence an admin actually read", async () => {
    await seedEvent({ summary: "Priya approved purchase order 138800" });
    await seedEvent({ summary: "Ravi edited RFQ 536445" });
    const client = await httpClient(ADMIN_A);

    const res = await client.get("/api/v1/activity?q=138800");
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.rows[0].summary).toContain("138800");
  });

  it("returns newest first and paginates", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedEvent({
        summary: `event ${i}`,
        occurredAt: new Date(Date.now() + i * 1000).toISOString(),
      });
    }
    const client = await httpClient(ADMIN_A);

    const page1 = await client.get("/api/v1/activity?limit=2&page=1");
    expect(page1.body.data.rows.map((r) => r.summary)).toEqual(["event 4", "event 3"]);
    expect(page1.body.data.total).toBe(5);
    expect(page1.body.data.hasMore).toBe(true);

    const page3 = await client.get("/api/v1/activity?limit=2&page=3");
    expect(page3.body.data.rows.map((r) => r.summary)).toEqual(["event 0"]);
    expect(page3.body.data.hasMore).toBe(false);
  });

  it("caps how much can be asked for at once", async () => {
    const client = await httpClient(ADMIN_A);
    const res = await client.get("/api/v1/activity?limit=100000");
    expect(res.body.data.limit).toBeLessThanOrEqual(200);
  });
});

describe("activity detail", () => {
  it("offers filters built from what this company actually has", async () => {
    await seedEvent({ category: "People", actorLabel: "Priya" });
    await seedEvent({ category: "Sourcing", actorLabel: "Priya" });
    await seedEvent({ companyId: COMPANY_B, category: "Billing", actorLabel: "Someone else" });
    const client = await httpClient(ADMIN_A);

    const res = await client.get("/api/v1/activity/facets");
    const categories = res.body.data.categories.map((c) => c.category);
    expect(categories).toEqual(expect.arrayContaining(["People", "Sourcing"]));
    // A filter that belongs to another company must not even be offered.
    expect(categories).not.toContain("Billing");
  });

  it("treats an event from another company as not found, not forbidden", async () => {
    // Distinguishing the two would confirm the row exists.
    const { id } = await seedEvent({ companyId: COMPANY_B });
    const client = await httpClient(ADMIN_A);

    const res = await client.get(`/api/v1/activity/${id}/changes`);
    expect(res.status).toBe(404);
  });

  it("returns the event with no changes when it has no request to join on", async () => {
    const { id } = await seedEvent({ summary: "Backfilled long ago" });
    const client = await httpClient(ADMIN_A);

    const res = await client.get(`/api/v1/activity/${id}/changes`);
    expect(res.status).toBe(200);
    expect(res.body.data.event.summary).toBe("Backfilled long ago");
    expect(res.body.data.changes).toEqual([]);
  });
});
