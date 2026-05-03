// Wave-1 step-3.1 tests: the very first action a buyer takes when starting an
// RFQ — `POST /add-product-to-draft` (creates the initial tbl_rfq draft row +
// first product) and `POST /save-draft` (updates draft metadata before
// submission). These run BEFORE rfqController.create (the submit-from-draft
// entry tested in rfq.create.flow.test.js).
//
// Surface tested via the production controllers:
//   - rfqController.createOrUpdateRfqDraftWithProductVendors
//   - rfqController.saveDraft
//
// Per CONVENTIONS.md: every test calls the production controller; setup uses
// raw INSERTs only for prerequisite state. The "auto-resolve vendors" branch
// goes through `hospitalityModel.getEligibleVendorsForVariant` (covered
// separately in vendorEligibility.test.js).

import { describe, it, expect, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import rfqController from "../../app/controllers/rfq/rfqController.js";

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

// Track every draft RFQ this suite creates so afterEach can clean it up — we
// commit (the controller has no txContext support), so isolation is via
// concrete-id tracking per CONVENTIONS.md §6.
const inserted = { rfqIds: [] };

beforeEach(() => { inserted.rfqIds = []; });

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  await db.none(`DELETE FROM tbl_rfq_filters WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_terms_map WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

// ===========================================================================
//  createOrUpdateRfqDraftWithProductVendors — initial draft creation
// ===========================================================================

describe("createOrUpdateRfqDraftWithProductVendors — input validation", () => {
  it("returns 400 when variant_id is missing", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { is_tender: 0, hotel_ids: [IDS.hotels.A1] /* no variant_id */ },
    });
    await rfqController.createOrUpdateRfqDraftWithProductVendors(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Invalid product data/i);
  });

  it("returns 404 when caller specifies an rfq_id that doesn't belong to them", async () => {
    // Create a draft owned by a DIFFERENT user.
    const other = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp")
       VALUES (8200001, '', '', '', '', '', '', '', 0, 0, $1, $1, NOW())
       RETURNING id`,
      [IDS.users.a1_proc_techApp]
    );
    inserted.rfqIds.push(other.id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id: other.id, variant_id: 1, hotel_ids: [IDS.hotels.A1] },
    });
    await rfqController.createOrUpdateRfqDraftWithProductVendors(m.req, m.res);
    expect(m.calls.status).toBe(404);
    expect(m.calls.body.message).toMatch(/not found or not authorized/i);
  });

  it("returns 404 when the specified draft is already published (is_published=1)", async () => {
    const pub = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp")
       VALUES (8200002, '', '', '', '', '', '', '', 1, 1, $1, $1, NOW())
       RETURNING id`,
      [IDS.users.a1_proc_buyer]
    );
    inserted.rfqIds.push(pub.id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id: pub.id, variant_id: 1, hotel_ids: [IDS.hotels.A1] },
    });
    await rfqController.createOrUpdateRfqDraftWithProductVendors(m.req, m.res);
    expect(m.calls.status).toBe(404);
  });
});

describe("createOrUpdateRfqDraftWithProductVendors — happy paths", () => {
  it("with NO rfq_id → creates a new draft tbl_rfq row + tbl_rfq_products row", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        variant_id: 1,
        hotel_ids: [IDS.hotels.A1],
        is_tender: 0,
        comment: "draft from product picker",
      },
    });
    await rfqController.createOrUpdateRfqDraftWithProductVendors(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.data.isNew).toBe(true);
    const newId = m.calls.body.data.rfq_id;
    inserted.rfqIds.push(newId);

    // tbl_rfq row landed with the right defaults.
    const rfq = await db.one(
      `SELECT created_by, updated_by, is_published, comment FROM tbl_rfq WHERE id=$1`,
      [newId]
    );
    expect(rfq.created_by).toBe(IDS.users.a1_proc_buyer);
    expect(rfq.is_published).toBe(0);
    expect(rfq.comment).toBe("draft from product picker");

    // First product was attached.
    const prod = await db.one(
      `SELECT product_variant_id FROM tbl_rfq_products WHERE rfq_id=$1`,
      [newId]
    );
    expect(prod.product_variant_id).toBe(1);

    // Default 8 terms were seeded into tbl_rfq_terms_map.
    const terms = await db.any(
      `SELECT terms_id FROM tbl_rfq_terms_map WHERE rfq_id=$1 ORDER BY terms_id`,
      [newId]
    );
    expect(terms.length).toBe(8);
  });

  it("with explicit rfq_id of an OWNED draft → adds another product to the SAME row (isNew=false)", async () => {
    // First call — creates the draft.
    const first = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { variant_id: 1, hotel_ids: [IDS.hotels.A1], is_tender: 0 },
    });
    await rfqController.createOrUpdateRfqDraftWithProductVendors(first.req, first.res);
    expect(first.calls.status).toBe(200);
    const rfq_id = first.calls.body.data.rfq_id;
    inserted.rfqIds.push(rfq_id);

    // Second call — same rfq_id, different variant.
    const second = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, variant_id: 2, hotel_ids: [IDS.hotels.A1], is_tender: 0 },
    });
    await rfqController.createOrUpdateRfqDraftWithProductVendors(second.req, second.res);
    expect(second.calls.status).toBe(200);
    expect(second.calls.body.data.isNew).toBe(false);
    expect(second.calls.body.data.rfq_id).toBe(rfq_id);

    // Two product rows on the same RFQ.
    const products = await db.any(
      `SELECT product_variant_id FROM tbl_rfq_products WHERE rfq_id=$1 ORDER BY product_variant_id`,
      [rfq_id]
    );
    expect(products.length).toBe(2);
    expect(products.map((p) => p.product_variant_id)).toEqual([1, 2]);
  });

  it("auto-resolves eligible vendors when product.vendors is omitted", async () => {
    // Set up: vendor_alpha mapped to variant 1 + has hotel A1 + category subs
    // (matching the eligibility query). This piggybacks on the same setup
    // pattern used in vendorEligibility.test.js, but we trigger it through
    // the production draft controller end-to-end.
    const variantVendor = await db.one(
      `INSERT INTO tbl_product_variant_vendor_mapping
         (product_variant_id, vendor_id, status, is_approved, created_by, created_at, updated_at)
       VALUES (1, $1, true, true, $1, now(), now()) RETURNING id`,
      [IDS.users.vendor_alpha]
    );
    const hotelSub = await db.one(
      `INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
       VALUES ($1, 'hotel', $2, 500, NOW() - INTERVAL '30 days', NOW() + INTERVAL '335 days', 'active')
       ON CONFLICT ON CONSTRAINT uq_vendor_hotel_category_subscription DO NOTHING
       RETURNING id`,
      [IDS.users.vendor_alpha, IDS.hotels.A1]
    );

    try {
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: { variant_id: 1, hotel_ids: [IDS.hotels.A1], is_tender: 0 },
      });
      await rfqController.createOrUpdateRfqDraftWithProductVendors(m.req, m.res);
      expect(m.calls.status).toBe(200);
      const rfq_id = m.calls.body.data.rfq_id;
      inserted.rfqIds.push(rfq_id);

      // The auto-resolve path inserted a tbl_rfq_product_vendors row for vendor_alpha.
      const v = await db.oneOrNone(
        `SELECT user_id FROM tbl_rfq_product_vendors WHERE rfq_id=$1 AND user_id=$2`,
        [rfq_id, IDS.users.vendor_alpha]
      );
      expect(v).not.toBeNull();
      expect(v.user_id).toBe(IDS.users.vendor_alpha);
    } finally {
      await db.none(
        `DELETE FROM tbl_product_variant_vendor_mapping WHERE id=$1`,
        [variantVendor.id]
      );
      if (hotelSub?.id) {
        await db.none(
          `DELETE FROM tbl_vendor_hotel_category_subscription WHERE id=$1`,
          [hotelSub.id]
        );
      }
    }
  });

  it("persists hotel_ids via reconcileRFQHotels into tbl_rfq_hotel_mappings", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        variant_id: 1,
        hotel_ids: [IDS.hotels.A1, IDS.hotels.A2],
        is_tender: 0,
      },
    });
    await rfqController.createOrUpdateRfqDraftWithProductVendors(m.req, m.res);
    expect(m.calls.status).toBe(200);
    const rfq_id = m.calls.body.data.rfq_id;
    inserted.rfqIds.push(rfq_id);

    const mappings = await db.any(
      `SELECT hotel_id FROM tbl_rfq_hotel_mappings WHERE rfq_id=$1 ORDER BY hotel_id`,
      [rfq_id]
    );
    expect(mappings.map((r) => r.hotel_id).sort()).toEqual(
      [IDS.hotels.A1, IDS.hotels.A2].sort()
    );

    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id=$1`, [rfq_id]);
  });
});

// ===========================================================================
//  saveDraft — updates an existing draft row's metadata
// ===========================================================================

describe("saveDraft — updates draft metadata before submission", () => {
  async function makeBareDraft() {
    const r = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp")
       VALUES (8201001, '', '', '', '', '', '', '', 0, 0, $1, $1, NOW())
       RETURNING id`,
      [IDS.users.a1_proc_buyer]
    );
    inserted.rfqIds.push(r.id);
    return r.id;
  }

  it("persists comment + bid_end_date + hospitality fields onto the existing draft row", async () => {
    const rfq_id = await makeBareDraft();
    const bidEnd = new Date(Date.now() + 7 * 86400_000)
      .toISOString().replace("T", " ").slice(0, 19);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        comment: "Edited from the form",
        bid_end_date: bidEnd,
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        process_id: IDS.processes.A_P1,
        company_name: "ACME",
        response_email: "buyer@test.local",
        contact_name: "Buyer Person",
        contact_number: "+919999999999",
        location: "Mumbai",
        is_tender: 0,
        rfq_type: "RFQ",
        filters: { global: null, local: null },
      },
    });
    await rfqController.saveDraft(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const after = await db.one(
      `SELECT comment, bid_end_date, hospitality_company_id, hotel_id, process_id
       FROM tbl_rfq WHERE id=$1`,
      [rfq_id]
    );
    expect(after.comment).toBe("Edited from the form");
    expect(after.bid_end_date).toBe(bidEnd);
    expect(after.hospitality_company_id).toBe(IDS.hospitality.A);
    expect(after.hotel_id).toBe(IDS.hotels.A1);
    expect(after.process_id).toBe(IDS.processes.A_P1);
  });

  it("F-DRAFT-500 — caller without access to the chosen hospitality / hotel context returns 4xx, not 500", async () => {
    const rfq_id = await makeBareDraft();
    // a1_proc_buyer is mapped to company A / hotel A1 only; pointing the
    // draft at company B / hotel B1 must trip the userHasContext rejection
    // in saveRfqDraft.
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        hospitality_company_id: IDS.hospitality.B,
        hotel_id: IDS.hotels.B1,
        is_tender: 0,
        filters: { global: null, local: null },
      },
    });
    await rfqController.saveDraft(m.req, m.res);
    // POST-FIX: business-logic rejections (auth/validation) map to 4xx —
    // 403 for access-denied is most precise; 400 acceptable. The catch block
    // must detect the rich-error shape (`error.message` is JSON-encoded
    // `{message, status}`) and translate, OR `saveRfqDraft` must throw a
    // structured `httpError` like the update controller does.
    expect([400, 403]).toContain(m.calls.status);
    expect(m.calls.body.errors.rfq).toMatch(/do not have access/i);
  });
});
