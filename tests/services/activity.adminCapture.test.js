/**
 * What a company administrator does must reach the activity trail.
 *
 * RCA 2026-10-12. Production's only company administrators (users 150 and 402,
 * user_type 7) have no hospitality mapping of their own. Every registry entry
 * that placed its event by the ACTOR's company therefore resolved to nothing,
 * and the capture middleware dropped the event without a word. Measured
 * against the row-level audit between 2026-09-04 and 2026-10-12: 3 of 3
 * business-unit removals, 2 of 2 approval workflows and every admin-triggered
 * password reset never reached the trail. Roles, delegations and workflow
 * deletion were scoped the same way.
 *
 * Each case here is a real request over HTTP by an administrator shaped like
 * production's — user_type 7, no mapping — followed by reading what landed,
 * both in the table and through the Activity API the admin actually uses.
 *
 * Isolation: Pattern B (commit + cleanup). The capture middleware writes on
 * its own connection after the response has finished.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

const ADMIN = 80058; // company A administrator, no hospitality mapping (like prod user 150)
const TARGET = 80059; // an ordinary buyer at company A
const OTHER_ADMIN = 80060; // company B administrator, no mapping

const HOSPITALITY_A = IDS.hospitality.A;
const HOTEL_A1 = IDS.hotels.A1;
const HOTEL_A2 = IDS.hotels.A2;
const BUYER_A = IDS.companies.A;
const BUYER_B = IDS.companies.B;
const DELEGATE = IDS.users.a1_proc_buyer;

const INSTANCE_ID = 980301;

let originalCompanyName;

const waitForEvent = async (since, route, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.oneOrNone(
      `SELECT * FROM tbl_activity_events
        WHERE occurred_at >= $1 AND route_pattern = $2 AND actor_user_id = $3
        ORDER BY id DESC LIMIT 1`,
      [since, route, ADMIN]
    );
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** Give the middleware time to (not) write, then read what it wrote. */
const settledEvents = async (since, route) => {
  await new Promise((r) => setTimeout(r, 800));
  return db.any(
    `SELECT * FROM tbl_activity_events
      WHERE occurred_at >= $1 AND route_pattern = $2 AND actor_user_id = $3`,
    [since, route, ADMIN]
  );
};

const cleanUp = async () => {
  await db.none(`DELETE FROM tbl_activity_events WHERE actor_user_id IN ($1, $2, $3)`, [ADMIN, TARGET, OTHER_ADMIN]);
  await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
                   (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1)`, [INSTANCE_ID]);
  await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = $1`, [INSTANCE_ID]);
  await db.none(`DELETE FROM tbl_approval_instances WHERE id = $1`, [INSTANCE_ID]);
  await db.none(`DELETE FROM tbl_approval_delegations WHERE delegator_user_id = $1 OR created_by = $2`, [TARGET, ADMIN]);
  await db.none(`DELETE FROM tbl_role_permissions WHERE role_id IN (SELECT id FROM tbl_roles WHERE created_by = $1)`, [ADMIN]);
  await db.none(`DELETE FROM tbl_roles WHERE created_by = $1`, [ADMIN]);
  await db.none(`DELETE FROM tbl_approval_processes WHERE created_by = $1`, [ADMIN]);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id IN ($1, $2)`, [TARGET, ADMIN]);
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [TARGET]);
  await db.none(`DELETE FROM tbl_hospitality_project_mappings WHERE created_by = $1`, [ADMIN]);
  await db.none(`DELETE FROM tbl_projects WHERE description = 'activity capture probe'`);
};

beforeAll(async () => {
  await cleanUp();
  await db.none(`DELETE FROM tbl_users WHERE id IN ($1, $2, $3)`, [ADMIN, TARGET, OTHER_ADMIN]);
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'Platform Admin A', 'platform.admin.a@capture.test', 1, 7, $4, now(), now()),
            ($2, 'Kavita Capture', 'kavita@capture.test', 1, 2, $4, now(), now()),
            ($3, 'Platform Admin B', 'platform.admin.b@capture.test', 1, 7, $5, now(), now())`,
    [ADMIN, TARGET, OTHER_ADMIN, BUYER_A, BUYER_B]
  );
  ({ company_name: originalCompanyName } = await db.one(
    `SELECT company_name FROM tbl_company WHERE id = $1`, [BUYER_A]
  ));
});

beforeEach(async () => {
  await cleanUp();
  // The person being administered: two units, an approval role at the first.
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
     VALUES ($1, $2, $3, 1), ($1, $2, $4, 1)`,
    [TARGET, HOSPITALITY_A, HOTEL_A1, HOTEL_A2]
  );
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id)
     VALUES ($1, 13, $2, $3)`,
    [TARGET, HOSPITALITY_A, HOTEL_A1]
  );
});

afterAll(async () => {
  await cleanUp();
  await db.none(`UPDATE tbl_company SET company_name = $2 WHERE id = $1`, [BUYER_A, originalCompanyName]);
  await db.none(`DELETE FROM tbl_users WHERE id IN ($1, $2, $3)`, [ADMIN, TARGET, OTHER_ADMIN]);
  await closeDb();
});

describe("removing someone from a business unit", () => {
  const ROUTE = "/hospitality/user/:user_id/mapping";

  it("is recorded at the unit they were removed from, naming them and it", async () => {
    const since = new Date().toISOString();
    const { name: hotelName } = await db.one(
      `SELECT name FROM tbl_hospitality_company_hotels WHERE id = $1`, [HOTEL_A1]
    );

    const client = await httpClient(ADMIN);
    const res = await client.delete(`/api/v1/hospitality/user/${TARGET}/mapping`).send({
      company_id: HOSPITALITY_A, mapping_type: 1, hotel_id: HOTEL_A1,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const event = await waitForEvent(since, ROUTE);
    expect(event).not.toBeNull();
    expect(event.event_key).toBe("user_mapping_removed");
    // The unit removed FROM — not the unit the user still has (A2), which is
    // what an entity lookup on the user would have found afterwards.
    expect(event.hospitality_company_id).toBe(HOSPITALITY_A);
    expect(event.hotel_id).toBe(HOTEL_A1);
    expect(event.buyer_company_id).toBe(BUYER_A);
    expect(event.summary).toBe(
      `Platform Admin A removed Kavita Capture from ${hotelName} (and 1 role assignment there)`
    );
  });

  it("records nothing when the request only warned and removed nothing", async () => {
    // The same route answers 200 with an approval-impact warning when the user
    // still has pending approvals in the unit — and changes nothing. A capture
    // keyed on the status code alone would write that up as a removal.
    const step1 = await db.one(
      `SELECT id FROM tbl_approval_policy_steps WHERE approval_policy_id = $1 AND step_order = 1`,
      [IDS.policies.A1_P1_RFQ]
    );
    const step2 = await db.one(
      `SELECT id FROM tbl_approval_policy_steps WHERE approval_policy_id = $1 AND step_order = 2`,
      [IDS.policies.A1_P1_RFQ]
    );
    await db.none(
      `INSERT INTO tbl_approval_instances
         (id, entity_type, entity_id, approval_policy_id, status, current_step,
          hospitality_company_id, hotel_id, initiated_by, metadata)
       VALUES ($1, 'PO', 9980301, $2, 'PENDING', 1, $3, $4, $5, '{}'::jsonb)`,
      [INSTANCE_ID, IDS.policies.A1_P1_RFQ, HOSPITALITY_A, HOTEL_A1, ADMIN]
    );
    const s1 = await db.one(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, policy_step_id, step_order, decision_rule, status)
       VALUES ($1, $2, 1, 'ANY', 'PENDING') RETURNING id`,
      [INSTANCE_ID, step1.id]
    );
    await db.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
       VALUES ($1, $2, 'PENDING')`,
      [s1.id, TARGET]
    );
    await db.none(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, policy_step_id, step_order, decision_rule, status)
       VALUES ($1, $2, 2, 'ANY', 'PENDING')`,
      [INSTANCE_ID, step2.id]
    );

    const since = new Date().toISOString();
    const client = await httpClient(ADMIN);
    const res = await client.delete(`/api/v1/hospitality/user/${TARGET}/mapping`).send({
      company_id: HOSPITALITY_A, mapping_type: 1, hotel_id: HOTEL_A1,
    });
    // Pinned so this cannot pass vacuously on a 400 (never recorded anyway).
    expect(res.status).toBe(200);
    expect(res.body.code).toBe("APPROVAL_IMPACT_WARNING");

    expect(await settledEvents(since, ROUTE)).toEqual([]);
    const still = await db.oneOrNone(
      `SELECT 1 FROM tbl_hospitality_user_mappings WHERE user_id = $1 AND hospitality_hotel_id = $2`,
      [TARGET, HOTEL_A1]
    );
    expect(still).not.toBeNull();
  });
});

describe("company-wide administration", () => {
  it("records creating, editing and deleting an approval workflow, by name", async () => {
    const client = await httpClient(ADMIN);

    let since = new Date().toISOString();
    const created = await client.post("/api/v1/general/hospitality/approval/processes")
      .send({ name: "Capex Approvals", description: "probe", process_type: "RFQ" });
    expect(created.status).toBe(201);
    const processId = created.body.data.id;

    const createEvent = await waitForEvent(since, "/general/hospitality/approval/processes");
    expect(createEvent).not.toBeNull();
    expect(createEvent.event_key).toBe("approval_process_created");
    // No hospitality company: a workflow belongs to the buyer company as a
    // whole. Before this fix that resolved to nothing and was dropped.
    expect(createEvent.hospitality_company_id).toBeNull();
    expect(createEvent.buyer_company_id).toBe(BUYER_A);
    expect(Number(createEvent.entity_id)).toBe(processId);
    expect(createEvent.summary).toBe('Platform Admin A created the approval workflow "Capex Approvals"');

    since = new Date().toISOString();
    const edited = await client.put(`/api/v1/general/hospitality/approval/processes/${processId}`)
      .send({ name: "Capex Approvals v2" });
    expect(edited.status).toBe(200);
    const editEvent = await waitForEvent(since, "/general/hospitality/approval/processes/:id");
    expect(editEvent.event_key).toBe("approval_process_updated");
    expect(editEvent.summary).toBe('Platform Admin A edited the approval workflow "Capex Approvals v2"');

    since = new Date().toISOString();
    const deleted = await client.delete(`/api/v1/general/hospitality/approval/processes/${processId}`);
    expect(deleted.status).toBe(200);
    const deleteEvent = await waitForEvent(since, "/general/hospitality/approval/processes/:id");
    expect(deleteEvent.event_key).toBe("approval_process_deleted");
    expect(deleteEvent.severity).toBe("critical");
    expect(deleteEvent.summary).toBe('Platform Admin A deactivated the approval workflow "Capex Approvals v2"');
  });

  it("records creating and changing a custom role, by title", async () => {
    const client = await httpClient(ADMIN);
    const perm = await db.one(`SELECT id FROM tbl_permissions WHERE resource::text = 'rfq' AND action::text = 'read' LIMIT 1`);

    let since = new Date().toISOString();
    const created = await client.post("/api/v1/rbac/roles")
      .send({ title: "Capture Probe Role", description: "probe", permission_ids: [perm.id] });
    expect(created.status).toBe(201);
    const roleId = created.body.data.role_id;

    const createEvent = await waitForEvent(since, "/rbac/roles");
    expect(createEvent).not.toBeNull();
    expect(createEvent.event_key).toBe("role_created");
    expect(createEvent.hospitality_company_id).toBeNull();
    expect(createEvent.buyer_company_id).toBe(BUYER_A);
    // The id lives at data.role_id; reading data.id left creations unlinked.
    expect(Number(createEvent.entity_id)).toBe(roleId);
    expect(createEvent.summary).toBe('Platform Admin A created the role "Capture Probe Role"');

    since = new Date().toISOString();
    const updated = await client.put(`/api/v1/rbac/roles/${roleId}`)
      .send({ title: "Capture Probe Role", description: "probe", permission_ids: [perm.id] });
    expect(updated.status).toBe(200);
    const updateEvent = await waitForEvent(since, "/rbac/roles/:roleId");
    expect(updateEvent.event_key).toBe("role_updated");
    expect(updateEvent.buyer_company_id).toBe(BUYER_A);
    expect(updateEvent.summary).toBe('Platform Admin A changed what the role "Capture Probe Role" can do');
  });

  it("records the company profile being edited, labelled with the company", async () => {
    const client = await httpClient(ADMIN);
    const since = new Date().toISOString();
    const res = await client.put("/api/v1/users/update-company-detail")
      .send({ company_name: "Company A Capture Probe" });
    expect(res.status).toBe(200);

    const event = await waitForEvent(since, "/users/update-company-detail");
    expect(event).not.toBeNull();
    expect(event.event_key).toBe("company_details_updated");
    expect(event.hospitality_company_id).toBeNull();
    expect(event.buyer_company_id).toBe(BUYER_A);
    expect(event.summary).toBe("Platform Admin A updated the company details for Company A Capture Probe");

    // tbl_company is audited now, so the expansion shows what changed.
    const changes = await client.get(`/api/v1/activity/${event.id}/changes`);
    expect(changes.status).toBe(200);
    const tables = changes.body.data.changes.map((c) => c.table_name);
    expect(tables).toContain("tbl_company");
  });
});

describe("unlinking a project from a business unit", () => {
  const ROUTE = "/hospitality/project/:project_id/mapping";

  const linkedProject = async () => {
    const { id } = await db.one(
      `INSERT INTO tbl_projects (name, description, location, user_id, status, budget)
       VALUES ('Lobby Refit', 'activity capture probe', 'nowhere', $1, 1, 1000)
       RETURNING id`,
      [ADMIN]
    );
    await db.none(
      `INSERT INTO tbl_hospitality_project_mappings
         (project_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
       VALUES ($1, $2, $3, 1, $4)`,
      [id, HOSPITALITY_A, HOTEL_A1, ADMIN]
    );
    return id;
  };

  it("is recorded at the unit the project was unlinked from", async () => {
    const projectId = await linkedProject();
    const since = new Date().toISOString();
    const client = await httpClient(ADMIN);
    const res = await client.delete(`/api/v1/hospitality/project/${projectId}/mapping`).send({
      company_id: HOSPITALITY_A, mapping_type: 1, hotel_id: HOTEL_A1,
    });
    expect(res.status).toBe(200);

    const event = await waitForEvent(since, ROUTE);
    expect(event).not.toBeNull();
    expect(event.event_key).toBe("project_mapping_removed");
    expect(event.hospitality_company_id).toBe(HOSPITALITY_A);
    expect(event.hotel_id).toBe(HOTEL_A1);
    expect(event.summary).toContain('"Lobby Refit"');
  });

  it("never files another tenant's business unit named in the request body", async () => {
    // The company is checked against the caller; the unit was not. Naming
    // company B's unit used to put that unit's id — and so its name, through
    // the business-unit filter — into company A's trail.
    const projectId = await linkedProject();
    const since = new Date().toISOString();
    const client = await httpClient(ADMIN);
    const res = await client.delete(`/api/v1/hospitality/project/${projectId}/mapping`).send({
      company_id: HOSPITALITY_A, mapping_type: 1, hotel_id: IDS.hotels.B1,
    });
    expect(res.status).toBe(200);

    const events = await settledEvents(since, ROUTE);
    expect(events.filter((e) => e.hotel_id === IDS.hotels.B1)).toEqual([]);
    // Nothing matched that unit, so nothing was unlinked — and nothing is
    // written up as an unlink either.
    expect(events).toEqual([]);
    const still = await db.oneOrNone(
      `SELECT 1 FROM tbl_hospitality_project_mappings WHERE project_id = $1 AND hospitality_hotel_id = $2`,
      [projectId, HOTEL_A1]
    );
    expect(still).not.toBeNull();
  });
});

describe("an administrator editing their own account", () => {
  it("names them, rather than 'a user', when the request carries no user_id", async () => {
    const client = await httpClient(ADMIN);
    const since = new Date().toISOString();
    const res = await client.put("/api/v1/users/update-user-detail").send({
      roles: [{ role_id: 13, company_id: HOSPITALITY_A, hotel_id: HOTEL_A1 }],
      confirmed_approval_impact: true,
    });
    expect(res.status).toBe(200);

    const event = await waitForEvent(since, "/users/update-user-detail");
    expect(event).not.toBeNull();
    expect(event.event_key).toBe("user_updated");
    expect(event.entity_type).toBe("USER");
    expect(Number(event.entity_id)).toBe(ADMIN);
    expect(event.buyer_company_id).toBe(BUYER_A);
    expect(event.summary).toMatch(/^Platform Admin A changed their own approval roles — added /);
  });
});

describe("administration that concerns one person", () => {
  it("files a password reset under the person it was sent to, naming them", async () => {
    const client = await httpClient(ADMIN);
    const since = new Date().toISOString();
    const res = await client.post(`/api/v1/users/${TARGET}/send-password-reset`).send({});
    expect(res.status).toBe(200);

    const event = await waitForEvent(since, "/users/:user_id/send-password-reset");
    expect(event).not.toBeNull();
    expect(event.hospitality_company_id).toBe(HOSPITALITY_A);
    expect(event.summary).toBe("Platform Admin A sent a password reset to Kavita Capture");
  });

  it("records cover arranged and ended, naming who covers for whom", async () => {
    const client = await httpClient(ADMIN);
    const start = new Date(Date.now() + 24 * 3600 * 1000);
    const end = new Date(Date.UTC(2031, 2, 3, 12));

    let since = new Date().toISOString();
    const created = await client.post("/api/v1/general/hospitality/approval/delegations").send({
      delegator_user_id: TARGET, delegate_user_id: DELEGATE,
      starts_at: start.toISOString(), ends_at: end.toISOString(), reason: "leave",
    });
    expect(created.status).toBe(200);

    const { name: delegateName } = await db.one(`SELECT name FROM tbl_users WHERE id = $1`, [DELEGATE]);
    const createEvent = await waitForEvent(since, "/general/hospitality/approval/delegations");
    expect(createEvent).not.toBeNull();
    // Placed where the person being covered for works.
    expect(createEvent.hospitality_company_id).toBe(HOSPITALITY_A);
    expect(createEvent.summary).toBe(
      `Platform Admin A arranged for ${delegateName} to cover for Kavita Capture until 3 March 2031`
    );

    since = new Date().toISOString();
    const revoked = await client.delete(`/api/v1/general/hospitality/approval/delegations/${created.body.data.id}`);
    expect(revoked.status).toBe(200);
    const revokeEvent = await waitForEvent(since, "/general/hospitality/approval/delegations/:id");
    expect(revokeEvent.summary).toBe(
      `Platform Admin A ended the arrangement for ${delegateName} to cover for Kavita Capture early`
    );
  });
});

describe("who can read company-wide events", () => {
  it("shows them to the company's administrators and to nobody else", async () => {
    const client = await httpClient(ADMIN);
    const since = new Date().toISOString();
    const created = await client.post("/api/v1/general/hospitality/approval/processes")
      .send({ name: "Isolation Probe Workflow", process_type: "RFQ" });
    expect(created.status).toBe(201);
    const event = await waitForEvent(since, "/general/hospitality/approval/processes");
    expect(event).not.toBeNull();

    const own = await client.get("/api/v1/activity").query({ q: "Isolation Probe Workflow" });
    expect(own.status).toBe(200);
    expect(own.body.data.rows.map((r) => r.id)).toContain(event.id);

    // Company B's administrator: not in the list, not in the facets, and the
    // detail answers 404 exactly as for an id that does not exist.
    const other = await httpClient(OTHER_ADMIN);
    const theirs = await other.get("/api/v1/activity").query({ q: "Isolation Probe Workflow" });
    expect(theirs.status).toBe(200);
    expect(theirs.body.data.rows).toEqual([]);
    const detail = await other.get(`/api/v1/activity/${event.id}/changes`);
    expect(detail.status).toBe(404);
  });
});
