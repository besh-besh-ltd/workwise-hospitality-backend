// ARC v2 — Manual entry: stage finalize for S0-S2 (§11 arc.manual.stage.*).
// Finalize lands the correct tbl_arc.status; backdated window persisted; NO
// contract rows for S0-S2.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

describe("ARC v2 manual — stage finalize (draft/floated/eval)", () => {
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

  async function draft(stage) {
    const res = await client.post("/api/v1/arc-v2/manual/draft").send({
      header: { title: `Stage ${stage}`, type: "product", eligibility_type: "open" },
      scope: { hotel_id: HOTEL, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: stage, created_at: "2024-04-01T00:00:00Z" },
    });
    expect(res.status).toBe(200);
    const id = res.body.data.arc.id;
    createdArcIds.push(id);
    return id;
  }

  async function addItem(id) {
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/items`).send({
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "litre" }],
    });
  }
  async function addVendor(id) {
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/vendors`).send({ vendors: [{ vendor_id: VENDOR }] });
  }

  test("S0 draft → finalizes to status 'draft', no contracts", async () => {
    const id = await draft("draft");
    await addItem(id);
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("draft");
    const c = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_contract WHERE arc_id = $1`, [id]);
    expect(c.n).toBe(0);
  });

  test("S1 floated → status 'floated', window + floated event backdated, no contracts", async () => {
    const id = await draft("floated");
    await addItem(id);
    await addVendor(id);
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      floated_at: "2024-04-03T00:00:00Z",
      submission_start_at: "2024-04-03T00:00:00Z",
      submission_end_at: "2024-04-10T00:00:00Z",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("floated");
    const arc = await db.one(`SELECT submission_start_at, submission_end_at FROM tbl_arc WHERE id = $1`, [id]);
    expect(new Date(arc.submission_start_at).getUTCFullYear()).toBe(2024);
    const evt = await db.any(`SELECT * FROM tbl_arc_event_log WHERE arc_id = $1 AND event_type = 'floated'`, [id]);
    expect(evt.length).toBe(1);
    expect(new Date(evt[0].at).getUTCMonth()).toBe(3); // April (0-based)
    const c = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_contract WHERE arc_id = $1`, [id]);
    expect(c.n).toBe(0);
  });

  test("S2 evaluation → status 'comm_eval_in_progress', no contracts", async () => {
    const id = await draft("evaluation");
    await addItem(id);
    await addVendor(id);
    const item = await db.one(`SELECT id FROM tbl_arc_item WHERE arc_id = $1`, [id]);
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/quotes`).send({
      quotes: [{ vendor_id: VENDOR, submitted_at: "2024-04-08T00:00:00Z", lines: [{ arc_item_id: item.id, rate: 90, gst_pct: 5 }] }],
    });
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      floated_at: "2024-04-03T00:00:00Z",
      submission_start_at: "2024-04-03T00:00:00Z",
      submission_end_at: "2024-04-10T00:00:00Z",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("comm_eval_in_progress");
    const c = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_contract WHERE arc_id = $1`, [id]);
    expect(c.n).toBe(0);
  });

  test("double-finalize is rejected (409)", async () => {
    const id = await draft("draft");
    await addItem(id);
    const ok = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({ confirm: true });
    expect(ok.status).toBe(200);
    const again = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({ confirm: true });
    expect(again.status).toBe(409);
  });
});
