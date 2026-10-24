// Opening stock import (Task B3): xlsx preview, then an all-or-nothing OPENING
// adjustment posted as deltas against the current balance. Fixtures are built
// in-test with exceljs. Everything runs in withTx (rolled back) except the
// HTTP upload case, which cleans up after itself.

import { describe, it, expect, afterAll } from "@jest/globals";
import ExcelJS from "exceljs";
import { randomUUID } from "crypto";
import { db, withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import { previewOpeningStock, postOpeningStock } from "../../app/services/inventory/openingImport.js";
import { postMovements } from "../../app/services/inventory/ledger.js";
import { setUomFactor } from "../../app/services/inventory/uom.js";

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
      expect(rows[6]).toMatchObject({ error: null, factor: 1, stockQty: 3 });
      expect(rows[6].invItemId).not.toBeNull();
      expect(rows[7].error).toBe("Duplicate item in file");
      expect(okCount).toBe(4);
      expect(errorCount).toBe(4);

      const lazy = await t.one(`SELECT i.stock_uom FROM tbl_inv_item_variant iv JOIN tbl_inv_item i ON i.id = iv.inv_item_id WHERE iv.product_variant_id = $1`, [lazyVariant]);
      expect(lazy.stock_uom).toBe("bunch");
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
