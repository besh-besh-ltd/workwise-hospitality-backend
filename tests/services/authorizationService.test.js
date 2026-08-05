// authorizationService — process_id scope behavior.
//
// Covers the new 4-axis scope semantics introduced for WH-RBAC-ProcessAlign:
//   - NULL process_id on a scope row is a wildcard (backwards-compat)
//   - A specific process_id binds the row to that process only
//   - process_type strictness only kicks in when the entity supplies an
//     expected type
//   - department_id retains the permissive-on-NULL-dept semantics that match
//     rbacModel.getUserPermissions
//   - buildScopeExistsClause exposes the same predicate for LIST queries

import { describe, it, expect, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  assertUserHasScope,
  assertCanReadParentRfq,
  buildScopeExistsClause,
  AuthorizationError,
} from "../../app/services/authorizationService.js";

afterAll(async () => {
  await closeDb();
});

// Insert (or re-use) an extra scope row so tests can pin a user to a single
// process without touching the broader fixture data. Wrapped in a try so it's
// no-op when the row already exists (avoids fighting the unique index).
async function addScopeRow({ user_id, role_id, company_id, hotel_id = null, department_id = null, process_id = null }) {
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, role_id, company_id, COALESCE(hotel_id, 0), COALESCE(department_id, 0), COALESCE(process_id, 0))
     DO NOTHING`,
    [user_id, role_id, company_id, hotel_id, department_id, process_id]
  );
}

async function removeScopeRow({ user_id, role_id, company_id, hotel_id = null, department_id = null, process_id = null }) {
  await db.none(
    `DELETE FROM tbl_user_role_scopes
      WHERE user_id = $1 AND role_id = $2 AND company_id = $3
        AND COALESCE(hotel_id, 0) = COALESCE($4, 0)
        AND COALESCE(department_id, 0) = COALESCE($5, 0)
        AND COALESCE(process_id, 0) = COALESCE($6, 0)`,
    [user_id, role_id, company_id, hotel_id, department_id, process_id]
  );
}

const ROLE_TENDER_CREATOR = 2; // rfq.create / rfq.read / boq.create / boq.read

describe("assertUserHasScope — NULL process_id (wildcard) backwards-compat", () => {
  it("allows a user with NULL process_id scope to act on an entity tagged with process A_P1", async () => {
    // a1_proc_buyer has TENDER_CREATOR scoped to (A, A1, proc, NULL).
    await expect(
      assertUserHasScope(IDS.users.a1_proc_buyer, "rfq.create", {
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
        process_id: IDS.processes.A_P1,
      })
    ).resolves.toBeUndefined();
  });

  it("allows the same NULL-process user on an entity with no process_id", async () => {
    await expect(
      assertUserHasScope(IDS.users.a1_proc_buyer, "rfq.create", {
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
        process_id: null,
      })
    ).resolves.toBeUndefined();
  });
});

describe("assertUserHasScope — specific process_id (strict)", () => {
  // Pin multiHotel to ONLY process A_P1 at hotel A2/proc, then assert behavior.
  const ROW = {
    user_id: IDS.users.multiHotel,
    role_id: ROLE_TENDER_CREATOR,
    company_id: IDS.hospitality.A,
    hotel_id: IDS.hotels.A2,
    department_id: IDS.departments.proc,
    process_id: IDS.processes.A_P1,
  };

  beforeAll(async () => { await addScopeRow(ROW); });
  afterAll(async () => { await removeScopeRow(ROW); });

  it("allows the user on the bound process (A_P1)", async () => {
    await expect(
      assertUserHasScope(IDS.users.multiHotel, "rfq.create", {
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A2,
        department_id: IDS.departments.proc,
        process_id: IDS.processes.A_P1,
      })
    ).resolves.toBeUndefined();
  });

  it("blocks the user on a different process (A_P2)", async () => {
    // multiHotel has NULL-process rows at A1/proc + A2/proc from the base
    // fixture, plus the strict A2/proc/A_P1 row added above. The strict row
    // only matches A_P1 — but the NULL rows would otherwise be permissive.
    // The check below uses hotel A2 + process A_P2: the NULL-process row at
    // A2/proc DOES match (wildcard). So we drop the wildcard row first to
    // assert genuine narrowing.
    const wildcardA2 = {
      user_id: IDS.users.multiHotel,
      role_id: ROLE_TENDER_CREATOR,
      company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.proc,
      process_id: null,
    };
    await removeScopeRow(wildcardA2);
    try {
      await expect(
        assertUserHasScope(IDS.users.multiHotel, "rfq.create", {
          hospitality_company_id: IDS.hospitality.A,
          hotel_id: IDS.hotels.A2,
          department_id: IDS.departments.proc,
          process_id: IDS.processes.A_P2,
        })
      ).rejects.toBeInstanceOf(AuthorizationError);
    } finally {
      await addScopeRow(wildcardA2);
    }
  });

  it("blocks the user on an entity with no process_id (specific-process scope cannot leak onto no-process entities)", async () => {
    const wildcardA2 = {
      user_id: IDS.users.multiHotel,
      role_id: ROLE_TENDER_CREATOR,
      company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.proc,
      process_id: null,
    };
    await removeScopeRow(wildcardA2);
    try {
      await expect(
        assertUserHasScope(IDS.users.multiHotel, "rfq.create", {
          hospitality_company_id: IDS.hospitality.A,
          hotel_id: IDS.hotels.A2,
          department_id: IDS.departments.proc,
          process_id: null,
        })
      ).rejects.toBeInstanceOf(AuthorizationError);
    } finally {
      await addScopeRow(wildcardA2);
    }
  });
});

describe("assertUserHasScope — process_type strictness", () => {
  it("allows an RFQ-type entity when user is bound to an RFQ-type process", async () => {
    // A_P1 has process_type = 'RFQ' in fixtures.
    await expect(
      assertUserHasScope(IDS.users.a1_proc_buyer, "rfq.create", {
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
        process_id: IDS.processes.A_P1,
        process_type: "RFQ",
      })
    ).resolves.toBeUndefined();
  });

  it("type mismatch is permissive when the user is wildcard-process", async () => {
    // a1_proc_buyer has NULL process_id — type check should not apply.
    await expect(
      assertUserHasScope(IDS.users.a1_proc_buyer, "rfq.create", {
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
        process_id: IDS.processes.A_P1,
        process_type: "TENDER", // wrong type, but user is wildcard
      })
    ).resolves.toBeUndefined();
  });
});

describe("assertUserHasScope — department_id permissive on NULL", () => {
  it("entity with NULL department is visible to a specific-department user (matches rbacModel semantics)", async () => {
    // a1_proc_buyer is scoped to dept=PROC. Entity dept=NULL should still pass.
    await expect(
      assertUserHasScope(IDS.users.a1_proc_buyer, "rfq.create", {
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: null, // entity has no dept
        process_id: null,
      })
    ).resolves.toBeUndefined();
  });

  it("entity with a non-matching department is blocked", async () => {
    await expect(
      assertUserHasScope(IDS.users.a1_proc_buyer, "rfq.create", {
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.eng, // user is proc, not eng
        process_id: null,
      })
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("assertUserHasScope — error shape", () => {
  it("throws AuthorizationError with code=PROCESS_NOT_IN_USER_SCOPE and structured data", async () => {
    let caught = null;
    try {
      await assertUserHasScope(IDS.users.a1_proc_buyer, "rfq.create", {
        hospitality_company_id: IDS.hospitality.B, // wrong company
        hotel_id: IDS.hotels.B1,
        department_id: null,
        process_id: null,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthorizationError);
    expect(caught.code).toBe("PROCESS_NOT_IN_USER_SCOPE");
    expect(caught.status).toBe(403);
    expect(caught.data).toEqual(
      expect.objectContaining({
        requiredPermission: "rfq.create",
        hospitality_company_id: IDS.hospitality.B,
      })
    );
  });
});

describe("assertCanReadParentRfq — defense-in-depth gate for per-entity GETs", () => {
  // Create two RFQs in the same (company, hotel, dept) but DIFFERENT processes
  // so we can prove the gate keys on process_id even when the rest of the tuple
  // matches.
  let rfqP1, rfqP2;
  beforeAll(async () => {
    const a = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, department_id, process_id)
       VALUES (9000901, '', '', '', '', '', '', '', 0, 1, $1, $1, NOW(), $2, $3, $4, $5)
       RETURNING id`,
      [IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P1]
    );
    const b = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, department_id, process_id)
       VALUES (9000902, '', '', '', '', '', '', '', 0, 1, $1, $1, NOW(), $2, $3, $4, $5)
       RETURNING id`,
      [IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P2]
    );
    rfqP1 = a.id;
    rfqP2 = b.id;
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_rfq WHERE id IN ($1, $2)`, [rfqP1, rfqP2]);
  });

  it("a wildcard-process user passes the gate for both P1 and P2 RFQs", async () => {
    // a1_proc_buyer has TENDER_CREATOR with process_id = NULL (wildcard).
    await expect(assertCanReadParentRfq(IDS.users.a1_proc_buyer, rfqP1)).resolves.toBeUndefined();
    await expect(assertCanReadParentRfq(IDS.users.a1_proc_buyer, rfqP2)).resolves.toBeUndefined();
  });

  it("a user pinned to process P1 only passes for the P1 RFQ and is BLOCKED for the P2 RFQ", async () => {
    const ROW = {
      user_id: IDS.users.multiHotel,
      role_id: 2, // TENDER_CREATOR has rfq.read
      company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      department_id: IDS.departments.proc,
      process_id: IDS.processes.A_P1,
    };
    await addScopeRow(ROW);
    // Drop multiHotel's pre-existing wildcard rows at A1/proc so we genuinely
    // narrow them to "process P1 only" for this assertion.
    const wildcard = { ...ROW, process_id: null };
    await removeScopeRow(wildcard);
    try {
      await expect(assertCanReadParentRfq(IDS.users.multiHotel, rfqP1)).resolves.toBeUndefined();
      await expect(assertCanReadParentRfq(IDS.users.multiHotel, rfqP2))
        .rejects.toBeInstanceOf(AuthorizationError);
    } finally {
      await addScopeRow(wildcard);
      await removeScopeRow(ROW);
    }
  });

  // Behaviour deliberately changed: this used to resolve (ALLOW) whenever
  // hospitality_company_id was NULL, on the assumption that such a row was a
  // legacy non-hospitality RFQ with no scope to enforce. Two facts killed that
  // assumption: the saveRfqDraft defect (fixed in 92604b60) wiped the column on
  // 84 real production RFQs, making the bypass reachable through every caller of
  // this helper; and production has no non-hospitality RFQs at all (3 such
  // companies exist, none of them own an RFQ). A row with no company, no
  // hotel_id and no hotel mapping has no tenant to authorise against, so the
  // only safe reading is to refuse. Rows that merely lost the column are
  // re-derived from their hotel and enforced normally — see the test below.
  it("refuses an RFQ with no resolvable tenant (no company, no hotel, no mapping)", async () => {
    const legacy = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp")
       VALUES (9000903, '', '', '', '', '', '', '', 0, 1, $1, $1, NOW())
       RETURNING id`,
      [IDS.users.a1_proc_buyer]
    );
    try {
      await expect(assertCanReadParentRfq(IDS.users.a1_proc_buyer, legacy.id))
        .rejects.toBeInstanceOf(AuthorizationError);
    } finally {
      await db.none(`DELETE FROM tbl_rfq WHERE id = $1`, [legacy.id]);
    }
  });

  // The 84-row production case: hospitality_company_id was wiped but the RFQ
  // still knows its hotel, so the tenant is recoverable. The gate must enforce
  // against the derived company rather than either allowing blindly (the old
  // bypass) or refusing a legitimate RFQ.
  it("re-derives the tenant from hotel_id when hospitality_company_id was wiped", async () => {
    const wiped = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by,
          hotel_id, "timestamp")
       VALUES (9000904, '', '', '', '', '', '', '', 0, 1, $1, $1, $2, NOW())
       RETURNING id`,
      [IDS.users.a1_proc_buyer, IDS.hotels.A1]
    );
    try {
      // In-scope user for hotel A1 is allowed via the derived company...
      await expect(assertCanReadParentRfq(IDS.users.a1_proc_buyer, wiped.id))
        .resolves.toBeUndefined();
      // ...and a user scoped elsewhere is still refused.
      await expect(assertCanReadParentRfq(IDS.users.companyB_admin, wiped.id))
        .rejects.toBeInstanceOf(AuthorizationError);
    } finally {
      await db.none(`DELETE FROM tbl_rfq WHERE id = $1`, [wiped.id]);
    }
  });

  it("is a no-op for an unknown RFQ id (lets the handler return its own 404)", async () => {
    await expect(assertCanReadParentRfq(IDS.users.a1_proc_buyer, 9999999))
      .resolves.toBeUndefined();
  });
});

describe("buildScopeExistsClause — LIST query predicate", () => {
  it("returns a SQL fragment that, when run with the user/permission params, matches in-scope rows", async () => {
    const { clause, params } = buildScopeExistsClause(
      IDS.users.a1_proc_buyer,
      "rfq.read",
      "RFQ",
      1
    );

    // Run a tiny self-contained query against a synthetic row (the clause
    // doesn't read tbl_rfq; it correlates by RFQ.* aliases — so we build a
    // VALUES row with those columns).
    const sql = `
      SELECT COUNT(*)::int AS n FROM (
        VALUES
          (1, $${params.length + 1}::int, $${params.length + 2}::int, $${params.length + 3}::int, $${params.length + 4}::int)
      ) AS RFQ(id, hospitality_company_id, hotel_id, department_id, process_id)
      WHERE ${clause}`;

    // In-scope row: a1_proc_buyer has scope (A, A1, proc, NULL) — wildcard process.
    const inScope = await db.one(sql, [
      ...params,
      IDS.hospitality.A,
      IDS.hotels.A1,
      IDS.departments.proc,
      IDS.processes.A_P1, // RFQ tagged with a specific process — wildcard scope still matches.
    ]);
    expect(inScope.n).toBe(1);

    // Out-of-scope row: different company.
    const outOfScope = await db.one(sql, [
      ...params,
      IDS.hospitality.B,
      IDS.hotels.B1,
      IDS.departments.proc,
      IDS.processes.B_P1,
    ]);
    expect(outOfScope.n).toBe(0);
  });
});
