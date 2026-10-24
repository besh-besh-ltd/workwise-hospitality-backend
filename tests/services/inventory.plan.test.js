// Delivery plans (Task B2, spec §7): a buyer splits a PO into hotel × phase
// deliveries; the plan locks at the first dispatch or receipt; dates of phases
// with no receipt can still move; vendors are told when an accepted PO's plan
// changes; the PO PDFs print the plan and a QR code.
//
// Service-level tests run in withTx (rolled back). Tests that go through HTTP,
// or through a model function with its own transaction, commit for real and
// clean up after themselves (cleanupTracked).

import { describe, it, expect, afterAll, afterEach, jest } from "@jest/globals";

// The plan notices are spied on so "the vendor is told" is observable without
// mail. Everything that imports them (controllers, notifier.js) sees the spy.
const notifyPlanChanged = jest.fn(async () => undefined);
const notifyDispatchCreated = jest.fn(async () => undefined);
jest.unstable_mockModule("../../app/services/inventory/notices/planNotices.js", () => ({
  notifyPlanChanged,
  notifyDispatchCreated,
}));

const { db, withTx, closeDb } = await import("../setup/db.js");
const { IDS } = await import("../fixtures/ids.js");
const fx = await import("../helpers/invPlanFixtures.js");
const { httpClient } = await import("../helpers/http.js");
const { getDeliveries, savePlan, patchDueDate } = await import("../../app/services/inventory/planService.js");
const { createDispatch } = await import("../../app/services/inventory/dispatchService.js");
const { buildPOTemplateData } = await import("../../app/helper/poTemplateDataBuilder.js");
const { loadCallOffPoContext, renderCallOffPoHtml } = await import("../../app/helper/arc_v2/callOffPoRenderer.js");
const { default: seoController } = await import("../../app/controllers/seo/seoController.js");
const { pdfRenderer } = await import("../../app/util/pdfRenderer.js");
const { qrSvg } = await import("../../app/services/inventory/qr.js");
const { shortUrl } = await import("../../app/services/inventory/shortUrl.js");
const { acceptPO } = await import("../../app/controllers/po/purchaseOrderController.js");
const { handleUpdatePO } = await import("../../app/models/purchaseOrderModel.js");

const { A1, A2, VENDOR, BUYER } = fx;
const ADMIN = IDS.users.companyA_admin; // CEO, company-wide: reads POs, holds awarding.create
const admin = { id: ADMIN, user_type: 2 };
const buyer = { id: BUYER, user_type: 2 }; // TENDER_CREATOR: rfq.read, no awarding.create

const tr = fx.newTracker();
afterEach(async () => {
  await fx.cleanupTracked(db, tr);
  notifyPlanChanged.mockClear();
  notifyDispatchCreated.mockClear();
});
afterAll(async () => {
  await closeDb();
});

const vendorDispatch = (over = {}) => ({
  challanNo: "CH-1",
  challanDate: "2030-11-08",
  expectedDeliveryDate: "2030-11-10",
  ...over,
});

function mockExpress({ user, params = {}, body = {} }) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  return { req: { user, params, body }, res };
}

describe("delivery plan", () => {
  it("default plan returned for single-hotel PO", async () => {
    await withTx(async (t) => {
      const po = await fx.makeRfqPo(t, { lines: [{ qty: 10, unit: "kg" }, { qty: 4, unit: "box" }] });
      const [l1, l2] = po.lineIds;

      const out = await getDeliveries(t, admin, po.poId);
      expect(out).toMatchObject({
        poId: po.poId,
        receiptStatus: "not_received",
        receiptLegacy: false,
        planLocked: false,
        planLockedAt: null,
        editable: "all",
        hotels: [{ id: A1, name: "Hotel A-1" }],
        grns: [],
        dispatches: [],
        rtvs: [],
        shortCloses: [],
      });
      expect(out.deliveries).toHaveLength(1);
      const [d] = out.deliveries;
      expect(d).toMatchObject({
        hotelId: A1, hotelName: "Hotel A-1", phaseNo: 1, dueDate: null, status: "open",
        overdue: false, hasReceipts: false,
      });
      expect(d.lines.map((l) => [l.poLineId, l.unit, l.plannedQty, l.acceptedQty, l.openQty, l.status])).toEqual([
        [l1, "kg", 10, 0, 10, "open"],
        [l2, "box", 4, 0, 4, "open"],
      ]);
      expect(out.poLines.map((l) => [l.id, l.orderedQty, l.openQty, l.receiptStatus])).toEqual([
        [l1, 10, 10, "open"],
        [l2, 4, 4, "open"],
      ]);
      expect(out.can).toMatchObject({ editPlan: true, shortClose: true, manageSiteRep: true });

      // Reading again does not make a second plan.
      await getDeliveries(t, admin, po.poId);
      expect(await fx.planRows(t, po.poId)).toHaveLength(1);

      // A phase whose date has passed is overdue while it is open ...
      await t.none(
        `UPDATE tbl_po_delivery SET due_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date - 2 WHERE po_id = $1`,
        [po.poId]
      );
      expect((await getDeliveries(t, admin, po.poId)).deliveries[0].overdue).toBe(true);
      // ... and never once the PO is closed short or fully received.
      await t.none(`UPDATE tbl_rfq_purchase_order SET receipt_status = 'closed_short' WHERE id = $1`, [po.poId]);
      expect((await getDeliveries(t, admin, po.poId)).deliveries[0].overdue).toBe(false);
    });
  });

  it("can flags follow the caller's own grants", async () => {
    await withTx(async (t) => {
      const po = await fx.makeRfqPo(t);
      // A role with grn.approve only, at the PO's hotel, on top of the buyer's read role.
      const role = await t.one(
        `INSERT INTO tbl_roles (title, description, created_by) VALUES ('B2 reverser', 'test', $1) RETURNING id`,
        [ADMIN]
      );
      await t.none(
        `INSERT INTO tbl_role_permissions (role_id, permission_id)
         SELECT $1, id FROM tbl_permissions WHERE resource::text = 'grn' AND action::text = 'approve'`,
        [role.id]
      );
      await t.none(
        `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id) VALUES ($1, $2, $3, $4)`,
        [BUYER, role.id, fx.CO, A1]
      );
      const out = await getDeliveries(t, buyer, po.poId);
      expect(out.can).toEqual({ editPlan: false, shortClose: false, receive: false, reverse: true, manageSiteRep: false });
    });
  });

  it("buyer splits multi-hotel PO into hotel×phase rows", async () => {
    await withTx(async (t) => {
      const po = await fx.makeRfqPo(t, { mappedHotels: [A1, A2], lines: [{ qty: 10 }, { qty: 6 }] });
      const [l1, l2] = po.lineIds;

      let out = await getDeliveries(t, admin, po.poId);
      expect(out.hotels.map((h) => h.id)).toEqual([A1, A2]);
      expect(out.deliveries).toHaveLength(1);
      expect(out.deliveries[0]).toMatchObject({ hotelId: null, hotelName: null, phaseNo: 1 });

      await savePlan(t, admin, po.poId, [
        { hotelId: A1, phaseNo: 1, dueDate: "2030-11-10", remarks: "Kitchen first",
          lines: [{ poLineId: l1, plannedQty: 4 }, { poLineId: l2, plannedQty: 3 }] },
        { hotelId: A1, phaseNo: 2, dueDate: "2030-11-20", remarks: null, lines: [{ poLineId: l1, plannedQty: 2 }] },
        { hotelId: A2, phaseNo: 1, dueDate: null, remarks: "",
          lines: [{ poLineId: l1, plannedQty: "4" }, { poLineId: l2, plannedQty: 3 }] },
      ]);

      out = await getDeliveries(t, admin, po.poId);
      expect(out.deliveries.map((d) => [d.hotelId, d.phaseNo, d.dueDate, d.remarks,
        d.lines.map((l) => [l.poLineId, l.plannedQty])])).toEqual([
        [A1, 1, "2030-11-10", "Kitchen first", [[l1, 4], [l2, 3]]],
        [A1, 2, "2030-11-20", null, [[l1, 2]]],
        [A2, 1, null, null, [[l1, 4], [l2, 3]]],
      ]);
      // The unallocated row is gone: the plan was replaced as a whole.
      expect((await fx.planRows(t, po.poId)).map((r) => r.hotel_id)).toEqual([A1, A1, A2]);

      // Part of the PO can stay unallocated (hotel decided later).
      await savePlan(t, admin, po.poId, [
        { hotelId: A1, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 5 }] },
        { hotelId: null, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 5 }, { poLineId: l2, plannedQty: 6 }] },
      ]);
      out = await getDeliveries(t, admin, po.poId);
      expect(out.deliveries.map((d) => [d.hotelId, d.lines.map((l) => l.plannedQty)])).toEqual([
        [A1, [5]],
        [null, [5, 6]],
      ]);
    });
  });

  it("plan sums must equal ordered qty", async () => {
    await withTx(async (t) => {
      const po = await fx.makeRfqPo(t, { mappedHotels: [A1, A2], lines: [{ qty: 10 }, { qty: 6 }] });
      const [l1, l2] = po.lineIds;
      await getDeliveries(t, admin, po.poId);

      const short = savePlan(t, admin, po.poId, [
        { hotelId: A1, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 9 }, { poLineId: l2, plannedQty: 6 }] },
      ]);
      await expect(short).rejects.toMatchObject({
        code: "VALIDATION",
        details: { poLineId: l1, plannedQty: 9, orderedQty: 10 },
      });
      await expect(short).rejects.toThrow(/9.*10/);

      // A line left out entirely is planned at 0.
      await expect(savePlan(t, admin, po.poId, [
        { hotelId: A1, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 10 }] },
      ])).rejects.toMatchObject({ code: "VALIDATION", details: { poLineId: l2, plannedQty: 0, orderedQty: 6 } });

      // Nothing was written.
      const rows = await fx.planRows(t, po.poId);
      expect(rows.map((r) => r.hotel_id)).toEqual([null]);
    });
  });

  it("plan validation refuses repeated phases, empty deliveries, early dates and foreign lines", async () => {
    await withTx(async (t) => {
      const po = await fx.makeRfqPo(t, { mappedHotels: [A1, A2], lines: [{ qty: 10 }] });
      const other = await fx.makeRfqPo(t, { lines: [{ qty: 10 }] });
      const [l1] = po.lineIds;
      await getDeliveries(t, admin, po.poId);

      const attempts = [
        // phase 1 twice at A1
        [{ hotelId: A1, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 5 }] },
         { hotelId: A1, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 5 }] }],
        // an empty delivery
        [{ hotelId: A1, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 10 }] },
         { hotelId: A2, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 0 }] }],
        // due before the PO was raised
        [{ hotelId: A1, phaseNo: 1, dueDate: "2020-01-01", lines: [{ poLineId: l1, plannedQty: 10 }] }],
        // not a date
        [{ hotelId: A1, phaseNo: 1, dueDate: "2030-02-30", lines: [{ poLineId: l1, plannedQty: 10 }] }],
        // another PO's line
        [{ hotelId: A1, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 10 }, { poLineId: other.lineIds[0], plannedQty: 1 }] }],
        // a negative quantity
        [{ hotelId: A1, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 12 }] },
         { hotelId: A2, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: -2 }] }],
        // no phase number
        [{ hotelId: A1, lines: [{ poLineId: l1, plannedQty: 10 }] }],
        // no deliveries at all
        [],
      ];
      for (const deliveries of attempts) {
        await expect(savePlan(t, admin, po.poId, deliveries)).rejects.toMatchObject({ code: "VALIDATION" });
      }
      expect((await fx.planRows(t, po.poId)).map((r) => r.hotel_id)).toEqual([null]);
    });
  });

  it("hotel outside PO hotel set is rejected", async () => {
    await withTx(async (t) => {
      const po = await fx.makeRfqPo(t, { mappedHotels: [A1, A2], lines: [{ qty: 10 }] });
      const [l1] = po.lineIds;
      await getDeliveries(t, admin, po.poId);
      for (const hotelId of [IDS.hotels.A3, IDS.hotels.B1, 999999]) {
        await expect(savePlan(t, admin, po.poId, [
          { hotelId: A1, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 5 }] },
          { hotelId, phaseNo: 1, lines: [{ poLineId: l1, plannedQty: 5 }] },
        ])).rejects.toMatchObject({ code: "VALIDATION", details: { hotelId } });
      }
    });
  });

  it("plan locks after first dispatch; quantities rejected with LOCKED; due date of untouched phase can move", async () => {
    await withTx(async (t) => {
      const po = await fx.makeRfqPo(t, { status: "approved", mappedHotels: [A1, A2], lines: [{ qty: 10 }] });
      const [l1] = po.lineIds;
      await getDeliveries(t, admin, po.poId);
      const plan = [
        { hotelId: A1, phaseNo: 1, dueDate: "2030-11-10", lines: [{ poLineId: l1, plannedQty: 6 }] },
        { hotelId: A2, phaseNo: 1, dueDate: "2030-11-12", lines: [{ poLineId: l1, plannedQty: 4 }] },
      ];
      await savePlan(t, admin, po.poId, plan);
      let out = await getDeliveries(t, admin, po.poId);
      const dA1 = out.deliveries.find((d) => d.hotelId === A1);
      const dA2 = out.deliveries.find((d) => d.hotelId === A2);

      await createDispatch(t, { id: VENDOR, user_type: 3 }, po.poId,
        vendorDispatch({ deliveryId: dA1.id, lines: [{ poLineId: l1, qty: 6 }] }));

      out = await getDeliveries(t, admin, po.poId);
      expect(out.planLocked).toBe(true);
      expect(out.planLockedAt).toEqual(expect.any(String));
      expect(out.editable).toBe("dates_only");

      // Quantities and hotels are frozen ...
      await expect(savePlan(t, admin, po.poId, [
        { ...plan[0], lines: [{ poLineId: l1, plannedQty: 5 }] },
        { ...plan[1], lines: [{ poLineId: l1, plannedQty: 5 }] },
      ])).rejects.toMatchObject({ code: "LOCKED" });

      // ... but a phase with nothing received can still move.
      out = await patchDueDate(t, admin, po.poId, dA2.id, "2030-11-30");
      expect(out.deliveries.find((d) => d.id === dA2.id).dueDate).toBe("2030-11-30");

      // A phase that has received goods cannot.
      await fx.postedGrn(t, { poId: po.poId, hotelId: A1, lines: [{ poLineId: l1, deliveryLineId: dA1.lines[0].id, accepted: 6 }] });
      await expect(patchDueDate(t, admin, po.poId, dA1.id, "2030-12-01")).rejects.toMatchObject({ code: "LOCKED" });
      out = await getDeliveries(t, admin, po.poId);
      expect(out.deliveries.find((d) => d.id === dA1.id)).toMatchObject({ dueDate: "2030-11-10", hasReceipts: true });

      // A delivery of another PO is not found here, and dates still respect the PO date.
      const other = await fx.makeRfqPo(t, { lines: [{ qty: 1 }] });
      const otherPlan = await getDeliveries(t, admin, other.poId);
      await expect(patchDueDate(t, admin, po.poId, otherPlan.deliveries[0].id, "2030-12-01"))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(patchDueDate(t, admin, po.poId, dA2.id, "2019-12-01")).rejects.toMatchObject({ code: "VALIDATION" });
    });
  });

  it("user without awarding.create cannot edit plan (403)", async () => {
    const po = await db.tx((t) => fx.makeRfqPo(t, { status: "approved", tracker: tr, lines: [{ qty: 10 }] }));
    const c = await httpClient(BUYER);

    const read = await c.get(`/api/v1/inventory/po/${po.poId}/deliveries`);
    expect(read.status).toBe(200);
    expect(read.body.status).toBe(1);
    expect(read.body.data.can.editPlan).toBe(false);
    const delivery = read.body.data.deliveries[0];

    const put = await c.put(`/api/v1/inventory/po/${po.poId}/deliveries`).send({
      deliveries: [{ hotelId: A1, phaseNo: 1, dueDate: "2030-11-10", lines: [{ poLineId: po.lineIds[0], plannedQty: 10 }] }],
    });
    expect(put.status).toBe(403);
    expect(put.body).toMatchObject({ status: 0, code: "PO_WRITE_PERMISSION_REQUIRED" });

    const patch = await c.patch(`/api/v1/inventory/po/${po.poId}/deliveries/${delivery.id}`).send({ dueDate: "2030-11-10" });
    expect(patch.status).toBe(403);
    expect((await fx.planRows(db, po.poId)).map((r) => r.due_date)).toEqual([null]);

    // Another company's PO does not exist as far as this caller can tell.
    const outsider = await httpClient(IDS.users.companyB_admin);
    const foreign = await outsider.get(`/api/v1/inventory/po/${po.poId}/deliveries`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.status).toBe(2);
  });

  it("plan change after acceptance notifies vendor", async () => {
    const accepted = await db.tx((t) => fx.makeRfqPo(t, { status: "approved", tracker: tr, lines: [{ qty: 10 }] }));
    const pending = await db.tx((t) => fx.makeRfqPo(t, { status: "pending_approval", tracker: tr, lines: [{ qty: 10 }] }));
    const c = await httpClient(ADMIN);

    const split = (po) => ({
      deliveries: [
        { hotelId: A1, phaseNo: 1, dueDate: "2030-11-10", remarks: "Week 1", lines: [{ poLineId: po.lineIds[0], plannedQty: 6 }] },
        { hotelId: A1, phaseNo: 2, dueDate: "2030-11-17", remarks: "Week 2", lines: [{ poLineId: po.lineIds[0], plannedQty: 4 }] },
      ],
    });

    const res = await c.put(`/api/v1/inventory/po/${accepted.poId}/deliveries`).send(split(accepted));
    expect(res.status).toBe(200);
    expect(res.body.data.deliveries.map((d) => d.phaseNo)).toEqual([1, 2]);
    expect(notifyPlanChanged).toHaveBeenCalledTimes(1);
    expect(notifyPlanChanged.mock.calls[0][1]).toMatchObject({ poId: accepted.poId, actorUserId: ADMIN });
    // The PDF the vendor holds is rewritten to print the new plan.
    const doc = await db.one(`SELECT po_pdf_url FROM tbl_rfq_purchase_order WHERE id = $1`, [accepted.poId]);
    expect(doc.po_pdf_url).toMatch(/^https:\/\//);

    // Moving a date on an accepted PO is a plan change too.
    notifyPlanChanged.mockClear();
    const phase2 = res.body.data.deliveries[1];
    const moved = await c.patch(`/api/v1/inventory/po/${accepted.poId}/deliveries/${phase2.id}`).send({ dueDate: "2030-11-24" });
    expect(moved.status).toBe(200);
    expect(moved.body.data.deliveries[1].dueDate).toBe("2030-11-24");
    expect(notifyPlanChanged).toHaveBeenCalledTimes(1);

    // Before the vendor has the PO, nobody is told.
    notifyPlanChanged.mockClear();
    const quiet = await c.put(`/api/v1/inventory/po/${pending.poId}/deliveries`).send(split(pending));
    expect(quiet.status).toBe(200);
    expect(notifyPlanChanged).not.toHaveBeenCalled();
  });

  it("PO PDF data includes delivery plan rows and QR svg", async () => {
    await withTx(async (t) => {
      const po = await fx.makeRfqPo(t, { mappedHotels: [A1, A2], lines: [{ qty: 10, unit: "kg" }] });
      const [l1] = po.lineIds;
      await getDeliveries(t, admin, po.poId);
      await savePlan(t, admin, po.poId, [
        { hotelId: A1, phaseNo: 1, dueDate: "2030-11-10", remarks: "Back gate", lines: [{ poLineId: l1, plannedQty: 6 }] },
        { hotelId: A2, phaseNo: 1, dueDate: null, lines: [{ poLineId: l1, plannedQty: 4 }] },
      ]);

      const data = await buildPOTemplateData(po.poId, t);
      expect(data.deliveryPlan).toEqual([
        expect.objectContaining({
          hotelName: "Hotel A-1", phaseNo: 1, dueDate: "2030-11-10", dueDateDisplay: "10 Nov 2030",
          remarks: "Back gate", lines: [{ productName: expect.any(String), unit: "kg", plannedQty: "6" }],
        }),
        expect.objectContaining({
          hotelName: "Hotel A-2", phaseNo: 1, dueDate: null, dueDateDisplay: "To be scheduled",
          lines: [{ productName: expect.any(String), unit: "kg", plannedQty: "4" }],
        }),
      ]);
      expect(data.poQrSvg).toBe(qrSvg(shortUrl("p", po.poId)));
      expect(data.poQrSvg).toMatch(/^<svg/);

      // The template prints both (Handlebars runs for real; Chromium is stubbed).
      let html = null;
      const real = pdfRenderer.renderToFile;
      pdfRenderer.renderToFile = async (h, p) => { html = h; return real(h, p); };
      try {
        await seoController.poPDF({ po_id: po.poId, company_id: IDS.companies.A }, t);
      } finally {
        pdfRenderer.renderToFile = real;
      }
      expect(html).toContain("DELIVERY PLAN");
      expect(html).toContain("Hotel A-2");
      expect(html).toContain("10 Nov 2030");
      expect(html).toContain("Back gate");
      expect(html).toContain(data.poQrSvg);

      // Call-off POs: same plan, same QR, on the call-off document.
      const co = await fx.makeCallOffPo(t, { lines: [{ qty: 6 }] });
      await getDeliveries(t, admin, co.poId);
      const ctx = await loadCallOffPoContext(co.poId, t);
      expect(ctx.delivery_plan).toEqual([
        expect.objectContaining({ hotelName: "Hotel A-2", phaseNo: 1, dueDate: "2030-11-15",
          lines: [expect.objectContaining({ plannedQty: "6", unit: "litre" })] }),
      ]);
      expect(ctx.qr_svg).toBe(qrSvg(shortUrl("p", co.poId)));
      const coHtml = renderCallOffPoHtml(ctx);
      expect(coHtml).toContain("Delivery plan");
      expect(coHtml).toContain("15 Nov 2030");
      expect(coHtml).toContain(ctx.qr_svg);
    });
  });

  it("accepting a PO fills due dates on its untouched default plan", async () => {
    const untouched = await db.tx((t) => fx.makeRfqPo(t, {
      status: "acceptance_pending", tracker: tr, lines: [{ qty: 5, deliveryPeriod: "7" }],
    }));
    const edited = await db.tx((t) => fx.makeRfqPo(t, {
      status: "acceptance_pending", tracker: tr, lines: [{ qty: 5, deliveryPeriod: "7" }],
    }));
    await db.tx((t) => getDeliveries(t, admin, untouched.poId));
    await db.tx(async (t) => {
      await getDeliveries(t, admin, edited.poId);
      await savePlan(t, admin, edited.poId, [
        { hotelId: A1, phaseNo: 1, lines: [{ poLineId: edited.lineIds[0], plannedQty: 3 }] },
        { hotelId: A1, phaseNo: 2, lines: [{ poLineId: edited.lineIds[0], plannedQty: 2 }] },
      ]);
    });
    // Before acceptance the default plan has no date: delivery is counted from acceptance.
    expect((await fx.planRows(db, untouched.poId)).map((r) => r.due_date)).toEqual([null]);

    for (const po of [untouched, edited]) {
      const { req, res } = mockExpress({ user: { id: VENDOR, user_type: 3 }, params: { po_id: String(po.poId) } });
      await acceptPO(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe(1);
    }

    const { d } = await db.one(`SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date + 7)::text AS d`);
    expect((await fx.planRows(db, untouched.poId)).map((r) => r.due_date)).toEqual([d]);
    // A plan the buyer shaped is left as the buyer left it.
    expect((await fx.planRows(db, edited.poId)).map((r) => r.due_date)).toEqual([null, null]);
  });

  it("editing a pending PO's quantities drops its draft plan", async () => {
    const po = await db.tx((t) => fx.makeRfqPo(t, {
      status: "draft", tracker: tr, initiatedBy: BUYER, lines: [{ qty: 5 }, { qty: 3 }],
    }));
    await db.tx((t) => getDeliveries(t, admin, po.poId));
    expect(await fx.planRows(db, po.poId)).toHaveLength(1);

    // An edit that leaves lines and quantities alone keeps the plan.
    await handleUpdatePO(po.poId, [{ path: "terms_and_conditions", newValue: "Deliver to the back gate" }], { id: BUYER });
    expect(await fx.planRows(db, po.poId)).toHaveLength(1);

    // A quantity edit drops it in the same transaction ...
    await handleUpdatePO(po.poId, [{ path: `product[${po.rfqProductIds[0]}].quantity`, newValue: 8 }], { id: BUYER });
    expect(await fx.planRows(db, po.poId)).toHaveLength(0);

    // ... and the next read plans the new quantity.
    const out = await db.tx((t) => getDeliveries(t, admin, po.poId));
    expect(out.deliveries[0].lines.map((l) => l.plannedQty)).toEqual([8, 3]);

    // Removing a line drops the plan too.
    await handleUpdatePO(po.poId, [{ path: `product[${po.rfqProductIds[1]}].removed`, newValue: true }], { id: BUYER });
    expect(await fx.planRows(db, po.poId)).toHaveLength(0);
  });
});
