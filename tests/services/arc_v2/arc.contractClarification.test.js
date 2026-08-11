// ARC — vendor-initiated contract clarification loop (SURGICAL).
//
// A vendor reviewing a generated rate contract disputes ONE field of an awarded
// line before signing. This must NOT de-finalise the commercial evaluation or
// re-open the allocation matrix — awarded means awarded. The evaluator can only
// REVISE the disputed value or UPHOLD it; resolving the last open clarification
// re-routes the (possibly-revised) award through a fresh committee approval and
// regenerates just the affected contract for re-acceptance.
//
// Observable end-to-end behaviours pinned here (real HTTP + local Postgres):
//   1. Raise a clarification → contract parks in 'clarification', but commercial
//      stays 'complete'/finalized, committee stays APPROVED, ARC stays
//      awaiting_vendor_acceptance. Lifecycle flags it (clarifications_open=1,
//      default_stage=commercial).
//   2. The allocation matrix stays locked (saveAllocation 409) and signing is
//      blocked (requestOtp 409).
//   3. Buyer revises → scoped award-snapshot edit; resolving the last one fires
//      a committee re-approval that regenerates the contract at the new rate.
//   4. Vendor sees the resolution; UPHOLD also flows forward unchanged.
//   5. On a split award, a sibling who already signed is never disturbed.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";
import { ensureApprovable } from "../../helpers/arcApproverPerms.js";

const HC     = IDS.hospitality.A;
const HOTEL  = IDS.hotels.A1;
const DEPT   = IDS.departments.proc;
const PROC   = IDS.processes.A_P1;
const BUYER  = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const TECH_POLICY_ID = 64922;
const COMMITTEE_POLICY_ID = 64923;

const snapOf = (v) => (typeof v === "string" ? JSON.parse(v) : v || {});

describe("ARC — vendor contract clarification loop (surgical)", () => {
  let buyerClient, vendorClient;
  let arcId, itemId, quoteLineId, contractId, lineId;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [VENDOR]);
    buyerClient = await httpClient(BUYER);
    vendorClient = await httpClient(VENDOR);
    await seedArcEvalPerms(db, [BUYER]);

    for (const [pid, entity] of [[TECH_POLICY_ID, "ARC_TECH"], [COMMITTEE_POLICY_ID, "ARC_COMMITTEE"]]) {
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
         VALUES ($1, 1, 'ANY', 'USER', $2)`,
        [pid, BUYER]
      );
    }
    // BUYER is the sole USER-source approver on both ARC_TECH and ARC_COMMITTEE
    // steps above — grant read+approve on their mapped resources at the ARC's
    // own hotel+department.
    await ensureApprovable(db, BUYER, "arc-tech", HC, HOTEL, DEPT);
    await ensureApprovable(db, BUYER, "arc-committee", HC, HOTEL, DEPT);

    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-CLARIFY-1', 'Clarification loop', $1, $2, $3, $4, $5, 'submission_closed',
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

    const te = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [itemId]);
    const clause = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1, 'Spec compliance', 10, 'compliance') RETURNING id`, [te.id]);
    await db.none(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
         (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response, buyer_id, buyer_marks)
       VALUES ($1, $2, 'Attached', $3, 8)`, [clause.id, VENDOR, BUYER]);

    await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/submit`).send({});
    await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [{
        awarded_vendor_id: VENDOR, awarded_quote_line_id: quoteLineId,
        allocated_qty: 500, allocated_share_pct: 100, l_rank: "L1", is_l1_default: true,
        awarded_quote_snapshot: { rate: 90, gst_pct: 5 },
      }],
    });
    await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/finalize`).send({});

    contractId = (await db.one(
      `SELECT id FROM tbl_arc_contract WHERE arc_id = $1 AND vendor_id = $2`, [arcId, VENDOR])).id;
    lineId = (await db.one(
      `SELECT id FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId])).id;
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
    for (const pid of [TECH_POLICY_ID, COMMITTEE_POLICY_ID]) {
      await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [pid]);
      await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [pid]);
    }
    await db.none(`DELETE FROM tbl_arc_contract_clarification WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = $1)`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  test("fixture reached a generated contract at the quoted rate", async () => {
    const contract = await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    expect(contract.status).toBe("awaiting_acceptance");
    const line = await db.one(`SELECT unit_rate FROM tbl_arc_contract_line WHERE id = $1`, [lineId]);
    expect(Number(line.unit_rate)).toBe(90);
  });

  test("raising a clarification parks the contract WITHOUT de-finalizing the award", async () => {
    const res = await vendorClient
      .post(`/api/v1/arc-v2/vendor/contracts/${contractId}/clarification`)
      .send({ items: [{ arc_contract_line_id: lineId, field: "base_price", comment: "FOB rate too low — please revise to ₹95." }] });
    expect(res.status).toBe(200);

    const contract = await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    expect(contract.status).toBe("clarification");

    // The award is NOT reversed: commercial still finalized, committee still
    // approved, ARC still awaiting acceptance.
    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arc.status).toBe("awaiting_vendor_acceptance");
    const committee = await db.one(
      `SELECT status FROM tbl_approval_instances
        WHERE entity_type = 'ARC_COMMITTEE' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1`, [arcId]);
    expect(committee.status).toBe("APPROVED");
    const comm = await db.one(`SELECT status FROM tbl_arc_comm_evaluation WHERE arc_id = $1`, [arcId]);
    expect(comm.status).toBe("finalized");

    // Lifecycle keeps commercial COMPLETE but flags it and routes the buyer there.
    const lc = await buyerClient.get(`/api/v1/arc-v2/${arcId}/lifecycle`);
    const commStage = lc.body.data.stages.find((s) => s.key === "commercial");
    expect(commStage.state).toBe("complete");
    expect(commStage.clarifications_open).toBe(1);
    expect(lc.body.data.default_stage).toBe("commercial");
  });

  test("the allocation matrix stays locked and signing is blocked", async () => {
    // No re-allocation / vendor deselection — the matrix is immutable.
    const alloc = await buyerClient.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [{ awarded_vendor_id: VENDOR, awarded_quote_line_id: quoteLineId, allocated_qty: 500, allocated_share_pct: 100, awarded_quote_snapshot: { rate: 90 } }],
    });
    expect(alloc.status).toBe(409);
    expect(alloc.body.code).toBe("STAGE_IMMUTABLE");

    const otp = await vendorClient.post(`/api/v1/arc-v2/vendor/contracts/${contractId}/otp/request`).send({});
    expect(otp.status).toBe(409);
  });

  test("getCommEval surfaces the open clarification to the evaluator", async () => {
    const ce = await buyerClient.get(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval`);
    expect(ce.status).toBe(200);
    expect(ce.body.data.clarifications.length).toBe(1);
    expect(ce.body.data.clarifications[0]).toMatchObject({ field: "base_price", status: "open" });
    expect(Number(ce.body.data.clarifications[0].vendor_id)).toBe(VENDOR);
  });

  test("buyer revises → scoped award edit + re-approval regenerates the contract at the new rate", async () => {
    const ce = await buyerClient.get(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval`);
    const clarId = ce.body.data.clarifications[0].id;

    const rev = await buyerClient
      .post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/clarification/${clarId}/revise`)
      .send({ value: 95, response: "Agreed — ₹95 to reflect inland freight." });
    expect(rev.status).toBe(200);
    expect(rev.body.data.open_remaining).toBe(0);

    // Scoped award edit + clarification resolved.
    const award = await db.one(
      `SELECT awarded_quote_snapshot FROM tbl_arc_comm_evaluation_award
        WHERE arc_item_id = $1 AND awarded_vendor_id = $2`, [itemId, VENDOR]);
    expect(Number(snapOf(award.awarded_quote_snapshot).rate)).toBe(95);
    const cl = await db.one(`SELECT status FROM tbl_arc_contract_clarification WHERE id = $1`, [clarId]);
    expect(cl.status).toBe("revised");

    // Resolving the last one re-routes through the committee (auto-approved here)
    // and regenerates the contract for re-acceptance at the revised rate.
    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arc.status).toBe("awaiting_vendor_acceptance");
    const contract = await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    expect(contract.status).toBe("awaiting_acceptance");
    const line = await db.one(`SELECT id, unit_rate FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
    expect(Number(line.unit_rate)).toBe(95);
    expect(Number(line.id)).toBe(Number(lineId)); // idempotent regeneration keeps the line id
  });

  test("vendor sees the resolved clarification on re-review", async () => {
    const detail = await vendorClient.get(`/api/v1/arc-v2/vendor/contracts/${contractId}`);
    expect(detail.status).toBe(200);
    const resolved = detail.body.data.clarifications.find((c) => c.field === "base_price");
    expect(resolved.status).toBe("revised");
    expect(Number(resolved.new_value)).toBe(95);
    expect(resolved.buyer_response).toMatch(/95/);
  });

  test("UPHOLD path: re-award fires, contract regenerates unchanged", async () => {
    const before = await db.one(`SELECT payment_terms FROM tbl_arc_contract_line WHERE id = $1`, [lineId]);

    const raise = await vendorClient
      .post(`/api/v1/arc-v2/vendor/contracts/${contractId}/clarification`)
      .send({ items: [{ arc_contract_line_id: lineId, field: "payment_terms", comment: "Need Net 30 not Net 45." }] });
    expect(raise.status).toBe(200);
    expect((await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [contractId])).status).toBe("clarification");

    const ce = await buyerClient.get(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval`);
    const clarId = ce.body.data.clarifications.find((c) => c.field === "payment_terms").id;

    const uphold = await buyerClient
      .post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/clarification/${clarId}/uphold`)
      .send({ response: "Net 45 is the category standard and stands per the tender." });
    expect(uphold.status).toBe(200);
    expect(uphold.body.data.open_remaining).toBe(0);

    const after = await db.one(`SELECT payment_terms FROM tbl_arc_contract_line WHERE id = $1`, [lineId]);
    expect(after.payment_terms).toBe(before.payment_terms);
    const contract = await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    expect(contract.status).toBe("awaiting_acceptance");
    const cl = await db.one(`SELECT status FROM tbl_arc_contract_clarification WHERE id = $1`, [clarId]);
    expect(cl.status).toBe("upheld");
  });

  test("a signed (active) contract refuses further clarifications", async () => {
    const otp = await vendorClient.post(`/api/v1/arc-v2/vendor/contracts/${contractId}/otp/request`).send({});
    expect(otp.status).toBe(200);
    const verify = await vendorClient.post(`/api/v1/arc-v2/vendor/contracts/${contractId}/otp/verify`).send({ code: otp.body.data.dev_code });
    expect(verify.body.data.contract.status).toBe("active");

    const late = await vendorClient
      .post(`/api/v1/arc-v2/vendor/contracts/${contractId}/clarification`)
      .send({ items: [{ arc_contract_line_id: lineId, field: "gst", comment: "too late" }] });
    expect(late.status).toBe(409);
  });
});

// ── Split award: one vendor's clarification must NOT disturb a sibling who
//    already signed. The signed contract is immutable; regeneration skips it.
describe("ARC — clarification on a split award preserves a signed sibling", () => {
  const VENDOR_B = IDS.users.vendor_beta;
  const TECH_PID = 64924;
  const COMM_PID = 64925;
  let buyerC, vendorAC, vendorBC;
  let arcId, itemId, qlA, qlB, contractA, contractB, lineA;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id IN ($1, $2)`, [VENDOR, VENDOR_B]);
    buyerC = await httpClient(BUYER);
    vendorAC = await httpClient(VENDOR);
    vendorBC = await httpClient(VENDOR_B);
    await seedArcEvalPerms(db, [BUYER]);

    for (const [pid, entity] of [[TECH_PID, "ARC_TECH"], [COMM_PID, "ARC_COMMITTEE"]]) {
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
         VALUES ($1, 1, 'ANY', 'USER', $2)`,
        [pid, BUYER]
      );
    }
    // Same USER-source approver grant as the first describe block above — this
    // is a separate suite-level fixture role/scope keyed by (user, role,
    // company, hotel, dept), so re-granting here is idempotent (ON CONFLICT).
    await ensureApprovable(db, BUYER, "arc-tech", HC, HOTEL, DEPT);
    await ensureApprovable(db, BUYER, "arc-committee", HC, HOTEL, DEPT);

    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-CLARIFY-SPLIT', 'Split clarify', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '10 days', NOW() + INTERVAL '180 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;

    // One item split 50/50 between vendor A and B → two separate contracts.
    itemId = (await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, 1, 1000, 'litre') RETURNING id`, [arcId])).id;

    const mkQuote = async (vendor, rate) => {
      const q = await db.one(
        `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at) VALUES ($1, $2, NOW()) RETURNING *`,
        [arcId, vendor]);
      return (await db.one(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
         VALUES ($1, $2, $3, 5) RETURNING id`, [q.id, itemId, rate])).id;
    };
    qlA = await mkQuote(VENDOR, 90);
    qlB = await mkQuote(VENDOR_B, 70);

    const te = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [itemId]);
    const clause = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1, 'Spec', 10, 'compliance') RETURNING id`, [te.id]);
    for (const v of [VENDOR, VENDOR_B]) {
      await db.none(
        `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
           (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response, buyer_id, buyer_marks)
         VALUES ($1, $2, 'Attached', $3, 8)`, [clause.id, v, BUYER]);
    }

    await buyerC.post(`/api/v1/arc-v2/evaluation/${arcId}/tech-eval/submit`).send({});
    await buyerC.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [
        { awarded_vendor_id: VENDOR,   awarded_quote_line_id: qlA, allocated_qty: 500, allocated_share_pct: 50, l_rank: "L2", is_l1_default: false, awarded_quote_snapshot: { rate: 90, gst_pct: 5 } },
        { awarded_vendor_id: VENDOR_B, awarded_quote_line_id: qlB, allocated_qty: 500, allocated_share_pct: 50, l_rank: "L1", is_l1_default: true,  awarded_quote_snapshot: { rate: 70, gst_pct: 5 } },
      ],
    });
    await buyerC.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/finalize`).send({});

    contractA = (await db.one(`SELECT id FROM tbl_arc_contract WHERE arc_id = $1 AND vendor_id = $2`, [arcId, VENDOR])).id;
    contractB = (await db.one(`SELECT id FROM tbl_arc_contract WHERE arc_id = $1 AND vendor_id = $2`, [arcId, VENDOR_B])).id;
    lineA = (await db.one(`SELECT id FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractA])).id;
  });

  afterAll(async () => {
    const instanceIds = (await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type IN ('ARC_TECH','ARC_COMMITTEE') AND entity_id = $1`, [arcId]
    )).map((r) => r.id);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    for (const pid of [TECH_PID, COMM_PID]) {
      await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [pid]);
      await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [pid]);
    }
    await db.none(`DELETE FROM tbl_arc_contract_clarification WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = $1)`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  test("vendor B signs; vendor A clarifies; B's signed contract is preserved", async () => {
    // Vendor B signs their contract.
    const otp = await vendorBC.post(`/api/v1/arc-v2/vendor/contracts/${contractB}/otp/request`).send({});
    const verify = await vendorBC.post(`/api/v1/arc-v2/vendor/contracts/${contractB}/otp/verify`).send({ code: otp.body.data.dev_code });
    expect(verify.body.data.contract.status).toBe("active");

    // Vendor A raises a clarification — allowed despite the signed sibling.
    const raise = await vendorAC.post(`/api/v1/arc-v2/vendor/contracts/${contractA}/clarification`)
      .send({ items: [{ arc_contract_line_id: lineA, field: "base_price", comment: "Need ₹95." }] });
    expect(raise.status).toBe(200);

    // CE revises A's rate → re-approval regenerates only A's contract.
    const ce = await buyerC.get(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval`);
    const clarId = ce.body.data.clarifications[0].id;
    const rev = await buyerC.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/clarification/${clarId}/revise`).send({ value: 95 });
    expect(rev.status).toBe(200);

    // Vendor B's signed contract is untouched; vendor A's regenerated at ₹95.
    const cB = await db.one(`SELECT status, signed_by_vendor_at FROM tbl_arc_contract WHERE id = $1`, [contractB]);
    expect(cB.status).toBe("active");
    expect(cB.signed_by_vendor_at).not.toBeNull();
    const lineBRate = await db.one(`SELECT unit_rate FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractB]);
    expect(Number(lineBRate.unit_rate)).toBe(70);

    const cA = await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [contractA]);
    expect(cA.status).toBe("awaiting_acceptance");
    const lineARate = await db.one(`SELECT unit_rate FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractA]);
    expect(Number(lineARate.unit_rate)).toBe(95);
  });
});
