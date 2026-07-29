// Wave-1 step-3.7 tests: vendor quote submission gates
// (`rfqController.createQuote`) and quote update gates
// (`rfqController.updateQuoteItems`).
//
// Per testing convention, every test calls the production controller directly
// with a mocked req/res. We focus on the **gate logic** (the rejection paths)
// because they're (a) where the bugs live and (b) testable without the full
// RFQ-products + vendor-mapping + quote-items insert path. The end-to-end
// happy path will be exercised via the PO/finalize test, which requires a
// real submitted quote anyway.
//
// Architectural defects this suite documents (NEW finding):
//   - **F-USERTYPE-QUOTE (P1)** — `createQuote` rejects with
//     `user.user_type != 3 && != 4`. Violates the architectural rule that
//     `tbl_users.user_type` is unused; vendor permission should be derived
//     via RBAC scope. Logged in AUDIT_REPORT.md §7.
//   - **F-QUOTE-001 (P1)** — `createQuote` does NOT check the vendor's
//     subscription status; the only enforcement happens in the
//     `requireActiveSubscriptionIfAuthenticated` middleware at the route
//     layer, AND that middleware itself gates on user_type=3 (so it skips
//     the check entirely if user_type is anything else). Lapsed-was-active
//     vendors with non-3 user_type can submit quotes.
//
// Both gates are LOCKED IN by the tests below — if production removes the
// user_type check (the desired fix), these tests must be updated.

import {
  describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import rfqController from "../../app/controllers/rfq/rfqController.js";
import { makeRFQ } from "../factories/rfq.js";
import pricingEngine from "../../app/services/pricingEngine.js";

afterAll(async () => {
  await closeDb();
});

// Express req/res mock that captures status/json calls.
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
      files: opts.files || [],
    },
    res,
    next: jest.fn(),
    calls,
  };
}

// Vendor user shape that exists in fixtures AND has the user_type the
// production code (incorrectly) expects. user_type=3 = legacy vendor convention;
// see F-USERTYPE-QUOTE.
function vendorUser(userId = IDS.users.vendor_alpha) {
  return { id: userId, user_type: 3, company_id: IDS.companies.vendorAlpha };
}

// Tracks RFQs we insert so afterEach can clean them up. We don't truncate
// dynamic tables wholesale because other suites may run in the same DB.
const inserted = { rfqIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
});

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  // Order matters: clarification messages → clarifications → finalizations →
  // negotiation rounds → quotes → rfq products/vendors → rfq itself.
  await db.none(
    `DELETE FROM tbl_rfq_clarification_message_files
     WHERE message_id IN (
       SELECT m.id FROM tbl_rfq_clarification_messages m
       JOIN tbl_rfq_clarifications c ON c.id = m.clarification_id
       WHERE c.rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_rfq_clarification_messages
     WHERE clarification_id IN (SELECT id FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_quotes_payment_terms WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  // tbl_quote_item_history references tbl_quote_items.id (no schema FK, so
  // we delete history first to keep dropTestDb clean across runs).
  await db.none(
    `DELETE FROM tbl_quote_item_history
     WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_quote_item_files
     WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

// Returns an IST-interpretable string `offsetMs` ahead of now. The controller
// parses this string AS IST (subtracts 5h30m), so we add the offset BEFORE
// formatting to compensate.
function istString(offsetMs) {
  const ist = new Date(Date.now() + offsetMs + 5.5 * 3600_000);
  return ist.toISOString().replace("T", " ").slice(0, 19);
}

// ---- Setup helpers ---------------------------------------------------------

/**
 * Create a Published RFQ with bid window currently OPEN (bid_end > now)
 * and clarification window CLOSED (vendor_clarification_date < now). This is
 * the canonical "quote-submission-allowed" state; tests that want to trigger
 * a specific gate override the relevant date.
 */
async function makeOpenRfq(overrides = {}) {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
  const fiveDaysHence = new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    tender_publish_date: oneDayAgo,
    vendor_clarification_date: oneHourAgo, // clarification ENDED — quote allowed
    bid_end_date: fiveDaysHence, // still open
    ...overrides,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

/**
 * Grant the vendor access to the RFQ via tbl_rfq_product_vendors. The model's
 * user_rfq_access_review uses this table to validate the vendor can quote.
 * We add a stub product + vendor mapping so the access check passes; without
 * this the gate tests would all fail at the access check instead of the gate
 * we want to exercise.
 */
async function attachVendorRfqAccess(rfq_id, vendorId) {
  // tbl_rfq_products NOT NULL no-default: comment, datasheet, spec_file,
  //   qap_file, product_variant_id, qap. `variant` is INTEGER NULLABLE.
  // We use real seeded variant id=1 (BEVERAGES family).
  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0)
     RETURNING id`,
    [rfq_id]
  );
  // tbl_rfq_product_vendors.variant is INTEGER NULLABLE.
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, 1, $2, 0)`,
    [rfq_id, vendorId]
  );
  return product.id;
}

// ===========================================================================
//  createQuote — permission + status gates
// ===========================================================================

describe("createQuote — permission gate (F-USERTYPE-QUOTE — locks current user_type-based behaviour)", () => {
  it("rejects a buyer-side user (user_type=1) with 'no permission to submit quotation'", async () => {
    const rfq_id = await makeOpenRfq();
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, user_type: 1 },
      body: { rfq_id, rfq_no: 1, products: [] },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/permission to submit/i);
  });

  it("rejects a non-vendor with user_type=2 (Tender Creator)", async () => {
    const rfq_id = await makeOpenRfq();
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, user_type: 2 },
      body: { rfq_id, rfq_no: 1, products: [] },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
  });

  // The ONLY user_types that pass: 3 (vendor) and 4 (vendor admin). This is
  // an architectural defect logged as F-USERTYPE-QUOTE — we lock it in here
  // so the fix is intentional, not accidental.
});

describe("createQuote — RFQ-status + window gates", () => {
  it("rejects when RFQ is CLOSED (status=2)", async () => {
    const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
    const fiveDaysHence = new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      status: 2,
      is_published: 0,
      tender_publish_date: oneDayAgo,
      vendor_clarification_date: oneHourAgo,
      bid_end_date: fiveDaysHence,
    });
    inserted.rfqIds.push(rfq_id);
    await attachVendorRfqAccess(rfq_id, IDS.users.vendor_alpha);

    const m = mockExpress({
      user: vendorUser(),
      body: { rfq_id, rfq_no: 1, products: [] },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/RFQ is Closed/i);
  });

  it("rejects when bid_end_date has passed AND no active negotiation rounds exist", async () => {
    const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
    const halfHourAgo = new Date(Date.now() - 1800_000).toISOString().replace("T", " ").slice(0, 19);
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      status: 1,
      is_published: 1,
      tender_publish_date: oneDayAgo,
      vendor_clarification_date: oneHourAgo,
      bid_end_date: halfHourAgo, // already past
    });
    inserted.rfqIds.push(rfq_id);
    await attachVendorRfqAccess(rfq_id, IDS.users.vendor_alpha);

    const m = mockExpress({
      user: vendorUser(),
      body: { rfq_id, rfq_no: 1, products: [] },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    // Match either the plain or RA-flavoured rejection — both indicate the
    // gate fired. The exact wording depends on whether reverse_auction is set.
    expect(m.calls.body.message).toMatch(/Bidding Period.*Ended|Reverse Auction has Ended/i);
  });

  it("ALLOWS submission past bid_end_date when an ACTIVE negotiation round exists", async () => {
    // This locks the architectural rule: an active negotiation round
    // re-opens the quote window for the products in that round.
    const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
    const halfHourAgo = new Date(Date.now() - 1800_000).toISOString().replace("T", " ").slice(0, 19);
    const fiveDaysHence = new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      status: 1,
      is_published: 1,
      tender_publish_date: oneDayAgo,
      vendor_clarification_date: oneHourAgo,
      bid_end_date: halfHourAgo,
    });
    inserted.rfqIds.push(rfq_id);
    const productId = await attachVendorRfqAccess(rfq_id, IDS.users.vendor_alpha);

    // Insert an ACTIVE negotiation round for this product.
    await db.none(
      `INSERT INTO tbl_negotiation_rounds (rfq_id, rfq_product_id, status, end_date, created_by)
       VALUES ($1, $2, 'ACTIVE', NOW() + INTERVAL '1 day', $3)`,
      [rfq_id, productId, IDS.users.a1_proc_buyer]
    );

    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 1,
        products: [
          // No product_id supplied → controller's per-product check skips
          // (the gate at line 7450 — `if (!product.product_id ... continue`).
          // We exit BEFORE the insert path; this is a gate-passing assertion.
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    // The "Bidding Period has Ended" rejection should NOT fire.
    if (m.calls.status === 400) {
      expect(m.calls.body.message).not.toMatch(/Bidding Period has Ended/i);
    }
  });

  it("rejects when an OPEN clarification exists (any-vendor blocking)", async () => {
    const rfq_id = await makeOpenRfq();
    await attachVendorRfqAccess(rfq_id, IDS.users.vendor_alpha);
    // Vendor B raised a clarification — Vendor A's quote-send is blocked.
    await db.none(
      `INSERT INTO tbl_rfq_clarifications (rfq_id, raised_by, vendor_company_id, subject, question, status)
       VALUES ($1, $2, $3, 'sub', 'q', 'OPEN')`,
      [rfq_id, IDS.users.vendor_beta, IDS.companies.vendorBeta]
    );

    const m = mockExpress({
      user: vendorUser(IDS.users.vendor_alpha),
      body: { rfq_id, rfq_no: 1, products: [] },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/clarification/i);
    // Privacy: error must not leak the questioning vendor's name.
    expect(m.calls.body.message).not.toMatch(/beta/i);
  });

  it("rejects when the clarification window has not yet ended (now < vendor_clarification_date)", async () => {
    // The controller treats `vendor_clarification_date` as IST. Use istString
    // so that "1 day from now" is correctly in the future post-IST conversion.
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      status: 1,
      is_published: 1,
      tender_publish_date: istString(-2 * 86400_000),
      vendor_clarification_date: istString(86400_000), // 1 day in the future (IST)
      bid_end_date: istString(5 * 86400_000),
    });
    inserted.rfqIds.push(rfq_id);
    await attachVendorRfqAccess(rfq_id, IDS.users.vendor_alpha);

    const m = mockExpress({
      user: vendorUser(),
      body: { rfq_id, rfq_no: 1, products: [] },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/clarification period ends/i);
  });

  it("rejects when 'all products are finalized' for this vendor", async () => {
    const rfq_id = await makeOpenRfq();
    const productId = await attachVendorRfqAccess(rfq_id, IDS.users.vendor_alpha);
    // Insert a finalization row so checkAllProductsFinalized returns true.
    await db.none(
      `INSERT INTO tbl_quote_finalization (rfq_id, rfq_no, quote_id, product_variant_id, variant, vendor_id, created_by)
       VALUES ($1, 1, 0, 1, 0, $2, $3)`,
      [rfq_id, IDS.users.vendor_alpha, IDS.users.a1_proc_buyer]
    );

    const m = mockExpress({
      user: vendorUser(),
      body: { rfq_id, rfq_no: 1, products: [] },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/All Products are Finalized/i);
    // Cleanup the finalization row.
    await db.none(
      `DELETE FROM tbl_quote_finalization WHERE rfq_id=$1 AND vendor_id=$2`,
      [rfq_id, IDS.users.vendor_alpha]
    );
  });
});

// ===========================================================================
//  updateQuoteItems — quote existence + status + window gates
// ===========================================================================

describe("updateQuoteItems — gates", () => {
  it("F-QUOTE-NOTFOUND-001 — quote-not-found returns 404 with a clear message (not a 500 crash)", async () => {
    // POST-FIX: when the requested quote does not exist, `updateQuoteItems`
    // returns 404 with a "quote not found" message — NOT an HTTP 500 from
    // dereferencing `quoteExists[0]`. Today the guard `if (!quoteExists)`
    // at rfqController.js:12405 fails to fire because checkIfExists returns
    // an empty array (truthy), so the next line crashes. Fix: change the
    // guard to `if (!quoteExists || quoteExists.length === 0)`, or have
    // checkIfExists return null on no-match.
    const m = mockExpress({
      user: vendorUser(),
      params: { quoteId: "999999999" },
      body: { rfq_id: 1, rfq_no: 1, products: [{ product_id: 1 }] },
    });
    await rfqController.updateQuoteItems(m.req, m.res, m.next);
    expect(m.calls.status).toBe(404);
    expect(m.calls.body.message).toMatch(/quote.*not.*found|not.*found.*quote/i);
  });

  it("returns 400 when products miss product_id", async () => {
    const m = mockExpress({
      user: vendorUser(),
      params: { quoteId: "1" },
      body: { rfq_id: 1, rfq_no: 1, products: [{ /* no product_id */ }] },
    });
    await rfqController.updateQuoteItems(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Missing required fields/i);
  });

  it("rejects when the quote's RFQ is CLOSED (status=2)", async () => {
    const rfq_id = await makeOpenRfq({ status: 2 });
    // Seed a real quote to update.
    const quote = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
       VALUES ($1, 1, $2, $2) RETURNING id`,
      [rfq_id, IDS.users.vendor_alpha]
    );

    const m = mockExpress({
      user: vendorUser(),
      params: { quoteId: String(quote.id) },
      body: { rfq_id, rfq_no: 1, products: [{ product_id: 1 }] },
    });
    await rfqController.updateQuoteItems(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/RFQ is Closed/i);
  });

  it("rejects when bid_end_date has passed AND no active negotiation round", async () => {
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
    const halfHourAgo = new Date(Date.now() - 1800_000).toISOString().replace("T", " ").slice(0, 19);
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      status: 1,
      is_published: 1,
      tender_publish_date: oneHourAgo,
      vendor_clarification_date: oneHourAgo,
      bid_end_date: halfHourAgo,
    });
    inserted.rfqIds.push(rfq_id);
    const quote = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
       VALUES ($1, 1, $2, $2) RETURNING id`,
      [rfq_id, IDS.users.vendor_alpha]
    );

    const m = mockExpress({
      user: vendorUser(),
      params: { quoteId: String(quote.id) },
      body: { rfq_id, rfq_no: 1, products: [{ product_id: 1 }] },
    });
    await rfqController.updateQuoteItems(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Bidding Period.*Ended|Reverse Auction has Ended/i);
  });

  it("rejects when 'all products are finalized' for this vendor", async () => {
    const rfq_id = await makeOpenRfq();
    await attachVendorRfqAccess(rfq_id, IDS.users.vendor_alpha);
    const quote = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
       VALUES ($1, 1, $2, $2) RETURNING id`,
      [rfq_id, IDS.users.vendor_alpha]
    );
    await db.none(
      `INSERT INTO tbl_quote_finalization (rfq_id, rfq_no, quote_id, product_variant_id, variant, vendor_id, created_by)
       VALUES ($1, 1, 0, 1, 0, $2, $3)`,
      [rfq_id, IDS.users.vendor_alpha, IDS.users.a1_proc_buyer]
    );

    const m = mockExpress({
      user: vendorUser(),
      params: { quoteId: String(quote.id) },
      body: { rfq_id, rfq_no: 1, products: [{ product_id: 1 }] },
    });
    await rfqController.updateQuoteItems(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/All Products are Finalized/i);
    await db.none(
      `DELETE FROM tbl_quote_finalization WHERE rfq_id=$1 AND vendor_id=$2`,
      [rfq_id, IDS.users.vendor_alpha]
    );
  });

  // F-QUOTE-001 closed 2026-05-03: route-level middleware
  // (requireActiveSubscriptionIfAuthenticated → hasValidPaidSubscription)
  // already enforces vhcs.status='active' AND end_date >= CURRENT_DATE.
  // Remaining vendor-identification concern is covered by F-USERTYPE-QUOTE.
});

// ===========================================================================
//  createQuote — happy paths
// ===========================================================================

/**
 * Build an open RFQ with two `tbl_rfq_products` rows on real seeded variants,
 * vendor mapped to both via `tbl_rfq_product_vendors`. Mirrors the canonical
 * "vendor can submit" state. Returns rfq_id + the inserted rfq_product rows.
 */
async function makeRfqWithProducts(vendorId = IDS.users.vendor_alpha) {
  const rfq_id = await makeOpenRfq();
  const productA = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id, product_variant_id, variant`,
    [rfq_id]
  );
  const productB = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 2, 0) RETURNING id, product_variant_id, variant`,
    [rfq_id]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, 1, $2, 0), ($1, 2, $2, 0)`,
    [rfq_id, vendorId]
  );
  return { rfq_id, productA, productB };
}

describe("createQuote — happy paths", () => {
  it("creates tbl_quotes + tbl_quote_items rows for a multi-product submission", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        products: [
          { product_id: 1, variant: 0, unit_price: 100, tax: 18, total_price: 118, comment: "p1", delivery_period: "7d", quantity: "10", tax_mode: "percentage", other_charges: [] },
          { product_id: 2, variant: 0, unit_price: 250, tax: 18, total_price: 295, comment: "p2", delivery_period: "10d", quantity: "5", tax_mode: "percentage", other_charges: [] },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const quotes = await db.any(
      `SELECT id, rfq_id, created_by, is_regret FROM tbl_quotes WHERE rfq_id=$1`,
      [rfq_id]
    );
    expect(quotes.length).toBe(1);
    expect(quotes[0].created_by).toBe(IDS.users.vendor_alpha);
    expect(quotes[0].is_regret).toBe(0);

    const items = await db.any(
      `SELECT product_variant_id, unit_price, total_price
       FROM tbl_quote_items WHERE quote_id=$1 ORDER BY product_variant_id`,
      [quotes[0].id]
    );
    expect(items.length).toBe(2);
    expect(parseFloat(items[0].unit_price)).toBe(100);
    expect(parseFloat(items[1].unit_price)).toBe(250);
  });

  it("regret submission: is_regret=1 + regret_reason → quote inserted with is_regret flag set", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        is_regret: 1, regret_reason: "Cannot fulfil this RFQ at the requested terms",
        products: [
          { product_id: 1, variant: 0, unit_price: "", tax: 0, total_price: 0, comment: "", delivery_period: "", quantity: "0", tax_mode: "percentage", other_charges: [] },
          { product_id: 2, variant: 0, unit_price: "", tax: 0, total_price: 0, comment: "", delivery_period: "", quantity: "0", tax_mode: "percentage", other_charges: [] },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.message).toMatch(/regretted/i);

    const quote = await db.one(
      `SELECT is_regret, regret_reason FROM tbl_quotes WHERE rfq_id=$1`,
      [rfq_id]
    );
    expect(quote.is_regret).toBe(1);
    expect(quote.regret_reason).toMatch(/cannot fulfil/i);
  });

  it("globalPaymentTerms + global_charges populate the quote row's columns", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        globalPaymentTerms: "30 days net",
        globalComment: "all-product comment",
        global_charges: [{ name: "Loading", value: 50 }, { name: "Insurance", value: 20 }],
        products: [
          { product_id: 1, variant: 0, unit_price: 100, tax: 18, total_price: 118, comment: "", delivery_period: "7d", quantity: "10", tax_mode: "percentage", other_charges: [] },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const q = await db.one(
      `SELECT global_payment_term, global_comment, global_charges FROM tbl_quotes WHERE rfq_id=$1`,
      [rfq_id]
    );
    expect(q.global_payment_term).toBe("30 days net");
    expect(q.global_comment).toBe("all-product comment");
    // global_charges is JSONB; comparison-by-name validates round-trip including
    // controller's slug-enrichment.
    const charges = Array.isArray(q.global_charges) ? q.global_charges : JSON.parse(q.global_charges || "[]");
    const names = charges.map((c) => c.name).sort();
    expect(names).toEqual(["Insurance", "Loading"]);
  });
});

// ===========================================================================
//  updateQuoteItems — happy paths
// ===========================================================================

describe("updateQuoteItems — happy paths", () => {
  async function seedQuote(rfq_id) {
    // Submit a quote first so we can update it.
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        products: [
          { product_id: 1, variant: 0, unit_price: 100, tax: 18, total_price: 118, comment: "initial", delivery_period: "7d", quantity: "10", tax_mode: "percentage", other_charges: [] },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);
    return await db.one(`SELECT id FROM tbl_quotes WHERE rfq_id=$1`, [rfq_id]);
  }

  it("updates an existing quote's items + global fields; tbl_quote_items reflects the change", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const quote = await seedQuote(rfq_id);

    const m = mockExpress({
      user: vendorUser(),
      params: { quoteId: String(quote.id) },
      body: {
        rfq_id, rfq_no: 12345,
        globalPaymentTerms: "60 days credit",
        globalComment: "updated comment",
        global_charges: [],
        global_payment_term_list: { createdTerms: [], updatedTerms: [], deletedTerms: [] },
        products: [
          { product_id: 1, variant: 0, unit_price: 95, tax: 18, total_price: 112.1, comment: "revised", delivery_period: "5d", quantity: "10", tax_mode: "percentage", other_charges: [] },
        ],
      },
    });
    await rfqController.updateQuoteItems(m.req, m.res, m.next);
    // updateQuoteItems doesn't always set status=200 explicitly; assert the row state directly.
    const item = await db.one(
      `SELECT unit_price, total_price, comment, delivery_period
       FROM tbl_quote_items WHERE quote_id=$1`,
      [quote.id]
    );
    expect(parseFloat(item.unit_price)).toBe(95);
    expect(item.comment).toBe("revised");
    expect(item.delivery_period).toBe("5d");

    const q = await db.one(
      `SELECT global_payment_term, global_comment FROM tbl_quotes WHERE id=$1`,
      [quote.id]
    );
    expect(q.global_payment_term).toBe("60 days credit");
    expect(q.global_comment).toBe("updated comment");
  });

  it("preserves audit trail in tbl_quote_item_history when an item is updated", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const quote = await seedQuote(rfq_id);

    const m = mockExpress({
      user: vendorUser(),
      params: { quoteId: String(quote.id) },
      body: {
        rfq_id, rfq_no: 12345,
        globalPaymentTerms: null, globalComment: null,
        global_payment_term_list: { createdTerms: [], updatedTerms: [], deletedTerms: [] },
        products: [
          { product_id: 1, variant: 0, unit_price: 90, tax: 18, total_price: 106.2, comment: "rev2", delivery_period: "3d", quantity: "10", tax_mode: "percentage", other_charges: [] },
        ],
      },
    });
    await rfqController.updateQuoteItems(m.req, m.res, m.next);

    // History row holds the PRE-update state (unit_price=100 from seedQuote).
    const history = await db.any(
      `SELECT unit_price, comment FROM tbl_quote_item_history
       WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE quote_id=$1)
       ORDER BY id ASC`,
      [quote.id]
    );
    expect(history.length).toBeGreaterThan(0);
    expect(parseFloat(history[0].unit_price)).toBe(100);
    expect(history[0].comment).toBe("initial");
  });
});

// ===========================================================================
//  MRP (tax-inclusive) quoting — createQuote + updateQuoteItems
//  Spec: .pipeline/spec.md §4, §8, §9.
//
//  Covers: server-authoritative derivation (unit_price/total_price are
//  computed from entered_mrp/mrp_discount/gst via deriveMrpLine — NEVER
//  trusted from the client, even when the client also sends a bogus
//  unit_price/total_price); audit-column persistence on BOTH duplicated
//  write paths (§8.7's divergence risk); round-trip to the entered MRP
//  within 0.01; backward compat for a Traditional (no pricing_method) line;
//  and explicit failure cases (entered_mrp <= 0, a zeroing discount).
// ===========================================================================

describe("MRP (tax-inclusive) quoting — createQuote", () => {
  it("derives unit_price/total_price from entered_mrp server-side, discarding a client-supplied unit_price/total_price", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        pricing_method: "MRP",
        products: [
          {
            product_id: 1, variant: 0,
            pricing_method: "MRP",
            entered_mrp: 1180, mrp_discount: "", mrp_discount_mode: "percentage",
            unit_price: 999999, tax: 18, total_price: 424242, // garbage — must be discarded
            comment: "mrp line", delivery_period: "7d", quantity: "1",
            tax_mode: "percentage", other_charges: [],
          },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const quote = await db.one(`SELECT id, pricing_method FROM tbl_quotes WHERE rfq_id=$1`, [rfq_id]);
    expect(quote.pricing_method).toBe("MRP");

    const item = await db.one(
      `SELECT unit_price, total_price, pricing_method, entered_mrp, mrp_discount, mrp_discount_mode
       FROM tbl_quote_items WHERE quote_id=$1`,
      [quote.id]
    );
    // base = 1180 / 1.18 = 1000 exactly — NOT the client's 999999.
    expect(parseFloat(item.unit_price)).toBe(1000);
    expect(item.pricing_method).toBe("MRP");
    expect(parseFloat(item.entered_mrp)).toBe(1180);
    expect(item.mrp_discount).toBeNull();
    expect(item.mrp_discount_mode).toBe("percentage");
    // total_price = 1000 * 1 * 1.18 = 1180 exactly — reproduces the entered
    // MRP (qty=1) and is NOT the client's 424242.
    expect(parseFloat(item.total_price)).toBe(1180);
  });

  it("forces percentage GST on an MRP line even when the client sends tax_mode='absolute' (round-trip preserved)", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        pricing_method: "MRP",
        products: [
          {
            product_id: 1, variant: 0,
            pricing_method: "MRP",
            entered_mrp: 1180, mrp_discount: "", mrp_discount_mode: "percentage",
            unit_price: "", tax: 18, total_price: 0,
            comment: "mrp abs-tamper", delivery_period: "7d", quantity: "1",
            tax_mode: "absolute", other_charges: [], // client tampers with an absolute GST mode
          },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const item = await db.one(
      `SELECT unit_price, tax, tax_mode, total_price FROM tbl_quote_items
       WHERE quote_id = (SELECT id FROM tbl_quotes WHERE rfq_id=$1)`,
      [rfq_id]
    );
    // The server must IGNORE the client's absolute tax_mode and store percentage,
    // so the engine re-adds 18% (not a flat ₹18) and the total reproduces the
    // entered MRP: base 1000, total 1000 * 1.18 = 1180 — NOT 1000 + 18 = 1018.
    expect(item.tax_mode).toBe("percentage");
    expect(parseFloat(item.unit_price)).toBe(1000);
    expect(parseFloat(item.total_price)).toBe(1180);
  });

  it("fractional MRP round-trips to the entered inclusive within 0.01", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        products: [
          {
            product_id: 1, variant: 0,
            pricing_method: "MRP",
            entered_mrp: 100, mrp_discount: "", mrp_discount_mode: "percentage",
            unit_price: "", tax: 18, total_price: 0,
            comment: "", delivery_period: "7d", quantity: "1",
            tax_mode: "percentage", other_charges: [],
          },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const item = await db.one(
      `SELECT unit_price, total_price FROM tbl_quote_items
       WHERE quote_id = (SELECT id FROM tbl_quotes WHERE rfq_id=$1)`,
      [rfq_id]
    );
    // deriveMrpLine({mrp:100, gst_pct:18}).base === 84.75 (q2'd once in the helper).
    expect(parseFloat(item.unit_price)).toBe(84.75);
    // Engine round-trip: 84.75 * 1.18 = 100.005 → q2 → 100.01, within the spec's
    // accepted 0.01 tolerance of the entered 100.
    expect(parseFloat(item.total_price)).toBe(100.01);
    expect(Math.abs(parseFloat(item.total_price) - 100)).toBeLessThanOrEqual(0.011);
  });

  it("applies a percentage discount to MRP before extracting GST", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        products: [
          {
            product_id: 1, variant: 0,
            pricing_method: "MRP",
            entered_mrp: 1180, mrp_discount: 10, mrp_discount_mode: "percentage",
            unit_price: "", tax: 18, total_price: 0,
            comment: "", delivery_period: "7d", quantity: "1",
            tax_mode: "percentage", other_charges: [],
          },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const item = await db.one(
      `SELECT unit_price, mrp_discount, mrp_discount_mode FROM tbl_quote_items
       WHERE quote_id = (SELECT id FROM tbl_quotes WHERE rfq_id=$1)`,
      [rfq_id]
    );
    // net = 1180 - 10% = 1062; base = 1062 / 1.18 = 900 exactly.
    expect(parseFloat(item.unit_price)).toBe(900);
    expect(parseFloat(item.mrp_discount)).toBe(10);
    expect(item.mrp_discount_mode).toBe("percentage");
  });

  it("a Traditional (no pricing_method) line is unaffected — backward compatible", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        products: [
          { product_id: 1, variant: 0, unit_price: 100, tax: 18, total_price: 118, comment: "trad", delivery_period: "7d", quantity: "10", tax_mode: "percentage", other_charges: [] },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const quote = await db.one(`SELECT id, pricing_method FROM tbl_quotes WHERE rfq_id=$1`, [rfq_id]);
    expect(quote.pricing_method).toBe("TRADITIONAL");

    const item = await db.one(
      `SELECT unit_price, total_price, pricing_method, entered_mrp, mrp_discount, mrp_discount_mode
       FROM tbl_quote_items WHERE quote_id=$1`,
      [quote.id]
    );
    expect(parseFloat(item.unit_price)).toBe(100);
    expect(parseFloat(item.total_price)).toBe(1180); // 100 * 10 * 1.18, same formula as before MRP existed
    expect(item.pricing_method).toBe("TRADITIONAL");
    expect(item.entered_mrp).toBeNull();
    expect(item.mrp_discount).toBeNull();
    expect(item.mrp_discount_mode).toBeNull();
  });

  // ---- Failure cases ----

  it("rejects an MRP line with entered_mrp <= 0 — nothing is persisted", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        products: [
          {
            product_id: 1, variant: 0, product_name: "Widget",
            pricing_method: "MRP",
            entered_mrp: 0, mrp_discount: "", mrp_discount_mode: "percentage",
            unit_price: "", tax: 18, total_price: 0,
            comment: "", delivery_period: "7d", quantity: "1",
            tax_mode: "percentage", other_charges: [],
          },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/MRP must be greater than 0/i);

    const quoteCount = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_quotes WHERE rfq_id=$1`, [rfq_id]);
    expect(quoteCount.n).toBe(0);
  });

  it("rejects a discount that zeroes the net (>= 100% of MRP)", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        products: [
          {
            product_id: 1, variant: 0, product_name: "Widget",
            pricing_method: "MRP",
            entered_mrp: 1000, mrp_discount: 100, mrp_discount_mode: "percentage",
            unit_price: "", tax: 18, total_price: 0,
            comment: "", delivery_period: "7d", quantity: "1",
            tax_mode: "percentage", other_charges: [],
          },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/discount is invalid/i);
  });

  // ── Gap 4: other_charges stay enabled and ADD ON TOP of the MRP-derived
  // base — MRP only governs the goods price, not per-line charges. ────────
  it("MRP line with an other_charge: derived base is unaffected, and the charge (+ its own tri-state tax) adds ON TOP of the base", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        products: [
          {
            product_id: 1, variant: 0,
            pricing_method: "MRP",
            entered_mrp: 1180, mrp_discount: "", mrp_discount_mode: "percentage",
            unit_price: "", tax: 18, total_price: 0,
            comment: "mrp with freight", delivery_period: "7d", quantity: "1",
            tax_mode: "percentage",
            other_charges: [
              { name: "Freight", amount: 200, amount_mode: "absolute", tax: 10, tax_mode: "percentage", comment: "freight chg" },
            ],
          },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const item = await db.one(
      `SELECT unit_price, total_price, other_charges FROM tbl_quote_items
       WHERE quote_id = (SELECT id FROM tbl_quotes WHERE rfq_id=$1)`,
      [rfq_id]
    );
    // base = 1180 / 1.18 = 1000 — the freight charge does NOT alter the MRP derivation.
    expect(parseFloat(item.unit_price)).toBe(1000);

    const charges = Array.isArray(item.other_charges) ? item.other_charges : JSON.parse(item.other_charges || "[]");
    // Charge amount/tax are computed independently of the MRP base — a flat
    // ₹200 with its own explicit 10% tax (₹20), NOT scaled/derived from the
    // MRP or discount math.
    expect(pricingEngine.calculateLineTotal({
      unit_price: 1000, quantity: 1, tax: 18, tax_mode: "percentage", other_charges: charges,
    }).total).toBe(1400);
    // total = base*(1+gst%) + charge(+its own tax) = 1180 (base+basetax) + 220.
    expect(parseFloat(item.total_price)).toBe(1400);
  });

  // ── Gap 6: absolute (₹) discount, not just percentage ──────────────────
  it("an absolute (₹) MRP discount derives the correct base — MRP 1180 less ₹118 → net 1062 → base 900 → total 1062", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        products: [
          {
            product_id: 1, variant: 0,
            pricing_method: "MRP",
            entered_mrp: 1180, mrp_discount: 118, mrp_discount_mode: "absolute",
            unit_price: "", tax: 18, total_price: 0,
            comment: "", delivery_period: "7d", quantity: "1",
            tax_mode: "percentage", other_charges: [],
          },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const item = await db.one(
      `SELECT unit_price, total_price, mrp_discount, mrp_discount_mode FROM tbl_quote_items
       WHERE quote_id = (SELECT id FROM tbl_quotes WHERE rfq_id=$1)`,
      [rfq_id]
    );
    // net = 1180 - 118 = 1062; base = 1062 / 1.18 = 900 exactly.
    expect(parseFloat(item.unit_price)).toBe(900);
    expect(parseFloat(item.mrp_discount)).toBe(118);
    expect(item.mrp_discount_mode).toBe("absolute");
    expect(parseFloat(item.total_price)).toBe(1062);
  });

  // ── Gap 7: gst=0 is a valid MRP line, not an error ─────────────────────
  it("an MRP line with gst=0 → base equals the entered MRP exactly, total has no tax, not an error", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        products: [
          {
            product_id: 1, variant: 0,
            pricing_method: "MRP",
            entered_mrp: 1000, mrp_discount: "", mrp_discount_mode: "percentage",
            unit_price: "", tax: 0, total_price: 0,
            comment: "", delivery_period: "7d", quantity: "1",
            tax_mode: "percentage", other_charges: [],
          },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    const item = await db.one(
      `SELECT unit_price, total_price FROM tbl_quote_items
       WHERE quote_id = (SELECT id FROM tbl_quotes WHERE rfq_id=$1)`,
      [rfq_id]
    );
    // gst=0 → nothing to extract → base === entered MRP exactly, and the
    // total (no tax) also equals the entered MRP. Not an error.
    expect(parseFloat(item.unit_price)).toBe(1000);
    expect(parseFloat(item.total_price)).toBe(1000);
  });

  // ── Gap 5 (RFQ half): downstream buyer-side reader parity ───────────────
  //
  // Proving the FULL HTTP quote-comparison-view path (GET
  // /rfq/quote-comparison-view/:id) is disproportionately heavy for this
  // suite: it requires deriveScope headers, a `quotes_locked`/deadline gate,
  // optional tech-eval wiring, and finalization/approval fixtures — see the
  // dedicated 900+ line `tests/services/rfq.quoteComparisonView.test.js`
  // suite that already exists purely to set that up.
  //
  // Instead we assert at the model-READ level, using the EXACT same formula
  // the comparison pipeline uses: `quoteCompareService.enrichQuoteCompareData`
  // reads `merged.unit_price` / `merged.tax` / `merged.tax_mode` off the
  // fetched quote row (no `pricing_method`/`entered_mrp` awareness at all —
  // see quoteCompareService.js L107-110) and feeds them straight into
  // `pricingEngine.calculateLineTotal` — the identical function
  // `createQuote`'s own server-authoritative recompute uses. So: read the
  // MRP row's persisted `unit_price`/`tax`/`tax_mode` (with NO `entered_mrp`/
  // `pricing_method` in the read), run them through `calculateLineTotal`
  // exactly as the comparison view would, and confirm the recomputed total
  // reproduces the entered MRP identically — proving a downstream reader
  // with zero MRP-specific code renders this row correctly.
  it("downstream reader parity: stored unit_price/tax/tax_mode alone (no MRP awareness) reproduce the entered MRP via the same formula quote-comparison uses", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        products: [
          {
            product_id: 1, variant: 0,
            pricing_method: "MRP",
            entered_mrp: 1180, mrp_discount: "", mrp_discount_mode: "percentage",
            unit_price: "", tax: 18, total_price: 0,
            comment: "", delivery_period: "7d", quantity: "1",
            tax_mode: "percentage", other_charges: [],
          },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);

    // Read back ONLY the fields a downstream reader like
    // quoteCompareService.enrichQuoteCompareData would read (unit_price, tax,
    // tax_mode, quantity, other_charges) — deliberately NOT selecting
    // pricing_method/entered_mrp/mrp_discount, to simulate an MRP-unaware reader.
    const row = await db.one(
      `SELECT unit_price, tax, tax_mode, quantity, other_charges, total_price
       FROM tbl_quote_items WHERE quote_id = (SELECT id FROM tbl_quotes WHERE rfq_id=$1)`,
      [rfq_id]
    );
    const oc = Array.isArray(row.other_charges) ? row.other_charges : JSON.parse(row.other_charges || "[]");
    const landed = pricingEngine.calculateLineTotal({
      unit_price: row.unit_price,
      quantity: row.quantity,
      tax: row.tax,
      tax_mode: row.tax_mode,
      other_charges: oc,
    });
    // The MRP-unaware recompute reproduces the entered MRP exactly (1180),
    // matching both the stored total_price and the original entered_mrp.
    expect(landed.total).toBe(1180);
    expect(landed.total).toBe(parseFloat(row.total_price));
  });
});

describe("MRP (tax-inclusive) quoting — updateQuoteItems (parity with createQuote)", () => {
  async function seedTraditionalQuote(rfq_id) {
    const m = mockExpress({
      user: vendorUser(),
      body: {
        rfq_id, rfq_no: 12345, status: 1,
        products: [
          { product_id: 1, variant: 0, unit_price: 100, tax: 18, total_price: 118, comment: "initial", delivery_period: "7d", quantity: "1", tax_mode: "percentage", other_charges: [] },
        ],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    expect(m.calls.status).toBe(200);
    return await db.one(`SELECT id FROM tbl_quotes WHERE rfq_id=$1`, [rfq_id]);
  }

  it("editing an existing Traditional line to MRP derives + persists identically to createQuote; the header updates; history carries the PRE-change (Traditional) state", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const quote = await seedTraditionalQuote(rfq_id);

    const m = mockExpress({
      user: vendorUser(),
      params: { quoteId: String(quote.id) },
      body: {
        rfq_id, rfq_no: 12345,
        globalPaymentTerms: null, globalComment: "switched to MRP", global_charges: [],
        global_payment_term_list: { createdTerms: [], updatedTerms: [], deletedTerms: [] },
        pricing_method: "MRP",
        products: [
          {
            product_id: 1, variant: 0,
            pricing_method: "MRP",
            entered_mrp: 1180, mrp_discount: "", mrp_discount_mode: "percentage",
            unit_price: 777777, tax: 18, total_price: 555555, // garbage — must be discarded
            comment: "now mrp", delivery_period: "5d", quantity: "1",
            tax_mode: "percentage", other_charges: [],
          },
        ],
      },
    });
    await rfqController.updateQuoteItems(m.req, m.res, m.next);

    const item = await db.one(
      `SELECT unit_price, total_price, pricing_method, entered_mrp, mrp_discount, mrp_discount_mode
       FROM tbl_quote_items WHERE quote_id=$1`,
      [quote.id]
    );
    // Same derivation as createQuote: base 1000, total 1180 exactly.
    expect(parseFloat(item.unit_price)).toBe(1000);
    expect(parseFloat(item.total_price)).toBe(1180);
    expect(item.pricing_method).toBe("MRP");
    expect(parseFloat(item.entered_mrp)).toBe(1180);

    // Header pricing_method updates too — the header-diff block fired because
    // globalComment changed (pricing_method is gated the same way, per §4c).
    const q = await db.one(`SELECT pricing_method FROM tbl_quotes WHERE id=$1`, [quote.id]);
    expect(q.pricing_method).toBe("MRP");

    // History row carries the PRE-change state (still Traditional, unit_price 100).
    const history = await db.one(
      `SELECT unit_price, pricing_method, entered_mrp
       FROM tbl_quote_item_history
       WHERE quote_item_id = (SELECT id FROM tbl_quote_items WHERE quote_id=$1)
       ORDER BY id DESC LIMIT 1`,
      [quote.id]
    );
    expect(parseFloat(history.unit_price)).toBe(100);
    expect(history.pricing_method).toBe("TRADITIONAL");
    expect(history.entered_mrp).toBeNull();
  });

  it("rejects an MRP line with entered_mrp <= 0 on the update path too (same guard as createQuote) — original line untouched", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const quote = await seedTraditionalQuote(rfq_id);

    const m = mockExpress({
      user: vendorUser(),
      params: { quoteId: String(quote.id) },
      body: {
        rfq_id, rfq_no: 12345,
        globalPaymentTerms: null, globalComment: null, global_charges: [],
        global_payment_term_list: { createdTerms: [], updatedTerms: [], deletedTerms: [] },
        products: [
          {
            product_id: 1, variant: 0, product_name: "Widget",
            pricing_method: "MRP",
            entered_mrp: -5, mrp_discount: "", mrp_discount_mode: "percentage",
            unit_price: "", tax: 18, total_price: 0,
            comment: "", delivery_period: "7d", quantity: "1",
            tax_mode: "percentage", other_charges: [],
          },
        ],
      },
    });
    await rfqController.updateQuoteItems(m.req, m.res, m.next);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/MRP must be greater than 0/i);

    const item = await db.one(`SELECT unit_price, pricing_method FROM tbl_quote_items WHERE quote_id=$1`, [quote.id]);
    expect(parseFloat(item.unit_price)).toBe(100);
    expect(item.pricing_method).toBe("TRADITIONAL");
  });

  // ── Gap 2 (DISCRIMINATING): the createQuote absolute-tamper guard has a
  // twin at rfqController.js ~L14059 (`updateQuoteItems` pre-normalization),
  // a SEPARATE code path with its own duplicated force. Without that force,
  // this edit's `tax_mode` would resolve to the client's 'absolute' and the
  // engine recompute at L14069-14079 (`tax_mode: product.tax_mode`) would
  // store total_price=1018 (base 1000 + flat ₹18), not 1180 (base * 1.18) —
  // exactly the undercharge bug §8.7 warns a divergent second guard chain
  // could reintroduce. WITH the force (present), tax_mode is stored as
  // 'percentage' and total_price reproduces the entered MRP (1180).
  it("forces percentage GST on an MRP line even when the client sends tax_mode='absolute' on the UPDATE path — DISCRIMINATING (updateQuoteItems has its own separate pre-normalization force)", async () => {
    const { rfq_id } = await makeRfqWithProducts();
    const quote = await seedTraditionalQuote(rfq_id);

    const m = mockExpress({
      user: vendorUser(),
      params: { quoteId: String(quote.id) },
      body: {
        rfq_id, rfq_no: 12345,
        globalPaymentTerms: null, globalComment: "switched to MRP w/ abs tamper", global_charges: [],
        global_payment_term_list: { createdTerms: [], updatedTerms: [], deletedTerms: [] },
        pricing_method: "MRP",
        products: [
          {
            product_id: 1, variant: 0,
            pricing_method: "MRP",
            entered_mrp: 1180, mrp_discount: "", mrp_discount_mode: "percentage",
            unit_price: "", tax: 18, total_price: 0,
            comment: "mrp abs-tamper on update", delivery_period: "5d", quantity: "1",
            tax_mode: "absolute", other_charges: [], // client tampers with an absolute GST mode
          },
        ],
      },
    });
    await rfqController.updateQuoteItems(m.req, m.res, m.next);

    const item = await db.one(
      `SELECT unit_price, tax, tax_mode, total_price, pricing_method FROM tbl_quote_items WHERE quote_id=$1`,
      [quote.id]
    );
    // Server must IGNORE the client's absolute tax_mode and store percentage —
    // base 1000, total 1000 * 1.18 = 1180, NOT 1000 + 18 = 1018.
    expect(item.tax_mode).toBe("percentage");
    expect(item.pricing_method).toBe("MRP");
    expect(parseFloat(item.unit_price)).toBe(1000);
    expect(parseFloat(item.total_price)).toBe(1180);
    expect(parseFloat(item.total_price)).not.toBe(1018);
  });
});
