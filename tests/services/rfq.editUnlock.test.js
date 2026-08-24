// Wave-1 step-3.8 + step-3.9 tests: edit-unlock variants.
//
// The default policy in `assertEditAllowed` is "bid window closed → no edits".
// Two unlock branches exist so the creator isn't stuck:
//
//   Step 8 (zero-participation):
//     bid_end_date in the past, NO `tbl_quotes` row exists for this RFQ
//     → editing IS allowed; the creator can extend bid_end_date / vendor
//        clarification deadline. (Full edit: any field.)
//
//   Step 9 (all vendors failed tech eval):
//     bid_end_date in the past, quotes exist, AND a tech-eval row marked
//     `blocked_insufficient_vendors=true` with `total_passed_verified=0`
//     → restricted edit only; per the controller's isRestrictedEdit guard,
//        ONLY `bid_end_date` is mutable. Other RFQ fields, product specs/files,
//        product comment, tech eval clauses, terms — all rejected with 400.
//
// Both unlock branches go through `rfqController.update`. We exercise via the
// production controller, no SQL replication.

import { describe, it, expect, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

// Mock cronManager — same as other update-flow tests; the unlock paths don't
// re-schedule, but cancelAndReissueApproval may import the module.
jest.unstable_mockModule("../../app/helper/cronManager.js", () => ({
  scheduleMilestoneReminder: async () => {},
  rescheduleMilestoneReminder: async () => {},
  removeMilestoneReminder: () => {},
  rescheduleAllMilestoneReminders: async () => {},
  scheduleGRNReminders: async () => {},
  publishRfqById: async () => {},
  scheduleRfqPublish: async () => {},
  removeRfqPublishJob: async () => ({ ok: true }),
  rescheduleAllRfqPublishJobs: async () => {},
  startVendorAcceptanceReminderCron: () => {},
  scheduleNegotiationRoundExpiration: () => {},
  removeNegotiationRoundExpiration: () => {},
  rescheduleAllNegotiationRoundExpirations: async () => {},
}));

const { default: rfqController } = await import(
  "../../app/controllers/rfq/rfqController.js"
);
const { default: rfqModel } = await import(
  "../../app/models/rfqModel.js"
);

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
    req: { user: opts.user, params: opts.params || {}, body: opts.body || {} },
    res,
    next: jest.fn(),
    calls,
  };
}

const inserted = { rfqIds: [] };

beforeEach(() => { inserted.rfqIds = []; });

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  await db.none(`DELETE FROM tbl_rfq_change_history WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response WHERE tbl_rfq_product_tech_evaluation_clauses_id IN (SELECT c.id FROM tbl_rfq_product_tech_evaluation_clauses c JOIN tbl_rfq_product_tech_evaluation te ON te.id = c.tbl_rfq_product_tech_evaluation_id WHERE te.rfq_id = ANY($1::int[]))`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation_clauses WHERE tbl_rfq_product_tech_evaluation_id IN (SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[]))`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

// ---- Helpers ---------------------------------------------------------------

function istString(offsetMs) {
  const ist = new Date(Date.now() + offsetMs + 5.5 * 3600_000);
  return ist.toISOString().replace("T", " ").slice(0, 19);
}

const fetchSnapshot = (rfq_id) => rfqModel.getFullRfqForEdit(rfq_id);

async function makeBidPastRfq() {
  // Submitted/published RFQ whose bid window has ALREADY CLOSED.
  const oneDayAgo = new Date(Date.now() - 86400_000)
    .toISOString().replace("T", " ").slice(0, 19);
  const twoDaysAgo = new Date(Date.now() - 2 * 86400_000)
    .toISOString().replace("T", " ").slice(0, 19);
  const threeDaysAgo = new Date(Date.now() - 3 * 86400_000)
    .toISOString().replace("T", " ").slice(0, 19);
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
    comment: "post-bid RFQ",
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
  // Quantity + Unit are mandatory per product (assertProductQuantityAndUnit).
  await db.none(
    `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
     VALUES ($1, $2, 'Quantity', '10', 0), ($1, $2, 'Unit', 'NOS', 0)`,
    [rfq_id, productVariantId]
  );
  return id;
}

// ===========================================================================
//  Baseline: bid past + quotes exist + no unlock condition → edit blocked.
// ===========================================================================

describe("rfqController.update — bid window closed (no unlock branch) → edit blocked", () => {
  it("rejects with 400 when bid past + quotes exist + neither dead-end nor tech-stuck", async () => {
    const rfq_id = await makeBidPastRfq();
    await attachProduct(rfq_id, 1);
    // Plant a vendor quote so hasQuotes=true.
    await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
       SELECT $1, rfq_no, $2, $2, 1, NOW() FROM tbl_rfq WHERE id=$1 RETURNING id`,
      [rfq_id, IDS.users.vendor_alpha]
    );
    const snap = await fetchSnapshot(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: { ...snap, bid_end_date: istString(7 * 86400_000) },
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/bid window has closed/i);
  });
});

// ===========================================================================
//  Step 8 — zero-participation edit-unlock (no quotes received)
// ===========================================================================

describe("rfqController.update — Step 8: zero-participation unlock", () => {
  it("bid past + ZERO tbl_quotes rows → creator CAN extend bid_end_date", async () => {
    const rfq_id = await makeBidPastRfq();
    await attachProduct(rfq_id, 1);
    // No tbl_quotes row → hasQuotes=false → unlock branch fires.
    const snap = await fetchSnapshot(rfq_id);

    const newBid = istString(7 * 86400_000);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: newBid } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.change_count).toBeGreaterThan(0);

    const after = await db.one(
      `SELECT bid_end_date FROM tbl_rfq WHERE id=$1`, [rfq_id]
    );
    // bid_end_date is text in the schema; the controller round-trips it.
    expect(after.bid_end_date).toBe(newBid);
  });

  it("bid past + ZERO quotes → creator can also extend vendor_clarification_date together", async () => {
    const rfq_id = await makeBidPastRfq();
    await attachProduct(rfq_id, 1);
    const snap = await fetchSnapshot(rfq_id);

    const newBid = istString(7 * 86400_000);
    const newClar = istString(5 * 86400_000);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: {
          ...snap,
          bid_end_date: newBid,
          vendor_clarification_date: newClar,
        },
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const after = await db.one(
      `SELECT bid_end_date, vendor_clarification_date FROM tbl_rfq WHERE id=$1`,
      [rfq_id]
    );
    expect(after.bid_end_date).toBe(newBid);
    expect(after.vendor_clarification_date).toBe(newClar);
  });
});

// ===========================================================================
//  Step 9 — all vendors fail tech eval → restricted edit unlock
// ===========================================================================

describe("rfqController.update — Step 9: tech-eval-all-failed unlock (restricted)", () => {
  /**
   * Plant tech-eval markers that signal "all eligible vendors failed":
   *   blocked_insufficient_vendors = TRUE
   *   total_passed_verified         = 0
   */
  async function plantTechStuck(rfq_id, productId) {
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation
         (rfq_id, tbl_rfq_product_id, blocked_insufficient_vendors,
          total_passed_verified, required_passed_vendors, minimum_passing_score)
       VALUES ($1, $2, TRUE, 0, 5, 50)`,
      [rfq_id, productId]
    );
  }

  it("bid past + quotes + tech-stuck → ALLOWS extending bid_end_date (restricted edit)", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    await plantTechStuck(rfq_id, productId);
    // hasQuotes=true (plant a quote so we're past the simple zero-participation gate).
    await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
       SELECT $1, rfq_no, $2, $2, 1, NOW() FROM tbl_rfq WHERE id=$1 RETURNING id`,
      [rfq_id, IDS.users.vendor_alpha]
    );
    const snap = await fetchSnapshot(rfq_id);

    const newBid = istString(7 * 86400_000);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: newBid } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const after = await db.one(
      `SELECT bid_end_date FROM tbl_rfq WHERE id=$1`, [rfq_id]
    );
    expect(after.bid_end_date).toBe(newBid);
  });

  // In restricted-edit mode the snapshot's bid_end_date MUST extend into the
  // future (assertEditDateConstraints fires before the restricted-edit guard,
  // so a past bid_end_date short-circuits with a date error rather than the
  // intended "Restricted edit: ..." rejection). We honor that contract by
  // always extending bid_end_date alongside the disallowed change we're
  // testing.

  it("bid past + tech-stuck → REJECTS modifying any other RFQ field (e.g. comment)", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    await plantTechStuck(rfq_id, productId);
    await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
       SELECT $1, rfq_no, $2, $2, 1, NOW() FROM tbl_rfq WHERE id=$1 RETURNING id`,
      [rfq_id, IDS.users.vendor_alpha]
    );
    const snap = await fetchSnapshot(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: {
          ...snap,
          bid_end_date: istString(7 * 86400_000), // valid extension
          comment: "trying to sneak in a comment change",
        },
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Restricted edit|only bid submission end date/i);

    // tbl_rfq.comment unchanged.
    const after = await db.one(`SELECT comment FROM tbl_rfq WHERE id=$1`, [rfq_id]);
    expect(after.comment).toBe("post-bid RFQ");
  });

  it("bid past + tech-stuck → REJECTS adding/removing products in restricted mode", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    await plantTechStuck(rfq_id, productId);
    await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
       SELECT $1, rfq_no, $2, $2, 1, NOW() FROM tbl_rfq WHERE id=$1 RETURNING id`,
      [rfq_id, IDS.users.vendor_alpha]
    );
    const snap = await fetchSnapshot(rfq_id);

    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.bid_end_date = istString(7 * 86400_000);
    tampered.products.push({
      id: null,
      product_variant_id: 2,
      variant: 0,
      product_name: "trying-to-add",
      comment: "",
      // Provide valid Quantity/Unit so assertProductQuantityAndUnit (which
      // runs against the snapshot before diff) passes and we reach the
      // restricted-mode product-add guard the test is actually asserting.
      specs: { Quantity: "10", Unit: "NOS" },
      files: { qap_file: [], spec_file: [], datasheet_file: [] },
      vendors: [],
      tech_eval_clauses: [],
    });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/cannot add new products|Restricted edit/i);
  });

  it("bid past + tech-stuck → ALLOWS adding new vendors (Refresh Vendors flow) when bid_end_date is also extended", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    await plantTechStuck(rfq_id, productId);
    await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
       SELECT $1, rfq_no, $2, $2, 1, NOW() FROM tbl_rfq WHERE id=$1 RETURNING id`,
      [rfq_id, IDS.users.vendor_alpha]
    );
    const snap = await fetchSnapshot(rfq_id);

    // Refresh Vendors UX: extend deadline AND add the new vendor in one snapshot.
    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.bid_end_date = istString(7 * 86400_000);
    tampered.products[0].vendors = [IDS.users.vendor_beta];

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const v = await db.oneOrNone(
      `SELECT user_id FROM tbl_rfq_product_vendors WHERE rfq_id=$1 AND user_id=$2`,
      [rfq_id, IDS.users.vendor_beta]
    );
    expect(v).not.toBeNull();
  });

  it.todo(
    "F-NOTIFY-001 (P2): refreshVendors MUST send a vendor-RFQ notification email to each newly-added vendor — today no email fires for the delta-set. Needs jest.unstable_mockModule on approvalEmails.sendVendorRfqNotification (or similar) to capture recipients."
  );
});

// ===========================================================================
//  Step 10 — tech-eval-UNSTARTABLE edit-unlock (restricted)
//
//  CONFIRMED PRODUCTION DEADLOCK, reproduced from RFQ 536289 (Orchid Hotel
//  Panchgani, Aug 2026). Six products each carried one technical clause. One of
//  31 invited vendors submitted a regret, came back and converted it into a
//  fully-priced 14-line quote via updateQuoteItems — which had no technical
//  check at all — and answered none of the clauses. Then the bid window closed.
//
//  Every downstream gate then held, correctly, and together they welded the RFQ
//  shut:
//    * addVendorResponse refuses a technical answer after bid_end_date, so the
//      vendor could not answer.
//    * getVendorScoresForTechEval derives its list from response rows, so the
//      buyer had nobody to score and the Technical Evaluation screen was blank.
//    * the commercial gate (vendorCondition) drops a vendor from EVERY product
//      unless they hold a pass somewhere on the RFQ, so all 14 priced lines
//      read as "awaiting quote".
//    * assertEditAllowed refused every edit, because "evaluation never started"
//      matched neither the dead-end nor the tech-stuck unlock branch — so
//      nobody could re-open the window to let the vendor answer.
//
//  The rule these tests pin: when the window has closed and a clause-bearing
//  product carries a real (non-regret) quote line that no vendor has fully
//  answered, the creator gets a RESTRICTED edit so they can extend the deadline.
//  And — the part that matters most — the unlock must NOT fire once a vendor has
//  actually answered, or it becomes a permanent hole in the bid window.
// ===========================================================================

describe("rfqController.update — Step 10: tech-eval-unstartable unlock (restricted)", () => {
  // A technical evaluation that HAS clauses but has NOT been run: no
  // blocked_insufficient_vendors, no cleared_vendors. This is the shape a
  // freshly-configured evaluation has, and the shape 536289 was stuck in.
  async function plantTechEvalWithClauses(rfq_id, productId, { clauseType = "clause", count = 1 } = {}) {
    const { id: evalId } = await db.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation
         (rfq_id, tbl_rfq_product_id, blocked_insufficient_vendors,
          total_passed_verified, required_passed_vendors, minimum_passing_score)
       VALUES ($1, $2, FALSE, 0, 5, 50) RETURNING id`,
      [rfq_id, productId]
    );
    const clauseIds = [];
    for (let i = 0; i < count; i++) {
      const { id } = await db.one(
        `INSERT INTO tbl_rfq_product_tech_evaluation_clauses
           (tbl_rfq_product_tech_evaluation_id, clause_text, weightage, clause_type)
         VALUES ($1, $2, 20, $3) RETURNING id`,
        [evalId, `Ocean Brand clause ${i + 1}`, clauseType]
      );
      clauseIds.push(id);
    }
    return { evalId, clauseIds };
  }

  // A quote WITH a line for the given product — the "real commercial interest"
  // half of the predicate. is_regret=1 carries no interest and must not unlock.
  async function plantQuoteWithLine(rfq_id, vendorId, productVariantId, { isRegret = 0 } = {}) {
    const { id: quoteId } = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, is_regret, "timestamp")
       SELECT $1, rfq_no, $2, $2, 1, $3, NOW() FROM tbl_rfq WHERE id=$1 RETURNING id`,
      [rfq_id, vendorId, isRegret]
    );
    await db.none(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, variant, unit_price,
          total_price, comment, delivery_period, quantity)
       SELECT $1, rfq_no, $2, $3, 0, 100, 1000, '', '7', '10'
         FROM tbl_rfq WHERE id=$1`,
      [rfq_id, quoteId, productVariantId]
    );
    return quoteId;
  }

  // A quote row with NO line for the clause-bearing product. hasQuotes is true
  // (so the zero-participation branch does not apply) but there is no
  // commercial interest in the gated product.
  async function plantQuoteWithoutLine(rfq_id, vendorId) {
    return db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
       SELECT $1, rfq_no, $2, $2, 1, NOW() FROM tbl_rfq WHERE id=$1 RETURNING id`,
      [rfq_id, vendorId]
    ).then((r) => r.id);
  }

  async function answerClauses(clauseIds, vendorId, response = "I Agree") {
    for (const clauseId of clauseIds) {
      await db.none(
        `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
           (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response, "timestamp")
         VALUES ($1, $2, $3, NOW())`,
        [clauseId, vendorId, response]
      );
    }
  }

  it("bid past + priced clause-bearing line + NOBODY answered → ALLOWS extending bid_end_date", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    await plantTechEvalWithClauses(rfq_id, productId);
    await plantQuoteWithLine(rfq_id, IDS.users.vendor_alpha, 1);
    const snap = await fetchSnapshot(rfq_id);

    const newBid = istString(7 * 86400_000);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: newBid } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const after = await db.one(`SELECT bid_end_date FROM tbl_rfq WHERE id=$1`, [rfq_id]);
    expect(after.bid_end_date).toBe(newBid);
  });

  // THE REGRESSION GUARD. If this ever goes green the unlock has become a
  // permanent hole in the bid window: any RFQ with a technical evaluation would
  // stay editable forever, whatever the vendors did.
  it("bid past + a vendor answered EVERY clause → still refuses the edit", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    const { clauseIds } = await plantTechEvalWithClauses(rfq_id, productId, { count: 2 });
    await plantQuoteWithLine(rfq_id, IDS.users.vendor_alpha, 1);
    await answerClauses(clauseIds, IDS.users.vendor_alpha);
    const snap = await fetchSnapshot(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: istString(7 * 86400_000) } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/bid window has closed/i);
  });

  // Partial answers are not answers: getVendorScoresForTechEval needs the FULL
  // clause set before is_passed stops being NULL, so one-of-two leaves the
  // evaluation just as unstartable.
  it("bid past + a vendor answered only SOME clauses → still unlocks", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    const { clauseIds } = await plantTechEvalWithClauses(rfq_id, productId, { count: 2 });
    await plantQuoteWithLine(rfq_id, IDS.users.vendor_alpha, 1);
    await answerClauses([clauseIds[0]], IDS.users.vendor_alpha);
    const snap = await fetchSnapshot(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: istString(7 * 86400_000) } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
  });

  // An empty string / 'N/A' is what a placeholder row carries (see
  // createEmptyVendorResponses); it is not an answer and must not re-lock.
  it("bid past + placeholder responses only ('' / 'N/A') → still unlocks", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    const { clauseIds } = await plantTechEvalWithClauses(rfq_id, productId, { count: 2 });
    await plantQuoteWithLine(rfq_id, IDS.users.vendor_alpha, 1);
    await answerClauses([clauseIds[0]], IDS.users.vendor_alpha, "");
    await answerClauses([clauseIds[1]], IDS.users.vendor_alpha, "N/A");
    const snap = await fetchSnapshot(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: istString(7 * 86400_000) } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
  });

  // No commercial interest in the gated product → not a deadlock. Without this
  // condition the flag fired on 37 production RFQs instead of the 1 that was
  // actually stuck.
  it("bid past + quote exists but NO line on the clause-bearing product → refuses", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    await plantTechEvalWithClauses(rfq_id, productId);
    await plantQuoteWithoutLine(rfq_id, IDS.users.vendor_alpha);
    const snap = await fetchSnapshot(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: istString(7 * 86400_000) } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/bid window has closed/i);
  });

  it("bid past + only a REGRET quote on the product → refuses", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    await plantTechEvalWithClauses(rfq_id, productId);
    await plantQuoteWithLine(rfq_id, IDS.users.vendor_alpha, 1, { isRegret: 1 });
    const snap = await fetchSnapshot(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: istString(7 * 86400_000) } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/bid window has closed/i);
  });

  // Sampling clauses are excluded from every other technical count in the
  // codebase (techEvalQuoteGate, rfqModel's tech_evaluation_status CTEs, both
  // vendor clients). A sampling-only evaluation asks nothing of the vendor, so
  // there is nothing for them to be stuck on.
  it("bid past + SAMPLING-only clauses → refuses (nothing for a vendor to answer)", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    await plantTechEvalWithClauses(rfq_id, productId, { clauseType: "sampling" });
    await plantQuoteWithLine(rfq_id, IDS.users.vendor_alpha, 1);
    const snap = await fetchSnapshot(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: istString(7 * 86400_000) } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/bid window has closed/i);
  });

  it("bid past + a vendor already holds a technical PASS → refuses", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    const { evalId } = await plantTechEvalWithClauses(rfq_id, productId);
    await plantQuoteWithLine(rfq_id, IDS.users.vendor_alpha, 1);
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors
         (tbl_rfq_product_tech_evaluation_id, vendor_id, status, is_verified, evaluation_round)
       VALUES ($1, $2, 1, TRUE, 1)`,
      [evalId, IDS.users.vendor_beta]
    );
    const snap = await fetchSnapshot(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: istString(7 * 86400_000) } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/bid window has closed/i);
  });

  // The unlock is RESTRICTED, exactly like the tech-stuck one: extend the
  // deadline and refresh vendors, nothing else. A creator must not be able to
  // rewrite the RFQ's terms after bids are in.
  it("bid past + unstartable → REJECTS modifying any other RFQ field", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    await plantTechEvalWithClauses(rfq_id, productId);
    await plantQuoteWithLine(rfq_id, IDS.users.vendor_alpha, 1);
    const snap = await fetchSnapshot(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: {
          ...snap,
          bid_end_date: istString(7 * 86400_000),
          comment: "rewriting the brief after bids are in",
        },
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Restricted edit/i);

    const after = await db.one(`SELECT comment FROM tbl_rfq WHERE id=$1`, [rfq_id]);
    expect(after.comment).toBe("post-bid RFQ");
  });

  it("bid past + unstartable → REJECTS modifying technical evaluation clauses", async () => {
    const rfq_id = await makeBidPastRfq();
    const productId = await attachProduct(rfq_id, 1);
    await plantTechEvalWithClauses(rfq_id, productId);
    await plantQuoteWithLine(rfq_id, IDS.users.vendor_alpha, 1);
    const snap = await fetchSnapshot(rfq_id);

    // Drop the clause the vendor is meant to answer — that would "resolve" the
    // deadlock by deleting the buyer's own requirement, and is not allowed.
    const products = (snap.products || []).map((p) => ({ ...p, tech_eval_clauses: [] }));
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: { ...snap, bid_end_date: istString(7 * 86400_000), products },
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Restricted edit/i);
  });
});
