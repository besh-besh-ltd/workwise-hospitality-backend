// Phase 9 — product-level test for multi-vendor tender finalize.
//
// What the buyer experiences end-to-end:
//   - On a tender at "ready to finalize", the buyer picks 1+ vendors per
//     product (multi-vendor) using the ARC route.
//   - Each (product, vendor) pick is committed as one finalize call to
//     POST /rfq/finalize with route_type='ARC'.
//   - After all picks, the database contains:
//       * one tbl_quote_finalization row per pick
//       * one tbl_arc envelope per VENDOR (not per cell — vendors get a
//         single envelope spanning every product they won)
//       * one tbl_arc_item per cell, status='PENDING'
//       * one tbl_approval_instances row per cell, entity_type='ARC',
//         entity_id = arc_item.id, with the parent tender's process_id
//       * tbl_arc_hotels seeded from tbl_rfq_hotel_mappings
//       * a TENDER lifecycle event 'ARC_PENDING_COMMITTEE' per cell
//
// This is the spine of Phase 2 — if multi-vendor finalize doesn't lay
// the right scaffolding, every downstream phase (committee, document,
// release) is built on sand.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { makeRFQ } from "../factories/rfq.js";

// Stub mailer + cron at module level — finalize fan-outs touch both.
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

// IDs we add inline for this suite — keeping them >= 70090 so they don't
// clash with anything seeded by the shared fixtures (see fixtures/ids.js).
const TENDER_PROCESS_ID = 70094;
const ARC_POLICY_ID = 60094;

beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_approval_processes
       (id, company_id, name, description, is_active, created_by, process_type)
     VALUES ($1, $2, 'Tender Single Hotel — finalize test', '', true, $3, 'TENDER')
     ON CONFLICT (id) DO NOTHING`,
    [TENDER_PROCESS_ID, IDS.companies.A, IDS.users.companyA_admin]
  );
  // ARC policy for this process @ Hotel A1: 1-step ANY, approver = the
  // commercial-approver role. The actual approver list isn't asserted by
  // this suite — what matters is that an instance can be created.
  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped, version,
        company_id, is_global)
     VALUES
       ($1, 'ARC', $2, $3, NULL, true, $4, $5, false, false, 1, $6, 0)
     ON CONFLICT (id) DO NOTHING`,
    [
      ARC_POLICY_ID,
      IDS.hospitality.A,
      IDS.hotels.A1,
      IDS.users.companyA_admin,
      TENDER_PROCESS_ID,
      IDS.companies.A,
    ]
  );
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ANY', 'USER', $2)
     ON CONFLICT DO NOTHING`,
    [ARC_POLICY_ID, IDS.users.a1_proc_commApp]
  );
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [ARC_POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [ARC_POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_processes WHERE id = $1`, [TENDER_PROCESS_ID]);
  await closeDb();
});

const inserted = { rfqIds: [] };

afterEach(async () => {
  if (inserted.rfqIds.length) {
    const rfqIds = inserted.rfqIds;
    // Tear down in dependency order: arc + approvals first.
    await db.none(
      `DELETE FROM tbl_approval_instances
       WHERE entity_type = 'ARC' AND entity_id IN (
         SELECT id FROM tbl_arc_item WHERE arc_id IN (
           SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[])
         )
       )`,
      [rfqIds]
    );
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id IN (SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[]))`, [rfqIds]);
    await db.none(`DELETE FROM tbl_arc_hotels WHERE arc_id IN (SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[]))`, [rfqIds]);
    await db.none(`DELETE FROM tbl_arc WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[]) AND entity_type IN ('TENDER','RFQ','ARC')`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
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

/**
 * Build a tender mid-flight at the "ready to finalize" point: 2 products,
 * 2 vendors mapped to each, one quote per (vendor) with 2 quote_items
 * (one per product) so finalize has real prices to snapshot.
 */
async function makeTenderReadyToFinalize() {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    is_tender: 1,
    status: 1, // QUOTING_OPEN — the controller doesn't gate on status
    is_published: 1,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: TENDER_PROCESS_ID,
    comment: "Multi-vendor finalize fixture",
    company_name: "Phileein Hospitality",
  });
  inserted.rfqIds.push(rfq_id);
  await db.none(
    `UPDATE tbl_rfq SET tender_scope='SINGLE',
                       arc_period_from=NOW()::date,
                       arc_period_to=(NOW() + INTERVAL '365 days')::date
     WHERE id = $1`,
    [rfq_id]
  );
  await db.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by)
     VALUES ($1, $2, $3) ON CONFLICT (rfq_id, hotel_id) DO NOTHING`,
    [rfq_id, IDS.hotels.A1, IDS.users.a1_proc_buyer]
  );

  // Two products. product_variant_id 1 + 2 are seeded by harness.
  const p1 = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
    [rfq_id]
  );
  const p2 = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 2, 0) RETURNING id`,
    [rfq_id]
  );
  // Quantity + Unit specs.
  await db.none(
    `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
     VALUES ($1, 1, 'Quantity', '100', 0), ($1, 1, 'Unit', 'NOS', 0),
            ($1, 2, 'Quantity', '50',  0), ($1, 2, 'Unit', 'KG',  0)`,
    [rfq_id]
  );

  // Vendor mappings.
  for (const vendorId of [IDS.users.vendor_alpha, IDS.users.vendor_beta]) {
    for (const productId of [1, 2]) {
      await db.none(
        `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT DO NOTHING`,
        [rfq_id, productId, vendorId]
      );
    }
  }

  // One quote per vendor + 2 quote_items each (one per product).
  const quotes = {};
  const quoteItems = {};
  for (const vendorId of [IDS.users.vendor_alpha, IDS.users.vendor_beta]) {
    const q = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, global_charges)
       VALUES ($1, $2, 1, $3, $3, '[]'::jsonb)
       RETURNING id`,
      [rfq_id, rfq_no, vendorId]
    );
    quotes[vendorId] = q.id;
    quoteItems[vendorId] = {};
    for (const productId of [1, 2]) {
      const unitPrice = vendorId === IDS.users.vendor_alpha
        ? (productId === 1 ? 100.50 : 200.00)
        : (productId === 1 ? 105.00 : 195.50);
      const qty = productId === 1 ? 100 : 50;
      const totalPrice = unitPrice * qty;
      const item = await db.one(
        `INSERT INTO tbl_quote_items
          (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
           comment, delivery_period, quantity, variant, other_charges)
         VALUES ($1, $2, $3, $4, $5, $6, '', '7 days', $7, 0, '[]'::jsonb)
         RETURNING id, unit_price`,
        [rfq_id, rfq_no, q.id, productId, unitPrice, totalPrice, String(qty)]
      );
      quoteItems[vendorId][productId] = { id: item.id, unit_price: item.unit_price };
    }
  }

  return { rfq_id, rfq_no, p1, p2, quotes, quoteItems };
}

describe("Tender finalize — multi-vendor ARC route", () => {
  it("creates one envelope per vendor, one arc_item per cell, one approval instance per cell", async () => {
    const { rfq_id, rfq_no, quotes, quoteItems } = await makeTenderReadyToFinalize();

    const cells = [
      { product: 1, vendor: IDS.users.vendor_alpha },
      { product: 2, vendor: IDS.users.vendor_alpha },
      { product: 1, vendor: IDS.users.vendor_beta  },
      { product: 2, vendor: IDS.users.vendor_beta  },
    ];

    for (const cell of cells) {
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        body: {
          rfq_id,
          rfq_no,
          product_variant_id: cell.product,
          vendor_id: cell.vendor,
          quote_id: quotes[cell.vendor],
          quote_item_id: quoteItems[cell.vendor][cell.product].id,
          variant: 0,
          route_type: "ARC",
        },
      });
      await rfqController.finalize(m.req, m.res);
      // The controller responds 200 on the happy ARC route. We don't
      // hard-assert the body shape here (large) — only that no
      // 4xx/5xx came back.
      expect([200, 201, null]).toContain(m.calls.status);
    }

    // ============ Observable outcomes ============

    // (a) tbl_quote_finalization: one row per cell.
    const finRows = await db.any(
      `SELECT rfq_id, vendor_id, product_variant_id FROM tbl_quote_finalization
       WHERE rfq_id = $1 ORDER BY vendor_id, product_variant_id`,
      [rfq_id]
    );
    expect(finRows.length).toBe(4);

    // (b) tbl_arc: one envelope per vendor.
    const envelopes = await db.any(
      `SELECT id, vendor_id, status, hospitality_company_id, period_from, period_to, tender_scope
       FROM tbl_arc WHERE rfq_id = $1 ORDER BY vendor_id`,
      [rfq_id]
    );
    expect(envelopes.length).toBe(2);
    expect(envelopes.map((e) => e.vendor_id).sort()).toEqual(
      [IDS.users.vendor_alpha, IDS.users.vendor_beta].sort()
    );
    envelopes.forEach((env) => {
      expect(env.status).toBe("PENDING_COMMITTEE");
      expect(env.tender_scope).toBe("SINGLE");
      expect(env.hospitality_company_id).toBe(IDS.hospitality.A);
      expect(env.period_from).toBeTruthy();
      expect(env.period_to).toBeTruthy();
    });

    // (c) tbl_arc_hotels: one row per envelope copying the parent rfq's
    //     hotel mappings.
    const arcHotels = await db.any(
      `SELECT arc_id, hotel_id FROM tbl_arc_hotels
        WHERE arc_id = ANY($1::int[]) ORDER BY arc_id, hotel_id`,
      [envelopes.map((e) => e.id)]
    );
    expect(arcHotels.length).toBe(2); // 2 envelopes × 1 hotel
    arcHotels.forEach((h) => expect(h.hotel_id).toBe(IDS.hotels.A1));

    // (d) tbl_arc_item: 4 cells (2 envelopes × 2 products), each PENDING,
    //     each with the unit_price snapshotted from the chosen quote.
    const items = await db.any(
      `SELECT ai.* FROM tbl_arc_item ai
        WHERE ai.arc_id = ANY($1::int[]) ORDER BY ai.arc_id, ai.product_variant_id`,
      [envelopes.map((e) => e.id)]
    );
    expect(items.length).toBe(4);
    items.forEach((it) => {
      expect(it.status).toBe("PENDING");
      expect(it.approval_instance_id).toBeTruthy();
      expect(Number(it.unit_price)).toBeGreaterThan(0);
    });
    // Cross-check unit prices: each arc_item's unit_price should equal
    // the chosen quote's unit_price (snapshot stability under later edits).
    for (const env of envelopes) {
      const itemsForEnv = items.filter((i) => i.arc_id === env.id);
      for (const it of itemsForEnv) {
        const expected = Number(quoteItems[env.vendor_id][it.product_variant_id].unit_price);
        expect(Number(it.unit_price)).toBeCloseTo(expected, 2);
      }
    }

    // (e) tbl_approval_instances: one PENDING ARC instance per arc_item,
    //     with the parent tender's process_id carried through and
    //     entity_id pointing at arc_item.id (NOT the rfq_product or rfq).
    const instances = await db.any(
      `SELECT id, status, entity_id, entity_type, approval_policy_id, hospitality_company_id, hotel_id
        FROM tbl_approval_instances
        WHERE entity_type = 'ARC' AND entity_id = ANY($1::int[])
        ORDER BY entity_id`,
      [items.map((i) => i.id)]
    );
    expect(instances.length).toBe(4);
    instances.forEach((inst) => {
      expect(inst.status).toBe("PENDING");
      expect(inst.entity_type).toBe("ARC");
      expect(inst.approval_policy_id).toBe(ARC_POLICY_ID);
      expect(inst.hospitality_company_id).toBe(IDS.hospitality.A);
      expect(inst.hotel_id).toBe(IDS.hotels.A1);
      // The instance entity_id is the arc_item.id (per-cell granularity).
      const matchingItem = items.find((i) => i.id === inst.entity_id);
      expect(matchingItem).toBeTruthy();
      expect(matchingItem.approval_instance_id).toBe(inst.id);
    });

    // (f) Lifecycle audit: ARC_PENDING_COMMITTEE event emitted per cell.
    const lifecycle = await db.any(
      `SELECT stage, action FROM tbl_lifecycle_history
        WHERE entity_type = 'TENDER' AND entity_id = $1 AND stage = 'ARC_PENDING_COMMITTEE'`,
      [rfq_id]
    );
    expect(lifecycle.length).toBe(4);
  });

  it("re-finalizing the same (vendor, product) is idempotent — no duplicate envelope, item, or approval instance", async () => {
    const { rfq_id, rfq_no, quotes, quoteItems } = await makeTenderReadyToFinalize();

    const cell = { product: 1, vendor: IDS.users.vendor_alpha };
    const body = {
      rfq_id, rfq_no,
      product_variant_id: cell.product,
      vendor_id: cell.vendor,
      quote_id: quotes[cell.vendor],
      quote_item_id: quoteItems[cell.vendor][cell.product].id,
      variant: 0,
      route_type: "ARC",
    };

    // First finalize.
    let m = mockExpress({ user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A }, body });
    await rfqController.finalize(m.req, m.res);
    expect([200, 201, null]).toContain(m.calls.status);

    // Second finalize of the SAME cell — should not duplicate downstream
    // ARC scaffolding. The existing finalization row is replaced (history
    // captured), but the envelope+item+instance are reused.
    m = mockExpress({ user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A }, body });
    await rfqController.finalize(m.req, m.res);
    expect([200, 201, null]).toContain(m.calls.status);

    const envelopes = await db.any(`SELECT id FROM tbl_arc WHERE rfq_id = $1`, [rfq_id]);
    expect(envelopes.length).toBe(1);
    const items = await db.any(`SELECT id FROM tbl_arc_item WHERE arc_id = $1`, [envelopes[0].id]);
    expect(items.length).toBe(1);
    const instances = await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC' AND entity_id = $1`,
      [items[0].id]
    );
    expect(instances.length).toBe(1);
  });

  it("all-or-nothing: when ARC envelope creation fails the WHOLE finalize tx rolls back (no orphaned quote_finalization row)", async () => {
    // Production-grade contract: finalize on the ARC route is committed
    // ATOMICALLY. Either both the buyer's vendor pick (tbl_quote_finalization)
    // AND the committee work item (tbl_arc envelope/item + per-cell
    // approval instance) land, or NEITHER does. A "vendor finalized but
    // no committee inbox entry" half-state would be a buyer dead-end.
    //
    // We force ARC creation to fail by removing the ARC policy under the
    // tender process at this scope — createApprovalInstance has nothing
    // to resolve and throws TENDER_POLICY_NOT_CONFIGURED.

    const { rfq_id, rfq_no, quotes, quoteItems } = await makeTenderReadyToFinalize();

    // Snapshot baseline counts before the doomed call.
    const beforeFinalization = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_quote_finalization WHERE rfq_id = $1`,
      [rfq_id]
    );
    const beforeArc = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_arc WHERE rfq_id = $1`,
      [rfq_id]
    );

    // Knock out the ARC policy + its steps so createApprovalInstance
    // refuses. We restore it after the assertion.
    const savedSteps = await db.any(
      `SELECT * FROM tbl_approval_policy_steps WHERE approval_policy_id = $1 ORDER BY step_order`,
      [ARC_POLICY_ID]
    );
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [ARC_POLICY_ID]);
    await db.none(`UPDATE tbl_approval_policies SET is_active = false WHERE id = $1`, [ARC_POLICY_ID]);

    try {
      const cell = { product: 1, vendor: IDS.users.vendor_alpha };
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        body: {
          rfq_id, rfq_no,
          product_variant_id: cell.product,
          vendor_id: cell.vendor,
          quote_id: quotes[cell.vendor],
          quote_item_id: quoteItems[cell.vendor][cell.product].id,
          variant: 0,
          route_type: "ARC",
        },
      });
      await rfqController.finalize(m.req, m.res);

      // Buyer sees a non-success status (the controller's outer error
      // handler converts the propagated error). The exact code is 400
      // today, but what matters is "NOT 200" — the buyer doesn't see
      // a misleading success.
      expect(m.calls.status).toBeGreaterThanOrEqual(400);

      // The all-or-nothing contract: nothing persisted.
      const afterFin = await db.one(
        `SELECT COUNT(*)::int AS n FROM tbl_quote_finalization WHERE rfq_id = $1`,
        [rfq_id]
      );
      expect(afterFin.n).toBe(beforeFinalization.n); // no new finalization row
      const afterArc = await db.one(
        `SELECT COUNT(*)::int AS n FROM tbl_arc WHERE rfq_id = $1`,
        [rfq_id]
      );
      expect(afterArc.n).toBe(beforeArc.n); // no new envelope
      const arcItems = await db.any(
        `SELECT ai.id FROM tbl_arc_item ai
           JOIN tbl_arc a ON a.id = ai.arc_id
          WHERE a.rfq_id = $1`,
        [rfq_id]
      );
      expect(arcItems.length).toBe(0);
      const stalePending = await db.any(
        `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC' AND status = 'PENDING'
            AND metadata->>'rfq_id' = $1::text`,
        [rfq_id]
      );
      expect(stalePending.length).toBe(0);
    } finally {
      // Restore the ARC policy so subsequent tests see the clean fixture.
      await db.none(`UPDATE tbl_approval_policies SET is_active = true WHERE id = $1`, [ARC_POLICY_ID]);
      for (const s of savedSteps) {
        await db.none(
          `INSERT INTO tbl_approval_policy_steps
            (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [s.approval_policy_id, s.step_order, s.decision_rule, s.approver_source_type, s.approver_source_id]
        );
      }
    }
  });
});
