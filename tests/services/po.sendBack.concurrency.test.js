// Two approvers on one ANY step acting at the same moment (client ticket T3).
// ----------------------------------------------------------------------------
// One asks for information while the other approves, or both ask. Exactly one
// wins and the other gets a 409; the database never ends up with a hold on a
// step that moved on, or with two holds.
//
// Every write path takes the PO row lock first, then the approval instance:
// sending back, answering, withdrawing, and the hold check inside approve and
// reject. The orderings below are made deterministic the way
// po.decision.lockOrder does it: a third connection holds the PO row, the
// requests queue behind it in a known order, then the holder lets go. A path
// that skipped the PO lock would not queue, and would win a race it should
// have lost.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const fakeTransport = { sendMail: (opts, cb) => cb(null, { messageId: "<captured>" }) };
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { makeSendBackWorld, S, sendBackRows } = await import("../helpers/poSendBackWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");
const { drainPoSendBackNotifications } = await import("../../app/services/po/poSendBackNotifier.js");

const world = makeSendBackWorld(db);

beforeAll(() => world.setup());
afterEach(async () => {
  await drainPoSendBackNotifications();
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

/**
 * Hold the PO row from a third connection, start `first` and wait until it
 * queues, start `second` and wait until it queues too, then let go.
 */
async function queuedBehindPoLock(poId, first, second) {
  const holder = await db.connect();
  try {
    await holder.none("BEGIN");
    await holder.one(`SELECT id FROM tbl_rfq_purchase_order WHERE id = $1 FOR UPDATE`, [poId]);
    const p1 = Promise.resolve(first()).then((r) => r);
    await waitForLockWaiters(1);
    const p2 = Promise.resolve(second()).then((r) => r);
    await waitForLockWaiters(2);
    await holder.none("COMMIT");
    return await Promise.all([p1, p2]);
  } finally {
    await holder.none("ROLLBACK").catch(() => {});
    holder.done();
  }
}

const askCreator = (who, poId, comment = "Need the photos") =>
  world.sendBack(who, poId, { target_role: "RFQ_CREATOR", reason_category: "EVIDENCE_MISSING", comment });
const count = async (instanceId, action) =>
  (await world.actions(instanceId)).filter((a) => a.action === action).length;

describe("two approvers on one ANY step at once", () => {
  it("send-back and approve by the two ANY approvers at once: exactly one succeeds", async () => {
    // (1) The send-back gets the PO first: the approval is refused, held.
    {
      const a = await world.poAtStep2();
      const [sent, approved] = await queuedBehindPoLock(
        a.poId,
        () => askCreator(S.APPROVER_A, a.poId),
        () => world.approve(S.APPROVER_B, a.poId)
      );
      expect(sent.status).toBe(201);
      expect(approved.status).toBe(409);
      expect(approved.body.code).toBe("PO_ON_HOLD");
      expect(await world.instanceState(a.instanceId)).toEqual({ status: "PENDING", current_step: a.steps.o2 });
      expect(await count(a.instanceId, "APPROVE")).toBe(1); // L1 only
      expect((await sendBackRows(db, a.poId)).map((r) => r.status)).toEqual(["OPEN"]);
    }

    // (2) The approval gets the PO first: the step moves on, and the send-back
    //     is refused because its asker is no longer pending on the current step.
    {
      const a = await world.poAtStep2();
      const [approved, sent] = await queuedBehindPoLock(
        a.poId,
        () => world.approve(S.APPROVER_B, a.poId),
        () => askCreator(S.APPROVER_A, a.poId)
      );
      expect(approved.status).toBe(200);
      expect(sent.status).toBe(409);
      expect(sent.body.code).toBe("STEP_NOT_PENDING");
      expect(await world.instanceState(a.instanceId)).toEqual({ status: "PENDING", current_step: a.steps.o3 });
      expect(await sendBackRows(db, a.poId)).toEqual([]);
      expect(await count(a.instanceId, "SEND_BACK")).toBe(0);
    }

    // (3) No arranged order: whichever wins, exactly one does, and the state
    //     agrees with it.
    {
      const a = await world.poAtStep2();
      const [sent, approved] = await Promise.all([askCreator(S.APPROVER_A, a.poId), world.approve(S.APPROVER_B, a.poId)]);
      const wins = [sent.status === 201, approved.status === 200].filter(Boolean).length;
      expect(wins).toBe(1);
      const state = await world.instanceState(a.instanceId);
      const rows = await sendBackRows(db, a.poId);
      if (sent.status === 201) {
        expect(approved.body.code).toBe("PO_ON_HOLD");
        expect(state.current_step).toBe(a.steps.o2);
        expect(rows.map((r) => r.status)).toEqual(["OPEN"]);
      } else {
        expect(sent.body.code).toBe("STEP_NOT_PENDING");
        expect(state.current_step).toBe(a.steps.o3);
        expect(rows).toEqual([]);
      }
    }
  });

  it("two simultaneous send-backs: one 201, one 409", async () => {
    const a = await world.poAtStep2();
    const [first, second] = await queuedBehindPoLock(
      a.poId,
      () => askCreator(S.APPROVER_A, a.poId, "first"),
      () => askCreator(S.APPROVER_B, a.poId, "second")
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("PO_ON_HOLD");

    const rows = await sendBackRows(db, a.poId);
    expect(rows).toEqual([expect.objectContaining({ status: "OPEN", requested_by: S.APPROVER_A, comment: "first" })]);
    expect(await count(a.instanceId, "SEND_BACK")).toBe(1);

    // Unarranged: still exactly one.
    const b = await world.poAtStep2();
    const results = await Promise.all([askCreator(S.APPROVER_A, b.poId), askCreator(S.APPROVER_B, b.poId)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409).body.code).toBe("PO_ON_HOLD");
    expect((await sendBackRows(db, b.poId)).map((r) => r.status)).toEqual(["OPEN"]);
  });

  it("the one-open index is the backstop: its violation is a 409 PO_ON_HOLD, never a 500", async () => {
    const a = await world.poAtStep2();
    const step = await db.one(`SELECT id, step_order FROM tbl_approval_instance_steps WHERE id = $1`, [a.steps.s2]);

    // A hold written by someone who skipped the PO lock, not yet committed:
    // the request cannot see it, gets past every check, and meets the index.
    //
    // The insert's foreign-key checks would take KEY SHARE on the PO row and
    // the instance, which the request's FOR UPDATE waits on, and then the
    // ordinary hold check would answer instead of the index. Replica mode
    // skips those checks for this one insert (CI and local test users are
    // superusers); the unique index is not a trigger and still applies.
    const holder = await db.connect();
    let res;
    try {
      await holder.none("BEGIN");
      await holder.none("SET LOCAL session_replication_role = replica");
      await holder.none(
        `INSERT INTO tbl_po_send_backs
           (purchase_order_id, rfq_id, approval_instance_id, approval_instance_step_id, step_order,
            route, reason_category, comment, requested_by, target_role, target_user_id)
         VALUES ($1, $2, $3, $4, $5, 'INFO_REQUEST', 'OTHER', 'racing', $6, 'RFQ_CREATOR', $7)`,
        [a.poId, a.rfq.id, a.instanceId, step.id, step.step_order, S.APPROVER_B, S.CREATOR]
      );
      const p = Promise.resolve(askCreator(S.APPROVER_A, a.poId)).then((r) => r);
      await waitForLockWaiters(1);
      await holder.none("COMMIT");
      res = await p;
    } finally {
      await holder.none("ROLLBACK").catch(() => {});
      holder.done();
    }

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PO_ON_HOLD");
    const rows = await sendBackRows(db, a.poId);
    expect(rows).toEqual([expect.objectContaining({ status: "OPEN", requested_by: S.APPROVER_B })]);
    expect(await count(a.instanceId, "SEND_BACK")).toBe(0);
  });
});
