/**
 * End-to-end proof that the audit trigger learns who is acting.
 *
 * The trigger runs inside Postgres and cannot see the HTTP request, which is
 * why `changed_by` recorded the pooled database role — 'postgres' — for every
 * one of its 105,000 rows. The application now stamps the acting user onto the
 * connection before the query runs.
 *
 * Everything else in the trail is downstream of this working, so it is tested
 * the only way that actually proves it: a real authenticated request over real
 * HTTP against real Postgres, then reading what the trigger wrote.
 */
import { db, closeDb } from "../setup/db.js";
// The application's own pool, not the test harness's. The leak this suite
// guards against can only happen on a connection the app itself reuses, so it
// has to be provoked through the same pool the app uses. jestEnv.js points
// DATABASE_NAME at the test database, so this is safe.
import appDb from "../../app/config/dbConn.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

const COMPANY_ID = IDS.hospitality.A;
const ADMIN = IDS.users.companyA_admin;

let original;
let originalUserType;

const auditRowsFor = (table, recordId, since) =>
  db.any(
    `SELECT operation, actor_user_id, request_id, changed_by, new_data
       FROM tbl_audit_row_changes
      WHERE table_name = $1 AND record_id = $2 AND changed_at >= $3
      ORDER BY id`,
    [table, recordId, since]
  );

beforeAll(async () => {
  // The user fixtures leave user_type NULL on purpose (tests/fixtures/users.js:31),
  // which means acl([7]) rejects every one of them and no admin-gated endpoint
  // can be exercised at all. Granted for this suite and put back afterwards;
  // the broader gap is worth closing separately.
  ({ user_type: originalUserType } = await db.one(
    "SELECT user_type FROM tbl_users WHERE id = $1",
    [ADMIN]
  ));
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);

  original = await db.one(
    `SELECT name, region, contact_email, gst, pan, registered_office_address
       FROM tbl_hospitality_companies WHERE id = $1`,
    [COMPANY_ID]
  );
});

afterAll(async () => {
  // These requests commit, so the fixture has to be put back by hand.
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [
    ADMIN,
    originalUserType,
  ]);
  await db.none("DELETE FROM tbl_audit_row_changes WHERE table_name = 'tbl_users' AND record_id = $1", [ADMIN]);
  await db.none(
    `UPDATE tbl_hospitality_companies
        SET name = $2, region = $3, contact_email = $4, gst = $5, pan = $6
      WHERE id = $1`,
    [
      COMPANY_ID,
      original.name,
      original.region,
      original.contact_email,
      original.gst,
      original.pan,
    ]
  );
  await db.none(
    `DELETE FROM tbl_audit_row_changes
      WHERE table_name = 'tbl_hospitality_companies' AND record_id = $1`,
    [COMPANY_ID]
  );
  await closeDb();
});

describe("the audit trigger records the person behind an HTTP request", () => {
  it("attributes a change to the admin who made it", async () => {
    const since = new Date().toISOString();
    const client = await httpClient(ADMIN);

    const res = await client.put(`/api/v1/hospitality/company/${COMPANY_ID}`).send({
      name: "Company A — renamed by the audit test",
      pan: original.pan || "AAAPZ1234C",
      region: original.region || "West",
    });
    expect(res.status).toBe(200);

    const rows = await auditRowsFor("tbl_hospitality_companies", COMPANY_ID, since);
    expect(rows.length).toBeGreaterThan(0);

    const row = rows[rows.length - 1];
    // The point of the whole exercise: a person, not 'postgres'.
    expect(row.actor_user_id).toBe(ADMIN);
    expect(row.new_data.name).toBe("Company A — renamed by the audit test");
  });

  it("ties the change to the request that caused it", async () => {
    // request_id is what will join a business event to the row changes it
    // produced, so an admin can expand "Priya renamed Company A" and see
    // exactly which columns moved.
    const since = new Date().toISOString();
    const client = await httpClient(ADMIN);

    await client.put(`/api/v1/hospitality/company/${COMPANY_ID}`).send({
      name: "Company A — request id probe",
      pan: original.pan || "AAAPZ1234C",
    });

    const rows = await auditRowsFor("tbl_hospitality_companies", COMPANY_ID, since);
    const row = rows[rows.length - 1];
    expect(row.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does not carry one request's actor into the next", async () => {
    // Connections are pooled and reused. A stamp that were only applied when
    // an actor exists would leave the previous request's user attached to
    // whatever ran next on that connection.
    const since = new Date().toISOString();

    const adminClient = await httpClient(ADMIN);
    await adminClient.put(`/api/v1/hospitality/company/${COMPANY_ID}`).send({
      name: "Company A — leak probe",
      pan: original.pan || "AAAPZ1234C",
    });

    // A write with no request context at all, over the *application's* pool —
    // the one that just served the admin. Going through the test harness's
    // separate pool would prove nothing, because those connections were never
    // stamped in the first place.
    await appDb.none(
      "UPDATE tbl_hospitality_companies SET region = region WHERE id = $1",
      [COMPANY_ID]
    );

    const rows = await auditRowsFor("tbl_hospitality_companies", COMPANY_ID, since);
    const last = rows[rows.length - 1];
    expect(last.actor_user_id).toBeNull();
  });
});
