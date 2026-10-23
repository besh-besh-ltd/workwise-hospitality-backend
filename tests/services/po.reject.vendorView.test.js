// A vendor never reads why an approver turned their PO down, nor who did.
// ----------------------------------------------------------------------------
// GET /po/vendor/detail/:po_id serves a vendor their own PO in any status,
// rejected and cancelled included. Its approval trail keeps its shape (which
// level, that it ended), but the rejected or cancelled level's actor and the
// approver's comment are internal to the buyer, as are the reason codes. The
// buyer's own detail still shows them.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const fakeTransport = { sendMail: (opts, cb) => cb(null, { messageId: "<captured>" }) };
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { makePoRejectWorld, W } = await import("../helpers/poRejectWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");
const { REASON_LABELS } = await import("../../app/services/po/poSendBackReasons.js");

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

const nameOf = async (userId) => (await db.one(`SELECT name FROM tbl_users WHERE id = $1`, [userId])).name;

const vendorDetail = async (poId) => {
  const res = await (await world.client(W.VENDOR_A)).get(`/api/v1/po/vendor/detail/${poId}`);
  expect(res.status).toBe(200);
  return res.body;
};
const buyerDetail = async (poId) => {
  const res = await (await world.client(W.INITIATOR)).get(`/api/v1/po/detail/${poId}`);
  expect(res.status).toBe(200);
  return res.body;
};
const approvalNode = (body, status) => body.data.workflow.find((n) => n.title === "L1 approval" && n.status === status);

describe("vendor PO detail after an approver's decision", () => {
  it("a rejected PO: the vendor gets no comment, reason or rejecter; the buyer still does", async () => {
    const COMMENT = "Internal: freight padded";
    const a = await world.pendingPo();
    const res = await world.rejectOnPoPage(a.poId, { remarks: COMMENT, reason_category: "PRICE_TAX_QUERY" });
    expect(res.status).toBe(200);
    const rejecter = await nameOf(W.PO_APPROVER);

    const vendor = await vendorDetail(a.poId);
    const seen = JSON.stringify(vendor);
    expect(seen).not.toContain(COMMENT);
    expect(seen).not.toContain(REASON_LABELS.PRICE_TAX_QUERY);
    expect(seen).not.toContain("PRICE_TAX_QUERY");
    expect(seen).not.toContain(rejecter);
    // The trail keeps its shape: the level is there, and it was rejected.
    expect(approvalNode(vendor, "rejected")).toMatchObject({ by: null, reason: null, policy: null });

    const buyer = await buyerDetail(a.poId);
    expect(approvalNode(buyer, "rejected")).toMatchObject({ by: rejecter, reason: COMMENT, policy: COMMENT });
  });

  it("a PO cancelled as not needed: the vendor gets no comment, reason or approver", async () => {
    const COMMENT = "Internal: budget pulled for Q3";
    const a = await world.pendingPo();
    const res = await world.rejectOnPoPage(a.poId, { remarks: COMMENT, reason_category: "NOT_REQUIRED" });
    expect(res.status).toBe(200);
    expect((await db.one(`SELECT status::text AS s FROM tbl_rfq_purchase_order WHERE id = $1`, [a.poId])).s).toBe("cancelled");
    const approver = await nameOf(W.PO_APPROVER);

    const vendor = await vendorDetail(a.poId);
    const seen = JSON.stringify(vendor);
    expect(seen).not.toContain(COMMENT);
    expect(seen).not.toContain(REASON_LABELS.NOT_REQUIRED);
    expect(seen).not.toContain("NOT_REQUIRED");
    expect(seen).not.toContain(approver);
    expect(approvalNode(vendor, "rejected")).toMatchObject({ by: null, reason: null, policy: null });

    const buyer = await buyerDetail(a.poId);
    expect(approvalNode(buyer, "rejected")).toMatchObject({ by: approver, reason: COMMENT });
  });
});
