// Purchase Requisitions — derived progress across the RFQ / PO lifecycle
// (Task 9, spec §4.2). A converted line's progress is computed from the RFQ and
// PO tables alone; no code path in RFQ or PO knows about PRs. These tests move
// the RFQ / PO through their states (the RFQ draft through its own API; status
// changes and POs as setup rows, the states other modules write) and read the
// PR back through the API.
//
// Personas
//   REQ  a1_eng_buyer   PR Requester at (A, A1, eng)
//   AP   crossCompany   PR Approver at (A, all, all)
//   BUY  a1_proc_buyer  PR Buyer at (A, A1, all); fixture RFQ creator at (A, A1, proc)

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  grantPr, revokeAllPr, firstUsableVariant, cleanupPrs, dropPrPolicies, unmapAll,
  approvedPr, cleanupRfqDrafts, rfqsOfLines,
} from "../helpers/prFixtures.js";
import { makePO, cleanupPurchaseOrders } from "../helpers/dashboardSeed.js";
import { buyerPrDetail } from "../../app/services/notificationLinks.js";

const A = IDS.hospitality.A;
const ENG = IDS.departments.eng;
const PROC = IDS.departments.proc;
const REQ = IDS.users.a1_eng_buyer;
const AP = IDS.users.crossCompany;
const BUY = IDS.users.a1_proc_buyer;
const PERSONAS = [REQ, AP, BUY];

const prIds = [];
const rfqIds = [];
const poIds = [];
let originalUserTypes = [];
let buyC, reqC;
let V;
let W;

const catalogLine = (variantId, extra = {}) => ({
  product_variant_id: variantId, quantity: "2", uom: "nos", estimated_unit_price: "1500.00", specification: "OEM", ...extra,
});

async function approved(lines, title) {
  const pr = await approvedPr(lines, { requesterId: REQ, approverId: AP, title });
  prIds.push(pr.id);
  return pr;
}

async function convert(lineIds) {
  const res = await buyC.post("/api/v1/pr/convert").send({ line_ids: lineIds, department_id: PROC });
  expect(res.status).toBe(200);
  rfqIds.push(Number(res.body.data.rfq_id));
  return res.body.data;
}

/** The RFQ product a line was converted into (its newest link). */
const productOf = async (lineId) => Number((await db.one(
  `SELECT rfq_product_id FROM tbl_pr_line_rfq WHERE pr_line_id = $1 ORDER BY id DESC LIMIT 1`, [lineId])).rfq_product_id);

async function po(rfqId, lineId, status) {
  const { po_id: poId } = await makePO(db, {
    rfq_id: rfqId, rfq_product_id: await productOf(lineId), vendor_user_id: IDS.users.vendor_alpha,
    company_id: IDS.companies.A, status, unit_price: 100, quantity: 2, total_value: 200,
  });
  poIds.push(Number(poId));
  return Number(poId);
}

const setRfq = (rfqId, status, isPublished) =>
  db.none(`UPDATE tbl_rfq SET status = $2, is_published = $3 WHERE id = $1`, [rfqId, status, isPublished]);

const lineOf = async (pr, lineId) => {
  const res = await reqC.get(`/api/v1/pr/${pr.id}`);
  expect(res.status).toBe(200);
  return res.body.data.lines.find((l) => l.id === lineId);
};
const headerProgress = async (pr) => {
  const res = await reqC.get(`/api/v1/pr?tab=mine&q=${encodeURIComponent(pr.pr_number)}`);
  expect(res.status).toBe(200);
  return res.body.data.rows.find((r) => r.id === pr.id).header_progress;
};
const poolLineIds = async (pr) => {
  const res = await buyC.get(`/api/v1/pr/pool?q=${encodeURIComponent(pr.pr_number)}&page_size=200`);
  expect(res.status).toBe(200);
  return res.body.data.rows.map((r) => r.line_id);
};

beforeAll(async () => {
  originalUserTypes = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [PERSONAS]);
  await revokeAllPr(PERSONAS);
  await unmapAll(A);
  await dropPrPolicies();
  await grantPr(REQ, "PR Requester", { departmentId: ENG });
  await grantPr(AP, "PR Approver", { hotelId: null });
  await grantPr(BUY, "PR Buyer");
  V = await firstUsableVariant();
  W = { variant_id: Number((await db.one(
    `SELECT pv.id FROM tbl_product_variant pv JOIN tbl_product p ON p.id = pv.product_id
      WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND pv.is_approve = 1
        AND pv.id <> $1
        AND EXISTS (SELECT 1 FROM tbl_product_categories pc JOIN tbl_category c ON c.id = pc.category_id
                     WHERE pc.product_id = p.id)
      ORDER BY pv.id DESC LIMIT 1`, [V.variant_id])).id) };
  buyC = await httpClient(BUY);
  reqC = await httpClient(REQ);
});

afterAll(async () => {
  await cleanupPurchaseOrders(db, poIds);
  const lineIds = await db.map(
    `SELECT id FROM tbl_purchase_requisition_line WHERE pr_id = ANY($1::int[])`, [prIds], (r) => Number(r.id));
  await cleanupRfqDrafts([...rfqIds, ...(await rfqsOfLines(lineIds))]);
  if (prIds.length) {
    await db.none(
      `DELETE FROM tbl_notifications
        WHERE (category = 'pr' AND additional_data->>'pr_id' = ANY($1::text[]))
           OR action_url = ANY($2::text[])`,
      [prIds.map(String), prIds.map((id) => buyerPrDetail(id))]);
  }
  await cleanupPrs(prIds);
  await dropPrPolicies();
  await revokeAllPr(PERSONAS);
  for (const u of originalUserTypes) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  }
});

describe("PR derived progress across the RFQ / PO lifecycle", () => {
  it("draft-deleted → in_pool: deleting the RFQ draft removes the links; the line is back in the pool", async () => {
    const pr = await approved([catalogLine(V.variant_id)], "progress-draft-deleted");
    const lineId = pr.line_ids[0];
    const { rfq_id: rfqId } = await convert(pr.line_ids);
    expect((await lineOf(pr, lineId)).progress).toBe("in_sourcing");
    expect(await poolLineIds(pr)).toEqual([]);

    const del = await buyC.delete(`/api/v1/rfq/delete-draft/${rfqId}`);
    expect(del.status).toBe(200);
    expect(await db.any(`SELECT id FROM tbl_pr_line_rfq WHERE pr_line_id = $1`, [lineId])).toEqual([]);
    const line = await lineOf(pr, lineId);
    expect(line.progress).toBe("in_pool");
    expect(line.links).toEqual([]);
    expect(await poolLineIds(pr)).toEqual([lineId]);
    expect(await headerProgress(pr)).toBe("in_queue");
  });

  it("rfq-withdrawn → in_pool: the dead link stays visible (live:false) and the line converts again", async () => {
    const pr = await approved([catalogLine(V.variant_id)], "progress-withdrawn");
    const lineId = pr.line_ids[0];
    const first = await convert(pr.line_ids);
    await setRfq(first.rfq_id, 5, 0);

    let line = await lineOf(pr, lineId);
    expect(line.progress).toBe("in_pool");
    expect(line.links).toEqual([
      { rfq_id: first.rfq_id, rfq_no: first.rfq_no, rfq_status_label: "Withdrawn", live: false, po: [] },
    ]);
    expect(await poolLineIds(pr)).toEqual([lineId]);

    const second = await convert(pr.line_ids);
    expect(second.rfq_id).not.toBe(first.rfq_id);
    line = await lineOf(pr, lineId);
    expect(line.progress).toBe("in_sourcing");
    expect(line.links).toEqual([
      { rfq_id: first.rfq_id, rfq_no: first.rfq_no, rfq_status_label: "Withdrawn", live: false, po: [] },
      { rfq_id: second.rfq_id, rfq_no: second.rfq_no, rfq_status_label: "Draft", live: true, po: [] },
    ]);
  });

  it("po-live → ordered: an approved PO on the RFQ product orders the line, even once the RFQ closes", async () => {
    const pr = await approved([catalogLine(V.variant_id)], "progress-po-live");
    const lineId = pr.line_ids[0];
    const { rfq_id: rfqId, rfq_no: rfqNo } = await convert(pr.line_ids);
    await setRfq(rfqId, 1, 1);
    const poId = await po(rfqId, lineId, "approved");
    const poNumber = (await db.one(`SELECT po_number FROM tbl_rfq_purchase_order WHERE id = $1`, [poId])).po_number;

    let line = await lineOf(pr, lineId);
    expect(line.progress).toBe("ordered");
    expect(line.links).toEqual([{
      rfq_id: rfqId, rfq_no: rfqNo, rfq_status_label: "Open", live: true,
      po: [{ po_id: poId, po_number: poNumber, status: "approved" }],
    }]);
    expect(await headerProgress(pr)).toBe("ordered");

    await setRfq(rfqId, 2, 1);
    line = await lineOf(pr, lineId);
    expect(line.progress).toBe("ordered");
    expect(line.links[0]).toMatchObject({ rfq_status_label: "Closed", live: true });
  });

  it("po-cancelled: RFQ still open → in_sourcing; RFQ closed → in_pool", async () => {
    const pr = await approved([catalogLine(V.variant_id)], "progress-po-cancelled");
    const lineId = pr.line_ids[0];
    const { rfq_id: rfqId } = await convert(pr.line_ids);
    await setRfq(rfqId, 1, 1);
    const poId = await po(rfqId, lineId, "approved");
    expect((await lineOf(pr, lineId)).progress).toBe("ordered");

    await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'cancelled' WHERE id = $1`, [poId]);
    let line = await lineOf(pr, lineId);
    expect(line.progress).toBe("in_sourcing");
    expect(line.links[0]).toMatchObject({ rfq_status_label: "Open", live: true, po: [{ po_id: poId, status: "cancelled" }] });

    await setRfq(rfqId, 2, 1);
    line = await lineOf(pr, lineId);
    expect(line.progress).toBe("in_pool");
    expect(line.links[0]).toMatchObject({ rfq_status_label: "Closed", live: false });
    expect(await poolLineIds(pr)).toEqual([lineId]);
  });

  it("rfq-closed with a PO on another product only → that line ordered, this line back in the pool", async () => {
    const pr = await approved([catalogLine(V.variant_id), catalogLine(W.variant_id)], "progress-partial-award");
    const [awarded, unawarded] = pr.line_ids;
    const { rfq_id: rfqId } = await convert(pr.line_ids);
    await setRfq(rfqId, 1, 1);
    await po(rfqId, awarded, "approved");
    await setRfq(rfqId, 2, 1);

    expect((await lineOf(pr, awarded)).progress).toBe("ordered");
    const line = await lineOf(pr, unawarded);
    expect(line.progress).toBe("in_pool");
    expect(line.links[0]).toMatchObject({ rfq_id: rfqId, rfq_status_label: "Closed", live: false, po: [] });
    expect(await poolLineIds(pr)).toEqual([unawarded]);
    expect(await headerProgress(pr)).toBe("partly_ordered");
  });

  it("rfq-approval-rejected → still in_sourcing: pending approval, then back to an unpublished draft", async () => {
    const pr = await approved([catalogLine(V.variant_id)], "progress-approval-rejected");
    const lineId = pr.line_ids[0];
    const { rfq_id: rfqId } = await convert(pr.line_ids);

    await setRfq(rfqId, 3, 0);
    let line = await lineOf(pr, lineId);
    expect(line.progress).toBe("in_sourcing");
    expect(line.links[0]).toMatchObject({ rfq_status_label: "Pending approval", live: true });

    await setRfq(rfqId, 4, 0);
    expect((await lineOf(pr, lineId)).links[0]).toMatchObject({ rfq_status_label: "Ready to publish", live: true });

    await setRfq(rfqId, 1, 0);
    line = await lineOf(pr, lineId);
    expect(line.progress).toBe("in_sourcing");
    expect(line.links[0]).toMatchObject({ rfq_status_label: "Draft", live: true });
    expect(await poolLineIds(pr)).toEqual([]);
  });
});
