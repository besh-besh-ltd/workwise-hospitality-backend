// The PO detail's dates say what happened to the PO's approval (E2E defect 4).
// ----------------------------------------------------------------------------
// GET /po/detail/:po_id used to label the approval's completed_at "Approved"
// whatever the approval's outcome, so a PO an approver had REJECTED showed
// "Approved <date>" under Key dates. The same timestamp also stood in for the
// date the vendor selection was finalized and the date the PO was sent to the
// vendor; neither happened on a rejected or cancelled approval.
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

/** The PO detail page's payload, read by the CEO-level initiator. */
async function detail(poId) {
  const res = await (await world.client(W.INITIATOR)).get(`/api/v1/po/detail/${poId}`);
  expect(res.status).toBe(200);
  return res.body.data;
}

/** The instance's outcome and when it was reached, as the API serialises it. */
async function outcomeOf(instanceId) {
  const row = await db.one(`SELECT status, completed_at FROM tbl_approval_instances WHERE id = $1`, [instanceId]);
  return { status: row.status, at: row.completed_at ? new Date(row.completed_at).toISOString() : null };
}

/** Only the key dates that report the approval's outcome. */
const outcomeDates = (d) => d.key_dates.filter((x) => ["Approved", "Rejected", "Cancelled"].includes(x.k));
const sentToVendor = (d) => d.workflow.find((n) => n.title === "Sent to vendor") || null;

describe("PO detail key dates follow the approval's outcome", () => {
  it("an approved PO reads Approved, on the day it was approved", async () => {
    const a = await world.pendingPo();
    expect((await world.approveOnPoPage(a.poId)).status).toBe(200);
    const outcome = await outcomeOf(a.instanceId);
    expect(outcome.status).toBe("APPROVED");

    const d = await detail(a.poId);
    expect(outcomeDates(d)).toEqual([{ k: "Approved", v: outcome.at, soon: false }]);
    // Sent to the vendor when it was approved.
    expect(sentToVendor(d)).toMatchObject({ when: outcome.at });
    expect(d.rfq.finalized_date).toBe(outcome.at);
  });

  it("an approver-rejected PO reads Rejected, never Approved", async () => {
    const a = await world.pendingPo();
    const res = await world.rejectOnPoPage(a.poId, { remarks: "GST shown twice", reason_category: "PRICE_TAX_QUERY" });
    expect(res.status).toBe(200);
    const outcome = await outcomeOf(a.instanceId);
    expect(outcome.status).toBe("REJECTED");

    const d = await detail(a.poId);
    expect(outcomeDates(d)).toEqual([{ k: "Rejected", v: outcome.at, soon: false }]);
    // The rejection is not the day the vendor selection was finalized.
    expect(d.rfq.finalized_date).toBeNull();
    expect(sentToVendor(d)).toBeNull();
  });

  it("a cancelled approval reads Cancelled, and nothing says the PO went to the vendor", async () => {
    const a = await world.pendingPo();
    const res = await (await world.client(W.INITIATOR))
      .post("/api/v1/general/hospitality/approval/cancel")
      .send({ instance_id: a.instanceId, reason: "raised against the wrong outlet" });
    expect(res.status).toBe(200);
    const outcome = await outcomeOf(a.instanceId);
    expect(outcome.status).toBe("CANCELLED");

    const d = await detail(a.poId);
    expect(outcomeDates(d)).toEqual([{ k: "Cancelled", v: outcome.at, soon: false }]);
    expect(d.rfq.finalized_date).toBeNull();
    // The PO never left: the node may be listed as a step still ahead, but it
    // carries no date (it used to carry the cancellation's).
    const sent = sentToVendor(d);
    if (sent) expect(sent).toMatchObject({ when: null, status: "pending" });
  });

  it("a PO still waiting on its approver has no outcome date", async () => {
    const a = await world.pendingPo();
    const d = await detail(a.poId);
    expect(outcomeDates(d)).toEqual([]);
    expect(d.rfq.finalized_date).toBeNull();
  });
});
