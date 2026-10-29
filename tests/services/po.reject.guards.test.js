// What a PO rejection refuses (client ticket T3, fix round 1).
// ----------------------------------------------------------------------------
// A rejection is recorded only against the PO's CURRENT approval, while it is
// still PENDING and the PO is still pending_approval. Everything else is a 409
// that changes nothing, on both surfaces (the PO page and the approval card):
//
//   STEP_NOT_PENDING         the approval already concluded, e.g. another
//                            approver approved first. This used to answer 200
//                            ("already decided"), so the approver, and the
//                            activity trail, recorded a rejection of a PO that
//                            had in fact been approved.
//   INSTANCE_NOT_CURRENT     the approval acted on is not the PO's current one
//                            (the PO has none, or has moved to another).
//   PO_NOT_PENDING_APPROVAL  the PO itself is no longer waiting for approval.
//
// The one non-PENDING case that still answers 200 is an approver's retry of
// their OWN rejection: nothing changes and the outcome that stands is returned.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const fakeTransport = { sendMail: (opts, cb) => cb(null, { messageId: "<captured>" }) };
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

/** Reject on the approval card, with or without a step id. */
async function cardReject(instanceId, { stepId = null, ...body } = {}) {
  return (await world.client(W.PO_APPROVER)).post(`/api/v1/general/hospitality/approval/action`).send({
    approval_instance_id: instanceId,
    ...(stepId ? { approval_instance_step_id: stepId } : {}),
    action: "REJECT",
    comment: "no",
    ...body,
  });
}

const rejectActions = (instanceId) =>
  db.any(`SELECT id FROM tbl_approval_actions WHERE approval_instance_id = $1 AND action = 'REJECT'`, [instanceId]);
const instanceStatus = async (id) => (await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [id])).status;
const poStatus = async (id) =>
  (await db.one(`SELECT status::text AS s FROM tbl_rfq_purchase_order WHERE id = $1`, [id])).s;

/** Activity rows captured from HTTP since `since`; the capture lands just after the response. */
async function activitySince(since, { settleMs = 1500, poId } = {}) {
  await new Promise((r) => setTimeout(r, settleMs));
  return db.any(
    `SELECT event_key, summary, status_code FROM tbl_activity_events
      WHERE occurred_at >= $1 AND source = 'HTTP' AND entity_type = 'PO' AND entity_id = $2
      ORDER BY id`,
    [since, poId]
  );
}

describe("a PO rejection that loses the race to an approval", () => {
  it("is refused with 409 STEP_NOT_PENDING on both surfaces, and leaves no rejection anywhere", async () => {
    const a = await world.pendingPo();
    const since = new Date();

    const approved = await world.approveOnPoPage(a.poId);
    expect(approved.status).toBe(200);
    expect(await instanceStatus(a.instanceId)).toBe("APPROVED");
    const statusAfterApprove = await poStatus(a.poId);
    expect(statusAfterApprove).not.toBe("pending_approval");

    const viaPage = await world.rejectOnPoPage(a.poId, { remarks: "too late", reason_category: "RENEGOTIATE" });
    expect(viaPage.status).toBe(409);
    expect(viaPage.body).toMatchObject({ status: 0, code: "STEP_NOT_PENDING" });
    expect(viaPage.body.message).toMatch(/already approved/i);
    expect(viaPage.body.message).toMatch(/not recorded/i);

    const viaCard = await cardReject(a.instanceId, { comment: "too late", reason_category: "RENEGOTIATE" });
    expect(viaCard.status).toBe(409);
    expect(viaCard.body).toMatchObject({ status: 3, code: "STEP_NOT_PENDING" });

    // Nothing of a rejection exists.
    expect(await instanceStatus(a.instanceId)).toBe("APPROVED");
    expect(await poStatus(a.poId)).toBe(statusAfterApprove);
    expect(await rejectActions(a.instanceId)).toEqual([]);
    expect(await sendBacksFor(db, a.poId)).toEqual([]);
    expect(await finalizationsFor(db, a.rfq.id, W.VENDOR_A)).toHaveLength(1);
    await drainPoRejectedNotifications();
    const notes = await db.any(
      `SELECT type FROM tbl_notifications
        WHERE (additional_data->>'po_id')::int = $1 AND type IN ('po_rejected', 'po_cancelled')`, [a.poId]);
    expect(notes).toEqual([]);

    // The activity trail has the approval and no rejection.
    const events = await activitySince(since, { poId: a.poId });
    expect(events.some((e) => /approved/i.test(e.summary))).toBe(true);
    expect(events.filter((e) => /reject/i.test(e.summary))).toEqual([]);
  });

  it("answers an approver's retry of their OWN rejection 200, changing nothing and reporting what stands", async () => {
    const a = await world.pendingPo();
    const first = await world.rejectOnPoPage(a.poId, { remarks: "GST wrong", reason_category: "PRICE_TAX_QUERY" });
    expect(first.status).toBe(200);
    await drainPoRejectedNotifications();
    const notesBefore = await db.any(
      `SELECT id FROM tbl_notifications WHERE (additional_data->>'po_id')::int = $1 AND type = 'po_rejected'`, [a.poId]);

    // A double-click, or a refresh-and-resend with a different reason.
    const again = await world.rejectOnPoPage(a.poId, { remarks: "again", reason_category: "OTHER" });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({
      already_completed: true, route: "COMMERCIAL", reason_category: "PRICE_TAX_QUERY",
    });
    const viaCard = await cardReject(a.instanceId, { comment: "again" });
    expect(viaCard.status).toBe(200);
    expect(viaCard.body.status).toBe(1);

    expect(await rejectActions(a.instanceId)).toHaveLength(1);
    expect(await sendBacksFor(db, a.poId)).toHaveLength(1);
    await drainPoRejectedNotifications();
    const notesAfter = await db.any(
      `SELECT id FROM tbl_notifications WHERE (additional_data->>'po_id')::int = $1 AND type = 'po_rejected'`, [a.poId]);
    expect(notesAfter).toHaveLength(notesBefore.length);
  });
});

describe("a PO rejection on an approval that is not current", () => {
  it("refuses INSTANCE_NOT_CURRENT when the PO has no approval linked", async () => {
    const a = await world.pendingPo();
    const stepId = await world.currentStepId(a.instanceId);
    await db.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL WHERE id = $1`, [a.poId]);

    const res = await cardReject(a.instanceId, { stepId });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 3, code: "INSTANCE_NOT_CURRENT" });
    expect(await instanceStatus(a.instanceId)).toBe("PENDING");
    expect(await rejectActions(a.instanceId)).toEqual([]);
    expect(await poStatus(a.poId)).toBe("pending_approval");
  });

  it("refuses INSTANCE_NOT_CURRENT when the PO has moved to another approval", async () => {
    const a = await world.pendingPo();
    const stepId = await world.currentStepId(a.instanceId);
    // The PO now points at a newer approval (what a re-initiation leaves).
    const newer = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          hospitality_company_id, hotel_id, department_id, initiated_by)
       SELECT entity_type, entity_id, approval_policy_id, 'PENDING', 1,
              hospitality_company_id, hotel_id, department_id, initiated_by
         FROM tbl_approval_instances WHERE id = $1
       RETURNING id`,
      [a.instanceId]
    );
    await db.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = $1 WHERE id = $2`, [newer.id, a.poId]);

    const res = await cardReject(a.instanceId, { stepId });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 3, code: "INSTANCE_NOT_CURRENT" });
    expect(await instanceStatus(a.instanceId)).toBe("PENDING");
    expect(await rejectActions(a.instanceId)).toEqual([]);
    expect(await poStatus(a.poId)).toBe("pending_approval");
  });

  it("refuses PO_NOT_PENDING_APPROVAL when the PO is no longer waiting for approval", async () => {
    const a = await world.pendingPo();
    const stepId = await world.currentStepId(a.instanceId);
    // The approval is still PENDING but the PO has left pending_approval.
    await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'draft' WHERE id = $1`, [a.poId]);

    const viaPage = await world.rejectOnPoPage(a.poId, { remarks: "x", reason_category: "OTHER" });
    expect(viaPage.status).toBe(409);
    expect(viaPage.body).toMatchObject({ status: 0, code: "PO_NOT_PENDING_APPROVAL" });
    const viaCard = await cardReject(a.instanceId, { stepId });
    expect(viaCard.status).toBe(409);
    expect(viaCard.body).toMatchObject({ status: 3, code: "PO_NOT_PENDING_APPROVAL" });

    expect(await instanceStatus(a.instanceId)).toBe("PENDING");
    expect(await rejectActions(a.instanceId)).toEqual([]);
    expect(await poStatus(a.poId)).toBe("draft");
    expect(await sendBacksFor(db, a.poId)).toEqual([]);
  });
});
