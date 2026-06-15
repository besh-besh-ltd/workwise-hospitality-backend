// MR — enriched listing + analytics endpoint.
//
// Proves the All-MRs listing gets per-row aggregates (hotel/dept names, value,
// item/vendor/category arrays, call-off count) and the dashboard analytics
// endpoint returns status/value totals, conversion, breakdowns by
// department/hotel/urgency/month, top requesters, and a recent feed.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HC     = IDS.hospitality.A;
const HOTEL  = IDS.hotels.A1;
const DEPT   = IDS.departments.proc;
const PROC   = IDS.processes.A_P1;
const BUYER  = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;
const MR_NUMS = ["MR-ANALYTICS-1", "MR-ANALYTICS-2", "MR-ANALYTICS-3"];

describe("MR — enriched listing + analytics", () => {
  let buyerClient, arcId, contractId, lineId, mr1;

  beforeAll(async () => {
    await db.none(`INSERT INTO tbl_category_department (category_id, department_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [CATEGORY, DEPT]);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    buyerClient = await httpClient(BUYER);

    const arc = await db.one(
      `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status, submission_start_at, submission_end_at,
          contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-MR-ANALYTICS', 'MR analytics ARC', $1,$2,$3,$4,$5,'contract_active',
               NOW()-INTERVAL '30 days', NOW()-INTERVAL '20 days', NOW()-INTERVAL '10 days', NOW()+INTERVAL '180 days', $6)
       RETURNING *`, [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    arcId = arc.id;
    const item = await db.one(`INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1,$2,1000,'litre') RETURNING *`, [arcId, VARIANT_ID]);
    const contract = await db.one(`INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'active') RETURNING *`, [arcId, VENDOR]);
    contractId = contract.id;
    lineId = (await db.one(`INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty) VALUES ($1,$2,90,5,1000) RETURNING *`, [contractId, item.id])).id;

    // Three MRs across statuses/urgencies with items (value = qty * 90).
    const mkMr = async (num, title, status, urgency, qty) => {
      const mr = await db.one(
        `INSERT INTO tbl_material_requisition (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW()-INTERVAL '2 days') RETURNING *`,
        [num, title, HC, HOTEL, DEPT, urgency, BUYER, status]);
      await db.none(
        `INSERT INTO tbl_material_requisition_item (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
         VALUES ($1,$2,$3,'litre',$4,$5,90)`, [mr.id, VARIANT_ID, qty, contractId, lineId]);
      return mr;
    };
    mr1 = await mkMr(MR_NUMS[0], "Restock A", "po_released", "normal", 200);  // value 18000
    await mkMr(MR_NUMS[1], "Restock B", "approved", "urgent", 100);           // value 9000
    await mkMr(MR_NUMS[2], "Restock C", "pending_approval", "normal", 50);    // value 4500
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE mr_number = ANY($1::varchar[])`, [MR_NUMS]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`, [CATEGORY, DEPT]);
  });

  test("list returns per-row enrichment (names, value, item/vendor/category arrays)", async () => {
    const res = await buyerClient.get(`/api/v1/mr?hotel_ids=${HOTEL}&limit=100`);
    expect(res.status).toBe(200);
    const row = res.body.data.data.find((r) => r.mr_number === MR_NUMS[0]);
    expect(row).toBeTruthy();
    expect(row.hotel_name).toBeTruthy();
    expect(row.department_name).toBeTruthy();
    expect(Number(row.total_est_value)).toBe(18000);
    expect(row.item_count).toBe(1);
    expect(Array.isArray(row.vendor_ids) && row.vendor_ids).toContain(VENDOR);
    expect(Array.isArray(row.category_titles) && row.category_titles.length).toBeGreaterThan(0);
    expect(Array.isArray(row.item_names) && row.item_names.length).toBe(1);
    expect(typeof row.call_off_count).not.toBe("undefined");
  });

  test("analytics returns totals, conversion, and breakdowns", async () => {
    const res = await buyerClient.get(`/api/v1/mr/analytics?hotel_ids=${HOTEL}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.totals.all).toBeGreaterThanOrEqual(3);
    expect(d.totals.po_released).toBeGreaterThanOrEqual(1);
    expect(Number(d.totals.total_value)).toBeGreaterThanOrEqual(31500);
    // conversion = po_released / (approved + po_released) → 1/2 of our seed = 50%
    expect(d.conversion_rate).not.toBeNull();
    expect(d.by_department.some((x) => x.department_name)).toBe(true);
    expect(d.by_hotel.some((x) => x.hotel_name)).toBe(true);
    const urg = d.by_urgency.map((x) => x.urgency);
    expect(urg).toContain("urgent");
    expect(urg).toContain("normal");
    expect(Array.isArray(d.by_month)).toBe(true);
    expect(d.top_requesters.length).toBeGreaterThanOrEqual(1);
    expect(d.recent.length).toBeGreaterThanOrEqual(3);
    expect(typeof d.overdue_count).toBe("number");
  });
});
