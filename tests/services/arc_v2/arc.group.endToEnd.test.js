// Group ARC — one rate contract for three hotels, end to end over HTTP.
//
// The other arc.group.* suites each seed the stage they test. This one walks a
// single group rate contract through every stage with the real endpoints, so
// the hand-offs between stages are covered too:
//
//   head office creates it for A1 (lead) + A2 + A3 and publishes
//   → alpha (serves A1, A2) and beta (serves A3) are invited for their hotels
//   → both quote → the window closes → commercial awards hotel by hotel
//   → the group committee (a different person) approves
//   → each vendor gets ONE contract covering the hotels it won, and signs it
//   → A2 raises an MR; the call-off PO is released under A2 and draws on A2's share
//   → head office sees A2's usage and that A1 and A3 have not ordered.
//
// Only the passage of time is seeded directly: the submission window closing
// and the contract term starting.

import { db } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { ROLE_IDS } from "../../fixtures/users.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { grantRoleScope, revokeRoleScopes } from "../../helpers/roleScope.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";
import { ensureApprovable } from "../../helpers/arcApproverPerms.js";
import {
  grantVendorHotelSubs, revokeVendorSubs, markAsVendors, restoreUserTypes, openSubmissionWindow, deleteArcs,
} from "../../helpers/arcGroupSeed.js";
import { seedGroupArcPolicy, cleanupGroupArcPolicies } from "../../helpers/arcGroupPolicy.js";
import { loadCallOffPoContext } from "../../../app/helper/arc_v2/callOffPoRenderer.js";

const { A1, A2, A3 } = IDS.hotels;
const HC_A = IDS.hospitality.A;
const PROC = IDS.departments.proc;
const VARIANT = 1;

const HO_BUYER = IDS.users.companyA_admin;   // runs the tender
const COMMITTEE = IDS.users.a1_proc_buyer;   // the group committee
const A2_BUYER = IDS.users.a1_eng_buyer;     // granted A2 Procurement: orders for A2
const ALPHA = IDS.users.vendor_alpha;
const BETA = IDS.users.vendor_beta;

describe("Group ARC — from draft to a hotel's call-off, end to end", () => {
  let typesBefore;
  let subIds = [];
  const policyIds = [];
  const scopeIds = [];
  let mappingId;
  let mrPolicyId;
  const mrIds = [];
  let arcId, itemId;
  let ho, committee, alpha, beta, a2;

  beforeAll(async () => {
    const buyers = [HO_BUYER, COMMITTEE, A2_BUYER];
    typesBefore = await db.any(`SELECT id, user_type, status FROM tbl_users WHERE id = ANY($1::int[])`, [buyers]);
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`, [buyers]);
    typesBefore.push(...(await markAsVendors([ALPHA, BETA])));
    subIds = [
      ...(await grantVendorHotelSubs([ALPHA], [A1, A2])),
      ...(await grantVendorHotelSubs([BETA], [A3])),
    ];
    await seedArcEvalPerms(db, [HO_BUYER]);
    // The group workflow: head office's publish is self-approved; the
    // committee award needs the committee member.
    policyIds.push(await seedGroupArcPolicy({ companyId: HC_A, approver: HO_BUYER, createdBy: HO_BUYER }));
    policyIds.push(await seedGroupArcPolicy({
      companyId: HC_A, approver: COMMITTEE, createdBy: HO_BUYER, entityType: "ARC_GROUP_COMMITTEE",
    }));

    // A2 ordering: a Procurement scope at A2, mapped to A2, sole MR approver there.
    scopeIds.push(await grantRoleScope(db, {
      userId: A2_BUYER, roleId: ROLE_IDS.TENDER_CREATOR, companyId: HC_A, hotelId: A2, departmentId: PROC,
    }));
    mappingId = Number((await db.one(
      `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
       VALUES ($1, $2, $3, 1, $1) RETURNING id`,
      [A2_BUYER, HC_A, A2]
    )).id);
    mrPolicyId = Number((await db.one(
      `INSERT INTO tbl_approval_policies (entity_type, hospitality_company_id, hotel_id, department_id,
                                          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ('MR', $1, $2, NULL, true, $3, NULL, false, false, 1) RETURNING id`,
      [HC_A, A2, HO_BUYER]
    )).id);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [mrPolicyId, A2_BUYER]
    );
    await ensureApprovable(db, [A2_BUYER], "mr", HC_A, A2, PROC);

    [ho, committee, alpha, beta, a2] = await Promise.all(
      [HO_BUYER, COMMITTEE, ALPHA, BETA, A2_BUYER].map((id) => httpClient(id))
    );
  });

  afterAll(async () => {
    const poIds = mrIds.length
      ? (await db.any(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id = ANY($1::int[])`, [mrIds])).map((r) => r.po_id)
      : [];
    if (mrIds.length) await db.none(`DELETE FROM tbl_arc_callof_po WHERE mr_id = ANY($1::int[])`, [mrIds]);
    if (poIds.length) {
      await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
      await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);
    }
    const mrInsts = (await db.any(`SELECT id FROM tbl_approval_instances WHERE approval_policy_id = $1`, [mrPolicyId])).map((r) => r.id);
    if (mrInsts.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [mrInsts]);
      await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [mrInsts]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [mrInsts]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [mrInsts]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [mrPolicyId]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [mrPolicyId]);
    if (mrIds.length) {
      await db.none(`DELETE FROM tbl_material_requisition_item WHERE mr_id = ANY($1::int[])`, [mrIds]);
      await db.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::int[])`, [mrIds]);
    }
    await cleanupGroupArcPolicies(policyIds);
    if (arcId) await deleteArcs([arcId]);
    await revokeRoleScopes(db, scopeIds);
    if (mappingId) await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE id = $1`, [mappingId]);
    await cleanupArcEvalPerms(db, [HO_BUYER]);
    await revokeVendorSubs(subIds);
    await restoreUserTypes(typesBefore);
  });

  test("head office creates a group ARC for three hotels and publishes it; each vendor is invited for the hotels it serves", async () => {
    const created = await ho.post("/api/v1/arc-v2").send({
      title: "Group towels — end to end",
      category_id: TEST_CATEGORIES.beverages,
      department_id: PROC,
      eligibility_type: "open",
      is_group: true,
      hotel_id: A1,
      hotel_ids: [A1, A2, A3],
      ...openSubmissionWindow(),
      items: [{
        product_variant_id: VARIANT, uom: "pcs",
        hotel_qtys: [{ hotel_id: A1, qty: 400 }, { hotel_id: A2, qty: 350 }, { hotel_id: A3, qty: 250 }],
      }],
    });
    expect(created.status).toBe(200);
    arcId = Number(created.body.data.arc.id);
    itemId = Number(created.body.data.items[0].id);

    const published = await ho.post(`/api/v1/arc-v2/${arcId}/publish`).send({});
    expect(published.status).toBe(200);
    expect(published.body.data.floated).toBe(true);
    expect(published.body.data.uncovered_hotel_ids).toEqual([]);

    const invitedFor = async (client) => (await client.get("/api/v1/arc-v2/vendor/requests"))
      .body.data.requests.find((r) => Number(r.id) === arcId)?.invited_hotel_ids;
    expect(await invitedFor(alpha)).toEqual([A1, A2]);
    expect(await invitedFor(beta)).toEqual([A3]);
  });

  test("both vendors quote one rate for their hotels", async () => {
    for (const [client, rate] of [[alpha, 90], [beta, 95]]) {
      const draft = await client.post("/api/v1/arc-v2/vendor/quote/draft").send({
        arc_id: arcId, lines: [{ arc_item_id: itemId, rate, gst_pct: 5 }],
      });
      expect(draft.status).toBe(200);
      const submit = await client.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: arcId });
      expect(submit.status).toBe(200);
    }
  });

  test("after the window closes, commercial awards hotel by hotel and finalizes to the group committee", async () => {
    await db.none(
      `UPDATE tbl_arc SET submission_end_at = NOW() - INTERVAL '1 day', submission_start_at = NOW() - INTERVAL '3 days' WHERE id = $1`,
      [arcId]
    );
    expect((await ho.get(`/api/v1/arc-v2/${arcId}/lifecycle`)).status).toBe(200);

    const comm = await ho.get(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval`);
    expect(comm.status).toBe(200);
    const lineOf = (vendorId) => Number(comm.body.data.quotes.find((q) => Number(q.vendor_id) === vendorId).quote_line_id);
    const alloc = (vendorId, hotelId, qty, rate) => ({
      hotel_id: hotelId, awarded_vendor_id: vendorId, awarded_quote_line_id: lineOf(vendorId), allocated_qty: qty,
      l_rank: vendorId === ALPHA ? "L1" : "L2", awarded_quote_snapshot: { rate, gst_pct: 5 },
    });
    const saved = await ho.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [alloc(ALPHA, A1, 400, 90), alloc(ALPHA, A2, 350, 90), alloc(BETA, A3, 250, 95)],
    });
    expect(saved.status).toBe(200);

    const finalized = await ho.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/finalize`).send({});
    expect(finalized.status).toBe(200);
    expect(finalized.body.data.unawarded).toEqual([]);
    expect((await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId])).status).toBe("committee_review");
  });

  test("the group committee approves; each vendor gets one contract for the hotels it won", async () => {
    const view = await committee.get(`/api/v1/arc-v2/committee/${arcId}`);
    expect(view.status).toBe(200);
    expect(view.body.data.approval.can_user_approve).toBe(true);
    expect(view.body.data.awards.find((a) => Number(a.awarded_vendor_id) === ALPHA).hotels)
      .toEqual([{ hotel_id: A1, allocated_qty: 400 }, { hotel_id: A2, allocated_qty: 350 }]);

    const decided = await committee.post(`/api/v1/arc-v2/committee/${arcId}/decide`).send({ decision: "approve" });
    expect(decided.status).toBe(200);

    const ledger = await db.any(
      `SELECT c.vendor_id, h.hotel_id, h.committed_qty::float AS committed
         FROM tbl_arc_contract c
         JOIN tbl_arc_contract_line l ON l.arc_contract_id = c.id
         JOIN tbl_arc_contract_line_hotel h ON h.arc_contract_line_id = l.id
        WHERE c.arc_id = $1
        ORDER BY c.vendor_id, h.hotel_id`,
      [arcId]
    );
    expect(ledger.map((r) => [Number(r.vendor_id), r.hotel_id, r.committed])).toEqual([
      [ALPHA, A1, 400], [ALPHA, A2, 350], [BETA, A3, 250],
    ].sort((x, y) => x[0] - y[0] || x[1] - y[1]));
  });

  test("both vendors see their hotels and sign; the contract goes live", async () => {
    for (const [client, vendorId, hotels] of [[alpha, ALPHA, [A1, A2]], [beta, BETA, [A3]]]) {
      const { id: contractId } = await db.one(`SELECT id FROM tbl_arc_contract WHERE arc_id = $1 AND vendor_id = $2`, [arcId, vendorId]);
      const detail = await client.get(`/api/v1/arc-v2/vendor/contracts/${contractId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data.hotels.map((h) => h.hotel_id)).toEqual(hotels);

      const otp = await client.post(`/api/v1/arc-v2/vendor/contracts/${contractId}/otp/request`).send({});
      expect(otp.status).toBe(200);
      const signed = await client.post(`/api/v1/arc-v2/vendor/contracts/${contractId}/otp/verify`).send({ code: otp.body.data.dev_code });
      expect(signed.status).toBe(200);
    }
    expect((await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId])).status).toBe("contract_active");
  });

  test("A2 orders from its share; the call-off PO is released under A2 with A2's identity", async () => {
    await db.none(`UPDATE tbl_arc SET contract_start_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [arcId]);

    const search = await a2.get(`/api/v1/mr/search-contracted-items?hotel_id=${A2}&department_id=${PROC}`);
    expect(search.status).toBe(200);
    const line = search.body.data.items.find((r) => Number(r.arc_id) === arcId);
    expect(line).toMatchObject({ is_group: true, vendor_id: ALPHA });
    expect(Number(line.hotel_remaining_qty)).toBe(350);

    const created = await a2.post("/api/v1/mr").send({
      title: "Towels for A2", hospitality_company_id: HC_A, hotel_id: A2, department_id: PROC,
      items: [{
        product_variant_id: VARIANT, quantity: 100, uom: "pcs",
        arc_contract_id: Number(line.arc_contract_id), arc_contract_line_id: Number(line.arc_contract_line_id),
      }],
    });
    expect(created.status).toBe(200);
    const mrId = Number(created.body.data.mr.id);
    mrIds.push(mrId);

    const submitted = await a2.post(`/api/v1/mr/${mrId}/submit`).send({});
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.warnings).toEqual([]);
    expect((await db.one(`SELECT status FROM tbl_material_requisition WHERE id = $1`, [mrId])).status).toBe("po_released");

    const { po_id: poId } = await db.one(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id = $1`, [mrId]);
    const hotel = await db.one(`SELECT name, gst FROM tbl_hospitality_company_hotels WHERE id = $1`, [A2]);
    const ctx = await loadCallOffPoContext(Number(poId));
    expect(ctx.buyer).toMatchObject({ hotel_name: hotel.name, gst: hotel.gst });
    expect((await a2.get(`/api/v1/po/detail/${poId}`)).status).toBe(200);
  });

  test("head office sees A2's usage, and that A1 and A3 have not ordered", async () => {
    const res = await ho.get(`/api/v1/arc-v2/${arcId}/active-summary`);
    expect(res.status).toBe(200);
    const usage = Object.fromEntries(res.body.data.hotel_usage.map((h) => [h.hotel_id, h]));
    expect(usage[A2]).toMatchObject({ committed_qty: 350, consumed_qty: 100, call_off_count: 1 });
    expect(usage[A1]).toMatchObject({ committed_qty: 400, consumed_qty: 0, call_off_count: 0 });
    expect(res.body.data.not_ordering_hotel_ids).toEqual([A1, A3]);
  });
});
