/**
 * Instance step numbering is NOT policy step numbering.
 *
 * createApprovalInstance (generalModel.js:2226-2258) numbers instance steps with
 * a fresh counter that only advances for steps that survived resolution — a
 * policy step resolving to zero approvers is dropped WITHOUT consuming a number.
 * Policy steps 1,2,3 with #1 dropped become instance steps 1,2, so instance
 * step 1 is policy step 2.
 *
 * The mid-flight reconciler used to re-derive each step's approver source by
 * ORDINAL (`ps.step_order = ais.step_order`), throwing away the true link stored
 * in `tbl_approval_instance_steps.policy_step_id`. Three silent failures follow:
 *
 *   1. the ordinal lands on a step the reconciler doesn't handle → the row is
 *      dropped from discovery and a revoked approver keeps a live approval;
 *   2. the ordinal lands on a DIFFERENT role → re-resolution runs against the
 *      wrong role, so someone can be removed from a step whose role they still
 *      hold, kept on a step whose role they just lost, or ADDED to a step no
 *      role of theirs backs;
 *   3. the policy-diff path matches by ordinal too, so a policy edit can apply a
 *      removal and a modification to the SAME instance step, and can re-point
 *      `policy_step_id` onto a step it does not belong to.
 *
 * Measured on production 2026-08-03: 471 instance steps where the ordinal join
 * lands on a different policy step than `policy_step_id`.
 *
 * The existing scoped-impact suite cannot reach any of this: it hand-inserts
 * instance steps whose step_order always equals the policy's. Everything here
 * builds the instance through the REAL createApprovalInstance so the divergence
 * is produced the way production produces it, then drives the real HTTP
 * endpoints (PUT /users/update-user-detail for membership changes, POST
 * /general/hospitality/approval/policies for policy edits) through the full
 * middleware chain.
 */

import { db, withTx } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";
import {
  revalidateApproverMembership,
  applyDiffToInstance,
  propagatePolicyChangeToInstances,
  computePolicyStepDiff,
  snapshotPolicySteps,
} from "../../app/services/approvalPropagationService.js";

// Local ID block — 87xxx / 67xxx are unused by fixtures and by the sibling
// scoped-impact suite (which owns 88xxx / 68xxx).
const ADMIN_ID = 87001;  // performs the update; holds no approver role; user_type 7 for acl([7])
const GHOST_ID = 87002;  // named by policy step 1; has NO hospitality mapping → resolves to ZERO approvers
const CO_ID = 87003;     // co-approver, keeps steps alive after a removal (rule = ALL)
const TARGET_ID = 87004; // the user whose grant is revoked / granted

// Two roles that BOTH carry read+approve on the PO ('awarding') resource, so
// neither ROLE step is dropped by roleHasReadAndApprovePermission at creation.
const ROLE_B = ROLE_IDS.FINAL_AWARDING_P1; // 13 — backs POLICY step 2 → INSTANCE step 1
const ROLE_A = 14;                         // Final Awarding P2 — backs POLICY step 3 → INSTANCE step 2
const ROLE_FILLER = ROLE_IDS.RFQ_OBSERVER; // 17 — backs nothing here; keeps the `roles: []` wipe guard out of play

// Policies. Each owns a distinct (hotel, department) tuple because
// uq_approval_policy_scope_process is UNIQUE on
// (entity_type, company, COALESCE(hotel,0), COALESCE(dept,0), COALESCE(process,0)).
// The scope is otherwise irrelevant: every instance below names its policy
// explicitly via `approval_policy_id`.
const DIVERGENT_POLICY = 67001; // A3 / dept NULL — step 1 dropped → numbering shifts by one
const ALIGNED_POLICY = 67002;   // A2 / dept NULL — nothing dropped → numbering coincides
const COLLISION_POLICY = 67003; // A3 / dept proc — for the diff-matcher injectivity test
const REFRESH_POLICY = 67004;   // A2 / dept proc — for the policy_step_id re-point test
const ALL_POLICIES = [DIVERGENT_POLICY, ALIGNED_POLICY, COLLISION_POLICY, REFRESH_POLICY];

// Explicit policy-step ids (+ ON CONFLICT) so a run that dies before afterAll
// cannot leave rows that make the next beforeAll trip idx_unique_step_order.
const DIV_STEPS = [67101, 67102, 67103];
const ALN_STEPS = [67201, 67202];
const COL_STEPS = [67301, 67302, 67303, 67304];
const REF_STEPS = [67401, 67402, 67403, 67404];

let createdInstanceIds = [];
let nextEntityId = 8700001;

/** The full desired role list, in the shape the frontend PUTs. */
function rolesPayload(roleIds) {
  return roleIds.map((role_id) => ({
    role_id,
    company_id: IDS.hospitality.A,
    hotel_id: null, // company-wide grant — covers every hotel in hospitality A
    department_id: IDS.departments.proc,
    process_id: null,
  }));
}

async function setUserRoles(userId, roleIds) {
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [userId]);
  for (const roleId of roleIds) {
    await db.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
       VALUES ($1, $2, $3, NULL, $4, NULL)`,
      [userId, roleId, IDS.hospitality.A, IDS.departments.proc]
    );
  }
}

/** Build a PENDING PO approval instance through the production creator. */
async function makeInstance(policyId, hotelId, t = null) {
  const entityId = nextEntityId++;
  const res = await createApprovalInstance({
    entity_type: "PO",
    entity_id: entityId,
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: hotelId,
    department_id: IDS.departments.proc,
    process_id: null,
    approval_policy_id: policyId,
    initiated_by: ADMIN_ID,
    metadata: { po_number: `PO-DIV-${entityId}` },
    ...(t ? { txContext: t } : {}),
  });
  if (!t) createdInstanceIds.push(res.instance.id);
  return res.instance;
}

/** (instance step_order → policy step_order) as actually stored. */
async function stepMapping(instanceId) {
  return db.any(
    `SELECT ais.step_order            AS instance_step_order,
            ps.step_order             AS policy_step_order,
            ps.approver_source_type,
            ps.approver_source_id
       FROM tbl_approval_instance_steps ais
       JOIN tbl_approval_policy_steps ps ON ps.id = ais.policy_step_id
      WHERE ais.approval_instance_id = $1
      ORDER BY ais.step_order ASC`,
    [instanceId]
  );
}

async function instanceStepsOf(instanceId) {
  return db.any(
    `SELECT id, step_order, status, policy_step_id
       FROM tbl_approval_instance_steps
      WHERE approval_instance_id = $1
      ORDER BY step_order ASC`,
    [instanceId]
  );
}

async function approverStatusAt(instanceId, instanceStepOrder, userId) {
  const row = await db.oneOrNone(
    `SELECT asa.status
       FROM tbl_approval_step_approvers asa
       JOIN tbl_approval_instance_steps ais ON ais.id = asa.approval_instance_step_id
      WHERE ais.approval_instance_id = $1
        AND ais.step_order = $2
        AND asa.approver_user_id = $3`,
    [instanceId, instanceStepOrder, userId]
  );
  return row?.status;
}

async function auditActions(instanceId, action) {
  return db.any(
    `SELECT aa.approval_instance_step_id, ais.step_order, ais.status AS step_status
       FROM tbl_approval_actions aa
       LEFT JOIN tbl_approval_instance_steps ais ON ais.id = aa.approval_instance_step_id
      WHERE aa.approval_instance_id = $1 AND aa.action = $2`,
    [instanceId, action]
  );
}

/** POST the payload the Approval Wizard posts when an admin saves a policy. */
async function editPolicy(client, policyId, { hotelId, departmentId, steps }) {
  return client.post("/api/v1/general/hospitality/approval/policies").send({
    id: policyId,
    entity_type: "PO",
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: hotelId,
    department_id: departmentId,
    is_active: true,
    confirmed_approval_impact: true,
    steps,
  });
}

const step = (order, sourceType, sourceId) => ({
  step_order: order,
  decision_rule: "ALL",
  approver_source_type: sourceType,
  approver_source_id: sourceId,
});

beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_users (id, name, email, mobile, password, user_type, status, company_id)
     VALUES ($1, 'Divergence Admin',  'divergence.admin@test.local',  '9000087001', 'x', 7, 1, $5),
            ($2, 'Divergence Ghost',  'divergence.ghost@test.local',  '9000087002', 'x', 2, 1, $5),
            ($3, 'Divergence CoAppr', 'divergence.coappr@test.local', '9000087003', 'x', 2, 1, $5),
            ($4, 'Divergence Target', 'divergence.target@test.local', '9000087004', 'x', 2, 1, $5)
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_ID, GHOST_ID, CO_ID, TARGET_ID, IDS.companies.A]
  );
  // user_type 7 is what acl([7]) on the policy-upsert route gates on, and what
  // resolveApprovalCompanyScope uses to derive the admin's hospitality scope.
  await db.none(`UPDATE tbl_users SET user_type = 7, status = 1 WHERE id = $1`, [ADMIN_ID]);

  // GHOST is deliberately given NO hospitality mapping — that is what makes the
  // USER-sourced policy step 1 resolve to zero approvers and get dropped.
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
     VALUES ($1, $4, NULL, 0),
            ($2, $4, $5, 1), ($2, $4, $6, 1),
            ($3, $4, $5, 1), ($3, $4, $6, 1)
     ON CONFLICT DO NOTHING`,
    [ADMIN_ID, CO_ID, TARGET_ID, IDS.hospitality.A, IDS.hotels.A3, IDS.hotels.A2]
  );

  await db.none(
    `INSERT INTO tbl_user_department (user_id, department_id) VALUES ($1, $3), ($2, $3)
     ON CONFLICT DO NOTHING`,
    [CO_ID, TARGET_ID, IDS.departments.proc]
  );

  // The co-approver holds BOTH roles company-wide, so no step ever empties out.
  await setUserRoles(CO_ID, [ROLE_B, ROLE_A]);

  // Guard: if either role lost read+approve on 'awarding', createApprovalInstance
  // would drop BOTH ROLE steps and every test below would pass vacuously.
  const perms = await db.any(
    `SELECT rp.role_id, count(DISTINCT p.action)::int AS cnt
       FROM tbl_role_permissions rp
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ANY($1::int[])
        AND p.resource = 'awarding' AND p.action IN ('read','approve')
      GROUP BY rp.role_id`,
    [[ROLE_B, ROLE_A]]
  );
  expect(perms.map((r) => r.cnt).sort()).toEqual([2, 2]);

  // Idempotent reset. A run killed before afterAll leaves the policies behind
  // (they insert ON CONFLICT DO NOTHING) but the policy-edit tests below replace
  // their steps with fresh serial ids — so re-inserting the fixed step ids would
  // trip idx_unique_step_order (approval_policy_id, step_order). Clear first.
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
  await db.none(`DELETE FROM tbl_approval_policy_change_log WHERE approval_policy_id = ANY($1::int[])`, [ALL_POLICIES]);
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [ALL_POLICIES]);

  const policies = [
    [DIVERGENT_POLICY, IDS.hotels.A3, null],
    [ALIGNED_POLICY, IDS.hotels.A2, null],
    [COLLISION_POLICY, IDS.hotels.A3, IDS.departments.proc],
    [REFRESH_POLICY, IDS.hotels.A2, IDS.departments.proc],
  ];
  for (const [policyId, hotelId, deptId] of policies) {
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id, process_id, is_active, created_by)
       VALUES ($1, 'PO', $2, $3, $4, NULL, true, $5)
       ON CONFLICT (id) DO NOTHING`,
      [policyId, IDS.hospitality.A, hotelId, deptId, ADMIN_ID]
    );
  }

  const insertSteps = async (policyId, rows) => {
    for (const [id, order, sourceType, sourceId] of rows) {
      await db.none(
        `INSERT INTO tbl_approval_policy_steps
           (id, approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
         VALUES ($1, $2, $3, 'ALL', $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [id, policyId, order, sourceType, sourceId]
      );
    }
  };

  // Divergent: step 1 resolves to nobody and is dropped.
  await insertSteps(DIVERGENT_POLICY, [
    [DIV_STEPS[0], 1, "USER", GHOST_ID],
    [DIV_STEPS[1], 2, "ROLE", ROLE_B],
    [DIV_STEPS[2], 3, "ROLE", ROLE_A],
  ]);
  // Aligned: nothing dropped, ordinals coincide.
  await insertSteps(ALIGNED_POLICY, [
    [ALN_STEPS[0], 1, "ROLE", ROLE_B],
    [ALN_STEPS[1], 2, "ROLE", ROLE_A],
  ]);
  // Collision + refresh: divergent AND long enough that a tail removal and a
  // mid-chain modification can fight over one instance step.
  for (const [policyId, ids] of [[COLLISION_POLICY, COL_STEPS], [REFRESH_POLICY, REF_STEPS]]) {
    await insertSteps(policyId, [
      [ids[0], 1, "USER", GHOST_ID],
      [ids[1], 2, "ROLE", ROLE_B],
      [ids[2], 3, "ROLE", ROLE_A],
      [ids[3], 4, "ROLE", ROLE_B],
    ]);
  }
});

beforeEach(async () => {
  await setUserRoles(TARGET_ID, [ROLE_B, ROLE_A]);
  await db.none(`UPDATE tbl_users SET status = 1 WHERE id = $1`, [TARGET_ID]);
});

afterEach(async () => {
  if (createdInstanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [createdInstanceIds]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [createdInstanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [createdInstanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_change_log WHERE approval_instance_id = ANY($1::int[])`, [createdInstanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [createdInstanceIds]);
    createdInstanceIds = [];
  }
  await db.none(`DELETE FROM tbl_approval_policy_change_log WHERE changed_by = $1`, [ADMIN_ID]);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [TARGET_ID]);
  await db.none(`UPDATE tbl_users SET status = 1 WHERE id = $1`, [TARGET_ID]);
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [[CO_ID, TARGET_ID]]);
  await db.none(`DELETE FROM tbl_user_department WHERE user_id = ANY($1::int[])`, [[CO_ID, TARGET_ID]]);
  // Delete by policy, not by id — the policy-edit tests replace the fixed step
  // ids with fresh serial ones.
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [ALL_POLICIES]);
  await db.none(`DELETE FROM tbl_approval_policy_change_log WHERE approval_policy_id = ANY($1::int[])`, [ALL_POLICIES]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [ALL_POLICIES]);
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [
    [ADMIN_ID, GHOST_ID, CO_ID, TARGET_ID],
  ]);
  await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [[ADMIN_ID, GHOST_ID, CO_ID, TARGET_ID]]);
});

// ===========================================================================
// PART 1 (removals) + the pre-flight simulation
// ===========================================================================
describe("reconciler follows policy_step_id, not the ordinal", () => {
  it("produces an instance whose step numbering really does diverge from the policy's", async () => {
    const instance = await makeInstance(DIVERGENT_POLICY, IDS.hotels.A3);
    const mapping = await stepMapping(instance.id);

    // Policy step 1 (USER → ghost) resolved to nobody and was dropped WITHOUT
    // consuming a step number. This is the precondition the whole file rests on.
    expect(mapping.map((m) => [m.instance_step_order, m.policy_step_order])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(mapping[0].approver_source_id).toBe(ROLE_B);
    expect(mapping[1].approver_source_id).toBe(ROLE_A);
  });

  it("marks the approver REMOVED on the step their revoked role actually backs", async () => {
    const instance = await makeInstance(DIVERGENT_POLICY, IDS.hotels.A3);
    expect(await approverStatusAt(instance.id, 1, TARGET_ID)).toBe("PENDING");

    // Revoke ROLE_B. It backs POLICY step 2, i.e. INSTANCE step 1.
    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      department_ids: [IDS.departments.proc],
      roles: rolesPayload([ROLE_A]),
      confirmed_approval_impact: true,
    });
    expect(res.status).toBe(200);

    // Ordinal matching looks up policy step 1 — the dropped USER step — and the
    // row disappears from discovery entirely, leaving the approver in place.
    expect(await approverStatusAt(instance.id, 1, TARGET_ID)).toBe("REMOVED");
  });

  it("removes them from that step ONLY, leaving the step backed by a role they still hold", async () => {
    const instance = await makeInstance(DIVERGENT_POLICY, IDS.hotels.A3);
    expect(await approverStatusAt(instance.id, 2, TARGET_ID)).toBe("PENDING");

    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      department_ids: [IDS.departments.proc],
      roles: rolesPayload([ROLE_A]),
      confirmed_approval_impact: true,
    });
    expect(res.status).toBe(200);

    // INSTANCE step 2 is POLICY step 3 (ROLE_A) — a role the user KEPT. Ordinal
    // matching resolves it against policy step 2 (ROLE_B) instead, finds the
    // user no longer holds ROLE_B, and removes them from the wrong step.
    expect(await approverStatusAt(instance.id, 2, TARGET_ID)).toBe("PENDING");
    expect(await approverStatusAt(instance.id, 1, TARGET_ID)).toBe("REMOVED");

    // The co-approver holds both roles throughout and must be untouched.
    expect(await approverStatusAt(instance.id, 1, CO_ID)).toBe("PENDING");
    expect(await approverStatusAt(instance.id, 2, CO_ID)).toBe("PENDING");
  });

  it("still reconciles via the ordinal when policy_step_id is NULL or points outside the policy", async () => {
    const nulled = await makeInstance(ALIGNED_POLICY, IDS.hotels.A2);
    const foreign = await makeInstance(ALIGNED_POLICY, IDS.hotels.A2);

    // A policy edit DELETEs and re-INSERTs every step row; `fk_instance_step_policy_step`
    // is ON DELETE SET NULL, so every surviving instance's link becomes NULL.
    // This is the ordinary state of any instance older than the last policy edit
    // and is exactly why the ordinal fallback has to stay.
    await db.none(`UPDATE tbl_approval_instance_steps SET policy_step_id = NULL WHERE approval_instance_id = $1`, [
      nulled.id,
    ]);

    // The other broken shape: a link that resolves, but to a step of a DIFFERENT
    // policy. Both steps are pointed at the divergent policy's ROLE_A step; if
    // that cross-policy link were followed, step 1 would resolve to ROLE_A — a
    // role the user KEEPS — and the revoked approver would survive.
    await db.none(`UPDATE tbl_approval_instance_steps SET policy_step_id = $2 WHERE approval_instance_id = $1`, [
      foreign.id,
      DIV_STEPS[2],
    ]);

    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      department_ids: [IDS.departments.proc],
      roles: rolesPayload([ROLE_A]),
      confirmed_approval_impact: true,
    });
    expect(res.status).toBe(200);

    for (const inst of [nulled, foreign]) {
      expect(await approverStatusAt(inst.id, 1, TARGET_ID)).toBe("REMOVED"); // ROLE_B step
      expect(await approverStatusAt(inst.id, 2, TARGET_ID)).toBe("PENDING"); // ROLE_A step
    }
  });

  it("warns about exactly the rows it then changes", async () => {
    const instance = await makeInstance(DIVERGENT_POLICY, IDS.hotels.A3);

    const client = await httpClient(ADMIN_ID);
    const payload = {
      user_id: TARGET_ID,
      department_ids: [IDS.departments.proc],
      roles: rolesPayload([ROLE_A]),
    };

    // Pre-flight: aborts the save and reports what it believes will happen.
    const preflight = await client.put("/api/v1/users/update-user-detail").send(payload);
    expect(preflight.status).toBe(200);
    expect(preflight.body.code).toBe("APPROVAL_IMPACT_WARNING");
    const warned = preflight.body.data.affectedInstances
      .filter((i) => i.instance_id === instance.id)
      .map((i) => i.step_order)
      .sort();

    // Nothing was applied yet.
    expect(await approverStatusAt(instance.id, 1, TARGET_ID)).toBe("PENDING");

    const applied = await client
      .put("/api/v1/users/update-user-detail")
      .send({ ...payload, confirmed_approval_impact: true });
    expect(applied.status).toBe(200);

    const removed = (
      await db.any(
        `SELECT ais.step_order
           FROM tbl_approval_step_approvers asa
           JOIN tbl_approval_instance_steps ais ON ais.id = asa.approval_instance_step_id
          WHERE ais.approval_instance_id = $1
            AND asa.approver_user_id = $2
            AND asa.status = 'REMOVED'
          ORDER BY ais.step_order`,
        [instance.id, TARGET_ID]
      )
    ).map((r) => r.step_order);

    // The simulation and the mutation must describe the same set of rows —
    // a warning that names step 2 while step 1 is what actually changes is the
    // failure mode this asserts against.
    expect(warned).toEqual([1]);
    expect(removed).toEqual(warned);
  });

  it("leaves an approver in place when the step's policy step cannot be resolved at all", async () => {
    const instance = await makeInstance(DIVERGENT_POLICY, IDS.hotels.A3);

    // A step beyond the end of the policy — no live policy step by id OR by
    // ordinal. Happens when a policy is shortened (or deleted) under a live
    // instance. There is nothing left to re-resolve against, so the reconciler
    // must fail CLOSED rather than guess.
    const orphan = await db.one(
      `INSERT INTO tbl_approval_instance_steps
         (approval_instance_id, policy_step_id, step_order, decision_rule, status)
       VALUES ($1, NULL, 9, 'ALL', 'PENDING') RETURNING id`,
      [instance.id]
    );
    await db.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
       VALUES ($1, $2, 'PENDING')`,
      [orphan.id, TARGET_ID]
    );

    // Deactivation disqualifies the user everywhere, so no source filter narrows
    // discovery — the orphan row genuinely reaches the reconciler.
    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      status: 0,
      confirmed_approval_impact: true,
    });
    expect(res.status).toBe(200);

    // Every resolvable step drops them...
    expect(await approverStatusAt(instance.id, 1, TARGET_ID)).toBe("REMOVED");
    expect(await approverStatusAt(instance.id, 2, TARGET_ID)).toBe("REMOVED");
    // ...and the unresolvable one is left alone rather than removed on a guess.
    expect(await approverStatusAt(instance.id, 9, TARGET_ID)).toBe("PENDING");
  });

  it("REPORTS the fail-closed skip instead of dropping the row silently", async () => {
    // NOTE: the DB outcome asserted above (orphan approver untouched) is the
    // same before and after the fix — a row an INNER-ised join never discovered
    // and a row we discover and then decline to touch look identical from the
    // outside. What changed is that the skip is now accounted for, so this test
    // asserts the accounting, which is the part that is genuinely differential.
    await withTx(async (t) => {
      const instance = await makeInstance(DIVERGENT_POLICY, IDS.hotels.A3, t);

      const orphan = await t.one(
        `INSERT INTO tbl_approval_instance_steps
           (approval_instance_id, policy_step_id, step_order, decision_rule, status)
         VALUES ($1, NULL, 9, 'ALL', 'PENDING') RETURNING id`,
        [instance.id]
      );
      await t.none(
        `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
         VALUES ($1, $2, 'PENDING')`,
        [orphan.id, TARGET_ID]
      );

      await t.none(`UPDATE tbl_users SET status = 0 WHERE id = $1`, [TARGET_ID]);

      const result = await revalidateApproverMembership({
        userId: TARGET_ID,
        changedBy: ADMIN_ID,
        changeType: "user_deactivated",
        txContext: t,
      });

      expect(result.unresolvedSteps.filter((s) => s.instance_id === instance.id)).toEqual([
        { instance_id: instance.id, step_id: orphan.id, step_order: 9, policy_step_id: null },
      ]);

      // And it really was a skip, not a removal.
      const orphanApprover = await t.one(
        `SELECT status FROM tbl_approval_step_approvers
          WHERE approval_instance_step_id = $1 AND approver_user_id = $2`,
        [orphan.id, TARGET_ID]
      );
      expect(orphanApprover.status).toBe("PENDING");
      expect(
        result.approversRemoved.filter((r) => r.instance_id === instance.id).map((r) => r.step_order).sort()
      ).toEqual([1, 2]);
    });
  });
});

// ===========================================================================
// PART 2 (additions)
// ===========================================================================
describe("the add path grants authority only on steps the role actually backs", () => {
  it("adds a newly granted role holder to that role's step, not the ordinal neighbour", async () => {
    // TARGET holds neither approver role when the instance is built, so both
    // ROLE steps resolve to the co-approver alone.
    await setUserRoles(TARGET_ID, [ROLE_FILLER]);
    const instance = await makeInstance(DIVERGENT_POLICY, IDS.hotels.A3);
    expect(await approverStatusAt(instance.id, 1, TARGET_ID)).toBeUndefined();
    expect(await approverStatusAt(instance.id, 2, TARGET_ID)).toBeUndefined();

    // Grant ROLE_B. It backs POLICY step 2 = INSTANCE step 1.
    const client = await httpClient(ADMIN_ID);
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: TARGET_ID,
      department_ids: [IDS.departments.proc],
      roles: rolesPayload([ROLE_FILLER, ROLE_B]),
    });
    expect(res.status).toBe(200);

    // The old add path joined `ais.step_order = ps.step_order`, so policy step 2
    // attached to INSTANCE step 2 — whose real source is ROLE_A — granting the
    // user approval authority on a step no role of theirs backs, while the step
    // ROLE_B does back never saw them at all.
    expect(await approverStatusAt(instance.id, 1, TARGET_ID)).toBe("PENDING");
    expect(await approverStatusAt(instance.id, 2, TARGET_ID)).toBeUndefined();
  });
});

// ===========================================================================
// The policy-diff path (applyDiffToInstance + the policy_step_id refresh)
//
// WHY THESE CALL THE PRODUCTION FUNCTIONS DIRECTLY INSTEAD OF POSTING THE EDIT:
// upsertApprovalPolicy runs `deletePolicySteps(id, t)` BEFORE propagation
// (generalController.js:694), and `fk_instance_step_policy_step` is ON DELETE
// SET NULL — so by the time applyDiffToInstance loads the instance steps, every
// `policy_step_id` on that instance is already NULL. Through the endpoint the
// matcher can therefore only ever take the ordinal path, where injectivity is
// free (one diff entry per step_order × UNIQUE (instance, step_order)).
//
// So be clear about what these two tests are: applyDiffToInstance and
// propagatePolicyChangeToInstances are EXPORTED functions, and the injectivity
// guard defends them against callers other than the single one that exists
// today. On that one live caller it is provably a no-op. It is ~25 lines with
// zero regression risk, which is the whole justification — there is no
// production state and no repo-buildable environment that reaches it. (The FK
// lives in tests/setup/schema.sql, a pg_dump of production, so every test DB has
// it; no file in migrations/ mentions policy_step_id at all.)
//
// These tests exist because the guard's behaviour should be pinned even so — an
// unexercised guard is a guess. The last test in this block pins the FK-nulling
// premise itself, since the "no-op on the live path" claim rests on it.
// ===========================================================================
describe("a policy edit maps diff entries onto instance steps injectively", () => {
  it("never lets a removal and a modification claim the same instance step", async () => {
    await withTx(async (t) => {
      const instance = await makeInstance(COLLISION_POLICY, IDS.hotels.A3, t);
      const steps = await t.any(
        `SELECT id, step_order, policy_step_id FROM tbl_approval_instance_steps
          WHERE approval_instance_id = $1 ORDER BY step_order ASC`,
        [instance.id]
      );
      expect(steps.map((s) => [s.step_order, s.policy_step_id])).toEqual([
        [1, COL_STEPS[1]], // policy step 2 (ROLE_B)
        [2, COL_STEPS[2]], // policy step 3 (ROLE_A)
        [3, COL_STEPS[3]], // policy step 4 (ROLE_B)
      ]);

      // The mix of live links and NULLs that propagatePolicyChangeToInstances
      // itself produces: it re-points only MODIFIED steps, so an instance ends
      // up holding some live links and some NULLed ones.
      await t.none(`UPDATE tbl_approval_instance_steps SET policy_step_id = NULL WHERE id = $1`, [steps[1].id]);

      // Drop policy step 4 and change policy step 3's source →
      // {STEP_MODIFIED@3, STEP_REMOVED@4}:
      //   REMOVED@4   id-matches  instance step 3 (link = policy step 4)
      //   MODIFIED@3  has no id-match (link NULLed) → ordinal → instance step 3
      // Both entries want the same row.
      const oldSteps = await snapshotPolicySteps(COLLISION_POLICY, t);
      const newSteps = [
        oldSteps[0],
        oldSteps[1],
        { ...oldSteps[2], approver_source_type: "USER", approver_source_id: CO_ID },
      ];
      const diff = computePolicyStepDiff(oldSteps, newSteps);
      expect(diff.map((d) => [d.type, d.step_order])).toEqual([
        ["STEP_MODIFIED", 3],
        ["STEP_REMOVED", 4],
      ]);

      const policyRow = await t.one(`SELECT * FROM tbl_approval_policies WHERE id = $1`, [COLLISION_POLICY]);
      const result = await applyDiffToInstance(instance, diff, policyRow, ADMIN_ID, t);

      const after = await t.any(
        `SELECT id, step_order, status FROM tbl_approval_instance_steps
          WHERE approval_instance_id = $1 ORDER BY step_order ASC`,
        [instance.id]
      );
      expect(after.find((s) => s.step_order === 3).status).toBe("REMOVED");

      // With a per-entry (rather than assignment) matcher, the removals loop
      // kills this step and the modifications loop then matches it AGAIN — the
      // removal by id, the modification by ordinal — reads a stale in-memory
      // status of 'PENDING', and INSERTs a live approver row onto a dead step.
      // getPendingApprovalsForUser filters on sa.status but not s.status, so that
      // row reads as a real pending approval and earns an "action required" email.
      const zombies = await t.any(
        `SELECT asa.approver_user_id, ais.step_order, ais.status AS step_status
           FROM tbl_approval_step_approvers asa
           JOIN tbl_approval_instance_steps ais ON ais.id = asa.approval_instance_step_id
          WHERE ais.approval_instance_id = $1
            AND asa.status = 'PENDING'
            AND ais.status <> 'PENDING'`,
        [instance.id]
      );
      expect(zombies).toEqual([]);

      // One claim per step also means no duplicated audit trail, and no
      // modification bookkeeping for a step the removal already took.
      const removedAudit = await t.any(
        `SELECT id FROM tbl_approval_actions WHERE approval_instance_id = $1 AND action = 'STEP_REMOVED'`,
        [instance.id]
      );
      expect(removedAudit).toHaveLength(1);
      expect(result.stepsModified).toEqual([]);
      expect(result.approversAdded).toEqual([]);

      // The modification found no step to apply to. That is a reconciliation
      // this instance did not receive, so it is reported rather than dropped —
      // same standard as PART 1's `unresolvedSteps`.
      expect(result.unmatchedDiffEntries).toEqual([
        { type: "STEP_MODIFIED", step_order: 3, policy_step_id: COL_STEPS[2] },
      ]);
    });
  });

  it("re-points policy_step_id onto the step it belongs to, not the ordinal-matching one", async () => {
    await withTx(async (t) => {
      const instance = await makeInstance(REFRESH_POLICY, IDS.hotels.A3, t);
      const before = await t.any(
        `SELECT step_order, policy_step_id FROM tbl_approval_instance_steps
          WHERE approval_instance_id = $1 ORDER BY step_order ASC`,
        [instance.id]
      );
      expect(before.map((s) => [s.step_order, s.policy_step_id])).toEqual([
        [1, REF_STEPS[1]], // policy step 2
        [2, REF_STEPS[2]], // policy step 3  ← the one being modified
        [3, REF_STEPS[3]], // policy step 4
      ]);

      // Stand-in for "the row insertPolicySteps just wrote for step_order 3".
      // Any live policy-step id satisfies the FK; a foreign one is used purely
      // because it is distinguishable from every link this instance already has.
      const MARKER = DIV_STEPS[2];
      const oldSteps = await snapshotPolicySteps(REFRESH_POLICY, t);
      const newSteps = oldSteps.map((s, i) =>
        i === 2 ? { ...s, id: MARKER, approver_source_type: "USER", approver_source_id: CO_ID } : s
      );
      const diff = computePolicyStepDiff(oldSteps, newSteps);
      expect(diff.map((d) => [d.type, d.step_order])).toEqual([["STEP_MODIFIED", 3]]);

      const policyRow = await t.one(`SELECT * FROM tbl_approval_policies WHERE id = $1`, [REFRESH_POLICY]);
      await propagatePolicyChangeToInstances({
        policyId: REFRESH_POLICY, diff, changedBy: ADMIN_ID, policy: policyRow, t,
      });

      const after = await t.any(
        `SELECT step_order, policy_step_id FROM tbl_approval_instance_steps
          WHERE approval_instance_id = $1 ORDER BY step_order ASC`,
        [instance.id]
      );
      const at = (order) => after.find((s) => s.step_order === order);

      // The old refresh was `UPDATE … WHERE step_order = <policy step_order>`, a
      // SECOND independent ordinal assumption: it wrote the new link onto
      // INSTANCE step 3 — which is policy step 4 — and left INSTANCE step 2, the
      // step actually being modified, untouched.
      expect(at(2).policy_step_id).toBe(MARKER);
      expect(at(3).policy_step_id).toBe(REF_STEPS[3]);
    });
  });

  it("clears every instance link before the diff is applied, so in-flow matching is ordinal", async () => {
    // The premise the two tests above rest on, pinned. If it ever stops holding
    // (FK dropped, or the controller stops deleting first) those tests describe
    // the live path rather than a guard — and this one says so by failing.
    const instance = await makeInstance(COLLISION_POLICY, IDS.hotels.A3);
    const before = await instanceStepsOf(instance.id);
    expect(before.every((s) => s.policy_step_id !== null)).toBe(true);

    const client = await httpClient(ADMIN_ID);
    const res = await editPolicy(client, COLLISION_POLICY, {
      hotelId: IDS.hotels.A3,
      departmentId: IDS.departments.proc,
      steps: [step(1, "USER", GHOST_ID), step(2, "ROLE", ROLE_B), step(3, "USER", CO_ID)],
    });
    expect(res.status).toBe(200);

    const after = await instanceStepsOf(instance.id);
    const newStep3 = await db.one(
      `SELECT id FROM tbl_approval_policy_steps WHERE approval_policy_id = $1 AND step_order = 3`,
      [COLLISION_POLICY]
    );

    // Every link is NULL except the single one propagation deliberately rewrote.
    expect(after.filter((s) => s.policy_step_id !== null).map((s) => s.policy_step_id)).toEqual([newStep3.id]);

    // ORDERING, pinned: the surviving link sits on the step the ORDINAL selects
    // (instance step 3), not the one the id-match would have selected (instance
    // step 2, which is genuinely policy step 3). That outcome is only reachable
    // if the links were ALREADY NULL when applyDiffToInstance loaded them —
    // i.e. deletePolicySteps ran before propagation. Reverse the order and this
    // flips to 2.
    expect(after.find((s) => s.policy_step_id === newStep3.id).step_order).toBe(3);

    // And the real flow still leaves no live approver row on a dead step.
    const zombies = await db.any(
      `SELECT asa.approver_user_id
         FROM tbl_approval_step_approvers asa
         JOIN tbl_approval_instance_steps ais ON ais.id = asa.approval_instance_step_id
        WHERE ais.approval_instance_id = $1 AND asa.status = 'PENDING' AND ais.status <> 'PENDING'`,
      [instance.id]
    );
    expect(zombies).toEqual([]);
  });
});
