// Integration test for "Negotiated quotes awaiting me" — the NEGOTIATION_QUOTE
// approval queue (N1 / Commercial Approver on prod).
//
// PRODUCTION shape (SPEC rule 6): NEGOTIATION_QUOTE.entity_id is the
// tbl_rfq_products id; the value is the po_payload the approval will turn
// into a PO. The old award widgets joined entity_id to
// tbl_negotiation_round_quotes.id — on prod every pending row came back blank
// with ₹0, and 171 approvals collided with an unrelated round quote and would
// have shown ANOTHER RFQ's number, vendor and price. The collision case below
// reproduces that exactly.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
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

const inserted = { rfqIds: [], instanceIds: [], roundIds: [], roundQuoteIds: [] };
const seeded = {};
const commApp = IDS.users.a1_proc_commApp;

async function rfq(t, title, hotel = IDS.hotels.A1) {
  const r = await makeRfqVisibleToDashboard(t, {
    createdBy: IDS.users.a1_proc_buyer, hospitality: IDS.hospitality.A, hotel,
    status: 1, is_published: 1, title,
  });
  inserted.rfqIds.push(r.rfq_id);
  return r.rfq_id;
}

async function nq(t, { rfqId, rfqProductId, value, createdAgo, approver = commApp, status = "PENDING", hotel = IDS.hotels.A1 }) {
  const { instance_id } = await makeApprovalChain(t, {
    entity_type: "NEGOTIATION_QUOTE", entity_id: rfqProductId,
    policy_id: IDS.policies.A1_P1_NEGOTIATION_QUOTE,
    hospitality: IDS.hospitality.A, hotel, status, created_ago_hours: createdAgo,
    metadata: {
      rfq_id: rfqId, rfq_product_id: rfqProductId, vendor_id: IDS.users.vendor_alpha,
      po_payload: { rfq_id: rfqId, total_value: value, vendor_id: IDS.users.vendor_alpha },
    },
    steps: [status === "PENDING"
      ? { approver }
      : { approver, status, acted_ago_hours: Math.max(createdAgo - 1, 0) }],
  });
  inserted.instanceIds.push(instance_id);
  return instance_id;
}

beforeAll(async () => {
  await db.tx(async (t) => {
    const variants = await t.any(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 2`);

    // rN1: two products, three instances (rp1a was re-submitted at a new
    // price) → ONE item worth 7,500 + 2,500 = 10,000 — the latest submission
    // per product, never the sum of every instance.
    const rN1 = await rfq(t, "Negotiated quote — two products");
    const rp1a = await addProductToRfq(t, rN1, { product_variant_id: variants[0].id });
    const rp1b = await addProductToRfq(t, rN1, { product_variant_id: variants[1].id });
    await nq(t, { rfqId: rN1, rfqProductId: rp1a.rfq_product_id, value: 7000, createdAgo: 72 });
    await nq(t, { rfqId: rN1, rfqProductId: rp1a.rfq_product_id, value: 7500, createdAgo: 48 });
    await nq(t, { rfqId: rN1, rfqProductId: rp1b.rfq_product_id, value: 2500, createdAgo: 47 });

    // rN2: waiting longest.
    const rN2 = await rfq(t, "Negotiated quote — oldest");
    const rp2 = await addProductToRfq(t, rN2);
    await nq(t, { rfqId: rN2, rfqProductId: rp2.rfq_product_id, value: 5000, createdAgo: 96 });

    // THE COLLISION: a round quote on an unrelated RFQ whose id equals
    // rp1a's id. Joining entity_id to round quotes would resolve rN1's item
    // to rOther.
    const rOther = await rfq(t, "Unrelated RFQ with a colliding round quote");
    const rpOther = await addProductToRfq(t, rOther);
    const roundOther = await t.one(
      `INSERT INTO tbl_negotiation_rounds (rfq_id, round_number, status, created_by, end_date, vendor_ids)
       VALUES ($1, 1, 'ENDED', $2, now(), ARRAY[$3]::int[]) RETURNING id`,
      [rOther, IDS.users.a1_proc_commEval, IDS.users.vendor_beta]
    );
    inserted.roundIds.push(roundOther.id);
    await t.none(
      `INSERT INTO tbl_negotiation_round_quotes (id, negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at)
       VALUES ($1, $2, $3, $4, 99999, now())`,
      [rp1a.rfq_product_id, roundOther.id, IDS.users.vendor_beta, rpOther.rfq_product_id]
    );
    inserted.roundQuoteIds.push(rp1a.rfq_product_id);

    // NOT in my queue.
    const rA2 = await rfq(t, "Negotiated quote at A2", IDS.hotels.A2);
    const rpA2 = await addProductToRfq(t, rA2);
    await nq(t, { rfqId: rA2, rfqProductId: rpA2.rfq_product_id, value: 1000, createdAgo: 5, hotel: IDS.hotels.A2 });
    const rElse = await rfq(t, "Negotiated quote — someone else's");
    const rpElse = await addProductToRfq(t, rElse);
    await nq(t, { rfqId: rElse, rfqProductId: rpElse.rfq_product_id, value: 1000, createdAgo: 5, approver: IDS.users.a1_proc_poApp });
    const rDone = await rfq(t, "Negotiated quote — already approved");
    const rpDone = await addProductToRfq(t, rDone);
    await nq(t, { rfqId: rDone, rfqProductId: rpDone.rfq_product_id, value: 1000, createdAgo: 5, status: "APPROVED" });

    Object.assign(seeded, { rN1, rN2, rOther, rA2, rElse, rDone, rp1a, rp1b });
  });
});

afterAll(async () => {
  await cleanupApprovalInstanceIds(db, inserted.instanceIds);
  await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE id = ANY($1)`, [inserted.roundQuoteIds]);
  await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1)`, [inserted.roundIds]);
  await cleanupTechEvals(db, inserted.rfqIds);
  await cleanupRfqs(db, inserted.rfqIds);
  await closeDb();
});

const get = async (user, path, hotel = IDS.hotels.A1) => {
  const client = await httpClient(user);
  return client.get(`/api/v1/dashboard-v2/${path}`).query({ hotel_ids: String(hotel) });
};

describe("Negotiated quotes awaiting me", () => {
  it("resolves every item through tbl_rfq_products — the colliding round quote is ignored", async () => {
    const res = await get(commApp, "my-commercial-approvals-pending");
    expect(res.status).toBe(200);
    const { count, total_value, items } = res.body.data;

    expect(count).toBe(2);
    expect(items.map((i) => i.rfq_id)).toEqual([seeded.rN2, seeded.rN1]); // oldest wait first
    expect(items.map((i) => i.rfq_id)).not.toContain(seeded.rOther);

    const n1 = items[1];
    expect(n1.entity_type).toBe("NEGOTIATION_QUOTE");
    expect(n1.instance_count).toBe(3);
    expect(n1.value).toBe(10000);
    expect(n1.rfq_product_ids.sort()).toEqual([seeded.rp1a.rfq_product_id, seeded.rp1b.rfq_product_id].sort());
    expect(n1.vendor_names).toHaveLength(1);
    expect(n1.rfq_no).toBeTruthy();

    expect(total_value).toBe(15000);
  });

  it("excludes other hotels, other approvers and decided approvals", async () => {
    const res = await get(commApp, "my-commercial-approvals-pending");
    const ids = res.body.data.items.map((i) => i.rfq_id);
    for (const excluded of [seeded.rA2, seeded.rElse, seeded.rDone]) expect(ids).not.toContain(excluded);
  });

  it("count equals the NEGOTIATION_QUOTE rows of the Action Centre drill-down", async () => {
    const [queue, detail] = await Promise.all([
      get(commApp, "my-commercial-approvals-pending"),
      get(commApp, "pending-approvals"),
    ]);
    expect(queue.body.data.count).toBe(detail.body.data.filter((r) => r.entity_type === "NEGOTIATION_QUOTE").length);
  });

  it("Hotel B user sees nothing", async () => {
    const res = await get(IDS.users.companyB_admin, "my-commercial-approvals-pending", IDS.hotels.B1);
    expect(res.body.data.count).toBe(0);
    expect(res.body.data.total_value).toBe(0);
  });
});
