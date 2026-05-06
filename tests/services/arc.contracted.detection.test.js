// Phase 9 — product-level test for contracted-item detection.
//
// What the buyer experiences end-to-end:
//   - When the buyer types into Magic Search (or any add-product flow)
//     with a hotel context selected, every returned product is enriched
//     with `arc_info`. Products under an active ARC contract for the
//     selected hotel get `arc_info.is_under_arc=true` plus the list of
//     covering ARCs. Other products get `arc_info.is_under_arc=false`.
//
//   - Multi-vendor ARCs are reflected: a product covered by two
//     vendors' envelopes returns both in `arc_info.arcs`.
//
//   - Expired / VOID / rejected-item ARCs do NOT count as covering.
//
//   - Hotel-scoped: a contract on hotel A1 does NOT mark the product
//     contracted when the buyer is shopping for hotel A2.
//
//   - When no hotel is in scope, enrichment is skipped entirely —
//     a product never gets `is_under_arc=true` outside the hospitality
//     flow.
//
// We exercise the exported enrichProductsWithArcInfo helper directly.
// That's the unit-of-work for Phase 6 — searchProduct just calls it.
// Hitting the helper avoids the heavyweight product-search query
// (which would need product/variant/category/vendor-mapping seeds we
// don't otherwise need).

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import arcModel from "../../app/models/arcModel.js";
import { enrichProductsWithArcInfo } from "../../app/controllers/rfq/rfqController.js";

afterAll(async () => {
  await closeDb();
});

const inserted = { rfqIds: [] };
afterEach(async () => {
  if (inserted.rfqIds.length) {
    const ids = inserted.rfqIds;
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id IN (SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[]))`, [ids]);
    await db.none(`DELETE FROM tbl_arc_hotels WHERE arc_id IN (SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[]))`, [ids]);
    await db.none(`DELETE FROM tbl_arc WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
    inserted.rfqIds = [];
  }
});

/**
 * Seed an ARC envelope of the given status covering a (product,
 * hotel(s), vendor). period and item-status are knobs so each test can
 * exercise a specific covering condition.
 */
async function makeArcCovering({
  product_variant_id,
  hotel_ids = [IDS.hotels.A1],
  vendor_id = IDS.users.vendor_alpha,
  envelope_status = "ACTIVE",
  item_status = "APPROVED",
  period_from = "2027-01-01",
  period_to = "2027-12-31",
}) {
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, is_tender, tender_publish_date,
        vendor_clarification_date, title, rfq_type, tender_scope,
        arc_period_from, arc_period_to)
     VALUES (nextval('tbl_rfq_id_seq'), 'enrichment fixture', 'Phileein', 'a@b.test',
             'C', '+91-9999999999', NOW() + INTERVAL '7 days', 'Loc', 1, 1,
             $1, $1, NOW(), $2, $3, 1, NOW() - INTERVAL '30 days',
             NOW() + INTERVAL '5 days', 'Detection RC', 'TENDER', 'SINGLE', $4, $5)
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
  const product = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
    [rfq.id, product_variant_id]
  );
  const env = await arcModel.ensureEnvelope({
    rfq_id: rfq.id, vendor_id, created_by: IDS.users.a1_proc_buyer,
  });
  await db.none(`UPDATE tbl_arc SET status = $2, period_from = $3, period_to = $4 WHERE id = $1`,
    [env.id, envelope_status, period_from, period_to]);
  const item = await arcModel.upsertItem({
    arc_id: env.id, rfq_product_id: product.id, product_variant_id, variant: 0,
    quote_id: 0, unit_price: 100,
  });
  await db.none(`UPDATE tbl_arc_item SET status = $2 WHERE id = $1`, [item.id, item_status]);
  return { rfq, env, item };
}

const stubProduct = (id, name = `Test ${id}`) => ({
  id, product_variant_id: id, name,
});

describe("Contracted-item detection — enrichProductsWithArcInfo", () => {
  it("attaches arc_info.is_under_arc=true with full envelope details when (product, hotel) is under an active ARC", async () => {
    const variantId = 9001;
    await makeArcCovering({ product_variant_id: variantId });

    const result = await enrichProductsWithArcInfo([stubProduct(variantId)], [IDS.hotels.A1]);

    expect(result.length).toBe(1);
    expect(result[0].arc_info.is_under_arc).toBe(true);
    expect(result[0].arc_info.arcs.length).toBe(1);
    const arc = result[0].arc_info.arcs[0];
    expect(arc.vendor_id).toBe(IDS.users.vendor_alpha);
    expect(arc.hotel_id).toBe(IDS.hotels.A1);
    expect(arc.tender_scope).toBe("SINGLE");
    expect(Number(arc.unit_price)).toBe(100);
    expect(arc.envelope_status).toBe("ACTIVE");
    expect(arc.source_tender_id).toBeTruthy();
    expect(arc.source_rfq_no).toBeTruthy();
  });

  it("returns multiple arcs when two vendors hold an active ARC for the same (product, hotel)", async () => {
    const variantId = 9002;
    await makeArcCovering({ product_variant_id: variantId, vendor_id: IDS.users.vendor_alpha });
    await makeArcCovering({ product_variant_id: variantId, vendor_id: IDS.users.vendor_beta });

    const result = await enrichProductsWithArcInfo([stubProduct(variantId)], [IDS.hotels.A1]);

    expect(result[0].arc_info.is_under_arc).toBe(true);
    expect(result[0].arc_info.arcs.length).toBe(2);
    expect(result[0].arc_info.arcs.map((a) => a.vendor_id).sort())
      .toEqual([IDS.users.vendor_alpha, IDS.users.vendor_beta].sort());
  });

  it("does NOT mark a product contracted if the only covering ARC has expired", async () => {
    const variantId = 9003;
    await makeArcCovering({
      product_variant_id: variantId,
      period_from: "2024-01-01", period_to: "2024-12-31", // already past
    });

    const result = await enrichProductsWithArcInfo([stubProduct(variantId)], [IDS.hotels.A1]);

    expect(result[0].arc_info.is_under_arc).toBe(false);
    expect(result[0].arc_info.arcs).toEqual([]);
  });

  it("does NOT count VOID envelopes (committee rejected every cell)", async () => {
    const variantId = 9004;
    await makeArcCovering({
      product_variant_id: variantId,
      envelope_status: "VOID", item_status: "REJECTED",
    });

    const result = await enrichProductsWithArcInfo([stubProduct(variantId)], [IDS.hotels.A1]);

    expect(result[0].arc_info.is_under_arc).toBe(false);
  });

  it("does NOT count rejected items even when the parent envelope is ACTIVE", async () => {
    const variantId = 9005;
    await makeArcCovering({
      product_variant_id: variantId,
      envelope_status: "ACTIVE", item_status: "REJECTED",
    });

    const result = await enrichProductsWithArcInfo([stubProduct(variantId)], [IDS.hotels.A1]);

    expect(result[0].arc_info.is_under_arc).toBe(false);
  });

  it("hotel-scopes the lookup: ARC for hotel A1 does NOT show as contracted when the buyer searches for hotel A2", async () => {
    const variantId = 9006;
    await makeArcCovering({ product_variant_id: variantId, hotel_ids: [IDS.hotels.A1] });

    const result = await enrichProductsWithArcInfo([stubProduct(variantId)], [IDS.hotels.A2]);

    expect(result[0].arc_info.is_under_arc).toBe(false);
  });

  it("a product NOT under any ARC gets is_under_arc=false (open-market RFQ flow)", async () => {
    const variantId = 9007;
    // Intentionally do NOT seed an ARC for this variant.
    const result = await enrichProductsWithArcInfo([stubProduct(variantId)], [IDS.hotels.A1]);

    expect(result[0].arc_info.is_under_arc).toBe(false);
    expect(result[0].arc_info.arcs).toEqual([]);
  });

  it("when no hotel is in scope, enrichment is skipped — every product gets is_under_arc=false (the ARC lookup is not run)", async () => {
    const variantId = 9008;
    await makeArcCovering({ product_variant_id: variantId });

    const result = await enrichProductsWithArcInfo([stubProduct(variantId)], []);

    expect(result[0].arc_info.is_under_arc).toBe(false);
  });

  it("group ARC: contract covers MULTIPLE hotels, so the product shows as contracted for any of them", async () => {
    const variantId = 9009;
    await makeArcCovering({
      product_variant_id: variantId,
      hotel_ids: [IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3],
    });

    // Buyer on hotel A2 — covered.
    const a2Result = await enrichProductsWithArcInfo([stubProduct(variantId)], [IDS.hotels.A2]);
    expect(a2Result[0].arc_info.is_under_arc).toBe(true);

    // Buyer on hotel B1 — NOT covered (B1 is outside the group).
    const b1Result = await enrichProductsWithArcInfo([stubProduct(variantId)], [IDS.hotels.B1]);
    expect(b1Result[0].arc_info.is_under_arc).toBe(false);
  });

  it("returns a NEW array; input products are not mutated", async () => {
    const variantId = 9010;
    const input = [stubProduct(variantId)];
    const inputCopy = JSON.parse(JSON.stringify(input));
    const result = await enrichProductsWithArcInfo(input, [IDS.hotels.A1]);
    expect(result).not.toBe(input);
    expect(input).toEqual(inputCopy);
  });

  it("handles an empty product list without hitting the DB", async () => {
    const result = await enrichProductsWithArcInfo([], [IDS.hotels.A1]);
    expect(result).toEqual([]);
  });
});
