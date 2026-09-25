// Group ARC — creating and editing a group rate contract draft.
//
// The wizard sends the lead hotel (hotel_id), every covered hotel (hotel_ids)
// and, per item, how much each hotel expects to buy (hotel_qtys). The server
// derives the company from the hotels, checks the caller may act at every
// hotel in the chosen department, and stores the item's indicative_qty as the
// sum of the split.
//
// Product-level: real Express app + Postgres over HTTP.

import { db } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const { A1, A2, A3, B1 } = IDS.hotels;
const HC_A = IDS.hospitality.A;
const PROC = IDS.departments.proc;
const ENG = IDS.departments.eng;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT = 1;

const ADMIN_A = IDS.users.companyA_admin; // Company A, every hotel, every department
const MULTI = IDS.users.multiHotel;        // A1 + A2, Procurement only
const A1_ONLY = IDS.users.a1_proc_buyer;   // A1, Procurement only
const SUPER = IDS.users.superAdmin;

const groupBody = (overrides = {}) => ({
  title: "Group towels FY27",
  category_id: CATEGORY,
  department_id: PROC,
  is_group: true,
  hotel_id: A1,
  hotel_ids: [A1, A2, A3],
  items: [{
    product_variant_id: VARIANT,
    uom: "pcs",
    hotel_qtys: [
      { hotel_id: A1, qty: 400 },
      { hotel_id: A2, qty: 350 },
      { hotel_id: A3, qty: 250 },
    ],
  }],
  ...overrides,
});

describe("Group ARC — create and edit a draft", () => {
  const createdArcIds = [];
  let typesBefore;

  beforeAll(async () => {
    typesBefore = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`,
      [[ADMIN_A, MULTI, A1_ONLY, SUPER]]);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [[ADMIN_A, MULTI, A1_ONLY]]);
    await db.none(`UPDATE tbl_users SET user_type = 8 WHERE id = $1`, [SUPER]);
  });

  afterAll(async () => {
    if (createdArcIds.length) {
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [createdArcIds]);
    }
    for (const u of typesBefore) {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
    }
  });

  const create = async (userId, body) => {
    const client = await httpClient(userId);
    const res = await client.post("/api/v1/arc-v2").send(body);
    if (res.body?.data?.arc?.id) createdArcIds.push(Number(res.body.data.arc.id));
    return res;
  };

  test("a company-wide buyer creates a group draft: coverage, lead hotel and per-hotel quantities are stored", async () => {
    const res = await create(ADMIN_A, groupBody());
    expect(res.status).toBe(200);
    const arcId = Number(res.body.data.arc.id);
    expect(res.body.data.arc).toMatchObject({ is_group: true, hotel_id: A1 });
    expect(Number(res.body.data.arc.hospitality_company_id)).toBe(HC_A);

    const hotels = await db.any(`SELECT hotel_id FROM tbl_arc_hotel_mappings WHERE arc_id = $1 ORDER BY hotel_id`, [arcId]);
    expect(hotels.map((h) => h.hotel_id)).toEqual([A1, A2, A3]);

    const item = await db.one(`SELECT id, indicative_qty::float AS qty FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
    expect(item.qty).toBe(1000);
    const split = await db.any(
      `SELECT hotel_id, indicative_qty::float AS qty FROM tbl_arc_item_hotel_qty WHERE arc_item_id = $1 ORDER BY hotel_id`,
      [item.id]
    );
    expect(split).toEqual([{ hotel_id: A1, qty: 400 }, { hotel_id: A2, qty: 350 }, { hotel_id: A3, qty: 250 }]);
  });

  test("GET returns the covered hotels (lead first) and each item's split", async () => {
    const created = await create(ADMIN_A, groupBody({ title: "Group read-back" }));
    const client = await httpClient(ADMIN_A);
    const res = await client.get(`/api/v1/arc-v2/${created.body.data.arc.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.arc.is_group).toBe(true);
    expect(res.body.data.arc.hotels.map((h) => h.hotel_id)).toEqual([A1, A2, A3]);
    expect(res.body.data.arc.hotels[0].is_lead).toBe(true);
    expect(res.body.data.items[0].hotel_qtys).toEqual([
      { hotel_id: A1, indicative_qty: 400 },
      { hotel_id: A2, indicative_qty: 350 },
      { hotel_id: A3, indicative_qty: 250 },
    ]);
  });

  test.each([
    ["fewer than two hotels", { hotel_ids: [A1], items: [{ product_variant_id: VARIANT, hotel_qtys: [{ hotel_id: A1, qty: 5 }] }] }, /at least two hotels/i],
    ["a lead hotel outside the covered hotels", { hotel_id: A3, hotel_ids: [A1, A2], items: [{ product_variant_id: VARIANT, hotel_qtys: [{ hotel_id: A1, qty: 5 }] }] }, /lead hotel/i],
    ["an item quantity for a hotel the ARC does not cover", { hotel_ids: [A1, A2], items: [{ product_variant_id: VARIANT, hotel_qtys: [{ hotel_id: A3, qty: 5 }] }] }, /not covered/i],
    ["a negative quantity", { items: [{ product_variant_id: VARIANT, hotel_qtys: [{ hotel_id: A1, qty: -1 }, { hotel_id: A2, qty: 3 }] }] }, /quantit/i],
    ["an item with no quantity at any hotel", { items: [{ product_variant_id: VARIANT, hotel_qtys: [{ hotel_id: A1, qty: 0 }] }] }, /quantit/i],
    ["an item without a per-hotel split", { items: [{ product_variant_id: VARIANT, indicative_qty: 10 }] }, /quantit/i],
  ])("rejects %s (400)", async (_label, overrides, message) => {
    const res = await create(ADMIN_A, groupBody(overrides));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
  });

  test("rejects hotels from different companies (400)", async () => {
    const res = await create(SUPER, groupBody({ hotel_ids: [A1, B1], items: [{ product_variant_id: VARIANT, hotel_qtys: [{ hotel_id: A1, qty: 5 }] }] }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/same company/i);
  });

  test("a buyer scoped to one hotel cannot create a group ARC that covers another (403)", async () => {
    const res = await create(A1_ONLY, groupBody({ hotel_ids: [A1, A2], items: [{ product_variant_id: VARIANT, hotel_qtys: [{ hotel_id: A1, qty: 5 }] }] }));
    expect(res.status).toBe(403);
  });

  test("the department must be one the buyer holds at every covered hotel (400)", async () => {
    const ok = await create(MULTI, groupBody({ hotel_ids: [A1, A2], items: [{ product_variant_id: VARIANT, hotel_qtys: [{ hotel_id: A1, qty: 5 }, { hotel_id: A2, qty: 5 }] }] }));
    expect(ok.status).toBe(200);
    const bad = await create(MULTI, groupBody({ department_id: ENG, hotel_ids: [A1, A2], items: [{ product_variant_id: VARIANT, hotel_qtys: [{ hotel_id: A1, qty: 5 }] }] }));
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/do not share this department/i);
  });

  test("editing a group draft re-splits quantities and changes coverage", async () => {
    const created = await create(ADMIN_A, groupBody({ title: "Group edit" }));
    const arcId = Number(created.body.data.arc.id);
    const client = await httpClient(ADMIN_A);
    const res = await client.patch(`/api/v1/arc-v2/${arcId}`).send({
      hotel_id: A2,
      hotel_ids: [A2, A3],
      items: [{ product_variant_id: VARIANT, uom: "pcs", hotel_qtys: [{ hotel_id: A2, qty: 60 }, { hotel_id: A3, qty: 40 }] }],
    });
    expect(res.status).toBe(200);
    const arc = await db.one(`SELECT hotel_id, is_group FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arc).toEqual({ hotel_id: A2, is_group: true });
    const hotels = await db.any(`SELECT hotel_id FROM tbl_arc_hotel_mappings WHERE arc_id = $1 ORDER BY hotel_id`, [arcId]);
    expect(hotels.map((h) => h.hotel_id)).toEqual([A2, A3]);
    const item = await db.one(`SELECT id, indicative_qty::float AS qty FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
    expect(item.qty).toBe(100);
    const split = await db.any(`SELECT hotel_id FROM tbl_arc_item_hotel_qty WHERE arc_item_id = $1 ORDER BY hotel_id`, [item.id]);
    expect(split.map((s) => s.hotel_id)).toEqual([A2, A3]);
  });

  test("narrowing coverage without resending items drops the removed hotel's quantity and re-totals", async () => {
    const created = await create(ADMIN_A, groupBody({ title: "Group narrow" }));
    const arcId = Number(created.body.data.arc.id);
    const client = await httpClient(ADMIN_A);
    const res = await client.patch(`/api/v1/arc-v2/${arcId}`).send({ hotel_ids: [A1, A2] });
    expect(res.status).toBe(200);
    const item = await db.one(`SELECT id, indicative_qty::float AS qty FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
    expect(item.qty).toBe(750);
  });

  test("a group draft can become a single-hotel draft; its group rows go", async () => {
    const created = await create(ADMIN_A, groupBody({ title: "Group to single" }));
    const arcId = Number(created.body.data.arc.id);
    const client = await httpClient(ADMIN_A);
    const res = await client.patch(`/api/v1/arc-v2/${arcId}`).send({
      is_group: false,
      items: [{ product_variant_id: VARIANT, uom: "pcs", indicative_qty: 90 }],
    });
    expect(res.status).toBe(200);
    expect((await db.one(`SELECT is_group FROM tbl_arc WHERE id = $1`, [arcId])).is_group).toBe(false);
    expect(await db.any(`SELECT 1 FROM tbl_arc_hotel_mappings WHERE arc_id = $1`, [arcId])).toHaveLength(0);
  });

  test("the lead hotel's buyer edits terms without needing access to every covered hotel", async () => {
    // Staff at a covered (non-lead) hotel are refused — arc.group.visibility.
    const created = await create(ADMIN_A, groupBody({ title: "Group edit rights", hotel_id: A1, hotel_ids: [A1, A2],
      items: [{ product_variant_id: VARIANT, hotel_qtys: [{ hotel_id: A1, qty: 1 }, { hotel_id: A2, qty: 1 }] }] }));
    const arcId = Number(created.body.data.arc.id);
    const lead = await httpClient(A1_ONLY); // A1 only — the lead hotel
    expect((await lead.patch(`/api/v1/arc-v2/${arcId}`).send({ title: "renamed by lead" })).status).toBe(200);
    // …but changing coverage needs access to every hotel involved.
    expect((await lead.patch(`/api/v1/arc-v2/${arcId}`).send({ hotel_ids: [A1, A3] })).status).toBe(403);
  });

  test("a single-hotel create without is_group behaves exactly as before", async () => {
    const res = await create(A1_ONLY, {
      title: "Plain single", category_id: CATEGORY, hotel_id: A1, department_id: PROC,
      items: [{ product_variant_id: VARIANT, indicative_qty: 12, uom: "pcs" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.is_group).toBe(false);
    expect(await db.any(`SELECT 1 FROM tbl_arc_hotel_mappings WHERE arc_id = $1`, [res.body.data.arc.id])).toHaveLength(0);
  });
});
