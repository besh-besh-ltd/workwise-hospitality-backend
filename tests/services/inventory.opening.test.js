// Opening stock import (Task B3): xlsx preview, then an all-or-nothing OPENING
// adjustment posted as deltas against the current balance. Fixtures are built
// in-test with exceljs. Everything runs in withTx (rolled back) except the
// HTTP upload case, which cleans up after itself.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import ExcelJS from "exceljs";
import { randomUUID } from "crypto";
import { db, withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import { previewOpeningStock, postOpeningStock } from "../../app/services/inventory/openingImport.js";
import { postMovements } from "../../app/services/inventory/ledger.js";
import { setUomFactor } from "../../app/services/inventory/uom.js";
import { startCount, cancelCount } from "../../app/services/inventory/countService.js";
import * as setup from "../../app/services/inventory/setupService.js";

const A = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const USER = { id: IDS.users.a1_proc_buyer, user_type: 2 };

afterAll(async () => {
  await closeDb();
});

let seq = 0;
const tag = () => `inv-b3o-${process.pid}-${++seq}`;

async function grantAdmin(t) {
  const role = await t.one(`SELECT id FROM tbl_roles WHERE title = 'Inventory Controller' AND created_by IS NULL`);
  return grantRoleScope(t, { userId: USER.id, roleId: role.id, companyId: A, hotelId: null });
}
async function makeItem(t, { name, code = null, uom = "kg" }) {
  return Number(
    (await t.one(
      `INSERT INTO tbl_inv_item (hospitality_company_id, display_name, item_code, stock_uom) VALUES ($1, $2, $3, $4) RETURNING id`,
      [A, name, code, uom]
    )).id
  );
}
async function makeVariant(t, name, sku) {
  const p = await t.one(`INSERT INTO tbl_product (id, name, slug, added_by) VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM tbl_product), $1, $2, $3) RETURNING id`, [name, tag(), IDS.users.superAdmin]);
  return Number(
    (await t.one(
      `INSERT INTO tbl_product_variant (name, slug, sku, added_by, product_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, tag(), sku, IDS.users.superAdmin, p.id]
    )).id
  );
}
async function sheet(rows, headers = ["Item Code", "Variant SKU", "Item Name", "Qty", "Unit", "Unit Cost", "Bin"]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Opening");
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function thrownBy(t, fn) {
  try {
    await t.tx((sp) => fn(sp));
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}
const balance = async (t, item) =>
  t.oneOrNone(`SELECT qty::float AS qty, avg_cost::float AS avg_cost FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = $2`, [HOTEL, item]);

describe("opening stock import", () => {
  it("preview matches by item code, sku, name; reports unmatched", async () => {
    await withTx(async (t) => {
      await grantAdmin(t);
      const byCode = await makeItem(t, { name: "Basmati Rice", code: "RICE-1" });
      const bySku = await makeItem(t, { name: "Sugar", uom: "kg" });
      const variant = await makeVariant(t, "Sugar M30", "SUG-30");
      await t.none(`INSERT INTO tbl_inv_item_variant (hospitality_company_id, inv_item_id, product_variant_id) VALUES ($1, $2, $3)`, [A, bySku, variant]);
      const byName = await makeItem(t, { name: "Olive Oil", uom: "ltr" });
      await setUomFactor(t, { invItemId: byCode, uomLabel: "Bag", factor: 25 });
      const lazyVariant = await makeVariant(t, "Fresh Basil", "BAS-1");

      const buf = await sheet([
        ["rice-1", null, "ignored", 2, "Bag", 2500, "A1"], // code, case-insensitive; 2 bags of 25 kg at 2500/bag
        [null, "SUG-30", null, 10, "kg", 40, null], // sku
        [null, null, "olive oil", 5, "ltr", 600, "B2"], // name
        [null, null, "Nothing Like It", 1, "kg", 1, null], // unmatched
        ["RICE-1", null, null, 1, "kg", 100, null], // duplicate item
        [null, null, "Sugar", 1, "Crate", 1, null], // duplicate: sugar already used by the row above
        [null, "BAS-1", null, 3, "bunch", 12, null], // lazily created from the catalogue
        [null, null, "Sugar", "abc", "kg", 1, null],
      ]);
      const { rows, okCount, errorCount } = await previewOpeningStock(t, USER, HOTEL, buf);

      expect(rows[0]).toMatchObject({ rowNo: 2, invItemId: byCode, qty: 2, uom: "Bag", factor: 25, stockQty: 50, unitCost: 100, binLabel: "A1", error: null });
      expect(rows[1]).toMatchObject({ invItemId: bySku, stockQty: 10, unitCost: 40, error: null });
      expect(rows[2]).toMatchObject({ invItemId: byName, displayName: "Olive Oil", stockQty: 5, error: null });
      expect(rows[3]).toMatchObject({ invItemId: null, error: "No matching item" });
      expect(rows[4]).toMatchObject({ invItemId: byCode, error: "Duplicate item in file" });
      expect(rows[5]).toMatchObject({ invItemId: bySku, error: "Duplicate item in file" }); // sugar already used by row 3
      expect(rows[6]).toMatchObject({
        error: null, invItemId: null, willCreate: true, productVariantId: lazyVariant, stockUom: "bunch", factor: 1, stockQty: 3, unitCost: 12,
      });
      expect(rows.filter((r) => r.willCreate)).toHaveLength(1); // errored rows are never willCreate
      expect(rows[7].error).toBe("Duplicate item in file");
      expect(okCount).toBe(4);
      expect(errorCount).toBe(4);

      // preview has no side effects: no item was created for the variant
      expect(await t.oneOrNone(`SELECT 1 FROM tbl_inv_item_variant WHERE product_variant_id = $1`, [lazyVariant])).toBeNull();
    });
  });

  it("preview flags unknown units, bad numbers and missing columns", async () => {
    await withTx(async (t) => {
      await grantAdmin(t);
      await makeItem(t, { name: "Flour" });
      await makeItem(t, { name: "Salt" });
      await makeItem(t, { name: "Pepper" });
      const { rows } = await previewOpeningStock(
        t,
        USER,
        HOTEL,
        await sheet([
          [null, null, "Flour", 1, "Crate", 1, null],
          [null, null, "Salt", -1, "kg", 1, null],
          [null, null, "Pepper", 1, "kg", "", null],
        ])
      );
      expect(rows.map((r) => r.error)).toEqual(["Unknown unit", "Invalid quantity", "Invalid unit cost"]);

    });
    await withTx(async (t) => {
      await grantAdmin(t);
      const err = await thrownBy(t, async (sp) => previewOpeningStock(sp, USER, HOTEL, await sheet([["a"]], ["Foo", "Bar"])));
      expect(err.code).toBe("VALIDATION");
    });
  });

  it("post creates OPENING adjustment, sets balances and stock_started_at", async () => {
    await withTx(async (t) => {
      await grantAdmin(t);
      const rice = await makeItem(t, { name: "Rice" });
      const oil = await makeItem(t, { name: "Oil", uom: "ltr" });
      const clientEventId = randomUUID();

      const { result, audit } = await postOpeningStock(
        t,
        USER,
        HOTEL,
        [
          { invItemId: rice, stockQty: 50, unitCost: 80, binLabel: "Dry 1" },
          { invItemId: oil, stockQty: 20, unitCost: 150, binLabel: null },
        ],
        clientEventId
      );
      expect(result.adjustmentNumber).toMatch(new RegExp(`^ADJ/${HOTEL}/\\d{4}-\\d{2}/\\d{5}$`));
      expect(audit).toMatchObject({ companyId: A, hotelId: HOTEL });

      const adj = await t.one(`SELECT reason_code, status, hotel_id FROM tbl_inv_adjustment WHERE id = $1`, [result.adjustmentId]);
      expect(adj).toMatchObject({ reason_code: "OPENING", status: "posted", hotel_id: HOTEL });
      expect(await balance(t, rice)).toEqual({ qty: 50, avg_cost: 80 });
      expect(await balance(t, oil)).toEqual({ qty: 20, avg_cost: 150 });
      const mv = await t.any(`SELECT movement_type, source_type, source_id::int AS sid FROM tbl_inv_movement WHERE inv_item_id = $1`, [rice]);
      expect(mv).toEqual([{ movement_type: "OPENING", source_type: "ADJ", sid: result.adjustmentId }]);
      const hs = await t.one(`SELECT stock_started_at FROM tbl_inv_hotel_settings WHERE hotel_id = $1`, [HOTEL]);
      expect(hs.stock_started_at).not.toBeNull();
      const hi = await t.one(`SELECT bin_label FROM tbl_inv_hotel_item WHERE hotel_id = $1 AND inv_item_id = $2`, [HOTEL, rice]);
      expect(hi.bin_label).toBe("Dry 1");

      // a replay of the same client event returns the original document
      const again = await postOpeningStock(t, USER, HOTEL, [{ invItemId: rice, stockQty: 999, unitCost: 1 }], clientEventId);
      expect(again.result).toEqual(result);
      expect((await balance(t, rice)).qty).toBe(50);
    });
  });

  it("post after R1 mark-ins posts delta to reach target qty", async () => {
    await withTx(async (t) => {
      await grantAdmin(t);
      const up = await makeItem(t, { name: "Up" });
      const down = await makeItem(t, { name: "Down" });
      const same = await makeItem(t, { name: "Same" });
      const mark = (invItemId, qty) => ({
        companyId: A, hotelId: HOTEL, invItemId, type: "GRN_IN", qty, unitCost: 10,
        sourceType: "GRN", sourceId: 1, postedBy: USER.id,
      });
      await postMovements(t, [mark(up, 10), mark(down, 10), mark(same, 10)]);

      const { result } = await postOpeningStock(
        t,
        USER,
        HOTEL,
        [
          { invItemId: up, stockQty: 25, unitCost: 20 },
          { invItemId: down, stockQty: 4, unitCost: 20 },
          { invItemId: same, stockQty: 10, unitCost: 20 },
        ],
        randomUUID()
      );
      expect((await balance(t, up)).qty).toBe(25);
      expect((await balance(t, down)).qty).toBe(4);
      expect((await balance(t, same)).qty).toBe(10);
      const opening = await t.any(
        `SELECT inv_item_id, qty::float AS qty FROM tbl_inv_movement WHERE movement_type = 'OPENING' AND source_id = $1 ORDER BY inv_item_id`,
        [result.adjustmentId]
      );
      expect(opening).toEqual([
        { inv_item_id: up, qty: 15 },
        { inv_item_id: down, qty: -6 },
      ]); // the unchanged item gets no movement
      // up: 10 @10 then 15 @20 averages 16
      expect((await balance(t, up)).avg_cost).toBe(16);
    });
  });

  it("rows with errors cannot be posted", async () => {
    await withTx(async (t) => {
      await grantAdmin(t);
      const rice = await makeItem(t, { name: "Rice" });
      const foreign = Number(
        (await t.one(`INSERT INTO tbl_inv_item (hospitality_company_id, display_name, stock_uom) VALUES ($1, 'Other co', 'kg') RETURNING id`, [IDS.hospitality.B])).id
      );
      const cases = [
        [{ invItemId: rice, stockQty: 5, unitCost: 1 }, { invItemId: rice, stockQty: 5, unitCost: 1 }], // duplicate
        [{ invItemId: rice, stockQty: 5, unitCost: 1 }, { invItemId: foreign, stockQty: 5, unitCost: 1 }], // other company
        [{ invItemId: rice, stockQty: -1, unitCost: 1 }],
        [{ invItemId: rice, stockQty: 1, unitCost: "" }],
        [],
      ];
      for (const rows of cases) {
        const err = await thrownBy(t, (sp) => postOpeningStock(sp, USER, HOTEL, rows, randomUUID()));
        expect(err.code).toBe("VALIDATION");
      }
      // bad rows reject the whole post: nothing was written
      expect(await balance(t, rice)).toBeNull();
      expect((await t.one(`SELECT count(*)::int AS n FROM tbl_inv_adjustment WHERE hotel_id = $1`, [HOTEL])).n).toBe(0);
      expect((await thrownBy(t, (sp) => postOpeningStock(sp, USER, HOTEL, [{ invItemId: rice, stockQty: 1, unitCost: 1 }], "not-a-uuid"))).code).toBe("VALIDATION");
    });
  });

  it("post creates items for willCreate rows in the same transaction; a bad row rolls them back", async () => {
    await withTx(async (t) => {
      await grantAdmin(t);
      const variant = await makeVariant(t, "Fresh Mint", "MINT-1");
      const preview = await previewOpeningStock(t, USER, HOTEL, await sheet([[null, "MINT-1", null, 4, "bunch", 15, "C1"]]));
      const row = preview.rows[0];
      expect(row).toMatchObject({ willCreate: true, productVariantId: variant, stockUom: "bunch" });

      // a second row with an error: nothing is created
      const rice = await makeItem(t, { name: "Rice" });
      const err = await thrownBy(t, (sp) =>
        postOpeningStock(sp, USER, HOTEL, [
          { invItemId: null, productVariantId: variant, stockUom: "bunch", stockQty: 4, unitCost: 15 },
          { invItemId: rice, stockQty: -1, unitCost: 1 },
        ], randomUUID())
      );
      expect(err.code).toBe("VALIDATION");
      expect(await t.oneOrNone(`SELECT 1 FROM tbl_inv_item_variant WHERE product_variant_id = $1`, [variant])).toBeNull();

      const { result } = await postOpeningStock(
        t, USER, HOTEL,
        [{ invItemId: null, productVariantId: row.productVariantId, stockUom: row.stockUom, stockQty: row.stockQty, unitCost: row.unitCost, binLabel: row.binLabel }],
        randomUUID()
      );
      const made = await t.one(
        `SELECT i.id, i.stock_uom FROM tbl_inv_item_variant iv JOIN tbl_inv_item i ON i.id = iv.inv_item_id WHERE iv.product_variant_id = $1`,
        [variant]
      );
      expect(made.stock_uom).toBe("bunch");
      expect(await balance(t, made.id)).toEqual({ qty: 4, avg_cost: 15 });
      expect(result.adjustmentId).toBeGreaterThan(0);

      // blank unit or unknown variant is refused
      const e2 = await thrownBy(t, (sp) => postOpeningStock(sp, USER, HOTEL, [{ invItemId: null, productVariantId: variant, stockUom: " ", stockQty: 1, unitCost: 1 }], randomUUID()));
      expect(e2.code).toBe("VALIDATION");
    });
  });

  it("a formula error in a cell reads as an error, not [object Object]", async () => {
    await withTx(async (t) => {
      await grantAdmin(t);
      await makeItem(t, { name: "Flour" });
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Opening");
      ws.addRow(["Item Name", "Qty", "Unit", "Unit Cost"]);
      ws.addRow(["Flour", { error: "#N/A" }, "kg", 5]);
      const { rows } = await previewOpeningStock(t, USER, HOTEL, Buffer.from(await wb.xlsx.writeBuffer()));
      expect(rows[0].error).toBe("Invalid quantity");
    });
  });

  it("a rejected row does not block the same item later in the sheet", async () => {
    await withTx(async (t) => {
      await grantAdmin(t);
      await makeItem(t, { name: "Flour" });
      const { rows } = await previewOpeningStock(
        t, USER, HOTEL,
        await sheet([[null, null, "Flour", 1, "Crate", 1, null], [null, null, "Flour", 2, "kg", 3, null]])
      );
      expect(rows.map((r) => r.error)).toEqual(["Unknown unit", null]);
    });
  });

  it("needs inventory.admin on the hotel", async () => {
    await withTx(async (t) => {
      const role = await t.one(`SELECT id FROM tbl_roles WHERE title = 'Storekeeper' AND created_by IS NULL`);
      await grantRoleScope(t, { userId: USER.id, roleId: role.id, companyId: A });
      const err = await thrownBy(t, (sp) => postOpeningStock(sp, USER, HOTEL, [{ invItemId: 1, stockQty: 1, unitCost: 1 }], randomUUID()));
      expect(err.code).toBe("FORBIDDEN");
    });
  });
});

describe("opening stock over HTTP", () => {
  it("uploads the xlsx behind the guard and previews it", async () => {
    const role = await db.one(`SELECT id FROM tbl_roles WHERE title = 'Inventory Controller' AND created_by IS NULL`);
    const scopeId = await grantRoleScope(db, { userId: USER.id, roleId: role.id, companyId: A });
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [USER.id]);
    const name = `Http Item ${tag()}`;
    const itemId = Number(
      (await db.one(`INSERT INTO tbl_inv_item (hospitality_company_id, display_name, stock_uom) VALUES ($1, $2, 'kg') RETURNING id`, [A, name])).id
    );
    try {
      const c = await httpClient(USER.id);
      const buf = await sheet([[null, null, name, 3, "kg", 10, null]]);
      const res = await c.post(`/api/v1/inventory/opening/${HOTEL}/preview`).attach("file", buf, "opening.xlsx");
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ okCount: 1, errorCount: 0 });
      expect(res.body.data.rows[0]).toMatchObject({ invItemId: itemId, stockQty: 3 });

      const none = await c.post(`/api/v1/inventory/opening/${HOTEL}/preview`);
      expect(none.status).toBe(400);

      const post = await c.post(`/api/v1/inventory/opening/${HOTEL}/post`).send({ rows: [{ invItemId: itemId, stockQty: 3, unitCost: 10 }], clientEventId: randomUUID() });
      expect(post.status).toBe(200);
      expect(post.body.data.adjustmentNumber).toMatch(/^ADJ\//);
    } finally {
      await db.none(`TRUNCATE tbl_inv_movement, tbl_inv_balance, tbl_inv_adjustment_line, tbl_inv_adjustment, tbl_inv_doc_sequence, tbl_inv_hotel_item, tbl_inv_hotel_settings CASCADE`);
      await db.none(`DELETE FROM tbl_inv_item WHERE id = $1`, [itemId]);
      await revokeRoleScopes(db, [scopeId]);
      await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [USER.id]);
    }
  });
});

describe("hotel and opening routes are tenant-scoped", () => {
  const B_USER = { id: IDS.users.companyB_admin, user_type: 2 };

  it("a Company B admin gets NOT_FOUND on Hotel A1", async () => {
    await withTx(async (t) => {
      const role = await t.one(`SELECT id FROM tbl_roles WHERE title = 'Inventory Controller' AND created_by IS NULL`);
      await grantRoleScope(t, { userId: B_USER.id, roleId: role.id, companyId: IDS.hospitality.B });
      const item = await makeItem(t, { name: "A only" });
      const buf = await sheet([[null, null, "A only", 1, "kg", 1, null]]);
      const calls = {
        getHotelSettings: () => setup.getHotelSettings(t, B_USER, HOTEL),
        saveHotelSettings: () => setup.saveHotelSettings(t, B_USER, HOTEL, { docCode: "X" }),
        listHotelItems: () => setup.listHotelItems(t, B_USER, { hotelId: HOTEL }),
        saveHotelItem: () => setup.saveHotelItem(t, B_USER, { hotelId: HOTEL, invItemId: item }, { minQty: 1 }),
        previewOpening: () => previewOpeningStock(t, B_USER, HOTEL, buf),
        postOpening: () => postOpeningStock(t, B_USER, HOTEL, [{ invItemId: item, stockQty: 1, unitCost: 1 }], randomUUID()),
      };
      for (const [name, call] of Object.entries(calls)) {
        const err = await thrownBy(t, call);
        expect([name, err.code, err.httpStatus]).toEqual([name, "NOT_FOUND", 404]);
      }
    });
  });

  it("multer failures are 400, not 500", async () => {
    const role = await db.one(`SELECT id FROM tbl_roles WHERE title = 'Inventory Controller' AND created_by IS NULL`);
    const scopeId = await grantRoleScope(db, { userId: USER.id, roleId: role.id, companyId: A });
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [USER.id]);
    try {
      const c = await httpClient(USER.id);
      const buf = await sheet([[null, null, "x", 1, "kg", 1, null]]);
      const wrongField = await c.post(`/api/v1/inventory/opening/${HOTEL}/preview`).attach("upload", buf, "o.xlsx");
      expect(wrongField.status).toBe(400);
      const big = await c.post(`/api/v1/inventory/opening/${HOTEL}/preview`).attach("file", Buffer.alloc(6 * 1024 * 1024), "big.xlsx");
      expect(big.status).toBe(400);
      expect(big.body.code).toBe("VALIDATION");
    } finally {
      await revokeRoleScopes(db, [scopeId]);
      await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [USER.id]);
    }
  });
});

// ---------------------------------------------------------------------------
// FX1: once a hotel's stock has started, an import never resets live stock
// (an item that moved since the start is refused), and a count freeze blocks it
// ---------------------------------------------------------------------------

const activityError = (day) => `Has stock activity since stock started on ${day}: use a count or an adjustment`;

/** The hotel's stock start as an IST day ("25 Oct 2026"), straight from Postgres. */
async function startedDay(conn) {
  const row = await conn.one(
    `SELECT to_char(stock_started_at AT TIME ZONE 'Asia/Kolkata', 'FMDD Mon YYYY') AS d, stock_started_at
       FROM tbl_inv_hotel_settings WHERE hotel_id = $1`,
    [HOTEL]
  );
  return { day: row.d, iso: new Date(row.stock_started_at).toISOString() };
}

const markOutRice = (invItemId, qty) => ({
  companyId: A, hotelId: HOTEL, invItemId, type: "MARK_OUT", qty: -qty, departmentId: IDS.departments.fb,
  sourceType: "OUT", sourceId: 1, postedBy: USER.id,
});

describe("opening import after stock has started", () => {
  it("refuses an item that moved since the start, in preview and post; untouched items still import", async () => {
    await withTx(async (t) => {
      await grantAdmin(t);
      const rice = await makeItem(t, { name: "Rice" });
      const oil = await makeItem(t, { name: "Oil", uom: "ltr" });
      const soap = await makeItem(t, { name: "Soap", uom: "pc" });
      const fullSheet = await sheet([
        [null, null, "Rice", 50, "kg", 80, null],
        [null, null, "Oil", 20, "ltr", 150, null],
        [null, null, "Soap", 7, "pc", 30, null],
      ]);

      // Before the start there is nothing to protect.
      expect(await previewOpeningStock(t, USER, HOTEL, fullSheet)).toMatchObject({
        stockStartedAt: null, countFreeze: false, errorCount: 0, okCount: 3,
      });

      // The F&B sheet starts stock; then F&B uses 5 kg of rice.
      await postOpeningStock(t, USER, HOTEL, [
        { invItemId: rice, stockQty: 50, unitCost: 80 },
        { invItemId: oil, stockQty: 20, unitCost: 150 },
      ], randomUUID());
      await postMovements(t, [markOutRice(rice, 5)]);
      const { day, iso } = await startedDay(t);

      const preview = await previewOpeningStock(t, USER, HOTEL, fullSheet);
      expect(preview.rows.map((r) => r.error)).toEqual([activityError(day), null, null]);
      expect(preview.rows[0]).toMatchObject({ invItemId: rice, stockQty: 50 });
      expect(preview).toMatchObject({ okCount: 2, errorCount: 1, stockStartedAt: iso, countFreeze: false });

      // Re-posting last week's sheet would wipe the mark-out: refused, row by row.
      const refused = await thrownBy(t, (sp) => postOpeningStock(sp, USER, HOTEL, [
        { invItemId: oil, stockQty: 20, unitCost: 150 },
        { invItemId: rice, stockQty: 50, unitCost: 80 },
      ], randomUUID()));
      expect([refused.code, refused.httpStatus]).toEqual(["VALIDATION", 400]);
      expect(refused.details).toEqual({ field: "rows", rows: [{ index: 1, invItemId: rice, error: activityError(day) }] });
      expect((await balance(t, rice)).qty).toBe(45);

      // The housekeeping sheet a few days later: a new item imports, and an
      // item with no activity since the start re-sent unchanged posts a zero delta.
      const { result } = await postOpeningStock(t, USER, HOTEL, [
        { invItemId: oil, stockQty: 20, unitCost: 150 },
        { invItemId: soap, stockQty: 7, unitCost: 30 },
      ], randomUUID());
      const moved = await t.any(
        `SELECT inv_item_id, qty::float AS qty FROM tbl_inv_movement WHERE source_type = 'ADJ' AND source_id = $1 ORDER BY inv_item_id`,
        [result.adjustmentId]
      );
      expect(moved).toEqual([{ inv_item_id: soap, qty: 7 }]);
      expect((await balance(t, rice)).qty).toBe(45);
      expect((await balance(t, oil)).qty).toBe(20);
      expect((await balance(t, soap)).qty).toBe(7);
    });
  });

  it("a count freeze shows in preview and refuses the post; a replay still answers", async () => {
    await withTx(async (t) => {
      await grantAdmin(t);
      const rice = await makeItem(t, { name: "Rice" });
      const key = randomUUID();
      const first = await postOpeningStock(t, USER, HOTEL, [{ invItemId: rice, stockQty: 10, unitCost: 80 }], key);
      const buf = await sheet([[null, null, "Rice", 10, "kg", 80, null]]);

      // An open count alone freezes nothing (the setting is off by default) ...
      const count = await startCount(t, USER, { hotelId: HOTEL, scope: "SELECTED", invItemIds: [rice] });
      expect((await previewOpeningStock(t, USER, HOTEL, buf)).countFreeze).toBe(false);
      // ... with the company's count_freeze on, it does.
      await t.none(
        `INSERT INTO tbl_inv_company_settings (hospitality_company_id, count_freeze) VALUES ($1, true)
         ON CONFLICT (hospitality_company_id) DO UPDATE SET count_freeze = true`,
        [A]
      );
      expect((await previewOpeningStock(t, USER, HOTEL, buf)).countFreeze).toBe(true);

      const locked = await thrownBy(t, (sp) =>
        postOpeningStock(sp, USER, HOTEL, [{ invItemId: rice, stockQty: 12, unitCost: 80 }], randomUUID()));
      expect([locked.code, locked.httpStatus]).toEqual(["LOCKED", 409]);
      expect(locked.details).toEqual({ countId: count.id, countNumber: count.countNumber });

      // A replay of the posted import answers with the original document.
      const again = await postOpeningStock(t, USER, HOTEL, [{ invItemId: rice, stockQty: 99, unitCost: 1 }], key);
      expect(again.result).toEqual(first.result);
      expect((await balance(t, rice)).qty).toBe(10);

      // The setting alone (no open count) freezes nothing either.
      await cancelCount(t, USER, count.id);
      expect((await previewOpeningStock(t, USER, HOTEL, buf)).countFreeze).toBe(false);
    });
  });
});

describe("opening import after stock has started (committed, over HTTP)", () => {
  // Every step commits, so the start stamp, receipts and mark-outs each carry
  // their own transaction time, as in production.
  let scopeId;
  let prevUserType;
  let made = [];

  beforeAll(async () => {
    const role = await db.one(`SELECT id FROM tbl_roles WHERE title = 'Inventory Controller' AND created_by IS NULL`);
    scopeId = await grantRoleScope(db, { userId: USER.id, roleId: role.id, companyId: A });
    prevUserType = (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [USER.id])).user_type;
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [USER.id]);
  });

  afterEach(async () => {
    await db.none(
      `TRUNCATE tbl_inv_movement, tbl_inv_balance, tbl_inv_adjustment_line, tbl_inv_adjustment, tbl_inv_out_line, tbl_inv_out,
                tbl_inv_doc_sequence, tbl_inv_hotel_item, tbl_inv_hotel_settings CASCADE`
    );
    if (made.length) await db.none(`DELETE FROM tbl_inv_item WHERE id = ANY($1::int[])`, [made]);
    made = [];
  });

  afterAll(async () => {
    await revokeRoleScopes(db, [scopeId]);
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [USER.id, prevUserType]);
  });

  async function committedItem(prefix, uom = "kg") {
    const name = `${prefix} ${tag()}`;
    const id = Number(
      (await db.one(`INSERT INTO tbl_inv_item (hospitality_company_id, display_name, stock_uom) VALUES ($1, $2, $3) RETURNING id`, [A, name, uom])).id
    );
    made.push(id);
    return { id, name };
  }

  /** Run `work` in a transaction that stays open (its row locks held) until release(). */
  async function holdOpen(work) {
    let release;
    let opened;
    const isOpen = new Promise((resolve) => {
      opened = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const done = db.tx(async (t) => {
      await work(t);
      opened();
      await gate;
    });
    await Promise.race([isOpen, done]);
    return { release, done };
  }

  /** Wait until some session is blocked on a lock. */
  async function untilBlocked() {
    const deadline = Date.now() + 15000;
    for (;;) {
      const { n } = await db.one(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
      );
      if (n >= 1) return;
      if (Date.now() > deadline) throw new Error("the import never waited for the balance lock");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const importRows = (rows) =>
    db.tx((t) => postOpeningStock(t, USER, HOTEL, rows, randomUUID())).then(() => null, (err) => err);

  it("receipts before the start never block; after it, only items that moved are refused and keep their stock", async () => {
    const c = await httpClient(USER.id);
    const rice = await committedItem("Rice");
    const oil = await committedItem("Oil", "ltr");
    const buf = await sheet([[null, null, rice.name, 50, "kg", 80, null], [null, null, oil.name, 20, "ltr", 150, null]]);
    const preview = () => c.post(`/api/v1/inventory/opening/${HOTEL}/preview`).attach("file", buf, "opening.xlsx");
    const post = () => c.post(`/api/v1/inventory/opening/${HOTEL}/post`).send({
      rows: [{ invItemId: rice.id, stockQty: 50, unitCost: 80 }, { invItemId: oil.id, stockQty: 20, unitCost: 150 }],
      clientEventId: randomUUID(),
    });

    // An R1 receipt of 10 kg rice, before the hotel's stock starts.
    await db.tx((t) => postMovements(t, [{
      companyId: A, hotelId: HOTEL, invItemId: rice.id, type: "GRN_IN", qty: 10, unitCost: 60,
      sourceType: "GRN", sourceId: 1, postedBy: USER.id,
    }]));
    let res = await preview();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ errorCount: 0, okCount: 2, stockStartedAt: null, countFreeze: false });
    const started = await post();
    expect(started.status).toBe(200);
    expect(await balance(db, rice.id)).toMatchObject({ qty: 50 }); // the receipt's 10 plus a delta of 40

    // The same sheet again the same day, nothing moved since: no error, zero deltas.
    const { iso } = await startedDay(db);
    res = await preview();
    expect(res.body.data).toMatchObject({ errorCount: 0, stockStartedAt: iso, countFreeze: false });
    const same = await post();
    expect(same.status).toBe(200);
    expect(await db.any(`SELECT 1 FROM tbl_inv_movement WHERE source_type = 'ADJ' AND source_id = $1`, [same.body.data.adjustmentId]))
      .toEqual([]);

    // F&B takes 5 kg of rice.
    const out = await c.post("/api/v1/inventory/out").send({
      hotelId: HOTEL, docType: "OUT", departmentId: IDS.departments.fb, clientEventId: randomUUID(),
      lines: [{ invItemId: rice.id, qty: 5 }],
    });
    expect(out.status).toBe(201);

    const { day } = await startedDay(db);
    res = await preview();
    expect(res.body.data.rows.map((r) => r.error)).toEqual([activityError(day), null]);
    expect(res.body.data).toMatchObject({ okCount: 1, errorCount: 1, stockStartedAt: iso });
    const stale = await post();
    expect(stale.status).toBe(400);
    expect(stale.body).toMatchObject({
      status: 0, code: "VALIDATION", details: { field: "rows", rows: [{ index: 0, invItemId: rice.id, error: activityError(day) }] },
    });
    expect(await balance(db, rice.id)).toMatchObject({ qty: 45 });
  });

  it("a mark-out that commits while the import waits for the balance lock is seen, not overwritten", async () => {
    const rice = await committedItem("Rice");
    expect(await importRows([{ invItemId: rice.id, stockQty: 50, unitCost: 80 }])).toBeNull();

    // A mark-out holds rice's balance row while the second import starts.
    const holder = await holdOpen((t) => postMovements(t, [markOutRice(rice.id, 5)]));
    const importing = importRows([{ invItemId: rice.id, stockQty: 50, unitCost: 80 }]);
    try {
      await untilBlocked();
    } finally {
      holder.release();
      await holder.done;
    }
    const err = await importing;
    expect(err?.code).toBe("VALIDATION");
    expect(err.details.rows).toEqual([{ index: 0, invItemId: rice.id, error: activityError((await startedDay(db)).day) }]);
    expect(await balance(db, rice.id)).toMatchObject({ qty: 45 });
  });

  it("an item's first receipt that commits while the import waits is seen, not added to", async () => {
    const rice = await committedItem("Rice");
    const soap = await committedItem("Soap", "pc");
    expect(await importRows([{ invItemId: rice.id, stockQty: 50, unitCost: 80 }])).toBeNull();

    // Soap's first receipt at the hotel, not yet committed: its balance row
    // exists only inside that transaction.
    const holder = await holdOpen((t) => postMovements(t, [{
      companyId: A, hotelId: HOTEL, invItemId: soap.id, type: "GRN_IN", qty: 3, unitCost: 30,
      sourceType: "GRN", sourceId: 1, postedBy: USER.id,
    }]));
    const importing = importRows([{ invItemId: soap.id, stockQty: 7, unitCost: 30 }]);
    try {
      await untilBlocked();
    } finally {
      holder.release();
      await holder.done;
    }
    const err = await importing;
    expect(err?.code).toBe("VALIDATION");
    expect(err.details.rows).toEqual([{ index: 0, invItemId: soap.id, error: activityError((await startedDay(db)).day) }]);
    expect(await balance(db, soap.id)).toMatchObject({ qty: 3 });
  });
});
