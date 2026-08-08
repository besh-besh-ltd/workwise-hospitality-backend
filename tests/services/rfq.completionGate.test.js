// The "Some products are missing quantity or unit" gate.
//
// Client ticket: buyers reach the Review step, see a quantity and a unit on
// every product, hit submit, and are told products are missing quantity or
// unit. The Review step and the gate were reading two different things.
//
// The gate (rfqModel.checkRFQCompletion) used to answer the question by
// comparing two COUNTS:
//
//     SELECT DISTINCT product_variant_id, variant FROM tbl_rfq_products  -- N
//     SELECT ... FROM tbl_rfq_products_specs ... HAVING count(title) = 2  -- M
//     return N === M
//
// Counting is not matching. Any spec group that does not correspond to a live
// product row still lands in M, so:
//
//   * M > N rejects an RFQ in which every product is actually complete
//     (measured on production: 49 of 81 open drafts were in this state), and
//   * a leftover spec group can pad M back up to N and let an RFQ through
//     with a product that has no quantity at all — the same defect failing
//     in the dangerous direction.
//
// It also could not name the offending product, so the message was
// unactionable even when it was right.
//
// These tests are written against observable behaviour: given a draft in a
// particular state, does POST /rfq/create accept it, and if it rejects, does
// it say which product is at fault.

import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

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
const { default: rfqModel } = await import("../../app/models/rfqModel.js");

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
    req: { user: opts.user, params: {}, body: opts.body || {} },
    res,
    next: jest.fn(),
    calls,
  };
}

const inserted = { rfqIds: [] };

beforeEach(() => { inserted.rfqIds = []; });

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  await db.none(
    `DELETE FROM tbl_approval_actions WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances
       WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
       SELECT s.id FROM tbl_approval_instance_steps s
       JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
       WHERE i.entity_type IN ('RFQ','TENDER') AND i.entity_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances
       WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_approval_instances
     WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

// ---- helpers ---------------------------------------------------------------

async function makeDraftRfq() {
  const iso = (ms) => new Date(Date.now() + ms).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 0,
    is_published: 0,
    tender_publish_date: iso(86400_000),
    vendor_clarification_date: iso(5 * 86400_000),
    bid_end_date: iso(7 * 86400_000),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

/** A product row. `variant` distinguishes two rows of the same catalogue item. */
async function addProduct(rfq_id, productVariantId, variant = 0, sheet_id = null) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant, sheet_id)
     VALUES ($1, '', '', '', '', '', $2, $3, $4) RETURNING id`,
    [rfq_id, productVariantId, variant, sheet_id]
  );
  return row.id;
}

async function addSpec(rfq_id, productVariantId, title, value, variant = 0, sheet_id = null) {
  await db.none(
    `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant, sheet_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [rfq_id, productVariantId, title, value, variant, sheet_id]
  );
}

async function addQtyUnit(rfq_id, pv, qty = "10", unit = "NOS", variant = 0, sheet_id = null) {
  await addSpec(rfq_id, pv, "Quantity", qty, variant, sheet_id);
  await addSpec(rfq_id, pv, "Unit", unit, variant, sheet_id);
}

/** Every product needs a vendor, or the NEXT gate rejects and masks this one. */
async function addVendor(rfq_id, pv, variant = 0) {
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, $4)`,
    [rfq_id, pv, IDS.users.vendor_alpha, variant]
  );
}

const bodyFor = (rfq_id, extra = {}) => ({
  rfq_id,
  hotel_ids: [IDS.hotels.A1],
  hotel_id: IDS.hotels.A1,
  hospitality_company_id: IDS.hospitality.A,
  process_id: IDS.processes.A_P1,
  department_id: null,
  bid_end_date: new Date(Date.now() + 7 * 86400_000).toISOString().replace("T", " ").slice(0, 19),
  tender_publish_date: new Date(Date.now() + 86400_000).toISOString().replace("T", " ").slice(0, 19),
  vendor_clarification_date: new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19),
  company_name: "Test Company",
  response_email: "test@example.com",
  contact_name: "Test Contact",
  contact_number: "+91-9999999999",
  location: "Test Location",
  comment: "Test",
  rfq_type: "RFQ",
  is_tender: 0,
  reverse_auction: 0,
  title: "Test RFQ",
  filters: { global: null, local: null },
  updatableData: { products: { updatable: { specs: {} }, deletable: [], insertable: [] }, vendors: {} },
  ...extra,
});

async function submit(rfq_id, extra = {}) {
  const m = mockExpress({ user: { id: IDS.users.a1_proc_buyer }, body: bodyFor(rfq_id, extra) });
  await rfqController.create(m.req, m.res, () => {});
  return m.calls;
}

/** True when the response is the quantity/unit rejection specifically. */
const isQtyUnitRejection = (calls) =>
  calls.status === 400 && /quantity|unit/i.test(calls.body?.message || "");

/**
 * Assert the draft was actually accepted — not merely "rejected for some
 * other reason". Without the status check these tests pass vacuously the
 * moment an unrelated gate starts failing first, which is exactly how the
 * original suite managed to cover this code path without catching any of
 * the defects below.
 *
 * The draft must have left status 0: 3 = PENDING_APPROVAL, or 4 = READY_TO_
 * PUBLISH when the submitter is also the final approver and the instance
 * auto-approves. Either one means the gate let it through.
 */
async function expectAccepted(rfq_id, calls) {
  const row = await db.one(`SELECT status FROM tbl_rfq WHERE id = $1`, [rfq_id]);
  const leftDraft = [3, 4].includes(Number(row.status));
  expect({ status: calls.status, message: calls.body?.message, leftDraft })
    .toEqual({ status: 200, message: calls.body?.message, leftDraft: true });
}

// ===========================================================================
//  Group 1 — the client's complaint: complete RFQs must not be rejected
// ===========================================================================

describe("a draft whose products all have a quantity and a unit is accepted", () => {
  it("accepts a single-character unit — 'g', 'm' and 'L' are real units", async () => {
    // The old rule was LENGTH(TRIM(value)) >= 2, which silently failed every
    // one-character unit. Production carried 'g' and 'm' on live drafts.
    for (const unit of ["g", "m", "L"]) {
      const rfq_id = await makeDraftRfq();
      await addProduct(rfq_id, 1);
      await addQtyUnit(rfq_id, 1, "10", unit);
      await addVendor(rfq_id, 1);

      const calls = await submit(rfq_id);
      await expectAccepted(rfq_id, calls);
    }
  });

  it("accepts a decimal quantity written as '0.5' or '.5'", async () => {
    for (const qty of ["0.5", ".5", "12.750"]) {
      const rfq_id = await makeDraftRfq();
      await addProduct(rfq_id, 1);
      await addQtyUnit(rfq_id, 1, qty, "KG");
      await addVendor(rfq_id, 1);

      const calls = await submit(rfq_id);
      await expectAccepted(rfq_id, calls);
    }
  });

  it("accepts a quantity or unit stored with surrounding whitespace", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addQtyUnit(rfq_id, 1, "  25  ", "  NOS  ");
    await addVendor(rfq_id, 1);

    await expectAccepted(rfq_id, await submit(rfq_id));
  });

  it("accepts specs whose title was written in a different case", async () => {
    // Production (proddb) holds 22 'quantity' and 22 'unit' rows written by a
    // path that did not capitalise. `title IN ('Quantity','Unit')` cannot see
    // them, so those products read as having no specs at all.
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addSpec(rfq_id, 1, "quantity", "10");
    await addSpec(rfq_id, 1, "unit", "NOS");
    await addVendor(rfq_id, 1);

    await expectAccepted(rfq_id, await submit(rfq_id));
  });

  it("accepts a complete RFQ that still carries specs from a deleted product", async () => {
    // THE CLIENT'S BUG. Removing a product deletes tbl_rfq_products but can
    // leave its spec rows behind. Those orphans pushed the qualified count
    // above the product count, and `N === M` failed on an RFQ where every
    // live product was complete.
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addQtyUnit(rfq_id, 1, "10", "NOS");
    await addVendor(rfq_id, 1);
    // Orphan: specs for a product variant with no row in tbl_rfq_products.
    await addQtyUnit(rfq_id, 2, "99", "KG");

    await expectAccepted(rfq_id, await submit(rfq_id));
  });

  it("accepts two variants of the same catalogue item when both are complete", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1, 0);
    await addProduct(rfq_id, 1, 1);
    await addQtyUnit(rfq_id, 1, "10", "NOS", 0);
    await addQtyUnit(rfq_id, 1, "20", "KG", 1);
    await addVendor(rfq_id, 1, 0);
    await addVendor(rfq_id, 1, 1);

    await expectAccepted(rfq_id, await submit(rfq_id));
  });
});

// ===========================================================================
//  Group 2 — the same defect in the dangerous direction
// ===========================================================================

describe("a draft with a genuinely incomplete product is still rejected", () => {
  it("rejects a product with no specs even when an orphan spec group pads the count", async () => {
    // Two products, one complete and one with nothing. An orphan spec group
    // makes the qualified count equal the product count, so the old gate let
    // this through and published an RFQ with a product that had no quantity.
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addProduct(rfq_id, 2);
    await addQtyUnit(rfq_id, 1, "10", "NOS");   // product 1 complete
    await addQtyUnit(rfq_id, 3, "99", "KG");    // orphan — no product row
    await addVendor(rfq_id, 1);
    await addVendor(rfq_id, 2);

    const calls = await submit(rfq_id);
    expect(isQtyUnitRejection(calls)).toBe(true);
  });

  it("rejects a quantity of zero", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addQtyUnit(rfq_id, 1, "0", "NOS");
    await addVendor(rfq_id, 1);

    expect(isQtyUnitRejection(await submit(rfq_id))).toBe(true);
  });

  it("rejects a negative and a non-numeric quantity", async () => {
    for (const qty of ["-5", "ten", "N/A"]) {
      const rfq_id = await makeDraftRfq();
      await addProduct(rfq_id, 1);
      await addQtyUnit(rfq_id, 1, qty, "NOS");
      await addVendor(rfq_id, 1);

      expect({ qty, rejected: isQtyUnitRejection(await submit(rfq_id)) })
        .toEqual({ qty, rejected: true });
    }
  });

  it("rejects a unit that is only a placeholder", async () => {
    for (const unit of ["", "   ", "NA", "N/A", "-"]) {
      const rfq_id = await makeDraftRfq();
      await addProduct(rfq_id, 1);
      await addQtyUnit(rfq_id, 1, "10", unit);
      await addVendor(rfq_id, 1);

      expect({ unit, rejected: isQtyUnitRejection(await submit(rfq_id)) })
        .toEqual({ unit, rejected: true });
    }
  });

  it("does not vacuously pass when selectedSheets matches no product row", async () => {
    // Every product and spec row on production has sheet_id NULL. `sheet_id
    // IN (...)` matches nothing, so both counts collapsed to 0, 0 === 0, and
    // an RFQ with no quantities anywhere sailed through the gate.
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);          // sheet_id NULL, no specs at all
    await addVendor(rfq_id, 1);

    const calls = await submit(rfq_id, { selectedSheets: [4242] });
    expect(isQtyUnitRejection(calls)).toBe(true);
  });
});

// ===========================================================================
//  Group 3 — the message has to be actionable
// ===========================================================================

describe("the rejection names the products at fault", () => {
  it("returns the offending product names and what each is missing", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addProduct(rfq_id, 2);
    await addQtyUnit(rfq_id, 1, "10", "NOS");   // complete
    await addSpec(rfq_id, 2, "Unit", "KG");     // product 2 has no Quantity
    await addVendor(rfq_id, 1);
    await addVendor(rfq_id, 2);

    const calls = await submit(rfq_id);
    expect(isQtyUnitRejection(calls)).toBe(true);
    expect(Array.isArray(calls.body.details)).toBe(true);
    expect(calls.body.details).toHaveLength(1);

    const [detail] = calls.body.details;
    expect(detail.productVariantId).toBe(2);
    expect(detail.missing).toEqual(["Quantity"]);
    // The client highlights the offending rows off this key — it is the same
    // one checkProductVendors emits, so both gates drive the same UI path.
    expect(Number.isInteger(detail.rfqProductId)).toBe(true);
    // And it says WHY, so "0" and "not filled in" don't read identically.
    expect(detail.reason).toMatch(/quantity is not set/i);
    // The complete product must not be blamed.
    expect(JSON.stringify(calls.body.details)).not.toContain('"productVariantId":1');
  });

  it("lists every incomplete product, not just the first", async () => {
    const rfq_id = await makeDraftRfq();
    for (const pv of [1, 2, 3]) {
      await addProduct(rfq_id, pv);
      await addVendor(rfq_id, pv);
    }
    await addQtyUnit(rfq_id, 1, "10", "NOS");   // only this one is complete

    const calls = await submit(rfq_id);
    expect(calls.body.details.map((d) => d.productVariantId).sort()).toEqual([2, 3]);
  });
});

// ===========================================================================
//  Group 4 — the sheet filter must not be an injection point
// ===========================================================================

describe("selectedSheets is data, never SQL", () => {
  it("does not execute a SQL fragment smuggled through selectedSheets", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addQtyUnit(rfq_id, 1, "10", "NOS");
    await addVendor(rfq_id, 1);

    // The old code interpolated `selectedSheets.join(',')` straight into the
    // WHERE clause. Anything non-numeric here is a caller error, not a query.
    await expect(
      rfqModel.checkRFQCompletion(rfq_id, ["1); DROP TABLE tbl_rfq_products_specs; --"])
    ).rejects.toThrow();

    const still = await db.one(`SELECT count(*)::int AS n FROM tbl_rfq_products_specs WHERE rfq_id = $1`, [rfq_id]);
    expect(still.n).toBe(2);
  });
});

// ===========================================================================
//  Group 5 — the buyer's actual journey, end to end
// ===========================================================================

describe("the journey that produced the ticket", () => {
  /**
   * What the buyer does: add products to the draft (which creates product rows
   * with no specs at all — the bulk endpoint writes products and vendors and
   * nothing else, which is why 40 production drafts hold products with zero
   * spec rows), type a quantity and a unit into each, then submit.
   *
   * The typed values travel in updatableData.products.updatable.specs, keyed
   * per product. Two products added in the same session used to collide on the
   * key "undefined" on the client, so only one set of specs was sent and the
   * other product was reported missing on a screen that was showing its
   * quantity. This drives the payload the fixed client sends.
   */
  it("persists the typed quantity for EVERY newly-added product, then accepts the draft", async () => {
    const rfq_id = await makeDraftRfq();

    // Two products, freshly added, no specs — exactly the post-bulk-add state.
    await addProduct(rfq_id, 1);
    await addProduct(rfq_id, 2);
    await addVendor(rfq_id, 1);
    await addVendor(rfq_id, 2);

    // Nothing typed yet: the gate must block, and name both.
    const before = await submit(rfq_id);
    expect(isQtyUnitRejection(before)).toBe(true);
    expect(before.body.details).toHaveLength(2);

    // The buyer types into both rows. Distinct keys per product — under the
    // old "undefined" keying these two entries were one entry.
    const calls = await submit(rfq_id, {
      updatableData: {
        products: {
          updatable: {
            specs: {
              "new:1:0": { product_id: 1, variant: 0, Quantity: "12", Unit: "g" },
              "new:2:0": { product_id: 2, variant: 0, Quantity: "0.5", Unit: "KG" },
            },
          },
          deletable: [],
          insertable: [],
        },
        vendors: {},
      },
    });

    await expectAccepted(rfq_id, calls);

    // Both products really do carry their own specs now.
    const specs = await db.any(
      `SELECT product_variant_id, title, btrim(value) AS value
         FROM tbl_rfq_products_specs WHERE rfq_id = $1 ORDER BY product_variant_id, title`,
      [rfq_id]
    );
    expect(specs).toEqual([
      { product_variant_id: 1, title: "Quantity", value: "12" },
      { product_variant_id: 1, title: "Unit", value: "g" },
      { product_variant_id: 2, title: "Quantity", value: "0.5" },
      { product_variant_id: 2, title: "Unit", value: "KG" },
    ]);
  });

  it("blocks and names only the product the buyer missed", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addProduct(rfq_id, 2);
    await addVendor(rfq_id, 1);
    await addVendor(rfq_id, 2);

    const calls = await submit(rfq_id, {
      updatableData: {
        products: {
          updatable: {
            specs: {
              "new:1:0": { product_id: 1, variant: 0, Quantity: "12", Unit: "NOS" },
              // second product: unit left on the placeholder the UI seeds
              "new:2:0": { product_id: 2, variant: 0, Quantity: "5", Unit: "" },
            },
          },
          deletable: [],
          insertable: [],
        },
        vendors: {},
      },
    });

    expect(isQtyUnitRejection(calls)).toBe(true);
    expect(calls.body.details).toHaveLength(1);
    expect(calls.body.details[0].productVariantId).toBe(2);
    expect(calls.body.details[0].missing).toEqual(["Unit"]);
  });
});
