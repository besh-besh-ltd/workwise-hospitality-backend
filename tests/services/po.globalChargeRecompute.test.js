// PO total_value recompute — document-level global charges on the EDIT path.
//
// WHY THIS SUITE EXISTS (production defect, PO 440 / po_number 138712):
//
//   handleUpdatePO used to hand-roll the global-charge loop and apply only
//   `norm.amount`, silently dropping each charge's `additional_tax` (e.g. the
//   18% GST levied on a 7% Transportation charge). The CREATE path
//   (draftPurchaseOrder's merge branch) and the MERGE path (mergeDraftPOs)
//   both delegate to pricingEngine.sumGlobalCharges, which includes it.
//   The result: a PO was correct the moment it was drafted and became wrong
//   the first time anybody edited it.
//
//   Verified in production on 2026-08-01: of 45 POs carrying global charges,
//   43 were correct and 2 were wrong — and both of the wrong ones had been
//   through an edit.
//
//   PO 440's exact shape is reproduced below:
//       6 lines summing            ₹16,939.00
//       Transportation 7%          ₹ 1,185.73   (applied — this part worked)
//       additional_tax 18% of that ₹   213.43   (DROPPED — the bug)
//       correct total              ₹18,338.16
//       stored total               ₹18,124.73
//
// These tests run Pattern B (commit + cleanup, CONVENTIONS.md §2): the
// function under test — handleUpdatePO — opens its own `db.tx(...)` against
// the production connection, so it cannot participate in a withTx rollback.
// Every id inserted is tracked and deleted in afterEach.

import { describe, it, expect, afterEach, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { handleUpdatePO } from "../../app/models/purchaseOrderModel.js";
import { draftPO } from "../../app/controllers/po/purchaseOrderController.js";

afterAll(async () => { await closeDb(); });

// ─────────────────────────────────────────────────────────────────────────
//  PO 440's real production shape.
// ─────────────────────────────────────────────────────────────────────────

// Six award lines. `expected_line_total` is what the pricing engine derives
// (qty x unit_price, plus base tax at tax_pct) and is asserted, not assumed.
const PO440_LINES = [
  { qty: 125, unit_price: 16,  tax_pct: 18, expected_line_total: 2360.00 },
  { qty: 50,  unit_price: 97,  tax_pct: 5,  expected_line_total: 5092.50 },
  { qty: 50,  unit_price: 48,  tax_pct: 5,  expected_line_total: 2520.00 },
  { qty: 10,  unit_price: 83,  tax_pct: 18, expected_line_total:  979.40 },
  { qty: 10,  unit_price: 462, tax_pct: 18, expected_line_total: 5451.60 },
  { qty: 3,   unit_price: 170, tax_pct: 5,  expected_line_total:  535.50 },
];

const PO440_LINE_SUBTOTAL = 16939.00;

// Legacy {tax, tax_mode} global-charge shape — exactly the JSONB stored on
// production PO 440. normalizeGlobalCharge maps `tax` -> `amount`.
const PO440_GLOBAL_CHARGES = [{
  tax: 7,
  name: "Transportation",
  slug: "transportation",
  comment: "Transportation",
  tax_mode: "percentage",
  is_global: true,
  additional_tax: 18,
  additional_tax_mode: "percentage",
}];

// 16939 + (7% = 1185.73) + (18% of 1185.73 = 213.4314) = 18338.1614 -> 18338.16
const PO440_CORRECT_TOTAL = 18338.16;
// What the buggy edit path stored: the additional_tax leg simply missing.
const PO440_BUGGY_TOTAL = 18124.73;

// ─────────────────────────────────────────────────────────────────────────
//  Setup / teardown bookkeeping
// ─────────────────────────────────────────────────────────────────────────

let RFQ_NO_COUNTER = 9_400_000;
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

/**
 * Builds a PO through the REAL create path (draftPO -> draftPurchaseOrder),
 * one call per line, exactly as rfqController.finalize does when a buyer
 * awards several products of an RFQ to the same vendor.
 *
 * Returns { po_id, rfq_id, line_ids } and leaves the PO in status 'draft'.
 */
async function buildPoViaCreatePath({ lines, globalCharges }) {
  const rfqNo = nextRfqNo();
  const rfq = await db.one(
    `INSERT INTO tbl_rfq (
       rfq_no, comment, company_name, response_email, contact_name, contact_number,
       bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
       hospitality_company_id, hotel_id, process_id, is_tender, title)
     VALUES ($1, '', '', 'buyer@test', 'buyer', '0', (NOW() + INTERVAL '7 days')::text,
             'Mumbai', 1, 1, $2, $2, NOW(), $3, $4, $5, 0, $6)
     RETURNING id, rfq_no`,
    [rfqNo, IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1, `GC Recompute RFQ ${rfqNo}`]
  );
  inserted.rfqIds.push(rfq.id);

  // One vendor quote carrying the document-level global charges — this is
  // where draftPO reads them from (tbl_quotes.global_charges).
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp", is_regret, global_charges)
     VALUES ($1, $2, $3, $3, 1, NOW(), 0, $4::jsonb) RETURNING id`,
    [rfq.id, rfq.rfq_no, IDS.users.vendor_alpha, JSON.stringify(globalCharges)]
  );
  inserted.quoteIds.push(quote.id);

  const built = [];
  let poId = null;

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const variantId = 1 + i;

    const rfqProduct = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfq.id, variantId]
    );

    const quoteItem = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
          package_price, tax, freight_price, variant, comment, delivery_period, quantity,
          tax_mode, other_charges)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 0, 0, '', '7', $8, 'percentage', '[]'::jsonb)
       RETURNING id`,
      [rfq.id, rfq.rfq_no, quote.id, variantId, L.unit_price, L.expected_line_total,
       L.tax_pct, String(L.qty)]
    );

    // The production award path: one draftPO call per finalized line, the
    // first creating the header and the rest merging onto it.
    const result = await db.tx((t) => draftPO({
      rfq_id: rfq.id,
      project_id: null,
      quote_item_id: quoteItem.id,
      existing_po_id: poId,
      selected_hierarchy: null,
      product_info: {
        rfq_product_id: rfqProduct.id,
        quantity: L.qty,
        unit: "NOS",
        unit_price: L.unit_price,
        charges_meta: { tax: L.tax_pct, tax_mode: "percentage", other_charges: [] },
        finalized_vendor_id: IDS.users.vendor_alpha,
      },
    }, { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A }, t));

    if (poId === null) {
      poId = result.po_id;
      inserted.poIds.push(poId);
    }
    built.push({ rfq_product_id: rfqProduct.id, quote_item_id: quoteItem.id });
  }

  return { po_id: poId, rfq_id: rfq.id, lines: built };
}

/** Reads back the stored header total as a JS number. */
async function readTotal(poId) {
  const row = await db.one(`SELECT total_value FROM tbl_rfq_purchase_order WHERE id = $1`, [poId]);
  return Number(row.total_value);
}

/**
 * Parks the PO in 'pending_approval' with no PENDING approval instance —
 * production PO 440's exact state when it was edited. handleUpdatePO's
 * trailing initiatePurchaseOrder call is then an idempotent no-op
 * (it only acts on status='draft'), which keeps this suite focused on the
 * total_value arithmetic and off the PDF/approver-email machinery.
 */
async function parkPendingApproval(poId) {
  await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'pending_approval' WHERE id = $1`, [poId]);
}

// ─────────────────────────────────────────────────────────────────────────

describe("handleUpdatePO — document-level global charges", () => {
  it("applies each global charge's additional_tax (production PO 440: ₹18,338.16, not ₹18,124.73)", async () => {
    const { po_id, lines } = await buildPoViaCreatePath({
      lines: PO440_LINES,
      globalCharges: PO440_GLOBAL_CHARGES,
    });

    // Guard the fixture itself: the six lines must really sum to ₹16,939.
    const sums = await db.one(
      `SELECT COALESCE(SUM(total_price), 0) AS s, COUNT(*)::int AS n
         FROM tbl_purchase_order_product WHERE purchase_order_id = $1`,
      [po_id]
    );
    expect(sums.n).toBe(6);
    expect(Number(sums.s)).toBeCloseTo(PO440_LINE_SUBTOTAL, 2);

    await parkPendingApproval(po_id);

    // The edit itself changes nothing about the money — it rewrites one
    // line's `unit`. The header must still be re-aggregated, and that
    // re-aggregation is what used to drop additional_tax.
    await handleUpdatePO(
      po_id,
      [{ path: `product[${lines[0].rfq_product_id}].unit`, newValue: "PCS" }],
      { id: IDS.users.a1_proc_buyer }
    );

    const stored = await readTotal(po_id);
    expect(stored).not.toBeCloseTo(PO440_BUGGY_TOTAL, 2); // the defect
    expect(stored).toBeCloseTo(PO440_CORRECT_TOTAL, 2);   // the contract
  });

  it("edit path total equals create path total for the same input (no drift, no double-count)", async () => {
    const { po_id, lines } = await buildPoViaCreatePath({
      lines: PO440_LINES,
      globalCharges: PO440_GLOBAL_CHARGES,
    });

    const afterCreate = await readTotal(po_id);
    expect(afterCreate).toBeCloseTo(PO440_CORRECT_TOTAL, 2);

    await parkPendingApproval(po_id);

    await handleUpdatePO(
      po_id,
      [{ path: `product[${lines[2].rfq_product_id}].unit`, newValue: "KG" }],
      { id: IDS.users.a1_proc_buyer }
    );

    expect(await readTotal(po_id)).toBeCloseTo(afterCreate, 2);
  });

  it("is idempotent across repeated edits — global charges are applied once, never compounded", async () => {
    const { po_id, lines } = await buildPoViaCreatePath({
      lines: PO440_LINES,
      globalCharges: PO440_GLOBAL_CHARGES,
    });
    await parkPendingApproval(po_id);

    for (const unit of ["PCS", "KG", "NOS"]) {
      await handleUpdatePO(
        po_id,
        [{ path: `product[${lines[1].rfq_product_id}].unit`, newValue: unit }],
        { id: IDS.users.a1_proc_buyer }
      );
      expect(await readTotal(po_id)).toBeCloseTo(PO440_CORRECT_TOTAL, 2);
    }
  });

  it("a real quantity change re-aggregates lines AND global charges together", async () => {
    const { po_id, lines } = await buildPoViaCreatePath({
      lines: PO440_LINES,
      globalCharges: PO440_GLOBAL_CHARGES,
    });
    await parkPendingApproval(po_id);

    // Line 1: 125 -> 100 @ ₹16 + 18% tax  =>  1600 + 288 = 1888.00
    // New subtotal: 16939 - 2360 + 1888 = 16467.00
    // Global: 7% = 1152.69 ; additional 18% of that = 207.4842
    // Grand: 16467 + 1152.69 + 207.4842 = 17827.1742 -> 17827.17
    await handleUpdatePO(
      po_id,
      [{ path: `product[${lines[0].rfq_product_id}].quantity`, newValue: 100 }],
      { id: IDS.users.a1_proc_buyer }
    );

    const sums = await db.one(
      `SELECT COALESCE(SUM(total_price), 0) AS s FROM tbl_purchase_order_product WHERE purchase_order_id = $1`,
      [po_id]
    );
    expect(Number(sums.s)).toBeCloseTo(16467.00, 2);
    expect(await readTotal(po_id)).toBeCloseTo(17827.17, 2);
  });

  it("absolute-mode global charge with absolute additional_tax is applied in full", async () => {
    // Guards the other side of normalizeGlobalCharge: an absolute charge must
    // not be scaled by the subtotal, and its absolute additional_tax must
    // still be added.  16939 + 1000 + 180 = 18119.00
    const { po_id, lines } = await buildPoViaCreatePath({
      lines: PO440_LINES,
      globalCharges: [{
        name: "Handling",
        slug: "handling",
        amount: 1000,
        amount_mode: "absolute",
        additional_tax: 180,
        additional_tax_mode: "absolute",
        is_global: true,
      }],
    });
    await parkPendingApproval(po_id);

    await handleUpdatePO(
      po_id,
      [{ path: `product[${lines[0].rfq_product_id}].unit`, newValue: "PCS" }],
      { id: IDS.users.a1_proc_buyer }
    );

    expect(await readTotal(po_id)).toBeCloseTo(18119.00, 2);
  });

  it("a PO with no global charges still totals to the plain line sum", async () => {
    const { po_id, lines } = await buildPoViaCreatePath({
      lines: PO440_LINES,
      globalCharges: [],
    });
    await parkPendingApproval(po_id);

    await handleUpdatePO(
      po_id,
      [{ path: `product[${lines[0].rfq_product_id}].unit`, newValue: "PCS" }],
      { id: IDS.users.a1_proc_buyer }
    );

    expect(await readTotal(po_id)).toBeCloseTo(PO440_LINE_SUBTOTAL, 2);
  });
});
