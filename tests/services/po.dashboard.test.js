// Wave: PO Dashboard / Tracking / Analytics aggregation endpoints.
// ----------------------------------------------------------------------------
// Product-level integration tests over real HTTP (supertest -> buildTestApp)
// against the local Postgres seed. Exercises the six NEW read-only PO endpoints
// mounted under /po:
//   GET /po/list, /po/dashboard/kpis, /po/awaiting, /po/detail/:po_id,
//   /po/tracking, /po/analytics
// plus a smoke of the existing POST /po/approve/:po_id approve flow.
//
// TENANT-SCOPE STRATEGY (the crux): poDashboardController.deriveScope() reads a
// hospitality company header (x-hospitality-company / x-company-id) and, when
// present, scopes by rfq.hospitality_company_id; otherwise it falls back to
// po.company_id = req.user.company_id. We deliberately send NO hospitality
// headers and lean on the FALLBACK path:
//   - a1_proc_buyer.company_id === IDS.companies.A === the seeded PO.company_id
//     -> the in-scope buyer SEES the PO.
//   - companyB_admin.company_id === IDS.companies.B (a real seeded company-B
//     buyer) -> NEVER sees company-A POs (clean tenant isolation, no extra rows
//     to author). The supertest auth headers carry only Authorization +
//     User-Agent, so the fallback is the only scope source — exactly what we
//     want to assert.
//
// All inserted rows are tracked and removed in afterEach (mirrors
// po.acceptReject.test.js). The httpClient is built per-test.

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

afterAll(async () => {
  await closeDb();
});

// Resolved once: a real product_variant id from the staging snapshot so the
// detail endpoint's INNER JOIN tbl_product_variant resolves an item name.
let VARIANT_ID = 1;

beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT_ID = v.id;
});

// ---- Row tracking -----------------------------------------------------------
const inserted = {
  rfqIds: [],
  poIds: [],
  poProductIds: [],
  rfqProductIds: [],
  quoteIds: [],
  approvalInstanceIds: [],
  approvalStepIds: [],
  approverIds: [],
  techEvalIds: [],
  techClauseIds: [],
};

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  // Tech-eval first: cleared_vendors references approval_instances, and the
  // tech_evaluation row references rfq + rfq_product — so purge these before
  // the approval-instance and rfq/product deletes below to avoid FK errors.
  if (inserted.techClauseIds.length) {
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response WHERE tbl_rfq_product_tech_evaluation_clauses_id = ANY($1::int[])`,
      [inserted.techClauseIds]
    );
  }
  if (inserted.techEvalIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`, [inserted.techEvalIds]);
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation_clauses WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`, [inserted.techEvalIds]);
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE id = ANY($1::int[])`, [inserted.techEvalIds]);
  }
  if (inserted.approverIds.length) {
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE id = ANY($1::int[])`, [inserted.approverIds]);
  }
  if (inserted.approvalStepIds.length) {
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE id = ANY($1::int[])`, [inserted.approvalStepIds]);
  }
  if (inserted.poIds.length) {
    // Detach instance from PO before deleting the instance (FK safety).
    await db.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL WHERE id = ANY($1::int[])`, [inserted.poIds]);
  }
  if (inserted.approvalInstanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [inserted.approvalInstanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [inserted.approvalInstanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inserted.approvalInstanceIds]);
  }
  if (inserted.poProductIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE id = ANY($1::int[])`, [inserted.poProductIds]);
  }
  if (inserted.poIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type='PO' AND entity_id = ANY($1::int[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [inserted.poIds]);
  }
  if (inserted.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [inserted.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [inserted.quoteIds]);
  }
  if (inserted.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [inserted.rfqProductIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

// ---- Setup helpers ----------------------------------------------------------
let PO_NO = 6_000_000;
const nextPoNo = () => `DASH-PO-${++PO_NO}`;

async function makeRfqWithProductAndVendor({
  vendorId = IDS.users.vendor_alpha,
  productVariantId = VARIANT_ID,
  createdBy = IDS.users.a1_proc_buyer,
  hospitality = IDS.hospitality.A,
  hotel = IDS.hotels.A1,
  department = IDS.departments.proc,
} = {}) {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy,
    status: 1,
    is_published: 1,
    bid_end_date: oneDayAgo,
    hospitality,
    hotel,
    department,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);

  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, 'Spec text', '', '', '', '', $2, 0)
     RETURNING id`,
    [rfq_id, productVariantId]
  );
  inserted.rfqProductIds.push(product.id);

  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, productVariantId, vendorId]
  );

  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, vendorId]
  );
  inserted.quoteIds.push(quote.id);

  return { rfq_id, rfq_no, rfq_product_id: product.id, product_variant_id: productVariantId, quote_id: quote.id };
}

async function makePo({
  rfq_id, vendorId = IDS.users.vendor_alpha, status = "acceptance_pending",
  rfq_product_ids = [], quote_ids = [], initiatedBy = IDS.users.a1_proc_buyer,
  companyId = IDS.companies.A, totalValue = 100, approvalInstanceId = null,
}) {
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, approval_instance_id,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, 100, $6, $7, $8, $9, $10, NOW(), NOW())
     RETURNING id`,
    [rfq_id, companyId, nextPoNo(), status, rfq_product_ids, vendorId, totalValue, quote_ids, initiatedBy, approvalInstanceId]
  );
  inserted.poIds.push(po.id);
  return po.id;
}

async function attachProductToPo(po_id, rfq_product_id, quote_id) {
  const r = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
     VALUES ($1, $2, $3, 2, 'NOS', 50, 100) RETURNING id`,
    [po_id, rfq_product_id, quote_id]
  );
  inserted.poProductIds.push(r.id);
  return r.id;
}

// Build a minimal PENDING PO approval instance + one PENDING step + one PENDING
// approver assigned to `approverUserId`. Returns the instance id; the PO must
// then point at it via approval_instance_id.
async function makePendingPoApproval({ po_rfq_id, approverUserId, hospitality = IDS.hospitality.A, hotel = IDS.hotels.A1 }) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
     VALUES ('PO', $1, $2, 'PENDING', 1, $3, $4, $5, $6, $7)
     RETURNING id`,
    [0, IDS.policies.A1_P1_PO, hospitality, hotel, IDS.departments.proc, IDS.users.a1_proc_buyer, IDS.processes.A_P1]
  );
  inserted.approvalInstanceIds.push(inst.id);

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`,
    [inst.id]
  );
  inserted.approvalStepIds.push(step.id);

  const appr = await db.one(
    `INSERT INTO tbl_approval_step_approvers
       (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING') RETURNING id`,
    [step.id, approverUserId]
  );
  inserted.approverIds.push(appr.id);

  return inst.id;
}

// A REJECTED PO approval: instance REJECTED, step 1 REJECTED, the approver
// REJECTED, plus a tbl_approval_actions REJECT row carrying the reason comment.
async function makeRejectedPoApproval({ rejecterUserId, reason = "capacity constraint", hospitality = IDS.hospitality.A, hotel = IDS.hotels.A1 }) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
     VALUES ('PO', $1, $2, 'REJECTED', 1, $3, $4, $5, $6, $7)
     RETURNING id`,
    [0, IDS.policies.A1_P1_PO, hospitality, hotel, IDS.departments.proc, IDS.users.a1_proc_buyer, IDS.processes.A_P1]
  );
  inserted.approvalInstanceIds.push(inst.id);

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, step_order, decision_rule, status, completed_at)
     VALUES ($1, 1, 'ANY', 'REJECTED', NOW()) RETURNING id`,
    [inst.id]
  );
  inserted.approvalStepIds.push(step.id);

  const appr = await db.one(
    `INSERT INTO tbl_approval_step_approvers
       (approval_instance_step_id, approver_user_id, status, acted_at)
     VALUES ($1, $2, 'REJECTED', NOW()) RETURNING id`,
    [step.id, rejecterUserId]
  );
  inserted.approverIds.push(appr.id);

  // The reject action carries the reason (cleaned via approval_instance_id in afterEach).
  await db.none(
    `INSERT INTO tbl_approval_actions
       (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
     VALUES ($1, $2, $3, 'REJECT', $4)`,
    [inst.id, step.id, rejecterUserId, reason]
  );

  return inst.id;
}

// Seed a technical evaluation for (rfq_id, rfq_product_id) + a vendor: two
// scored clauses, an APPROVED tech-eval approval instance (so there's an
// approver), and a cleared_vendors row with the final calculated_score.
async function seedTechEval({ rfq_id, rfq_product_id, vendorId, approverUserId, calculatedScore = 80, minPass = 60 }) {
  const te = await db.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation
       (rfq_id, tbl_rfq_product_id, minimum_passing_score, is_complete, current_round)
     VALUES ($1, $2, $3, true, 1) RETURNING id`,
    [rfq_id, rfq_product_id, minPass]
  );
  inserted.techEvalIds.push(te.id);

  const c1 = await db.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation_clauses
       (tbl_rfq_product_tech_evaluation_id, clause_text, weightage, clause_type)
     VALUES ($1, 'Build quality & materials', 10, 'clause') RETURNING id`,
    [te.id]
  );
  const c2 = await db.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation_clauses
       (tbl_rfq_product_tech_evaluation_id, clause_text, weightage, clause_type)
     VALUES ($1, 'Warranty & support terms', 10, 'clause') RETURNING id`,
    [te.id]
  );
  inserted.techClauseIds.push(c1.id, c2.id);

  // Scored responses: score_timestamp must differ from timestamp to count.
  await db.none(
    `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
       (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response, buyer_id, buyer_marks, "timestamp", score_timestamp)
     VALUES ($1, $2, 'Meets spec', $3, 9, NOW() - INTERVAL '2 hours', NOW())`,
    [c1.id, vendorId, approverUserId]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
       (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response, buyer_id, buyer_marks, "timestamp", score_timestamp)
     VALUES ($1, $2, '3 year warranty', $3, 7, NOW() - INTERVAL '2 hours', NOW())`,
    [c2.id, vendorId, approverUserId]
  );

  // APPROVED tech-eval approval instance + the APPROVE action (the approver).
  const ai = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
     VALUES ('TECHNICAL', $1, $2, 'APPROVED', 1, $3, $4, $5, $6, $7) RETURNING id`,
    [te.id, IDS.policies.A1_P1_PO, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.users.a1_proc_buyer, IDS.processes.A_P1]
  );
  inserted.approvalInstanceIds.push(ai.id);
  await db.none(
    `INSERT INTO tbl_approval_actions (approval_instance_id, approver_user_id, action, comment)
     VALUES ($1, $2, 'APPROVE', 'Technically cleared')`,
    [ai.id, approverUserId]
  );

  await db.none(
    `INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors
       (tbl_rfq_product_tech_evaluation_id, vendor_id, status, is_verified, evaluation_round, approval_instance_id, calculated_score)
     VALUES ($1, $2, 1, true, 1, $3, $4)`,
    [te.id, vendorId, ai.id, calculatedScore]
  );

  return te.id;
}

// ===========================================================================
// 1) GET /po/list — shape + status_counts buckets
// ===========================================================================
describe("GET /po/list", () => {
  it("returns the seeded PO for the in-scope buyer with the documented shape + 8 status buckets", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({ rfq_id, status: "acceptance_pending", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get("/api/v1/po/list");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.total_items).toBe("number");
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBeGreaterThan(0);

    // status_counts has the 8 documented buckets.
    const sc = res.body.status_counts;
    expect(sc).toBeDefined();
    for (const k of ["all", "pending", "approved", "dispatched", "delivered", "rejected", "draft", "completed"]) {
      expect(typeof sc[k]).toBe("number");
    }
    // acceptance_pending lands in the `pending` bucket.
    expect(sc.pending).toBeGreaterThanOrEqual(1);

    const row = res.body.data.find((p) => p.id === po_id);
    expect(row).toBeDefined();
    expect(row.status).toBe("acceptance_pending");
    expect(row.vendor).toMatchObject({ id: IDS.users.vendor_alpha });
    expect(typeof row.po_number).toBe("string");
    expect(row.items_count).toBe(1);
  });

  it("?status=pending returns the pending PO in data", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({ rfq_id, status: "pending_approval", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get("/api/v1/po/list?status=pending");

    expect(res.status).toBe(200);
    const ids = res.body.data.map((p) => p.id);
    expect(ids).toContain(po_id);
    // Every returned row must be in the pending bucket.
    for (const p of res.body.data) {
      expect(["pending_approval", "acceptance_pending"]).toContain(p.status);
    }
  });
});

// ===========================================================================
// 2) GET /po/list — search
// ===========================================================================
describe("GET /po/list?search=", () => {
  it("search by po_number returns the PO; a non-matching search returns empty", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({ rfq_id, status: "acceptance_pending", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);
    const poNumber = (await db.one(`SELECT po_number FROM tbl_rfq_purchase_order WHERE id=$1`, [po_id])).po_number;

    const client = await httpClient(IDS.users.a1_proc_buyer);

    const hit = await client.get(`/api/v1/po/list?search=${encodeURIComponent(poNumber)}`);
    expect(hit.status).toBe(200);
    expect(hit.body.data.map((p) => p.id)).toContain(po_id);

    const miss = await client.get(`/api/v1/po/list?search=NO_SUCH_PO_ZZZ_${Date.now()}`);
    expect(miss.status).toBe(200);
    expect(miss.body.data).toHaveLength(0);
    expect(miss.body.total_items).toBe(0);
  });
});

// ===========================================================================
// 3) GET /po/dashboard/kpis
// ===========================================================================
describe("GET /po/dashboard/kpis", () => {
  it("returns the documented numeric KPI keys; a fresh non-terminal PO increments activeCount", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const before = await client.get("/api/v1/po/dashboard/kpis");
    expect(before.status).toBe(200);
    const baselineActive = before.body.activeCount;

    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({ rfq_id, status: "acceptance_pending", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const after = await client.get("/api/v1/po/dashboard/kpis");
    expect(after.status).toBe(200);

    for (const k of [
      "activeCount", "awaitingYou", "awaitingOldestDays", "inTransit",
      "avgDeliveryDays", "approvedThisMonth", "approvedDeltaPct",
      "totalValueMTD", "totalValueDeltaPct",
    ]) {
      expect(typeof after.body[k]).toBe("number");
    }
    expect(after.body.activeCount).toBe(baselineActive + 1);
  });

  it("counts vendor acceptance: accepted (approved + vendor_action_at) vs pending (Sr 221)", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const before = await client.get("/api/v1/po/dashboard/kpis");
    expect(before.status).toBe(200);
    const basePending = before.body.vendorAcceptancePending;
    const baseAccepted = before.body.vendorAccepted;
    expect(typeof basePending).toBe("number");
    expect(typeof baseAccepted).toBe("number");

    // A PO awaiting the vendor's acceptance.
    const a = await makeRfqWithProductAndVendor();
    const poPending = await makePo({ rfq_id: a.rfq_id, status: "acceptance_pending", rfq_product_ids: [a.rfq_product_id], quote_ids: [a.quote_id] });
    await attachProductToPo(poPending, a.rfq_product_id, a.quote_id);

    // A PO the vendor has accepted (status -> approved, vendor_action_at set).
    const b = await makeRfqWithProductAndVendor();
    const poAccepted = await makePo({ rfq_id: b.rfq_id, status: "approved", rfq_product_ids: [b.rfq_product_id], quote_ids: [b.quote_id] });
    await attachProductToPo(poAccepted, b.rfq_product_id, b.quote_id);
    await db.none(`UPDATE tbl_rfq_purchase_order SET vendor_action_at = NOW() WHERE id = $1`, [poAccepted]);

    const after = await client.get("/api/v1/po/dashboard/kpis");
    expect(after.body.vendorAcceptancePending).toBe(basePending + 1);
    expect(after.body.vendorAccepted).toBe(baseAccepted + 1);
  });
});

// ===========================================================================
// 4) GET /po/awaiting
// ===========================================================================
describe("GET /po/awaiting", () => {
  it("returns a PO whose current PENDING step is assigned to the requester, and hides it from others", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    // Approval instance with a PENDING step assigned to the PO approver.
    const instId = await makePendingPoApproval({ po_rfq_id: rfq_id, approverUserId: IDS.users.a1_proc_poApp });
    const po_id = await makePo({
      rfq_id, status: "pending_approval", rfq_product_ids: [rfq_product_id],
      quote_ids: [quote_id], approvalInstanceId: instId,
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);
    // Point the instance entity_id at the real PO (cosmetic; query joins on PO->instance).
    await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po_id, instId]);

    // The assigned approver sees it.
    const approverClient = await httpClient(IDS.users.a1_proc_poApp);
    const seen = await approverClient.get("/api/v1/po/awaiting");
    expect(seen.status).toBe(200);
    expect(Array.isArray(seen.body.data)).toBe(true);
    const mine = seen.body.data.find((p) => p.id === po_id);
    expect(mine).toBeDefined();
    expect(mine.po_number).toBeTruthy();
    expect(mine.vendor).toMatchObject({ id: IDS.users.vendor_alpha });

    // A different in-scope user (the buyer) is NOT a pending approver -> does not see it.
    const otherClient = await httpClient(IDS.users.a1_proc_buyer);
    const notSeen = await otherClient.get("/api/v1/po/awaiting");
    expect(notSeen.status).toBe(200);
    expect(notSeen.body.data.map((p) => p.id)).not.toContain(po_id);
  });
});

// ===========================================================================
// 5) GET /po/detail/:po_id
// ===========================================================================
describe("GET /po/detail/:po_id — product coverage", () => {
  // A purchase order is per-vendor and is built from the finalizations made so
  // far, so a draft can be initiated while other products on the same RFQ are
  // still unfinalized. Initiating FREEZES it — anything finalized afterwards is
  // clubbed into a separate PO. The detail page turns this into Initiate
  // (green, covers everything) vs Force Initiate (yellow, with a warning), so
  // the flag has to be derived on the server: the client sees only the items it
  // was sent and cannot know what is missing.
  //
  // Production example this mirrors: PO 472 on RFQ 809 — 3 products on the RFQ,
  // 1 finalized, 1 PO. Incomplete.

  /** Add another product to an existing RFQ, without putting it on any PO. */
  async function addRfqProduct(rfq_id, product_variant_id) {
    const p = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, qap, variant)
       VALUES ($1, '', '0', '', '', $2, '0', 0) RETURNING id`,
      [rfq_id, product_variant_id]
    );
    inserted.rfqProductIds = inserted.rfqProductIds || [];
    inserted.rfqProductIds.push(p.id);
    return p.id;
  }

  it("covers_all_products = true when the PO carries every product on the RFQ", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({ rfq_id, rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.rfq_product_count).toBe(1);
    expect(res.body.data.po_product_count).toBe(1);
    expect(res.body.data.covers_all_products).toBe(true);
  });

  it("covers_all_products = false when a product on the RFQ is not on the PO", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    // Two more products on the RFQ, neither finalized onto this PO — the
    // production shape of PO 472.
    await addRfqProduct(rfq_id, 2);
    await addRfqProduct(rfq_id, 3);
    const po_id = await makePo({ rfq_id, rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.rfq_product_count).toBe(3);
    expect(res.body.data.po_product_count).toBe(1);
    expect(res.body.data.covers_all_products).toBe(false);
  });

  it("counts a product once even if it appears on several PO lines", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    await addRfqProduct(rfq_id, 2);
    const po_id = await makePo({ rfq_id, rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);
    await attachProductToPo(po_id, rfq_product_id, quote_id); // same product, second line

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);

    // Two lines, but still only ONE of the RFQ's two products is covered —
    // counting rows instead of distinct products would call this complete.
    expect(res.body.data.po_product_count).toBe(1);
    expect(res.body.data.rfq_product_count).toBe(2);
    expect(res.body.data.covers_all_products).toBe(false);
  });
});

describe("GET /po/detail/:po_id", () => {
  it("returns the contract-shaped detail object for an in-scope PO", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({ rfq_id, status: "acceptance_pending", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toBeDefined();
    expect(d.id).toBe(po_id);
    expect(typeof d.po_number).toBe("string");
    expect(d.status).toBe("acceptance_pending");
    expect(d.status_label).toBe("Awaiting Vendor Acceptance");
    // Nested contract objects/arrays.
    expect(d.rfq).toMatchObject({ id: rfq_id });
    expect(d.vendor).toMatchObject({ id: IDS.users.vendor_alpha });
    expect(Array.isArray(d.items)).toBe(true);
    expect(d.items.length).toBe(1);
    expect(d.pricing).toBeDefined();
    expect(typeof d.pricing.total).toBe("number");
    expect(Array.isArray(d.payment_terms)).toBe(true);
    expect(Array.isArray(d.workflow)).toBe(true);
    expect(Array.isArray(d.docs)).toBe(true);
    expect(Array.isArray(d.activity)).toBe(true);
    expect(Array.isArray(d.comparison)).toBe(true);
  });

  // The PO's OWN scope keys. A client deciding whether to offer a write action
  // on this purchase order (the Force Initiate button on the detail page) has
  // to resolve the user's grants against THIS entity's hotel/department — the
  // same tuple assertPoAccess evaluates. Without these two ids the only scope
  // the frontend could reach for was the viewer's hospitality_mappings, which
  // answers a different question: a create grant sitting at the PO's hotel
  // disappears from the reply whenever the viewer's mapping snapshot doesn't
  // cover that hotel, which is how a draft PO lost its Initiate button.
  it("carries the PO's own hotel_id and department_id so a client can scope write actions to it", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor({
      hotel: IDS.hotels.A1,
      department: IDS.departments.proc,
    });
    const po_id = await makePo({ rfq_id, status: "draft", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);

    expect(res.status).toBe(200);
    // Sourced from the parent RFQ, not from the caller — the same COALESCE
    // the scope predicate uses, so a call-off PO reports its ARC's hotel.
    expect(res.body.data.hotel_id).toBe(IDS.hotels.A1);
    expect(res.body.data.department_id).toBe(IDS.departments.proc);
  });
});

// ===========================================================================
// 6) SECURITY — tenant isolation (the most important test)
// ===========================================================================
describe("SECURITY: cross-tenant isolation", () => {
  it("a company-B buyer gets 404 on a company-A PO detail (no leak) and never sees A's POs in /po/list", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor(); // company A
    const po_id = await makePo({
      rfq_id, status: "acceptance_pending", rfq_product_ids: [rfq_product_id],
      quote_ids: [quote_id], companyId: IDS.companies.A,
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    // companyB_admin.company_id === IDS.companies.B -> fallback scope = po.company_id = B.
    const bClient = await httpClient(IDS.users.companyB_admin);

    // Detail of an A-PO must 404 (not 200, not 403) — never leak existence.
    const detail = await bClient.get(`/api/v1/po/detail/${po_id}`);
    expect(detail.status).toBe(404);
    expect(detail.body.data).toBeUndefined();

    // List for company B must NOT include the A-PO.
    const list = await bClient.get("/api/v1/po/list");
    expect(list.status).toBe(200);
    expect(list.body.data.map((p) => p.id)).not.toContain(po_id);

    // Sanity: the in-scope A buyer DOES see it (proves the PO exists + isolation is real).
    const aClient = await httpClient(IDS.users.a1_proc_buyer);
    const aDetail = await aClient.get(`/api/v1/po/detail/${po_id}`);
    expect(aDetail.status).toBe(200);
    expect(aDetail.body.data.id).toBe(po_id);
  });
});

// ===========================================================================
// 7) GET /po/tracking
// ===========================================================================
describe("GET /po/tracking", () => {
  it("returns data[] + tab_counts; an approved PO appears but a draft PO does not (pre-approval excluded)", async () => {
    // Approved (trackable) PO.
    const a = await makeRfqWithProductAndVendor();
    const approvedPoId = await makePo({ rfq_id: a.rfq_id, status: "approved", rfq_product_ids: [a.rfq_product_id], quote_ids: [a.quote_id] });
    await attachProductToPo(approvedPoId, a.rfq_product_id, a.quote_id);

    // Draft (NOT trackable) PO.
    const d = await makeRfqWithProductAndVendor();
    const draftPoId = await makePo({ rfq_id: d.rfq_id, status: "draft", rfq_product_ids: [d.rfq_product_id], quote_ids: [d.quote_id] });
    await attachProductToPo(draftPoId, d.rfq_product_id, d.quote_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get("/api/v1/po/tracking?tab=all");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.tab_counts).toBeDefined();
    for (const k of ["active", "awaiting-grn", "payment", "completed", "all"]) {
      expect(typeof res.body.tab_counts[k]).toBe("number");
    }

    const ids = res.body.data.map((p) => p.id);
    expect(ids).toContain(approvedPoId);
    expect(ids).not.toContain(draftPoId);

    const approvedRow = res.body.data.find((p) => p.id === approvedPoId);
    expect(Array.isArray(approvedRow.stages)).toBe(true);
    expect(approvedRow.stages.length).toBe(8);
    expect(typeof approvedRow.current_stage).toBe("string");
  });
});

// ===========================================================================
// 8) GET /po/analytics
// ===========================================================================
describe("GET /po/analytics", () => {
  it("?period=this-month returns kpis{}, spend_trend[6], status_dist[], top_vendors[], queue_health{}", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({ rfq_id, status: "approved", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id], totalValue: 5000 });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get("/api/v1/po/analytics?period=this-month");

    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.kpis).toBeDefined();
    expect(typeof b.kpis.total_spend).toBe("number");
    expect(typeof b.kpis.active_vendors).toBe("number");

    expect(Array.isArray(b.spend_trend)).toBe(true);
    expect(b.spend_trend).toHaveLength(6);
    expect(b.spend_trend.some((m) => m.current === true)).toBe(true);

    expect(Array.isArray(b.status_dist)).toBe(true);
    expect(Array.isArray(b.top_vendors)).toBe(true);

    expect(b.queue_health).toBeDefined();
    for (const k of ["under_24h", "d1_to_3", "over_3d", "oldest_days", "avg_approval_days"]) {
      expect(typeof b.queue_health[k]).toBe("number");
    }
  });
});

// ===========================================================================
// 9) Role gate — vendors (user_type 3) are blocked by noAcl([3])
// ===========================================================================
describe("Role gate: noAcl([3]) blocks vendors", () => {
  it("a vendor user (user_type=3) calling /po/list gets 403", async () => {
    // Fixture vendor users have user_type NULL; the route gate keys off
    // user_type === 3. Set it for the duration of this test, then restore.
    const prev = await db.one(`SELECT user_type FROM tbl_users WHERE id=$1`, [IDS.users.vendor_alpha]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id=$1`, [IDS.users.vendor_alpha]);
    try {
      const client = await httpClient(IDS.users.vendor_alpha);
      const res = await client.get("/api/v1/po/list");
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/Access denied/i);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id=$1`, [IDS.users.vendor_alpha, prev.user_type]);
    }
  });
});

// ===========================================================================
// 10) Smoke — existing POST /po/approve/:po_id (authorized approver approves)
// ===========================================================================
describe("POST /po/approve/:po_id (smoke)", () => {
  it("an authorized approver can act on a pending PO approval via the existing endpoint", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const instId = await makePendingPoApproval({ po_rfq_id: rfq_id, approverUserId: IDS.users.a1_proc_poApp });
    const po_id = await makePo({
      rfq_id, status: "pending_approval", rfq_product_ids: [rfq_product_id],
      quote_ids: [quote_id], approvalInstanceId: instId,
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);
    await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po_id, instId]);

    const client = await httpClient(IDS.users.a1_proc_poApp);
    const res = await client.post(`/api/v1/po/approve/${po_id}`).send({ action: "APPROVE", comment: "ok" });

    // The endpoint exists and an authorized approver is accepted (not 403/404).
    // We don't deep-assert the downstream flow (covered by po.acceptReject).
    expect(res.status).toBeLessThan(500);
    expect([401, 403, 404]).not.toContain(res.status);
  });
});

// ===========================================================================
// 11) Action Required bucket (#2) — user-specific: the current approver sees a
//     PO awaiting their approval; status_counts exposes action_required.
// ===========================================================================
describe("GET /po/list?status=action-required", () => {
  it("includes a PO whose current pending step is assigned to the requester, and exposes status_counts.action_required", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const instId = await makePendingPoApproval({ po_rfq_id: rfq_id, approverUserId: IDS.users.a1_proc_poApp });
    const po_id = await makePo({
      rfq_id, status: "pending_approval", rfq_product_ids: [rfq_product_id],
      quote_ids: [quote_id], approvalInstanceId: instId,
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);
    await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po_id, instId]);

    // The assigned approver: the PO is in their Action Required bucket.
    const approver = await httpClient(IDS.users.a1_proc_poApp);
    const ar = await approver.get("/api/v1/po/list?status=action-required");
    expect(ar.status).toBe(200);
    expect(ar.body.data.map((p) => p.id)).toContain(po_id);
    expect(typeof ar.body.status_counts.action_required).toBe("number");
    expect(ar.body.status_counts.action_required).toBeGreaterThanOrEqual(1);

    // A different in-scope user who is NOT the approver (and didn't initiate it)
    // does not get it via the approval branch. (They may still see it only if
    // they can create POs AND it's draft/approved — here it's pending_approval,
    // so the approval branch is the only inclusion path.)
    const other = await httpClient(IDS.users.companyB_admin);
    const otherAr = await other.get("/api/v1/po/list?status=action-required");
    expect(otherAr.status).toBe(200);
    expect(otherAr.body.data.map((p) => p.id)).not.toContain(po_id);
  });
});

// ===========================================================================
// 12) Current approver line (#6) — list rows for a pending PO carry the step
//     label + the current approvers' names.
// ===========================================================================
describe("GET /po/list — current approver info on pending rows", () => {
  it("a pending PO row exposes current_step_label + current_approvers", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const instId = await makePendingPoApproval({ po_rfq_id: rfq_id, approverUserId: IDS.users.a1_proc_poApp });
    const po_id = await makePo({
      rfq_id, status: "pending_approval", rfq_product_ids: [rfq_product_id],
      quote_ids: [quote_id], approvalInstanceId: instId,
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);
    await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po_id, instId]);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get("/api/v1/po/list");
    expect(res.status).toBe(200);
    const row = res.body.data.find((p) => p.id === po_id);
    expect(row).toBeDefined();
    expect(row.current_step_label).toBe("L1");
    expect(Array.isArray(row.current_approvers)).toBe(true);
    expect(row.current_approvers.map((a) => a.user_id)).toContain(IDS.users.a1_proc_poApp);
    expect(row.current_approvers[0].name).toBeTruthy();
  });
});

// ===========================================================================
// 13) Detail awaiting_me (#3) — true only for the actual current approver, and
//     the full lifecycle audit trail is present.
// ===========================================================================
describe("GET /po/detail/:po_id — awaiting_me + audit trail", () => {
  it("awaiting_me is true for the current approver and false for a non-approver in scope", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const instId = await makePendingPoApproval({ po_rfq_id: rfq_id, approverUserId: IDS.users.a1_proc_poApp });
    const po_id = await makePo({
      rfq_id, status: "pending_approval", rfq_product_ids: [rfq_product_id],
      quote_ids: [quote_id], approvalInstanceId: instId,
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);
    await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po_id, instId]);

    // Current approver: awaiting_me true.
    const approver = await httpClient(IDS.users.a1_proc_poApp);
    const ad = await approver.get(`/api/v1/po/detail/${po_id}`);
    expect(ad.status).toBe(200);
    expect(ad.body.data.awaiting_me).toBe(true);
    expect(ad.body.data.current_step_label).toBe("L1");
    expect(ad.body.data.current_approvers.map((a) => a.user_id)).toContain(IDS.users.a1_proc_poApp);

    // In-scope buyer who is NOT the approver: awaiting_me false (the core bug fix).
    const buyer = await httpClient(IDS.users.a1_proc_buyer);
    const bd = await buyer.get(`/api/v1/po/detail/${po_id}`);
    expect(bd.status).toBe(200);
    expect(bd.body.data.awaiting_me).toBe(false);
    // ...but it still surfaces who it's waiting on.
    expect(bd.body.data.current_approvers.length).toBeGreaterThanOrEqual(1);
  });

  it("workflow is a full lifecycle audit trail (PO created + downstream nodes), not just approval steps", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({ rfq_id, status: "approved", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);
    expect(res.status).toBe(200);
    const titles = res.body.data.workflow.map((w) => w.title);
    // Created node always present.
    expect(titles).toContain("PO created");
    // An approved PO surfaces the downstream vendor/logistics chain.
    expect(titles).toContain("Sent to vendor");
    expect(res.body.data.workflow.length).toBeGreaterThan(1);
    // activity feed has a created event with a human message.
    const created = res.body.data.activity.find((a) => a.type === "created");
    expect(created).toBeDefined();
    expect(created.msg).toMatch(/created purchase order/i);
  });

  it("a rejected approval step shows status 'rejected' (not done) with the rejection reason", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const instId = await makeRejectedPoApproval({ rejecterUserId: IDS.users.a1_proc_poApp, reason: "capacity constraint" });
    const po_id = await makePo({
      rfq_id, status: "rejected", rfq_product_ids: [rfq_product_id],
      quote_ids: [quote_id], approvalInstanceId: instId,
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);
    await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po_id, instId]);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);
    expect(res.status).toBe(200);

    const rejectedNode = res.body.data.workflow.find((w) => w.status === "rejected");
    expect(rejectedNode).toBeDefined();
    expect(rejectedNode.title).toMatch(/L1 approval/i);
    // The reason is surfaced on the node (not just in the activity feed).
    expect(rejectedNode.reason).toBe("capacity constraint");
    // A rejected PO must NOT render the rejected step as a green "done" tick.
    expect(rejectedNode.status).not.toBe("done");
    // And the downstream vendor/logistics chain is not shown for a rejected PO.
    const titles = res.body.data.workflow.map((w) => w.title);
    expect(titles).not.toContain("Sent to vendor");
  });

  it("a vendor-rejected PO shows the 'Vendor rejected the PO' node as rejected (red), not done", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({ rfq_id, status: "rejected_by_vendor", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);
    await db.none(
      `UPDATE tbl_rfq_purchase_order SET vendor_rejection_reason = $2, vendor_action_at = NOW() WHERE id = $1`,
      [po_id, "capacity constraint"]
    );

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);
    expect(res.status).toBe(200);

    const node = res.body.data.workflow.find((w) => w.title === "Vendor rejected the PO");
    expect(node).toBeDefined();
    expect(node.status).toBe("rejected");
    expect(node.status).not.toBe("done");
    expect(node.reason).toBe("capacity constraint");
  });
});

// ===========================================================================
// 13b) REMOVED-approver tombstones must not leak into the audit trail.
//      Root cause (PO 138699 / RFQ 681, instance 3628 in production): the
//      mid-flight reconciler soft-deletes a revoked approver — status=
//      'REMOVED' + removed_at + removal_reason — rather than deleting the
//      row. buildAuditTrail's per-step approver aggregate had no status
//      predicate, so a REMOVED row still counted toward "N approvers", could
//      be picked as the step's `by` actor, and a SKIPPED step fell through
//      the nodeStatus ladder to "pending" as if still queued.
// ===========================================================================
describe("GET /po/detail/:po_id — REMOVED approver tombstones are excluded from the audit trail", () => {
  it("a REMOVED approver does not inflate the 'N approvers' count and is never named as the step's actor", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const instId = await makePendingPoApproval({ po_rfq_id: rfq_id, approverUserId: IDS.users.a1_proc_poApp });

    // Tombstone a second approver on the SAME step, mirroring the production
    // reconciler (role revoked -> status='REMOVED', removed_at, removal_reason).
    const step = await db.one(
      `SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1 AND step_order = 1`,
      [instId]
    );
    const removed = await db.one(
      `INSERT INTO tbl_approval_step_approvers
         (approval_instance_step_id, approver_user_id, status, removed_at, removal_reason)
       VALUES ($1, $2, 'REMOVED', NOW(), 'role_removed') RETURNING id`,
      [step.id, IDS.users.a1_proc_finance]
    );
    inserted.approverIds.push(removed.id);

    const po_id = await makePo({
      rfq_id, status: "pending_approval", rfq_product_ids: [rfq_product_id],
      quote_ids: [quote_id], approvalInstanceId: instId,
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);
    await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po_id, instId]);

    const pendingName = (await db.one(`SELECT name FROM tbl_users WHERE id=$1`, [IDS.users.a1_proc_poApp])).name;
    const removedName = (await db.one(`SELECT name FROM tbl_users WHERE id=$1`, [IDS.users.a1_proc_finance])).name;

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);
    expect(res.status).toBe(200);

    const stepNode = res.body.data.workflow.find((w) => w.title === "L1 approval");
    expect(stepNode).toBeDefined();
    // Exactly one ACTIVE approver remains -> no "N approvers" inflation from
    // counting the tombstone alongside the live one.
    expect(stepNode.policy).toBeNull();
    // The live PENDING approver is named as the actor — never the tombstone.
    expect(stepNode.by).toBe(pendingName);
    expect(stepNode.by).not.toBe(removedName);
  });

  it("a SKIPPED step does not render as pending or current", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();

    // A two-step instance: step 1 SKIPPED, step 2 PENDING = the current step.
    const inst = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
       VALUES ('PO', 0, $1, 'PENDING', 2, $2, $3, $4, $5, $6)
       RETURNING id`,
      [IDS.policies.A1_P1_PO, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.users.a1_proc_buyer, IDS.processes.A_P1]
    );
    inserted.approvalInstanceIds.push(inst.id);

    const step1 = await db.one(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, 1, 'ANY', 'SKIPPED') RETURNING id`,
      [inst.id]
    );
    inserted.approvalStepIds.push(step1.id);

    const step2 = await db.one(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, 2, 'ANY', 'PENDING') RETURNING id`,
      [inst.id]
    );
    inserted.approvalStepIds.push(step2.id);

    const appr = await db.one(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
       VALUES ($1, $2, 'PENDING') RETURNING id`,
      [step2.id, IDS.users.a1_proc_poApp]
    );
    inserted.approverIds.push(appr.id);

    const po_id = await makePo({
      rfq_id, status: "pending_approval", rfq_product_ids: [rfq_product_id],
      quote_ids: [quote_id], approvalInstanceId: inst.id,
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);
    await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po_id, inst.id]);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);
    expect(res.status).toBe(200);

    const skippedNode = res.body.data.workflow.find((w) => w.title === "L1 approval");
    const currentNode = res.body.data.workflow.find((w) => w.title === "L2 approval");
    expect(skippedNode).toBeDefined();
    expect(currentNode).toBeDefined();
    expect(skippedNode.status).not.toBe("pending");
    expect(skippedNode.status).not.toBe("current");
    expect(skippedNode.status).toBe("skipped");
    expect(currentNode.status).toBe("current");
  });

  it("a step whose approver rows ALL exist but are ALL REMOVED aggregates to an empty set ('[]', not [null])", async () => {
    // Edge case distinct from "no approver rows at all" (the LEFT JOIN miss,
    // already covered by the SKIPPED-step test above): here every row on the
    // step is present but tombstoned, so the FILTER excludes every one of
    // them. Postgres semantics: JSON_AGG(...) FILTER (WHERE <all false>) over
    // a non-empty group is NULL, not an array containing a null element —
    // COALESCE(..., '[]') must still yield an empty array, and the step must
    // render with a null actor rather than throwing or naming a tombstone.
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const instId = await makePendingPoApproval({ po_rfq_id: rfq_id, approverUserId: IDS.users.a1_proc_poApp });

    const step = await db.one(
      `SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1 AND step_order = 1`,
      [instId]
    );
    // Tombstone the only approver row on the step (the row makePendingPoApproval
    // created and already tracked in inserted.approverIds — we're mutating it
    // in place, not adding a new row).
    await db.none(
      `UPDATE tbl_approval_step_approvers
         SET status = 'REMOVED', removed_at = NOW(), removal_reason = 'role_removed'
       WHERE approval_instance_step_id = $1`,
      [step.id]
    );

    const po_id = await makePo({
      rfq_id, status: "pending_approval", rfq_product_ids: [rfq_product_id],
      quote_ids: [quote_id], approvalInstanceId: instId,
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);
    await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po_id, instId]);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);
    expect(res.status).toBe(200);

    const stepNode = res.body.data.workflow.find((w) => w.title === "L1 approval");
    expect(stepNode).toBeDefined();
    expect(stepNode.policy).toBeNull();
    expect(stepNode.by).toBeNull();
  });
});

// ===========================================================================
// 14) Technical evaluation on PO detail — per-product clause marks, the
//     vendor's percentage, and who approved the evaluation.
// ===========================================================================
describe("GET /po/detail/:po_id — technical evaluation", () => {
  it("returns per-product clause-wise marks, the vendor's percentage, and the approver", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor(); // vendor = vendor_alpha
    const po_id = await makePo({ rfq_id, status: "approved", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    // The finalized vendor (vendor_alpha) scored 9+7 of 20 = 80%, approved by a1_proc_poApp.
    await seedTechEval({
      rfq_id,
      rfq_product_id,
      vendorId: IDS.users.vendor_alpha,
      approverUserId: IDS.users.a1_proc_poApp,
      calculatedScore: 80,
      minPass: 60,
    });
    const approverName = (await db.one(`SELECT name FROM tbl_users WHERE id=$1`, [IDS.users.a1_proc_poApp])).name;

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);
    expect(res.status).toBe(200);

    const te = res.body.data.tech_eval;
    expect(Array.isArray(te)).toBe(true);
    expect(te.length).toBe(1);

    const prod = te[0];
    expect(prod.percentage).toBe(80);
    expect(prod.minimum_passing_score).toBe(60);
    expect(prod.status).toBe("passed"); // 80 >= 60
    expect(prod.approver).toBe(approverName);
    expect(prod.approved_at).toBeTruthy();

    // Clause-wise marks present.
    expect(Array.isArray(prod.clauses)).toBe(true);
    expect(prod.clauses.length).toBe(2);
    const obtained = prod.clauses.map((c) => c.obtained_marks).sort();
    expect(obtained).toEqual([7, 9]);
    for (const c of prod.clauses) {
      expect(c.max_marks).toBe(10);
      expect(typeof c.clause_text).toBe("string");
    }
  });

  it("tech_eval is [] when the PO's products have no technical evaluation configured", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({ rfq_id, status: "approved", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id] });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${po_id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tech_eval).toEqual([]);
  });
});
