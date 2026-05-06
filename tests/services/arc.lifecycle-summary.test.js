// Phase 9 — product-level test for the tender lifecycle summary.
//
// What the buyer sees on the RFQ details page:
//   - Phase 1 label: "Tender Approval" when is_tender=1, "RFQ Approval"
//     otherwise. Same data shape; only the label differs.
//   - Phase 4 for tenders: "ARC Approval" with arc_envelopes[] data
//     (one per vendor) and ARC-typed approval instances. NO PO data
//     is surfaced — the PO list is downstream of ARC release, not part
//     of the tender's own lifecycle.
//   - Phase 4 for RFQs: "Purchase Order" — unchanged; preserves the
//     legacy purchase_orders[] + PO instance data.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import arcModel from "../../app/models/arcModel.js";
import rfqModel from "../../app/models/rfqModel.js";

afterAll(async () => { await closeDb(); });

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

const makeRfq = async ({ is_tender, scope = null, hotel_ids = [IDS.hotels.A1] }) => {
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, is_tender, tender_publish_date,
        vendor_clarification_date, title, rfq_type, tender_scope,
        arc_period_from, arc_period_to)
     VALUES (nextval('tbl_rfq_id_seq'), 'lifecycle fixture', 'Phileein', 'a@b.test',
             'C', '+91-9999999999', NOW() + INTERVAL '7 days', 'Loc', 1, 1,
             $1, $1, NOW(), $2, $3, $5, NOW() - INTERVAL '30 days',
             NOW() + INTERVAL '5 days', 'Lifecycle fixture', 'TENDER', $4,
             '2027-01-01', '2027-12-31')
     RETURNING id, rfq_no`,
    [IDS.users.a1_proc_buyer, IDS.hospitality.A, hotel_ids[0], scope, is_tender]
  );
  inserted.rfqIds.push(rfq.id);
  for (const h of hotel_ids) {
    await db.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [rfq.id, h, IDS.users.a1_proc_buyer]
    );
  }
  return rfq;
};

describe("getLifecycleSummary — phase labels", () => {
  it("Phase 1 label reads 'Tender Approval' for a tender RFQ", async () => {
    const rfq = await makeRfq({ is_tender: 1, scope: 'SINGLE' });
    const summary = await rfqModel.getLifecycleSummary(rfq.id, IDS.users.a1_proc_buyer);
    const phase1 = summary.phases.find((p) => p.key === 'rfq_approval');
    expect(phase1).toBeTruthy();
    expect(phase1.label).toBe('Tender Approval');
  });

  it("Phase 1 label reads 'RFQ Approval' for a regular RFQ", async () => {
    const rfq = await makeRfq({ is_tender: 0, scope: null });
    const summary = await rfqModel.getLifecycleSummary(rfq.id, IDS.users.a1_proc_buyer);
    const phase1 = summary.phases.find((p) => p.key === 'rfq_approval');
    expect(phase1.label).toBe('RFQ Approval');
  });
});

describe("getLifecycleSummary — Phase 4 for tenders surfaces ARC envelopes (not POs)", () => {
  it("returns phase key='arc_approval' with arc_envelopes[] for a tender", async () => {
    const rfq = await makeRfq({ is_tender: 1, scope: 'SINGLE' });

    // Seed an envelope so Phase 4 has something concrete to summarise.
    const env = await arcModel.ensureEnvelope({
      rfq_id: rfq.id,
      vendor_id: IDS.users.vendor_alpha,
      created_by: IDS.users.a1_proc_buyer,
    });
    await db.none(
      `UPDATE tbl_arc SET status = 'ACTIVE', document_url = 'https://example.com/arc.pdf', document_generated_at = NOW() WHERE id = $1`,
      [env.id]
    );
    const product = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
      [rfq.id]
    );
    const item = await arcModel.upsertItem({
      arc_id: env.id, rfq_product_id: product.id, product_variant_id: 1,
      variant: 0, quote_id: 0, unit_price: 100,
    });
    await db.none(`UPDATE tbl_arc_item SET status = 'APPROVED' WHERE id = $1`, [item.id]);

    const summary = await rfqModel.getLifecycleSummary(rfq.id, IDS.users.a1_proc_buyer);
    const phase4 = summary.phases.find((p) => ['arc_approval', 'purchase_order'].includes(p.key));
    expect(phase4).toBeTruthy();
    expect(phase4.key).toBe('arc_approval');
    expect(phase4.label).toBe('ARC Approval');
    expect(Array.isArray(phase4.arc_envelopes)).toBe(true);
    expect(phase4.arc_envelopes.length).toBe(1);
    expect(phase4.arc_envelopes[0].arc_id).toBe(env.id);
    expect(phase4.arc_envelopes[0].vendor_id).toBe(IDS.users.vendor_alpha);
    expect(phase4.arc_envelopes[0].status).toBe('ACTIVE');
    expect(phase4.arc_envelopes[0].document_url).toBe('https://example.com/arc.pdf');
    expect(phase4.arc_envelopes[0].items_total).toBe(1);
    expect(phase4.arc_envelopes[0].items_approved).toBe(1);
    // The legacy purchase_orders field is NOT included on the tender path —
    // POs are operational call-offs, not part of the tender's lifecycle.
    expect(phase4.purchase_orders).toBeUndefined();
  });

  it("returns phase key='purchase_order' for a regular RFQ (legacy path unchanged)", async () => {
    const rfq = await makeRfq({ is_tender: 0, scope: null });
    const summary = await rfqModel.getLifecycleSummary(rfq.id, IDS.users.a1_proc_buyer);
    const phase4 = summary.phases.find((p) => ['arc_approval', 'purchase_order'].includes(p.key));
    expect(phase4.key).toBe('purchase_order');
    expect(phase4.label).toBe('Purchase Order');
    expect(phase4.arc_envelopes).toBeUndefined();
  });

  it("tender Phase 4 status = 'current' while any envelope is still PENDING_COMMITTEE", async () => {
    const rfq = await makeRfq({ is_tender: 1, scope: 'SINGLE' });
    const env = await arcModel.ensureEnvelope({
      rfq_id: rfq.id,
      vendor_id: IDS.users.vendor_alpha,
      created_by: IDS.users.a1_proc_buyer,
    });
    const product = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
      [rfq.id]
    );
    await arcModel.upsertItem({
      arc_id: env.id, rfq_product_id: product.id, product_variant_id: 1,
      variant: 0, quote_id: 0, unit_price: 100,
    });

    const summary = await rfqModel.getLifecycleSummary(rfq.id, IDS.users.a1_proc_buyer);
    const phase4 = summary.phases.find((p) => p.key === 'arc_approval');
    expect(phase4.status).toBe('current');
  });

  it("tender Phase 4 status = 'completed' when every envelope is terminal", async () => {
    const rfq = await makeRfq({ is_tender: 1, scope: 'SINGLE' });
    const env = await arcModel.ensureEnvelope({
      rfq_id: rfq.id,
      vendor_id: IDS.users.vendor_alpha,
      created_by: IDS.users.a1_proc_buyer,
    });
    await db.none(`UPDATE tbl_arc SET status = 'ACTIVE' WHERE id = $1`, [env.id]);

    const summary = await rfqModel.getLifecycleSummary(rfq.id, IDS.users.a1_proc_buyer);
    const phase4 = summary.phases.find((p) => p.key === 'arc_approval');
    expect(phase4.status).toBe('completed');
  });
});
