/**
 * ARC v2 finally has an APPROVER role for its technical and commercial stages.
 *
 * ── WHAT WAS MISSING ──────────────────────────────────────────────────────
 * ARC v2 modelled an EVALUATOR per stage and no approver. RFQ modelled both:
 * role 7 'Technical Approver' (te.read + te.approve) and role 12 'Commercial
 * Approver' (negotiation.read/approve + quote-compare.read/approve). ARC had no
 * analogue, and the ARC-stage resources reflected that — `arc-tech` and
 * `arc-comm` each carried `evaluate` and `read` and NO `approve` row at all.
 *
 * `createApprovalInstance` drops a ROLE-source policy step whose role lacks BOTH
 * `read` and `approve` on the entity type's resource. With no `approve` row in
 * existence, NO role could pass that gate for either stage. So:
 *
 *   ARC_NEGOTIATION → mapped to 'arc-comm' → every ROLE step silently dropped.
 *                     Drop every step and the instance was born
 *                     APPROVED / current_step = 0 — a negotiation round going
 *                     live with nobody having approved it. (That fail-open is
 *                     gone: createApprovalInstance now THROWS
 *                     APPROVAL_POLICY_RESOLVES_TO_NOBODY and writes no row.)
 *   ARC_TECH        → not mapped at all → fell back to `entity_type.toLowerCase()`
 *                     = 'arc_tech' (UNDERSCORE), which is not a `resource_type`
 *                     enum label, so `p.resource = $2` RAISED
 *                     `invalid input value for enum resource_type` and took the
 *                     whole submitTechEval transaction with it.
 *
 * Neither had fired only because every policy in production uses USER-source
 * steps. The admin Approval Wizard offers both stages and defaults every level
 * to `approver_source_type: 'ROLE'`, so this was one saved policy away.
 *
 * ── WHAT THIS SUITE PINS ──────────────────────────────────────────────────
 *  1. The ROLE path now WORKS end to end for ARC_TECH and ARC_NEGOTIATION —
 *     a code path that had never executed anywhere, ever.
 *  2. THE GOVERNING CONSTRAINT, FOR ROLE-SOURCE STEPS: 'ARC Tech Evaluator'
 *     cannot approve a technical evaluation and 'ARC Commercial Evaluator'
 *     cannot approve a negotiation round. A design in which an evaluator
 *     qualifies as approver of their own work is wrong by definition, so this is
 *     asserted directly rather than inferred from the permission table.
 *
 *     ── TWO LIMITS ON THAT CLAIM, BOTH PINNED BELOW RATHER THAN PAPERED OVER ──
 *
 *     (i) IT COVERS ROLE-SOURCE STEPS ONLY. `createApprovalInstance` applies the
 *     read+approve gate to `approver_source_type === 'ROLE'` and nothing else
 *     (generalModel.js), and the policy-save guard mirrors that. `resolveApprovers`'
 *     DEPARTMENT branch selects every active user in the named department with NO
 *     permission join whatsoever — so a step of
 *     `DEPARTMENT: <the department the evaluator sits in>` reaches the same
 *     outcome the ROLE mistake was blocked from reaching, and does it WORSE: it
 *     produces a real, live approver rather than a dropped step. Out of scope
 *     here — closing it is a separate decision with its own blast radius — but it
 *     means "an evaluator can never approve their own work" is not true of the
 *     system as a whole. It is true of ROLE steps.
 *
 *     (ii) 'ARC Admin' IS NOT FULLY SEPARATED. It is withheld the two new approve
 *     keys, but it has held `arc-committee.approve` since 20260608100800 — and
 *     `arc-comm.evaluate`, which gates `finalizeCommEval`, the handler that
 *     SPAWNS the ARC_COMMITTEE instance with `initiated_by = <that same user>`.
 *     One ARC Admin can therefore award, finalize commercial, and approve the
 *     resulting award. Pre-existing and deliberately untouched; asserted
 *     explicitly below so it reads as a known gap, not as coverage.
 *  3. The enum-throw guard: an unknown resource returns false instead of raising.
 *  4. The auto-approve fail-open is GONE for case (b). Two outcomes that
 *     production could not tell apart across 51 instances — case (a) "the
 *     initiator was the only approver" and case (b) "nobody qualified" — are now
 *     different KINDS of event, not two labels on the same APPROVED/0 row:
 *       (a) still auto-approves, still stamped INITIATOR_ONLY / legitimate:true,
 *           with a real step, a real approver and a real APPROVE action;
 *       (b) throws APPROVAL_POLICY_RESOLVES_TO_NOBODY before the INSERT, so no
 *           instance exists at all and the submission is blocked. The per-step
 *           reason that used to be written to metadata now rides on
 *           `err.diagnostics.skipped_steps`, so the triage information survives.
 *     The MIXED shape (some steps dropped, at least one resolved) is unchanged:
 *     an instance IS created, and `approval_diagnostics.skipped_steps` records
 *     what was lost.
 *
 * Instances are built through the production `createApprovalInstance` because
 * the entire mechanism under test is its creation-time gate; hand-inserted steps
 * would prove nothing about it.
 */

import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import {
  createApprovalInstance,
  roleHasReadAndApprovePermission,
  ENTITY_APPROVE_RESOURCE_MAP,
} from "../../app/models/generalModel.js";

// Fresh private ID block — 89xxx (users/roles) / 69xxx (policies + steps).
// Taken elsewhere: 88xxx/68xxx (approvalPropagation.scopedImpact),
// 87xxx/67xxx (approvalPropagation.stepOrderDivergence),
// 86xxx/66xxx (approvalPropagation.rolePermissionRevocation),
// 83xxx/63xxx (approvalPropagation.mapAndCreateGaps), 95xxx (ARC eval fixtures).
const U_TECH_APPROVER = 89001; // holds 'ARC Technical Approver'
const U_NEG_APPROVER  = 89002; // holds 'ARC Negotiation Approver'
const U_TECH_EVAL     = 89003; // holds 'ARC Tech Evaluator'        — must NOT approve
const U_COMM_EVAL     = 89004; // holds 'ARC Commercial Evaluator'  — must NOT approve
const U_ARC_ADMIN     = 89005; // holds 'ARC Admin'                 — must NOT approve
const U_INITIATOR     = 89006; // submits everything; never an approver except in the case-(a) test
const U_NOPERM        = 89007; // holds a role with zero permissions
const U_TENDER_APP    = 89008; // holds legacy 'Tender Approver' (boq.read + boq.approve)
const U_AMEND_APP     = 89009; // holds legacy 'ARC Approver'    (arc.read  + arc.approve)
const ALL_USERS = [
  U_TECH_APPROVER, U_NEG_APPROVER, U_TECH_EVAL, U_COMM_EVAL, U_ARC_ADMIN,
  U_INITIATOR, U_NOPERM, U_TENDER_APP, U_AMEND_APP,
];

const NOPERM_ROLE = 89100; // custom role, deliberately granted nothing

// Policies. uq_approval_policy_scope_process is UNIQUE on
// (entity_type, company, COALESCE(hotel,0), COALESCE(dept,0), COALESCE(process,0))
// WHERE is_active, so each row below owns a distinct (hotel, dept) tuple. The
// scope is otherwise irrelevant — every instance names its policy explicitly.
const P_TECH_ROLE  = 69001; // ARC_TECH        / A2 / eng  — ARC Technical Approver
const P_TECH_EVAL  = 69002; // ARC_TECH        / A3 / eng  — ARC Tech Evaluator (must be dropped)
const P_NEG_ROLE   = 69003; // ARC_NEGOTIATION / A2 / eng  — ARC Negotiation Approver
const P_NEG_EVAL   = 69004; // ARC_NEGOTIATION / A3 / eng  — ARC Commercial Evaluator (must be dropped)
const P_TECH_ADMIN = 69005; // ARC_TECH        / A2 / fb   — ARC Admin (must be dropped)
const P_CASE_A     = 69006; // ARC_TECH        / A3 / fb   — USER step naming the initiator
const P_CASE_B     = 69007; // ARC_TECH        / A2 / hk   — ROLE step with a permission-less role
const P_AMENDMENT  = 69008; // ARC_AMENDMENT   / A3 / hk   — was UNMAPPED; now maps to 'arc'
const P_CASE_MIXED = 69009; // ARC_TECH        / A3 / proc — ROLE(unqualified) + USER(initiator)
const P_COMMITTEE_ADMIN = 69010; // ARC_COMMITTEE / A2 / proc — ARC Admin approving its own award
const P_TENDER     = 69012; // TENDER          / A2 / proc — was pointed at 'tender'; now 'boq'
const ALL_POLICIES = [
  P_TECH_ROLE, P_TECH_EVAL, P_NEG_ROLE, P_NEG_EVAL, P_TECH_ADMIN,
  P_CASE_A, P_CASE_B, P_AMENDMENT, P_CASE_MIXED, P_COMMITTEE_ADMIN, P_TENDER,
];

let nextEntityId = 8900001;

/** Resolve a system role by title — the row may come from the seed or a migration. */
async function systemRoleId(title) {
  const row = await db.oneOrNone(
    `SELECT id FROM tbl_roles WHERE title = $1 AND created_by IS NULL ORDER BY id ASC LIMIT 1`,
    [title]
  );
  if (!row) throw new Error(`system role '${title}' is missing from the test database`);
  return row.id;
}

async function permissionKeysOf(roleId) {
  const rows = await db.any(
    `SELECT p.resource::text AS resource, p.action::text AS action
       FROM tbl_role_permissions rp
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1`,
    [roleId]
  );
  return [...new Set(rows.map((r) => `${r.resource}.${r.action}`))].sort();
}

async function makeInstance(policyId, entityType, hotelId, { initiatedBy = U_INITIATOR } = {}) {
  return createApprovalInstance({
    entity_type: entityType,
    entity_id: nextEntityId++,
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: hotelId,
    department_id: null,
    process_id: null,
    approval_policy_id: policyId,
    initiated_by: initiatedBy,
    metadata: { arc_number: `ARC-STAGE-${nextEntityId}` },
  });
}

async function approversOf(instanceId) {
  return db.any(
    `SELECT ais.step_order, asa.approver_user_id, asa.status
       FROM tbl_approval_step_approvers asa
       JOIN tbl_approval_instance_steps ais ON ais.id = asa.approval_instance_step_id
      WHERE ais.approval_instance_id = $1
      ORDER BY ais.step_order ASC, asa.approver_user_id ASC`,
    [instanceId]
  );
}

async function instanceRow(instanceId) {
  return db.one(
    `SELECT status, current_step, metadata FROM tbl_approval_instances WHERE id = $1`,
    [instanceId]
  );
}

/** Every instance ever written for a policy — the "was anything created?" probe. */
async function instancesForPolicy(policyId) {
  return db.any(
    `SELECT id, status, current_step FROM tbl_approval_instances
      WHERE approval_policy_id = $1 ORDER BY id ASC`,
    [policyId]
  );
}

/**
 * Run a creation that MUST be refused and hand back the error.
 *
 * `createApprovalInstance` no longer answers "every step was dropped" with an
 * instance born APPROVED; it throws APPROVAL_POLICY_RESOLVES_TO_NOBODY before
 * the INSERT. The per-step diagnostics that used to land in
 * `metadata.auto_approval.skipped_steps` ride on `err.diagnostics` instead, so
 * assertions about WHICH step was dropped and WHY are made there.
 */
async function expectRefusedCreation(promise) {
  const err = await promise.then(
    (res) => {
      throw new Error(
        `expected createApprovalInstance to be refused, but it returned instance ${res?.instance?.id}`
      );
    },
    (e) => e
  );
  expect(err.code).toBe("APPROVAL_POLICY_RESOLVES_TO_NOBODY");
  expect(err.httpStatus).toBe(400);
  expect(err.message).toMatch(/resolved to zero usable approval steps/i);
  return err;
}

let ROLE_TECH_APPROVER;
let ROLE_NEG_APPROVER;
let ROLE_TECH_EVALUATOR;
let ROLE_COMM_EVALUATOR;
let ROLE_ARC_ADMIN;
let ROLE_ARC_APPROVER_LEGACY; // 'ARC Approver' — arc.read + arc.approve
// 4 — holds tender.approve (unsatisfiable: no tender.read row exists) AND
// boq.read + boq.approve, which is what TENDER now resolves against.
const ROLE_TENDER_APPROVER = ROLE_IDS.TENDER_APPROVER;

async function purge() {
  await db.none(
    `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
       SELECT ais.id FROM tbl_approval_instance_steps ais
       JOIN tbl_approval_instances ai ON ai.id = ais.approval_instance_id
       WHERE ai.approval_policy_id = ANY($1::int[]))`,
    [ALL_POLICIES]
  );
  await db.none(
    `DELETE FROM tbl_approval_actions WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances WHERE approval_policy_id = ANY($1::int[]))`,
    [ALL_POLICIES]
  );
  await db.none(
    `DELETE FROM tbl_approval_instance_change_log WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances WHERE approval_policy_id = ANY($1::int[]))`,
    [ALL_POLICIES]
  );
  await db.none(
    `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances WHERE approval_policy_id = ANY($1::int[]))`,
    [ALL_POLICIES]
  );
  await db.none(`DELETE FROM tbl_approval_instances WHERE approval_policy_id = ANY($1::int[])`, [ALL_POLICIES]);
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [ALL_POLICIES]);
}

beforeAll(async () => {
  ROLE_TECH_APPROVER  = await systemRoleId("ARC Technical Approver");
  ROLE_NEG_APPROVER   = await systemRoleId("ARC Negotiation Approver");
  ROLE_TECH_EVALUATOR = await systemRoleId("ARC Tech Evaluator");
  ROLE_COMM_EVALUATOR = await systemRoleId("ARC Commercial Evaluator");
  ROLE_ARC_ADMIN      = await systemRoleId("ARC Admin");
  ROLE_ARC_APPROVER_LEGACY = await systemRoleId("ARC Approver");

  await db.none(
    `INSERT INTO tbl_users (id, name, email, mobile, password, user_type, status, company_id)
     VALUES ($1, 'ARC Tech Approver',   'arcstage.techapp@test.local',  '9000089001', 'x', 2, 1, $10),
            ($2, 'ARC Neg Approver',    'arcstage.negapp@test.local',   '9000089002', 'x', 2, 1, $10),
            ($3, 'ARC Tech Evaluator',  'arcstage.techeval@test.local', '9000089003', 'x', 2, 1, $10),
            ($4, 'ARC Comm Evaluator',  'arcstage.commeval@test.local', '9000089004', 'x', 2, 1, $10),
            ($5, 'ARC Module Admin',    'arcstage.arcadmin@test.local', '9000089005', 'x', 2, 1, $10),
            ($6, 'ARC Stage Initiator', 'arcstage.initiator@test.local','9000089006', 'x', 7, 1, $10),
            ($7, 'ARC Stage NoPerm',    'arcstage.noperm@test.local',   '9000089007', 'x', 2, 1, $10),
            ($8, 'ARC Stage Tender App','arcstage.tenderapp@test.local','9000089008', 'x', 2, 1, $10),
            ($9, 'ARC Stage Amend App', 'arcstage.amendapp@test.local', '9000089009', 'x', 2, 1, $10)
     ON CONFLICT (id) DO NOTHING`,
    [U_TECH_APPROVER, U_NEG_APPROVER, U_TECH_EVAL, U_COMM_EVAL, U_ARC_ADMIN, U_INITIATOR, U_NOPERM,
     U_TENDER_APP, U_AMEND_APP, IDS.companies.A]
  );

  // resolveApprovers joins tbl_hospitality_user_mappings — without a mapping a
  // ROLE step resolves to zero approvers and gets dropped for a reason that has
  // nothing to do with permissions, making every assertion below vacuous.
  for (const uid of ALL_USERS) {
    await db.none(
      `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
       VALUES ($1, $2, NULL, 0) ON CONFLICT DO NOTHING`,
      [uid, IDS.hospitality.A]
    );
  }

  await db.none(
    `INSERT INTO tbl_roles (id, title, description, created_by)
     VALUES ($1, 'ARC Stage NoPerm Fixture', 'holds no permissions at all', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [NOPERM_ROLE]
  );

  // Role grants: company-wide (hotel NULL, dept NULL) so a single row covers
  // every policy scope in this suite.
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [ALL_USERS]);
  const grants = [
    [U_TECH_APPROVER, ROLE_TECH_APPROVER],
    [U_NEG_APPROVER, ROLE_NEG_APPROVER],
    [U_TECH_EVAL, ROLE_TECH_EVALUATOR],
    [U_COMM_EVAL, ROLE_COMM_EVALUATOR],
    [U_ARC_ADMIN, ROLE_ARC_ADMIN],
    [U_NOPERM, NOPERM_ROLE],
    [U_TENDER_APP, ROLE_TENDER_APPROVER],
    [U_AMEND_APP, ROLE_ARC_APPROVER_LEGACY],
  ];
  for (const [userId, roleId] of grants) {
    await db.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
       VALUES ($1, $2, $3, NULL, NULL, NULL)`,
      [userId, roleId, IDS.hospitality.A]
    );
  }

  await purge();
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [ALL_POLICIES]);

  const policySpecs = [
    [P_TECH_ROLE,  "ARC_TECH",        IDS.hotels.A2, IDS.departments.eng],
    [P_TECH_EVAL,  "ARC_TECH",        IDS.hotels.A3, IDS.departments.eng],
    [P_NEG_ROLE,   "ARC_NEGOTIATION", IDS.hotels.A2, IDS.departments.eng],
    [P_NEG_EVAL,   "ARC_NEGOTIATION", IDS.hotels.A3, IDS.departments.eng],
    [P_TECH_ADMIN, "ARC_TECH",        IDS.hotels.A2, IDS.departments.fb],
    [P_CASE_A,     "ARC_TECH",        IDS.hotels.A3, IDS.departments.fb],
    [P_CASE_B,     "ARC_TECH",        IDS.hotels.A2, IDS.departments.hk],
    [P_AMENDMENT,  "ARC_AMENDMENT",   IDS.hotels.A3, IDS.departments.hk],
    [P_CASE_MIXED, "ARC_TECH",        IDS.hotels.A3, IDS.departments.proc],
    [P_COMMITTEE_ADMIN, "ARC_COMMITTEE", IDS.hotels.A2, IDS.departments.proc],
    [P_TENDER,     "TENDER",          IDS.hotels.A2, IDS.departments.proc],
  ];
  for (const [policyId, entityType, hotelId, deptId] of policySpecs) {
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id, process_id, is_active, created_by, is_master)
       VALUES ($1, $2, $3, $4, $5, NULL, true, $6, false)`,
      [policyId, entityType, IDS.hospitality.A, hotelId, deptId, U_INITIATOR]
    );
  }

  // One single-step ROLE policy each. Instances pass department_id = null, so
  // the resolver's dept filter is inert and the company-wide grants above apply.
  const stepSpecs = [
    [69101, P_TECH_ROLE,  "ROLE", ROLE_TECH_APPROVER],
    [69102, P_TECH_EVAL,  "ROLE", ROLE_TECH_EVALUATOR],
    [69103, P_NEG_ROLE,   "ROLE", ROLE_NEG_APPROVER],
    [69104, P_NEG_EVAL,   "ROLE", ROLE_COMM_EVALUATOR],
    [69105, P_TECH_ADMIN, "ROLE", ROLE_ARC_ADMIN],
    [69106, P_CASE_A,     "USER", U_INITIATOR],
    [69107, P_CASE_B,     "ROLE", NOPERM_ROLE],
    // ARC_AMENDMENT resolves against 'arc', so the step names the role that
    // actually holds arc.read + arc.approve. It used to name the ARC Technical
    // Approver, which was fine when the resource was the unmatchable
    // 'arc_amendment' (every role failed equally); it is wrong now that the gate
    // is real.
    [69108, P_AMENDMENT,  "ROLE", ROLE_ARC_APPROVER_LEGACY],
    [69111, P_COMMITTEE_ADMIN, "ROLE", ROLE_ARC_ADMIN],
    [69112, P_TENDER,     "ROLE", ROLE_TENDER_APPROVER],
  ];
  for (const [stepId, policyId, sourceType, sourceId] of stepSpecs) {
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (id, approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, $2, 1, 'ANY', $3, $4) ON CONFLICT (id) DO NOTHING`,
      [stepId, policyId, sourceType, sourceId]
    );
  }

  // The MIXED shape needs TWO steps: an unqualified ROLE that will be dropped,
  // then a USER step naming the initiator that will auto-complete.
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (id, approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES (69109, $1, 1, 'ANY', 'ROLE', $2),
            (69110, $1, 2, 'ANY', 'USER', $3)
     ON CONFLICT (id) DO NOTHING`,
    [P_CASE_MIXED, NOPERM_ROLE, U_INITIATOR]
  );
});

afterAll(async () => {
  await purge();
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [ALL_POLICIES]);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [ALL_USERS]);
  await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [NOPERM_ROLE]);
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [ALL_USERS]);
  await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [ALL_USERS]);
});

describe("ARC stage approver roles — permission shape", () => {
  it("seeds ARC Technical Approver with arc-tech.read + arc-tech.approve and nothing else", async () => {
    expect(await permissionKeysOf(ROLE_TECH_APPROVER)).toEqual(["arc-tech.approve", "arc-tech.read"]);
  });

  it("seeds ARC Negotiation Approver with arc-comm.read + arc-comm.approve and nothing else", async () => {
    expect(await permissionKeysOf(ROLE_NEG_APPROVER)).toEqual(["arc-comm.approve", "arc-comm.read"]);
  });

  it("maps ARC_TECH → arc-tech and ARC_NEGOTIATION → arc-comm", () => {
    expect(ENTITY_APPROVE_RESOURCE_MAP.ARC_TECH).toBe("arc-tech");
    expect(ENTITY_APPROVE_RESOURCE_MAP.ARC_NEGOTIATION).toBe("arc-comm");
  });

  it("gives the legacy 'ARC Approver' role the arc.read row it was missing", async () => {
    const legacy = await systemRoleId("ARC Approver");
    const keys = await permissionKeysOf(legacy);
    expect(keys).toContain("arc.approve");
    expect(keys).toContain("arc.read");
    // ...which is exactly what makes it pass its own gate for ARC / ARC_PUBLISH.
    expect(await roleHasReadAndApprovePermission(legacy, "arc")).toBe(true);
  });
});

describe("ARC_TECH / ARC_NEGOTIATION ROLE-source steps produce real approvals", () => {
  it("ARC_TECH + ARC Technical Approver → PENDING instance with that approver", async () => {
    const res = await makeInstance(P_TECH_ROLE, "ARC_TECH", IDS.hotels.A2);

    expect(res.autoApproved).toBeUndefined();
    expect(res.totalSteps).toBe(1);

    const row = await instanceRow(res.instance.id);
    expect(row.status).toBe("PENDING");
    expect(row.current_step).toBe(1);

    const approvers = await approversOf(res.instance.id);
    expect(approvers).toHaveLength(1);
    expect(approvers[0].approver_user_id).toBe(U_TECH_APPROVER);
    expect(approvers[0].status).toBe("PENDING");
  });

  it("ARC_NEGOTIATION + ARC Negotiation Approver → PENDING instance with that approver", async () => {
    const res = await makeInstance(P_NEG_ROLE, "ARC_NEGOTIATION", IDS.hotels.A2);

    expect(res.autoApproved).toBeUndefined();
    expect(res.totalSteps).toBe(1);

    const row = await instanceRow(res.instance.id);
    expect(row.status).toBe("PENDING");

    const approvers = await approversOf(res.instance.id);
    expect(approvers).toHaveLength(1);
    expect(approvers[0].approver_user_id).toBe(U_NEG_APPROVER);
    expect(approvers[0].status).toBe("PENDING");
  });
});

describe("GOVERNING CONSTRAINT (ROLE-source steps): an evaluator cannot approve their own work", () => {
  // ── HOW THIS PROPERTY IS OBSERVED, AND WHAT CHANGED ─────────────────────
  // The property is unchanged and non-negotiable: an evaluator role must never
  // end up holding approval authority over its own work. Only the OBSERVABLE
  // OUTCOME moved. The engine used to drop the unqualified step and then create
  // the instance APPROVED / current_step = 0, so these tests read the drop off
  // `metadata.auto_approval.skipped_steps` — the evaluator was not an approver,
  // but the evaluation sailed through unapproved, which is the same bad ending
  // by a different route. Dropping every step is now a REFUSAL: no instance, no
  // approval, the submission stops. So each test below asserts the rejection AND
  // that its diagnostics name the evaluator role and the step it sat on — the
  // same fact, from the surface that now carries it.

  it("ARC Tech Evaluator does not qualify to approve a technical evaluation", async () => {
    // Directly, at the gate...
    expect(await roleHasReadAndApprovePermission(ROLE_TECH_EVALUATOR, "arc-tech")).toBe(false);

    // ...and through the engine: the step is dropped, nobody is made an approver,
    // and with nothing left the whole creation is refused.
    const err = await expectRefusedCreation(makeInstance(P_TECH_EVAL, "ARC_TECH", IDS.hotels.A3));
    expect(err.diagnostics.skipped_steps).toEqual([
      expect.objectContaining({
        step_order: 1,
        approver_source_type: "ROLE",
        approver_source_id: ROLE_TECH_EVALUATOR,
        resource: "arc-tech",
        reason: "ROLE_LACKS_READ_AND_APPROVE",
      }),
    ]);
    expect(err.diagnostics.resolved_step_count).toBe(0);

    // The evaluation is not approved by anybody, including by default.
    expect(await instancesForPolicy(P_TECH_EVAL)).toEqual([]);
  });

  it("ARC Commercial Evaluator does not qualify to approve a negotiation round", async () => {
    expect(await roleHasReadAndApprovePermission(ROLE_COMM_EVALUATOR, "arc-comm")).toBe(false);

    const err = await expectRefusedCreation(makeInstance(P_NEG_EVAL, "ARC_NEGOTIATION", IDS.hotels.A3));
    expect(err.diagnostics.skipped_steps[0]).toMatchObject({
      approver_source_id: ROLE_COMM_EVALUATOR,
      resource: "arc-comm",
      reason: "ROLE_LACKS_READ_AND_APPROVE",
    });

    // No round goes live on an approval nobody granted.
    expect(await instancesForPolicy(P_NEG_EVAL)).toEqual([]);
  });

  it("ARC Admin is withheld BOTH new approve keys, so it cannot approve a tech evaluation", async () => {
    // Deliberate: ARC Admin holds arc-tech.evaluate + arc-comm.evaluate. Granting
    // it either new approve key would let ONE role both score an evaluation and
    // sign it off. A tenant wanting that must grant both roles explicitly.
    const keys = await permissionKeysOf(ROLE_ARC_ADMIN);
    expect(keys).toContain("arc-tech.evaluate");
    expect(keys).toContain("arc-comm.evaluate");
    expect(keys).not.toContain("arc-tech.approve");
    expect(keys).not.toContain("arc-comm.approve");

    const err = await expectRefusedCreation(makeInstance(P_TECH_ADMIN, "ARC_TECH", IDS.hotels.A2));
    expect(err.diagnostics.skipped_steps[0]).toMatchObject({
      approver_source_id: ROLE_ARC_ADMIN,
      resource: "arc-tech",
      reason: "ROLE_LACKS_READ_AND_APPROVE",
    });
    expect(await instancesForPolicy(P_TECH_ADMIN)).toEqual([]);
  });

  it("KNOWN GAP, PINNED: ARC Admin still qualifies to approve the AWARD it finalized", async () => {
    // The claim "ARC Admin evaluates, so it does not approve" would be false, and
    // the test above must not be read as making it. ARC Admin has held
    // arc-committee.read + arc-committee.approve since 20260608100800, and
    // ARC_COMMITTEE maps to 'arc-committee' — so it passes that gate outright.
    const keys = await permissionKeysOf(ROLE_ARC_ADMIN);
    expect(keys).toContain("arc-committee.approve");
    expect(keys).toContain("arc-committee.read");
    expect(await roleHasReadAndApprovePermission(ROLE_ARC_ADMIN, "arc-committee")).toBe(true);

    // And the same role holds the key that gates finalizeCommEval — the handler
    // that CREATES the ARC_COMMITTEE instance with initiated_by = that user. So
    // the award allocator, the finalizer and a resolved approver can be one
    // person, and if they are the sole resolved approver the engine's
    // isInitiatorInStep short-circuit auto-approves it.
    expect(keys).toContain("arc-comm.evaluate");

    // Demonstrated end to end rather than argued: an ARC_COMMITTEE instance
    // initiated BY the ARC Admin, on a policy naming their own role, is born
    // APPROVED with their own APPROVE action as the only audit row.
    const res = await makeInstance(P_COMMITTEE_ADMIN, "ARC_COMMITTEE", IDS.hotels.A2, {
      initiatedBy: U_ARC_ADMIN,
    });
    expect(res.autoApproved).toBe(true);
    expect(res.autoApprovalCase).toBe("INITIATOR_ONLY");

    const approvers = await approversOf(res.instance.id);
    expect(approvers).toEqual([
      expect.objectContaining({ approver_user_id: U_ARC_ADMIN, status: "APPROVED" }),
    ]);

    // Closing this means removing arc-committee.approve from ARC Admin — a
    // product decision, not a side effect of adding tech/commercial approvers.
    // WHEN THAT DECISION IS MADE, THIS TEST SHOULD FAIL and be rewritten.
  });
});

describe("enum-throw guard on roleHasReadAndApprovePermission", () => {
  // `tbl_permissions.resource` is the resource_type ENUM. Comparing it to a text
  // parameter made Postgres coerce the PARAMETER, so a non-label value RAISED
  // instead of matching nothing — and callers reach here with
  // `entity_type.toLowerCase()`, which produces underscores where the enum uses
  // hyphens. Casting the column to text turns the raise into a plain `false`.
  it("returns false for a resource that is not a resource_type label", async () => {
    await expect(roleHasReadAndApprovePermission(ROLE_TECH_APPROVER, "arc_tech")).resolves.toBe(false);
    await expect(roleHasReadAndApprovePermission(ROLE_TECH_APPROVER, "totally_made_up")).resolves.toBe(false);
    await expect(roleHasReadAndApprovePermission(ROLE_TECH_APPROVER, "arc_amendment")).resolves.toBe(false);
  });

  it("ARC_AMENDMENT now maps to a real resource, so its ROLE steps resolve instead of vanishing", async () => {
    // ── WHAT THIS TEST USED TO ASSERT ────────────────────────────────────
    // ARC_AMENDMENT was a real, authorable entity type the map did not cover, so
    // the lookup fell back to `entity_type.toLowerCase()` = 'arc_amendment'
    // (UNDERSCORE). Before the `::text` cast that RAISED
    // `invalid input value for enum resource_type` mid-transaction — a 500 in the
    // middle of the caller's own write — and this test pinned the improvement:
    // it degraded to a skipped step labelled ENTITY_TYPE_NOT_IN_RESOURCE_MAP.
    //
    // But "degrades to a skipped step" was only ever half a fix. No role can hold
    // a permission on a resource that does not exist, so EVERY ROLE step of every
    // amendment policy was dropped, and an all-ROLE policy produced an instance
    // born APPROVED — an amendment to agreed commercial terms, post-award, waved
    // through with nobody asked. The map now carries 'ARC_AMENDMENT' → 'arc':
    // the same resource the ARC base and publish gates use, and the one an
    // amendment approver must already hold to see the contract they are amending.
    expect(ENTITY_APPROVE_RESOURCE_MAP.ARC_AMENDMENT).toBe("arc");

    // A role holding arc.read + arc.approve now passes the gate and becomes a
    // real, pending approver — the code path that could not previously exist.
    expect(await roleHasReadAndApprovePermission(ROLE_ARC_APPROVER_LEGACY, "arc")).toBe(true);

    const res = await makeInstance(P_AMENDMENT, "ARC_AMENDMENT", IDS.hotels.A3);
    expect(res.autoApproved).toBeUndefined();
    expect(res.totalSteps).toBe(1);

    const row = await instanceRow(res.instance.id);
    expect(row.status).toBe("PENDING");
    expect(row.current_step).toBe(1);

    const approvers = await approversOf(res.instance.id);
    expect(approvers).toEqual([
      expect.objectContaining({ approver_user_id: U_AMEND_APP, status: "PENDING" }),
    ]);
  });

  it("refuses outright an entity type that is still absent from the resource map", async () => {
    // The enum-safety property this describe block is about, asserted on an
    // entity type that genuinely has no mapping. `generalController.submitApproval`
    // reads entity_type straight from the request body with no whitelist, so this
    // is reachable from outside.
    //
    // Two things must hold, and the second is the one that changed. It must not
    // RAISE a Postgres enum error (that was the original defect — the `::text`
    // cast fixed it), and it must not quietly proceed: an unmapped entity type
    // means no role can qualify, which used to mean every step dropped and the
    // instance born APPROVED. It is now rejected at the top of the function,
    // before the policy is even looked up.
    expect(ENTITY_APPROVE_RESOURCE_MAP.TOTALLY_MADE_UP_ENTITY).toBeUndefined();

    const err = await createApprovalInstance({
      entity_type: "TOTALLY_MADE_UP_ENTITY",
      entity_id: nextEntityId++,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A3,
      department_id: null,
      process_id: null,
      initiated_by: U_INITIATOR,
    }).then(
      (res) => { throw new Error(`expected a refusal, got instance ${res?.instance?.id}`); },
      (e) => e
    );

    expect(err.code).toBe("ENTITY_TYPE_NOT_IN_RESOURCE_MAP");
    expect(err.message).toMatch(/ENTITY_APPROVE_RESOURCE_MAP|no entry in/i);
    // Not the enum raise it once was.
    expect(err.message).not.toMatch(/invalid input value for enum/i);

    expect(
      await db.any(
        `SELECT id FROM tbl_approval_instances WHERE entity_type = 'TOTALLY_MADE_UP_ENTITY'`
      )
    ).toEqual([]);
  });

  // ── THE SAME DEFECT CLASS, ON TWO RBAC READ ENDPOINTS ────────────────────
  // `roleHasReadAndApprovePermission` was not the only uncast enum comparison.
  // rbacModel.getDepartmentsForUserScope and getUserPermissionsForHotels both
  // compared `p.resource` to a text parameter fed STRAIGHT from a query string /
  // request body, so any value that is not a resource_type label produced
  // `invalid input value for enum resource_type` — a 500 handed out by a URL.
  // Same `::text` fix, asserted over real HTTP because the reachability is the
  // point.
  it("GET /rbac/departments?resource=<not a label> returns a result, not a 500", async () => {
    const client = await httpClient(U_INITIATOR);
    const res = await client.get(
      `/api/v1/rbac/departments?hotel_id=${IDS.hotels.A1}&resource=definitely_not_a_resource`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body?.data)).toBe(true);

    // Still discriminating: a REAL resource the user has no grant for behaves
    // the same way, so the cast did not turn the filter into a pass-through.
    const real = await client.get(
      `/api/v1/rbac/departments?hotel_id=${IDS.hotels.A1}&resource=arc-tech`
    );
    expect(real.status).toBe(200);
  });

  it("POST /rbac/me/permissions/bulk with an unknown key returns a result, not a 500", async () => {
    const client = await httpClient(U_INITIATOR);
    const res = await client
      .post("/api/v1/rbac/me/permissions/bulk")
      .send({ hotel_ids: [IDS.hotels.A1], key: "definitely_not_a_resource" });
    expect(res.status).toBe(200);
    expect(res.body?.status).toBe(true);
  });
});

// The auto-approve fail-open used to be merely SELF-DESCRIBING: both exits
// produced an APPROVED / current_step = 0 row and a `metadata.auto_approval`
// block said which one you were looking at. Case (b) — nobody qualified — no
// longer has an exit: it is refused before the INSERT. What remains here is the
// legitimate short-circuit, the mixed shape, and proof that (b) leaves nothing
// behind.
describe("auto-approval survives only where somebody actually approved", () => {
  it("case (a) — initiator was the only approver — is labelled INITIATOR_ONLY and keeps a real audit trail", async () => {
    const res = await makeInstance(P_CASE_A, "ARC_TECH", IDS.hotels.A3, { initiatedBy: U_INITIATOR });

    expect(res.autoApproved).toBe(true);
    expect(res.autoApprovalCase).toBe("INITIATOR_ONLY");

    const row = await instanceRow(res.instance.id);
    expect(row.status).toBe("APPROVED");
    expect(row.current_step).toBe(0);
    expect(row.metadata.auto_approval.case).toBe("INITIATOR_ONLY");
    expect(row.metadata.auto_approval.legitimate).toBe(true);

    // The distinguishing evidence: a real step, a real approver, a real APPROVE.
    const approvers = await approversOf(res.instance.id);
    expect(approvers).toHaveLength(1);
    expect(approvers[0]).toMatchObject({ approver_user_id: U_INITIATOR, status: "APPROVED" });

    const actions = await db.any(
      `SELECT action, approver_user_id FROM tbl_approval_actions WHERE approval_instance_id = $1`,
      [res.instance.id]
    );
    expect(actions).toEqual([{ action: "APPROVE", approver_user_id: U_INITIATOR }]);
  });

  it("case (b) — nobody qualified — is REFUSED with a per-step reason, and no instance is written", async () => {
    // This used to assert the instance was created APPROVED / current_step = 0
    // and merely LABELLED `NO_APPROVER_RESOLVED, legitimate: false`. The label
    // was an improvement on nothing at all, but the entity still proceeded as
    // approved and the audit trail still read APPROVED — an authorization bypass
    // wearing a diagnostic. Refusal is the fix; the diagnostics survive on the
    // error, so the same triage information is available to whoever is blocked.
    const err = await expectRefusedCreation(makeInstance(P_CASE_B, "ARC_TECH", IDS.hotels.A2));

    expect(err.diagnostics.policy_step_count).toBe(1);
    expect(err.diagnostics.resolved_step_count).toBe(0);
    expect(err.diagnostics.skipped_steps).toEqual([
      expect.objectContaining({
        approver_source_type: "ROLE",
        approver_source_id: NOPERM_ROLE,
        resource: "arc-tech",
        resource_mapped: true,
        reason: "ROLE_LACKS_READ_AND_APPROVE",
      }),
    ]);
    // Actionable without reading the code: which policy, and what to do.
    expect(err.message).toMatch(new RegExp(`policy ${P_CASE_B}\\b`, "i"));

    // Nothing at all was written — not an instance, not a step, not an approver,
    // not an action. Under the old behaviour every one of these existed except
    // the last two, and the instance said APPROVED.
    expect(await instancesForPolicy(P_CASE_B)).toEqual([]);
    const orphanSteps = await db.any(
      `SELECT ais.id FROM tbl_approval_instance_steps ais
         JOIN tbl_approval_instances ai ON ai.id = ais.approval_instance_id
        WHERE ai.approval_policy_id = $1`,
      [P_CASE_B]
    );
    expect(orphanSteps).toEqual([]);
  });

  it("the MIXED shape — a step dropped AND the initiator self-approving the rest — is not stamped legitimate", async () => {
    // Policy [ROLE: unqualified, USER: initiator]. The ROLE step vanishes, the
    // USER step auto-completes, and the instance exits through the case-(a)
    // branch. Labelling that `legitimate: true` at info level would give the
    // worst combination in the engine the quietest treatment — a real approval
    // level gone AND the submitter approving what remained.
    const res = await makeInstance(P_CASE_MIXED, "ARC_TECH", IDS.hotels.A3);

    expect(res.autoApproved).toBe(true);
    expect(res.autoApprovalCase).toBe("INITIATOR_ONLY");
    expect(res.skippedSteps).toHaveLength(1);

    const row = await instanceRow(res.instance.id);
    expect(row.status).toBe("APPROVED");
    expect(row.metadata.auto_approval.case).toBe("INITIATOR_ONLY");
    // The boolean an alert keys off.
    expect(row.metadata.auto_approval.legitimate).toBe(false);
    expect(row.metadata.auto_approval.dropped_step_count).toBe(1);
    expect(row.metadata.auto_approval.skipped_steps[0]).toMatchObject({
      approver_source_id: NOPERM_ROLE,
      reason: "ROLE_LACKS_READ_AND_APPROVE",
    });

    // Only the surviving step exists, approved by the initiator.
    const approvers = await approversOf(res.instance.id);
    expect(approvers).toEqual([
      expect.objectContaining({ approver_user_id: U_INITIATOR, status: "APPROVED" }),
    ]);
  });

  it("TENDER: the unsatisfiable-resource landmine is defused — its ROLE step resolves to a real approver", async () => {
    // ── WHAT THIS TEST USED TO ASSERT ────────────────────────────────────
    // TENDER mapped to the `tender` resource, which holds ONLY `approve`; no
    // `tender.read` row exists anywhere, so NO role could pass the gate. The
    // policy-save guard deliberately allowed such a policy to be saved (an admin
    // cannot grant a permission that does not exist — see
    // arc.approvers.policyGuard.test.js), and this test pinned the other half of
    // that bargain: the step was dropped at runtime and the diagnostics named
    // the real fault, RESOURCE_CANNOT_SATISFY_GATE, rather than blaming the role.
    //
    // ── WHY THAT PREMISE IS GONE ─────────────────────────────────────────
    // The follow-up this test recorded ("seeding tender.read is a product
    // decision") was answered a different and better way: the map now points
    // TENDER at 'boq', the resource the tender surfaces already read on
    // (`CASE WHEN is_tender = 1 THEN 'boq' ELSE 'rfq' END`), which carries the
    // full read/approve pair. Nothing new was granted to anybody — the approval
    // gate was pointed at the resource the UI was already using, so "resolved as
    // approver" and "can see it" finally agree for tenders.
    //
    // So the property to pin inverts: a TENDER ROLE step is no longer dropped.
    expect(ENTITY_APPROVE_RESOURCE_MAP.TENDER).toBe("boq");
    expect(await roleHasReadAndApprovePermission(ROLE_TENDER_APPROVER, "boq")).toBe(true);
    // ...and the reason the old mapping was hopeless still holds, which is why
    // this had to be fixed by re-pointing rather than by granting.
    expect(await roleHasReadAndApprovePermission(ROLE_TENDER_APPROVER, "tender")).toBe(false);

    const res = await makeInstance(P_TENDER, "TENDER", IDS.hotels.A2);
    expect(res.autoApproved).toBeUndefined();
    expect(res.totalSteps).toBe(1);
    expect(res.skippedSteps ?? []).toEqual([]);

    const row = await instanceRow(res.instance.id);
    expect(row.status).toBe("PENDING");
    expect(row.current_step).toBe(1);
    // No diagnostics block at all — nothing was skipped.
    expect(row.metadata?.approval_diagnostics).toBeUndefined();
    expect(row.metadata?.auto_approval).toBeUndefined();

    expect(await approversOf(res.instance.id)).toEqual([
      expect.objectContaining({ approver_user_id: U_TENDER_APP, status: "PENDING" }),
    ]);
  });

  it("the two cases are now different KINDS of event, not two labels on the same row", async () => {
    // This used to assert that both cases produced an APPROVED / current_step = 0
    // row and were told apart only by `metadata.auto_approval.case`. That
    // labelling was the best available while both fell through the same
    // auto-approve branch. They no longer do: case (b) never becomes a row.
    const a = await makeInstance(P_CASE_A, "ARC_TECH", IDS.hotels.A3);
    const errB = await expectRefusedCreation(makeInstance(P_CASE_B, "ARC_TECH", IDS.hotels.A2));

    // (a) The legitimate one still auto-approves, still says so on the row.
    const rowA = await db.one(
      `SELECT status, current_step, metadata->'auto_approval'->>'case' AS auto_case,
              (metadata->'auto_approval'->>'legitimate')::boolean AS legitimate
         FROM tbl_approval_instances WHERE id = $1`,
      [a.instance.id]
    );
    expect(rowA).toMatchObject({
      status: "APPROVED",
      current_step: 0,
      auto_case: "INITIATOR_ONLY",
      legitimate: true,
    });

    // (b) There is no row to label. That is the distinction now — and the only
    // one that cannot be misread by a downstream query, a report, or a human
    // scanning for approvals nobody granted.
    expect(await instancesForPolicy(P_CASE_B)).toEqual([]);
    expect(errB.diagnostics.resolved_step_count).toBe(0);
  });
});
