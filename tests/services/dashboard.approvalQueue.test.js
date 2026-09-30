// The "approvals waiting on me" queue — ONE predicate behind the Action Centre
// badge, the status banner and the pending-approvals list
// (dashboardMetrics.myPendingApprovalsFrom).
//
//   · counts DISTINCT actionable items: prod had one approver with 50 PENDING
//     NEGOTIATION_QUOTE instances across 3 RFQs, which pushed the banner into
//     critical mode on its own;
//   · NULL-hotel (company-level) approvals are in the queue, as in the nav badge;
//   · a REMOVED approver's tombstone row is not a pending approval;
//   · the list honours hotel_ids exactly like the badge (it used to ignore them);
//   · every row resolves the RFQ it belongs to by entity type (SPEC rule 6) —
//     NEGOTIATION_QUOTE.entity_id is an rfq_product, TECHNICAL.entity_id is a
//     round, so neither may be read as an RFQ id.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
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

afterAll(async () => {
  await closeDb();
});

const APPROVER = IDS.users.multiHotel; // mapped to A1 and A2
const seeded = { rfqIds: [], poIds: [], approvals: [] };
beforeEach(() => {
  seeded.rfqIds = [];
  seeded.poIds = [];
  seeded.approvals = [];
});
afterEach(async () => {
  for (const [type, id] of seeded.approvals) await cleanupApprovalInstances(db, type, [id]);
  await cleanupPurchaseOrders(db, seeded.poIds);
  if (seeded.rfqIds.length) await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [seeded.rfqIds]);
  await cleanupRfqs(db, seeded.rfqIds);
});

async function get(path, hotels) {
  const client = await httpClient(APPROVER);
  const res = await client.get(`/api/v1/dashboard-v2/${path}`).query(hotels ? { hotel_ids: hotels.join(",") } : {});
  expect(res.status).toBe(200);
  return res.body.data;
}
const badge = async (hotels) => (await get("action-center", hotels)).pending_approvals;
const list = (hotels) => get("pending-approvals", hotels);

async function rfq(hotel = IDS.hotels.A1) {
  const { rfq_id } = await makeRfqVisibleToDashboard(db, {
    createdBy: IDS.users.a1_proc_buyer, hospitality: IDS.hospitality.A, hotel,
    is_published: 1, status: 1, title: "Approval queue RFQ",
  });
  seeded.rfqIds.push(rfq_id);
  return rfq_id;
}

async function pending({ entity_type, entity_id, policy_id, hotel = IDS.hotels.A1, metadata }) {
  const inst = await makeApprovalInstanceWithApprover(db, {
    entity_type, entity_id, policy_id,
    approver_user_id: APPROVER,
    hospitality: IDS.hospitality.A,
    hotel,
  });
  if (metadata) {
    await db.none(`UPDATE tbl_approval_instances SET metadata = $2::jsonb WHERE id = $1`, [inst.instance_id, JSON.stringify(metadata)]);
  }
  seeded.approvals.push([entity_type, entity_id]);
  return inst;
}

describe("distinct actionable items", () => {
  it("two NEGOTIATION_QUOTE instances on one RFQ are ONE item; the row resolves the RFQ via the rfq_product", async () => {
    const b0 = await badge();
    const rfq_id = await rfq();
    const p1 = await addProductToRfq(db, rfq_id);
    const p2 = await addProductToRfq(db, rfq_id);
    // Prod shape: entity_id = tbl_rfq_products.id.
    await pending({ entity_type: "NEGOTIATION_QUOTE", entity_id: p1.rfq_product_id, policy_id: IDS.policies.A1_P1_NEGOTIATION_QUOTE, metadata: { rfq_id } });
    await pending({ entity_type: "NEGOTIATION_QUOTE", entity_id: p2.rfq_product_id, policy_id: IDS.policies.A1_P1_NEGOTIATION_QUOTE, metadata: { rfq_id } });

    expect((await badge()) - b0).toBe(1);
    const rows = (await list()).filter((r) => r.entity_type === "NEGOTIATION_QUOTE" && r.rfq_id === rfq_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].instance_count).toBe(2);
    expect(rows[0].entity_rfq_no).toBeTruthy();
  });

  it("TECHNICAL resolves its RFQ from metadata, never from entity_id (a round id)", async () => {
    const rfq_id = await rfq();
    const roundId = 900000 + (rfq_id % 90000); // deliberately NOT an RFQ id
    await pending({ entity_type: "TECHNICAL", entity_id: roundId, policy_id: IDS.policies.A1_P1_TECHNICAL, metadata: { rfq_id } });
    const row = (await list()).find((r) => r.entity_type === "TECHNICAL" && r.entity_id === roundId);
    expect(row.rfq_id).toBe(rfq_id);
  });

  it("PO rows carry po_id and the PO's RFQ", async () => {
    const rfq_id = await rfq();
    const { rfq_product_id } = await addProductToRfq(db, rfq_id);
    const { po_id } = await makePO(db, {
      rfq_id, rfq_product_id, vendor_user_id: IDS.users.vendor_alpha, company_id: IDS.companies.A, status: "pending_approval",
    });
    seeded.poIds.push(po_id);
    await pending({ entity_type: "PO", entity_id: po_id, policy_id: IDS.policies.A1_P1_PO, metadata: { rfq_id } });
    const row = (await list()).find((r) => r.entity_type === "PO" && r.entity_id === po_id);
    expect(row.po_id).toBe(po_id);
    expect(row.rfq_id).toBe(rfq_id);
  });
});

describe("what is in the queue", () => {
  it("a company-level approval with NULL hotel is counted", async () => {
    const b0 = await badge();
    const rfq_id = await rfq();
    await pending({ entity_type: "RFQ", entity_id: rfq_id, policy_id: IDS.policies.A1_P1_RFQ, hotel: null });
    await db.none(`UPDATE tbl_rfq SET is_published = 0, status = 3 WHERE id = $1`, [rfq_id]);
    expect((await badge()) - b0).toBe(1);
  });

  it("a REMOVED approver's tombstone is not a pending approval", async () => {
    const b0 = await badge();
    const rfq_id = await rfq();
    await db.none(`UPDATE tbl_rfq SET is_published = 0, status = 3 WHERE id = $1`, [rfq_id]);
    const inst = await pending({ entity_type: "RFQ", entity_id: rfq_id, policy_id: IDS.policies.A1_P1_RFQ });
    expect((await badge()) - b0).toBe(1);
    await db.none(
      `UPDATE tbl_approval_step_approvers SET removed_at = now() WHERE approval_instance_step_id = $1`,
      [inst.step_id]
    );
    expect((await badge()) - b0).toBe(0);
  });
});

describe("list and badge agree under a hotel filter", () => {
  it("with hotel_ids=A2 neither shows an A1 approval; both show it with A1", async () => {
    const rfq_id = await rfq(IDS.hotels.A1);
    await db.none(`UPDATE tbl_rfq SET is_published = 0, status = 3 WHERE id = $1`, [rfq_id]);
    await pending({ entity_type: "RFQ", entity_id: rfq_id, policy_id: IDS.policies.A1_P1_RFQ, hotel: IDS.hotels.A1 });

    for (const hotels of [[IDS.hotels.A1], [IDS.hotels.A2], undefined]) {
      const [b, l] = await Promise.all([badge(hotels), list(hotels)]);
      expect(l.length).toBe(b);
    }
    const a2 = await list([IDS.hotels.A2]);
    expect(a2.some((r) => r.rfq_id === rfq_id)).toBe(false);
    const a1 = await list([IDS.hotels.A1]);
    expect(a1.some((r) => r.rfq_id === rfq_id)).toBe(true);
  });
});
