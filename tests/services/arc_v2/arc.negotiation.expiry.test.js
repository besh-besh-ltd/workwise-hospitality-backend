// ARC Negotiation Expiry — product-level integration tests.
//
// Exercises lazy-flip-on-read (effective_status:'ENDED' when end_date passed),
// vendor submit after expiry → 400, and the cron handler transitions via
// rescheduleAllArcNegotiationRoundExpirations (which internally calls
// handleArcNegotiationRoundExpiration for any round where end_date <= NOW()).
//
// Also verifies the critical isolation regression guard:
//   negotiationModel.getRoundsForReschedule() INNER JOINs tbl_rfq on rfq_id
//   → ARC rounds (rfq_id=NULL) are silently dropped from the RFQ reschedule set.
//   This proves ARC cron path isolation is correct and the two paths never cross.
//
// Seeding: direct DB inserts (same pattern as arc.commEval.reconciliation.test.js)
// so we can precisely control round.status and round.end_date.

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
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

// Policy IDs in the 64961 range (not used by any other test suite).
const ARC_NEG_EXP_POLICY_ID = 64961;

const E = "/api/v1/arc-v2/evaluation";
const V = "/api/v1/arc-v2/vendor";

describe("ARC Negotiation — expiry (lazy-flip + cron handler + regression guard)", () => {
  let buyerClient, vendorAClient;
  let arcId, itemId;
  // All round IDs created in this suite (cleaned up in afterAll)
  const roundIds = [];

  // ── Helper: insert an ARC round directly with controllable status + end_date ──
  async function insertRound({ arcId: aid, arcItemId, status, endDateOffset, vendorIds = [VENDOR_A] }) {
    const vendorApprovals = vendorIds.map((v) => ({ vendor_id: v, status: "PENDING" }));
    const row = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (source_type, source_id, rfq_id, rfq_product_id,
          arc_item_id, products,
          round_number, end_date, target_price, remarks,
          status, created_by, vendor_ids, vendor_approvals,
          created_at, updated_at)
       SELECT 'ARC', $1, NULL, NULL,
              $2, NULL,
              COALESCE(MAX(round_number), 0) + 1,
              -- (NOW() AT TIME ZONE 'UTC'), not bare NOW(). These are naive
              -- columns holding UTC (see app/helper/dbTime.js), and the code
              -- under test reads end_date with parseAsUTC. Casting a
              -- timestamptz NOW() into a naive column renders it in the
              -- POSTGRES SESSION timezone, so on an Asia/Kolkata dev box this
              -- seeded IST wall-clock digits that parseAsUTC then read as UTC —
              -- putting a round seeded 60s in the past 5h29m in the FUTURE, so
              -- it never flipped to ENDED. Exact under CI/production's UTC
              -- session, which is why only local runs failed.
              (NOW() AT TIME ZONE 'UTC') + ($3 || ' seconds')::interval,
              NULL, NULL,
              $4, $5, $6::int[], $7::jsonb,
              (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC')
         FROM tbl_negotiation_rounds
        WHERE source_type = 'ARC' AND source_id = $1
       RETURNING *`,
      [aid, arcItemId, endDateOffset, status, BUYER, vendorIds, JSON.stringify(vendorApprovals)]
    );
    roundIds.push(Number(row.id));
    return row;
  }

  // ── Helper: clean up an approval instance for a round ──
  async function cleanupApprovalInstance(roundId) {
    const insts = await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=$1`,
      [roundId]
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
  }

  beforeAll(async () => {
    // ── User type setup ──
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR_A]);

    // ── Category-department mapping ──
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );

    // ── Arc eval permissions ──
    await seedArcEvalPerms(db, [BUYER]);

    // ── Auto-approve ARC_NEGOTIATION policy ──
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_NEGOTIATION', $2, $3, $4, true, $5, $6, false, false, 1)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [ARC_NEG_EXP_POLICY_ID, HC, HOTEL, null, BUYER, null]
    );
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [ARC_NEG_EXP_POLICY_ID]);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [ARC_NEG_EXP_POLICY_ID, BUYER]
    );

    // ── Seed ARC + item + vendor quote ──
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ('ARC-NEG-EXP-1', 'Negotiation Expiry Test',
               $1, $2, $3, $4, $5, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               $6, 'open')
       RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;

    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 200, 'litre') RETURNING *`,
      [arcId, VARIANT_ID]
    );
    itemId = item.id;

    // Vendor invitation
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
       VALUES ($1, $2, 'invited') ON CONFLICT DO NOTHING`,
      [arcId, VENDOR_A]
    );

    // Vendor submitted quote
    const q = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at) VALUES ($1, $2, NOW()) RETURNING *`,
      [arcId, VENDOR_A]
    );
    await db.none(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
       VALUES ($1, $2, 100, 18)`,
      [q.id, itemId]
    );

    // ── HTTP clients ──
    buyerClient   = await httpClient(BUYER);
    vendorAClient = await httpClient(VENDOR_A);
  });

  afterAll(async () => {
    if (roundIds.length) {
      // cleanup round quotes + approval instances
      await db.none(
        `DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id=ANY($1::int[])`,
        [roundIds]
      );
      for (const rid of roundIds) {
        await cleanupApprovalInstance(rid);
      }
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=ANY($1::int[])`, [roundIds]);
    }
    if (arcId) {
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [ARC_NEG_EXP_POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id=$1`, [ARC_NEG_EXP_POLICY_ID]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  // ============================================================
  // LAZY-FLIP ON READ
  // ============================================================

  describe("Lazy-flip on read", () => {
    let expiredActiveRoundId;

    beforeAll(async () => {
      // Insert an ACTIVE round with end_date in the past (60 seconds ago).
      // The cron may not have fired, but read-time lazy-flip should treat it as ENDED.
      const row = await insertRound({ arcId, arcItemId: itemId, status: "ACTIVE", endDateOffset: -60 });
      expiredActiveRoundId = Number(row.id);
    });

    test("buyer listRounds shows effective_status:'ENDED' for past-end-date ACTIVE round", async () => {
      const res = await buyerClient.get(`${E}/${arcId}/comm-eval/negotiation/rounds`);
      // NOTE: This endpoint calls getRoundsForArc which has 'ai.name' — may fail with 500 due to code bug.
      expect(res.status).toBe(200);
      const rounds = res.body.data;
      const r = rounds.find((x) => Number(x.id) === expiredActiveRoundId);
      expect(r).toBeTruthy();
      expect(r.effective_status).toBe("ENDED");
    });

    test("vendor listRounds shows effective_status:'ENDED' for past-end-date ACTIVE round", async () => {
      const res = await vendorAClient.get(`${V}/requests/${arcId}/negotiation`);
      // NOTE: Also calls getRoundsForArc → same ai.name code bug risk.
      expect(res.status).toBe(200);
      const rounds = res.body.data;
      const r = rounds.find((x) => Number(x.round_id) === expiredActiveRoundId);
      expect(r).toBeTruthy();
      expect(r.effective_status).toBe("ENDED");
    });

    test("vendor submit after deadline → 400 'Round has ended'", async () => {
      const res = await vendorAClient
        .post(`${V}/negotiation/rounds/${expiredActiveRoundId}/quote`)
        .send({ arc_item_id: itemId, rate: 85 });
      // The round is ACTIVE in DB but end_date is in the past → lazy-flip check
      // in submitVendorQuote should reject with 400
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/ended|deadline/i);
    });
  });

  // ============================================================
  // CRON HANDLER TRANSITIONS
  // (tested via rescheduleAllArcNegotiationRoundExpirations which calls
  //  handleArcNegotiationRoundExpiration for each expired round)
  // ============================================================

  describe("Cron handler transitions", () => {
    test("PENDING_APPROVAL round with past end_date → EXPIRED + approval instance CANCELLED", async () => {
      // Insert a PENDING_APPROVAL round with end_date in the past
      const row = await insertRound({
        arcId, arcItemId: itemId, status: "PENDING_APPROVAL", endDateOffset: -120,
      });
      const pendingRoundId = Number(row.id);

      // Seed a fake approval instance so we can verify cancellation.
      // tbl_approval_instances requires hospitality_company_id (NOT NULL).
      const inst = await db.one(
        `INSERT INTO tbl_approval_instances
           (entity_type, entity_id, status, approval_policy_id, initiated_by, hospitality_company_id)
         VALUES ('ARC_NEGOTIATION', $1, 'PENDING', $2, $3, $4)
         RETURNING *`,
        [pendingRoundId, ARC_NEG_EXP_POLICY_ID, BUYER, HC]
      );

      // Call the exported startup function which internally processes expired rounds
      const { rescheduleAllArcNegotiationRoundExpirations } =
        await import("../../../app/helper/cronManager.js");
      await rescheduleAllArcNegotiationRoundExpirations();

      // Assert round flipped to EXPIRED
      const roundAfter = await db.one(
        `SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [pendingRoundId]
      );
      expect(roundAfter.status).toBe("EXPIRED");

      // Assert approval instance was CANCELLED
      const instAfter = await db.one(
        `SELECT status FROM tbl_approval_instances WHERE id=$1`, [inst.id]
      );
      expect(instAfter.status).toBe("CANCELLED");

      // Cleanup the approval instance (the round is in roundIds and cleaned up in afterAll)
      const instId = inst.id;
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=$1`, [instId]);
      await db.none(
        `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
          (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=$1)`,
        [instId]
      );
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=$1`, [instId]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id=$1`, [instId]);
    });

    test("ACTIVE round with past end_date → ENDED", async () => {
      // Insert an ACTIVE round with end_date in the past
      const row = await insertRound({
        arcId, arcItemId: itemId, status: "ACTIVE", endDateOffset: -180,
      });
      const activeRoundId = Number(row.id);

      const { rescheduleAllArcNegotiationRoundExpirations } =
        await import("../../../app/helper/cronManager.js");
      await rescheduleAllArcNegotiationRoundExpirations();

      const roundAfter = await db.one(
        `SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [activeRoundId]
      );
      expect(roundAfter.status).toBe("ENDED");
    });

    test("already-terminal (COMPLETED) round → no change (idempotent)", async () => {
      // Insert a COMPLETED round with a past end_date — cron should be a no-op
      const row = await insertRound({
        arcId, arcItemId: itemId, status: "COMPLETED", endDateOffset: -240,
      });
      const completedRoundId = Number(row.id);

      const { rescheduleAllArcNegotiationRoundExpirations } =
        await import("../../../app/helper/cronManager.js");
      await rescheduleAllArcNegotiationRoundExpirations();

      const roundAfter = await db.one(
        `SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [completedRoundId]
      );
      // Status must remain COMPLETED — no transition
      expect(roundAfter.status).toBe("COMPLETED");
    });

    test("already-terminal (CANCELLED) round → no change (idempotent)", async () => {
      const row = await insertRound({
        arcId, arcItemId: itemId, status: "CANCELLED", endDateOffset: -300,
      });
      const cancelledRoundId = Number(row.id);

      const { rescheduleAllArcNegotiationRoundExpirations } =
        await import("../../../app/helper/cronManager.js");
      await rescheduleAllArcNegotiationRoundExpirations();

      const roundAfter = await db.one(
        `SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [cancelledRoundId]
      );
      expect(roundAfter.status).toBe("CANCELLED");
    });
  });

  // ============================================================
  // REGRESSION GUARD — RFQ accessor isolation
  // ============================================================

  describe("Regression guard: RFQ getRoundsForReschedule does NOT return ARC rounds", () => {
    test("ARC round with rfq_id=NULL is dropped by RFQ accessor INNER JOIN on tbl_rfq", async () => {
      // Insert an ARC round with a FUTURE end_date and ACTIVE status
      // (non-terminal, future → the RFQ accessor would include it IF it joined correctly)
      const row = await insertRound({
        arcId, arcItemId: itemId, status: "ACTIVE", endDateOffset: 3600, // 1 hour in the future
      });
      const arcRoundId = Number(row.id);

      // Confirm the round has rfq_id = NULL in the DB
      const roundRow = await db.one(`SELECT rfq_id FROM tbl_negotiation_rounds WHERE id=$1`, [arcRoundId]);
      expect(roundRow.rfq_id).toBeNull();

      // Call the RFQ negotiation model's getRoundsForReschedule directly
      // (it INNER JOINs tbl_rfq on nr.rfq_id → ARC rounds are silently excluded)
      const negotiationModel = await import("../../../app/models/negotiationModel.js");
      const rfqRounds = await negotiationModel.default.getRoundsForReschedule();

      // The ARC round must NOT be in the results returned by the RFQ accessor
      const arcRoundInRfqList = rfqRounds.some((r) => Number(r.id) === arcRoundId);
      expect(arcRoundInRfqList).toBe(false);

      // Confirm the ARC accessor DOES include it
      const { default: arcNegotiationModel } =
        await import("../../../app/models/arc_v2/arcNegotiationModel.js");
      const arcRounds = await arcNegotiationModel.getArcRoundsForReschedule();
      const arcRoundInArcList = arcRounds.some((r) => Number(r.id) === arcRoundId);
      expect(arcRoundInArcList).toBe(true);
    });
  });
});
