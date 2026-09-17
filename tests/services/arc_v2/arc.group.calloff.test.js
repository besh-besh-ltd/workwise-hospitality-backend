// Group ARC — hotels ordering against a group rate contract.
//
// Staff at any covered hotel find the contract's items, raise a material
// requisition (MR) and, once it is approved, a call-off purchase order is
// released under THEIR hotel. Usage is recorded per hotel. The group total
// is the hard cap; a hotel may order past its own share (a soft allocation)
// and the ARC creator is told when that happens (PRD default).
//
// Scenario — an ACTIVE group contract (vendor alpha, rate 90, 1,000 pcs)
// covering A1 (400) + A2 (350) + A3 (250), lead A1, Procurement. The ordering
// user holds ONLY an A2 / Procurement scope.

import { db } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { ROLE_IDS } from "../../fixtures/users.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { grantRoleScope, revokeRoleScopes } from "../../helpers/roleScope.js";
import { ensureApprovable } from "../../helpers/arcApproverPerms.js";
import { markAsVendors, restoreUserTypes, deleteArcs } from "../../helpers/arcGroupSeed.js";
import { loadCallOffPoContext } from "../../../app/helper/arc_v2/callOffPoRenderer.js";
import { handleCallOffRejection } from "../../../app/services/callOffPoService.js";

const { A1, A2, A3 } = IDS.hotels;
const HC_A = IDS.hospitality.A;
const PROC = IDS.departments.proc;
const VARIANT = 1;

const CREATOR = IDS.users.companyA_admin;  // created the group ARC
const A2_BUYER = IDS.users.a1_eng_buyer;   // A1 Engineering + (granted) A2 Procurement
const A1_BUYER = IDS.users.a1_proc_buyer;  // A1 Procurement (the lead hotel)
const B_ADMIN = IDS.users.companyB_admin;
const ALPHA = IDS.users.vendor_alpha;

describe("Group ARC — ordering per hotel", () => {
  let arcId, contractId, lineId, mrPolicyId, mappingId;
  let poId;
  const mrIds = [];
  const scopeIds = [];
  let typesBefore;
  let a2;

  const ledger = async () => db.any(
    `SELECT hotel_id, committed_qty::float AS committed, consumed_qty::float AS used
       FROM tbl_arc_contract_line_hotel WHERE arc_contract_line_id = $1 ORDER BY hotel_id`,
    [lineId]
  );
  const lineUsed = async () => Number((await db.one(`SELECT consumed_qty FROM tbl_arc_contract_line WHERE id = $1`, [lineId])).consumed_qty);

  const raiseMr = async (client, quantity) => {
    const create = await client.post("/api/v1/mr").send({
      title: "Towels for A2", hospitality_company_id: HC_A, hotel_id: A2, department_id: PROC,
      items: [{ product_variant_id: VARIANT, quantity, uom: "pcs", arc_contract_id: contractId, arc_contract_line_id: lineId }],
    });
    if (create.body?.data?.mr?.id) mrIds.push(Number(create.body.data.mr.id));
    return create;
  };

  beforeAll(async () => {
    const users = [CREATOR, A2_BUYER, A1_BUYER, B_ADMIN];
    typesBefore = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [users]);
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`, [users]);
    typesBefore.push(...(await markAsVendors([ALPHA])));
    scopeIds.push(await grantRoleScope(db, {
      userId: A2_BUYER, roleId: ROLE_IDS.TENDER_CREATOR, companyId: HC_A, hotelId: A2, departmentId: PROC,
    }));
    // Hotel staff are mapped to their hotel; approver resolution requires it.
    mappingId = Number((await db.one(
      `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
       VALUES ($1, $2, $3, 1, $1) RETURNING id`,
      [A2_BUYER, HC_A, A2]
    )).id);

    arcId = Number((await db.one(
      `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
                            status, is_group, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-GROUP-CALLOFF-' || floor(random() * 1e9)::text, 'Group towels', $1, $2, $3, $4,
               'contract_active', true, NOW() - INTERVAL '1 day', NOW() + INTERVAL '300 days', $5)
       RETURNING id`,
      [TEST_CATEGORIES.beverages, HC_A, A1, PROC, CREATOR]
    )).id);
    await db.none(`INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id) SELECT $1, h FROM unnest($2::int[]) h`, [arcId, [A1, A2, A3]]);
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 1000, 'pcs') RETURNING id`,
      [arcId, VARIANT]
    );
    contractId = Number((await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, signed_by_vendor_at) VALUES ($1, $2, 'active', NOW()) RETURNING id`,
      [arcId, ALPHA]
    )).id);
    lineId = Number((await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 90, 5, 1000) RETURNING id`,
      [contractId, item.id]
    )).id);
    await db.none(
      `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty)
       VALUES ($1, $2, 400), ($1, $3, 350), ($1, $4, 250)`,
      [lineId, A1, A2, A3]
    );

    // MR approval at A2: the ordering buyer is the sole approver, so submit auto-releases.
    mrPolicyId = Number((await db.one(
      `INSERT INTO tbl_approval_policies (entity_type, hospitality_company_id, hotel_id, department_id,
                                          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ('MR', $1, $2, NULL, true, $3, NULL, false, false, 1) RETURNING id`,
      [HC_A, A2, CREATOR]
    )).id);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [mrPolicyId, A2_BUYER]
    );
    await ensureApprovable(db, [A2_BUYER], "mr", HC_A, A2, PROC);
    a2 = await httpClient(A2_BUYER);
  });

  afterAll(async () => {
    const insts = (await db.any(`SELECT id FROM tbl_approval_instances WHERE approval_policy_id = $1`, [mrPolicyId])).map((r) => r.id);
    if (insts.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [insts]);
      await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [insts]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [insts]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [insts]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [mrPolicyId]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [mrPolicyId]);
    const poIds = (await db.any(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id = ANY($1::int[])`, [mrIds])).map((r) => r.po_id);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE mr_id = ANY($1::int[])`, [mrIds]);
    if (poIds.length) {
      await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
      await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);
    }
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE mr_id = ANY($1::int[])`, [mrIds]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::int[])`, [mrIds]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    await deleteArcs([arcId]);
    await revokeRoleScopes(db, scopeIds);
    if (mappingId) await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE id = $1`, [mappingId]);
    await restoreUserTypes(typesBefore);
  });

  test("a covered hotel finds the contract line with its own share and the group's remaining quantity", async () => {
    const res = await a2.get(`/api/v1/mr/search-contracted-items?hotel_id=${A2}&department_id=${PROC}`);
    expect(res.status).toBe(200);
    const row = res.body.data.items.find((r) => Number(r.arc_contract_line_id) === lineId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ is_group: true });
    expect(Number(row.remaining_qty)).toBe(1000);
    expect(Number(row.hotel_committed_qty)).toBe(350);
    expect(Number(row.hotel_remaining_qty)).toBe(350);
    expect(Number(row.current_rate)).toBe(90);
  });

  test("a paused hotel does not see the line", async () => {
    await db.none(`UPDATE tbl_arc_contract_line_hotel SET is_suspended = true WHERE arc_contract_line_id = $1 AND hotel_id = $2`, [lineId, A1]);
    try {
      const a1 = await httpClient(A1_BUYER);
      const res = await a1.get(`/api/v1/mr/search-contracted-items?hotel_id=${A1}&department_id=${PROC}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items.find((r) => Number(r.arc_contract_line_id) === lineId)).toBeUndefined();
    } finally {
      await db.none(`UPDATE tbl_arc_contract_line_hotel SET is_suspended = false WHERE arc_contract_line_id = $1 AND hotel_id = $2`, [lineId, A1]);
    }
  });

  test("a hotel orders past its share: submit warns, the call-off is released, and usage is recorded for that hotel", async () => {
    const create = await raiseMr(a2, 400); // share 350, group remaining 1000
    expect(create.status).toBe(200);
    const mrId = Number(create.body.data.mr.id);
    const submit = await a2.post(`/api/v1/mr/${mrId}/submit`).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.warnings).toEqual([
      expect.objectContaining({ arc_contract_line_id: lineId, hotel_id: A2, hotel_remaining_qty: 350, quantity: 400 }),
    ]);
    expect((await db.one(`SELECT status FROM tbl_material_requisition WHERE id = $1`, [mrId])).status).toBe("po_released");
    poId = Number((await db.one(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id = $1`, [mrId])).po_id);

    expect(await lineUsed()).toBe(400);
    expect((await ledger()).find((r) => r.hotel_id === A2)).toEqual({ hotel_id: A2, committed: 350, used: 400 });
    const events = await db.any(
      `SELECT payload FROM tbl_arc_event_log WHERE arc_id = $1 AND event_type = 'call_off_over_hotel_share'`, [arcId]
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ hotel_id: A2, mr_id: mrId });
  });

  test("the group total stays the hard cap", async () => {
    const create = await raiseMr(a2, 700); // group remaining is now 600
    expect(create.status).toBe(200);
    const submit = await a2.post(`/api/v1/mr/${create.body.data.mr.id}/submit`).send({});
    expect(submit.status).toBe(400);
    expect(submit.body.message).toMatch(/remaining quantity/i);
  });

  test("the call-off PO carries the ordering hotel's identity", async () => {
    const hotel = await db.one(`SELECT name, gst FROM tbl_hospitality_company_hotels WHERE id = $1`, [A2]);
    const ctx = await loadCallOffPoContext(poId);
    expect(ctx.buyer).toMatchObject({ hotel_name: hotel.name, gst: hotel.gst });
  });

  test("the ordering hotel sees its call-off PO; another company does not", async () => {
    const detail = await a2.get(`/api/v1/po/detail/${poId}`);
    expect(detail.status).toBe(200);
    const list = await a2.get(`/api/v1/po/list?limit=100`);
    expect(list.status).toBe(200);
    const rows = list.body.data?.rows || list.body.data?.pos || list.body.data || [];
    expect(JSON.stringify(rows)).toContain(`"id":${poId}`);

    const other = await httpClient(B_ADMIN);
    expect([403, 404]).toContain((await other.get(`/api/v1/po/detail/${poId}`)).status);
  });

  test("a vendor rejecting the call-off reverses that hotel's usage", async () => {
    await db.tx((t) => handleCallOffRejection(poId, "cannot deliver", t));
    expect(await lineUsed()).toBe(0);
    expect((await ledger()).find((r) => r.hotel_id === A2).used).toBe(0);
  });
});
