// ARC lifecycle — GET /v1/arc-v2/:id/lifecycle state machine.
//
// Walks ONE ARC through the entire journey and pins stages[].state/reason +
// default_stage at every point, plus two special-case ARCs (technical
// skipped, contract ended) and the per-caller permissions block:
//   1. window open      → overview active, everything else locked.
//   2. window passed    → GET lazily flips floated→submission_closed (DB!),
//                         overview complete, technical active, default technical.
//   3. one vendor fully scored → technical partial, commercial unlocks.
//   4. submit           → ARC_TECH instance spawned via the engine;
//                         can_user_approve true ONLY for the approver.
//   5. approve          → technical complete (immutable), default commercial.
//   6. all items allocated → commercial partial, awarding opens as preview.
//   7. finalize         → ARC_COMMITTEE instance spawned, commercial complete,
//                         awarding committee_in_review, default awarding.
//   8. committee approve → awarding complete, active stage live, default active.
//   9. skipped ARC      → zero clauses ⇒ technical skipped, commercial active.
//  10. ended ARC        → terminated ⇒ active stage ended, default active.
//  11. permissions      → empty for an unscoped buyer; reflects seeded
//                         role scopes (arc-tech.read) for a reader user.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";

const HC     = IDS.hospitality.A;
const HOTEL  = IDS.hotels.A1;
const DEPT   = IDS.departments.proc;
const PROC   = IDS.processes.A_P1;
const BUYER  = IDS.users.a1_proc_buyer;
const TECH_APPROVER = IDS.users.a1_proc_techApp;
const COMMITTEE_APPROVER = IDS.users.a1_proc_finance;
const READER = IDS.users.a1_eng_buyer; // gets a seeded arc-tech.read scope
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const CATEGORY = TEST_CATEGORIES.beverages;

const TECH_POLICY_ID      = 64910;
const COMMITTEE_POLICY_ID = 64911;
// Permission/role/scope fixtures (test seed lacks the arc-tech.read rows).
const PERM_TECH_READ_ID = 95001;
const READER_ROLE_ID    = 95001;
const READER_SCOPE_ID   = 95001;

const stageOf = (body, key) => body.data.stages.find((s) => s.key === key);

describe("ARC lifecycle — stage state machine end-to-end", () => {
  let buyerClient, techApproverClient, committeeApproverClient, readerClient;
  let arcId, skipArcId, endedArcId;
  let itemIds = [], clauseIds = [], responseIdsA = [], responseIdsB = [];

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id IN ($1,$2,$3,$4)`,
      [BUYER, TECH_APPROVER, COMMITTEE_APPROVER, READER]);
    buyerClient = await httpClient(BUYER);
    techApproverClient = await httpClient(TECH_APPROVER);
    committeeApproverClient = await httpClient(COMMITTEE_APPROVER);
    readerClient = await httpClient(READER);
    // BUYER drives the gated evaluation endpoints (requireArcPermission).
    await seedArcEvalPerms(db, [BUYER]);

    // Policies: 1-step ARC_TECH (tech approver), 1-step ARC_COMMITTEE (finance).
    for (const [pid, entity, approver] of [
      [TECH_POLICY_ID, 'ARC_TECH', TECH_APPROVER],
      [COMMITTEE_POLICY_ID, 'ARC_COMMITTEE', COMMITTEE_APPROVER],
    ]) {
      await db.none(
        `INSERT INTO tbl_approval_policies
           (id, entity_type, hospitality_company_id, hotel_id, department_id,
            is_active, created_by, process_id, is_master, is_department_scoped, version)
         VALUES ($1, $2, $3, $4, NULL, true, $5, $6, false, false, 1)
         ON CONFLICT (id) DO NOTHING`,
        [pid, entity, HC, HOTEL, BUYER, PROC]
      );
      await db.none(
        `INSERT INTO tbl_approval_policy_steps
           (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
         VALUES ($1, 1, 'ALL', 'USER', $2)`,
        [pid, approver]
      );
    }

    // Journey ARC: floated, window still open, 2 items, both vendors quoted,
    // clauses configured on both items, responses recorded for both vendors.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          payment_terms_expected, created_by)
       VALUES ('ARC-TEST-LC-J', 'Lifecycle journey', $1, $2, $3, $4, $5, 'floated',
               NOW() - INTERVAL '7 days', NOW() + INTERVAL '2 days',
               NOW() + INTERVAL '10 days', NOW() + INTERVAL '180 days',
               'Net 30', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    await db.none(`INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1,$2,'invited'), ($1,$3,'invited')`,
      [arcId, VENDOR_A, VENDOR_B]);

    for (const [variant, qty] of [[1, 1000], [2, 500]]) {
      const item = await db.one(
        `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
         VALUES ($1, $2, $3, 'litre', 100) RETURNING *`, [arcId, variant, qty]);
      itemIds.push(Number(item.id));
      const te = await db.one(
        `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
         VALUES ($1, 60) RETURNING *`, [item.id]);
      const clause = await db.one(
        `INSERT INTO tbl_arc_item_tech_evaluation_clauses
           (arc_item_tech_evaluation_id, clause_text, weightage, clause_type)
         VALUES ($1, 'ISO certification on file', 10, 'compliance') RETURNING *`, [te.id]);
      clauseIds.push(Number(clause.id));
      for (const [vendor, bucket] of [[VENDOR_A, responseIdsA], [VENDOR_B, responseIdsB]]) {
        const resp = await db.one(
          `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
             (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response)
           VALUES ($1, $2, 'Attached') RETURNING *`, [clause.id, vendor]);
        bucket.push(Number(resp.id));
      }
      // Quotes for the commercial stage later.
      for (const [vendor, rate] of [[VENDOR_A, 90], [VENDOR_B, 95]]) {
        const q = await db.one(
          `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at)
           VALUES ($1, $2, NOW()) ON CONFLICT (arc_id, vendor_id) DO UPDATE SET updated_at = NOW()
           RETURNING *`, [arcId, vendor]);
        await db.none(
          `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
           VALUES ($1, $2, $3, 5) ON CONFLICT (arc_quote_id, arc_item_id) DO NOTHING`,
          [q.id, item.id, rate]);
      }
    }

    // Skip ARC: window closed, items but ZERO clauses.
    skipArcId = (await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-LC-S', 'Lifecycle skip', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '10 days', NOW() + INTERVAL '180 days', $6) RETURNING id`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    )).id;
    await db.none(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, 3, 100, 'kg')`, [skipArcId]);

    // Ended ARC.
    endedArcId = (await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-LC-E', 'Lifecycle ended', $1, $2, $3, $4, $5, 'terminated',
               NOW() - INTERVAL '200 days', NOW() - INTERVAL '190 days',
               NOW() - INTERVAL '180 days', NOW() - INTERVAL '10 days', $6) RETURNING id`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    )).id;

    // Reader fixtures: a custom role holding arc-tech.read, scoped to A1.
    await db.none(
      `INSERT INTO tbl_permissions (id, resource, action, ordering)
       VALUES ($1, 'arc-tech', 'read', 0) ON CONFLICT (id) DO NOTHING`,
      [PERM_TECH_READ_ID]);
    await db.none(
      `INSERT INTO tbl_roles (id, title, description, created_by)
       VALUES ($1, 'LC Test Tech Reader', 'lifecycle test fixture', NULL)
       ON CONFLICT (id) DO NOTHING`, [READER_ROLE_ID]);
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, $2 WHERE NOT EXISTS
         (SELECT 1 FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2)`,
      [READER_ROLE_ID, PERM_TECH_READ_ID]);
    await db.none(
      `INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (id) DO NOTHING`,
      [READER_SCOPE_ID, READER, READER_ROLE_ID, HC, HOTEL]);
  });

  afterAll(async () => {
    const arcIds = [arcId, skipArcId, endedArcId];
    const instanceIds = (await db.any(
      `SELECT id FROM tbl_approval_instances
        WHERE entity_type IN ('ARC_TECH','ARC_COMMITTEE') AND entity_id = ANY($1::bigint[])`,
      [arcIds]
    )).map((r) => r.id);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers
                      WHERE approval_instance_step_id IN
                        (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    for (const pid of [TECH_POLICY_ID, COMMITTEE_POLICY_ID]) {
      await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [pid]);
      await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [pid]);
    }
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [READER_SCOPE_ID]);
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [READER_ROLE_ID]);
    await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [READER_ROLE_ID]);
    await db.none(`DELETE FROM tbl_permissions WHERE id = $1`, [PERM_TECH_READ_ID]);
    await cleanupArcEvalPerms(db, [BUYER]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [arcIds]);
  });

  test("1. window open: overview active, everything downstream locked", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(res.status).toBe(200);
    expect(stageOf(res.body, "overview")).toMatchObject({ state: "active", reason: "window_open" });
    expect(stageOf(res.body, "technical")).toMatchObject({ state: "locked", reason: "window_open" });
    expect(stageOf(res.body, "commercial")).toMatchObject({ state: "locked" });
    expect(stageOf(res.body, "awarding")).toMatchObject({ state: "locked" });
    expect(stageOf(res.body, "active")).toMatchObject({ state: "locked" });
    expect(res.body.data.default_stage).toBe("overview");
    expect(stageOf(res.body, "overview").counts.invited).toBe(2);
    expect(stageOf(res.body, "overview").counts.submitted).toBe(2);
  });

  test("2. window passed: GET lazily flips status and technical activates", async () => {
    await db.none(`UPDATE tbl_arc SET submission_end_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [arcId]);
    const res = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(res.status).toBe(200);
    // Lazy flip persisted + event logged.
    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("submission_closed");
    const ev = await db.oneOrNone(
      `SELECT 1 FROM tbl_arc_event_log WHERE arc_id = $1 AND event_type = 'submission_closed'`, [arcId]);
    expect(ev).toBeTruthy();

    expect(stageOf(res.body, "overview")).toMatchObject({ state: "complete", reason: "window_closed" });
    expect(stageOf(res.body, "technical")).toMatchObject({ state: "active", reason: "scoring_in_progress" });
    expect(res.body.data.default_stage).toBe("technical");
  });

  test("3. one vendor fully scored across all items → technical partial, commercial unlocks", async () => {
    for (const responseId of responseIdsA) {
      const r = await buyerClient.post(`/api/v1/arc-v2/evaluation/tech-eval/score`).send({
        response_id: responseId, buyer_marks: 8, buyer_remark: "ok",
      });
      expect(r.status).toBe(200);
    }
    const res = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    const tech = stageOf(res.body, "technical");
    expect(tech.state).toBe("partial");
    expect(tech.reason).toBe("scoring_partial");
    expect(tech.counts.vendors_fully_scored).toBe(1);
    expect(stageOf(res.body, "commercial")).toMatchObject({ state: "active", reason: "not_started" });
    expect(res.body.data.default_stage).toBe("commercial");
  });

  test("4. submit spawns the ARC_TECH instance; can_user_approve is per-caller", async () => {
    // Score vendor B too so the submitted record is complete.
    for (const responseId of responseIdsB) {
      await buyerClient.post(`/api/v1/arc-v2/evaluation/tech-eval/score`).send({
        response_id: responseId, buyer_marks: 4, buyer_remark: "weak",
      });
    }
    const submit = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/submit`).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.approval_instance_id).toBeTruthy();

    // Instance stamped onto the tech evals.
    const stamped = await db.any(
      `SELECT te.approval_instance_id
         FROM tbl_arc_item_tech_evaluation te
         JOIN tbl_arc_item i ON i.id = te.arc_item_id
        WHERE i.arc_id = $1`, [arcId]);
    expect(stamped.every((r) => Number(r.approval_instance_id) === Number(submit.body.data.approval_instance_id))).toBe(true);

    const asBuyer = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    const tech = stageOf(asBuyer.body, "technical");
    expect(tech.state).toBe("partial");
    expect(tech.reason).toBe("awaiting_approval");
    expect(tech.approval.status).toBe("PENDING");
    expect(tech.approval.can_user_approve).toBe(false);

    const asApprover = await techApproverClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(stageOf(asApprover.body, "technical").approval.can_user_approve).toBe(true);

    // Re-submit while pending is blocked.
    const again = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/submit`).send({});
    expect(again.status).toBe(400);
  });

  test("5. approval completes technical (immutable) and defaults to commercial", async () => {
    const decide = await techApproverClient
      .post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/decide`)
      .send({ decision: "approve", comment: "Looks clean" });
    expect(decide.status).toBe(200);
    expect(decide.body.data.approval.status).toBe("APPROVED");

    const arcRow = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arcRow.status).toBe("tech_eval_approved");

    const res = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(stageOf(res.body, "technical")).toMatchObject({ state: "complete", reason: "approved" });
    expect(res.body.data.default_stage).toBe("commercial");
  });

  test("6. all items allocated → commercial partial, awarding opens as preview", async () => {
    const quoteLines = await db.any(
      `SELECT ql.id, ql.arc_item_id, q.vendor_id
         FROM tbl_arc_quote_line ql JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
        WHERE q.arc_id = $1 AND q.vendor_id = $2`, [arcId, VENDOR_A]);
    const items = await db.any(`SELECT id, indicative_qty FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
    for (const item of items) {
      const ql = quoteLines.find((l) => Number(l.arc_item_id) === Number(item.id));
      const r = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
        item_id: item.id,
        allocations: [{
          awarded_vendor_id: VENDOR_A, awarded_quote_line_id: ql.id,
          allocated_qty: Number(item.indicative_qty), l_rank: 'L1', is_l1_default: true,
          awarded_quote_snapshot: { rate: 90, gst_pct: 5 },
        }],
      });
      expect(r.status).toBe(200);
    }
    const res = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(stageOf(res.body, "commercial")).toMatchObject({ state: "partial", reason: "awaiting_finalize" });
    expect(stageOf(res.body, "commercial").counts).toMatchObject({ items_total: 2, items_allocated: 2 });
    expect(stageOf(res.body, "awarding")).toMatchObject({ state: "active", reason: "preview" });
  });

  test("7. finalize completes commercial and puts awarding in committee review", async () => {
    const fin = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/finalize`).send({});
    expect(fin.status).toBe(200);
    const res = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(stageOf(res.body, "commercial")).toMatchObject({ state: "complete", reason: "finalized" });
    const awarding = stageOf(res.body, "awarding");
    expect(awarding).toMatchObject({ state: "active", reason: "committee_in_review" });
    expect(awarding.approval.status).toBe("PENDING");
    expect(res.body.data.default_stage).toBe("awarding");

    const asCommittee = await committeeApproverClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(stageOf(asCommittee.body, "awarding").approval.can_user_approve).toBe(true);
  });

  test("8. committee approval completes awarding and activates the contract stage", async () => {
    const decide = await committeeApproverClient
      .post(`/api/v1/arc-v2/committee/${arcId}/decide`)
      .send({ decision: "approve", comment: "Award confirmed" });
    expect(decide.status).toBe(200);

    const res = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(stageOf(res.body, "awarding")).toMatchObject({ state: "complete", reason: "contracts_generated" });
    expect(stageOf(res.body, "active")).toMatchObject({ state: "active", reason: "awaiting_vendor_acceptance" });
    expect(stageOf(res.body, "active").counts.contracts_total).toBe(1);
    expect(res.body.data.default_stage).toBe("active");
  });

  test("9. zero clauses → technical skipped, commercial opens directly", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/${skipArcId}/lifecycle`);
    expect(stageOf(res.body, "technical")).toMatchObject({ state: "skipped", reason: "no_clauses_configured" });
    expect(stageOf(res.body, "commercial")).toMatchObject({ state: "active" });
    expect(res.body.data.default_stage).toBe("commercial");
  });

  test("10. terminated ARC → active stage ended and is the default", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/${endedArcId}/lifecycle`);
    expect(stageOf(res.body, "active")).toMatchObject({ state: "ended", reason: "terminated" });
    expect(res.body.data.default_stage).toBe("active");
  });

  test("11. permissions block reflects the caller's role scopes for THIS ARC's hotel", async () => {
    // Buyer holds the seeded evaluation role at this hotel.
    const asBuyer = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    const bp = asBuyer.body.data.permissions;
    expect([...bp['arc-tech']].sort()).toEqual(['evaluate', 'read']);
    expect([...bp['arc-comm']].sort()).toEqual(['evaluate', 'read']);
    expect(bp['arc-committee']).toEqual([]);
    // Tech approver has NO ARC module roles → all empty (decide stays
    // engine-gated, so approvers don't need any).
    const asTechApprover = await techApproverClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(asTechApprover.body.data.permissions).toEqual({
      'arc': [], 'arc-tech': [], 'arc-comm': [], 'arc-committee': [],
    });
    // Reader holds arc-tech.read at this hotel.
    const asReader = await readerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(asReader.body.data.permissions['arc-tech']).toContain('read');
    expect(asReader.body.data.permissions['arc-comm']).toEqual([]);
  });

  test("12. evaluation endpoints enforce module permissions server-side", async () => {
    // Reader holds arc-tech.read → may VIEW the tech matrix but not write.
    const readOk = await readerClient.get(`/api/v1/arc-v2/evaluation/items/${itemIds[0]}/tech-eval`);
    expect(readOk.status).toBe(200);
    const writeDenied = await readerClient
      .post(`/api/v1/arc-v2/evaluation/tech-eval/score`)
      .send({ response_id: responseIdsA[0], buyer_marks: 9 });
    expect(writeDenied.status).toBe(403);
    // No arc-comm key at all → even the comm-eval read is denied.
    const commDenied = await readerClient.get(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval`);
    expect(commDenied.status).toBe(403);
    // Tech approver has no module roles whatsoever → tech read denied too.
    const approverDenied = await techApproverClient.get(`/api/v1/arc-v2/evaluation/items/${itemIds[0]}/tech-eval`);
    expect(approverDenied.status).toBe(403);
  });
});
