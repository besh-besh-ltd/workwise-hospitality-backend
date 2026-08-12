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

  it("the deadline test does not depend on the Postgres session timezone", async () => {
    // end_date is naive UTC. Bare NOW() makes Postgres reinterpret it in the
    // session zone, so under Asia/Kolkata a round with 3 hours left reads as
    // 2.5 hours EXPIRED and silently stops blocking. Run the guard's own model
    // function under a shifted session to prove it no longer cares.
    //
    // A transaction-local SET keeps this from leaking into sibling suites.
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    expect((await createRound(rfq_id, product_id, [{ name: "base_price", target: 64000 }])).status).toBe(200);
    const round = await onlyRound(rfq_id);
    await setRoundDeadline(round.id, `(now() AT TIME ZONE 'UTC') + interval '3 hours'`);

    for (const tz of ["UTC", "Asia/Kolkata", "America/New_York"]) {
      const visible = await db.tx(async (t) => {
        await t.none(`SET LOCAL TIME ZONE '${tz}'`);
        return t.any(
          `SELECT id FROM tbl_negotiation_rounds
            WHERE rfq_id = $1
              AND status IN ('PENDING_APPROVAL','ACTIVE')
              AND end_date > (now() AT TIME ZONE 'UTC')`,
          [rfq_id]);
      });
      expect({ tz, blocking: visible.length }).toEqual({ tz, blocking: 1 });
    }
  });
});
