// NEGOTIATION_QUOTE post-approval → PO drafting.
//
// This suite pins the ONE supported way an approved commercial award turns
// into a purchase order (Path A: the `po_payload` frozen by
// rfqController.finalize), and pins the removal of the legacy alternative
// ("Path B") that reconstructed a PO from `metadata.selected_quotes`.
//
// WHY PATH B WAS DELETED
//
//   Path B computed:
//       negotiationPrice = selectedQuote.quoted_price
//       totalValue       = quantity * negotiationPrice
//       unit_price       = negotiationPrice
//
//   but `tbl_negotiation_round_quotes.quoted_price` is a landed LINE TOTAL,
//   not a unit price — negotiationModel.js:157 says so explicitly ("it is
//   written straight from tbl_quote_items.total_price at both vendor-quote
//   write sites"), and rfqModel.js:1600 aliases `qi.total_price AS
//   quoted_price`. Verified read-only against production on 2026-08-01:
//   of 520 non-ARC round-quote rows, 466 equal the quote item's total_price
//   exactly and only 1 equals its unit_price (a quantity-1 line); mean
//   quantity on those rows is ~698.
//
//   So Path B would have drafted a PO roughly 700x the award value AND
//   written a line total into the unit-price column. It also produced a
//   materially different PO from Path A: no tax, no per-line charges, no
//   document-level global charges, no selected_hierarchy, and no
//   existing_po_id (so no merge — every line would spawn its own PO).
//
//   It had never executed: 1,523 of 1,524 approved NEGOTIATION_QUOTE
//   instances in production carry a po_payload (Path A), and the single
//   Path-B-shaped instance (id 56, rfq 208) carries is_tender: 1 and was
//   skipped by the branch's own `metadata.is_tender !== 1` guard — silently.
//   RFQ 208 has had zero POs since 2026-03-11 as a result.
//
// THE CONTRACT NOW: an instance that cannot be turned into a PO must say so.
// It records a NEGOTIATION_QUOTES_APPROVED_NO_PO lifecycle event (visible on
// the RFQ timeline) and logs an error — never silence.
//
// Pattern B (commit + cleanup, CONVENTIONS.md §2): the handler opens its own
// db.tx against the production connection, so withTx rollback isn't available.

import { describe, it, expect, afterEach, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { handleNegotiationQuotePostApproval } from "../../app/controllers/general/negotiationQuotePostApproval.js";

afterAll(async () => { await closeDb(); });

let RFQ_NO_COUNTER = 9_500_000;
const nextRfqNo = () => ++RFQ_NO_COUNTER;

const inserted = { rfqIds: [], quoteIds: [], instanceIds: [] };

afterEach(async () => {
  if (inserted.rfqIds.length) {
    const poIds = await db.any(
      `SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]
    );
    const ids = poIds.map((r) => r.id);
    if (ids.length) {
      await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::bigint[])`, [ids]);
      await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [ids]);
    }
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[]) AND entity_type IN ('RFQ','TENDER')`, [inserted.rfqIds]);
  }
  if (inserted.instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inserted.instanceIds]);
  }
  if (inserted.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [inserted.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [inserted.quoteIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  inserted.rfqIds = [];
  inserted.quoteIds = [];
  inserted.instanceIds = [];
});

/**
 * One RFQ, one product, one vendor quote line. `quantity` is deliberately
 * large (500) and `unit_price` small so a unit-price/line-total confusion is
 * impossible to miss in the assertions.
 */
async function seedAward({ isTender = 0, quantity = 500, unitPrice = 20, taxPct = 18 } = {}) {
  const rfqNo = nextRfqNo();
  const rfq = await db.one(
    `INSERT INTO tbl_rfq (
       rfq_no, comment, company_name, response_email, contact_name, contact_number,
       bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
       hospitality_company_id, hotel_id, process_id, is_tender, title)
     VALUES ($1, '', '', 'buyer@test', 'buyer', '0', (NOW() + INTERVAL '7 days')::text,
             'Mumbai', 1, 1, $2, $2, NOW(), $3, $4, $5, $6, $7)
     RETURNING id, rfq_no`,
    [rfqNo, IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1,
     isTender, `PostApproval RFQ ${rfqNo}`]
  );
  inserted.rfqIds.push(rfq.id);

  const rfqProduct = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
    [rfq.id]
  );

  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp", is_regret, global_charges)
     VALUES ($1, $2, $3, $3, 1, NOW(), 0, '[]'::jsonb) RETURNING id`,
    [rfq.id, rfq.rfq_no, IDS.users.vendor_alpha]
  );
  inserted.quoteIds.push(quote.id);

  // Landed line total = qty * unit_price * (1 + tax) = 500 * 20 * 1.18 = 11800
  const lineTotal = quantity * unitPrice * (1 + taxPct / 100);
  const quoteItem = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
        package_price, tax, freight_price, variant, comment, delivery_period, quantity,
        tax_mode, other_charges)
     VALUES ($1, $2, $3, 1, $4, $5, 0, $6, 0, 0, '', '7', $7, 'percentage', '[]'::jsonb)
     RETURNING id`,
    [rfq.id, rfq.rfq_no, quote.id, unitPrice, lineTotal, taxPct, String(quantity)]
  );

  return {
    rfq_id: rfq.id,
    rfq_product_id: rfqProduct.id,
    quote_id: quote.id,
    quote_item_id: quoteItem.id,
    quantity,
    unit_price: unitPrice,
    tax_pct: taxPct,
    line_total: lineTotal,
  };
}

async function seedApprovedInstance(entityId, metadata) {
  const row = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, metadata, completed_at)
     VALUES ('NEGOTIATION_QUOTE', $1, $2, 'APPROVED', 1, $3, $4, $5, $6, $7::jsonb, NOW())
     RETURNING id`,
    [entityId, IDS.policies.A1_P1_NEGOTIATION_QUOTE, IDS.hospitality.A, IDS.hotels.A1,
     IDS.departments.proc, IDS.users.a1_proc_buyer, JSON.stringify(metadata)]
  );
  inserted.instanceIds.push(row.id);
  return row.id;
}

const posForRfq = (rfqId) => db.any(
  `SELECT po.id, po.total_value, po.status,
          (SELECT COALESCE(SUM(p.total_price), 0) FROM tbl_purchase_order_product p WHERE p.purchase_order_id = po.id) AS line_sum,
          (SELECT MIN(p.unit_price) FROM tbl_purchase_order_product p WHERE p.purchase_order_id = po.id) AS unit_price
     FROM tbl_rfq_purchase_order po WHERE po.rfq_id = $1`,
  [rfqId]
);

const lifecycleFor = (rfqId) => db.any(
  `SELECT stage, action, remarks, metadata FROM tbl_lifecycle_history
    WHERE entity_id = $1 AND entity_type IN ('RFQ','TENDER') ORDER BY id`,
  [rfqId]
);

// ─────────────────────────────────────────────────────────────────────────

describe("handleNegotiationQuotePostApproval — Path A (po_payload)", () => {
  it("drafts a PO from the frozen po_payload with engine-computed totals", async () => {
    const award = await seedAward();

    const instanceId = await seedApprovedInstance(award.rfq_product_id, {
      rfq_id: award.rfq_id,
      rfq_product_id: award.rfq_product_id,
      vendor_id: IDS.users.vendor_alpha,
      quote_id: award.quote_item_id,
      is_tender: 0,
      po_user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      po_payload: {
        rfq_id: award.rfq_id,
        project_id: null,
        quote_item_id: award.quote_item_id,
        selected_hierarchy: null,
        product_info: {
          rfq_product_id: award.rfq_product_id,
          quantity: award.quantity,
          unit: "NOS",
          unit_price: award.unit_price,
          charges_meta: { tax: award.tax_pct, tax_mode: "percentage", other_charges: [] },
          finalized_vendor_id: IDS.users.vendor_alpha,
        },
      },
    });

    await handleNegotiationQuotePostApproval(instanceId, IDS.users.a1_proc_buyer, {});

    const pos = await posForRfq(award.rfq_id);
    expect(pos).toHaveLength(1);
    // 500 x 20 = 10,000 basic + 18% = 11,800 — the award value, not 500x it.
    expect(Number(pos[0].total_value)).toBeCloseTo(award.line_total, 2);
    expect(Number(pos[0].line_sum)).toBeCloseTo(award.line_total, 2);
    // The unit-price column holds a UNIT price.
    expect(Number(pos[0].unit_price)).toBeCloseTo(award.unit_price, 2);

    const events = await lifecycleFor(award.rfq_id);
    expect(events.map((e) => e.stage)).toContain("NEGOTIATION_QUOTES_APPROVED");
  });

  it("ignores an instance that is not APPROVED", async () => {
    const award = await seedAward();
    const instanceId = await seedApprovedInstance(award.rfq_product_id, {
      rfq_id: award.rfq_id,
      po_user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      po_payload: {
        rfq_id: award.rfq_id,
        quote_item_id: award.quote_item_id,
        product_info: {
          rfq_product_id: award.rfq_product_id,
          quantity: award.quantity,
          unit: "NOS",
          unit_price: award.unit_price,
          charges_meta: { tax: award.tax_pct, tax_mode: "percentage", other_charges: [] },
          finalized_vendor_id: IDS.users.vendor_alpha,
        },
      },
    });
    await db.none(`UPDATE tbl_approval_instances SET status = 'PENDING' WHERE id = $1`, [instanceId]);

    await handleNegotiationQuotePostApproval(instanceId, IDS.users.a1_proc_buyer, {});

    expect(await posForRfq(award.rfq_id)).toHaveLength(0);
    expect(await lifecycleFor(award.rfq_id)).toHaveLength(0);
  });
});

describe("handleNegotiationQuotePostApproval — Path B is gone", () => {
  it("a selected_quotes-only instance drafts NO purchase order", async () => {
    const award = await seedAward({ isTender: 0 });

    // Exactly the shape Path B matched: rfq_id + selected_quotes, no
    // po_payload, is_tender !== 1. quoted_price carries the LINE TOTAL,
    // which Path B would have multiplied by quantity (500) all over again.
    const instanceId = await seedApprovedInstance(award.rfq_product_id, {
      rfq_id: award.rfq_id,
      rfq_product_id: award.rfq_product_id,
      is_tender: 0,
      selected_quotes: [{
        vendor_id: IDS.users.vendor_alpha,
        quote_id: award.quote_id,
        quoted_price: award.line_total,
      }],
    });

    await handleNegotiationQuotePostApproval(instanceId, IDS.users.a1_proc_buyer, {});

    const pos = await posForRfq(award.rfq_id);
    expect(pos).toHaveLength(0);
  });

  it("a selected_quotes-only instance records a visible lifecycle event — never silence", async () => {
    const award = await seedAward({ isTender: 0 });
    const instanceId = await seedApprovedInstance(award.rfq_product_id, {
      rfq_id: award.rfq_id,
      rfq_product_id: award.rfq_product_id,
      is_tender: 0,
      selected_quotes: [{
        vendor_id: IDS.users.vendor_alpha,
        quote_id: award.quote_id,
        quoted_price: award.line_total,
      }],
    });

    await handleNegotiationQuotePostApproval(instanceId, IDS.users.a1_proc_buyer, {});

    const events = await lifecycleFor(award.rfq_id);
    const skipped = events.find((e) => e.stage === "NEGOTIATION_QUOTES_APPROVED_NO_PO");
    expect(skipped).toBeDefined();
    expect(skipped.remarks).toMatch(/po_payload/i);
    expect(skipped.metadata.approval_instance_id).toBe(instanceId);
    // And it must NOT masquerade as a successful award.
    expect(events.map((e) => e.stage)).not.toContain("NEGOTIATION_QUOTES_APPROVED");
  });

  it("the production instance-56 shape (is_tender: 1) is no longer skipped silently", async () => {
    // Instance 56 / RFQ 208: Path B's own `metadata.is_tender !== 1` guard
    // matched nothing, so the branch fell through and the handler returned
    // without a PO and without a trace. That RFQ has had no PO since
    // 2026-03-11. The same shape must now leave a visible record.
    const award = await seedAward({ isTender: 1 });
    const instanceId = await seedApprovedInstance(award.rfq_product_id, {
      rfq_id: award.rfq_id,
      rfq_product_id: award.rfq_product_id,
      is_tender: 1,
      selected_quotes: [{
        vendor_id: IDS.users.vendor_alpha,
        quote_id: award.quote_id,
        quoted_price: award.line_total,
      }],
    });

    await handleNegotiationQuotePostApproval(instanceId, IDS.users.a1_proc_buyer, {});

    expect(await posForRfq(award.rfq_id)).toHaveLength(0);

    const events = await db.any(
      `SELECT stage, entity_type, remarks FROM tbl_lifecycle_history
        WHERE entity_id = $1 AND entity_type IN ('RFQ','TENDER')`,
      [award.rfq_id]
    );
    const skipped = events.find((e) => e.stage === "NEGOTIATION_QUOTES_APPROVED_NO_PO");
    expect(skipped).toBeDefined();
    // Tenders are recorded against the TENDER timeline, matching Path A.
    expect(skipped.entity_type).toBe("TENDER");
  });
});
