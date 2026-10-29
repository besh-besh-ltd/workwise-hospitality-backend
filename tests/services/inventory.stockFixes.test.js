// E1 stock review fixes: document codes (I-1), numbers too large to record
// (I-2), expiry after tracking stops (M-1), lazy item order (M-2), idempotency
// keys across document kinds (M-3), item setup visibility (M-4), barcode
// matching (M-5) and the activity line of a return (carry-forward 15).
//
// Service cases run inside withTx (rolled back). The cases that need two
// connections or the HTTP stack commit, so the suite truncates the dynamic
// tables before and after, and revokes its grants and activity rows.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { randomUUID } from "crypto";
import excelJS from "exceljs";
import { db, withTx, closeDb, truncateDynamic } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { revokeRoleScopes } from "../helpers/roleScope.js";
import {
  CO, CO_B, A1, A2, A3, FB, STORE, STORE_ID, CTRL, FOREIGN, asUser, grant, grantCast, makeItem, stockIn, move,
  balanceOf, thrownBy, istToday, addDays,
} from "../helpers/invStockFixtures.js";
import * as setup from "../../app/services/inventory/setupService.js";
import { previewOpeningStock, postOpeningStock } from "../../app/services/inventory/openingImport.js";
import { postOut } from "../../app/services/inventory/outService.js";
import { createAdjustment, approveAdjustment } from "../../app/services/inventory/adjustmentService.js";
import { startCount, saveCountLines, submitCount } from "../../app/services/inventory/countService.js";
import { getStockItem } from "../../app/services/inventory/stockQueries.js";
import { resolveScan } from "../../app/services/inventory/scanService.js";
import { postMovements } from "../../app/services/inventory/ledger.js";
import { sendInventoryError } from "../../app/services/inventory/errors.js";

/** A member of company A (mapped at A1, Technical Evaluator) holding no inventory permission. */
const NOBODY = asUser(IDS.users.a1_proc_techEval);
const BOGUS = 2000000000;

const out = (over = {}) => ({ hotelId: A1, docType: "OUT", departmentId: FB, clientEventId: randomUUID(), ...over });
const adj = (over = {}) => ({ hotelId: A1, reasonCode: "WASTAGE", submit: true, clientEventId: randomUUID(), ...over });

let seq = 0;
const tag = () => `inv-e1s-${process.pid}-${++seq}`;

/** A catalogue variant of its own (product + variant). */
async function makeVariant(t, name = `Variant ${tag()}`) {
  const product = await t.one(
    `INSERT INTO tbl_product (id, name, slug, added_by) VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM tbl_product), $1, $2, $3) RETURNING id`,
    [name, tag(), IDS.users.superAdmin]
  );
  const v = await t.one(
    `INSERT INTO tbl_product_variant (name, slug, sku, added_by, product_id) VALUES ($1, $2, NULL, $3, $4) RETURNING id`,
    [name, tag(), IDS.users.superAdmin, product.id]
  );
  return Number(v.id);
}

/** What a thrown error looks like to a client: code, message and details. */
const answerOf = (err) => ({ code: err.code, message: err.message, details: err.details });

async function openingXlsx(rows) {
  const wb = new excelJS.Workbook();
  const ws = wb.addWorksheet("Opening");
  ws.addRow(["Item Code", "Qty", "Unit", "Unit Cost"]);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const committedScopes = [];

beforeAll(async () => {
  await truncateDynamic();
});

afterAll(async () => {
  await revokeRoleScopes(db, committedScopes);
  await db.none(`DELETE FROM tbl_activity_events WHERE entity_type = 'INV_OUT'`);
  await truncateDynamic();
  await closeDb();
});

// ---------------------------------------------------------------------------
// I-1 document codes
// ---------------------------------------------------------------------------

describe("I-1 document codes", () => {
  it("a hotel's document code is frozen once it has numbered a document; setting the first code still works", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "E1 Rice" });
      for (const hotelId of [A1, A3]) await stockIn(t, { hotelId, invItemId: item, qty: 10, unitCost: 10 });

      // a fresh hotel sets its code, and may still change it while nothing is numbered
      await setup.saveHotelSettings(t, CTRL, A1, { docCode: "E1W" });
      await setup.saveHotelSettings(t, CTRL, A1, { docCode: "E1X" });
      const { doc: first } = await postOut(t, CTRL, out({ lines: [{ invItemId: item, qty: 1 }] }));
      expect(first.outNumber).toMatch(/^OUT\/E1X\/\d{4}-\d{2}\/00001$/);

      // numbered: no rename, no clearing it back to the hotel id
      for (const docCode of ["E1Y", "e1x", null]) {
        const err = await thrownBy(t, (sp) => setup.saveHotelSettings(sp, CTRL, A1, { docCode }));
        expect({ docCode, code: err.code, status: err.httpStatus, field: err.details?.field }).toEqual({
          docCode, code: "CONFLICT", status: 409, field: "docCode",
        });
        expect(err.message).toMatch(/can't change once documents are numbered/);
      }
      // saving the same code (and other settings) is no change
      const { result: same } = await setup.saveHotelSettings(t, CTRL, A1, { docCode: "E1X", includeGstInCost: true });
      expect(same).toMatchObject({ docCode: "E1X", includeGstInCost: true });

      // A3 numbered under the default code (its id) and has no code yet: its first code is still allowed
      const { doc: byId } = await postOut(t, CTRL, out({ hotelId: A3, lines: [{ invItemId: item, qty: 1 }] }));
      expect(byId.outNumber).toMatch(new RegExp(`^OUT/${A3}/\\d{4}-\\d{2}/00001$`));
      await setup.saveHotelSettings(t, CTRL, A3, { docCode: "E1R" });
      const { doc: byCode } = await postOut(t, CTRL, out({ hotelId: A3, lines: [{ invItemId: item, qty: 1 }] }));
      expect(byCode.outNumber).toMatch(/^OUT\/E1R\/\d{4}-\d{2}\/00002$/);
    });
  });

  it("no hotel takes a code another hotel holds or has held, so document numbers never collide", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "E1 Dal" });
      for (const hotelId of [A1, A2]) await stockIn(t, { hotelId, invItemId: item, qty: 10, unitCost: 10 });

      await setup.saveHotelSettings(t, CTRL, A1, { docCode: "E1X" });
      await postOut(t, CTRL, out({ lines: [{ invItemId: item, qty: 1 }] }));
      // A3 held E1P before settling on E1S (nothing numbered in between)
      await setup.saveHotelSettings(t, CTRL, A3, { docCode: "E1P" });
      await setup.saveHotelSettings(t, CTRL, A3, { docCode: "E1S" });

      for (const docCode of ["E1X", "e1x", "E1P", "e1p", "E1S"]) {
        const err = await thrownBy(t, (sp) => setup.saveHotelSettings(sp, CTRL, A2, { docCode }));
        expect({ docCode, code: err.code, field: err.details?.field }).toEqual({ docCode, code: "CONFLICT", field: "docCode" });
      }

      // A3 may go back to a code it held itself
      await setup.saveHotelSettings(t, CTRL, A3, { docCode: "E1P" });

      // A2 numbers with a code of its own: no clash with A1's OUT/E1X/…/00001
      await setup.saveHotelSettings(t, CTRL, A2, { docCode: "E1Z" });
      const { doc } = await postOut(t, CTRL, out({ hotelId: A2, lines: [{ invItemId: item, qty: 1 }] }));
      expect(doc.outNumber).toMatch(/^OUT\/E1Z\/\d{4}-\d{2}\/00001$/);

      // company B is another numbering space: it may use E1X
      await setup.saveHotelSettings(t, FOREIGN, IDS.hotels.B1, { docCode: "E1X" });
    });
  });
});

// ---------------------------------------------------------------------------
// I-2 numbers too large to record
// ---------------------------------------------------------------------------

describe("I-2 numbers too large to record", () => {
  it("a FOUND adjustment too large to value is refused when it is raised, not when it is approved", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "E1 Saffron" });
      await stockIn(t, { invItemId: item, qty: 1, unitCost: 1000 });
      const key = randomUUID();
      const err = await thrownBy(t, (sp) => createAdjustment(sp, STORE, adj({
        reasonCode: "FOUND", clientEventId: key, lines: [{ invItemId: item, qty: 900000000000 }],
      })));
      expect(err.code).toBe("VALIDATION");
      expect(err.httpStatus).toBe(400);
      expect(err.details).toMatchObject({ field: "lines", index: 0, invItemId: item });
      expect(err.message).toContain("E1 Saffron");
      expect(await t.oneOrNone(`SELECT id FROM tbl_inv_adjustment WHERE client_event_id = $1`, [key])).toBeNull();
    });
  });

  it("approving an adjustment whose value has outgrown what can be stored is VALIDATION, not a database error", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "E1 Truffle" });
      await stockIn(t, { invItemId: item, qty: 1, unitCost: 1 });
      const { adjustment } = await createAdjustment(t, STORE, adj({
        reasonCode: "FOUND", lines: [{ invItemId: item, qty: 90000000000 }],
      }));
      expect(adjustment.status).toBe("pending_approval");
      // the average climbs to about 1e7 before the approver gets to it
      await stockIn(t, { invItemId: item, qty: 1, unitCost: 20000000, type: "GRN_IN" });

      const err = await thrownBy(t, (sp) => approveAdjustment(sp, CTRL, adjustment.id));
      expect({ code: err.code, status: err.httpStatus, field: err.details?.field, invItemId: err.details?.invItemId })
        .toEqual({ code: "VALIDATION", status: 400, field: "lines", invItemId: item });
      expect((await balanceOf(t, A1, item)).qty).toBe(2);
    });
  });

  it("the ledger refuses a quantity or value too large to record, naming the item", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t, { name: "E1 Gold Leaf" });
      const opening = (qty, unitCost) => [{
        companyId: CO, hotelId: A1, invItemId: item, type: "OPENING", qty, unitCost,
        sourceType: "ADJ", sourceId: 999999, postedBy: STORE_ID,
      }];
      for (const [qty, unitCost] of [[1e15, 1], [1e13, 1e5], [1, 1e15]]) {
        const err = await thrownBy(t, (sp) => postMovements(sp, opening(qty, unitCost)));
        expect({ qty, unitCost, code: err.code, index: err.details?.index, invItemId: err.details?.invItemId })
          .toEqual({ qty, unitCost, code: "VALIDATION", index: 0, invItemId: item });
        expect(err.message).toContain("E1 Gold Leaf");
      }
      expect(await balanceOf(t, A1, item)).toEqual({ qty: 0, avgCost: 0, value: 0 });
    });
  });

  it("count submit refuses a variance too large to value", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "E1 Vanilla" });
      await stockIn(t, { invItemId: item, qty: 1, unitCost: 1000000 });
      const count = await startCount(t, STORE, { hotelId: A1, scope: "SELECTED", isBlind: false, invItemIds: [item] });
      await saveCountLines(t, STORE, count.id, [{ invItemId: item, countedQty: 900000000000, clientEventId: randomUUID() }]);
      const err = await thrownBy(t, (sp) => submitCount(sp, STORE, count.id));
      expect({ code: err.code, field: err.details?.field }).toEqual({ code: "VALIDATION", field: "lines" });
      expect(err.details.lines).toEqual([expect.objectContaining({ invItemId: item, displayName: "E1 Vanilla" })]);
      expect((await t.one(`SELECT status FROM tbl_inv_count WHERE id = $1`, [count.id])).status).toBe("open");
    });
  });

  it("opening import refuses rows too large to record, row by row, in the preview and the post", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const code = (n) => `E1-OPEN-${process.pid}-${n}`;
      const items = [];
      for (let i = 0; i < 4; i += 1) items.push(await makeItem(t, { name: `E1 Opening ${i}`, itemCode: code(i) }));
      const rows = [
        { invItemId: items[0], stockQty: 1e12, unitCost: 1 }, // quantity
        { invItemId: items[1], stockQty: 1, unitCost: 1e10 }, // unit cost
        { invItemId: items[2], stockQty: 1e8, unitCost: 1e7 }, // value
        { invItemId: items[3], stockQty: 5, unitCost: 10 }, // fine
      ];
      const err = await thrownBy(t, (sp) => postOpeningStock(sp, CTRL, A1, rows, randomUUID()));
      expect({ code: err.code, field: err.details?.field }).toEqual({ code: "VALIDATION", field: "rows" });
      expect(err.details.rows.map((r) => [r.index, r.invItemId, r.error])).toEqual([
        [0, items[0], "Quantity is too large"],
        [1, items[1], "Unit cost is too large"],
        [2, items[2], "Value is too large"],
      ]);

      const preview = await previewOpeningStock(t, CTRL, A1, await openingXlsx([
        [code(0), 1e12, "kg", 1], [code(1), 1, "kg", 1e10], [code(2), 1e8, "kg", 1e7], [code(3), 5, "kg", 10],
      ]));
      expect(preview.rows.map((r) => r.error)).toEqual([
        "Quantity is too large", "Unit cost is too large", "Value is too large", null,
      ]);
    });
  });

  it("setup refuses levels, pack sizes, limits, unit factors and shelf lives too large to store", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "E1 Setup" });
      const cases = [
        ["minQty", (sp) => setup.saveHotelItem(sp, CTRL, { hotelId: A1, invItemId: item }, { minQty: 1e14 })],
        ["packFactor", (sp) => setup.addItemBarcode(sp, CTRL, item, { code: `E1PACK${process.pid}`, packFactor: 1e14 })],
        ["adjustmentAutoApproveLimit", (sp) => setup.saveCompanySettings(sp, CTRL, { adjustmentAutoApproveLimit: 1e14 })],
        ["factor", (sp) => setup.saveItemUoms(sp, CTRL, item, { uoms: [{ uomLabel: "crate", factorToStock: 1e12 }] })],
        ["minShelfLifeDays", (sp) => setup.updateItem(sp, CTRL, item, { minShelfLifeDays: 1e10 })],
      ];
      for (const [field, call] of cases) {
        const err = await thrownBy(t, call);
        expect({ field, code: err.code, status: err.httpStatus, detail: err.details?.field })
          .toEqual({ field, code: "VALIDATION", status: 400, detail: field });
      }
    });
  });

  it("a number the database cannot store answers 400 VALIDATION, never a 500", () => {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    const pgError = Object.assign(new Error("numeric field overflow"), { code: "22003" });
    sendInventoryError(res, pgError);
    expect({ status: res.statusCode, body: res.body }).toEqual({
      status: 400,
      body: { status: 0, code: "VALIDATION", message: "A number is too large to record", details: {} },
    });
  });
});

// ---------------------------------------------------------------------------
// M-1 expiry once tracking is off
// ---------------------------------------------------------------------------

describe("M-1 expiry once tracking is off", () => {
  it("an item whose expiry tracking is off shows no batch expiries on its stock card", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "E1 Yoghurt" });
      await t.none(`UPDATE tbl_inv_item SET track_expiry = true WHERE id = $1`, [item]);
      const soon = addDays(await istToday(t), 5);
      await postMovements(t, [{
        companyId: CO, hotelId: A1, invItemId: item, type: "GRN_IN", qty: 5, unitCost: 10, batchNo: "Y-1",
        expiryDate: soon, sourceType: "GRN", sourceId: 999999, postedBy: STORE_ID,
      }]);
      const before = await getStockItem(t, STORE, { hotelId: A1, invItemId: item });
      expect(before.batches).toEqual([{ batchNo: "Y-1", expiryDate: soon, qty: 5 }]);

      await setup.updateItem(t, CTRL, item, { trackExpiry: false });
      await move(t, { invItemId: item, type: "MARK_OUT", qty: -5, departmentId: FB });

      const after = await getStockItem(t, STORE, { hotelId: A1, invItemId: item });
      expect({ trackExpiry: after.item.trackExpiry, qty: after.balance.qty, batches: after.batches })
        .toEqual({ trackExpiry: false, qty: 0, batches: [] });
      // the batch rows themselves stay (read-side filter): turning tracking back on heals them
      expect(Number((await t.one(`SELECT count(*) AS n FROM tbl_inv_batch WHERE inv_item_id = $1`, [item])).n)).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// M-2 lazy item order
// ---------------------------------------------------------------------------

describe("M-2 lazy item order", () => {
  it("opening import creates missing items in variant order, as a GRN does", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const low = await makeVariant(t, "E1 Lazy Low");
      const high = await makeVariant(t, "E1 Lazy High");
      expect(low).toBeLessThan(high);
      const row = (productVariantId) => ({ invItemId: null, productVariantId, stockUom: "kg", stockQty: 1, unitCost: 10 });
      await postOpeningStock(t, CTRL, A1, [row(high), row(low)], randomUUID());
      const made = await t.any(
        `SELECT product_variant_id, inv_item_id FROM tbl_inv_item_variant
          WHERE hospitality_company_id = $1 AND product_variant_id = ANY($2::int[]) ORDER BY inv_item_id`,
        [CO, [low, high]]
      );
      expect(made.map((r) => Number(r.product_variant_id))).toEqual([low, high]);
    });
  });
});

// ---------------------------------------------------------------------------
// M-3 one idempotency key, two document kinds
// ---------------------------------------------------------------------------

describe("M-3 one idempotency key, two document kinds", () => {
  it("a key used for an opening import is not replayed as an adjustment, nor the other way round", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "E1 Oats" });
      await stockIn(t, { invItemId: item, qty: 10, unitCost: 10 });

      const openingKey = randomUUID();
      const { result: opening } = await postOpeningStock(t, CTRL, A1, [{ invItemId: item, stockQty: 10, unitCost: 10 }], openingKey);
      const asAdjustment = await thrownBy(t, (sp) => createAdjustment(sp, STORE, adj({
        clientEventId: openingKey, lines: [{ invItemId: item, qty: -1 }],
      })));
      expect(answerOf(asAdjustment)).toEqual({
        code: "CONFLICT", message: "That clientEventId was used for another document", details: { field: "clientEventId" },
      });

      const adjustmentKey = randomUUID();
      const { adjustment } = await createAdjustment(t, STORE, adj({ clientEventId: adjustmentKey, lines: [{ invItemId: item, qty: -1 }] }));
      const asOpening = await thrownBy(t, (sp) => postOpeningStock(sp, CTRL, A1, [{ invItemId: item, stockQty: 3, unitCost: 10 }], adjustmentKey));
      expect(answerOf(asOpening)).toEqual({
        code: "CONFLICT", message: "That clientEventId was used for another document", details: { field: "clientEventId" },
      });

      // each kind still replays itself
      const again = await postOpeningStock(t, CTRL, A1, [{ invItemId: item, stockQty: 10, unitCost: 10 }], openingKey);
      expect(again.result.adjustmentId).toBe(opening.adjustmentId);
      const replay = await createAdjustment(t, STORE, adj({ clientEventId: adjustmentKey, lines: [{ invItemId: item, qty: -1 }] }));
      expect({ id: replay.adjustment.id, replayed: replay.replayed }).toEqual({ id: adjustment.id, replayed: true });
    });
  });
});

// ---------------------------------------------------------------------------
// M-4 item setup visibility
// ---------------------------------------------------------------------------

describe("M-4 item setup visibility", () => {
  it("a company member with no inventory role gets exactly the missing-id answer for a real item", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "E1 Hidden" });
      const barcode = await t.one(
        `INSERT INTO tbl_inv_item_barcode (hospitality_company_id, inv_item_id, code) VALUES ($1, $2, $3) RETURNING id`,
        [CO, item, `E1HID${process.pid}`]
      );
      const calls = {
        updateItem: (sp, id) => setup.updateItem(sp, NOBODY, id, { displayName: "x" }),
        mapVariantToItem: (sp, id) => setup.mapVariantToItem(sp, NOBODY, id, { productVariantId: 1 }),
        getItemUoms: (sp, id) => setup.getItemUoms(sp, NOBODY, id),
        saveItemUoms: (sp, id) => setup.saveItemUoms(sp, NOBODY, id, { uoms: [] }),
        addItemBarcode: (sp, id) => setup.addItemBarcode(sp, NOBODY, id, { code: "E1NEW" }),
        deleteItemBarcode: (sp, id) => setup.deleteItemBarcode(sp, NOBODY, id, barcode.id),
      };
      for (const [name, call] of Object.entries(calls)) {
        const real = answerOf(await thrownBy(t, (sp) => call(sp, item)));
        const missing = answerOf(await thrownBy(t, (sp) => call(sp, BOGUS)));
        expect({ name, real }).toEqual({ name, real: missing });
        expect({ name, code: real.code }).toEqual({ name, code: "NOT_FOUND" });
      }

      // somebody who can see the item but not act on it is still told so
      const err = await thrownBy(t, (sp) => setup.updateItem(sp, STORE, item, { displayName: "x" }));
      expect(err.code).toBe("FORBIDDEN");
    });
  });

  it("the item's row lock is taken only after the permission gate", async () => {
    const item = await makeItem(db, { name: "E1 Locked" });
    let release;
    const held = new Promise((r) => { release = r; });
    let lockTaken;
    const locked = new Promise((r) => { lockTaken = r; });
    const holder = db.tx(async (t) => {
      await t.one(`SELECT id FROM tbl_inv_item WHERE id = $1 FOR UPDATE`, [item]);
      lockTaken();
      await held;
    });
    await locked;
    let outcome;
    try {
      outcome = await db.tx(async (t) => {
        await t.none(`SET LOCAL lock_timeout = '500ms'`);
        try {
          await t.tx((sp) => setup.updateItem(sp, NOBODY, item, { displayName: "x" }));
          return "saved";
        } catch (err) {
          return err.code;
        }
      });
    } finally {
      release();
      await holder;
    }
    // before the fix the caller queued on the row lock: 55P03 lock_not_available
    expect(outcome).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// M-5 barcodes match the way the scan matches
// ---------------------------------------------------------------------------

describe("M-5 barcodes match the way the scan matches", () => {
  it("barcodes are unique per company ignoring case and surrounding spaces", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const first = await makeItem(t, { name: "E1 Tag A" });
      const second = await makeItem(t, { name: "E1 Tag B" });
      const { result: added } = await setup.addItemBarcode(t, CTRL, first, { code: "  abc12X  ", source: "INTERNAL" });
      expect(added.code).toBe("abc12X");

      const err = await thrownBy(t, (sp) => setup.addItemBarcode(sp, CTRL, second, { code: "ABC12x", source: "INTERNAL" }));
      expect({ code: err.code, field: err.details?.field, invItemId: err.details?.invItemId })
        .toEqual({ code: "CONFLICT", field: "code", invItemId: first });
      expect(err.message).toContain("E1 Tag A");

      // the database holds the line too
      const raw = await thrownBy(t, (sp) => sp.none(
        `INSERT INTO tbl_inv_item_barcode (hospitality_company_id, inv_item_id, code) VALUES ($1, $2, 'ABC12X')`,
        [CO, second]
      ));
      expect(raw.code).toBe("23505");

      // another company is another namespace
      const foreign = await makeItem(t, { companyId: CO_B, name: "E1 Tag B-co" });
      await setup.addItemBarcode(t, FOREIGN, foreign, { code: "ABC12X", source: "INTERNAL" });
    });
  });

  it("a numeric code the scan reads as another alias's GTIN is refused", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const first = await makeItem(t, { name: "E1 Cola can" });
      const second = await makeItem(t, { name: "E1 Cola crate" });
      await setup.addItemBarcode(t, CTRL, first, { code: "012345678905" }); // UPC-A
      const err = await thrownBy(t, (sp) => setup.addItemBarcode(sp, CTRL, second, { code: "0012345678905" })); // its EAN-13
      expect({ code: err.code, invItemId: err.details?.invItemId }).toEqual({ code: "CONFLICT", invItemId: first });
    });
  });

  it("a scan that matches two items reports a conflict instead of picking one", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const first = await makeItem(t, { name: "E1 Twin one" });
      const second = await makeItem(t, { name: "E1 Twin two" });
      // written around setup (as older data could be): the same GTIN on two items
      await t.none(
        `INSERT INTO tbl_inv_item_barcode (hospitality_company_id, inv_item_id, code)
         VALUES ($1, $2, '012345678905'), ($1, $3, '0012345678905')`,
        [CO, first, second]
      );
      // the GTIN-14 read, and either printed form: all one product, claimed by two items
      for (const code of ["00012345678905", "012345678905", "0012345678905"]) {
        const err = await thrownBy(t, (sp) => resolveScan(sp, STORE, { code, context: `hotel:${A1}` }));
        expect({ code, err: err.code, status: err.httpStatus }).toEqual({ code, err: "CONFLICT", status: 409 });
        expect(err.details.candidates.map((c) => c.invItemId).sort((a, b) => a - b)).toEqual([first, second].sort((a, b) => a - b));
      }

      // one alias, one item: resolved as before
      const third = await makeItem(t, { name: "E1 Single" });
      await t.none(`INSERT INTO tbl_inv_item_barcode (hospitality_company_id, inv_item_id, code) VALUES ($1, $2, 'E1-ONLY-ONE')`, [CO, third]);
      const single = await resolveScan(t, STORE, { code: "e1-only-one", context: `hotel:${A1}` });
      expect(single).toMatchObject({ kind: "item", item: { invItemId: third } });
    });
  });
});

// ---------------------------------------------------------------------------
// carry-forward 15: a return reads as a return
// ---------------------------------------------------------------------------

describe("activity trail for mark-out and return", () => {
  async function summaryOf(outId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await db.oneOrNone(
        `SELECT event_key, summary FROM tbl_activity_events WHERE entity_type = 'INV_OUT' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
        [String(outId)]
      );
      if (row || Date.now() > deadline) return row;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("a return to stock is summarised as a return, a mark-out as a mark-out (one event key)", async () => {
    committedScopes.push(await grant(db, STORE_ID, "Storekeeper"));
    const item = await makeItem(db, { name: "E1 Napkins" });
    await db.tx((t) => stockIn(t, { invItemId: item, qty: 10, unitCost: 5 }));
    const store = await httpClient(STORE_ID);

    const marked = await store.post("/api/v1/inventory/out").send(out({ lines: [{ invItemId: item, qty: 3 }] }));
    expect(marked.status).toBe(201);
    const returned = await store.post("/api/v1/inventory/out").send(out({ docType: "RETURN", lines: [{ invItemId: item, qty: 1 }] }));
    expect(returned.status).toBe(201);

    const outEvent = await summaryOf(marked.body.data.id);
    const returnEvent = await summaryOf(returned.body.data.id);
    expect(outEvent.event_key).toBe("inventory_stock_marked_out");
    expect(returnEvent.event_key).toBe("inventory_stock_marked_out");
    expect(outEvent.summary).toMatch(/ marked stock out OUT\//);
    expect(returnEvent.summary).toMatch(/ returned stock RET\//);
    expect(returnEvent.summary).not.toContain("marked stock out");
  });
});
