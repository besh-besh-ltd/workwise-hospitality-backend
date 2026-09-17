// Group ARC — watching a live group rate contract.
//
//   · Usage per hotel: committed vs used, call-offs, which hotels have not
//     ordered yet, and on-contract spend — the share of a hotel's spend on the
//     contracted products that went through the contract (PRD §12).
//   · Hotel staff hear when the contract goes live, expires or is about to.
//   · The listing shows a group ARC once, under every covered hotel's filter.
//
// Scenario — an ACTIVE group contract (alpha, rate 90) covering A1 (lead, 400)
// + A2 (350) + A3 (250, paused). A1 has called off 100 through the contract
// and bought the same product outside it for ₹4,050 on an ordinary PO.

import { db } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { ROLE_IDS } from "../../fixtures/users.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { makeRFQ } from "../../factories/rfq.js";
import { grantRoleScope, revokeRoleScopes } from "../../helpers/roleScope.js";
import { markAsVendors, restoreUserTypes, deleteArcs } from "../../helpers/arcGroupSeed.js";
import { notifyArcEvent } from "../../../app/services/arcNotificationService.js";
import { ARC_EVENT_TYPES } from "../../../app/services/arcEventLogService.js";

const { A1, A2, A3 } = IDS.hotels;
const HC_A = IDS.hospitality.A;
const PROC = IDS.departments.proc;
const VARIANT = 1;
const TAG = `GRPACT-${Date.now()}`;

const CREATOR = IDS.users.companyA_admin;
const A2_STAFF = IDS.users.a1_eng_buyer;  // + A2 Procurement with mr.create below
const ALPHA = IDS.users.vendor_alpha;
const MR_CREATE_ROLE = 9_901;              // test-only role carrying mr.create

describe("Group ARC — the live contract", () => {
  let arcId, singleArcId, contractId, lineId;
  let typesBefore;
  const scopeIds = [];
  const cleanup = { poIds: [], mrIds: [], rfqIds: [] };

  beforeAll(async () => {
    typesBefore = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [[CREATOR, A2_STAFF]]);
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`, [[CREATOR, A2_STAFF]]);
    typesBefore.push(...(await markAsVendors([ALPHA])));

    await db.none(`INSERT INTO tbl_roles (id, title, description, created_by) VALUES ($1, 'MR raiser (test)', 'mr.create', NULL) ON CONFLICT (id) DO NOTHING`, [MR_CREATE_ROLE]);
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, p.id FROM tbl_permissions p
        WHERE p.resource::text = 'mr' AND p.action = 'create'
          AND NOT EXISTS (SELECT 1 FROM tbl_role_permissions rp WHERE rp.role_id = $1 AND rp.permission_id = p.id)`,
      [MR_CREATE_ROLE]
    );
    scopeIds.push(await grantRoleScope(db, { userId: A2_STAFF, roleId: MR_CREATE_ROLE, companyId: HC_A, hotelId: A2, departmentId: PROC }));
    scopeIds.push(await grantRoleScope(db, { userId: A2_STAFF, roleId: ROLE_IDS.TENDER_CREATOR, companyId: HC_A, hotelId: A2, departmentId: PROC }));

    arcId = Number((await db.one(
      `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
                            status, is_group, contract_start_at, contract_end_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'contract_active', true, NOW() - INTERVAL '30 days', NOW() + INTERVAL '300 days', $7)
       RETURNING id`,
      [`${TAG}-G`, `${TAG} group`, TEST_CATEGORIES.beverages, HC_A, A1, PROC, CREATOR]
    )).id);
    await db.none(`INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id) SELECT $1, h FROM unnest($2::int[]) h`, [arcId, [A1, A2, A3]]);
    const item = await db.one(`INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 1000, 'pcs') RETURNING id`, [arcId, VARIANT]);
    contractId = Number((await db.one(`INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`, [arcId, ALPHA])).id);
    lineId = Number((await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty, consumed_qty)
       VALUES ($1, $2, 90, 5, 1000, 100) RETURNING id`,
      [contractId, item.id]
    )).id);
    await db.none(
      `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty, consumed_qty, is_suspended)
       VALUES ($1, $2, 400, 100, false), ($1, $3, 350, 0, false), ($1, $4, 250, 0, true)`,
      [lineId, A1, A2, A3]
    );

    // A1 called off 100 through the contract (₹9,450 incl. 5% GST).
    const mr = await db.one(
      `INSERT INTO tbl_material_requisition (mr_number, title, hospitality_company_id, hotel_id, department_id, status, raised_by)
       VALUES ($1, 'A1 towels', $2, $3, $4, 'po_released', $5) RETURNING id`,
      [`${TAG}-MR`, HC_A, A1, PROC, CREATOR]
    );
    cleanup.mrIds.push(Number(mr.id));
    const callOff = await db.one(
      `INSERT INTO tbl_rfq_purchase_order (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
                                           finalized_vendor_id, total_value, quote_id, arc_contract_id, source_mr_id, is_call_off)
       VALUES (NULL, $1, $2, 'approved', '{}', 100, 90, $3, 9450, '{}', $4, $5, TRUE) RETURNING id`,
      [IDS.companies.A, `${TAG}-CO`, ALPHA, contractId, mr.id]
    );
    cleanup.poIds.push(Number(callOff.id));
    await db.none(
      `INSERT INTO tbl_purchase_order_product (purchase_order_id, quantity, unit, unit_price, total_price, product_variant_id, arc_contract_line_id)
       VALUES ($1, 100, 'pcs', 90, 9450, $2, $3)`,
      [callOff.id, VARIANT, lineId]
    );
    await db.none(
      `INSERT INTO tbl_arc_callof_po (po_id, mr_id, arc_contract_id, arc_contract_line_id, quantity, price_applied, released_at)
       VALUES ($1, $2, $3, $4, 100, 90, NOW() - INTERVAL '2 days')`,
      [callOff.id, mr.id, contractId, lineId]
    );

    // …and bought the same product outside the contract for ₹4,050.
    const { rfq_id: rfqId } = await makeRFQ(db, { createdBy: CREATOR, hotel: A1, department: PROC, status: 2 });
    const rfq = { id: rfqId };
    cleanup.rfqIds.push(Number(rfqId));
    const rfqProduct = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfq.id, VARIANT]
    );
    const offPo = await db.one(
      `INSERT INTO tbl_rfq_purchase_order (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
                                           finalized_vendor_id, total_value, quote_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'approved', $4, 45, 90, $5, 4050, '{}', NOW() - INTERVAL '5 days', NOW()) RETURNING id`,
      [rfq.id, IDS.companies.A, `${TAG}-OFF`, [rfqProduct.id], ALPHA]
    );
    cleanup.poIds.push(Number(offPo.id));
    await db.none(
      `INSERT INTO tbl_purchase_order_product (purchase_order_id, rfq_product_id, quantity, unit, unit_price, total_price)
       VALUES ($1, $2, 45, 'pcs', 90, 4050)`,
      [offPo.id, rfqProduct.id]
    );

    singleArcId = Number((await db.one(
      `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
                            status, contract_start_at, contract_end_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'contract_active', NOW() - INTERVAL '1 day', NOW() + INTERVAL '100 days', $7)
       RETURNING id`,
      [`${TAG}-S`, `${TAG} single`, TEST_CATEGORIES.beverages, HC_A, A1, PROC, CREATOR]
    )).id);
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = ANY($1::text[])`, [[String(arcId), String(singleArcId)]]);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [cleanup.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [cleanup.poIds]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::int[])`, [cleanup.mrIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [cleanup.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [cleanup.rfqIds]);
    await deleteArcs([arcId, singleArcId]);
    await revokeRoleScopes(db, scopeIds);
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [MR_CREATE_ROLE]);
    await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [MR_CREATE_ROLE]);
    await restoreUserTypes(typesBefore);
  });

  describe("usage per hotel", () => {
    let usage;
    beforeAll(async () => {
      const client = await httpClient(CREATOR);
      const res = await client.get(`/api/v1/arc-v2/${arcId}/active-summary`);
      expect(res.status).toBe(200);
      usage = res.body.data;
    });

    test("each covered hotel reports its share, what it used, and whether it is paused", () => {
      const byHotel = Object.fromEntries(usage.hotel_usage.map((h) => [h.hotel_id, h]));
      expect(Object.keys(byHotel).map(Number).sort()).toEqual([A1, A2, A3]);
      expect(byHotel[A1]).toMatchObject({ is_lead: true, committed_qty: 400, consumed_qty: 100, utilisation_pct: 25, call_off_count: 1, is_suspended: false });
      expect(byHotel[A2]).toMatchObject({ committed_qty: 350, consumed_qty: 0, utilisation_pct: 0, call_off_count: 0 });
      expect(byHotel[A3]).toMatchObject({ is_suspended: true });
    });

    test("on-contract spend is the share of a hotel's spend on these products that went through the contract", () => {
      const a1 = usage.hotel_usage.find((h) => h.hotel_id === A1);
      expect(a1.on_contract_value).toBe(9450);
      expect(a1.off_contract_value).toBe(4050);
      expect(a1.on_contract_pct).toBe(70);
      expect(usage.hotel_usage.find((h) => h.hotel_id === A2).on_contract_pct).toBeNull();
    });

    test("hotels that have not ordered yet are named (paused hotels excluded)", () => {
      expect(usage.not_ordering_hotel_ids).toEqual([A2]);
    });

    test("each call-off names the hotel that ordered it", () => {
      expect(usage.callOffs[0]).toMatchObject({ hotel_id: A1 });
      expect(usage.callOffs[0].hotel_name).toBeTruthy();
    });
  });

  describe("who hears about it", () => {
    const recipients = async (id, eventType) => (await db.any(
      `SELECT DISTINCT recipient_user_id FROM tbl_notifications
        WHERE additional_data->>'arc_id' = $1 AND additional_data->>'event_type' = $2`,
      [String(id), eventType]
    )).map((r) => Number(r.recipient_user_id));

    test("staff who order at a covered hotel are told the contract is live", async () => {
      await notifyArcEvent({ arcId, eventType: ARC_EVENT_TYPES.CONTRACT_ACTIVE, actorId: null, payload: {} });
      const ids = await recipients(arcId, "contract_active");
      expect(ids).toEqual(expect.arrayContaining([CREATOR, A2_STAFF]));
    });

    test("a single-hotel ARC's audience is unchanged", async () => {
      await notifyArcEvent({ arcId: singleArcId, eventType: ARC_EVENT_TYPES.CONTRACT_ACTIVE, actorId: null, payload: {} });
      expect(await recipients(singleArcId, "contract_active")).not.toContain(A2_STAFF);
    });
  });

  describe("the listing", () => {
    test("a group ARC appears once, marked, with every covered hotel", async () => {
      const client = await httpClient(CREATOR);
      const res = await client.post("/api/v1/arc-v2/list-view").send({ tab: "all", search: TAG, limit: 50 });
      expect(res.status).toBe(200);
      const rows = res.body.data.rows.filter((r) => Number(r.id) === arcId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ is_group: true, hotel_ids: [A1, A2, A3] });
      expect(rows[0].hotel_names).toHaveLength(3);
    });

    test("the business-unit facet counts it under each covered hotel, and filtering by any of them finds it", async () => {
      const client = await httpClient(CREATOR);
      const all = await client.post("/api/v1/arc-v2/list-view").send({ tab: "all", search: TAG, limit: 50 });
      const facet = Object.fromEntries(all.body.data.facets.buId.map((f) => [Number(f.key), f.count]));
      expect(facet[A2]).toBe(1);
      expect(facet[A3]).toBe(1);
      expect(facet[A1]).toBe(2); // the group ARC and the single-hotel ARC

      const byA3 = await client.post("/api/v1/arc-v2/list-view").send({ tab: "all", search: TAG, limit: 50, filters: { buId: [String(A3)] } });
      expect(byA3.body.data.rows.map((r) => Number(r.id))).toEqual([arcId]);
    });

    test("searching by a covered hotel's name finds the group ARC", async () => {
      const hotel = await db.one(`SELECT name FROM tbl_hospitality_company_hotels WHERE id = $1`, [A3]);
      const client = await httpClient(CREATOR);
      const res = await client.post("/api/v1/arc-v2/list-view").send({ tab: "all", search: hotel.name, limit: 100 });
      expect(res.body.data.rows.map((r) => Number(r.id))).toContain(arcId);
    });
  });
});
