/**
 * Granting access that a user already holds changes nothing.
 *
 * The admin screens grant a hospitality company (or one business unit) to a
 * user. Granting the same company again used to add another identical row —
 * that is how production came to hold the same company-level grant up to five
 * times for one buyer, which broke his RFQ draft save. With the unique key now
 * NULLS NOT DISTINCT (migrations/20261024120000_user_mapping_nulls_not_distinct
 * .sql) a repeat grant updates the existing row instead; and a single request
 * naming the same grant twice must not trip "ON CONFLICT DO UPDATE command
 * cannot affect row a second time" — for user creation that error would be
 * swallowed and leave the new user with no access at all.
 *
 * Pattern B (commit + cleanup): both endpoints commit their own writes.
 *   npm test -- --testPathPatterns "hospitality.userMappingIdempotency"
 */
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";

// ---- Users (84001-84099) ----
const ADMIN_ID = 84001;   // user_type 7 — company admin of Company A
const TARGET_ID = 84002;  // buyer in Company A, starts with no grant
const TARGET2_ID = 84003; // buyer in Company A, starts with no grant

const CREATE_EMAIL = "dupmap.create@test.local";
const CREATE_MOBILE = "9840000101";

const createdUserIds = [];

const companyGrants = (userId) =>
  db.any(
    `SELECT id, auto_map_projects
       FROM tbl_hospitality_user_mappings
      WHERE user_id = $1 AND hospitality_company_id = $2 AND mapping_type = 0
      ORDER BY id`,
    [userId, IDS.hospitality.A]
  );

async function removeUsers(ids) {
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_user_department WHERE user_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [ids]);
}

beforeAll(async () => {
  // A crashed prior run against the same TEST_RUN_ID database may have left these.
  const stale = await db.map(
    `SELECT id FROM tbl_users WHERE email = $1 OR mobile = $2`,
    [CREATE_EMAIL, CREATE_MOBILE],
    (r) => r.id
  );
  await removeUsers([...stale, ADMIN_ID, TARGET_ID, TARGET2_ID]);

  await db.none(
    `INSERT INTO tbl_users (id, name, email, mobile, password, user_type, status, company_id)
     VALUES ($1, 'Dup Map Admin',    'dupmap.admin@test.local',   '9840000001', 'x', 7, 1, $4),
            ($2, 'Dup Map Target',   'dupmap.target@test.local',  '9840000002', 'x', 2, 1, $4),
            ($3, 'Dup Map Target 2', 'dupmap.target2@test.local', '9840000003', 'x', 2, 1, $4)`,
    [ADMIN_ID, TARGET_ID, TARGET2_ID, IDS.companies.A]
  );
});

afterAll(async () => {
  await removeUsers([...createdUserIds, ADMIN_ID, TARGET_ID, TARGET2_ID]);
  await closeDb();
});

describe("POST /hospitality/company/:id/map-users — repeat grants", () => {
  it("granting the same company twice leaves one grant, carrying the latest auto-map choice", async () => {
    const admin = await httpClient(ADMIN_ID);
    const grant = (autoMap) =>
      admin
        .post(`/api/v1/hospitality/company/${IDS.hospitality.A}/map-users`)
        .send({ mapping_type: 0, user_ids: [TARGET_ID], auto_map_projects: autoMap });

    expect((await grant(false)).status).toBe(200);
    expect((await grant(true)).status).toBe(200);

    const rows = await companyGrants(TARGET_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].auto_map_projects).toBe(true);
  });

  it("naming the same user twice in one grant leaves one grant", async () => {
    const admin = await httpClient(ADMIN_ID);
    const res = await admin
      .post(`/api/v1/hospitality/company/${IDS.hospitality.A}/map-users`)
      .send({ mapping_type: 0, user_ids: [TARGET2_ID, TARGET2_ID], auto_map_projects: true });

    expect(res.status).toBe(200);
    expect(await companyGrants(TARGET2_ID)).toHaveLength(1);
  });
});

describe("POST /users/create-buyer-company-user — the same company listed twice", () => {
  it("creates the user with exactly one grant for that company", async () => {
    const admin = await httpClient(ADMIN_ID);
    const res = await admin.post("/api/v1/users/create-buyer-company-user").send({
      name: "Dup Map New User",
      email: CREATE_EMAIL,
      mobile: CREATE_MOBILE,
      user_type: 2,
      password: "Passw0rd!23",
      designation: "Tester",
      department_ids: [],
      roles: [],
      mappings: [
        { company_id: IDS.hospitality.A, mapping_level: "company", auto_map_projects: false },
        { company_id: IDS.hospitality.A, mapping_level: "company", auto_map_projects: true },
      ],
    });

    expect(res.status).toBe(200);
    const newUserId = res.body.data?.id;
    expect(newUserId).toBeTruthy();
    createdUserIds.push(newUserId);

    const rows = await companyGrants(newUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0].auto_map_projects).toBe(true);
  });
});
