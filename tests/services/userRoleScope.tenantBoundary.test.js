/**
 * Role-scope writes must stay inside the acting admin's own tenant.
 *
 * PUT /api/v1/users/update-user-detail accepts a `roles[]` array where every
 * entry names the hospitality company the grant applies to. Those ids used to
 * be written into tbl_user_role_scopes verbatim — nothing checked that the
 * named company belonged to the admin's own buyer parent.
 *
 * The only thing enforcing the boundary was the UI: RoleScopeSelector fills
 * its company dropdown from GET /hospitality/entities, which is scoped to
 * `hc.buyer_company_id = req.user.company_id`. A hand-crafted request skips
 * the dropdown entirely, so the check has to exist on the server.
 *
 * Everything here drives the real HTTP endpoint through the full middleware
 * chain (auth → Joi → controller), and asserts on the persisted rows — a
 * status code alone would not prove that nothing was written.
 */

import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";

// Local ID block — 881xx is unused by fixtures and by the sibling
// approvalPropagation.scopedImpact suite (which owns 88001/88002).
const ADMIN_A_ID = 88101; // user_type 7 under buyer parent A
const TARGET_ID = 88102; // ordinary buyer under parent A — the edit target
const ADMIN_NULL_ID = 88103; // user_type 7 with company_id NULL (prod user 268)

const ROLE_R = ROLE_IDS.TECH_EVAL; // 6
const ROLE_R2 = ROLE_IDS.TENDER_APPROVER; // 4

/** The row the target already holds before every test. */
const EXISTING_SCOPE = {
  role_id: ROLE_R,
  company_id: IDS.hospitality.A,
  hotel_id: IDS.hotels.A1,
};

/** The payload shape the frontend sends: the FULL desired role list. */
function rolesPayload(scopes) {
  return scopes.map((s) => ({
    role_id: s.role_id,
    company_id: s.company_id,
    hotel_id: s.hotel_id ?? null,
    department_id: null,
    process_id: null,
  }));
}

/** Read back the persisted scope tuples, ordered for stable comparison. */
async function scopesOf(userId) {
  return db.any(
    `SELECT role_id, company_id, hotel_id, department_id, process_id
       FROM tbl_user_role_scopes
      WHERE user_id = $1
      ORDER BY role_id, company_id, hotel_id NULLS FIRST`,
    [userId]
  );
}

async function resetTargetScopes() {
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [TARGET_ID]);
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
     VALUES ($1, $2, $3, $4, NULL, NULL)`,
    [TARGET_ID, EXISTING_SCOPE.role_id, EXISTING_SCOPE.company_id, EXISTING_SCOPE.hotel_id]
  );
}

beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_users (id, name, email, mobile, password, user_type, status, company_id)
     VALUES ($1, 'Tenant Boundary Admin A', 'tenant.boundary.admin.a@test.local', '9000088101', 'x', 7, 1, $4),
            ($2, 'Tenant Boundary Target',  'tenant.boundary.target@test.local',  '9000088102', 'x', 2, 1, $4),
            ($3, 'Tenant Boundary Admin Null', 'tenant.boundary.admin.null@test.local', '9000088103', 'x', 7, 1, NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_A_ID, TARGET_ID, ADMIN_NULL_ID, IDS.companies.A]
  );
});

beforeEach(resetTargetScopes);

afterAll(async () => {
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [
    [ADMIN_A_ID, TARGET_ID, ADMIN_NULL_ID],
  ]);
  await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [
    [ADMIN_A_ID, TARGET_ID, ADMIN_NULL_ID],
  ]);
});

describe("role scopes may only name hospitality companies the admin owns", () => {
  it("rejects a hospitality company belonging to another buyer parent, writing nothing", async () => {
    const before = await scopesOf(TARGET_ID);

    const client = await httpClient(ADMIN_A_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      // Hospitality B sits under buyer parent B — admin A must never be able
      // to grant a role there, however the request is constructed.
      roles: rolesPayload([{ role_id: ROLE_R, company_id: IDS.hospitality.B, hotel_id: IDS.hotels.B1 }]),
      confirmed_approval_impact: true,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ROLE_SCOPE_COMPANY_FORBIDDEN");

    // Provably unchanged — contents, not just the count.
    expect(await scopesOf(TARGET_ID)).toEqual(before);
    expect(before).toHaveLength(1);
  });

  it("accepts a hospitality company under the admin's own buyer parent", async () => {
    const client = await httpClient(ADMIN_A_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      roles: rolesPayload([
        EXISTING_SCOPE,
        { role_id: ROLE_R2, company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A2 },
      ]),
      confirmed_approval_impact: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();

    const after = await scopesOf(TARGET_ID);
    expect(after).toHaveLength(2);
    expect(after.map((r) => [r.role_id, r.company_id, r.hotel_id])).toEqual([
      [ROLE_R2, IDS.hospitality.A, IDS.hotels.A2],
      [ROLE_R, IDS.hospitality.A, IDS.hotels.A1],
    ]);
  });

  it("accepts a company-wide grant (hotel_id NULL) under the admin's own parent", async () => {
    const client = await httpClient(ADMIN_A_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      roles: rolesPayload([{ role_id: ROLE_R, company_id: IDS.hospitality.A, hotel_id: null }]),
      confirmed_approval_impact: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();

    const after = await scopesOf(TARGET_ID);
    expect(after).toHaveLength(1);
    expect(after[0].company_id).toBe(IDS.hospitality.A);
    expect(after[0].hotel_id).toBeNull();
  });

  it("rejects the WHOLE payload when one entry of many is foreign — no partial write", async () => {
    const before = await scopesOf(TARGET_ID);

    const client = await httpClient(ADMIN_A_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      roles: rolesPayload([
        // Genuinely theirs …
        { role_id: ROLE_R2, company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A2 },
        // … smuggled in alongside one that is not.
        { role_id: ROLE_R, company_id: IDS.hospitality.B, hotel_id: IDS.hotels.B1 },
      ]),
      confirmed_approval_impact: true,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ROLE_SCOPE_COMPANY_FORBIDDEN");

    // The valid half must NOT have landed. `roles` is a full replace, so a
    // partial write would also have destroyed the pre-existing row.
    expect(await scopesOf(TARGET_ID)).toEqual(before);
    expect(await scopesOf(TARGET_ID)).toHaveLength(1);
  });

  it("rejects a hospitality company id that does not exist at all", async () => {
    const before = await scopesOf(TARGET_ID);

    const client = await httpClient(ADMIN_A_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      roles: rolesPayload([{ role_id: ROLE_R, company_id: 99999, hotel_id: null }]),
      confirmed_approval_impact: true,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ROLE_SCOPE_COMPANY_FORBIDDEN");
    expect(await scopesOf(TARGET_ID)).toEqual(before);
  });

  it("leaves an ordinary profile edit that omits roles[] completely alone", async () => {
    const before = await scopesOf(TARGET_ID);

    const client = await httpClient(ADMIN_A_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      name: "Tenant Boundary Target Renamed",
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    expect(await scopesOf(TARGET_ID)).toEqual(before);
  });
});

describe("an admin with no buyer parent (company_id NULL) fails closed", () => {
  /**
   * Production user 268 is an ACTIVE user_type 7 with company_id NULL. With no
   * parent company there is no tenant to validate a submitted hospitality
   * company against, so the permitted set is empty and every role-scope write
   * is refused.
   *
   * Verified read-only against production before choosing this: that account
   * has never once called this endpoint (tbl_users.updated_by — which this
   * handler stamps on every successful call — has 0 rows for 268, vs 111 for
   * admin 150 and 5 for admin 402). Its only writes were 22 user CREATIONS in
   * a single 32-minute window on 2026-02-28, through a different endpoint.
   * Cross-user edits are already inert for it besides: the UPDATE is gated on
   * `company_id = <admin's company_id>`, which renders as `company_id = null`
   * and matches no row. Failing closed regresses nothing that works today.
   */
  it("refuses any role-scope write and leaves the rows untouched", async () => {
    const before = await scopesOf(TARGET_ID);

    const client = await httpClient(ADMIN_NULL_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      roles: rolesPayload([{ role_id: ROLE_R, company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1 }]),
      confirmed_approval_impact: true,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ROLE_SCOPE_COMPANY_FORBIDDEN");
    expect(await scopesOf(TARGET_ID)).toEqual(before);
  });

  it("can still edit its own profile, because that never touches roles[]", async () => {
    const client = await httpClient(ADMIN_NULL_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      name: "Tenant Boundary Admin Null",
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
  });
});
