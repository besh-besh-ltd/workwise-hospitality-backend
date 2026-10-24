// Stock counts (Task C3, spec §8.5): each line records the system quantity
// when it is counted, approval posts the deltas, blind counts hide system
// quantities from counters, and a hotel's first approved full count starts
// its stock. Everything runs inside withTx (rolled back).

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { randomUUID } from "crypto";
import { db, withTx, closeDb, truncateDynamic } from "../setup/db.js";
import {
  A1, A2, FB, STORE, STORE_ID, CTRL, CTRL_ID, grantCast, makeItem, setLevels, stockIn, balanceOf, movementsOf,
  thrownBy,
} from "../helpers/invStockFixtures.js";
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

      // an item found during the count joins it
      const found = await makeItem(t, { name: "Found item" });
      await stockIn(t, { invItemId: found, qty: 1, unitCost: 10 });
      const { count: grown } = await saveCountLines(t, STORE, count.id, [line(found, 2)]);
      expect(lineOf(grown, found)).toMatchObject({ countedQty: 2, systemQtyAtCount: 1 });

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
      expect(asCounter.can).toEqual({ count: true, approve: false });

      const submitted = await submitCount(t, STORE, count.id);
      expect(lineOf(submitted, item)).toMatchObject({ systemQtyAtCount: null, varianceQty: null, varianceValue: null });
      expect(lineOf(await getCount(t, STORE, count.id), item).systemQtyAtCount).toBeNull();

      // the approver sees everything
      const asApprover = await getCount(t, CTRL, count.id);
      expect(lineOf(asApprover, item)).toMatchObject({ systemQtyAtCount: 10, varianceQty: -2, varianceValue: -10 });
      expect(asApprover.can).toEqual({ count: true, approve: true });

      const list = await listCounts(t, STORE, { hotelId: A1 });
      expect(list.rows.find((r) => r.id === count.id)).toMatchObject({ status: "submitted", isBlind: true, lineCount: 1, countedCount: 1 });
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
