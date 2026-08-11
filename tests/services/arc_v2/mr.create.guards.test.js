// MR create — tenant-scope derivation + contract-linkage validation +
// over-consumption guard (audit CO1, CO2, CO4-submit, CO16).
//
// Product-level: real Express app + Postgres.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { ensureApprovable } from "../../helpers/arcApproverPerms.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const HOTEL_B1 = IDS.hotels.B1; // buyer has no access
const DEPT_PROC = IDS.departments.proc;
const DEPT_ENG = IDS.departments.eng;
const PROC = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const VENDOR2 = IDS.users.vendor_beta;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;
const OTHER_VARIANT_ID = 2;

describe("MR create guards (CO1 scope · CO2 linkage · CO4 over-consumption)", () => {
  let client;
  let arcId, contractId, contractLineId, contract2Id, mrPolicyId = 64941;

  beforeAll(async () => {
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`, [CATEGORY, DEPT_PROC]);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    client = await httpClient(BUYER);

    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-MRGUARD-1','MR guard ARC',$1,$2,$3,$4,$5,'contract_active',
               NOW()-INTERVAL '30 days', NOW()-INTERVAL '20 days',
               NOW()-INTERVAL '10 days', NOW()+INTERVAL '180 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT_PROC, PROC, BUYER]);
    arcId = arc.id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 1000, 'litre') RETURNING *`, [arcId, VARIANT_ID]);
    const contract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'active') RETURNING *`,
      [arcId, VENDOR]);
    contractId = contract.id;
    const line = await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 90, 5, 1000) RETURNING *`, [contractId, item.id]);
    contractLineId = line.id;
    // A second, unrelated contract (different vendor) — used to prove a line
    // can't be claimed under the wrong contract.
    const contract2 = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'active') RETURNING *`,
      [arcId, VENDOR2]);
    contract2Id = contract2.id;

    // MR policy: BUYER is sole approver (auto-approves) — only needed by the
    // happy-path submit; over-consumption is checked before policy resolution.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1,'MR',$2,$3,NULL,true,$4,NULL,false,false,1) ON CONFLICT (id) DO NOTHING`,
      [mrPolicyId, HC, HOTEL, BUYER]);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1,1,'ANY','USER',$2)`, [mrPolicyId, BUYER]);
    // MR entity types resolve against the `mr` resource, and USER-source
    // steps are permission-gated — the named approver must hold read+approve
    // on it or the step drops and submit 400s. Scoped to the buyer's OWN
    // hotel+department so it cannot widen the scope these suites assert on.
    await ensureApprovable(db, [BUYER], 'mr', HC, HOTEL, DEPT_PROC);
  });

  afterAll(async () => {
    const mrIds = (await db.any(`SELECT id FROM tbl_material_requisition WHERE hospitality_company_id=$1 AND hotel_id IN ($2,$3)`, [HC, HOTEL, HOTEL_B1])).map(r => r.id);
    if (mrIds.length) {
      const instIds = (await db.any(`SELECT id FROM tbl_approval_instances WHERE entity_type='MR' AND entity_id = ANY($1::int[])`, [mrIds])).map(r => r.id);
      if (instIds.length) {
        await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
        await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instIds]);
        await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
        await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instIds]);
      }
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [mrPolicyId]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id=$1`, [mrPolicyId]);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id IN ($1,$2)`, [contractId, contract2Id]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id IN ($1,$2)`, [contractId, contract2Id]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id IN ($1,$2)`, [contractId, contract2Id]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE hospitality_company_id=$1`, [HC]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN ($1,$2)`, [contractId, contract2Id]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id IN ($1,$2)`, [contractId, contract2Id]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_category_department WHERE category_id=$1 AND department_id=$2`, [CATEGORY, DEPT_PROC]);
  });

  const validItem = (over = {}) => ({
    product_variant_id: VARIANT_ID, quantity: 100, uom: "litre",
    arc_contract_id: contractId, arc_contract_line_id: contractLineId, matched_unit_rate: 90, ...over,
  });

  // Temporarily grant BUYER a role scope on another department so the request
  // gets PAST the (hotel × department) scope gate and reaches the CO2
  // contract-linkage validation underneath it. Without this the endpoint now
  // (correctly) refuses with 403 before any item is inspected, which would hide
  // the linkage guard the test is actually about.
  async function withDeptScope(departmentId, fn) {
    const row = await db.one(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, 2, $2, $3, $4) RETURNING id`,
      [BUYER, HC, HOTEL, departmentId]
    );
    try {
      return await fn();
    } finally {
      await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [row.id]);
    }
  }

  test("CO1 — derives hospitality_company_id from the hotel; ignores a spoofed body value", async () => {
    const res = await client.post("/api/v1/mr").send({
      title: "Scope derive",
      hospitality_company_id: IDS.hospitality.B, // spoof
      hotel_id: HOTEL, department_id: DEPT_PROC,
      items: [validItem()],
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.mr.hospitality_company_id)).toBe(HC);
  });

  test("CO1 — rejects creating an MR for a hotel the buyer can't access", async () => {
    const res = await client.post("/api/v1/mr").send({
      title: "Cross-hotel", hotel_id: HOTEL_B1, department_id: DEPT_PROC, items: [validItem()],
    });
    expect(res.status).toBe(403);
  });

  test("CO2 — rejects an item whose line belongs to a different contract", async () => {
    const res = await client.post("/api/v1/mr").send({
      title: "Wrong contract", hotel_id: HOTEL, department_id: DEPT_PROC,
      items: [validItem({ arc_contract_id: contract2Id })], // line is under contractId
    });
    expect(res.status).toBe(400);
  });

  test("CO2 — rejects an item whose product doesn't match the contract line", async () => {
    const res = await client.post("/api/v1/mr").send({
      title: "Wrong variant", hotel_id: HOTEL, department_id: DEPT_PROC,
      items: [validItem({ product_variant_id: OTHER_VARIANT_ID })],
    });
    expect(res.status).toBe(400);
  });

  test("CO2 — rejects an item whose contract is not in the MR's department", async () => {
    await withDeptScope(DEPT_ENG, async () => {
      const res = await client.post("/api/v1/mr").send({
        title: "Wrong dept", hotel_id: HOTEL, department_id: DEPT_ENG, items: [validItem()],
      });
      expect(res.status).toBe(400);
    });
  });

  test("CO1 — rejects an MR for a department the buyer has no role scope for", async () => {
    const res = await client.post("/api/v1/mr").send({
      title: "Unscoped dept", hotel_id: HOTEL, department_id: DEPT_ENG, items: [validItem()],
    });
    expect(res.status).toBe(403);
  });

  test("CO4 — submit is blocked when requested qty exceeds the line's remaining qty", async () => {
    const create = await client.post("/api/v1/mr").send({
      title: "Over-consume", hotel_id: HOTEL, department_id: DEPT_PROC,
      items: [validItem({ quantity: 5000 })], // committed 1000
    });
    expect(create.status).toBe(200);
    const sub = await client.post(`/api/v1/mr/${create.body.data.mr.id}/submit`).send({});
    expect(sub.status).toBe(400);
  });

  test("happy path — a valid contracted item creates + submits", async () => {
    const create = await client.post("/api/v1/mr").send({
      title: "Valid restock", hotel_id: HOTEL, department_id: DEPT_PROC,
      items: [validItem({ quantity: 100 })],
    });
    expect(create.status).toBe(200);
    expect(create.body.data.items.length).toBe(1);
    const sub = await client.post(`/api/v1/mr/${create.body.data.mr.id}/submit`).send({});
    expect(sub.status).toBe(200);
  });
});
