// ARC v2 — publish tags eligible vendors + notifies them (audit C3 + C2).
//
// Observable contract:
//   C3 — floating an "open" ARC snapshots an invitation row for EVERY eligible
//        vendor (active OR lapsed/expired per the agreed float-eligibility rule),
//        excluding cancelled/pending, and the ARC then shows up in those
//        vendors' request lists.
//   C2 — every tagged vendor receives an in-app notification for the float.
//
// Eligible set for category BEVERAGES (from tests/fixtures/vendors.js):
//   alpha (active), beta (active), gamma (expired/lapsed)  → tagged
//   delta (cancelled), epsilon (pending, other category)   → NOT tagged
//
// Product-level: real Express app + real Postgres. No mocks (nodemailer stubbed).

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

describe("ARC v2 — publish tags + notifies eligible vendors (C3 + C2)", () => {
  const BUYER = IDS.users.a1_proc_buyer;
  const HOTEL = IDS.hotels.A1;
  const DEPT = IDS.departments.proc;
  const PROC = IDS.processes.A_P1;
  const CATEGORY = TEST_CATEGORIES.beverages;
  const VARIANT_ID = 1;

  const EXPECTED = [IDS.users.vendor_alpha, IDS.users.vendor_beta, IDS.users.vendor_gamma]
    .map(Number).sort((a, b) => a - b);
  const EXCLUDED = [IDS.users.vendor_delta, IDS.users.vendor_epsilon].map(Number);

  let buyerClient;
  let arcId;

  beforeAll(async () => {
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(
      `UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`,
      [[IDS.users.vendor_alpha, IDS.users.vendor_beta, IDS.users.vendor_gamma]]
    );
    buyerClient = await httpClient(BUYER);

    const today = new Date();
    const createRes = await buyerClient.post("/api/v1/arc-v2").send({
      title: "Publish vendors — beverages open",
      category_id: CATEGORY,
      hotel_id: HOTEL,
      department_id: DEPT,
      process_id: PROC,
      eligibility_type: "open",
      submission_start_at: new Date(today.getTime() + 1 * 86400_000).toISOString(),
      submission_end_at:   new Date(today.getTime() + 7 * 86400_000).toISOString(),
      contract_start_at:   new Date(today.getTime() + 14 * 86400_000).toISOString(),
      contract_end_at:     new Date(today.getTime() + 200 * 86400_000).toISOString(),
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "litre" }],
    });
    expect(createRes.status).toBe(200);
    arcId = Number(createRes.body.data.arc.id);
    const pubRes = await buyerClient.post(`/api/v1/arc-v2/${arcId}/publish`).send({});
    expect(pubRes.status).toBe(200);
  });

  afterAll(async () => {
    if (arcId) {
      await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = $1`, [String(arcId)]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    }
    await db.none(
      `DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`,
      [CATEGORY, DEPT]
    );
  });

  test("C3 — open publish snapshots an invitation for every eligible vendor (active + lapsed), excluding cancelled/pending", async () => {
    const rows = await db.any(
      `SELECT vendor_id FROM tbl_arc_invitation WHERE arc_id = $1 ORDER BY vendor_id`,
      [arcId]
    );
    const ids = rows.map((r) => Number(r.vendor_id));
    expect(ids).toEqual(EXPECTED);
    for (const ex of EXCLUDED) expect(ids).not.toContain(ex);
  });

  test("C2 — each tagged vendor receives an in-app notification for the float", async () => {
    const rows = await db.any(
      `SELECT recipient_user_id FROM tbl_notifications
        WHERE additional_data->>'arc_id' = $1
        ORDER BY recipient_user_id`,
      [String(arcId)]
    );
    const recipients = rows.map((r) => Number(r.recipient_user_id));
    expect(recipients).toEqual(EXPECTED);
  });

  test("C3 — the floated ARC is visible in an eligible vendor's request list", async () => {
    const vendorClient = await httpClient(IDS.users.vendor_alpha);
    const res = await vendorClient.get("/api/v1/arc-v2/vendor/requests");
    expect(res.status).toBe(200);
    const arcIds = res.body.data.requests.map((r) => Number(r.id));
    expect(arcIds).toContain(arcId);
  });
});
