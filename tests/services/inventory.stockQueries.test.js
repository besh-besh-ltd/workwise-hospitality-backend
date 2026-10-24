// Stock queries (Task C3): the stock list, the item card, the ledger (bin
// card) and the inventory overview, plus the tenant boundary over HTTP.
//
// The query cases run inside withTx. The cross-company case commits its
// documents (it goes through HTTP), so the suite truncates the dynamic tables
// before and after, and revokes its grants.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { randomUUID } from "crypto";
import { db, withTx, closeDb, truncateDynamic } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import { IDS } from "../fixtures/ids.js";
import { makeRfqPo, setPlan } from "../helpers/invReceiptFixtures.js";
import {
  CO, A1, A2, A3, HB1, FB, HK, STORE, CTRL, CTRL_ID, FOREIGN_ID, asUser, grantCast, makeItem, setLevels, stockIn, setCompanySettings,
  thrownBy, istToday, addDays,
} from "../helpers/invStockFixtures.js";
import { getStock, getStockItem, getLedger, getOverview } from "../../app/services/inventory/stockQueries.js";
import { postOut } from "../../app/services/inventory/outService.js";
import { createAdjustment } from "../../app/services/inventory/adjustmentService.js";
import { startCount } from "../../app/services/inventory/countService.js";

const READER_ID = IDS.users.a1_proc_techEval;
const outDoc = (over) => ({ hotelId: A1, docType: "OUT", departmentId: FB, clientEventId: randomUUID(), ...over });

beforeAll(async () => {
  await truncateDynamic();
});

afterAll(async () => {
  await truncateDynamic();
  await closeDb();
});

describe("stock queries", () => {
  it("stock list flags below reorder", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const low = await makeItem(t, { name: "Alpha low", itemCode: "AL-1" });
      const fine = await makeItem(t, { name: "Beta fine" });
      const unset = await makeItem(t, { name: "Gamma no level" });
      const empty = await makeItem(t, { name: "Delta level only" });
      await stockIn(t, { invItemId: low, qty: 3, unitCost: 10 });
      await stockIn(t, { invItemId: fine, qty: 10, unitCost: 2 });
      await stockIn(t, { invItemId: unset, qty: 1, unitCost: 7 });
      await setLevels(t, { invItemId: low, reorderLevel: 5, maxQty: 20, binLabel: "R1" });
      await setLevels(t, { invItemId: fine, reorderLevel: 5 });
      await setLevels(t, { invItemId: empty, reorderLevel: 0 });
      await makeItem(t, { name: "Epsilon elsewhere" }); // no balance, no level at A1: not listed

      const stock = await getStock(t, STORE, { hotelId: A1 });
      expect(stock).toMatchObject({ hotelId: A1, stockStartedAt: null, total: 4, totals: { qtyItems: 3, value: 57 } });
      expect(stock.hotels.map((h) => h.id)).toEqual(expect.arrayContaining([A1, A2, A3]));
      expect(stock.rows.map((r) => r.displayName)).toEqual(["Alpha low", "Beta fine", "Delta level only", "Gamma no level"]);
      const byName = Object.fromEntries(stock.rows.map((r) => [r.displayName, r]));
      expect(byName["Alpha low"]).toMatchObject({
        invItemId: low, itemCode: "AL-1", stockUom: "kg", qty: 3, avgCost: 10, value: 30, reorderLevel: 5, maxQty: 20,
        binLabel: "R1", belowReorder: true,
      });
      expect(byName["Alpha low"].lastMovementAt).toEqual(expect.any(String));
      expect(byName["Beta fine"].belowReorder).toBe(false);
      expect(byName["Gamma no level"]).toMatchObject({ belowReorder: false, reorderLevel: null });
      expect(byName["Delta level only"]).toMatchObject({ qty: 0, belowReorder: true, lastMovementAt: null });

      const below = await getStock(t, STORE, { hotelId: A1, belowReorder: "true" });
      expect(below.rows.map((r) => r.invItemId)).toEqual([low, empty]);
      expect(below.total).toBe(2);
      const search = await getStock(t, STORE, { hotelId: A1, search: "al-1" });
      expect(search.rows.map((r) => r.invItemId)).toEqual([low]);

      // a started hotel says when
      await t.none(
        `INSERT INTO tbl_inv_hotel_settings (hotel_id, hospitality_company_id, stock_started_at)
         VALUES ($1, (SELECT hospitality_company_id FROM tbl_hospitality_company_hotels WHERE id = $1), now())`,
        [A1]
      );
      expect((await getStock(t, STORE, { hotelId: A1 })).stockStartedAt).toEqual(expect.any(String));

      // the item card
      const card = await getStockItem(t, STORE, { hotelId: A1, invItemId: low });
      expect(card).toMatchObject({
        item: { id: low, displayName: "Alpha low", stockUom: "kg" },
        balance: { qty: 3, avgCost: 10, value: 30 },
        levels: { reorderLevel: 5, maxQty: 20, binLabel: "R1", minQty: null },
        barcodes: [],
        batches: [],
      });
      expect(card.recentMovements).toEqual([expect.objectContaining({ type: "OPENING", qty: 3, qtyAfter: 3 })]);

      // no hotel given: the first hotel the caller can read
      expect((await getStock(t, STORE, {})).hotelId).toBe(stock.hotels[0].id);
    });
  });

  it("ledger paginates with doc numbers", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      await setCompanySettings(t, { autoApproveLimit: 100000 });
      const item = await makeItem(t, { name: "Napkins" });
      await stockIn(t, { invItemId: item, qty: 100, unitCost: 1 });
      const outs = [];
      for (let i = 0; i < 50; i += 1) {
        outs.push((await postOut(t, STORE, outDoc({ departmentId: i % 2 ? FB : HK, lines: [{ invItemId: item, qty: 1 }] }))).doc);
      }
      const { adjustment } = await createAdjustment(t, STORE, {
        hotelId: A1, reasonCode: "WASTAGE", submit: true, clientEventId: randomUUID(), lines: [{ invItemId: item, qty: -2 }],
      });

      const page1 = await getLedger(t, STORE, { hotelId: A1, invItemId: item });
      expect(page1.total).toBe(52);
      expect(page1.rows).toHaveLength(50);
      // newest first
      expect(page1.rows[0]).toMatchObject({
        type: "ADJUST_OUT", qty: -2, unitCost: 1, value: -2, qtyAfter: 48, avgCostAfter: 1,
        sourceType: "ADJ", sourceId: adjustment.id, docNumber: adjustment.adjustmentNumber, reasonCode: "WASTAGE",
      });
      expect(page1.rows[0].postedByName).toBeTruthy();
      expect(page1.rows[1]).toMatchObject({
        type: "MARK_OUT", qty: -1, qtyAfter: 50, sourceType: "OUT", sourceId: outs[49].id, docNumber: outs[49].outNumber,
      });
      expect(page1.rows[1].departmentName).toBeTruthy();
      expect(page1.rows[1].postedAt).toEqual(expect.any(String));

      const page2 = await getLedger(t, STORE, { hotelId: A1, invItemId: item, page: 2 });
      expect(page2.total).toBe(52);
      expect(page2.rows.map((r) => r.type)).toEqual(["MARK_OUT", "OPENING"]);
      expect(page2.rows[0].docNumber).toBe(outs[0].outNumber);
      expect(new Set([...page1.rows, ...page2.rows].map((r) => r.id)).size).toBe(52);

      // date range (IST days)
      const today = await istToday(t);
      expect((await getLedger(t, STORE, { hotelId: A1, invItemId: item, from: today, to: today })).total).toBe(52);
      expect((await getLedger(t, STORE, { hotelId: A1, invItemId: item, from: addDays(today, 1) })).total).toBe(0);
      const bad = await thrownBy(t, (sp) => getLedger(sp, STORE, { hotelId: A1, invItemId: item, from: "24/10/2026" }));
      expect(bad.code).toBe("VALIDATION");
    });
  });

  it("overview aggregates by hotel and department", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      await setCompanySettings(t, { autoApproveLimit: 100000 });
      const p = await makeItem(t, { name: "Oil" });
      const q = await makeItem(t, { name: "Soap" });
      await stockIn(t, { invItemId: p, qty: 10, unitCost: 100 });
      await stockIn(t, { hotelId: A2, invItemId: q, qty: 5, unitCost: 20 });
      await setLevels(t, { invItemId: p, reorderLevel: 10 });
      await setLevels(t, { hotelId: A2, invItemId: q, reorderLevel: 1 });
      await postOut(t, STORE, outDoc({ departmentId: FB, lines: [{ invItemId: p, qty: 2 }] }));
      await postOut(t, STORE, outDoc({ departmentId: HK, lines: [{ invItemId: p, qty: 1 }] }));
      await postOut(t, STORE, outDoc({ docType: "RETURN", departmentId: FB, lines: [{ invItemId: p, qty: 1 }] }));
      await createAdjustment(t, STORE, {
        hotelId: A1, reasonCode: "WASTAGE", submit: true, clientEventId: randomUUID(), lines: [{ invItemId: p, qty: -1 }],
      });
      await createAdjustment(t, STORE, {
        hotelId: A1, reasonCode: "FOUND", submit: true, clientEventId: randomUUID(), lines: [{ invItemId: p, qty: 1 }],
      });
      await t.none(
        `INSERT INTO tbl_inv_hotel_settings (hotel_id, hospitality_company_id, stock_started_at)
         VALUES ($1, (SELECT hospitality_company_id FROM tbl_hospitality_company_hotels WHERE id = $1), now())`,
        [A1]
      );

      // deliveries: plan rows of live POs, by IST due date
      const today = await istToday(t);
      const po1 = await makeRfqPo(t, { lines: [{ qty: 30, unit: "kg" }] });
      await setPlan(t, po1.poId, [
        { hotelId: A1, phaseNo: 1, dueDate: today, lines: { [po1.lineIds[0]]: 10 } },
        { hotelId: A1, phaseNo: 2, dueDate: addDays(today, -1), lines: { [po1.lineIds[0]]: 10 } },
        { hotelId: A1, phaseNo: 3, dueDate: addDays(today, 3), lines: { [po1.lineIds[0]]: 5 } },
        { hotelId: null, phaseNo: 1, dueDate: today, lines: { [po1.lineIds[0]]: 5 } }, // unallocated: no hotel
      ]);
      const po2 = await makeRfqPo(t, { hotel: A2, lines: [{ qty: 4, unit: "kg" }] });
      await setPlan(t, po2.poId, [{ hotelId: A2, phaseNo: 1, dueDate: addDays(today, 5), lines: { [po2.lineIds[0]]: 4 } }]);
      const legacy = await makeRfqPo(t, { lines: [{ qty: 2, unit: "kg" }] });
      await setPlan(t, legacy.poId, [{ hotelId: A1, phaseNo: 1, dueDate: addDays(today, -3), lines: { [legacy.lineIds[0]]: 2 } }]);
      await t.none(`UPDATE tbl_rfq_purchase_order SET receipt_legacy = true WHERE id = $1`, [legacy.poId]);
      const done = await makeRfqPo(t, { lines: [{ qty: 2, unit: "kg" }] });
      const [doneRow] = await setPlan(t, done.poId, [{ hotelId: A1, phaseNo: 1, dueDate: today, lines: { [done.lineIds[0]]: 2 } }]);
      await t.none(`UPDATE tbl_po_delivery SET status = 'received' WHERE id = $1`, [doneRow.deliveryId]);
      const cancelled = await makeRfqPo(t, { status: "cancelled", lines: [{ qty: 2, unit: "kg" }] });
      await setPlan(t, cancelled.poId, [{ hotelId: A1, phaseNo: 1, dueDate: today, lines: { [cancelled.lineIds[0]]: 2 } }]);

      const all = await getOverview(t, CTRL, {});
      const valueOf = (rows, hotelId) => rows.find((r) => r.hotelId === hotelId)?.value;
      // A1: 1000 − 200 − 100 + 100 − 100 + 100 = 800; A2: 100; A3 has nothing
      expect(valueOf(all.stockValueByHotel, A1)).toBe(800);
      expect(valueOf(all.stockValueByHotel, A2)).toBe(100);
      expect(valueOf(all.stockValueByHotel, A3)).toBe(0);
      expect(all.stockValueByHotel.find((r) => r.hotelId === A1).hotelName).toBeTruthy();
      expect(all.lowStockCount).toBe(1); // Oil: 8 ≤ 10
      expect(all.deliveries).toEqual({ dueToday: 1, dueThisWeek: 3, overdue: 1 });
      // net of returns, at movement value
      expect(all.outThisMonthByDept).toEqual(expect.arrayContaining([
        expect.objectContaining({ departmentId: FB, value: 100 }),
        expect.objectContaining({ departmentId: HK, value: 100 }),
      ]));
      expect(all.outThisMonthByDept).toHaveLength(2);
      expect(all.outThisMonthByDept[0].departmentName).toBeTruthy();
      expect(all.wastageThisMonth).toBe(100);
      expect(all.stockNotStartedHotels.map((h) => h.hotelId).sort()).toEqual([A2, A3].sort());

      const a2 = await getOverview(t, CTRL, { hotelId: A2 });
      expect(a2.stockValueByHotel).toEqual([expect.objectContaining({ hotelId: A2, value: 100 })]);
      expect(a2).toMatchObject({ lowStockCount: 0, deliveries: { dueToday: 0, dueThisWeek: 1, overdue: 0 }, wastageThisMonth: 0 });
      expect(a2.outThisMonthByDept).toEqual([]);

      // a storekeeper sees the same figures for their hotels
      expect((await getOverview(t, STORE, { hotelId: A1 })).lowStockCount).toBe(1);

      // a reader of A1 only: A2 of the same company is out of scope, so 404 like a foreign hotel
      const reader = await t.one(
        `INSERT INTO tbl_roles (title, description, created_by) VALUES ('C3 inventory read', 'overview test', $1) RETURNING id`,
        [CTRL_ID]
      );
      await t.none(
        `INSERT INTO tbl_role_permissions (role_id, permission_id)
         SELECT $1, id FROM tbl_permissions WHERE resource::text = 'inventory' AND action::text = 'read'`,
        [reader.id]
      );
      await grantRoleScope(t, { userId: READER_ID, roleId: Number(reader.id), companyId: CO, hotelId: A1 });
      const narrow = await getOverview(t, asUser(READER_ID), {});
      expect(narrow.stockValueByHotel.map((h) => h.hotelId)).toEqual([A1]);
      expect((await thrownBy(t, (sp) => getOverview(sp, asUser(READER_ID), { hotelId: A2 }))).code).toBe("NOT_FOUND");
      expect((await thrownBy(t, (sp) => getStock(sp, asUser(READER_ID), { hotelId: A2 }))).code).toBe("NOT_FOUND");
    });
  });
});

describe("tenant boundary over HTTP (committed)", () => {
  let scopes = [];
  const made = {};

  beforeAll(async () => {
    scopes = await grantCast(db);
    made.item = await makeItem(db, { name: "Boundary item" });
    made.bItem = await makeItem(db, { companyId: 10002, name: "Company B item" });
    await db.tx(async (t) => {
      await stockIn(t, { invItemId: made.item, qty: 10 });
      made.out = (await postOut(t, STORE, outDoc({ lines: [{ invItemId: made.item, qty: 1 }] }))).doc;
      made.adjustment = (await createAdjustment(t, STORE, {
        hotelId: A1, reasonCode: "WASTAGE", submit: true, clientEventId: randomUUID(), lines: [{ invItemId: made.item, qty: -1 }],
      })).adjustment;
      made.count = await startCount(t, STORE, { hotelId: A1, scope: "SELECTED", invItemIds: [made.item] });
    });
  });
  afterAll(async () => {
    await revokeRoleScopes(db, scopes);
  });

  it("cross-company hotel is 404", async () => {
    const foreign = await httpClient(FOREIGN_ID);
    const base = "/api/v1/inventory";
    const attempts = [
      foreign.get(`${base}/stock?hotelId=${A1}`),
      foreign.get(`${base}/stock/${A1}/items/${made.item}`),
      foreign.get(`${base}/stock/${A1}/items/${made.item}/ledger`),
      foreign.get(`${base}/stock/${HB1}/items/${made.item}`), // own hotel, foreign item
      foreign.post(`${base}/out`).send(outDoc({ lines: [{ invItemId: made.item, qty: 1 }] })),
      foreign.post(`${base}/out`).send(outDoc({ hotelId: HB1, lines: [{ invItemId: made.item, qty: 1 }] })),
      foreign.get(`${base}/out/${made.out.id}`),
      foreign.post(`${base}/adjustments`).send({
        hotelId: A1, reasonCode: "WASTAGE", submit: true, clientEventId: randomUUID(), lines: [{ invItemId: made.item, qty: -1 }],
      }),
      foreign.get(`${base}/adjustments/${made.adjustment.id}`),
      foreign.post(`${base}/adjustments/${made.adjustment.id}/approve`),
      foreign.post(`${base}/adjustments/${made.adjustment.id}/reject`).send({ reason: "x" }),
      foreign.post(`${base}/counts`).send({ hotelId: A1, scope: "FULL" }),
      foreign.get(`${base}/counts/${made.count.id}`),
      foreign.put(`${base}/counts/${made.count.id}/lines`).send({ lines: [{ invItemId: made.item, countedQty: 1, clientEventId: randomUUID() }] }),
      foreign.post(`${base}/counts/${made.count.id}/submit`),
      foreign.post(`${base}/counts/${made.count.id}/approve`).send({ reasons: {} }),
      foreign.post(`${base}/counts/${made.count.id}/cancel`),
      foreign.get(`${base}/overview?hotelId=${A1}`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect([res.req.method, res.req.path, res.status, res.body.status]).toEqual([res.req.method, res.req.path, 404, 2]);
    }

    // lists never leak another company's rows
    for (const path of [`/out?hotelId=${A1}`, `/adjustments?hotelId=${A1}`, `/counts?hotelId=${A1}`, `/out`, `/adjustments`, `/counts`]) {
      const res = await foreign.get(`${base}${path}`);
      expect([path, res.status, res.body.data.total]).toEqual([path, 200, 0]);
    }
    // the foreign company's own overview has none of company A's hotels
    const overview = await foreign.get(`${base}/overview`);
    expect(overview.status).toBe(200);
    expect(overview.body.data.stockValueByHotel.map((r) => r.hotelId)).not.toContain(A1);

    // nothing changed
    const ctrl = await httpClient(CTRL_ID);
    const count = await ctrl.get(`${base}/counts/${made.count.id}`);
    expect(count.body.data).toMatchObject({ status: "open" });
    const stock = await ctrl.get(`${base}/stock/${A1}/items/${made.item}`);
    expect(stock.body.data.balance.qty).toBe(9); // 10 − 1 marked out; the adjustment still waits
  });
});
