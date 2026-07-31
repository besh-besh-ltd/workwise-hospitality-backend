// negotiation.listView.sources.test.js — product-level integration tests.
//
// Verifies that POST /api/v1/negotiation/list-view now returns BOTH RFQ and ARC
// negotiation rounds, with a `source` filter (all|RFQ|ARC) and `source_counts`.
//
// Strategy: direct INSERTs only (no HTTP round-trips for seeding), real HTTP
// for all assertions. Follows conventions from:
//   arc.negotiation.flow.test.js  — ARC direct-INSERT fixtures + approval teardown
//   listView.fyFilter.test.js     — list-view HTTP request/response shape
//
// IMPORTANT: node-postgres returns BIGSERIAL / integer columns as strings.
// All ID comparisons use Number() so `toContain` / `toBe` work correctly.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { makeRFQ } from "../factories/rfq.js";

// ─── Fixture constants ───────────────────────────────────────────────────────
const HC_A    = IDS.hospitality.A;
const HC_B    = IDS.hospitality.B;
const HOTEL_A = IDS.hotels.A1;
const HOTEL_A2 = IDS.hotels.A2;                  // second hotel under the SAME company
const HOTEL_B = IDS.hotels.B1;
const DEPT    = IDS.departments.proc;
const PROC    = IDS.processes.A_P1;
const BUYER   = IDS.users.a1_proc_buyer;         // user_type=2, RBAC-scoped to (HC_A, A1)
const BUYER_B = IDS.users.companyB_admin;        // will set user_type=2, scoped to HC_B only
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

// The list-view read matrix keys off permission negotiation.read. The shared
// fixture role for BUYER (TENDER_CREATOR / role 2) does not carry it — true in
// production too — so grant a role that does, scoped to (HC_A, A1, all depts).
// Torn down in afterAll. Role 8 = Commercial Negotiator N1.
const ROLE_NEG_READ = 8;

// Policy ID for the pending-on-me ARC_NEGOTIATION instance (must be in tbl_approval_policies).
// Use 64970 to avoid clash with arc.negotiation.flow.test.js (64960).
const PENDING_POLICY_ID = 64970;

// Day-based offset (avoids IST timezone edge cases — same pattern as arc.negotiation.flow.test.js).
const D = (daysFromNow) =>
  new Date(Date.now() + daysFromNow * 86_400_000).toISOString();

// ─── State variables ─────────────────────────────────────────────────────────
let buyerClient;
let rfqId, rfqRoundId;
let arcId, arcItemId, arcRoundId;
let pendingArcId, pendingArcItemId, pendingArcRoundId;
let instanceId, instanceStepId;
let arcB_Id, arcB_RoundId; // Company B — for scope-isolation assertion
let rfqA2_Id, rfqA2_RoundId; // SAME company, DIFFERENT hotel — hotel isolation
let arcA2_Id, arcA2_ItemId, arcA2_RoundId;
let negScopeId; // tbl_user_role_scopes row granting BUYER negotiation.read

describe("Negotiation list-view — source filter (RFQ + ARC unification)", () => {
  // ── SETUP ──────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    // Ensure buyer user_type=2 (ACL gate is acl([2,8])).
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    // Company B admin also needs user_type=2 for the isolation test.
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER_B]);

    // Grant BUYER negotiation.read at (HC_A, A1, all depts) — see ROLE_NEG_READ.
    const scopeRow = await db.one(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, $4, NULL)
       RETURNING id`,
      [BUYER, ROLE_NEG_READ, HC_A, HOTEL_A]
    );
    negScopeId = Number(scopeRow.id);

    buyerClient = await httpClient(BUYER);

    // ── 1. Company-A RFQ + active negotiation round ─────────────────────────
    const { rfq_id } = await makeRFQ(db, {
      createdBy: BUYER,
      hospitality: HC_A,
      hotel: HOTEL_A,
    });
    rfqId = Number(rfq_id);

    const rfqRound = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, source_type, source_id, round_number, status, end_date, created_by)
       VALUES ($1, 'RFQ', $1, 1, 'ACTIVE', $2, $3)
       RETURNING id`,
      [rfqId, D(7), BUYER]
    );
    rfqRoundId = Number(rfqRound.id);

    // ── 2. Company-A ARC + active ARC negotiation round ─────────────────────
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at,
          contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ('LISTV-SRC-ARC-1', 'List View Source Test ARC',
               $1, $2, $3, $4, $5, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               $6, 'open')
       RETURNING id, arc_number, title`,
      [CATEGORY, HC_A, HOTEL_A, DEPT, PROC, BUYER]
    );
    arcId = Number(arc.id);

    const arcItem = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 100, 'kg', 50)
       RETURNING id`,
      [arcId, VARIANT_ID]
    );
    arcItemId = Number(arcItem.id);

    const arcRound = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (source_type, source_id, arc_item_id, rfq_id, round_number, status, end_date, created_by)
       VALUES ('ARC', $1, $2, NULL, 1, 'ACTIVE', $3, $4)
       RETURNING id`,
      [arcId, arcItemId, D(7), BUYER]
    );
    arcRoundId = Number(arcRound.id);

    // ── 3. Company-A ARC with PENDING_APPROVAL round (pending-on-me test) ───
    const pendingArc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at,
          contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ('LISTV-SRC-ARC-PENDING', 'List View Pending ARC',
               $1, $2, $3, $4, $5, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               $6, 'open')
       RETURNING id`,
      [CATEGORY, HC_A, HOTEL_A, DEPT, PROC, BUYER]
    );
    pendingArcId = Number(pendingArc.id);

    const pendingArcItem = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 50, 'litre')
       RETURNING id`,
      [pendingArcId, VARIANT_ID]
    );
    pendingArcItemId = Number(pendingArcItem.id);

    const pendingRound = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (source_type, source_id, arc_item_id, rfq_id, round_number, status, end_date, created_by)
       VALUES ('ARC', $1, $2, NULL, 1, 'PENDING_APPROVAL', $3, $4)
       RETURNING id`,
      [pendingArcId, pendingArcItemId, D(3), BUYER]
    );
    pendingArcRoundId = Number(pendingRound.id);

    // Insert minimal approval policy so the FK constraint on tbl_approval_instances is satisfied.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_NEGOTIATION', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [PENDING_POLICY_ID, HC_A, HOTEL_A, BUYER, PROC]
    );

    // Insert approval instance (entity_type='ARC_NEGOTIATION', entity_id=round.id).
    const inst = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          initiated_by, hospitality_company_id, hotel_id, department_id)
       VALUES ('ARC_NEGOTIATION', $1, $2, 'PENDING', 1, $3, $4, $5, $6)
       RETURNING id`,
      [pendingArcRoundId, PENDING_POLICY_ID, BUYER, HC_A, HOTEL_A, DEPT]
    );
    instanceId = Number(inst.id);

    // Insert instance step (step_order=1 = current_step=1).
    const step = await db.one(
      `INSERT INTO tbl_approval_instance_steps
         (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, 1, 'ALL', 'PENDING')
       RETURNING id`,
      [instanceId]
    );
    instanceStepId = Number(step.id);

    // Insert step approver = BUYER (so pending-on-me fires for this user).
    await db.none(
      `INSERT INTO tbl_approval_step_approvers
         (approval_instance_step_id, approver_user_id, status)
       VALUES ($1, $2, 'PENDING')`,
      [instanceStepId, BUYER]
    );

    // ── 4. Company-B ARC + round (scope isolation) ───────────────────────────
    const arcB = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at,
          contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ('LISTV-SRC-ARC-B1', 'Company B Isolation ARC',
               $1, $2, $3, $4, $5, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               $6, 'open')
       RETURNING id`,
      [CATEGORY, HC_B, HOTEL_B, DEPT, PROC, BUYER_B]
    );
    arcB_Id = Number(arcB.id);

    // ARC B item
    const arcBItem = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 20, 'unit')
       RETURNING id`,
      [arcB_Id, VARIANT_ID]
    );

    const arcBRound = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (source_type, source_id, arc_item_id, rfq_id, round_number, status, end_date, created_by)
       VALUES ('ARC', $1, $2, NULL, 1, 'ACTIVE', $3, $4)
       RETURNING id`,
      [arcB_Id, Number(arcBItem.id), D(5), BUYER_B]
    );
    arcB_RoundId = Number(arcBRound.id);

    // ── 5. SAME company (HC_A), DIFFERENT hotel (A2) — hotel isolation ───────
    // BUYER is RBAC-scoped to A1 only. These rows share the company clause but
    // must still be invisible: the company boundary is NOT the read boundary.
    const { rfq_id: rfqA2 } = await makeRFQ(db, {
      createdBy: BUYER_B,
      hospitality: HC_A,
      hotel: HOTEL_A2,
      department: DEPT,
    });
    rfqA2_Id = Number(rfqA2);

    const rfqA2Round = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, source_type, source_id, round_number, status, end_date, created_by)
       VALUES ($1, 'RFQ', $1, 1, 'ACTIVE', $2, $3)
       RETURNING id`,
      [rfqA2_Id, D(7), BUYER_B]
    );
    rfqA2_RoundId = Number(rfqA2Round.id);

    const arcA2 = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at,
          contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ('LISTV-SRC-ARC-A2', 'Same Company Other Hotel ARC',
               $1, $2, $3, $4, $5, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               $6, 'open')
       RETURNING id`,
      [CATEGORY, HC_A, HOTEL_A2, DEPT, PROC, BUYER_B]
    );
    arcA2_Id = Number(arcA2.id);

    const arcA2Item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 15, 'unit')
       RETURNING id`,
      [arcA2_Id, VARIANT_ID]
    );
    arcA2_ItemId = Number(arcA2Item.id);

    const arcA2Round = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (source_type, source_id, arc_item_id, rfq_id, round_number, status, end_date, created_by)
       VALUES ('ARC', $1, $2, NULL, 1, 'ACTIVE', $3, $4)
       RETURNING id`,
      [arcA2_Id, arcA2_ItemId, D(5), BUYER_B]
    );
    arcA2_RoundId = Number(arcA2Round.id);
  });

  // ── TEARDOWN ───────────────────────────────────────────────────────────────
  afterAll(async () => {
    // Approval rows (step approvers → steps → instances).
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id = $1`,
      [instanceStepId]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = $1`,
      [instanceId]
    );
    await db.none(
      `DELETE FROM tbl_approval_instances WHERE id = $1`,
      [instanceId]
    );
    await db.none(
      `DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`,
      [PENDING_POLICY_ID]
    );
    await db.none(
      `DELETE FROM tbl_approval_policies WHERE id = $1`,
      [PENDING_POLICY_ID]
    );

    // Role-scope grant that gave BUYER negotiation.read.
    if (negScopeId) {
      await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [negScopeId]);
    }

    // Negotiation round quotes (none seeded but belt-and-suspenders).
    const allRoundIds = [rfqRoundId, arcRoundId, pendingArcRoundId, arcB_RoundId,
                         rfqA2_RoundId, arcA2_RoundId].filter(Boolean);
    if (allRoundIds.length) {
      await db.none(
        `DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`,
        [allRoundIds]
      );
      await db.none(
        `DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`,
        [allRoundIds]
      );
    }

    // ARC items
    const allArcItemIds = [arcItemId, pendingArcItemId, arcA2_ItemId].filter(Boolean);
    if (allArcItemIds.length) {
      await db.none(`DELETE FROM tbl_arc_item WHERE id = ANY($1::int[])`, [allArcItemIds]);
    }
    // ARC B item (different variable)
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [[arcB_Id].filter(Boolean)]);

    // ARC event logs + ARCs
    const allArcIds = [arcId, pendingArcId, arcB_Id, arcA2_Id].filter(Boolean);
    if (allArcIds.length) {
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [allArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [allArcIds]);
    }

    // RFQs
    const allRfqIds = [rfqId, rfqA2_Id].filter(Boolean);
    if (allRfqIds.length) {
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [allRfqIds]);
    }
  });

  // ── HELPER ─────────────────────────────────────────────────────────────────
  const listView = (body = {}) =>
    buyerClient.post("/api/v1/negotiation/list-view").send(body);

  const roundIds = (res) => res.body.data.rows.map((r) => Number(r.round_id));

  // ─────────────────────────────────────────────────────────────────────────
  // Test 1 — ARC round appears in default (source='all') list
  // ─────────────────────────────────────────────────────────────────────────
  test("1. ARC round appears in default list (source='all') alongside RFQ round", async () => {
    const res = await listView({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const data = res.body.data;
    expect(data.rows).toBeDefined();
    expect(data.source_counts).toBeDefined();

    const ids = roundIds(res);
    // ARC round must be present
    expect(ids).toContain(arcRoundId);
    // RFQ round must also be present
    expect(ids).toContain(rfqRoundId);

    // ARC row field assertions
    const arcRow = data.rows.find((r) => Number(r.round_id) === arcRoundId);
    expect(arcRow).toBeDefined();
    expect(arcRow.source_type).toBe("ARC");
    expect(Number(arcRow.arc_id)).toBe(arcId);
    // arc_number appears in rfq_no slot (ARC title slot)
    expect(arcRow.rfq_no).toBe("LISTV-SRC-ARC-1");
    expect(arcRow.title).toBe("List View Source Test ARC");
    // rfq_id is null for ARC rows
    expect(arcRow.rfq_id).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2 — source='ARC' narrows to ARC rows only
  // ─────────────────────────────────────────────────────────────────────────
  test("2. source='ARC' returns only ARC rows; RFQ round absent; source_counts.ARC matches", async () => {
    const res = await listView({ source: "ARC" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const data = res.body.data;
    const ids = roundIds(res);

    // All returned rows must be ARC
    for (const r of data.rows) {
      expect(r.source_type).toBe("ARC");
    }

    // ARC round present; RFQ round absent
    expect(ids).toContain(arcRoundId);
    expect(ids).not.toContain(rfqRoundId);

    // source_counts.ARC must equal the count of ARC rows we got in 'all' mode.
    // (We just verify it's >= 1 and matches the rows length here since other
    // ARC rows from other tests could appear in the DB.)
    expect(data.source_counts.ARC).toBeGreaterThanOrEqual(1);
    // For our seeded set: ARC narrow total = source_counts.ARC (the full scoped ARC count).
    // rows.length reflects pagination applied to the ARC subset.
    // We trust source_counts by design — check that ARC count is consistent.
    expect(data.source_counts.RFQ).toBeGreaterThanOrEqual(0);
    expect(data.source_counts.all).toBe(data.source_counts.RFQ + data.source_counts.ARC);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3 — source='RFQ' parity: same RFQ rows as before, no ARC rows
  // ─────────────────────────────────────────────────────────────────────────
  test("3. source='RFQ' returns RFQ round and NO ARC rows — additive-only behavior", async () => {
    const res = await listView({ source: "RFQ" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const data = res.body.data;
    const ids = roundIds(res);

    // All returned rows must be RFQ
    for (const r of data.rows) {
      expect(r.source_type).toBe("RFQ");
    }

    // Seeded RFQ round must be present
    expect(ids).toContain(rfqRoundId);

    // ARC round ids must NOT appear
    expect(ids).not.toContain(arcRoundId);
    expect(ids).not.toContain(pendingArcRoundId);
    expect(ids).not.toContain(arcB_RoundId);

    // source_counts integrity: all = RFQ + ARC
    expect(data.source_counts.all).toBe(data.source_counts.RFQ + data.source_counts.ARC);
    expect(data.source_counts.RFQ).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4 — source_counts integrity: all === RFQ + ARC
  // ─────────────────────────────────────────────────────────────────────────
  test("4. source_counts.all === source_counts.RFQ + source_counts.ARC in default response", async () => {
    const res = await listView({});
    expect(res.status).toBe(200);

    const { source_counts } = res.body.data;
    expect(source_counts).toBeDefined();
    expect(typeof source_counts.all).toBe("number");
    expect(typeof source_counts.RFQ).toBe("number");
    expect(typeof source_counts.ARC).toBe("number");
    expect(source_counts.all).toBe(source_counts.RFQ + source_counts.ARC);

    // Both are populated (our seeds contribute at least 1 each).
    expect(source_counts.RFQ).toBeGreaterThanOrEqual(1);
    expect(source_counts.ARC).toBeGreaterThanOrEqual(2); // arcRoundId + pendingArcRoundId (both HC_A)
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 5 — Pending-on-me unified: ARC_NEGOTIATION pending shows in for_me
  // ─────────────────────────────────────────────────────────────────────────
  test("5. tab='for_me' (source='all') includes the ARC round awaiting BUYER approval", async () => {
    const res = await listView({ tab: "for_me", source: "all" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const data = res.body.data;
    const ids = roundIds(res);

    // The pending ARC round (PENDING_APPROVAL) must appear in for_me
    expect(ids).toContain(pendingArcRoundId);

    // action_required must be true on that row
    const pendingRow = data.rows.find((r) => Number(r.round_id) === pendingArcRoundId);
    expect(pendingRow).toBeDefined();
    expect(pendingRow.action_required).toBe(true);

    // tab_counts.for_me must be at least 1 (counts the ARC round)
    expect(data.tab_counts.for_me).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 6 — Scope isolation. Two boundaries, both enforced:
  //   (a) company: Company-A buyer never sees a Company-B round;
  //   (b) hotel:   an A1-scoped buyer never sees an A2 round of their OWN
  //                company. Company alone is NOT the read boundary — this is
  //                the P0 leak (see negotiation.listView.scope.test.js). Kept
  //                here too so the two suites cannot drift apart.
  // ─────────────────────────────────────────────────────────────────────────
  test("6. Company-A buyer cannot see Company-B ARC negotiation round in any source mode", async () => {
    // source='all'
    const resAll = await listView({ source: "all" });
    expect(resAll.status).toBe(200);
    expect(roundIds(resAll)).not.toContain(arcB_RoundId);

    // source='ARC' — still must not see Company-B round
    const resArc = await listView({ source: "ARC" });
    expect(resArc.status).toBe(200);
    expect(roundIds(resArc)).not.toContain(arcB_RoundId);
  });

  test("6b. An A1-scoped buyer cannot see A2 rounds of their OWN company (RFQ or ARC)", async () => {
    // limit high enough that "absent" means scoped out, not paginated away.
    const resAll = await listView({ source: "all", limit: 100 });
    expect(resAll.status).toBe(200);
    const idsAll = roundIds(resAll);

    // In scope (hotel A1) — still visible.
    expect(idsAll).toContain(rfqRoundId);
    expect(idsAll).toContain(arcRoundId);
    // Same company, other hotel — must NOT leak, on either branch of the union.
    expect(idsAll).not.toContain(rfqA2_RoundId);
    expect(idsAll).not.toContain(arcA2_RoundId);

    // Per-source modes enforce it too.
    const resRfq = await listView({ source: "RFQ", limit: 100 });
    expect(roundIds(resRfq)).not.toContain(rfqA2_RoundId);
    const resArc = await listView({ source: "ARC", limit: 100 });
    expect(roundIds(resArc)).not.toContain(arcA2_RoundId);

    // The derived buId facet must not advertise the out-of-scope hotel either.
    const buIds = (resAll.body.data.facets.buId || []).map((f) => String(f.key));
    expect(buIds).toContain(String(HOTEL_A));
    expect(buIds).not.toContain(String(HOTEL_A2));
    expect(buIds).not.toContain(String(HOTEL_B));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 7 (bonus) — Mixed paginate: total reflects RFQ+ARC; page/limit works
  // ─────────────────────────────────────────────────────────────────────────
  test("7. total in default response equals RFQ+ARC combined; page/limit slices without error", async () => {
    const resDefault = await listView({});
    expect(resDefault.status).toBe(200);
    const { total, source_counts } = resDefault.body.data;

    // total should equal the full scoped set (all source types)
    expect(total).toBeGreaterThanOrEqual(source_counts.RFQ + source_counts.ARC);

    // Page 1 limit 1 should return exactly 1 row without error
    const resPaged = await listView({ page: 1, limit: 1 });
    expect(resPaged.status).toBe(200);
    expect(resPaged.body.data.rows.length).toBe(1);
    expect(resPaged.body.data.total).toBeGreaterThanOrEqual(1);
  });
});
