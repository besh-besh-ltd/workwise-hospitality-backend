// Rejecting one vendor's PO on a multi-vendor award (client ticket T3).
// ----------------------------------------------------------------------------
// A rejection de-finalizes ONE vendor: the one on the rejected PO. Another
// vendor's award, PO and award approval are not touched, and the RFQ does not
// fall back while a sibling PO is still waiting for its approver.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const fakeTransport = { sendMail: (opts, cb) => cb(null, { messageId: "<captured>" }) };
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { makePoRejectWorld, finalizationsFor, W } = await import("../helpers/poRejectWorld.js");
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

const statusOf = async (poId) =>
  (await db.one(`SELECT status::text AS status FROM tbl_rfq_purchase_order WHERE id = $1`, [poId])).status;
const instanceStatus = async (id) => (await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [id])).status;

const lifecycle = async (rfqId) => {
  // The CEO-level initiator reads every stage; the RFQ creator cannot see the PO panel.
  const res = await (await world.client(W.INITIATOR)).get(`/api/v1/rfq/${rfqId}/lifecycle`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  return res.body.data;
};

describe("rejecting one vendor's PO on a multi-vendor award", () => {
  it("rejecting vendor A's PO leaves vendor B's finalization, PO and NQ approval intact", async () => {
    // One product split between two vendors: one award approval, two POs.
    const staged = await world.stageRfq({ products: 1, vendors: [W.VENDOR_A, W.VENDOR_B] });
    const { pos, approvalInstanceId: nqId } = await world.award(staged, staged.products[0], [W.VENDOR_A, W.VENDOR_B]);
    expect(pos).toHaveLength(2);
    const poA = pos.find((p) => p.finalized_vendor_id === W.VENDOR_A).id;
    const poB = pos.find((p) => p.finalized_vendor_id === W.VENDOR_B).id;
    await world.initiate(poA);
    const instB = await world.initiate(poB);

    const res = await world.rejectOnPoPage(poA, { remarks: "vendor A cannot deliver", reason_category: "RENEGOTIATE" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    // A is out ...
    expect(await statusOf(poA)).toBe("rejected");
    expect(await finalizationsFor(db, staged.rfq.id, W.VENDOR_A)).toHaveLength(0);
    // ... B is exactly where it was.
    expect(await finalizationsFor(db, staged.rfq.id, W.VENDOR_B)).toHaveLength(1);
    expect(await statusOf(poB)).toBe("pending_approval");
    expect(await instanceStatus(instB)).toBe("PENDING");
    // The award approval still backs B's PO, so it is not cancelled.
    expect(await instanceStatus(nqId)).toBe("APPROVED");
    // Nothing of B's was archived.
    const archived = await db.any(`SELECT vendor_id FROM tbl_quote_finalization_history WHERE rfq_id = $1`, [staged.rfq.id]);
    expect(archived.map((r) => r.vendor_id)).toEqual([W.VENDOR_A]);
  });

  it("lifecycle shows PO_REJECTED for A and PO_APPROVAL while B is pending", async () => {
    // Two products, one per vendor.
    const staged = await world.stageRfq({ products: 2, vendors: [W.VENDOR_A, W.VENDOR_B] });
    const [p1, p2] = staged.products;
    const poA = (await world.award(staged, p1, [W.VENDOR_A])).pos[0].id;
    const poB = (await world.award(staged, p2, [W.VENDOR_B])).pos[0].id;
    await world.initiate(poA);
    await world.initiate(poB);

    const rejected = await world.rejectOnPoPage(poA, { remarks: "wrong vendor", reason_category: "RENEGOTIATE" });
    expect(rejected.status).toBe(200);

    // B is still with its approver: the RFQ stays in PO approval.
    let data = await lifecycle(staged.rfq.id);
    expect(data.current_status).toBe("PO_APPROVAL");

    // Once B is approved, what is left is A's rejected product.
    const approved = await world.approveOnPoPage(poB);
    expect(approved.status).toBe(200);
    expect(await statusOf(poB)).not.toBe("pending_approval");

    data = await lifecycle(staged.rfq.id);
    expect(data.current_status).toBe("PO_REJECTED");
    const poStage = data.stages.find((s) => s.key === "purchase-order");
    expect(poStage.phase.sub_status).toBe("approver_rejected");
  });
});
