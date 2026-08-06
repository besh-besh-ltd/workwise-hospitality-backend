// GET /api/v1/po/:po_id/initiators — "who can initiate THIS purchase order?"
// ----------------------------------------------------------------------------
// security.poInitiateWriteGate.test.js pinned the gate: initiating a PO needs
// `awarding.create` OR `awarding.update` on the PO's own company x hotel x
// department x process tuple, on top of the read grant that lets you see it at
// all. That gate is correct, and it leaves the refused user with nothing: a
// disabled button, a 403, and no idea whose desk to walk to. The PO stops.
//
// This endpoint is the answer to that question, and it has exactly ONE
// correctness property:
//
//     every name it returns must genuinely pass assertPoInitiateAccess
//     for this purchase order.
//
// A name that 403s when its owner tries is worse than no name at all — it sends
// someone chasing a colleague who cannot help either. So the list is not a
// hand-written re-statement of the gate: purchaseOrderModel.listPoInitiators
// reads the SAME predicate from the other side, via
// authorizationService.listUsersWithAnyScope, which shares its WHERE clause
// verbatim with assertUserHasScope. The `agreement` describe below is what
// actually holds that line: it runs the real gate for EVERY fixture user and
// asserts set equality with what the endpoint returned.
//
// The subtle half of the property is that the gate is a CONJUNCTION.
// assertPoInitiateAccess runs assertPoAccess first, so passing it needs BOTH a
// read grant (awarding.read / rfq.read / boq.read) AND a write grant
// (awarding.create / awarding.update):
//
//   role 12 COMM_APPROVER     awarding.read                — read, NO write
//   role 13 FINAL_AWARDING_P1 awarding.create + .read      — both
//   role  1 CEO               awarding.create + all reads  — both
//
// A user with the write half and not the read half passes the write gate and
// is then refused 404 by the read gate. Listing them would be precisely the
// false positive this endpoint must never produce — and a one-query
// implementation over the write permissions alone WOULD produce it.
//
// Every role in the seeded reference data happens to pair awarding.create with
// awarding.read, so that combination cannot arise from the fixtures. It is not
// hypothetical: production created exactly it by granting awarding.create to
// Commercial Negotiator N1 (a role holding no PO read), and staging carries
// that grant today. This suite therefore builds the same shape explicitly —
// a role with awarding.create and nothing else — rather than leaving the
// conjunction untested because the seed is too tidy to break it.
//
// PII: the response carries names, employee codes, emails and mobile numbers,
// so the read gate is mandatory and out-of-scope must stay 404 (a 403 would
// confirm the PO exists). A lifecycle endpoint in this codebase once began
// returning personal data without its tenant guard; that is the mistake being
// deliberately not repeated.

import {
  describe, it, expect, afterAll, beforeAll,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import {
  assertPoInitiateAccess, PoAccessError, PoWritePermissionError,
} from "../../app/models/purchaseOrderModel.js";

const READ_ONLY   = IDS.users.a1_proc_commApp;  // role 12 — awarding.read, no create
const WRITE_ONLY  = IDS.users.a1_proc_commEval; // + CREATE_ONLY_ROLE below — write, NO read
const PO_APPROVER = IDS.users.a1_proc_poApp;    // role 13 — both
const WRITER      = IDS.users.a1_eng_buyer;     // + runtime role 13 at (A, A1, proc)
const WRONG_HOTEL = IDS.users.multiHotel;       // + runtime role 13 at (A, A2, proc)
const INACTIVE    = IDS.users.inactive;         // + runtime role 13 at (A, A1, proc), status 0
const FOREIGN     = IDS.users.companyB_admin;   // CEO at hospitality B only
const VENDOR      = IDS.users.vendor_alpha;

// Throwaway rows this suite owns outright, so it can set user_type = 8 without
// mutating a shared fixture user other suites in this shard also read.
const TOP_MGMT_SAME_CO  = 80901; // user_type 8, buyer company A  -> listed
const TOP_MGMT_OTHER_CO = 80902; // user_type 8, buyer company B  -> NOT listed

// A role carrying awarding.create and NOTHING else — the production shape the
// seed data cannot express (see the header). Suite-owned, dropped in afterAll.
const CREATE_ONLY_ROLE = 9901;

let readOnlyClient, writerClient, foreignClient, vendorClient, writeOnlyClient, adminClient;
const grantIds = [];
const created = { rfqIds: [], poIds: [] };

beforeAll(async () => {
  // acl()/noAcl() branch on user_type; the shared fixtures leave it NULL.
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`,
    [[READ_ONLY, WRITE_ONLY, PO_APPROVER, WRITER, WRONG_HOTEL, FOREIGN, INACTIVE,
      IDS.users.companyA_admin]]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);

  // Contact details, so the suite can prove they are carried through — and
  // prove the null case is a null VALUE, not a missing key.
  await db.none(
    `UPDATE tbl_users SET mobile = '+91-9000000016', employee_code = 'EMP-POAPP'
      WHERE id = $1`, [PO_APPROVER]);
  await db.none(
    `UPDATE tbl_users SET mobile = NULL, employee_code = NULL WHERE id = $1`, [WRITER]);

  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id)
     VALUES ($1, 'Top Management A', 'topmgmt.a@test.local', 1, 8, $2),
            ($3, 'Top Management B', 'topmgmt.b@test.local', 1, 8, $4)
     ON CONFLICT (id) DO UPDATE SET status = 1, user_type = 8, company_id = EXCLUDED.company_id`,
    [TOP_MGMT_SAME_CO, IDS.companies.A, TOP_MGMT_OTHER_CO, IDS.companies.B]
  );

  await db.none(
    `INSERT INTO tbl_roles (id, title, description, created_by)
     VALUES ($1, 'Awarding Create Only (test)', 'awarding.create and nothing else', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [CREATE_ONLY_ROLE]
  );
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, p.id FROM tbl_permissions p
      WHERE p.resource::text = 'awarding' AND p.action::text = 'create'
        AND NOT EXISTS (SELECT 1 FROM tbl_role_permissions rp
                         WHERE rp.role_id = $1 AND rp.permission_id = p.id)`,
    [CREATE_ONLY_ROLE]
  );

  // The write half of the gate WITHOUT the read half.
  grantIds.push(await grantRoleScope(db, {
    userId: WRITE_ONLY, roleId: CREATE_ONLY_ROLE,
    companyId: IDS.hospitality.A, hotelId: IDS.hotels.A1, departmentId: IDS.departments.proc,
  }));

  // A write grant at the PO's OWN hotel...
  grantIds.push(await grantRoleScope(db, {
    userId: WRITER, roleId: ROLE_IDS.FINAL_AWARDING_P1,
    companyId: IDS.hospitality.A, hotelId: IDS.hotels.A1, departmentId: IDS.departments.proc,
  }));
  // ...the same grant at a DIFFERENT hotel, which must not put them on the list...
  grantIds.push(await grantRoleScope(db, {
    userId: WRONG_HOTEL, roleId: ROLE_IDS.FINAL_AWARDING_P1,
    companyId: IDS.hospitality.A, hotelId: IDS.hotels.A2, departmentId: IDS.departments.proc,
  }));
  // ...and the same grant held by a user whose account is switched off.
  grantIds.push(await grantRoleScope(db, {
    userId: INACTIVE, roleId: ROLE_IDS.FINAL_AWARDING_P1,
    companyId: IDS.hospitality.A, hotelId: IDS.hotels.A1, departmentId: IDS.departments.proc,
  }));

  readOnlyClient  = await httpClient(READ_ONLY);
  writerClient    = await httpClient(WRITER);
  writeOnlyClient = await httpClient(WRITE_ONLY);
  foreignClient   = await httpClient(FOREIGN);
  vendorClient    = await httpClient(VENDOR);
  adminClient     = await httpClient(IDS.users.companyA_admin);
});

afterAll(async () => {
  // These rows are global — leaving them would leak into every suite sharing
  // this Jest process (maxWorkers is 1).
  await revokeRoleScopes(db, grantIds);
  if (created.poIds.length) {
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [created.poIds]);
  }
  if (created.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqIds]);
  }
  await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`,
    [[TOP_MGMT_SAME_CO, TOP_MGMT_OTHER_CO]]);
  await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [CREATE_ONLY_ROLE]);
  await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [CREATE_ONLY_ROLE]);
  await closeDb();
});

let PO_NO = 8_500_000;

/**
 * A purchase order at an explicit scope. This endpoint reads nothing but the
 * PO's tenancy tuple, so the fixture is the RFQ + the PO header and nothing
 * else — no products, no quotes, no approval instance.
 */
async function makePo({
  hotel = IDS.hotels.A1,
  department = IDS.departments.proc,
  process = IDS.processes.A_P1,
} = {}) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    hospitality: IDS.hospitality.A,
    hotel,
    department,
    process,
  });
  created.rfqIds.push(rfq_id);

  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by)
     VALUES ($1, $2, $3, 'draft', '{}'::int[], 1, 100, $4, 1000, '{}'::int[], $5)
     RETURNING id`,
    [rfq_id, IDS.companies.A, `INITIATORS-PO-${++PO_NO}`, VENDOR, IDS.users.a1_proc_buyer]
  );
  created.poIds.push(po.id);
  return po.id;
}

/** The real gate, as a three-valued answer. */
async function gateFor(userId, poId) {
  const user = await db.one(`SELECT id, user_type FROM tbl_users WHERE id = $1`, [userId]);
  try {
    await assertPoInitiateAccess(user, poId);
    return "PASS";
  } catch (err) {
    if (err instanceof PoAccessError) return "404";
    if (err instanceof PoWritePermissionError) return "403";
    throw err;
  }
}

const actionsOf = (userId) => db.any(
  `SELECT DISTINCT p.resource::text || '.' || p.action::text AS perm
     FROM tbl_user_role_scopes urs
     JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
     JOIN tbl_permissions p       ON p.id = rp.permission_id
    WHERE urs.user_id = $1 AND urs.company_id = $2`,
  [userId, IDS.hospitality.A]
).then((rows) => rows.map((r) => r.perm));

// ===========================================================================
// 0. The premises the rest of this suite rests on. If the seeded role map
//    drifts, these fail loudly instead of the tests below silently asserting
//    something else.
// ===========================================================================
describe("premises: the seeded permission model", () => {
  it("the read-only user holds a read grant and NO awarding write", async () => {
    const perms = await actionsOf(READ_ONLY);
    expect(perms).toContain("awarding.read");
    expect(perms).not.toContain("awarding.create");
    expect(perms).not.toContain("awarding.update");
  });

  it("no seeded role pairs awarding.create with no read at all — hence the suite-owned role", async () => {
    // If the reference data ever grows such a role, this fails and the
    // scaffolding above can be deleted in favour of the real one.
    const rows = await db.any(
      `SELECT rl.id
         FROM tbl_roles rl
        WHERE rl.id <> $1
          AND EXISTS (SELECT 1 FROM tbl_role_permissions rp JOIN tbl_permissions p ON p.id = rp.permission_id
                       WHERE rp.role_id = rl.id AND (p.resource::text || '.' || p.action::text)
                             IN ('awarding.create','awarding.update'))
          AND NOT EXISTS (SELECT 1 FROM tbl_role_permissions rp JOIN tbl_permissions p ON p.id = rp.permission_id
                           WHERE rp.role_id = rl.id AND (p.resource::text || '.' || p.action::text)
                                 IN ('awarding.read','rfq.read','boq.read'))`,
      [CREATE_ONLY_ROLE]
    );
    expect(rows.map((r) => r.id)).toEqual([]);
  });

  it("the write-only user holds awarding.create and NONE of the read permissions", async () => {
    // This is the conjunction trap: the write half admits them, the read half
    // refuses them 404, so they can NOT initiate and must never be listed.
    const perms = await actionsOf(WRITE_ONLY);
    expect(perms).toContain("awarding.create");
    expect(perms).not.toContain("awarding.read");
    expect(perms).not.toContain("rfq.read");
    expect(perms).not.toContain("boq.read");
  });

  it("the PO approver holds both halves", async () => {
    const perms = await actionsOf(PO_APPROVER);
    expect(perms).toContain("awarding.create");
    expect(perms.some((p) => ["awarding.read", "rfq.read", "boq.read"].includes(p))).toBe(true);
  });
});

// ===========================================================================
// 1. The gate on the endpoint itself. It hands out personal data, so it is a
//    PO read and carries the PO read gate — nothing weaker.
// ===========================================================================
describe("SECURITY: /po/:po_id/initiators is gated like every other PO read", () => {
  it("an out-of-scope caller gets 404 — no list, no PII, no proof the PO exists", async () => {
    const po_id = await makePo();

    const res = await foreignClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(res.status).toBe(404);
    expect(res.body?.code).toBe("PO_NOT_FOUND_OR_OUT_OF_SCOPE");
    expect(res.body?.data).toBeUndefined();
    // Nothing that could carry a name, an email or a phone number came back.
    expect(JSON.stringify(res.body)).not.toMatch(/@test\.local|\+91-/);
  });

  it("a vendor is refused at the route layer", async () => {
    const po_id = await makePo();
    const res = await vendorClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(res.status).toBe(403);
    expect(res.body?.data).toBeUndefined();
  });

  it("a caller who cannot see the PO cannot see who can initiate it, even holding awarding.create", async () => {
    // WRITE_ONLY passes the write half of the gate but not the read half, so
    // the endpoint must treat them exactly like any other stranger.
    const po_id = await makePo();
    expect(await gateFor(WRITE_ONLY, po_id)).toBe("404");

    const res = await writeOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(res.status).toBe(404);
    expect(res.body?.code).toBe("PO_NOT_FOUND_OR_OUT_OF_SCOPE");
  });
});

// ===========================================================================
// 2. The feature itself: a user who cannot initiate is told who can.
// ===========================================================================
describe("a read-only user is given somewhere to go", () => {
  it("can_initiate is false AND the list of people who can is non-empty", async () => {
    const po_id = await makePo();

    // Premise: they really can see this PO, and really cannot initiate it.
    expect((await readOnlyClient.get(`/api/v1/po/${po_id}`)).status).toBe(200);
    expect(await gateFor(READ_ONLY, po_id)).toBe("403");

    const res = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(res.status).toBe(200);
    expect(res.body?.status).toBe(1);
    expect(res.body?.data?.can_initiate).toBe(false);
    // This is the entire point of the endpoint. An empty list here means the
    // refused user is still stuck.
    expect(res.body.data.initiators.length).toBeGreaterThan(0);
    expect(res.body.data.total).toBe(res.body.data.initiators.length);
  });

  it("every listed person carries the fields the UI renders, with nulls as nulls", async () => {
    const po_id = await makePo();
    const res = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);

    for (const i of res.body.data.initiators) {
      expect(Object.keys(i).sort()).toEqual(
        ["email", "employee_code", "mobile", "name", "role_title", "user_id"]
      );
      expect(typeof i.user_id).toBe("number");
      expect(i.name).toBeTruthy();
    }

    // A user with contact details carries them...
    const approver = res.body.data.initiators.find((i) => i.user_id === PO_APPROVER);
    expect(approver).toBeDefined();
    expect(approver.mobile).toBe("+91-9000000016");
    expect(approver.employee_code).toBe("EMP-POAPP");
    expect(approver.role_title).toBe("Final Awarding P1");

    // ...and a user without them reports null rather than dropping the key.
    const writer = res.body.data.initiators.find((i) => i.user_id === WRITER);
    expect(writer).toBeDefined();
    expect(writer.mobile).toBeNull();
    expect(writer.employee_code).toBeNull();
    expect("mobile" in writer).toBe(true);
    expect("employee_code" in writer).toBe(true);
  });

  it("the list is sorted by name", async () => {
    const po_id = await makePo();
    const res = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
    const names = res.body.data.initiators.map((i) => (i.name || "").toLowerCase());
    expect(names).toEqual([...names].sort());
  });

  it("a user who CAN initiate is told so", async () => {
    const po_id = await makePo();
    expect(await gateFor(WRITER, po_id)).toBe("PASS");

    const res = await writerClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(res.status).toBe(200);
    expect(res.body.data.can_initiate).toBe(true);
  });

  it("the caller never appears in their own list", async () => {
    const po_id = await makePo();

    const asWriter = await writerClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(asWriter.body.data.initiators.map((i) => i.user_id)).not.toContain(WRITER);

    // ...and is present for somebody else, so the exclusion is the reason they
    // are missing, not a lack of permission.
    const asReadOnly = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(asReadOnly.body.data.initiators.map((i) => i.user_id)).toContain(WRITER);
  });
});

// ===========================================================================
// 3. THE agreement property. The list is the exact inverse of the gate.
// ===========================================================================
describe("agreement: the list and the gate answer the same question", () => {
  it("every name returned actually passes assertPoInitiateAccess for that PO", async () => {
    const po_id = await makePo();
    const res = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(res.body.data.initiators.length).toBeGreaterThan(0);

    for (const i of res.body.data.initiators) {
      // Anything other than PASS here is a name that would 403 or 404 the
      // person it was shown to.
      expect([i.user_id, await gateFor(i.user_id, po_id)]).toEqual([i.user_id, "PASS"]);
    }
  });

  it("the returned set is EXACTLY the set of users the gate admits", async () => {
    // Run the real gate over every fixture user and compare sets, so a false
    // NEGATIVE (someone who can initiate but is not listed) fails too, not just
    // a false positive.
    //
    // ONE deliberate difference: a super admin of a DIFFERENT buyer company is
    // admitted by the gate (which is company-blind for user_type 8) but is not
    // listed, because this endpoint refuses to hand another tenant's personal
    // mobile number to a stranger. That narrowing only ever REMOVES names, so
    // it cannot introduce the false positive the property is about. It has its
    // own test below.
    const po_id = await makePo();
    const res = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);

    const everyone = await db.any(
      `SELECT id FROM tbl_users
        WHERE id BETWEEN 80001 AND 80999 AND status = 1 AND is_deleted = 0
          AND id <> $1
        ORDER BY id`,
      [TOP_MGMT_OTHER_CO]
    );
    const admitted = [];
    for (const u of everyone) {
      if (u.id !== READ_ONLY && (await gateFor(u.id, po_id)) === "PASS") admitted.push(u.id);
    }

    const asc = (a, b) => a - b;
    expect(admitted.length).toBeGreaterThan(0);
    expect(res.body.data.initiators.map((i) => i.user_id).sort(asc)).toEqual(admitted.sort(asc));
  });

  it("a user whose write grant is at a DIFFERENT hotel is absent", async () => {
    const po_id = await makePo({ hotel: IDS.hotels.A1 });
    // Premise: they can see this PO (baseline rfq.read at A1) and still cannot
    // initiate it, because their awarding.create sits at A2.
    expect(await gateFor(WRONG_HOTEL, po_id)).toBe("403");

    const res = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(res.body.data.initiators.map((i) => i.user_id)).not.toContain(WRONG_HOTEL);

    // Control: at THEIR hotel the same person is both admitted and listed —
    // without it, "absent" could just mean "can never initiate anything".
    // READ_ONLY is scoped to A1, so the A2 PO is asked about as the company
    // admin, whose CEO grant is company-wide.
    const theirPo = await makePo({ hotel: IDS.hotels.A2 });
    expect(await gateFor(WRONG_HOTEL, theirPo)).toBe("PASS");
    const asAdmin = await adminClient.get(`/api/v1/po/${theirPo}/initiators`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.data.initiators.map((i) => i.user_id)).toContain(WRONG_HOTEL);
  });

  it("a user holding awarding.create but no read grant is absent — the gate is a conjunction", async () => {
    const po_id = await makePo();
    expect(await gateFor(WRITE_ONLY, po_id)).toBe("404");

    const res = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(res.body.data.initiators.map((i) => i.user_id)).not.toContain(WRITE_ONLY);
  });
});

// ===========================================================================
// 4. Only people who can actually be reached.
// ===========================================================================
describe("only active, non-vendor users are ever named", () => {
  it("an inactive user holding the write grant is excluded", async () => {
    const po_id = await makePo();
    const row = await db.one(`SELECT status FROM tbl_users WHERE id = $1`, [INACTIVE]);
    expect(row.status).toBe(0); // premise: the account is switched off

    // They hold the very same grant as WRITER, so permissions are not why they
    // are missing.
    const grant = await db.one(
      `SELECT COUNT(*)::int AS c FROM tbl_user_role_scopes
        WHERE user_id = $1 AND role_id = $2 AND hotel_id = $3`,
      [INACTIVE, ROLE_IDS.FINAL_AWARDING_P1, IDS.hotels.A1]
    );
    expect(grant.c).toBeGreaterThan(0);

    const res = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(res.body.data.initiators.map((i) => i.user_id)).not.toContain(INACTIVE);
  });

  it("a blocked user holding the write grant is excluded", async () => {
    const po_id = await makePo();
    await db.none(`UPDATE tbl_users SET status = 2 WHERE id = $1`, [WRITER]);
    try {
      const res = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
      expect(res.body.data.initiators.map((i) => i.user_id)).not.toContain(WRITER);
    } finally {
      await db.none(`UPDATE tbl_users SET status = 1 WHERE id = $1`, [WRITER]);
    }
    // Restored: they are listed again, so status was the reason.
    const after = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(after.body.data.initiators.map((i) => i.user_id)).toContain(WRITER);
  });

  it("no vendor is ever named", async () => {
    const po_id = await makePo();
    const res = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
    const ids = res.body.data.initiators.map((i) => i.user_id);
    const vendors = await db.any(`SELECT id FROM tbl_users WHERE user_type = 3`);
    for (const v of vendors) expect(ids).not.toContain(v.id);
  });
});

// ===========================================================================
// 5. Super admins (user_type 8). They DO pass the gate — assertPoInitiateAccess
//    returns early for them and they hold no tbl_user_role_scopes rows — so
//    they belong on the list. The gate is company-blind for them; this list is
//    deliberately not, because handing another tenant's mobile number to a
//    stranger is not an improvement over saying nothing.
// ===========================================================================
describe("super admins", () => {
  it("a super admin of the PO's own buyer company is listed", async () => {
    const po_id = await makePo();
    expect(await gateFor(TOP_MGMT_SAME_CO, po_id)).toBe("PASS");

    const res = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
    const entry = res.body.data.initiators.find((i) => i.user_id === TOP_MGMT_SAME_CO);
    expect(entry).toBeDefined();
    // They hold no role row, so the title is the one thing that must be named
    // rather than looked up.
    expect(entry.role_title).toBe("Top Management");
  });

  it("a super admin of a DIFFERENT buyer company is not listed", async () => {
    const po_id = await makePo();
    const res = await readOnlyClient.get(`/api/v1/po/${po_id}/initiators`);
    expect(res.body.data.initiators.map((i) => i.user_id)).not.toContain(TOP_MGMT_OTHER_CO);
  });
});
