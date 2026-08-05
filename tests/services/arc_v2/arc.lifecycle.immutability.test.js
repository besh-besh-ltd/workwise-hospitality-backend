// ARC lifecycle — immutability guards (409 STAGE_IMMUTABLE).
//
// A FULLY complete stage is read-only; a PARTIAL stage stays editable.
// Proves the write guards across the commercial/awarding boundary:
//   1. While commercial is merely partial (all items allocated, not
//      finalized) allocations remain editable.
//   2. After finalize: saveAllocation → 409, finalize again → 409,
//      setupTechEval → 409 (can't un-skip technical under a locked award).
//   3. send-back-to-tech is refused (400) here because technical was SKIPPED
//      (no clauses) — there is no upstream stage to bounce to, so the finalized
//      award is left untouched.
//   4. After the committee APPROVES, send-back-to-tech itself 409s — the award
//      is contractually locked (the committee guard fires before the tech check).

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
const COMMITTEE_APPROVER = IDS.users.a1_proc_finance;
const VENDOR = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const POLICY_ID = 64913;

describe("ARC lifecycle — stage immutability + send-back unlock", () => {
  let buyerClient, committeeClient;
  let arcId, itemId, quoteLineId;

  const allocate = (qty = 500) =>
    buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [{
        awarded_vendor_id: VENDOR, awarded_quote_line_id: quoteLineId,
        allocated_qty: qty, l_rank: "L1", is_l1_default: true,
        awarded_quote_snapshot: { rate: 90, gst_pct: 5 },
      }],
    });

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id IN ($1,$2)`, [BUYER, COMMITTEE_APPROVER]);
    buyerClient = await httpClient(BUYER);
    committeeClient = await httpClient(COMMITTEE_APPROVER);
    // Evaluation endpoints are gated by requireArcPermission (arc-tech/-comm).
    await seedArcEvalPerms(db, [BUYER]);

    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_COMMITTEE', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [POLICY_ID, COMMITTEE_APPROVER]
    );

    // Window closed, NO clauses (technical skipped) — straight to commercial.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-IMM-1', 'Immutability', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '10 days', NOW() + INTERVAL '180 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    itemId = (await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, 1, 500, 'litre') RETURNING id`, [arcId])).id;
    const q = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at)
       VALUES ($1, $2, NOW()) RETURNING *`, [arcId, VENDOR]);
    quoteLineId = (await db.one(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
       VALUES ($1, $2, 90, 5) RETURNING id`, [q.id, itemId])).id;
  });

  afterAll(async () => {
    const instanceIds = (await db.any(
      `SELECT id FROM tbl_approval_instances
        WHERE entity_type IN ('ARC_TECH','ARC_COMMITTEE') AND entity_id = $1`, [arcId]
    )).map((r) => r.id);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers
                      WHERE approval_instance_step_id IN
                        (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = $1)`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  test("partial commercial stays editable; finalize locks it (409 on every write)", async () => {
    expect((await allocate()).status).toBe(200);
    // Partial → still editable (re-allocate fine).
    expect((await allocate()).status).toBe(200);

    const fin = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/finalize`).send({});
    expect(fin.status).toBe(200);

    const blocked = await allocate();
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("STAGE_IMMUTABLE");

    const reFinalize = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/finalize`).send({});
    expect(reFinalize.status).toBe(409);
    expect(reFinalize.body.code).toBe("STAGE_IMMUTABLE");

    // Configuring tech clauses now would un-skip technical under a locked
    // award — blocked too.
    const lateClauses = await buyerClient
      .post(`/api/v1/arc-v2/evaluation/items/${itemId}/tech-eval`)
      .send({ minimum_passing_score: 60, clauses: [{ clause_text: "late", weightage: 100 }] });
    expect(lateClauses.status).toBe(409);
    expect(lateClauses.body.code).toBe("STAGE_IMMUTABLE");
  });

  test("send-back-to-tech is refused (400) when technical was skipped — the finalized award is untouched", async () => {
    const pendingBefore = await db.one(
      `SELECT id, status FROM tbl_approval_instances
        WHERE entity_type = 'ARC_COMMITTEE' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`, [arcId]);
    expect(pendingBefore.status).toBe("PENDING");

    // Technical was skipped (no clauses) — nothing to send it back to.
    const sendBack = await buyerClient
      .post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/send-back-to-tech`)
      .send({ reason: "Split needs rebalancing" });
    expect(sendBack.status).toBe(400);
    expect(sendBack.body.message).toMatch(/Technical evaluation was not performed/i);

    // The finalized award is left intact — committee still pending, nothing cancelled.
    const untouched = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [pendingBefore.id]);
    expect(untouched.status).toBe("PENDING");
    const commercial = (await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`))
      .body.data.stages.find((s) => s.key === "commercial");
    expect(commercial.state).toBe("complete");
  });

  test("after committee approval the award is contractually locked — even send-back-to-tech 409s", async () => {
    const decide = await committeeClient
      .post(`/api/v1/arc-v2/committee/${arcId}/decide`)
      .send({ decision: "approve", comment: "Locked in" });
    expect(decide.status).toBe(200);

    // Committee-approved guard fires before the tech-applies check → 409, not 400.
    const sendBack = await buyerClient
      .post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/send-back-to-tech`)
      .send({ reason: "too late" });
    expect(sendBack.status).toBe(409);
    expect(sendBack.body.code).toBe("STAGE_IMMUTABLE");

    const blocked = await allocate();
    expect(blocked.status).toBe(409);
  });
});
