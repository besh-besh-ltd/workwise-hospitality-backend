/**
 * What the company.admin capability actually lets someone do (T0).
 *
 * Making administration a capability is only half the change. Roughly twenty
 * places still asked the old question — `user_type === 7` — and each one is a
 * door that stays shut for an administrator promoted the new way. The worst of
 * them is the one below: `update_user_detail` has no route gate, because it
 * also serves self-edit, so a single line in the controller decides who may
 * edit somebody else's account. Read off user_type, it meant a capability
 * administrator could not manage a single user — the core of the job.
 *
 * These are behavioural: a real request, refused, then the same request
 * allowed once the capability is granted and nothing else has changed.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { requestIsCompanyAdmin } from "../../app/middleware/companyAdmin.js";

const BUYER = IDS.users.a1_proc_buyer;   // promoted mid-suite
const TARGET = IDS.users.a1_proc_techEval;

let adminRoleId;
let grantId = null;
let originalTargetName;

const grantCapability = async () => {
  const row = await db.oneOrNone(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
    [BUYER, adminRoleId, IDS.hospitality.A]
  );
  grantId = row?.id ?? grantId;
};

const revokeCapability = async () => {
  if (grantId) await db.none("DELETE FROM tbl_user_role_scopes WHERE id = $1", [grantId]);
  grantId = null;
};

beforeAll(async () => {
  ({ id: adminRoleId } = await db.one(
    "SELECT id FROM tbl_roles WHERE title = 'Company Administrator'"
  ));
  ({ name: originalTargetName } = await db.one(
    "SELECT name FROM tbl_users WHERE id = $1",
    [TARGET]
  ));
});

afterEach(revokeCapability);

afterAll(async () => {
  await db.none("UPDATE tbl_users SET name = $2 WHERE id = $1", [TARGET, originalTargetName]);
  await db.none(
    "DELETE FROM tbl_audit_row_changes WHERE table_name IN ('tbl_users','tbl_user_role_scopes')"
  );
  await closeDb();
});

describe("administering other people", () => {
  it("refuses an ordinary buyer", async () => {
    const client = await httpClient(BUYER);
    const res = await client
      .put("/api/v1/users/update-user-detail")
      .send({ user_id: TARGET, name: "Renamed by a non-admin" });

    expect(res.status).toBe(403);
    const row = await db.one("SELECT name FROM tbl_users WHERE id = $1", [TARGET]);
    expect(row.name).toBe(originalTargetName);
  });

  it("allows the same person once they hold the capability", async () => {
    // Nothing about the account changes except the grant — in particular
    // user_type does not move, which is the whole point of the model.
    const before = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [BUYER]);
    await grantCapability();
    const after = await db.one("SELECT user_type FROM tbl_users WHERE id = $1", [BUYER]);
    expect(after.user_type).toBe(before.user_type);

    const client = await httpClient(BUYER);
    const res = await client
      .put("/api/v1/users/update-user-detail")
      .send({ user_id: TARGET, name: "Renamed by a capability admin" });

    expect(res.status).toBe(200);
    const row = await db.one("SELECT name FROM tbl_users WHERE id = $1", [TARGET]);
    expect(row.name).toBe("Renamed by a capability admin");
  });

  it("stops again the moment the capability is revoked", async () => {
    await grantCapability();
    await revokeCapability();

    const client = await httpClient(BUYER);
    const res = await client
      .put("/api/v1/users/update-user-detail")
      .send({ user_id: TARGET, name: "Renamed after revocation" });

    expect(res.status).toBe(403);
  });
});

describe("asking the question once per request", () => {
  it("does not re-query for a second caller in the same request", async () => {
    // Several handlers ask twice — a guard, then a branch that widens a
    // query's scope — and each ask is a round trip. Memoised on the request
    // for the same reason resolveApprovalCompanyScope is.
    const req = { user: { id: BUYER, user_type: 2 } };
    expect(await requestIsCompanyAdmin(req)).toBe(false);

    await grantCapability();
    // The grant is real, but this request already has its answer.
    expect(await requestIsCompanyAdmin(req)).toBe(false);
    expect(await requestIsCompanyAdmin({ user: { id: BUYER, user_type: 2 } })).toBe(true);
  });
});
