// Phase 9 — product-level test for ARC Release → Contracted PO.
//
// What the buyer experiences end-to-end:
//   - Buyer searches for a contracted product (Phase 6 enrichment
//     already covered separately) and chooses "Create PO directly".
//   - The release-create endpoint validates eligibility and:
//       1. Inserts tbl_arc_release (status='DRAFT' → 'PO_DRAFTED').
//       2. Snapshots prices into tbl_arc_release_items at the
//          contracted unit_price; line totals computed by the same
//          pricing engine the open-market PO flow uses.
//       3. Drafts a tbl_rfq_purchase_order with:
//            * is_contracted = 1
//            * arc_release_id = the new release
//            * rfq_id = NULL (no parent RFQ — the parent is the ARC)
//            * total_value = sum of line totals
//            * vendor_id = the ARC's vendor
//       4. Inserts one tbl_purchase_order_product per release item with
//          unit_price + quantity + total_price + charges_meta.
//       5. Records lifecycle events ARC_RELEASE_CREATED + ARC_RELEASE_PO_DRAFTED.
//
// Validation contract (what the buyer cannot do):
//   - Cannot release against a VOID/EXPIRED envelope.
//   - Cannot release for a hotel not covered by the envelope.
//   - Cannot include arc_item_ids outside the envelope or rejected ones.
//   - Cannot release with quantity ≤ 0.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import arcModel from "../../app/models/arcModel.js";
import arcReleaseController from "../../app/controllers/arc/arcReleaseController.js";

afterAll(async () => { await closeDb(); });

const inserted = { rfqIds: [] };
afterEach(async () => {
  if (inserted.rfqIds.length) {
    const ids = inserted.rfqIds;
    // Cascade-aware teardown.
    const releaseIds = (await db.any(
      `SELECT r.id FROM tbl_arc_release r JOIN tbl_arc a ON a.id = r.arc_id WHERE a.rfq_id = ANY($1::int[])`, [ids]
    )).map((r) => r.id);
    if (releaseIds.length > 0) {
      const poIds = (await db.any(
        `SELECT id FROM tbl_rfq_purchase_order WHERE arc_release_id = ANY($1::int[])`, [releaseIds]
      )).map((r) => r.id);
      if (poIds.length > 0) {
        await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
        await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);
      }
      await db.none(`DELETE FROM tbl_arc_release_items WHERE arc_release_id = ANY($1::int[])`, [releaseIds]);
      await db.none(`DELETE FROM tbl_arc_release WHERE id = ANY($1::int[])`, [releaseIds]);
    }
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id IN (SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[]))`, [ids]);
    await db.none(`DELETE FROM tbl_arc_hotels WHERE arc_id IN (SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[]))`, [ids]);
    await db.none(`DELETE FROM tbl_arc WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'TENDER' AND entity_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [ids]);
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
    req: { user: opts.user, params: opts.params || {}, query: opts.query || {}, body: opts.body || {} },
    res, next: jest.fn(), calls,
  };
}

/**
 * Build an ACTIVE ARC envelope ready for release with two APPROVED
 * line items at distinct prices.
 */
async function makeReleasableEnvelope({
  hotel_ids = [IDS.hotels.A1],
  vendor_id = IDS.users.vendor_alpha,
  envelope_status = "ACTIVE",
  period_from = "2026-01-01",
  period_to = "2027-12-31",
} = {}) {
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, is_tender, tender_publish_date,
        vendor_clarification_date, title, rfq_type, tender_scope,
        arc_period_from, arc_period_to)
     VALUES (nextval('tbl_rfq_id_seq'), 'release fixture', 'Phileein', 'a@b.test',
             'C', '+91-9999999999', NOW() + INTERVAL '7 days', 'Loc', 1, 1,
             $1, $1, NOW(), $2, $3, 1, NOW() - INTERVAL '30 days',
             NOW() + INTERVAL '5 days', 'Release fixture', 'TENDER', 'SINGLE',
             $4::date, $5::date)
     RETURNING id, rfq_no`,
    [IDS.users.a1_proc_buyer, IDS.hospitality.A, hotel_ids[0], period_from, period_to]
  );
  inserted.rfqIds.push(rfq.id);
  for (const h of hotel_ids) {
    await db.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [rfq.id, h, IDS.users.a1_proc_buyer]
    );
  }

  const products = [];
  for (const pv of [101, 102]) {
    const p = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfq.id, pv]
    );
    products.push({ id: p.id, product_variant_id: pv });
  }

  const env = await arcModel.ensureEnvelope({
    rfq_id: rfq.id, vendor_id, created_by: IDS.users.a1_proc_buyer,
  });
  await db.none(
    `UPDATE tbl_arc SET status = $2, period_from = $3, period_to = $4 WHERE id = $1`,
    [env.id, envelope_status, period_from, period_to]
  );

  // Two approved items: one at ₹100, one at ₹200, with distinct charges.
  const items = [];
  for (const [i, p] of products.entries()) {
    const it = await arcModel.upsertItem({
      arc_id: env.id, rfq_product_id: p.id, product_variant_id: p.product_variant_id,
      variant: 0, quote_id: 0,
      unit_price: i === 0 ? 100.50 : 200.00,
      // Realistic charges_meta shape — pricing engine consumes these.
      charges_meta: { tax: 18, tax_mode: "percentage", other_charges: [] },
    });
    await db.none(
      `UPDATE tbl_arc_item SET status = 'APPROVED', approved_at = NOW(), approved_by = $2 WHERE id = $1`,
      [it.id, IDS.users.a1_proc_commApp]
    );
    items.push({ ...it, status: 'APPROVED' });
  }

  return { rfq, env, items, products };
}

describe("ARC Release → Contracted PO", () => {
  it("happy path: drafts a Contracted PO with snapshotted prices, correct totals, and the right is_contracted/arc_release_id flags", async () => {
    const { rfq, env, items } = await makeReleasableEnvelope();

    // Buyer wants 10 of product 1 (unit_price 100.50) + 5 of product 2 (200.00).
    // Pricing engine treats charges_meta.tax=18% as a % uplift on the line,
    // and Math.round's the line total (per pricingEngine.calculateLineTotal):
    //   line 1: round((100.50 * 10) * 1.18) = round(1185.90) = 1186
    //   line 2: round((200.00 * 5)  * 1.18) = round(1180.00) = 1180
    //   total: 2366
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        arc_id: env.id,
        hotel_id: IDS.hotels.A1,
        items: [
          { arc_item_id: items[0].id, quantity: 10 },
          { arc_item_id: items[1].id, quantity: 5 },
        ],
      },
    });
    await arcReleaseController.createRelease(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.status).toBe(1);
    const { release_id, po_id, vendor_id, total_value } = m.calls.body.data;
    expect(release_id).toBeTruthy();
    expect(po_id).toBeTruthy();
    expect(vendor_id).toBe(IDS.users.vendor_alpha);
    expect(Number(total_value)).toBe(2366);

    // (a) Release header: PO_DRAFTED after the PO insertion succeeds.
    const release = await db.one(
      `SELECT * FROM tbl_arc_release WHERE id = $1`, [release_id]
    );
    expect(release.status).toBe("PO_DRAFTED");
    expect(release.arc_id).toBe(env.id);
    expect(release.hotel_id).toBe(IDS.hotels.A1);
    expect(release.vendor_id).toBe(IDS.users.vendor_alpha);
    expect(Number(release.total_value)).toBe(2366);

    // (b) Release items: one row per cell, snapshotted prices.
    const releaseItems = await db.any(
      `SELECT * FROM tbl_arc_release_items WHERE arc_release_id = $1 ORDER BY arc_item_id`,
      [release_id]
    );
    expect(releaseItems.length).toBe(2);
    expect(Number(releaseItems[0].unit_price)).toBe(100.50);
    expect(Number(releaseItems[0].quantity)).toBe(10);
    expect(Number(releaseItems[0].total_price)).toBe(1186);
    expect(Number(releaseItems[1].unit_price)).toBe(200.00);
    expect(Number(releaseItems[1].quantity)).toBe(5);
    expect(Number(releaseItems[1].total_price)).toBe(1180);

    // (c) Contracted PO: rfq_id NULL, is_contracted=1, arc_release_id set,
    //     vendor + total_value carried over.
    const po = await db.one(`SELECT * FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);
    expect(po.is_contracted).toBe(1);
    expect(po.arc_release_id).toBe(release_id);
    expect(po.rfq_id).toBeNull();
    expect(po.finalized_vendor_id).toBe(IDS.users.vendor_alpha);
    expect(Number(po.total_value)).toBe(2366);

    // (d) PO products: one row per release line with the correct calc.
    const poProducts = await db.any(
      `SELECT * FROM tbl_purchase_order_product WHERE purchase_order_id = $1 ORDER BY id`,
      [po_id]
    );
    expect(poProducts.length).toBe(2);
    expect(Number(poProducts[0].quantity)).toBe(10);
    expect(Number(poProducts[0].unit_price)).toBe(100.50);
    expect(Number(poProducts[0].total_price)).toBe(1186);
    expect(Number(poProducts[1].quantity)).toBe(5);
    expect(Number(poProducts[1].unit_price)).toBe(200.00);
    expect(Number(poProducts[1].total_price)).toBe(1180);

    // (e) Lifecycle events: ARC_RELEASE_CREATED + ARC_RELEASE_PO_DRAFTED.
    const lifecycle = await db.any(
      `SELECT stage FROM tbl_lifecycle_history
        WHERE entity_type = 'TENDER' AND entity_id = $1
          AND stage IN ('ARC_RELEASE_CREATED','ARC_RELEASE_PO_DRAFTED')
        ORDER BY id`,
      [rfq.id]
    );
    expect(lifecycle.map((r) => r.stage)).toEqual(['ARC_RELEASE_CREATED', 'ARC_RELEASE_PO_DRAFTED']);
  });

  it("rejects release against a VOID envelope", async () => {
    const { env, items } = await makeReleasableEnvelope({ envelope_status: "VOID" });
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        arc_id: env.id, hotel_id: IDS.hotels.A1,
        items: [{ arc_item_id: items[0].id, quantity: 1 }],
      },
    });
    await arcReleaseController.createRelease(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/release requires ACTIVE\/DOC_GENERATED/i);
  });

  it("rejects release against an expired envelope (period_to < today)", async () => {
    const { env, items } = await makeReleasableEnvelope({
      period_from: "2024-01-01", period_to: "2024-12-31",
    });
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        arc_id: env.id, hotel_id: IDS.hotels.A1,
        items: [{ arc_item_id: items[0].id, quantity: 1 }],
      },
    });
    await arcReleaseController.createRelease(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/expired/i);
  });

  it("rejects release for a hotel not covered by the envelope", async () => {
    const { env, items } = await makeReleasableEnvelope({ hotel_ids: [IDS.hotels.A1] });
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        arc_id: env.id, hotel_id: IDS.hotels.A2, // not in tbl_arc_hotels
        items: [{ arc_item_id: items[0].id, quantity: 1 }],
      },
    });
    await arcReleaseController.createRelease(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/not covered by this ARC/i);
  });

  it("rejects release with quantity <= 0", async () => {
    const { env, items } = await makeReleasableEnvelope();
    for (const badQty of [0, -1]) {
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        body: {
          arc_id: env.id, hotel_id: IDS.hotels.A1,
          items: [{ arc_item_id: items[0].id, quantity: badQty }],
        },
      });
      await arcReleaseController.createRelease(m.req, m.res);
      expect(m.calls.status).toBe(400);
      expect(m.calls.body.message).toMatch(/quantity > 0/i);
    }
  });

  it("rejects release that includes an arc_item from a different envelope or a rejected cell", async () => {
    const env1 = await makeReleasableEnvelope();
    const env2 = await makeReleasableEnvelope({ vendor_id: IDS.users.vendor_beta });

    // Try to release env1 using an arc_item from env2.
    let m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        arc_id: env1.env.id, hotel_id: IDS.hotels.A1,
        items: [{ arc_item_id: env2.items[0].id, quantity: 1 }],
      },
    });
    await arcReleaseController.createRelease(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/do not belong to this ARC|not approved/i);

    // Reject one item on env1 then try to release it.
    await db.none(`UPDATE tbl_arc_item SET status = 'REJECTED' WHERE id = $1`, [env1.items[0].id]);
    m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        arc_id: env1.env.id, hotel_id: IDS.hotels.A1,
        items: [{ arc_item_id: env1.items[0].id, quantity: 1 }],
      },
    });
    await arcReleaseController.createRelease(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/do not belong to this ARC|not approved/i);
  });

  it("getEligibleVendors returns the active ARC vendors for the (hotel, product) pair", async () => {
    const env1 = await makeReleasableEnvelope({ vendor_id: IDS.users.vendor_alpha });
    const env2 = await makeReleasableEnvelope({ vendor_id: IDS.users.vendor_beta });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      query: {
        product_variant_id: env1.items[0].product_variant_id,
        hotel_id: IDS.hotels.A1,
      },
    });
    await arcReleaseController.getEligibleVendors(m.req, m.res);

    expect(m.calls.status).toBe(200);
    const vendorIds = m.calls.body.data.map((r) => r.vendor_id);
    expect(vendorIds.sort()).toEqual([IDS.users.vendor_alpha, IDS.users.vendor_beta].sort());
  });

  it("getRelease returns the full release with line items and the drafted PO link", async () => {
    const { env, items } = await makeReleasableEnvelope();
    const createMock = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        arc_id: env.id, hotel_id: IDS.hotels.A1,
        items: [{ arc_item_id: items[0].id, quantity: 3 }],
      },
    });
    await arcReleaseController.createRelease(createMock.req, createMock.res);
    const { release_id, po_id } = createMock.calls.body.data;

    const getMock = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      params: { id: release_id },
    });
    await arcReleaseController.getRelease(getMock.req, getMock.res);
    expect(getMock.calls.status).toBe(200);
    expect(getMock.calls.body.data.id).toBe(release_id);
    expect(getMock.calls.body.data.items.length).toBe(1);
    expect(getMock.calls.body.data.po?.id).toBe(po_id);
  });
});
