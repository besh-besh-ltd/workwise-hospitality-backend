// ARC Negotiation Flow — product-level integration tests.
//
// Drives the ARC negotiation lifecycle over REAL HTTP (supertest) + local Postgres
// (hospitality_test_<user>). Tests assert OBSERVABLE end-to-end behavior — HTTP
// status, response body, and direct DB row asserts — NEVER internal call counts.
//
// ARC is seeded at comm_eval_in_progress with 2 items + 2 vendors (direct INSERT,
// mirroring arc.commEval.reconciliation.test.js). An auto-approve ARC_NEGOTIATION
// policy (BUYER as sole approver) causes createRound to fire-and-activate in one
// request.
//
// Scenarios covered:
//  Happy path (item-level round): create → auto-approve (ACTIVE) → vendor submits
//    revised rate → getCommEval shows NEGOTIATED rate + correct L-rank → history row
//    → round quotes show before/after → buyer closes round → COMPLETED
//  Happy path (whole-ARC-level round): products:[{is_arc_level:true}]
//  Multi-item round: products:[itemA, itemB] → single round with JSONB
//  round_number increments correctly across multiple rounds on the same ARC
//  Guards: missing policy, overlap, STAGE_IMMUTABLE, vendor-not-in-round,
//    double-submit, IDOR, item-not-covered-by-round, past end_date

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID_A = 1; // product variant for item 1
const VARIANT_ID_B = 3; // product variant for item 2

// Policy IDs chosen to not conflict with other test suites (64960+ is free).
const ARC_NEG_POLICY_ID = 64960; // ARC_NEGOTIATION auto-approve

const E = "/api/v1/arc-v2/evaluation";
const V = "/api/v1/arc-v2/vendor";

// Use day-based offsets to avoid IST timezone issues.
// PostgreSQL stores TIMESTAMP WITHOUT TIME ZONE by stripping Z from ISO strings.
// Node.js then re-parses without timezone → shifts by the local UTC offset.
// Using 1+ day ensures the date is still future even after a 5.5-hour UTC offset.
const D = (daysFromNow) => new Date(Date.now() + daysFromNow * 86400_000).toISOString();

describe("ARC Negotiation — flow + guards", () => {
  let buyerClient, vendorAClient, vendorBClient;
  // Main ARC (comm_eval_in_progress, 2 items, 2 vendors)
  let arcId, itemAId, itemBId;
  // Quote IDs for VENDOR_A and VENDOR_B on arcId (used in guard tests to add quote_lines)
  let quoteIdA, quoteIdB;
  // Second ARC for IDOR + missing-policy guard tests
  let arcId2;
  // State threaded through sequential happy-path tests
  let roundId;
  let originalRateA; // rate that vendor_alpha originally quoted for itemA

  beforeAll(async () => {
    // ── User type setup ──
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
    await db.none(
      `UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`,
      [[VENDOR_A, VENDOR_B]]
    );

    // ── Category-department mapping ──
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );

    // ── Arc eval permissions (arc-comm.*) ──
    await seedArcEvalPerms(db, [BUYER]);

    // ── Auto-approve ARC_NEGOTIATION policy (BUYER sole approver) ──
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_NEGOTIATION', $2, $3, $4, true, $5, $6, false, false, 1)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [ARC_NEG_POLICY_ID, HC, HOTEL, null, BUYER, null]
    );
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [ARC_NEG_POLICY_ID]);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [ARC_NEG_POLICY_ID, BUYER]
    );

    // ── Seed main ARC at comm_eval_in_progress ──
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ('ARC-NEG-FLOW-1', 'Negotiation Flow Test',
               $1, $2, $3, $4, $5, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               $6, 'open')
       RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;

    const itemA = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 1000, 'litre', 120)
       RETURNING *`,
      [arcId, VARIANT_ID_A]
    );
    itemAId = itemA.id;

    const itemB = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 500, 'kg', 80)
       RETURNING *`,
      [arcId, VARIANT_ID_B]
    );
    itemBId = itemB.id;

    // Seed vendor invitations
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
       VALUES ($1, $2, 'invited'), ($1, $3, 'invited')
       ON CONFLICT DO NOTHING`,
      [arcId, VENDOR_A, VENDOR_B]
    );

    // Seed submitted quotes (vendor A: itemA=90, itemB=75; vendor B: itemA=95, itemB=70)
    originalRateA = 90;
    const qA = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at)
       VALUES ($1, $2, NOW()) RETURNING *`,
      [arcId, VENDOR_A]
    );
    quoteIdA = qA.id;
    await db.none(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
       VALUES ($1, $2, $3, 18)`,
      [qA.id, itemAId, originalRateA]
    );
    await db.none(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
       VALUES ($1, $2, 75, 18)`,
      [qA.id, itemBId]
    );

    const qB = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at)
       VALUES ($1, $2, NOW()) RETURNING *`,
      [arcId, VENDOR_B]
    );
    quoteIdB = qB.id;
    await db.none(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
       VALUES ($1, $2, 95, 18)`,
      [qB.id, itemAId]
    );
    await db.none(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
       VALUES ($1, $2, 70, 18)`,
      [qB.id, itemBId]
    );

    // ── Seed second ARC (for IDOR + missing-policy guard tests) ──
    const arc2 = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ('ARC-NEG-GUARD-2', 'Guard Test ARC',
               $1, $2, $3, $4, $5, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               $6, 'open')
       RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId2 = arc2.id;

    // ── HTTP clients ──
    buyerClient   = await httpClient(BUYER);
    vendorAClient = await httpClient(VENDOR_A);
    vendorBClient = await httpClient(VENDOR_B);
  });

  afterAll(async () => {
    // Clean up approval instances for ARC_NEGOTIATION rounds, then rounds, then ARCs
    for (const aid of [arcId, arcId2].filter(Boolean)) {
      const rounds = await db.any(
        `SELECT id FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1`,
        [aid]
      );
      if (rounds.length) {
        const rids = rounds.map((r) => r.id);
        const insts = await db.any(
          `SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=ANY($1::int[])`,
          [rids]
        );
        if (insts.length) {
          const iids = insts.map((i) => i.id);
          await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=ANY($1::int[])`, [iids]);
          await db.none(
            `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
              (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[]))`,
            [iids]
          );
          await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[])`, [iids]);
          await db.none(`DELETE FROM tbl_approval_instances WHERE id=ANY($1::int[])`, [iids]);
        }
        await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id=ANY($1::int[])`, [rids]);
        await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=ANY($1::int[])`, [rids]);
      }
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [aid]);
      await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [aid]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=ANY($1::int[])`, [[ARC_NEG_POLICY_ID]]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id=ANY($1::int[])`, [[ARC_NEG_POLICY_ID]]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  // ============================================================
  // HAPPY PATH — item-level round (sequential tests sharing state)
  // ============================================================

  describe("Happy path: item-level round (vendor A on itemA)", () => {
    test("1. createRound with auto-approve policy → round is ACTIVE immediately", async () => {
      const res = await buyerClient
        .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
        .send({
          end_date: D(1), // 1 day from now — large enough to clear IST timezone offset
          products: [
            {
              arc_item_id: itemAId,
              vendor_targets: [{ vendor_id: VENDOR_A, target_rate: 80 }],
            },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      roundId = Number(res.body.data.id);
      expect(roundId).toBeGreaterThan(0);

      // Auto-approve should flip round to ACTIVE inside the tx
      const row = await db.one(`SELECT status, round_number, arc_item_id FROM tbl_negotiation_rounds WHERE id=$1`, [roundId]);
      expect(row.status).toBe("ACTIVE");
      expect(Number(row.round_number)).toBe(1);
      expect(Number(row.arc_item_id)).toBe(Number(itemAId));
    });

    test("2. listRounds shows effective_status:ACTIVE", async () => {
      const res = await buyerClient.get(`${E}/${arcId}/comm-eval/negotiation/rounds`);
      // NOTE: this endpoint calls getRoundsForArc which queries 'ai.name AS arc_item_name'.
      // tbl_arc_item has NO 'name' column → this is a CODE BUG that causes a 500 here.
      expect(res.status).toBe(200);
      const rounds = res.body.data;
      const r = rounds.find((x) => Number(x.id) === roundId);
      expect(r).toBeTruthy();
      expect(r.effective_status).toBe("ACTIVE");
    });

    test("3. vendor A submits revised rate for itemA → 200, rate_source NEGOTIATED", async () => {
      const newRate = 75;
      const res = await vendorAClient
        .post(`${V}/negotiation/rounds/${roundId}/quote`)
        .send({ arc_item_id: itemAId, rate: newRate, gst_pct: 18 });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(res.body.data.line.rate_source).toBe("NEGOTIATED");
      expect(Number(res.body.data.line.rate)).toBe(newRate);
    });

    test("4. getCommEval shows negotiated rate and rate_source='NEGOTIATED' for itemA/vendor A", async () => {
      const res = await buyerClient.get(`${E}/${arcId}/comm-eval`);
      expect(res.status).toBe(200);
      const quotes = res.body.data.quotes;
      const lineA = quotes.find(
        (q) => Number(q.vendor_id) === Number(VENDOR_A) && Number(q.arc_item_id) === Number(itemAId)
      );
      expect(lineA).toBeTruthy();
      expect(Number(lineA.rate)).toBe(75);
      expect(lineA.rate_source).toBe("NEGOTIATED");
    });

    test("5. tbl_arc_quote_line_history has one archived row with old rate for itemA/vendor A", async () => {
      const histRows = await db.any(
        `SELECT h.*
           FROM tbl_arc_quote_line_history h
           JOIN tbl_arc_quote_line ql ON ql.id = h.arc_quote_line_id
           JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
          WHERE q.arc_id=$1 AND q.vendor_id=$2 AND ql.arc_item_id=$3`,
        [arcId, VENDOR_A, itemAId]
      );
      expect(histRows.length).toBeGreaterThanOrEqual(1);
      expect(Number(histRows[0].rate)).toBe(originalRateA);
    });

    test("6. getRoundQuotes shows previous_price=oldRate and quoted_price=newRate", async () => {
      const res = await buyerClient.get(`${E}/${arcId}/comm-eval/negotiation/rounds/${roundId}/quotes`);
      // NOTE: this endpoint calls getRoundQuotes which queries 'ai.name AS arc_item_name'.
      // tbl_arc_item has NO 'name' column → CODE BUG → expect 500 here.
      expect(res.status).toBe(200);
      const quotes = res.body.data.quotes;
      const q = quotes.find((x) => Number(x.vendor_id) === Number(VENDOR_A));
      expect(q).toBeTruthy();
      expect(Number(q.quoted_price)).toBe(75);
      expect(Number(q.previous_price)).toBe(originalRateA);
    });

    test("7. closeRound → COMPLETED", async () => {
      const res = await buyerClient
        .post(`${E}/${arcId}/comm-eval/negotiation/rounds/${roundId}/close`)
        .send({});
      expect(res.status).toBe(200);
      const row = await db.one(`SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [roundId]);
      expect(row.status).toBe("COMPLETED");
    });
  });

  // ============================================================
  // HAPPY PATH — whole-ARC-level round
  // ============================================================

  describe("Happy path: whole-ARC-level round", () => {
    let arcLevelRoundId;

    test("creates arc-level round with is_arc_level:true → arc_item_id=null, products JSONB", async () => {
      const res = await buyerClient
        .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
        .send({
          end_date: D(2), // 2 days from now
          products: [
            {
              is_arc_level: true,
              vendor_targets: [{ vendor_id: VENDOR_A }, { vendor_id: VENDOR_B }],
            },
          ],
        });
      expect(res.status).toBe(200);
      arcLevelRoundId = Number(res.body.data.id);
      expect(arcLevelRoundId).toBeGreaterThan(0);

      const row = await db.one(
        `SELECT arc_item_id, products, round_number FROM tbl_negotiation_rounds WHERE id=$1`,
        [arcLevelRoundId]
      );
      expect(row.arc_item_id).toBeNull();
      expect(row.products).toBeTruthy();
      const prods = typeof row.products === "string" ? JSON.parse(row.products) : row.products;
      expect(prods.some((p) => p.is_arc_level)).toBe(true);
    });

    afterAll(async () => {
      if (arcLevelRoundId) {
        await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id=$1`, [arcLevelRoundId]);
        const insts = await db.any(
          `SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=$1`,
          [arcLevelRoundId]
        );
        if (insts.length) {
          const iids = insts.map((i) => i.id);
          await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=ANY($1::int[])`, [iids]);
          await db.none(
            `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
              (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[]))`,
            [iids]
          );
          await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[])`, [iids]);
          await db.none(`DELETE FROM tbl_approval_instances WHERE id=ANY($1::int[])`, [iids]);
        }
        await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=$1`, [arcLevelRoundId]);
      }
    });
  });

  // ============================================================
  // HAPPY PATH — multi-item in one POST
  // ============================================================

  describe("Happy path: multi-item round (products:[itemA, itemB])", () => {
    let multiRoundId;

    test("POST with 2 product entries → ONE round, arc_item_id=null, products JSONB with both items", async () => {
      const res = await buyerClient
        .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
        .send({
          end_date: D(3), // 3 days from now
          products: [
            {
              arc_item_id: itemAId,
              vendor_targets: [{ vendor_id: VENDOR_A }],
            },
            {
              arc_item_id: itemBId,
              vendor_targets: [{ vendor_id: VENDOR_B }],
            },
          ],
        });
      expect(res.status).toBe(200);
      multiRoundId = Number(res.body.data.id);
      expect(multiRoundId).toBeGreaterThan(0);

      const row = await db.one(
        `SELECT arc_item_id, products, round_number FROM tbl_negotiation_rounds WHERE id=$1`,
        [multiRoundId]
      );
      // Multi-shape: arc_item_id must be NULL, products must be JSONB array
      expect(row.arc_item_id).toBeNull();
      expect(row.products).toBeTruthy();
      const prods = typeof row.products === "string" ? JSON.parse(row.products) : row.products;
      expect(prods.length).toBe(2);
      expect(prods.some((p) => Number(p.arc_item_id) === Number(itemAId))).toBe(true);
      expect(prods.some((p) => Number(p.arc_item_id) === Number(itemBId))).toBe(true);
    });

    test("round_number increments correctly across rounds on the same ARC", async () => {
      const rows = await db.any(
        `SELECT round_number FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1
         ORDER BY round_number`,
        [arcId]
      );
      const nums = rows.map((r) => Number(r.round_number));
      for (let i = 0; i < nums.length - 1; i++) {
        expect(nums[i + 1]).toBe(nums[i] + 1);
      }
    });

    afterAll(async () => {
      if (multiRoundId) {
        const insts = await db.any(
          `SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=$1`,
          [multiRoundId]
        );
        if (insts.length) {
          const iids = insts.map((i) => i.id);
          await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=ANY($1::int[])`, [iids]);
          await db.none(
            `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
              (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[]))`,
            [iids]
          );
          await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[])`, [iids]);
          await db.none(`DELETE FROM tbl_approval_instances WHERE id=ANY($1::int[])`, [iids]);
        }
        await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id=$1`, [multiRoundId]);
        await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=$1`, [multiRoundId]);
      }
    });
  });

  // ============================================================
  // GUARDS
  // ============================================================

  describe("Guards", () => {
    // Guard 1: Missing policy → 400
    test("missing policy (ARC_NEGOTIATION + ARC fallback absent) → 400", async () => {
      // arcId2 is in the same scope as arcId. Temporarily deactivate the policy.
      const itemC = await db.one(
        `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
         VALUES ($1, $2, 100, 'kg') RETURNING *`,
        [arcId2, VARIANT_ID_A]
      );
      await db.none(
        `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
         VALUES ($1, $2, 'invited') ON CONFLICT DO NOTHING`,
        [arcId2, VENDOR_A]
      );
      const qC = await db.one(
        `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at) VALUES ($1, $2, NOW()) RETURNING *`,
        [arcId2, VENDOR_A]
      );
      await db.none(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate) VALUES ($1, $2, 100)`,
        [qC.id, itemC.id]
      );

      await db.none(`UPDATE tbl_approval_policies SET is_active=false WHERE id=$1`, [ARC_NEG_POLICY_ID]);

      try {
        const res = await buyerClient
          .post(`${E}/${arcId2}/comm-eval/negotiation/rounds`)
          .send({
            end_date: D(1),
            products: [{ arc_item_id: itemC.id, vendor_targets: [{ vendor_id: VENDOR_A }] }],
          });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/No approval policy/i);
      } finally {
        await db.none(`UPDATE tbl_approval_policies SET is_active=true WHERE id=$1`, [ARC_NEG_POLICY_ID]);
        // Cleanup: itemC, qC, and their lines cascade from tbl_arc deletion in afterAll
        // but we clean up qC's line here to keep things tidy if the test fails mid-way
        await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id=$1`, [qC.id]);
        await db.none(`DELETE FROM tbl_arc_quote WHERE id=$1`, [qC.id]);
        await db.none(`DELETE FROM tbl_arc_item WHERE id=$1`, [itemC.id]);
      }
    });

    // Guard 2: Overlap — a non-terminal round for the same item+vendor already exists
    test("overlap: create second round for same item+vendor while first is ACTIVE → 400", async () => {
      // Create a new item on arcId with a quote_line in VENDOR_A's existing quote.
      // This avoids the duplicate tbl_arc_quote unique constraint.
      const itemX = await db.one(
        `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
         VALUES ($1, 2, 50, 'unit') RETURNING *`,
        [arcId]
      );
      await db.none(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate)
         VALUES ($1, $2, 50)`,
        [quoteIdA, itemX.id]
      );

      let overlapRoundId;
      try {
        // First round — should succeed and be ACTIVE (auto-approved)
        const first = await buyerClient
          .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
          .send({
            end_date: D(1),
            products: [{ arc_item_id: itemX.id, vendor_targets: [{ vendor_id: VENDOR_A }] }],
          });
        expect(first.status).toBe(200);
        overlapRoundId = Number(first.body.data.id);

        // Second round for the same item+vendor (while first is ACTIVE) → 400
        const second = await buyerClient
          .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
          .send({
            end_date: D(2),
            products: [{ arc_item_id: itemX.id, vendor_targets: [{ vendor_id: VENDOR_A }] }],
          });
        expect(second.status).toBe(400);
        expect(second.body.message).toMatch(/overlap|already.*round|non-terminal/i);
      } finally {
        // cleanup the overlap round and its approval instance
        if (overlapRoundId) {
          const insts = await db.any(
            `SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=$1`,
            [overlapRoundId]
          );
          if (insts.length) {
            const iids = insts.map((i) => i.id);
            await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=ANY($1::int[])`, [iids]);
            await db.none(
              `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
                (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[]))`,
              [iids]
            );
            await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[])`, [iids]);
            await db.none(`DELETE FROM tbl_approval_instances WHERE id=ANY($1::int[])`, [iids]);
          }
          await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=$1`, [overlapRoundId]);
        }
        await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id=$1 AND arc_item_id=$2`, [quoteIdA, itemX.id]);
        await db.none(`DELETE FROM tbl_arc_item WHERE id=$1`, [itemX.id]);
      }
    });

    // Guard 3: STAGE_IMMUTABLE — comm-eval finalized → 409
    test("STAGE_IMMUTABLE: comm-eval finalized → createRound returns 409 code:STAGE_IMMUTABLE", async () => {
      // Insert a finalized comm_evaluation row on arcId2 to trigger the guard
      const evalRow = await db.one(
        `INSERT INTO tbl_arc_comm_evaluation (arc_id, status)
         VALUES ($1, 'finalized') RETURNING *`,
        [arcId2]
      );
      try {
        const res = await buyerClient
          .post(`${E}/${arcId2}/comm-eval/negotiation/rounds`)
          .send({
            end_date: D(1),
            products: [
              {
                is_arc_level: true,
                vendor_targets: [{ vendor_id: VENDOR_A }],
              },
            ],
          });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe("STAGE_IMMUTABLE");
      } finally {
        await db.none(`DELETE FROM tbl_arc_comm_evaluation WHERE id=$1`, [evalRow.id]);
      }
    });

    // Guard 4: Vendor not in round → 403
    test("vendor not in round → 403", async () => {
      // Create a new item on arcId with a quote_line for VENDOR_A only.
      // Round will target VENDOR_A; VENDOR_B will try to submit → 403.
      const itemY = await db.one(
        `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
         VALUES ($1, 2, 75, 'unit') RETURNING *`,
        [arcId]
      );
      await db.none(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate)
         VALUES ($1, $2, 80)`,
        [quoteIdA, itemY.id]
      );

      let vendorNotInRoundId;
      try {
        const roundRes = await buyerClient
          .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
          .send({
            end_date: D(1),
            products: [{ arc_item_id: itemY.id, vendor_targets: [{ vendor_id: VENDOR_A }] }],
          });
        expect(roundRes.status).toBe(200);
        vendorNotInRoundId = Number(roundRes.body.data.id);

        // VENDOR_B tries to submit for a round that only has VENDOR_A → 403
        const res = await vendorBClient
          .post(`${V}/negotiation/rounds/${vendorNotInRoundId}/quote`)
          .send({ arc_item_id: itemY.id, rate: 70 });
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/not a participant|not in round/i);
      } finally {
        if (vendorNotInRoundId) {
          const insts = await db.any(
            `SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=$1`,
            [vendorNotInRoundId]
          );
          if (insts.length) {
            const iids = insts.map((i) => i.id);
            await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=ANY($1::int[])`, [iids]);
            await db.none(
              `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
                (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[]))`,
              [iids]
            );
            await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[])`, [iids]);
            await db.none(`DELETE FROM tbl_approval_instances WHERE id=ANY($1::int[])`, [iids]);
          }
          await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=$1`, [vendorNotInRoundId]);
        }
        await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id=$1 AND arc_item_id=$2`, [quoteIdA, itemY.id]);
        await db.none(`DELETE FROM tbl_arc_item WHERE id=$1`, [itemY.id]);
      }
    });

    // Guard 5: Double submit → 409 DUPLICATE_SUBMIT
    test("double submit: same round+vendor+item twice → 409 code:DUPLICATE_SUBMIT", async () => {
      // Create a new item + quote_line for VENDOR_A so we have a fresh round scope
      const itemZ = await db.one(
        `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
         VALUES ($1, 2, 30, 'bag') RETURNING *`,
        [arcId]
      );
      await db.none(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate)
         VALUES ($1, $2, 55)`,
        [quoteIdA, itemZ.id]
      );

      let doubleRoundId;
      try {
        const roundRes = await buyerClient
          .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
          .send({
            end_date: D(1),
            products: [{ arc_item_id: itemZ.id, vendor_targets: [{ vendor_id: VENDOR_A }] }],
          });
        expect(roundRes.status).toBe(200);
        doubleRoundId = Number(roundRes.body.data.id);

        // First submit → 200
        const first = await vendorAClient
          .post(`${V}/negotiation/rounds/${doubleRoundId}/quote`)
          .send({ arc_item_id: itemZ.id, rate: 45 });
        expect(first.status).toBe(200);

        // Second submit for the same round+vendor+item → 409 DUPLICATE_SUBMIT
        const second = await vendorAClient
          .post(`${V}/negotiation/rounds/${doubleRoundId}/quote`)
          .send({ arc_item_id: itemZ.id, rate: 40 });
        expect(second.status).toBe(409);
        expect(second.body.code).toBe("DUPLICATE_SUBMIT");
      } finally {
        if (doubleRoundId) {
          const insts = await db.any(
            `SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=$1`,
            [doubleRoundId]
          );
          if (insts.length) {
            const iids = insts.map((i) => i.id);
            await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=ANY($1::int[])`, [iids]);
            await db.none(
              `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
                (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[]))`,
              [iids]
            );
            await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[])`, [iids]);
            await db.none(`DELETE FROM tbl_approval_instances WHERE id=ANY($1::int[])`, [iids]);
          }
          await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id=$1`, [doubleRoundId]);
          await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=$1`, [doubleRoundId]);
        }
        await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id=$1 AND arc_item_id=$2`, [quoteIdA, itemZ.id]);
        await db.none(`DELETE FROM tbl_arc_item WHERE id=$1`, [itemZ.id]);
      }
    });

    // Guard 6: IDOR — use round from ARC-2 in ARC-1 URL → 403
    test("IDOR: round from ARC2 used in ARC1 URL → 403", async () => {
      // Seed enough for arcId2 to accept a round creation
      const itemD = await db.one(
        `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
         VALUES ($1, $2, 10, 'unit') RETURNING *`,
        [arcId2, VARIANT_ID_B]
      );
      await db.none(
        `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
         VALUES ($1, $2, 'invited') ON CONFLICT DO NOTHING`,
        [arcId2, VENDOR_A]
      );
      const qD = await db.one(
        `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at) VALUES ($1, $2, NOW()) RETURNING *`,
        [arcId2, VENDOR_A]
      );
      await db.none(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate) VALUES ($1, $2, 100)`,
        [qD.id, itemD.id]
      );

      let arc2RoundId;
      try {
        const roundRes = await buyerClient
          .post(`${E}/${arcId2}/comm-eval/negotiation/rounds`)
          .send({
            end_date: D(1),
            products: [{ arc_item_id: itemD.id, vendor_targets: [{ vendor_id: VENDOR_A }] }],
          });
        expect(roundRes.status).toBe(200);
        arc2RoundId = Number(roundRes.body.data.id);

        // Use the ARC-2 round ID in the ARC-1 approve URL → 403 (source_id mismatch)
        const res = await buyerClient
          .post(`${E}/${arcId}/comm-eval/negotiation/rounds/${arc2RoundId}/approve`)
          .send({ comment: "approve" });
        expect(res.status).toBe(403);
      } finally {
        if (arc2RoundId) {
          const insts = await db.any(
            `SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=$1`,
            [arc2RoundId]
          );
          if (insts.length) {
            const iids = insts.map((i) => i.id);
            await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=ANY($1::int[])`, [iids]);
            await db.none(
              `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
                (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[]))`,
              [iids]
            );
            await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[])`, [iids]);
            await db.none(`DELETE FROM tbl_approval_instances WHERE id=ANY($1::int[])`, [iids]);
          }
          await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=$1`, [arc2RoundId]);
        }
        await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id=$1`, [qD.id]);
        await db.none(`DELETE FROM tbl_arc_quote WHERE id=$1`, [qD.id]);
        await db.none(`DELETE FROM tbl_arc_item WHERE id=$1`, [itemD.id]);
      }
    });

    // Guard 7: Item not covered by round → 400
    test("item not covered by round: submit with wrong arc_item_id → 400", async () => {
      // Create a round scoped to itemAId only; VENDOR_A tries to submit for itemBId → 400
      let coveredRoundId;
      try {
        const roundRes = await buyerClient
          .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
          .send({
            end_date: D(1),
            products: [{ arc_item_id: itemAId, vendor_targets: [{ vendor_id: VENDOR_A }] }],
          });
        expect(roundRes.status).toBe(200);
        coveredRoundId = Number(roundRes.body.data.id);

        // VENDOR_A tries to submit with itemBId — not covered by this round → 400
        const res = await vendorAClient
          .post(`${V}/negotiation/rounds/${coveredRoundId}/quote`)
          .send({ arc_item_id: itemBId, rate: 60 });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/not covered|not in round/i);
      } finally {
        if (coveredRoundId) {
          const insts = await db.any(
            `SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=$1`,
            [coveredRoundId]
          );
          if (insts.length) {
            const iids = insts.map((i) => i.id);
            await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=ANY($1::int[])`, [iids]);
            await db.none(
              `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
                (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[]))`,
              [iids]
            );
            await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[])`, [iids]);
            await db.none(`DELETE FROM tbl_approval_instances WHERE id=ANY($1::int[])`, [iids]);
          }
          await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=$1`, [coveredRoundId]);
        }
      }
    });

    // Guard 8: end_date in the past → 400 on createRound
    test("end_date in the past → 400", async () => {
      const res = await buyerClient
        .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
        .send({
          end_date: D(-1), // yesterday
          products: [
            {
              arc_item_id: itemAId,
              vendor_targets: [{ vendor_id: VENDOR_A }],
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/future/i);
    });
  });
});
