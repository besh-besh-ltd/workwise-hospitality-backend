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
import {
  loadRtvDocument, buildRtvHtml, formatDateTimeIst, loadGrnDocument, renderGrnDocument, renderRtvDocument,
} from "../../app/services/inventory/grnPdf.js";
import { reverseGrn } from "../../app/services/inventory/grnService.js";
import { shortUrl } from "../../app/services/inventory/shortUrl.js";
import { InventoryError } from "../../app/services/inventory/errors.js";
import { resolveItemForVariant } from "../../app/services/inventory/items.js";
import { startCount, cancelCount } from "../../app/services/inventory/countService.js";
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

/**
 * A PO line of 6 kg at A1 planned as phases A/B/C of 2 each, and one receipt
 * line accepting all 6 spread 2/2/2. Returns are spread latest allocation (C)
 * first. ret(disposition) drafts a return of 2 against that receipt line.
 */
async function threePhaseReceipt(t) {
  const { poId, lineIds: [line] } = await makeRfqPo(t, { lines: [{ qty: 6, unit: "kg" }] });
  const [a, b, c] = await setPlan(t, poId, [
    { hotelId: A1, phaseNo: 1, dueDate: "2026-10-20", lines: { [line]: 2 } },
    { hotelId: A1, phaseNo: 2, dueDate: "2026-11-20", lines: { [line]: 2 } },
    { hotelId: A1, phaseNo: 3, dueDate: "2026-12-20", lines: { [line]: 2 } },
  ]);
  const grn = await postReceiptGrn(t, {
    poId,
    lines: [{
      poLineId: line, accepted: 6,
      allocations: [a, b, c].map((d) => ({ deliveryLineId: d.lines[line], accepted: 2 })),
    }],
  });
  const ret = (disposition) => createRtv(t, STORES, {
    grnId: grn.grnId, disposition, lines: [{ grnLineId: grn.lines[0].grnLineId, qty: 2, reason: "Bad lot" }],
  });
  return { poId, line, A: a.lines[line], B: b.lines[line], C: c.lines[line], grn, ret };
}

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

      // Not replaced yet: the RTV stays open, and the refusal says where.
      const hotelName = (await t.one(`SELECT name FROM tbl_hospitality_company_hotels WHERE id = $1`, [A1])).name;
      const notYet = await expectInvError(closeRtv(t, STORES, draft.id, {}), "CONFLICT", {
        openLines: [expect.objectContaining({ phaseNo: 1, hotelId: A1, hotelName, openQty: 3 })],
      });
      expect(notYet.message).toBe(`Receive or short-close the remaining qty on Phase 1 at ${hotelName} before closing this return`);
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

  it("needs grn.approve at the GRN's hotel; a GRN or RTV the caller can't see is not found (rule C3)", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, lineIds: [line] } = await makeRfqPo(t);
      const grn = await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 10 }] });
      const input = { grnId: grn.grnId, disposition: "CREDIT", lines: [{ grnLineId: grn.lines[0].grnLineId, qty: 1, reason: "x" }] };
      const member = { id: IDS.users.a1_proc_techEval, user_type: 2 };

      // Mapped to company A but no grn grant at A1: the GRN reads as missing.
      await expectInvError(createRtv(t, member, input), "NOT_FOUND");
      await expectInvError(createRtv(t, OTHER_COMPANY, input), "NOT_FOUND");
      const rtv = await createRtv(t, STORES, input);
      await expectInvError(getRtv(t, member, rtv.id), "NOT_FOUND");
      await expectInvError(getRtv(t, OTHER_COMPANY, rtv.id), "NOT_FOUND");
      await expectInvError(getRtv(t, STORES, 999999999), "NOT_FOUND");

      // Seeing A1's receipts (Storekeeper: grn.read) without grn.approve: 403.
      const storekeeper = await t.one(`SELECT id FROM tbl_roles WHERE title = 'Storekeeper' AND created_by IS NULL`);
      await grantRoleScope(t, { userId: member.id, roleId: storekeeper.id, companyId: CO, hotelId: A1 });
      await expectInvError(createRtv(t, member, input), "FORBIDDEN");
      expect((await getRtv(t, member, rtv.id)).id).toBe(rtv.id);
      await expectInvError(cancelRtv(t, member, rtv.id), "FORBIDDEN");
    });
  });

  it("an older draft dispatched after newer returns takes only what is left, moving none of them", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const shortCloses = (poId) => t.any(
        `SELECT delivery_line_id, qty::float AS qty FROM tbl_po_short_close WHERE po_id = $1 ORDER BY id`, [poId]
      );

      // CREDIT drafted first (rl1), then REPLACE (rl2) and CREDIT (rl3) dispatched.
      const one = await threePhaseReceipt(t);
      const rl1 = await one.ret("CREDIT");
      await dispatchRtv(t, STORES, (await one.ret("REPLACE")).id, {});
      const rl3 = await one.ret("CREDIT");
      await dispatchRtv(t, STORES, rl3.id, {});
      // Latest allocation first: rl2's replacement on C, rl3's credit on B.
      expect(await shortCloses(one.poId)).toEqual([{ delivery_line_id: one.B, qty: 2 }]);
      // Returns spread in dispatch order, so rl1 takes A, the only phase left,
      // and closes exactly its own 2 there.
      const sent = await dispatchRtv(t, STORES, rl1.id, {});
      expect(sent.status).toBe("dispatched");
      expect(await shortCloses(one.poId)).toEqual([{ delivery_line_id: one.B, qty: 2 }, { delivery_line_id: one.A, qty: 2 }]);
      expect((await deliveryLinesOf(t, one.poId)).map((d) => [d.id, d.returned_replace, d.returned_credit, d.short_closed]))
        .toEqual([[one.A, 0, 2, 2], [one.B, 0, 2, 2], [one.C, 2, 0, 0]]);

      // A REPLACE drafted before a dispatched CREDIT leaves that credit where it is.
      const two = await threePhaseReceipt(t);
      const replace = await two.ret("REPLACE");
      await dispatchRtv(t, STORES, (await two.ret("CREDIT")).id, {});
      await dispatchRtv(t, STORES, replace.id, {});
      expect(await shortCloses(two.poId)).toEqual([{ delivery_line_id: two.C, qty: 2 }]);
      expect((await deliveryLinesOf(t, two.poId)).map((d) => [d.id, d.returned_replace, d.returned_credit, d.short_closed]))
        .toEqual([[two.A, 0, 0, 0], [two.B, 2, 0, 0], [two.C, 0, 2, 2]]);
    });
  });

  it("an older CREDIT dispatched after a newer REPLACE was replaced leaves no phantom open phase (E1 I-1)", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, line, A, B, C, ret } = await threePhaseReceipt(t);
      const credit = await ret("CREDIT"); // drafted first
      const replace = await ret("REPLACE");
      await dispatchRtv(t, STORES, replace.id, {}); // the replacement is owed on C
      // The replacement arrives: C is the only open row.
      await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 2, deliveryLineId: C }] });

      await dispatchRtv(t, STORES, credit.id, {});
      // The credit takes B (C's 2 are the replaced ones); REPLACE stays on C.
      expect((await deliveryLinesOf(t, poId)).map((d) => [d.id, d.accepted, d.returned_replace, d.returned_credit, d.short_closed, d.status]))
        .toEqual([
          [A, 2, 0, 0, 0, "received"],
          [B, 2, 0, 2, 2, "short_closed"],
          [C, 4, 2, 0, 0, "received"],
        ]);
      // One close of 2, nothing open, and the REPLACE return can close.
      expect(await t.any(`SELECT delivery_line_id, qty::float AS qty FROM tbl_po_short_close WHERE po_id = $1`, [poId]))
        .toEqual([{ delivery_line_id: B, qty: 2 }]);
      expect(await poState(t, poId)).toEqual({
        receiptStatus: "closed_short",
        lines: [{ accepted: 8, rr: 2, rc: 2, sc: 2, receipt_status: "short_closed" }],
      });
      expect((await closeRtv(t, STORES, replace.id, {})).status).toBe("closed");
    });
  });

  it("a dispatch that would move an earlier return's replacement qty is refused, writing nothing", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, C, grn, ret } = await threePhaseReceipt(t);
      const replace = await ret("REPLACE");
      await dispatchRtv(t, STORES, replace.id, {}); // rr 2 on C
      // A clock that stamped the REPLACE after "now" sorts it after the next
      // dispatch, so the roll-up would push its replacement off C.
      await t.none(`UPDATE tbl_rtv SET dispatched_at = now() + interval '1 day' WHERE id = $1`, [replace.id]);
      const credit = await ret("CREDIT");
      const snapshot = async () => ({
        log: await t.any(`SELECT id FROM tbl_po_short_close WHERE po_id = $1`, [poId]),
        dls: await deliveryLinesOf(t, poId),
        moves: await rtvMovements(t, credit.id),
        balance: await balanceOf(t, A1, grn.lines[0].invItemId),
        rtv: await t.one(`SELECT status, rtv_number, dispatched_at FROM tbl_rtv WHERE id = $1`, [credit.id]),
      });
      const before = await snapshot();
      expect(before.dls.find((d) => d.id === C)).toMatchObject({ returned_replace: 2, status: "open" });
      const err = await expectInvError(t.tx((sp) => dispatchRtv(sp, STORES, credit.id, {})), "CONFLICT", { rtvId: credit.id });
      expect(err.message).toBe("Later returns on this receipt were dispatched first. Cancel this draft and raise it again to dispatch it.");
      expect(await snapshot()).toEqual(before);
      expect(before.rtv).toEqual({ status: "draft", rtv_number: null, dispatched_at: null });
    });
  });

  it("dispatch stamps dispatched_at", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { ret } = await threePhaseReceipt(t);
      const rtv = await ret("REPLACE");
      expect((await t.one(`SELECT dispatched_at FROM tbl_rtv WHERE id = $1`, [rtv.id])).dispatched_at).toBeNull();
      await dispatchRtv(t, STORES, rtv.id, {});
      const { dispatched_at: at } = await t.one(`SELECT dispatched_at FROM tbl_rtv WHERE id = $1`, [rtv.id]);
      expect(at).toBeInstanceOf(Date);
    });
  });

  it("a credit return on a receipt line booked to no delivery is refused, writing nothing", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, lineIds: [line] } = await makeRfqPo(t, { lines: [{ qty: 10, unit: "kg" }] });
      const grn = await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 10 }] });
      const [g] = grn.lines;
      // A receipt that never reached the delivery plan (e.g. a legacy-received PO).
      await t.none(`DELETE FROM tbl_grn_line_alloc WHERE grn_line_id = $1`, [g.grnLineId]);
      const credit = await createRtv(t, STORES, {
        grnId: grn.grnId, disposition: "CREDIT", lines: [{ grnLineId: g.grnLineId, qty: 3, reason: "Spoilt" }],
      });
      const snapshot = async () => ({
        log: await t.any(`SELECT id FROM tbl_po_short_close WHERE po_id = $1`, [poId]),
        dls: await deliveryLinesOf(t, poId),
        moves: await rtvMovements(t, credit.id),
        balance: await balanceOf(t, A1, g.invItemId),
        rtv: await t.one(`SELECT status, rtv_number FROM tbl_rtv WHERE id = $1`, [credit.id]),
      });
      const before = await snapshot();
      const err = await expectInvError(
        t.tx((sp) => dispatchRtv(sp, STORES, credit.id, {})), "CONFLICT", { rtvId: credit.id, grnId: grn.grnId }
      );
      expect(err.message).toBe("This receipt line isn't booked to any delivery, so the credit can't be closed against the PO");
      expect(await snapshot()).toEqual(before);
      expect(before.rtv).toEqual({ status: "draft", rtv_number: null });
    });
  });

  it("RTV_OUT stock qty is exact: 3.3333 at 0.5 is 1.6667, 1.0003 at 1.5 is 1.5005", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, lineIds: [l1, l2] } = await makeRfqPo(t, {
        lines: [{ qty: 10, unit: "box", variantId: 1 }, { qty: 10, unit: "case", variantId: 3 }],
      });
      const grn = await postReceiptGrn(t, {
        poId, lines: [{ poLineId: l1, accepted: 4, uomFactor: 0.5 }, { poLineId: l2, accepted: 2, uomFactor: 1.5 }],
      });
      const [g1, g2] = grn.lines;
      const rtv = await createRtv(t, STORES, {
        grnId: grn.grnId, disposition: "REPLACE",
        lines: [
          { grnLineId: g1.grnLineId, qty: 3.3333, reason: "Crushed" },
          // In floating point 1.0003 × 1.5 is 1.50044999…, which would post 1.5004.
          { grnLineId: g2.grnLineId, qty: 1.0003, reason: "Crushed" },
        ],
      });
      await dispatchRtv(t, STORES, rtv.id, {});
      expect((await rtvMovements(t, rtv.id)).map((m) => m.qty)).toEqual([-1.6667, -1.5005]);
      expect(await balanceOf(t, A1, g1.invItemId)).toBe(0.3333);
      expect(await balanceOf(t, A1, g2.invItemId)).toBe(1.4995);
    });
  });

  it("a line marked out on arrival comes back from its department, never from unrelated store stock (E1 M-1)", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const KITCHEN = IDS.departments.fb;
      // 10 kg already in the store from another PO, at 80.
      const other = await makeRfqPo(t, { lines: [{ qty: 10, unit: "kg" }] });
      const stocked = await postReceiptGrn(t, { poId: other.poId, lines: [{ poLineId: other.lineIds[0], accepted: 10, unitCost: 80 }] });
      // This PO's 10 kg (at 100) went straight to the kitchen: GRN_IN, then MARK_OUT at the average, 90.
      const { poId, lineIds: [line] } = await makeRfqPo(t, { lines: [{ qty: 10, unit: "kg" }] });
      const grn = await postReceiptGrn(t, {
        poId, lines: [{ poLineId: line, accepted: 10, unitCost: 100, markOutDepartmentId: KITCHEN }],
      });
      const item = grn.lines[0].invItemId;
      expect(item).toBe(stocked.lines[0].invItemId);
      expect(await balanceOf(t, A1, item)).toBe(10);

      const rtv = await createRtv(t, STORES, {
        grnId: grn.grnId, disposition: "REPLACE", lines: [{ grnLineId: grn.lines[0].grnLineId, qty: 4, reason: "Mouldy" }],
      });
      await dispatchRtv(t, STORES, rtv.id, {});
      // The other PO's 10 kg are still on the shelf.
      expect(await balanceOf(t, A1, item)).toBe(10);
      // The kitchen hands the 4 back at the cost it took them at, then they leave at the receipt cost.
      const moves = await t.any(
        `SELECT movement_type, qty::float AS qty, unit_cost::float AS unit_cost, department_id, reason_code
           FROM tbl_inv_movement WHERE source_type = 'RTV' AND source_id = $1 ORDER BY id`,
        [rtv.id]
      );
      expect(moves).toEqual([
        { movement_type: "RETURN_IN", qty: 4, unit_cost: 90, department_id: KITCHEN, reason_code: "RTV" },
        { movement_type: "RTV_OUT", qty: -4, unit_cost: 100, department_id: null, reason_code: null },
      ]);
      // The kitchen's consumption of this item is now 6.
      const kitchen = await t.one(
        `SELECT SUM(-qty)::float AS net FROM tbl_inv_movement
          WHERE hotel_id = $1 AND inv_item_id = $2 AND department_id = $3 AND movement_type IN ('MARK_OUT', 'RETURN_IN')`,
        [A1, item, KITCHEN]
      );
      expect(kitchen.net).toBe(6);

      // With nothing else in the store, the rest still goes back (no NEGATIVE_STOCK) and the store stays as it was.
      const lone = await makeRfqPo(t, { lines: [{ qty: 5, unit: "nos", variantId: 3 }] });
      const loneGrn = await postReceiptGrn(t, {
        poId: lone.poId, lines: [{ poLineId: lone.lineIds[0], accepted: 5, markOutDepartmentId: KITCHEN }],
      });
      const loneItem = loneGrn.lines[0].invItemId;
      expect(await balanceOf(t, A1, loneItem)).toBe(0);
      const all = await createRtv(t, STORES, {
        grnId: loneGrn.grnId, disposition: "CREDIT", lines: [{ grnLineId: loneGrn.lines[0].grnLineId, qty: 5, reason: "Wrong" }],
      });
      await dispatchRtv(t, STORES, all.id, {});
      expect(await balanceOf(t, A1, loneItem)).toBe(0);
      expect((await rtvMovements(t, all.id)).map((m) => [m.movement_type, m.qty])).toEqual([["RETURN_IN", 5], ["RTV_OUT", -5]]);
    });
  });

  it("partial returns and reversals of one receipt line add up to exactly what it stocked (E1 M-2)", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      // 12 pcs at 0.083333 dozen each stock exactly 1.0000 dozen.
      const receipt = async () => {
        const { poId, lineIds: [line] } = await makeRfqPo(t, { lines: [{ qty: 12, unit: "pcs" }] });
        const grn = await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 12, uomFactor: 0.083333 }] });
        const [g] = grn.lines;
        expect(await balanceOf(t, A1, g.invItemId)).toBe(1);
        const sendBack = async (qty) => {
          const rtv = await createRtv(t, STORES, {
            grnId: grn.grnId, disposition: "CREDIT", lines: [{ grnLineId: g.grnLineId, qty, reason: "Cracked" }],
          });
          await dispatchRtv(t, STORES, rtv.id, {});
          return (await rtvMovements(t, rtv.id)).map((m) => m.qty);
        };
        const reverse = async (qty) => {
          const { grn: rev } = await reverseGrn(t, STORES, { grnId: grn.grnId, reason: "Keyed wrong", lines: [{ grnLineId: g.grnLineId, qty }] });
          return (await t.any(
            `SELECT qty::float AS qty FROM tbl_inv_movement WHERE source_type = 'GRN' AND source_id = $1 AND movement_type = 'GRN_REVERSAL' ORDER BY id`,
            [rev.id]
          )).map((m) => m.qty);
        };
        return { item: g.invItemId, sendBack, reverse };
      };

      // Returns of 5 + 5 + 2: the last one takes the exact remainder (each part
      // rounded on its own would be 0.4167 × 2 + 0.1667 = 1.0001).
      const rtvs = await receipt();
      expect(await rtvs.sendBack(5)).toEqual([-0.4167]);
      expect(await rtvs.sendBack(5)).toEqual([-0.4166]);
      expect(await rtvs.sendBack(2)).toEqual([-0.1667]);
      expect(await balanceOf(t, A1, rtvs.item)).toBe(0);

      // The same with reversals.
      const revs = await receipt();
      expect(await revs.reverse(5)).toEqual([-0.4167]);
      expect(await revs.reverse(5)).toEqual([-0.4166]);
      expect(await revs.reverse(2)).toEqual([-0.1667]);
      expect(await balanceOf(t, A1, revs.item)).toBe(0);

      // And mixed: what one took counts for the other.
      const mixed = await receipt();
      expect(await mixed.sendBack(5)).toEqual([-0.4167]);
      expect(await mixed.reverse(5)).toEqual([-0.4166]);
      expect(await mixed.sendBack(2)).toEqual([-0.1667]);
      expect(await balanceOf(t, A1, mixed.item)).toBe(0);
    });
  });

  it("GRN and RTV document keys end in a random UUID, so they can't be enumerated (E1 M-4)", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, lineIds: [line] } = await makeRfqPo(t);
      const grn = await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 10 }] });
      const rtv = await createRtv(t, STORES, {
        grnId: grn.grnId, disposition: "CREDIT", lines: [{ grnLineId: grn.lines[0].grnLineId, qty: 1, reason: "x" }],
      });
      await dispatchRtv(t, STORES, rtv.id, {});
      const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
      const grnCtx = await loadGrnDocument(t, grn.grnId);
      const rtvCtx = await loadRtvDocument(t, rtv.id);
      const grnUrls = [await renderGrnDocument(grnCtx), await renderGrnDocument(grnCtx)];
      const rtvUrls = [await renderRtvDocument(rtvCtx), await renderRtvDocument(rtvCtx)];
      for (const url of grnUrls) expect(url).toMatch(new RegExp(`/grn/${CO}/${grn.grnId}-[A-Za-z0-9-]+-${UUID}\\.pdf$`));
      for (const url of rtvUrls) expect(url).toMatch(new RegExp(`/rtv/${CO}/${rtv.id}-[A-Za-z0-9-]+-${UUID}\\.pdf$`));
      expect(grnUrls[0]).not.toBe(grnUrls[1]);
      expect(rtvUrls[0]).not.toBe(rtvUrls[1]);
    });
  });

  it("a receipt line with no stock item or unit conversion is refused at create", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, lineIds: [l1, l2] } = await makeRfqPo(t, {
        lines: [{ qty: 10, unit: "kg", variantId: 1 }, { qty: 5, unit: "nos", variantId: 3 }],
      });
      const grn = await postReceiptGrn(t, {
        poId, lines: [{ poLineId: l1, accepted: 10 }, { poLineId: l2, accepted: 5 }],
      });
      const [g1, g2] = grn.lines;
      await t.none(`UPDATE tbl_grn_line SET inv_item_id = NULL WHERE id = $1`, [g1.grnLineId]);
      await t.none(`UPDATE tbl_grn_line SET uom_factor = NULL, stock_qty = NULL WHERE id = $1`, [g2.grnLineId]);
      for (const [g, name] of [[g1, "7 UP PEPSI 1.5 LTR"], [g2, "PEPSI 600 ML"]]) {
        const err = await expectInvError(
          createRtv(t, STORES, { grnId: grn.grnId, disposition: "CREDIT", lines: [{ grnLineId: g.grnLineId, qty: 1, reason: "x" }] }),
          "VALIDATION",
          { grnLineId: g.grnLineId }
        );
        expect(err.message).toContain(name);
      }
      expect(await t.any(`SELECT 1 FROM tbl_rtv WHERE po_id = $1`, [poId])).toEqual([]);
    });
  });

  it("names the product from the stock item when the line has no catalogue variant", async () => {
    await withTx(async (t) => {
      await grantStores(t);
      const { poId, lineIds: [line] } = await makeRfqPo(t);
      const grn = await postReceiptGrn(t, { poId, lines: [{ poLineId: line, accepted: 10 }] });
      const rtv = await createRtv(t, STORES, {
        grnId: grn.grnId, disposition: "CREDIT", lines: [{ grnLineId: grn.lines[0].grnLineId, qty: 1, reason: "x" }],
      });
      await t.none(`UPDATE tbl_inv_item SET display_name = 'Stores name for Pepsi' WHERE id = $1`, [grn.lines[0].invItemId]);
      await t.none(`UPDATE tbl_grn_line SET product_variant_id = NULL WHERE id = $1`, [grn.lines[0].grnLineId]);
      await t.none(`UPDATE tbl_purchase_order_product SET product_variant_id = NULL, rfq_product_id = NULL WHERE id = $1`, [line]);
      expect((await getRtv(t, STORES, rtv.id)).lines[0].productName).toBe("Stores name for Pepsi");
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
      // "Dispatched" is when the stock left (the RTV_OUT posting), not the RTV's last edit.
      await t.none(`UPDATE tbl_rtv SET updated_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [rtv.id]);
      const { at } = await t.one(
        `SELECT MIN(posted_at) AS at FROM tbl_inv_movement WHERE source_type = 'RTV' AND source_id = $1`, [rtv.id]
      );
      const ctx = await loadRtvDocument(t, rtv.id);
      expect(ctx.dispatchedAt).toBe(formatDateTimeIst(at));
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
  const made = { poIds: [], rfqIds: [], users: [] };
  const prevTypes = [];
  const scopeIds = [];
  const httpUsers = [STORES.id, OTHER_COMPANY.id];
  let stockItem; // variant 1's stock item at CO (a return needs one); removed after if made here

  beforeAll(async () => {
    stockItem = await resolveItemForVariant(db, { companyId: CO, productVariantId: 1, createIfMissing: true, defaultUom: "kg" });
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
    if (stockItem?.created) {
      await db.none(`DELETE FROM tbl_inv_item_variant WHERE inv_item_id = $1`, [stockItem.id]);
      await db.none(`DELETE FROM tbl_inv_item WHERE id = $1`, [stockItem.id]);
    }
    await revokeRoleScopes(db, scopeIds);
    if (made.users.length) {
      await db.none(`DELETE FROM tbl_activity_events WHERE actor_user_id = ANY($1::int[])`, [made.users]);
      await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [made.users]);
    }
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
      `INSERT INTO tbl_grn_line (hospitality_company_id, grn_id, po_line_id, product_variant_id, inv_item_id, po_uom,
                                 received_qty, accepted_qty, uom_factor, stock_qty, unit_cost)
       VALUES ($1, $2, $3, 1, $4, 'kg', 10, 10, 1, 10, 100) RETURNING id`,
      [CO, grn.id, po.lineIds[0], stockItem.id]
    );
    return { ...po, grnId: Number(grn.id), grnLineId: Number(line.id) };
  }

  it("a receipt's returns come with GET /grn/:id, for a Controller who can't see the PO itself", async () => {
    // The system Inventory Controller role alone: every grn and inventory key,
    // no PO (awarding) permission, so the PO's Deliveries tab is not theirs.
    const CTRL = 81501;
    const role = await db.one(`SELECT id FROM tbl_roles WHERE title = 'Inventory Controller' AND created_by IS NULL`);
    let scope = null;
    try {
      await db.none(
        `INSERT INTO tbl_users (id, name, email, status, user_type, company_id) VALUES ($1, 'RTV controller', 'rtv.ctrl.81501@test.local', 1, 2, $2)`,
        [CTRL, IDS.companies.A]
      );
      await db.none(
        `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
         VALUES ($1, $2, $3, 1, $4)`,
        [CTRL, CO, A1, IDS.users.superAdmin]
      );
      scope = await grantRoleScope(db, { userId: CTRL, roleId: role.id, companyId: CO, hotelId: A1 });

      const { poId, grnId, grnLineId } = await committedGrn();
      const other = await committedGrn(); // another receipt's return is not this one's
      const client = await httpClient(CTRL);
      const made1 = await client.post("/api/v1/inventory/rtv").send({
        grnId, disposition: "REPLACE", remarks: "caps", lines: [{ grnLineId, qty: 4, reason: "damaged" }],
      });
      expect(made1.status).toBe(200);
      const made2 = await client.post("/api/v1/inventory/rtv").send({
        grnId: other.grnId, disposition: "CREDIT", remarks: "x", lines: [{ grnLineId: other.grnLineId, qty: 1, reason: "damaged" }],
      });
      expect(made2.status).toBe(200);

      expect((await client.get(`/api/v1/inventory/po/${poId}/deliveries`)).status).toBe(404);
      const res = await client.get(`/api/v1/inventory/grn/${grnId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.rtvs).toEqual([
        expect.objectContaining({
          id: made1.body.data.id, grnId, disposition: "REPLACE", status: "draft",
          lines: [expect.objectContaining({ grnLineId, qty: 4, reason: "damaged" })],
        }),
      ]);
      expect(JSON.stringify(res.body.data.rtvs)).not.toMatch(/cost|price|value|rate/i);
    } finally {
      await revokeRoleScopes(db, scope ? [scope] : []);
      await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [CTRL]);
      made.users.push(CTRL); // removed after its RTVs (afterAll)
    }
  });

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

  it("dispatch is refused while a count freezes the GRN's hotel; raising a draft is not", async () => {
    const { grnId, grnLineId } = await committedGrn();
    const client = await httpClient(STORES.id);
    let count = null;
    const priorSettings = await db.oneOrNone(
      `SELECT count_freeze FROM tbl_inv_company_settings WHERE hospitality_company_id = $1`, [CO]
    );
    try {
      await db.none(
        `INSERT INTO tbl_inv_company_settings (hospitality_company_id, count_freeze) VALUES ($1, true)
         ON CONFLICT (hospitality_company_id) DO UPDATE SET count_freeze = true`,
        [CO]
      );
      count = await db.tx((t) => startCount(t, STORES, { hotelId: A1, scope: "SELECTED", invItemIds: [stockItem.id] }));

      const created = await client.post("/api/v1/inventory/rtv").send({
        grnId, disposition: "REPLACE", lines: [{ grnLineId, qty: 2, reason: "Dented cans" }],
      });
      expect(created.status).toBe(200);
      const rtvId = created.body.data.id;

      const sent = await client.post(`/api/v1/inventory/rtv/${rtvId}/dispatch`).send({ challanNo: "GP-1" });
      expect(sent.status).toBe(409);
      expect(sent.body).toMatchObject({
        status: 0, code: "LOCKED", details: { countId: count.id, countNumber: count.countNumber },
      });
      const read = await client.get(`/api/v1/inventory/rtv/${rtvId}`);
      expect(read.body.data).toMatchObject({ status: "draft", rtvNumber: null });
    } finally {
      // The count names the shared stock item, which afterAll may delete: remove it.
      if (count) {
        await db.tx((t) => cancelCount(t, STORES, count.id));
        await db.none(
          `DELETE FROM tbl_inv_count_line_event WHERE count_line_id IN (SELECT id FROM tbl_inv_count_line WHERE count_id = $1)`,
          [count.id]
        );
        await db.none(`DELETE FROM tbl_inv_count_line WHERE count_id = $1`, [count.id]);
        await db.none(`DELETE FROM tbl_inv_count WHERE id = $1`, [count.id]);
      }
      await db.none(`DELETE FROM tbl_inv_doc_sequence WHERE hotel_id = $1 AND doc_type = 'CNT'`, [A1]);
      if (priorSettings) {
        await db.none(`UPDATE tbl_inv_company_settings SET count_freeze = $2 WHERE hospitality_company_id = $1`, [CO, priorSettings.count_freeze]);
      } else {
        await db.none(`DELETE FROM tbl_inv_company_settings WHERE hospitality_company_id = $1`, [CO]);
      }
    }
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
