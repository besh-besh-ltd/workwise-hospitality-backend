// Group ARC — publishing, and what each vendor is invited for.
//
// A regional vendor often serves only some of a group's hotels. Publishing a
// group rate contract invites every vendor that covers at least one hotel and
// records WHICH hotels each vendor may quote for and win. Each vendor then
// sees only its own hotels and quantities, and may submit while its
// subscription is active for at least one of them.
//
// Scenario (Company A, category Beverages, covering A1 + A2 + A3, lead A1):
//   alpha   — beverages active;  hotels A1, A2 active
//   beta    — beverages active;  hotel  A3 active
//   gamma   — beverages EXPIRED; hotel  A1 active   → invited, renewal needed
//   epsilon — no beverages sub;  hotel  A1 active   → not eligible
//
// Product-level: real Express app + Postgres over HTTP.

import { db } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import {
  grantVendorHotelSubs, revokeVendorSubs, markAsVendors, restoreUserTypes,
  openSubmissionWindow, deleteArcs,
} from "../../helpers/arcGroupSeed.js";
import { seedGroupArcPolicy, cleanupGroupArcPolicies } from "../../helpers/arcGroupPolicy.js";

const { A1, A2, A3 } = IDS.hotels;
const HC_A = IDS.hospitality.A;
const PROC = IDS.departments.proc;
const BEVERAGES = TEST_CATEGORIES.beverages;
const JUICE = TEST_CATEGORIES.juice;
const VARIANT = 1;

const ADMIN_A = IDS.users.companyA_admin;
const ALPHA = IDS.users.vendor_alpha;
const BETA = IDS.users.vendor_beta;
const GAMMA = IDS.users.vendor_gamma;
const EPSILON = IDS.users.vendor_epsilon;

const split = (pairs) => pairs.map(([hotel_id, qty]) => ({ hotel_id, qty }));

describe("Group ARC — publish and per-hotel vendor coverage", () => {
  const arcIds = [];
  const policyIds = [];
  let subIds = [];
  let typesBefore;
  let buyer;
  let groupArcId;
  let groupItemId;

  const createGroupDraft = async (overrides = {}) => {
    const res = await buyer.post("/api/v1/arc-v2").send({
      title: "Group beverages",
      category_id: BEVERAGES,
      department_id: PROC,
      eligibility_type: "open",
      is_group: true,
      hotel_id: A1,
      hotel_ids: [A1, A2, A3],
      ...openSubmissionWindow(),
      items: [{ product_variant_id: VARIANT, uom: "pcs", hotel_qtys: split([[A1, 400], [A2, 350], [A3, 250]]) }],
      ...overrides,
    });
    expect(res.status).toBe(200);
    arcIds.push(Number(res.body.data.arc.id));
    return res.body.data;
  };

  beforeAll(async () => {
    typesBefore = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = $1`, [ADMIN_A]);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [ADMIN_A]);
    typesBefore.push(...(await markAsVendors([ALPHA, BETA, GAMMA, EPSILON])));
    subIds = [
      ...(await grantVendorHotelSubs([ALPHA], [A1, A2])),
      ...(await grantVendorHotelSubs([BETA], [A3])),
      ...(await grantVendorHotelSubs([GAMMA, EPSILON], [A1])),
    ];
    buyer = await httpClient(ADMIN_A);
  });

  afterAll(async () => {
    await cleanupGroupArcPolicies(policyIds);
    await deleteArcs(arcIds);
    await revokeVendorSubs(subIds);
    await restoreUserTypes(typesBefore);
  });

  test("without a group approval workflow, publishing is refused and says what to set up", async () => {
    const draft = await createGroupDraft();
    const res = await buyer.post(`/api/v1/arc-v2/${draft.arc.id}/publish`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/group rate contracts/i);
    expect((await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [draft.arc.id])).status).toBe("draft");
  });

  test("with the group workflow, publishing floats and invites each vendor for the hotels it covers", async () => {
    policyIds.push(await seedGroupArcPolicy({ companyId: HC_A, approver: ADMIN_A, createdBy: ADMIN_A }));
    const draft = await createGroupDraft({ title: "Group beverages — live" });
    groupArcId = Number(draft.arc.id);
    groupItemId = Number(draft.items[0].id);

    const res = await buyer.post(`/api/v1/arc-v2/${groupArcId}/publish`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.floated).toBe(true);
    expect(res.body.data.uncovered_hotel_ids).toEqual([]);

    const rows = await db.any(
      `SELECT i.vendor_id, array_agg(ih.hotel_id ORDER BY ih.hotel_id) AS hotel_ids
         FROM tbl_arc_invitation i
         JOIN tbl_arc_invitation_hotel ih ON ih.arc_invitation_id = i.id
        WHERE i.arc_id = $1
        GROUP BY i.vendor_id`,
      [groupArcId]
    );
    const byVendor = Object.fromEntries(rows.map((r) => [Number(r.vendor_id), r.hotel_ids.map(Number)]));
    expect(byVendor).toEqual({ [ALPHA]: [A1, A2], [BETA]: [A3], [GAMMA]: [A1] });
  });

  test("publish reports covered hotels that no eligible vendor serves", async () => {
    // Juice: only beta subscribes, and beta serves only A3.
    const draft = await createGroupDraft({
      title: "Group juice", category_id: JUICE, hotel_ids: [A2, A3], hotel_id: A2,
      items: [{ product_variant_id: VARIANT, uom: "pcs", hotel_qtys: split([[A2, 10], [A3, 10]]) }],
    });
    const res = await buyer.post(`/api/v1/arc-v2/${draft.arc.id}/publish`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.uncovered_hotel_ids).toEqual([A2]);
  });

  test("a hand-picked vendor that serves none of the hotels is refused at publish", async () => {
    const draft = await createGroupDraft({
      title: "Group invite-only", eligibility_type: "invitation", invited_vendor_ids: [ALPHA, EPSILON],
    });
    const res = await buyer.post(`/api/v1/arc-v2/${draft.arc.id}/publish`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot serve any of this rate contract's hotels/i);
    expect(res.body.message).toContain(String(EPSILON));
  });

  describe("what a vendor sees", () => {
    test("the request list marks the group and the hotels this vendor is invited for", async () => {
      const client = await httpClient(ALPHA);
      const res = await client.get("/api/v1/arc-v2/vendor/requests");
      expect(res.status).toBe(200);
      const row = res.body.data.requests.find((r) => Number(r.id) === groupArcId);
      expect(row).toMatchObject({ is_group: true, invited_hotel_ids: [A1, A2] });
    });

    test("the request detail shows only this vendor's hotels and quantities", async () => {
      const client = await httpClient(ALPHA);
      const res = await client.get(`/api/v1/arc-v2/vendor/requests/${groupArcId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.arc.hotels.map((h) => h.hotel_id)).toEqual([A1, A2]);
      expect(res.body.data.arc.hotels[0]).not.toHaveProperty("gst");
      const item = res.body.data.items.find((i) => Number(i.id) === groupItemId);
      expect(item.hotel_qtys).toEqual([{ hotel_id: A1, indicative_qty: 400 }, { hotel_id: A2, indicative_qty: 350 }]);
      expect(Number(item.indicative_qty)).toBe(750);
      expect(res.body.data.renewal_needed_hotel_ids).toEqual([]);
    });

    test("a vendor with a lapsed subscription is told which hotels need renewal", async () => {
      const client = await httpClient(GAMMA);
      const res = await client.get(`/api/v1/arc-v2/vendor/requests/${groupArcId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.renewal_needed_hotel_ids).toEqual([A1]);
    });
  });

  describe("who may submit", () => {
    const draftAndSubmit = async (vendorId) => {
      const client = await httpClient(vendorId);
      const draft = await client.post("/api/v1/arc-v2/vendor/quote/draft").send({
        arc_id: groupArcId, lines: [{ arc_item_id: groupItemId, rate: 120, gst_pct: 18 }],
      });
      expect(draft.status).toBe(200);
      return client.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: groupArcId });
    };

    test("a vendor active for at least one invited hotel may submit", async () => {
      // alpha's A2 subscription lapses; A1 is still active.
      await db.none(
        `UPDATE tbl_vendor_hotel_category_subscription SET status = 'expired'
          WHERE vendor_id = $1 AND item_type = 'hotel' AND item_id = $2 AND id = ANY($3::int[])`,
        [ALPHA, A2, subIds]
      );
      expect((await draftAndSubmit(ALPHA)).status).toBe(200);
    });

    test("a vendor whose only invited hotel has lapsed may draft but not submit", async () => {
      await db.none(
        `UPDATE tbl_vendor_hotel_category_subscription SET status = 'expired'
          WHERE vendor_id = $1 AND item_type = 'hotel' AND item_id = $2 AND id = ANY($3::int[])`,
        [BETA, A3, subIds]
      );
      expect((await draftAndSubmit(BETA)).status).toBe(403);
    });
  });
});
