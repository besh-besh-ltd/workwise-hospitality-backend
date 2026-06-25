// ARC v2 — Manual entry: vendor eligibility + override toggle + dupe arc_number
// (§11 arc.manual.vendors, arc.manual.dupe).

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const BUYER = IDS.users.a1_proc_buyer;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const CATEGORY = TEST_CATEGORIES.beverages;
const VENDOR_ALPHA = IDS.users.vendor_alpha;   // active beverages
const VENDOR_GAMMA = IDS.users.vendor_gamma;   // expired beverages (still eligible)
const VENDOR_DELTA = IDS.users.vendor_delta;   // cancelled (override only)

describe("ARC v2 manual — vendor eligibility + override + dupe", () => {
  let client;
  const createdArcIds = [];

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id IN ($1, $2, $3)`,
      [VENDOR_ALPHA, VENDOR_GAMMA, VENDOR_DELTA]);
    client = await httpClient(BUYER);
  });

  afterAll(async () => {
    if (createdArcIds.length) {
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_manual_entry WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [createdArcIds]);
    }
  });

  async function newDraft(extraHeader = {}) {
    const res = await client.post("/api/v1/arc-v2/manual/draft").send({
      header: { title: "vendors", type: "product", ...extraHeader },
      scope: { hotel_id: HOTEL, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: "draft", created_at: "2024-04-01T00:00:00Z" },
    });
    expect(res.status).toBe(200);
    const id = res.body.data.arc.id;
    createdArcIds.push(id);
    return id;
  }

  test("all-vendors lists all active vendors with a `subscribed` flag", async () => {
    const res = await client.get(`/api/v1/arc-v2/manual/all-vendors?hotel_id=${HOTEL}&category_id=${CATEGORY}`);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.data.vendors.map((v) => [Number(v.id), v]));
    expect(byId.get(VENDOR_ALPHA)?.subscribed).toBe(true);   // active beverages
    expect(byId.get(VENDOR_GAMMA)?.subscribed).toBe(true);   // expired counts as eligible
    expect(byId.get(VENDOR_DELTA)?.subscribed).toBe(false);  // cancelled → not subscribed
  });

  test("selecting an unsubscribed vendor with override sets eligibility_overridden", async () => {
    const id = await newDraft();
    const res = await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/vendors`).send({
      vendors: [{ vendor_id: VENDOR_DELTA, eligibility_overridden: true }],
    });
    expect(res.status).toBe(200);
    const me = await db.one(`SELECT eligibility_overridden FROM tbl_arc_manual_entry WHERE arc_id = $1`, [id]);
    expect(me.eligibility_overridden).toBe(true);
    const inv = await db.one(`SELECT vendor_id FROM tbl_arc_invitation WHERE arc_id = $1`, [id]);
    expect(Number(inv.vendor_id)).toBe(VENDOR_DELTA);
  });

  test("duplicate user-supplied arc_number → 409", async () => {
    const num = `ARC-LEGACY-${Date.now()}`;
    const first = await client.post("/api/v1/arc-v2/manual/draft").send({
      header: { title: "legacy 1", arc_number: num },
      scope: { hotel_id: HOTEL, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: "draft", created_at: "2024-04-01T00:00:00Z" },
    });
    expect(first.status).toBe(200);
    createdArcIds.push(first.body.data.arc.id);
    expect(first.body.data.arc.arc_number).toBe(num);

    const dupe = await client.post("/api/v1/arc-v2/manual/draft").send({
      header: { title: "legacy 2", arc_number: num },
      scope: { hotel_id: HOTEL, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: "draft", created_at: "2024-04-01T00:00:00Z" },
    });
    expect(dupe.status).toBe(409);
  });

  test("blank arc_number → server-generated unique ARC-* number", async () => {
    const id = await newDraft();
    const arc = await db.one(`SELECT arc_number FROM tbl_arc WHERE id = $1`, [id]);
    expect(arc.arc_number).toMatch(/^ARC-/);
  });
});
