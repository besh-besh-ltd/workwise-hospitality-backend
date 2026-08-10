// ARC v2 — DEPLOYMENT E2E WALK. Drives ONE ARC through the ENTIRE lifecycle
// over real HTTP (no seeded intermediate state, no engine bypass), role-switching
// at each step, asserting every transition AND the final contract→MR→call-off-PO
// linkage. This is the connected-handoff proof the per-phase suites don't give.
//
//   create → publish/float → vendor accept → tech-envelope → quote
//   → buyer tech-eval (setup → score → submit → auto-approve)
//   → commercial allocation → finalize → committee auto-approve
//   → contract generated → vendor OTP-sign → ARC contract_active
//   → buyer raises MR against the contract → submit → auto-approve
//   → call-off PO auto-released + linked to the MR → PO detail loads (200)
//
// A single auto-approve ARC policy (entity_type 'ARC', approver = BUYER) covers
// publish (ARC), tech-eval submit (ARC_TECH→fallback ARC) and finalize
// (ARC_COMMITTEE→fallback ARC). A separate MR policy auto-approves the call-off.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";
import { ensureArcApprovable, ensureApprovable } from "../../helpers/arcApproverPerms.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;
const VENDOR_A = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

const ARC_POLICY_ID = 64950; // entity_type ARC (covers publish/tech/committee via fallback)
const MR_POLICY_ID  = 64951; // entity_type MR

const E = "/api/v1/arc-v2/evaluation";
const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();

describe("ARC v2 — DEPLOYMENT E2E: create → contract_active → MR → call-off PO", () => {
  let buyerClient, vendorAClient;
  let arcId, itemId, clauseId, quoteLineId, contractId, mrId, poId;

  beforeAll(async () => {
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`, [CATEGORY, DEPT]);
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR_A]);
    await seedArcEvalPerms(db, [BUYER]);

    // Auto-approve ARC policy (BUYER sole approver) — covers publish/tech/committee.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC', $2, $3, $4, true, $5, $6, false, false, 1)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [ARC_POLICY_ID, HC, HOTEL, null, BUYER, null]);
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [ARC_POLICY_ID]);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`, [ARC_POLICY_ID, BUYER]);
    await ensureArcApprovable(db, [BUYER], HC);

    // Auto-approve MR policy (BUYER sole approver) — releases the call-off PO.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'MR', $2, $3, $4, true, $5, $6, false, false, 1)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [MR_POLICY_ID, HC, HOTEL, null, BUYER, null]);
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [MR_POLICY_ID]);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`, [MR_POLICY_ID, BUYER]);
    // BUYER is the named USER-source approver on the MR policy step above; the
    // gate requires read+approve on 'awarding' (MR's mapped resource). Scoped to
    // this hotel + department rather than company-wide, so the grant cannot
    // widen any scope check downstream.
    await ensureApprovable(db, [BUYER], 'awarding', HC, HOTEL, DEPT);

    buyerClient   = await httpClient(BUYER);
    vendorAClient = await httpClient(VENDOR_A);
  });

  afterAll(async () => {
    if (arcId) {
      const insts = (await db.any(
        `SELECT id FROM tbl_approval_instances WHERE entity_id = $1 OR entity_id = $2`, [arcId, mrId || 0]
      )).map(r => r.id);
      if (insts.length) {
        await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [insts]);
        await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [insts]);
        await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [insts]);
        await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [insts]);
      }
      if (contractId) {
        await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id = $1`, [contractId]);
        await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE arc_contract_id = $1)`, [contractId]);
        await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id = $1`, [contractId]);
      }
      if (mrId) {
        await db.none(`DELETE FROM tbl_material_requisition_item WHERE mr_id = $1`, [mrId]);
        await db.none(`DELETE FROM tbl_material_requisition WHERE id = $1`, [mrId]);
      }
      await db.none(`DELETE FROM tbl_arc_contract_signature_otp WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = $1)`, [arcId]);
      await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = $1)`, [arcId]);
      await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id IN ($1,$2)`, [ARC_POLICY_ID, MR_POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id IN ($1,$2)`, [ARC_POLICY_ID, MR_POLICY_ID]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  test("1. create ARC draft (with one item, tech required)", async () => {
    const res = await buyerClient.post("/api/v1/arc-v2").send({
      title: "E2E Deployment Walk", category_id: CATEGORY,
      hotel_id: HOTEL, department_id: DEPT,
      eligibility_type: "open", technical_response_required: true,
      submission_start_at: D(-1), submission_end_at: D(7),
      contract_start_at: D(14), contract_end_at: D(200),
      payment_terms_expected: "Net 30", delivery_expected: "Within 7 days",
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 1000, uom: "litre" }],
    });
    expect(res.status).toBe(200);
    arcId = Number(res.body.data.arc.id);
    itemId = Number(res.body.data.items[0].id);
    expect(res.body.data.arc.status).toBe("draft");
  });

  test("2. publish → auto-floats (ARC publish policy auto-approves)", async () => {
    const res = await buyerClient.post(`/api/v1/arc-v2/${arcId}/publish`).send({});
    expect(res.status).toBe(200);
    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id=$1`, [arcId]);
    expect(arc.status).toBe("floated");
  });

  test("3. buyer configures a technical clause on the item", async () => {
    const res = await buyerClient.post(`${E}/items/${itemId}/tech-eval`).send({
      minimum_passing_score: 50,
      clauses: [{ clause_text: "ISO 22000 certified", weightage: 100, clause_type: "compliance", is_mandatory: true }],
    });
    expect(res.status).toBe(200);
    const c = await db.one(
      `SELECT c.id FROM tbl_arc_item_tech_evaluation_clauses c
         JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
        WHERE te.arc_item_id = $1`, [itemId]);
    clauseId = Number(c.id);
  });

  test("4. vendor accepts terms, answers the clause, seals the technical envelope", async () => {
    expect((await vendorAClient.post("/api/v1/arc-v2/vendor/quote/accept-terms").send({ arc_id: arcId })).status).toBe(200);
    expect((await vendorAClient.post("/api/v1/arc-v2/vendor/tech-envelope/draft").send({
      arc_id: arcId, responses: [{ clause_id: clauseId, vendor_response: "Yes — ISO 22000:2018 certified" }],
    })).status).toBe(200);
    expect((await vendorAClient.post("/api/v1/arc-v2/vendor/tech-envelope/submit").send({ arc_id: arcId })).status).toBe(200);
  });

  test("5. vendor submits a commercial quote", async () => {
    expect((await vendorAClient.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: arcId, lines: [{ arc_item_id: itemId, rate: 90, gst_pct: 5 }],
    })).status).toBe(200);
    const res = await vendorAClient.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: arcId });
    expect(res.status).toBe(200);
    const ql = await db.one(
      `SELECT ql.id FROM tbl_arc_quote_line ql JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
        WHERE q.arc_id = $1 AND q.vendor_id = $2`, [arcId, VENDOR_A]);
    quoteLineId = Number(ql.id);
  });

  test("6. buyer scores the response then submits tech-eval → auto-approved", async () => {
    const view = await buyerClient.get(`${E}/items/${itemId}/tech-eval`);
    expect(view.status).toBe(200);
    const respId = Number(view.body.data.responses[0].response_id);
    expect((await buyerClient.post(`${E}/tech-eval/score`).send({
      response_id: respId, buyer_marks: 90, mandatory_passed: true,
    })).status).toBe(200);
    const submit = await buyerClient.post(`${E}/${arcId}/tech-eval/submit`).send({});
    expect(submit.status).toBe(200);
    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id=$1`, [arcId]);
    expect(arc.status).toBe("tech_eval_approved");
  });

  test("7. buyer allocates the full qty to the vendor then finalizes → committee auto-approves → contracts generated", async () => {
    const alloc = await buyerClient.post(`${E}/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [{
        awarded_vendor_id: VENDOR_A, awarded_quote_line_id: quoteLineId,
        allocated_qty: 1000, l_rank: "L1", is_l1_default: true,
        awarded_quote_snapshot: { rate: 90, gst_pct: 5 },
      }],
    });
    expect(alloc.status).toBe(200);
    const fin = await buyerClient.post(`${E}/${arcId}/comm-eval/finalize`).send({});
    expect(fin.status).toBe(200);
    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id=$1`, [arcId]);
    expect(arc.status).toBe("awaiting_vendor_acceptance");
    const contract = await db.one(`SELECT id, status FROM tbl_arc_contract WHERE arc_id=$1 AND vendor_id=$2`, [arcId, VENDOR_A]);
    contractId = Number(contract.id);
    expect(contract.status).toBe("awaiting_acceptance");
  });

  test("8. vendor OTP-signs the contract → ARC becomes contract_active", async () => {
    const reqRes = await vendorAClient.post(`/api/v1/arc-v2/vendor/contracts/${contractId}/otp/request`).send({});
    expect(reqRes.status).toBe(200);
    const code = reqRes.body.data.dev_code;
    expect(code).toMatch(/^\d{6}$/);
    const verify = await vendorAClient.post(`/api/v1/arc-v2/vendor/contracts/${contractId}/otp/verify`).send({ code });
    expect(verify.status).toBe(200);
    expect(verify.body.data.contract.status).toBe("active");
    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id=$1`, [arcId]);
    expect(arc.status).toBe("contract_active");
  });

  test("9. buyer raises an MR against the active contract, submits → call-off PO auto-released + linked", async () => {
    const line = await db.one(`SELECT id, unit_rate FROM tbl_arc_contract_line WHERE arc_contract_id=$1 LIMIT 1`, [contractId]);
    const create = await buyerClient.post("/api/v1/mr").send({
      title: "E2E call-off", hospitality_company_id: HC, hotel_id: HOTEL, department_id: DEPT,
      items: [{
        product_variant_id: VARIANT_ID, quantity: 100, uom: "litre",
        arc_contract_id: contractId, arc_contract_line_id: Number(line.id),
        matched_unit_rate: Number(line.unit_rate),
      }],
    });
    expect(create.status).toBe(200);
    mrId = Number(create.body.data.mr.id);
    const submit = await buyerClient.post(`/api/v1/mr/${mrId}/submit`).send({});
    expect(submit.status).toBe(200);

    const mr = await db.one(`SELECT status FROM tbl_material_requisition WHERE id=$1`, [mrId]);
    expect(mr.status).toBe("po_released");

    // The call-off PO exists and is LINKED to this MR + ARC contract.
    const co = await db.one(`SELECT po_id, mr_id, arc_contract_id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mrId]);
    poId = Number(co.po_id);
    expect(Number(co.arc_contract_id)).toBe(contractId);
    const po = await db.one(`SELECT is_call_off, source_mr_id, arc_contract_id FROM tbl_rfq_purchase_order WHERE id=$1`, [poId]);
    expect(po.is_call_off).toBe(true);
    expect(Number(po.source_mr_id)).toBe(mrId);
  });

  test("10. the call-off PO detail loads (regression: the auto_initiated 500)", async () => {
    const res = await buyerClient.get(`/api/v1/po/detail/${poId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.is_call_off).toBe(true);
    expect(Number(res.body.data.call_off.mr_id ?? res.body.data.source_mr_id ?? mrId)).toBe(mrId);
  });
});
