// Phase 9 — product-level tests for the ARC envelope model.
//
// These exercise observable outcomes (rows persisted, idempotency,
// referential shape) over the production model functions. They do NOT
// assert on internal call counts or helper wiring — per the project's
// product-level test convention.
//
// Subjects under test:
//   - arcModel.ensureEnvelope: idempotent per (rfq, vendor); copies hotels.
//   - arcModel.upsertItem: keyed on (arc, product_variant, variant);
//     repeats are no-ops.
//   - arcModel.findActiveArcsForProducts: bulk lookup returns one row per
//     (active arc, hotel) match for an APPROVED item.
//   - arcModel.getEnvelopeDecisionCounts: counts pending/approved/rejected.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import arcModel from "../../app/models/arcModel.js";

const inserted = { rfqIds: [], arcIds: [] };

afterAll(async () => {
  await closeDb();
});

afterEach(async () => {
  if (inserted.arcIds.length) {
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [inserted.arcIds]);
    await db.none(`DELETE FROM tbl_arc_hotels WHERE arc_id = ANY($1::int[])`, [inserted.arcIds]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [inserted.arcIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  inserted.rfqIds = [];
  inserted.arcIds = [];
});

/** Create a tender RFQ with required ARC fields populated. */
async function makeTender(opts = {}) {
  const todayPlus = (days) =>
    new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    is_tender: 1,
    status: 4,
    is_published: 1,
    hospitality: opts.hospitality ?? IDS.hospitality.A,
    hotel: opts.hotel ?? IDS.hotels.A1,
    process: opts.process ?? IDS.processes.A_P1,
    ...opts,
  });
  inserted.rfqIds.push(rfq_id);
  // tender_scope + period dates aren't in the factory; set directly.
  await db.none(
    `UPDATE tbl_rfq
     SET tender_scope = $2,
         arc_period_from = $3::date,
         arc_period_to = $4::date
     WHERE id = $1`,
    [rfq_id, opts.tender_scope ?? "SINGLE", todayPlus(0), todayPlus(365)]
  );
  // Map at least one hotel via the canonical mappings table.
  const hotelIds = opts.hotel_ids ?? [opts.hotel ?? IDS.hotels.A1];
  for (const h of hotelIds) {
    await db.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (rfq_id, hotel_id) DO NOTHING`,
      [rfq_id, h, IDS.users.a1_proc_buyer]
    );
  }
  return rfq_id;
}

describe("ARC envelope — ensureEnvelope", () => {
  it("creates a per-(rfq, vendor) envelope and copies covered hotels", async () => {
    const rfqId = await makeTender({ hotel_ids: [IDS.hotels.A1, IDS.hotels.A2] });
    const env = await arcModel.ensureEnvelope({
      rfq_id: rfqId,
      vendor_id: IDS.users.vendor_alpha,
      created_by: IDS.users.a1_proc_buyer,
    });
    inserted.arcIds.push(env.id);

    expect(env).toBeTruthy();
    expect(env.rfq_id).toBe(rfqId);
    expect(env.vendor_id).toBe(IDS.users.vendor_alpha);
    expect(env.tender_scope).toBe("SINGLE");
    expect(env.status).toBe("PENDING_COMMITTEE");

    const hotels = await db.any(
      `SELECT hotel_id FROM tbl_arc_hotels WHERE arc_id = $1 ORDER BY hotel_id`,
      [env.id]
    );
    expect(hotels.map((h) => h.hotel_id).sort()).toEqual([IDS.hotels.A1, IDS.hotels.A2].sort());
  });

  it("is idempotent — calling twice for the same (rfq, vendor) returns the same envelope", async () => {
    const rfqId = await makeTender();
    const first = await arcModel.ensureEnvelope({
      rfq_id: rfqId,
      vendor_id: IDS.users.vendor_alpha,
      created_by: IDS.users.a1_proc_buyer,
    });
    inserted.arcIds.push(first.id);

    const second = await arcModel.ensureEnvelope({
      rfq_id: rfqId,
      vendor_id: IDS.users.vendor_alpha,
      created_by: IDS.users.a1_proc_buyer,
    });
    expect(second.id).toBe(first.id);

    const count = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_arc WHERE rfq_id = $1 AND vendor_id = $2`,
      [rfqId, IDS.users.vendor_alpha]
    );
    expect(count.n).toBe(1);
  });

  it("creates separate envelopes for different vendors on the same tender", async () => {
    const rfqId = await makeTender();
    const a = await arcModel.ensureEnvelope({
      rfq_id: rfqId,
      vendor_id: IDS.users.vendor_alpha,
      created_by: IDS.users.a1_proc_buyer,
    });
    inserted.arcIds.push(a.id);
    const b = await arcModel.ensureEnvelope({
      rfq_id: rfqId,
      vendor_id: IDS.users.vendor_beta,
      created_by: IDS.users.a1_proc_buyer,
    });
    inserted.arcIds.push(b.id);

    expect(a.id).not.toBe(b.id);
    expect(a.vendor_id).toBe(IDS.users.vendor_alpha);
    expect(b.vendor_id).toBe(IDS.users.vendor_beta);
  });

  it("rejects when the rfq is not a tender", async () => {
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      is_tender: 0,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      process: IDS.processes.A_P1,
    });
    inserted.rfqIds.push(rfq_id);

    await expect(
      arcModel.ensureEnvelope({
        rfq_id,
        vendor_id: IDS.users.vendor_alpha,
        created_by: IDS.users.a1_proc_buyer,
      })
    ).rejects.toThrow(/only valid for tenders/i);
  });
});

describe("ARC envelope — upsertItem", () => {
  it("inserts one row per (product_variant, variant) under the envelope", async () => {
    const rfqId = await makeTender();
    const env = await arcModel.ensureEnvelope({
      rfq_id: rfqId,
      vendor_id: IDS.users.vendor_alpha,
      created_by: IDS.users.a1_proc_buyer,
    });
    inserted.arcIds.push(env.id);

    const item = await arcModel.upsertItem({
      arc_id: env.id,
      rfq_product_id: 1,
      product_variant_id: 100,
      variant: null,
      quote_id: 0,
      unit_price: 100,
    });
    expect(item.status).toBe("PENDING");
    expect(item.unit_price).toBe("100.00");

    // Re-upsert: returns the same row, doesn't duplicate.
    const repeat = await arcModel.upsertItem({
      arc_id: env.id,
      rfq_product_id: 1,
      product_variant_id: 100,
      variant: null,
      quote_id: 0,
      unit_price: 999,
    });
    expect(repeat.id).toBe(item.id);

    const count = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_arc_item WHERE arc_id = $1`,
      [env.id]
    );
    expect(count.n).toBe(1);
  });
});

describe("ARC envelope — getEnvelopeDecisionCounts", () => {
  it("counts pending / approved / rejected items correctly", async () => {
    const rfqId = await makeTender();
    const env = await arcModel.ensureEnvelope({
      rfq_id: rfqId,
      vendor_id: IDS.users.vendor_alpha,
      created_by: IDS.users.a1_proc_buyer,
    });
    inserted.arcIds.push(env.id);

    // Three items, one approved, one rejected, one pending.
    await arcModel.upsertItem({
      arc_id: env.id, rfq_product_id: 1, product_variant_id: 100,
      quote_id: 0, unit_price: 100,
    });
    await arcModel.upsertItem({
      arc_id: env.id, rfq_product_id: 2, product_variant_id: 101,
      quote_id: 0, unit_price: 200,
    });
    await arcModel.upsertItem({
      arc_id: env.id, rfq_product_id: 3, product_variant_id: 102,
      quote_id: 0, unit_price: 300,
    });
    await db.none(
      `UPDATE tbl_arc_item SET status = 'APPROVED' WHERE arc_id = $1 AND product_variant_id = 100`,
      [env.id]
    );
    await db.none(
      `UPDATE tbl_arc_item SET status = 'REJECTED' WHERE arc_id = $1 AND product_variant_id = 101`,
      [env.id]
    );

    const counts = await arcModel.getEnvelopeDecisionCounts({ arc_id: env.id });
    expect(counts).toEqual({ total: 3, pending: 1, approved: 1, rejected: 1 });
  });
});

describe("ARC envelope — findActiveArcsForProducts (contracted-item lookup)", () => {
  it("returns rows when an APPROVED item covers (hotel, product_variant) and the envelope is ACTIVE within period", async () => {
    const rfqId = await makeTender({ hotel_ids: [IDS.hotels.A1, IDS.hotels.A2] });
    const env = await arcModel.ensureEnvelope({
      rfq_id: rfqId,
      vendor_id: IDS.users.vendor_alpha,
      created_by: IDS.users.a1_proc_buyer,
    });
    inserted.arcIds.push(env.id);

    await arcModel.upsertItem({
      arc_id: env.id, rfq_product_id: 1, product_variant_id: 555,
      quote_id: 0, unit_price: 250,
    });
    await db.none(
      `UPDATE tbl_arc SET status = 'ACTIVE' WHERE id = $1`,
      [env.id]
    );
    await db.none(
      `UPDATE tbl_arc_item SET status = 'APPROVED' WHERE arc_id = $1`,
      [env.id]
    );

    const rows = await arcModel.findActiveArcsForProducts({
      product_variant_ids: [555],
      hotel_ids: [IDS.hotels.A1],
    });
    expect(rows.length).toBe(1);
    expect(rows[0].arc_id).toBe(env.id);
    expect(rows[0].vendor_id).toBe(IDS.users.vendor_alpha);
    expect(rows[0].hotel_id).toBe(IDS.hotels.A1);
    expect(Number(rows[0].unit_price)).toBe(250);
  });

  it("does NOT return rows when the envelope's period_to is in the past", async () => {
    const rfqId = await makeTender();
    const env = await arcModel.ensureEnvelope({
      rfq_id: rfqId,
      vendor_id: IDS.users.vendor_alpha,
      created_by: IDS.users.a1_proc_buyer,
    });
    inserted.arcIds.push(env.id);

    await arcModel.upsertItem({
      arc_id: env.id, rfq_product_id: 1, product_variant_id: 555,
      quote_id: 0, unit_price: 250,
    });
    // Force expiry: period_from yesterday, period_to two days ago.
    await db.none(
      `UPDATE tbl_arc SET status = 'ACTIVE',
                          period_from = CURRENT_DATE - INTERVAL '5 days',
                          period_to = CURRENT_DATE - INTERVAL '2 days'
       WHERE id = $1`,
      [env.id]
    );
    await db.none(`UPDATE tbl_arc_item SET status = 'APPROVED' WHERE arc_id = $1`, [env.id]);

    const rows = await arcModel.findActiveArcsForProducts({
      product_variant_ids: [555],
      hotel_ids: [IDS.hotels.A1],
    });
    expect(rows.length).toBe(0);
  });

  it("does NOT return rows when items are rejected, even if the envelope is ACTIVE", async () => {
    const rfqId = await makeTender();
    const env = await arcModel.ensureEnvelope({
      rfq_id: rfqId,
      vendor_id: IDS.users.vendor_alpha,
      created_by: IDS.users.a1_proc_buyer,
    });
    inserted.arcIds.push(env.id);

    await arcModel.upsertItem({
      arc_id: env.id, rfq_product_id: 1, product_variant_id: 555,
      quote_id: 0, unit_price: 250,
    });
    await db.none(`UPDATE tbl_arc SET status = 'ACTIVE' WHERE id = $1`, [env.id]);
    await db.none(`UPDATE tbl_arc_item SET status = 'REJECTED' WHERE arc_id = $1`, [env.id]);

    const rows = await arcModel.findActiveArcsForProducts({
      product_variant_ids: [555],
      hotel_ids: [IDS.hotels.A1],
    });
    expect(rows.length).toBe(0);
  });
});
