/**
 * Company administrator as a capability rather than a user type (T0).
 *
 * `acl([7])` compares the single scalar `tbl_users.user_type`, which makes
 * admin and buyer mutually exclusive. That is the reason promoting a buyer
 * would silently revoke their transactional access — there are 33 numeric
 * `user_type` branches in the RFQ and PO read paths, one of which lists
 * "2, 3, 8, 9, 10" and not 7 — and the reason all three production admins see
 * nothing: visibility is decided by `resolveHospitalityCompanyScope` and
 * `buildScopeExistsClause`, and admins hold no mappings and no role scopes.
 *
 * Holding the capability as a permission makes an administrator an ordinary
 * buyer who also holds `company.admin`: scoped like a buyer, listed like a
 * buyer, promotable without moving `user_type`.
 *
 * The gate accepts the legacy `user_type = 7` as well, deliberately. Landing
 * this must not change the behaviour of any existing account, so there is no
 * flag day; migrating the three legacy accounts is a separate step.
 */
import { db, closeDb } from "../setup/db.js";
import { isCompanyAdmin } from "../../app/middleware/companyAdmin.js";
import { IDS } from "../fixtures/ids.js";

const BUYER = IDS.users.a1_proc_buyer;
const ADMIN = IDS.users.companyA_admin;

let adminRoleId;
let restoreAdminType;
const grantedScopes = [];

beforeAll(async () => {
  const row = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [ADMIN]);
  restoreAdminType = row.user_type;
  await db.none("UPDATE tbl_users SET user_type = 7 WHERE id = $1", [ADMIN]);

  const role = await db.one(
    "SELECT id FROM tbl_roles WHERE title = 'Company Administrator'"
  );
  adminRoleId = role.id;
});

afterAll(async () => {
  await db.none("UPDATE tbl_users SET user_type = $2 WHERE id = $1", [ADMIN, restoreAdminType]);
  for (const id of grantedScopes) {
    await db.none("DELETE FROM tbl_user_role_scopes WHERE id = $1", [id]);
  }
  await db.none("DELETE FROM tbl_audit_row_changes WHERE table_name IN ('tbl_users','tbl_user_role_scopes')");
  await closeDb();
});

// Idempotent: uq_user_role_scope_tuple refuses a duplicate grant, which is
// the UM-7 guard doing its job. The helper should not trip over it.
const grantCapability = async (userId) => {
  const row = await db.oneOrNone(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, adminRoleId, IDS.hospitality.A]
  );
  if (row) grantedScopes.push(row.id);
  return row?.id ?? null;
};

describe("the company.admin capability", () => {
  it("is seeded as a permission, on a system role", async () => {
    const permission = await db.oneOrNone(
      "SELECT id FROM tbl_permissions WHERE resource = 'company' AND action = 'admin'"
    );
    expect(permission).not.toBeNull();

    const role = await db.one(
      "SELECT created_by FROM tbl_roles WHERE title = 'Company Administrator'"
    );
    // created_by IS NULL marks a system role, which keeps it out of the
    // custom-role editor and behind the "cannot be modified" guard.
    expect(role.created_by).toBeNull();
  });

  it("recognises a buyer who has been granted it", async () => {
    expect(await isCompanyAdmin({ id: BUYER, user_type: 2 })).toBe(false);

    await grantCapability(BUYER);
    expect(await isCompanyAdmin({ id: BUYER, user_type: 2 })).toBe(true);
  });

  it("grants the capability without moving user_type", async () => {
    // The entire point: none of the 33 numeric user_type branches in the read
    // paths sees anything different, so a promoted buyer keeps their job.
    //
    // Asserted as "unchanged" rather than "equals 2" because the fixtures
    // leave user_type NULL on purpose (tests/fixtures/users.js:31) — the
    // invariant is that granting does not touch it, whatever it started as.
    const before = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [BUYER]);
    await grantCapability(BUYER);
    const after = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [BUYER]);

    expect(after.user_type).toBe(before.user_type);
    expect(await isCompanyAdmin({ id: BUYER, user_type: before.user_type })).toBe(true);
  });

  it("still accepts a legacy user_type 7 account", async () => {
    // No flag day: existing admins must keep working the day this lands.
    expect(await isCompanyAdmin({ id: ADMIN, user_type: 7 })).toBe(true);
  });

  it("refuses somebody with neither", async () => {
    expect(await isCompanyAdmin({ id: IDS.users.a1_eng_buyer, user_type: 2 })).toBe(false);
  });

  it("refuses an absent or malformed user rather than throwing", async () => {
    expect(await isCompanyAdmin(null)).toBe(false);
    expect(await isCompanyAdmin({})).toBe(false);
    expect(await isCompanyAdmin({ id: 0, user_type: 2 })).toBe(false);
  });

  it("refuses an id that matches nothing, however odd", async () => {
    // Including one outside int4 range. Postgres compares it without raising,
    // so this is the no-rows path rather than the error path.
    //
    // The error path itself — the catch in isCompanyAdmin, which returns false
    // so the gate fails closed — is deliberately not asserted here. It cannot
    // be reached without breaking the database underneath the test, and
    // mocking the connection to reach it would test the mock rather than the
    // behaviour. Recorded as a known untested line rather than covered by a
    // test that only appears to cover it.
    expect(await isCompanyAdmin({ id: 9999999999999, user_type: 2 })).toBe(false);
    expect(await isCompanyAdmin({ id: -1, user_type: 2 })).toBe(false);
  });

  it("cannot be conferred by anything on the request", async () => {
    // can() resolves permissions through x-company-id / x-hotel-id headers,
    // which this codebase's own security work found untrustworthy. The
    // capability comes from granted scopes and nothing else, so decorating the
    // caller with company or hotel claims must change nothing.
    const impostor = {
      id: IDS.users.a1_eng_buyer,
      user_type: 2,
      company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      headers: { "x-company-id": String(IDS.hospitality.A) },
      is_admin: true,
      permissions: { company: ["admin"] },
    };
    expect(await isCompanyAdmin(impostor)).toBe(false);
  });
});
