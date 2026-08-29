/**
 * What Workwise's own staff do inside a customer's account.
 *
 * The flagship claim of the activity trail is that a company admin can see
 * everything that happens in their company. The first question a client's
 * security review asks is narrower and sharper: who at the *supplier* can see
 * our data, and what did they look at?
 *
 * A trail of writes cannot answer that, because most of what support does is
 * read. So for this one actor the rule inverts: looking is the event.
 *
 * These tests exercise the choke point over real HTTP against the real
 * internal-console authentication, because the whole mechanism turns on which
 * passport strategy minted the token.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { loginAsInternalStaff } from "../helpers/auth.js";
import { buildTestApp } from "../setup/app.js";
import { IDS } from "../fixtures/ids.js";
import request from "supertest";

const COMPANY_ID = IDS.hospitality.A;
// One account, both consoles — which is the production situation: three
// user_type 7 accounts can sign in to the client app and to the internal one.
const BOTH_HATS = IDS.users.companyA_admin;
const TARGET = IDS.users.a1_proc_buyer;  // a customer's own buyer

let originalTargetType;
let originalAdminType;
let company;

const eventsSince = (since) =>
  db.any(
    `SELECT event_key, category, severity, actor_type, actor_user_id,
            hospitality_company_id, entity_type, entity_id, entity_label,
            summary, http_method, route_pattern
       FROM tbl_activity_events
      WHERE occurred_at >= $1
      ORDER BY id`,
    [since]
  );

// Capture runs on the response's `finish` event, deliberately off the
// request's critical path, so it lands a moment after the client has its
// answer. Polling is honest about that rather than pretending otherwise.
const waitForEvent = async (since, predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await eventsSince(since)).find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** A supertest client carrying an internal-console token. */
const internalClient = async (userId) => {
  const app = await buildTestApp();
  const { headers } = await loginAsInternalStaff(userId);
  const wrap = (method) => (path) => {
    let req = request(app)[method](path);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req;
  };
  return { get: wrap("get"), put: wrap("put"), post: wrap("post") };
};

beforeAll(async () => {
  // The internal console's own validation only recognises a buyer by
  // user_type, and the fixtures leave it NULL on purpose.
  ({ user_type: originalTargetType } = await db.one(
    "SELECT user_type FROM tbl_users WHERE id = $1",
    [TARGET]
  ));
  ({ user_type: originalAdminType } = await db.one(
    "SELECT user_type FROM tbl_users WHERE id = $1",
    [BOTH_HATS]
  ));
  await db.none("UPDATE tbl_users SET user_type = 2 WHERE id = $1", [TARGET]);
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [BOTH_HATS]);
  company = await db.one(
    "SELECT name, region, pan FROM tbl_hospitality_companies WHERE id = $1",
    [COMPANY_ID]
  );
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [
    TARGET,
    originalTargetType,
  ]);
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [
    BOTH_HATS,
    originalAdminType,
  ]);
  await db.none(
    "UPDATE tbl_hospitality_companies SET name = $2, region = $3 WHERE id = $1",
    [COMPANY_ID, company.name, company.region]
  );
  await db.none(
    "DELETE FROM tbl_activity_events WHERE hospitality_company_id = $1",
    [COMPANY_ID]
  );
  await closeDb();
});

describe("Workwise staff working in a customer's account", () => {
  it("records a read, not just a change", async () => {
    const since = new Date().toISOString();
    const client = await internalClient(BOTH_HATS);

    const res = await client.get(`/api/v1/admin/buyer/buyer-details/${TARGET}`);
    expect(res.status).toBe(200);

    const event = await waitForEvent(
      since,
      (e) => e.event_key === "workwise_viewed_account"
    );
    expect(event).not.toBeNull();
    expect(event.http_method).toBe("GET");
    expect(event.actor_type).toBe("WORKWISE_STAFF");
    expect(event.actor_user_id).toBe(BOTH_HATS);
    expect(event.category).toBe("Workwise Access");
  });

  it("files it in the customer's trail, under the person who was looked at", async () => {
    // The URL carries a user id and nothing else. Landing in the right
    // company's feed means the scope was resolved from that person's
    // hospitality mapping — which is also what makes the sentence name them.
    const since = new Date().toISOString();
    const client = await internalClient(BOTH_HATS);
    await client.get(`/api/v1/admin/buyer/buyer-details/${TARGET}`);

    const event = await waitForEvent(
      since,
      (e) => e.event_key === "workwise_viewed_account"
    );
    expect(event.hospitality_company_id).toBe(COMPANY_ID);
    expect(event.entity_type).toBe("USER");
    expect(event.entity_id).toBe(String(TARGET));
    expect(event.entity_label).toBeTruthy();
    expect(event.summary).toContain(event.entity_label);
    expect(event.summary).toMatch(/Workwise staff/i);
  });

  it("tells the two hats apart by the token, not by the account", async () => {
    // The same person, the same id, two consoles. If the mark were read off
    // the account, one of these would be wrong — and it would be wrong in the
    // direction that matters, since a client's own administrator would start
    // appearing in their feed as the supplier looking at them.
    const since = new Date().toISOString();

    const asCustomer = await httpClient(BOTH_HATS);
    const put = await asCustomer
      .put(`/api/v1/hospitality/company/${COMPANY_ID}`)
      .send({
        name: "Company A — two hats probe",
        pan: company.pan || "AAAPZ1234C",
        region: "West",
      });
    expect(put.status).toBe(200);

    const asStaff = await internalClient(BOTH_HATS);
    expect(
      (await asStaff.get(`/api/v1/admin/buyer/buyer-details/${TARGET}`)).status
    ).toBe(200);

    const customerEvent = await waitForEvent(
      since,
      (e) => e.event_key === "company_updated"
    );
    const staffEvent = await waitForEvent(
      since,
      (e) => e.event_key === "workwise_viewed_account"
    );

    expect(customerEvent.actor_user_id).toBe(BOTH_HATS);
    expect(staffEvent.actor_user_id).toBe(BOTH_HATS);
    expect(customerEvent.actor_type).toBe("USER");
    expect(staffEvent.actor_type).toBe("WORKWISE_STAFF");
  });

  it("still ignores an ordinary customer read", async () => {
    // The inversion applies to one actor only. Recording every buyer's GET
    // would bury the feed under navigation and answer no question anybody
    // asked. This has to be a request that actually succeeds — a read the
    // caller is refused would not have been captured either way, and would
    // make this pass for the wrong reason.
    const since = new Date().toISOString();
    const client = await httpClient(BOTH_HATS);

    const res = await client.get(`/api/v1/hospitality/companies`);
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 800));
    const rows = await eventsSince(since);
    expect(rows.filter((e) => e.http_method === "GET")).toHaveLength(0);
  });
});
