// ARC v2 — Manual entry: draft create / resume / section autosave (§11 arc.manual.draft).

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

describe("ARC v2 manual — draft create / resume / autosave", () => {
  const BUYER = IDS.users.a1_proc_buyer;
  const HOTEL = IDS.hotels.A1;
  const DEPT = IDS.departments.proc;
  const CATEGORY = TEST_CATEGORIES.beverages;
  const VARIANT_ID = 1;
  const VENDOR = IDS.users.vendor_alpha;
  let client;
  const createdArcIds = [];

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
    client = await httpClient(BUYER);
  });

  afterAll(async () => {
    if (createdArcIds.length) {
      await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::int[]))`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_manual_entry WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [createdArcIds]);
    }
  });

  async function newDraft(stage = "floated") {
    const res = await client.post("/api/v1/arc-v2/manual/draft").send({
      header: { title: "Resume me", type: "product", eligibility_type: "open" },
      scope: { hotel_id: HOTEL, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: stage, created_at: "2024-04-01T00:00:00Z" },
    });
    expect(res.status).toBe(200);
    const id = res.body.data.arc.id;
    createdArcIds.push(id);
    return id;
  }

  test("creates a draft with backdated created_at and a manual_entry row", async () => {
    const id = await newDraft("draft");
    const arc = await db.one(`SELECT * FROM tbl_arc WHERE id = $1`, [id]);
    expect(arc.status).toBe("draft");
    expect(new Date(arc.created_at).getUTCFullYear()).toBe(2024);
    const me = await db.one(`SELECT * FROM tbl_arc_manual_entry WHERE arc_id = $1`, [id]);
    expect(me.is_manual).toBe(true);
    expect(me.target_stage).toBe("draft");
    expect(me.entered_by).toBe(BUYER);
  });

  test("section autosave persists items + vendors + quotes; resume returns the graph", async () => {
    const id = await newDraft("evaluation");
    // Items.
    const itemsRes = await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/items`).send({
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "litre", target_price: 100, hsn: "2202" }],
    });
    expect(itemsRes.status).toBe(200);
    // Vendors.
    const venRes = await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/vendors`).send({
      vendors: [{ vendor_id: VENDOR }],
    });
    expect(venRes.status).toBe(200);
    // Look up the item id for the quote line.
    const item = await db.one(`SELECT id FROM tbl_arc_item WHERE arc_id = $1`, [id]);
    // Quotes.
    const qRes = await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/quotes`).send({
      quotes: [{
        vendor_id: VENDOR, submitted_at: "2024-04-05T00:00:00Z", payment_terms: "Net 30",
        lines: [{ arc_item_id: item.id, rate: 90, gst_pct: 5 }],
      }],
    });
    expect(qRes.status).toBe(200);

    // Resume.
    const resume = await client.get(`/api/v1/arc-v2/manual/draft/${id}`);
    expect(resume.status).toBe(200);
    const g = resume.body.data;
    expect(g.items.length).toBe(1);
    expect(g.items[0].hsn).toBe("2202");
    expect(g.invitations.length).toBe(1);
    expect(Number(g.invitations[0].vendor_id)).toBe(VENDOR);
    expect(g.quotes.length).toBe(1);
    expect(g.quotes[0].lines.length).toBe(1);
    expect(Number(g.quotes[0].lines[0].rate)).toBe(90);
  });
});
