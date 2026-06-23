// Call-off POs are first-class (audit CO5, CO7, CO8).
//
//   CO7 — release writes tbl_purchase_order_product line rows (per MR item).
//   CO5 — the legacy GET /po/:po_id detail endpoint loads a call-off PO
//         (previously 404'd: INNER joins on NULL rfq_id / initiated_by).
//   CO8 — call-off POs appear in the buyer's PO list (GET /po/list), which
//         previously INNER-joined tbl_rfq and dropped them.
//   CO7-CHARGE — absolute (flat) charge on the contract line is added ONCE to
//         the line total, never multiplied by quantity (regression for the bug
//         where total was computed as engine(qty=1).total × qty).
//
// Product-level: real Express app + Postgres.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { calculateLineTotal } from "../../../app/services/pricingEngine.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

describe("Call-off POs are first-class (CO5 detail · CO7 line rows · CO8 list)", () => {
  let buyerClient, arcId, contractId, contractLineId, poId, handleMrPostApproval;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    buyerClient = await httpClient(BUYER);
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-COFC-1','Call-off first-class ARC',$1,$2,$3,$4,$5,'contract_active',
               NOW()-INTERVAL '30 days', NOW()-INTERVAL '20 days',
               NOW()-INTERVAL '10 days', NOW()+INTERVAL '180 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    arcId = arc.id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1,$2,1000,'litre') RETURNING *`, [arcId, VARIANT_ID]);
    const contract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'active') RETURNING *`,
      [arcId, VENDOR]);
    contractId = contract.id;
    const line = await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1,$2,90,5,1000) RETURNING *`, [contractId, item.id]);
    contractLineId = line.id;

    ({ handleMrPostApproval } = await import("../../../app/controllers/mr/mrController.js"));

    const mr = await db.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
       VALUES ('MR-COFC-1','First-class call-off',$1,$2,$3,'normal',$4,'pending_approval',NOW()) RETURNING *`,
      [HC, HOTEL, DEPT, BUYER]);
    await db.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1,$2,200,'litre',$3,$4,90)`, [mr.id, VARIANT_ID, contractId, contractLineId]);
    await handleMrPostApproval(70020, BUYER, {
      instance: { id: 70020, entity_type: "MR", entity_id: mr.id, status: "APPROVED" },
    });
    poId = (await db.one(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mr.id])).po_id;
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id=$1`, [poId]);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE hospitality_company_id=$1 AND title LIKE 'First-class%'`, [HC]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
  });

  test("CO7 — release writes a tbl_purchase_order_product line row per MR item", async () => {
    const lines = await db.any(
      `SELECT quantity, unit_price, product_variant_id, arc_contract_line_id
         FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [poId]);
    expect(lines.length).toBe(1);
    expect(Number(lines[0].quantity)).toBe(200);
    expect(Number(lines[0].unit_price)).toBe(90);
    expect(Number(lines[0].product_variant_id)).toBe(VARIANT_ID);
    expect(Number(lines[0].arc_contract_line_id)).toBe(Number(contractLineId));
  });

  test("CO5 — the legacy GET /po/:po_id endpoint loads a call-off PO (no 404)", async () => {
    const res = await buyerClient
      .get(`/api/v1/po/${poId}`)
      .set("x-hospitality-company", String(HC))
      .set("x-hotel-ids", String(HOTEL));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeTruthy();
    expect(Number(res.body.data.id)).toBe(Number(poId));
  });

  test("CO8 — the call-off PO appears in the buyer's PO list", async () => {
    const res = await buyerClient
      .get(`/api/v1/po/list?limit=200`)
      .set("x-hospitality-company", String(HC))
      .set("x-hotel-ids", String(HOTEL));
    expect(res.status).toBe(200);
    const rows = res.body?.data?.rows || res.body?.data?.items || res.body?.data || [];
    const ids = (Array.isArray(rows) ? rows : []).map((r) => Number(r.id));
    expect(ids).toContain(Number(poId));
  });
});

// ---------------------------------------------------------------------------
// CO7-CHARGE — absolute-charge regression suite
//
// Seeds an ARC contract line WITH a flat freight charge (amount_mode='absolute',
// amount=500). MR qty=200. The fixed service runs the pricing engine at the REAL
// quantity so the absolute charge is added ONCE.  The old buggy path computed
// engine(qty=1).total × 200, which multiplied the flat charge by qty.
//
// Expected (correct) total:
//   base        = 90 × 200 = 18000
//   base_tax    = 18000 × 5% = 900
//   freight     = 500  (absolute — added once regardless of qty)
//   freight_tax = 500 × 5% = 25  (inherits base GST)
//   total       = 18000 + 900 + 500 + 25 = 19425
//
// Old buggy total:
//   engine(qty=1).total = 90 + 4.5 + 500 + 25 = 619.5
//   buggy line total    = 619.5 × 200 = 123900
// ---------------------------------------------------------------------------
describe("CO7-CHARGE — absolute charge on contract line is never multiplied by qty", () => {
  const BASE_RATE   = 90;
  const GST_PCT     = 5;
  const FREIGHT_AMT = 500;   // flat absolute charge
  const QTY         = 200;

  let chargeArcId, chargeContractId, chargeContractLineId, chargePoId;
  let handleMrPostApproval2;

  beforeAll(async () => {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-CHRGTEST-1','Charge regression ARC',$1,$2,$3,$4,$5,'contract_active',
               NOW()-INTERVAL '30 days', NOW()-INTERVAL '20 days',
               NOW()-INTERVAL '10 days', NOW()+INTERVAL '180 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    chargeArcId = arc.id;

    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1,$2,1000,'litre') RETURNING *`, [chargeArcId, VARIANT_ID]);

    const contract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'active') RETURNING *`,
      [chargeArcId, VENDOR]);
    chargeContractId = contract.id;

    // Seed the contract line WITH a flat absolute freight charge
    const charges = JSON.stringify([
      { name: 'Freight', amount: FREIGHT_AMT, amount_mode: 'absolute', tax: null },
    ]);
    const line = await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty, charges)
       VALUES ($1,$2,$3,$4,1000,$5::jsonb) RETURNING *`,
      [chargeContractId, item.id, BASE_RATE, GST_PCT, charges]);
    chargeContractLineId = line.id;

    ({ handleMrPostApproval: handleMrPostApproval2 } =
      await import("../../../app/controllers/mr/mrController.js"));

    const mr = await db.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
       VALUES ('MR-CHRG-1','Charge regression MR',$1,$2,$3,'normal',$4,'pending_approval',NOW()) RETURNING *`,
      [HC, HOTEL, DEPT, BUYER]);

    await db.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1,$2,$3,'litre',$4,$5,$6)`,
      [mr.id, VARIANT_ID, QTY, chargeContractId, chargeContractLineId, BASE_RATE]);

    await handleMrPostApproval2(70099, BUYER, {
      instance: { id: 70099, entity_type: "MR", entity_id: mr.id, status: "APPROVED" },
    });

    chargePoId = (await db.one(
      `SELECT po_id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mr.id]
    )).po_id;
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id=$1`, [chargePoId]);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id=$1`, [chargeContractId]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1`, [chargeContractId]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id=$1`, [chargeContractId]);
    await db.none(
      `DELETE FROM tbl_material_requisition WHERE hospitality_company_id=$1 AND title LIKE 'Charge regression%'`,
      [HC]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id=$1`, [chargeContractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id=$1`, [chargeContractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [chargeArcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [chargeArcId]);
  });

  test("CO7-CHARGE — flat absolute freight is added once; total_price equals engine-at-real-qty, not allIn×qty", async () => {
    const lines = await db.any(
      `SELECT quantity, unit_price, total_price
         FROM tbl_purchase_order_product WHERE purchase_order_id = $1`,
      [chargePoId]);

    expect(lines.length).toBe(1);
    const row = lines[0];

    // unit_price must be the BASE rate, not the all-in per-unit price
    expect(Number(row.unit_price)).toBe(BASE_RATE);

    // Correct total: engine at qty=200, absolute charge added once
    const engineOut = calculateLineTotal({
      unit_price:    BASE_RATE,
      quantity:      QTY,
      tax:           GST_PCT,
      tax_mode:      'percentage',
      other_charges: [{ name: 'Freight', amount: FREIGHT_AMT, amount_mode: 'absolute', tax: null }],
    });
    // engine: base=18000, base_tax=900, freight=500, freight_tax=25 → 19425
    expect(Number(row.total_price)).toBe(engineOut.total);

    // Buggy value: engine(qty=1).total × qty — freight would be scaled by qty
    const allInAtOne = calculateLineTotal({
      unit_price:    BASE_RATE,
      quantity:      1,
      tax:           GST_PCT,
      tax_mode:      'percentage',
      other_charges: [{ name: 'Freight', amount: FREIGHT_AMT, amount_mode: 'absolute', tax: null }],
    });
    const buggyTotal = Math.round(allInAtOne.total * QTY * 100) / 100;
    // Confirm the two values are indeed different (sanity-check the test itself)
    expect(buggyTotal).not.toBe(engineOut.total);
    // And confirm we are NOT storing the buggy value
    expect(Number(row.total_price)).not.toBe(buggyTotal);
  });
});
