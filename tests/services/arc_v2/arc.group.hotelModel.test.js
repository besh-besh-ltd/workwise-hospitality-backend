// Group ARC — the hotel coverage model.
//
// arcHotelModel is the only module that writes the group-only tables. Callers
// hand it the FINAL desired state (the hotels, the per-hotel quantities) and it
// reconciles, mirroring hospitalityModel.reconcileRFQHotels, so a resumed draft
// can be saved repeatedly without duplicating or orphaning rows.
//
// Pattern A: every case runs inside a rolled-back transaction.

import { withTx } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import arcHotelModel from "../../../app/models/arc_v2/arcHotelModel.js";

const { A1, A2, A3 } = IDS.hotels;
const BUYER = IDS.users.a1_proc_buyer;

async function seedArc(t, { isGroup = true, hotelId = A1 } = {}) {
  const arc = await t.one(
    `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id,
                          department_id, created_by, is_group)
     VALUES ('ARC-HOTELMODEL-' || floor(random() * 1e9)::text, 'hotel model', $1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [TEST_CATEGORIES.beverages, IDS.hospitality.A, hotelId, IDS.departments.proc, BUYER, isGroup]
  );
  const item = await t.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
     VALUES ($1, 1, 1, 'pcs') RETURNING *`,
    [arc.id]
  );
  return { arc, item };
}

describe("arcHotelModel — coverage", () => {
  test("reconcileArcHotels stores the desired set and is idempotent", async () => {
    await withTx(async (t) => {
      const { arc } = await seedArc(t);
      expect(await arcHotelModel.reconcileArcHotels(arc.id, [A2, A1, A2], BUYER, t)).toEqual([A1, A2]);
      expect(await arcHotelModel.reconcileArcHotels(arc.id, [A1, A2], BUYER, t)).toEqual([A1, A2]);
      const rows = await t.any(`SELECT hotel_id FROM tbl_arc_hotel_mappings WHERE arc_id = $1`, [arc.id]);
      expect(rows).toHaveLength(2);
    });
  });

  test("reconcileArcHotels removes hotels no longer selected", async () => {
    await withTx(async (t) => {
      const { arc } = await seedArc(t);
      await arcHotelModel.reconcileArcHotels(arc.id, [A1, A2, A3], BUYER, t);
      expect(await arcHotelModel.reconcileArcHotels(arc.id, [A1, A3], BUYER, t)).toEqual([A1, A3]);
    });
  });

  test("arcHotelIds: a group ARC covers its mapped hotels plus the lead hotel", async () => {
    await withTx(async (t) => {
      const { arc } = await seedArc(t, { hotelId: A1 });
      await arcHotelModel.reconcileArcHotels(arc.id, [A2, A3], BUYER, t);
      expect(await arcHotelModel.arcHotelIds(arc, t)).toEqual([A1, A2, A3]);
    });
  });

  test("arcHotelIds: a single-hotel ARC covers only its hotel, whatever rows exist", async () => {
    await withTx(async (t) => {
      const { arc } = await seedArc(t, { isGroup: false, hotelId: A3 });
      await t.none(`INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id) VALUES ($1, $2)`, [arc.id, A1]);
      expect(await arcHotelModel.arcHotelIds(arc, t)).toEqual([A3]);
    });
  });

  test("listArcHotels returns the lead hotel first, marked, with the identity fields a contract needs", async () => {
    await withTx(async (t) => {
      const { arc } = await seedArc(t, { hotelId: A2 });
      await arcHotelModel.reconcileArcHotels(arc.id, [A1, A2, A3], BUYER, t);
      const hotels = await arcHotelModel.listArcHotels(arc, t);
      expect(hotels.map((h) => h.hotel_id)).toEqual([A2, ...[A1, A3]]);
      expect(hotels[0].is_lead).toBe(true);
      expect(hotels.slice(1).every((h) => h.is_lead === false)).toBe(true);
      for (const key of ["name", "city", "state", "gst", "is_head_office"]) {
        expect(hotels[0]).toHaveProperty(key);
      }
    });
  });
});

describe("arcHotelModel — per-hotel item quantities", () => {
  test("setItemHotelQtys replaces the split and returns the total", async () => {
    await withTx(async (t) => {
      const { item } = await seedArc(t);
      expect(await arcHotelModel.setItemHotelQtys(item.id, [
        { hotel_id: A1, indicative_qty: 400 },
        { hotel_id: A2, indicative_qty: 350 },
      ], t)).toBe(750);
      expect(await arcHotelModel.setItemHotelQtys(item.id, [
        { hotel_id: A1, indicative_qty: 100 },
        { hotel_id: A3, indicative_qty: 0 },
      ], t)).toBe(100);
      const rows = await t.any(
        `SELECT hotel_id, indicative_qty::float AS qty FROM tbl_arc_item_hotel_qty WHERE arc_item_id = $1 ORDER BY hotel_id`,
        [item.id]
      );
      expect(rows).toEqual([{ hotel_id: A1, qty: 100 }, { hotel_id: A3, qty: 0 }]);
    });
  });

  test("listItemHotelQtys groups the split by item", async () => {
    await withTx(async (t) => {
      const { arc, item } = await seedArc(t);
      await arcHotelModel.setItemHotelQtys(item.id, [
        { hotel_id: A2, indicative_qty: 5 },
        { hotel_id: A1, indicative_qty: 7.5 },
      ], t);
      expect(await arcHotelModel.listItemHotelQtys(arc.id, t)).toEqual({
        [String(item.id)]: [
          { hotel_id: A1, indicative_qty: 7.5 },
          { hotel_id: A2, indicative_qty: 5 },
        ],
      });
    });
  });

  test("clearGroupRows removes coverage and per-hotel quantities (group → single on a draft)", async () => {
    await withTx(async (t) => {
      const { arc, item } = await seedArc(t);
      await arcHotelModel.reconcileArcHotels(arc.id, [A1, A2], BUYER, t);
      await arcHotelModel.setItemHotelQtys(item.id, [{ hotel_id: A1, indicative_qty: 3 }], t);
      await arcHotelModel.clearGroupRows(arc.id, t);
      expect(await t.any(`SELECT 1 FROM tbl_arc_hotel_mappings WHERE arc_id = $1`, [arc.id])).toHaveLength(0);
      expect(await t.any(`SELECT 1 FROM tbl_arc_item_hotel_qty WHERE arc_item_id = $1`, [item.id])).toHaveLength(0);
    });
  });
});
