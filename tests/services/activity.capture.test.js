/**
 * The activity trail, end to end.
 *
 * The requirement is that everything happening anywhere in a company is
 * recorded. Against 343 mutating endpoints that is only achievable by
 * capturing at a choke point rather than at call sites, so these tests exercise
 * the choke point: real authenticated requests over real HTTP, then reading
 * what landed in the trail.
 *
 * The cases that matter most are the ones where a plausible implementation
 * quietly does the wrong thing — an event scoped to the wrong company, an
 * entity id that only exists in the response, a rejected request recorded as
 * though it happened, or a route nobody remembered to name.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  getUncataloguedRoutes,
  resetUncataloguedRoutes,
} from "../../app/middleware/activityCapture.js";

const COMPANY_ID = IDS.hospitality.A;
const ADMIN = IDS.users.companyA_admin;

let original;
let originalUserType;

const eventsSince = (since) =>
  db.any(
    `SELECT event_key, category, severity, actor_type, actor_user_id, actor_label,
            hospitality_company_id, hotel_id, entity_type, entity_id, entity_label,
            summary, http_method, route_pattern, status_code, request_id, source,
            metadata
       FROM tbl_activity_events
      WHERE occurred_at >= $1
      ORDER BY id`,
    [since]
  );

// The capture runs on the response's `finish` event, so it is deliberately
// off the request's critical path and lands a moment after the client has its
// answer. Polling is honest about that rather than pretending it is
// synchronous.
const waitForEvent = async (since, predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await eventsSince(since);
    const hit = rows.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
};

beforeAll(async () => {
  ({ user_type: originalUserType } = await db.one(
    "SELECT user_type FROM tbl_users WHERE id = $1",
    [ADMIN]
  ));
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);
  original = await db.one(
    "SELECT name, region, pan FROM tbl_hospitality_companies WHERE id = $1",
    [COMPANY_ID]
  );
});

afterAll(async () => {
  await db.none(
    "UPDATE tbl_users SET user_type = $2 WHERE id = $1",
    [ADMIN, originalUserType]
  );
  await db.none(
    "UPDATE tbl_hospitality_companies SET name = $2, region = $3 WHERE id = $1",
    [COMPANY_ID, original.name, original.region]
  );
  await db.none("DELETE FROM tbl_activity_events WHERE hospitality_company_id = $1", [
    COMPANY_ID,
  ]);
  await db.none(
    "DELETE FROM tbl_audit_row_changes WHERE table_name IN ('tbl_hospitality_companies','tbl_users')"
  );
  await closeDb();
});

describe("activity capture", () => {
  it("records a real action in the words an admin would use", async () => {
    const since = new Date().toISOString();
    const client = await httpClient(ADMIN);

    const res = await client.put(`/api/v1/hospitality/company/${COMPANY_ID}`).send({
      name: "Company A — capture probe",
      pan: original.pan || "AAAPZ1234C",
      region: "West",
    });
    expect(res.status).toBe(200);

    const event = await waitForEvent(since, (e) => e.event_key === "company_updated");
    expect(event).not.toBeNull();
    expect(event.category).toBe("Organisation");
    expect(event.severity).toBe("notable");
    // The company's *name* is only knowable by reading its row, so this also
    // pins that scope is derived from the entity rather than from the URL,
    // which carries nothing but an id.
    expect(event.entity_label).toBe("Company A — capture probe");
    expect(event.summary).toContain("Company A — capture probe");
    expect(event.http_method).toBe("PUT");
    expect(event.route_pattern).toBe("/hospitality/company/:company_id");
    expect(event.status_code).toBe(200);
  });

  it("attributes the event to the person, not to the database role", async () => {
    const since = new Date().toISOString();
    const client = await httpClient(ADMIN);
    await client.put(`/api/v1/hospitality/company/${COMPANY_ID}`).send({
      name: "Company A — actor probe",
      pan: original.pan || "AAAPZ1234C",
    });

    const event = await waitForEvent(since, (e) => e.event_key === "company_updated");
    expect(event.actor_user_id).toBe(ADMIN);
    expect(event.actor_type).toBe("USER");
    expect(event.actor_label).toBeTruthy();
  });

  it("scopes the event to the company it happened in", async () => {
    // The scoping key. Derived from the entity or the URL, never from the
    // x-company-id header, which the codebase's own security work found
    // untrustworthy — a trail you can redirect by editing a header is not one.
    const since = new Date().toISOString();
    const client = await httpClient(ADMIN);
    await client
      .put(`/api/v1/hospitality/company/${COMPANY_ID}`)
      .set("x-company-id", "999999")
      .send({ name: "Company A — scope probe", pan: original.pan || "AAAPZ1234C" });

    const event = await waitForEvent(since, (e) => e.event_key === "company_updated");
    expect(event.hospitality_company_id).toBe(COMPANY_ID);
  });

  it("ties the event to the row changes it caused", async () => {
    const since = new Date().toISOString();
    const client = await httpClient(ADMIN);
    await client.put(`/api/v1/hospitality/company/${COMPANY_ID}`).send({
      name: "Company A — join probe",
      pan: original.pan || "AAAPZ1234C",
    });

    const event = await waitForEvent(since, (e) => e.event_key === "company_updated");
    expect(event.request_id).toBeTruthy();

    const changes = await db.any(
      `SELECT table_name, operation, new_data
         FROM tbl_audit_row_changes WHERE request_id = $1`,
      [event.request_id]
    );
    // This join is what lets an admin expand one sentence and see which
    // columns actually moved.
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((c) => c.table_name === "tbl_hospitality_companies")).toBe(true);
  });

  it("does not record an attempt that was refused", async () => {
    // A rejected request is not something that happened to the company; it is
    // something that did not.
    const since = new Date().toISOString();
    const client = await httpClient(IDS.users.a1_proc_buyer); // not an admin

    const res = await client
      .put(`/api/v1/hospitality/company/${COMPANY_ID}`)
      .send({ name: "should not appear", pan: "AAAPZ1234C" });
    expect(res.status).toBeGreaterThanOrEqual(400);

    await new Promise((r) => setTimeout(r, 400));
    const rows = await eventsSince(since);
    expect(
      rows.filter((e) => e.route_pattern === "/hospitality/company/:company_id")
    ).toEqual([]);
  });

  it("reports a mutating route the registry does not name", async () => {
    // The anti-rot mechanism. Route 344 will be added by somebody who has
    // never read the registry; without this its events would be recorded
    // namelessly and nobody would find out.
    //
    // Note the request below is rejected, and the gap is still reported.
    // Whether the catalogue covers a route has nothing to do with whether a
    // particular call succeeded, and counting only successes would hide
    // exactly the routes that usually fail validation.
    resetUncataloguedRoutes();
    const client = await httpClient(ADMIN);

    const res = await client
      .post(`/api/v1/hospitality/company/${COMPANY_ID}/map-projects`)
      .send({ project_ids: [] });
    expect(res.status).toBeGreaterThanOrEqual(400);

    await new Promise((r) => setTimeout(r, 400));
    const gaps = getUncataloguedRoutes();
    expect(gaps.some((g) => g.route.includes("map-projects"))).toBe(true);
  });

  it("does not report a route the registry does name", async () => {
    resetUncataloguedRoutes();
    const client = await httpClient(ADMIN);
    await client.put(`/api/v1/hospitality/company/${COMPANY_ID}`).send({
      name: "Company A — no-gap probe",
      pan: original.pan || "AAAPZ1234C",
    });

    await new Promise((r) => setTimeout(r, 400));
    const gaps = getUncataloguedRoutes();
    expect(gaps.some((g) => g.route.includes("/hospitality/company/:company_id"))).toBe(false);
  });
});

describe("what does NOT belong in the feed", () => {
  // The original design wrote a row for every mutating request, named or not,
  // on the principle that a gap in the registry should not become a gap in the
  // trail. Opening the screen showed why that is wrong: the verb does not tell
  // you whether anything happened. 57 of this codebase's POST routes are
  // queries — /rfq/list-view, /users/get-dashboard-data,
  // /rbac/me/permissions/bulk — and several fire on every page load, for every
  // user. The feed filled with "performed POST /rbac/me/permissions/bulk".
  //
  // Completeness never rested on this layer: the row-level trigger records
  // every actual data change with before/after and an actor regardless. This
  // layer owes the reader a sentence, and "performed POST /x" is not one.
  it("does not record a POST that is really a query", async () => {
    const since = new Date().toISOString();
    const client = await httpClient(ADMIN);

    // A real, unregistered, read-shaped POST the frontend calls on page load.
    // It must SUCCEED — a rejected request is dropped earlier for a different
    // reason, which would make this pass against any implementation at all.
    const res = await client
      .post("/api/v1/rbac/me/permissions/bulk")
      .send({ hotel_ids: [IDS.hotels.A1] });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 800));
    const rows = await eventsSince(since);
    expect(
      rows.filter((e) => e.route_pattern === "/rbac/me/permissions/bulk")
    ).toHaveLength(0);
  });

  it("still counts the unnamed route as a registry gap", async () => {
    // Suppressing the row must not suppress the reporting: an event that
    // genuinely should be in the feed is found by this counter, and silencing
    // it would be how a real omission goes unnoticed forever.
    resetUncataloguedRoutes();
    const client = await httpClient(ADMIN);
    const res = await client
      .post("/api/v1/rbac/me/permissions/bulk")
      .send({ hotel_ids: [IDS.hotels.A1] });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 400));
    const gaps = getUncataloguedRoutes().map((g) => g.route);
    expect(gaps.some((g) => g.includes("/rbac/me/permissions/bulk"))).toBe(true);
  });

  it("still records a named event", async () => {
    // The guard must not have turned the feed off.
    const since = new Date().toISOString();
    const client = await httpClient(ADMIN);
    await client.put(`/api/v1/hospitality/company/${COMPANY_ID}`).send({
      name: "Company A — still recording",
      pan: original.pan || "AAAPZ1234C",
    });

    const event = await waitForEvent(since, (e) => e.event_key === "company_updated");
    expect(event).not.toBeNull();
  });
});
