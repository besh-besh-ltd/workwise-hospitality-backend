// Inventory admin setup (Task B3): items, barcodes, levels, settings, category
// defaults. Service calls run inside withTx (rolled back); role grants are
// made inside the same transaction, so nothing leaks.

import { describe, it, expect, afterAll } from "@jest/globals";
import { withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { grantRoleScope } from "../helpers/roleScope.js";
import * as setup from "../../app/services/inventory/setupService.js";
import { getEffectiveSettings } from "../../app/services/inventory/settings.js";
import { resolveItemForVariant } from "../../app/services/inventory/items.js";

const A = IDS.hospitality.A;
const B = IDS.hospitality.B;
const HOTEL_A1 = IDS.hotels.A1;
const HOTEL_A2 = IDS.hotels.A2;
const ADMIN_USER = { id: IDS.users.a1_proc_buyer, user_type: 2 };
const OTHER_USER = { id: IDS.users.a1_proc_poApp, user_type: 2 };
const B_USER = { id: IDS.users.companyB_admin, user_type: 2 };

afterAll(async () => {
  await closeDb();
});

let seq = 0;
const tag = () => `inv-b3-${process.pid}-${++seq}`;

async function roleId(t, title) {
  return Number((await t.one(`SELECT id FROM tbl_roles WHERE title = $1 AND created_by IS NULL`, [title])).id);
}
async function grant(t, user, title, companyId = A, hotelId = null) {
  await grantRoleScope(t, { userId: user.id, roleId: await roleId(t, title), companyId, hotelId });
}
async function makeVariant(t, name = `Variant ${tag()}`, sku = null) {
  const product = await t.one(
    `INSERT INTO tbl_product (id, name, slug, added_by) VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM tbl_product), $1, $2, $3) RETURNING id`,
    [name, tag(), IDS.users.superAdmin]
  );
  const v = await t.one(
    `INSERT INTO tbl_product_variant (name, slug, sku, added_by, product_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, tag(), sku, IDS.users.superAdmin, product.id]
  );
  return Number(v.id);
}
async function thrownBy(t, fn) {
  try {
    await t.tx((sp) => fn(sp));
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

describe("inventory setup", () => {
  it("admin creates item from variant and maps a duplicate variant", async () => {
    await withTx(async (t) => {
      await grant(t, ADMIN_USER, "Inventory Controller");
      const v1 = await makeVariant(t, "Surf Excel 1kg");
      const v2 = await makeVariant(t, "Surf Excel 1 kg (dup)");

      const { result: item } = await setup.createItem(t, ADMIN_USER, {
        productVariantId: v1,
        stockUom: " kg ",
        displayName: "Surf Excel",
        trackExpiry: true,
        minShelfLifeDays: 30,
      });
      expect(item).toMatchObject({
        displayName: "Surf Excel",
        stockUom: "kg",
        trackExpiry: true,
        minShelfLifeDays: 30,
        isActive: true,
      });
      expect(item.variants.map((v) => v.productVariantId)).toEqual([v1]);

      // a second create for the same variant names the item that has it
      const dup = await thrownBy(t, (sp) => setup.createItem(sp, ADMIN_USER, { productVariantId: v1, stockUom: "kg" }));
      expect(dup.code).toBe("CONFLICT");
      expect(dup.message).toContain("Surf Excel");

      const { result: mapped } = await setup.mapVariantToItem(t, ADMIN_USER, item.id, { productVariantId: v2 });
      expect(mapped.variants.map((v) => v.productVariantId).sort()).toEqual([v1, v2].sort());

      // search finds it by its variant's name
      const found = await setup.listItems(t, ADMIN_USER, { search: "excel 1 kg" });
      expect(found.rows.map((r) => r.id)).toContain(item.id);

      const { result: edited } = await setup.updateItem(t, ADMIN_USER, item.id, {
        displayName: "Surf Excel Matic",
        itemCode: "SE-1",
        stockUom: "kg",
        trackExpiry: false,
        minShelfLifeDays: null,
        overReceiptTolerancePct: 5,
        isActive: true,
      });
      expect(edited).toMatchObject({ displayName: "Surf Excel Matic", itemCode: "SE-1", overReceiptTolerancePct: 5 });
    });
  });

  it("non-admin cannot create item (403)", async () => {
    await withTx(async (t) => {
      await grant(t, OTHER_USER, "Storekeeper"); // read/create/update, no admin
      const v = await makeVariant(t);
      const err = await thrownBy(t, (sp) => setup.createItem(sp, OTHER_USER, { productVariantId: v, stockUom: "kg" }));
      expect(err.code).toBe("FORBIDDEN");
      expect(err.httpStatus).toBe(403);

      // an item the storekeeper can see but not edit is 403, not 404
      await grant(t, ADMIN_USER, "Inventory Controller");
      const { result: item } = await setup.createItem(t, ADMIN_USER, { productVariantId: v, stockUom: "kg" });
      const e2 = await thrownBy(t, (sp) => setup.updateItem(sp, OTHER_USER, item.id, { displayName: "x" }));
      expect(e2.code).toBe("FORBIDDEN");
    });
  });

  it("items of another company are NOT_FOUND on every /items/:id route", async () => {
    await withTx(async (t) => {
      await grant(t, ADMIN_USER, "Inventory Controller");
      await grant(t, B_USER, "Inventory Controller", B);
      const v = await makeVariant(t);
      const { result: item } = await setup.createItem(t, ADMIN_USER, { productVariantId: v, stockUom: "kg" });
      const v2 = await makeVariant(t);
      const calls = [
        (sp) => setup.updateItem(sp, B_USER, item.id, { displayName: "x" }),
        (sp) => setup.mapVariantToItem(sp, B_USER, item.id, { productVariantId: v2 }),
        (sp) => setup.getItemUoms(sp, B_USER, item.id),
        (sp) => setup.saveItemUoms(sp, B_USER, item.id, { uoms: [{ uomLabel: "Case", factorToStock: 12 }] }),
        (sp) => setup.addItemBarcode(sp, B_USER, item.id, { code: "123" }),
        (sp) => setup.deleteItemBarcode(sp, B_USER, item.id, 1),
      ];
      for (const call of calls) expect((await thrownBy(t, call)).code).toBe("NOT_FOUND");
      expect((await setup.listItems(t, B_USER, {})).rows.map((r) => r.id)).not.toContain(item.id);
    });
  });

  it("units: save replaces the set; the stock unit cannot change after movements", async () => {
    await withTx(async (t) => {
      await grant(t, ADMIN_USER, "Inventory Controller");
      const { result: item } = await setup.createItem(t, ADMIN_USER, { productVariantId: await makeVariant(t), stockUom: "kg" });
      await setup.saveItemUoms(t, ADMIN_USER, item.id, { uoms: [{ uomLabel: "Case", factorToStock: 12 }, { uomLabel: "Bag", factorToStock: 5 }] });
      const { result } = await setup.saveItemUoms(t, ADMIN_USER, item.id, { uoms: [{ uomLabel: " case ", factorToStock: 10 }] });
      expect(result).toEqual([{ uomLabel: "case", factorToStock: 10 }]);

      await t.none(
        `INSERT INTO tbl_inv_movement (hospitality_company_id, hotel_id, inv_item_id, movement_type, qty, unit_cost, value,
                                      qty_after, avg_cost_after, source_type, source_id)
         VALUES ($1, $2, $3, 'GRN_IN', 1, 1, 1, 1, 1, 'GRN', 1)`,
        [A, HOTEL_A1, item.id]
      );
      const err = await thrownBy(t, (sp) => setup.updateItem(sp, ADMIN_USER, item.id, { stockUom: "g" }));
      expect(err.code).toBe("CONFLICT");
    });
  });

  it("barcode unique per company; same code allowed in another company", async () => {
    await withTx(async (t) => {
      await grant(t, ADMIN_USER, "Inventory Controller");
      await grant(t, B_USER, "Inventory Controller", B);
      const { result: a1 } = await setup.createItem(t, ADMIN_USER, { productVariantId: await makeVariant(t), stockUom: "pcs", displayName: "Soap A" });
      const { result: a2 } = await setup.createItem(t, ADMIN_USER, { productVariantId: await makeVariant(t), stockUom: "pcs" });
      const { result: b1 } = await setup.createItem(t, B_USER, { productVariantId: await makeVariant(t), stockUom: "pcs" });

      const { result: bc } = await setup.addItemBarcode(t, ADMIN_USER, a1.id, { code: " 8901234567890 ", packFactor: 12, source: "MANUFACTURER" });
      expect(bc).toMatchObject({ code: "8901234567890", packFactor: 12, source: "MANUFACTURER" });

      const clash = await thrownBy(t, (sp) => setup.addItemBarcode(sp, ADMIN_USER, a2.id, { code: "8901234567890" }));
      expect(clash.code).toBe("CONFLICT");
      expect(clash.message).toContain("Soap A");

      await setup.addItemBarcode(t, B_USER, b1.id, { code: "8901234567890" }); // other company: fine

      for (const packFactor of [0, -1, "x"]) {
        const e = await thrownBy(t, (sp) => setup.addItemBarcode(sp, ADMIN_USER, a1.id, { code: `c-${packFactor}`, packFactor }));
        expect(e.code).toBe("VALIDATION");
      }

      // another item's barcode id cannot be removed through this item
      const wrong = await thrownBy(t, (sp) => setup.deleteItemBarcode(sp, ADMIN_USER, a2.id, bc.id));
      expect(wrong.code).toBe("NOT_FOUND");
      expect((await setup.deleteItemBarcode(t, ADMIN_USER, a1.id, bc.id)).result).toEqual({ deleted: true });
    });
  });

  it("hotel levels validate ordering", async () => {
    await withTx(async (t) => {
      await grant(t, ADMIN_USER, "Inventory Controller", A, HOTEL_A1);
      const { result: item } = await setup.createItem(t, ADMIN_USER, { productVariantId: await makeVariant(t), stockUom: "kg" });
      const key = { hotelId: HOTEL_A1, invItemId: item.id };

      const { result } = await setup.saveHotelItem(t, ADMIN_USER, key, { minQty: 5, reorderLevel: 10, maxQty: 50, binLabel: "Shelf 3" });
      expect(result).toMatchObject({ invItemId: item.id, minQty: 5, reorderLevel: 10, maxQty: 50, binLabel: "Shelf 3" });

      for (const body of [
        { minQty: 10, reorderLevel: 5, maxQty: 50 },
        { minQty: 5, reorderLevel: 60, maxQty: 50 },
        { minQty: -1 },
      ]) {
        expect((await thrownBy(t, (sp) => setup.saveHotelItem(sp, ADMIN_USER, key, body))).code).toBe("VALIDATION");
      }
      // partial levels are fine
      await setup.saveHotelItem(t, ADMIN_USER, key, { reorderLevel: 8 });

      const list = await setup.listHotelItems(t, ADMIN_USER, { hotelId: HOTEL_A1 });
      expect(list.rows.find((r) => r.invItemId === item.id)).toMatchObject({ reorderLevel: 8, minQty: null });

      // the grant covers hotel A1 only
      expect((await thrownBy(t, (sp) => setup.saveHotelItem(sp, ADMIN_USER, { hotelId: HOTEL_A2, invItemId: item.id }, {}))).code).toBe("FORBIDDEN");
    });
  });

  it("settings: hotel includeGstInCost overrides company", async () => {
    await withTx(async (t) => {
      await grant(t, ADMIN_USER, "Inventory Controller");
      expect(await setup.getCompanySettings(t, ADMIN_USER)).toEqual({
        overReceiptTolerancePct: 0,
        allowNegativeStock: false,
        includeGstInCost: false,
        adjustmentAutoApproveLimit: 0,
        countFreeze: false,
      });
      const { result } = await setup.saveCompanySettings(t, ADMIN_USER, { includeGstInCost: true, overReceiptTolerancePct: 2.5, adjustmentAutoApproveLimit: 500 });
      expect(result).toMatchObject({ includeGstInCost: true, overReceiptTolerancePct: 2.5, adjustmentAutoApproveLimit: 500, allowNegativeStock: false });

      await setup.saveHotelSettings(t, ADMIN_USER, HOTEL_A1, { includeGstInCost: false, docCode: "BLR" });
      const hotel = await setup.getHotelSettings(t, ADMIN_USER, HOTEL_A1);
      expect(hotel).toMatchObject({ hotelId: HOTEL_A1, docCode: "BLR", includeGstInCost: false, effectiveIncludeGstInCost: false });
      expect((await getEffectiveSettings(t, { companyId: A, hotelId: HOTEL_A1 })).includeGstInCost).toBe(false);
      expect((await getEffectiveSettings(t, { companyId: A, hotelId: HOTEL_A2 })).includeGstInCost).toBe(true);

      // back to "use the company value"
      await setup.saveHotelSettings(t, ADMIN_USER, HOTEL_A1, { includeGstInCost: null });
      expect((await setup.getHotelSettings(t, ADMIN_USER, HOTEL_A1)).effectiveIncludeGstInCost).toBe(true);

      expect((await thrownBy(t, (sp) => setup.saveCompanySettings(sp, ADMIN_USER, { overReceiptTolerancePct: -1 }))).code).toBe("VALIDATION");
    });
  });

  it("doc code: numeric only when it is the hotel's own id; unique in the company", async () => {
    await withTx(async (t) => {
      await grant(t, ADMIN_USER, "Inventory Controller");
      const other = String(HOTEL_A2);
      expect((await thrownBy(t, (sp) => setup.saveHotelSettings(sp, ADMIN_USER, HOTEL_A1, { docCode: other }))).code).toBe("VALIDATION");
      await setup.saveHotelSettings(t, ADMIN_USER, HOTEL_A1, { docCode: String(HOTEL_A1) });
      for (const bad of ["a/b", "has space"]) {
        expect((await thrownBy(t, (sp) => setup.saveHotelSettings(sp, ADMIN_USER, HOTEL_A1, { docCode: bad }))).code).toBe("VALIDATION");
      }
      await setup.saveHotelSettings(t, ADMIN_USER, HOTEL_A1, { docCode: "BLR" });
      expect((await thrownBy(t, (sp) => setup.saveHotelSettings(sp, ADMIN_USER, HOTEL_A2, { docCode: "blr" }))).code).toBe("CONFLICT");
    });
  });

  it("category defaults applied on lazy create", async () => {
    await withTx(async (t) => {
      await grant(t, ADMIN_USER, "Inventory Controller");
      const cat = Number(
        (await t.one(`INSERT INTO tbl_category (title, parent_id, slug, created_by) VALUES ($1, 0, $2, $3) RETURNING id`, ["Dairy " + tag(), tag(), IDS.users.superAdmin])).id
      );
      const { result } = await setup.saveCategoryDefaults(t, ADMIN_USER, { rows: [{ categoryId: cat, trackExpiry: true, defaultMarkOutOnArrival: true }] });
      expect(result.rows).toEqual([expect.objectContaining({ categoryId: cat, trackExpiry: true, defaultMarkOutOnArrival: true })]);
      expect((await setup.getCategoryDefaults(t, ADMIN_USER)).rows).toHaveLength(1);

      const product = await t.one(`INSERT INTO tbl_product (id, name, slug, added_by) VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM tbl_product), 'Milk', $1, $2) RETURNING id`, [tag(), IDS.users.superAdmin]);
      await t.none(`INSERT INTO tbl_product_categories (product_id, category_id) VALUES ($1, $2)`, [product.id, cat]);
      const variant = Number((await t.one(`INSERT INTO tbl_product_variant (name, slug, added_by, product_id) VALUES ('Milk 1L', $1, $2, $3) RETURNING id`, [tag(), IDS.users.superAdmin, product.id])).id);

      const lazy = await resolveItemForVariant(t, { companyId: A, productVariantId: variant, createIfMissing: true, defaultUom: "ltr" });
      expect(lazy.trackExpiry).toBe(true);

      // replace semantics, and unknown categories are refused
      expect((await thrownBy(t, (sp) => setup.saveCategoryDefaults(sp, ADMIN_USER, { rows: [{ categoryId: 999999999, trackExpiry: true, defaultMarkOutOnArrival: false }] }))).code).toBe("VALIDATION");
      expect((await setup.saveCategoryDefaults(t, ADMIN_USER, { rows: [] })).result.rows).toEqual([]);
    });
  });
});
