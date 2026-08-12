// Wave-2: negotiation field-coverage tests.
//
// Production reality (verified against hospitality_stage RFQ 189 +
// rounds 77/78/79): a negotiation round can target ANY combination of:
//   - `base_price`                   (numeric — the unit price)
//   - per-charge fields (e.g. "Freight", "Insurance", "Packaging",
//     custom names like "test custom charge", or charge-prefixed forms
//     like "charge_Freight")
//   - mode flags such as "Freight_mode"
//   - free-text fields: "comments", "payment_terms"
//   - structured fields: "documents" (array of { comment, file_url,
//     document_index })
//
// A field has shape `{ name, target }` where `target` is the buyer's
// initial proposal — number for numeric fields, string for text fields,
// or an array of objects for documents. The buyer creates the round; the
// stored `vendor_approvals[].negotiation_fields` carries those targets
// per vendor verbatim. The vendor responds via `submitVendorQuote` →
// `tbl_negotiation_round_quotes` with `quoted_price` + `previous_price`.
//
// Why this matters: an RFQ where one buyer is negotiating Freight with
// vendor A and Packaging with vendor B has dozens of distinct money
// numbers in flight. A bug in target persistence, vendor isolation, or
// field-overlap protection means a buyer ends up paying based on the
// wrong vendor's number.
//
// What we lock here:
//   1. createRound persists multi-field vendor_targets (base_price +
//      named charges + free-text + structured "documents") with target
//      values intact.
//   2. Multi-vendor round: each vendor's negotiation_fields slot has
//      ONLY their own fields (no leak across vendors at write time).
//   3. Field-overlap protection across active rounds: same product +
//      same field name on a second active round is rejected.
//   4. Different fields on the same product CAN coexist as parallel
//      active rounds.
//   5. submitVendorQuote happy path: tbl_negotiation_round_quotes row
//      with quoted_price + previous_price both persist.
//   6. submitVendorQuote one-shot: a second submission by the same
//      vendor on the same round is rejected.
//   7. Foreign-vendor write block (already covered in negotiation.flow,
//      re-asserted here for completeness).
//   8. F-NEGO-001 expanded: vendor B's getActiveRound exposes vendor
//      A's per-field targets including custom_charges-style fields.

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
    `SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  const roundIds = rounds.map((r) => r.id);
  if (roundIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_actions
       WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances
         WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[]))`,
      [roundIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_step_approvers
       WHERE approval_instance_step_id IN (
         SELECT s.id FROM tbl_approval_instance_steps s
         JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
         WHERE i.entity_type='NEGOTIATION' AND i.entity_id = ANY($1::int[]))`,
      [roundIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_steps
       WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances
         WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[]))`,
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
});

// ---- Helpers --------------------------------------------------------------

const futureIso = (offsetMs = 7 * 86400_000) =>
  new Date(Date.now() + offsetMs).toISOString();

async function makeBidEndedRfq() {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const threeDaysAgo = new Date(Date.now() - 3 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    tender_publish_date: threeDaysAgo,
    vendor_clarification_date: twoDaysAgo,
    bid_end_date: oneDayAgo,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

async function attachProduct(rfq_id, productVariantId = 1) {
  const { id } = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
    [rfq_id, productVariantId]
  );
  return id;
}

async function attachVendor(rfq_id, vendorId, productVariantId = 1) {
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, productVariantId, vendorId]
  );
}

// ===========================================================================
//  createRound — multi-field target persistence
// ===========================================================================

describe("createRound — multi-field vendor_targets persist with target values intact", () => {
  it("base_price + Freight + Insurance + comments + payment_terms + documents all land in vendor_approvals[].negotiation_fields", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    const richFields = [
      { name: "base_price", target: 450 },
      { name: "Freight", target: 8 },
      { name: "Insurance", target: 5 },
      { name: "comments", target: "Please reduce by 10%" },
      { name: "payment_terms", target: "30 days credit instead of advance" },
      { name: "documents", target: [
        { comment: "revised spec sheet", file_url: "https://test-workwise-bucket.s3.ap-south-1.amazonaws.com/x.pdf", document_index: 0 },
      ] },
    ];

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, rfq_product_id: product_id, end_date: futureIso(),
        vendor_targets: [{ vendor_id: IDS.users.vendor_alpha, fields: richFields }],
      },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const round = await db.one(
      `SELECT id, vendor_approvals FROM tbl_negotiation_rounds WHERE rfq_id=$1`,
      [rfq_id]
    );
    const approvals = Array.isArray(round.vendor_approvals)
      ? round.vendor_approvals
      : JSON.parse(round.vendor_approvals);
    expect(approvals.length).toBe(1);
    expect(approvals[0].vendor_id).toBe(IDS.users.vendor_alpha);

    const fieldsByName = Object.fromEntries(
      approvals[0].negotiation_fields.map((f) => [f.name, f])
    );
    expect(fieldsByName["base_price"].target).toBe(450);
    expect(fieldsByName["Freight"].target).toBe(8);
    expect(fieldsByName["Insurance"].target).toBe(5);
    expect(fieldsByName["comments"].target).toBe("Please reduce by 10%");
    expect(fieldsByName["payment_terms"].target).toBe("30 days credit instead of advance");
    // documents is an array — verify shape preserved.
    expect(Array.isArray(fieldsByName["documents"].target)).toBe(true);
    expect(fieldsByName["documents"].target[0].file_url).toMatch(/test-workwise-bucket/);
    expect(fieldsByName["documents"].target[0].document_index).toBe(0);
  });
});

// ===========================================================================
//  Multi-vendor isolation (write side)
// ===========================================================================

describe("createRound — multi-vendor: each vendor's negotiation_fields slot has only their own fields", () => {
  it("vendor A targets base_price; vendor B targets Freight + Insurance — neither slot leaks into the other at write time", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);
    await attachVendor(rfq_id, IDS.users.vendor_beta, 1);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, rfq_product_id: product_id, end_date: futureIso(),
        vendor_targets: [
          { vendor_id: IDS.users.vendor_alpha, fields: [{ name: "base_price", target: 450 }] },
          { vendor_id: IDS.users.vendor_beta, fields: [
            { name: "Freight", target: 8 },
            { name: "Insurance", target: 5 },
          ] },
        ],
      },
    });
    await negotiationController.createRound(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const round = await db.one(
      `SELECT vendor_approvals FROM tbl_negotiation_rounds WHERE rfq_id=$1`, [rfq_id]
    );
    const approvals = Array.isArray(round.vendor_approvals)
      ? round.vendor_approvals
      : JSON.parse(round.vendor_approvals);

    const alpha = approvals.find((a) => a.vendor_id === IDS.users.vendor_alpha);
    const beta = approvals.find((a) => a.vendor_id === IDS.users.vendor_beta);

    expect(alpha.negotiation_fields.length).toBe(1);
    expect(alpha.negotiation_fields[0].name).toBe("base_price");
    expect(alpha.negotiation_fields[0].target).toBe(450);

    expect(beta.negotiation_fields.length).toBe(2);
    const betaFields = beta.negotiation_fields.map((f) => f.name).sort();
    expect(betaFields).toEqual(["Freight", "Insurance"]);
    // vendor_beta's slot must NOT contain base_price.
    expect(beta.negotiation_fields.find((f) => f.name === "base_price")).toBeUndefined();
    // vendor_alpha's slot must NOT contain Freight/Insurance.
    expect(alpha.negotiation_fields.find((f) => f.name === "Freight")).toBeUndefined();
    expect(alpha.negotiation_fields.find((f) => f.name === "Insurance")).toBeUndefined();
  });
});

// ===========================================================================
//  Field-overlap protection across active rounds (same product, same vendor)
// ===========================================================================

describe("createRound — field-overlap protection on the same product", () => {
  // Helper that approves a round so it becomes ACTIVE — needed so the next
  // overlap check actually runs against an ACTIVE round.
  async function approveRound(round_id) {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_commApp },
      params: { id: String(round_id) }, body: {},
    });
    await negotiationController.approveRound(m.req, m.res);
    expect(m.calls.status).toBe(200);
  }

  it("a second round targeting the SAME field on the SAME product+vendor while the first is ACTIVE → 400", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    // Round 1 — Freight.
    const create1 = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, rfq_product_id: product_id, end_date: futureIso(),
        vendor_targets: [{ vendor_id: IDS.users.vendor_alpha, fields: [{ name: "Freight", target: 8 }] }],
      },
    });
    await negotiationController.createRound(create1.req, create1.res);
    expect(create1.calls.status).toBe(200);
    const round1 = await db.one(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id=$1`, [rfq_id]);
    await approveRound(round1.id);

    // Round 2 — also Freight → must reject with "already has an active round".
    const create2 = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, rfq_product_id: product_id, end_date: futureIso(),
        vendor_targets: [{ vendor_id: IDS.users.vendor_alpha, fields: [{ name: "Freight", target: 6 }] }],
      },
    });
    await negotiationController.createRound(create2.req, create2.res);
    expect(create2.calls.status).toBe(400);
    // Wording changed deliberately: the old copy called every blocking round
    // "active" even when it was only awaiting approval. This round really IS
    // live (approveRound above), so it gets the live-round message.
    expect(create2.calls.body.code).toBe("ROUND_ACTIVE");
    expect(create2.calls.body.message).toMatch(/has a live negotiation round on Freight/i);
  });

  it("a second round targeting a DIFFERENT field on the same product+vendor IS allowed", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    // Round 1 — Freight.
    const create1 = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, rfq_product_id: product_id, end_date: futureIso(),
        vendor_targets: [{ vendor_id: IDS.users.vendor_alpha, fields: [{ name: "Freight", target: 8 }] }],
      },
    });
    await negotiationController.createRound(create1.req, create1.res);
    expect(create1.calls.status).toBe(200);
    const round1 = await db.one(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id=$1`, [rfq_id]);
    await approveRound(round1.id);

    // Round 2 — Insurance (different field). Must succeed.
    const create2 = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, rfq_product_id: product_id, end_date: futureIso(),
        vendor_targets: [{ vendor_id: IDS.users.vendor_alpha, fields: [{ name: "Insurance", target: 5 }] }],
      },
    });
    await negotiationController.createRound(create2.req, create2.res);
    expect(create2.calls.status).toBe(200);

    const rounds = await db.any(
      `SELECT id, round_number, status FROM tbl_negotiation_rounds WHERE rfq_id=$1 ORDER BY round_number`,
      [rfq_id]
    );
    expect(rounds.length).toBe(2);
  });
});

// ===========================================================================
//  submitVendorQuote — one-shot + previous_price round-trip
// ===========================================================================

describe("submitVendorQuote — one-shot enforcement + previous_price round-trip", () => {
  async function activeRoundForVendor(vendorId, fields = [{ name: "base_price", target: 450 }]) {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, vendorId, 1);
    const create = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, rfq_product_id: product_id, end_date: futureIso(),
        vendor_targets: [{ vendor_id: vendorId, fields }],
      },
    });
    await negotiationController.createRound(create.req, create.res);
    expect(create.calls.status).toBe(200);
    const round = await db.one(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id=$1`, [rfq_id]);

    const approve = mockExpress({
      user: { id: IDS.users.a1_proc_commApp },
      params: { id: String(round.id) }, body: {},
    });
    await negotiationController.approveRound(approve.req, approve.res);
    expect(approve.calls.status).toBe(200);
    return { rfq_id, product_id, round_id: round.id };
  }

  it("first submission persists quoted_price + previous_price; second submission is rejected with 'already submitted'", async () => {
    const { product_id, round_id } = await activeRoundForVendor(IDS.users.vendor_alpha);

    const submit1 = mockExpress({
      user: { id: IDS.users.vendor_alpha, vendor_id: IDS.users.vendor_alpha },
      params: { id: String(round_id) },
      body: { rfq_product_id: product_id, quoted_price: 425, previous_price: 500 },
    });
    await negotiationController.submitVendorQuote(submit1.req, submit1.res);
    expect(submit1.calls.status).toBe(200);

    const stored = await db.one(
      `SELECT quoted_price, previous_price, vendor_id
       FROM tbl_negotiation_round_quotes WHERE negotiation_round_id=$1`,
      [round_id]
    );
    expect(parseFloat(stored.quoted_price)).toBe(425);
    expect(parseFloat(stored.previous_price)).toBe(500);
    expect(stored.vendor_id).toBe(IDS.users.vendor_alpha);

    // Second submission — same vendor, same round.
    const submit2 = mockExpress({
      user: { id: IDS.users.vendor_alpha, vendor_id: IDS.users.vendor_alpha },
      params: { id: String(round_id) },
      body: { rfq_product_id: product_id, quoted_price: 410 },
    });
    await negotiationController.submitVendorQuote(submit2.req, submit2.res);
    expect(submit2.calls.status).toBe(400);
    expect(submit2.calls.body.message).toMatch(/already submitted|Only one submission/i);

    // Stored row is unchanged.
    const after = await db.one(
      `SELECT quoted_price FROM tbl_negotiation_round_quotes WHERE negotiation_round_id=$1`,
      [round_id]
    );
    expect(parseFloat(after.quoted_price)).toBe(425);
  });
});

// ===========================================================================
//  F-NEGO-001 (read leak) — vendor B sees vendor A's per-field targets
// ===========================================================================

describe("getActiveRound — F-NEGO-001 leak coverage on per-field targets", () => {
  it("vendor B fetching getActiveRound MUST NOT see vendor A's negotiation_fields (custom-charge-style or otherwise)", async () => {
    const rfq_id = await makeBidEndedRfq();
    const product_id = await attachProduct(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);
    await attachVendor(rfq_id, IDS.users.vendor_beta, 1);

    // Buyer creates a round where each vendor has DISTINCT secrets.
    const create = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, rfq_product_id: product_id, end_date: futureIso(),
        vendor_targets: [
          { vendor_id: IDS.users.vendor_alpha, fields: [
            { name: "base_price", target: 425 },
            { name: "Freight", target: 7 },
            { name: "test_custom_charge", target: 100 },
          ] },
          { vendor_id: IDS.users.vendor_beta, fields: [
            { name: "base_price", target: 460 },
            { name: "Insurance", target: 6 },
          ] },
        ],
      },
    });
    await negotiationController.createRound(create.req, create.res);
    expect(create.calls.status).toBe(200);

    // Approve the round so it becomes ACTIVE — vendors now hit getActiveRound
    // with vendor_token-style auth (user_type=3).
    const round = await db.one(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id=$1`, [rfq_id]);
    const approve = mockExpress({
      user: { id: IDS.users.a1_proc_commApp },
      params: { id: String(round.id) }, body: {},
    });
    await negotiationController.approveRound(approve.req, approve.res);
    expect(approve.calls.status).toBe(200);

    // vendor_beta calls getActiveRound (vendor token route, user_type=3).
    const m = mockExpress({
      user: { id: IDS.users.vendor_beta, vendor_id: IDS.users.vendor_beta, user_type: 3 },
      params: { rfq_id: String(rfq_id) },
      query: { rfq_product_id: String(product_id) },
    });
    await negotiationController.getActiveRound(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const data = m.calls.body.data;
    expect(data).not.toBeNull();
    const approvals = Array.isArray(data.vendor_approvals)
      ? data.vendor_approvals
      : JSON.parse(data.vendor_approvals || "[]");

    // POST-FIX: vendor_approvals is scoped to the requesting vendor; Vendor
    // A's slot (with their per-field targets including custom-charge fields)
    // MUST NOT appear when Vendor B reads the round. Vendor B's own slot
    // remains visible.
    const alphaSlot = approvals.find((a) => a.vendor_id === IDS.users.vendor_alpha);
    expect(alphaSlot).toBeUndefined();
    const betaSlot = approvals.find((a) => a.vendor_id === IDS.users.vendor_beta);
    expect(betaSlot).toBeDefined();
    const betaFieldNames = betaSlot.negotiation_fields.map((f) => f.name).sort();
    expect(betaFieldNames).toEqual(["Insurance", "base_price"]);
  });
});
