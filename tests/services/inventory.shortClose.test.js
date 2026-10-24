// Short-close and reopen (Task B5, spec §6.12).
//
// The buyer closes an undelivered remainder with a reason: one
// tbl_po_short_close row per affected delivery line, sized by that line's open
// qty, and the roll-up then reads the line as short_closed. A call-off PO
// gives the closed qty back to its rate contract (contract line AND the
// Group-ARC per-hotel ledger row) in the same transaction; a reopen takes it
// again under the release guard and is refused when the contract is used up.
//
// Service tests run inside withTx (always rolled back). The HTTP tests commit
// for real and clean up after themselves.

import { describe, it, expect, afterAll, beforeAll, afterEach } from "@jest/globals";
import { db, withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { shortClose, reopenShortClose } from "../../app/services/inventory/shortCloseService.js";
import { createRtv, dispatchRtv } from "../../app/services/inventory/rtvService.js";
import { grantRoleScope } from "../helpers/roleScope.js";
import { InventoryError } from "../../app/services/inventory/errors.js";
import { drainReceivingNotices } from "../../app/services/inventory/notices/receivingNotices.js";
import {
  CO, A1, A2, VENDOR, makeRfqPo, setPlan, postReceiptGrn, deliveryLinesOf,
} from "../helpers/invReceiptFixtures.js";

const OWNER = { id: IDS.users.companyA_admin, user_type: 2 }; // CEO: awarding.create company-wide
const NON_INITIATOR = { id: IDS.users.a1_proc_buyer, user_type: 2 }; // sees A1 POs, cannot initiate
const STORES = { id: IDS.users.a1_proc_buyer, user_type: 2 }; // given grn.* where a test needs it

afterAll(async () => {
  await closeDb();
});

const expectInvError = async (promise, code, detailsMatch) => {
  let err;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(InventoryError);
  expect(err.code).toBe(code);
  if (detailsMatch) expect(err.details).toMatchObject(detailsMatch);
  return err;
};

let seq = 0;
const tag = () => `b5sc-${process.pid}-${++seq}`;

/**
 * An accepted call-off PO raised by an MR at `hotel` against a Group ARC line
 * (committed 1000, hotel share `hotelShare`), already released: the contract
 * line and the hotel's ledger row carry `qty` consumed.
 */
async function makeCallOffPo(t, { hotel = A2, qty = 6, committed = 1000, hotelShare = 400 } = {}) {
  const t0 = tag();
  const arc = await t.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
        is_group, submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
     VALUES ($1, 'Short-close ARC', (SELECT id FROM tbl_category ORDER BY id LIMIT 1), $2, $3, $4, $5,
             'contract_active', true, NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
             NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6)
     RETURNING id`,
    [`ARC-${t0}`.slice(0, 40), CO, A1, IDS.departments.proc, IDS.processes.A_P1, OWNER.id]
  );
  const arcItem = await t.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, 2, 100, 'pcs') RETURNING id`,
    [arc.id]
  );
  const contract = await t.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
    [arc.id, VENDOR]
  );
  const line = await t.one(
    `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty, consumed_qty)
     VALUES ($1, $2, 90, 5, $3, $4) RETURNING id`,
    [contract.id, arcItem.id, committed, qty]
  );
  const hotelRow = await t.one(
    `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty, consumed_qty)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [line.id, hotel, hotelShare, qty]
  );
  // Another hotel's ledger row on the same line must never move.
  await t.none(
    `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty, consumed_qty)
     VALUES ($1, $2, 300, 50)`,
    [line.id, hotel === A1 ? A2 : A1]
  );
  const mr = await t.one(
    `INSERT INTO tbl_material_requisition
       (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, required_by_date)
     VALUES ($1, 'Short-close MR', $2, $3, $4, 'normal', $5, 'po_released', '2026-11-15') RETURNING id`,
    [`MR-${t0}`.slice(0, 40), CO, hotel, IDS.departments.fb, OWNER.id]
  );
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id,
        total_value, quote_id, arc_contract_id, source_mr_id, is_call_off)
     VALUES (NULL, $1, $2, 'approved', '{}', $3, 90, $4, 0, '{}', $5, $6, TRUE) RETURNING id`,
    [IDS.companies.A, `CO-${t0}`, qty, VENDOR, contract.id, mr.id]
  );
  const pop = await t.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, quantity, unit, unit_price, charges_meta, total_price, product_variant_id, arc_contract_line_id)
     VALUES ($1, $2, 'pcs', 90, '{"tax":5,"tax_mode":"percentage","other_charges":[]}'::jsonb, $3, 2, $4)
     RETURNING id`,
    [po.id, qty, 94.5 * qty, line.id]
  );
  return {
    poId: Number(po.id), lineId: Number(pop.id), contractLineId: Number(line.id),
    hotelRowId: Number(hotelRow.id), mrId: Number(mr.id), arcId: Number(arc.id),
  };
}

const consumed = async (t, contractLineId) => {
  const line = await t.one(`SELECT consumed_qty::float AS c FROM tbl_arc_contract_line WHERE id = $1`, [contractLineId]);
  const hotels = await t.any(
    `SELECT hotel_id, consumed_qty::float AS c FROM tbl_arc_contract_line_hotel
      WHERE arc_contract_line_id = $1 ORDER BY hotel_id`,
    [contractLineId]
  );
  return { line: line.c, hotels: Object.fromEntries(hotels.map((h) => [h.hotel_id, h.c])) };
};

const logOf = (t, poId) =>
  t.any(
    `SELECT delivery_line_id, qty::float AS qty, reason_code, remarks, action, acted_by
       FROM tbl_po_short_close WHERE po_id = $1 ORDER BY id`,
    [poId]
  );

const receiptStatus = async (t, poId) =>
  (await t.one(`SELECT receipt_status FROM tbl_rfq_purchase_order WHERE id = $1`, [poId])).receipt_status;

describe("short-close", () => {
  it("short-close remainder of one phase sets short_closed and PO closed_short when rest received", async () => {
    await withTx(async (t) => {
      const { poId, lineIds: [line] } = await makeRfqPo(t, { lines: [{ qty: 10, unit: "kg" }] });
      const [p1, p2] = await setPlan(t, poId, [
        { hotelId: A1, phaseNo: 1, dueDate: "2026-10-20", lines: { [line]: 6 } },
        { hotelId: A1, phaseNo: 2, dueDate: "2026-11-20", lines: { [line]: 4 } },
      ]);
      await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 6, deliveryLineId: p1.lines[line] }] });
      await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 1, deliveryLineId: p2.lines[line] }] });
      expect(await receiptStatus(t, poId)).toBe("partial");

      const out = await shortClose(t, OWNER, poId, {
        target: { type: "delivery", deliveryId: p2.deliveryId },
        reasonCode: "vendor_cannot_supply",
        remarks: "  Out of season  ",
      });

      // One row, on the phase-2 line, for its open 3 (planned 4 − accepted 1).
      expect(await logOf(t, poId)).toEqual([
        { delivery_line_id: p2.lines[line], qty: 3, reason_code: "vendor_cannot_supply", remarks: "Out of season",
          action: "close", acted_by: OWNER.id },
      ]);
      expect(out).toMatchObject({ poId, receiptStatus: "closed_short", shortCloseIds: [expect.any(Number)] });
      expect(out.closed).toEqual([{ deliveryLineId: p2.lines[line], poLineId: line, qty: 3 }]);

      const dls = await deliveryLinesOf(t, poId);
      expect(dls.map((d) => [d.id, d.status, d.short_closed])).toEqual([
        [p1.lines[line], "received", 0],
        [p2.lines[line], "short_closed", 3],
      ]);
      const deliveries = await t.any(`SELECT id, status FROM tbl_po_delivery WHERE po_id = $1 ORDER BY id`, [poId]);
      expect(deliveries.map((d) => d.status)).toEqual(["received", "short_closed"]);
      const pol = await t.one(
        `SELECT receipt_status, short_closed_qty::float AS sc FROM tbl_purchase_order_product WHERE id = $1`, [line]
      );
      expect(pol).toEqual({ receipt_status: "short_closed", sc: 3 });
      expect(await receiptStatus(t, poId)).toBe("closed_short");

      // Nothing is left open, so a second close is refused.
      await expectInvError(
        shortClose(t, OWNER, poId, { target: { type: "po" }, reasonCode: "no_longer_needed" }),
        "VALIDATION"
      );
    });
  });

  it("closes by hotel, by delivery lines and for the whole PO", async () => {
    await withTx(async (t) => {
      const { poId, lineIds: [l1, l2] } = await makeRfqPo(t, {
        mappedHotels: [A1, A2], lines: [{ qty: 10, unit: "kg", variantId: 1 }, { qty: 8, unit: "nos", variantId: 3 }],
      });
      const [h1, h2] = await setPlan(t, poId, [
        { hotelId: A1, phaseNo: 1, lines: { [l1]: 5, [l2]: 4 } },
        { hotelId: A2, phaseNo: 1, lines: { [l1]: 5, [l2]: 4 } },
      ]);
      await postReceiptGrn(t, { poId, hotelId: A2, lines: [{ poLineId: l1, accepted: 2, deliveryLineId: h2.lines[l1] }] });

      const byHotel = await shortClose(t, OWNER, poId, {
        target: { type: "hotel", hotelId: A2 }, reasonCode: "no_longer_needed",
      });
      expect(byHotel.closed).toEqual([
        { deliveryLineId: h2.lines[l1], poLineId: l1, qty: 3 },
        { deliveryLineId: h2.lines[l2], poLineId: l2, qty: 4 },
      ]);

      const byLines = await shortClose(t, OWNER, poId, {
        target: { type: "lines", deliveryLineIds: [h1.lines[l2]] }, reasonCode: "substituted",
      });
      expect(byLines.closed).toEqual([{ deliveryLineId: h1.lines[l2], poLineId: l2, qty: 4 }]);

      const all = await shortClose(t, OWNER, poId, { target: { type: "po" }, reasonCode: "price_dispute" });
      expect(all.closed).toEqual([{ deliveryLineId: h1.lines[l1], poLineId: l1, qty: 5 }]);
      expect(all.receiptStatus).toBe("closed_short");

      // A delivery or line of another PO is not found.
      const other = await makeRfqPo(t);
      const [o] = await setPlan(t, other.poId, [{ hotelId: A1, lines: { [other.lineIds[0]]: 10 } }]);
      await expectInvError(
        shortClose(t, OWNER, poId, { target: { type: "delivery", deliveryId: o.deliveryId }, reasonCode: "other", remarks: "x" }),
        "NOT_FOUND"
      );
      await expectInvError(
        shortClose(t, OWNER, poId, {
          target: { type: "lines", deliveryLineIds: [o.lines[other.lineIds[0]]] }, reasonCode: "other", remarks: "x",
        }),
        "NOT_FOUND"
      );
    });
  });

  it("reason required; other needs remarks", async () => {
    await withTx(async (t) => {
      const { poId } = await makeRfqPo(t);
      const target = { type: "po" };
      await expectInvError(shortClose(t, OWNER, poId, { target }), "VALIDATION", { field: "reasonCode" });
      await expectInvError(shortClose(t, OWNER, poId, { target, reasonCode: "lost" }), "VALIDATION", { field: "reasonCode" });
      await expectInvError(
        shortClose(t, OWNER, poId, { target, reasonCode: "other", remarks: "   " }),
        "VALIDATION",
        { field: "remarks" }
      );
      await expectInvError(shortClose(t, OWNER, poId, { reasonCode: "no_longer_needed" }), "VALIDATION", { field: "target" });
      await expectInvError(
        shortClose(t, OWNER, poId, { target: { type: "phase" }, reasonCode: "no_longer_needed" }),
        "VALIDATION",
        { field: "target" }
      );
      expect(await logOf(t, poId)).toEqual([]);

      // With remarks, "other" closes the whole open qty (the default plan is created on demand).
      const out = await shortClose(t, OWNER, poId, { target, reasonCode: "other", remarks: "Project cancelled" });
      expect(out.closed).toEqual([expect.objectContaining({ qty: 10 })]);
      expect(await receiptStatus(t, poId)).toBe("closed_short");
    });
  });

  it("short-close on a PO awaiting vendor acceptance is refused", async () => {
    await withTx(async (t) => {
      // The vendor can still reject a PO in these states, and a rejection gives
      // a call-off's full qty back, so closing part of it first would give
      // that part back twice.
      for (const status of ["sent", "acceptance_pending"]) {
        const { poId } = await makeRfqPo(t, { status });
        const err = await expectInvError(
          shortClose(t, OWNER, poId, { target: { type: "po" }, reasonCode: "no_longer_needed" }),
          "VALIDATION",
          { status }
        );
        expect(err.message).toBe("Short-close is available once the vendor accepts the PO");
        await expectInvError(
          reopenShortClose(t, OWNER, poId, { deliveryLineIds: [1], remarks: "x" }),
          "VALIDATION",
          { status }
        );
        expect(await logOf(t, poId)).toEqual([]);
      }
    });
  });

  it("is refused on a PO that is no longer live", async () => {
    await withTx(async (t) => {
      for (const status of ["cancelled", "rejected_by_vendor"]) {
        const { poId } = await makeRfqPo(t, { status });
        await expectInvError(
          shortClose(t, OWNER, poId, { target: { type: "po" }, reasonCode: "no_longer_needed" }),
          "CONFLICT",
          { status }
        );
      }
    });
  });

  it("call-off short-close gives back contract and Group-ARC hotel consumed_qty", async () => {
    await withTx(async (t) => {
      const po = await makeCallOffPo(t, { hotel: A2, qty: 6 });
      await postReceiptGrn(t, { poId: po.poId, hotelId: A2, lines: [{ poLineId: po.lineId, accepted: 4 }] });
      expect(await consumed(t, po.contractLineId)).toEqual({ line: 6, hotels: { [A1]: 50, [A2]: 6 } });

      const out = await shortClose(t, OWNER, po.poId, { target: { type: "po" }, reasonCode: "vendor_cannot_supply" });
      expect(out.closed).toEqual([expect.objectContaining({ poLineId: po.lineId, qty: 2 })]);
      expect(out.callOffGiveBack).toEqual([{ arcContractLineId: po.contractLineId, hotelId: A2, qty: 2 }]);
      // The ordering hotel's ledger row and the line total get 2 back; the other hotel is untouched.
      expect(await consumed(t, po.contractLineId)).toEqual({ line: 4, hotels: { [A1]: 50, [A2]: 4 } });
      expect(await receiptStatus(t, po.poId)).toBe("closed_short");
    });
  });
});

describe("reopen", () => {
  it("reopen re-consumes contract; contract line is a hard cap, the hotel share is soft (as at release)", async () => {
    await withTx(async (t) => {
      const po = await makeCallOffPo(t, { hotel: A2, qty: 6, committed: 100, hotelShare: 40 });
      await postReceiptGrn(t, { poId: po.poId, hotelId: A2, lines: [{ poLineId: po.lineId, accepted: 4 }] });
      const closed = await shortClose(t, OWNER, po.poId, { target: { type: "po" }, reasonCode: "no_longer_needed" });
      const dlId = closed.closed[0].deliveryLineId;
      expect(await consumed(t, po.contractLineId)).toEqual({ line: 4, hotels: { [A1]: 50, [A2]: 4 } });

      await expectInvError(reopenShortClose(t, OWNER, po.poId, { deliveryLineIds: [dlId] }), "VALIDATION", { field: "remarks" });

      const out = await reopenShortClose(t, OWNER, po.poId, { deliveryLineIds: [dlId], remarks: "Vendor found stock" });
      expect(out.reopened).toEqual([{ deliveryLineId: dlId, poLineId: po.lineId, qty: 2 }]);
      expect(out.receiptStatus).toBe("partial");
      expect((await logOf(t, po.poId)).map((r) => [r.action, r.qty, r.reason_code, r.remarks])).toEqual([
        ["close", 2, "no_longer_needed", null],
        ["reopen", 2, null, "Vendor found stock"],
      ]);
      expect(await consumed(t, po.contractLineId)).toEqual({ line: 6, hotels: { [A1]: 50, [A2]: 6 } });
      const [dl] = await deliveryLinesOf(t, po.poId);
      expect([dl.status, dl.short_closed]).toEqual(["partial", 0]);

      // Nothing net-closed left on that line.
      await expectInvError(
        reopenShortClose(t, OWNER, po.poId, { deliveryLineIds: [dlId], remarks: "again" }),
        "VALIDATION"
      );

      // Close again, then another requisition uses the rest of the contract:
      // the reopen is refused and nothing moves.
      await shortClose(t, OWNER, po.poId, { target: { type: "po" }, reasonCode: "no_longer_needed" });
      await t.none(`UPDATE tbl_arc_contract_line SET consumed_qty = committed_qty WHERE id = $1`, [po.contractLineId]);
      const before = await logOf(t, po.poId);
      await expectInvError(
        t.tx((sp) => reopenShortClose(sp, OWNER, po.poId, { deliveryLineIds: [dlId], remarks: "retry" })),
        "CONFLICT",
        { arcContractLineId: po.contractLineId }
      );
      expect(await logOf(t, po.poId)).toEqual(before);
      expect(await consumed(t, po.contractLineId)).toEqual({ line: 100, hotels: { [A1]: 50, [A2]: 4 } });

      // Room on the contract but the ordering hotel's share is used up: allowed,
      // exactly as at release: the hotel goes past its share and head office
      // gets the over-share event.
      await t.none(`UPDATE tbl_arc_contract_line SET consumed_qty = 4 WHERE id = $1`, [po.contractLineId]);
      await t.none(`UPDATE tbl_arc_contract_line_hotel SET consumed_qty = committed_qty WHERE id = $1`, [po.hotelRowId]);
      const over = await reopenShortClose(t, OWNER, po.poId, { deliveryLineIds: [dlId], remarks: "retry" });
      expect(over.reopened).toEqual([{ deliveryLineId: dlId, poLineId: po.lineId, qty: 2 }]);
      expect(await consumed(t, po.contractLineId)).toEqual({ line: 6, hotels: { [A1]: 50, [A2]: 42 } });
      const shareEntry = {
        arc_contract_line_id: po.contractLineId, hotel_id: A2, committed_qty: 40, consumed_qty: 42,
        mr_id: po.mrId, po_id: po.poId,
      };
      expect(over.callOffOverShare).toEqual([{ arcId: po.arcId, payload: expect.objectContaining(shareEntry) }]);
      const events = await t.any(
        `SELECT arc_id::int AS arc_id, payload FROM tbl_arc_event_log WHERE event_type = 'call_off_over_hotel_share' AND arc_id = $1`,
        [po.arcId]
      );
      expect(events).toEqual([{ arc_id: po.arcId, payload: expect.objectContaining(shareEntry) }]);
    });
  });

  it("contract deltas are rounded to 2 dp once, so a fractional close and reopen nets to zero", async () => {
    await withTx(async (t) => {
      const po = await makeCallOffPo(t, { hotel: A2, qty: 6 });
      await postReceiptGrn(t, { poId: po.poId, hotelId: A2, lines: [{ poLineId: po.lineId, accepted: 4.125 }] });
      const start = await consumed(t, po.contractLineId);
      expect(start).toEqual({ line: 6, hotels: { [A1]: 50, [A2]: 6 } });

      const closed = await shortClose(t, OWNER, po.poId, { target: { type: "po" }, reasonCode: "no_longer_needed" });
      expect(closed.closed).toEqual([expect.objectContaining({ qty: 1.875 })]);
      // The contract columns hold 2 dp: 1.875 is given back as 1.88 (half-up), once.
      expect(closed.callOffGiveBack).toEqual([{ arcContractLineId: po.contractLineId, hotelId: A2, qty: 1.88 }]);
      expect(await consumed(t, po.contractLineId)).toEqual({ line: 4.12, hotels: { [A1]: 50, [A2]: 4.12 } });

      const reopened = await reopenShortClose(t, OWNER, po.poId, {
        deliveryLineIds: [closed.closed[0].deliveryLineId], remarks: "Back on",
      });
      expect(reopened.callOffReconsume).toEqual([{ arcContractLineId: po.contractLineId, hotelId: A2, qty: 1.88 }]);
      expect(await consumed(t, po.contractLineId)).toEqual(start);
    });
  });

  it("credit RTV on a call-off gives back contract qty; its lines cannot be reopened", async () => {
    await withTx(async (t) => {
      const role = await t.one(`SELECT id FROM tbl_roles WHERE title = 'Inventory Controller' AND created_by IS NULL`);
      await grantRoleScope(t, { userId: STORES.id, roleId: role.id, companyId: CO, hotelId: A2 });
      const po = await makeCallOffPo(t, { hotel: A2, qty: 6 });
      const grn = await postReceiptGrn(t, { poId: po.poId, hotelId: A2, lines: [{ poLineId: po.lineId, accepted: 6 }] });
      const dlId = grn.lines[0].deliveryLineId;
      expect(await consumed(t, po.contractLineId)).toEqual({ line: 6, hotels: { [A1]: 50, [A2]: 6 } });

      // 2 go back against a credit note: the contract and the ordering hotel get 2 back.
      const rtv = await createRtv(t, STORES, {
        grnId: grn.grnId, disposition: "CREDIT",
        lines: [{ grnLineId: grn.lines[0].grnLineId, qty: 2, reason: "Leaking" }],
      });
      const sent = await dispatchRtv(t, STORES, rtv.id, {});
      expect(await t.any(
        `SELECT delivery_line_id, qty::float AS qty, reason_code, action, rtv_id FROM tbl_po_short_close WHERE po_id = $1`,
        [po.poId]
      )).toEqual([{ delivery_line_id: dlId, qty: 2, reason_code: "other", action: "close", rtv_id: rtv.id }]);
      const afterCredit = { line: 4, hotels: { [A1]: 50, [A2]: 4 } };
      expect(await consumed(t, po.contractLineId)).toEqual(afterCredit);
      expect(await receiptStatus(t, po.poId)).toBe("closed_short");

      // Credited qty stays closed: a reopen is refused and nothing moves.
      const log = await logOf(t, po.poId);
      const err = await expectInvError(
        reopenShortClose(t, OWNER, po.poId, { deliveryLineIds: [dlId], remarks: "Vendor will resend" }),
        "VALIDATION",
        { field: "deliveryLineIds", rtvNumbers: [sent.rtvNumber] }
      );
      expect(err.message).toBe(`Qty credited by RTV ${sent.rtvNumber} can't be reopened`);
      expect(await logOf(t, po.poId)).toEqual(log);
      expect(await consumed(t, po.contractLineId)).toEqual(afterCredit);
      expect(await receiptStatus(t, po.poId)).toBe("closed_short");
    });
  });
});

describe("short-close over HTTP", () => {
  const created = { poIds: [], rfqIds: [] };
  const prevTypes = [];

  beforeAll(async () => {
    const ids = [OWNER.id, NON_INITIATOR.id, IDS.users.companyB_admin];
    prevTypes.push(...(await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [ids])));
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [ids]);
  });

  afterEach(async () => {
    await drainReceivingNotices();
    const { poIds, rfqIds } = created;
    if (poIds.length) {
      await db.none(`DELETE FROM tbl_notifications WHERE (additional_data->>'po_id')::int = ANY($1::int[])`, [poIds]);
      await db.none(`DELETE FROM tbl_po_short_close WHERE po_id = ANY($1::int[])`, [poIds]);
      await db.none(`DELETE FROM tbl_po_delivery WHERE po_id = ANY($1::int[])`, [poIds]);
      await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
      await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);
    }
    if (rfqIds.length) {
      await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
      await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
      await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
    }
    created.poIds = [];
    created.rfqIds = [];
  });

  afterAll(async () => {
    for (const r of prevTypes) {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [r.id, r.user_type]);
    }
  });

  const committedPo = async () => {
    const po = await makeRfqPo(db);
    created.poIds.push(po.poId);
    created.rfqIds.push(po.rfqId);
    return po;
  };

  it("non-initiator gets 403", async () => {
    const { poId } = await committedPo();
    const body = { target: { type: "po" }, reasonCode: "no_longer_needed" };

    const res = await (await httpClient(NON_INITIATOR.id)).post(`/api/v1/inventory/po/${poId}/short-close`).send(body);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ status: 0, code: "PO_WRITE_PERMISSION_REQUIRED" });

    const reopen = await (await httpClient(NON_INITIATOR.id))
      .post(`/api/v1/inventory/po/${poId}/short-close/reopen`).send({ deliveryLineIds: [1], remarks: "x" });
    expect(reopen.status).toBe(403);

    // Another company's PO is not found, not forbidden.
    const foreign = await (await httpClient(IDS.users.companyB_admin))
      .post(`/api/v1/inventory/po/${poId}/short-close`).send(body);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ status: 2 });

    expect(await db.any(`SELECT 1 FROM tbl_po_short_close WHERE po_id = $1`, [poId])).toEqual([]);
  });

  it("the PO owner short-closes and gets the PO's receipt state back", async () => {
    const { poId, lineIds: [line] } = await committedPo();
    const client = await httpClient(OWNER.id);
    const res = await client.post(`/api/v1/inventory/po/${poId}/short-close`)
      .send({ target: { type: "po" }, reasonCode: "vendor_cannot_supply", remarks: "Discontinued" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data).toMatchObject({
      poId,
      receiptStatus: "closed_short",
      poLines: [expect.objectContaining({ id: line, shortClosedQty: 10, openQty: 0, receiptStatus: "short_closed" })],
      shortCloses: [expect.objectContaining({ qty: 10, reasonCode: "vendor_cannot_supply", action: "close" })],
    });

    const bad = await client.post(`/api/v1/inventory/po/${poId}/short-close`)
      .send({ target: { type: "po" }, reasonCode: "other" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ status: 0, code: "VALIDATION" });

    const dlId = res.body.data.shortCloses[0].deliveryLineId;
    const reopened = await client.post(`/api/v1/inventory/po/${poId}/short-close/reopen`)
      .send({ deliveryLineIds: [dlId], remarks: "Back in stock" });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({ poId, receiptStatus: "not_received" });
  });
});
