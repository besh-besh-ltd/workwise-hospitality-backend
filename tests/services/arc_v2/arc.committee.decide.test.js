// ARC committee — view gating + decide endpoint over real HTTP.
//
// Proves:
//   1. getCommitteeView returns the full approval chain (steps, approver
//      names, statuses, comments) and a per-caller `can_user_approve` flag —
//      true only for the CURRENT pending approver.
//   2. POST /committee/:arcId/decide walks the chain through the engine:
//      non-approvers are rejected, send-back demands a comment, step-1
//      approval advances to step 2, and the final approval fires the hooks —
//      contracts generated per awarded vendor + ARC → awaiting_vendor_acceptance.
//   3. A committee rejection (send-back) flips the ARC to committee_sent_back
//      and re-opens commercial evaluation.
//   4. Vendors can't reach the committee surface at all (ACL).

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { createApprovalInstance } from "../../../app/models/generalModel.js";
import { ensureArcApprovable } from "../../helpers/arcApproverPerms.js";

const HC     = IDS.hospitality.A;
const HOTEL  = IDS.hotels.A1;
const DEPT   = IDS.departments.proc;
const PROC   = IDS.processes.A_P1;
const BUYER  = IDS.users.a1_proc_buyer;     // buyer, NOT on the committee
const APPROVER1 = IDS.users.a1_proc_techApp;
const APPROVER2 = IDS.users.a1_proc_finance;
const VENDOR = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const POLICY_ID = 64902;

describe("ARC committee — chain visibility, approver gating, decide endpoint", () => {
  let buyerClient, approver1Client, approver2Client, vendorClient;
  const arcs = {}; // key → { arcId, commId }

  async function seedCommitteeArc(key, number, variantId) {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          payment_terms_expected, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'committee_review',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               'Net 30', $8) RETURNING *`,
      [number, `Committee decide ${key}`, CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 500, 'litre', 100) RETURNING *`, [arc.id, variantId]);
    const quote = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, payment_terms)
       VALUES ($1, $2, NOW(), 'Net 30') RETURNING *`, [arc.id, VENDOR]);
    const quoteLine = await db.one(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
       VALUES ($1, $2, 90, 5) RETURNING *`, [quote.id, item.id]);
    const comm = await db.one(
      `INSERT INTO tbl_arc_comm_evaluation (arc_id, status, finalized_at)
       VALUES ($1, 'finalized', NOW()) RETURNING *`, [arc.id]);
    await db.none(
      `INSERT INTO tbl_arc_comm_evaluation_award
         (arc_comm_evaluation_id, arc_item_id, awarded_vendor_id,
          awarded_quote_line_id, allocated_qty, l_rank, is_l1_default, awarded_quote_snapshot)
       VALUES ($1, $2, $3, $4, 500, 'L1', true, $5::jsonb)`,
      [comm.id, item.id, VENDOR, quoteLine.id,
       JSON.stringify({ rate: 90, gst_pct: 5, payment_terms: "Net 30" })]
    );
    // Approval instance through the engine, pinned to our 2-step policy.
    const engineResult = await createApprovalInstance({
      entity_type: "ARC_COMMITTEE",
      entity_id: arc.id,
      hospitality_company_id: HC,
      hotel_id: HOTEL,
      department_id: DEPT,
      process_id: PROC,
      approval_policy_id: POLICY_ID,
      initiated_by: BUYER,
      metadata: {},
    });
    arcs[key] = { arcId: arc.id, commId: comm.id, instanceId: engineResult.instance.id };
    return arcs[key];
  }

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id IN ($1, $2, $3)`,
      [BUYER, APPROVER1, APPROVER2]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [VENDOR]);
    buyerClient     = await httpClient(BUYER);
    approver1Client = await httpClient(APPROVER1);
    approver2Client = await httpClient(APPROVER2);
    vendorClient    = await httpClient(VENDOR);

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
       VALUES ($1, 1, 'ALL', 'USER', $2), ($1, 2, 'ALL', 'USER', $3)`,
      [POLICY_ID, APPROVER1, APPROVER2]
    );
    // APPROVER1/APPROVER2 are named via ('USER', ...) on the two steps —
    // permission-gated at instance creation (seedCommitteeArc below).
    await ensureArcApprovable(db, [APPROVER1, APPROVER2], HC);

    await seedCommitteeArc("approve", "ARC-TEST-CMTE-1", 1);
    await seedCommitteeArc("sendback", "ARC-TEST-CMTE-2", 2);
  });

  afterAll(async () => {
    const arcIds = Object.values(arcs).map((a) => a.arcId);
    const instanceIds = Object.values(arcs).map((a) => a.instanceId);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_comm_evaluation_award WHERE arc_comm_evaluation_id IN (SELECT id FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::bigint[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [arcIds]);
  });

  test("vendors cannot reach the committee surface", async () => {
    const view = await vendorClient.get(`/api/v1/arc-v2/committee/${arcs.approve.arcId}`);
    expect(view.status).toBe(403);
    const act = await vendorClient.post(`/api/v1/arc-v2/committee/${arcs.approve.arcId}/decide`).send({ decision: "approve" });
    expect(act.status).toBe(403);
  });

  test("view exposes the full chain with names, and can_user_approve is per-caller", async () => {
    const asApprover1 = await approver1Client.get(`/api/v1/arc-v2/committee/${arcs.approve.arcId}`);
    expect(asApprover1.status).toBe(200);
    const approval = asApprover1.body.data.approval;
    expect(approval).toBeTruthy();
    expect(approval.total_steps).toBe(2);
    expect(approval.current_step).toBe(1);
    expect(approval.can_user_approve).toBe(true);
    // Names are visible buyer-side.
    const allNames = approval.steps.flatMap((s) => s.approvers.map((a) => a.user_name));
    expect(allNames.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    // Hero context joined in.
    expect(asApprover1.body.data.arc.category_title).toBeTruthy();
    expect(asApprover1.body.data.arc.hotel_name).toBeTruthy();

    // A buyer who is not on the committee sees the chain but cannot act.
    const asBuyer = await buyerClient.get(`/api/v1/arc-v2/committee/${arcs.approve.arcId}`);
    expect(asBuyer.status).toBe(200);
    expect(asBuyer.body.data.approval.can_user_approve).toBe(false);

    // Step-2 approver is not the CURRENT approver yet.
    const asApprover2 = await approver2Client.get(`/api/v1/arc-v2/committee/${arcs.approve.arcId}`);
    expect(asApprover2.body.data.approval.can_user_approve).toBe(false);
  });

  test("send-back demands a comment; non-approvers are stopped by the engine", async () => {
    const noComment = await approver1Client
      .post(`/api/v1/arc-v2/committee/${arcs.approve.arcId}/decide`)
      .send({ decision: "reject" });
    expect(noComment.status).toBe(400);
    expect(noComment.body.message).toMatch(/comment|reason/i);

    const outsider = await buyerClient
      .post(`/api/v1/arc-v2/committee/${arcs.approve.arcId}/decide`)
      .send({ decision: "approve" });
    expect(outsider.status).toBeGreaterThanOrEqual(400);

    const still = await db.one(
      `SELECT status, current_step FROM tbl_approval_instances WHERE id = $1`,
      [arcs.approve.instanceId]
    );
    expect(still.status).toBe("PENDING");
    expect(still.current_step).toBe(1);
  });

  test("two-step approval walks the chain and the final approval generates contracts", async () => {
    const s1 = await approver1Client
      .post(`/api/v1/arc-v2/committee/${arcs.approve.arcId}/decide`)
      .send({ decision: "approve", comment: "Within budget envelope" });
    expect(s1.status).toBe(200);
    expect(s1.body.data.approval.status).toBe("PENDING");
    expect(s1.body.data.approval.current_step).toBe(2);

    // Step-1's comment is now visible in the chain for everyone.
    const view = await buyerClient.get(`/api/v1/arc-v2/committee/${arcs.approve.arcId}`);
    expect(JSON.stringify(view.body.data.approval.steps)).toMatch(/Within budget envelope/);
    // And now approver2 IS the current approver.
    const asApprover2 = await approver2Client.get(`/api/v1/arc-v2/committee/${arcs.approve.arcId}`);
    expect(asApprover2.body.data.approval.can_user_approve).toBe(true);

    const s2 = await approver2Client
      .post(`/api/v1/arc-v2/committee/${arcs.approve.arcId}/decide`)
      .send({ decision: "approve" });
    expect(s2.status).toBe(200);
    expect(s2.body.data.approval.status).toBe("APPROVED");

    // Hooks fired: contracts generated per awarded vendor, ARC advanced.
    const contracts = await db.any(`SELECT * FROM tbl_arc_contract WHERE arc_id = $1`, [arcs.approve.arcId]);
    expect(contracts.length).toBe(1);
    expect(contracts[0].vendor_id).toBe(VENDOR);
    const arcRow = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcs.approve.arcId]);
    expect(arcRow.status).toBe("awaiting_vendor_acceptance");

    // No further decisions allowed.
    const again = await approver1Client
      .post(`/api/v1/arc-v2/committee/${arcs.approve.arcId}/decide`)
      .send({ decision: "approve" });
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/APPROVED/);
  });

  test("committee send-back re-opens commercial evaluation", async () => {
    const res = await approver1Client
      .post(`/api/v1/arc-v2/committee/${arcs.sendback.arcId}/decide`)
      .send({ decision: "reject", comment: "L2 share too thin — rebalance the split" });
    expect(res.status).toBe(200);
    expect(res.body.data.approval.status).toBe("REJECTED");

    const arcRow = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcs.sendback.arcId]);
    expect(arcRow.status).toBe("committee_sent_back");
    const comm = await db.one(`SELECT status FROM tbl_arc_comm_evaluation WHERE id = $1`, [arcs.sendback.commId]);
    expect(comm.status).toBe("sent_back");
    // No contracts were generated on the rejected path.
    const contracts = await db.any(`SELECT * FROM tbl_arc_contract WHERE arc_id = $1`, [arcs.sendback.arcId]);
    expect(contracts.length).toBe(0);
  });
});
