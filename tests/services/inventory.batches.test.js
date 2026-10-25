// Expiry batches (Task D3): ledger.postMovements keeps tbl_inv_batch for items
// that track expiry, and deducts outbound stock earliest-expiry-first (FEFO).
//
// What is pinned here:
//   - inbound stock with a batch / expiry lands in that batch; stock with no
//     expiry recorded sits in one undated bucket ('' / NO_EXPIRY_DATE);
//   - an outbound movement that names a batch takes it from that batch first
//     (a GRN reversal or RTV of a received batch), anything else goes FEFO,
//     the undated bucket first; one outbound line becomes one movement row per
//     batch it touched;
//   - Σ batch qty = balance qty for every tracked item, whatever happens;
//   - items that do not track expiry keep no batches and are never split;
//   - the documents that read movements per line (mark-out, adjustment,
//     count) still show one line with its whole value when it was split.
//
// Service cases run inside withTx. The concurrency case commits, so the suite
// truncates the dynamic tables before and after.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { randomUUID } from "crypto";
import { db, withTx, closeDb, truncateDynamic } from "../setup/db.js";
import { postMovements, NO_EXPIRY_DATE } from "../../app/services/inventory/ledger.js";
import { postOut } from "../../app/services/inventory/outService.js";
import { createAdjustment, getAdjustment, listAdjustments } from "../../app/services/inventory/adjustmentService.js";
import { startCount, saveCountLines, submitCount, approveCount } from "../../app/services/inventory/countService.js";
import { getStockItem } from "../../app/services/inventory/stockQueries.js";
import {
  CO, A1, A2, FB, STORE, STORE_ID, CTRL, grantCast, makeItem, setCompanySettings, thrownBy,
} from "../helpers/invStockFixtures.js";

beforeAll(async () => {
  await truncateDynamic();
});

afterAll(async () => {
  await truncateDynamic();
  await closeDb();
});

async function trackedItem(t, name = "Milk 1L") {
  const id = await makeItem(t, { name, stockUom: "pcs" });
  await t.none(`UPDATE tbl_inv_item SET track_expiry = true WHERE id = $1`, [id]);
  return id;
}

const mv = (invItemId, type, qty, extra = {}) => ({
  companyId: CO, hotelId: A1, invItemId, type, qty, sourceType: "TEST", sourceId: 1, postedBy: STORE_ID, ...extra,
});
const lot = (batchNo, expiryDate) => ({ batchNo, expiryDate });

async function batchesOf(t, invItemId, hotelId = A1) {
  const rows = await t.any(
    `SELECT batch_no, expiry_date::text AS expiry_date, qty::float AS qty FROM tbl_inv_batch
      WHERE hotel_id = $1 AND inv_item_id = $2 ORDER BY expiry_date, batch_no`,
    [hotelId, invItemId]
  );
  return rows.map((r) => ({ batchNo: r.batch_no, expiryDate: r.expiry_date, qty: r.qty }));
}
const nonZero = (rows) => rows.filter((r) => r.qty !== 0);

async function movementRows(t, invItemId, hotelId = A1) {
  return t.any(
    `SELECT movement_type AS type, qty::float AS qty, value::float AS value, qty_after::float AS qty_after,
            batch_no, expiry_date::text AS expiry_date
       FROM tbl_inv_movement WHERE hotel_id = $1 AND inv_item_id = $2 ORDER BY id`,
    [hotelId, invItemId]
  );
}

async function balanceQty(t, invItemId, hotelId = A1) {
  const row = await t.oneOrNone(`SELECT qty::float AS qty FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = $2`, [
    hotelId, invItemId,
  ]);
  return row ? row.qty : 0;
}

/** Σ batch qty against the balance, for every tracked item at every hotel. */
async function batchDrift(t) {
  return t.any(
    `SELECT b.hotel_id, b.inv_item_id, b.qty::text AS balance, COALESCE(s.qty, 0)::text AS batches
       FROM tbl_inv_balance b
       JOIN tbl_inv_item i ON i.id = b.inv_item_id AND i.track_expiry
       LEFT JOIN (SELECT hotel_id, inv_item_id, sum(qty) AS qty FROM tbl_inv_batch GROUP BY 1, 2) s
              ON s.hotel_id = b.hotel_id AND s.inv_item_id = b.inv_item_id
      WHERE b.qty <> COALESCE(s.qty, 0)`
  );
}

describe("FEFO", () => {
  it("FEFO deducts earliest expiry batch first and splits across batches", async () => {
    await withTx(async (t) => {
      const milk = await trackedItem(t);
      await postMovements(t, [
        mv(milk, "GRN_IN", 5, { unitCost: 40, ...lot("LOT-B", "2026-12-10") }),
        mv(milk, "GRN_IN", 4, { unitCost: 40, ...lot("LOT-A", "2026-11-20") }),
        mv(milk, "GRN_IN", 6, { unitCost: 40, ...lot("LOT-C", "2027-01-05") }),
      ]);
      expect(await batchesOf(t, milk)).toEqual([
        { batchNo: "LOT-A", expiryDate: "2026-11-20", qty: 4 },
        { batchNo: "LOT-B", expiryDate: "2026-12-10", qty: 5 },
        { batchNo: "LOT-C", expiryDate: "2027-01-05", qty: 6 },
      ]);

      const rows = await postMovements(t, [mv(milk, "MARK_OUT", -7, { departmentId: FB, sourceLineId: 77 })]);
      // one mark-out line, two movement rows: all of LOT-A, then 3 of LOT-B
      expect(rows).toEqual([
        expect.objectContaining({ type: "MARK_OUT", qty: -4, batchNo: "LOT-A", expiryDate: "2026-11-20", qtyAfter: 11, value: -160, sourceLineId: 77, departmentId: FB }),
        expect.objectContaining({ type: "MARK_OUT", qty: -3, batchNo: "LOT-B", expiryDate: "2026-12-10", qtyAfter: 8, value: -120, sourceLineId: 77, departmentId: FB }),
      ]);
      expect(await batchesOf(t, milk)).toEqual([
        { batchNo: "LOT-A", expiryDate: "2026-11-20", qty: 0 },
        { batchNo: "LOT-B", expiryDate: "2026-12-10", qty: 2 },
        { batchNo: "LOT-C", expiryDate: "2027-01-05", qty: 6 },
      ]);
      expect(await balanceQty(t, milk)).toBe(8);
      expect(await batchDrift(t)).toEqual([]);

      // the next mark-out finishes LOT-B before touching LOT-C
      await postMovements(t, [mv(milk, "MARK_OUT", -3, { departmentId: FB })]);
      expect(nonZero(await batchesOf(t, milk))).toEqual([{ batchNo: "LOT-C", expiryDate: "2027-01-05", qty: 5 }]);
    });
  });

  it("a named batch goes out from that batch first; whatever it lacks goes FEFO", async () => {
    await withTx(async (t) => {
      const milk = await trackedItem(t);
      await postMovements(t, [
        mv(milk, "GRN_IN", 4, { unitCost: 40, ...lot("LOT-A", "2026-11-20") }),
        mv(milk, "GRN_IN", 6, { unitCost: 50, ...lot("LOT-C", "2027-01-05") }),
        mv(milk, "GRN_IN", 5, { unitCost: 40, ...lot("LOT-B", "2026-12-10") }),
      ]);
      // reversing the LOT-C receipt takes LOT-C, not the earliest batch
      const reversal = await postMovements(t, [mv(milk, "GRN_REVERSAL", -6, { unitCost: 50, ...lot("LOT-C", "2027-01-05") })]);
      expect(reversal).toEqual([expect.objectContaining({ qty: -6, batchNo: "LOT-C", expiryDate: "2027-01-05", unitCost: 50 })]);
      expect(nonZero(await batchesOf(t, milk)).map((b) => [b.batchNo, b.qty])).toEqual([["LOT-A", 4], ["LOT-B", 5]]);

      // an unnamed mark-out still goes FEFO (LOT-A)
      await postMovements(t, [mv(milk, "MARK_OUT", -2)]);
      expect(nonZero(await batchesOf(t, milk)).map((b) => [b.batchNo, b.qty])).toEqual([["LOT-A", 2], ["LOT-B", 5]]);

      // naming a batch that holds less than asked: the batch first, the rest FEFO
      const rtv = await postMovements(t, [
        mv(milk, "MARK_OUT", -4, lot("LOT-B", "2026-12-10")),
        mv(milk, "RTV_OUT", -3, lot("LOT-B", "2026-12-10")),
      ]);
      expect(rtv.map((r) => [r.type, r.qty, r.batchNo])).toEqual([
        ["MARK_OUT", -4, "LOT-B"],
        ["RTV_OUT", -1, "LOT-B"],
        ["RTV_OUT", -2, "LOT-A"],
      ]);
      expect(nonZero(await batchesOf(t, milk))).toEqual([]);
      expect(await balanceQty(t, milk)).toBe(0);
      expect(await batchDrift(t)).toEqual([]);
    });
  });

  it("stock with no expiry recorded sits in one undated bucket that goes out first", async () => {
    await withTx(async (t) => {
      const milk = await trackedItem(t);
      await postMovements(t, [
        mv(milk, "OPENING", 3, { unitCost: 30 }),
        mv(milk, "GRN_IN", 5, { unitCost: 40, ...lot("LOT-A", "2026-11-20") }),
        // a batch number with no expiry is its own bucket, also undated
        mv(milk, "GRN_IN", 2, { unitCost: 40, batchNo: "NOEXP-1" }),
        // an expiry with no batch number is a dated bucket of its own
        mv(milk, "GRN_IN", 1, { unitCost: 40, expiryDate: "2026-11-01" }),
      ]);
      expect(await batchesOf(t, milk)).toEqual([
        { batchNo: "", expiryDate: "2026-11-01", qty: 1 },
        { batchNo: "LOT-A", expiryDate: "2026-11-20", qty: 5 },
        { batchNo: "", expiryDate: NO_EXPIRY_DATE, qty: 3 },
        { batchNo: "NOEXP-1", expiryDate: NO_EXPIRY_DATE, qty: 2 },
      ]);

      const rows = await postMovements(t, [mv(milk, "COUNT_OUT", -7)]);
      // undated first (plain, then by batch number), then by expiry date
      expect(rows.map((r) => [r.qty, r.batchNo, r.expiryDate])).toEqual([
        [-3, null, null],
        [-2, "NOEXP-1", null],
        [-1, null, "2026-11-01"],
        [-1, "LOT-A", "2026-11-20"],
      ]);
      expect(nonZero(await batchesOf(t, milk))).toEqual([{ batchNo: "LOT-A", expiryDate: "2026-11-20", qty: 4 }]);

      // returns and count gains with no batch go back to the undated bucket;
      // a return that names its batch goes back to that batch
      await postMovements(t, [
        mv(milk, "RETURN_IN", 1, { departmentId: FB }),
        mv(milk, "RETURN_IN", 2, { departmentId: FB, ...lot("LOT-A", "2026-11-20") }),
        mv(milk, "COUNT_IN", 1),
      ]);
      expect(nonZero(await batchesOf(t, milk))).toEqual([
        { batchNo: "LOT-A", expiryDate: "2026-11-20", qty: 6 },
        { batchNo: "", expiryDate: NO_EXPIRY_DATE, qty: 2 },
      ]);
      // the item card shows the undated bucket with no expiry date
      await grantCast(t);
      const card = await getStockItem(t, STORE, { hotelId: A1, invItemId: milk });
      expect(card.batches).toEqual([
        { batchNo: "LOT-A", expiryDate: "2026-11-20", qty: 6 },
        { batchNo: null, expiryDate: null, qty: 2 },
      ]);
      // a negative opening delta is an outbound like any other
      await postMovements(t, [mv(milk, "OPENING", -3)]);
      expect(nonZero(await batchesOf(t, milk))).toEqual([{ batchNo: "LOT-A", expiryDate: "2026-11-20", qty: 5 }]);
      expect(await batchDrift(t)).toEqual([]);
    });
  });

  it("receipt then mark out on arrival in one call takes the batch just received", async () => {
    await withTx(async (t) => {
      const milk = await trackedItem(t);
      await postMovements(t, [mv(milk, "GRN_IN", 4, { unitCost: 40, ...lot("OLD", "2026-11-01") })]);
      const rows = await postMovements(t, [
        mv(milk, "GRN_IN", 6, { unitCost: 40, sourceLineId: 5, ...lot("NEW", "2027-02-01") }),
        mv(milk, "MARK_OUT", -6, { departmentId: FB, sourceLineId: 5, ...lot("NEW", "2027-02-01") }),
      ]);
      expect(rows.map((r) => [r.type, r.qty, r.batchNo])).toEqual([["GRN_IN", 6, "NEW"], ["MARK_OUT", -6, "NEW"]]);
      expect(nonZero(await batchesOf(t, milk))).toEqual([{ batchNo: "OLD", expiryDate: "2026-11-01", qty: 4 }]);
    });
  });

  it("items that do not track expiry keep no batches and are never split", async () => {
    await withTx(async (t) => {
      const soap = await makeItem(t, { name: "Soap", stockUom: "pcs" });
      await postMovements(t, [
        mv(soap, "GRN_IN", 4, { unitCost: 10, ...lot("S-1", "2026-11-20") }),
        mv(soap, "GRN_IN", 4, { unitCost: 10, ...lot("S-2", "2026-12-20") }),
      ]);
      const rows = await postMovements(t, [mv(soap, "MARK_OUT", -6)]);
      expect(rows).toEqual([expect.objectContaining({ qty: -6, batchNo: null, expiryDate: null })]);
      expect(await batchesOf(t, soap)).toEqual([]);
    });
  });

  it("an item that starts tracking expiry folds the stock it already holds into the undated bucket", async () => {
    await withTx(async (t) => {
      const curd = await makeItem(t, { name: "Curd", stockUom: "pcs" });
      await postMovements(t, [mv(curd, "OPENING", 10, { unitCost: 20 })]);
      await t.none(`UPDATE tbl_inv_item SET track_expiry = true WHERE id = $1`, [curd]);
      await postMovements(t, [mv(curd, "GRN_IN", 5, { unitCost: 20, ...lot("C-1", "2026-11-30") })]);
      expect(await batchesOf(t, curd)).toEqual([
        { batchNo: "C-1", expiryDate: "2026-11-30", qty: 5 },
        { batchNo: "", expiryDate: NO_EXPIRY_DATE, qty: 10 },
      ]);
      expect(await batchDrift(t)).toEqual([]);
    });
  });

  it("with negative stock allowed the deficit sits undated, and the next receipt fills it first", async () => {
    await withTx(async (t) => {
      await setCompanySettings(t, { allowNegative: true });
      const milk = await trackedItem(t);
      await postMovements(t, [mv(milk, "GRN_IN", 2, { unitCost: 40, ...lot("LOT-A", "2026-11-20") })]);
      const rows = await postMovements(t, [mv(milk, "MARK_OUT", -5)]);
      expect(rows.map((r) => [r.qty, r.batchNo, r.qtyAfter])).toEqual([[-2, "LOT-A", 0], [-3, null, -3]]);
      expect(nonZero(await batchesOf(t, milk))).toEqual([{ batchNo: "", expiryDate: NO_EXPIRY_DATE, qty: -3 }]);

      // 5 arrive: 3 of them cover what was already issued, 2 are left in LOT-B
      await postMovements(t, [mv(milk, "GRN_IN", 5, { unitCost: 40, ...lot("LOT-B", "2026-12-10") })]);
      expect(nonZero(await batchesOf(t, milk))).toEqual([{ batchNo: "LOT-B", expiryDate: "2026-12-10", qty: 2 }]);
      expect(await balanceQty(t, milk)).toBe(2);
      // reversals stay guarded per item, whatever the batches say
      const err = await thrownBy(t, (sp) => postMovements(sp, [mv(milk, "GRN_REVERSAL", -5, { unitCost: 40, ...lot("LOT-B", "2026-12-10") })]));
      expect(err.code).toBe("NEGATIVE_STOCK");
      expect(err.details).toMatchObject({ available: 2, requested: 5 });
    });
  });
});

describe("invariant", () => {
  it("batch qty sums equal balance for tracked items", async () => {
    await withTx(async (t) => {
      await setCompanySettings(t, { allowNegative: true });
      const items = [await trackedItem(t, "Tracked 1"), await trackedItem(t, "Tracked 2")];
      const hotels = [A1, A2];
      const lots = [lot("L1", "2026-11-05"), lot("L2", "2026-12-01"), lot("L3", "2027-03-01"), lot(null, null), lot("L4", null)];
      // deterministic pseudo-random walk (no flaky seeds)
      let seed = 7;
      const rnd = (n) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
      };
      const outbound = ["MARK_OUT", "ADJUST_OUT", "COUNT_OUT", "OPENING"];
      for (let step = 0; step < 60; step += 1) {
        const batch = [];
        for (let k = 0; k <= rnd(3); k += 1) {
          const invItemId = items[rnd(2)];
          const hotelId = hotels[rnd(2)];
          const qty = (rnd(700) + 1) / 100;
          const which = lots[rnd(lots.length)];
          if (rnd(5) < 3) {
            batch.push({ ...mv(invItemId, rnd(2) ? "GRN_IN" : "OPENING", qty, { unitCost: 10 + rnd(50) }), hotelId, ...which });
          } else {
            const named = rnd(3) === 0 ? which : {};
            batch.push({ ...mv(invItemId, outbound[rnd(outbound.length)], -qty, named), hotelId });
          }
        }
        await postMovements(t, batch);
      }
      expect(await batchDrift(t)).toEqual([]);
      // no dated batch ever goes below zero; the undated bucket only does when
      // the balance itself is negative, and then it holds the whole deficit
      const bad = await t.any(
        `SELECT bt.hotel_id, bt.inv_item_id, bt.batch_no, bt.expiry_date::text, bt.qty::text, b.qty::text AS balance
           FROM tbl_inv_batch bt
           JOIN tbl_inv_balance b ON b.hotel_id = bt.hotel_id AND b.inv_item_id = bt.inv_item_id
          WHERE bt.inv_item_id = ANY($1::int[])
            AND bt.qty < 0
            AND NOT (bt.batch_no = '' AND bt.expiry_date = $2::date AND bt.qty = b.qty)`,
        [items, NO_EXPIRY_DATE]
      );
      expect(bad).toEqual([]);
      // the ledger's own invariant still holds
      const qtyDrift = await t.any(
        `SELECT b.hotel_id, b.inv_item_id FROM tbl_inv_balance b
           LEFT JOIN (SELECT hotel_id, inv_item_id, sum(qty) AS qty FROM tbl_inv_movement GROUP BY 1, 2) m
                  ON m.hotel_id = b.hotel_id AND m.inv_item_id = b.inv_item_id
          WHERE b.inv_item_id = ANY($1::int[]) AND b.qty <> COALESCE(m.qty, 0)`,
        [items]
      );
      expect(qtyDrift).toEqual([]);
    });
  });
});

describe("documents read a split line as one line", () => {
  it("a mark-out split across batches shows one line with its whole value", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const milk = await trackedItem(t);
      await postMovements(t, [
        mv(milk, "GRN_IN", 3, { unitCost: 40, ...lot("LOT-A", "2026-11-20") }),
        mv(milk, "GRN_IN", 5, { unitCost: 40, ...lot("LOT-B", "2026-12-10") }),
      ]);
      const { doc } = await postOut(t, STORE, {
        hotelId: A1, docType: "OUT", departmentId: FB, clientEventId: randomUUID(), lines: [{ invItemId: milk, qty: 5 }],
      });
      expect(doc.lines).toEqual([expect.objectContaining({ invItemId: milk, qty: 5, unitCost: 40, value: 200 })]);
      expect(doc.totalValue).toBe(200);
      const split = await t.any(`SELECT batch_no, qty::float AS qty FROM tbl_inv_movement WHERE source_type = 'OUT' AND source_id = $1 ORDER BY id`, [doc.id]);
      expect(split).toEqual([{ batch_no: "LOT-A", qty: -3 }, { batch_no: "LOT-B", qty: -2 }]);
    });
  });

  it("an adjustment split across batches shows one line, and the list counts it once", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      await setCompanySettings(t, { autoApproveLimit: 100000 });
      const milk = await trackedItem(t);
      await postMovements(t, [
        mv(milk, "GRN_IN", 2, { unitCost: 40, ...lot("LOT-A", "2026-11-20") }),
        mv(milk, "GRN_IN", 5, { unitCost: 40, ...lot("LOT-B", "2026-12-10") }),
      ]);
      const { adjustment } = await createAdjustment(t, STORE, {
        hotelId: A1, reasonCode: "EXPIRY", submit: true, clientEventId: randomUUID(), lines: [{ invItemId: milk, qty: -4 }],
      });
      expect(adjustment.status).toBe("posted");
      const detail = await getAdjustment(t, STORE, adjustment.id);
      expect(detail.lines).toEqual([expect.objectContaining({ invItemId: milk, qty: -4, value: -160 })]);
      expect(detail.value).toBe(160);
      const list = await listAdjustments(t, STORE, { hotelId: A1 });
      expect(list.rows.find((r) => r.id === adjustment.id)).toMatchObject({ lineCount: 1, value: 160 });
    });
  });

  it("an approved count that splits a loss across batches keeps the whole variance value", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const milk = await trackedItem(t);
      await postMovements(t, [
        mv(milk, "GRN_IN", 2, { unitCost: 40, ...lot("LOT-A", "2026-11-20") }),
        mv(milk, "GRN_IN", 5, { unitCost: 40, ...lot("LOT-B", "2026-12-10") }),
      ]);
      const count = await startCount(t, STORE, { hotelId: A1, scope: "SELECTED", invItemIds: [milk] });
      await saveCountLines(t, STORE, count.id, [{ invItemId: milk, countedQty: 3, clientEventId: randomUUID() }]);
      const submitted = await submitCount(t, STORE, count.id);
      const lineId = submitted.lines.find((l) => l.invItemId === milk).id;
      const approved = await approveCount(t, CTRL, count.id, { [lineId]: "Expired in the chiller" });
      expect(approved.lines.find((l) => l.invItemId === milk)).toMatchObject({ varianceQty: -4, varianceValue: -160 });
      expect(nonZero(await batchesOf(t, milk))).toEqual([{ batchNo: "LOT-B", expiryDate: "2026-12-10", qty: 3 }]);
    });
  });
});

describe("concurrency", () => {
  it("two concurrent mark-outs of one tracked item never take the same batch twice", async () => {
    const milk = await db.tx(async (t) => {
      const id = await trackedItem(t, "Concurrent milk");
      await postMovements(t, [
        mv(id, "GRN_IN", 5, { unitCost: 40, ...lot("LOT-A", "2026-11-20") }),
        mv(id, "GRN_IN", 5, { unitCost: 40, ...lot("LOT-B", "2026-12-10") }),
      ]);
      return id;
    });
    // Hold the balance row so both posters queue behind it, then let them race.
    let release;
    const gate = new Promise((r) => { release = r; });
    const holder = db.tx(async (t) => {
      await t.one(`SELECT qty FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = $2 FOR UPDATE`, [A1, milk]);
      await gate;
    });
    const posters = [1, 2].map(() => db.tx((t) => postMovements(t, [mv(milk, "MARK_OUT", -4)])));
    await new Promise((r) => setTimeout(r, 150));
    release();
    await Promise.all([holder, ...posters]);

    await withTx(async (t) => {
      expect(await balanceQty(t, milk)).toBe(2);
      expect(nonZero(await batchesOf(t, milk))).toEqual([{ batchNo: "LOT-B", expiryDate: "2026-12-10", qty: 2 }]);
      const rows = await movementRows(t, milk);
      expect(rows.filter((r) => r.type === "MARK_OUT").map((r) => [r.qty, r.batch_no])).toEqual([
        [-4, "LOT-A"],
        [-1, "LOT-A"],
        [-3, "LOT-B"],
      ]);
      expect(await batchDrift(t)).toEqual([]);
    });
  });
});
