// arcPricingResolver — unit-ish test against real Postgres (seeds rows
// directly, doesn't go through HTTP).
//
// Phase A: the resolver just returns original contract_line values. The
// Phase C amendment-overlay code path will land here later; this test pins
// the contract so future amendment logic doesn't accidentally break the
// no-amendment path.

import { resolveCurrentPrice } from "../../../app/services/arcPricingResolver.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

describe("arcPricingResolver", () => {
  const HC     = IDS.hospitality.A;
  const HOTEL  = IDS.hotels.A1;
  const DEPT   = IDS.departments.proc;
  const PROC   = IDS.processes.A_P1;
  const BUYER  = IDS.users.a1_proc_buyer;
  const VENDOR = IDS.users.vendor_alpha;
  const CATEGORY = TEST_CATEGORIES.beverages;
  const VARIANT_ID = 1;
  let contractLineId, contractId, arcId;

  beforeAll(async () => {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by)
       VALUES ('ARC-TEST-PRICING-1', 'Pricing test', $1, $2, $3, $4, $5,
               'contract_active',
               NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
               NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days',
               $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 500, 'litre') RETURNING *`, [arcId, VARIANT_ID]
    );
    const contract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status)
       VALUES ($1, $2, 'active') RETURNING *`, [arcId, VENDOR]
    );
    contractId = contract.id;
    const line = await db.one(
      `INSERT INTO tbl_arc_contract_line
         (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty, charges, payment_terms)
       VALUES ($1, $2, 88.5, 5, 500, '[{"label":"Freight","value":2}]'::jsonb, 'Net 30')
       RETURNING *`,
      [contractId, item.id]
    );
    contractLineId = line.id;
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  });

  test("returns the original contract-line values when no amendment exists", async () => {
    const result = await resolveCurrentPrice(contractLineId);
    expect(Number(result.unit_rate)).toBe(88.5);
    expect(Number(result.gst_pct)).toBe(5);
    expect(result.payment_terms).toBe("Net 30");
    expect(result.applied_amendment_id).toBeNull();
    expect(Array.isArray(result.charges)).toBe(true);
    expect(result.charges[0]).toMatchObject({ label: "Freight" });
  });

  test("accepts an asOfDate argument without behaviour change in Phase A", async () => {
    const future = new Date(Date.now() + 30 * 86400_000);
    const past   = new Date(Date.now() - 30 * 86400_000);
    const r1 = await resolveCurrentPrice(contractLineId, future);
    const r2 = await resolveCurrentPrice(contractLineId, past);
    expect(Number(r1.unit_rate)).toBe(88.5);
    expect(Number(r2.unit_rate)).toBe(88.5);
    expect(r1.applied_amendment_id).toBeNull();
    expect(r2.applied_amendment_id).toBeNull();
  });

  test("throws on unknown contract line id", async () => {
    await expect(resolveCurrentPrice(999_999_999)).rejects.toThrow(/contract line/);
  });

  test("requires arcContractLineId", async () => {
    await expect(resolveCurrentPrice(null)).rejects.toThrow(/required/);
  });

  test("exposes the full contract_line for caller introspection", async () => {
    const result = await resolveCurrentPrice(contractLineId);
    expect(result.contract_line).toBeTruthy();
    expect(result.contract_line.id).toBe(contractLineId);
    expect(result.contract_line.arc_id).toBe(arcId);
    expect(result.contract_line.vendor_id).toBe(VENDOR);
  });
});
