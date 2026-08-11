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
import { ensureArcApprovable } from "../../helpers/arcApproverPerms.js";

const HC     = IDS.hospitality.A;
const HOTEL  = IDS.hotels.A1;
const DEPT   = IDS.departments.proc;
const PROC   = IDS.processes.A_P1;
const BUYER  = IDS.users.a1_proc_buyer;
const TECH_APPROVER = IDS.users.a1_proc_techApp;
const COMMITTEE_APPROVER = IDS.users.a1_proc_finance;
const READER = IDS.users.a1_eng_buyer; // gets a seeded arc-tech.read scope
// Cross-tenant user: mapped only to Hospitality B (hotels B1/B2), never to A1.
const CROSS_TENANT = IDS.users.companyB_admin;
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
  let buyerClient, techApproverClient, committeeApproverClient, readerClient, crossTenantClient;
  let arcId, skipArcId, endedArcId;
  let itemIds = [], clauseIds = [], responseIdsA = [], responseIdsB = [];

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id IN ($1,$2,$3,$4,$5)`,
      [BUYER, TECH_APPROVER, COMMITTEE_APPROVER, READER, CROSS_TENANT]);
    // Seed mobile for TECH_APPROVER so contact.mobile is non-null in actors payload.
    await db.none(`UPDATE tbl_users SET mobile = $1 WHERE id = $2`, ['+919812345678', TECH_APPROVER]);
    buyerClient = await httpClient(BUYER);
    techApproverClient = await httpClient(TECH_APPROVER);
    committeeApproverClient = await httpClient(COMMITTEE_APPROVER);
    readerClient = await httpClient(READER);
    crossTenantClient = await httpClient(CROSS_TENANT);
    // BUYER drives the gated evaluation endpoints (requireArcPermission).
    await seedArcEvalPerms(db, [BUYER]);

    // Policies: 1-step ARC_TECH (tech approver), 1-step ARC_COMMITTEE (finance).
    // The 4th element is the resource the entity_type maps to. USER-source
    // steps are permission-gated, so each named approver must hold read+approve
    // on exactly that resource — and only that one, so test 11 can still assert
    // an exact permissions payload rather than a blanket ARC grant.
    for (const [pid, entity, approver, resource] of [
      [TECH_POLICY_ID, 'ARC_TECH', TECH_APPROVER, 'arc-tech'],
      [COMMITTEE_POLICY_ID, 'ARC_COMMITTEE', COMMITTEE_APPROVER, 'arc-committee'],
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
      await ensureArcApprovable(db, [approver], HC, null, [resource]);
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
    // Reset seeded mobile on TECH_APPROVER.
    await db.none(`UPDATE tbl_users SET mobile = NULL WHERE id = $1`, [TECH_APPROVER]);
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

    // NEW: actors/flow — locked stage (commercial still locked at this point).
    const commercial1 = stageOf(res.body, "commercial");
    expect(commercial1.flow).toBeDefined();
    expect(commercial1.flow.next_stage).toBe("awarding");
    expect(commercial1.flow.action_taker_role).toBe("Commercial evaluator");
    expect(commercial1.actors).toBeDefined();
    expect(commercial1.actors.contact).toBeNull();
    // Technical locked: flow present, no contact
    const technical1 = stageOf(res.body, "technical");
    expect(technical1.flow).toBeDefined();
    expect(technical1.flow.next_stage).toBe("commercial");
    expect(technical1.actors.contact).toBeNull();
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

  test("3. scoring alone leaves technical partial — commercial stays LOCKED until approval", async () => {
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
    // Qualification is provisional until the tech approval ratifies it —
    // commercial must not open, and writes against it must 409.
    expect(stageOf(res.body, "commercial")).toMatchObject({ state: "locked", reason: "technical_incomplete" });
    expect(res.body.data.default_stage).toBe("technical");

    const ql = await db.one(
      `SELECT ql.id FROM tbl_arc_quote_line ql JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
        WHERE q.arc_id = $1 AND q.vendor_id = $2 AND ql.arc_item_id = $3`,
      [arcId, VENDOR_A, itemIds[0]]);
    const blocked = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: itemIds[0],
      allocations: [{ awarded_vendor_id: VENDOR_A, awarded_quote_line_id: ql.id, allocated_qty: 100, l_rank: "L1", is_l1_default: true, awarded_quote_snapshot: { rate: 90 } }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("STAGE_LOCKED");
    const finalizeBlocked = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/finalize`).send({});
    expect(finalizeBlocked.status).toBe(409);
    expect(finalizeBlocked.body.code).toBe("STAGE_LOCKED");
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

    // NEW: actors/flow assertions — technical stage pending
    const techFlow = stageOf(asBuyer.body, "technical").flow;
    const techActors = stageOf(asBuyer.body, "technical").actors;

    // flow correctness: next_stage, roles
    expect(techFlow.next_stage).toBe("commercial");
    expect(techFlow.action_taker_role).toBe("Technical evaluator");
    expect(techFlow.approver_role).toBe("Technical approver");

    // approver resolved — PENDING instance, people includes TECH_APPROVER
    expect(techActors.approver.status).toBe("PENDING");
    expect(techActors.approver.step_label).toBe("Level 1 of 1 · all must approve");
    const approverUserIds = techActors.approver.people.map((p) => p.user_id);
    expect(approverUserIds).toContain(TECH_APPROVER);
    const techAppPerson = techActors.approver.people.find((p) => p.user_id === TECH_APPROVER);
    expect(techAppPerson.name).toBeTruthy();
    expect(techAppPerson.email).toBeTruthy();

    // contact — seeded mobile '+919812345678' must appear
    expect(techActors.contact).not.toBeNull();
    expect(techActors.contact.mobile).toBe("+919812345678");
    expect(techActors.contact.name).toBeTruthy();
    expect(techActors.contact.email).toBeTruthy();
    expect(techActors.contact.role).toBe("Technical approver");

    // action_taker resolved (BUYER has arc-tech.evaluate in this hotel/dept)
    expect(techActors.action_taker.people.length).toBeGreaterThan(0);

    // next_stage object
    expect(techActors.next_stage).toMatchObject({ key: "commercial" });

    // can_user_approve gating: BUYER → false (already confirmed via approval block above)
    expect(techActors.approver.can_user_approve).toBe(false);

    // can_user_approve: TECH_APPROVER → true (uses asApprover already fetched above)
    const techActorsApprover = stageOf(asApprover.body, "technical").actors;
    expect(techActorsApprover.approver.can_user_approve).toBe(true);

    // can_user_approve: READER → false (different dept, not an approver)
    const asReaderLifecycle = await readerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(stageOf(asReaderLifecycle.body, "technical").actors.approver.can_user_approve).toBe(false);

    // scope isolation: READER (a1_eng_buyer, Engineering dept) must NOT appear
    // in either approver.people or action_taker.people (ARC scoped to Procurement dept)
    const allActorIds = [
      ...techActors.approver.people.map((p) => p.user_id),
      ...techActors.action_taker.people.map((p) => p.user_id),
    ];
    expect(allActorIds).not.toContain(READER);

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
    // Vendor B scored 40% (< 60% minimum) → not technically qualified, so
    // awarding them is rejected even though commercial is open now.
    const qlB = await db.one(
      `SELECT ql.id FROM tbl_arc_quote_line ql JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
        WHERE q.arc_id = $1 AND q.vendor_id = $2 AND ql.arc_item_id = $3`,
      [arcId, VENDOR_B, itemIds[0]]);
    const itemRow = await db.one(`SELECT indicative_qty FROM tbl_arc_item WHERE id = $1`, [itemIds[0]]);
    const dq = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: itemIds[0],
      allocations: [{ awarded_vendor_id: VENDOR_B, awarded_quote_line_id: qlB.id, allocated_qty: Number(itemRow.indicative_qty), l_rank: "L1", is_l1_default: false, awarded_quote_snapshot: { rate: 95 } }],
    });
    expect(dq.status).toBe(400);
    expect(dq.body.message).toMatch(/not technically qualified/);

    // REDACTION: vendor B's commercial terms never leave the server once
    // technical disqualified them — the comm-eval payload carries sealed lines.
    const ce = await buyerClient.get(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval`);
    const bLines = ce.body.data.quotes.filter((q) => Number(q.vendor_id) === VENDOR_B);
    expect(bLines.length).toBeGreaterThan(0);
    expect(bLines.every((q) => q.rate === null && q.technically_disqualified === true)).toBe(true);
    const aLines = ce.body.data.quotes.filter((q) => Number(q.vendor_id) === VENDOR_A);
    expect(aLines.every((q) => q.rate !== null && !q.technically_disqualified)).toBe(true);

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
    // Clearing the last holder is allowed — the item returns to pending.
    const cleared = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: items[0].id, allocations: [],
    });
    expect(cleared.status).toBe(200);
    const mid = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(stageOf(mid.body, "commercial").counts.items_allocated).toBe(1);
    // Restore the allocation so the journey continues to finalize.
    const qlRestore = quoteLines.find((l) => Number(l.arc_item_id) === Number(items[0].id));
    const restore = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: items[0].id,
      allocations: [{
        awarded_vendor_id: VENDOR_A, awarded_quote_line_id: qlRestore.id,
        allocated_qty: Number(items[0].indicative_qty), l_rank: 'L1', is_l1_default: true,
        awarded_quote_snapshot: { rate: 90, gst_pct: 5 },
      }],
    });
    expect(restore.status).toBe(200);

    const res = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(stageOf(res.body, "commercial")).toMatchObject({ state: "partial", reason: "awaiting_finalize" });
    expect(stageOf(res.body, "commercial").counts).toMatchObject({ items_total: 2, items_allocated: 2 });
    expect(stageOf(res.body, "awarding")).toMatchObject({ state: "active", reason: "preview" });
    // The raw status advanced on the first commercial action; awarding's
    // read-only preview never steals the default from Commercial.
    expect(res.body.data.current_status).toBe("comm_eval_in_progress");
    expect(res.body.data.default_stage).toBe("commercial");
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

    // NEW: awarding actors/flow assertions
    const awardingFlow = stageOf(res.body, "awarding").flow;
    const awardingActors = stageOf(res.body, "awarding").actors;
    expect(awardingFlow.next_stage).toBe("active");
    expect(awardingActors.approver.status).toBe("PENDING");
    expect(awardingActors.approver.people.map((p) => p.user_id)).toContain(COMMITTEE_APPROVER);
    // NULL-safe mobile: COMMITTEE_APPROVER has no mobile seeded → contact.mobile null
    expect(awardingActors.contact).not.toBeNull();
    expect(awardingActors.contact.mobile).toBeNull();
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

    // NEW: active stage is terminal — approver null, next_stage null, contact null
    const activeActors = stageOf(res.body, "active").actors;
    const activeFlow = stageOf(res.body, "active").flow;
    expect(activeActors.approver).toBeNull();
    expect(activeFlow.next_stage).toBeNull();
    expect(activeActors.contact).toBeNull();
  });

  test("9. zero clauses → technical skipped, commercial opens directly", async () => {
    const res = await buyerClient.get(`/api/v1/arc-v2/${skipArcId}/lifecycle`);
    expect(stageOf(res.body, "technical")).toMatchObject({ state: "skipped", reason: "no_clauses_configured" });
    expect(stageOf(res.body, "commercial")).toMatchObject({ state: "active" });
    expect(res.body.data.default_stage).toBe("commercial");

    // NEW: skipped technical — flow present, approver null (no ARC_TECH instance ever spawned)
    const skipTech = stageOf(res.body, "technical");
    expect(skipTech.flow.next_stage).toBe("commercial");
    expect(skipTech.actors.approver).toBeNull();
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
    // Tech approver holds arc-tech read+approve and NOTHING else.
    //
    // This used to assert all-empty, on the premise that "decide stays
    // engine-gated, so approvers don't need any permissions". That premise is
    // no longer true: USER-source approval steps are permission-gated at
    // resolution, so a named approver who holds no read+approve on the step's
    // resource is dropped and never becomes an approver at all. Holding
    // arc-tech read+approve is now a PRECONDITION of being the ARC_TECH
    // approver in tests 4-8 above, not an incidental extra grant.
    //
    // The assertion stays exact — it just encodes the new invariant: an
    // approver holds precisely the resource they approve on, and no other.
    const asTechApprover = await techApproverClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    const tp = asTechApprover.body.data.permissions;
    expect([...tp['arc-tech']].sort()).toEqual(['approve', 'read']);
    expect({ ...tp, 'arc-tech': undefined }).toEqual({
      'arc': [], 'arc-tech': undefined, 'arc-comm': [], 'arc-committee': [],
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
    // Tech approver now necessarily holds arc-tech.read (see test 11), so the
    // tech matrix READ is allowed — they have to be able to see what they are
    // approving. What they still must NOT have is `evaluate`: reading the
    // matrix and scoring it are different permissions, and the approver was
    // never granted the latter.
    const approverRead = await techApproverClient.get(`/api/v1/arc-v2/evaluation/items/${itemIds[0]}/tech-eval`);
    expect(approverRead.status).toBe(200);
    const approverScoreDenied = await techApproverClient
      .post(`/api/v1/arc-v2/evaluation/tech-eval/score`)
      .send({ response_id: responseIdsA[0], buyer_marks: 7 });
    expect(approverScoreDenied.status).toBe(403);
  });

  test("13. cross-tenant caller receives 403 on GET lifecycle (P0 tenant guard)", async () => {
    // CROSS_TENANT (companyB_admin) is mapped only to Hospitality B / Hotels B1+B2.
    // The ARC belongs to Hotel A1 under Hospitality A — entirely different tenant.
    // Before the fix this returned 200 and leaked approver/evaluator PII.
    const denied = await crossTenantClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(denied.status).toBe(403);
    expect(denied.body.message).toMatch(/do not have access/i);

    // Sanity: the in-scope buyer still gets 200.
    const allowed = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.arc).toBeDefined();
  });
});
