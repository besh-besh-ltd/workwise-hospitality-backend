/**
 * Changing who approves must show up in the activity trail, naming whose
 * access changed and what changed.
 *
 * Client ticket 2026-09-22, RFQ 536263: "approval matrix now see changed". It
 * had. On 15 Sep at 13:20 IST the step-2 approver for every PO at The Orchid
 * Hotel Mumbai moved from Maruti Kangane to a newly created user, Geetanand
 * Shetty. The row-level audit trigger recorded every row of it. The activity
 * trail — the thing an admin can actually read — recorded nothing.
 *
 * Two faults, both reproduced here:
 *
 *  1. The account that made the change ("Phileein Hospitality", a type-7
 *     administrator) has no hospitality mapping of its own. User events were
 *     scoped by the ACTOR's company, so the capture middleware found no company
 *     and silently dropped every one of that account's user and role edits.
 *     They belong in the trail of the company the edited user belongs to.
 *
 *  2. Even when a user edit was recorded, it read "X updated a user account" —
 *     no whose, no what. The controller already computes the exact role-scope
 *     diff to propagate approval changes; it just never reached the trail.
 *
 * Isolation: Pattern B (commit + cleanup) — real HTTP, and the capture
 * middleware writes on its own connection after the response finishes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";

// Buyer-user range 80001..80099; 80056/80057 are unused by any other suite.
const ADMIN_WITHOUT_MAPPING = 80056; // shaped like production user 150
const TARGET = 80057;

const P1 = 13; // "Final Awarding P1" — seeded system role
const P2 = 14; // "Final Awarding P2"

const HOSPITALITY = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;

const waitForUserEvent = async (since, route = '/users/update-user-detail', timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.oneOrNone(
      `SELECT event_key, hospitality_company_id, entity_type, entity_id, entity_label,
              summary, metadata, status_code
         FROM tbl_activity_events
        WHERE occurred_at >= $1 AND route_pattern = $3
          AND actor_user_id = $2
        ORDER BY id DESC LIMIT 1`,
      [since, ADMIN_WITHOUT_MAPPING, route]
    );
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
};

const NEW_USER_EMAIL = "geetanand.test@roles.test";

const removeCreatedUser = async () => {
  const created = await db.oneOrNone(`SELECT id FROM tbl_users WHERE email = $1`, [NEW_USER_EMAIL]);
  if (!created) return;
  // Creating a user with an approval role can hand them live pending approvals.
  await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approver_user_id = $1`, [created.id]);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [created.id]);
  await db.none(`DELETE FROM tbl_user_department WHERE user_id = $1`, [created.id]);
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [created.id]);
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [created.id]);
};

const cleanUp = async () => {
  await removeCreatedUser();
  await db.none(`DELETE FROM tbl_activity_events WHERE actor_user_id = $1`, [ADMIN_WITHOUT_MAPPING]);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id IN ($1, $2)`, [ADMIN_WITHOUT_MAPPING, TARGET]);
  await db.none(`DELETE FROM tbl_user_department WHERE user_id IN ($1, $2)`, [ADMIN_WITHOUT_MAPPING, TARGET]);
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id IN ($1, $2)`, [ADMIN_WITHOUT_MAPPING, TARGET]);
};

beforeAll(async () => {
  await cleanUp();
  await db.none(`DELETE FROM tbl_users WHERE id IN ($1, $2)`, [ADMIN_WITHOUT_MAPPING, TARGET]);
  // The production shape: a type-7 administrator with NO hospitality mapping.
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'Platform Admin', 'platform.admin@roles.test', 1, 7, $2, now(), now())`,
    [ADMIN_WITHOUT_MAPPING, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'Maruti Test', 'maruti.test@roles.test', 1, 2, $2, now(), now())`,
    [TARGET, IDS.companies.A]
  );
});

beforeEach(async () => {
  await cleanUp();
  // The person whose approval role is about to move: mapped to the unit and
  // holding Final Awarding P2 there.
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
     VALUES ($1, $2, $3, 1)`,
    [TARGET, HOSPITALITY, HOTEL]
  );
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
     VALUES ($1, $2, $3, $4, NULL, NULL)`,
    [TARGET, P2, HOSPITALITY, HOTEL]
  );
});

afterAll(async () => {
  await cleanUp();
  await db.none(`DELETE FROM tbl_users WHERE id IN ($1, $2)`, [ADMIN_WITHOUT_MAPPING, TARGET]);
  await closeDb();
});

/** Move TARGET from P2 to P1 at the unit — the shape of the 15 Sep change. */
const moveApprovalRole = async () => {
  const client = await httpClient(ADMIN_WITHOUT_MAPPING);
  return client.put("/api/v1/users/update-user-detail").send({
    user_id: TARGET,
    roles: [{ role_id: P1, company_id: HOSPITALITY, hotel_id: HOTEL }],
    confirmed_approval_impact: true,
  });
};

describe("activity trail — changes to who approves", () => {
  it("records an admin's role change even when the admin has no company mapping", async () => {
    const since = new Date();
    const res = await moveApprovalRole();
    expect(res.status).toBe(200);

    const event = await waitForUserEvent(since);
    expect(event).not.toBeNull();
    // Filed with the company whose approvals changed, where its admins look.
    expect(Number(event.hospitality_company_id)).toBe(HOSPITALITY);
  });

  it("names whose access changed", async () => {
    const since = new Date();
    await moveApprovalRole();

    const event = await waitForUserEvent(since);
    expect(Number(event.entity_id)).toBe(TARGET);
    expect(event.entity_label).toBe("Maruti Test");
    expect(event.summary).toContain("Maruti Test");
  });

  it("says which approval roles were removed and which were granted, and where", async () => {
    const since = new Date();
    await moveApprovalRole();

    const event = await waitForUserEvent(since);
    const hotel = await db.one(`SELECT name FROM tbl_hospitality_company_hotels WHERE id = $1`, [HOTEL]);

    expect(event.summary).toMatch(/removed Final Awarding P2/);
    expect(event.summary).toMatch(/added Final Awarding P1/);
    expect(event.summary).toContain(hotel.name);
  });

  it("keeps the structured diff on the event for anyone filtering or exporting", async () => {
    const since = new Date();
    await moveApprovalRole();

    const event = await waitForUserEvent(since);
    const { removed, added } = event.metadata.role_scopes;
    expect(removed).toEqual([expect.objectContaining({ role_id: P2, role: "Final Awarding P2", hotel_id: HOTEL })]);
    expect(added).toEqual([expect.objectContaining({ role_id: P1, role: "Final Awarding P1", hotel_id: HOTEL })]);
  });

  it("records an account created with approval roles, even by an admin with no company mapping", async () => {
    // The other half of 15 Sep: Geetanand Shetty did not exist before that
    // session. He was CREATED with Final Awarding P2 at the unit, and that
    // event was dropped for the same reason as the edit.
    const since = new Date();
    const client = await httpClient(ADMIN_WITHOUT_MAPPING);
    const res = await client.post("/api/v1/users/create-buyer-company-user").send({
      name: "Geetanand Test",
      email: NEW_USER_EMAIL,
      mobile: "9000000057",
      password: "Passw0rd!23",
      roles: [{ role_id: P2, company_id: HOSPITALITY, hotel_id: HOTEL }],
      mappings: [{ company_id: HOSPITALITY, mapping_level: "hotel", hotel_id: HOTEL }],
    });
    expect(res.status).toBe(200);

    const event = await waitForUserEvent(since, "/users/create-buyer-company-user");
    expect(event).not.toBeNull();
    expect(Number(event.hospitality_company_id)).toBe(HOSPITALITY);
    expect(Number(event.entity_id)).toBe(res.body.data.id);

    const hotel = await db.one(`SELECT name FROM tbl_hospitality_company_hotels WHERE id = $1`, [HOTEL]);
    expect(event.summary).toContain("Geetanand Test");
    expect(event.summary).toContain(`Final Awarding P2 at ${hotel.name}`);
    expect(event.metadata.role_scopes.added).toEqual([
      expect.objectContaining({ role_id: P2, role: "Final Awarding P2", hotel_id: HOTEL }),
    ]);
  });
});
