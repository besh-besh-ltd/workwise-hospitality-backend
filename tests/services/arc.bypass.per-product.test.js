// Phase 9 — product-level test for the bypass-ARC override.
//
// What the buyer experiences:
//   - When a product the buyer adds is currently under an active ARC
//     (Phase 6 detection — separately tested), the FE prompts:
//       "Continue with RFQ (override)" → modal asks for a reason ≥30 chars.
//   - The reason is stored PER-PRODUCT on tbl_rfq_products.bypass_arc_reason
//     (with bypass_arc_recorded_by + recorded_at). It's NOT a parent RFQ
//     attribute — different products on the same RFQ may carry different
//     reasons (or no reason at all).
//   - The parent tbl_rfq.bypass_arc rollup flag flips to 1 the first
//     time any product carries a reason — used by listing-level filters
//     and the BypassArcRibbon banner.
//   - Each bypass action emits an RFQ_BYPASS_ARC lifecycle event with
//     the per-product context (product_variant_id, variant, reason).
//   - Reasons shorter than 30 chars are rejected silently (no
//     persistence, no rollup, no lifecycle event) so the FE's
//     min-length validator + the server agree.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
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

afterAll(async () => { await closeDb(); });

const inserted = { rfqIds: [] };
afterEach(async () => {
  if (inserted.rfqIds.length) {
    const ids = inserted.rfqIds;
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_terms_map WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
    inserted.rfqIds = [];
  }
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
    res, next: jest.fn(), calls,
  };
}

const REASON_LONG = "We need this product on a tighter spec window than the current ARC vendor can promise so an open-market competition is justified.";
const REASON_SHORT = "Too short";

async function makeTenderDraft(overrides = {}) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    is_tender: 1,
    status: 1,
    is_published: 0,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1, // any process — bypass test isn't about approval
    comment: "Bypass test draft",
    company_name: "Phileein",
    ...overrides,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

describe("Bypass-ARC override — per-product reason persistence", () => {
  it("persists reason on the product row, sets parent rollup, emits lifecycle event", async () => {
    const rfq_id = await makeTenderDraft();

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        rfq_id,
        is_tender: 1,
        hotel_ids: [IDS.hotels.A1],
        variant_id: 9101,
        bypass_arc_reason: REASON_LONG,
        // Pass an explicit (empty) vendor list to bypass the auto-add
        // path — vendor wiring isn't what this test cares about.
        vendors: [{ vendor_id: IDS.users.vendor_alpha }],
      },
    });
    await rfqController.createOrUpdateRfqDraftWithProductVendors(m.req, m.res);
    expect([200, 201, null]).toContain(m.calls.status);

    // (a) Per-product persistence — reason + audit metadata are pinned.
    const product = await db.one(
      `SELECT bypass_arc_reason, bypass_arc_recorded_by, bypass_arc_recorded_at
         FROM tbl_rfq_products
        WHERE rfq_id = $1 AND product_variant_id = 9101`,
      [rfq_id]
    );
    expect(product.bypass_arc_reason).toBe(REASON_LONG);
    expect(product.bypass_arc_recorded_by).toBe(IDS.users.a1_proc_buyer);
    expect(product.bypass_arc_recorded_at).toBeTruthy();

    // (b) Parent rollup flag flipped to 1.
    const rfq = await db.one(`SELECT bypass_arc FROM tbl_rfq WHERE id = $1`, [rfq_id]);
    expect(rfq.bypass_arc).toBe(1);

    // (c) Lifecycle event emitted exactly once for this product.
    const events = await db.any(
      `SELECT stage, action, metadata, remarks FROM tbl_lifecycle_history
        WHERE entity_id = $1 AND stage = 'RFQ_BYPASS_ARC'`,
      [rfq_id]
    );
    expect(events.length).toBe(1);
    expect(events[0].action).toBe('BYPASS_ARC');
    expect(events[0].remarks).toBe(REASON_LONG);
    const meta = typeof events[0].metadata === 'string' ? JSON.parse(events[0].metadata) : events[0].metadata;
    expect(meta.product_variant_id).toBe(9101);
    expect(meta.reason).toBe(REASON_LONG);
  });

  it("rejects reasons shorter than 30 characters — no persistence, no rollup, no event", async () => {
    const rfq_id = await makeTenderDraft();

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        rfq_id,
        is_tender: 1,
        hotel_ids: [IDS.hotels.A1],
        variant_id: 9102,
        bypass_arc_reason: REASON_SHORT,
        vendors: [{ vendor_id: IDS.users.vendor_alpha }],
      },
    });
    await rfqController.createOrUpdateRfqDraftWithProductVendors(m.req, m.res);
    expect([200, 201, null]).toContain(m.calls.status);

    // The product is inserted (bypass is optional), but with NULL reason.
    const product = await db.one(
      `SELECT bypass_arc_reason, bypass_arc_recorded_by, bypass_arc_recorded_at
         FROM tbl_rfq_products
        WHERE rfq_id = $1 AND product_variant_id = 9102`,
      [rfq_id]
    );
    expect(product.bypass_arc_reason).toBeNull();
    expect(product.bypass_arc_recorded_by).toBeNull();
    expect(product.bypass_arc_recorded_at).toBeNull();

    const rfq = await db.one(`SELECT bypass_arc FROM tbl_rfq WHERE id = $1`, [rfq_id]);
    expect(rfq.bypass_arc || 0).toBe(0);

    const events = await db.any(
      `SELECT id FROM tbl_lifecycle_history
        WHERE entity_id = $1 AND stage = 'RFQ_BYPASS_ARC'`,
      [rfq_id]
    );
    expect(events.length).toBe(0);
  });

  it("preserves per-product isolation — bypassing one product leaves another intact", async () => {
    const rfq_id = await makeTenderDraft();

    // Product A — bypassed.
    let m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        rfq_id, is_tender: 1, hotel_ids: [IDS.hotels.A1],
        variant_id: 9201, bypass_arc_reason: REASON_LONG,
        vendors: [{ vendor_id: IDS.users.vendor_alpha }],
      },
    });
    await rfqController.createOrUpdateRfqDraftWithProductVendors(m.req, m.res);

    // Product B — NO bypass.
    m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        rfq_id, is_tender: 1, hotel_ids: [IDS.hotels.A1],
        variant_id: 9202, // no bypass_arc_reason
        vendors: [{ vendor_id: IDS.users.vendor_alpha }],
      },
    });
    await rfqController.createOrUpdateRfqDraftWithProductVendors(m.req, m.res);

    const products = await db.any(
      `SELECT product_variant_id, bypass_arc_reason
         FROM tbl_rfq_products
        WHERE rfq_id = $1 ORDER BY product_variant_id`,
      [rfq_id]
    );
    expect(products.length).toBe(2);
    expect(products[0].product_variant_id).toBe(9201);
    expect(products[0].bypass_arc_reason).toBe(REASON_LONG);
    expect(products[1].product_variant_id).toBe(9202);
    expect(products[1].bypass_arc_reason).toBeNull();

    // Parent rollup is 1 because at least one product is bypassed.
    const rfq = await db.one(`SELECT bypass_arc FROM tbl_rfq WHERE id = $1`, [rfq_id]);
    expect(rfq.bypass_arc).toBe(1);

    // Two products bypassed = two RFQ_BYPASS_ARC events. Here only one is.
    const events = await db.any(
      `SELECT id FROM tbl_lifecycle_history
        WHERE entity_id = $1 AND stage = 'RFQ_BYPASS_ARC'`,
      [rfq_id]
    );
    expect(events.length).toBe(1);
  });

  it("two bypassed products on the same draft = two lifecycle events, same parent rollup", async () => {
    const rfq_id = await makeTenderDraft();
    for (const variantId of [9301, 9302]) {
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        body: {
          rfq_id, is_tender: 1, hotel_ids: [IDS.hotels.A1],
          variant_id: variantId, bypass_arc_reason: REASON_LONG,
          vendors: [{ vendor_id: IDS.users.vendor_alpha }],
        },
      });
      await rfqController.createOrUpdateRfqDraftWithProductVendors(m.req, m.res);
    }
    const events = await db.any(
      `SELECT metadata FROM tbl_lifecycle_history
        WHERE entity_id = $1 AND stage = 'RFQ_BYPASS_ARC'
        ORDER BY id`,
      [rfq_id]
    );
    expect(events.length).toBe(2);
    const variantIds = events.map((e) => {
      const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata;
      return meta.product_variant_id;
    }).sort();
    expect(variantIds).toEqual([9301, 9302]);
  });

  it("the schema CHECK constraint blocks any path that tries to write a <30-char reason", async () => {
    const rfq_id = await makeTenderDraft();
    // Direct INSERT bypassing the controller's app-tier validation —
    // the DB itself must refuse the row.
    await expect(
      db.none(
        `INSERT INTO tbl_rfq_products
           (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant, bypass_arc_reason)
         VALUES ($1, '', '', '', '', '', 9999, 0, 'too short')`,
        [rfq_id]
      )
    ).rejects.toThrow(/chk_rfq_products_bypass_arc_reason_len|violates check constraint/i);
  });

  it("bypass_arc_recorded_by is pinned to req.user.id — never trusts a client-supplied value", async () => {
    const rfq_id = await makeTenderDraft();
    const otherUserId = IDS.users.a1_proc_finance;
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        rfq_id,
        is_tender: 1,
        hotel_ids: [IDS.hotels.A1],
        variant_id: 9401,
        bypass_arc_reason: REASON_LONG,
        // Tampering attempt — the controller MUST ignore this.
        bypass_arc_recorded_by: otherUserId,
        vendors: [{ vendor_id: IDS.users.vendor_alpha }],
      },
    });
    await rfqController.createOrUpdateRfqDraftWithProductVendors(m.req, m.res);
    const product = await db.one(
      `SELECT bypass_arc_recorded_by FROM tbl_rfq_products
        WHERE rfq_id = $1 AND product_variant_id = 9401`,
      [rfq_id]
    );
    expect(product.bypass_arc_recorded_by).toBe(IDS.users.a1_proc_buyer);
    expect(product.bypass_arc_recorded_by).not.toBe(otherUserId);
  });
});
