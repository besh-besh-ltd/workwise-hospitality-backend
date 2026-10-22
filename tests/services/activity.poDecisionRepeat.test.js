// A repeated PO decision that ran nothing writes no second activity row (R26).
// ----------------------------------------------------------------------------
// An approver's double-click on a PO they already decided answers 200 with
// nothing recorded (poApprovalService). The activity capture records every
// response under 400, so each repeat used to add another "approved" or
// "rejected" line to the trail for a decision that happened once.
//
// The PO decision service now marks those answers `data.no_op: true`, and the
// capture skips on that flag alone. It does NOT skip on `already_completed`:
// for non-PO approvals the engine sets that flag while the post-action and
// the initiator's notification still re-run, and the row is the record of who
// re-triggered them. The control below pins that.
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
const extraInstances = [];

beforeAll(() => world.setup());
afterEach(async () => {
  await drainPoRejectedNotifications();
  if (extraInstances.length) {
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [extraInstances.splice(0)]);
  }
  await world.cleanup();
});
afterAll(async () => {
  await world.teardown();
  await closeDb();
});

// The capture runs on the response's `finish` event, just after the client has
// its answer; let it land before counting.
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

/** PO page decision rows for this PO since `since`. */
async function poPageRows(since, poId) {
  await settle();
  return db.any(
    `SELECT summary FROM tbl_activity_events
      WHERE occurred_at >= $1 AND source = 'HTTP' AND event_key = 'po_approval_decided'
        AND entity_type = 'PO' AND entity_id = $2
      ORDER BY id`,
    [since, poId]
  );
}

/** Approval-card decision rows by this actor since `since`. */
async function cardRows(since, actorId) {
  await settle();
  return db.any(
    `SELECT summary FROM tbl_activity_events
      WHERE occurred_at >= $1 AND source = 'HTTP' AND event_key = 'approval_decided' AND actor_user_id = $2
      ORDER BY id`,
    [since, actorId]
  );
}

const cardDecide = async (instanceId, action, stepId = null) =>
  (await world.client(W.PO_APPROVER)).post(`/api/v1/general/hospitality/approval/action`).send({
    approval_instance_id: instanceId,
    ...(stepId ? { approval_instance_step_id: stepId } : {}),
    action,
    comment: "ok",
  });

describe("a repeated PO decision leaves one activity row", () => {
  it("PO page: a same-user double-click on Approve", async () => {
    const a = await world.pendingPo();
    const since = new Date();

    const first = await world.approveOnPoPage(a.poId);
    const again = await world.approveOnPoPage(a.poId);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);

    const rows = await poPageRows(since, a.poId);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toMatch(/approved purchase order/i);
    expect(first.body.data.no_op).toBe(false);
    expect(again.body.data).toMatchObject({ already_completed: true, no_op: true });
  });

  it("approval card: a same-user double-click on Approve for a PO approval", async () => {
    const a = await world.pendingPo();
    const stepId = await world.currentStepId(a.instanceId);
    const since = new Date();

    const first = await cardDecide(a.instanceId, "APPROVE", stepId);
    const again = await cardDecide(a.instanceId, "APPROVE", stepId);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);

    expect(await cardRows(since, W.PO_APPROVER)).toHaveLength(1);
    expect(first.body.data.no_op).toBeUndefined();
    expect(again.body.data).toMatchObject({ instance_status: "APPROVED", already_completed: true, no_op: true });
  });

  it("PO page: a same-user repeat of a rejection", async () => {
    const a = await world.pendingPo();
    const since = new Date();

    const first = await world.rejectOnPoPage(a.poId, { remarks: "GST wrong", reason_category: "PRICE_TAX_QUERY" });
    const again = await world.rejectOnPoPage(a.poId, { remarks: "GST wrong", reason_category: "PRICE_TAX_QUERY" });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);

    const rows = await poPageRows(since, a.poId);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toMatch(/rejected purchase order/i);
    expect(first.body.data.no_op).toBe(false);
    expect(again.body.data).toMatchObject({ already_completed: true, no_op: true });
  });
});

describe("control: a non-PO `already_completed` repeat is still recorded", () => {
  it("writes a row for every repeat on the approval card", async () => {
    // The cheapest concluded non-PO approval: an INDENT instance, which has no
    // post-action handler, initiated by the caller (so no notification goes
    // out either). The engine answers `already_completed` before any approver
    // check, exactly as it does for an RFQ or MR approval whose handler re-runs.
    const a = await world.pendingPo();
    const indent = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          hospitality_company_id, hotel_id, department_id, initiated_by)
       SELECT 'INDENT', 0, approval_policy_id, 'APPROVED', 1,
              hospitality_company_id, hotel_id, department_id, $2
         FROM tbl_approval_instances WHERE id = $1
       RETURNING id`,
      [a.instanceId, W.PO_APPROVER]
    );
    extraInstances.push(indent.id);
    const since = new Date();

    const first = await cardDecide(indent.id, "APPROVE");
    const again = await cardDecide(indent.id, "APPROVE");
    for (const res of [first, again]) {
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ instance_status: "APPROVED", already_completed: true });
      expect(res.body.data.no_op).toBeUndefined();
    }

    expect(await cardRows(since, W.PO_APPROVER)).toHaveLength(2);
  });
});
