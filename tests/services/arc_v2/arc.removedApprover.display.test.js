// ARC surfaces must never render a REMOVED approver as a live one.
//
// The mid-flight reconciler (approvalPropagationService) does not delete an
// approver whose authority is revoked — it soft-tombstones the row
// (status='REMOVED' + removed_at + removal_reason) so the audit survives. The
// governing rule for display surfaces: a surface with dedicated removed-approver
// UI gets the rows passed through and labels them; a surface without one
// excludes them. A REMOVED row must NEVER win a single-slot selection (a step's
// actor, current_approvers, a "waiting on" name) nor be counted in a total.
//
// This suite pins the two ARC surfaces that had no such UI:
//
//   1. GET /v1/arc-v2/:id/lifecycle  → stages[].actors.approver.people (the
//      stage aside's approver list + its "+N more" count) and
//      stages[].actors.contact (the surfaced "who to call" — name, email AND
//      MOBILE, on a tenant-guarded PII endpoint).
//   2. GET /v1/arc-v2/amendments     → approval_chain[].approver_user_ids /
//      approver_names, which drive ActiveStage's live-approver list and its
//      isCurrentApprover "your turn" affordance — and which are PERSISTED into
//      tbl_arc_amendment.approval_chain, so a stale name outlives the request.
//
// Tombstones are written directly in setup, exactly as the reconciler writes
// them (it only ever flips a PENDING row: `SET status='REMOVED', removed_at,
// removal_reason WHERE ... status='PENDING'`). Every assertion reads through
// the real HTTP endpoint.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { createApprovalInstance, getApprovalInstanceDetails } from "../../../app/models/generalModel.js";

const HC    = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT  = IDS.departments.proc;
const PROC  = IDS.processes.A_P1;
const CATEGORY = TEST_CATEGORIES.beverages;

const BUYER     = IDS.users.a1_proc_buyer;   // reads the lifecycle page
const GHOST     = IDS.users.a1_proc_commApp; // the approver who gets tombstoned
const SURVIVOR  = IDS.users.a1_proc_techApp; // the approver who stays live
const AMD_STEP1 = IDS.users.a1_proc_poApp;   // amendment step 1 (acts)
const AMD_GHOST = IDS.users.a1_proc_finance; // amendment step 2, tombstoned
const VENDOR    = IDS.users.vendor_alpha;

// Distinctive PII: if either string appears anywhere in a payload that should
// have excluded the tombstoned approver, we have leaked the wrong person's
// contact details — which is the failure that actually matters here.
const GHOST_MOBILE    = "+919000000111";
const SURVIVOR_MOBILE = "+919000000222";

const TECH_POLICY_ID = 64990;
const AMD_POLICY_ID  = 64991;

const stageOf = (body, key) => body.data.stages.find((s) => s.key === key);

const dIso = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Tombstone exactly the way the reconciler does. */
async function tombstone(instanceId, stepOrder, userId, reason = "role_membership_change") {
  const res = await db.result(
    `UPDATE tbl_approval_step_approvers sa
        SET status = 'REMOVED', removed_at = NOW(), removal_reason = $4
       FROM tbl_approval_instance_steps s
      WHERE sa.approval_instance_step_id = s.id
        AND s.approval_instance_id = $1
        AND s.step_order = $2
        AND sa.approver_user_id = $3
        AND sa.status = 'PENDING'`,
    [instanceId, stepOrder, userId, reason]
  );
  expect(res.rowCount).toBe(1); // setup must actually have tombstoned something
}

describe("ARC — REMOVED approvers never render as live approvers", () => {
  let buyerClient, vendorClient, step1Client;
  let mixedArcId, mixedInstanceId;     // step has 1 tombstone + 1 live approver
  let strandedArcId, strandedInstanceId; // step's ONLY approver is tombstoned
  let contractId, lineId, amendmentId, amdInstanceId, amdArcId;
  const arcIds = [];

  async function seedTechArc(number, title) {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          payment_terms_expected, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'tech_eval_in_progress',
               NOW() - INTERVAL '20 days', NOW() - INTERVAL '2 days',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               'Net 30', $8) RETURNING *`,
      [number, title, CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcIds.push(arc.id);
    // One item with a configured clause, so the technical stage is neither
    // skipped nor locked and therefore carries an approver block.
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, 1, 500, 'litre', 100) RETURNING *`, [arc.id]);
    const te = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING *`, [item.id]);
    await db.none(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1, 'ISO certification on file', 10, 'compliance')`, [te.id]);

    const engine = await createApprovalInstance({
      entity_type: "ARC_TECH",
      entity_id: arc.id,
      hospitality_company_id: HC,
      hotel_id: HOTEL,
      department_id: DEPT,
      process_id: PROC,
      approval_policy_id: TECH_POLICY_ID,
      initiated_by: BUYER,
      metadata: {},
    });
    return { arcId: arc.id, instanceId: engine.instance.id };
  }

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id IN ($1,$2,$3,$4,$5)`,
      [BUYER, GHOST, SURVIVOR, AMD_STEP1, AMD_GHOST]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [VENDOR]);
    await db.none(`UPDATE tbl_users SET mobile = $2 WHERE id = $1`, [GHOST, GHOST_MOBILE]);
    await db.none(`UPDATE tbl_users SET mobile = $2 WHERE id = $1`, [SURVIVOR, SURVIVOR_MOBILE]);

    buyerClient  = await httpClient(BUYER);
    vendorClient = await httpClient(VENDOR);
    step1Client  = await httpClient(AMD_STEP1);

    // ARC_TECH policy: ONE step, GHOST as the policy-resolved approver. Being
    // resolved from the policy, GHOST's approver row gets the LOWEST id on the
    // step — so any surviving `people[0]` fallback would pick the tombstone.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_TECH', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [TECH_POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [TECH_POLICY_ID, GHOST]
    );

    // (a) mixed step: GHOST tombstoned, SURVIVOR added alongside and left PENDING.
    ({ arcId: mixedArcId, instanceId: mixedInstanceId } =
      await seedTechArc("ARC-TEST-RMV-1", "Removed approver — mixed step"));
    await db.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
       SELECT id, $2, 'PENDING' FROM tbl_approval_instance_steps
        WHERE approval_instance_id = $1 AND step_order = 1`,
      [mixedInstanceId, SURVIVOR]
    );
    await tombstone(mixedInstanceId, 1, GHOST);

    // (b) stranded step: the ONLY approver is tombstoned.
    ({ arcId: strandedArcId, instanceId: strandedInstanceId } =
      await seedTechArc("ARC-TEST-RMV-2", "Removed approver — stranded step"));
    await tombstone(strandedInstanceId, 1, GHOST, "user_deactivated");

    // ── amendment fixture: active ARC + contract + 2-step ARC_AMENDMENT policy
    const amdArc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by)
       VALUES ('ARC-TEST-RMV-3', 'Removed approver — amendment', $1, $2, $3, $4, $5,
               'contract_active',
               NOW() - INTERVAL '40 days', NOW() - INTERVAL '30 days',
               NOW() - INTERVAL '20 days', (NOW() + INTERVAL '180 days')::date,
               $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    amdArcId = amdArc.id;
    arcIds.push(amdArcId);
    const amdItem = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, 1, 500, 'litre') RETURNING *`, [amdArcId]);
    const contract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status)
       VALUES ($1, $2, 'active') RETURNING *`, [amdArcId, VENDOR]);
    contractId = contract.id;
    lineId = (await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 100, 5, 500) RETURNING id`, [contractId, amdItem.id])).id;

    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_AMENDMENT', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [AMD_POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2), ($1, 2, 'ALL', 'USER', $3)`,
      [AMD_POLICY_ID, AMD_STEP1, AMD_GHOST]
    );
  });

  afterAll(async () => {
    const instanceIds = [mixedInstanceId, strandedInstanceId, amdInstanceId].filter(Boolean);
    await db.none(`DELETE FROM tbl_arc_amendment_edit_history
                    WHERE arc_amendment_id IN (SELECT id FROM tbl_arc_amendment WHERE arc_contract_id = $1)`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_amendment_document
                    WHERE arc_amendment_id IN (SELECT id FROM tbl_arc_amendment WHERE arc_contract_id = $1)`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_amendment WHERE arc_contract_id = $1`, [contractId]);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers
                      WHERE approval_instance_step_id IN
                        (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [[TECH_POLICY_ID, AMD_POLICY_ID]]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [[TECH_POLICY_ID, AMD_POLICY_ID]]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_clauses
                    WHERE arc_item_tech_evaluation_id IN
                      (SELECT te.id FROM tbl_arc_item_tech_evaluation te
                         JOIN tbl_arc_item i ON i.id = te.arc_item_id
                        WHERE i.arc_id = ANY($1::bigint[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_item_tech_evaluation
                    WHERE arc_item_id IN (SELECT id FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`UPDATE tbl_users SET mobile = NULL WHERE id = ANY($1::int[])`, [[GHOST, SURVIVOR]]);
  });

  // ── 1. lifecycle stage aside ───────────────────────────────────────────
  test("lifecycle current-approver list excludes the tombstone and counts only live approvers", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/${mixedArcId}/lifecycle`);
    expect(res.status).toBe(200);

    const approver = stageOf(res.body, "technical").actors.approver;
    expect(approver.status).toBe("PENDING");
    // Exactly one live approver — not two. The aside renders this array as the
    // approver list and derives its "+N more" count from its length.
    expect(approver.people.map((p) => p.user_id)).toEqual([SURVIVOR]);
    expect(approver.people.some((p) => p.status === "REMOVED")).toBe(false);
    expect(approver.unassigned).toBe(false);
    // Step metadata is unaffected by the exclusion.
    expect(approver.step_label).toMatch(/Level 1 of 1/);
  });

  test("lifecycle contact is the live approver, and never leaks the removed approver's mobile", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/${mixedArcId}/lifecycle`);
    const technical = stageOf(res.body, "technical");

    expect(technical.actors.contact).not.toBeNull();
    expect(technical.actors.contact.mobile).toBe(SURVIVOR_MOBILE);
    // `plus` counts the OTHER live approvers; a tombstone must not inflate it.
    expect(technical.actors.contact.plus).toBeUndefined();
    expect(JSON.stringify(technical)).not.toContain(GHOST_MOBILE);
  });

  test("when every approver on the step is removed, the endpoint surfaces nobody rather than the wrong person", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/${strandedArcId}/lifecycle`);
    expect(res.status).toBe(200);
    const technical = stageOf(res.body, "technical");

    // No live approver remains — say so, instead of presenting a tombstone.
    expect(technical.actors.approver.status).toBe("PENDING");
    expect(technical.actors.approver.people).toEqual([]);
    expect(technical.actors.approver.unassigned).toBe(true);
    // Step metadata survives the empty approver set (the LEFT JOIN keeps the
    // step row), so the label does not degrade to a placeholder.
    expect(technical.actors.approver.step_label).toMatch(/Level 1 of 1/);

    // THE POINT: the removed approver must not become the "who to call"
    // contact. Whatever the contact ends up being (null, or the stage's
    // evaluator), it is never the tombstoned person.
    const contact = technical.actors.contact;
    if (contact) expect(contact.mobile).not.toBe(GHOST_MOBILE);
    expect(JSON.stringify(technical)).not.toContain(GHOST_MOBILE);
  });

  test("the tombstone is still visible to the engine's own audit view — this is a display filter, not data loss", async () => {
    const details = await getApprovalInstanceDetails(strandedInstanceId, BUYER);
    const approvers = details.steps.flatMap((s) => s.approvers);
    const ghost = approvers.find((a) => Number(a.user_id) === GHOST);
    expect(ghost).toBeDefined();
    expect(ghost.status).toBe("REMOVED");
    expect(ghost.removal_reason).toBe("user_deactivated");
    expect(ghost.removed_at).toBeTruthy();
  });

  // ── 2. amendment approval chain ────────────────────────────────────────
  test("vendor requests an amendment; the cached chain starts out naming the (still live) step-2 approver", async () => {
    const res = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId,
      amendment_type: "price",
      amendment_from: dIso(1),
      amendment_to: dIso(90),
      reason: "Input cost pass-through",
      payload: { arc_contract_line_id: lineId, new_rate: 120 },
    });
    expect(res.status).toBe(200);
    amendmentId = res.body.data.amendment.id;

    const row = await db.one(`SELECT approval_instance_id, approval_chain FROM tbl_arc_amendment WHERE id = $1`, [amendmentId]);
    amdInstanceId = row.approval_instance_id;
    const step2 = row.approval_chain.find((s) => s.step === 2);
    // Pre-condition for the next two tests: this is the stale cache we must fix.
    expect(step2.approver_user_ids.map(Number)).toContain(AMD_GHOST);
  });

  test("a chain cached BEFORE the removal is reconciled on read — the removed approver is gone from the buyer listing", async () => {
    await tombstone(amdInstanceId, 2, AMD_GHOST, "role_membership_change");

    const res = await buyerClient.get(`/api/v1/arc-v2/amendments?arc_id=${amdArcId}`);
    expect(res.status).toBe(200);
    const amendment = res.body.data.amendments.find((a) => Number(a.id) === Number(amendmentId));
    const step2 = amendment.approval_chain.find((s) => s.step === 2);

    expect(step2.approver_user_ids.map(Number)).not.toContain(AMD_GHOST);
    expect(step2.approver_names).toEqual([]);
    // The stored cache is genuinely still stale — this is a read-time
    // reconciliation, and the engine remains the source of truth.
    const stored = await db.one(`SELECT approval_chain FROM tbl_arc_amendment WHERE id = $1`, [amendmentId]);
    expect(stored.approval_chain.find((s) => s.step === 2).approver_user_ids.map(Number)).toContain(AMD_GHOST);
  });

  test("the next engine touch rewrites the cache without the removed approver, keeping the live one", async () => {
    // A replacement approver joins step 2 while the amendment is in flight.
    await db.none(
      `INSERT INTO tbl_approval_step_approvers
         (approval_instance_step_id, approver_user_id, status, added_mid_flight)
       SELECT id, $2, 'PENDING', true FROM tbl_approval_instance_steps
        WHERE approval_instance_id = $1 AND step_order = 2`,
      [amdInstanceId, SURVIVOR]
    );

    // Step 1's approver acts → refreshChainCache recomputes the whole chain.
    const res = await step1Client
      .post(`/api/v1/arc-v2/amendments/${amendmentId}/review`)
      .send({ decision: "approve", comment: "ok from step 1" });
    expect(res.status).toBe(200);

    const stored = await db.one(`SELECT approval_chain FROM tbl_arc_amendment WHERE id = $1`, [amendmentId]);
    const step2 = stored.approval_chain.find((s) => s.step === 2);
    expect(step2.approver_user_ids.map(Number)).toEqual([SURVIVOR]);
    expect(step2.approver_names.length).toBe(1);
    expect(JSON.stringify(stored.approval_chain)).not.toContain(String(AMD_GHOST));

    // And the buyer listing agrees.
    const listed = await buyerClient.get(`/api/v1/arc-v2/amendments?arc_id=${amdArcId}`);
    const amendment = listed.body.data.amendments.find((a) => Number(a.id) === Number(amendmentId));
    expect(amendment.approval_chain.find((s) => s.step === 2).approver_user_ids.map(Number)).toEqual([SURVIVOR]);
  });

  test("the removed approver is still refused by the engine if they try to act", async () => {
    const ghostClient = await httpClient(AMD_GHOST);
    const res = await ghostClient
      .post(`/api/v1/arc-v2/amendments/${amendmentId}/review`)
      .send({ decision: "approve", comment: "should not be allowed" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
