// SECURITY — PO rejections on the RFQ detail and the RFQ list are buyer-only.
// ----------------------------------------------------------------------------
// GET /rfq/getRfqById/:id serves buyers AND vendors (JWT, or the emailed-link
// `?token=`), with no ACL. It attached `vendor_rejections` for every caller:
// every vendor whose PO was rejected on the RFQ, the approver's or vendor's
// reason, who rejected it, the other vendors' PO ids and the reason code. An
// assigned vendor could read a competitor's rejection.
//
// Now a vendor or token caller gets `vendor_rejections: []` and the query is
// not run. The RFQ list (POST /rfq/list-view, any signed-in user) skips the
// `po_rejection` card marker for them the same way.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const fakeTransport = { sendMail: (opts, cb) => cb(null, { messageId: "<captured>" }) };
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { httpClient } = await import("../helpers/http.js");
const { makePoRejectWorld, W } = await import("../helpers/poRejectWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");

const world = makePoRejectWorld(db);
const tokenIds = [];

beforeAll(() => world.setup());
afterEach(async () => {
  await drainPoRejectedNotifications();
  if (tokenIds.length) {
    await db.none(`DELETE FROM tbl_vendor_rfq_tokens_non_login WHERE id = ANY($1::int[])`, [tokenIds.splice(0)]);
  }
  await world.cleanup();
});
afterAll(async () => {
  await world.teardown();
  await closeDb();
});

const REMARK = "vendor A cannot meet the delivery date";

/** An RFQ quoted by A and B, with A's PO rejected by the approver. */
async function rfqWithApproverRejection() {
  const staged = await world.stageRfq({ products: 1, vendors: [W.VENDOR_A, W.VENDOR_B] });
  const poA = (await world.award(staged, staged.products[0], [W.VENDOR_A])).pos[0].id;
  await world.initiate(poA);
  const res = await world.rejectOnPoPage(poA, { remarks: REMARK, reason_category: "RENEGOTIATE" });
  expect(res.status).toBe(200);
  return { staged, poA };
}

const leaksRejection = (body) => {
  const json = JSON.stringify(body);
  return json.includes(REMARK) || json.includes("RENEGOTIATE") || json.includes("reason_category");
};

describe("GET /rfq/getRfqById/:id — vendor_rejections", () => {
  it("gives the buyer the rejection", async () => {
    const { staged, poA } = await rfqWithApproverRejection();
    const res = await (await world.client(W.CREATOR)).get(`/api/v1/rfq/getRfqById/${staged.rfq.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.vendor_rejections).toEqual([
      expect.objectContaining({ po_id: poA, rejection_type: "approver", reason_category: "RENEGOTIATE", rejection_reason: REMARK }),
    ]);
  });

  it("gives an assigned vendor (JWT) no rejection entries, its own or a competitor's", async () => {
    const { staged } = await rfqWithApproverRejection();
    for (const vendorId of [W.VENDOR_B, W.VENDOR_A]) {
      const res = await (await world.client(vendorId)).get(`/api/v1/rfq/getRfqById/${staged.rfq.id}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(res.body.data.vendor_rejections).toEqual([]);
      expect(leaksRejection(res.body)).toBe(false);
    }
  });

  it("gives a vendor on the emailed-link token no rejection entries", async () => {
    const { staged } = await rfqWithApproverRejection();
    const token = String(9_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
    const row = await db.one(
      `INSERT INTO tbl_vendor_rfq_tokens_non_login (token, vendor_id, rfq_no) VALUES ($1::bigint, $2, $3) RETURNING id`,
      [token, W.VENDOR_B, staged.rfq.rfq_no]
    );
    tokenIds.push(row.id);

    const anon = await httpClient(null);
    const res = await anon.get(`/api/v1/rfq/getRfqById/${staged.rfq.id}?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.vendor_rejections).toEqual([]);
    expect(leaksRejection(res.body)).toBe(false);
  });
});

describe("POST /rfq/list-view — po_rejection marker", () => {
  it("never carries a rejection marker for a vendor", async () => {
    const { staged } = await rfqWithApproverRejection();
    // The buyer's card has it ...
    const buyer = await (await world.client(W.CREATOR)).post("/api/v1/rfq/list-view").send({ page: 1, limit: 100 });
    expect(buyer.status).toBe(200);
    const buyerRow = buyer.body.data.rows.find((r) => Number(r.id) === Number(staged.rfq.id));
    expect(buyerRow.po_rejection).toEqual(expect.objectContaining({ rejection_reason: REMARK }));

    // ... a vendor's response has no marker on any row, whatever rows it gets.
    const res = await (await world.client(W.VENDOR_B)).post("/api/v1/rfq/list-view").send({ page: 1, limit: 100 });
    expect(res.status).toBe(200);
    for (const r of res.body.data?.rows || []) expect(r.po_rejection ?? null).toBeNull();
    expect(leaksRejection(res.body)).toBe(false);
  });
});
