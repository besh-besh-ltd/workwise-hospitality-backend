/**
 * The Approval Wizard may no longer save a ROLE step that can never approve.
 *
 * ── THE HOLE THIS CLOSES ──────────────────────────────────────────────────
 * `createApprovalInstance` drops a ROLE-source policy step whose role lacks BOTH
 * `<resource>.read` and `<resource>.approve` for the policy's entity type. The
 * drop is silent, and it happens at INSTANCE time — hours or weeks after the
 * policy was saved, inside somebody else's transaction. Drop every step and the
 * instance used to be born `APPROVED, current_step = 0`: an approval nobody
 * granted. `createApprovalInstance` now REFUSES that case outright
 * (`APPROVAL_POLICY_RESOLVES_TO_NOBODY`, no instance row written), so the
 * runtime consequence is a blocked submission instead of a silent bypass — but
 * that is a stall in someone else's transaction, discovered by whoever tried to
 * submit. Catching it at SAVE time, where the admin who caused it is standing,
 * is still the point of this suite.
 *
 * Nothing warned the admin at save time, and the wizard makes the mistake easy:
 * it lists every role in the tenant unfiltered and defaults each level to
 * `approver_source_type: 'ROLE'`. Picking "ARC Tech Evaluator" to approve a
 * technical evaluation is the obvious, wrong, one-click choice.
 *
 * ── THE VALIDATION SCOPE, AND WHY IT IS THE DELTA ─────────────────────────
 * Existing data already violates this rule. Production policy 194 uses
 * `Final Awarding P1/P2/P3` for entity_type `ARC`, and those roles hold zero
 * `arc.*` — every one of its ROLE steps is already being dropped. If the guard
 * validated ALL steps on every save, that policy (and others like it) could not
 * be edited AT ALL: not renamed, not deactivated, not moved, not repaired one
 * step at a time. The guard would lock the door on the people holding the mop.
 *
 * So the guard validates the steps this save ADDS or RE-POINTS, and nothing
 * else. New bad steps are impossible; old bad steps stay visible and fixable.
 * The suite below pins both halves — the rejection AND the non-rejection.
 *
 * Everything runs over real HTTP through the full middleware chain
 * (POST /api/v1/general/hospitality/approval/policies, acl([7])).
 */

import { jest } from "@jest/globals";
import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { roleStepPermissionVerdict } from "../../app/services/approvalPropagationService.js";
import { logger } from "../../app/util/logger.js";

// Same private ID block as arc.approvers.stageRoles.test.js — 89xxx users,
// 69xxx approval rows — but disjoint sub-ranges (89011+ / 69201+) so the two
// suites can run in either order in the same Jest process.
const ADMIN = 89011; // user_type 7 under buyer company A — the only role acl([7]) admits

// Pre-seeded policies (created directly so their "before" state is exactly the
// legacy shape under test). Each owns a distinct
// (entity_type, company, hotel, dept, process) tuple — uq_approval_policy_scope_process.
const P_LEGACY_ARC = 69201; // ARC   / A2 / hk  — the production-194 analogue: ROLE steps that already fail
const P_INDENT     = 69202; // INDENT / A3 / hk — entity type whose resource is not in the catalogue

const SEEDED_POLICIES = [P_LEGACY_ARC, P_INDENT];
const SEEDED_STEPS = [69211, 69212, 69221];

// Policies created THROUGH the endpoint during the run; ids are assigned by the
// sequence, so they are tracked by scope and swept in afterEach.
const CREATE_SCOPES = [
  [IDS.hotels.A1, IDS.departments.hk],
  [IDS.hotels.A1, IDS.departments.fb],
  [IDS.hotels.A2, IDS.departments.fb],
];

let ROLE_TECH_APPROVER;   // ARC Technical Approver   — arc-tech.read + arc-tech.approve
let ROLE_TECH_EVALUATOR;  // ARC Tech Evaluator       — arc-tech.evaluate + arc-tech.read, NO approve
let ROLE_NEG_APPROVER;    // ARC Negotiation Approver — arc-comm.read + arc-comm.approve
let ROLE_COMM_EVALUATOR;  // ARC Commercial Evaluator — arc-comm.evaluate + reads, NO approve

async function systemRoleId(title) {
  const row = await db.oneOrNone(
    `SELECT id FROM tbl_roles WHERE title = $1 AND created_by IS NULL ORDER BY id ASC LIMIT 1`,
    [title]
  );
  if (!row) throw new Error(`system role '${title}' is missing from the test database`);
  return row.id;
}

/** The payload shape the Approval Wizard posts. */
function savePolicy(client, body) {
  return client.post("/api/v1/general/hospitality/approval/policies").send({
    hospitality_company_id: IDS.hospitality.A,
    is_active: true,
    confirmed_approval_impact: true,
    ...body,
  });
}

const roleStep = (order, roleId, rule = "ANY") => ({
  step_order: order,
  decision_rule: rule,
  approval_type: "STANDARD",
  approver_source_type: "ROLE",
  approver_source_id: roleId,
});

const userStep = (order, userId, rule = "ANY") => ({
  step_order: order,
  decision_rule: rule,
  approval_type: "STANDARD",
  approver_source_type: "USER",
  approver_source_id: userId,
});

async function stepsOf(policyId) {
  return db.any(
    `SELECT step_order, decision_rule, approver_source_type, approver_source_id
       FROM tbl_approval_policy_steps WHERE approval_policy_id = $1 ORDER BY step_order ASC`,
    [policyId]
  );
}

/** Reset the legacy ARC policy to its pre-test step shape. */
async function resetLegacySteps() {
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [P_LEGACY_ARC]);
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (id, approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, $4, 1, 'ALL', 'ROLE', $6),
            ($2, $4, 2, 'ALL', 'ROLE', $7),
            ($3, $4, 3, 'ALL', 'USER', $5)`,
    [
      SEEDED_STEPS[0], SEEDED_STEPS[1], SEEDED_STEPS[2],
      P_LEGACY_ARC, ADMIN,
      ROLE_IDS.FINAL_AWARDING_P1, // 13 — holds awarding.*, zero arc.*
      14,                          // Final Awarding P2 — same
    ]
  );
}

async function sweepCreatedPolicies() {
  for (const [hotelId, deptId] of CREATE_SCOPES) {
    const rows = await db.any(
      `SELECT id FROM tbl_approval_policies
        WHERE hospitality_company_id = $1 AND hotel_id = $2 AND department_id = $3 AND created_by = $4`,
      [IDS.hospitality.A, hotelId, deptId, ADMIN]
    );
    const ids = rows.map((r) => r.id);
    if (!ids.length) continue;
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [ids]);
  }
}

beforeAll(async () => {
  ROLE_TECH_APPROVER  = await systemRoleId("ARC Technical Approver");
  ROLE_TECH_EVALUATOR = await systemRoleId("ARC Tech Evaluator");
  ROLE_NEG_APPROVER   = await systemRoleId("ARC Negotiation Approver");
  ROLE_COMM_EVALUATOR = await systemRoleId("ARC Commercial Evaluator");

  await db.none(
    `INSERT INTO tbl_users (id, name, email, mobile, password, user_type, status, company_id)
     VALUES ($1, 'ARC Policy Guard Admin', 'arcguard.admin@test.local', '9000089011', 'x', 7, 1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN, IDS.companies.A]
  );
  // computeApprovalCompanyScope unions in the buyer company's hospitality
  // entities for user_type 7 — that is the whole scope this admin gets.
  await db.none(`UPDATE tbl_users SET user_type = 7, status = 1, company_id = $2 WHERE id = $1`, [ADMIN, IDS.companies.A]);

  // Idempotent reset for a run killed before afterAll.
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [SEEDED_POLICIES]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [SEEDED_POLICIES]);
  await sweepCreatedPolicies();

  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id, process_id, is_active, created_by, is_master)
     VALUES ($1, 'ARC',    $3, $5, $7, NULL, true, $4, false),
            ($2, 'INDENT', $3, $6, $7, NULL, true, $4, false)`,
    [P_LEGACY_ARC, P_INDENT, IDS.hospitality.A, ADMIN, IDS.hotels.A2, IDS.hotels.A3, IDS.departments.hk]
  );
  await resetLegacySteps();
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (id, approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, $2, 1, 'ANY', 'ROLE', $3)`,
    [SEEDED_STEPS[2] + 1, P_INDENT, ROLE_IDS.TENDER_CREATOR]
  );
});

afterEach(async () => {
  await sweepCreatedPolicies();
  await resetLegacySteps();
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [SEEDED_POLICIES]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [SEEDED_POLICIES]);
  await sweepCreatedPolicies();
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [ADMIN]);
});

describe("CREATE — a new policy may not name a role that cannot approve it", () => {
  it("rejects an ARC_TECH policy whose ROLE step names ARC Tech Evaluator", async () => {
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      entity_type: "ARC_TECH",
      hotel_id: IDS.hotels.A1,
      department_id: IDS.departments.hk,
      steps: [roleStep(1, ROLE_TECH_EVALUATOR)],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("APPROVER_ROLE_CANNOT_APPROVE");
    // The message has to be actionable: which role, which permission.
    expect(res.body.message).toContain("ARC Tech Evaluator");
    expect(res.body.message).toContain("arc-tech.approve");
    expect(res.body.data.entity_type).toBe("ARC_TECH");
    expect(res.body.data.steps).toEqual([
      expect.objectContaining({
        step_order: 1,
        role_id: ROLE_TECH_EVALUATOR,
        role_title: "ARC Tech Evaluator",
        resource: "arc-tech",
        missing_permissions: ["arc-tech.approve"],
      }),
    ]);

    // Nothing was written.
    const created = await db.any(
      `SELECT id FROM tbl_approval_policies
        WHERE entity_type = 'ARC_TECH' AND hotel_id = $1 AND department_id = $2`,
      [IDS.hotels.A1, IDS.departments.hk]
    );
    expect(created).toHaveLength(0);
  });

  it("rejects an ARC_NEGOTIATION policy whose ROLE step names ARC Commercial Evaluator", async () => {
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      entity_type: "ARC_NEGOTIATION",
      hotel_id: IDS.hotels.A1,
      department_id: IDS.departments.fb,
      steps: [roleStep(1, ROLE_COMM_EVALUATOR)],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("APPROVER_ROLE_CANNOT_APPROVE");
    expect(res.body.data.steps[0]).toMatchObject({
      role_title: "ARC Commercial Evaluator",
      resource: "arc-comm",
      missing_permissions: ["arc-comm.approve"],
    });
  });

  it("accepts the same policies when they name the matching approver role", async () => {
    const client = await httpClient(ADMIN);

    const tech = await savePolicy(client, {
      entity_type: "ARC_TECH",
      hotel_id: IDS.hotels.A1,
      department_id: IDS.departments.hk,
      steps: [roleStep(1, ROLE_TECH_APPROVER)],
    });
    expect(tech.status).toBe(201);
    expect(await stepsOf(tech.body.data.id)).toEqual([
      { step_order: 1, decision_rule: "ANY", approver_source_type: "ROLE", approver_source_id: ROLE_TECH_APPROVER },
    ]);

    const neg = await savePolicy(client, {
      entity_type: "ARC_NEGOTIATION",
      hotel_id: IDS.hotels.A1,
      department_id: IDS.departments.fb,
      steps: [roleStep(1, ROLE_NEG_APPROVER)],
    });
    expect(neg.status).toBe(201);
    expect((await stepsOf(neg.body.data.id))[0].approver_source_id).toBe(ROLE_NEG_APPROVER);
  });

  it("reports every offending step, not just the first", async () => {
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      entity_type: "ARC_TECH",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.fb,
      steps: [
        roleStep(1, ROLE_TECH_APPROVER), // fine
        roleStep(2, ROLE_TECH_EVALUATOR), // not fine
        roleStep(3, ROLE_COMM_EVALUATOR), // not fine either — it is a commercial role
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.data.steps.map((s) => s.step_order)).toEqual([2, 3]);
    // ARC Commercial Evaluator carries arc-tech.READ (20260611100000 grants it so
    // the commercial stage can see the qualification basis) but never
    // arc-tech.approve — so it is one row short in exactly the same way, and the
    // message says which row.
    expect(res.body.data.steps[1].missing_permissions).toEqual(["arc-tech.approve"]);
  });

  it("leaves USER-source steps alone — the gate only applies to ROLE steps", async () => {
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      entity_type: "ARC_TECH",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.fb,
      steps: [userStep(1, ADMIN)],
    });
    expect(res.status).toBe(201);
  });

  it("judges a TENDER ROLE step on its merits now that TENDER maps to a satisfiable resource", async () => {
    // ── WHAT THIS TEST USED TO ASSERT, AND WHY IT NO LONGER CAN ───────────
    // TENDER used to map to the `tender` resource, which holds ONLY `approve`.
    // There is no `tender.read` row anywhere, so
    // roleHasReadAndApprovePermission(<any role>, 'tender') could never return
    // true for any role that will ever exist. TENDER is stage 1 of the
    // Tender-process route in the admin Approval Wizard and its role dropdown is
    // unfiltered, so an admin picking ANY role at Level 1 got a 400 they could
    // not resolve through any UI — `tender.read` cannot be granted because it
    // does not exist. This test therefore pinned a FAIL-OPEN: the guard waved
    // the step through with a loud warning, and the runtime consequence (every
    // ROLE step dropped, instance born APPROVED) was accepted as the price.
    //
    // ── WHAT CHANGED ─────────────────────────────────────────────────────
    // ENTITY_APPROVE_RESOURCE_MAP now maps 'TENDER' → 'boq', the resource the
    // tender surfaces actually read on (`CASE WHEN is_tender = 1 THEN 'boq'`),
    // and `boq` carries the full read/approve pair. The landmine is defused at
    // the source rather than routed around: there is nothing to fail open ABOUT,
    // so the guard discriminates on TENDER exactly as it does on every other
    // entity type. Both halves of that are asserted below, because "it stopped
    // failing open" is only good news if the gate is now real.
    const tenderCatalogue = await db.any(
      `SELECT DISTINCT action::text AS action FROM tbl_permissions
        WHERE resource::text = 'tender' AND action IN ('read','approve')`
    );
    // Still pinned: `tender` remains unsatisfiable. That is the fact that made
    // pointing TENDER at it wrong, and if someone ever seeds `tender.read` the
    // rationale above changes and this test should say so by failing here.
    expect(tenderCatalogue.map((r) => r.action).sort()).toEqual(["approve"]);

    // ...and the resource TENDER points at instead can satisfy the gate.
    const boqCatalogue = await db.any(
      `SELECT DISTINCT action::text AS action FROM tbl_permissions
        WHERE resource::text = 'boq' AND action IN ('read','approve')`
    );
    expect(boqCatalogue.map((r) => r.action).sort()).toEqual(["approve", "read"]);

    // 'Tender Approver' holds boq.read + boq.approve, so it is permitted ON ITS
    // MERITS — reason OK, not the RESOURCE_CANNOT_SATISFY_GATE pass it used to
    // be waved through with.
    const verdict = await roleStepPermissionVerdict(ROLE_IDS.TENDER_APPROVER, "TENDER", db);
    expect(verdict).toEqual({ permitted: true, resource: "boq", reason: "OK" });

    // The other half, and the reason this is a strengthening rather than a
    // relaxation: a role that does NOT hold the pair is now REJECTED. Under the
    // old fail-open EVERY role passed this save, including this one, and the
    // policy then silently dropped its only step at instance time.
    const client = await httpClient(ADMIN);
    const rejected = await savePolicy(client, {
      entity_type: "TENDER",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.fb,
      steps: [roleStep(1, ROLE_IDS.TENDER_CREATOR)], // boq.read + boq.create, no boq.approve
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("APPROVER_ROLE_CANNOT_APPROVE");
    expect(rejected.body.data.steps[0]).toMatchObject({
      role_id: ROLE_IDS.TENDER_CREATOR,
      role_title: "Tender Creator",
      resource: "boq",
      missing_permissions: ["boq.approve"],
    });
    expect(
      await db.any(
        `SELECT id FROM tbl_approval_policies
          WHERE entity_type = 'TENDER' AND hotel_id = $1 AND department_id = $2`,
        [IDS.hotels.A2, IDS.departments.fb]
      )
    ).toHaveLength(0);

    const warn = jest.spyOn(logger, "warn");
    try {
      const accepted = await savePolicy(client, {
        entity_type: "TENDER",
        hotel_id: IDS.hotels.A2,
        department_id: IDS.departments.fb,
        steps: [roleStep(1, ROLE_IDS.TENDER_APPROVER)],
      });

      expect(accepted.status).toBe(201);
      expect(await stepsOf(accepted.body.data.id)).toEqual([
        { step_order: 1, decision_rule: "ANY", approver_source_type: "ROLE", approver_source_id: ROLE_IDS.TENDER_APPROVER },
      ]);

      // The 201 must come from passing the gate, not from being waved past it.
      // The fail-open path is the one that names the missing row, so its absence
      // is the observable difference between "permitted" and "unjudgeable".
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.filter((m) => m.includes("tender.read"))).toEqual([]);
      expect(messages.filter((m) => m.includes("RolePermGate"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("still rejects when the catalogue CAN express the requirement and the role just lacks it", async () => {
    // The distinction the fail-open turns on. `arc-tech.approve` exists, so
    // naming a role that does not hold it is an admin error and stays a 400 —
    // unlike a resource with no rows at all (see the INDENT case below), where
    // the missing permission cannot be granted by any admin.
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      entity_type: "ARC_TECH",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.fb,
      steps: [roleStep(1, ROLE_TECH_EVALUATOR)],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("APPROVER_ROLE_CANNOT_APPROVE");
  });

  it("fails OPEN when the entity type's resource is not in the permission catalogue", async () => {
    // INDENT maps to nothing, so the fallback resource is 'indent' — which has
    // no read/approve rows anywhere. That is a hole in the resource map, not
    // evidence about the role, and rejecting there would make unmodelled entity
    // types unauthorable. Same verdict the revocation reconciler uses.
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      entity_type: "INDENT",
      hotel_id: IDS.hotels.A1,
      department_id: IDS.departments.hk,
      steps: [roleStep(1, ROLE_TECH_EVALUATOR)],
    });
    expect(res.status).toBe(201);
  });
});

describe("UPDATE — the guard validates the delta, not the whole policy", () => {
  it("lets a legacy policy whose existing ROLE steps already fail be re-saved unchanged", async () => {
    // The production-194 shape: entity_type ARC with Final Awarding P1/P2, which
    // hold zero arc.*. Every one of these steps is already dropped at instance
    // time. Editing the policy for an unrelated reason must still work.
    const before = await stepsOf(P_LEGACY_ARC);
    expect(before[0].approver_source_type).toBe("ROLE");

    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      id: P_LEGACY_ARC,
      entity_type: "ARC",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.hk,
      steps: before.map((s) => ({
        step_order: s.step_order,
        decision_rule: s.decision_rule,
        approver_source_type: s.approver_source_type,
        approver_source_id: s.approver_source_id,
      })),
    });

    expect(res.status).toBe(200);
    expect(await stepsOf(P_LEGACY_ARC)).toEqual(before);
  });

  it("lets an untouched bad step's decision_rule change — the role named there is pre-existing", async () => {
    const before = await stepsOf(P_LEGACY_ARC);
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      id: P_LEGACY_ARC,
      entity_type: "ARC",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.hk,
      steps: before.map((s) => ({
        step_order: s.step_order,
        decision_rule: s.step_order === 1 ? "ANY" : s.decision_rule,
        approver_source_type: s.approver_source_type,
        approver_source_id: s.approver_source_id,
      })),
    });

    expect(res.status).toBe(200);
    expect((await stepsOf(P_LEGACY_ARC))[0].decision_rule).toBe("ANY");
  });

  it("rejects RE-POINTING a step at another role that cannot approve", async () => {
    const before = await stepsOf(P_LEGACY_ARC);
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      id: P_LEGACY_ARC,
      entity_type: "ARC",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.hk,
      steps: [
        { ...before[0], approver_source_id: ROLE_TECH_EVALUATOR },
        before[1],
        before[2],
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("APPROVER_ROLE_CANNOT_APPROVE");
    expect(res.body.data.steps[0]).toMatchObject({
      step_order: 1,
      role_title: "ARC Tech Evaluator",
      resource: "arc",
      missing_permissions: ["arc.read", "arc.approve"],
    });
    // The save aborted before any mutation.
    expect(await stepsOf(P_LEGACY_ARC)).toEqual(before);
  });

  it("rejects ADDING a new bad ROLE step to an already-bad policy", async () => {
    const before = await stepsOf(P_LEGACY_ARC);
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      id: P_LEGACY_ARC,
      entity_type: "ARC",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.hk,
      steps: [...before, roleStep(4, ROLE_TECH_EVALUATOR, "ALL")],
    });

    expect(res.status).toBe(400);
    expect(res.body.data.steps).toEqual([expect.objectContaining({ step_order: 4 })]);
    expect(await stepsOf(P_LEGACY_ARC)).toEqual(before);
  });

  it("accepts REPAIRING a bad step by pointing it at a role that can approve", async () => {
    // The repair path the delta scope exists to keep open. ARC Approver holds
    // arc.approve and (as of this change) arc.read.
    const arcApprover = await systemRoleId("ARC Approver");
    const before = await stepsOf(P_LEGACY_ARC);
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      id: P_LEGACY_ARC,
      entity_type: "ARC",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.hk,
      steps: [{ ...before[0], approver_source_id: arcApprover }, before[1], before[2]],
    });

    expect(res.status).toBe(200);
    expect((await stepsOf(P_LEGACY_ARC))[0].approver_source_id).toBe(arcApprover);
  });

  it("cannot be bypassed by OMITTING step_order", async () => {
    // The first implementation derived the validation set from
    // computePolicyStepDiff, which keys purely on `step_order`. Omit the field
    // and every proposed step collapses onto one `undefined` key holding only
    // the LAST element: every stored step read as STEP_REMOVED (never
    // validated) and one lone entry as STEP_ADDED. An unqualified ROLE step
    // riding in front of a USER step was persisted unchecked — while
    // insertPolicySteps happily numbered both from the array index.
    const before = await stepsOf(P_LEGACY_ARC);
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      id: P_LEGACY_ARC,
      entity_type: "ARC",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.hk,
      steps: [
        { decision_rule: "ANY", approver_source_type: "ROLE", approver_source_id: ROLE_TECH_EVALUATOR },
        { decision_rule: "ANY", approver_source_type: "USER", approver_source_id: ADMIN },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("APPROVER_ROLE_CANNOT_APPROVE");
    // step_order is reported the way insertPolicySteps would have derived it.
    expect(res.body.data.steps).toEqual([
      expect.objectContaining({ step_order: 1, role_id: ROLE_TECH_EVALUATOR }),
    ]);
    expect(await stepsOf(P_LEGACY_ARC)).toEqual(before);
  });

  it("cannot be bypassed by DUPLICATING a step_order with the bad entry first", async () => {
    // Map.set keeps the last write, so an order-keyed diff saw no change at
    // order 1 and validated nothing — while insertPolicySteps wrote BOTH rows
    // (there is no unique constraint on (approval_policy_id, step_order)).
    const before = await stepsOf(P_LEGACY_ARC);
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      id: P_LEGACY_ARC,
      entity_type: "ARC",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.hk,
      steps: [
        { step_order: 1, decision_rule: "ALL", approver_source_type: "ROLE", approver_source_id: ROLE_TECH_EVALUATOR },
        { step_order: 1, decision_rule: "ALL", approver_source_type: "ROLE", approver_source_id: ROLE_IDS.FINAL_AWARDING_P1 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.data.steps).toEqual([
      expect.objectContaining({ role_id: ROLE_TECH_EVALUATOR }),
    ]);
    expect(await stepsOf(P_LEGACY_ARC)).toEqual(before);
  });

  it("is not fooled by a string step_order into whole-policy validation", async () => {
    // The order-keyed diff compared numbers to strings, so "1" matched nothing
    // and every step flipped to ADDED/REMOVED — re-validating the whole legacy
    // policy and making it un-saveable, the exact outcome delta scope avoids.
    const before = await stepsOf(P_LEGACY_ARC);
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      id: P_LEGACY_ARC,
      entity_type: "ARC",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.hk,
      steps: before.map((s) => ({
        step_order: String(s.step_order),
        decision_rule: s.decision_rule,
        approver_source_type: s.approver_source_type,
        approver_source_id: s.approver_source_id,
      })),
    });

    expect(res.status).toBe(200);
    expect(await stepsOf(P_LEGACY_ARC)).toEqual(before);
  });

  it("allows REORDERING two pre-existing bad steps — nothing new is named", async () => {
    // The delta is the multiset of ROLE sources, not positions, so swapping two
    // already-present roles introduces nothing and stays editable.
    const before = await stepsOf(P_LEGACY_ARC);
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      id: P_LEGACY_ARC,
      entity_type: "ARC",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.hk,
      steps: [
        { ...before[0], approver_source_id: before[1].approver_source_id },
        { ...before[1], approver_source_id: before[0].approver_source_id },
        before[2],
      ],
    });

    expect(res.status).toBe(200);
    const after = await stepsOf(P_LEGACY_ARC);
    expect(after[0].approver_source_id).toBe(before[1].approver_source_id);
    expect(after[1].approver_source_id).toBe(before[0].approver_source_id);
  });

  it("rejects DUPLICATING a pre-existing bad role onto an extra step", async () => {
    // Grandfathering is by multiplicity, not membership: using a bad role once
    // more than the policy already did is a NEW bad step.
    const before = await stepsOf(P_LEGACY_ARC);
    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      id: P_LEGACY_ARC,
      entity_type: "ARC",
      hotel_id: IDS.hotels.A2,
      department_id: IDS.departments.hk,
      steps: [...before, { ...before[0], step_order: 4 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.data.steps).toEqual([
      expect.objectContaining({ step_order: 4, role_id: ROLE_IDS.FINAL_AWARDING_P1 }),
    ]);
    expect(await stepsOf(P_LEGACY_ARC)).toEqual(before);
  });

  it("re-checks EVERY step when the entity_type changes under them", async () => {
    // Changing entity_type re-points every step at a different permission
    // resource, so no step's prior validity carries over.
    const before = await stepsOf(P_INDENT);
    expect(before[0].approver_source_type).toBe("ROLE");

    const client = await httpClient(ADMIN);
    const res = await savePolicy(client, {
      id: P_INDENT,
      entity_type: "ARC_TECH",
      hotel_id: IDS.hotels.A3,
      department_id: IDS.departments.hk,
      steps: before.map((s) => ({
        step_order: s.step_order,
        decision_rule: s.decision_rule,
        approver_source_type: s.approver_source_type,
        approver_source_id: s.approver_source_id,
      })),
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("APPROVER_ROLE_CANNOT_APPROVE");
    expect(res.body.data.entity_type).toBe("ARC_TECH");
    // Unchanged on disk: still INDENT, still its original step.
    const after = await db.one(`SELECT entity_type FROM tbl_approval_policies WHERE id = $1`, [P_INDENT]);
    expect(after.entity_type).toBe("INDENT");
    expect(await stepsOf(P_INDENT)).toEqual(before);
  });
});
