// SECURITY — vendors never act on internal approvals (ruling R25).
// ----------------------------------------------------------------------------
// POST /general/hospitality/approval/action had no role gate. The engine's
// approver check is the real control, but it runs AFTER an early return for a
// concluded instance, so any signed-in caller, a vendor included, could get an
// "already decided" answer for any instance id (and, for a PO, run the PO
// path's work on it). No vendor screen calls this route. It now carries
// noAcl([3]), like its sibling /cancel.
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

const actions = (instanceId) =>
  db.any(`SELECT id FROM tbl_approval_actions WHERE approval_instance_id = $1`, [instanceId]);

describe("POST /general/hospitality/approval/action as a vendor", () => {
  it("is refused 403 for APPROVE and REJECT, on a pending and on a concluded approval", async () => {
    const a = await world.pendingPo();
    const stepId = await world.currentStepId(a.instanceId);
    const vendor = await world.client(W.VENDOR_A);

    for (const action of ["APPROVE", "REJECT"]) {
      const res = await vendor.post(`/api/v1/general/hospitality/approval/action`).send({
        approval_instance_id: a.instanceId, approval_instance_step_id: stepId, action, comment: "x",
      });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ message: "Access denied for this role" });
    }
    expect(await actions(a.instanceId)).toEqual([]);

    // Concluded: the engine's early "already decided" answer is not reachable either.
    expect((await world.approveOnPoPage(a.poId)).status).toBe(200);
    const late = await vendor.post(`/api/v1/general/hospitality/approval/action`).send({
      approval_instance_id: a.instanceId, action: "APPROVE",
    });
    expect(late.status).toBe(403);
    expect(late.body).toEqual({ message: "Access denied for this role" });
  });

  it("still lets the buyer approver act", async () => {
    const a = await world.pendingPo();
    const res = await (await world.client(W.PO_APPROVER)).post(`/api/v1/general/hospitality/approval/action`).send({
      approval_instance_id: a.instanceId,
      approval_instance_step_id: await world.currentStepId(a.instanceId),
      action: "APPROVE",
      comment: "ok",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.instance_status).toBe("APPROVED");
  });
});
