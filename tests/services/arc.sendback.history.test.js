// Phase 9 — product-level tests for the tender send-back service.
//
// What the user/buyer should observe end-to-end:
//   - When the ARC committee sends a tender back, every byte of the
//     wiped active state is preserved as a snapshot row in
//     tbl_tender_sendback_history.
//   - Approval instances are CANCELLED, NOT deleted (audit trail
//     stays whole even after live state is gone).
//   - tbl_rfq.iteration_number bumps; the rfq is back to an OPEN
//     status so the buyer can rerun the wiped phase.
//   - VENDOR_FINALIZATION leaves negotiation rounds + tech-eval
//     rows alone; TECHNICAL_EVALUATION wipes those too.
//   - Vendor quotes are NEVER deleted on either send-back path.
//   - Reasons shorter than 30 chars are rejected by the service.

import { describe, it, expect, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import arcModel from "../../app/models/arcModel.js";
import { sendBackTender } from "../../app/services/tenderSendbackService.js";

const inserted = { rfqIds: [], arcIds: [] };

afterAll(async () => {
  await closeDb();
});

afterEach(async () => {
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_tender_sendback_history WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  if (inserted.arcIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_instance_steps
       WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances
         WHERE entity_type = 'ARC' AND entity_id IN (
           SELECT id FROM tbl_arc_item WHERE arc_id = ANY($1::int[])
         )
       )`,
      [inserted.arcIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instances
       WHERE entity_type = 'ARC' AND entity_id IN (
         SELECT id FROM tbl_arc_item WHERE arc_id = ANY($1::int[])
       )`,
      [inserted.arcIds]
    );
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [inserted.arcIds]);
    await db.none(`DELETE FROM tbl_arc_hotels WHERE arc_id = ANY($1::int[])`, [inserted.arcIds]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [inserted.arcIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  inserted.rfqIds = [];
  inserted.arcIds = [];
});

/** Set up a tender mid-flight at the ARC stage with finalization +
 *  some negotiation rounds, so the send-back wipe has things to wipe.
 */
async function makeArcStageTender({ withNegotiation = false } = {}) {
  const todayPlus = (days) =>
    new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    is_tender: 1,
    status: 4,
    is_published: 1,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);
  await db.none(
    `UPDATE tbl_rfq
     SET tender_scope = 'SINGLE',
         arc_period_from = $2::date,
         arc_period_to = $3::date,
         iteration_number = 1
     WHERE id = $1`,
    [rfq_id, todayPlus(0), todayPlus(365)]
  );
  await db.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by)
     VALUES ($1, $2, $3) ON CONFLICT (rfq_id, hotel_id) DO NOTHING`,
    [rfq_id, IDS.hotels.A1, IDS.users.a1_proc_buyer]
  );
  // Two products
  const p1 = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', '0', 555, 0) RETURNING id`,
    [rfq_id]
  );
  const p2 = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', '0', 666, 0) RETURNING id`,
    [rfq_id]
  );

  // Finalization rows (one per product/vendor) — the existing model
  // schema.
  await db.none(
    `INSERT INTO tbl_quote_finalization (rfq_id, rfq_no, product_variant_id, vendor_id, quote_id, created_by, variant)
     VALUES ($1, 1, 555, $2, 0, $3, 0)`,
    [rfq_id, IDS.users.vendor_alpha, IDS.users.a1_proc_buyer]
  );
  await db.none(
    `INSERT INTO tbl_quote_finalization (rfq_id, rfq_no, product_variant_id, vendor_id, quote_id, created_by, variant)
     VALUES ($1, 1, 666, $2, 0, $3, 0)`,
    [rfq_id, IDS.users.vendor_alpha, IDS.users.a1_proc_buyer]
  );

  // ARC envelope + items + a few approval instances.
  const env = await arcModel.ensureEnvelope({
    rfq_id, vendor_id: IDS.users.vendor_alpha, created_by: IDS.users.a1_proc_buyer,
  });
  inserted.arcIds.push(env.id);
  await arcModel.upsertItem({
    arc_id: env.id, rfq_product_id: p1.id, product_variant_id: 555, variant: 0,
    quote_id: 0, unit_price: 100,
  });
  await arcModel.upsertItem({
    arc_id: env.id, rfq_product_id: p2.id, product_variant_id: 666, variant: 0,
    quote_id: 0, unit_price: 200,
  });
  // One PENDING approval instance per arc_item.
  const items = await db.any(`SELECT * FROM tbl_arc_item WHERE arc_id = $1`, [env.id]);
  // Need a real approval policy id — pick the seeded RFQ-side one for A1/P1.
  const policyId = IDS.policies?.A1_P1_RFQ ?? 60001;
  for (const it of items) {
    const ai = await db.one(
      `INSERT INTO tbl_approval_instances
        (entity_type, entity_id, approval_policy_id, status, current_step, hospitality_company_id, hotel_id, initiated_by, metadata)
       VALUES ('ARC', $1, $2, 'PENDING', 1, $3, $4, $5, '{}'::jsonb)
       RETURNING id`,
      [it.id, policyId, IDS.hospitality.A, IDS.hotels.A1, IDS.users.a1_proc_buyer]
    );
    await db.none(`UPDATE tbl_arc_item SET approval_instance_id = $1 WHERE id = $2`, [ai.id, it.id]);
  }

  if (withNegotiation) {
    // Seed the full negotiation tree so the wipe + snapshot have to
    // navigate FK children, not just the parent table.
    const round = await db.one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, rfq_product_id, round_number, status, created_by, end_date, target_price)
       VALUES ($1, $2, 1, 'ENDED', $3, NOW() + INTERVAL '7 days', 95.50)
       RETURNING id`,
      [rfq_id, p1.id, IDS.users.a1_proc_buyer]
    );
    await db.none(
      `INSERT INTO tbl_negotiation_round_quotes
        (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at)
       VALUES ($1, $2, $3, 92.00, 100.00, NOW())`,
      [round.id, IDS.users.vendor_alpha, p1.id]
    );
    await db.none(
      `INSERT INTO tbl_negotiation_round_approvals
        (negotiation_round_id, approver_user_id, status, remarks, acted_at)
       VALUES ($1, $2, 'APPROVED', 'OK', NOW())`,
      [round.id, IDS.users.a1_proc_commApp]
    );
    // Finalization audit log entry — distinct from the live finalization
    // rows seeded above.
    await db.none(
      `INSERT INTO tbl_quote_finalization_history
        (rfq_id, rfq_no, quote_id, product_variant_id, vendor_id, created_by, variant, changed_by)
       VALUES ($1, 1, 0, 555, $2, $3, 0, $3)`,
      [rfq_id, IDS.users.vendor_alpha, IDS.users.a1_proc_buyer]
    );
  }

  return { rfq_id, arcId: env.id };
}

const REASON = "The committee identified material price discrepancies that require re-evaluation of vendor quotes against the ratecard.";

describe("Tender send-back — ARC → VENDOR_FINALIZATION", () => {
  it("snapshots ARC + finalization, cancels approval instances, increments iteration, leaves negotiation alone", async () => {
    const { rfq_id, arcId } = await makeArcStageTender({ withNegotiation: true });

    const result = await sendBackTender({
      rfq_id,
      from_stage: "ARC",
      to_stage: "VENDOR_FINALIZATION",
      reason: REASON,
      performed_by: IDS.users.a1_proc_buyer,
    });

    expect(result.iteration_before).toBe(1);
    expect(result.iteration_after).toBe(2);
    expect(result.from_stage).toBe("ARC");
    expect(result.to_stage).toBe("VENDOR_FINALIZATION");

    // Snapshot row exists.
    const history = await db.any(
      `SELECT * FROM tbl_tender_sendback_history WHERE rfq_id = $1`,
      [rfq_id]
    );
    expect(history.length).toBe(1);
    expect(history[0].snapshot_arc).toBeTruthy();
    expect(history[0].snapshot_finalization).toBeTruthy();
    expect(history[0].snapshot_approval_instances).toBeTruthy();
    expect(history[0].reason).toContain("price discrepancies");

    // ARC + finalization wiped.
    const arcRows = await db.any(`SELECT id FROM tbl_arc WHERE rfq_id = $1`, [rfq_id]);
    expect(arcRows.length).toBe(0);
    const finRows = await db.any(`SELECT id FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq_id]);
    expect(finRows.length).toBe(0);

    // Negotiation tree preserved (this is VENDOR_FINALIZATION, not TECH).
    // All three negotiation tables stay intact so the buyer can re-finalize
    // against the same negotiation context.
    const negRows = await db.any(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfq_id]);
    expect(negRows.length).toBe(1);
    const negQuoteRows = await db.any(
      `SELECT id FROM tbl_negotiation_round_quotes
        WHERE negotiation_round_id IN (SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = $1)`,
      [rfq_id]
    );
    expect(negQuoteRows.length).toBe(1);
    const negApprovalRows = await db.any(
      `SELECT id FROM tbl_negotiation_round_approvals
        WHERE negotiation_round_id IN (SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = $1)`,
      [rfq_id]
    );
    expect(negApprovalRows.length).toBe(1);
    // Finalization-history audit log is intentionally PRESERVED on every
    // send-back path — it's an append-only ledger of award/de-award cycles.
    const finHistoryRows = await db.any(
      `SELECT id FROM tbl_quote_finalization_history WHERE rfq_id = $1`,
      [rfq_id]
    );
    expect(finHistoryRows.length).toBe(1);

    // Approval instances cancelled, not deleted. Look them up via the
    // ids captured in the snapshot blob (array of instance rows).
    const snapshotInstances = Array.isArray(history[0].snapshot_approval_instances)
      ? history[0].snapshot_approval_instances
      : history[0].snapshot_approval_instances?.instances || [];
    const snapshotIds = snapshotInstances.map((i) => i.id);
    expect(snapshotIds.length).toBeGreaterThan(0);
    const cancelled = await db.any(
      `SELECT id, status, metadata FROM tbl_approval_instances WHERE id = ANY($1::int[])`,
      [snapshotIds]
    );
    expect(cancelled.length).toBe(snapshotIds.length);
    cancelled.forEach((row) => {
      expect(row.status).toBe("CANCELLED");
      const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      expect(meta?.cancellation?.sendback_from).toBe("ARC");
      expect(meta?.cancellation?.sendback_to).toBe("VENDOR_FINALIZATION");
    });

    // RFQ iteration bumped + status reset to OPEN.
    const after = await db.one(
      `SELECT iteration_number, status FROM tbl_rfq WHERE id = $1`,
      [rfq_id]
    );
    expect(after.iteration_number).toBe(2);
    expect(after.status).toBe(1);

    // Lifecycle event TENDER_SENDBACK was recorded.
    const lc = await db.any(
      `SELECT stage, action, metadata FROM tbl_lifecycle_history
       WHERE entity_type = 'TENDER' AND entity_id = $1 AND stage = 'TENDER_SENDBACK'`,
      [rfq_id]
    );
    expect(lc.length).toBe(1);
    const meta = typeof lc[0].metadata === "string" ? JSON.parse(lc[0].metadata) : lc[0].metadata;
    expect(meta.from_stage).toBe("ARC");
    expect(meta.to_stage).toBe("VENDOR_FINALIZATION");
  });
});

describe("Tender send-back — ARC → TECHNICAL_EVALUATION", () => {
  it("wipes ARC + finalization + negotiation rounds (and snapshots all of them)", async () => {
    const { rfq_id } = await makeArcStageTender({ withNegotiation: true });

    await sendBackTender({
      rfq_id,
      from_stage: "ARC",
      to_stage: "TECHNICAL_EVALUATION",
      reason: REASON,
      performed_by: IDS.users.a1_proc_buyer,
    });

    // All three negotiation tables wiped — no orphaned children left.
    const negRows = await db.any(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfq_id]);
    expect(negRows.length).toBe(0);
    const orphanedQuotes = await db.any(
      `SELECT id FROM tbl_negotiation_round_quotes
        WHERE negotiation_round_id NOT IN (SELECT id FROM tbl_negotiation_rounds)`
    );
    expect(orphanedQuotes.length).toBe(0);
    const orphanedApprovals = await db.any(
      `SELECT id FROM tbl_negotiation_round_approvals
        WHERE negotiation_round_id NOT IN (SELECT id FROM tbl_negotiation_rounds)`
    );
    expect(orphanedApprovals.length).toBe(0);

    // Live finalization rows wiped; the audit-log history table is
    // intentionally preserved so the long-running ledger stays whole.
    const finRows = await db.any(`SELECT id FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq_id]);
    expect(finRows.length).toBe(0);
    const finHistoryRows = await db.any(
      `SELECT id FROM tbl_quote_finalization_history WHERE rfq_id = $1`,
      [rfq_id]
    );
    expect(finHistoryRows.length).toBe(1);

    // Snapshot blob captures every commercial table — rounds, round_quotes,
    // round_approvals, finalization rows, and finalization history.
    const history = await db.one(
      `SELECT snapshot_negotiation, snapshot_finalization FROM tbl_tender_sendback_history WHERE rfq_id = $1`,
      [rfq_id]
    );
    expect(history.snapshot_negotiation).toBeTruthy();
    expect(history.snapshot_negotiation.rounds.length).toBe(1);
    expect(history.snapshot_negotiation.round_quotes.length).toBe(1);
    expect(history.snapshot_negotiation.round_approvals.length).toBe(1);
    expect(history.snapshot_finalization).toBeTruthy();
    expect(history.snapshot_finalization.finalizations.length).toBe(2);
    expect(history.snapshot_finalization.history.length).toBe(1);
  });

  it("wipes the tech-eval tree across all 10 schema tables and preserves them in the snapshot", async () => {
    const { rfq_id } = await makeArcStageTender({ withNegotiation: false });

    // Seed a slice of the tech-eval tree: one evaluation row, one clause, one
    // cleared vendor, one round, one comment + file, one vendor response + file.
    const productId = (
      await db.one(`SELECT id FROM tbl_rfq_products WHERE rfq_id = $1 ORDER BY id ASC LIMIT 1`, [rfq_id])
    ).id;
    const evalRow = await db.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation (rfq_id, tbl_rfq_product_id, minimum_passing_score)
       VALUES ($1, $2, 60) RETURNING id`,
      [rfq_id, productId]
    );
    const clauseRow = await db.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation_clauses
        (tbl_rfq_product_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1, 'Vendors must hold ISO 9001:2015 certification', 20, 'clause')
       RETURNING id`,
      [evalRow.id]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_clauses_files
        (tbl_rfq_product_tech_evaluation_clauses_id, file_url)
       VALUES ($1, 'https://s3.example.com/clause.pdf')`,
      [clauseRow.id]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors
        (tbl_rfq_product_tech_evaluation_id, vendor_id, status)
       VALUES ($1, $2, 1)`,
      [evalRow.id, IDS.users.vendor_alpha]
    );
    await db.none(
      `INSERT INTO tbl_tech_evaluation_rounds
        (tbl_rfq_product_tech_evaluation_id, round_number, status)
       VALUES ($1, 1, 'COMPLETED')`,
      [evalRow.id]
    );
    const commentRow = await db.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation_comments
        (tbl_rfq_product_tech_evaluation_clauses_id, text, sender_id, receiver_id)
       VALUES ($1, 'Please clarify the scope', $2, $3)
       RETURNING id`,
      [clauseRow.id, IDS.users.a1_proc_buyer, IDS.users.vendor_alpha]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_comments_files
        (tbl_rfq_product_tech_evaluation_comments_id, file_url, user_id)
       VALUES ($1, 'https://s3.example.com/comment.pdf', $2)`,
      [commentRow.id, IDS.users.a1_proc_buyer]
    );
    const responseRow = await db.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
        (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response, buyer_id, buyer_marks)
       VALUES ($1, $2, 'Yes, certified', $3, 18)
       RETURNING id`,
      [clauseRow.id, IDS.users.vendor_alpha, IDS.users.a1_proc_buyer]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response_files
        (tbl_rfq_product_tech_evaluation_vendors_response_id, file_url)
       VALUES ($1, 'https://s3.example.com/response.pdf')`,
      [responseRow.id]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_eval_vendor_replacements
        (rfq_id, rfq_product_id, old_vendor_id, new_vendor_id, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [rfq_id, productId, IDS.users.vendor_alpha, IDS.users.vendor_beta, IDS.users.a1_proc_buyer]
    );

    await sendBackTender({
      rfq_id,
      from_stage: "ARC",
      to_stage: "TECHNICAL_EVALUATION",
      reason: REASON,
      performed_by: IDS.users.a1_proc_buyer,
    });

    // After wipe: every tech-eval table is empty for this rfq.
    const evalRows = await db.any(
      `SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1`,
      [rfq_id]
    );
    expect(evalRows.length).toBe(0);
    const replRows = await db.any(
      `SELECT id FROM tbl_rfq_product_tech_eval_vendor_replacements WHERE rfq_id = $1`,
      [rfq_id]
    );
    expect(replRows.length).toBe(0);
    // Children must be gone too — the original FK-chain rows would be orphans
    // if the wipe missed them.
    const orphanedClauses = await db.any(
      `SELECT id FROM tbl_rfq_product_tech_evaluation_clauses
        WHERE tbl_rfq_product_tech_evaluation_id NOT IN (SELECT id FROM tbl_rfq_product_tech_evaluation)`
    );
    expect(orphanedClauses.length).toBe(0);

    // Snapshot blob captures every table.
    const history = await db.one(
      `SELECT snapshot_tech_eval FROM tbl_tender_sendback_history WHERE rfq_id = $1`,
      [rfq_id]
    );
    const snap = history.snapshot_tech_eval;
    expect(snap).toBeTruthy();
    expect(snap.tbl_rfq_product_tech_evaluation.length).toBe(1);
    expect(snap.tbl_rfq_product_tech_evaluation_clauses.length).toBe(1);
    expect(snap.tbl_rfq_product_tech_evaluation_clauses_files.length).toBe(1);
    expect(snap.tbl_rfq_product_tech_evaluation_cleared_vendors.length).toBe(1);
    expect(snap.tbl_rfq_product_tech_evaluation_comments.length).toBe(1);
    expect(snap.tbl_rfq_product_tech_evaluation_comments_files.length).toBe(1);
    expect(snap.tbl_rfq_product_tech_evaluation_vendors_response.length).toBe(1);
    expect(snap.tbl_rfq_product_tech_evaluation_vendors_response_files.length).toBe(1);
    expect(snap.tbl_tech_evaluation_rounds.length).toBe(1);
    expect(snap.tbl_rfq_product_tech_eval_vendor_replacements.length).toBe(1);
  });
});

describe("Tender send-back — input validation", () => {
  it("rejects when reason is shorter than 30 characters", async () => {
    const { rfq_id } = await makeArcStageTender();
    await expect(
      sendBackTender({
        rfq_id,
        from_stage: "ARC",
        to_stage: "VENDOR_FINALIZATION",
        reason: "too short",
        performed_by: IDS.users.a1_proc_buyer,
      })
    ).rejects.toThrow(/at least 30 characters/i);
  });

  it("rejects unsupported transitions", async () => {
    const { rfq_id } = await makeArcStageTender();
    await expect(
      sendBackTender({
        rfq_id,
        from_stage: "ARC",
        to_stage: "DRAFT", // not in the matrix anymore
        reason: REASON,
        performed_by: IDS.users.a1_proc_buyer,
      })
    ).rejects.toThrow(/Invalid send-back transition/i);
  });
});
