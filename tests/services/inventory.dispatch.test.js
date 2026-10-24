// Vendor dispatch notes (Task B2, spec §7.3): the vendor tells the hotel what
// is on the truck, against the PO's delivery plan. The legacy "Mark
// dispatched" button becomes a dispatch note with no lines (D1: it used to
// crash on any PO with more than one line, and on every call-off PO).
//
// Service-level tests run in withTx. HTTP and legacy-model tests commit and
// clean up after themselves.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import * as fx from "../helpers/invPlanFixtures.js";
import { httpClient } from "../helpers/http.js";
import { getDeliveries, savePlan } from "../../app/services/inventory/planService.js";
import { createDispatch, getVendorDeliveries } from "../../app/services/inventory/dispatchService.js";
import { recomputePoReceipt } from "../../app/services/inventory/receiptRollup.js";
import { handleMarkDispatched } from "../../app/models/purchaseOrderModel.js";

const { A1, A2, VENDOR, BUYER } = fx;
const OTHER_VENDOR = IDS.users.vendor_beta;
const ADMIN = IDS.users.companyA_admin;
const admin = { id: ADMIN, user_type: 2 };
const vendor = { id: VENDOR, user_type: 3 };

const tr = fx.newTracker();
const stamped = new Map();

beforeAll(async () => {
  // Fixture users carry user_type NULL; the vendor routes admit user_type 3 only.
  for (const id of [VENDOR, OTHER_VENDOR]) {
    stamped.set(id, await db.one(`SELECT user_type, status FROM tbl_users WHERE id = $1`, [id]));
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [id]);
  }
});
afterEach(async () => {
  await fx.cleanupTracked(db, tr);
});
afterAll(async () => {
  for (const [id, row] of stamped) {
    await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`, [id, row.user_type, row.status]);
  }
  await closeDb();
});

const note = (over = {}) => ({
  challanNo: "DC-778",
  challanDate: "2030-11-08",
  expectedDeliveryDate: "2030-11-10",
  vehicleNo: "MH01AB1234",
  transporter: "Blue Dart",
  ewayBillNo: "EWB-1",
  remarks: "Fragile",
  ...over,
});

/** Every key at every depth of a JSON value. */
function allKeys(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

describe("vendor dispatch notes", () => {
  it("vendor creates dispatch note with lines and phase", async () => {
    const po = await db.tx((t) => fx.makeRfqPo(t, {
      status: "approved", tracker: tr, mappedHotels: [A1, A2], lines: [{ qty: 10, unit: "kg" }, { qty: 6, unit: "box" }],
    }));
    const [l1, l2] = po.lineIds;
    await db.tx(async (t) => {
      await getDeliveries(t, admin, po.poId);
      await savePlan(t, admin, po.poId, [
        { hotelId: A1, phaseNo: 1, dueDate: "2030-11-05", lines: [{ poLineId: l1, plannedQty: 4 }, { poLineId: l2, plannedQty: 6 }] },
        { hotelId: A1, phaseNo: 2, dueDate: "2030-11-12", lines: [{ poLineId: l1, plannedQty: 3 }] },
        { hotelId: A2, phaseNo: 1, dueDate: "2030-11-12", lines: [{ poLineId: l1, plannedQty: 3 }] },
      ]);
    });
    const plan = await db.tx((t) => getDeliveries(t, admin, po.poId));
    const phase2 = plan.deliveries.find((d) => d.hotelId === A1 && d.phaseNo === 2);

    const c = await httpClient(VENDOR);
    const res = await c.post(`/api/v1/inventory/vendor/po/${po.poId}/dispatches`).send(note({
      deliveryId: phase2.id,
      lines: [{ poLineId: l1, qty: 3 }, { poLineId: l2, qty: "2" }],
    }));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe(1);
    const d = res.body.data;
    expect(d).toMatchObject({
      dispatchNumber: expect.stringMatching(/^DSP\/10101\/\d{4}-\d{2}\/\d{5}$/),
      hotelId: A1,
      hotelName: "Hotel A-1",
      deliveryId: phase2.id,
      phaseNo: 2,
      status: "in_transit",
      challanNo: "DC-778",
      expectedDeliveryDate: "2030-11-10",
    });
    expect(d.lines.map((l) => [l.poLineId, l.qty])).toEqual([[l1, 3], [l2, 2]]);
    expect(d.lines[0].productName).toEqual(expect.any(String));

    const row = await db.one(
      `SELECT d.vendor_id, d.challan_date::text AS challan_date, d.vehicle_no, d.transporter, d.eway_bill_no, d.remarks,
              po.status::text AS po_status, po.delivery_plan_locked_at
         FROM tbl_po_dispatch d JOIN tbl_rfq_purchase_order po ON po.id = d.po_id
        WHERE d.id = $1`,
      [d.id]
    );
    expect(row).toMatchObject({
      vendor_id: VENDOR, challan_date: "2030-11-08", vehicle_no: "MH01AB1234", transporter: "Blue Dart",
      eway_bill_no: "EWB-1", remarks: "Fragile", po_status: "dispatched",
    });
    expect(row.delivery_plan_locked_at).not.toBeNull();

    // The buyer's page lists it.
    const after = await db.tx((t) => getDeliveries(t, admin, po.poId));
    expect(after.dispatches).toEqual([expect.objectContaining({ id: d.id, phaseNo: 2, status: "in_transit" })]);
    expect(after.planLocked).toBe(true);

    // The required fields are required.
    const bad = await c.post(`/api/v1/inventory/vendor/po/${po.poId}/dispatches`).send(note({
      challanNo: "", lines: [{ poLineId: l1, qty: 1 }],
    }));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("VALIDATION");
    const empty = await c.post(`/api/v1/inventory/vendor/po/${po.poId}/dispatches`).send(note({ lines: [] }));
    expect(empty.status).toBe(400);

    // Another vendor cannot see the PO at all.
    const other = await httpClient(OTHER_VENDOR);
    const foreign = await other.post(`/api/v1/inventory/vendor/po/${po.poId}/dispatches`).send(note({
      lines: [{ poLineId: l1, qty: 1 }],
    }));
    expect(foreign.status).toBe(404);
    expect((await other.get(`/api/v1/inventory/vendor/po/${po.poId}/deliveries`)).status).toBe(404);
    expect((await other.post(`/api/v1/inventory/vendor/po/${po.poId}/dispatches/${d.id}/cancel`)).status).toBe(404);

    // The vendor can withdraw a note while it is on the road, once.
    const cancel = await c.post(`/api/v1/inventory/vendor/po/${po.poId}/dispatches/${d.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.data).toMatchObject({ id: d.id, status: "cancelled" });
    const again = await c.post(`/api/v1/inventory/vendor/po/${po.poId}/dispatches/${d.id}/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("CONFLICT");
  });

  it("dispatch qty above open qty rejected", async () => {
    await withTx(async (t) => {
      const po = await fx.makeRfqPo(t, { status: "approved", mappedHotels: [A1, A2], lines: [{ qty: 10 }] });
      const [l1] = po.lineIds;
      await getDeliveries(t, admin, po.poId);

      await expect(createDispatch(t, vendor, po.poId, note({ lines: [{ poLineId: l1, qty: 11 }] })))
        .rejects.toMatchObject({ code: "VALIDATION", details: { poLineId: l1, openQty: 10 } });

      // Split, then receive 4 at A1: A1 has 2 open, the PO line has 6.
      await savePlan(t, admin, po.poId, [
        { hotelId: A1, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 6 }] },
        { hotelId: A2, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 4 }] },
      ]);
      const plan = await getDeliveries(t, admin, po.poId);
      const atA1 = plan.deliveries.find((d) => d.hotelId === A1);
      await fx.postedGrn(t, { poId: po.poId, hotelId: A1, lines: [{ poLineId: l1, deliveryLineId: atA1.lines[0].id, accepted: 4 }] });
      await recomputePoReceipt(t, po.poId);

      await expect(createDispatch(t, vendor, po.poId, note({ hotelId: A1, lines: [{ poLineId: l1, qty: 3 }] })))
        .rejects.toMatchObject({ code: "VALIDATION", details: { poLineId: l1, openQty: 2 } });
      await expect(createDispatch(t, vendor, po.poId, note({ lines: [{ poLineId: l1, qty: 7 }] })))
        .rejects.toMatchObject({ code: "VALIDATION", details: { poLineId: l1, openQty: 6 } });

      const ok = await createDispatch(t, vendor, po.poId, note({ lines: [{ poLineId: l1, qty: 6 }] }));
      expect(ok).toMatchObject({ hotelId: null, deliveryId: null, phaseNo: null, status: "in_transit" });
      // With no hotel named, the number is taken on the PO's first hotel.
      expect(ok.dispatchNumber).toMatch(/^DSP\/10101\//);
      const atA2 = await createDispatch(t, vendor, po.poId, note({ hotelId: A2, lines: [{ poLineId: l1, qty: 4 }] }));
      expect(atA2.dispatchNumber).toMatch(/^DSP\/10102\//);

      // A line of another PO, a hotel the PO does not deliver to, a delivery
      // of another hotel: all refused.
      const other = await fx.makeRfqPo(t, { status: "approved", lines: [{ qty: 5 }] });
      await expect(createDispatch(t, vendor, po.poId, note({ lines: [{ poLineId: other.lineIds[0], qty: 1 }] })))
        .rejects.toMatchObject({ code: "VALIDATION" });
      await expect(createDispatch(t, vendor, po.poId, note({ hotelId: IDS.hotels.A3, lines: [{ poLineId: l1, qty: 1 }] })))
        .rejects.toMatchObject({ code: "VALIDATION" });
      await expect(createDispatch(t, vendor, po.poId, note({ hotelId: A2, deliveryId: atA1.id, lines: [{ poLineId: l1, qty: 1 }] })))
        .rejects.toMatchObject({ code: "VALIDATION" });
      await expect(createDispatch(t, vendor, po.poId, note({ lines: [{ poLineId: l1, qty: 0 }] })))
        .rejects.toMatchObject({ code: "VALIDATION" });
    });
  });

  it("buyer cannot call vendor dispatch route", async () => {
    const po = await db.tx((t) => fx.makeRfqPo(t, { status: "approved", tracker: tr, lines: [{ qty: 10 }] }));
    for (const userId of [ADMIN, BUYER]) {
      const c = await httpClient(userId);
      const post = await c.post(`/api/v1/inventory/vendor/po/${po.poId}/dispatches`).send(note({
        lines: [{ poLineId: po.lineIds[0], qty: 1 }],
      }));
      expect(post.status).toBe(403);
      expect((await c.get(`/api/v1/inventory/vendor/po/${po.poId}/deliveries`)).status).toBe(403);
    }
    const { n } = await db.one(`SELECT count(*)::int AS n FROM tbl_po_dispatch WHERE po_id = $1`, [po.poId]);
    expect(n).toBe(0);
  });

  it("legacy markDispatched works for multi-line RFQ PO and call-off PO", async () => {
    const rfqPo = await db.tx((t) => fx.makeRfqPo(t, {
      status: "approved", tracker: tr, lines: [{ qty: 10, deliveryPeriod: "7" }, { qty: 4, deliveryPeriod: "10 days" }],
    }));
    const callOff = await db.tx((t) => fx.makeCallOffPo(t, { tracker: tr, lines: [{ qty: 6 }, { qty: 2 }] }));

    for (const po of [rfqPo, callOff]) {
      await expect(handleMarkDispatched(po.poId, VENDOR)).resolves.toBe(true);
      const rows = await db.any(
        `SELECT d.id, d.status, d.hotel_id, d.dispatch_number,
                (SELECT count(*)::int FROM tbl_po_dispatch_line l WHERE l.dispatch_id = d.id) AS line_count
           FROM tbl_po_dispatch d WHERE d.po_id = $1`,
        [po.poId]
      );
      expect(rows).toEqual([expect.objectContaining({ status: "in_transit", line_count: 0, hotel_id: null })]);
      const head = await db.one(
        `SELECT status::text AS status, delivery_plan_locked_at FROM tbl_rfq_purchase_order WHERE id = $1`,
        [po.poId]
      );
      expect(head.status).toBe("dispatched");
      expect(head.delivery_plan_locked_at).not.toBeNull();
      // The PO's people are told, as before.
      const told = await db.any(
        `SELECT recipient_user_id FROM tbl_notifications
          WHERE type = 'po_dispatched' AND (additional_data->>'po_id')::int = $1`,
        [po.poId]
      );
      expect(told.map((r) => Number(r.recipient_user_id))).toContain(BUYER);
      await db.none(`DELETE FROM tbl_notifications WHERE type = 'po_dispatched' AND (additional_data->>'po_id')::int = $1`, [po.poId]);
    }

    // Still only the vendor of the PO.
    await expect(handleMarkDispatched(rfqPo.poId, OTHER_VENDOR)).rejects.toThrow(/does not belong/i);
  });

  it("legacy markDispatched pressed twice records one note and one email", async () => {
    const po = await db.tx((t) => fx.makeRfqPo(t, { status: "approved", tracker: tr, lines: [{ qty: 10 }, { qty: 4 }] }));
    const notes = () => db.any(`SELECT id FROM tbl_po_dispatch WHERE po_id = $1`, [po.poId]);
    const told = () => db.any(
      `SELECT id FROM tbl_notifications
        WHERE type = 'po_dispatched' AND recipient_user_id = $2 AND (additional_data->>'po_id')::int = $1`,
      [po.poId, BUYER]
    );
    try {
      // A double click: both requests at once.
      await expect(Promise.all([handleMarkDispatched(po.poId, VENDOR), handleMarkDispatched(po.poId, VENDOR)]))
        .resolves.toEqual([true, true]);
      const [first, ...more] = await notes();
      expect(more).toEqual([]);
      expect(await told()).toHaveLength(1);

      // A retry later, while that note is still on the road: the same note.
      await expect(handleMarkDispatched(po.poId, VENDOR)).resolves.toBe(true);
      expect((await notes()).map((r) => r.id)).toEqual([first.id]);
      expect(await told()).toHaveLength(1);

      // Once the vendor withdraws it, the button records a new one.
      await db.none(`UPDATE tbl_po_dispatch SET status = 'cancelled' WHERE id = $1`, [first.id]);
      await expect(handleMarkDispatched(po.poId, VENDOR)).resolves.toBe(true);
      expect(await notes()).toHaveLength(2);
    } finally {
      await db.none(`DELETE FROM tbl_notifications WHERE type = 'po_dispatched' AND (additional_data->>'po_id')::int = $1`, [po.poId]);
    }
  });

  it("second dispatch never moves status back from GRN", async () => {
    await withTx(async (t) => {
      const po = await fx.makeRfqPo(t, { status: "approved", lines: [{ qty: 10 }] });
      const [l1] = po.lineIds;
      await createDispatch(t, vendor, po.poId, note({ lines: [{ poLineId: l1, qty: 4 }] }));
      const status = async () => (await t.one(`SELECT status::text AS s FROM tbl_rfq_purchase_order WHERE id = $1`, [po.poId])).s;
      expect(await status()).toBe("dispatched");

      for (const later of ["GRN", "invoice_raised"]) {
        await t.none(`UPDATE tbl_rfq_purchase_order SET status = $2 WHERE id = $1`, [po.poId, later]);
        await createDispatch(t, vendor, po.poId, note({ lines: [{ poLineId: l1, qty: 1 }] }));
        expect(await status()).toBe(later);
      }
      // The legacy button on a PO already past dispatch leaves it there too.
      await createDispatch(t, { system: true, userId: VENDOR }, po.poId, { lines: [] });
      expect(await status()).toBe("invoice_raised");

      // Nothing can be dispatched against a PO the vendor has not accepted, a
      // closed one, or one already received in full.
      for (const s of ["acceptance_pending", "pending_approval", "cancelled", "rejected_by_vendor"]) {
        await t.none(`UPDATE tbl_rfq_purchase_order SET status = $2 WHERE id = $1`, [po.poId, s]);
        await expect(createDispatch(t, { system: true, userId: VENDOR }, po.poId, { lines: [] }))
          .rejects.toMatchObject({ code: "CONFLICT" });
        // The vendor is refused too: a PO not (or no longer) released to them is not found.
        await expect(createDispatch(t, vendor, po.poId, note({ lines: [{ poLineId: l1, qty: 1 }] })))
          .rejects.toMatchObject({ code: ["pending_approval", "cancelled"].includes(s) ? "NOT_FOUND" : "CONFLICT" });
      }
      await t.none(`UPDATE tbl_rfq_purchase_order SET status = 'GRN', receipt_status = 'received' WHERE id = $1`, [po.poId]);
      await expect(createDispatch(t, vendor, po.poId, note({ lines: [{ poLineId: l1, qty: 1 }] })))
        .rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  it("vendor deliveries view has no price fields", async () => {
    await withTx(async (t) => {
      const po = await fx.makeRfqPo(t, { status: "approved", mappedHotels: [A1, A2], lines: [{ qty: 10 }, { qty: 6 }] });
      const [l1, l2] = po.lineIds;
      await getDeliveries(t, admin, po.poId);
      await savePlan(t, admin, po.poId, [
        { hotelId: A1, phaseNo: 1, dueDate: "2030-11-10", remarks: "Dock 2",
          lines: [{ poLineId: l1, plannedQty: 6 }, { poLineId: l2, plannedQty: 6 }] },
        { hotelId: A2, phaseNo: 1, dueDate: "2030-11-12", lines: [{ poLineId: l1, plannedQty: 4 }] },
      ]);
      const plan = await getDeliveries(t, admin, po.poId);
      const atA1 = plan.deliveries.find((d) => d.hotelId === A1);
      const dl = (poLineId) => atA1.lines.find((l) => l.poLineId === poLineId).id;

      const sent = await createDispatch(t, vendor, po.poId, note({ deliveryId: atA1.id, lines: [{ poLineId: l1, qty: 6 }, { poLineId: l2, qty: 6 }] }));
      // The vendor's own invoice for that delivery (C4).
      await t.none(
        `INSERT INTO tbl_purchase_order_document
           (purchase_order_id, document_type, document_url, uploaded_by, invoice_number, invoice_date, invoice_amount, dispatch_id)
         VALUES ($1, 'invoice', 'https://example.test/inv.pdf', $2, 'INV-77', '2030-01-04', 70500, $3)`,
        [po.poId, VENDOR, sent.id]
      );
      const grn = await fx.postedGrn(t, {
        poId: po.poId, hotelId: A1,
        lines: [
          { poLineId: l1, deliveryLineId: dl(l1), accepted: 5, rejected: 1, unitCost: 250 },
          { poLineId: l2, deliveryLineId: dl(l2), accepted: 2 },
        ],
      });
      const rtv = await t.one(
        `INSERT INTO tbl_rtv (rtv_number, hospitality_company_id, po_id, grn_id, hotel_id, disposition, status, challan_no, created_by)
         VALUES ('RTV/10101/2030-31/00001', $1, $2, $3, $4, 'REPLACE', 'dispatched', 'RC-1', $5) RETURNING id`,
        [fx.CO, po.poId, grn.grnId, A1, BUYER]
      );
      await t.none(
        `INSERT INTO tbl_rtv_line (hospitality_company_id, rtv_id, grn_line_id, qty, reason) VALUES ($1, $2, $3, 1, 'Torn bag')`,
        [fx.CO, rtv.id, grn.grnLineIds[0]]
      );
      await t.none(
        `INSERT INTO tbl_po_short_close (hospitality_company_id, po_id, delivery_line_id, qty, reason_code, remarks, action, acted_by)
         VALUES ($1, $2, $3, 4, 'no_longer_needed', 'Menu changed', 'close', $4)`,
        [fx.CO, po.poId, dl(l2), BUYER]
      );
      await recomputePoReceipt(t, po.poId);

      const view = await getVendorDeliveries(t, vendor, po.poId);

      // Everything the vendor needs is there ...
      expect(view.deliveries.map((d) => [d.hotelName, d.phaseNo, d.dueDate, d.remarks])).toEqual([
        ["Hotel A-1", 1, "2030-11-10", "Dock 2"],
        ["Hotel A-2", 1, "2030-11-12", null],
      ]);
      expect(view.deliveries[0].lines.find((l) => l.poLineId === l1))
        .toMatchObject({ plannedQty: 6, acceptedQty: 5, rejectedQty: 1, returnedReplaceQty: 1, openQty: 2 });
      expect(view.dispatches).toHaveLength(1);
      expect(view.grns).toEqual([expect.objectContaining({
        grnNumber: expect.any(String), hotelName: "Hotel A-1", receivedAt: "2030-01-05",
        lines: expect.arrayContaining([expect.objectContaining({ acceptedQty: 5, rejectedQty: 1, rejectionReason: "damaged" })]),
      })]);
      expect(view.rtvs).toEqual([expect.objectContaining({
        rtvNumber: "RTV/10101/2030-31/00001", hotelName: "Hotel A-1", disposition: "REPLACE", status: "dispatched",
        lines: [expect.objectContaining({ qty: 1, reason: "Torn bag" })],
      })]);
      expect(view.shortCloses).toEqual([expect.objectContaining({
        hotelName: "Hotel A-1", qty: 4, reasonCode: "no_longer_needed", remarks: "Menu changed", actedAt: expect.any(String),
      })]);
      // invoiceAmount is the vendor's own billed figure (it typed it in), not a
      // buyer price, which is why its key does not match the scan below.
      expect(view.invoices).toEqual([expect.objectContaining({
        invoiceNumber: "INV-77", invoiceDate: "2030-01-04", invoiceAmount: 70500, dispatchId: sent.id,
      })]);

      // ... and nothing about money or the buyer's people.
      const priceKeys = allKeys(view).filter((k) => /price|rate|cost|value/i.test(k));
      expect(allKeys(view)).toEqual(expect.arrayContaining(["deliveries", "dispatches", "grns", "rtvs", "shortCloses", "invoices"]));
      expect(priceKeys).toEqual([]);
      const text = JSON.stringify(view);
      const names = await t.any(`SELECT name FROM tbl_users WHERE id = ANY($1::int[]) AND name IS NOT NULL`, [[BUYER, ADMIN]]);
      for (const { name } of names) expect(text).not.toContain(name);
      expect(allKeys(view).filter((k) => /By(Name)?$|actedBy|postedBy|createdBy/.test(k))).toEqual([]);

      // A PO not yet released to the vendor is not theirs to see (as in their PO list).
      for (const status of ["draft", "pending_approval"]) {
        const unreleased = await fx.makeRfqPo(t, { status, lines: [{ qty: 1 }] });
        await expect(getVendorDeliveries(t, vendor, unreleased.poId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
    });
  });
});
