// ARC v2 — publish-time window validation + zero-vendor guard (audit M1 + M2).
//
//   M1 — publish rejects an inverted/past submission window or inverted
//        contract period (not just the single submission_end < contract_start).
//   M2 — publish refuses to float a contract with no vendors to invite.
//
// Product-level: real Express app + Postgres.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedAutoApproveArcPolicy, cleanupArcPublishPolicy } from "../../helpers/arcPublishPolicy.js";

describe("ARC v2 — publish validation (M1 + M2)", () => {
  const BUYER = IDS.users.a1_proc_buyer;
  const HC    = IDS.hospitality.A;
  const HOTEL = IDS.hotels.A1;
  const DEPT = IDS.departments.proc;
  const CATEGORY = TEST_CATEGORIES.beverages;
  const VARIANT_ID = 1;
  const PUBLISH_POLICY_ID = 64925; // auto-approve ARC policy so the control case floats
  const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();
  let client;
  const createdArcIds = [];

  async function createDraft(overrides = {}) {
    const res = await client.post("/api/v1/arc-v2").send({
      title: "Publish validation",
      category_id: CATEGORY,
      hotel_id: HOTEL,
      department_id: DEPT,
      eligibility_type: "open",
      submission_start_at: D(1),
      submission_end_at:   D(7),
      contract_start_at:   D(14),
      contract_end_at:     D(200),
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
      ...overrides,
    });
    expect(res.status).toBe(200);
    const id = Number(res.body.data.arc.id);
    createdArcIds.push(id);
    return id;
  }

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
    client = await httpClient(BUYER);
    // Auto-approve ARC publish policy so the valid "control" case floats; the
    // M1/M2 cases 400 on window/panel validation BEFORE policy resolution, so
    // they're unaffected by the policy's presence.
    await seedAutoApproveArcPolicy({
      policyId: PUBLISH_POLICY_ID, hospitalityCompanyId: HC, hotelId: HOTEL,
      departmentId: null, processId: null, createdBy: BUYER, approver: BUYER,
    });
  });

  afterAll(async () => {
    await cleanupArcPublishPolicy({ policyId: PUBLISH_POLICY_ID, arcIds: createdArcIds });
    if (createdArcIds.length) {
      await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = ANY($1::text[])`, [createdArcIds.map(String)]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [createdArcIds]);
    }
    await db.none(`DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`, [CATEGORY, DEPT]);
  });

  test("M1 — rejects an inverted submission window (start ≥ end)", async () => {
    const id = await createDraft({ submission_start_at: D(7), submission_end_at: D(2) });
    const res = await client.post(`/api/v1/arc-v2/${id}/publish`).send({});
    expect(res.status).toBe(400);
  });

  test("M1 — rejects a submission window that has already closed", async () => {
    const id = await createDraft({ submission_start_at: D(-5), submission_end_at: D(-1) });
    const res = await client.post(`/api/v1/arc-v2/${id}/publish`).send({});
    expect(res.status).toBe(400);
  });

  test("M1 — rejects an inverted contract period (start ≥ end)", async () => {
    const id = await createDraft({ contract_start_at: D(200), contract_end_at: D(20) });
    const res = await client.post(`/api/v1/arc-v2/${id}/publish`).send({});
    expect(res.status).toBe(400);
  });

  test("M2 — refuses to float when no vendor would be invited", async () => {
    // invitation-only with no invitees → zero vendors tagged.
    const id = await createDraft({ eligibility_type: "invitation" });
    const res = await client.post(`/api/v1/arc-v2/${id}/publish`).send({});
    expect(res.status).toBe(400);
  });

  test("control — a valid open ARC with eligible vendors still floats", async () => {
    const id = await createDraft();
    const res = await client.post(`/api/v1/arc-v2/${id}/publish`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("floated");
    expect(res.body.data.vendor_count).toBeGreaterThan(0);
  });
});
