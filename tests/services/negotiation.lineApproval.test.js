// negotiation.lineApproval.test.js — approving a negotiation round LINE BY
// LINE instead of all-or-nothing.
//
// THE PROBLEM
//
// A round's approval is one yes/no for the whole round, but a round covers
// many line items: in production 22 NEGOTIATION approvals each decided between
// 2 and 18 line items with a single verdict, and NO round has ever had a
// heterogeneous outcome — all 985 rounds with a populated vendor_approvals[]
// carry exactly one distinct status. An approver who is happy with four of
// five targets has to reject the round and have the whole thing rebuilt.
//
// Note there are TWO approval gates in this module and only one of them is
// this one:
//   NEGOTIATION       entity_id = tbl_negotiation_rounds.id  — the PUBLISH gate
//   NEGOTIATION_QUOTE entity_id = tbl_rfq_products.id        — the AWARD gate,
//                                                              already per-line
// This suite is about the publish gate. Client feedback item 8.
//
// SEMANTICS UNDER TEST — partial publish:
//   approved lines go live to the vendors; rejected lines are withheld and can
//   be re-opened by a later round. The round's own status stays binary, so
//   activateNegotiationRoundInTx keeps its `WHERE status = 'PENDING_APPROVAL'`
//   idempotency claim untouched.
//
// Assertions are OBSERVABLE OUTCOMES only — round row state, the products
// JSONB, HTTP status, and which vendor invitation payloads were produced.

import {
  describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

// ── Email capture ───────────────────────────────────────────────────────────
// The activation notifications are fire-and-forget; we capture the payloads
// rather than the transport so we can assert WHO would have been told.
const emailCalls = { vendor: [], approved: [], created: [] };

jest.unstable_mockModule(
  "../../app/helper/sendEmailFunctions/negotiationEmails.js",
  () => ({
    sendNegotiationExpiredNotification: async () => {},
    sendNegotiationRoundEndedNotification: async () => {},
    sendNegotiationRoundCreatedNotification: async (args) => { emailCalls.created.push(args); },
    sendNegotiationRoundVendorNotification: async (args) => { emailCalls.vendor.push(args); },
    sendNegotiationRoundApprovedNotification: async (args) => { emailCalls.approved.push(args); },
  })
);

const { httpClient } = await import("../helpers/http.js");
const negotiationController = (
  await import("../../app/controllers/negotiation/negotiationController.js")
).default;

// ── Actors ──────────────────────────────────────────────────────────────────
const BUYER = IDS.users.a1_proc_buyer;      // round creator (no negotiation.read)
const APPROVER = IDS.users.a1_proc_commApp;  // COMM_APPROVER — sole A1/P1 NEGOTIATION approver
// Step 2 on the multi-step policy. Must be a role that carries negotiation.read,
// because the tenant guard on the dedicated endpoints is the negotiation read
// matrix — an approver without that permission can only act through the generic
// approval endpoint. COMM_NEGO_N1 (role 8) carries it; TENDER_APPROVER does not.
const SECOND_APPROVER = IDS.users.a1_proc_commEval;
const OUTSIDER = IDS.users.companyB_admin;   // Hospitality B — must never touch an A1 round
const VENDOR = IDS.users.vendor_alpha;
const VARIANT_ID = 1;

const created = {
  rfqIds: [],
  roundIds: [],
  processIds: [],
  policyIds: [],
};

let approverClient, secondApproverClient, outsiderClient;

// ── Small utilities ─────────────────────────────────────────────────────────
const futureIso = (offsetMs = 7 * 86400_000) => new Date(Date.now() + offsetMs).toISOString();
const pastSqlTs = (offsetMs = 86400_000) =>
  new Date(Date.now() - offsetMs).toISOString().replace("T", " ").slice(0, 19);

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: { user: opts.user, params: opts.params || {}, body: opts.body || {}, query: opts.query || {} },
    res,
    calls,
  };
}

/** Poll until `predicate()` is truthy or the budget runs out. */
async function waitFor(predicate, { timeoutMs = 8000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const roundRow = (roundId) =>
  db.one(`SELECT * FROM tbl_negotiation_rounds WHERE id = $1`, [roundId]);

const vendorStatuses = async (roundId) => {
  const row = await roundRow(roundId);
  return (row.vendor_approvals || []).map((v) => v.status);
};

/**
 * Seed the exact live state the traps need: a bid-ended RFQ with one product,
 * one eligible vendor, and a negotiation round sitting in PENDING_APPROVAL
 * behind a real NEGOTIATION approval instance. The round is created through
 * the production controller, not hand-rolled SQL.
 */
async function seedRoundPendingApproval({ process = IDS.processes.A_P1, label = "neg-activation" } = {}) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: BUYER,
    status: 1,
    is_published: 1,
    tender_publish_date: pastSqlTs(3 * 86400_000),
    vendor_clarification_date: pastSqlTs(2 * 86400_000),
    bid_end_date: pastSqlTs(), // bid window CLOSED → negotiation allowed
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process,
    title: label,
  });
  created.rfqIds.push(Number(rfq_id));

  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
    [rfq_id, VARIANT_ID]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, VARIANT_ID, VENDOR]
  );

  const m = mockExpress({
    user: { id: BUYER },
    body: {
      rfq_id,
      rfq_product_id: product.id,
      end_date: futureIso(),
      vendor_targets: [{ vendor_id: VENDOR, fields: [{ name: "base_price", target: "90" }] }],
    },
  });
  await negotiationController.createRound(m.req, m.res);
  expect(m.calls.status).toBe(200);

  const round = await db.one(
    `SELECT * FROM tbl_negotiation_rounds WHERE rfq_id = $1 ORDER BY id DESC LIMIT 1`,
    [rfq_id]
  );
  created.roundIds.push(Number(round.id));
  // The buyer initiated and the approver is somebody else — nothing auto-approves.
  expect(round.status).toBe("PENDING_APPROVAL");

  const instance = await db.one(
    `SELECT * FROM tbl_approval_instances
      WHERE entity_type = 'NEGOTIATION' AND entity_id = $1 AND status = 'PENDING'`,
    [round.id]
  );

  return {
    rfqId: Number(rfq_id),
    rfqProductId: Number(product.id),
    roundId: Number(round.id),
    instanceId: Number(instance.id),
  };
}

/** A NEGOTIATION policy with two ALL steps, so step 1 leaves the instance PENDING. */
async function seedMultiStepNegotiationPolicy() {
  const proc = await db.one(
    `INSERT INTO tbl_approval_processes
       (company_id, name, description, is_active, created_by, process_type)
     VALUES ($1, 'Neg-Activation Two-Step', '', true, $2, 'RFQ') RETURNING id`,
    [IDS.companies.A, IDS.users.companyA_admin]
  );
  created.processIds.push(Number(proc.id));

  const policy = await db.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped, version)
     VALUES ('NEGOTIATION', $1, $2, NULL, true, $3, $4, false, false, 1) RETURNING id`,
    [IDS.hospitality.A, IDS.hotels.A1, IDS.users.companyA_admin, proc.id]
  );
  created.policyIds.push(Number(policy.id));

  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ALL', 'USER', $2), ($1, 2, 'ALL', 'USER', $3)`,
    [policy.id, APPROVER, SECOND_APPROVER]
  );

  return Number(proc.id);
}


describe("Negotiation round approval — line by line", () => {
  beforeAll(async () => {
    await db.none(
      `UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`,
      [[BUYER, APPROVER, SECOND_APPROVER, OUTSIDER]]
    );
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
    approverClient = await httpClient(APPROVER);
    secondApproverClient = await httpClient(SECOND_APPROVER);
    outsiderClient = await httpClient(OUTSIDER);
  });

  afterAll(async () => {
    if (created.roundIds.length) {
      await db.none(`DELETE FROM tbl_approval_instances WHERE entity_type = 'NEGOTIATION' AND entity_id = ANY($1::int[])`, [created.roundIds]);
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [created.roundIds]);
    }
    if (created.rfqIds.length) {
      await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqIds]);
    }
    if (created.policyIds.length) {
      await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [created.policyIds]);
      await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [created.policyIds]);
    }
    if (created.processIds.length) {
      await db.none(`DELETE FROM tbl_approval_processes WHERE id = ANY($1::int[])`, [created.processIds]);
    }
  });

  beforeEach(() => {
    emailCalls.vendor.length = 0;
    emailCalls.approved.length = 0;
    emailCalls.created.length = 0;
  });

  /** A PENDING_APPROVAL round covering TWO products for one vendor. */
  async function seedTwoLineRound(label = "neg-line-approval") {
    const { rfq_id } = await makeRFQ(db, {
      createdBy: BUYER,
      status: 1,
      is_published: 1,
      tender_publish_date: pastSqlTs(3 * 86400_000),
      vendor_clarification_date: pastSqlTs(2 * 86400_000),
      bid_end_date: pastSqlTs(),
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      process: IDS.processes.A_P1,
      title: label,
    });
    created.rfqIds.push(Number(rfq_id));

    const products = [];
    for (const variant of [VARIANT_ID, 2]) {
      const p = await db.one(
        `INSERT INTO tbl_rfq_products
           (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
         VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
        [rfq_id, variant]
      );
      await db.none(
        `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
         VALUES ($1, $2, $3, 0)`,
        [rfq_id, variant, VENDOR]
      );
      products.push(Number(p.id));
    }

    const m = mockExpress({
      user: { id: BUYER },
      body: {
        rfq_id,
        end_date: futureIso(),
        products: products.map((pid, i) => ({
          rfq_product_id: pid,
          vendor_targets: [{ vendor_id: VENDOR, fields: [{ name: "base_price", target: String(90 + i) }] }],
        })),
      },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const round = await db.one(
      `SELECT * FROM tbl_negotiation_rounds WHERE rfq_id = $1 ORDER BY id DESC LIMIT 1`,
      [rfq_id]
    );
    created.roundIds.push(Number(round.id));
    expect(round.status).toBe("PENDING_APPROVAL");

    return { rfqId: Number(rfq_id), roundId: Number(round.id), lineA: products[0], lineB: products[1] };
  }

  const lineVerdict = (row, rfqProductId) => {
    const entry = (row.products || []).find((p) => Number(p.rfq_product_id) === Number(rfqProductId));
    return entry?.vendor_targets?.[0]?.approval?.status ?? null;
  };

  const approve = (roundId, body) =>
    approverClient.post(`/api/v1/negotiation/rounds/${roundId}/approve`).send(body);

  // The activation notifications are fire-and-forget: a previous test's invite
  // can land after beforeEach clears the buffer, so never index by position.
  const inviteFor = (roundId) =>
    emailCalls.vendor.find((c) => Number(c?.round?.id) === Number(roundId)) || null;

  // ── back-compat ───────────────────────────────────────────────────────────

  test("approving with no line decisions still approves the whole round", async () => {
    // Every existing caller sends only { remarks }. That must keep working, or
    // the generic approval queue and the deployed frontend both break.
    const { roundId, lineA, lineB } = await seedTwoLineRound("neg-line-backcompat");

    const res = await approve(roundId, { remarks: "all good" });
    expect(res.status).toBe(200);

    const row = await roundRow(roundId);
    expect(row.status).toBe("ACTIVE");
    expect(lineVerdict(row, lineA)).not.toBe("REJECTED");
    expect(lineVerdict(row, lineB)).not.toBe("REJECTED");
  });

  // ── partial publish ───────────────────────────────────────────────────────

  test("one line can be rejected while the rest of the round goes live", async () => {
    const { roundId, lineA, lineB } = await seedTwoLineRound("neg-line-partial");

    const res = await approve(roundId, {
      remarks: "second target is unrealistic",
      lines: [
        { rfq_product_id: lineA, vendor_id: VENDOR, decision: "APPROVED" },
        { rfq_product_id: lineB, vendor_id: VENDOR, decision: "REJECTED", remarks: "target below cost" },
      ],
    });
    expect(res.status).toBe(200);

    const row = await roundRow(roundId);
    expect(row.status).toBe("ACTIVE");
    expect(lineVerdict(row, lineA)).toBe("APPROVED");
    expect(lineVerdict(row, lineB)).toBe("REJECTED");
  });

  test("the rejected line records who rejected it and why", async () => {
    const { roundId, lineA, lineB } = await seedTwoLineRound("neg-line-audit");

    await approve(roundId, {
      lines: [
        { rfq_product_id: lineA, vendor_id: VENDOR, decision: "APPROVED" },
        { rfq_product_id: lineB, vendor_id: VENDOR, decision: "REJECTED", remarks: "target below cost" },
      ],
    });

    const row = await roundRow(roundId);
    const entry = (row.products || []).find((p) => Number(p.rfq_product_id) === Number(lineB));
    const approval = entry.vendor_targets[0].approval;
    expect(approval.remarks).toBe("target below cost");
    expect(Number(approval.acted_by)).toBe(APPROVER);
    expect(approval.acted_at).toBeTruthy();
  });

  test("a rejected line is withheld from the vendor's invitation", async () => {
    // The whole point of partial publish: the vendor is asked to re-quote the
    // approved line and is never shown the rejected target.
    const { roundId, lineA, lineB } = await seedTwoLineRound("neg-line-email");

    await approve(roundId, {
      lines: [
        { rfq_product_id: lineA, vendor_id: VENDOR, decision: "APPROVED" },
        { rfq_product_id: lineB, vendor_id: VENDOR, decision: "REJECTED" },
      ],
    });

    const invite = await waitFor(() => inviteFor(roundId));
    expect(invite).toBeTruthy();
    const vendorEntry = (invite.vendors || []).find((v) => Number(v.id) === VENDOR);
    const productIds = (vendorEntry?.products || []).map((p) => Number(p.rfq_product_id));

    expect(productIds).toContain(lineA);
    expect(productIds).not.toContain(lineB);
  });

  test("rejecting every line is refused — that is a rejection, not a partial publish", async () => {
    // Publishing a round with nothing in it would invite the vendor to answer
    // an empty negotiation.
    const { roundId, lineA, lineB } = await seedTwoLineRound("neg-line-all-rejected");

    const res = await approve(roundId, {
      lines: [
        { rfq_product_id: lineA, vendor_id: VENDOR, decision: "REJECTED" },
        { rfq_product_id: lineB, vendor_id: VENDOR, decision: "REJECTED" },
      ],
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const row = await roundRow(roundId);
    expect(row.status).toBe("PENDING_APPROVAL");
    expect(inviteFor(roundId)).toBeNull();
  });

  test("a line the approver said nothing about is treated as approved", async () => {
    // Silence is not rejection: an approver who rejects one line has approved
    // the round, and the untouched lines ride with it.
    const { roundId, lineA, lineB } = await seedTwoLineRound("neg-line-silence");

    const res = await approve(roundId, {
      lines: [{ rfq_product_id: lineB, vendor_id: VENDOR, decision: "REJECTED" }],
    });
    expect(res.status).toBe(200);

    const row = await roundRow(roundId);
    expect(lineVerdict(row, lineA)).not.toBe("REJECTED");
    expect(lineVerdict(row, lineB)).toBe("REJECTED");
  });

  test("a line decision naming a product that is not on the round is refused", async () => {
    const { roundId, lineA } = await seedTwoLineRound("neg-line-foreign");

    const res = await approve(roundId, {
      lines: [
        { rfq_product_id: lineA, vendor_id: VENDOR, decision: "APPROVED" },
        { rfq_product_id: 99999999, vendor_id: VENDOR, decision: "REJECTED" },
      ],
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const row = await roundRow(roundId);
    expect(row.status).toBe("PENDING_APPROVAL");
  });

  test("the round still activates exactly once when the click is repeated", async () => {
    // The idempotency claim on activateNegotiationRoundInTx must survive the
    // per-line write that now happens just before it.
    const { roundId, lineA, lineB } = await seedTwoLineRound("neg-line-idempotent");
    const lines = [
      { rfq_product_id: lineA, vendor_id: VENDOR, decision: "APPROVED" },
      { rfq_product_id: lineB, vendor_id: VENDOR, decision: "REJECTED" },
    ];

    await approve(roundId, { lines });
    const second = await approve(roundId, { lines });

    expect(second.status).toBeGreaterThanOrEqual(400); // no longer pending
    await waitFor(() => inviteFor(roundId));
    expect(emailCalls.vendor.filter((c) => Number(c?.round?.id) === roundId)).toHaveLength(1);

    const row = await roundRow(roundId);
    expect(lineVerdict(row, lineB)).toBe("REJECTED");
  });

  test("an out-of-scope caller cannot record a line verdict", async () => {
    const { roundId, lineA } = await seedTwoLineRound("neg-line-scope");

    const res = await outsiderClient
      .post(`/api/v1/negotiation/rounds/${roundId}/approve`)
      .send({ lines: [{ rfq_product_id: lineA, vendor_id: VENDOR, decision: "REJECTED" }] });

    expect(res.status).toBe(403);
    const row = await roundRow(roundId);
    expect(row.status).toBe("PENDING_APPROVAL");
    expect(lineVerdict(row, lineA)).toBeNull();
  });

  test("a rejected line can be re-opened by a new round", async () => {
    // The conflict guard blocks a new round on a (vendor, product, field) that
    // an active round already covers. A line the approver REFUSED to publish is
    // not covered by anything, so it must not be blocked — otherwise rejecting
    // a line strands it forever.
    const { rfqId, roundId, lineA, lineB } = await seedTwoLineRound("neg-line-reopen");

    await approve(roundId, {
      lines: [
        { rfq_product_id: lineA, vendor_id: VENDOR, decision: "APPROVED" },
        { rfq_product_id: lineB, vendor_id: VENDOR, decision: "REJECTED" },
      ],
    });

    const m = mockExpress({
      user: { id: BUYER },
      body: {
        rfq_id: rfqId,
        end_date: futureIso(),
        products: [
          { rfq_product_id: lineB, vendor_targets: [{ vendor_id: VENDOR, fields: [{ name: "base_price", target: "85" }] }] },
        ],
      },
    });
    await negotiationController.createRound(m.req, m.res);

    expect(m.calls.status).toBe(200);
    created.roundIds.push(Number((await db.one(
      `SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = $1 ORDER BY id DESC LIMIT 1`, [rfqId])).id));
  });

  test("the line that WAS published still blocks a duplicate round", async () => {
    // The other half of the same rule: partial publish must not become a hole
    // in the conflict guard.
    const { rfqId, roundId, lineA, lineB } = await seedTwoLineRound("neg-line-reopen-guard");

    await approve(roundId, {
      lines: [
        { rfq_product_id: lineA, vendor_id: VENDOR, decision: "APPROVED" },
        { rfq_product_id: lineB, vendor_id: VENDOR, decision: "REJECTED" },
      ],
    });

    const m = mockExpress({
      user: { id: BUYER },
      body: {
        rfq_id: rfqId,
        end_date: futureIso(),
        products: [
          { rfq_product_id: lineA, vendor_targets: [{ vendor_id: VENDOR, fields: [{ name: "base_price", target: "85" }] }] },
        ],
      },
    });
    await negotiationController.createRound(m.req, m.res);

    expect(m.calls.status).toBeGreaterThanOrEqual(400);
  });
});
