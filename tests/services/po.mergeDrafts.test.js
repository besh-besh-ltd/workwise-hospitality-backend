// Bulk PO merge — tests for `mergeDraftPOs` in purchaseOrderModel.js.
//
// The merge endpoint lets a buyer (or post-merge approver) fold multiple
// draft POs of the SAME vendor on the SAME RFQ into a single kept draft —
// useful when commercial finalization produced parallel drafts that the
// approver wants combined before approval. The model is the authoritative
// integration point: the route handler is a thin wrapper, and the FE flow
// (PO Listing bulk-select) calls the same code path.
//
// These tests run inside withTx so every prerequisite + the merge call +
// the assertions live in one rolled-back tx. No afterEach cleanup needed,
// no risk of cross-suite leakage.
//
// Per CONVENTIONS.md §1: the production function (mergeDraftPOs) is invoked
// directly; setup INSERTs and final SELECT readbacks are the only raw SQL.

import { describe, it, expect, afterAll } from "@jest/globals";
import { withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { mergeDraftPOs } from "../../app/models/purchaseOrderModel.js";

afterAll(async () => { await closeDb(); });

// ─────────────────────────────────────────────────────────────────────────
//  Local fixture helpers — scoped to this suite. Build a complete-enough
//  draft PO (header + line items) inside the given tx.
// ─────────────────────────────────────────────────────────────────────────

let RFQ_NO_COUNTER = 9_100_000;
const nextRfqNo = () => ++RFQ_NO_COUNTER;

let PO_NUM_COUNTER = 9_100_000;
const nextPoNumber = () => `MRG-${++PO_NUM_COUNTER}`;

async function makeRfqWithProducts(t, { createdBy, productCount = 1, hospitalityCompany = IDS.hospitality.A, hotel = IDS.hotels.A1 } = {}) {
  const rfqNo = nextRfqNo();
  const rfqRow = await t.one(
    `INSERT INTO tbl_rfq (
       rfq_no, comment, company_name, response_email, contact_name, contact_number,
       bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
       hospitality_company_id, hotel_id, process_id, is_tender, title)
     VALUES ($1, '', '', 'buyer@test', 'buyer', '0', NOW() + INTERVAL '7 days',
             'Mumbai', 1, 1, $2, $2, NOW(), $3, $4, $5, 0, $6)
     RETURNING id, rfq_no`,
    [rfqNo, createdBy, hospitalityCompany, hotel, IDS.processes.A_P1, `Merge Test RFQ ${rfqNo}`]
  );
  const productIds = [];
  for (let i = 0; i < productCount; i++) {
    const p = await t.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfqRow.id, 1 + i]
    );
    productIds.push(p.id);
  }
  return { rfq_id: rfqRow.id, rfq_no: rfqRow.rfq_no, product_ids: productIds };
}

async function makeQuoteItem(t, { rfq_id, rfq_no, vendorId, product_variant_id = 1, unit_price = 100, quantity = 10 }) {
  const quote = await t.one(
    `INSERT INTO tbl_quotes
       (rfq_id, rfq_no, created_by, updated_by, status, "timestamp", is_regret)
     VALUES ($1, $2, $3, $3, 1, NOW(), 0) RETURNING id`,
    [rfq_id, rfq_no, vendorId]
  );
  const qi = await t.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
        package_price, tax, freight_price, variant, comment, delivery_period, quantity,
        tax_mode, other_charges)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, '', '7', $7, 'percentage', '[]'::jsonb)
     RETURNING id`,
    [rfq_id, rfq_no, quote.id, product_variant_id, unit_price, unit_price * quantity, String(quantity)]
  );
  return { quote_id: quote.id, quote_item_id: qi.id };
}

async function makeDraftPO(t, {
  rfq_id,
  vendorId,
  buyerId,
  company_id = IDS.companies.A,
  global_charges = [],
  lines = [], // [{ rfq_product_id, quote_item_id, quantity, unit_price, total_price }]
} = {}) {
  const totalValue = lines.reduce((s, l) => s + Number(l.total_price || 0), 0);
  const totalQty   = lines.reduce((s, l) => s + Number(l.quantity || 0), 0);
  const rfqProductIds = lines.map(l => l.rfq_product_id);
  const quoteIds = lines.map(l => l.quote_item_id);

  // pg-promise serialises JS arrays as text[]; casts pin them to int[] to
  // match the column types. (Same workaround the production model uses.)
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, global_charges, po_pdf_url)
     VALUES ($1, $2, $3, 'draft', $4::int[], $5, $6, $7, $8, $9::int[], $10, $11::jsonb, $12)
     RETURNING id, po_number`,
    [
      rfq_id, company_id, nextPoNumber(),
      rfqProductIds, totalQty, lines[0]?.unit_price || 0,
      vendorId, totalValue, quoteIds, buyerId,
      JSON.stringify(global_charges),
      `https://example.test/po-${nextPoNumber()}.pdf`, // stale URL we expect to be nulled
    ]
  );

  for (const line of lines) {
    await t.none(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, charges_meta, total_price)
       VALUES ($1, $2, $3, $4, 'pcs', $5, $6::jsonb, $7)`,
      [
        po.id, line.rfq_product_id, line.quote_item_id,
        line.quantity, line.unit_price,
        JSON.stringify(line.charges_meta || { tax: 0, tax_mode: 'percentage', other_charges: [] }),
        line.total_price
      ]
    );
  }
  return { po_id: po.id, po_number: po.po_number };
}

async function countLines(t, poId) {
  const r = await t.one(
    `SELECT COUNT(*)::int AS c FROM tbl_purchase_order_product WHERE purchase_order_id = $1`,
    [poId]
  );
  return r.c;
}

async function readPO(t, poId) {
  return t.oneOrNone(
    `SELECT id, status, finalized_vendor_id, rfq_id, company_id,
            total_value, quantity, rfq_product_id, quote_id, po_pdf_url, global_charges
       FROM tbl_rfq_purchase_order WHERE id = $1`,
    [poId]
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Tests
// ─────────────────────────────────────────────────────────────────────────

describe("mergeDraftPOs — bulk merge of same-vendor drafts", () => {

  it("re-parents line items, deletes sources, recomputes total over the merged set", async () => {
    await withTx(async (t) => {
      const { rfq_id, rfq_no, product_ids } = await makeRfqWithProducts(t, {
        createdBy: IDS.users.a1_proc_buyer, productCount: 3,
      });
      const qi1 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha, product_variant_id: 1 });
      const qi2 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha, product_variant_id: 2 });
      const qi3 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha, product_variant_id: 3 });

      // Draft A: 1 line @ 100 × 10 = 1000
      const a = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qi1.quote_item_id, quantity: 10, unit_price: 100, total_price: 1000 }],
      });
      // Draft B: 1 line @ 200 × 5 = 1000
      const b = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[1], quote_item_id: qi2.quote_item_id, quantity: 5, unit_price: 200, total_price: 1000 }],
      });
      // Draft C (the one we'll KEEP): 1 line @ 50 × 6 = 300, with one global charge
      const c = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        global_charges: [{ name: 'Round-off', slug: 'roundoff', amount: 5, amount_mode: 'percentage' }],
        lines: [{ rfq_product_id: product_ids[2], quote_item_id: qi3.quote_item_id, quantity: 6, unit_price: 50, total_price: 300 }],
      });

      // Sanity: pre-merge state.
      expect(await countLines(t, a.po_id)).toBe(1);
      expect(await countLines(t, b.po_id)).toBe(1);
      expect(await countLines(t, c.po_id)).toBe(1);

      const result = await mergeDraftPOs({
        keep_po_id: c.po_id,
        po_ids: [a.po_id, b.po_id, c.po_id],
        user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        txContext: t,
      });

      // Source POs gone.
      expect(await readPO(t, a.po_id)).toBeNull();
      expect(await readPO(t, b.po_id)).toBeNull();
      // Kept PO has 3 line items now.
      expect(await countLines(t, c.po_id)).toBe(3);

      // Total recomputation:
      //   line subtotal = 1000 + 1000 + 300 = 2300
      //   global charge: 5% of 2300 = 115
      //   grand total   = 2415.00
      const kept = await readPO(t, c.po_id);
      expect(Number(kept.total_value)).toBe(2415);

      // Quantity column aggregates new line set.
      expect(Number(kept.quantity)).toBe(10 + 5 + 6);

      // rfq_product_id + quote_id arrays rebuilt from current lines, not
      // carrying stale source-PO entries. Sort-agnostic check.
      expect(kept.rfq_product_id.sort()).toEqual(product_ids.slice().sort());
      expect(kept.quote_id.sort()).toEqual([qi1.quote_item_id, qi2.quote_item_id, qi3.quote_item_id].sort());

      // po_pdf_url nulled (stale URL after a structural change).
      expect(kept.po_pdf_url).toBeNull();

      // Returned summary matches actual state.
      expect(result.keep_po_id).toBe(c.po_id);
      expect(result.merged_po_ids.sort()).toEqual([a.po_id, b.po_id].sort());
      expect(result.new_line_count).toBe(3);
      expect(Number(result.new_total_value)).toBe(2415);
      expect(Number(result.new_line_subtotal)).toBe(2300);
    });
  });

  it("rejects mixed vendors", async () => {
    await withTx(async (t) => {
      const { rfq_id, rfq_no, product_ids } = await makeRfqWithProducts(t, {
        createdBy: IDS.users.a1_proc_buyer, productCount: 2,
      });
      const qiA = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha });
      const qiB = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_beta, product_variant_id: 2 });

      const a = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qiA.quote_item_id, quantity: 10, unit_price: 100, total_price: 1000 }],
      });
      const b = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_beta, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[1], quote_item_id: qiB.quote_item_id, quantity: 5, unit_price: 200, total_price: 1000 }],
      });

      await expect(
        mergeDraftPOs({
          keep_po_id: a.po_id, po_ids: [a.po_id, b.po_id],
          user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
          txContext: t,
        })
      ).rejects.toThrow(/same vendor/i);

      // Both POs untouched.
      expect(await countLines(t, a.po_id)).toBe(1);
      expect(await countLines(t, b.po_id)).toBe(1);
    });
  });

  it("rejects any non-draft PO in the set", async () => {
    await withTx(async (t) => {
      const { rfq_id, rfq_no, product_ids } = await makeRfqWithProducts(t, {
        createdBy: IDS.users.a1_proc_buyer, productCount: 2,
      });
      const qi1 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha, product_variant_id: 1 });
      const qi2 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha, product_variant_id: 2 });

      const a = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qi1.quote_item_id, quantity: 10, unit_price: 100, total_price: 1000 }],
      });
      const b = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[1], quote_item_id: qi2.quote_item_id, quantity: 5, unit_price: 200, total_price: 1000 }],
      });
      // Flip b to pending_approval.
      await t.none(`UPDATE tbl_rfq_purchase_order SET status = 'pending_approval' WHERE id = $1`, [b.po_id]);

      await expect(
        mergeDraftPOs({
          keep_po_id: a.po_id, po_ids: [a.po_id, b.po_id],
          user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
          txContext: t,
        })
      ).rejects.toThrow(/not a draft/i);
    });
  });

  it("rejects fewer than 2 distinct POs", async () => {
    await withTx(async (t) => {
      const { rfq_id, rfq_no, product_ids } = await makeRfqWithProducts(t, { createdBy: IDS.users.a1_proc_buyer });
      const qi = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha });
      const a = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qi.quote_item_id, quantity: 1, unit_price: 1, total_price: 1 }],
      });
      await expect(
        mergeDraftPOs({
          keep_po_id: a.po_id, po_ids: [a.po_id, a.po_id], // duplicates dedupe to 1
          user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
          txContext: t,
        })
      ).rejects.toThrow(/at least 2 distinct/i);
    });
  });

  it("rejects cross-RFQ merges", async () => {
    await withTx(async (t) => {
      const r1 = await makeRfqWithProducts(t, { createdBy: IDS.users.a1_proc_buyer });
      const r2 = await makeRfqWithProducts(t, { createdBy: IDS.users.a1_proc_buyer });
      const qi1 = await makeQuoteItem(t, { rfq_id: r1.rfq_id, rfq_no: r1.rfq_no, vendorId: IDS.users.vendor_alpha });
      const qi2 = await makeQuoteItem(t, { rfq_id: r2.rfq_id, rfq_no: r2.rfq_no, vendorId: IDS.users.vendor_alpha });
      const a = await makeDraftPO(t, {
        rfq_id: r1.rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: r1.product_ids[0], quote_item_id: qi1.quote_item_id, quantity: 1, unit_price: 1, total_price: 1 }],
      });
      const b = await makeDraftPO(t, {
        rfq_id: r2.rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: r2.product_ids[0], quote_item_id: qi2.quote_item_id, quantity: 1, unit_price: 1, total_price: 1 }],
      });
      await expect(
        mergeDraftPOs({
          keep_po_id: a.po_id, po_ids: [a.po_id, b.po_id],
          user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
          txContext: t,
        })
      ).rejects.toThrow(/same RFQ/i);
    });
  });

  it("rejects cross-tenant merges via the user.company_id gate", async () => {
    await withTx(async (t) => {
      const { rfq_id, rfq_no, product_ids } = await makeRfqWithProducts(t, { createdBy: IDS.users.a1_proc_buyer });
      const qi1 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha });
      const qi2 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha, product_variant_id: 2 });
      const a = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qi1.quote_item_id, quantity: 1, unit_price: 1, total_price: 1 }],
      });
      const b = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qi2.quote_item_id, quantity: 1, unit_price: 1, total_price: 1 }],
      });
      // Caller is from Company B, but the POs are Company A — must be rejected.
      await expect(
        mergeDraftPOs({
          keep_po_id: a.po_id, po_ids: [a.po_id, b.po_id],
          user: { id: IDS.users.companyB_admin, company_id: IDS.companies.B },
          txContext: t,
        })
      ).rejects.toThrow(/do not have access/i);
    });
  });

  it("brings payment milestones, tasks, and documents along onto the kept PO", async () => {
    await withTx(async (t) => {
      const { rfq_id, rfq_no, product_ids } = await makeRfqWithProducts(t, { createdBy: IDS.users.a1_proc_buyer });
      const qi1 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha });
      const qi2 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha, product_variant_id: 2 });

      const a = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qi1.quote_item_id, quantity: 2, unit_price: 100, total_price: 200 }],
      });
      const b = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qi2.quote_item_id, quantity: 3, unit_price: 100, total_price: 300 }],
      });

      // Source PO carries a milestone + a task + a document.
      await t.none(
        `INSERT INTO tbl_payment_milestone (rfq_id, po_id, company_id, milestone_name, due_date, milestone_description, created_by)
         VALUES ($1, $2, $3, 'Advance', NOW() + INTERVAL '30 days', '30% advance', $4)`,
        [rfq_id, b.po_id, IDS.companies.A, IDS.users.a1_proc_buyer]
      );
      await t.none(
        `INSERT INTO tbl_purchase_order_tasks (rfq_id, po_id, company_id, task_name, completion_date, status, task_description, created_by)
         VALUES ($1, $2, $3, 'QA inspection', NOW() + INTERVAL '14 days', 'pending', 'Inspect samples', $4)`,
        [rfq_id, b.po_id, IDS.companies.A, IDS.users.a1_proc_buyer]
      );
      await t.none(
        `INSERT INTO tbl_purchase_order_document (purchase_order_id, document_type, document_url, uploaded_by)
         VALUES ($1, 'grn', 'https://example.test/doc.pdf', $2)`,
        [b.po_id, IDS.users.a1_proc_buyer]
      );

      await mergeDraftPOs({
        keep_po_id: a.po_id, po_ids: [a.po_id, b.po_id],
        user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        txContext: t,
      });

      // All three rows now reference the kept PO.
      const ms = await t.one(`SELECT po_id FROM tbl_payment_milestone WHERE milestone_name = 'Advance' AND rfq_id = $1`, [rfq_id]);
      expect(ms.po_id).toBe(a.po_id);

      const tk = await t.one(`SELECT po_id FROM tbl_purchase_order_tasks WHERE task_name = 'QA inspection' AND rfq_id = $1`, [rfq_id]);
      expect(tk.po_id).toBe(a.po_id);

      // purchase_order_id is bigint → driver returns string; coerce for comparison.
      const dc = await t.one(`SELECT purchase_order_id FROM tbl_purchase_order_document WHERE document_url = 'https://example.test/doc.pdf'`);
      expect(Number(dc.purchase_order_id)).toBe(a.po_id);
    });
  });

  it("dedupes HSN mappings on the kept PO so source duplicates are dropped on conflict", async () => {
    await withTx(async (t) => {
      const { rfq_id, rfq_no, product_ids } = await makeRfqWithProducts(t, { createdBy: IDS.users.a1_proc_buyer });
      const qi1 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha });
      const qi2 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha, product_variant_id: 2 });

      const a = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qi1.quote_item_id, quantity: 1, unit_price: 1, total_price: 1 }],
      });
      const b = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qi2.quote_item_id, quantity: 1, unit_price: 1, total_price: 1 }],
      });

      // Kept PO already has an HSN code for product_ids[0]; source PO has a
      // different one for the same product. After merge, only the kept-PO's
      // mapping should survive.
      await t.none(
        `INSERT INTO tbl_purchase_order_hsn_mapping (po_id, rfq_item_id, hsn_code)
         VALUES ($1, $2, 'KEPT-001')`,
        [a.po_id, product_ids[0]]
      );
      await t.none(
        `INSERT INTO tbl_purchase_order_hsn_mapping (po_id, rfq_item_id, hsn_code)
         VALUES ($1, $2, 'SRC-001')`,
        [b.po_id, product_ids[0]]
      );

      await mergeDraftPOs({
        keep_po_id: a.po_id, po_ids: [a.po_id, b.po_id],
        user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        txContext: t,
      });

      const hsns = await t.any(
        `SELECT hsn_code FROM tbl_purchase_order_hsn_mapping WHERE po_id = $1 AND rfq_item_id = $2`,
        [a.po_id, product_ids[0]]
      );
      expect(hsns.map(h => h.hsn_code)).toEqual(['KEPT-001']);
    });
  });

  it("preserves the KEPT PO's global_charges (not summed across sources) and applies them to the new subtotal", async () => {
    await withTx(async (t) => {
      const { rfq_id, rfq_no, product_ids } = await makeRfqWithProducts(t, { createdBy: IDS.users.a1_proc_buyer, productCount: 2 });
      const qi1 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha });
      const qi2 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha, product_variant_id: 2 });

      // Kept PO has a 10% global charge; source PO has a Rs.500 absolute one
      // we want IGNORED on the kept total.
      const a = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        global_charges: [{ name: 'GST', slug: 'gst', amount: 10, amount_mode: 'percentage' }],
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qi1.quote_item_id, quantity: 2, unit_price: 500, total_price: 1000 }],
      });
      const b = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        global_charges: [{ name: 'Other Fee', slug: 'other_fee', amount: 500, amount_mode: 'absolute' }],
        lines: [{ rfq_product_id: product_ids[1], quote_item_id: qi2.quote_item_id, quantity: 4, unit_price: 250, total_price: 1000 }],
      });

      await mergeDraftPOs({
        keep_po_id: a.po_id, po_ids: [a.po_id, b.po_id],
        user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        txContext: t,
      });

      const kept = await readPO(t, a.po_id);
      // Subtotal = 1000 + 1000 = 2000; 10% global = 200; total = 2200. The
      // source PO's Rs.500 global must NOT show up — it's discarded with the source.
      expect(Number(kept.total_value)).toBe(2200);

      // Globals snapshot unchanged on kept PO.
      const gc = Array.isArray(kept.global_charges) ? kept.global_charges
        : (typeof kept.global_charges === 'string' ? JSON.parse(kept.global_charges) : []);
      expect(gc).toHaveLength(1);
      expect(gc[0].slug).toBe('gst');
    });
  });

  it("when two drafts hold the same rfq_product, both line rows survive on the kept PO (no auto-sum)", async () => {
    await withTx(async (t) => {
      const { rfq_id, rfq_no, product_ids } = await makeRfqWithProducts(t, { createdBy: IDS.users.a1_proc_buyer });
      const qi1 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha });
      const qi2 = await makeQuoteItem(t, { rfq_id, rfq_no, vendorId: IDS.users.vendor_alpha, product_variant_id: 2 });

      // Both POs carry product_ids[0], at different quantities. After merge
      // both lines should coexist — the model intentionally does NOT auto-
      // sum, because the user explicitly chose to merge and may want to
      // post-edit duplicates themselves (or the duplication may be intentional,
      // e.g. two separate delivery batches of the same SKU).
      const a = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qi1.quote_item_id, quantity: 2, unit_price: 100, total_price: 200 }],
      });
      const b = await makeDraftPO(t, {
        rfq_id, vendorId: IDS.users.vendor_alpha, buyerId: IDS.users.a1_proc_buyer,
        lines: [{ rfq_product_id: product_ids[0], quote_item_id: qi2.quote_item_id, quantity: 5, unit_price: 100, total_price: 500 }],
      });

      await mergeDraftPOs({
        keep_po_id: a.po_id, po_ids: [a.po_id, b.po_id],
        user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
        txContext: t,
      });

      expect(await countLines(t, a.po_id)).toBe(2);
      const kept = await readPO(t, a.po_id);
      // total = 200 + 500 = 700, no globals on either side here.
      expect(Number(kept.total_value)).toBe(700);
      // Quantity column reflects total qty across lines (2 + 5 = 7).
      expect(Number(kept.quantity)).toBe(7);
    });
  });
});
