// ARC amendment addendum — coverage for the paths the happy-path suite skips:
//   1. item_add  → addendum → sign  (a type the main suite doesn't exercise)
//   2. item_remove → addendum → sign
//   3. sign AFTER the window already closed → 'ended' (no overlay), not 'live'
//   4. wrong OTP → 400, addendum stays awaiting (no accidental sign)
//   5. the GENERIC central-engine approval hook (handleArcAmendmentApproval),
//      not just POST /review, parks the amendment + generates the addendum
//   6. decline frees the line — a fresh amendment can be raised after a void
//
// Real-HTTP over the live middleware; PDF/S3 is skipped under NODE_ENV=test
// (content-hash fallback), so document_hash is always present.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { resolveCurrentPrice } from "../../../app/services/arcPricingResolver.js";
import { submitApprovalAction } from "../../../app/models/generalModel.js";
import { handleArcAmendmentApproval } from "../../../app/controllers/arc_v2/arcAmendmentController.js";

const HC = IDS.hospitality.A, HOTEL = IDS.hotels.A1, DEPT = IDS.departments.proc, PROC = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer, APPROVER = IDS.users.a1_proc_techApp, VENDOR = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const POLICY_ID = 64903;

const dIso = (off) => { const d = new Date(Date.now() + off * 86400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const getAm = (id) => db.one(`SELECT * FROM tbl_arc_amendment WHERE id = $1`, [id]);
const addendumOf = (amId) => db.oneOrNone(`SELECT * FROM tbl_arc_amendment_document WHERE arc_amendment_id = $1`, [amId]);

describe("ARC amendment addendum — coverage (types, edges, hook)", () => {
  let vendorClient, approverClient;
  let arcId, contractId, lineA, lineB, lineC, lineD, lineE;

  const approve = (amId) => approverClient.post(`/api/v1/arc-v2/amendments/${amId}/review`).send({ decision: "approve" });
  async function sign(addendumId) {
    const otp = await vendorClient.post(`/api/v1/arc-v2/vendor/addendums/${addendumId}/otp/request`).send({});
    return vendorClient.post(`/api/v1/arc-v2/vendor/addendums/${addendumId}/otp/verify`).send({ code: otp.body.data.dev_code });
  }

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [VENDOR]);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [APPROVER]);
    vendorClient = await httpClient(VENDOR);
    approverClient = await httpClient(APPROVER);

    const arc = await db.one(
      `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-ADDM-COV', 'Addendum coverage ARC', $1, $2, $3, $4, $5, 'contract_active',
          NOW() - INTERVAL '40 days', NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days', (NOW() + INTERVAL '180 days')::date, $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    arcId = arc.id;
    const mkLine = async (variant, rate, qty) => {
      const item = await db.one(`INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, $3, 'unit') RETURNING *`, [arcId, variant, qty]);
      return (await db.one(`INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty) VALUES ($1, $2, $3, 5, $4) RETURNING id`, [contractId, item.id, rate, qty])).id;
    };
    const contract = await db.one(`INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, document_hash) VALUES ($1, $2, 'active', 'ORIG-COV') RETURNING *`, [arcId, VENDOR]);
    contractId = contract.id;
    lineA = await mkLine(1, 100, 500);
    lineB = await mkLine(2, 100, 200);
    lineC = await mkLine(3, 100, 300);
    lineD = await mkLine(4, 100, 400);
    lineE = await mkLine(5, 100, 250);

    await db.none(`INSERT INTO tbl_approval_policies (id, entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_AMENDMENT', $2, $3, NULL, true, $4, $5, false, false, 1) ON CONFLICT (id) DO NOTHING`, [POLICY_ID, HC, HOTEL, BUYER, PROC]);
    await db.none(`INSERT INTO tbl_approval_policy_steps (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id) VALUES ($1, 1, 'ALL', 'USER', $2)`, [POLICY_ID, APPROVER]);
  });

  afterAll(async () => {
    const inst = (await db.any(`SELECT approval_instance_id AS id FROM tbl_arc_amendment WHERE arc_contract_id = $1 AND approval_instance_id IS NOT NULL`, [contractId])).map((r) => r.id);
    await db.none(`DELETE FROM tbl_arc_contract_signature_otp WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_amendment_document WHERE arc_amendment_id IN (SELECT id FROM tbl_arc_amendment WHERE arc_contract_id = $1)`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_amendment WHERE arc_contract_id = $1`, [contractId]);
    if (inst.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [inst]);
      await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [inst]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [inst]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inst]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  });

  test("item_add flows through addendum → sign → live", async () => {
    const req = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "item_add",
      amendment_from: dIso(0), amendment_to: dIso(60), reason: "Add seasonal SKU",
      payload: { product_variant_id: 7, new_qty: 120, new_rate: 75 },
    });
    expect(req.status).toBe(200);
    const amId = req.body.data.amendment.id;
    expect((await approve(amId)).body.data.amendment.status).toBe("awaiting_signature");
    const doc = await addendumOf(amId);
    expect(doc.status).toBe("awaiting_signature");
    expect((await sign(doc.id)).status).toBe(200);
    expect((await getAm(amId)).status).toBe("live");
    expect((await db.one(`SELECT status FROM tbl_arc_amendment_document WHERE id=$1`, [doc.id])).status).toBe("signed");
  });

  test("item_remove flows through addendum → sign → live", async () => {
    const req = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "item_remove",
      amendment_from: dIso(0), reason: "Discontinue line",
      payload: { arc_contract_line_id: lineA },
    });
    expect(req.status).toBe(200);
    const amId = req.body.data.amendment.id;
    expect((await approve(amId)).body.data.amendment.status).toBe("awaiting_signature");
    const doc = await addendumOf(amId);
    expect((await sign(doc.id)).status).toBe(200);
    expect((await getAm(amId)).status).toBe("live");
  });

  test("signing after the window already closed → 'ended', no overlay applied", async () => {
    const req = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "price",
      amendment_from: dIso(-20), amendment_to: dIso(-1), reason: "Backdated (already lapsed)",
      payload: { arc_contract_line_id: lineB, new_rate: 999 },
    });
    expect(req.status).toBe(200);
    const amId = req.body.data.amendment.id;
    expect((await approve(amId)).body.data.amendment.status).toBe("awaiting_signature");
    const doc = await addendumOf(amId);
    expect((await sign(doc.id)).status).toBe(200);
    // Window is in the past → bind resolves to 'ended', not 'live'.
    expect((await getAm(amId)).status).toBe("ended");
    // Addendum is still recorded as signed.
    expect((await db.one(`SELECT status FROM tbl_arc_amendment_document WHERE id=$1`, [doc.id])).status).toBe("signed");
    // No overlay today (window lapsed) — original rate stands.
    const priced = await resolveCurrentPrice(lineB, new Date());
    expect(Number(priced.unit_rate)).toBe(100);
  });

  test("wrong OTP → 400, addendum stays awaiting (no accidental sign)", async () => {
    const req = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "price",
      amendment_from: dIso(0), amendment_to: dIso(60), reason: "Uplift",
      payload: { arc_contract_line_id: lineC, new_rate: 130 },
    });
    const amId = req.body.data.amendment.id;
    await approve(amId);
    const doc = await addendumOf(amId);
    await vendorClient.post(`/api/v1/arc-v2/vendor/addendums/${doc.id}/otp/request`).send({});
    const bad = await vendorClient.post(`/api/v1/arc-v2/vendor/addendums/${doc.id}/otp/verify`).send({ code: "000000" });
    expect(bad.status).toBe(400);
    expect((await db.one(`SELECT status FROM tbl_arc_amendment_document WHERE id=$1`, [doc.id])).status).toBe("awaiting_signature");
    expect((await getAm(amId)).status).toBe("awaiting_signature");
  });

  test("generic central-engine approval hook generates the addendum (not just /review)", async () => {
    const req = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "price",
      amendment_from: dIso(0), amendment_to: dIso(60), reason: "Via central approvals UI",
      payload: { arc_contract_line_id: lineD, new_rate: 140 },
    });
    const amId = req.body.data.amendment.id;
    const instanceId = (await getAm(amId)).approval_instance_id;
    // Drive the engine to APPROVED directly (simulating the central approvals
    // surface), then fire the post-approval hook — NOT the /review endpoint.
    await submitApprovalAction({ approval_instance_id: instanceId, approver_user_id: APPROVER, action: "APPROVE", comment: "ok" });
    await handleArcAmendmentApproval(instanceId, APPROVER);
    expect((await getAm(amId)).status).toBe("awaiting_signature");
    const doc = await addendumOf(amId);
    expect(doc).toBeTruthy();
    expect(doc.status).toBe("awaiting_signature");
  });

  test("decline frees the line — a fresh amendment can be raised after a void", async () => {
    const r1 = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "qty",
      amendment_from: dIso(0), amendment_to: dIso(60), reason: "first try",
      payload: { arc_contract_line_id: lineE, new_qty: 900 },
    });
    const amId = r1.body.data.amendment.id;
    await approve(amId);
    const doc = await addendumOf(amId);
    await vendorClient.post(`/api/v1/arc-v2/vendor/addendums/${doc.id}/decline`).send({ reason: "no" });
    expect((await getAm(amId)).status).toBe("voided");
    // Line is free again — second request is accepted (not blocked 409).
    const r2 = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "qty",
      amendment_from: dIso(0), amendment_to: dIso(60), reason: "second try",
      payload: { arc_contract_line_id: lineE, new_qty: 850 },
    });
    expect(r2.status).toBe(200);
  });
});
