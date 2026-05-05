// Phase 9 — product-level test for the ARC document data shape.
//
// Asserts the buyer- + vendor-visible contract document is built with
// the right payload, BEFORE any Puppeteer / S3 work. The renderer above
// (generateAwardDocument) is just Handlebars + Puppeteer + a tempfile
// write; the truthful contract is the templateData that goes in.
//
// Locked invariants:
//   - NO `quantity` field anywhere on a product line — qty is a per-
//     call-off concern, not a master-contract concern (per product team).
//   - `period_from` and `period_to` always populated as formatted strings.
//   - `products` array contains ONLY APPROVED arc_items; rejected ones
//     never make it onto the signed document.
//   - Single ARC: `hotels.length === 1`, `is_group_arc === false`.
//   - Group ARC: `hotels.length >= 2`, `is_group_arc === true`, hotels
//     iterated in name order (Group ARC may span hospitality companies).
//   - `unit_price` is the snapshotted contracted price from arc_item.
//   - vendor + buyer_company + service_provider blocks present.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import arcModel from "../../app/models/arcModel.js";
import { buildArcTemplateData } from "../../app/controllers/arc/arcDocumentController.js";

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
    await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
    inserted.rfqIds = [];
  }
});

async function makeArcEnvelope({ scope, hotelIds }) {
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, is_tender, tender_publish_date,
        vendor_clarification_date, title, rfq_type, tender_scope,
        arc_period_from, arc_period_to)
     VALUES (nextval('tbl_rfq_id_seq'), 'doc test', 'Phileein', 'a@b.test',
             'C', '+91-9999999999', NOW() + INTERVAL '7 days', 'Loc', 1, 1,
             $1, $1, NOW(), $2, $3, 1, NOW() + INTERVAL '1 day',
             NOW() + INTERVAL '5 days', 'Doc shape RC', 'TENDER', $4,
             '2027-01-01', '2027-12-31')
     RETURNING id, rfq_no`,
    [IDS.users.a1_proc_buyer, IDS.hospitality.A, hotelIds[0], scope]
  );
  inserted.rfqIds.push(rfq.id);

  for (const hotelId of hotelIds) {
    await db.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [rfq.id, hotelId, IDS.users.a1_proc_buyer]
    );
  }

  const products = [];
  for (const pv of [1, 2, 3]) {
    const p = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfq.id, pv]
    );
    products.push({ id: p.id, product_variant_id: pv });
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, $2, 'Quantity', '100', 0), ($1, $2, 'Unit', $3, 0)`,
      [rfq.id, pv, pv === 1 ? "NOS" : pv === 2 ? "KG" : "LTR"]
    );
  }

  const env = await arcModel.ensureEnvelope({
    rfq_id: rfq.id, vendor_id: IDS.users.vendor_alpha, created_by: IDS.users.a1_proc_buyer,
  });

  // Three items: two APPROVED (different prices), one REJECTED.
  const i1 = await arcModel.upsertItem({
    arc_id: env.id, rfq_product_id: products[0].id, product_variant_id: 1, variant: 0,
    quote_id: 0, unit_price: 100.50,
  });
  const i2 = await arcModel.upsertItem({
    arc_id: env.id, rfq_product_id: products[1].id, product_variant_id: 2, variant: 0,
    quote_id: 0, unit_price: 200.00,
  });
  const i3 = await arcModel.upsertItem({
    arc_id: env.id, rfq_product_id: products[2].id, product_variant_id: 3, variant: 0,
    quote_id: 0, unit_price: 75.25,
  });
  await db.none(
    `UPDATE tbl_arc_item SET status = 'APPROVED', approved_at = NOW(), approved_by = $2 WHERE id = $1`,
    [i1.id, IDS.users.a1_proc_commApp]
  );
  await db.none(
    `UPDATE tbl_arc_item SET status = 'APPROVED', approved_at = NOW(), approved_by = $2 WHERE id = $1`,
    [i2.id, IDS.users.a1_proc_commApp]
  );
  await db.none(
    `UPDATE tbl_arc_item SET status = 'REJECTED', rejection_remarks = 'Out of band' WHERE id = $1`,
    [i3.id]
  );

  return { rfq, envelope: env, products };
}

describe("ARC document data shape", () => {
  it("Single ARC: builds the template payload with one hotel, products list, period, no quantity, only approved items", async () => {
    const { envelope } = await makeArcEnvelope({
      scope: "SINGLE",
      hotelIds: [IDS.hotels.A1],
    });

    const data = await buildArcTemplateData(envelope.id);

    // Period block always populated.
    expect(data.period_from).toBeTruthy();
    expect(data.period_to).toBeTruthy();
    expect(data.tender_scope).toBe("SINGLE");
    expect(data.is_group_arc).toBe(false);

    // Hotels: exactly one for Single ARC.
    expect(Array.isArray(data.hotels)).toBe(true);
    expect(data.hotels.length).toBe(1);
    expect(data.hotel).toBeTruthy();
    expect(data.hotel.name).toBe(data.hotels[0].name);

    // Products: only the two APPROVED items, in stable id order.
    expect(Array.isArray(data.products)).toBe(true);
    expect(data.products.length).toBe(2);
    expect(data.products.map((p) => Number(p.unit_price))).toEqual([100.50, 200.00]);

    // No quantity anywhere on any product row — that's the locked invariant.
    data.products.forEach((p) => {
      expect("quantity" in p).toBe(false);
      expect("qty" in p).toBe(false);
      expect("qty_value" in p).toBe(false);
    });

    // Vendor + buyer + service-provider headers populated.
    expect(data.vendor).toBeTruthy();
    expect(data.vendor.name).toBeTruthy();
    expect(data.service_provider).toBeTruthy();
    expect(data.service_provider.name).toBeTruthy();

    // Internal carry — used by renderer for filename, not by the template.
    expect(data._envelope).toBeTruthy();
    expect(data._envelope.vendor_id).toBe(IDS.users.vendor_alpha);
  });

  it("Group ARC: hotels iterates >=2 rows in name order; is_group_arc=true", async () => {
    const { envelope } = await makeArcEnvelope({
      scope: "GROUP",
      hotelIds: [IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3],
    });

    const data = await buildArcTemplateData(envelope.id);

    expect(data.tender_scope).toBe("GROUP");
    expect(data.is_group_arc).toBe(true);
    expect(data.hotels.length).toBe(3);
    // Ordered by name (per query) — stable ordering means the rendered
    // PDF lists hotels deterministically across runs.
    const names = data.hotels.map((h) => h.name);
    expect([...names].sort()).toEqual(names);

    // Each hotel row has name + address + (optional) company_name.
    data.hotels.forEach((h) => {
      expect(h.name).toBeTruthy();
      expect(h.address).toBeTruthy();
    });

    // Same product invariants apply to Group ARC.
    expect(data.products.length).toBe(2);
    data.products.forEach((p) => {
      expect("quantity" in p).toBe(false);
    });
  });

  it("throws when the envelope has zero approved items (would be a blank contract)", async () => {
    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, is_tender, tender_publish_date,
          vendor_clarification_date, title, rfq_type, tender_scope,
          arc_period_from, arc_period_to)
       VALUES (nextval('tbl_rfq_id_seq'), 'all-rejected', 'P', 'a@b.test',
               'C', '+91-9999999999', NOW() + INTERVAL '7 days', 'Loc', 1, 1,
               $1, $1, NOW(), $2, $3, 1, NOW() + INTERVAL '1 day',
               NOW() + INTERVAL '5 days', 'All rejected', 'TENDER', 'SINGLE',
               '2027-01-01', '2027-12-31')
       RETURNING id`,
      [IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1]
    );
    inserted.rfqIds.push(rfq.id);
    await db.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [rfq.id, IDS.hotels.A1, IDS.users.a1_proc_buyer]
    );
    const product = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
      [rfq.id]
    );
    const env = await arcModel.ensureEnvelope({
      rfq_id: rfq.id, vendor_id: IDS.users.vendor_alpha, created_by: IDS.users.a1_proc_buyer,
    });
    const it = await arcModel.upsertItem({
      arc_id: env.id, rfq_product_id: product.id, product_variant_id: 1, variant: 0,
      quote_id: 0, unit_price: 50,
    });
    await db.none(
      `UPDATE tbl_arc_item SET status = 'REJECTED' WHERE id = $1`, [it.id]
    );

    await expect(buildArcTemplateData(env.id)).rejects.toThrow(/No approved ARC items/i);
  });

  it("throws on a non-tender RFQ — guards against accidental document generation for plain RFQs", async () => {
    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, is_tender, tender_publish_date,
          vendor_clarification_date, title, rfq_type, tender_scope)
       VALUES (nextval('tbl_rfq_id_seq'), 'non-tender', 'X', 'a@b.test',
               'C', '+91-9999999999', NOW() + INTERVAL '7 days', 'Loc', 1, 1,
               $1, $1, NOW(), $2, $3, 0, NULL, NULL, 'Non-tender', 'RFQ', NULL)
       RETURNING id`,
      [IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1]
    );
    inserted.rfqIds.push(rfq.id);
    // Force-create an envelope on the non-tender (would normally be impossible
    // through the controller — we bypass to exercise the guard).
    const env = await db.one(
      `INSERT INTO tbl_arc
         (rfq_id, vendor_id, hospitality_company_id, tender_scope, period_from, period_to,
          created_by, status)
       VALUES ($1, $2, $3, 'SINGLE', '2027-01-01', '2027-12-31', $4, 'PENDING_COMMITTEE')
       RETURNING id`,
      [rfq.id, IDS.users.vendor_alpha, IDS.hospitality.A, IDS.users.a1_proc_buyer]
    );

    await expect(buildArcTemplateData(env.id)).rejects.toThrow(/only valid for tenders/i);
  });
});
