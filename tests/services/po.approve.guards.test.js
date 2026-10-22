// What a PO approval refuses (client ticket T3, ruling R25).
// ----------------------------------------------------------------------------
// The approval twin of po.reject.guards. An APPROVE is recorded only against
// the PO's CURRENT approval, while it is still PENDING and the PO is still
// pending_approval. Anything else is a 409 that changes nothing, on both
// surfaces (the PO page and the approval card).
//
// Before: the engine answers an APPROVE on a concluded instance with
// `already_completed` (before it checks who is asking), and the PO path ran
// the rest anyway:
//   - on a REJECTED instance it rewrote the dead PO's document (an S3 upload
//     and a new po_pdf_url), answered 200, and the trail said "approved";
//   - on an APPROVED instance (a late ANY approver, a double-click) it re-ran
//     the post-action, which put an accepted, dispatched or received PO back
//     to acceptance_pending and emailed the vendor again.
//
// The one concluded case that answers 200 is the same approver's retry of
// their own APPROVE. Nothing runs: no document, no post-action, no email.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const sent = [];
const fakeTransport = { sendMail: (opts, cb) => { sent.push(opts); cb(null, { messageId: "<captured>" }); } };
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { makePoRejectWorld, W } = await import("../helpers/poRejectWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");

const world = makePoRejectWorld(db);
const SENTINEL_PDF = "https://bucket.s3.ap-south-1.amazonaws.com/purchase-order/po-SENTINEL-1.pdf";

beforeAll(() => world.setup());
afterEach(async () => {
  await drainPoRejectedNotifications();
  await world.cleanup();
  sent.length = 0;
});
afterAll(async () => {
  await world.teardown();
  await closeDb();
});

const settle = (ms = 1000) => new Promise((r) => setTimeout(r, ms));

/** Approve on the PO page as `userId`. */
async function pageApprove(userId, poId) {
  return (await world.client(userId)).post(`/api/v1/po/approve/${poId}`).send({ decision: "approved", remarks: "ok" });
}

/** Approve on the approval card as `userId`. */
async function cardApprove(userId, instanceId, stepId) {
  return (await world.client(userId)).post(`/api/v1/general/hospitality/approval/action`).send({
    approval_instance_id: instanceId,
    ...(stepId ? { approval_instance_step_id: stepId } : {}),
    action: "APPROVE",
    comment: "ok",
  });
}

const po = (id) =>
  db.one(`SELECT status::text AS status, po_pdf_url, po_number FROM tbl_rfq_purchase_order WHERE id = $1`, [id]);
const instanceStatus = async (id) => (await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [id])).status;
const approveActions = (instanceId) =>
  db.any(`SELECT approver_user_id FROM tbl_approval_actions WHERE approval_instance_id = $1 AND action = 'APPROVE'`, [instanceId]);
/** handlePOPostApproval's own lifecycle row: one per run of the post-action. */
const postActionRuns = async (poId) =>
  (await db.one(
    `SELECT COUNT(*)::int AS n FROM tbl_lifecycle_history
      WHERE entity_type = 'PO' AND entity_id = $1 AND stage = 'PO_ACCEPTANCE_PENDING'`,
    [poId]
  )).n;
/** The vendor's "accept or reject" email for this PO. */
const vendorAcceptanceEmails = (poNumber) =>
  sent.filter((m) => String(m.subject || "").includes(`PO #${poNumber}`) && /Accept or Reject/.test(String(m.subject)));

/** HTTP activity since `since`: the PO page's by PO id, the card's by actor. */
async function approvalActivitySince(since, { poId, actorId }) {
  await settle(1500);
  return db.any(
    `SELECT event_key, summary, status_code FROM tbl_activity_events
      WHERE occurred_at >= $1 AND source = 'HTTP'
        AND ((entity_type = 'PO' AND entity_id = $2) OR (event_key = 'approval_decided' AND actor_user_id = $3))
      ORDER BY id`,
    [since, poId, actorId]
  );
}

/** A second approver on the PO's current step, decided by ANY, as a late approver needs. */
async function addAnyApprover(instanceId, userId) {
  const stepId = await world.currentStepId(instanceId);
  await db.none(`UPDATE tbl_approval_instance_steps SET decision_rule = 'ANY' WHERE id = $1`, [stepId]);
  await db.none(
    `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING')`,
    [stepId, userId]
  );
  return stepId;
}

describe("an approval on a REJECTED approval", () => {
  it("is refused 409 STEP_NOT_PENDING on both surfaces; the document, PO and trail are untouched", async () => {
    const a = await world.pendingPo();
    const stepId = await world.currentStepId(a.instanceId);
    const rejected = await world.rejectOnPoPage(a.poId, { remarks: "GST wrong", reason_category: "PRICE_TAX_QUERY" });
    expect(rejected.status).toBe(200);
    await db.none(`UPDATE tbl_rfq_purchase_order SET po_pdf_url = $1 WHERE id = $2`, [SENTINEL_PDF, a.poId]);
    const before = await po(a.poId);
    const since = new Date();

    const viaPage = await pageApprove(W.PO_APPROVER, a.poId);
    const viaCard = await cardApprove(W.PO_APPROVER, a.instanceId, stepId);
    await settle();

    // Nothing happened: state and side effects first, then the answers.
    const after = await po(a.poId);
    expect(after.po_pdf_url).toBe(SENTINEL_PDF);
    expect(after.status).toBe(before.status);
    expect(await instanceStatus(a.instanceId)).toBe("REJECTED");
    expect(await approveActions(a.instanceId)).toEqual([]);
    expect(await postActionRuns(a.poId)).toBe(0);
    expect(vendorAcceptanceEmails(after.po_number)).toEqual([]);

    expect(viaPage.status).toBe(409);
    expect(viaPage.body).toMatchObject({ status: 0, code: "STEP_NOT_PENDING" });
    expect(viaPage.body.message).toMatch(/already rejected/i);
    expect(viaPage.body.message).toMatch(/approval was not recorded/i);
    expect(viaCard.status).toBe(409);
    expect(viaCard.body).toMatchObject({ status: 3, code: "STEP_NOT_PENDING" });

    const events = await approvalActivitySince(since, { poId: a.poId, actorId: W.PO_APPROVER });
    expect(events.filter((e) => /approved/i.test(e.summary))).toEqual([]);
  });
});

describe("an approval on an APPROVED approval", () => {
  it("refuses a different approver's late approval 409; an accepted PO stays accepted and is not re-sent", async () => {
    const a = await world.pendingPo();
    const stepId = await addAnyApprover(a.instanceId, W.COMM_APP);

    expect((await pageApprove(W.PO_APPROVER, a.poId)).status).toBe(200);
    expect(await instanceStatus(a.instanceId)).toBe("APPROVED");
    expect((await po(a.poId)).status).toBe("acceptance_pending");

    // The vendor accepts.
    const accepted = await (await world.client(W.VENDOR_A)).post(`/api/v1/po/accept/${a.poId}`).send({});
    expect(accepted.status).toBe(200);
    expect((await po(a.poId)).status).toBe("approved");
    await db.none(`UPDATE tbl_rfq_purchase_order SET po_pdf_url = $1 WHERE id = $2`, [SENTINEL_PDF, a.poId]);
    await settle();
    const { po_number } = await po(a.poId);
    const emailsBefore = vendorAcceptanceEmails(po_number).length;
    expect(emailsBefore).toBe(1);

    // The other ANY approver, late, on both surfaces; then the first
    // approver's own retry.
    const viaPage = await pageApprove(W.COMM_APP, a.poId);
    const viaCard = await cardApprove(W.COMM_APP, a.instanceId, stepId);
    const retry = await pageApprove(W.PO_APPROVER, a.poId);
    await settle();

    // The accepted PO is untouched: state and side effects first.
    const after = await po(a.poId);
    expect(after.status).toBe("approved");
    expect(after.po_pdf_url).toBe(SENTINEL_PDF);
    expect(await postActionRuns(a.poId)).toBe(1);
    expect(vendorAcceptanceEmails(po_number)).toHaveLength(emailsBefore);
    expect((await approveActions(a.instanceId)).map((r) => r.approver_user_id)).toEqual([W.PO_APPROVER]);

    expect(viaPage.status).toBe(409);
    expect(viaPage.body).toMatchObject({ status: 0, code: "STEP_NOT_PENDING" });
    expect(viaPage.body.message).toMatch(/already approved/i);
    expect(viaCard.status).toBe(409);
    expect(viaCard.body).toMatchObject({ status: 3, code: "STEP_NOT_PENDING" });
    expect(retry.status).toBe(200);
    expect(retry.body.data).toMatchObject({ instance_status: "APPROVED", already_completed: true });
  });

  it("answers the same approver's double-click 200 and runs the post-action exactly once", async () => {
    const a = await world.pendingPo();
    const stepId = await world.currentStepId(a.instanceId);

    const first = await pageApprove(W.PO_APPROVER, a.poId);
    expect(first.status).toBe(200);
    expect(first.body.data.already_completed).not.toBe(true);
    await db.none(`UPDATE tbl_rfq_purchase_order SET po_pdf_url = $1 WHERE id = $2`, [SENTINEL_PDF, a.poId]);

    const again = await pageApprove(W.PO_APPROVER, a.poId);
    const viaCard = await cardApprove(W.PO_APPROVER, a.instanceId, stepId);
    await settle();

    // One decision, one post-action, one vendor email: side effects first.
    const after = await po(a.poId);
    expect(await postActionRuns(a.poId)).toBe(1);
    expect(vendorAcceptanceEmails(after.po_number)).toHaveLength(1);
    expect(after.po_pdf_url).toBe(SENTINEL_PDF);
    expect(after.status).toBe("acceptance_pending");
    expect(await approveActions(a.instanceId)).toHaveLength(1);

    expect(again.status).toBe(200);
    expect(again.body.status).toBe(1);
    expect(again.body.message).toMatch(/already approved/i);
    expect(again.body.data).toMatchObject({ instance_status: "APPROVED", already_completed: true });
    expect(viaCard.status).toBe(200);
    expect(viaCard.body.status).toBe(1);
    expect(viaCard.body.data).toMatchObject({ instance_status: "APPROVED", already_completed: true });
  });
});

describe("an approval on an approval that is not current, or a PO not pending", () => {
  it("refuses INSTANCE_NOT_CURRENT on the card when the PO has no approval linked", async () => {
    const a = await world.pendingPo();
    const stepId = await world.currentStepId(a.instanceId);
    await db.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL WHERE id = $1`, [a.poId]);

    const res = await cardApprove(W.PO_APPROVER, a.instanceId, stepId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 3, code: "INSTANCE_NOT_CURRENT" });
    expect(await instanceStatus(a.instanceId)).toBe("PENDING");
    expect(await approveActions(a.instanceId)).toEqual([]);
    expect((await po(a.poId)).status).toBe("pending_approval");
  });

  it("refuses PO_NOT_PENDING_APPROVAL on both surfaces when the PO left pending_approval", async () => {
    const a = await world.pendingPo();
    const stepId = await world.currentStepId(a.instanceId);
    await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'draft' WHERE id = $1`, [a.poId]);

    const viaPage = await pageApprove(W.PO_APPROVER, a.poId);
    expect(viaPage.status).toBe(409);
    expect(viaPage.body).toMatchObject({ status: 0, code: "PO_NOT_PENDING_APPROVAL" });
    const viaCard = await cardApprove(W.PO_APPROVER, a.instanceId, stepId);
    expect(viaCard.status).toBe(409);
    expect(viaCard.body).toMatchObject({ status: 3, code: "PO_NOT_PENDING_APPROVAL" });

    expect(await instanceStatus(a.instanceId)).toBe("PENDING");
    expect(await approveActions(a.instanceId)).toEqual([]);
    expect((await po(a.poId)).status).toBe("draft");
    expect(await postActionRuns(a.poId)).toBe(0);
  });
});
