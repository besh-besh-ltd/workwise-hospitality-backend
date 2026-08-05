// Wave-style integration test for the Commercial Approver dashboard widgets.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  addProductToRfq,
  makePO,
  cleanupPurchaseOrders,
  makeApprovalInstanceWithApprover,
  cleanupApprovalInstances,
} from "../helpers/dashboardSeed.js";

const inserted = { rfqIds: [], poIds: [] };
const seeded = {};

beforeAll(async () => {
  await db.tx(async (t) => {
    // ─── 3 pending PO approvals on commApp ────────────────────────
    // PO #1 — high value (₹50,000), unit_price 500
    const r1 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Big PO",
    });
    const rp1 = await addProductToRfq(t, r1.rfq_id);
    const po1 = await makePO(t, {
      rfq_id: r1.rfq_id, rfq_product_id: rp1.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      unit_price: 500, quantity: 100, total_value: 50000,
      status: "pending_approval",
    });
    const inst1 = await makeApprovalInstanceWithApprover(t, {
      entity_type: "PO", entity_id: po1.po_id,
      approver_user_id: IDS.users.a1_proc_commApp,
      policy_id: IDS.policies.A1_P1_PO,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_buyer,
    });

    // PO #2 — mid value (₹12,000)
    const r2 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Mid PO",
    });
    const rp2 = await addProductToRfq(t, r2.rfq_id);
    const po2 = await makePO(t, {
      rfq_id: r2.rfq_id, rfq_product_id: rp2.rfq_product_id,
      vendor_user_id: IDS.users.vendor_beta,
      company_id: IDS.companies.A,
      unit_price: 120, quantity: 100, total_value: 12000,
      status: "pending_approval",
    });
    const inst2 = await makeApprovalInstanceWithApprover(t, {
      entity_type: "PO", entity_id: po2.po_id,
      approver_user_id: IDS.users.a1_proc_commApp,
      policy_id: IDS.policies.A1_P1_PO,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_buyer,
    });

    // PO #3 — small value (₹3,000)
    const r3 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Small PO",
    });
    const rp3 = await addProductToRfq(t, r3.rfq_id);
    const po3 = await makePO(t, {
      rfq_id: r3.rfq_id, rfq_product_id: rp3.rfq_product_id,
      vendor_user_id: IDS.users.vendor_gamma,
      company_id: IDS.companies.A,
      unit_price: 60, quantity: 50, total_value: 3000,
      status: "pending_approval",
    });
    const inst3 = await makeApprovalInstanceWithApprover(t, {
      entity_type: "PO", entity_id: po3.po_id,
      approver_user_id: IDS.users.a1_proc_commApp,
      policy_id: IDS.policies.A1_P1_PO,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_buyer,
    });

    // ─── A completed PO from history — establishes "last paid price" ─
    // Same product_variant as PO #1 (rp1), historical unit_price ₹400.
    // PO #1 awards at ₹500 → 25% drift = anomaly!
    const histRfq = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 2, is_published: 1, title: "Historical purchase",
    });
    const histRp = await addProductToRfq(t, histRfq.rfq_id, {
      product_variant_id: rp1.product_variant_id,
    });
    const histPo = await makePO(t, {
      rfq_id: histRfq.rfq_id, rfq_product_id: histRp.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      unit_price: 400, quantity: 100, total_value: 40000,
      status: "completed",
      created_ago_days: 30,
    });

    // ─── Negative cases ───────────────────────────────────────────
    // Pending PO approval where commApp is NOT the approver — must not surface.
    const rOther = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "PO on someone else",
    });
    const rpOther = await addProductToRfq(t, rOther.rfq_id);
    const poOther = await makePO(t, {
      rfq_id: rOther.rfq_id, rfq_product_id: rpOther.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      unit_price: 100, quantity: 1, total_value: 100,
    });
    await makeApprovalInstanceWithApprover(t, {
      entity_type: "PO", entity_id: poOther.po_id,
      approver_user_id: IDS.users.a1_proc_techApp, // different user!
      policy_id: IDS.policies.A1_P1_PO,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_buyer,
    });

    // Pending PO at A2 — wrong hotel, must not surface.
    const rA2 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A2,
      status: 1, is_published: 1, title: "PO at A2",
    });
    const rpA2 = await addProductToRfq(t, rA2.rfq_id);
    const poA2 = await makePO(t, {
      rfq_id: rA2.rfq_id, rfq_product_id: rpA2.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      unit_price: 200, quantity: 1, total_value: 200,
    });
    await makeApprovalInstanceWithApprover(t, {
      entity_type: "PO", entity_id: poA2.po_id,
      approver_user_id: IDS.users.a1_proc_commApp,
      policy_id: IDS.policies.A1_P1_PO,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A2,
      initiated_by: IDS.users.a1_proc_buyer,
    });

    // ─── Completed approvals for throughput ───────────────────────
    // 2 completed approvals: 8h and 16h turnarounds.
    const rThr1 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Throughput 8h",
    });
    const rpThr1 = await addProductToRfq(t, rThr1.rfq_id);
    const poThr1 = await makePO(t, {
      rfq_id: rThr1.rfq_id, rfq_product_id: rpThr1.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      unit_price: 100, quantity: 1, total_value: 100,
      status: "approved",
    });
    await makeApprovalInstanceWithApprover(t, {
      entity_type: "PO", entity_id: poThr1.po_id,
      approver_user_id: IDS.users.a1_proc_commApp,
      policy_id: IDS.policies.A1_P1_PO,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_buyer,
      instance_status: "APPROVED",
      approver_status: "APPROVED",
      created_ago_hours: 8 + 2,
      acted_ago_hours: 2,
    });

    const rThr2 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Throughput 16h",
    });
    const rpThr2 = await addProductToRfq(t, rThr2.rfq_id);
    const poThr2 = await makePO(t, {
      rfq_id: rThr2.rfq_id, rfq_product_id: rpThr2.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      unit_price: 100, quantity: 1, total_value: 100,
      status: "approved",
    });
    await makeApprovalInstanceWithApprover(t, {
      entity_type: "PO", entity_id: poThr2.po_id,
      approver_user_id: IDS.users.a1_proc_commApp,
      policy_id: IDS.policies.A1_P1_PO,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_buyer,
      instance_status: "APPROVED",
      approver_status: "APPROVED",
      created_ago_hours: 16 + 3,
      acted_ago_hours: 3,
    });

    seeded.po1 = po1.po_id;
    seeded.po2 = po2.po_id;
    seeded.po3 = po3.po_id;

    inserted.poIds = [
      po1.po_id, po2.po_id, po3.po_id, histPo.po_id,
      poOther.po_id, poA2.po_id, poThr1.po_id, poThr2.po_id,
    ];
    inserted.rfqIds = [
      r1.rfq_id, r2.rfq_id, r3.rfq_id, histRfq.rfq_id,
      rOther.rfq_id, rA2.rfq_id, rThr1.rfq_id, rThr2.rfq_id,
    ];
  });
});

afterAll(async () => {
  await cleanupApprovalInstances(db, "PO", inserted.poIds);
  await cleanupPurchaseOrders(db, inserted.poIds);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [inserted.rfqIds]);
  await cleanupRfqs(db, inserted.rfqIds);
  await closeDb();
});

describe("Buyer Dashboard — Commercial Approver widgets (real data)", () => {
  /* ────────── /my-commercial-approvals-pending ───────── */

  it("returns 3 pending PO approvals with exact total value + top-3 by ₹", async () => {
    const client = await httpClient(IDS.users.a1_proc_commApp);
    const res = await client
      .get("/api/v1/dashboard-v2/my-commercial-approvals-pending")
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.count).toBe(3);
    // 50000 + 12000 + 3000 = 65000
    expect(res.body.data.total_value).toBe(65000);
    expect(res.body.data.top_by_value).toHaveLength(3);

    // Sorted DESC by ₹ — highest value is PO #1 at 50000.
    expect(res.body.data.top_by_value[0].po_id).toBe(seeded.po1);
    expect(res.body.data.top_by_value[0].value).toBe(50000);
    expect(res.body.data.top_by_value[1].po_id).toBe(seeded.po2);
    expect(res.body.data.top_by_value[1].value).toBe(12000);
    expect(res.body.data.top_by_value[2].po_id).toBe(seeded.po3);
    expect(res.body.data.top_by_value[2].value).toBe(3000);
  });

  /* ────────── /deals-with-price-anomalies ───────── */

  it("returns exactly the PO whose unit_price is ≥10% above the last completed PO of the same product", async () => {
    const client = await httpClient(IDS.users.a1_proc_commApp);
    const res = await client
      .get("/api/v1/dashboard-v2/deals-with-price-anomalies")
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    const anomaly = res.body.data.items[0];
    expect(anomaly.id).toBe(seeded.po1);
    expect(anomaly.awarded_unit_price).toBe(500);
    expect(anomaly.last_paid_unit_price).toBe(400);
    // (500-400)/400 * 100 = 25%
    expect(Math.round(anomaly.drift_pct)).toBe(25);
    expect(anomaly.product_name).not.toBeNull();
  });

  /* ────────── /commercial-approval-throughput ───────── */

  it("computes avg-hours across 2 completed PO approvals", async () => {
    const client = await httpClient(IDS.users.a1_proc_commApp);
    const res = await client
      .get("/api/v1/dashboard-v2/commercial-approval-throughput")
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body.data.unit).toBe("hrs");
    // 8h + 16h → avg 12h. Allow small drift from INSERT timing.
    expect(res.body.data.current_period_avg_hours).toBeGreaterThan(11.9);
    expect(res.body.data.current_period_avg_hours).toBeLessThan(12.1);
    expect(res.body.data.prior_period_avg_hours).toBeNull();
  });

  /* ────────── Scope ───────── */

  it("does not include POs at A2 or where commApp is not the approver", async () => {
    const client = await httpClient(IDS.users.a1_proc_commApp);
    const res = await client
      .get("/api/v1/dashboard-v2/my-commercial-approvals-pending")
      .query({ hotel_ids: String(IDS.hotels.A1) });
    // Only 3 seeded for commApp at A1.
    expect(res.body.data.count).toBe(3);
  });

  it("Hotel B user sees zero Commercial Approver widgets", async () => {
    const client = await httpClient(IDS.users.companyB_admin);
    const [pend, anom, thru] = await Promise.all([
      client.get("/api/v1/dashboard-v2/my-commercial-approvals-pending").query({ hotel_ids: String(IDS.hotels.B1) }),
      client.get("/api/v1/dashboard-v2/deals-with-price-anomalies").query({ hotel_ids: String(IDS.hotels.B1) }),
      client.get("/api/v1/dashboard-v2/commercial-approval-throughput").query({ hotel_ids: String(IDS.hotels.B1) }),
    ]);
    expect(pend.body.data.count).toBe(0);
    expect(pend.body.data.total_value).toBe(0);
    expect(anom.body.data.count).toBe(0);
    expect(thru.body.data.current_period_avg_hours).toBeNull();
  });
});
