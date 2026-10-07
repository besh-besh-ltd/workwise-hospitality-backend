// Integration test for the approver widgets that share one pending-approval
// predicate: technical approvals awaiting me, RFQ approvals awaiting me, and
// the approval-turnaround card that replaced the three throughput cards.
//
// Fixtures use the PRODUCTION shapes (SPEC rule 6):
//   · TECHNICAL.entity_id is the ROUND id; the RFQ and product live in
//     metadata (prod: entity_id ≠ rfq on 345 of 347 instances). The old
//     widget read entity_id as the RFQ and linked to the wrong RFQ.
//   · a publish approval on an already-published RFQ is not actionable
//     (288 of 290 prod RFQ approvals).
//   · every step row is created with its instance, so "waiting since" is
//     when the step actually reached the approver, not instance creation.

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
  makeApprovalChain,
  cleanupApprovalInstanceIds,
} from "../helpers/dashboardSeed.js";

const inserted = { rfqIds: [], instanceIds: [] };
const seeded = {};
const techApp = IDS.users.a1_proc_techApp;
const istDate = (d) => moment.tz("Asia/Kolkata").add(d, "days").format("YYYY-MM-DD");

async function rfq(t, title, { hotel = IDS.hotels.A1, status = 1, is_published = 1, bid_end_date } = {}) {
  const r = await makeRfqVisibleToDashboard(t, {
    createdBy: IDS.users.a1_proc_buyer, hospitality: IDS.hospitality.A, hotel,
    status, is_published, title, ...(bid_end_date ? { bid_end_date } : {}),
  });
  inserted.rfqIds.push(r.rfq_id);
  return r.rfq_id;
}

async function chain(t, opts) {
  const { instance_id } = await makeApprovalChain(t, { hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, ...opts });
  inserted.instanceIds.push(instance_id);
  return instance_id;
}

const tech = (rfqId, rfqProductId, extra = {}) => ({
  entity_type: "TECHNICAL", policy_id: IDS.policies.A1_P1_TECHNICAL,
  metadata: { rfq_id: rfqId, rfq_product_id: rfqProductId }, ...extra,
});

beforeAll(async () => {
  await db.tx(async (t) => {
    const variants = await t.any(`SELECT id, name FROM tbl_product_variant ORDER BY id LIMIT 2`);

    // ── Technical approvals awaiting techApp ──────────────────────────
    // rT1: two products → two instances → ONE item (collapses to the RFQ),
    // waiting 10 days.
    const rT1 = await rfq(t, "Tech approval — two products");
    const p1a = await addProductToRfq(t, rT1, { product_variant_id: variants[0].id });
    const p1b = await addProductToRfq(t, rT1, { product_variant_id: variants[1].id });
    await chain(t, { ...tech(rT1, p1a.rfq_product_id), entity_id: 910001, created_ago_hours: 240, steps: [{ approver: techApp }] });
    await chain(t, { ...tech(rT1, p1b.rfq_product_id), entity_id: 910002, created_ago_hours: 239, steps: [{ approver: techApp }] });

    // rT2: submitted 8 days ago, step 1 decided by someone else 1 day ago,
    // now at step 2 with techApp → waiting since ~1 day. Its entity_id (a
    // round id) deliberately equals rT1's RFQ id: reading entity_id as the
    // RFQ would link this item to the wrong RFQ.
    const rT2 = await rfq(t, "Tech approval — reached me yesterday");
    const p2 = await addProductToRfq(t, rT2, { product_variant_id: variants[0].id });
    await chain(t, {
      ...tech(rT2, p2.rfq_product_id), entity_id: rT1, created_ago_hours: 192,
      steps: [
        { approver: IDS.users.a1_proc_commApp, status: "APPROVED", acted_ago_hours: 24 },
        { approver: techApp },
      ],
    });

    // NOT mine / not in scope.
    const rT3 = await rfq(t, "Tech approval at A2", { hotel: IDS.hotels.A2 });
    const p3 = await addProductToRfq(t, rT3);
    await chain(t, { ...tech(rT3, p3.rfq_product_id), entity_id: 910003, hotel: IDS.hotels.A2, steps: [{ approver: techApp }] });
    const rT4 = await rfq(t, "Tech approval — I was removed");
    const p4 = await addProductToRfq(t, rT4);
    await chain(t, { ...tech(rT4, p4.rfq_product_id), entity_id: 910004, steps: [{ approver: techApp, removed: true }] });
    const rT5 = await rfq(t, "Tech approval — someone else's");
    const p5 = await addProductToRfq(t, rT5);
    await chain(t, { ...tech(rT5, p5.rfq_product_id), entity_id: 910005, steps: [{ approver: IDS.users.a1_proc_commApp }] });

    // ── RFQ (publish) approvals awaiting techApp ──────────────────────
    const rR1 = await rfq(t, "Publish approval", { status: 4, is_published: 0 });
    await chain(t, { entity_type: "RFQ", entity_id: rR1, policy_id: IDS.policies.A1_P1_RFQ, created_ago_hours: 50, steps: [{ approver: techApp }] });
    // Company-level (NULL hotel) approval — still actionable.
    const rR3 = await rfq(t, "Publish approval — company level", { status: 4, is_published: 0 });
    await chain(t, { entity_type: "RFQ", entity_id: rR3, policy_id: IDS.policies.A1_P1_RFQ, hotel: null, created_ago_hours: 20, steps: [{ approver: techApp }] });
    // Already published → nobody can act on it.
    const rR2 = await rfq(t, "Publish approval on a live RFQ");
    await chain(t, { entity_type: "RFQ", entity_id: rR2, policy_id: IDS.policies.A1_P1_RFQ, steps: [{ approver: techApp }] });

    // ── Decisions for the turnaround card ─────────────────────────────
    // D1: submitted 60h ago; step 1 done 30h ago; techApp decided step 2
    //     26h ago → 4h from the step reaching them (34h from submission).
    const rD1 = await rfq(t, "Decided tech approval 1");
    const pD1 = await addProductToRfq(t, rD1);
    await chain(t, {
      ...tech(rD1, pD1.rfq_product_id), entity_id: 910011, status: "APPROVED", created_ago_hours: 60,
      steps: [
        { approver: IDS.users.a1_proc_commApp, status: "APPROVED", acted_ago_hours: 30 },
        { approver: techApp, status: "APPROVED", acted_ago_hours: 26 },
      ],
    });
    // D2: single step, 12h → 10h ago = 2h.
    const rD2 = await rfq(t, "Decided tech approval 2");
    const pD2 = await addProductToRfq(t, rD2);
    await chain(t, {
      ...tech(rD2, pD2.rfq_product_id), entity_id: 910012, status: "APPROVED", created_ago_hours: 12,
      steps: [{ approver: techApp, status: "APPROVED", acted_ago_hours: 10 }],
    });
    // D3: an RFQ approval techApp REJECTED after 1h.
    const rD3 = await rfq(t, "Decided RFQ approval", { status: 1, is_published: 0 });
    await chain(t, {
      entity_type: "RFQ", entity_id: rD3, policy_id: IDS.policies.A1_P1_RFQ, status: "REJECTED", created_ago_hours: 5,
      steps: [{ approver: techApp, status: "REJECTED", acted_ago_hours: 4 }],
    });

    // Tech-eval tab: techEval submitted 5h after the bid closed; a later
    // re-submission for the same product does not count again.
    const bidClose = moment.tz("Asia/Kolkata").subtract(10, "hours").format("YYYY-MM-DDTHH:mm:ss");
    const rE = await rfq(t, "Evaluated RFQ", { bid_end_date: bidClose });
    const pE = await addProductToRfq(t, rE);
    await chain(t, {
      ...tech(rE, pE.rfq_product_id), entity_id: 910021, initiated_by: IDS.users.a1_proc_techEval,
      status: "APPROVED", created_ago_hours: 5,
      steps: [{ approver: IDS.users.a1_proc_commApp, status: "APPROVED", acted_ago_hours: 4 }],
    });
    await chain(t, {
      ...tech(rE, pE.rfq_product_id), entity_id: 910022, initiated_by: IDS.users.a1_proc_techEval,
      created_ago_hours: 1, steps: [{ approver: IDS.users.a1_proc_commApp }],
    });

    Object.assign(seeded, { rT1, rT2, rT3, rT4, rT5, rR1, rR2, rR3, variants });
  });
});

afterAll(async () => {
  await cleanupApprovalInstanceIds(db, inserted.instanceIds);
  await cleanupTechEvals(db, inserted.rfqIds);
  await cleanupRfqs(db, inserted.rfqIds);
  await closeDb();
});

const get = async (user, path, query = {}) => {
  const client = await httpClient(user);
  return client.get(`/api/v1/dashboard-v2/${path}`).query({ hotel_ids: String(IDS.hotels.A1), ...query });
};

describe("Technical approvals awaiting me", () => {
  it("one item per RFQ, resolved from metadata (never entity_id), oldest wait first", async () => {
    const res = await get(techApp, "my-tech-approvals-pending");
    expect(res.status).toBe(200);
    const { count, items, oldest_age_days } = res.body.data;

    expect(count).toBe(2);
    expect(items.map((i) => i.rfq_id)).toEqual([seeded.rT1, seeded.rT2]);

    const [first, second] = items;
    expect(first.entity_type).toBe("TECHNICAL");
    expect(first.instance_count).toBe(2);
    expect(first.rfq_product_ids).toHaveLength(2);
    expect(first.product_names).toHaveLength(2);
    expect(first.rfq_no).toBeTruthy();
    expect(first.age_days).toBe(10);
    expect(oldest_age_days).toBe(10);

    // Waiting since the step reached techApp (1 day), not submission (8 days).
    expect(second.age_days).toBe(1);
    expect(second.rfq_id).not.toBe(seeded.rT1);

    for (const excluded of [seeded.rT3, seeded.rT4, seeded.rT5]) {
      expect(items.map((i) => i.rfq_id)).not.toContain(excluded);
    }
  });
});

describe("RFQ approvals awaiting me", () => {
  it("lists actionable publish approvals, including company-level ones", async () => {
    const res = await get(techApp, "my-rfq-approvals-pending");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
    const ids = res.body.data.items.map((i) => i.rfq_id);
    expect(ids).toEqual([seeded.rR1, seeded.rR3]);
    expect(ids).not.toContain(seeded.rR2); // already published
  });
});

describe("Parity with the Action Centre drill-down", () => {
  it("each queue's count equals its entity types' rows in /pending-approvals", async () => {
    const [detail, techQ, rfqQ] = await Promise.all([
      get(techApp, "pending-approvals"),
      get(techApp, "my-tech-approvals-pending"),
      get(techApp, "my-rfq-approvals-pending"),
    ]);
    const rows = detail.body.data;
    const ofType = (types) => rows.filter((r) => types.includes(r.entity_type)).length;
    expect(techQ.body.data.count).toBe(ofType(["TECHNICAL"]));
    expect(rfqQ.body.data.count).toBe(ofType(["RFQ", "TENDER"]));
  });
});

describe("Approval turnaround", () => {
  it("measures each decision from the step reaching me — median, P90, n", async () => {
    const res = await get(techApp, "approval-turnaround");
    expect(res.status).toBe(200);
    const tabs = Object.fromEntries(res.body.data.tabs.map((x) => [x.key, x]));

    expect(res.body.data.tabs.map((x) => x.key)).toEqual(
      ["tech_eval", "tech_approval", "quote_approval", "po_approval", "rfq_approval"]);
    expect(tabs.tech_approval.n).toBe(2);
    expect(tabs.tech_approval.median_hours).toBeCloseTo(3, 1); // median(4h, 2h)
    expect(tabs.tech_approval.p90_hours).toBeCloseTo(3.8, 1);
    expect(tabs.rfq_approval.n).toBe(1);
    expect(tabs.rfq_approval.median_hours).toBeCloseTo(1, 1);
    expect(tabs.quote_approval.n).toBe(0);
    expect(tabs.quote_approval.median_hours).toBeNull();
    expect(tabs.tech_eval.n).toBe(0); // techApp submitted no evaluations
  });

  it("tech-eval tab: bid close → my first submission per product", async () => {
    const res = await get(IDS.users.a1_proc_techEval, "approval-turnaround");
    const tabs = Object.fromEntries(res.body.data.tabs.map((x) => [x.key, x]));
    expect(tabs.tech_eval.n).toBe(1);
    expect(tabs.tech_eval.median_hours).toBeGreaterThan(4.9);
    expect(tabs.tech_eval.median_hours).toBeLessThan(5.1);
  });

  it("honours the date window", async () => {
    const res = await get(techApp, "approval-turnaround", { start_date: istDate(1), end_date: istDate(1) });
    for (const tab of res.body.data.tabs) expect(tab.n).toBe(0);
  });
});
