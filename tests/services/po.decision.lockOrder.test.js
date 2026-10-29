// Every PO decision takes its locks in the one order: PO row, then approval
// instance (client ticket T3, global constraint "lock order").
// ----------------------------------------------------------------------------
// Editing a pending PO (PUT /po/:po_id) locks the PO row and then the PENDING
// approval instance it cancels and re-initiates. A decision that locked the
// instance first and touched the PO row afterwards — which is what both
// decision surfaces did — deadlocks against it: each holds the lock the other
// needs, and Postgres kills one of them with 40P01.
//
// Deterministic, no timing races: a third connection holds the instance lock;
// the decision is sent and parks on it; the edit is sent and parks too; then
// the holder lets go. Whatever order the decision takes its locks in decides
// whether the two requests finish or deadlock.
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

/** Waits until `n` backends of this database are blocked on a lock. */
async function waitForLockWaiters(n, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { waiting } = await db.one(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`);
    if (waiting >= n) return;
    if (Date.now() > deadline) throw new Error(`expected ${n} lock waiter(s), saw ${waiting}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const SURFACES = {
  "the PO page": (poId, instanceId, decision) =>
    decision === "APPROVE"
      ? world.approveOnPoPage(poId)
      : world.rejectOnPoPage(poId, { remarks: "race", reason_category: "PRICE_TAX_QUERY" }),
  "the approval card": async (poId, instanceId, decision) =>
    decision === "APPROVE"
      ? (await world.client(W.PO_APPROVER)).post(`/api/v1/general/hospitality/approval/action`).send({
          approval_instance_id: instanceId,
          approval_instance_step_id: await world.currentStepId(instanceId),
          action: "APPROVE",
          comment: "race",
        })
      : world.rejectOnApprovalCard(instanceId, { remarks: "race", reason_category: "PRICE_TAX_QUERY" }),
};

describe("PO decisions lock the PO row before the approval instance", () => {
  for (const [surface, decide] of Object.entries(SURFACES)) {
    for (const decision of ["APPROVE", "REJECT"]) {
      it(`${decision} on ${surface} racing an edit of the same PO: neither deadlocks`, async () => {
        const a = await world.pendingPo();
        // The edit is made by the PO's creator; give that role to a buyer who
        // can read the PO (the award-approval raiser cannot).
        await db.none(`UPDATE tbl_rfq_purchase_order SET initiated_by = $2 WHERE id = $1`, [a.poId, W.INITIATOR]);
        const editor = await world.client(W.INITIATOR);
        // Resolve before the race so the decision request does no extra reads.
        const stepId = await world.currentStepId(a.instanceId);
        expect(stepId).toBeTruthy();

        const holder = await db.connect();
        let decisionRes;
        let editRes;
        try {
          await holder.none("BEGIN");
          await holder.one(`SELECT id FROM tbl_approval_instances WHERE id = $1 FOR UPDATE`, [a.instanceId]);

          const decisionP = Promise.resolve(decide(a.poId, a.instanceId, decision)).then((r) => r);
          await waitForLockWaiters(1);
          const editP = editor
            .put(`/api/v1/po/${a.poId}`)
            .send({ changes: [{ path: "terms_and_conditions", newValue: "Delivery within 7 days" }] })
            .then((r) => r);
          await waitForLockWaiters(2);

          await holder.none("COMMIT");
          [decisionRes, editRes] = await Promise.all([decisionP, editP]);
        } finally {
          await holder.none("ROLLBACK").catch(() => {});
          holder.done();
        }

        for (const res of [decisionRes, editRes]) {
          expect(JSON.stringify(res.body)).not.toMatch(/deadlock|40P01/i);
        }
        expect(decisionRes.status).toBe(200);
        expect(decisionRes.body.status).toBe(1);
        const inst = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [a.instanceId]);
        expect(inst.status).toBe(decision === "APPROVE" ? "APPROVED" : "REJECTED");
      });
    }
  }
});
