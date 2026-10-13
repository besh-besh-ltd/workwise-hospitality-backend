/**
 * Rebuilding the company-administration events the live trail dropped.
 *
 * The live capture lost administrators' events for weeks (see
 * activity.adminCapture). The row-level audit kept every row of them, with
 * the actor and the request id. The admin_actions backfill source projects one
 * readable event per such request. These fixtures are the shapes production
 * actually has (dry run 2026-10-12: 29 user/role edits, 7 password resets,
 * 4 account creations, 3 business-unit removals, 2 approval workflows), plus
 * the shapes that must NOT become events.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { SOURCES } from "../../app/services/activity/backfillSources.js";

const ADMIN = 80062; // like prod user 150: type 7, no mapping
const PERSON = 80063; // the account being administered
const READER = IDS.users.companyA_admin;

const HOSP = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;

const R = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REQUESTS = [1, 2, 3, 4, 5, 6, 7, 8].map(R);

let processId;
let readerType;

const runAdminSource = async () =>
  (await db.result(SOURCES.find((s) => s.name === "admin_actions").sql)).rowCount;

const audit = (requestId, table, op, recordId, oldData, newData, actor = ADMIN) =>
  db.none(
    `INSERT INTO tbl_audit_row_changes (table_name, operation, record_id, old_data, new_data, actor_user_id, request_id, changed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, now() - interval '20 days')`,
    [table, op, recordId, oldData ? JSON.stringify(oldData) : null, newData ? JSON.stringify(newData) : null, actor, requestId]
  );

const reconstructed = () =>
  db.any(
    `SELECT * FROM tbl_activity_events
      WHERE is_reconstructed AND metadata->>'source_table' = 'tbl_audit_row_changes'
        AND request_id = ANY($1::uuid[])
      ORDER BY request_id`,
    [REQUESTS]
  );

const cleanUp = async () => {
  await db.none(`DELETE FROM tbl_activity_events WHERE request_id = ANY($1::uuid[])`, [REQUESTS]);
  await db.none(`DELETE FROM tbl_audit_row_changes WHERE request_id = ANY($1::uuid[]) OR (actor_user_id = $2 AND request_id IS NULL)`, [REQUESTS, ADMIN]);
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [PERSON]);
  await db.none(`DELETE FROM tbl_approval_processes WHERE created_by = $1`, [ADMIN]);
};

beforeAll(async () => {
  await cleanUp();
  await db.none(`DELETE FROM tbl_users WHERE id IN ($1, $2)`, [ADMIN, PERSON]);
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'Backfill Admin', 'backfill.admin@capture.test', 1, 7, $3, now(), now()),
            ($2, 'Geetanand Backfill', 'geetanand@capture.test', 1, 2, $3, now(), now())`,
    [ADMIN, PERSON, IDS.companies.A]
  );
  // Today's state: still mapped to A1 (the backfill places user events there).
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
     VALUES ($1, $2, $3, 1)`,
    [PERSON, HOSP, A1]
  );
  ({ id: processId } = await db.one(
    `INSERT INTO tbl_approval_processes (company_id, name, created_by, process_type)
     VALUES ($1, 'Backfill Workflow', $2, 'RFQ') RETURNING id`,
    [IDS.companies.A, ADMIN]
  ));
  ({ user_type: readerType } = await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [READER]));
  await db.none(`UPDATE tbl_users SET user_type = 7 WHERE id = $1`, [READER]);

  // 1. An account created with an approval role and a unit.
  await audit(R(1), "tbl_users", "INSERT", PERSON, null, { id: PERSON, name: "Geetanand Backfill", status: 1 });
  await audit(R(1), "tbl_hospitality_user_mappings", "INSERT", 1, null,
    { user_id: PERSON, hospitality_company_id: HOSP, hospitality_hotel_id: A1, mapping_type: 1 });
  await audit(R(1), "tbl_user_role_scopes", "INSERT", 1, null,
    { user_id: PERSON, role_id: 14, company_id: HOSP, hotel_id: A1 });

  // 2. Removed from a business unit (A2), roles there cascading away.
  await audit(R(2), "tbl_hospitality_user_mappings", "DELETE", 2,
    { user_id: PERSON, hospitality_company_id: HOSP, hospitality_hotel_id: A2, mapping_type: 1 }, null);
  await audit(R(2), "tbl_user_role_scopes", "DELETE", 2,
    { user_id: PERSON, role_id: 13, company_id: HOSP, hotel_id: A2 }, null);

  // 3. An approval workflow created.
  await audit(R(3), "tbl_approval_processes", "INSERT", processId, null,
    { id: processId, company_id: IDS.companies.A, name: "Backfill Workflow" });

  // 4. The edit screen's delete-and-reinsert: P1 swapped for P2 at A1, plus
  //    the profile row's bookkeeping columns.
  await audit(R(4), "tbl_user_role_scopes", "DELETE", 3,
    { user_id: PERSON, role_id: 13, company_id: HOSP, hotel_id: A1 }, null);
  await audit(R(4), "tbl_user_role_scopes", "INSERT", 4, null,
    { user_id: PERSON, role_id: 14, company_id: HOSP, hotel_id: A1 });
  await audit(R(4), "tbl_users", "UPDATE", PERSON, { updated_at: "a" }, { updated_at: "b" });

  // 5. Deactivated by the admin.
  await audit(R(5), "tbl_users", "UPDATE", PERSON, { status: 1, updated_at: "a" }, { status: 0, updated_at: "b" });

  // 6. A password reset the admin sent (the reset writes the OTP).
  await audit(R(6), "tbl_users", "UPDATE", PERSON, { otp: null }, { otp: "123456" });

  // 7. NOT an event: the person's own login rewriting their user agent.
  await audit(R(7), "tbl_users", "UPDATE", PERSON, { user_agent: "x", endpoint: "a" }, { user_agent: "y", endpoint: "b" }, PERSON);

  // 8. NOT reconstructed: the live trail already has this request.
  await audit(R(8), "tbl_user_role_scopes", "INSERT", 5, null,
    { user_id: PERSON, role_id: 13, company_id: HOSP, hotel_id: A1 });
  await db.none(
    `INSERT INTO tbl_activity_events (source, category, severity, actor_type, actor_label,
                                      hospitality_company_id, summary, request_id)
     VALUES ('HTTP', 'People', 'notable', 'USER', 'Backfill Admin', $1, 'live event', $2)`,
    [HOSP, R(8)]
  );

  // NOT an event: a script with no request id.
  await audit(null, "tbl_user_role_scopes", "INSERT", 6, null,
    { user_id: PERSON, role_id: 13, company_id: HOSP, hotel_id: A1 });
});

afterAll(async () => {
  await cleanUp();
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [READER, readerType]);
  await db.none(`DELETE FROM tbl_users WHERE id IN ($1, $2)`, [ADMIN, PERSON]);
  await closeDb();
});

describe("admin_actions backfill", () => {
  let rows;
  let byRequest;
  let a1Name;
  let a2Name;

  beforeAll(async () => {
    await runAdminSource();
    rows = await reconstructed();
    byRequest = Object.fromEntries(rows.map((r) => [r.request_id, r]));
    ({ name: a1Name } = await db.one(`SELECT name FROM tbl_hospitality_company_hotels WHERE id = $1`, [A1]));
    ({ name: a2Name } = await db.one(`SELECT name FROM tbl_hospitality_company_hotels WHERE id = $1`, [A2]));
  });

  it("rebuilds exactly the six admin actions and nothing else", () => {
    expect(rows.map((r) => r.request_id).sort()).toEqual([R(1), R(2), R(3), R(4), R(5), R(6)].sort());
  });

  it("names the account created and the roles it was given", () => {
    const e = byRequest[R(1)];
    expect(e.event_key).toBe("user_created");
    expect(e.category).toBe("People");
    expect(e.hospitality_company_id).toBe(HOSP);
    expect(e.summary).toBe(`Backfill Admin created an account for Geetanand Backfill with approval roles — Final Awarding P2 at ${a1Name}`);
  });

  it("places a business-unit removal at the unit removed from", () => {
    const e = byRequest[R(2)];
    expect(e.event_key).toBe("user_mapping_removed");
    expect(e.hospitality_company_id).toBe(HOSP);
    expect(e.hotel_id).toBe(A2);
    expect(e.summary).toBe(`Backfill Admin removed Geetanand Backfill from ${a2Name}`);
  });

  it("files a workflow company-wide under its buyer company", () => {
    const e = byRequest[R(3)];
    expect(e.event_key).toBe("approval_process_created");
    expect(e.hospitality_company_id).toBeNull();
    expect(e.buyer_company_id).toBe(IDS.companies.A);
    expect(e.summary).toBe('Backfill Admin created the approval workflow "Backfill Workflow"');
  });

  it("reports a role swap as what changed, not as everything deleted and re-added", () => {
    const e = byRequest[R(4)];
    expect(e.event_key).toBe("user_updated");
    expect(e.summary).toBe(
      `Backfill Admin changed Geetanand Backfill's approval roles — removed Final Awarding P1 at ${a1Name}; added Final Awarding P2 at ${a1Name}`
    );
  });

  it("names a deactivation and a password reset", () => {
    expect(byRequest[R(5)].summary).toBe("Backfill Admin deactivated Geetanand Backfill's account");
    expect(byRequest[R(6)].event_key).toBe("password_reset_sent");
    expect(byRequest[R(6)].summary).toBe("Backfill Admin sent a password reset to Geetanand Backfill");
  });

  it("marks every row reconstructed and keeps the real actor and request", () => {
    for (const e of rows) {
      expect(e.is_reconstructed).toBe(true);
      expect(e.source).toBe("BACKFILL");
      expect(e.actor_user_id).toBe(ADMIN);
      expect(e.actor_type).toBe("USER");
      expect(e.metadata.source_id).toBe(e.request_id);
      expect(e.buyer_company_id).toBe(IDS.companies.A);
    }
  });

  it("adds nothing when run again", async () => {
    expect(await runAdminSource()).toBe(0);
    expect(await reconstructed()).toHaveLength(6);
  });

  it("lets an administrator open the rows each rebuilt event came from", async () => {
    const client = await httpClient(READER);
    const res = await client.get(`/api/v1/activity/${byRequest[R(2)].id}/changes`);
    expect(res.status).toBe(200);
    expect(res.body.data.changes.map((c) => c.table_name)).toEqual(
      expect.arrayContaining(["tbl_hospitality_user_mappings", "tbl_user_role_scopes"])
    );
  });
});
