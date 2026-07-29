// Call-off PO document (audit CO10 — PDF).
//
//   - renderCallOffPoHtml produces a complete, escaped document (pure unit).
//   - loadCallOffPoContext shapes a released call-off PO into the renderer ctx.
//   - generateCallOffPoPdf is test-gated (never launches Chrome / hits S3 here).
//
// Puppeteer→S3 itself is environment-gated (NODE_ENV=test), so we verify the
// deterministic template + the data feeding it, not the binary render.

import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import {
  renderCallOffPoHtml,
  loadCallOffPoContext,
  generateCallOffPoPdf,
} from "../../../app/helper/arc_v2/callOffPoRenderer.js";

describe("Call-off PO document (CO10)", () => {
  test("renderCallOffPoHtml renders parties, line items, rates and total", () => {
    const html = renderCallOffPoHtml({
      po: { po_number: "CO-123-9", total_value: 18000, created_at: "2026-06-18" },
      buyer: { company_name: "Workwise Hotels", hotel_name: "Hotel A-1" },
      vendor: { name: "Alpha Vendor", email: "alpha@test.local" },
      arc: { arc_number: "ARC-2026-XYZ", mr_number: "MR-2026-1" },
      lines: [
        { product_name: "7 UP PEPSI 1.5 LTR", quantity: 200, unit: "litre", unit_price: 90, gst_pct: 5, total_price: 18000 },
      ],
    });
    expect(html).toContain("Call-off Purchase Order");
    expect(html).toContain("CO-123-9");
    expect(html).toContain("Alpha Vendor");
    expect(html).toContain("Workwise Hotels");
    expect(html).toContain("ARC-2026-XYZ");
    expect(html).toContain("7 UP PEPSI 1.5 LTR");
    expect(html).toContain("₹18,000.00");
  });

  test("renderCallOffPoHtml escapes HTML in untrusted fields", () => {
    const html = renderCallOffPoHtml({
      po: { po_number: "CO-1", total_value: 0, created_at: null },
      buyer: {}, vendor: { name: "<script>x</script>" }, arc: {},
      lines: [],
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  describe("with a released call-off PO", () => {
    const HC = IDS.hospitality.A, HOTEL = IDS.hotels.A1, DEPT = IDS.departments.proc;
    const PROC = IDS.processes.A_P1, BUYER = IDS.users.a1_proc_buyer, VENDOR = IDS.users.vendor_alpha;
    const CATEGORY = TEST_CATEGORIES.beverages, VARIANT_ID = 1;
    let arcId, contractId, contractLineId, poId;

    beforeAll(async () => {
      const arc = await db.one(
        `INSERT INTO tbl_arc
           (arc_number, title, category_id, hospitality_company_id, hotel_id,
            department_id, process_id, status,
            submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
         VALUES ('ARC-COPDF-1','PDF ctx ARC',$1,$2,$3,$4,$5,'contract_active',
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
      const { handleMrPostApproval } = await import("../../../app/controllers/mr/mrController.js");
      const mr = await db.one(
        `INSERT INTO tbl_material_requisition
           (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
         VALUES ('MR-COPDF-1','PDF ctx',$1,$2,$3,'normal',$4,'pending_approval',NOW()) RETURNING *`,
        [HC, HOTEL, DEPT, BUYER]);
      await db.none(
        `INSERT INTO tbl_material_requisition_item
           (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
         VALUES ($1,$2,200,'litre',$3,$4,90)`, [mr.id, VARIANT_ID, contractId, contractLineId]);
      await handleMrPostApproval(70040, BUYER, {
        instance: { id: 70040, entity_type: "MR", entity_id: mr.id, status: "APPROVED" },
      });
      poId = (await db.one(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mr.id])).po_id;
    });

    afterAll(async () => {
      await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id=$1`, [poId]);
      await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id=$1`, [contractId]);
      await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1`, [contractId]);
      await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id=$1`, [contractId]);
      await db.none(`DELETE FROM tbl_material_requisition WHERE hospitality_company_id=$1 AND title='PDF ctx'`, [HC]);
      await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id=$1`, [contractId]);
      await db.none(`DELETE FROM tbl_arc_contract WHERE id=$1`, [contractId]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
    });

    test("loadCallOffPoContext shapes the released PO into a renderable ctx", async () => {
      const ctx = await loadCallOffPoContext(poId);
      expect(ctx).toBeTruthy();
      expect(ctx.po.po_number).toMatch(/^CO-/);
      expect(ctx.arc.arc_number).toBe("ARC-COPDF-1");
      expect(ctx.arc.mr_number).toBe("MR-COPDF-1");
      expect(ctx.vendor.name).toBeTruthy();
      expect(ctx.lines.length).toBe(1);
      expect(Number(ctx.lines[0].quantity)).toBe(200);
      expect(Number(ctx.lines[0].unit_price)).toBe(90);
      expect(ctx.lines[0].product_name).toBeTruthy();
      // The loaded ctx renders to a complete document.
      const html = renderCallOffPoHtml(ctx);
      expect(html).toContain(ctx.po.po_number);
    });

    test("generateCallOffPoPdf is a no-op under the test harness (no Chrome/S3)", async () => {
      const result = await generateCallOffPoPdf(poId);
      expect(result).toBeNull();
      const po = await db.one(`SELECT po_pdf_url FROM tbl_rfq_purchase_order WHERE id=$1`, [poId]);
      expect(po.po_pdf_url).toBeNull(); // gated off in test env
    });
  });
});
