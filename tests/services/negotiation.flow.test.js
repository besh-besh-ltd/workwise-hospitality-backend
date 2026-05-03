// Wave-1 step-3.11 tests: negotiation round creation gates + approval flow.
//
// Surface tested via production controllers:
//   - negotiationController.createRound      (POST /negotiation/rounds)
//   - negotiationController.approveRound     (POST /negotiation/rounds/:id/approve)
//   - negotiationController.rejectRound      (POST /negotiation/rounds/:id/reject)
//
// Per CONVENTIONS.md: every test calls the production controller; no SQL
// duplication. Setup raw INSERTs only for prerequisite state.
//
// Architectural rules locked in:
//   - createRound rejects when no NEGOTIATION policy exists for the
//     (process, hotel, dept) scope (no cross-process fall-through).
//   - createRound blocks if the bid window hasn't ended (quote visibility
//     locked rule, IST-based).
//   - Vendor must be on tbl_rfq_product_vendors for the product to be
//     eligible.

import {
  describe, it, expect, afterAll, beforeEach, afterEach, jest,
} from "@jest/globals";
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

const inserted = { rfqIds: [], extraProcessIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.extraProcessIds = [];
});

afterEach(async () => {
  if (inserted.rfqIds.length) {
    // Negotiation rounds → cancel their NEGOTIATION approval instances first.
    const roundIds = (
      await db.any(
        `SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`,
        [inserted.rfqIds]
      )
    ).map((r) => r.id);

    if (roundIds.length) {
      await db.none(
        `DELETE FROM tbl_approval_actions
         WHERE approval_instance_id IN (
           SELECT id FROM tbl_approval_instances
           WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[])
         )`,
        [roundIds]
      );
      await db.none(
        `DELETE FROM tbl_approval_step_approvers
         WHERE approval_instance_step_id IN (
           SELECT s.id FROM tbl_approval_instance_steps s
           JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
           WHERE i.entity_type='NEGOTIATION' AND i.entity_id = ANY($1::int[])
         )`,
        [roundIds]
      );
      await db.none(
        `DELETE FROM tbl_approval_instance_steps
         WHERE approval_instance_id IN (
           SELECT id FROM tbl_approval_instances
           WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[])
         )`,
        [roundIds]
      );
      await db.none(
        `DELETE FROM tbl_approval_instances
         WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[])`,
        [roundIds]
      );
      await db.none(
        `DELETE FROM tbl_negotiation_round_approvals WHERE negotiation_round_id = ANY($1::int[])`,
        [roundIds]
      );
      await db.none(
        `DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`,
        [roundIds]
      );
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [roundIds]);
    }
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  if (inserted.extraProcessIds.length) {
    await db.none(`DELETE FROM tbl_approval_processes WHERE id = ANY($1::int[])`, [
      inserted.extraProcessIds,
    ]);
  }
});

// ---- Setup helpers ---------------------------------------------------------

async function makeBidEndedRfq(overrides = {}) {
  // bid_end_date in the past so quoteVisibility is UNLOCKED — required for
  // negotiation rounds to be allowed.
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const threeDaysAgo = new Date(Date.now() - 3 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    tender_publish_date: threeDaysAgo,
    vendor_clarification_date: twoDaysAgo,
    bid_end_date: oneDayAgo, // bid window CLOSED
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
    ...overrides,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

async function makeRfqProduct(rfq_id, productVariantId = 1) {
  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0)
     RETURNING id`,
    [rfq_id, productVariantId]
  );
  return product.id;
}

async function attachVendor(rfq_id, vendorId, productVariantId = 1) {
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, productVariantId, vendorId]
  );
}

const futureIso = (offsetMs = 7 * 86400_000) =>
  new Date(Date.now() + offsetMs).toISOString();

// ===========================================================================
//  createRound — input + state gates
// ===========================================================================

describe("createRound — input validation", () => {
  it("rejects when rfq_id is missing", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_product_id: 1, end_date: futureIso(), vendor_targets: [{ vendor_id: 1 }] },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/rfq_id.*required/i);
  });

  it("rejects when rfq_product_id is missing", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id: 1, end_date: futureIso(), vendor_targets: [{ vendor_id: 1 }] },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });

  it("rejects when end_date is missing", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id: 1, rfq_product_id: 1, vendor_targets: [{ vendor_id: 1 }] },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });

  it("rejects when vendor_targets is missing", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id: 1, rfq_product_id: 1, end_date: futureIso() },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/vendor_targets.*non-empty/i);
  });

  it("rejects when vendor_targets is an empty array", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id: 1, rfq_product_id: 1, end_date: futureIso(), vendor_targets: [] },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });

  it("rejects when end_date is in the past", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id: 1,
        rfq_product_id: 1,
        end_date: new Date(Date.now() - 86400_000).toISOString(),
        vendor_targets: [{ vendor_id: 1 }],
      },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/End date must be in the future/i);
  });
});

describe("createRound — state gates", () => {
  it("returns 404 when RFQ does not exist", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id: 999999999,
        rfq_product_id: 1,
        end_date: futureIso(),
        vendor_targets: [{ vendor_id: IDS.users.vendor_alpha }],
      },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(404);
  });

  it("rejects when RFQ is not a hospitality RFQ", async () => {
    // Create RFQ with no hospitality_company_id by overriding to null.
    // Our factory always sets hospitality; we have to insert directly.
    const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const fiveDaysHence = new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const rfq = await db.one(
      `INSERT INTO tbl_rfq (
         rfq_no, comment, company_name, response_email, contact_name, contact_number,
         bid_end_date, location, is_published, status, created_by, updated_by,
         "timestamp", is_tender, rfq_type
       ) VALUES (8888888, '', '', '', '', '', $1, '', 1, 1, $2, $2, now(), 0, 'RFQ')
       RETURNING id`,
      [oneDayAgo, IDS.users.a1_proc_buyer]
    );
    inserted.rfqIds.push(rfq.id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id: rfq.id,
        rfq_product_id: 1,
        end_date: futureIso(),
        vendor_targets: [{ vendor_id: IDS.users.vendor_alpha }],
      },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/only available for hospitality/i);
  });

  it("rejects when bid window is still OPEN (quote visibility locked)", async () => {
    // bid_end_date in the future → quote visibility locked → negotiation
    // remains view-only.
    const fiveDaysHence = new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      status: 1,
      is_published: 1,
      bid_end_date: fiveDaysHence, // OPEN
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      process: IDS.processes.A_P1,
    });
    inserted.rfqIds.push(rfq_id);
    const product_id = await makeRfqProduct(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        rfq_product_id: product_id,
        end_date: futureIso(),
        vendor_targets: [{ vendor_id: IDS.users.vendor_alpha, fields: [{ name: "base_price" }] }],
      },
    });
    await negotiationController.createRound(m.req, m.res);
    expect([400, 423]).toContain(m.calls.status);
    expect(m.calls.body.message).toMatch(/view only|deadline has passed|deadline.*passed/i);
  });

  it("returns 404 when product not in RFQ", async () => {
    const rfq_id = await makeBidEndedRfq();
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        rfq_product_id: 999999999,
        end_date: futureIso(),
        vendor_targets: [{ vendor_id: IDS.users.vendor_alpha }],
      },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(404);
  });

  it("rejects when vendor is not part of the product", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await makeRfqProduct(rfq_id);
    // No attachVendor call — vendor_alpha is not in tbl_rfq_product_vendors.

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        rfq_product_id: product_id,
        end_date: futureIso(),
        vendor_targets: [{ vendor_id: IDS.users.vendor_alpha, fields: [{ name: "base_price" }] }],
      },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/not part of this product/i);
  });
});

describe("createRound — NEGOTIATION policy resolution (no cross-process fall-through)", () => {
  it("rejects when no NEGOTIATION policy exists for the (process, hotel) scope", async () => {
    // Spin up a fresh process under company A with NO policies, attach the
    // RFQ to it. The policy resolver must surface "no approval workflow found"
    // rather than silently fall back to A_P1's NEGOTIATION policy.
    const newProc = await db.one(
      `INSERT INTO tbl_approval_processes (company_id, name, description, is_active, created_by, process_type)
       VALUES ($1, 'Negotiation-Test Process', '', true, $2, 'RFQ') RETURNING id`,
      [IDS.companies.A, IDS.users.companyA_admin]
    );
    inserted.extraProcessIds.push(newProc.id);

    const rfq_id = await makeBidEndedRfq({ process: newProc.id });
    const product_id = await makeRfqProduct(rfq_id);
    await attachVendor(rfq_id, IDS.users.vendor_alpha);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        rfq_product_id: product_id,
        end_date: futureIso(),
        vendor_targets: [{ vendor_id: IDS.users.vendor_alpha, fields: [{ name: "base_price" }] }],
      },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/No approval workflow found for NEGOTIATION/i);

    // No round should have been created.
    const rounds = await db.any(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id=$1`, [rfq_id]);
    expect(rounds.length).toBe(0);
  });

  it("happy path — creates round + NEGOTIATION approval instance for the process's policy", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await makeRfqProduct(rfq_id);
    await attachVendor(rfq_id, IDS.users.vendor_alpha);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        rfq_product_id: product_id,
        end_date: futureIso(),
        vendor_targets: [
          { vendor_id: IDS.users.vendor_alpha, fields: [{ name: "base_price" }] },
        ],
      },
    });
    await negotiationController.createRound(m.req, m.res);

    expect(m.calls.status).toBe(200);
    // Round persisted with PENDING_APPROVAL or ACTIVE (auto-approve case).
    const round = await db.one(
      `SELECT id, status, round_number, rfq_product_id FROM tbl_negotiation_rounds WHERE rfq_id=$1`,
      [rfq_id]
    );
    expect(["PENDING_APPROVAL", "ACTIVE"]).toContain(round.status);
    expect(round.round_number).toBe(1);
    expect(round.rfq_product_id).toBe(product_id);

    // NEGOTIATION approval instance was created against the round.id.
    const inst = await db.one(
      `SELECT entity_type, entity_id, approval_policy_id, status
       FROM tbl_approval_instances
       WHERE entity_type='NEGOTIATION' AND entity_id=$1`,
      [round.id]
    );
    expect(inst.entity_type).toBe("NEGOTIATION");
    expect(inst.approval_policy_id).toBe(IDS.policies.A1_P1_NEGOTIATION);
  });
});

// ===========================================================================
//  approveRound / rejectRound — basic state transitions
// ===========================================================================

describe("approveRound / rejectRound — state transitions", () => {
  // These exercise the NEGOTIATION approval engine through the public API.
  // We rely on createRound to seed a PENDING_APPROVAL round, then act on its
  // approval instance through the negotiation controller.

  async function seedPendingRound() {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await makeRfqProduct(rfq_id);
    await attachVendor(rfq_id, IDS.users.vendor_alpha);
    const create = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        rfq_product_id: product_id,
        end_date: futureIso(),
        vendor_targets: [
          { vendor_id: IDS.users.vendor_alpha, fields: [{ name: "base_price" }] },
        ],
      },
    });
    await negotiationController.createRound(create.req, create.res);
    expect(create.calls.status).toBe(200);
    const round = await db.one(
      `SELECT id, status FROM tbl_negotiation_rounds WHERE rfq_id=$1`,
      [rfq_id]
    );
    return { rfq_id, product_id, round };
  }

  it("returns 404 when approving a non-existent round", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_commApp },
      params: { id: "999999999" },
      body: {},
    });
    await negotiationController.approveRound(m.req, m.res);
    expect([400, 404]).toContain(m.calls.status);
  });

  it("rejectRound with missing remarks returns 400", async () => {
    const { round } = await seedPendingRound();
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_commApp },
      params: { id: String(round.id) },
      body: {}, // no remarks
    });
    await negotiationController.rejectRound(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });
});

// ===========================================================================
//  approveRound — full happy path through the production engine
// ===========================================================================

describe("approveRound — happy path drives round PENDING_APPROVAL → ACTIVE", () => {
  it("acts as the role-eligible approver, flips instance APPROVED + round ACTIVE, logs lifecycle event", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await makeRfqProduct(rfq_id);
    await attachVendor(rfq_id, IDS.users.vendor_alpha);

    const create = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, rfq_product_id: product_id, end_date: futureIso(),
        vendor_targets: [
          { vendor_id: IDS.users.vendor_alpha, fields: [{ name: "base_price" }] },
        ],
      },
    });
    await negotiationController.createRound(create.req, create.res);
    expect(create.calls.status).toBe(200);

    const round = await db.one(
      `SELECT id, status FROM tbl_negotiation_rounds WHERE rfq_id=$1`, [rfq_id]
    );
    expect(round.status).toBe("PENDING_APPROVAL");

    // approveRound — acting as a1_proc_commApp (has COMM_APPROVER role per A1_P1_NEGOTIATION).
    const approve = mockExpress({
      user: { id: IDS.users.a1_proc_commApp },
      params: { id: String(round.id) },
      body: { remarks: "approve nego round" },
    });
    await negotiationController.approveRound(approve.req, approve.res);
    expect(approve.calls.status).toBe(200);

    // Round flipped to ACTIVE; approval instance APPROVED.
    const after = await db.one(
      `SELECT status, approved_at, published_at FROM tbl_negotiation_rounds WHERE id=$1`,
      [round.id]
    );
    expect(after.status).toBe("ACTIVE");
    expect(after.approved_at).not.toBeNull();
    expect(after.published_at).not.toBeNull();

    const inst = await db.one(
      `SELECT id, status FROM tbl_approval_instances
       WHERE entity_type='NEGOTIATION' AND entity_id=$1`,
      [round.id]
    );
    expect(inst.status).toBe("APPROVED");

    // Lifecycle event ROUND_PUBLISHED recorded.
    const lifecycle = await db.oneOrNone(
      `SELECT action FROM tbl_lifecycle_history
       WHERE entity_id=$1 AND action='ROUND_PUBLISHED' LIMIT 1`,
      [rfq_id]
    );
    expect(lifecycle).not.toBeNull();
  });
});

// ===========================================================================
//  rejectRound — happy path
// ===========================================================================

describe("rejectRound — terminates instance + cancels round", () => {
  it("rejecting a PENDING_APPROVAL round flips instance REJECTED + round status reflects rejection; no further approval activity expected", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await makeRfqProduct(rfq_id);
    await attachVendor(rfq_id, IDS.users.vendor_alpha);

    const create = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, rfq_product_id: product_id, end_date: futureIso(),
        vendor_targets: [
          { vendor_id: IDS.users.vendor_alpha, fields: [{ name: "base_price" }] },
        ],
      },
    });
    await negotiationController.createRound(create.req, create.res);
    const round = await db.one(
      `SELECT id, status FROM tbl_negotiation_rounds WHERE rfq_id=$1`, [rfq_id]
    );
    expect(round.status).toBe("PENDING_APPROVAL");

    // rejectRound — acting as the same approver.
    const reject = mockExpress({
      user: { id: IDS.users.a1_proc_commApp },
      params: { id: String(round.id) },
      body: { remarks: "needs more vendor analysis" },
    });
    await negotiationController.rejectRound(reject.req, reject.res);
    expect(reject.calls.status).toBe(200);

    // Approval instance REJECTED.
    const inst = await db.one(
      `SELECT status FROM tbl_approval_instances
       WHERE entity_type='NEGOTIATION' AND entity_id=$1`, [round.id]
    );
    expect(inst.status).toBe("REJECTED");

    // Round status reflects rejection (CANCELLED or REJECTED depending on
    // controller implementation — assert it's NOT still pending or active).
    const after = await db.one(
      `SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [round.id]
    );
    expect(["CANCELLED", "REJECTED"]).toContain(after.status);
  });
});

// ===========================================================================
//  submitVendorQuote — vendor-side action on an ACTIVE round
// ===========================================================================

describe("submitVendorQuote — assigned vendor quotes on ACTIVE round", () => {
  async function activeRoundForVendor(vendorIds) {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await makeRfqProduct(rfq_id);
    for (const vid of vendorIds) await attachVendor(rfq_id, vid);

    // create round
    const create = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, rfq_product_id: product_id, end_date: futureIso(),
        vendor_targets: vendorIds.map((vid, i) => ({
          vendor_id: vid,
          // Distinct fields per vendor — needed for F-NEGO-001 leak assertion.
          fields: [{ name: i === 0 ? "base_price" : "freight_price" }],
          custom_charges: [{ name: `vendor-${vid}-secret-charge`, value: 100 + i }],
        })),
      },
    });
    await negotiationController.createRound(create.req, create.res);
    expect(create.calls.status).toBe(200);

    const round = await db.one(
      `SELECT id FROM tbl_negotiation_rounds WHERE rfq_id=$1`, [rfq_id]
    );

    // approve to ACTIVE
    const approve = mockExpress({
      user: { id: IDS.users.a1_proc_commApp },
      params: { id: String(round.id) }, body: {},
    });
    await negotiationController.approveRound(approve.req, approve.res);
    expect(approve.calls.status).toBe(200);

    return { rfq_id, product_id, round_id: round.id };
  }

  it("assigned vendor (vendor_alpha) submits a quote → tbl_negotiation_round_quotes row inserted", async () => {
    const { product_id, round_id } = await activeRoundForVendor([IDS.users.vendor_alpha]);

    const submit = mockExpress({
      user: { id: IDS.users.vendor_alpha, vendor_id: IDS.users.vendor_alpha },
      params: { id: String(round_id) },
      body: { rfq_product_id: product_id, quoted_price: 950, previous_price: 1000 },
    });
    await negotiationController.submitVendorQuote(submit.req, submit.res);
    expect(submit.calls.status).toBe(200);
    expect(submit.calls.body.message).toMatch(/submitted successfully/i);

    const quote = await db.one(
      `SELECT vendor_id, quoted_price FROM tbl_negotiation_round_quotes
       WHERE negotiation_round_id=$1`, [round_id]
    );
    expect(quote.vendor_id).toBe(IDS.users.vendor_alpha);
    expect(parseFloat(quote.quoted_price)).toBe(950);
  });

  it("foreign vendor (vendor_beta, not assigned) submitting quote is blocked with 403", async () => {
    const { product_id, round_id } = await activeRoundForVendor([IDS.users.vendor_alpha]);

    const submit = mockExpress({
      user: { id: IDS.users.vendor_beta, vendor_id: IDS.users.vendor_beta },
      params: { id: String(round_id) },
      body: { rfq_product_id: product_id, quoted_price: 800 },
    });
    await negotiationController.submitVendorQuote(submit.req, submit.res);
    expect(submit.calls.status).toBe(403);
    expect(submit.calls.body.message).toMatch(/not assigned/i);

    // No quote row inserted.
    const rows = await db.any(
      `SELECT 1 FROM tbl_negotiation_round_quotes
       WHERE negotiation_round_id=$1 AND vendor_id=$2`,
      [round_id, IDS.users.vendor_beta]
    );
    expect(rows.length).toBe(0);
  });

  it("F-NEGO-001 — vendor B fetching getActiveRound MUST NOT see vendor A's vendor_approvals entry", async () => {
    const { rfq_id, product_id, round_id } = await activeRoundForVendor([
      IDS.users.vendor_alpha, IDS.users.vendor_beta,
    ]);

    // vendor_beta hits getActiveRound with user_type=3 (vendor token route).
    const m = mockExpress({
      user: { id: IDS.users.vendor_beta, vendor_id: IDS.users.vendor_beta, user_type: 3 },
      params: { rfq_id: String(rfq_id) },
      query: { rfq_product_id: String(product_id) },
    });
    await negotiationController.getActiveRound(m.req, m.res);
    expect(m.calls.status).toBe(200);

    // POST-FIX expectation: when a vendor (user_type=3) reads the active
    // round, vendor_approvals MUST be scoped to that vendor only — Vendor A's
    // entry (incl. their custom_charges and approval status) must not appear.
    // Today the controller returns the full JSONB array unfiltered. Until
    // fixed (filter `WHERE user_id=$current_vendor` server-side, or drop the
    // column from the vendor-side projection), this test fails.
    const data = m.calls.body.data;
    expect(data).not.toBeNull();
    const vendorApprovals = Array.isArray(data.vendor_approvals) ? data.vendor_approvals : [];
    const alphaEntry = vendorApprovals.find((va) => va.vendor_id === IDS.users.vendor_alpha);
    expect(alphaEntry).toBeUndefined();
    // Vendor B's own entry should still be present.
    const betaEntry = vendorApprovals.find((va) => va.vendor_id === IDS.users.vendor_beta);
    expect(betaEntry).toBeDefined();
  });
});

// ===========================================================================
//  Remaining deferreds — concurrency + cron-driven
// ===========================================================================

describe("negotiation — remaining deferreds (Wave 4 / cron + time mocks)", () => {
  it.todo(
    "round expiration cron: round end_date elapses with no buyer action → status=EXPIRED + approval CANCELLED (Wave 4 / Task 13 with time-mock + invokable cron body)"
  );
});
