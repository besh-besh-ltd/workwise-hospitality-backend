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

// Catalogue variants used by the draft-product tests below.
const VARIANT_ID = 1;
const OTHER_VARIANT_ID = 2;

beforeEach(() => { inserted.rfqIds = []; });

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  await db.none(`DELETE FROM tbl_rfq_filters WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_terms_map WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(
    `DELETE FROM tbl_rfq_product_files WHERE rfq_product_id IN
       (SELECT id FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
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
  // rfq_no is UNIQUE, so it has to vary per call — a test that makes two
  // drafts (e.g. the cross-RFQ delete case) would otherwise collide.
  let bareDraftSeq = 0;
  async function makeBareDraft() {
    const r = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp")
       VALUES ($2, '', '', '', '', '', '', '', 0, 0, $1, $1, NOW())
       RETURNING id`,
      [IDS.users.a1_proc_buyer, 8201001 + bareDraftSeq++]
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

  // =========================================================================
  //  Adding a product to an existing draft, then saving.
  //
  //  The edit buffer is an object keyed by `tbl_rfq_products.id`. A product
  //  added in THIS editing session has no server id yet, so the client files
  //  its edits under the literal string "undefined". The files branch used to
  //  pass that key straight into `rfq_product_id = $1::INT`, so Postgres threw
  //  `invalid input syntax for type integer: "undefined"`, the whole save
  //  rolled back, and the buyer could not save a draft at all after adding a
  //  product. Reported from production 2026-08-11.
  //
  //  Every bucket must resolve the product by the identity carried INSIDE the
  //  value (product_id + variant), never by the key.
  // =========================================================================
  describe("adding a product to a draft — the bucket key is not a primary key", () => {
    async function draftWithProduct(variant = 0) {
      const rfq_id = await makeBareDraft();
      const p = await db.one(
        `INSERT INTO tbl_rfq_products
           (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, qap, variant)
         VALUES ($1, '', '0', '', '', $2, '0', $3)
         RETURNING id`,
        [rfq_id, VARIANT_ID, variant]
      );
      return { rfq_id, rfqProductId: p.id };
    }

    function saveBody(rfq_id, updatableProducts) {
      return {
        rfq_id,
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        process_id: IDS.processes.A_P1,
        is_tender: 0,
        filters: { global: null, local: null },
        updatableData: { products: updatableProducts },
      };
    }

    it('does not 500 when a just-added product files its edits under the "undefined" key', async () => {
      const { rfq_id, rfqProductId } = await draftWithProduct();
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: saveBody(rfq_id, {
          updatable: {
            // Exactly what the client sends for a product added in-session.
            files: {
              undefined: {
                product_id: VARIANT_ID,
                variant: 0,
                spec_file: ["https://files.test/spec-1.pdf"],
              },
            },
          },
        }),
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      // and the file landed on the real product row, not nowhere
      const files = await db.any(
        `SELECT rfq_product_id, file_type, file_url
           FROM tbl_rfq_product_files WHERE rfq_product_id = $1`,
        [rfqProductId]
      );
      expect(files).toHaveLength(1);
      expect(files[0].file_type).toBe("SPEC");
      expect(files[0].file_url).toBe("https://files.test/spec-1.pdf");
      await db.none(`DELETE FROM tbl_rfq_product_files WHERE rfq_product_id = $1`, [rfqProductId]);
    });

    it('accepts the "new:<variantId>:<variant>" key the client mints for unsaved products', async () => {
      const { rfq_id, rfqProductId } = await draftWithProduct();
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: saveBody(rfq_id, {
          updatable: {
            files: {
              [`new:${VARIANT_ID}:0`]: {
                product_id: VARIANT_ID,
                variant: 0,
                qap_file: ["https://files.test/qap-1.pdf"],
              },
            },
            comment: {
              [`new:${VARIANT_ID}:0`]: {
                product_id: VARIANT_ID,
                variant: 0,
                comment: "added in this session",
              },
            },
          },
        }),
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      const files = await db.any(
        `SELECT file_type FROM tbl_rfq_product_files WHERE rfq_product_id = $1`,
        [rfqProductId]
      );
      expect(files.map((f) => f.file_type)).toEqual(["QAP"]);
      const row = await db.one(`SELECT comment FROM tbl_rfq_products WHERE id = $1`, [rfqProductId]);
      expect(row.comment).toBe("added in this session");
      await db.none(`DELETE FROM tbl_rfq_product_files WHERE rfq_product_id = $1`, [rfqProductId]);
    });

    it("a comment for a product with no row on this RFQ is dropped, not written onto another product", async () => {
      const { rfq_id, rfqProductId } = await draftWithProduct();
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: saveBody(rfq_id, {
          updatable: {
            comment: {
              undefined: {
                product_id: OTHER_VARIANT_ID, // never added to this RFQ
                variant: 0,
                comment: "should not land anywhere",
              },
            },
          },
        }),
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      const row = await db.one(`SELECT comment FROM tbl_rfq_products WHERE id = $1`, [rfqProductId]);
      expect(row.comment).toBe("");
    });

    // A dropped write is a client bug, and for a week the only sign of one was
    // a log line. The buyer saw "Products saved successfully!" and lost the
    // product they had just added. The response now names what it refused, so
    // the UI can contradict its own success message.
    it("reports the specs it refused instead of answering an unqualified success", async () => {
      const { rfq_id } = await draftWithProduct();
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: saveBody(rfq_id, {
          updatable: {
            specs: {
              [`new:${OTHER_VARIANT_ID}:0`]: {
                product_id: OTHER_VARIANT_ID, // never added to this RFQ
                variant: 0,
                Quantity: 25,
              },
            },
          },
        }),
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      expect(m.calls.body.message.dropped_writes).toEqual([
        {
          kind: "specs",
          key: `new:${OTHER_VARIANT_ID}:0`,
          product_variant_id: OTHER_VARIANT_ID,
          variant: 0,
        },
      ]);
    });

    it("reports a refused comment the same way", async () => {
      const { rfq_id } = await draftWithProduct();
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: saveBody(rfq_id, {
          updatable: {
            comment: {
              [`new:${OTHER_VARIANT_ID}:0`]: {
                product_id: OTHER_VARIANT_ID,
                variant: 0,
                comment: "nowhere to live",
              },
            },
          },
        }),
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      expect(m.calls.body.message.dropped_writes).toEqual([
        expect.objectContaining({ kind: "comment", product_variant_id: OTHER_VARIANT_ID }),
      ]);
    });

    it("stays quiet when every edit landed", async () => {
      const { rfq_id } = await draftWithProduct();
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: saveBody(rfq_id, {
          updatable: {
            specs: {
              [`${VARIANT_ID}`]: { product_id: VARIANT_ID, variant: 0, Quantity: 10 },
            },
          },
        }),
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      expect(m.calls.body.message.dropped_writes).toEqual([]);
    });

    // The bug the client hit: save-draft has no channel for a new product and
    // never inserts tbl_rfq_products. Pinning that here so nobody builds on
    // the assumption again — a product must come from add-product-to-draft.
    it("does not create a product row, however the client files the edit", async () => {
      const { rfq_id } = await draftWithProduct();
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: saveBody(rfq_id, {
          addable: [{ product_id: OTHER_VARIANT_ID, variant: 0 }],
          updatable: {
            specs: {
              [`new:${OTHER_VARIANT_ID}:0`]: {
                product_id: OTHER_VARIANT_ID,
                variant: 0,
                Quantity: 25,
              },
            },
          },
        }),
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      const rows = await db.any(
        `SELECT product_variant_id FROM tbl_rfq_products WHERE rfq_id = $1`,
        [rfq_id]
      );
      expect(rows.map((r) => r.product_variant_id)).toEqual([VARIANT_ID]);
      // and no orphan spec left behind for a product that does not exist
      const specs = await db.any(
        `SELECT 1 FROM tbl_rfq_products_specs WHERE rfq_id = $1 AND product_variant_id = $2`,
        [rfq_id, OTHER_VARIANT_ID]
      );
      expect(specs).toHaveLength(0);
      expect(m.calls.body.message.dropped_writes).not.toEqual([]);
    });

    it("files for a product with no row on this RFQ are dropped without failing the save", async () => {
      const { rfq_id } = await draftWithProduct();
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: saveBody(rfq_id, {
          updatable: {
            files: {
              undefined: {
                product_id: OTHER_VARIANT_ID, // never added to this RFQ
                variant: 0,
                spec_file: ["https://files.test/orphan.pdf"],
              },
            },
          },
        }),
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      const orphans = await db.any(
        `SELECT f.id FROM tbl_rfq_product_files f
           JOIN tbl_rfq_products p ON p.id = f.rfq_product_id
          WHERE p.rfq_id = $1`,
        [rfq_id]
      );
      expect(orphans).toHaveLength(0);
    });

    // `products.deletable` is a client-supplied list of PRIMARY KEYS. The
    // delete used to run `WHERE id = $1` with no rfq_id predicate, so a buyer
    // editing their own draft could name any tbl_rfq_products.id in the system
    // — including another tenant's — and it would be deleted along with its
    // files and technical evaluations.
    it("cannot delete a product belonging to a different RFQ by naming its id", async () => {
      const victim = await draftWithProduct();
      const attacker = await draftWithProduct();

      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: saveBody(attacker.rfq_id, { deletable: [victim.rfqProductId] }),
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      const stillThere = await db.oneOrNone(
        `SELECT id, rfq_id FROM tbl_rfq_products WHERE id = $1`,
        [victim.rfqProductId]
      );
      expect(stillThere).not.toBeNull();
      expect(stillThere.rfq_id).toBe(victim.rfq_id);
    });

    it("still deletes a product that does belong to the RFQ being saved", async () => {
      const { rfq_id, rfqProductId } = await draftWithProduct();
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: saveBody(rfq_id, { deletable: [rfqProductId] }),
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      const gone = await db.oneOrNone(`SELECT id FROM tbl_rfq_products WHERE id = $1`, [rfqProductId]);
      expect(gone).toBeNull();
    });

    it("a non-numeric id in deletable is ignored instead of aborting the save", async () => {
      const { rfq_id, rfqProductId } = await draftWithProduct();
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: saveBody(rfq_id, {
          deletable: ["undefined", `new:${VARIANT_ID}:0`],
          updatable: {
            comment: {
              undefined: { product_id: VARIANT_ID, variant: 0, comment: "saved anyway" },
            },
          },
        }),
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      const row = await db.one(`SELECT comment FROM tbl_rfq_products WHERE id = $1`, [rfqProductId]);
      expect(row.comment).toBe("saved anyway");
    });

    // tbl_rfq_product_vendors.variant is nullable, so an undefined variant
    // writes NULL against a product row holding 0 — and every later lookup
    // matches on the (product_variant_id, variant) pair, so the vendor is
    // mapped in name only and never actually sees the RFQ.
    it("maps a vendor at variant 0 when the client sends no variant", async () => {
      const { rfq_id } = await draftWithProduct();
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: {
          ...saveBody(rfq_id, {}),
          updatableData: {
            vendors: {
              undefined: {
                product_id: VARIANT_ID,
                addable: [IDS.users.vendor_alpha],
              },
            },
          },
        },
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      const mapped = await db.any(
        `SELECT variant FROM tbl_rfq_product_vendors WHERE rfq_id = $1 AND user_id = $2`,
        [rfq_id, IDS.users.vendor_alpha]
      );
      expect(mapped).toHaveLength(1);
      expect(mapped[0].variant).toBe(0);
    });

    it("a variant-bearing product resolves to its own row, not the variant-0 sibling", async () => {
      const rfq_id = await makeBareDraft();
      const base = await db.one(
        `INSERT INTO tbl_rfq_products
           (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, qap, variant)
         VALUES ($1, '', '0', '', '', $2, '0', 0) RETURNING id`,
        [rfq_id, VARIANT_ID]
      );
      const withVariant = await db.one(
        `INSERT INTO tbl_rfq_products
           (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, qap, variant)
         VALUES ($1, '', '0', '', '', $2, '0', 1) RETURNING id`,
        [rfq_id, VARIANT_ID]
      );
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: saveBody(rfq_id, {
          updatable: {
            files: {
              undefined: {
                product_id: VARIANT_ID,
                variant: 1,
                spec_file: ["https://files.test/variant-1.pdf"],
              },
            },
          },
        }),
      });
      await rfqController.saveDraft(m.req, m.res);

      expect(m.calls.status).toBe(200);
      const onVariant = await db.any(
        `SELECT id FROM tbl_rfq_product_files WHERE rfq_product_id = $1`, [withVariant.id]);
      const onBase = await db.any(
        `SELECT id FROM tbl_rfq_product_files WHERE rfq_product_id = $1`, [base.id]);
      expect(onVariant).toHaveLength(1);
      expect(onBase).toHaveLength(0);
      await db.none(`DELETE FROM tbl_rfq_product_files WHERE rfq_product_id = ANY($1::int[])`,
        [[base.id, withVariant.id]]);
    });
  });
});
