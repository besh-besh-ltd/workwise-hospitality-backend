// Inventory stock ledger (Task A2): ledger.postMovements is the ONLY writer of
// tbl_inv_movement and tbl_inv_balance, so every receipt, mark-out, count and
// return-to-vendor inherits what is proven here: weighted-average valuation,
// the negative-stock guard, and serialisation of concurrent posts.
//
// Most tests run inside withTx (always rolled back). The concurrency block
// needs real committed transactions, so it cleans up with TRUNCATE: the ledger
// is append-only and DELETE on tbl_inv_movement is refused by its trigger.

import { describe, it, expect, afterAll, afterEach } from "@jest/globals";
import { db, withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { postMovements } from "../../app/services/inventory/ledger.js";
import { InventoryError } from "../../app/services/inventory/errors.js";

const CO = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const USER = IDS.users.a1_proc_buyer;
const DEPT = IDS.departments.fb;

afterAll(async () => {
  await closeDb();
});

async function makeItem(conn, name = "Ledger test soap", companyId = CO) {
  const row = await conn.one(
    `INSERT INTO tbl_inv_item (hospitality_company_id, display_name, stock_uom)
     VALUES ($1, $2, 'pcs') RETURNING id`,
    [companyId, name]
  );
  return Number(row.id);
}

/** One movement in the shape postMovements takes. */
function mv(invItemId, type, qty, extra = {}) {
  return {
    companyId: CO,
    hotelId: HOTEL,
    invItemId,
    type,
    qty,
    sourceType: "TEST",
    sourceId: 1,
    postedBy: USER,
    ...extra,
  };
}

async function balanceOf(conn, invItemId, hotelId = HOTEL) {
  const row = await conn.oneOrNone(
    `SELECT qty::text AS qty, avg_cost::text AS avg_cost, value::text AS value
       FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = $2`,
    [hotelId, invItemId]
  );
  if (!row) return null;
  return { qty: Number(row.qty), avgCost: Number(row.avg_cost), value: Number(row.value) };
}

async function movementsOf(conn, invItemId, hotelId = HOTEL) {
  const rows = await conn.any(
    `SELECT movement_type, qty::text AS qty, unit_cost::text AS unit_cost, value::text AS value,
            qty_after::text AS qty_after, avg_cost_after::text AS avg_cost_after
       FROM tbl_inv_movement WHERE hotel_id = $1 AND inv_item_id = $2 ORDER BY id`,
    [hotelId, invItemId]
  );
  return rows.map((r) => ({
    type: r.movement_type,
    qty: Number(r.qty),
    unitCost: Number(r.unit_cost),
    value: Number(r.value),
    qtyAfter: Number(r.qty_after),
    avgCostAfter: Number(r.avg_cost_after),
  }));
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

/** 10 @100 then 10 @200: the opening position most tests start from. */
async function receiveTwoLots(t, item) {
  await postMovements(t, [mv(item, "GRN_IN", 10, { unitCost: 100 })]);
  return postMovements(t, [mv(item, "GRN_IN", 10, { unitCost: 200 })]);
}

describe("valuation", () => {
  it("weighted average updates on inbound", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t);
      const [second] = await receiveTwoLots(t, item);

      expect(second).toMatchObject({ type: "GRN_IN", qty: 10, unitCost: 200, value: 2000, qtyAfter: 20, avgCostAfter: 150 });
      expect(await balanceOf(t, item)).toEqual({ qty: 20, avgCost: 150, value: 3000 });
    });
  });

  it("outbound valued at average", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t);
      await receiveTwoLots(t, item);

      const [out] = await postMovements(t, [mv(item, "MARK_OUT", -5, { departmentId: DEPT })]);

      expect(out).toMatchObject({ type: "MARK_OUT", qty: -5, unitCost: 150, value: -750, qtyAfter: 15, avgCostAfter: 150, departmentId: DEPT });
      expect(await balanceOf(t, item)).toEqual({ qty: 15, avgCost: 150, value: 2250 });
    });
  });

  it("issuing the whole balance leaves no value behind", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t);
      // 2 @10 + 1 @11 = 31 over 3 units: avg 10.3333 (rounded). Issued one
      // at a time at 10.3333, the last issue takes the 10.3334 that is left,
      // so the balance ends at 0 / 0 instead of a 0.0001 residue.
      await postMovements(t, [mv(item, "GRN_IN", 2, { unitCost: 10 }), mv(item, "GRN_IN", 1, { unitCost: 11 })]);
      const outs = await postMovements(t, [1, 2, 3].map(() => mv(item, "MARK_OUT", -1, { departmentId: DEPT })));

      expect(outs.map((o) => o.value)).toEqual([-10.3333, -10.3333, -10.3334]);
      expect(await balanceOf(t, item)).toEqual({ qty: 0, avgCost: 10.3333, value: 0 });
      const sum = await t.one(
        `SELECT sum(value)::text AS v FROM tbl_inv_movement WHERE hotel_id = $1 AND inv_item_id = $2`,
        [HOTEL, item]
      );
      expect(Number(sum.v)).toBe(0);
    });
  });

  it("reversal is valued at the receipt cost and re-averages the rest", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t);
      await receiveTwoLots(t, item); // 20 @150, value 3000

      // Reversing the 10 @100 lot leaves the 10 @200 lot.
      const [rev] = await postMovements(t, [mv(item, "GRN_REVERSAL", -10, { unitCost: 100 })]);
      expect(rev).toMatchObject({ qty: -10, unitCost: 100, value: -1000, qtyAfter: 10, avgCostAfter: 200 });
      expect(await balanceOf(t, item)).toEqual({ qty: 10, avgCost: 200, value: 2000 });

      // Without a unit cost an RTV is valued at the average.
      const [rtv] = await postMovements(t, [mv(item, "RTV_OUT", -4)]);
      expect(rtv).toMatchObject({ unitCost: 200, value: -800, qtyAfter: 6, avgCostAfter: 200 });
    });
  });

  it("a reversal dearer than the remaining value writes the difference off", async () => {
    await withTx(async (t) => {
      // 10 @100 + 5 @400 = 3000 over 15 (avg 200). Mark out 9 at 200 leaves
      // 6 units worth 1200. Reversing the dearer lot at its receipt cost takes
      // 2000 out of 1200: the balance value floors at 0 (avg 0) and the 800
      // gap is written off. Quantity still reconciles; value does not.
      const item = await makeItem(t);
      await postMovements(t, [mv(item, "GRN_IN", 10, { unitCost: 100 }), mv(item, "GRN_IN", 5, { unitCost: 400 })]);
      await postMovements(t, [mv(item, "MARK_OUT", -9, { departmentId: DEPT })]);

      const [rev] = await postMovements(t, [mv(item, "GRN_REVERSAL", -5, { unitCost: 400 })]);
      expect(rev).toMatchObject({ qty: -5, unitCost: 400, value: -2000, qtyAfter: 1, avgCostAfter: 0 });
      expect(await balanceOf(t, item)).toEqual({ qty: 1, avgCost: 0, value: 0 });

      // A reversal that empties the balance keeps the average and zeroes the value.
      const other = await makeItem(t, "Ledger write-off to zero");
      await postMovements(t, [mv(other, "GRN_IN", 10, { unitCost: 100 }), mv(other, "GRN_IN", 10, { unitCost: 200 })]);
      await postMovements(t, [mv(other, "MARK_OUT", -10, { departmentId: DEPT })]); // 1500 left
      const [empty] = await postMovements(t, [mv(other, "GRN_REVERSAL", -10, { unitCost: 200 })]);
      expect(empty).toMatchObject({ value: -2000, qtyAfter: 0, avgCostAfter: 150 });
      expect(await balanceOf(t, other)).toEqual({ qty: 0, avgCost: 150, value: 0 });

      const sums = await t.any(
        `SELECT m.inv_item_id, sum(m.qty)::text AS qty, sum(m.value)::text AS value,
                b.qty::text AS b_qty, b.value::text AS b_value
           FROM tbl_inv_movement m
           JOIN tbl_inv_balance b ON b.hotel_id = m.hotel_id AND b.inv_item_id = m.inv_item_id
          WHERE m.hotel_id = $1 AND m.inv_item_id = ANY($2::int[])
          GROUP BY m.inv_item_id, b.qty, b.value
          ORDER BY m.inv_item_id`,
        [HOTEL, [item, other]]
      );
      expect(sums.map((s) => [s.qty === s.b_qty, Number(s.value), Number(s.b_value)])).toEqual([
        [true, -800, 0],
        [true, -500, 0],
      ]);
    });
  });

  it("returns, count gains and found stock default to the average cost", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t);
      await receiveTwoLots(t, item); // 20 @150
      await postMovements(t, [mv(item, "MARK_OUT", -5, { departmentId: DEPT })]);

      const rows = await postMovements(t, [
        mv(item, "RETURN_IN", 2, { departmentId: DEPT }),
        mv(item, "COUNT_IN", 1),
        mv(item, "ADJUST_IN", 1, { reasonCode: "FOUND" }),
      ]);
      expect(rows.map((r) => [r.type, r.unitCost, r.value, r.qtyAfter])).toEqual([
        ["RETURN_IN", 150, 300, 17],
        ["COUNT_IN", 150, 150, 18],
        ["ADJUST_IN", 150, 150, 19],
      ]);
      expect(await balanceOf(t, item)).toEqual({ qty: 19, avgCost: 150, value: 2850 });

      // Everything issued: the average is still known, so a return values at it.
      await postMovements(t, [mv(item, "MARK_OUT", -19, { departmentId: DEPT })]);
      const [back] = await postMovements(t, [mv(item, "RETURN_IN", 1, { departmentId: DEPT })]);
      expect(back).toMatchObject({ unitCost: 150, value: 150, qtyAfter: 1, avgCostAfter: 150 });

      // An explicit unit cost still wins.
      const [priced] = await postMovements(t, [mv(item, "RETURN_IN", 1, { unitCost: 50, departmentId: DEPT })]);
      expect(priced).toMatchObject({ unitCost: 50, value: 50, qtyAfter: 2, avgCostAfter: 100 });
    });
  });

  it("without an average cost yet, a unit cost is required", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t);
      for (const type of ["RETURN_IN", "COUNT_IN", "ADJUST_IN"]) {
        const err = await thrownBy(t, (sp) => postMovements(sp, [mv(item, type, 1)]));
        expect(err).toBeInstanceOf(InventoryError);
        expect(err.code).toBe("VALIDATION");
        expect(err.details).toMatchObject({ index: 0, field: "unitCost", hotelId: HOTEL, invItemId: item });
        expect(err.message).toMatch(/unit cost/i);
      }
      // A receipt or an opening balance never falls back to the average.
      await postMovements(t, [mv(item, "GRN_IN", 4, { unitCost: 25 })]);
      for (const type of ["GRN_IN", "OPENING"]) {
        const err = await thrownBy(t, (sp) => postMovements(sp, [mv(item, type, 1)]));
        expect(err.details).toMatchObject({ index: 0, field: "unitCost" });
      }
      expect(await movementsOf(t, item)).toHaveLength(1);
    });
  });

  it("receipt then mark out on arrival in one call nets to zero", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t);
      const rows = await postMovements(t, [
        mv(item, "GRN_IN", 12, { unitCost: 7.5, sourceType: "GRN", sourceLineId: 3 }),
        mv(item, "MARK_OUT", -12, { departmentId: DEPT, sourceType: "GRN", sourceLineId: 3 }),
      ]);

      expect(rows.map((r) => [r.type, r.qtyAfter, r.value])).toEqual([
        ["GRN_IN", 12, 90],
        ["MARK_OUT", 0, -90],
      ]);
      expect(rows[0].id).toBeLessThan(rows[1].id);
      expect(await balanceOf(t, item)).toEqual({ qty: 0, avgCost: 7.5, value: 0 });
    });
  });
});

describe("guards", () => {
  it("negative stock blocked", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t);
      await receiveTwoLots(t, item);
      await postMovements(t, [mv(item, "MARK_OUT", -5, { departmentId: DEPT })]);

      const err = await thrownBy(t, (sp) =>
        postMovements(sp, [mv(item, "MARK_OUT", -16, { departmentId: DEPT })])
      );
      expect(err).toBeInstanceOf(InventoryError);
      expect(err.code).toBe("NEGATIVE_STOCK");
      expect(err.httpStatus).toBe(409);
      expect(err.details).toMatchObject({ hotelId: HOTEL, invItemId: item, available: 15, requested: 16 });
      expect(err.message).toBe("Not enough stock of Ledger test soap: 15 available, 16 requested");

      // Nothing was written.
      expect(await balanceOf(t, item)).toEqual({ qty: 15, avgCost: 150, value: 2250 });
      expect(await movementsOf(t, item)).toHaveLength(3);
    });
  });

  it("every short movement is reported at once", async () => {
    await withTx(async (t) => {
      const soap = await makeItem(t, "Ledger soap");
      const towel = await makeItem(t, "Ledger towel");
      const ok = await makeItem(t, "Ledger shampoo");
      await postMovements(t, [
        mv(soap, "GRN_IN", 2, { unitCost: 1 }),
        mv(ok, "GRN_IN", 9, { unitCost: 1 }),
      ]);

      const err = await thrownBy(t, (sp) =>
        postMovements(sp, [
          mv(soap, "MARK_OUT", -3, { departmentId: DEPT, sourceLineId: 11 }),
          mv(ok, "MARK_OUT", -9, { departmentId: DEPT, sourceLineId: 12 }),
          mv(towel, "MARK_OUT", -1, { departmentId: DEPT, sourceLineId: 13 }),
        ])
      );
      expect(err.code).toBe("NEGATIVE_STOCK");
      expect(err.details.lines).toEqual([
        { index: 0, hotelId: HOTEL, invItemId: soap, sourceLineId: 11, itemName: "Ledger soap", available: 2, requested: 3 },
        { index: 2, hotelId: HOTEL, invItemId: towel, sourceLineId: 13, itemName: "Ledger towel", available: 0, requested: 1 },
      ]);
      // The first short line is also at the top level.
      expect(err.details).toMatchObject({ invItemId: soap, available: 2, requested: 3 });
      expect(err.message).toMatch(/2 lines/);
      expect(await balanceOf(t, ok)).toEqual({ qty: 9, avgCost: 1, value: 9 });
    });
  });

  it("negative stock allowed when setting on", async () => {
    await withTx(async (t) => {
      await t.none(
        `INSERT INTO tbl_inv_company_settings (hospitality_company_id, allow_negative_stock)
         VALUES ($1, true)
         ON CONFLICT (hospitality_company_id) DO UPDATE SET allow_negative_stock = true`,
        [CO]
      );
      const item = await makeItem(t);
      await receiveTwoLots(t, item);
      await postMovements(t, [mv(item, "MARK_OUT", -5, { departmentId: DEPT })]);

      const [out] = await postMovements(t, [mv(item, "MARK_OUT", -16, { departmentId: DEPT })]);

      expect(out).toMatchObject({ qty: -16, unitCost: 150, value: -2400, qtyAfter: -1 });
      expect(await balanceOf(t, item)).toMatchObject({ qty: -1, avgCost: 150 });
    });
  });

  it("reversals and returns to vendor never go negative, even when negative stock is allowed", async () => {
    await withTx(async (t) => {
      await t.none(
        `INSERT INTO tbl_inv_company_settings (hospitality_company_id, allow_negative_stock)
         VALUES ($1, true)
         ON CONFLICT (hospitality_company_id) DO UPDATE SET allow_negative_stock = true`,
        [CO]
      );
      const item = await makeItem(t);
      await postMovements(t, [mv(item, "GRN_IN", 10, { unitCost: 100 })]);
      await postMovements(t, [mv(item, "MARK_OUT", -6, { departmentId: DEPT })]);

      const reversal = await thrownBy(t, (sp) =>
        postMovements(sp, [mv(item, "GRN_REVERSAL", -10, { unitCost: 100, sourceType: "GRN" })])
      );
      expect(reversal).toBeInstanceOf(InventoryError);
      expect(reversal.code).toBe("NEGATIVE_STOCK");
      expect(reversal.details).toMatchObject({ invItemId: item, available: 4, requested: 10 });

      const rtv = await thrownBy(t, (sp) => postMovements(sp, [mv(item, "RTV_OUT", -5, { sourceType: "RTV" })]));
      expect(rtv.code).toBe("NEGATIVE_STOCK");

      // The setting still lets an ordinary mark-out through.
      const [out] = await postMovements(t, [mv(item, "MARK_OUT", -5, { departmentId: DEPT })]);
      expect(out.qtyAfter).toBe(-1);
    });
  });

  it("zero movements are dropped and wrong signs are refused", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t);

      expect(await postMovements(t, [mv(item, "COUNT_IN", 0, { unitCost: 5 })])).toEqual([]);
      expect(await postMovements(t, [])).toEqual([]);
      expect(await movementsOf(t, item)).toEqual([]);

      const wrongSign = await thrownBy(t, (sp) => postMovements(sp, [mv(item, "MARK_OUT", 5)]));
      expect(wrongSign).toMatchObject({ code: "VALIDATION", httpStatus: 400 });
      expect(wrongSign.details).toMatchObject({ index: 0, field: "qty" });

      const inboundWrongSign = await thrownBy(t, (sp) =>
        postMovements(sp, [mv(item, "GRN_IN", -1, { unitCost: 5 })])
      );
      expect(inboundWrongSign.code).toBe("VALIDATION");

      const noCost = await thrownBy(t, (sp) => postMovements(sp, [mv(item, "GRN_IN", 5)]));
      expect(noCost.code).toBe("VALIDATION");
      expect(noCost.details).toMatchObject({ index: 0, field: "unitCost" });

      const badType = await thrownBy(t, (sp) => postMovements(sp, [mv(item, "SHRINK", -1)]));
      expect(badType.code).toBe("VALIDATION");

      expect(await balanceOf(t, item)).toBeNull();
    });
  });

  it("an item or hotel from another company is refused", async () => {
    await withTx(async (t) => {
      const foreignItem = await makeItem(t, "Company B soap", IDS.hospitality.B);
      const err = await thrownBy(t, (sp) =>
        postMovements(sp, [mv(foreignItem, "GRN_IN", 1, { unitCost: 1 })])
      );
      expect(err.code).toBe("VALIDATION");

      const item = await makeItem(t);
      const foreignHotel = await thrownBy(t, (sp) =>
        postMovements(sp, [mv(item, "GRN_IN", 1, { unitCost: 1, hotelId: IDS.hotels.B1 })])
      );
      expect(foreignHotel.code).toBe("VALIDATION");
    });
  });
});

// Deterministic PRNG so a failure reproduces.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe("invariant", () => {
  it("invariant holds", async () => {
    await withTx(async (t) => {
      const rand = mulberry32(20261024);
      const pick = (arr) => arr[Math.floor(rand() * arr.length)];
      const hotels = [IDS.hotels.A1, IDS.hotels.A2];
      const items = [await makeItem(t, "Inv A"), await makeItem(t, "Inv B"), await makeItem(t, "Inv C")];
      const onHand = new Map(); // `${hotel}:${item}` -> qty (in 1/4 units, to stay exact)
      const key = (h, i) => `${h}:${i}`;

      let posted = 0;
      while (posted < 50) {
        const batch = [];
        const size = 1 + Math.floor(rand() * 4);
        for (let n = 0; n < size && posted < 50; n += 1, posted += 1) {
          const hotelId = pick(hotels);
          const invItemId = pick(items);
          const have = onHand.get(key(hotelId, invItemId)) || 0;
          const quarters = 1 + Math.floor(rand() * 80); // 0.25 .. 20
          const outbound = have > 0 && rand() < 0.5;
          if (outbound) {
            const take = Math.min(have, quarters);
            onHand.set(key(hotelId, invItemId), have - take);
            batch.push(mv(invItemId, pick(["MARK_OUT", "ADJUST_OUT", "COUNT_OUT", "RTV_OUT"]), -take / 4, {
              hotelId,
              departmentId: DEPT,
            }));
          } else {
            onHand.set(key(hotelId, invItemId), have + quarters);
            batch.push(mv(invItemId, pick(["GRN_IN", "RETURN_IN", "ADJUST_IN", "COUNT_IN", "OPENING"]), quarters / 4, {
              hotelId,
              unitCost: Math.round(rand() * 50000) / 100, // 0.00 .. 500.00
            }));
          }
        }
        await postMovements(t, batch);
      }

      const rows = await t.any(
        `SELECT b.hotel_id, b.inv_item_id,
                b.qty::text AS qty, b.value::text AS value, b.avg_cost::text AS avg_cost,
                (SELECT sum(m.qty) FROM tbl_inv_movement m
                  WHERE m.hotel_id = b.hotel_id AND m.inv_item_id = b.inv_item_id)::text AS sum_qty,
                (SELECT sum(m.value) FROM tbl_inv_movement m
                  WHERE m.hotel_id = b.hotel_id AND m.inv_item_id = b.inv_item_id)::text AS sum_value
           FROM tbl_inv_balance b
          WHERE b.inv_item_id = ANY($1::int[])`,
        [items]
      );
      expect(rows.length).toBeGreaterThan(1);
      for (const r of rows) {
        expect(r.qty).toBe(r.sum_qty);
        expect(r.value).toBe(r.sum_value);
        expect(Number(r.qty) * 4).toBe(onHand.get(key(r.hotel_id, r.inv_item_id)));
        if (Number(r.qty) > 0) {
          expect(Math.abs(Number(r.value) / Number(r.qty) - Number(r.avg_cost))).toBeLessThanOrEqual(0.00005);
        }

        // Each row's qty_after is the running sum up to and including it.
        const chain = await movementsOf(t, r.inv_item_id, r.hotel_id);
        let running = 0;
        for (const m of chain) {
          running = Math.round((running + m.qty) * 10000) / 10000;
          expect(m.qtyAfter).toBe(running);
        }
        expect(chain[chain.length - 1].avgCostAfter).toBe(Number(r.avg_cost));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrency: real, committed, overlapping transactions.
// ---------------------------------------------------------------------------

/** Resolves for everyone once `n` callers have arrived, so both txs are open before either posts. */
function barrier(n) {
  let arrived = 0;
  let release;
  const all = new Promise((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === n) release();
    await all;
  };
}

describe("concurrency", () => {
  const created = [];

  afterEach(async () => {
    await db.none(`TRUNCATE tbl_inv_movement, tbl_inv_balance`);
    if (created.length) {
      await db.none(`DELETE FROM tbl_inv_item WHERE id = ANY($1::int[])`, [created.splice(0)]);
    }
  });

  async function committedItem(name) {
    const id = await makeItem(db, name);
    created.push(id);
    return id;
  }

  /**
   * A db.tx that opens, waits at the gate, then posts. `largeTablePlan` makes
   * Postgres plan the way it would against a production-sized balance table
   * (index nested loop, rows visited in input order) instead of the hash join
   * a near-empty test table gets, whose physical-order scan would hide a lock
   * order that depends on the caller's input order.
   */
  const postAfter = (gate, movements, { largeTablePlan = false } = {}) =>
    db.tx(async (t) => {
      if (largeTablePlan) {
        await t.none("SET LOCAL enable_hashjoin = off; SET LOCAL enable_mergejoin = off; SET LOCAL enable_seqscan = off");
      }
      await t.one("SELECT 1");
      await gate();
      return postMovements(t, movements);
    });

  it("concurrent posts serialize", async () => {
    const item = await committedItem("Concurrent soap");
    await db.tx((t) => postMovements(t, [mv(item, "GRN_IN", 15, { unitCost: 10 })]));

    const gate = barrier(2);
    const take10 = () => postAfter(gate, [mv(item, "MARK_OUT", -10, { departmentId: DEPT })]);
    const results = await Promise.allSettled([take10(), take10()]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(InventoryError);
    expect(refused[0].reason.code).toBe("NEGATIVE_STOCK");
    expect(refused[0].reason.details).toMatchObject({ available: 5, requested: 10 });

    expect(await balanceOf(db, item)).toEqual({ qty: 5, avgCost: 10, value: 50 });
    const mvs = await movementsOf(db, item);
    expect(mvs.map((m) => [m.type, m.qtyAfter])).toEqual([
      ["GRN_IN", 15],
      ["MARK_OUT", 5],
    ]);
  });

  it("posted_at follows lock order: a transaction that opened first but posts last is stamped last", async () => {
    const item = await committedItem("Stamp soap");
    const towel = await committedItem("Stamp towel");
    await db.tx((t) => postMovements(t, [mv(item, "GRN_IN", 10, { unitCost: 10, sourceId: 100 })]));

    // T1 (a receipt) opens first and waits. T2 (a mark-out) opens later,
    // takes the balance lock, posts and commits. Then T1 posts.
    let opened;
    let go;
    const t1Open = new Promise((resolve) => {
      opened = resolve;
    });
    const t1Go = new Promise((resolve) => {
      go = resolve;
    });
    const t1 = db.tx(async (t) => {
      await t.one("SELECT now()");
      opened();
      await t1Go;
      return postMovements(t, [
        mv(item, "GRN_IN", 50, { unitCost: 10, sourceId: 1 }),
        mv(towel, "GRN_IN", 5, { unitCost: 10, sourceId: 1 }),
      ]);
    });
    await t1Open;
    await db.tx((t) => postMovements(t, [mv(item, "MARK_OUT", -1, { departmentId: DEPT, sourceId: 2 })]));
    go();
    await t1;

    const ordered = (by) => db.any(
      `SELECT source_id::int AS src, qty_after::float AS qty_after FROM tbl_inv_movement
        WHERE hotel_id = $1 AND inv_item_id = $2 ORDER BY ${by}`,
      [HOTEL, item]
    );
    // The movement committed second is stamped later: time order = lock order = id order.
    expect(await ordered("posted_at, id")).toEqual([
      { src: 100, qty_after: 10 },
      { src: 2, qty_after: 9 },
      { src: 1, qty_after: 59 },
    ]);
    expect(await ordered("id")).toEqual(await ordered("posted_at, id"));

    // What the reports read ("last movement before the cut-off") is the real balance.
    const [last] = await ordered("posted_at DESC, id DESC LIMIT 1");
    expect(last.qty_after).toBe((await balanceOf(db, item)).qty);
    expect(last.qty_after).toBe(59);

    // One stamp per call: T1's movements share it, and it is each balance's last_movement_at.
    expect(await db.one(
      `SELECT count(DISTINCT m.posted_at)::int AS stamps, bool_and(b.last_movement_at = m.posted_at) AS on_balance
         FROM tbl_inv_movement m
         JOIN tbl_inv_balance b ON b.hotel_id = m.hotel_id AND b.inv_item_id = m.inv_item_id
        WHERE m.source_type = 'TEST' AND m.source_id = 1`
    )).toEqual({ stamps: 1, on_balance: true });
  });

  it("first receipts of a new item from two transactions both land", async () => {
    const item = await committedItem("Concurrent new item");

    const gate = barrier(2);
    await Promise.all([
      postAfter(gate, [mv(item, "GRN_IN", 5, { unitCost: 10 })]),
      postAfter(gate, [mv(item, "GRN_IN", 7, { unitCost: 20 })]),
    ]);

    // 50 + 140 = 190 over 12 units, whichever committed first.
    expect(await balanceOf(db, item)).toEqual({ qty: 12, avgCost: 15.8333, value: 190 });
    // The second writer saw the first one's committed row, not an empty balance.
    const mvs = await movementsOf(db, item);
    expect(mvs).toHaveLength(2);
    expect([5, 7]).toContain(mvs[0].qtyAfter);
    expect(mvs[1].qtyAfter).toBe(12);
  });

  it("posts touching the same items in opposite order do not deadlock", async () => {
    const items = [];
    for (let n = 0; n < 8; n += 1) items.push(await committedItem(`Concurrent ${n}`));
    await db.tx((t) => postMovements(t, items.map((i) => mv(i, "GRN_IN", 100, { unitCost: 1 }))));

    // A third session holds the middle item, so both posters stall half-way
    // through taking their locks. One lists the items ascending, the other
    // descending: locking in input order, each would now hold what the other
    // needs, and Postgres would abort one of them as a deadlock once the
    // middle item is released.
    let release;
    let held;
    const holding = new Promise((resolve) => {
      held = resolve;
    });
    const blocker = db.tx(async (t) => {
      await t.one(
        `SELECT 1 FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = $2 FOR UPDATE`,
        [HOTEL, items[4]]
      );
      held();
      await new Promise((resolve) => {
        release = resolve;
      });
    });
    await holding;

    const takeOne = (i) => mv(i, "MARK_OUT", -1, { departmentId: DEPT });
    const open = () => Promise.resolve();
    const posts = Promise.allSettled([
      postAfter(open, items.map(takeOne), { largeTablePlan: true }),
      postAfter(open, [...items].reverse().map(takeOne), { largeTablePlan: true }),
    ]);

    // Wait until both posters are blocked on row locks, then let them go.
    // Release in finally: a timeout that kept the blocker's row lock would
    // stall the posters and every later test's TRUNCATE behind them.
    try {
      const deadline = Date.now() + 15000;
      for (;;) {
        const { n } = await db.one(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`
        );
        if (n >= 2) break;
        if (Date.now() > deadline) throw new Error(`only ${n} poster(s) blocked`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      release();
      await blocker;
    }

    const results = await posts;
    expect(results.map((r) => (r.status === "rejected" ? String(r.reason?.message) : "ok"))).toEqual(["ok", "ok"]);
    for (const i of items) expect((await balanceOf(db, i)).qty).toBe(98);
  });
});
