/**
 * HN-3 — departments on the People list.
 *
 * Ashlesha's report: verifying somebody's department meant opening every mapped
 * user in turn. The payload behind that list carried the person, their mapping
 * level and whether projects auto-map — and nothing about departments.
 *
 * The choice worth testing is *which* department. Two sources exist and they
 * disagree: tbl_user_department (251 of 258 mapped users in production) and the
 * department on their role scopes (227). The scoped one is what routes
 * approvals and what opening the user actually shows, which is the trip this
 * saves — so that is the one reported.
 *
 * And three states, not two: a role scope with no department restriction means
 * ALL departments, which is the broadest grant there is and must never render
 * as the narrowest.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import { IDS } from "../fixtures/ids.js";

const ADMIN = IDS.users.companyA_admin;
const SUBJECT = IDS.users.a1_proc_techEval;
// Someone with no role scope in company A at all — the fixture users under A
// all carry one, so proving the "no roles here" and cross-company cases needs
// an outsider mapped in for the duration.
const OUTSIDER = IDS.users.companyB_admin;
const URL = `/api/v1/hospitality/company/${IDS.hospitality.A}/user-mappings?include_all=true`;

let restoreAdminType;
let mappingId = null;
let outsiderMappingId = null;
const grants = [];

const rowFor = (body, userId) =>
  (body?.data || []).find((r) => Number(r.user_id) === userId);

beforeAll(async () => {
  ({ user_type: restoreAdminType } = await db.one(
    "SELECT user_type FROM tbl_users WHERE id = $1", [ADMIN]
  ));
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);

  // The subject must be mapped to the company to appear on the list at all.
  const existing = await db.oneOrNone(
    `SELECT id FROM tbl_hospitality_user_mappings
      WHERE user_id = $1 AND hospitality_company_id = $2 AND mapping_type = 0`,
    [SUBJECT, IDS.hospitality.A]
  );
  if (!existing) {
    const row = await db.one(
      `INSERT INTO tbl_hospitality_user_mappings
              (user_id, hospitality_company_id, mapping_type, hospitality_hotel_id)
       VALUES ($1, $2, 0, NULL) RETURNING id`,
      [SUBJECT, IDS.hospitality.A]
    );
    mappingId = Number(row.id);
  }

  const outsiderRow = await db.oneOrNone(
    `SELECT id FROM tbl_hospitality_user_mappings
      WHERE user_id = $1 AND hospitality_company_id = $2 AND mapping_type = 0`,
    [OUTSIDER, IDS.hospitality.A]
  );
  if (!outsiderRow) {
    const row = await db.one(
      `INSERT INTO tbl_hospitality_user_mappings
              (user_id, hospitality_company_id, mapping_type, hospitality_hotel_id)
       VALUES ($1, $2, 0, NULL) RETURNING id`,
      [OUTSIDER, IDS.hospitality.A]
    );
    outsiderMappingId = Number(row.id);
  }
});

afterEach(async () => {
  await revokeRoleScopes(db, grants.splice(0));
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [ADMIN, restoreAdminType]);
  for (const id of [mappingId, outsiderMappingId]) {
    if (id) await db.none("DELETE FROM tbl_hospitality_user_mappings WHERE id = $1", [id]);
  }
  await db.none(
    "DELETE FROM tbl_audit_row_changes WHERE table_name IN ('tbl_user_role_scopes','tbl_hospitality_user_mappings','tbl_users')"
  );
  await closeDb();
});

describe("departments on the People list", () => {
  it("names the departments the person actually operates in", async () => {
    grants.push(
      await grantRoleScope(db, {
        userId: SUBJECT, roleId: 2,
        companyId: IDS.hospitality.A, departmentId: IDS.departments.proc,
      })
    );

    const client = await httpClient(ADMIN);
    const res = await client.get(URL);
    expect(res.status).toBe(200);

    const row = rowFor(res.body, SUBJECT);
    expect(row).toBeDefined();
    expect(row.departments).toContain("Procurement");
    expect(row.all_departments).toBe(false);
    expect(row.has_roles_here).toBe(true);
  });

  it("reports an unrestricted scope as all departments, not as none", async () => {
    // The state most likely to be got wrong. A role scope with department_id
    // NULL is all-department access — the broadest grant — and an empty list
    // would read as the narrowest.
    grants.push(
      await grantRoleScope(db, {
        userId: SUBJECT, roleId: 2,
        companyId: IDS.hospitality.A, departmentId: null,
      })
    );

    const client = await httpClient(ADMIN);
    const row = rowFor((await client.get(URL)).body, SUBJECT);
    expect(row.all_departments).toBe(true);
  });

  it("says when somebody is mapped but holds no role here at all", async () => {
    // Different from "no department": this person cannot act in the company at
    // all, which is worth seeing on the list rather than discovering later.
    const client = await httpClient(ADMIN);
    const row = rowFor((await client.get(URL)).body, OUTSIDER);
    expect(row).toBeDefined();
    expect(row.has_roles_here).toBe(false);
    expect(row.departments).toEqual([]);
    expect(row.all_departments).toBe(false);
  });

  it("does not report a department granted in another company", async () => {
    // Departments are global rows, so a scope in company B naming a department
    // would leak onto company A's list if the query forgot to constrain the
    // company. This person's only scopes are in B.
    grants.push(
      await grantRoleScope(db, {
        userId: OUTSIDER, roleId: 2,
        companyId: IDS.hospitality.B, departmentId: IDS.departments.fb,
      })
    );

    const client = await httpClient(ADMIN);
    const row = rowFor((await client.get(URL)).body, OUTSIDER);
    expect(row.departments).not.toContain("F&B");
    expect(row.has_roles_here).toBe(false);
  });
});
