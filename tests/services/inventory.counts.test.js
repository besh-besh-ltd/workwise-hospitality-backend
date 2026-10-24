// Stock counts (Task C3, spec §8.5): each line records the system quantity
// when it is counted, approval posts the deltas, blind counts hide system
// quantities from counters, and a hotel's first approved full count starts
// its stock. Everything runs inside withTx (rolled back).

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { randomUUID } from "crypto";
import { db, withTx, closeDb, truncateDynamic } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { revokeRoleScopes } from "../helpers/roleScope.js";
import {
  CO_B, A1, A2, A3, HB1, FB, STORE, STORE_ID, CTRL, CTRL_ID, grantCast, makeItem, setLevels, stockIn, move, balanceOf,
  movementsOf, setCompanySettings, thrownBy,
} from "../helpers/invStockFixtures.js";
import { makeRfqPo, postReceiptGrn } from "../helpers/invReceiptFixtures.js";
import {
  startCount, saveCountLines, submitCount, approveCount, cancelCount, getCount, listCounts,
} from "../../app/services/inventory/countService.js";
import { postOut } from "../../app/services/inventory/outService.js";
import { notifyApprovalNeeded, drainApprovalNotices } from "../../app/services/inventory/notices/approvalNotices.js";

beforeAll(async () => {
  await truncateDynamic();
});

afterAll(async () => {
  await closeDb();
});

const line = (invItemId, countedQty, clientEventId = randomUUID()) => ({ invItemId, countedQty, clientEventId });
const markOut = (t, invItemId, qty, hotelId = A1) =>
  postOut(t, STORE, { hotelId, docType: "OUT", departmentId: FB, clientEventId: randomUUID(), lines: [{ invItemId, qty }] });
const lineOf = (count, invItemId) => count.lines.find((l) => l.invItemId === invItemId);

describe("counts", () => {
  it("count posts deltas so mark-outs during count are not lost", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "Flour" });
      await stockIn(t, { invItemId: item, qty: 10, unitCost: 40 });

      const count = await startCount(t, STORE, { hotelId: A1, scope: "SELECTED", isBlind: false, invItemIds: [item] });
      expect(count).toMatchObject({ hotelId: A1, scope: "SELECTED", status: "open", isBlind: false });
      expect(count.countNumber).toMatch(/^CNT\/10101\/\d{4}-\d{2}\/00001$/);
      expect(count.lines).toEqual([expect.objectContaining({ invItemId: item, countedQty: null, systemQtyAtCount: null })]);

      // counted 9 while the system said 10
      const { count: saved } = await saveCountLines(t, STORE, count.id, [line(item, 9)]);
      expect(lineOf(saved, item)).toMatchObject({ countedQty: 9, systemQtyAtCount: 10, varianceQty: -1 });

      // the kitchen takes 2 while the count is open
      await markOut(t, item, 2);
      expect((await balanceOf(t, A1, item)).qty).toBe(8);

      const submitted = await submitCount(t, STORE, count.id);
      expect(submitted.status).toBe("submitted");
      expect(lineOf(submitted, item)).toMatchObject({ varianceQty: -1, varianceValue: -40 });

      // every non-zero variance needs a reason
      const noReason = await thrownBy(t, (sp) => approveCount(sp, CTRL, count.id, {}));
      expect(noReason.code).toBe("VALIDATION");
      expect(noReason.details.lines).toEqual([expect.objectContaining({ lineId: lineOf(submitted, item).id, invItemId: item })]);
      // only approvers approve
      const storekeeper = await thrownBy(t, (sp) => approveCount(sp, STORE, count.id, {}));
      expect(storekeeper.code).toBe("FORBIDDEN");

      const approved = await approveCount(t, CTRL, count.id, { [lineOf(submitted, item).id]: "Spillage" });
      expect(approved).toMatchObject({ status: "approved" });
      expect(lineOf(approved, item)).toMatchObject({ reason: "Spillage", varianceQty: -1, varianceValue: -40 });
      expect(await movementsOf(t, { sourceType: "CNT", sourceId: count.id })).toEqual([
        expect.objectContaining({ type: "COUNT_OUT", inv_item_id: item, qty: -1, unit_cost: 40 }),
      ]);
      // 10 − 2 marked out − 1 short = 7: the mark-out is not lost
      expect((await balanceOf(t, A1, item)).qty).toBe(7);

      const again = await thrownBy(t, (sp) => approveCount(sp, CTRL, count.id, {}));
      expect(again.code).toBe("CONFLICT");
    });
  });

  it("re-saving a line re-captures the system qty; a replayed line is a no-op", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t);
      await stockIn(t, { invItemId: item, qty: 10 });
      const count = await startCount(t, STORE, { hotelId: A1, scope: "SELECTED", invItemIds: [item] });

      const key = randomUUID();
      await saveCountLines(t, STORE, count.id, [line(item, 9, key)]);
      await markOut(t, item, 3);
      // the outbox replays the first save: nothing changes
      const replay = await saveCountLines(t, STORE, count.id, [line(item, 9, key)]);
      expect(replay.replayed).toBe(true);
      expect(lineOf(replay.count, item)).toMatchObject({ countedQty: 9, systemQtyAtCount: 10 });
      // a recount captures the system qty again
      const { count: recount, replayed } = await saveCountLines(t, STORE, count.id, [line(item, 6)]);
      expect(replayed).toBe(false);
      expect(lineOf(recount, item)).toMatchObject({ countedQty: 6, systemQtyAtCount: 7, varianceQty: -1 });

      // a late retry of the first save (its answer was lost) is still a replay: the recount stands
      const late = await saveCountLines(t, STORE, count.id, [line(item, 9, key)]);
      expect(late.replayed).toBe(true);
      expect(lineOf(late.count, item)).toMatchObject({ countedQty: 6, systemQtyAtCount: 7 });

      // an item found during the count joins it
      const found = await makeItem(t, { name: "Found item" });
      await stockIn(t, { invItemId: found, qty: 1, unitCost: 10 });
      const { count: grown } = await saveCountLines(t, STORE, count.id, [line(found, 2)]);
      expect(lineOf(grown, found)).toMatchObject({ countedQty: 2, systemQtyAtCount: 1 });

      // each line of a save has its own key, and a key belongs to one item
      const twin = randomUUID();
      const dup = await thrownBy(t, (sp) => saveCountLines(sp, STORE, count.id, [line(item, 5, twin), line(found, 3, twin)]));
      expect(dup.code).toBe("VALIDATION");
      expect(dup.details).toMatchObject({ field: "lines", index: 1 });
      const reused = await thrownBy(t, (sp) => saveCountLines(sp, STORE, count.id, [line(found, 4, key)]));
      expect(reused.code).toBe("VALIDATION");
      expect(reused.details).toMatchObject({ field: "lines", index: 0, invItemId: found });

      // the same item cannot sit in two active counts
      const overlap = await thrownBy(t, (sp) => startCount(sp, STORE, { hotelId: A1, scope: "SELECTED", invItemIds: [found] }));
      expect(overlap.code).toBe("CONFLICT");
      expect(overlap.details).toMatchObject({ countId: count.id });

      // a cancelled count posts nothing and frees its items
      const storekeeper = await thrownBy(t, (sp) => cancelCount(sp, STORE, count.id));
      expect(storekeeper.code).toBe("FORBIDDEN");
      const cancelled = await cancelCount(t, CTRL, count.id);
      expect(cancelled.status).toBe("cancelled");
      const closed = await thrownBy(t, (sp) => saveCountLines(sp, STORE, count.id, [line(item, 1)]));
      expect(closed.code).toBe("CONFLICT");
      expect(closed.details).toEqual({ status: "cancelled" });
      // an answer lost before the cancel: its retry is still a replay
      const afterCancel = await saveCountLines(t, STORE, count.id, [line(item, 9, key)]);
      expect(afterCancel.replayed).toBe(true);
      expect(afterCancel.count.status).toBe("cancelled");
      expect(await movementsOf(t, { sourceType: "CNT", sourceId: count.id })).toEqual([]);
      await startCount(t, STORE, { hotelId: A1, scope: "SELECTED", invItemIds: [found] });
    });
  });

  it("blind count hides system qty from counter", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t);
      await stockIn(t, { invItemId: item, qty: 10, unitCost: 5 });
      const count = await startCount(t, STORE, { hotelId: A1, scope: "SELECTED", isBlind: true, invItemIds: [item] });

      const { count: asCounter } = await saveCountLines(t, STORE, count.id, [line(item, 8)]);
      expect(asCounter.isBlind).toBe(true);
      expect(lineOf(asCounter, item)).toMatchObject({ countedQty: 8, systemQtyAtCount: null, varianceQty: null, varianceValue: null });
      expect(asCounter.summary).toEqual({ lineCount: 1, countedCount: 1, varianceLines: null, varianceValue: null });
      expect(asCounter.can).toEqual({ count: true, approve: false });

      const submitted = await submitCount(t, STORE, count.id);
      expect(lineOf(submitted, item)).toMatchObject({ systemQtyAtCount: null, varianceQty: null, varianceValue: null });
      expect(lineOf(await getCount(t, STORE, count.id), item).systemQtyAtCount).toBeNull();

      // the approver sees everything
      const asApprover = await getCount(t, CTRL, count.id);
      expect(lineOf(asApprover, item)).toMatchObject({ systemQtyAtCount: 10, varianceQty: -2, varianceValue: -10 });
      expect(asApprover.summary).toEqual({ lineCount: 1, countedCount: 1, varianceLines: 1, varianceValue: -10 });
      expect((await getCount(t, STORE, count.id)).summary).toMatchObject({ varianceLines: null, varianceValue: null });
      expect(asApprover.can).toEqual({ count: true, approve: true });

      const list = await listCounts(t, STORE, { hotelId: A1 });
      expect(list.rows.find((r) => r.id === count.id)).toMatchObject({
        status: "submitted", isBlind: true, lineCount: 1, countedCount: 1, countFreeze: false,
      });
      // the hotel's effective freeze setting rides on the count
      expect(asApprover.countFreeze).toBe(false);
      await setCompanySettings(t, { countFreeze: true });
      expect((await getCount(t, STORE, count.id)).countFreeze).toBe(true);
      expect((await listCounts(t, STORE, { hotelId: A1 })).rows.find((r) => r.id === count.id).countFreeze).toBe(true);
    });
  });

  it("count approval sets stock_started_at", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const kept = await makeItem(t, { name: "Kept" });
      const gained = await makeItem(t, { name: "Gained" });
      const levelled = await makeItem(t, { name: "Levelled only" });
      const other = await makeItem(t, { name: "Elsewhere" });
      await stockIn(t, { hotelId: A2, invItemId: kept, qty: 5, unitCost: 10 });
      await stockIn(t, { hotelId: A2, invItemId: gained, qty: 2, unitCost: 30 });
      await setLevels(t, { hotelId: A2, invItemId: levelled, reorderLevel: 1, binLabel: "B-1" });
      await stockIn(t, { hotelId: A1, invItemId: other, qty: 1 });
      expect((await t.oneOrNone(`SELECT stock_started_at FROM tbl_inv_hotel_settings WHERE hotel_id = $1`, [A2]))?.stock_started_at ?? null).toBeNull();

      // FULL takes every item with a balance or a level row at the hotel
      const count = await startCount(t, STORE, { hotelId: A2, scope: "FULL" });
      expect(count.lines.map((l) => l.invItemId).sort()).toEqual([kept, gained, levelled].sort());
      expect(lineOf(count, levelled).binLabel).toBe("B-1");

      await saveCountLines(t, STORE, count.id, [line(kept, 5), line(gained, 3), line(levelled, 0)]);
      await submitCount(t, STORE, count.id);
      const approved = await approveCount(t, CTRL, count.id, { [lineOf(count, gained).id]: "Misplaced" });
      expect(approved.status).toBe("approved");
      expect(approved.approvedBy).toBe(CTRL_ID);
      expect(await movementsOf(t, { sourceType: "CNT", sourceId: count.id })).toEqual([
        expect.objectContaining({ type: "COUNT_IN", inv_item_id: gained, qty: 1, unit_cost: 30 }),
      ]);
      expect((await balanceOf(t, A2, gained)).qty).toBe(3);

      const started = await t.one(`SELECT stock_started_at FROM tbl_inv_hotel_settings WHERE hotel_id = $1`, [A2]);
      expect(started.stock_started_at).not.toBeNull();
      // a second approval keeps the first start
      const second = await startCount(t, STORE, { hotelId: A2, scope: "SELECTED", invItemIds: [kept] });
      await saveCountLines(t, STORE, second.id, [line(kept, 5)]);
      await submitCount(t, STORE, second.id);
      await approveCount(t, CTRL, second.id, {});
      const after = await t.one(`SELECT stock_started_at FROM tbl_inv_hotel_settings WHERE hotel_id = $1`, [A2]);
      expect(new Date(after.stock_started_at).toISOString()).toBe(new Date(started.stock_started_at).toISOString());

      // nothing counted: nothing to submit
      const empty = await startCount(t, STORE, { hotelId: A2, scope: "SELECTED", invItemIds: [levelled] });
      const err = await thrownBy(t, (sp) => submitCount(sp, STORE, empty.id));
      expect(err.code).toBe("VALIDATION");
    });
  });

  it("a submitted count tells the hotel's approvers", async () => {
    let countId;
    try {
      await withTx(async (t) => {
        await grantCast(t);
        const item = await makeItem(t);
        await stockIn(t, { invItemId: item, qty: 3, unitCost: 2 });
        const count = await startCount(t, STORE, { hotelId: A1, scope: "SELECTED", invItemIds: [item] });
        countId = count.id;
        await saveCountLines(t, STORE, count.id, [line(item, 2)]);
        await submitCount(t, STORE, count.id);
        // the controller calls this after commit with db; inside the test transaction here
        await notifyApprovalNeeded(t, { kind: "count", id: count.id, actorUserId: STORE_ID });
        await drainApprovalNotices();
      });
      const rows = await db.any(
        `SELECT recipient_user_id, title, action_url FROM tbl_notifications
          WHERE type = 'inventory_approval_needed' AND (additional_data->>'countId')::int = $1
          ORDER BY recipient_user_id`,
        [countId]
      );
      // the cast's only approver is CTRL; the storekeeper who submitted holds no approve
      expect(rows.map((r) => Number(r.recipient_user_id))).toEqual([CTRL_ID]);
      expect(rows[0].title).toMatch(/^Stock count CNT\/.+ is ready for approval$/);
      expect(rows[0].action_url).toBe(`/dashboard/buyer/inventory/counts/${countId}`);
    } finally {
      await db.none(
        `DELETE FROM tbl_notifications WHERE type = 'inventory_approval_needed' AND (additional_data->>'countId')::int = $1`,
        [countId ?? 0]
      );
    }
  });

  it("a full count cannot be submitted with uncounted lines", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const counted = await makeItem(t, { name: "Counted" });
      const skipped = await makeItem(t, { name: "Skipped" });
      await stockIn(t, { hotelId: A3, invItemId: counted, qty: 2 });
      await stockIn(t, { hotelId: A3, invItemId: skipped, qty: 3 });
      const count = await startCount(t, STORE, { hotelId: A3, scope: "FULL" });
      await saveCountLines(t, STORE, count.id, [line(counted, 2)]);

      const err = await thrownBy(t, (sp) => submitCount(sp, STORE, count.id));
      expect(err.code).toBe("VALIDATION");
      expect(err.details).toEqual({
        field: "lines",
        uncounted: [{ lineId: lineOf(count, skipped).id, invItemId: skipped, displayName: "Skipped" }],
        uncountedTotal: 1,
      });

      await saveCountLines(t, STORE, count.id, [line(skipped, 0)]);
      expect((await submitCount(t, STORE, count.id)).status).toBe("submitted");
    });
  });

  it("a first full count of legacy stock with no cost anywhere needs a unit cost; a later receipt averages correctly", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const legacy = await makeItem(t, { name: "Legacy rice" });
      await setLevels(t, { hotelId: A2, invItemId: legacy, reorderLevel: 5 });
      const count = await startCount(t, STORE, { hotelId: A2, scope: "FULL" });
      await saveCountLines(t, STORE, count.id, [line(legacy, 50)]);
      const submitted = await submitCount(t, STORE, count.id);
      const lineId = lineOf(submitted, legacy).id;
      const reasons = { [lineId]: "Opening stock on the shelf" };

      const legacyLine = { lineId, invItemId: legacy, displayName: "Legacy rice" };
      // the approver is told up front which lines need a cost; nobody else is
      expect(lineOf(await getCount(t, CTRL, count.id), legacy).needsUnitCost).toBe(true);
      expect(lineOf(await getCount(t, STORE, count.id), legacy).needsUnitCost).toBe(false);

      // a missing reason and a missing cost come back together, in one error
      const both = await thrownBy(t, (sp) => approveCount(sp, CTRL, count.id, {}));
      expect(both.code).toBe("VALIDATION");
      expect(both.details).toEqual({ field: "reasons", lines: [legacyLine], reasons: [legacyLine], unitCosts: [legacyLine] });
      expect(both.message).toMatch(/reason.+ and .+unit cost/);

      // no cost at the hotel, nor anywhere in the company: refused, never posted at 0
      const noCost = await thrownBy(t, (sp) => approveCount(sp, CTRL, count.id, reasons));
      expect(noCost.code).toBe("VALIDATION");
      expect(noCost.details).toEqual({ field: "unitCosts", lines: [legacyLine], reasons: [], unitCosts: [legacyLine] });
      const zero = await thrownBy(t, (sp) => approveCount(sp, CTRL, count.id, reasons, { [lineId]: 0 }));
      expect(zero.details).toMatchObject({ field: "unitCosts", lineId: String(lineId) });
      const huge = await thrownBy(t, (sp) => approveCount(sp, CTRL, count.id, reasons, { [lineId]: 1e9 + 1 }));
      expect(huge.code).toBe("VALIDATION");
      expect(huge.details).toMatchObject({ field: "unitCosts", lineId: String(lineId) });

      const approved = await approveCount(t, CTRL, count.id, reasons, { [lineId]: 40 });
      expect(approved.status).toBe("approved");
      expect(lineOf(approved, legacy)).toMatchObject({ varianceQty: 50, varianceValue: 2000 });
      expect(await movementsOf(t, { sourceType: "CNT", sourceId: count.id })).toEqual([
        expect.objectContaining({ type: "COUNT_IN", inv_item_id: legacy, qty: 50, unit_cost: 40 }),
      ]);
      // the first receipt blends with the counted stock's cost, not with zero
      await stockIn(t, { hotelId: A2, invItemId: legacy, qty: 50, unitCost: 60, type: "GRN_IN" });
      expect(await balanceOf(t, A2, legacy)).toEqual({ qty: 100, avgCost: 50, value: 5000 });
    });
  });

  it("a gain with no cost here takes the latest inbound cost at a sibling hotel, never another company's", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const towel = await makeItem(t, { name: "Towel" });
      const soap = await makeItem(t, { name: "Soap" });
      const mat = await makeItem(t, { name: "Bath mat" });
      await stockIn(t, { hotelId: A1, invItemId: towel, qty: 3, unitCost: 25 });
      await stockIn(t, { hotelId: A1, invItemId: towel, qty: 2, unitCost: 35, type: "GRN_IN" });
      await stockIn(t, { hotelId: A1, invItemId: soap, qty: 1, unitCost: 20 });
      // company B stocks its own "Bath mat": its cost is never borrowed
      const foreignMat = await makeItem(t, { companyId: CO_B, name: "Bath mat" });
      await stockIn(t, { companyId: CO_B, hotelId: HB1, invItemId: foreignMat, qty: 1, unitCost: 999 });

      const count = await startCount(t, STORE, { hotelId: A2, scope: "SELECTED", invItemIds: [towel, soap, mat] });
      await saveCountLines(t, STORE, count.id, [line(towel, 4), line(soap, 2), line(mat, 1)]);
      const submitted = await submitCount(t, STORE, count.id);
      const id = (item) => lineOf(submitted, item).id;
      const reasons = { [id(towel)]: "found", [id(soap)]: "found", [id(mat)]: "found" };

      const matLine = { lineId: id(mat), invItemId: mat, displayName: "Bath mat" };
      const err = await thrownBy(t, (sp) => approveCount(sp, CTRL, count.id, reasons));
      expect(err.details).toEqual({ field: "unitCosts", lines: [matLine], reasons: [], unitCosts: [matLine] });
      const hint = await getCount(t, CTRL, count.id);
      expect([towel, soap, mat].map((i) => lineOf(hint, i).needsUnitCost)).toEqual([false, false, true]);

      // the approver's cost comes first; otherwise the company's latest inbound cost
      await approveCount(t, CTRL, count.id, reasons, { [id(soap)]: 22, [id(mat)]: 12 });
      const costs = Object.fromEntries(
        (await movementsOf(t, { sourceType: "CNT", sourceId: count.id })).map((m) => [m.inv_item_id, [m.type, m.qty, m.unit_cost]])
      );
      expect(costs).toEqual({
        [towel]: ["COUNT_IN", 4, 35],
        [soap]: ["COUNT_IN", 2, 22],
        [mat]: ["COUNT_IN", 1, 12],
      });
    });
  });

  it("a gain on stock held at an average of 0 posts at 0, with no unit cost asked", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const sample = await makeItem(t, { name: "Free sample" });
      await move(t, { hotelId: A2, invItemId: sample, type: "COUNT_IN", qty: 5, unitCost: 0 });
      const count = await startCount(t, STORE, { hotelId: A2, scope: "SELECTED", invItemIds: [sample] });
      await saveCountLines(t, STORE, count.id, [line(sample, 7)]);
      const submitted = await submitCount(t, STORE, count.id);
      expect(lineOf(await getCount(t, CTRL, count.id), sample).needsUnitCost).toBe(false);

      await approveCount(t, CTRL, count.id, { [lineOf(submitted, sample).id]: "Found" });
      expect(await movementsOf(t, { sourceType: "CNT", sourceId: count.id })).toEqual([
        expect.objectContaining({ type: "COUNT_IN", inv_item_id: sample, qty: 2, unit_cost: 0, value: 0 }),
      ]);
      expect(await balanceOf(t, A2, sample)).toEqual({ qty: 7, avgCost: 0, value: 0 });
    });
  });

  it("a reversed receipt's cost is not borrowed for a count gain", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const { poId, lineIds } = await makeRfqPo(t, { hotel: A1, lines: [{ qty: 10, unit: "kg", variantId: 1 }] });
      const grn = await postReceiptGrn(t, { poId, hotelId: A1, lines: [{ poLineId: lineIds[0], accepted: 4, unitCost: 500 }] });
      const [{ grnLineId, invItemId: item }] = grn.lines;

      const count = await startCount(t, STORE, { hotelId: A2, scope: "SELECTED", invItemIds: [item] });
      await saveCountLines(t, STORE, count.id, [line(item, 3)]);
      const submitted = await submitCount(t, STORE, count.id);
      const lineId = lineOf(submitted, item).id;
      // the posted receipt's cost would value the gain
      expect(lineOf(await getCount(t, CTRL, count.id), item).needsUnitCost).toBe(false);

      // the receipt is reversed in full (a posted REVERSAL naming its line)
      const rev = await t.one(
        `INSERT INTO tbl_grn (grn_number, hospitality_company_id, hotel_id, po_id, doc_type, reverses_grn_id, status,
                              received_at, received_by, posted_at, posted_by)
         SELECT grn_number || '-R', hospitality_company_id, hotel_id, po_id, 'REVERSAL', id, 'posted',
                received_at, received_by, now(), posted_by FROM tbl_grn WHERE id = $1 RETURNING id`,
        [grn.grnId]
      );
      await t.none(
        `INSERT INTO tbl_grn_line (hospitality_company_id, grn_id, po_line_id, product_variant_id, inv_item_id, po_uom,
                                   received_qty, accepted_qty, rejected_qty, uom_factor, stock_qty, unit_cost,
                                   reverses_grn_line_id)
         SELECT hospitality_company_id, $1, po_line_id, product_variant_id, inv_item_id, po_uom,
                received_qty, accepted_qty, rejected_qty, uom_factor, stock_qty, unit_cost, id
           FROM tbl_grn_line WHERE id = $2`,
        [rev.id, grnLineId]
      );
      await t.none(`UPDATE tbl_grn SET status = 'reversed' WHERE id = $1`, [grn.grnId]);

      expect(lineOf(await getCount(t, CTRL, count.id), item).needsUnitCost).toBe(true);
      const err = await thrownBy(t, (sp) => approveCount(sp, CTRL, count.id, { [lineId]: "Found" }));
      expect(err.code).toBe("VALIDATION");
      expect(err.details).toMatchObject({ field: "unitCosts", unitCosts: [expect.objectContaining({ lineId, invItemId: item })] });
    });
  });

  it("a selected spot check does not start the hotel's stock", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t);
      await stockIn(t, { hotelId: A2, invItemId: item, qty: 4 });
      const count = await startCount(t, STORE, { hotelId: A2, scope: "SELECTED", invItemIds: [item] });
      await saveCountLines(t, STORE, count.id, [line(item, 4)]);
      await submitCount(t, STORE, count.id);
      await approveCount(t, CTRL, count.id, {});
      const row = await t.oneOrNone(`SELECT stock_started_at FROM tbl_inv_hotel_settings WHERE hotel_id = $1`, [A2]);
      expect(row?.stock_started_at ?? null).toBeNull();
    });
  });
});

describe("committed: count approval racing a first receipt, and late retries over HTTP", () => {
  let scopes = [];
  beforeAll(async () => {
    scopes = await grantCast(db);
  });
  afterAll(async () => {
    await revokeRoleScopes(db, scopes);
    await db.none(`DELETE FROM tbl_activity_events WHERE entity_type = ANY($1::text[])`, [["INV_COUNT"]]);
    await truncateDynamic();
  });

  /** A submitted SELECTED count at A3 of one new item: system 0, counted 5. */
  async function submittedCount(name) {
    const item = await makeItem(db, { name });
    const count = await db.tx((t) => startCount(t, STORE, { hotelId: A3, scope: "SELECTED", invItemIds: [item] }));
    await db.tx((t) => saveCountLines(t, STORE, count.id, [line(item, 5)]));
    const submitted = await db.tx((t) => submitCount(t, STORE, count.id));
    return { item, countId: count.id, lineId: lineOf(submitted, item).id };
  }
  /** The item's first receipt at A3: 10 @ 100. */
  const receipt = (item) => (t) => stockIn(t, { hotelId: A3, invItemId: item, qty: 10, unitCost: 100, type: "GRN_IN" });
  /** Run `work` in a transaction that stays open until release(). */
  function held(work) {
    let release;
    let ready;
    const gate = new Promise((r) => { release = r; });
    const started = new Promise((r) => { ready = r; });
    const done = db.tx(async (t) => {
      const result = await work(t);
      ready();
      await gate;
      return result;
    });
    done.catch(() => ready());
    return { started, release, done };
  }
  /** Still running after `ms`? */
  async function stillPending(promise, ms = 300) {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, ms));
    return !settled;
  }

  it("the receipt commits first: the count waits for it, then posts at the receipt's average", async () => {
    const { item, countId, lineId } = await submittedCount("Race: receipt first");
    const grn = held(receipt(item));
    await grn.started;
    // no unitCosts and no cost anywhere: only the receipt's average can value this gain
    const approve = db.tx((t) => approveCount(t, CTRL, countId, { [lineId]: "Found in store" }));
    expect(await stillPending(approve)).toBe(true);
    grn.release();
    await grn.done;
    expect((await approve).status).toBe("approved");
    expect(await balanceOf(db, A3, item)).toEqual({ qty: 15, avgCost: 100, value: 1500 });
  });

  it("the count commits first: the receipt waits for it, and the average blends both costs", async () => {
    const { item, countId, lineId } = await submittedCount("Race: count first");
    const approve = held((t) => approveCount(t, CTRL, countId, { [lineId]: "Found in store" }, { [lineId]: 80 }));
    await approve.started;
    const grn = db.tx(receipt(item));
    expect(await stillPending(grn)).toBe(true);
    approve.release();
    await approve.done;
    await grn;
    const balance = await balanceOf(db, A3, item);
    expect(balance.qty).toBe(15);
    expect(balance.value).toBe(1400); // 5 × 80 + 10 × 100
    expect(balance.avgCost).toBeCloseTo(93.3333, 3);
  });

  it("a late retry of an older line save answers replayed, no_op and keeps the newer count; one key per line", async () => {
    const item = await makeItem(db, { name: "Retry item" });
    const other = await makeItem(db, { name: "Other item" });
    await db.tx((t) => stockIn(t, { hotelId: A3, invItemId: item, qty: 10 }));
    const count = await db.tx((t) => startCount(t, STORE, { hotelId: A3, scope: "SELECTED", invItemIds: [item] }));
    const store = await httpClient(STORE_ID);
    const put = (lines) => store.put(`/api/v1/inventory/counts/${count.id}/lines`).send({ lines });

    const e1 = randomUUID();
    expect((await put([line(item, 9, e1)])).status).toBe(200);
    const newer = await put([line(item, 6)]);
    expect(newer.status).toBe(200);
    expect(newer.body.data.replayed).toBeUndefined();

    const late = await put([line(item, 9, e1)]);
    expect(late.status).toBe(200);
    expect(late.body.data).toMatchObject({ replayed: true, no_op: true });
    expect(lineOf(late.body.data, item).countedQty).toBe(6);
    expect(await db.one(`SELECT counted_qty::float AS q FROM tbl_inv_count_line WHERE count_id = $1`, [count.id])).toEqual({ q: 6 });

    // the same key on two lines of one save is a 400, not a 500
    const twin = randomUUID();
    const dup = await put([line(item, 5, twin), line(other, 1, twin)]);
    expect(dup.status).toBe(400);
    expect(dup.body).toMatchObject({ code: "VALIDATION", details: { field: "lines", index: 1 } });

    // once submitted: a retry of an applied save is still a replay; a new save is refused
    expect((await store.post(`/api/v1/inventory/counts/${count.id}/submit`).send({})).status).toBe(200);
    const afterSubmit = await put([line(item, 9, e1)]);
    expect(afterSubmit.status).toBe(200);
    expect(afterSubmit.body.data).toMatchObject({ status: "submitted", replayed: true, no_op: true });
    const fresh = await put([line(item, 4)]);
    expect(fresh.status).toBe(409);
    expect(fresh.body).toMatchObject({ code: "CONFLICT", details: { status: "submitted" } });
  });

  it("the approve endpoint passes the approver's unit costs through", async () => {
    const { item, countId, lineId } = await submittedCount("Http unit cost");
    const ctrl = await httpClient(CTRL_ID);
    const res = await ctrl.post(`/api/v1/inventory/counts/${countId}/approve`)
      .send({ reasons: { [lineId]: "Found in store" }, unitCosts: { [lineId]: 70 } });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("approved");
    expect(await movementsOf(db, { sourceType: "CNT", sourceId: countId })).toEqual([
      expect.objectContaining({ type: "COUNT_IN", inv_item_id: item, qty: 5, unit_cost: 70 }),
    ]);
  });
});
