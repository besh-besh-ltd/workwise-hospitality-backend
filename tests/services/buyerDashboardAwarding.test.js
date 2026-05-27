// Wave-style integration test for the Awarding P1/P2 dashboard widgets.

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

const inserted = { rfqIds: [], poIds: [], nrqIds: [], roundIds: [] };
const seeded = {};

beforeAll(async () => {
  await db.tx(async (t) => {
    // ── 2 pending NEGOTIATION_QUOTE award approvals on poApp ───────
    // RFQ with a negotiation round and a quote needing award approval.
    const r1 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Award candidate 1",
    });
    const rp1 = await addProductToRfq(t, r1.rfq_id);
    const round1 = await t.one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, round_number, status, created_by, end_date, vendor_ids)
       VALUES ($1, 1, 'CLOSED', $2, NOW() - INTERVAL '1 day', ARRAY[$3]::int[])
       RETURNING id`,
      [r1.rfq_id, IDS.users.a1_proc_commEval, IDS.users.vendor_alpha]
    );
    const nrq1 = await t.one(
      `INSERT INTO tbl_negotiation_round_quotes
         (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at)
       VALUES ($1, $2, $3, 7500, NOW() - INTERVAL '12 hours') RETURNING id`,
      [round1.id, IDS.users.vendor_alpha, rp1.rfq_product_id]
    );
    const award1 = await makeApprovalInstanceWithApprover(t, {
      entity_type: "NEGOTIATION_QUOTE", entity_id: nrq1.id,
      approver_user_id: IDS.users.a1_proc_poApp,
      policy_id: IDS.policies.A1_P1_NEGOTIATION_QUOTE,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_commEval,
    });

    const r2 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Award candidate 2",
    });
    const rp2 = await addProductToRfq(t, r2.rfq_id);
    const round2 = await t.one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, round_number, status, created_by, end_date, vendor_ids)
       VALUES ($1, 1, 'CLOSED', $2, NOW() - INTERVAL '1 day', ARRAY[$3]::int[])
       RETURNING id`,
      [r2.rfq_id, IDS.users.a1_proc_commEval, IDS.users.vendor_beta]
    );
    const nrq2 = await t.one(
      `INSERT INTO tbl_negotiation_round_quotes
         (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at)
       VALUES ($1, $2, $3, 4500, NOW() - INTERVAL '6 hours') RETURNING id`,
      [round2.id, IDS.users.vendor_beta, rp2.rfq_product_id]
    );
    const award2 = await makeApprovalInstanceWithApprover(t, {
      entity_type: "NEGOTIATION_QUOTE", entity_id: nrq2.id,
      approver_user_id: IDS.users.a1_proc_poApp,
      policy_id: IDS.policies.A1_P1_NEGOTIATION_QUOTE,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_commEval,
    });

    // ── 1 recently APPROVED award by poApp ────────────────────────
    const r3 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Recently awarded",
    });
    const rp3 = await addProductToRfq(t, r3.rfq_id);
    const round3 = await t.one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, round_number, status, created_by, end_date, closed_at, vendor_ids)
       VALUES ($1, 1, 'COMPLETED', $2, NOW() - INTERVAL '5 days', NOW() - INTERVAL '4 days', ARRAY[$3]::int[])
       RETURNING id`,
      [r3.rfq_id, IDS.users.a1_proc_commEval, IDS.users.vendor_alpha]
    );
    const nrq3 = await t.one(
      `INSERT INTO tbl_negotiation_round_quotes
         (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at)
       VALUES ($1, $2, $3, 9000, NOW() - INTERVAL '5 days') RETURNING id`,
      [round3.id, IDS.users.vendor_alpha, rp3.rfq_product_id]
    );
    await makeApprovalInstanceWithApprover(t, {
      entity_type: "NEGOTIATION_QUOTE", entity_id: nrq3.id,
      approver_user_id: IDS.users.a1_proc_poApp,
      policy_id: IDS.policies.A1_P1_NEGOTIATION_QUOTE,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      initiated_by: IDS.users.a1_proc_commEval,
      instance_status: "APPROVED",
      approver_status: "APPROVED",
      created_ago_hours: 24 * 4,
      acted_ago_hours: 24 * 3,
    });
    // PO linked to that award.
    const poRecent = await makePO(t, {
      rfq_id: r3.rfq_id, rfq_product_id: rp3.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      unit_price: 90, quantity: 100, total_value: 9000,
      status: "approved",
    });

    // ── POs for value pipeline at A1 ────────────────────────────
    // Completed (status='completed'): ₹15000
    const rPipe1 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 2, is_published: 1, title: "Pipeline completed",
    });
    const rpPipe1 = await addProductToRfq(t, rPipe1.rfq_id);
    const poComp1 = await makePO(t, {
      rfq_id: rPipe1.rfq_id, rfq_product_id: rpPipe1.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      unit_price: 150, quantity: 100, total_value: 15000,
      status: "completed",
    });

    // Approved (still counts as completed bucket): ₹5000
    const rPipe2 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Pipeline approved",
    });
    const rpPipe2 = await addProductToRfq(t, rPipe2.rfq_id);
    const poApp = await makePO(t, {
      rfq_id: rPipe2.rfq_id, rfq_product_id: rpPipe2.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      unit_price: 50, quantity: 100, total_value: 5000,
      status: "approved",
    });

    // Ongoing: pending_approval ₹2000 + acceptance_pending ₹3000
    const rPipe3 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Pipeline pending_approval",
    });
    const rpPipe3 = await addProductToRfq(t, rPipe3.rfq_id);
    const poPa = await makePO(t, {
      rfq_id: rPipe3.rfq_id, rfq_product_id: rpPipe3.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      unit_price: 20, quantity: 100, total_value: 2000,
      status: "pending_approval",
    });

    const rPipe4 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Pipeline acceptance_pending",
    });
    const rpPipe4 = await addProductToRfq(t, rPipe4.rfq_id);
    const poAp = await makePO(t, {
      rfq_id: rPipe4.rfq_id, rfq_product_id: rpPipe4.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      unit_price: 30, quantity: 100, total_value: 3000,
      status: "acceptance_pending",
    });

    // Rejected — should NOT count toward either bucket.
    const rPipe5 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Pipeline rejected",
    });
    const rpPipe5 = await addProductToRfq(t, rPipe5.rfq_id);
    const poRej = await makePO(t, {
      rfq_id: rPipe5.rfq_id, rfq_product_id: rpPipe5.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      unit_price: 10, quantity: 100, total_value: 1000,
      status: "rejected",
    });

    seeded.award1 = award1.instance_id;
    seeded.award2 = award2.instance_id;
    seeded.r3 = r3.rfq_id;
    seeded.poRecent = poRecent.po_id;

    inserted.nrqIds = [nrq1.id, nrq2.id, nrq3.id];
    inserted.roundIds = [round1.id, round2.id, round3.id];
    inserted.poIds = [
      poRecent.po_id, poComp1.po_id, poApp.po_id, poPa.po_id, poAp.po_id, poRej.po_id,
    ];
    inserted.rfqIds = [
      r1.rfq_id, r2.rfq_id, r3.rfq_id,
      rPipe1.rfq_id, rPipe2.rfq_id, rPipe3.rfq_id, rPipe4.rfq_id, rPipe5.rfq_id,
    ];
  });
});

afterAll(async () => {
  await cleanupApprovalInstances(db, "NEGOTIATION_QUOTE", inserted.nrqIds);
  await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE id = ANY($1)`, [inserted.nrqIds]);
  await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1)`, [inserted.roundIds]);
  await cleanupPurchaseOrders(db, inserted.poIds);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [inserted.rfqIds]);
  await cleanupRfqs(db, inserted.rfqIds);
  await closeDb();
});

describe("Buyer Dashboard — Awarding P1/P2 widgets (real data)", () => {
  /* ────────── /my-award-approvals-pending ───────── */

  it("returns the 2 pending NEGOTIATION_QUOTE award approvals with accurate ₹", async () => {
    const client = await httpClient(IDS.users.a1_proc_poApp);
    const res = await client
      .get("/api/v1/dashboard-v2/my-award-approvals-pending")
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
    // Quoted prices: 7500 + 4500 = 12000
    expect(res.body.data.total_value).toBe(12000);

    const ids = res.body.data.items.map((i) => i.id).sort();
    expect(ids).toEqual([seeded.award1, seeded.award2].sort());
  });

  /* ────────── /recent-awards ───────── */

  it("returns the recently cleared award with linked PO", async () => {
    const client = await httpClient(IDS.users.a1_proc_poApp);
    const res = await client
      .get("/api/v1/dashboard-v2/recent-awards")
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(1);
    const award = res.body.data.items[0];
    expect(award.rfq_id).toBe(seeded.r3);
    expect(Number(award.value)).toBe(9000);
    expect(award.po_id).toBe(seeded.poRecent);
    expect(res.body.data.total_value).toBe(9000);
  });

  /* ────────── /award-value-pipeline ───────── */

  it("aggregates POs into completed vs ongoing value buckets", async () => {
    const client = await httpClient(IDS.users.a1_proc_poApp);
    const res = await client
      .get("/api/v1/dashboard-v2/award-value-pipeline")
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    // Completed = poRecent(9000) [status='approved'] + poComp1(15000) [completed] + poApp(5000) [approved] = 29000
    // Ongoing  = poPa(2000) [pending_approval] + poAp(3000) [acceptance_pending] = 5000
    // Rejected (1000) excluded.
    expect(res.body.data.completed_value).toBe(29000);
    expect(res.body.data.completed_po_count).toBe(3);
    expect(res.body.data.ongoing_value).toBe(5000);
    expect(res.body.data.ongoing_po_count).toBe(2);
  });

  /* ────────── Scope isolation ───────── */

  it("Hotel B sees zero Awarding widgets for our seeded data", async () => {
    const client = await httpClient(IDS.users.companyB_admin);
    const [pending, recent, pipeline] = await Promise.all([
      client.get("/api/v1/dashboard-v2/my-award-approvals-pending").query({ hotel_ids: String(IDS.hotels.B1) }),
      client.get("/api/v1/dashboard-v2/recent-awards").query({ hotel_ids: String(IDS.hotels.B1) }),
      client.get("/api/v1/dashboard-v2/award-value-pipeline").query({ hotel_ids: String(IDS.hotels.B1) }),
    ]);
    expect(pending.body.data.count).toBe(0);
    expect(pending.body.data.total_value).toBe(0);
    expect(recent.body.data.items.length).toBe(0);
    expect(pipeline.body.data.completed_value).toBe(0);
    expect(pipeline.body.data.ongoing_value).toBe(0);
  });
});
