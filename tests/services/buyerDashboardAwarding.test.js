// Integration test for the Awarding widgets. The award IS the PO:
//   · "POs awaiting my approval" — the PO approval queue (P1/P2/P3 approve POs
//     on prod; the old widget queried NEGOTIATION_QUOTE instead);
//   · "Recently approved POs" — POs whose approval completed in the window;
//   · "PO value by stage" — every PO raised in the window, bucketed.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import moment from "moment-timezone";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  addProductToRfq,
  cleanupTechEvals,
  makePO,
  cleanupPurchaseOrders,
  makeApprovalChain,
  cleanupApprovalInstanceIds,
} from "../helpers/dashboardSeed.js";

const inserted = { rfqIds: [], poIds: [], instanceIds: [] };
const seeded = {};
const poApp = IDS.users.a1_proc_poApp;
const istDate = (d) => moment.tz("Asia/Kolkata").add(d, "days").format("YYYY-MM-DD");

/** An RFQ + product + PO; optionally a PO approval chain. */
async function po(t, title, { value, lineTotal, status, createdAgoDays = 0, hotel = IDS.hotels.A1, approval }) {
  const r = await makeRfqVisibleToDashboard(t, {
    createdBy: IDS.users.a1_proc_buyer, hospitality: IDS.hospitality.A, hotel,
    status: 1, is_published: 1, title,
  });
  inserted.rfqIds.push(r.rfq_id);
  const rp = await addProductToRfq(t, r.rfq_id);
  const p = await makePO(t, {
    rfq_id: r.rfq_id, rfq_product_id: rp.rfq_product_id, vendor_user_id: IDS.users.vendor_alpha,
    company_id: IDS.companies.A, status, unit_price: value, quantity: 1, total_value: value,
    created_ago_days: createdAgoDays, line_total: lineTotal,
  });
  inserted.poIds.push(p.po_id);
  if (approval) {
    const { instance_id } = await makeApprovalChain(t, {
      entity_type: "PO", entity_id: p.po_id, policy_id: IDS.policies.A1_P1_PO,
      hospitality: IDS.hospitality.A, hotel: approval.hotel === undefined ? hotel : approval.hotel,
      status: approval.status ?? "PENDING",
      created_ago_hours: approval.createdAgo,
      metadata: { po_id: p.po_id, rfq_id: r.rfq_id, total_value: value },
      steps: [approval.status && approval.status !== "PENDING"
        ? { approver: approval.approver ?? poApp, status: approval.status, acted_ago_hours: approval.actedAgo }
        : { approver: approval.approver ?? poApp }],
    });
    inserted.instanceIds.push(instance_id);
  }
  return { rfq_id: r.rfq_id, po_id: p.po_id };
}

beforeAll(async () => {
  await db.tx(async (t) => {
    // ── Awaiting poApp's approval ─────────────────────────────────────
    const p1 = await po(t, "PO awaiting — oldest", { value: 12000, status: "pending_approval", approval: { createdAgo: 30 } });
    // Company-level approval (NULL hotel) — prod PO 3's shape, still mine.
    const p2 = await po(t, "PO awaiting — company level", { value: 3000, status: "pending_approval", approval: { createdAgo: 10, hotel: null } });
    const pA2 = await po(t, "PO awaiting at A2", { value: 700, status: "pending_approval", hotel: IDS.hotels.A2, approval: { createdAgo: 5 } });
    const pElse = await po(t, "PO awaiting someone else", { value: 800, status: "pending_approval", approval: { createdAgo: 5, approver: IDS.users.a1_proc_commApp } });

    // ── Approved ──────────────────────────────────────────────────────
    const p3 = await po(t, "PO approved by me 2 days ago", {
      value: 9000, status: "approved", createdAgoDays: 3, approval: { status: "APPROVED", createdAgo: 72, actedAgo: 48 },
    });
    const p5 = await po(t, "PO dispatched, approved 4 days ago", {
      value: 6000, status: "dispatched", createdAgoDays: 5,
      approval: { status: "APPROVED", createdAgo: 120, actedAgo: 96, approver: IDS.users.a1_proc_commApp },
    });
    const p4 = await po(t, "PO approved 39 days ago", {
      value: 4000, status: "approved", createdAgoDays: 40,
      approval: { status: "APPROVED", createdAgo: 960, actedAgo: 936, approver: IDS.users.a1_proc_commApp },
    });

    // Header total_value carries freight the lines don't (5,000 vs 4,800).
    // Spend everywhere is the line total, so every PO widget must show 4,800.
    const p9 = await po(t, "PO approved yesterday, header ≠ lines", {
      value: 5000, lineTotal: 4800, status: "approved", createdAgoDays: 1,
      approval: { status: "APPROVED", createdAgo: 24, actedAgo: 20, approver: IDS.users.a1_proc_commApp },
    });

    // Internally approved yesterday but the vendor hasn't accepted: not
    // committed spend, so not a "recently approved PO" either.
    const p10 = await po(t, "PO approved, awaiting vendor acceptance", {
      value: 700, status: "acceptance_pending", createdAgoDays: 1,
      approval: { status: "APPROVED", createdAgo: 24, actedAgo: 12 },
    });

    // ── Only in the value pipeline ────────────────────────────────────
    const p6 = await po(t, "PO rejected", { value: 1000, status: "rejected" });
    const p7 = await po(t, "PO cancelled", { value: 500, status: "cancelled" });
    const p8 = await po(t, "PO draft", { value: 250, status: "draft" });

    Object.assign(seeded, { p1, p2, pA2, pElse, p3, p4, p5, p6, p7, p8, p9, p10 });
  });
});

afterAll(async () => {
  await cleanupApprovalInstanceIds(db, inserted.instanceIds);
  await cleanupPurchaseOrders(db, inserted.poIds);
  await cleanupTechEvals(db, inserted.rfqIds);
  await cleanupRfqs(db, inserted.rfqIds);
  await closeDb();
});

const get = async (user, path, query = {}) => {
  const client = await httpClient(user);
  return client.get(`/api/v1/dashboard-v2/${path}`).query({ hotel_ids: String(IDS.hotels.A1), ...query });
};

describe("POs awaiting my approval", () => {
  it("lists my PO approvals, oldest first, with PO number, RFQ and ₹", async () => {
    const res = await get(poApp, "my-award-approvals-pending");
    expect(res.status).toBe(200);
    const { count, total_value, items } = res.body.data;
    expect(count).toBe(2);
    expect(items.map((i) => i.po_id)).toEqual([seeded.p1.po_id, seeded.p2.po_id]);
    expect(total_value).toBe(15000);

    const first = items[0];
    expect(first.entity_type).toBe("PO");
    expect(first.rfq_id).toBe(seeded.p1.rfq_id);
    expect(first.po_number).toBeTruthy();
    expect(first.value).toBe(12000);
    expect(first.vendor_names).toHaveLength(1);

    const ids = items.map((i) => i.po_id);
    expect(ids).not.toContain(seeded.pA2.po_id);
    expect(ids).not.toContain(seeded.pElse.po_id);
  });

  it("count equals the PO rows of the Action Centre drill-down", async () => {
    const [queue, detail] = await Promise.all([get(poApp, "my-award-approvals-pending"), get(poApp, "pending-approvals")]);
    expect(queue.body.data.count).toBe(detail.body.data.filter((r) => r.entity_type === "PO").length);
  });
});

describe("Recently approved POs", () => {
  it("defaults to the last 30 days, newest approval first, flags my own approvals", async () => {
    const res = await get(poApp, "recent-awards");
    expect(res.status).toBe(200);
    const { count, total_value, items, window } = res.body.data;
    expect(items.map((i) => i.po_id)).toEqual([seeded.p9.po_id, seeded.p3.po_id, seeded.p5.po_id]);
    expect(count).toBe(3);
    // Line totals, not the header: p9 counts 4,800, not 5,000.
    expect(total_value).toBe(19800);
    expect(items[0].value).toBe(4800);
    expect(items[1].approved_by_me).toBe(true);
    expect(items[2].approved_by_me).toBe(false);
    expect(items[1].rfq_id).toBe(seeded.p3.rfq_id);
    expect(window.end_date).toBe(istDate(0));
  });

  it("is committed spend only: a PO awaiting vendor acceptance is not listed", async () => {
    const res = await get(poApp, "recent-awards", { start_date: istDate(-59), end_date: istDate(0) });
    expect(res.body.data.items.map((i) => i.po_id)).not.toContain(seeded.p10.po_id);
  });

  it("over a window covering every PO it equals the committed spend (D1)", async () => {
    const range = { start_date: istDate(-400), end_date: istDate(0) };
    const [recent, pipe, snap] = await Promise.all([
      get(poApp, "recent-awards", range),
      get(poApp, "award-value-pipeline", range),
      get(poApp, "procurement-snapshot", range),
    ]);
    // Every committed PO in this fixture went through an approval, so the
    // two populations coincide exactly; on real data recently-approved is a
    // subset (POs committed without an approval instance are not listed).
    expect(recent.body.data.count).toBe(pipe.body.data.committed_po_count);
    expect(recent.body.data.total_value).toBe(pipe.body.data.committed_value);
    expect(recent.body.data.total_value).toBe(snap.body.data.total_spend);
  });

  it("honours an explicit window", async () => {
    const res = await get(poApp, "recent-awards", { start_date: istDate(-59), end_date: istDate(0) });
    expect(res.body.data.items.map((i) => i.po_id)).toEqual([seeded.p9.po_id, seeded.p3.po_id, seeded.p5.po_id, seeded.p4.po_id]);
    expect(res.body.data.total_value).toBe(23800);
  });
});

describe("PO value by stage", () => {
  const stageMap = (data) => Object.fromEntries(data.stages.map((s) => [s.key, s]));

  it("buckets POs raised in the window; drafts and cancelled POs never happened", async () => {
    const res = await get(poApp, "award-value-pipeline", { start_date: istDate(-29), end_date: istDate(0) });
    expect(res.status).toBe(200);
    const s = stageMap(res.body.data);
    // Mine (12,000 + 3,000) and the one awaiting someone else (800): the
    // pipeline is the business unit's, not my queue.
    expect(s.in_approval).toMatchObject({ value: 15800, po_count: 3 });
    expect(s.awaiting_acceptance).toMatchObject({ value: 700, po_count: 1 });
    expect(s.approved).toMatchObject({ value: 13800, po_count: 2 });
    expect(s.in_fulfilment).toMatchObject({ value: 6000, po_count: 1 });
    expect(s.rejected).toMatchObject({ value: 1000, po_count: 1 });
    expect(res.body.data.committed_value).toBe(19800);
    expect(res.body.data.committed_po_count).toBe(3);
    expect(res.body.data.pending_value).toBe(16500);
    // The A2 PO is outside the selected hotel.
    const total = res.body.data.stages.reduce((sum, x) => sum + x.value, 0);
    expect(total).toBe(37300);
  });

  it("committed value reconciles with the procurement snapshot's spend (D1)", async () => {
    for (const range of [{ start_date: istDate(-29), end_date: istDate(0) }, {}]) {
      const [pipe, snap] = await Promise.all([
        get(poApp, "award-value-pipeline", range),
        get(poApp, "procurement-snapshot", range),
      ]);
      expect(snap.status).toBe(200);
      expect(pipe.body.data.committed_value).toBe(snap.body.data.total_spend);
      expect(pipe.body.data.committed_po_count).toBe(snap.body.data.pos_issued);
    }
  });

  it("with no range covers every PO, including the 40-day-old one", async () => {
    const res = await get(poApp, "award-value-pipeline");
    expect(stageMap(res.body.data).approved).toMatchObject({ value: 17800, po_count: 3 });
    expect(res.body.data.committed_value).toBe(23800);
  });

  it("Hotel B user sees nothing", async () => {
    const client = await httpClient(IDS.users.companyB_admin);
    const [q, recent, pipe] = await Promise.all(["my-award-approvals-pending", "recent-awards", "award-value-pipeline"]
      .map((p) => client.get(`/api/v1/dashboard-v2/${p}`).query({ hotel_ids: String(IDS.hotels.B1) })));
    expect(q.body.data.count).toBe(0);
    expect(recent.body.data.count).toBe(0);
    expect(pipe.body.data.committed_value).toBe(0);
  });
});
