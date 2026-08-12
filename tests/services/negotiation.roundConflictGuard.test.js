// The conflict guard that decides whether a buyer may open another negotiation
// round on the same field(s) for the same vendor.
//
// REPORTED DEFECT (RFQ #536326 / id 785, vendor Optima Solutions).
// The buyer created round 1 on `base_price`. It needed approval from three
// people under an ALL rule; two approved, the third never acted. The round sat
// in PENDING_APPROVAL for 24.5 hours — never approved, never published, never
// seen by the vendor — and every attempt to open a replacement round failed
// with:
//
//     "... already has an ACTIVE negotiation round for field(s): base_price.
//      Please select different fields or wait for the existing round to
//      complete."
//
// Both halves of that were wrong. The round was not active, and it could not
// "complete" — it could only be approved or expire. The buyer was told to wait
// for something that would never happen, and the UI offers the creator no way
// to withdraw it.
//
// Two distinct defects are locked in here:
//
//   1. The message did not distinguish PENDING_APPROVAL from ACTIVE.
//   2. The predicate was `(status != 'ACTIVE' OR end_date > NOW())`, so the
//      deadline was only ever tested for ACTIVE rounds. A PENDING_APPROVAL
//      round short-circuited on the first clause and blocked forever. That
//      matters because the closer is a ONE-SHOT IN-MEMORY job: measured across
//      806 closed production rounds, 29 were closed only when the server next
//      restarted (worst: 45 hours late). For those hours the field was blocked
//      with no time-based escape at all.
//
// Also covered: `now() AT TIME ZONE 'UTC'` vs bare `NOW()`. end_date is a naive
// column holding UTC; comparing it against a timestamptz makes Postgres
// reinterpret the naive side in the SESSION timezone. Exact under production's
// UTC session, 5h30m out under a local Asia/Kolkata one — and in the RELEASING
// direction, which is why a stuck block can never be reproduced in dev.

import { describe, it, expect, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import negotiationController from "../../app/controllers/negotiation/negotiationController.js";
import { makeRFQ } from "../factories/rfq.js";

afterAll(async () => {
  await closeDb();
});

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: {
      user: opts.user,
      params: opts.params || {},
      body: opts.body || {},
      query: opts.query || {},
    },
    res,
    next: jest.fn(),
    calls,
  };
}

const inserted = { rfqIds: [] };
beforeEach(() => { inserted.rfqIds = []; });

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  const rounds = await db.any(
    `SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]
  );
  const roundIds = rounds.map((r) => r.id);
  if (roundIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_actions WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[]))`,
      [roundIds]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT s.id FROM tbl_approval_instance_steps s
         JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
         WHERE i.entity_type='NEGOTIATION' AND i.entity_id = ANY($1::int[]))`,
      [roundIds]);
    await db.none(
      `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[]))`,
      [roundIds]);
    await db.none(
      `DELETE FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[])`,
      [roundIds]);
    await db.none(`DELETE FROM tbl_negotiation_round_approvals WHERE negotiation_round_id = ANY($1::int[])`, [roundIds]);
    await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [roundIds]);
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [roundIds]);
  }
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

const futureIso = (offsetMs = 7 * 86400_000) => new Date(Date.now() + offsetMs).toISOString();
const naive = (d) => d.toISOString().replace("T", " ").slice(0, 19);

async function makeBidEndedRfq() {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    tender_publish_date: naive(new Date(Date.now() - 3 * 86400_000)),
    vendor_clarification_date: naive(new Date(Date.now() - 2 * 86400_000)),
    bid_end_date: naive(new Date(Date.now() - 86400_000)),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

async function attachProduct(rfq_id, productVariantId = 1) {
  const { id } = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap,
        product_variant_id, variant)
     VALUES ($1,'','','','','',$2,0) RETURNING id`,
    [rfq_id, productVariantId]);
  return id;
}

async function attachVendor(rfq_id, vendorId, productVariantId = 1) {
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1,$2,$3,0)`,
    [rfq_id, productVariantId, vendorId]);
}

/** Create round 1. Leaves it in PENDING_APPROVAL — the reported state. */
async function createRound(rfq_id, product_id, fields, endIso = futureIso()) {
  const m = mockExpress({
    user: { id: IDS.users.a1_proc_buyer },
    body: {
      rfq_id, rfq_product_id: product_id, end_date: endIso,
      vendor_targets: [{ vendor_id: IDS.users.vendor_alpha, fields }],
    },
  });
  await negotiationController.createRound(m.req, m.res);
  return m.calls;
}

const setRoundDeadline = (roundId, sql) =>
  db.none(`UPDATE tbl_negotiation_rounds SET end_date = ${sql} WHERE id = $1`, [roundId]);

const onlyRound = (rfq_id) =>
  db.one(`SELECT id, status, end_date FROM tbl_negotiation_rounds WHERE rfq_id=$1`, [rfq_id]);

describe("negotiation round conflict guard", () => {
  it("names the real state: a PENDING_APPROVAL round is not called 'active'", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    const first = await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }]);
    expect(first.status).toBe(200);
    expect((await onlyRound(rfq_id)).status).toBe("PENDING_APPROVAL");

    const second = await createRound(rfq_id, product_id, [{ name: "base_price", target: 60000 }]);

    expect(second.status).toBe(400);
    expect(second.body.code).toBe("ROUND_AWAITING_APPROVAL");
    // The two claims that misled the buyer must both be gone.
    expect(second.body.message).not.toMatch(/active negotiation round/i);
    expect(second.body.message).not.toMatch(/wait for the existing round to complete/i);
    // …and it must say what is actually true and what to do about it.
    expect(second.body.message).toMatch(/awaiting internal approval/i);
    expect(second.body.message).toMatch(/has not reached the vendor/i);
    expect(second.body.data.round_status).toBe("PENDING_APPROVAL");
    expect(second.body.data.fields).toEqual(["base_price"]);
  });

  it("a PENDING_APPROVAL round past its deadline no longer blocks", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    const first = await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }]);
    expect(first.status).toBe(200);
    const round = await onlyRound(rfq_id);

    // Simulate the one-shot in-memory closer having missed its window — the
    // state 29 production rounds were left in, some for 45 hours.
    await setRoundDeadline(round.id, `(now() AT TIME ZONE 'UTC') - interval '3 hours'`);
    expect((await onlyRound(rfq_id)).status).toBe("PENDING_APPROVAL");

    const second = await createRound(rfq_id, product_id, [{ name: "base_price", target: 60000 }]);

    // A pending round past its deadline can never go live, so it must not
    // block a replacement. Before the fix this returned 400 forever.
    expect(second.status).toBe(200);
    const rounds = await db.any(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id=$1`, [rfq_id]);
    expect(rounds).toHaveLength(2);
  });

  it("a live round still blocks, and now says when it closes", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);

    const approve = mockExpress({
      user: { id: IDS.users.a1_proc_commApp }, params: { id: String(round.id) }, body: {},
    });
    await negotiationController.approveRound(approve.req, approve.res);
    expect(approve.calls.status).toBe(200);
    expect((await onlyRound(rfq_id)).status).toBe("ACTIVE");

    const second = await createRound(rfq_id, product_id, [{ name: "base_price", target: 60000 }]);
    expect(second.status).toBe(400);
    expect(second.body.code).toBe("ROUND_ACTIVE");
    expect(second.body.message).toMatch(/live negotiation round/i);
    expect(second.body.message).toMatch(/IST/);          // deadline in the buyer's own clock
  });

  it("a different field is still allowed alongside a pending round", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    // Narrowing the guard must not have widened it: non-overlapping fields
    // were always allowed and must stay allowed.
    expect((await createRound(rfq_id, product_id, [{ name: "Freight", target: 8 }])).status).toBe(200);
  });

  it("a round whose deadline has passed can no longer be approved into life", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);
    await setRoundDeadline(round.id, `(now() AT TIME ZONE 'UTC') - interval '3 hours'`);

    const approve = mockExpress({
      user: { id: IDS.users.a1_proc_commApp }, params: { id: String(round.id) }, body: {},
    });
    await negotiationController.approveRound(approve.req, approve.res);

    // Without this, the guard change above would be a hole: a replacement
    // round can now be created, and approving the stale one would put TWO
    // live rounds on the same field.
    expect(approve.calls.status).toBe(400);
    expect(approve.calls.body.message).toMatch(/deadline has already passed/i);
    expect((await onlyRound(rfq_id)).status).toBe("PENDING_APPROVAL");
  });

  // ---- withdraw: the creator's way out of a stuck round -------------------

  async function withdraw(round_id, userId, remarks = "approver is on leave") {
    const m = mockExpress({
      user: { id: userId }, params: { id: String(round_id) }, body: { remarks },
    });
    await negotiationController.withdrawRound(m.req, m.res);
    return m.calls;
  }

  it("the creator can withdraw their own stuck round, and then open a new one", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);

    // Blocked before withdrawing — this is the reported state.
    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 60000 }])).status).toBe(400);

    const res = await withdraw(round.id, IDS.users.a1_proc_buyer);
    expect(res.status).toBe(200);
    expect(res.body.data.withdrawn).toBe(true);

    const after = await db.one(`SELECT status, closed_at FROM tbl_negotiation_rounds WHERE id=$1`, [round.id]);
    expect(after.status).toBe("CANCELLED");
    expect(after.closed_at).not.toBeNull();

    // The approval request must die with it, or the approver keeps an
    // actionable card for a round that no longer exists.
    const instance = await db.oneOrNone(
      `SELECT status FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id=$1`,
      [round.id]);
    if (instance) expect(instance.status).toBe("CANCELLED");

    // The whole point: the buyer is unblocked.
    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 60000 }])).status).toBe(200);
  });

  it("a buyer who did NOT create the round cannot withdraw it", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);

    // Same hotel, same RFQ, genuine round access — and still refused. Round
    // access is not authorship; withdrawing is.
    const res = await withdraw(round.id, IDS.users.a1_proc_commApp);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/only the buyer who created this round/i);
    expect((await onlyRound(rfq_id)).status).toBe("PENDING_APPROVAL");
  });

  it("a live round cannot be withdrawn — the vendor can already see it", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);
    const approve = mockExpress({
      user: { id: IDS.users.a1_proc_commApp }, params: { id: String(round.id) }, body: {},
    });
    await negotiationController.approveRound(approve.req, approve.res);
    expect(approve.calls.status).toBe(200);

    const res = await withdraw(round.id, IDS.users.a1_proc_buyer);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already live with the vendor/i);
    expect((await onlyRound(rfq_id)).status).toBe("ACTIVE");
  });

  it("withdrawing requires a reason", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);

    const res = await withdraw(round.id, IDS.users.a1_proc_buyer, "   ");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/why you are withdrawing/i);
    expect((await onlyRound(rfq_id)).status).toBe("PENDING_APPROVAL");
  });

  // ---- the round-detail action gate that surfaces Withdraw ----------------

  it("offers Withdraw to the author, and to nobody else", async () => {
    // The endpoint alone is not the feature — the button has to appear on a
    // page that exists. My first attempt put it on NegotiationBanner.js, which
    // is imported by nothing; a browser sweep caught that it never rendered.
    // This pins the server-side gate the LIVE round-detail page reads.
    const { deriveActions } = await import(
      "../../app/controllers/negotiation/negotiationRoundDetailController.js");

    const base = {
      state: "awaiting_approval",
      permissions: { read: true, create: true, update: true, approve: false },
      locked: false,
      vendorApprovalSummary: { pending: 1 },
      hasResponses: false,
    };

    const author = deriveActions({ ...base, viewerUserId: 42, createdByUserId: 42 });
    const colleague = deriveActions({ ...base, viewerUserId: 99, createdByUserId: 42 });

    expect(author.can_withdraw).toBe(true);
    expect(colleague.can_withdraw).toBe(false);

    // Withdraw is the author's escape hatch precisely BECAUSE reject is not
    // available to them: `can_reject` needs negotiation.approve, which this
    // author does not hold. 2 of 26 production round-creators are in exactly
    // this position.
    expect(author.can_reject).toBe(false);
    expect(author.can_approve).toBe(false);
  });

  it("does not offer Withdraw once the round is live or already closed", async () => {
    const { deriveActions } = await import(
      "../../app/controllers/negotiation/negotiationRoundDetailController.js");
    const base = {
      permissions: { read: true, approve: true },
      locked: false, vendorApprovalSummary: {}, hasResponses: false,
      viewerUserId: 42, createdByUserId: 42,
    };
    // Live with vendors: pulling it back is a louder action, and the server
    // route refuses it too.
    expect(deriveActions({ ...base, state: "open_with_vendors" }).can_withdraw).toBe(false);
    expect(deriveActions({ ...base, state: "cancelled" }).can_withdraw).toBe(false);
    expect(deriveActions({ ...base, state: "concluded" }).can_withdraw).toBe(false);
  });

  // ---- the sweeper: backstop for the one-shot in-memory closer -----------

  it("the sweeper closes an overdue PENDING round as EXPIRED, not ENDED", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);
    // The one-shot job was lost to a deploy; the deadline came and went.
    await setRoundDeadline(round.id, `(now() AT TIME ZONE 'UTC') - interval '2 hours'`);

    const { runNegotiationRoundClosureSweep } = await import("../../app/helper/cronManager.js");
    await runNegotiationRoundClosureSweep();

    // EXPIRED, because nobody approved it in time — distinct from ENDED, which
    // means a live round ran its course. The two are not interchangeable: only
    // EXPIRED tells the buyer the round never reached the vendor.
    const after = await onlyRound(rfq_id);
    expect(after.status).toBe("EXPIRED");

    // …and the pending approval instance must be cancelled with it, or the
    // approver keeps an actionable card for a round that no longer exists.
    const instance = await db.oneOrNone(
      `SELECT status FROM tbl_approval_instances
        WHERE entity_type='NEGOTIATION' AND entity_id=$1`, [round.id]);
    if (instance) expect(instance.status).toBe("CANCELLED");
  });

  it("the sweeper closes an overdue ACTIVE round as ENDED", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);
    const approve = mockExpress({
      user: { id: IDS.users.a1_proc_commApp }, params: { id: String(round.id) }, body: {},
    });
    await negotiationController.approveRound(approve.req, approve.res);
    expect(approve.calls.status).toBe(200);
    await setRoundDeadline(round.id, `(now() AT TIME ZONE 'UTC') - interval '2 hours'`);

    const { runNegotiationRoundClosureSweep } = await import("../../app/helper/cronManager.js");
    await runNegotiationRoundClosureSweep();

    expect((await onlyRound(rfq_id)).status).toBe("ENDED");
  });

  it("the sweeper leaves a round that still has time alone, and is safe to run twice", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);
    await setRoundDeadline(round.id, `(now() AT TIME ZONE 'UTC') + interval '6 hours'`);

    const { runNegotiationRoundClosureSweep } = await import("../../app/helper/cronManager.js");
    await runNegotiationRoundClosureSweep();
    expect((await onlyRound(rfq_id)).status).toBe("PENDING_APPROVAL");

    // Overdue now — and sweeping twice must not double-close or throw, since
    // the real cron overlaps with the one-shot job it is backing up.
    await setRoundDeadline(round.id, `(now() AT TIME ZONE 'UTC') - interval '1 minute'`);
    await runNegotiationRoundClosureSweep();
    const first = await onlyRound(rfq_id);
    await runNegotiationRoundClosureSweep();
    const second = await onlyRound(rfq_id);
    expect(first.status).toBe("EXPIRED");
    expect(second.status).toBe("EXPIRED");
  });

  it("overlapping sweeps are skipped rather than stacked", async () => {
    // A sweep can outlast its own 5-minute interval — up to 200 rounds, each a
    // transaction plus an email — and cron fires regardless.
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);
    await setRoundDeadline(round.id, `(now() AT TIME ZONE 'UTC') - interval '1 minute'`);

    const { runNegotiationRoundClosureSweep } = await import("../../app/helper/cronManager.js");
    const [a, b, c] = await Promise.all([
      runNegotiationRoundClosureSweep(),
      runNegotiationRoundClosureSweep(),
      runNegotiationRoundClosureSweep(),
    ]);

    expect((await onlyRound(rfq_id)).status).toBe("EXPIRED");
    // One did the work; the others bowed out instead of piling on.
    expect([a, b, c].filter((r) => r?.skipped === true)).toHaveLength(2);

    // Exactly one closure recorded, not three.
    const events = await db.any(
      `SELECT id FROM tbl_lifecycle_history
        WHERE entity_id = $1 AND action = 'NEGOTIATION_ROUND_EXPIRED'`,
      [rfq_id]);
    expect(events).toHaveLength(1);
  });

  it("the status-guarded claim lets exactly one closer win a genuine race", async () => {
    // The in-flight flag only covers sweeps inside ONE process. The one-shot
    // in-memory job, the boot sweep and the sweeper are all separate callers —
    // and across several app instances there is no shared flag at all. What
    // actually makes double-closing impossible is that the transition is
    // CLAIMED: the UPDATE carries the expected status, so the loser writes no
    // rows and returns before emailing or logging.
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);

    const claim = () =>
      db.result(
        `UPDATE tbl_negotiation_rounds
            SET status = 'EXPIRED', closed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'PENDING_APPROVAL'`,
        [round.id]);

    const results = await Promise.all([claim(), claim(), claim()]);
    const winners = results.filter((r) => r.rowCount === 1);
    expect(winners).toHaveLength(1);
    expect((await onlyRound(rfq_id)).status).toBe("EXPIRED");
  });

  it("a LIVE round with 2 hours left still blocks, whatever the session timezone", async () => {
    // The real regression test for the bare-NOW() defect, exercising the real
    // model function rather than a hand-written copy of its SQL.
    //
    // end_date is naive UTC. Bare `NOW()` is a timestamptz, and comparing the
    // two makes Postgres reinterpret the naive side in the SESSION timezone.
    // Under Asia/Kolkata — which is what local Postgres runs, per CLAUDE.md —
    // the right-hand side lands 5h30m ahead, so a round with 2 hours genuinely
    // left reads as 3.5 hours EXPIRED and silently stops blocking.
    //
    // This has to be an ACTIVE round: the old predicate was
    // `(status != 'ACTIVE' OR end_date > NOW())`, so a PENDING round
    // short-circuited past the date entirely and would not show the skew.
    //
    // Under a UTC session (CI, production) both old and new code agree, so
    // this case only bites locally — which is the right way round: the machine
    // a human runs tests on is the one that catches it.
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);
    const approve = mockExpress({
      user: { id: IDS.users.a1_proc_commApp }, params: { id: String(round.id) }, body: {},
    });
    await negotiationController.approveRound(approve.req, approve.res);
    expect(approve.calls.status).toBe(200);

    // Genuinely 2 hours of life left, stated in the column's own frame (UTC).
    await setRoundDeadline(round.id, `(now() AT TIME ZONE 'UTC') + interval '2 hours'`);

    const { default: negotiationModel } = await import("../../app/models/negotiationModel.js");
    const blocking = await negotiationModel.getActiveRoundsByRfqId(rfq_id, false);

    const sessionTz = (await db.one(`SHOW timezone`)).TimeZone;
    expect({ sessionTz, blocking: blocking.length }).toEqual({ sessionTz, blocking: 1 });

    // And the guard built on it must still refuse the overlapping round.
    const second = await createRound(rfq_id, product_id, [{ name: "base_price", target: 60000 }]);
    expect(second.status).toBe(400);
    expect(second.body.code).toBe("ROUND_ACTIVE");
  });
});
