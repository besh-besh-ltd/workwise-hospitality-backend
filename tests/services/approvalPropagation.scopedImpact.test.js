/**
 * Pre-flight approval-impact analysis must be SCOPE-AWARE.
 *
 * Regression context: editing a user's role at ONE (company, hotel) used to
 * surface pending approvals from EVERY company/hotel where the same role_id
 * appeared, because the controller collapsed the removed scope rows to bare
 * role ids before handing them to simulateApproverImpact(). A hotel-7 edit
 * degraded to "role 13 was removed somewhere" and warned about PO instances
 * belonging to a different legal entity entirely.
 *
 * The mutation path was always correctly scoped (revalidateApproverMembership
 * re-resolves per instance), so no data was corrupted — this is a
 * correctness/trust bug in the warning modal.
 *
 * Everything here drives the real HTTP endpoint
 * (PUT /api/v1/users/update-user-detail) through the full middleware chain.
 */

import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";

// Local ID block — 88xxx / 68xxx are unused by fixtures (see tests/fixtures/ids.js).
const ADMIN_ID = 88001;
const TARGET_ID = 88002;

/* The "other company" side of every isolation assertion below.
   This used to be the shared fixture's IDS.hospitality.B — but that entity
   hangs off buyer parent B, while ADMIN_ID belongs to parent A, so a single
   update-user-detail payload spanning both is a cross-tenant write that the
   controller now refuses outright (ROLE_SCOPE_COMPANY_FORBIDDEN). That was
   never a legal production operation: in production one buyer parent owns
   EIGHT hospitality companies and an admin routinely grants across all of
   them, which is exactly the shape modelled here — a second hospitality
   company under the SAME parent as the admin. The property under test
   (impact analysis must not leak across companies) is unchanged; only the
   tenancy of the second company is now realistic.
   IDs sit in the documented fixture ranges (10001..10099 / 10101..10199) at
   the top end, where the shared fixtures do not reach. */
const HOSPITALITY_C = 10091; // second hospitality entity under buyer parent A
const HOTEL_C1 = 10191; // its only hotel

const ROLE_R = ROLE_IDS.FINAL_AWARDING_P1; // 13 — the role being moved
const ROLE_R2 = ROLE_IDS.TENDER_APPROVER; //  4 — the role it is swapped to

const POLICY_A1 = 68001; // PO policy @ (hospitality A, hotel A1)
const POLICY_A2 = 68002; // PO policy @ (hospitality A, hotel A2)
const POLICY_B1 = 68003; // PO policy @ (hospitality C, hotel C1)

const STEP_A1 = 68101;
const STEP_A2 = 68102;
const STEP_B1 = 68103;

// Every policy gets a second step so that removing the sole step-1 approver
// skips a step but does NOT auto-complete the instance — that is the
// WARNING case (what the admin actually saw), not the BLOCKED case.
const STEP2_A1 = 68111;
const STEP2_A2 = 68112;
const STEP2_B1 = 68113;

// Instances created per-test, tracked for teardown.
let createdInstanceIds = [];
let nextInstanceId = 68201;

const SCOPE_A1 = { role_id: ROLE_R, company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1 };
const SCOPE_B1 = { role_id: ROLE_R, company_id: HOSPITALITY_C, hotel_id: HOTEL_C1 };

/** Insert a PENDING PO approval instance whose step 1 is sourced from ROLE_R. */
async function makePendingPoInstance({ policyId, stepId, step2Id, companyId, hotelId, metadata }) {
  const instanceId = nextInstanceId++;
  createdInstanceIds.push(instanceId);

  await db.none(
    `INSERT INTO tbl_approval_instances
       (id, entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, metadata)
     VALUES ($1, 'PO', $2, $3, 'PENDING', 1, $4, $5, $6, $7, $8::jsonb)`,
    [instanceId, 900000 + instanceId, policyId, companyId, hotelId,
      IDS.departments.proc, ADMIN_ID, JSON.stringify(metadata)]
  );

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, policy_step_id, step_order, decision_rule, status)
     VALUES ($1, $2, 1, 'ANY', 'PENDING') RETURNING id`,
    [instanceId, stepId]
  );

  await db.none(
    `INSERT INTO tbl_approval_step_approvers
       (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING')`,
    [step.id, TARGET_ID]
  );

  // Downstream step keeps the instance alive after step 1 is skipped.
  await db.none(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, policy_step_id, step_order, decision_rule, status)
     VALUES ($1, $2, 2, 'ANY', 'PENDING')`,
    [instanceId, step2Id]
  );

  return { instanceId, stepId: step.id };
}

/** Reset the target user's role scopes to the given tuples. */
async function setTargetScopes(scopes) {
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [TARGET_ID]);
  for (const s of scopes) {
    await db.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
       VALUES ($1, $2, $3, $4, NULL, NULL)`,
      [TARGET_ID, s.role_id, s.company_id, s.hotel_id ?? null]
    );
  }
}

/** The payload the frontend sends: the FULL desired role list. */
function rolesPayload(scopes) {
  return scopes.map((s) => ({
    role_id: s.role_id,
    company_id: s.company_id,
    hotel_id: s.hotel_id ?? null,
    department_id: null,
    process_id: null,
  }));
}

beforeAll(async () => {
  // Second hospitality entity under buyer parent A, owned by this suite (the
  // shared fixtures only reach 10002 / 10105). Both of ADMIN_ID's grant
  // targets therefore sit inside its own tenant, as they do in production.
  await db.none(
    `INSERT INTO tbl_hospitality_companies (id, buyer_company_id, name)
     VALUES ($1, $2, 'Hospitality C (scopedImpact)')
     ON CONFLICT (id) DO NOTHING`,
    [HOSPITALITY_C, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_hospitality_company_hotels (id, hospitality_company_id, name)
     VALUES ($1, $2, 'Hotel C-1 (scopedImpact)')
     ON CONFLICT (id) DO NOTHING`,
    [HOTEL_C1, HOSPITALITY_C]
  );

  // Two users under the same buyer parent company (the admin's UPDATE is
  // gated on `company_id = <admin's company_id>`).
  await db.none(
    `INSERT INTO tbl_users (id, name, email, mobile, password, user_type, status, company_id)
     VALUES ($1, 'Scoped Impact Admin', 'scoped.impact.admin@test.local', '9000088001', 'x', 7, 1, $3),
            ($2, 'Scoped Impact Target', 'scoped.impact.target@test.local', '9000088002', 'x', 2, 1, $3)
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_ID, TARGET_ID, IDS.companies.A]
  );

  // Hospitality mappings — resolveApprovers() joins these when re-resolving.
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
     VALUES ($1, $3, NULL, 0),
            ($2, $3, $5, 1),
            ($2, $3, $6, 1),
            ($2, $4, $7, 1)
     ON CONFLICT DO NOTHING`,
    [ADMIN_ID, TARGET_ID, IDS.hospitality.A, HOSPITALITY_C,
      IDS.hotels.A1, IDS.hotels.A2, HOTEL_C1]
  );

  // The target user keeps one department throughout — so `department_ids`
  // round-trips unchanged and never looks like a wipe.
  await db.none(
    `INSERT INTO tbl_user_department (user_id, department_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [TARGET_ID, IDS.departments.proc]
  );

  // Three single-step PO policies, one per (company, hotel), all sourcing ROLE_R.
  const policies = [
    [POLICY_A1, IDS.hospitality.A, IDS.hotels.A1, STEP_A1, STEP2_A1],
    [POLICY_A2, IDS.hospitality.A, IDS.hotels.A2, STEP_A2, STEP2_A2],
    [POLICY_B1, HOSPITALITY_C, HOTEL_C1, STEP_B1, STEP2_B1],
  ];
  for (const [policyId, companyId, hotelId, stepId, step2Id] of policies) {
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by)
       VALUES ($1, 'PO', $2, $3, $4, true, $5)
       ON CONFLICT (id) DO NOTHING`,
      [policyId, companyId, hotelId, IDS.departments.proc, ADMIN_ID]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (id, approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, $2, 1, 'ANY', 'ROLE', $3),
              ($4, $2, 2, 'ANY', 'ROLE', $5)
       ON CONFLICT (id) DO NOTHING`,
      [stepId, policyId, ROLE_R, step2Id, ROLE_R2]
    );
  }
});

afterEach(async () => {
  if (createdInstanceIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`,
      [createdInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [createdInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`,
      [createdInstanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [createdInstanceIds]);
    createdInstanceIds = [];
  }
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [TARGET_ID]);
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_user_department WHERE user_id = $1`, [TARGET_ID]);
  await db.none(
    `DELETE FROM tbl_approval_policy_steps WHERE id = ANY($1::int[])`,
    [[STEP_A1, STEP_A2, STEP_B1, STEP2_A1, STEP2_A2, STEP2_B1]]
  );
  await db.none(
    `DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`,
    [[POLICY_A1, POLICY_A2, POLICY_B1]]
  );
  await db.none(
    `DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`,
    [[ADMIN_ID, TARGET_ID]]
  );
  await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [[ADMIN_ID, TARGET_ID]]);
  // Suite-owned hospitality entity — drop the hotel first (FK).
  await db.none(`DELETE FROM tbl_hospitality_company_hotels WHERE id = $1`, [HOTEL_C1]);
  await db.none(`DELETE FROM tbl_hospitality_companies WHERE id = $1`, [HOSPITALITY_C]);
});

async function approverStatusFor(instanceId) {
  const row = await db.oneOrNone(
    `SELECT asa.status
       FROM tbl_approval_step_approvers asa
       JOIN tbl_approval_instance_steps ais ON ais.id = asa.approval_instance_step_id
      WHERE ais.approval_instance_id = $1 AND asa.approver_user_id = $2`,
    [instanceId, TARGET_ID]
  );
  return row?.status;
}

describe("pre-flight approval impact is scoped to the changed role scope", () => {
  it("does NOT warn about a pending instance in a different company/hotel", async () => {
    await setTargetScopes([SCOPE_A1, SCOPE_B1]);

    // The only PENDING instance lives at (hospitality B, hotel B1) — a scope
    // the admin is NOT touching.
    const { instanceId } = await makePendingPoInstance({
      policyId: POLICY_B1,
      stepId: STEP_B1,
      step2Id: STEP2_B1,
      companyId: HOSPITALITY_C,
      hotelId: HOTEL_C1,
      metadata: { po_number: "PO-B1-001", rfq_no: 9999001 },
    });

    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      department_ids: [IDS.departments.proc],
      // Swap ONLY the (A, A1) row to a different role. (B, B1) is untouched.
      roles: rolesPayload([{ ...SCOPE_A1, role_id: ROLE_R2 }, SCOPE_B1]),
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    expect(await approverStatusFor(instanceId)).toBe("PENDING");
  });

  it("DOES warn when the removed scope matches the instance's company + hotel", async () => {
    await setTargetScopes([SCOPE_A1, SCOPE_B1]);

    const { instanceId: a1Instance } = await makePendingPoInstance({
      policyId: POLICY_A1,
      stepId: STEP_A1,
      step2Id: STEP2_A1,
      companyId: IDS.hospitality.A,
      hotelId: IDS.hotels.A1,
      metadata: { po_number: "PO-A1-001", rfq_no: 9999002 },
    });
    // Decoy in another company — must NOT appear in the warning.
    await makePendingPoInstance({
      policyId: POLICY_B1,
      stepId: STEP_B1,
      step2Id: STEP2_B1,
      companyId: HOSPITALITY_C,
      hotelId: HOTEL_C1,
      metadata: { po_number: "PO-B1-002", rfq_no: 9999003 },
    });

    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      department_ids: [IDS.departments.proc],
      roles: rolesPayload([{ ...SCOPE_A1, role_id: ROLE_R2 }, SCOPE_B1]),
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe("APPROVAL_IMPACT_WARNING");
    const ids = res.body.data.affectedInstances.map((i) => i.instance_id);
    expect(ids).toEqual([a1Instance]);
  });

  it("labels a PO instance with its PO number, not the RFQ number", async () => {
    await setTargetScopes([SCOPE_A1]);
    await makePendingPoInstance({
      policyId: POLICY_A1,
      stepId: STEP_A1,
      step2Id: STEP2_A1,
      companyId: IDS.hospitality.A,
      hotelId: IDS.hotels.A1,
      metadata: { po_number: "138626", rfq_no: 536074 },
    });

    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      department_ids: [IDS.departments.proc],
      roles: rolesPayload([{ ...SCOPE_A1, role_id: ROLE_R2 }]),
    });

    expect(res.body.code).toBe("APPROVAL_IMPACT_WARNING");
    expect(res.body.data.affectedInstances[0].entity_identifier).toBe("138626");
  });

  it("treats a company-wide (hotel_id NULL) grant as covering every hotel in that company", async () => {
    const companyWide = { role_id: ROLE_R, company_id: IDS.hospitality.A, hotel_id: null };
    await setTargetScopes([companyWide, SCOPE_B1]);

    const { instanceId: a1Instance } = await makePendingPoInstance({
      policyId: POLICY_A1,
      stepId: STEP_A1,
      step2Id: STEP2_A1,
      companyId: IDS.hospitality.A,
      hotelId: IDS.hotels.A1,
      metadata: { po_number: "PO-A1-003", rfq_no: 9999004 },
    });
    const { instanceId: a2Instance } = await makePendingPoInstance({
      policyId: POLICY_A2,
      stepId: STEP_A2,
      step2Id: STEP2_A2,
      companyId: IDS.hospitality.A,
      hotelId: IDS.hotels.A2,
      metadata: { po_number: "PO-A2-001", rfq_no: 9999005 },
    });

    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      department_ids: [IDS.departments.proc],
      // Drop the company-wide grant; keep only the B-side row.
      roles: rolesPayload([SCOPE_B1]),
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe("APPROVAL_IMPACT_WARNING");
    const ids = res.body.data.affectedInstances.map((i) => i.instance_id).sort();
    expect(ids).toEqual([a1Instance, a2Instance].sort());
  });
});

describe("empty-payload wipe guard", () => {
  it("refuses an unconfirmed roles:[] payload and leaves every scope intact", async () => {
    await setTargetScopes([SCOPE_A1, SCOPE_B1]);

    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      name: "Scoped Impact Target",
      department_ids: [],
      roles: [],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SCOPE_CLEAR_NOT_CONFIRMED");

    const remaining = await db.any(
      `SELECT role_id FROM tbl_user_role_scopes WHERE user_id = $1`,
      [TARGET_ID]
    );
    expect(remaining).toHaveLength(2);

    const depts = await db.any(
      `SELECT department_id FROM tbl_user_department WHERE user_id = $1`,
      [TARGET_ID]
    );
    expect(depts).toHaveLength(1);
  });

  it("lets an admin trim a non-empty list down without any confirmation", async () => {
    await setTargetScopes([SCOPE_A1, SCOPE_B1]);

    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      department_ids: [IDS.departments.proc],
      roles: rolesPayload([SCOPE_B1]),
      confirmed_approval_impact: true,
    });

    expect(res.status).toBe(200);
    const remaining = await db.any(
      `SELECT company_id FROM tbl_user_role_scopes WHERE user_id = $1`,
      [TARGET_ID]
    );
    expect(remaining.map((r) => r.company_id)).toEqual([HOSPITALITY_C]);
  });

  it("rejects a role scope that does not name its hospitality company", async () => {
    await setTargetScopes([SCOPE_A1]);

    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      department_ids: [IDS.departments.proc],
      roles: [{ role_id: ROLE_R, company_id: null, hotel_id: IDS.hotels.A1 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ROLE_SCOPE_COMPANY_REQUIRED");

    const remaining = await db.any(
      `SELECT role_id FROM tbl_user_role_scopes WHERE user_id = $1`,
      [TARGET_ID]
    );
    expect(remaining).toHaveLength(1);
  });

  it("still lets an admin remove a user's last role when the clear is confirmed", async () => {
    await setTargetScopes([SCOPE_A1]);

    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      department_ids: [IDS.departments.proc],
      roles: [],
      confirm_clear_all_scopes: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();

    const remaining = await db.any(
      `SELECT role_id FROM tbl_user_role_scopes WHERE user_id = $1`,
      [TARGET_ID]
    );
    expect(remaining).toHaveLength(0);
  });
});
