// Group ARC — the group workflow actually gates publishing.
//
// arc.group.policy.test.js proves a group rate contract RESOLVES the
// company-wide ARC_GROUP workflow and never a single hotel's. This suite walks
// the consequence over HTTP, with the approver being someone OTHER than the
// person publishing (the usual shape: a buyer prepares, head office signs off):
//
//   publish → parks pending_publish_approval, invisible to vendors
//           → only the named approver may decide
//           → approve → floats, and every vendor is invited for its hotels.
//
// A rejection parks publish_rejected and the ARC stays off the vendors' list.

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
const BASE = "/api/v1/arc-v2";

const CREATOR = IDS.users.companyA_admin;   // prepares and publishes
const APPROVER = IDS.users.a1_proc_buyer;   // the group workflow's approver
const OUTSIDER = IDS.users.a1_eng_buyer;    // named nowhere in the workflow
const ALPHA = IDS.users.vendor_alpha;
const BETA = IDS.users.vendor_beta;

describe("Group ARC — publishing waits for the group workflow's approver", () => {
  const arcIds = [];
  const policyIds = [];
  let subIds = [];
  let typesBefore;
  let creator, approver, outsider, alpha;

  const createDraft = async (title) => {
    const res = await creator.post(BASE).send({
      title,
      category_id: TEST_CATEGORIES.beverages,
      department_id: PROC,
      eligibility_type: "open",
      is_group: true,
      hotel_id: A1,
      hotel_ids: [A1, A2, A3],
      ...openSubmissionWindow(),
      items: [{
        product_variant_id: 1, uom: "pcs",
        hotel_qtys: [{ hotel_id: A1, qty: 400 }, { hotel_id: A2, qty: 350 }, { hotel_id: A3, qty: 250 }],
      }],
    });
    expect(res.status).toBe(200);
    const id = Number(res.body.data.arc.id);
    arcIds.push(id);
    return id;
  };

  beforeAll(async () => {
    const buyers = [CREATOR, APPROVER, OUTSIDER];
    typesBefore = await db.any(`SELECT id, user_type, status FROM tbl_users WHERE id = ANY($1::int[])`, [buyers]);
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`, [buyers]);
    typesBefore.push(...(await markAsVendors([ALPHA, BETA])));
    subIds = [
      ...(await grantVendorHotelSubs([ALPHA], [A1, A2])),
      ...(await grantVendorHotelSubs([BETA], [A3])),
    ];
    // The company-wide group workflow — approved by someone other than the creator.
    policyIds.push(await seedGroupArcPolicy({ companyId: HC_A, approver: APPROVER, createdBy: CREATOR }));
    [creator, approver, outsider, alpha] = await Promise.all(
      [CREATOR, APPROVER, OUTSIDER, ALPHA].map((id) => httpClient(id))
    );
  });

  afterAll(async () => {
    await cleanupGroupArcPolicies(policyIds);
    await deleteArcs(arcIds);
    await revokeVendorSubs(subIds);
    await restoreUserTypes(typesBefore);
  });

  test("publishing parks the group ARC for approval, and vendors cannot see it yet", async () => {
    const arcId = await createDraft("Group beverages — awaiting sign-off");

    const pub = await creator.post(`${BASE}/${arcId}/publish`).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data.floated).toBe(false);
    expect(pub.body.data.arc.status).toBe("pending_publish_approval");

    const inst = await db.one(
      `SELECT status FROM tbl_approval_instances WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1`,
      [arcId]
    );
    expect(inst.status).toBe("PENDING");

    const list = await alpha.get(`${BASE}/vendor/requests`);
    expect(list.body.data.requests.map((r) => Number(r.id))).not.toContain(arcId);
  });

  test("only the workflow's approver may decide", async () => {
    const arcId = arcIds[0];

    const mine = await approver.get(`${BASE}/${arcId}/publish-approval`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.approval.can_user_approve).toBe(true);

    const refused = await outsider.post(`${BASE}/${arcId}/publish-approval/decide`).send({ decision: "approve" });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId])).status).toBe("pending_publish_approval");
  });

  test("approval floats it and invites every vendor for the hotels it serves", async () => {
    const arcId = arcIds[0];

    const decided = await approver.post(`${BASE}/${arcId}/publish-approval/decide`).send({ decision: "approve" });
    expect(decided.status).toBe(200);
    expect((await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId])).status).toBe("floated");

    const invitations = await db.any(
      `SELECT i.vendor_id, array_agg(ih.hotel_id ORDER BY ih.hotel_id) AS hotel_ids
         FROM tbl_arc_invitation i
         JOIN tbl_arc_invitation_hotel ih ON ih.arc_invitation_id = i.id
        WHERE i.arc_id = $1 GROUP BY i.vendor_id`,
      [arcId]
    );
    const byVendor = Object.fromEntries(invitations.map((r) => [Number(r.vendor_id), r.hotel_ids.map(Number)]));
    expect(byVendor[ALPHA]).toEqual([A1, A2]);
    expect(byVendor[BETA]).toEqual([A3]);

    const list = await alpha.get(`${BASE}/vendor/requests`);
    expect(list.body.data.requests.map((r) => Number(r.id))).toContain(arcId);
  });

  test("a rejection keeps it off the vendors' list and lets the creator revise it", async () => {
    const arcId = await createDraft("Group beverages — sent back");
    expect((await creator.post(`${BASE}/${arcId}/publish`).send({})).body.data.arc.status).toBe("pending_publish_approval");

    const rejected = await approver
      .post(`${BASE}/${arcId}/publish-approval/decide`)
      .send({ decision: "reject", comment: "add the Delhi volumes" });
    expect(rejected.status).toBe(200);
    expect((await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId])).status).toBe("publish_rejected");

    const list = await alpha.get(`${BASE}/vendor/requests`);
    expect(list.body.data.requests.map((r) => Number(r.id))).not.toContain(arcId);

    const revised = await creator.patch(`${BASE}/${arcId}`).send({ title: "Group beverages — revised" });
    expect(revised.status).toBe(200);
  });
});
