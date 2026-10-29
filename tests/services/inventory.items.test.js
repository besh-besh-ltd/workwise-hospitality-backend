// Inventory items, units and cost (Task A3).
//
// A stock item is the company's own entity; catalogue variants map onto it
// (several variants may share one item, one variant maps to one item). The
// first receipt of an unmapped variant creates its item lazily. Unit
// conversion resolves free-text PO units case- and space-insensitively and
// NEVER silently falls back to factor 1 (Review Focus 2). The cost of a PO
// line comes from the same pricing helpers the PO documents use.
//
// Everything runs inside withTx (always rolled back), except the RFQ PO built
// with tests/helpers/poFixtures.js, which commits and is cleaned up afterwards.

import { describe, it, expect, afterAll, afterEach } from "@jest/globals";
import { db, withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { newPoFixtureTracker, poFixtures, cleanupPoFixtures } from "../helpers/poFixtures.js";
import {
  resolveItemForVariant,
  mapVariantToItem,
  suggestItems,
  suggestItemsByWords,
} from "../../app/services/inventory/items.js";
import { resolveUomFactor, setUomFactor } from "../../app/services/inventory/uom.js";
import { resolvePoLineUnitCost } from "../../app/services/inventory/cost.js";
import { InventoryError } from "../../app/services/inventory/errors.js";
import { buildPOTemplateData } from "../../app/helper/poTemplateDataBuilder.js";
import { computeCallOffLine, callOffLineTax } from "../../app/helper/arc_v2/callOffLineTax.js";

const CO = IDS.hospitality.A;
const OTHER_CO = IDS.hospitality.B;
const HOTEL = IDS.hotels.A1;
const USER = IDS.users.a1_proc_buyer;
const ADMIN = IDS.users.superAdmin;

const inserted = newPoFixtureTracker();
const { makeRfqWithProductAndVendor, makePo, attachProductToPo } = poFixtures(inserted);

afterEach(async () => {
  await cleanupPoFixtures(inserted);
});

afterAll(async () => {
  await closeDb();
});

let seq = 0;
const tag = () => `inv-a3-${process.pid}-${++seq}`;

async function makeCategory(t, { parentId = 0, title = `Cat ${tag()}` } = {}) {
  const row = await t.one(
    `INSERT INTO tbl_category (title, parent_id, slug, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [title, parentId, tag(), ADMIN]
  );
  return Number(row.id);
}

/** A catalogue product + variant, mapped to the given categories. */
async function makeVariant(t, { name = `Variant ${tag()}`, categoryIds = [] } = {}) {
  const product = await t.one(
    `INSERT INTO tbl_product (name, slug, added_by) VALUES ($1, $2, $3) RETURNING id`,
    [name, tag(), ADMIN]
  );
  for (const categoryId of categoryIds) {
    await t.none(
      `INSERT INTO tbl_product_categories (product_id, category_id) VALUES ($1, $2)`,
      [product.id, categoryId]
    );
  }
  const variant = await t.one(
    `INSERT INTO tbl_product_variant (name, slug, added_by, product_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, tag(), ADMIN, product.id]
  );
  return Number(variant.id);
}

async function makeItem(t, { name = `Item ${tag()}`, stockUom = "kg", companyId = CO } = {}) {
  const row = await t.one(
    `INSERT INTO tbl_inv_item (hospitality_company_id, display_name, stock_uom)
     VALUES ($1, $2, $3) RETURNING id`,
    [companyId, name, stockUom]
  );
  return Number(row.id);
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

describe("stock items for catalogue variants", () => {
  it("lazy create maps variant 1:1 and inherits category expiry flag", async () => {
    await withTx(async (t) => {
      // Dairy (track expiry) > Milk; the product sits in Milk and in a
      // category with no default. Any true category default wins.
      const dairy = await makeCategory(t, { title: "Dairy" });
      const milk = await makeCategory(t, { parentId: dairy, title: "Milk" });
      const misc = await makeCategory(t);
      await t.none(
        `INSERT INTO tbl_inv_category_default (hospitality_company_id, category_id, track_expiry)
         VALUES ($1, $2, true), ($1, $3, false)`,
        [CO, dairy, misc]
      );
      const variant = await makeVariant(t, { name: "Amul Taaza 1L", categoryIds: [milk, misc] });

      expect(
        await resolveItemForVariant(t, { companyId: CO, productVariantId: variant, createIfMissing: false })
      ).toBeNull();

      const item = await resolveItemForVariant(t, {
        companyId: CO,
        productVariantId: variant,
        createIfMissing: true,
        userId: USER,
        defaultUom: "  Litre  ",
      });
      expect(item).toEqual({
        id: expect.any(Number),
        displayName: "Amul Taaza 1L",
        stockUom: "Litre",
        trackExpiry: true,
        minShelfLifeDays: null,
        overReceiptTolerancePct: null,
        created: true,
      });

      const maps = await t.any(
        `SELECT inv_item_id, hospitality_company_id, created_by FROM tbl_inv_item_variant
          WHERE product_variant_id = $1`,
        [variant]
      );
      expect(maps).toEqual([{ inv_item_id: item.id, hospitality_company_id: CO, created_by: USER }]);

      // Second resolution reuses the mapping; nothing new is created.
      const again = await resolveItemForVariant(t, {
        companyId: CO,
        productVariantId: variant,
        createIfMissing: true,
        userId: USER,
        defaultUom: "pcs",
      });
      expect(again).toEqual({ ...item, created: false });
      const count = await t.one(
        `SELECT COUNT(*)::int AS n FROM tbl_inv_item WHERE hospitality_company_id = $1 AND display_name = $2`,
        [CO, "Amul Taaza 1L"]
      );
      expect(count.n).toBe(1);

      // The mapping is per company: company B gets its own item.
      expect(
        await resolveItemForVariant(t, { companyId: OTHER_CO, productVariantId: variant, createIfMissing: false })
      ).toBeNull();

      // No category default → no expiry tracking.
      const plain = await makeVariant(t, { categoryIds: [misc] });
      const plainItem = await resolveItemForVariant(t, {
        companyId: CO,
        productVariantId: plain,
        createIfMissing: true,
        userId: USER,
        defaultUom: "pcs",
      });
      expect(plainItem.trackExpiry).toBe(false);
    });
  });

  it("lazy create refuses to invent a stock unit", async () => {
    await withTx(async (t) => {
      const variant = await makeVariant(t);
      const err = await thrownBy(t, (sp) =>
        resolveItemForVariant(sp, { companyId: CO, productVariantId: variant, createIfMissing: true, userId: USER, defaultUom: "   " })
      );
      expect(err).toBeInstanceOf(InventoryError);
      expect(err.code).toBe("VALIDATION");
      expect(err.details.field).toBe("defaultUom");
    });
  });

  it("second variant can map to existing item", async () => {
    await withTx(async (t) => {
      const first = await makeVariant(t, { name: "Dove soap 100g" });
      const second = await makeVariant(t, { name: "Dove Soap 100 g (shadow)" });
      const item = await resolveItemForVariant(t, {
        companyId: CO, productVariantId: first, createIfMissing: true, userId: USER, defaultUom: "pcs",
      });

      const mapped = await mapVariantToItem(t, { companyId: CO, productVariantId: second, invItemId: item.id, userId: USER });
      expect(mapped).toEqual({ invItemId: item.id, productVariantId: second, created: true });

      const resolved = await resolveItemForVariant(t, { companyId: CO, productVariantId: second, createIfMissing: false });
      expect(resolved.id).toBe(item.id);
      expect(resolved.created).toBe(false);

      // Mapping to the same item again is a no-op.
      expect(
        await mapVariantToItem(t, { companyId: CO, productVariantId: second, invItemId: item.id, userId: USER })
      ).toEqual({ invItemId: item.id, productVariantId: second, created: false });
    });
  });

  it("mapping a variant already mapped elsewhere is CONFLICT", async () => {
    await withTx(async (t) => {
      const variantA = await makeVariant(t);
      const variantB = await makeVariant(t);
      const itemA = await resolveItemForVariant(t, {
        companyId: CO, productVariantId: variantA, createIfMissing: true, userId: USER, defaultUom: "pcs",
      });
      const itemB = await resolveItemForVariant(t, {
        companyId: CO, productVariantId: variantB, createIfMissing: true, userId: USER, defaultUom: "pcs",
      });

      const err = await thrownBy(t, (sp) =>
        mapVariantToItem(sp, { companyId: CO, productVariantId: variantA, invItemId: itemB.id, userId: USER })
      );
      expect(err).toBeInstanceOf(InventoryError);
      expect(err.code).toBe("CONFLICT");
      expect(err.httpStatus).toBe(409);
      expect(err.details).toEqual(expect.objectContaining({ productVariantId: variantA, invItemId: itemA.id }));

      // An item of another company is not visible: 404, not a mapping.
      const foreign = await makeItem(t, { companyId: OTHER_CO });
      const err404 = await thrownBy(t, (sp) =>
        mapVariantToItem(sp, { companyId: CO, productVariantId: variantB, invItemId: foreign, userId: USER })
      );
      expect(err404.code).toBe("NOT_FOUND");
    });
  });

  it("suggestItems ranks similar company items and skips the variant's own item", async () => {
    await withTx(async (t) => {
      const variant = await makeVariant(t, { name: "Dettol Liquid Handwash 200ml" });
      const own = await makeItem(t, { name: "Dettol Liquid Handwash 200ml", stockUom: "pcs" });
      await mapVariantToItem(t, { companyId: CO, productVariantId: variant, invItemId: own, userId: USER });
      const close = await makeItem(t, { name: "Dettol Handwash Liquid 200 ml", stockUom: "pcs" });
      const far = await makeItem(t, { name: "Basmati rice 25kg", stockUom: "bag" });
      const otherCompany = await makeItem(t, { name: "Dettol Liquid Handwash 200ml", companyId: OTHER_CO });

      const rows = await suggestItems(t, { companyId: CO, productVariantId: variant });
      const ids = rows.map((r) => r.invItemId);
      expect(ids).toContain(close);
      expect(ids).not.toContain(own);
      expect(ids).not.toContain(far);
      expect(ids).not.toContain(otherCompany);
      expect(rows.length).toBeLessThanOrEqual(5);
      for (const r of rows) {
        expect(r.score).toBeGreaterThanOrEqual(0.3);
        expect(typeof r.displayName).toBe("string");
      }
      const scores = rows.map((r) => r.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);

      // Without pg_trgm: share of the variant's words found in the item name.
      const byWords = await suggestItemsByWords(t, { companyId: CO, productVariantId: variant });
      // "200ml" is not in "… 200 ml": 3 of 4 words.
      expect(byWords).toEqual([{ invItemId: close, displayName: "Dettol Handwash Liquid 200 ml", score: 0.75 }]);
    });
  });
});

describe("unit conversion", () => {
  it("resolveUomFactor trims and case-folds; missing factor returns null", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t, { stockUom: "kg" });

      // The PO unit equals the stock unit once trimmed and case-folded.
      expect(await resolveUomFactor(t, { invItemId: item, uomLabel: " KG " })).toBe(1);
      expect(await resolveUomFactor(t, { invItemId: item, uomLabel: "kg" })).toBe(1);

      // A defined pack unit, stored normalised, matched however it is typed.
      await setUomFactor(t, { invItemId: item, uomLabel: "  Case ", factor: 24, userId: USER });
      expect(await resolveUomFactor(t, { invItemId: item, uomLabel: "Case" })).toBe(24);
      expect(await resolveUomFactor(t, { invItemId: item, uomLabel: " CASE  " })).toBe(24);

      // No factor: null, never a silent 1.
      expect(await resolveUomFactor(t, { invItemId: item, uomLabel: "Box" })).toBeNull();
      expect(await resolveUomFactor(t, { invItemId: item, uomLabel: "" })).toBeNull();

      const stored = await t.any(
        `SELECT uom_label, factor_to_stock::text AS factor, hospitality_company_id, created_by
           FROM tbl_inv_item_uom WHERE inv_item_id = $1`,
        [item]
      );
      expect(stored).toEqual([{ uom_label: "Case", factor: "24.000000", hospitality_company_id: CO, created_by: USER }]);
    });
  });

  it("inner whitespace is collapsed on both sides", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t, { stockUom: "Kg  Bag" });
      expect(await resolveUomFactor(t, { invItemId: item, uomLabel: "kg bag" })).toBe(1);

      await setUomFactor(t, { invItemId: item, uomLabel: "Master   Carton", factor: 12, userId: USER });
      expect(await resolveUomFactor(t, { invItemId: item, uomLabel: "master carton" })).toBe(12);
      const label = await t.one(`SELECT uom_label FROM tbl_inv_item_uom WHERE inv_item_id = $1`, [item]);
      expect(label.uom_label).toBe("Master Carton");
    });
  });

  it("setUomFactor upserts case-insensitively and validates", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t, { stockUom: "pcs" });
      await setUomFactor(t, { invItemId: item, uomLabel: "Case", factor: 24, userId: USER });
      await setUomFactor(t, { invItemId: item, uomLabel: "CASE", factor: 12, userId: USER });
      const rows = await t.any(
        `SELECT uom_label, factor_to_stock::text AS factor FROM tbl_inv_item_uom WHERE inv_item_id = $1`,
        [item]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].factor).toBe("12.000000");
      expect(await resolveUomFactor(t, { invItemId: item, uomLabel: "case" })).toBe(12);

      for (const bad of [
        { uomLabel: "Box", factor: 0 },
        { uomLabel: "Box", factor: -2 },
        { uomLabel: "Box", factor: "abc" },
        { uomLabel: "   ", factor: 6 },
        { uomLabel: " PCS ", factor: 6 }, // the stock unit itself is always 1
      ]) {
        const err = await thrownBy(t, (sp) => setUomFactor(sp, { invItemId: item, userId: USER, ...bad }));
        expect(err).toBeInstanceOf(InventoryError);
        expect(err.code).toBe("VALIDATION");
      }

      const missing = await thrownBy(t, (sp) =>
        setUomFactor(sp, { invItemId: 2147483000, uomLabel: "Box", factor: 6, userId: USER })
      );
      expect(missing.code).toBe("NOT_FOUND");
    });
  });
});

describe("cost per PO unit", () => {
  it("cost resolver: RFQ line taxable rate ex-GST; include-GST hotel override adds GST", async () => {
    // RFQ PO from the shared fixtures (committed; cleaned up in afterEach).
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const poId = await makePo({ rfq_id, status: "approved", rfq_product_ids: [rfq_product_id] });
    const lineId = await attachProductToPo(poId, rfq_product_id, quote_id);
    // GST as a percentage, plus a freight charge that must NOT reach the cost.
    await db.none(
      `UPDATE tbl_purchase_order_product
          SET quantity = 12, unit_price = 87.5, total_price = 1300,
              charges_meta = $2::jsonb
        WHERE id = $1`,
      [lineId, JSON.stringify({ tax: 18, tax_mode: "percentage", other_charges: [{ name: "Freight", amount: 5, amount_mode: "percentage" }] })]
    );

    await withTx(async (t) => {
      // What the PO document prints for this very line.
      const doc = await buildPOTemplateData(poId, t);
      const printed = doc.items.find((it) => Number(it.id) === lineId);
      const expectedRate = Number(printed.taxable_amount) / 12;
      const expectedGst = Number(printed.effective_tax_rate);
      expect(expectedRate).toBeCloseTo(87.5, 6);
      expect(expectedGst).toBe(18);

      // Company default: GST is not part of stock cost.
      const exGst = await resolvePoLineUnitCost(t, { poLineId: lineId, hotelId: HOTEL, companyId: CO });
      expect(exGst.taxableUnitRate).toBeCloseTo(expectedRate, 6);
      expect(exGst.gstPct).toBe(expectedGst);
      expect(exGst.costPerPoUnit).toBeCloseTo(expectedRate, 6);

      // This hotel cannot claim ITC: its override puts GST into cost.
      await t.none(
        `INSERT INTO tbl_inv_hotel_settings (hotel_id, hospitality_company_id, include_gst_in_cost)
         VALUES ($1, $2, true)`,
        [HOTEL, CO]
      );
      const inclGst = await resolvePoLineUnitCost(t, { poLineId: lineId, hotelId: HOTEL, companyId: CO });
      expect(inclGst.taxableUnitRate).toBeCloseTo(expectedRate, 6);
      expect(inclGst.costPerPoUnit).toBeCloseTo(expectedRate * (1 + expectedGst / 100), 6);
      expect(inclGst.costPerPoUnit).toBeCloseTo(103.25, 6);

      // Another hotel of the company still follows the company default.
      const otherHotel = await resolvePoLineUnitCost(t, { poLineId: lineId, hotelId: IDS.hotels.A2, companyId: CO });
      expect(otherHotel.costPerPoUnit).toBeCloseTo(expectedRate, 6);
    });
  });

  it("cost resolver reads an absolute GST amount as its effective rate", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const poId = await makePo({ rfq_id, status: "approved", rfq_product_ids: [rfq_product_id] });
    const lineId = await attachProductToPo(poId, rfq_product_id, quote_id);
    // ₹450 GST on a ₹2,500 line = 18%, never "450%".
    await db.none(
      `UPDATE tbl_purchase_order_product
          SET quantity = 10, unit_price = 250, total_price = 2950,
              charges_meta = '{"tax": 450, "tax_mode": "absolute"}'::jsonb
        WHERE id = $1`,
      [lineId]
    );
    await withTx(async (t) => {
      const doc = await buildPOTemplateData(poId, t);
      const printed = doc.items.find((it) => Number(it.id) === lineId);
      await t.none(
        `INSERT INTO tbl_inv_company_settings (hospitality_company_id, include_gst_in_cost) VALUES ($1, true)`,
        [CO]
      );
      const cost = await resolvePoLineUnitCost(t, { poLineId: lineId, hotelId: HOTEL, companyId: CO });
      expect(cost.gstPct).toBe(Number(printed.effective_tax_rate));
      expect(cost.gstPct).toBe(18);
      expect(cost.taxableUnitRate).toBeCloseTo(250, 6);
      expect(cost.costPerPoUnit).toBeCloseTo(295, 6);
    });
  });

  it("cost resolver handles call-off line via callOffLineTax", async () => {
    await withTx(async (t) => {
      const { poId, lineId, line } = await makeCallOffPo(t, {
        quantity: 7,
        unitRate: 90,
        gstPct: 5,
        charges: [{ name: "Delivery", amount: 35, amount_mode: "absolute" }],
      });

      const engine = computeCallOffLine(line);
      const documentTax = callOffLineTax(line, null);
      const expectedRate = engine.base / 7;
      expect(expectedRate).toBeCloseTo(90, 6);

      const exGst = await resolvePoLineUnitCost(t, { poLineId: lineId, hotelId: HOTEL, companyId: CO });
      expect(exGst.taxableUnitRate).toBeCloseTo(expectedRate, 6);
      expect(exGst.gstPct).toBe(5);
      expect(exGst.costPerPoUnit).toBeCloseTo(expectedRate, 6);
      // The delivery charge is in the document's taxable value but not in stock cost.
      expect(exGst.taxableUnitRate * 7).toBeLessThan(documentTax.taxable_value);

      await t.none(
        `INSERT INTO tbl_inv_company_settings (hospitality_company_id, include_gst_in_cost) VALUES ($1, true)`,
        [CO]
      );
      const inclGst = await resolvePoLineUnitCost(t, { poLineId: lineId, hotelId: HOTEL, companyId: CO });
      expect(inclGst.costPerPoUnit).toBeCloseTo(94.5, 6);
      expect(poId).toEqual(expect.any(Number));
    });
  });

  it("unknown PO line is NOT_FOUND", async () => {
    await withTx(async (t) => {
      const err = await thrownBy(t, (sp) =>
        resolvePoLineUnitCost(sp, { poLineId: 2147483000, hotelId: HOTEL, companyId: CO })
      );
      expect(err.code).toBe("NOT_FOUND");
    });
  });
});

/**
 * A call-off PO with one line, shaped exactly as callOffPoService.releaseForMr
 * writes it (writeCallOffPoLines): unit_price = the contract base rate,
 * charges_meta = {tax: gst %, tax_mode: 'percentage', other_charges}.
 */
async function makeCallOffPo(t, { quantity, unitRate, gstPct, charges = [] }) {
  const t0 = tag();
  const arc = await t.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
     VALUES ($1, 'Inventory cost ARC', (SELECT id FROM tbl_category ORDER BY id LIMIT 1), $2, $3, $4, $5,
             'contract_active', NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
             NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6)
     RETURNING id`,
    [`ARC-${t0}`.slice(0, 40), CO, HOTEL, IDS.departments.proc, IDS.processes.A_P1, USER]
  );
  const arcItem = await t.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, 1, 100, 'litre') RETURNING id`,
    [arc.id]
  );
  const contract = await t.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
    [arc.id, IDS.users.vendor_alpha]
  );
  const contractLine = await t.one(
    `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
     VALUES ($1, $2, $3, $4, 1000) RETURNING id`,
    [contract.id, arcItem.id, unitRate, gstPct]
  );
  const mr = await t.one(
    `INSERT INTO tbl_material_requisition
       (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, required_by_date)
     VALUES ($1, 'Inventory cost MR', $2, $3, $4, 'normal', $5, 'po_released', '2026-11-05') RETURNING id`,
    [`MR-${t0}`.slice(0, 40), CO, HOTEL, IDS.departments.fb, USER]
  );
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id,
        total_value, quote_id, arc_contract_id, source_mr_id, is_call_off)
     VALUES (NULL, $1, $2, 'approved', '{}', $3, $4, $5, 0, '{}', $6, $7, TRUE) RETURNING id`,
    [IDS.companies.A, `CO-${t0}`, quantity, unitRate, IDS.users.vendor_alpha, contract.id, mr.id]
  );
  const chargesMeta = { tax: gstPct, tax_mode: "percentage", other_charges: charges };
  const line = { unit_price: unitRate, quantity, tax: gstPct, other_charges: charges };
  const total = computeCallOffLine(line).total;
  const pop = await t.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, charges_meta, total_price,
        product_variant_id, arc_contract_line_id)
     VALUES ($1, NULL, NULL, $2, 'litre', $3, $4::jsonb, $5, 1, $6) RETURNING id`,
    [po.id, quantity, unitRate, JSON.stringify(chargesMeta), total, contractLine.id]
  );
  return { poId: Number(po.id), lineId: Number(pop.id), line };
}
