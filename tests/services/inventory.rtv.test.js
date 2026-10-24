// Return to vendor (Task B5, spec §6.13).
//
// An RTV is built from posted RECEIPT GRN lines, up to what is still accepted
// and not already returned or reversed. Dispatch posts RTV_OUT at the GRN
// line's unit cost (refused with NEGATIVE_STOCK when the goods are gone).
//   REPLACE: the roll-up reopens the qty; the RTV closes once the reopened
//            qty is received again or short-closed.
//   CREDIT:  short-close rows (reason other, "RTV <number> credit") land on
//            the same delivery lines the roll-up spreads the credit over, so
//            the qty does not come back as open; close records the credit note.
//
// Everything runs inside withTx (always rolled back).

import { describe, it, expect, afterAll, beforeAll, afterEach } from "@jest/globals";
import { db, withTx, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import {
  createRtv, dispatchRtv, closeRtv, cancelRtv, getRtv,
} from "../../app/services/inventory/rtvService.js";
import { shortClose } from "../../app/services/inventory/shortCloseService.js";
import { loadRtvDocument, buildRtvHtml } from "../../app/services/inventory/grnPdf.js";
import { shortUrl } from "../../app/services/inventory/shortUrl.js";
import { InventoryError } from "../../app/services/inventory/errors.js";
import {
  CO, A1, makeRfqPo, setPlan, postReceiptGrn, deliveryLinesOf, markOut, balanceOf,
} from "../helpers/invReceiptFixtures.js";

const STORES = { id: IDS.users.a1_proc_buyer, user_type: 2 };
const OWNER = { id: IDS.users.companyA_admin, user_type: 2 };
const OTHER_COMPANY = { id: IDS.users.companyB_admin, user_type: 2 };

afterAll(async () => {
  await closeDb();
});

/** Give STORES the Inventory Controller role (every grn + inventory key) at A1. */
async function grantStores(t, userId = STORES.id) {
  const role = await t.one(`SELECT id FROM tbl_roles WHERE title = 'Inventory Controller' AND created_by IS NULL`);
  await grantRoleScope(t, { userId, roleId: role.id, companyId: CO, hotelId: A1 });
}

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

const rtvMovements = (t, rtvId) =>
  t.any(
    `SELECT movement_type, qty::float AS qty, unit_cost::float AS unit_cost, source_line_id
       FROM tbl_inv_movement WHERE source_type = 'RTV' AND source_id = $1 ORDER BY id`,
    [rtvId]
  );

const poState = async (t, poId) => {
  const po = await t.one(`SELECT receipt_status FROM tbl_rfq_purchase_order WHERE id = $1`, [poId]);
  const lines = await t.any(
    `SELECT accepted_qty::float AS accepted, returned_replace_qty::float AS rr, returned_credit_qty::float AS rc,
            short_closed_qty::float AS sc, receipt_status
       FROM tbl_purchase_order_product WHERE purchase_order_id = $1 ORDER BY id`,
    [poId]
  );
  return { receiptStatus: po.receipt_status, lines };
};

describe("return to vendor", () => {
  it("REPLACE reopens qty and posts RTV_OUT", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, lineIds: [line] } = await makeRfqPo(t, { lines: [{ qty: 10, unit: "kg" }] });
      const grn = await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 10, unitCost: 52.5 }] });
      const [gl] = grn.lines;
      expect(await balanceOf(t, A1, gl.invItemId)).toBe(10);

      const draft = await createRtv(t, STORES, {
        grnId: grn.grnId, disposition: "REPLACE", remarks: "Wrong grade",
        lines: [{ grnLineId: gl.grnLineId, qty: 3, reason: "Grade B delivered" }],
      });
      expect(draft).toMatchObject({
        poId, grnId: grn.grnId, hotelId: A1, disposition: "REPLACE", status: "draft", rtvNumber: null,
        remarks: "Wrong grade", lines: [{ grnLineId: gl.grnLineId, qty: 3, reason: "Grade B delivered" }],
      });
      // A draft moves no stock and reopens nothing.
      expect(await rtvMovements(t, draft.id)).toEqual([]);
      expect((await poState(t, poId)).receiptStatus).toBe("received");

      const sent = await dispatchRtv(t, STORES, draft.id, { challanNo: "GP-778" });
      expect(sent).toMatchObject({ status: "dispatched", challanNo: "GP-778", rtvNumber: expect.stringMatching(new RegExp(`^RTV/${A1}/\\d{4}-\\d{2}/\\d{5}$`)) });
      expect(await rtvMovements(t, draft.id)).toEqual([
        { movement_type: "RTV_OUT", qty: -3, unit_cost: 52.5, source_line_id: expect.any(String) },
      ]);
      expect(await balanceOf(t, A1, gl.invItemId)).toBe(7);
      expect(await poState(t, poId)).toEqual({
        receiptStatus: "partial",
        lines: [{ accepted: 10, rr: 3, rc: 0, sc: 0, receipt_status: "partial" }],
      });

      // Not replaced yet: the RTV stays open.
      await expectInvError(closeRtv(t, STORES, draft.id, {}), "CONFLICT");
      await expectInvError(dispatchRtv(t, STORES, draft.id, {}), "CONFLICT", { status: "dispatched" });

      // The replacement arrives; now it closes.
      await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 3 }] });
      expect((await poState(t, poId)).receiptStatus).toBe("received");
      const closed = await closeRtv(t, STORES, draft.id, {});
      expect(closed).toMatchObject({ status: "closed", creditNoteRef: null });
    });
  });

  it("a REPLACE return also closes when the reopened qty is short-closed instead", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, lineIds: [line] } = await makeRfqPo(t);
      const grn = await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 10 }] });
      const rtv = await createRtv(t, STORES, {
        grnId: grn.grnId, disposition: "REPLACE", lines: [{ grnLineId: grn.lines[0].grnLineId, qty: 2, reason: "Torn" }],
      });
      await dispatchRtv(t, STORES, rtv.id, {});
      await shortClose(t, OWNER, poId, { target: { type: "po" }, reasonCode: "vendor_cannot_supply" });
      expect((await closeRtv(t, STORES, rtv.id, {})).status).toBe("closed");
    });
  });

  it("CREDIT closes qty", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, lineIds: [line] } = await makeRfqPo(t, { lines: [{ qty: 10, unit: "kg" }] });
      const [p1, p2] = await setPlan(t, poId, [
        { hotelId: A1, phaseNo: 1, dueDate: "2026-10-20", lines: { [line]: 5 } },
        { hotelId: A1, phaseNo: 2, dueDate: "2026-11-20", lines: { [line]: 5 } },
      ]);
      // One receipt line covering both phases (B1 splits a line over phases).
      const grn = await postReceiptGrn(t, {
        poId,
        lines: [{
          poLineId: line, accepted: 10,
          allocations: [{ deliveryLineId: p1.lines[line], accepted: 5 }, { deliveryLineId: p2.lines[line], accepted: 5 }],
        }],
      });
      const gl = grn.lines[0];
      expect((await poState(t, poId)).receiptStatus).toBe("received");

      const rtv = await createRtv(t, STORES, {
        grnId: grn.grnId, disposition: "CREDIT", lines: [{ grnLineId: gl.grnLineId, qty: 3, reason: "Spoilt" }],
      });
      const sent = await dispatchRtv(t, STORES, rtv.id, {});
      expect(await balanceOf(t, A1, gl.invItemId)).toBe(7);

      // The credit is spread latest-allocation-first (phase 2), and the
      // short-close rows land on that same delivery line.
      const log = await t.any(
        `SELECT delivery_line_id, qty::float AS qty, reason_code, remarks, action, rtv_id
           FROM tbl_po_short_close WHERE po_id = $1 ORDER BY id`,
        [poId]
      );
      expect(log).toEqual([
        {
          delivery_line_id: p2.lines[line], qty: 3, reason_code: "other", remarks: `RTV ${sent.rtvNumber} credit`,
          action: "close", rtv_id: rtv.id,
        },
      ]);
      const dls = await deliveryLinesOf(t, poId);
      expect(dls.map((d) => [d.id, d.returned_credit, d.short_closed, d.status])).toEqual([
        [p1.lines[line], 0, 0, "received"],
        [p2.lines[line], 3, 3, "short_closed"],
      ]);
      // Nothing comes back as open.
      expect(await poState(t, poId)).toEqual({
        receiptStatus: "closed_short",
        lines: [{ accepted: 10, rr: 0, rc: 3, sc: 3, receipt_status: "short_closed" }],
      });

      await expectInvError(closeRtv(t, STORES, rtv.id, {}), "VALIDATION", { field: "creditNoteRef" });
      const closed = await closeRtv(t, STORES, rtv.id, { creditNoteRef: "  CN-2026-118 " });
      expect(closed).toMatchObject({ status: "closed", creditNoteRef: "CN-2026-118" });
    });
  });

  it("RTV qty above returnable rejected", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, lineIds: [line] } = await makeRfqPo(t);
      const grn = await postReceiptGrn(t, {
        poId, lines: [{ poLineId: line, accepted: 5, rejected: 2, rejectionReason: "damaged" }],
      });
      const gl = grn.lines[0];
      const lines = (qty) => [{ grnLineId: gl.grnLineId, qty, reason: "Bad" }];

      await expectInvError(
        createRtv(t, STORES, { grnId: grn.grnId, disposition: "REPLACE", lines: lines(6) }),
        "VALIDATION",
        { grnLineId: gl.grnLineId, returnable: 5 }
      );
      await createRtv(t, STORES, { grnId: grn.grnId, disposition: "REPLACE", lines: lines(3) });
      // A draft already holds 3 of the 5.
      await expectInvError(
        createRtv(t, STORES, { grnId: grn.grnId, disposition: "CREDIT", lines: lines(3) }),
        "VALIDATION",
        { returnable: 2 }
      );

      // A reversal of 1 takes it down again.
      const rev = await t.one(
        `INSERT INTO tbl_grn (grn_number, hospitality_company_id, hotel_id, po_id, doc_type, reverses_grn_id, status,
                              received_at, posted_at)
         VALUES ('GRN/R/1', $1, $2, $3, 'REVERSAL', $4, 'posted', '2026-10-24', now()) RETURNING id`,
        [CO, A1, poId, grn.grnId]
      );
      await t.none(
        `INSERT INTO tbl_grn_line (hospitality_company_id, grn_id, po_line_id, reverses_grn_line_id, po_uom,
                                   received_qty, accepted_qty, rejected_qty)
         VALUES ($1, $2, $3, $4, 'kg', 1, 1, 0)`,
        [CO, rev.id, line, gl.grnLineId]
      );
      await expectInvError(
        createRtv(t, STORES, { grnId: grn.grnId, disposition: "CREDIT", lines: lines(2) }),
        "VALIDATION",
        { returnable: 1 }
      );

      // Shape and target checks.
      await expectInvError(
        createRtv(t, STORES, { grnId: grn.grnId, disposition: "SWAP", lines: lines(1) }), "VALIDATION", { field: "disposition" }
      );
      await expectInvError(
        createRtv(t, STORES, { grnId: grn.grnId, disposition: "CREDIT", lines: [] }), "VALIDATION", { field: "lines" }
      );
      await expectInvError(
        createRtv(t, STORES, { grnId: grn.grnId, disposition: "CREDIT", lines: [{ grnLineId: gl.grnLineId, qty: 1, reason: " " }] }),
        "VALIDATION"
      );
      await expectInvError(
        createRtv(t, STORES, { grnId: rev.id, disposition: "CREDIT", lines: lines(1) }), "CONFLICT"
      );
      const other = await makeRfqPo(t);
      const otherGrn = await postReceiptGrn(t, { poId: other.poId, lines: [{ poLineId: other.lineIds[0], accepted: 4 }] });
      await expectInvError(
        createRtv(t, STORES, {
          grnId: grn.grnId, disposition: "CREDIT", lines: [{ grnLineId: otherGrn.lines[0].grnLineId, qty: 1, reason: "x" }],
        }),
        "NOT_FOUND"
      );
    });
  });

  it("RTV blocked when stock already marked out", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, lineIds: [line] } = await makeRfqPo(t);
      const grn = await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 10 }] });
      const gl = grn.lines[0];
      await markOut(t, { invItemId: gl.invItemId, qty: 8 });

      const rtv = await createRtv(t, STORES, {
        grnId: grn.grnId, disposition: "REPLACE", lines: [{ grnLineId: gl.grnLineId, qty: 5, reason: "Leaking" }],
      });
      await expectInvError(
        t.tx((sp) => dispatchRtv(sp, STORES, rtv.id, {})),
        "NEGATIVE_STOCK",
        { invItemId: gl.invItemId, available: 2, requested: 5 }
      );
      // Nothing moved: still a draft, no number, no ledger rows, nothing reopened.
      expect(await getRtv(t, STORES, rtv.id)).toMatchObject({ status: "draft", rtvNumber: null });
      expect(await rtvMovements(t, rtv.id)).toEqual([]);
      expect(await balanceOf(t, A1, gl.invItemId)).toBe(2);
      expect((await poState(t, poId)).receiptStatus).toBe("received");

      // A draft can still be cancelled; a cancelled one cannot be dispatched.
      expect((await cancelRtv(t, STORES, rtv.id)).status).toBe("cancelled");
      await expectInvError(dispatchRtv(t, STORES, rtv.id, {}), "CONFLICT");
      await expectInvError(cancelRtv(t, STORES, rtv.id), "CONFLICT");
    });
  });

  it("needs grn.approve at the GRN's hotel; another company's RTV is not found", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, lineIds: [line] } = await makeRfqPo(t);
      const grn = await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 10 }] });
      const input = { grnId: grn.grnId, disposition: "CREDIT", lines: [{ grnLineId: grn.lines[0].grnLineId, qty: 1, reason: "x" }] };

      // Mapped to company A but no grn grant at A1.
      await expectInvError(createRtv(t, { id: IDS.users.a1_proc_techEval, user_type: 2 }, input), "FORBIDDEN");
      await expectInvError(createRtv(t, OTHER_COMPANY, input), "NOT_FOUND");
      const rtv = await createRtv(t, STORES, input);
      await expectInvError(getRtv(t, OTHER_COMPANY, rtv.id), "NOT_FOUND");
      await expectInvError(getRtv(t, STORES, 999999999), "NOT_FOUND");
    });
  });

  it("RTV challan HTML carries both parties, the lines, values and a QR", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, poNumber, lineIds: [line] } = await makeRfqPo(t, { lines: [{ qty: 10, unit: "kg", unitPrice: 120 }] });
      const grn = await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 10 }] });
      const rtv = await createRtv(t, STORES, {
        grnId: grn.grnId, disposition: "CREDIT", remarks: "Return <urgent>",
        lines: [{ grnLineId: grn.lines[0].grnLineId, qty: 4, reason: "Mould on <b>top</b> layer" }],
      });
      const sent = await dispatchRtv(t, STORES, rtv.id, { challanNo: "GP-9" });
      const ctx = await loadRtvDocument(t, rtv.id);
      const html = buildRtvHtml(ctx);
      expect(html).toContain("Delivery challan");
      expect(html).toContain(sent.rtvNumber);
      expect(html).toContain(grn.grnNumber);
      expect(html).toContain(poNumber);
      expect(html).toContain("GP-9");
      expect(html).toContain("7 UP PEPSI 1.5 LTR");
      expect(html).toContain("Mould on &lt;b&gt;top&lt;/b&gt; layer");
      expect(html).toContain("Return &lt;urgent&gt;");
      expect(html).toContain("Against credit note");
      expect(html).toContain("480.00"); // 4 × ₹120 taxable value
      expect(html).toContain("<svg");
      expect(html).toContain(shortUrl("g", grn.grnId));
      expect(html).not.toMatch(/<script/i);
    });
  });
});

// The controllers over HTTP: committed rows, cleaned up after each test. The
// GRN is inserted as a posted receipt directly (no ledger movements), so
// nothing here touches the append-only ledger; dispatch (which posts RTV_OUT)
// is covered by the service tests above.
describe("RTV and GRN document over HTTP", () => {
  const made = { poIds: [], rfqIds: [] };
  const prevTypes = [];
  const scopeIds = [];
  const httpUsers = [STORES.id, OTHER_COMPANY.id];

  beforeAll(async () => {
    prevTypes.push(...(await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [httpUsers])));
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [httpUsers]);
    const role = await db.one(`SELECT id FROM tbl_roles WHERE title = 'Inventory Controller' AND created_by IS NULL`);
    scopeIds.push(await grantRoleScope(db, { userId: STORES.id, roleId: role.id, companyId: CO, hotelId: A1 }));
  });

  afterEach(async () => {
    const { poIds, rfqIds } = made;
    if (poIds.length) {
      const rtvIds = (await db.any(`SELECT id FROM tbl_rtv WHERE po_id = ANY($1::int[])`, [poIds])).map((r) => Number(r.id));
      if (rtvIds.length) {
        await db.none(
          `DELETE FROM tbl_activity_events WHERE entity_type = 'RTV' AND entity_id = ANY($1::bigint[])`, [rtvIds]
        );
      }
      await db.none(`DELETE FROM tbl_rtv WHERE po_id = ANY($1::int[])`, [poIds]);
      await db.none(`DELETE FROM tbl_grn WHERE po_id = ANY($1::int[])`, [poIds]);
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
    made.poIds = [];
    made.rfqIds = [];
  });

  afterAll(async () => {
    await revokeRoleScopes(db, scopeIds);
    for (const r of prevTypes) {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [r.id, r.user_type]);
    }
  });

  /** A committed PO at A1 with one GRN (posted unless said otherwise) accepting 10 kg. */
  async function committedGrn({ status = "posted" } = {}) {
    const po = await makeRfqPo(db, { lines: [{ qty: 10, unit: "kg" }] });
    made.poIds.push(po.poId);
    made.rfqIds.push(po.rfqId);
    const grn = await db.one(
      `INSERT INTO tbl_grn (grn_number, hospitality_company_id, hotel_id, po_id, status, received_at, posted_at, posted_by)
       VALUES ($1, $2, $3, $4, $5, '2026-10-24', now(), $6) RETURNING id`,
      [status === "draft" ? null : `GRN-HTTP-${po.poId}`, CO, A1, po.poId, status, STORES.id]
    );
    const line = await db.one(
      `INSERT INTO tbl_grn_line (hospitality_company_id, grn_id, po_line_id, product_variant_id, po_uom,
                                 received_qty, accepted_qty, uom_factor, stock_qty, unit_cost)
       VALUES ($1, $2, $3, 1, 'kg', 10, 10, 1, 10, 100) RETURNING id`,
      [CO, grn.id, po.lineIds[0]]
    );
    return { ...po, grnId: Number(grn.id), grnLineId: Number(line.id) };
  }

  it("GET /grn/:id/pdf renders the posted GRN; other companies get 404, drafts 409", async () => {
    const { grnId } = await committedGrn();
    const res = await (await httpClient(STORES.id)).get(`/api/v1/inventory/grn/${grnId}/pdf`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 1, data: { url: expect.stringMatching(new RegExp(`/grn/${CO}/${grnId}-GRN-HTTP-`)) } });

    const foreign = await (await httpClient(OTHER_COMPANY.id)).get(`/api/v1/inventory/grn/${grnId}/pdf`);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ status: 2 });

    const draft = await committedGrn({ status: "draft" });
    const conflict = await (await httpClient(STORES.id)).get(`/api/v1/inventory/grn/${draft.grnId}/pdf`);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ status: 0, code: "CONFLICT" });
  });

  it("creates, reads and cancels an RTV; the trail files it under the GRN's hotel", async () => {
    const { grnId, grnLineId } = await committedGrn();
    const client = await httpClient(STORES.id);
    const created = await client.post("/api/v1/inventory/rtv").send({
      grnId, disposition: "REPLACE", remarks: "Dented", lines: [{ grnLineId, qty: 2, reason: "Dented cans" }],
    });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({
      status: "draft", rtvNumber: null, grnId, hotelId: A1, pdfUrl: null,
      lines: [expect.objectContaining({ grnLineId, qty: 2, reason: "Dented cans", productName: "7 UP PEPSI 1.5 LTR" })],
    });
    const rtvId = created.body.data.id;

    const read = await client.get(`/api/v1/inventory/rtv/${rtvId}`);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({ id: rtvId, status: "draft", pdfUrl: null });
    const foreign = await (await httpClient(OTHER_COMPANY.id)).get(`/api/v1/inventory/rtv/${rtvId}`);
    expect(foreign.status).toBe(404);

    const tooMuch = await client.post("/api/v1/inventory/rtv").send({
      grnId, disposition: "CREDIT", lines: [{ grnLineId, qty: 9, reason: "x" }],
    });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body).toMatchObject({ status: 0, code: "VALIDATION", details: { returnable: 8 } });

    const cancelled = await client.post(`/api/v1/inventory/rtv/${rtvId}/cancel`).send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ id: rtvId, status: "cancelled" });
    const late = await client.post(`/api/v1/inventory/rtv/${rtvId}/dispatch`).send({});
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: "CONFLICT", details: { status: "cancelled" } });

    // The activity row is written after the response; poll briefly.
    let event = null;
    for (let i = 0; i < 50 && !event; i += 1) {
      event = await db.oneOrNone(
        `SELECT hospitality_company_id, hotel_id, entity_id FROM tbl_activity_events
          WHERE event_key = 'inventory_rtv_created' AND entity_type = 'RTV' AND entity_id = $1`,
        [rtvId]
      );
      if (!event) await new Promise((r) => setTimeout(r, 100));
    }
    expect(event).toMatchObject({ hospitality_company_id: CO, hotel_id: A1 });
  });
});
