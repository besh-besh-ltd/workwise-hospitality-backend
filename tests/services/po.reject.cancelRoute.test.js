// "Not needed any more": a PO rejection that cancels instead of re-awarding
// (client ticket T3).
// ----------------------------------------------------------------------------
// The reason NOT_REQUIRED takes the CANCEL route: the PO is cancelled (not
// 'rejected'), the vendor's award is archived like any rejection, nothing asks
// for a re-award, and the RFQ creator is told to close the RFQ if nothing else
// is needed.
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
const { makePoRejectWorld, sendBacksFor, finalizationsFor, W } = await import("../helpers/poRejectWorld.js");
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

describe("rejecting a PO as not needed", () => {
  it("NOT_REQUIRED cancels the PO, archives finalization, raises no re-award chip and tells the RFQ creator", async () => {
    const a = await world.pendingPo();
    sentMails.length = 0;

    // No route in the body: NOT_REQUIRED alone means CANCEL.
    const res = await world.rejectOnPoPage(a.poId, { remarks: "Outlet refurbishment dropped", reason_category: "NOT_REQUIRED" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data).toMatchObject({ route: "CANCEL", reason_category: "NOT_REQUIRED", instance_status: "REJECTED" });

    // Cancelled, not rejected; the approval itself was rejected.
    const po = await db.one(`SELECT status::text AS status FROM tbl_rfq_purchase_order WHERE id = $1`, [a.poId]);
    expect(po.status).toBe("cancelled");
    const inst = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [a.instanceId]);
    expect(inst.status).toBe("REJECTED");

    // The award is archived, not left live on a PO nobody will raise.
    expect(await finalizationsFor(db, a.rfq.id, W.VENDOR_A)).toHaveLength(0);
    const archived = await db.any(
      `SELECT vendor_id, changed_by FROM tbl_quote_finalization_history WHERE rfq_id = $1`, [a.rfq.id]);
    expect(archived).toEqual([{ vendor_id: W.VENDOR_A, changed_by: W.PO_APPROVER }]);

    expect(await sendBacksFor(db, a.poId)).toEqual([expect.objectContaining({
      route: "CANCEL", reason_category: "NOT_REQUIRED", comment: "Outlet refurbishment dropped",
      status: "CLOSED", resolution: "CANCELLED", requested_by: W.PO_APPROVER,
    })]);
    // One lifecycle row for the decision (ruling R21); the send-back carries the rest.
    const lifecycle = await db.any(
      `SELECT stage, action FROM tbl_lifecycle_history
        WHERE entity_type = 'PO' AND entity_id = $1 AND (action = 'REJECT' OR stage ~ 'REJECT|CANCEL')`, [a.poId]);
    expect(lifecycle).toEqual([{ stage: "REJECTED", action: "REJECT" }]);

    // No re-award chip: not on the RFQ detail, not on the list card, and the
    // lifecycle does not call it a rejection waiting for re-award.
    const creator = await world.client(W.CREATOR);
    const detail = await creator.get(`/api/v1/rfq/getRfqById/${a.rfq.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.vendor_rejections).toEqual([]);
    const list = await creator.post("/api/v1/rfq/list-view").send({ page: 1, limit: 100 });
    expect(list.status).toBe(200);
    const row = list.body.data.rows.find((r) => Number(r.id) === Number(a.rfq.id));
    expect(row).toBeDefined();
    expect(row.po_rejection).toBeNull();
    expect(row.lifecycle_stage).not.toBe("PO_REJECTED");

    // The RFQ creator is told, with a link to the RFQ, to close it.
    await drainPoRejectedNotifications();
    const notes = await db.any(
      `SELECT recipient_user_id, type, title, message, action_url FROM tbl_notifications
        WHERE (additional_data->>'po_id')::int = $1 AND type = 'po_cancelled'`, [a.poId]);
    const toCreator = notes.filter((n) => n.recipient_user_id === W.CREATOR);
    expect(toCreator).toHaveLength(1);
    expect(toCreator[0].action_url).toBe(`/dashboard/buyer/rfq-management-details?type=buyer-view&id=${a.rfq.id}`);
    expect(toCreator[0].message).toContain("cancelled as not needed");
    expect(toCreator[0].message).toContain(`Please close RFQ ${a.rfq.rfq_no} if nothing else is required.`);
    expect(toCreator[0].message).toContain("Not needed any more");
    expect(toCreator[0].message).toContain('"Outlet refurbishment dropped"');
    // ... and nobody is asked to re-award.
    const reaward = await db.any(
      `SELECT 1 FROM tbl_notifications WHERE (additional_data->>'po_id')::int = $1 AND type = 'po_rejected'`, [a.poId]);
    expect(reaward).toHaveLength(0);

    const creatorEmail = (await db.one(`SELECT email FROM tbl_users WHERE id = $1`, [W.CREATOR])).email;
    const mails = sentMails.filter((m) => /cancelled by/i.test(m.subject || ""));
    expect(mails.map((m) => m.to)).toContain(creatorEmail);
  });
});
