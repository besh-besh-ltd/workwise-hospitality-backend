// MRP (tax-inclusive) money accuracy — quote line -> PO line -> printed PO.
//
// WHY THIS SUITE EXISTS (production defect, RFQ 363 / #535917):
//
//   In MRP mode a vendor enters a GST-INCLUSIVE price (an MRP) and a discount.
//   The system reverse-calculates a tax-EXCLUSIVE base and stores it in
//   tbl_quote_items.unit_price, which is numeric(15,2). For almost every GST
//   rate that base is a repeating decimal:
//
//       400 / 1.18 = 338.9830508474...  ->  stored 338.98
//       338.98 x 75 x 1.18              =   29,999.73     (vendor offered 30,000)
//
//   Rounding the rate BEFORE multiplying by quantity loses up to half a paisa
//   per unit, so the error scales with quantity. Measured live:
//
//       MOUSE          MRP   500 less 20% x 75  ->  30,000.00   showed  29,999.73
//       KEYBOARD       MRP 1,300 less 15% x 50  ->  55,250.00   showed  55,249.96
//       LAPTOP SCREEN  MRP 6,000 less  5% x 20  -> 1,14,000.00  showed 1,14,000.04
//
//   The drift carried into tbl_purchase_order_product and the generated PO PDF,
//   so the PO stated a number the vendor never quoted.
//
// THE FIX these tests lock in: the tax-inclusive amount is authoritative.
// buildAuthoritativePOPayload re-derives the rate from the MRP audit columns at
// full precision, and the engine prices MRP lines from `net_inclusive x qty`.
//
// NOTE ON FIXTURES: every quote item below is seeded with the ALREADY-DRIFTED
// 2dp unit_price that production rows actually contain (338.98, not the exact
// rate). That is deliberate — it proves existing stored quotes re-derive
// correctly on read rather than needing a data backfill.
//
// Pattern B (commit + cleanup, CONVENTIONS.md §2): draftPO opens its own
// db.tx against the production connection, so it cannot participate in a
// withTx rollback. Every id inserted is tracked and deleted in afterEach.

import { describe, it, expect, afterEach, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { draftPO, buildAuthoritativePOPayload } from "../../app/controllers/po/purchaseOrderController.js";
import { buildPOTemplatePricing } from "../../app/helper/poTemplatePricing.js";

afterAll(async () => { await closeDb(); });

// Scope fixtures to this run — two sessions share one test database.
const RUN_TAG = process.env.TEST_RUN_ID || "local";
let RFQ_NO_COUNTER = 9_600_000;
const nextRfqNo = () => ++RFQ_NO_COUNTER;

const inserted = { rfqIds: [], poIds: [], quoteIds: [] };

afterEach(async () => {
  if (inserted.poIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::bigint[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [inserted.poIds]);
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
  inserted.poIds = [];
  inserted.quoteIds = [];
});

/** q2 helper mirroring the engine's boundary rounding. */
const q2 = (n) => Math.round(n * 100) / 100;

/**
 * Seed an RFQ + vendor quote + one quote item, then award it through the REAL
 * production sequence: buildAuthoritativePOPayload -> draftPO. That ordering
 * matters — the authoritative re-read is the step that repairs an MRP line.
 *
 * `line.pricing_method === 'MRP'` seeds the audit columns and stores the
 * drifted 2dp unit_price; Traditional lines store unit_price verbatim.
 */
async function awardLineToPo(line) {
  const rfqNo = nextRfqNo();
  const rfq = await db.one(
    `INSERT INTO tbl_rfq (
       rfq_no, comment, company_name, response_email, contact_name, contact_number,
       bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
       hospitality_company_id, hotel_id, process_id, is_tender, title)
     VALUES ($1, '', '', 'buyer@test', 'buyer', '0',
             ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') + INTERVAL '7 days')::text,
             'Mumbai', 1, 1, $2, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'), $3, $4, $5, 0, $6)
     RETURNING id, rfq_no`,
    [rfqNo, IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1,
     `MRP Rounding ${RUN_TAG} ${rfqNo}`]
  );
  inserted.rfqIds.push(rfq.id);

  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp", is_regret, global_charges, pricing_method)
     VALUES ($1, $2, $3, $3, 1, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'), 0, '[]'::jsonb, $4)
     RETURNING id`,
    [rfq.id, rfq.rfq_no, IDS.users.vendor_alpha, line.pricing_method || "TRADITIONAL"]
  );
  inserted.quoteIds.push(quote.id);

  const rfqProduct = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
    [rfq.id]
  );

  const isMrp = line.pricing_method === "MRP";
  // What the vendor offered per unit, GST-inclusive.
  const netInclusive = isMrp ? line.mrp - (line.mrp * line.discount) / 100 : null;
  // The lossy 2dp rate production actually has on disk today.
  const storedUnitPrice = isMrp ? q2(netInclusive / (1 + line.gst / 100)) : line.unit_price;

  const quoteItem = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
        package_price, tax, freight_price, variant, comment, delivery_period, quantity,
        tax_mode, other_charges, pricing_method, entered_mrp, mrp_discount, mrp_discount_mode)
     VALUES ($1, $2, $3, 1, $4, $5, 0, $6, 0, 0, '', '7', $7, 'percentage', '[]'::jsonb, $8, $9, $10, $11)
     RETURNING id`,
    [rfq.id, rfq.rfq_no, quote.id, storedUnitPrice, 0, line.gst, String(line.qty),
     line.pricing_method || "TRADITIONAL",
     isMrp ? line.mrp : null,
     isMrp ? line.discount : null,
     isMrp ? "percentage" : null]
  );

  // Production award path. `unit_price` in the request body is client-supplied
  // (rfqValidation requires it) — pass the drifted value a browser would send,
  // so the test also proves the server no longer trusts it.
  const rawPayload = {
    rfq_id: rfq.id,
    project_id: null,
    quote_item_id: quoteItem.id,
    existing_po_id: null,
    selected_hierarchy: null,
    product_info: {
      rfq_product_id: rfqProduct.id,
      quantity: line.qty,
      unit: "NOS",
      unit_price: storedUnitPrice,
      charges_meta: { tax: line.gst, tax_mode: "percentage", other_charges: [] },
      finalized_vendor_id: IDS.users.vendor_alpha,
    },
  };

  const result = await db.tx(async (t) => {
    const authPayload = await buildAuthoritativePOPayload(rawPayload, t);
    return draftPO(authPayload, { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A }, t);
  });
  inserted.poIds.push(result.po_id);

  const poLine = await db.one(
    `SELECT quantity, unit_price, total_price, charges_meta
       FROM tbl_purchase_order_product WHERE purchase_order_id = $1`,
    [result.po_id]
  );
  const header = await db.one(
    `SELECT total_value FROM tbl_rfq_purchase_order WHERE id = $1`, [result.po_id]
  );

  return { po_id: result.po_id, poLine, header, quoteItemId: quoteItem.id };
}

// ─────────────────────────────────────────────────────────────────────────
//  The three lines measured live on RFQ 363 / #535917.
// ─────────────────────────────────────────────────────────────────────────

const REAL_CASES = [
  { label: "MOUSE — MRP ₹500 less 20% × 75",           mrp: 500,  discount: 20, qty: 75, gst: 18, intended: 30000,  drifted: 29999.73 },
  { label: "KEYBOARD — MRP ₹1,300 less 15% × 50",      mrp: 1300, discount: 15, qty: 50, gst: 18, intended: 55250,  drifted: 55249.96 },
  { label: "LAPTOP SCREEN — MRP ₹6,000 less 5% × 20",  mrp: 6000, discount: 5,  qty: 20, gst: 18, intended: 114000, drifted: 114000.04 },
];

describe("MRP rounding — the PO states the amount the vendor offered", () => {
  it.each(REAL_CASES)(
    "$label: PO line total is ₹$intended, not ₹$drifted",
    async ({ mrp, discount, qty, gst, intended, drifted }) => {
      const { poLine, header } = await awardLineToPo({
        pricing_method: "MRP", mrp, discount, qty, gst,
      });

      expect(Number(poLine.total_price)).toBe(intended);
      expect(Number(poLine.total_price)).not.toBe(drifted);
      // No global charges on these lines, so the header grand total matches.
      expect(Number(header.total_value)).toBe(intended);
    }
  );

  it.each(REAL_CASES)(
    "$label: the printed PO recomputes to ₹$intended from the stored PO line",
    async ({ mrp, discount, qty, gst, intended }) => {
      const { poLine } = await awardLineToPo({
        pricing_method: "MRP", mrp, discount, qty, gst,
      });

      // The PDF does not print the stored total — it re-runs the engine off
      // unit_price x quantity (poTemplatePricing.buildEngineInput). This is the
      // step that used to reintroduce the drift on the document itself.
      const pricing = buildPOTemplatePricing(
        [{
          quantity: poLine.quantity,
          unit_price: poLine.unit_price,
          tax: gst,
          tax_mode: "percentage",
          other_charges: [],
        }],
        "gst",
        []
      );

      // `total_price` is the raw engine number; `subtotal`/`totalPrice` are the
      // formatted strings the template actually prints.
      expect(pricing.items[0].total_price).toBe(intended);
      expect(Number(pricing.items[0].subtotal)).toBe(intended);
      expect(Number(pricing.totalPrice)).toBe(intended);
    }
  );

  it("the GST split sums back to the intended total even though the split itself repeats", async () => {
    // 30,000 / 1.18 = 25,423.728813... — the exclusive half is a repeating
    // decimal, so neither part is representable at 2dp. What must hold is that
    // the two parts still add up to what the vendor offered.
    const { poLine } = await awardLineToPo({
      pricing_method: "MRP", mrp: 500, discount: 20, qty: 75, gst: 18,
    });

    const pricing = buildPOTemplatePricing(
      [{ quantity: poLine.quantity, unit_price: poLine.unit_price, tax: 18, tax_mode: "percentage", other_charges: [] }],
      "gst",
      []
    );
    const item = pricing.items[0];

    expect(Number(item.basic_amount)).toBe(25423.73);
    expect(Number(item.tax_amount)).toBe(4576.27);
    expect(q2(Number(item.basic_amount) + Number(item.tax_amount))).toBe(30000);
  });

  it("re-derives from the MRP audit columns, discarding the drifted unit_price the client sent", async () => {
    // The seeded quote item holds unit_price = 338.98 (the rounded rate every
    // existing MRP row on disk has) and the award payload echoes it back. The
    // PO must still land on 30,000 — i.e. the value was re-derived from
    // entered_mrp/mrp_discount, not taken from either the row or the request.
    const { poLine, quoteItemId } = await awardLineToPo({
      pricing_method: "MRP", mrp: 500, discount: 20, qty: 75, gst: 18,
    });

    const stored = await db.one(
      `SELECT unit_price, entered_mrp, mrp_discount FROM tbl_quote_items WHERE id = $1`,
      [quoteItemId]
    );
    expect(Number(stored.unit_price)).toBe(338.98);   // untouched, still drifted
    expect(Number(stored.entered_mrp)).toBe(500);
    expect(Number(stored.mrp_discount)).toBe(20);

    // The PO's own rate carries full precision (the column is unconstrained
    // numeric), which is what keeps later PO edits and the PDF exact.
    expect(Number(poLine.unit_price)).toBeCloseTo(338.9830508, 6);
    expect(Number(poLine.total_price)).toBe(30000);
  });

  it("preserves a genuine decimal instead of rounding to whole rupees", async () => {
    // MRP 99.99 less 3% = 96.9903/unit x 7 = 678.9321 -> 678.93. The rule is
    // "keep what the vendor meant", which is not the same as "make it whole".
    const { poLine } = await awardLineToPo({
      pricing_method: "MRP", mrp: 99.99, discount: 3, qty: 7, gst: 12,
    });

    expect(Number(poLine.total_price)).toBe(678.93);
    expect(Number.isInteger(Number(poLine.total_price))).toBe(false);
  });

  it("Traditional (tax-exclusive) awards are completely unaffected", async () => {
    // Same shape, no MRP columns: unit_price is the real exclusive rate and the
    // arithmetic must be byte-identical to before this fix existed.
    const { poLine, header } = await awardLineToPo({
      pricing_method: "TRADITIONAL", unit_price: 338.98, qty: 75, gst: 18,
    });

    // 338.98 x 75 = 25,423.50, +18% = 29,999.73. Unchanged legacy behaviour —
    // a Traditional line means the vendor really did quote ₹338.98 exclusive.
    expect(Number(poLine.total_price)).toBe(29999.73);
    expect(Number(header.total_value)).toBe(29999.73);
    expect(Number(poLine.unit_price)).toBe(338.98);
  });
});
