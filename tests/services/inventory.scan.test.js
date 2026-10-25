// Scan resolve and short links (Task B4).
//
// Every scan screen sends what it read (camera, keyboard-wedge scanner or typed
// by hand) to one resolver. It tries, in order: our own QR short URL
// (/s/<t>/<id>), a GS1 code (its GTIN looked up as a barcode alias), a plain
// barcode alias, the stock item code, then a catalogue variant SKU. Everything
// resolves inside the caller's scope only: another company's code is simply
// unknown, and another company's short link is a 404 (spec §10.1).
//
// Service tests run inside withTx (always rolled back). The HTTP block at the
// end commits its rows and removes them afterwards.

import { describe, it, expect, afterAll, beforeAll } from "@jest/globals";
import { db, withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import { httpClient } from "../helpers/http.js";
import {
  tag,
  storekeeperRoleId,
  roleWith,
  makeItem,
  addBarcode,
  freeVariants,
  mapVariant,
  makeRfqPo,
  makeGrn,
  makeDispatch,
  thrownBy,
} from "../helpers/invScanFixtures.js";
import {
  parseGs1,
  resolveScan,
  resolveShortLink,
} from "../../app/services/inventory/scanService.js";
import { InventoryError } from "../../app/services/inventory/errors.js";

const A = IDS.hospitality.A;
const B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const B1 = IDS.hotels.B1;
// Mapped to company A (hotel A1), holding no grn / inventory grant until a
// test gives one.
const USER = { id: IDS.users.a1_proc_techApp, user_type: 2 };
const GS = "\x1d";

afterAll(async () => {
  await closeDb();
});

const grantStorekeeper = async (t, hotelId) =>
  grantRoleScope(t, { userId: USER.id, roleId: await storekeeperRoleId(t), companyId: A, hotelId });

describe("parseGs1", () => {
  it("parseGs1 handles (01)(17)(10) with GS separators and day-00 expiry", () => {
    // GS1-128 with its symbology identifier; the variable batch ends at GS.
    expect(parseGs1(`]C1` + `0109501101530003` + `17270300` + `10ABC-123${GS}21SER9`)).toEqual({
      gtin: "09501101530003",
      batch: "ABC-123",
      expiry: "2027-03-31", // day 00 = last day of the month
      serial: "SER9",
    });
    // GS1 DataMatrix; the batch comes first, so a GS ends it.
    expect(parseGs1(`]d2010950110153000310LOT7${GS}17270200`)).toEqual({
      gtin: "09501101530003", batch: "LOT7", expiry: "2027-02-28", serial: null,
    });
    expect(parseGs1(`]d2010950110153000317280200`).expiry).toBe("2028-02-29");

    // Human-readable form, typed by hand.
    expect(parseGs1("(01)09501101530003(17)261215(10)L-42")).toEqual({
      gtin: "09501101530003", batch: "L-42", expiry: "2026-12-15", serial: null,
    });
    // No identifier: a camera read gives the bare element string. Accepted
    // when it opens with (01) and a GTIN whose check digit is right.
    expect(parseGs1(`010950110153000310B1${GS}17280229`)).toEqual({
      gtin: "09501101530003", batch: "B1", expiry: "2028-02-29", serial: null,
    });
    // Some scanners send the leading FNC1 as a GS.
    expect(parseGs1(`${GS}0109501101530003`)).toEqual({
      gtin: "09501101530003", batch: null, expiry: null, serial: null,
    });
    // Fixed-length AIs need no separator: (11) production date, then (17).
    expect(parseGs1("]C1010950110153000311260101172612001099").expiry).toBe("2026-12-31");

    // An impossible date keeps the rest; an unknown AI stops the parse.
    expect(parseGs1("]C1010950110153000317271340")).toEqual({
      gtin: "09501101530003", batch: null, expiry: null, serial: null,
    });
    expect(parseGs1("]C1010950110153000399XYZ").gtin).toBe("09501101530003");

    // Not GS1: plain EANs, words, a bare 01-string with a wrong check digit,
    // a short GTIN, nothing.
    for (const code of ["8901234567890", "hello", "0109501101530004", "]C1010950110", "", null, undefined]) {
      expect([code, parseGs1(code)]).toEqual([code, null]);
    }
  });
});

describe("resolveScan and resolveShortLink", () => {
  it("resolve short URL to po", async () => {
    await withTx(async (t) => {
      await grantStorekeeper(t, A1);
      const { poId } = await makeRfqPo(t, { lines: [{ qty: 5 }] });

      for (const code of [
        `https://app.example.com/s/p/${poId}`,
        `/s/p/${poId}`,
        `http://localhost:3000/s/P/${poId}/`,
      ]) {
        expect(await resolveScan(t, USER, { code, context: `hotel:${A1}` })).toEqual({
          kind: "po", code, gs1: null, item: null, poId,
        });
      }
      // The id arrives as a query-string value.
      expect(await resolveShortLink(t, USER, { t: "p", id: String(poId) })).toEqual({
        path: `/dashboard/buyer/purchase-orders/${poId}?tab=deliveries`,
      });
    });
  });

  it("short links open the GRN, the item's stock card and the dispatch's receive screen", async () => {
    await withTx(async (t) => {
      // Storekeeper at A2 only: the item opens on A2, the first hotel in scope.
      await grantStorekeeper(t, A2);
      const item = await makeItem(t, { name: "Basmati rice", stockUom: "kg" });
      const { poId, lineIds } = await makeRfqPo(t, { hotel: A2, lines: [{ qty: 10 }] });
      const grnId = await makeGrn(t, {
        hotelId: A2, poId, lines: [{ poLineId: lineIds[0], invItemId: item, accepted: 10 }],
      });
      const dispatchId = await makeDispatch(t, { poId, hotelId: A2 });

      expect(await resolveShortLink(t, USER, { t: "g", id: grnId })).toEqual({
        path: `/dashboard/buyer/inventory/grn/${grnId}`,
      });
      expect(await resolveShortLink(t, USER, { t: "i", id: item })).toEqual({
        path: `/dashboard/buyer/inventory/stock/${A2}/${item}`,
      });
      expect(await resolveShortLink(t, USER, { t: "d", id: dispatchId })).toEqual({
        path: `/dashboard/buyer/inventory/receive/${poId}?dispatch=${dispatchId}`,
      });

      const ctx = { context: `hotel:${A2}` };
      expect(await resolveScan(t, USER, { code: `/s/g/${grnId}`, ...ctx })).toMatchObject({
        kind: "grn", grnId, poId, item: null,
      });
      expect(await resolveScan(t, USER, { code: `/s/d/${dispatchId}`, ...ctx })).toMatchObject({
        kind: "dispatch", dispatchId, poId, item: null,
      });
      expect(await resolveScan(t, USER, { code: `/s/i/${item}`, ...ctx })).toEqual({
        kind: "item",
        code: `/s/i/${item}`,
        gs1: null,
        item: {
          invItemId: item, displayName: "Basmati rice", stockUom: "kg", packFactor: 1, poLineId: null,
          stockedAtHotel: false,
        },
      });

      // A GRN at a hotel the user has no grant on is not theirs to open.
      const { poId: a1Po, lineIds: a1Lines } = await makeRfqPo(t, { hotel: A1, lines: [{ qty: 1 }] });
      const a1Grn = await makeGrn(t, {
        hotelId: A1, poId: a1Po, lines: [{ poLineId: a1Lines[0], invItemId: item, accepted: 1 }],
      });
      const err = await thrownBy(t, (sp) => resolveShortLink(sp, USER, { t: "g", id: a1Grn }));
      expect(err).toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
      expect(await resolveScan(t, USER, { code: `/s/g/${a1Grn}`, ...ctx })).toMatchObject({ kind: "unknown" });
    });
  });

  it("resolve manufacturer EAN alias with pack factor", async () => {
    await withTx(async (t) => {
      await grantStorekeeper(t, A1);
      const butter = await makeItem(t, { name: "Amul Butter 100g", stockUom: "pcs" });
      // The carton EAN: one scan is 24 pieces.
      await addBarcode(t, { invItemId: butter, code: "8901234567897", packFactor: 24 });
      const ctx = { context: `hotel:${A1}` };

      expect(await resolveScan(t, USER, { code: "8901234567897", ...ctx })).toEqual({
        kind: "item",
        code: "8901234567897",
        gs1: null,
        item: {
          invItemId: butter, displayName: "Amul Butter 100g", stockUom: "pcs", packFactor: 24, poLineId: null,
          stockedAtHotel: false,
        },
      });
      // Scanner noise around the code is ignored.
      expect((await resolveScan(t, USER, { code: " 8901234567897\r\n", ...ctx })).item.invItemId).toBe(butter);

      // The same product's GS1-128: the 14-digit GTIN matches the 13-digit
      // alias, and batch / expiry come back to prefill the receipt.
      const gs1Code = `]C10108901234567897` + `10B9${GS}17271200`;
      expect(await resolveScan(t, USER, { code: gs1Code, ...ctx })).toEqual({
        kind: "item",
        code: gs1Code,
        gs1: { gtin: "08901234567897", batch: "B9", expiry: "2027-12-31", serial: null },
        item: {
          invItemId: butter, displayName: "Amul Butter 100g", stockUom: "pcs", packFactor: 24, poLineId: null,
          stockedAtHotel: false,
        },
      });

      // A GS1 code whose GTIN is not an alias is unknown, with the parse kept
      // so the screen can offer to link the GTIN.
      const stranger = `]C10109501101530003` + `10X1`;
      expect(await resolveScan(t, USER, { code: stranger, ...ctx })).toEqual({
        kind: "unknown",
        code: stranger,
        gs1: { gtin: "09501101530003", batch: "X1", expiry: null, serial: null },
        item: null,
      });
      expect(await resolveScan(t, USER, { code: "NOPE-404", ...ctx })).toEqual({
        kind: "unknown", code: "NOPE-404", gs1: null, item: null,
      });
    });
  });

  it("plain codes fall back to the item code, then a mapped variant's SKU", async () => {
    await withTx(async (t) => {
      await grantStorekeeper(t, A1);
      const ctx = { context: `hotel:${A1}` };
      const coded = await makeItem(t, { name: "Paneer", itemCode: `PNR-${process.pid}` });
      expect((await resolveScan(t, USER, { code: `pnr-${process.pid}`, ...ctx })).item).toMatchObject({
        invItemId: coded, packFactor: 1,
      });

      const [variant] = await freeVariants(t, 1);
      const sku = `SKU-${tag()}`;
      await t.none(`UPDATE tbl_product_variant SET sku = $2 WHERE id = $1`, [variant, sku]);
      const mapped = await makeItem(t, { name: "Mapped by SKU" });
      await mapVariant(t, { invItemId: mapped, variantId: variant });
      expect((await resolveScan(t, USER, { code: sku.toLowerCase(), ...ctx })).item).toMatchObject({
        invItemId: mapped, packFactor: 1,
      });

      // An alias beats an item code that reads the same.
      const aliased = await makeItem(t, { name: "Aliased" });
      const clash = `CLASH-${process.pid}`;
      await makeItem(t, { name: "Coded the same", itemCode: clash });
      await addBarcode(t, { invItemId: aliased, code: clash, packFactor: 6 });
      expect((await resolveScan(t, USER, { code: clash, ...ctx })).item).toMatchObject({
        invItemId: aliased, packFactor: 6,
      });

      // Without a context the user's own hotels set the company.
      expect((await resolveScan(t, USER, { code: clash })).item.invItemId).toBe(aliased);
    });
  });

  it("resolve within PO context returns poLineId; item not on PO is unknown", async () => {
    await withTx(async (t) => {
      await grantStorekeeper(t, A1);
      const [v1, v2] = await freeVariants(t, 2);
      const onPo = await makeItem(t, { name: "On the PO" });
      await mapVariant(t, { invItemId: onPo, variantId: v1 });
      await addBarcode(t, { invItemId: onPo, code: `ON-PO-${process.pid}`, packFactor: 12 });
      const offPo = await makeItem(t, { name: "Not on the PO" });
      await mapVariant(t, { invItemId: offPo, variantId: v2 });
      await addBarcode(t, { invItemId: offPo, code: `OFF-PO-${process.pid}` });

      const { poId, lineIds } = await makeRfqPo(t, {
        lines: [{ qty: 3, variantId: null }, { qty: 4, variantId: v1 }, { qty: 2, variantId: v1 }],
      });
      const ctx = { context: `po:${poId}` };

      expect(await resolveScan(t, USER, { code: `ON-PO-${process.pid}`, ...ctx })).toEqual({
        kind: "item",
        code: `ON-PO-${process.pid}`,
        gs1: null,
        item: {
          invItemId: onPo, displayName: "On the PO", stockUom: "kg", packFactor: 12, poLineId: lineIds[1],
          stockedAtHotel: null, // a PO context names no single hotel
        },
      });
      // The item is on two lines: once the first is received, the next open one.
      await t.none(`UPDATE tbl_purchase_order_product SET receipt_status = 'received' WHERE id = $1`, [lineIds[1]]);
      expect((await resolveScan(t, USER, { code: `ON-PO-${process.pid}`, ...ctx })).item.poLineId).toBe(lineIds[2]);
      expect((await resolveScan(t, USER, { code: `/s/i/${onPo}`, ...ctx })).item.poLineId).toBe(lineIds[2]);

      expect(await resolveScan(t, USER, { code: `OFF-PO-${process.pid}`, ...ctx })).toEqual({
        kind: "unknown", code: `OFF-PO-${process.pid}`, gs1: null, item: null,
      });
      expect((await resolveScan(t, USER, { code: `/s/i/${offPo}`, ...ctx })).kind).toBe("unknown");
      // Outside the PO the same code is an ordinary item.
      expect((await resolveScan(t, USER, { code: `OFF-PO-${process.pid}`, context: `hotel:${A1}` })).item).toMatchObject({
        invItemId: offPo, poLineId: null,
      });
    });
  });

  it("in a PO context the alias of the item on the PO wins over a closer match off it", async () => {
    await withTx(async (t) => {
      await grantStorekeeper(t, A1);
      const [v1] = await freeVariants(t, 1);
      const onPo = await makeItem(t, { name: "Mixed-case alias, on the PO" });
      await mapVariant(t, { invItemId: onPo, variantId: v1 });
      const offPo = await makeItem(t, { name: "Exact alias, off the PO" });
      const code = `MIX-${process.pid}`;
      await addBarcode(t, { invItemId: offPo, code });
      await addBarcode(t, { invItemId: onPo, code: code.toLowerCase(), packFactor: 6 });
      const { poId, lineIds } = await makeRfqPo(t, { lines: [{ qty: 6, variantId: v1 }] });

      // Off the PO, the exact alias is the better match ...
      expect((await resolveScan(t, USER, { code, context: `hotel:${A1}` })).item.invItemId).toBe(offPo);
      // ... on the PO only the PO's item is a candidate, so it is found, not "unknown".
      expect((await resolveScan(t, USER, { code, context: `po:${poId}` })).item).toMatchObject({
        invItemId: onPo, packFactor: 6, poLineId: lineIds[0],
      });
    });
  });

  it("UPC-E and its UPC-A / EAN-13 / GTIN-14 forms are one product", async () => {
    await withTx(async (t) => {
      await grantStorekeeper(t, A1);
      const ctx = { context: `hotel:${A1}` };
      // UPC-E 04252614 is UPC-A 042100005264 (last data digit 1: manufacturer
      // 42100, product 00526), not 04252614 padded with zeros.
      const cola = await makeItem(t, { name: "Cola 330ml can" });
      await addBarcode(t, { invItemId: cola, code: "042100005264" });
      for (const code of ["04252614", "0042100005264", `]C1010004210000526410LOT${GS}`]) {
        const r = await resolveScan(t, USER, { code, ...ctx });
        expect([code, r.kind, r.item?.invItemId]).toEqual([code, "item", cola]);
      }

      // Stored as UPC-E, found from the long forms.
      const chips = await makeItem(t, { name: "Chips 50g" });
      await addBarcode(t, { invItemId: chips, code: "01234565" });
      for (const code of ["012345000065", "0012345000065", "00012345000065"]) {
        const r = await resolveScan(t, USER, { code, ...ctx });
        expect([code, r.kind, r.item?.invItemId]).toEqual([code, "item", chips]);
      }

      // An 8-digit code that is not a valid UPC-E stays an EAN-8: zero-padding
      // never turns it into some UPC-A.
      expect((await resolveScan(t, USER, { code: "04252615", ...ctx })).kind).toBe("unknown");
    });
  });

  it("in a hotel context an item not stocked there still resolves, flagged stockedAtHotel:false", async () => {
    await withTx(async (t) => {
      await grantStorekeeper(t, null); // every company-A hotel
      const held = await makeItem(t, { name: "Has a balance at A1" });
      await t.none(
        `INSERT INTO tbl_inv_balance (hotel_id, inv_item_id, hospitality_company_id, qty) VALUES ($1, $2, $3, 4)`,
        [A1, held, A]
      );
      const binned = await makeItem(t, { name: "Has a bin at A1" });
      await t.none(
        `INSERT INTO tbl_inv_hotel_item (hotel_id, inv_item_id, hospitality_company_id, bin_label) VALUES ($1, $2, $3, 'B-1')`,
        [A1, binned, A]
      );
      const never = await makeItem(t, { name: "Never stocked" });
      for (const [id, n] of [[held, 1], [binned, 2], [never, 3]]) {
        await addBarcode(t, { invItemId: id, code: `STK-${process.pid}-${n}` });
      }

      const at = async (n, context) => (await resolveScan(t, USER, { code: `STK-${process.pid}-${n}`, context }));
      for (const [n, a1, a2] of [[1, true, false], [2, true, false], [3, false, false]]) {
        const r1 = await at(n, `hotel:${A1}`);
        const r2 = await at(n, `hotel:${A2}`);
        // The code is known either way: "kind:item", never the link-this-code path.
        expect([n, r1.kind, r1.item.stockedAtHotel, r2.kind, r2.item.stockedAtHotel])
          .toEqual([n, "item", a1, "item", a2]);
      }
      // No single hotel in play: no flag.
      expect((await at(1, undefined)).item.stockedAtHotel).toBeNull();
    });
  });

  it("our item QR resolves for a receiver with GRN rights only; its stock card link needs inventory.read", async () => {
    await withTx(async (t) => {
      await grantRoleScope(t, { userId: USER.id, roleId: await roleWith(t, ["grn.read", "grn.create"]), companyId: A, hotelId: A1 });
      const item = await makeItem(t, { name: "Labelled by us" });
      expect(await resolveScan(t, USER, { code: `/s/i/${item}`, context: `hotel:${A1}` })).toMatchObject({
        kind: "item", item: { invItemId: item, stockedAtHotel: false },
      });
      // The phone-camera link opens the stock card, which this user cannot read.
      const err = await thrownBy(t, (sp) => resolveShortLink(sp, USER, { t: "i", id: item }));
      expect(err).toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    });
  });

  it("foreign company code is unknown, foreign id short link is 404", async () => {
    await withTx(async (t) => {
      // Storekeeper on every company-A hotel.
      await grantStorekeeper(t, null);
      const foreignItem = await makeItem(t, { companyId: B, itemCode: `FOREIGN-${process.pid}` });
      await addBarcode(t, { companyId: B, invItemId: foreignItem, code: `FOREIGN-EAN-${process.pid}` });
      const { poId: foreignPo, lineIds } = await makeRfqPo(t, {
        hospitality: B, company: IDS.companies.B, hotel: B1, lines: [{ qty: 1 }],
      });
      const foreignGrn = await makeGrn(t, {
        companyId: B, hotelId: B1, poId: foreignPo,
        lines: [{ poLineId: lineIds[0], invItemId: foreignItem, accepted: 1 }],
      });
      const foreignDispatch = await makeDispatch(t, { companyId: B, poId: foreignPo, hotelId: B1 });

      for (const code of [
        `FOREIGN-EAN-${process.pid}`,
        `FOREIGN-${process.pid}`,
        `/s/i/${foreignItem}`,
        `/s/p/${foreignPo}`,
        `/s/g/${foreignGrn}`,
        `/s/d/${foreignDispatch}`,
      ]) {
        for (const context of [`hotel:${A1}`, undefined]) {
          const r = await resolveScan(t, USER, { code, context });
          expect([code, context, r.kind, r.item]).toEqual([code, context, "unknown", null]);
        }
      }

      for (const [kind, id] of [
        ["i", foreignItem], ["p", foreignPo], ["g", foreignGrn], ["d", foreignDispatch],
        ["i", 999999999], ["x", 1], ["p", "abc"], ["p", -4],
      ]) {
        const err = await thrownBy(t, (sp) => resolveShortLink(sp, USER, { t: kind, id }));
        expect(err).toBeInstanceOf(InventoryError);
        expect([kind, id, err.code, err.httpStatus]).toEqual([kind, id, "NOT_FOUND", 404]);
      }

      // Another company's hotel or PO as the context is a 404 as well.
      for (const context of [`hotel:${B1}`, `po:${foreignPo}`, "po:999999999"]) {
        const err = await thrownBy(t, (sp) => resolveScan(sp, USER, { code: "anything", context }));
        expect([context, err.code]).toEqual([context, "NOT_FOUND"]);
      }

      // Vendors never resolve buyer short links, even for their own PO.
      const vendor = { id: IDS.users.vendor_alpha, user_type: 3 };
      const { poId: ownPo } = await makeRfqPo(t, { lines: [{ qty: 1 }] });
      expect((await thrownBy(t, (sp) => resolveShortLink(sp, vendor, { t: "p", id: ownPo }))).code).toBe("NOT_FOUND");
    });
  });

  it("a context without a read grant is 404 even inside the company (rule C3); bad input is 400", async () => {
    await withTx(async (t) => {
      // Mapped to company A but no grn / inventory grant anywhere.
      const { poId } = await makeRfqPo(t, { lines: [{ qty: 1 }] });
      for (const context of [`hotel:${A1}`, `po:${poId}`]) {
        const err = await thrownBy(t, (sp) => resolveScan(sp, USER, { code: "X-1", context }));
        expect([context, err.code, err.httpStatus]).toEqual([context, "NOT_FOUND", 404]);
        // Word for word what a context that does not exist gets.
        const missing = await thrownBy(t, (sp) => resolveScan(sp, USER, { code: "X-1", context: context.replace(/\d+$/, "999999999") }));
        expect(err.message).toBe(missing.message);
      }
      const none = await thrownBy(t, (sp) => resolveScan(sp, USER, { code: "X-1" }));
      expect(none.code).toBe("FORBIDDEN");

      // grn.read alone is enough to scan at a hotel.
      await grantRoleScope(t, { userId: USER.id, roleId: await roleWith(t, ["grn.read"]), companyId: A, hotelId: A1 });
      expect((await resolveScan(t, USER, { code: "X-1", context: `hotel:${A1}` })).kind).toBe("unknown");

      for (const args of [
        { code: "", context: `hotel:${A1}` },
        { code: "   ", context: `hotel:${A1}` },
        { code: "x".repeat(600), context: `hotel:${A1}` },
        { code: "X-1", context: "warehouse:1" },
        { code: "X-1", context: "hotel:abc" },
      ]) {
        const err = await thrownBy(t, (sp) => resolveScan(sp, USER, args));
        expect([args.context, err.code, err.httpStatus]).toEqual([args.context, "VALIDATION", 400]);
      }
    });
  });
});

describe("scan resolve and short links over HTTP", () => {
  const BASE = "/api/v1/inventory";
  const code = `HTTP-EAN-${process.pid}`;
  let prevUser;
  let grantIds = [];
  let itemId;

  beforeAll(async () => {
    prevUser = await db.one(`SELECT user_type, status FROM tbl_users WHERE id = $1`, [USER.id]);
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [USER.id]);
    grantIds = [await grantRoleScope(db, {
      userId: USER.id, roleId: await storekeeperRoleId(db), companyId: A, hotelId: A1,
    })];
    itemId = await makeItem(db, { name: `HTTP item ${process.pid}`, stockUom: "L" });
    await addBarcode(db, { invItemId: itemId, code, packFactor: 6 });
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_inv_item_barcode WHERE inv_item_id = $1`, [itemId]);
    await db.none(`DELETE FROM tbl_inv_item WHERE id = $1`, [itemId]);
    await revokeRoleScopes(db, grantIds);
    await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`, [
      USER.id, prevUser.user_type, prevUser.status,
    ]);
  });

  it("answers the contract envelope, and 404 / 400 for foreign or missing input", async () => {
    const c = await httpClient(USER.id);

    const ok = await c.get(`${BASE}/scan/resolve`).query({ code, context: `hotel:${A1}` });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      status: 1,
      message: expect.any(String),
      data: {
        kind: "item", code, gs1: null,
        item: {
          invItemId: itemId, displayName: `HTTP item ${process.pid}`, stockUom: "L", packFactor: 6, poLineId: null,
          stockedAtHotel: false,
        },
      },
    });

    const foreign = await c.get(`${BASE}/scan/resolve`).query({ code, context: `hotel:${B1}` });
    expect([foreign.status, foreign.body.status]).toEqual([404, 2]);
    const missing = await c.get(`${BASE}/scan/resolve`).query({ context: `hotel:${A1}` });
    expect([missing.status, missing.body.code]).toEqual([400, "VALIDATION"]);

    const link = await c.get(`${BASE}/s/resolve`).query({ t: "i", id: itemId });
    expect(link.status).toBe(200);
    expect(link.body.data).toEqual({ path: `/dashboard/buyer/inventory/stock/${A1}/${itemId}` });
    const gone = await c.get(`${BASE}/s/resolve`).query({ t: "i", id: 999999999 });
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ status: 2 });
  });
});
