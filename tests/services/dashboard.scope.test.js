// Buyer-dashboard scoping regression suite.
//
// The dashboard model had ZERO references to tbl_user_role_scopes and no acl()
// on any /dashboard-v2 route. It scoped by `buyer_company_id` — the BILLING
// account — which in production maps to EIGHT distinct legal entities under a
// single id (buyer_company_id 13 = Orchid Hotels Pune / Kamat Hotels India /
// Phileein / SLPD / Zaffiro / Envotel / ILEX / Chandi). Widgets missing a
// hotel filter therefore crossed legal-entity boundaries, and the department
// and process axes were unenforceable.
//
// Each test below was confirmed RED against the unpatched model.
//
// Fixture axes used here (see tests/fixtures/network.js):
//   - Hospitality A (buyer company A) vs Hospitality B (buyer company B)
//     → the cross-TENANT axis. Used for /smart-insights, whose market-average
//       LATERAL had no company predicate at all.
//   - Hotel A1 vs Hotel A2, both under Hospitality A → the cross-BUSINESS-UNIT
//     axis inside one legal entity. This is the shape that leaks in production.
//   - Department Procurement vs Engineering, both at hotel A1 → the axis that
//     was structurally unenforceable because the model never joined RBAC.

import { describe, it, expect, afterAll, beforeAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  makePO,
  cleanupPurchaseOrders,
  makeApprovalInstanceWithApprover,
  cleanupApprovalInstances,
  makeTechEval,
  cleanupTechEvals,
  insertVendorQuote,
} from "../helpers/dashboardSeed.js";

const BASE = "/api/v1/dashboard-v2";
const WIDE = { start_date: "2020-01-01", end_date: "2999-01-01" };
const TAG = "DSC" + String(Date.now()).slice(-6);

// Everything we create, for teardown.
const seeded = {
  rfqIds: [],
  poIds: [],
  productIds: [],
  variantIds: [],
  rfqProductIds: [],
  approvalEntityIds: { PO: [], TECHNICAL: [] },
};

/** Create a product + variant pair we fully control the price history of. */
async function makeVariant(label) {
  const p = await db.one(
    `INSERT INTO tbl_product (name, slug, added_by) VALUES ($1, $2, $3) RETURNING id`,
    [`${TAG} ${label} P`, `${TAG}-${label}-p`.toLowerCase(), IDS.users.a1_proc_buyer]
  );
  const v = await db.one(
    `INSERT INTO tbl_product_variant (name, slug, added_by, product_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`${TAG} ${label}`, `${TAG}-${label}-v`.toLowerCase(), IDS.users.a1_proc_buyer, p.id]
  );
  seeded.productIds.push(p.id);
  seeded.variantIds.push(v.id);
  return { productId: p.id, variantId: v.id, name: `${TAG} ${label}` };
}

async function addProduct(rfqId, variantId) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', $2, 1) RETURNING id`,
    [rfqId, variantId]
  );
  seeded.rfqProductIds.push(row.id);
  return row.id;
}

/** Insert a priced quote line for `variantId` on `rfqId`, authored by a vendor. */
async function quoteAt(rfqId, variantId, unitPrice, vendorId = IDS.users.vendor_alpha) {
  const quoteId = await insertVendorQuote(db, { rfq_id: rfqId, vendor_user_id: vendorId });
  const parent = await db.one(`SELECT rfq_no FROM tbl_rfq WHERE id = $1`, [rfqId]);
  await db.none(
    `INSERT INTO tbl_quote_items
       (quote_id, rfq_id, rfq_no, product_variant_id, unit_price, quantity, total_price, comment, delivery_period)
     VALUES ($1, $2, $3, $4, $5, '1', $5, '', '')`,
    [quoteId, rfqId, parent.rfq_no, variantId, unitPrice]
  );
  return quoteId;
}

// ── Fixture graph ────────────────────────────────────────────────────
// A) CROSS-TENANT (smart-insights): one variant quoted in BOTH buyer companies.
//    A's own average is 1000; B quotes 100. Cross-tenant mean = 700, so A's
//    1000 clears the model's `> market * 1.15` (1150 > … no — 1000 > 805) and
//    the widget renders B's prices in A's "Market: ₹…" copy. Scoped to A only,
//    the market IS A's own average and the alert cannot fire.
// B) CROSS-BU (deals-with-price-anomalies): a completed PO at hotel A2 sets the
//    "last paid" benchmark that an A1-only approver is shown.
// C) CROSS-DEPARTMENT (abc / cost-intelligence / category-insights / the "my"
//    widgets): an RFQ at hotel A1 but department Engineering, invisible to a
//    Procurement-scoped user in every other buyer surface.
const fx = {};

beforeAll(async () => {
  // ---- A) cross-tenant variant -------------------------------------
  fx.sharedVariant = await makeVariant("SHARED");

  const aRfq = await makeRfqVisibleToDashboard(db, {
    createdBy: IDS.users.a1_proc_buyer,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    department: IDS.departments.proc, process: IDS.processes.A_P1,
    is_published: 1, status: 1, title: `${TAG} A tenant RFQ`,
  });
  seeded.rfqIds.push(aRfq.rfq_id);
  fx.aRfqId = aRfq.rfq_id;
  await addProduct(aRfq.rfq_id, fx.sharedVariant.variantId);
  await quoteAt(aRfq.rfq_id, fx.sharedVariant.variantId, 1000);
  await quoteAt(aRfq.rfq_id, fx.sharedVariant.variantId, 1000, IDS.users.vendor_beta);

  const bRfq = await makeRfqVisibleToDashboard(db, {
    createdBy: IDS.users.companyB_admin,
    hospitality: IDS.hospitality.B, hotel: IDS.hotels.B1,
    department: null, process: IDS.processes.B_P1,
    is_published: 1, status: 1, title: `${TAG} B tenant RFQ`,
  });
  seeded.rfqIds.push(bRfq.rfq_id);
  fx.bRfqId = bRfq.rfq_id;
  await addProduct(bRfq.rfq_id, fx.sharedVariant.variantId);
  await quoteAt(bRfq.rfq_id, fx.sharedVariant.variantId, 100);

  // ---- B) cross-BU completed PO ------------------------------------
  fx.buVariant = await makeVariant("CROSSBU");

  const a2Rfq = await makeRfqVisibleToDashboard(db, {
    createdBy: IDS.users.a1_proc_buyer,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A2,
    department: IDS.departments.proc, process: IDS.processes.A_P1,
    is_published: 1, status: 1, title: `${TAG} A2 RFQ`,
  });
  seeded.rfqIds.push(a2Rfq.rfq_id);
  fx.a2RfqId = a2Rfq.rfq_id;
  const a2Prod = await addProduct(a2Rfq.rfq_id, fx.buVariant.variantId);
  const a2Po = await makePO(db, {
    rfq_id: a2Rfq.rfq_id, rfq_product_id: a2Prod,
    vendor_user_id: IDS.users.vendor_alpha, company_id: IDS.companies.A,
    status: "completed", unit_price: 100, quantity: 1, total_value: 100,
    created_ago_days: 30,
  });
  seeded.poIds.push(a2Po.po_id);

  // The A1 approver's own pending PO for the same variant, priced well above
  // the A2 "last paid" figure so the anomaly row is emitted.
  const a1Rfq = await makeRfqVisibleToDashboard(db, {
    createdBy: IDS.users.a1_proc_buyer,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    department: IDS.departments.proc, process: IDS.processes.A_P1,
    is_published: 1, status: 1, title: `${TAG} A1 anomaly RFQ`,
  });
  seeded.rfqIds.push(a1Rfq.rfq_id);
  const a1Prod = await addProduct(a1Rfq.rfq_id, fx.buVariant.variantId);
  const a1Po = await makePO(db, {
    rfq_id: a1Rfq.rfq_id, rfq_product_id: a1Prod,
    vendor_user_id: IDS.users.vendor_alpha, company_id: IDS.companies.A,
    status: "pending_approval", unit_price: 500, quantity: 1, total_value: 500,
  });
  seeded.poIds.push(a1Po.po_id);
  await makeApprovalInstanceWithApprover(db, {
    entity_type: "PO", entity_id: a1Po.po_id,
    approver_user_id: IDS.users.a1_proc_commApp,
    policy_id: IDS.policies.A1_P1_PO,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
  });
  seeded.approvalEntityIds.PO.push(a1Po.po_id);

  // ---- C) cross-department RFQ at the SAME hotel --------------------
  fx.deptVariant = await makeVariant("ENGDEPT");

  const engRfq = await makeRfqVisibleToDashboard(db, {
    createdBy: IDS.users.a1_eng_buyer,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    department: IDS.departments.eng, process: IDS.processes.A_P1,
    is_published: 1, status: 1, title: `${TAG} A1 Engineering RFQ`,
  });
  seeded.rfqIds.push(engRfq.rfq_id);
  fx.engRfqId = engRfq.rfq_id;
  const engProd = await addProduct(engRfq.rfq_id, fx.deptVariant.variantId);
  fx.engRfqProductId = engProd;
  const engPo = await makePO(db, {
    rfq_id: engRfq.rfq_id, rfq_product_id: engProd,
    vendor_user_id: IDS.users.vendor_alpha, company_id: IDS.companies.A,
    status: "approved", unit_price: 9_000_000, quantity: 1, total_value: 9_000_000,
  });
  seeded.poIds.push(engPo.po_id);
  // Quotes so the Engineering item also shows up in cost-intelligence's
  // vendor-comparison / price-trend panels.
  await quoteAt(engRfq.rfq_id, fx.deptVariant.variantId, 9_000_000);
  // A tech-eval + a quote-compare-shaped RFQ, both Engineering.
  const te = await makeTechEval(db, {
    rfq_id: engRfq.rfq_id, rfq_product_id: engProd, isComplete: false, clauseCount: 1,
  });
  fx.engTechEvalId = te.tech_eval_id;
  await db.none(
    `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
       (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response)
     VALUES ($1, $2, 'disagree')`,
    [te.clause_ids[0], IDS.users.vendor_alpha]
  );

  // A second Engineering RFQ at hotel A1 that is parked in the quote-compare
  // gate: quotes in, no negotiation, no PO. Feeds /my-quote-compares.
  const engQcRfq = await makeRfqVisibleToDashboard(db, {
    createdBy: IDS.users.a1_eng_buyer,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    department: IDS.departments.eng, process: IDS.processes.A_P1,
    is_published: 1, status: 1, title: `${TAG} A1 Engineering QC RFQ`,
  });
  seeded.rfqIds.push(engQcRfq.rfq_id);
  fx.engQcRfqId = engQcRfq.rfq_id;
  await addProduct(engQcRfq.rfq_id, fx.deptVariant.variantId);
  await quoteAt(engQcRfq.rfq_id, fx.deptVariant.variantId, 1234);

  // ---- D) an approval instance for a hotel OUTSIDE the approver's set
  // Same approver, but the instance is filed at hotel A2. /action-center's
  // count filters on i.hotel_id; /pending-approvals' list did not.
  await makeApprovalInstanceWithApprover(db, {
    entity_type: "TECHNICAL", entity_id: fx.a2RfqId,
    approver_user_id: IDS.users.a1_proc_buyer,
    policy_id: IDS.policies.A1_P1_TECHNICAL,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A2,
  });
  seeded.approvalEntityIds.TECHNICAL.push(fx.a2RfqId);
});

afterAll(async () => {
  await cleanupApprovalInstances(db, "PO", seeded.approvalEntityIds.PO);
  await cleanupApprovalInstances(db, "TECHNICAL", seeded.approvalEntityIds.TECHNICAL);
  await cleanupPurchaseOrders(db, seeded.poIds);
  await cleanupTechEvals(db, seeded.rfqIds);
  if (seeded.variantIds.length) {
    await db.none(
      `DELETE FROM tbl_quote_items WHERE product_variant_id = ANY($1)`,
      [seeded.variantIds]
    );
    await db.none(`DELETE FROM tbl_rfq_products WHERE product_variant_id = ANY($1)`, [seeded.variantIds]);
  }
  await cleanupRfqs(db, seeded.rfqIds);
  if (seeded.variantIds.length) {
    await db.none(`DELETE FROM tbl_product_variant WHERE id = ANY($1)`, [seeded.variantIds]);
  }
  if (seeded.productIds.length) {
    await db.none(`DELETE FROM tbl_product WHERE id = ANY($1)`, [seeded.productIds]);
  }
  await closeDb();
});

// ═════════════════════════════════════════════════════════════════════
describe("dashboard scoping — cross-tenant", () => {
  it("/smart-insights never builds a benchmark from another tenant's quotes", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`${BASE}/smart-insights`).query({ hotel_ids: String(IDS.hotels.A1), ...WIDE });
    expect(res.status).toBe(200);

    const insights = res.body.data.insights || [];
    const leak = insights.find(
      (i) => i.type === "price_alert" && String(i.title).includes(fx.sharedVariant.name)
    );
    // The only reason this alert can fire is company B's ₹100 quote dragging
    // the "market average" below company A's own ₹1000.
    expect(leak).toBeUndefined();
  });

  it("/smart-insights never renders a cross-tenant mean in its copy", async () => {
    // Direct assertion on the rendered number rather than on the alert's
    // presence. A(1000, 1000) + B(100) has a cross-tenant mean of exactly 700;
    // A's own mean is 1000. ₹700.00 can only appear if B's quote was read.
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`${BASE}/smart-insights`).query({ hotel_ids: String(IDS.hotels.A1), ...WIDE });
    const blob = JSON.stringify(res.body.data.insights || []);
    expect(blob).not.toContain("₹700.00");
  });
});

describe("dashboard scoping — cross-business-unit inside one legal entity", () => {
  it("/deals-with-price-anomalies does not benchmark against another BU's paid price", async () => {
    const client = await httpClient(IDS.users.a1_proc_commApp);
    const res = await client.get(`${BASE}/deals-with-price-anomalies`).query({ hotel_ids: String(IDS.hotels.A1) });
    expect(res.status).toBe(200);
    const items = res.body.data.items || [];
    const leak = items.find((i) => String(i.product_name).includes(fx.buVariant.name));
    // The only "last paid" price for this variant lives at hotel A2, which is
    // outside this approver's scope — so no anomaly row may be produced.
    expect(leak).toBeUndefined();
  });

  it("/pending-approvals agrees with the /action-center badge count", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const q = { hotel_ids: String(IDS.hotels.A1), ...WIDE };

    const center = await client.get(`${BASE}/action-center`).query(q);
    const list = await client.get(`${BASE}/pending-approvals`).query(q);
    expect(center.status).toBe(200);
    expect(list.status).toBe(200);

    expect(Array.isArray(list.body.data)).toBe(true);
    expect(list.body.data.length).toBe(center.body.data.pending_approvals);
  });

  it("/pending-approvals excludes an approval filed at a hotel outside the user's scope", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`${BASE}/pending-approvals`).query({ hotel_ids: String(IDS.hotels.A1), ...WIDE });
    const rows = res.body.data || [];
    const leak = rows.find((r) => r.entity_type === "TECHNICAL" && Number(r.entity_id) === Number(fx.a2RfqId));
    expect(leak).toBeUndefined();
  });
});

describe("dashboard scoping — department axis on the high-value data widgets", () => {
  const q = { hotel_ids: String(IDS.hotels.A1), ...WIDE };

  it("/abc-analysis excludes an out-of-department item", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`${BASE}/abc-analysis`).query(q);
    expect(res.status).toBe(200);
    const names = (res.body.data.items || []).map((i) => i.name);
    expect(names).not.toContain(fx.deptVariant.name);
  });

  it("/abc-analysis total value excludes out-of-department spend", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`${BASE}/abc-analysis`).query(q);
    // The Engineering PO alone is ₹90 lakh; if it leaked, the total would
    // dwarf everything else in the fixture set.
    expect(Number(res.body.data.total_value)).toBeLessThan(9_000_000);
  });

  it("/category-insights does not name an out-of-department item", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`${BASE}/category-insights`).query({ ...q, dimension: "item" });
    expect(res.status).toBe(200);
    const names = (res.body.data.categories || []).map((c) => c.category_name);
    expect(names).not.toContain(fx.deptVariant.name);
  });

  it("/cost-intelligence does not offer an out-of-department item in its selector", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`${BASE}/cost-intelligence`).query(q);
    expect(res.status).toBe(200);
    const ids = (res.body.data.top_products || []).map((p) => Number(p.product_variant_id));
    expect(ids).not.toContain(Number(fx.deptVariant.variantId));
  });

  it("/cost-intelligence refuses to benchmark an explicitly requested out-of-scope item", async () => {
    // product_variant_id is a client-supplied query param. Asking for an item
    // the caller has no scope for must not return its price history.
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client
      .get(`${BASE}/cost-intelligence`)
      .query({ ...q, product_variant_id: String(fx.deptVariant.variantId) });
    expect(res.status).toBe(200);
    expect(res.body.data.benchmark?.benchmark_price ?? null).toBeNull();
    expect(res.body.data.vendor_comparison || []).toHaveLength(0);
  });

  it("/procurement-snapshot total spend excludes out-of-department POs", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`${BASE}/procurement-snapshot`).query(q);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.total_spend)).toBeLessThan(9_000_000);
  });
});

describe('dashboard scoping — the "my" widgets are bound to the calling user', () => {
  const q = { hotel_ids: String(IDS.hotels.A1) };

  it("/my-tech-evals-pending excludes an out-of-scope department's evaluation", async () => {
    const client = await httpClient(IDS.users.a1_proc_techEval);
    const res = await client.get(`${BASE}/my-tech-evals-pending`).query(q);
    expect(res.status).toBe(200);
    const ids = (res.body.data.items || []).map((i) => Number(i.id));
    expect(ids).not.toContain(Number(fx.engTechEvalId));
  });

  it("/tech-evals-with-disagreements excludes an out-of-scope department's evaluation", async () => {
    const client = await httpClient(IDS.users.a1_proc_techEval);
    const res = await client.get(`${BASE}/tech-evals-with-disagreements`).query(q);
    expect(res.status).toBe(200);
    const ids = (res.body.data.items || []).map((i) => Number(i.id));
    expect(ids).not.toContain(Number(fx.engTechEvalId));
  });

  it("/my-quote-compares excludes an out-of-scope department's RFQ", async () => {
    const client = await httpClient(IDS.users.a1_proc_commEval);
    const res = await client.get(`${BASE}/my-quote-compares`).query(q);
    expect(res.status).toBe(200);
    const ids = (res.body.data.items || []).map((i) => Number(i.id));
    expect(ids).not.toContain(Number(fx.engQcRfqId));
  });

  it("/award-value-pipeline excludes out-of-scope department PO value", async () => {
    const client = await httpClient(IDS.users.a1_proc_poApp);
    const res = await client.get(`${BASE}/award-value-pipeline`).query(q);
    expect(res.status).toBe(200);
    const total = Number(res.body.data.completed_value) + Number(res.body.data.ongoing_value);
    expect(total).toBeLessThan(9_000_000);
  });

  it("a vendor cannot reach a buyer dashboard widget at all", async () => {
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [IDS.users.vendor_alpha]);
    try {
      const client = await httpClient(IDS.users.vendor_alpha);
      const res = await client.get(`${BASE}/abc-analysis`).query({ hotel_ids: String(IDS.hotels.A1), ...WIDE });
      expect(res.status).toBe(403);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [IDS.users.vendor_alpha]);
    }
  });

  it("a user with no role scope for the hotel gets an empty dashboard, not another BU's", async () => {
    // companyB_admin is scoped to Hospitality B only. Asking for hotel A1 must
    // never return Hospitality A rows.
    const client = await httpClient(IDS.users.companyB_admin);
    const res = await client.get(`${BASE}/abc-analysis`).query({ hotel_ids: String(IDS.hotels.A1), ...WIDE });
    expect(res.status).toBe(200);
    const names = (res.body.data.items || []).map((i) => i.name);
    expect(names).not.toContain(fx.buVariant.name);
    expect(names).not.toContain(fx.deptVariant.name);
  });
});
