// Re-awarding after a PO rejection (client ticket T3).
// ----------------------------------------------------------------------------
// A rejection sends the product back to commercial evaluation. The people who
// can act are told — the RFQ creator, the PO creator and the commercial
// evaluators, once each, never the vendor — and the PO that re-awards the
// product carries a pointer to the rejected one, so its approver can see why
// the first was turned down.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const sentMails = [];
const fakeTransport = {
  sendMail: (opts, cb) => { sentMails.push(opts); cb(null, { messageId: "<captured>" }); },
};
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { makePoRejectWorld, W } = await import("../helpers/poRejectWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");

const world = makePoRejectWorld(db);

beforeAll(() => world.setup());
afterEach(async () => {
  await drainPoRejectedNotifications();
  await world.cleanup();
});
afterAll(async () => {
  await world.teardown();
  await closeDb();
});

/** A PO for vendor A, initiated and pending, on an RFQ both vendors quoted. */
async function pendingPoWithAlternative() {
  const staged = await world.stageRfq({ products: 1, vendors: [W.VENDOR_A, W.VENDOR_B] });
  const product = staged.products[0];
  const { pos } = await world.award(staged, product, [W.VENDOR_A]);
  const poId = pos[0].id;
  const instanceId = await world.initiate(poId);
  return { ...staged, product, poId, instanceId };
}

describe("re-award after a PO rejection", () => {
  it("a re-awarded PO records replaces_po_id and exposes the prior reason", async () => {
    const a = await pendingPoWithAlternative();
    const rejectedPo = await db.one(`SELECT po_number FROM tbl_rfq_purchase_order WHERE id = $1`, [a.poId]);

    const res = await world.rejectOnPoPage(a.poId, { remarks: "Vendor B is cheaper now", reason_category: "RENEGOTIATE" });
    expect(res.status).toBe(200);

    // The people who re-award are sent to Create Round for a re-negotiation.
    await drainPoRejectedNotifications();
    const links = await db.any(
      `SELECT DISTINCT action_url FROM tbl_notifications WHERE (additional_data->>'po_id')::int = $1 AND type = 'po_rejected'`,
      [a.poId]);
    expect(links.map((l) => l.action_url)).toEqual([`/dashboard/buyer/negotiation/${a.rfq.id}/create`]);

    // Re-award the product to vendor B.
    const { pos } = await world.award(a, a.product, [W.VENDOR_B]);
    expect(pos).toHaveLength(1);
    const newPoId = pos[0].id;
    const row = await db.one(`SELECT replaces_po_id FROM tbl_rfq_purchase_order WHERE id = $1`, [newPoId]);
    expect(row.replaces_po_id).toBe(a.poId);

    // A buyer sees the trace on the PO detail ...
    const buyer = await world.client(W.INITIATOR);
    const detail = await buyer.get(`/api/v1/po/${newPoId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.detail.replaces).toEqual({
      po_id: a.poId,
      po_number: rejectedPo.po_number,
      reason_category: "RENEGOTIATE",
      comment: "Vendor B is cheaper now",
    });
    // ... and a PO that replaces nothing says so.
    const plain = await buyer.get(`/api/v1/po/${a.poId}`);
    expect(plain.status).toBe(200);
    expect(plain.body.detail.replaces).toBeNull();

    // A vendor never learns why another vendor's PO was rejected.
    await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'acceptance_pending' WHERE id = $1`, [newPoId]);
    const vendor = await world.client(W.VENDOR_B);
    const asVendor = await vendor.get(`/api/v1/po/${newPoId}`);
    expect(asVendor.status).toBe(200);
    expect(asVendor.body.data).not.toHaveProperty("replaces_po_id");
    expect(JSON.stringify(asVendor.body)).not.toContain("Vendor B is cheaper now");
    expect(asVendor.body.detail?.replaces).toBeUndefined();
  });

  it("notifies RFQ creator, PO creator and commercial evaluators once each, never the vendor", async () => {
    const a = await pendingPoWithAlternative();
    const po = await db.one(`SELECT po_number, initiated_by FROM tbl_rfq_purchase_order WHERE id = $1`, [a.poId]);
    // The world's PO creator is the person who raised the award approval.
    expect(po.initiated_by).toBe(W.COMM_EVAL);
    sentMails.length = 0;

    const res = await world.rejectOnPoPage(a.poId, { remarks: "GST shown twice", reason_category: "PRICE_TAX_QUERY" });
    expect(res.status).toBe(200);
    await drainPoRejectedNotifications();

    const rows = await db.any(
      `SELECT recipient_user_id, title, message, action_url FROM tbl_notifications
        WHERE (additional_data->>'po_id')::int = $1 AND type = 'po_rejected'
        ORDER BY recipient_user_id`, [a.poId]);
    // RFQ creator, PO creator (= award approval raiser), and the commercial
    // approver who finalized the award. Once each. Not the rejecting approver,
    // not the vendors.
    const expected = [W.CREATOR, W.COMM_EVAL, W.COMM_APP].sort((x, y) => x - y);
    expect(rows.map((r) => r.recipient_user_id)).toEqual(expected);

    const approverName = (await db.one(`SELECT name FROM tbl_users WHERE id = $1`, [W.PO_APPROVER])).name;
    for (const r of rows) {
      expect(r.title).toBe(`PO ${po.po_number} rejected by ${approverName}`);
      expect(r.message).toBe(
        `PO ${po.po_number} was rejected by ${approverName}: Question on price, GST or calculation. ` +
        `"GST shown twice". It is back in commercial evaluation for re-award.`
      );
      expect(r.action_url).toBe(`/dashboard/buyer/quote-comparison?rfq=${a.rfq.id}`);
    }

    // No vendor notification of any kind came out of the rejection.
    const toVendors = await db.any(
      `SELECT type FROM tbl_notifications
        WHERE (additional_data->>'po_id')::int = $1 AND recipient_user_id = ANY($2::int[])`,
      [a.poId, [W.VENDOR_A, W.VENDOR_B]]);
    expect(toVendors).toEqual([]);

    // One email per recipient with an address; none to a vendor.
    const users = await db.any(`SELECT id, email FROM tbl_users WHERE id = ANY($1::int[])`,
      [[...expected, W.VENDOR_A, W.VENDOR_B, W.PO_APPROVER]]);
    const emailOf = new Map(users.map((u) => [u.id, u.email]));
    const rejectionMails = sentMails.filter((m) => /rejected by/i.test(m.subject || ""));
    expect(rejectionMails.map((m) => m.to).sort()).toEqual(
      expected.map((id) => emailOf.get(id)).filter(Boolean).sort());
    const vendorAddresses = [W.VENDOR_A, W.VENDOR_B].map((id) => emailOf.get(id)).filter(Boolean);
    for (const m of sentMails) expect(vendorAddresses).not.toContain(m.to);
  });
});
