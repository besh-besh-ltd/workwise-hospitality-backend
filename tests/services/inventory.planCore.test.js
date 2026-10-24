// Delivery-plan core, receipt roll-up and the legacy PO status (Task A3).
//
// tbl_po_delivery_line rows are the source of truth for receiving; PO line and
// PO header counters are cached roll-ups that recomputePoReceipt rebuilds from
// the source rows (GRN allocations, RTV lines, short-close log). Every PO gets
// a default plan lazily; legacy POs already received before the module stay
// untouched. po.status only ever moves forward.
//
// Everything runs inside withTx (always rolled back).

import { describe, it, expect, afterAll } from "@jest/globals";
import { withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import {
  getPoContext,
  ensureDefaultPlan,
  defaultDueDate,
  listPoLines,
} from "../../app/services/inventory/planCore.js";
import {
  deriveLineStatus,
  derivePoReceiptStatus,
  recomputePoReceipt,
} from "../../app/services/inventory/receiptRollup.js";
import { advanceLegacyPoStatus } from "../../app/services/inventory/poStatus.js";
import { InventoryError } from "../../app/services/inventory/errors.js";

const CO = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;

afterAll(async () => {
  await closeDb();
});

let seq = 0;
const tag = () => `inv-a3p-${process.pid}-${++seq}`;

/**
 * An RFQ PO with real lines. `lines` = [{qty, unit, deliveryPeriod?}]; each line
 * gets an RFQ product and a quote item (which carries the vendor's
 * delivery_period). `mappedHotels` adds tbl_rfq_hotel_mappings rows.
 */
async function makeRfqPo(t, {
  status = "approved", hotel = A1, mappedHotels = [], lines = [{ qty: 10, unit: "kg" }],
  vendorActionAt = null, department = IDS.departments.proc,
} = {}) {
  const { rfq_id, rfq_no } = await makeRFQ(t, { createdBy: BUYER, status: 1, is_published: 1, hotel, department });
  for (const h of mappedHotels) {
    await t.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
      [rfq_id, h, BUYER]
    );
  }
  const quote = await t.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, VENDOR]
  );
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, vendor_action_at)
     VALUES ($1, $2, $3, $4, '{}', 1, 100, $5, 100, '{}', $6, $7) RETURNING id`,
    [rfq_id, IDS.companies.A, `INV-A3-${tag()}`, status, VENDOR, BUYER, vendorActionAt]
  );
  const lineIds = [];
  for (const l of lines) {
    const rp = await t.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
      [rfq_id]
    );
    const qi = await t.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, comment, delivery_period, quantity)
       VALUES ($1, $2, $3, 1, 100, 100, '', $4, $5) RETURNING id`,
      [rfq_id, rfq_no, quote.id, l.deliveryPeriod ?? "", String(l.qty)]
    );
    const pop = await t.one(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
       VALUES ($1, $2, $3, $4, $5, 100, $6) RETURNING id`,
      [po.id, rp.id, qi.id, l.qty, l.unit ?? "kg", 100 * l.qty]
    );
    lineIds.push(Number(pop.id));
  }
  return { poId: Number(po.id), rfqId: rfq_id, lineIds };
}

/** A call-off PO raised by an MR at `hotel` (no RFQ). */
async function makeCallOffPo(t, { hotel = A2, requiredBy = "2026-11-15", qty = 6 } = {}) {
  const t0 = tag();
  const arc = await t.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
     VALUES ($1, 'Plan core ARC', (SELECT id FROM tbl_category ORDER BY id LIMIT 1), $2, $3, $4, $5,
             'contract_active', NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
             NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6)
     RETURNING id`,
    [`ARC-${t0}`.slice(0, 40), CO, A1, IDS.departments.proc, IDS.processes.A_P1, BUYER]
  );
  const arcItem = await t.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, 1, 100, 'litre') RETURNING id`,
    [arc.id]
  );
  const contract = await t.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
    [arc.id, VENDOR]
  );
  const contractLine = await t.one(
    `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
     VALUES ($1, $2, 90, 5, 1000) RETURNING id`,
    [contract.id, arcItem.id]
  );
  const mr = await t.one(
    `INSERT INTO tbl_material_requisition
       (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, required_by_date)
     VALUES ($1, 'Plan core MR', $2, $3, $4, 'normal', $5, 'po_released', $6) RETURNING id`,
    [`MR-${t0}`.slice(0, 40), CO, hotel, IDS.departments.fb, BUYER, requiredBy]
  );
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id,
        total_value, quote_id, arc_contract_id, source_mr_id, is_call_off)
     VALUES (NULL, $1, $2, 'acceptance_pending', '{}', $3, 90, $4, 0, '{}', $5, $6, TRUE) RETURNING id`,
    [IDS.companies.A, `CO-${t0}`, qty, VENDOR, contract.id, mr.id]
  );
  const pop = await t.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, quantity, unit, unit_price, charges_meta, total_price, product_variant_id, arc_contract_line_id)
     VALUES ($1, $2, 'litre', 90, '{"tax":5,"tax_mode":"percentage","other_charges":[]}'::jsonb, $3, 1, $4)
     RETURNING id`,
    [po.id, qty, 94.5 * qty, contractLine.id]
  );
  return { poId: Number(po.id), lineId: Number(pop.id), mrId: Number(mr.id) };
}

async function planOf(t, poId) {
  const deliveries = await t.any(
    `SELECT id, hotel_id, phase_no, due_date::text AS due_date, status, hospitality_company_id
       FROM tbl_po_delivery WHERE po_id = $1 ORDER BY id`,
    [poId]
  );
  const lines = await t.any(
    `SELECT dl.id, dl.delivery_id, dl.po_line_id, dl.planned_qty::text AS planned_qty, dl.status
       FROM tbl_po_delivery_line dl JOIN tbl_po_delivery d ON d.id = dl.delivery_id
      WHERE d.po_id = $1 ORDER BY dl.po_line_id`,
    [poId]
  );
  return { deliveries, lines };
}

/** A posted GRN (RECEIPT or REVERSAL) with one line allocated to one delivery line. */
async function postGrnLine(t, { poId, hotelId = A1, poLineId, deliveryLineId, accepted, rejected = 0,
  docType = "RECEIPT", reversesGrnId = null, reversesGrnLineId = null, status = "posted" }) {
  const grn = await t.one(
    `INSERT INTO tbl_grn (hospitality_company_id, hotel_id, po_id, doc_type, reverses_grn_id, status, received_at, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-10-24', now()) RETURNING id`,
    [CO, hotelId, poId, docType, reversesGrnId, status]
  );
  const line = await t.one(
    `INSERT INTO tbl_grn_line (hospitality_company_id, grn_id, po_line_id, reverses_grn_line_id, po_uom,
                               received_qty, accepted_qty, rejected_qty, rejection_reason)
     VALUES ($1, $2, $3, $4, 'kg', $5, $6, $7, $8) RETURNING id`,
    [CO, grn.id, poLineId, reversesGrnLineId, accepted + rejected, accepted, rejected, rejected > 0 ? "damaged" : null]
  );
  const sign = docType === "REVERSAL" ? -1 : 1;
  await t.none(
    `INSERT INTO tbl_grn_line_alloc (hospitality_company_id, grn_line_id, delivery_line_id, accepted_qty, rejected_qty)
     VALUES ($1, $2, $3, $4, $5)`,
    [CO, line.id, deliveryLineId, sign * accepted, sign * rejected]
  );
  return { grnId: Number(grn.id), grnLineId: Number(line.id) };
}

async function rollupOf(t, poId) {
  const po = await t.one(
    `SELECT receipt_status FROM tbl_rfq_purchase_order WHERE id = $1`,
    [poId]
  );
  const lines = await t.any(
    `SELECT id, received_qty::text AS received, accepted_qty::text AS accepted, rejected_qty::text AS rejected,
            returned_replace_qty::text AS returned_replace, returned_credit_qty::text AS returned_credit,
            short_closed_qty::text AS short_closed, receipt_status
       FROM tbl_purchase_order_product WHERE purchase_order_id = $1 ORDER BY id`,
    [poId]
  );
  const dlines = await t.any(
    `SELECT dl.po_line_id, dl.accepted_qty::text AS accepted, dl.rejected_qty::text AS rejected,
            dl.returned_replace_qty::text AS returned_replace, dl.returned_credit_qty::text AS returned_credit,
            dl.short_closed_qty::text AS short_closed, dl.status
       FROM tbl_po_delivery_line dl JOIN tbl_po_delivery d ON d.id = dl.delivery_id
      WHERE d.po_id = $1 ORDER BY dl.po_line_id`,
    [poId]
  );
  const deliveries = await t.any(`SELECT status FROM tbl_po_delivery WHERE po_id = $1 ORDER BY id`, [poId]);
  return { receiptStatus: po.receipt_status, lines, dlines, deliveries: deliveries.map((d) => d.status) };
}

/** Runs fn in a SAVEPOINT and returns what it threw (or fails the test). */
async function thrownBy(t, fn) {
  try {
    await t.tx((sp) => fn(sp));
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

describe("PO context", () => {
  it("resolves company, hotel set, department and receipt flags for RFQ and call-off POs", async () => {
    await withTx(async (t) => {
      const single = await makeRfqPo(t, { hotel: A1 });
      const ctx = await getPoContext(t, single.poId);
      expect(ctx).toEqual(expect.objectContaining({
        isCallOff: false,
        companyId: CO,
        hotelIds: [A1],
        departmentId: IDS.departments.proc,
        vendorId: VENDOR,
        status: "approved",
        receiptStatus: "not_received",
        receiptLegacy: false,
        planLockedAt: null,
      }));
      expect(ctx.po.id).toBe(single.poId);

      const multi = await makeRfqPo(t, { hotel: A1, mappedHotels: [A2, A1] });
      expect((await getPoContext(t, multi.poId)).hotelIds).toEqual([A1, A2]);

      const callOff = await makeCallOffPo(t, { hotel: A2 });
      const coCtx = await getPoContext(t, callOff.poId);
      expect(coCtx).toEqual(expect.objectContaining({
        isCallOff: true, companyId: CO, hotelIds: [A2], departmentId: IDS.departments.fb,
      }));

      const err = await thrownBy(t, (sp) => getPoContext(sp, 2147483000));
      expect(err).toBeInstanceOf(InventoryError);
      expect(err.code).toBe("NOT_FOUND");
    });
  });
});

describe("default delivery plan", () => {
  it("single-hotel PO gets one phase-1 delivery with all lines", async () => {
    await withTx(async (t) => {
      // Accepted at 02:00 IST on the 21st (20:30 UTC on the 20th): the IST day counts.
      const { poId, lineIds } = await makeRfqPo(t, {
        hotel: A1,
        vendorActionAt: "2026-10-21T02:00:00+05:30",
        lines: [
          { qty: 10, unit: "kg", deliveryPeriod: "7 days" },
          { qty: 5.5, unit: "Case", deliveryPeriod: " 4 " },
        ],
      });

      await ensureDefaultPlan(t, poId);

      const { deliveries, lines } = await planOf(t, poId);
      expect(deliveries).toEqual([
        { id: expect.any(Number), hotel_id: A1, phase_no: 1, due_date: "2026-10-28", status: "open", hospitality_company_id: CO },
      ]);
      expect(lines.map((l) => [l.po_line_id, l.planned_qty, l.status, l.delivery_id])).toEqual([
        [lineIds[0], "10.0000", "open", deliveries[0].id],
        [lineIds[1], "5.5000", "open", deliveries[0].id],
      ]);
    });
  });

  it("call-off PO plans at the MR hotel, due on the MR's required-by date", async () => {
    await withTx(async (t) => {
      const { poId, lineId } = await makeCallOffPo(t, { hotel: A2, requiredBy: "2026-11-15", qty: 6 });
      await ensureDefaultPlan(t, poId);
      const { deliveries, lines } = await planOf(t, poId);
      expect(deliveries).toEqual([
        expect.objectContaining({ hotel_id: A2, phase_no: 1, due_date: "2026-11-15" }),
      ]);
      expect(lines.map((l) => [l.po_line_id, l.planned_qty])).toEqual([[lineId, "6.0000"]]);
    });
  });

  it("multi-hotel RFQ PO gets one unallocated delivery", async () => {
    await withTx(async (t) => {
      const { poId, lineIds } = await makeRfqPo(t, {
        hotel: A1, mappedHotels: [A1, A2], lines: [{ qty: 20 }, { qty: 8 }],
      });
      await ensureDefaultPlan(t, poId);
      const { deliveries, lines } = await planOf(t, poId);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toEqual(expect.objectContaining({ hotel_id: null, phase_no: 1 }));
      expect(lines.map((l) => [l.po_line_id, l.planned_qty])).toEqual([
        [lineIds[0], "20.0000"],
        [lineIds[1], "8.0000"],
      ]);
    });
  });

  it("ensureDefaultPlan is idempotent", async () => {
    await withTx(async (t) => {
      const { poId } = await makeRfqPo(t, { lines: [{ qty: 3 }, { qty: 4 }] });
      await ensureDefaultPlan(t, poId);
      const first = await planOf(t, poId);
      await ensureDefaultPlan(t, poId);
      await ensureDefaultPlan(t, poId);
      expect(await planOf(t, poId)).toEqual(first);

      // A plan the buyer already edited is never overwritten.
      await t.none(`UPDATE tbl_po_delivery SET due_date = '2026-12-01', remarks = 'buyer' WHERE po_id = $1`, [poId]);
      await ensureDefaultPlan(t, poId);
      const kept = await t.one(`SELECT due_date::text AS d, remarks FROM tbl_po_delivery WHERE po_id = $1`, [poId]);
      expect(kept).toEqual({ d: "2026-12-01", remarks: "buyer" });

      // A legacy PO received before the module gets no plan.
      const legacy = await makeRfqPo(t, { status: "completed" });
      await t.none(
        `UPDATE tbl_rfq_purchase_order SET receipt_legacy = true, receipt_status = 'received' WHERE id = $1`,
        [legacy.poId]
      );
      await ensureDefaultPlan(t, legacy.poId);
      expect((await planOf(t, legacy.poId)).deliveries).toEqual([]);
    });
  });

  it("defaultDueDate parses whole days only", async () => {
    await withTx(async (t) => {
      const at = "2026-10-01T10:00:00+05:30";
      const cases = [
        [["10"], "2026-10-11"],
        [["10 Days"], "2026-10-11"],
        [["3d"], "2026-10-04"],
        [["1 day", "12 days"], "2026-10-13"], // the latest line governs one delivery
        [["2 weeks"], null],
        [["7", "ASAP"], null], // a line we cannot read makes the date unknown
        [[""], null],
      ];
      for (const [periods, expected] of cases) {
        const { poId } = await makeRfqPo(t, {
          vendorActionAt: at,
          lines: periods.map((p) => ({ qty: 1, deliveryPeriod: p })),
        });
        expect([periods, await defaultDueDate(t, { id: poId })]).toEqual([periods, expected]);
      }
      // Not yet accepted by the vendor: no anchor date.
      const pending = await makeRfqPo(t, { status: "pending_approval", lines: [{ qty: 1, deliveryPeriod: "5" }] });
      expect(await defaultDueDate(t, { id: pending.poId })).toBeNull();
    });
  });

  it("listPoLines exposes the PO lines with their variant and ordered qty", async () => {
    await withTx(async (t) => {
      const { poId, lineIds } = await makeRfqPo(t, { lines: [{ qty: 2, unit: " Box " }] });
      const lines = await listPoLines(t, poId);
      expect(lines).toEqual([
        expect.objectContaining({ id: lineIds[0], productVariantId: 1, unit: " Box ", orderedQty: 2 }),
      ]);
      expect(typeof lines[0].productName).toBe("string");
    });
  });
});

describe("line and PO receipt status", () => {
  it("deriveLineStatus table", () => {
    const rows = [
      [{ planned: 10, accepted: 10 }, "received"],
      [{ planned: 10, accepted: 4 }, "partial"],
      [{ planned: 10, accepted: 4, shortClosed: 6 }, "short_closed"],
      [{ planned: 10, accepted: 10, returnedReplace: 3 }, "partial"],
      [{ planned: 10, accepted: 0 }, "open"],
      // extra edges
      [{ planned: 10, accepted: 10.5 }, "received"], // within tolerance
      [{ planned: 10, accepted: 10, returnedCredit: 3, shortClosed: 3 }, "short_closed"], // credit RTV
      [{ planned: 10, accepted: 0, shortClosed: 10 }, "short_closed"],
      [{ planned: "10.0000", accepted: "9.9999" }, "partial"],
      [{ planned: 0.3, accepted: 0.1 + 0.2 }, "received"], // no float drift
    ];
    for (const [input, expected] of rows) {
      expect([input, deriveLineStatus(input)]).toEqual([input, expected]);
    }
  });

  it("derivePoReceiptStatus table", () => {
    const rows = [
      [["received", "received"], "received"],
      [["received", "short_closed"], "closed_short"],
      [["short_closed"], "closed_short"],
      [["received", "partial"], "partial"],
      [["received", "open"], "partial"],
      [["open", "short_closed"], "partial"],
      [["open", "partial"], "partial"],
      [["open", "open"], "not_received"],
      [[], "not_received"],
    ];
    for (const [statuses, expected] of rows) {
      expect([statuses, derivePoReceiptStatus(statuses)]).toEqual([statuses, expected]);
    }
  });

  it("recomputePoReceipt rolls lines up to PO status", async () => {
    await withTx(async (t) => {
      const { poId, lineIds: [soap, rice] } = await makeRfqPo(t, { lines: [{ qty: 10 }, { qty: 5 }] });
      await ensureDefaultPlan(t, poId);
      const { lines: plan } = await planOf(t, poId);
      const dlSoap = plan.find((l) => l.po_line_id === soap).id;
      const dlRice = plan.find((l) => l.po_line_id === rice).id;

      // Nothing received yet.
      let r = await recomputePoReceipt(t, poId);
      expect(r.receiptStatus).toBe("not_received");

      // Soap fully received; rice 2 accepted + 1 rejected.
      const receipt = await postGrnLine(t, { poId, poLineId: soap, deliveryLineId: dlSoap, accepted: 10 });
      await postGrnLine(t, { poId, poLineId: rice, deliveryLineId: dlRice, accepted: 2, rejected: 1 });
      // A draft GRN never counts.
      await postGrnLine(t, { poId, poLineId: rice, deliveryLineId: dlRice, accepted: 3, status: "draft" });

      r = await recomputePoReceipt(t, poId);
      expect(r.receiptStatus).toBe("partial");
      expect(r.lines).toEqual([
        expect.objectContaining({ id: soap, orderedQty: 10, receivedQty: 10, acceptedQty: 10, rejectedQty: 0, openQty: 0, receiptStatus: "received" }),
        expect.objectContaining({ id: rice, orderedQty: 5, receivedQty: 3, acceptedQty: 2, rejectedQty: 1, openQty: 3, receiptStatus: "partial" }),
      ]);
      expect(r.lines[0]).toEqual(expect.objectContaining({
        productName: expect.any(String), unit: "kg", returnedReplaceQty: 0, returnedCreditQty: 0, shortClosedQty: 0,
      }));

      // Safe to call repeatedly: derived, never incremented.
      const again = await recomputePoReceipt(t, poId);
      expect(again).toEqual(r);
      let db = await rollupOf(t, poId);
      expect(db.receiptStatus).toBe("partial");
      expect(db.lines.map((l) => [l.accepted, l.rejected, l.received, l.receipt_status])).toEqual([
        ["10.0000", "0.0000", "10.0000", "received"],
        ["2.0000", "1.0000", "3.0000", "partial"],
      ]);
      expect(db.dlines.map((l) => l.status)).toEqual(["received", "partial"]);
      expect(db.deliveries).toEqual(["partial"]);

      // Short-close the rice remainder: closed short.
      await t.none(
        `INSERT INTO tbl_po_short_close (hospitality_company_id, po_id, delivery_line_id, qty, reason_code, action)
         VALUES ($1, $2, $3, 3, 'vendor_cannot_supply', 'close')`,
        [CO, poId, dlRice]
      );
      r = await recomputePoReceipt(t, poId);
      expect(r.receiptStatus).toBe("closed_short");
      db = await rollupOf(t, poId);
      expect(db.lines[1]).toEqual(expect.objectContaining({ short_closed: "3.0000", receipt_status: "short_closed" }));
      expect(db.deliveries).toEqual(["short_closed"]);

      // Reopen it: close minus reopen.
      await t.none(
        `INSERT INTO tbl_po_short_close (hospitality_company_id, po_id, delivery_line_id, qty, action)
         VALUES ($1, $2, $3, 3, 'reopen')`,
        [CO, poId, dlRice]
      );
      r = await recomputePoReceipt(t, poId);
      expect(r.receiptStatus).toBe("partial");
      expect(r.lines[1].shortClosedQty).toBe(0);

      // A dispatched REPLACE return of 4 soap reopens 4; a draft RTV does not count.
      const rtv = await t.one(
        `INSERT INTO tbl_rtv (hospitality_company_id, po_id, grn_id, hotel_id, disposition, status)
         VALUES ($1, $2, $3, $4, 'REPLACE', 'dispatched') RETURNING id`,
        [CO, poId, receipt.grnId, A1]
      );
      await t.none(
        `INSERT INTO tbl_rtv_line (hospitality_company_id, rtv_id, grn_line_id, qty) VALUES ($1, $2, $3, 4)`,
        [CO, rtv.id, receipt.grnLineId]
      );
      const draftRtv = await t.one(
        `INSERT INTO tbl_rtv (hospitality_company_id, po_id, grn_id, hotel_id, disposition, status)
         VALUES ($1, $2, $3, $4, 'CREDIT', 'draft') RETURNING id`,
        [CO, poId, receipt.grnId, A1]
      );
      await t.none(
        `INSERT INTO tbl_rtv_line (hospitality_company_id, rtv_id, grn_line_id, qty) VALUES ($1, $2, $3, 1)`,
        [CO, draftRtv.id, receipt.grnLineId]
      );
      r = await recomputePoReceipt(t, poId);
      expect(r.lines[0]).toEqual(expect.objectContaining({
        acceptedQty: 10, returnedReplaceQty: 4, returnedCreditQty: 0, openQty: 4, receiptStatus: "partial",
      }));
      db = await rollupOf(t, poId);
      expect(db.dlines[0]).toEqual(expect.objectContaining({ returned_replace: "4.0000", status: "partial" }));

      // Reversing 6 of the soap receipt (a REVERSAL GRN, negative allocation).
      await postGrnLine(t, {
        poId, poLineId: soap, deliveryLineId: dlSoap, accepted: 6,
        docType: "REVERSAL", reversesGrnId: receipt.grnId, reversesGrnLineId: receipt.grnLineId,
      });
      await t.none(`UPDATE tbl_grn SET status = 'partially_reversed' WHERE id = $1`, [receipt.grnId]);
      r = await recomputePoReceipt(t, poId);
      expect(r.lines[0]).toEqual(expect.objectContaining({ acceptedQty: 4, receivedQty: 4, returnedReplaceQty: 4, openQty: 10 }));
      expect(r.lines[0].receiptStatus).toBe("open");
      expect(r.receiptStatus).toBe("partial");
    });
  });

  it("recomputePoReceipt credits a CREDIT return and spreads returns over the line's allocations", async () => {
    await withTx(async (t) => {
      const { poId, lineIds: [soap] } = await makeRfqPo(t, { lines: [{ qty: 10 }] });
      // Two phases at A1: 6 then 4.
      const d1 = await t.one(
        `INSERT INTO tbl_po_delivery (hospitality_company_id, po_id, hotel_id, phase_no, due_date)
         VALUES ($1, $2, $3, 1, '2026-10-25') RETURNING id`, [CO, poId, A1]);
      const d2 = await t.one(
        `INSERT INTO tbl_po_delivery (hospitality_company_id, po_id, hotel_id, phase_no, due_date)
         VALUES ($1, $2, $3, 2, '2026-11-25') RETURNING id`, [CO, poId, A1]);
      const l1 = await t.one(
        `INSERT INTO tbl_po_delivery_line (hospitality_company_id, delivery_id, po_line_id, planned_qty)
         VALUES ($1, $2, $3, 6) RETURNING id`, [CO, d1.id, soap]);
      const l2 = await t.one(
        `INSERT INTO tbl_po_delivery_line (hospitality_company_id, delivery_id, po_line_id, planned_qty)
         VALUES ($1, $2, $3, 4) RETURNING id`, [CO, d2.id, soap]);

      // One GRN line of 10, allocated 6 to phase 1 then 4 to phase 2.
      const grn = await t.one(
        `INSERT INTO tbl_grn (hospitality_company_id, hotel_id, po_id, status, received_at)
         VALUES ($1, $2, $3, 'posted', '2026-10-24') RETURNING id`, [CO, A1, poId]);
      const gl = await t.one(
        `INSERT INTO tbl_grn_line (hospitality_company_id, grn_id, po_line_id, po_uom, received_qty, accepted_qty)
         VALUES ($1, $2, $3, 'kg', 10, 10) RETURNING id`, [CO, grn.id, soap]);
      await t.none(
        `INSERT INTO tbl_grn_line_alloc (hospitality_company_id, grn_line_id, delivery_line_id, accepted_qty)
         VALUES ($1, $2, $3, 6), ($1, $2, $4, 4)`, [CO, gl.id, l1.id, l2.id]);

      // CREDIT return of 5, closed; B5 also logs the credited qty as short-closed.
      const rtv = await t.one(
        `INSERT INTO tbl_rtv (hospitality_company_id, po_id, grn_id, hotel_id, disposition, status)
         VALUES ($1, $2, $3, $4, 'CREDIT', 'closed') RETURNING id`, [CO, poId, grn.id, A1]);
      await t.none(
        `INSERT INTO tbl_rtv_line (hospitality_company_id, rtv_id, grn_line_id, qty) VALUES ($1, $2, $3, 5)`,
        [CO, rtv.id, gl.id]);
      await t.none(
        `INSERT INTO tbl_po_short_close (hospitality_company_id, po_id, delivery_line_id, qty, reason_code, action)
         VALUES ($1, $2, $3, 4, 'other', 'close'), ($1, $2, $4, 1, 'other', 'close')`,
        [CO, poId, l2.id, l1.id]);

      const r = await recomputePoReceipt(t, poId);
      const rows = await t.any(
        `SELECT id, accepted_qty::text AS accepted, returned_credit_qty::text AS credit,
                short_closed_qty::text AS sc, status
           FROM tbl_po_delivery_line WHERE id = ANY($1::int[]) ORDER BY id`,
        [[l1.id, l2.id]]);
      // The latest allocation (phase 2) is returned first, then phase 1.
      expect(rows).toEqual([
        { id: l1.id, accepted: "6.0000", credit: "1.0000", sc: "1.0000", status: "short_closed" },
        { id: l2.id, accepted: "4.0000", credit: "4.0000", sc: "4.0000", status: "short_closed" },
      ]);
      expect(r.lines[0]).toEqual(expect.objectContaining({ acceptedQty: 10, returnedCreditQty: 5, shortClosedQty: 5, openQty: 0, receiptStatus: "short_closed" }));
      expect(r.receiptStatus).toBe("closed_short");
    });
  });

  it("legacy received PO without plan is left untouched", async () => {
    await withTx(async (t) => {
      const { poId } = await makeRfqPo(t, { status: "completed", lines: [{ qty: 4 }] });
      await t.none(
        `UPDATE tbl_rfq_purchase_order SET receipt_legacy = true, receipt_status = 'received' WHERE id = $1`,
        [poId]
      );
      const before = await rollupOf(t, poId);
      const r = await recomputePoReceipt(t, poId);
      expect(r.receiptStatus).toBe("received");
      expect(await rollupOf(t, poId)).toEqual(before);
      expect((await planOf(t, poId)).deliveries).toEqual([]);

      // A legacy PO that was still open is recomputed normally.
      const open = await makeRfqPo(t, { status: "approved", lines: [{ qty: 4 }] });
      await t.none(`UPDATE tbl_rfq_purchase_order SET receipt_legacy = true WHERE id = $1`, [open.poId]);
      expect((await recomputePoReceipt(t, open.poId)).receiptStatus).toBe("not_received");
    });
  });
});

describe("legacy po.status", () => {
  it("advanceLegacyPoStatus moves forward only", async () => {
    await withTx(async (t) => {
      const approved = await makeRfqPo(t, { status: "approved" });
      expect(await advanceLegacyPoStatus(t, approved.poId, "GRN")).toEqual({ from: "approved", to: "GRN", changed: true });
      expect((await t.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id = $1`, [approved.poId])).status).toBe("GRN");
      // Second dispatch after GRN never moves it back.
      expect(await advanceLegacyPoStatus(t, approved.poId, "dispatched")).toEqual({ from: "GRN", to: "GRN", changed: false });

      const invoiced = await makeRfqPo(t, { status: "invoice_raised" });
      expect(await advanceLegacyPoStatus(t, invoiced.poId, "GRN")).toEqual({ from: "invoice_raised", to: "invoice_raised", changed: false });
      expect((await t.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id = $1`, [invoiced.poId])).status).toBe("invoice_raised");

      const cancelled = await makeRfqPo(t, { status: "cancelled" });
      expect(await advanceLegacyPoStatus(t, cancelled.poId, "GRN")).toEqual({ from: "cancelled", to: "cancelled", changed: false });
      expect((await t.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id = $1`, [cancelled.poId])).status).toBe("cancelled");

      const dispatched = await makeRfqPo(t, { status: "dispatched" });
      expect(await advanceLegacyPoStatus(t, dispatched.poId, "invoice_raised")).toEqual({ from: "dispatched", to: "invoice_raised", changed: true });

      const bad = await thrownBy(t, (sp) => advanceLegacyPoStatus(sp, approved.poId, "completed"));
      expect(bad.code).toBe("VALIDATION");
      const missing = await thrownBy(t, (sp) => advanceLegacyPoStatus(sp, 2147483000, "GRN"));
      expect(missing.code).toBe("NOT_FOUND");
    });
  });
});
