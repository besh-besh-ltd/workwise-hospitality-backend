// Vendor Purchase Order module — Task 1: vendor-scoped dashboard endpoint.
//
//   GET /api/v1/po/vendor/dashboard  (passportSignIn + acl([3]) — vendor only)
//
// The vendor dashboard must surface ONLY POs whose finalized_vendor_id is the
// caller, across BOTH PO flavours: call-off POs (released from an ARC contract
// via an approved MR) AND regular RFQ POs. KPIs/attention/earnings are scoped
// to the vendor; another vendor must never see these rows.
//
// Product-level: real Express app + Postgres via supertest. Run serial:
//   npm test -- po.vendor.module --runInBand

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const OTHER_VENDOR = IDS.users.vendor_beta;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

describe("Vendor PO module (dashboard · list · detail)", () => {
  let alphaClient, betaClient, handleMrPostApproval;
  let arcId, contractId, contractLineId;
  let calloffPoId, calloffMrId, rfqId, rfqPoId, oldCompletedPoId;
  let vendorCompanyId;
  const OLD_COMPLETED_VALUE = 7777;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [OTHER_VENDOR]);

    alphaClient = await httpClient(VENDOR);
    betaClient = await httpClient(OTHER_VENDOR);

    vendorCompanyId = (await db.one(`SELECT company_id FROM tbl_users WHERE id = $1`, [VENDOR])).company_id;

    // --- ARC + active contract + line (vendor_alpha) -----------------------
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-VPO-1','Vendor PO dashboard ARC',$1,$2,$3,$4,$5,'contract_active',
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

    // Release ONE call-off PO for vendor_alpha → born 'acceptance_pending'.
    ({ handleMrPostApproval } = await import("../../app/controllers/mr/mrController.js"));
    const mr = await db.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
       VALUES ('MR-VPO-1','VPO call-off',$1,$2,$3,'normal',$4,'pending_approval',NOW()) RETURNING *`,
      [HC, HOTEL, DEPT, BUYER]);
    calloffMrId = mr.id;
    await db.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1,$2,100,'litre',$3,$4,90)`, [mr.id, VARIANT_ID, contractId, contractLineId]);
    await handleMrPostApproval(79030, BUYER, {
      instance: { id: 79030, entity_type: "MR", entity_id: mr.id, status: "APPROVED" },
    });
    calloffPoId = (await db.one(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mr.id])).po_id;

    // --- ONE regular RFQ-type PO for vendor_alpha --------------------------
    // tbl_rfq_purchase_order CHECK requires rfq_id NOT NULL for non-call-off.
    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, created_by, updated_by, status,
          hospitality_company_id, hotel_id, department_id, process_id, title)
       VALUES ('VPO rfq','Hotel A1','buyer@test.local','A1 Buyer','9999999999',
               $1,'A1',$2,$2,1,$3,$4,$5,$6,'VPO RFQ') RETURNING id`,
      [String(Date.now() + 86400000), BUYER, HC, HOTEL, DEPT, PROC]);
    rfqId = rfq.id;
    const rfqPo = await db.one(
      `INSERT INTO tbl_rfq_purchase_order
         (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
          finalized_vendor_id, total_value, quote_id, is_call_off)
       VALUES ($1,$2,'PO-VPO-RFQ-1','acceptance_pending','{1}',10,50,$3,500,'{}',false)
       RETURNING id`,
      [rfqId, vendorCompanyId, VENDOR]);
    rfqPoId = rfqPo.id;

    // An OLD completed PO (60 days ago) for vendor_alpha. It is "earned" but
    // not earned THIS month, so it must NOT inflate earnings_mtd.
    const oldPo = await db.one(
      `INSERT INTO tbl_rfq_purchase_order
         (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
          finalized_vendor_id, total_value, quote_id, is_call_off, created_at)
       VALUES ($1,$2,'PO-VPO-RFQ-OLD','completed','{1}',10,50,$3,$4,'{}',false, NOW()-INTERVAL '60 days')
       RETURNING id`,
      [rfqId, vendorCompanyId, VENDOR, OLD_COMPLETED_VALUE]);
    oldCompletedPoId = oldPo.id;
  });

  afterAll(async () => {
    if (oldCompletedPoId) await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id=$1`, [oldCompletedPoId]);
    if (rfqPoId) await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id=$1`, [rfqPoId]);
    if (rfqId) await db.none(`DELETE FROM tbl_rfq WHERE id=$1`, [rfqId]);
    await db.none(`DELETE FROM tbl_notifications WHERE category IN ('CALL_OFF','mr')`);
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1)`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE id=$1`, [calloffMrId]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
  });

  test("vendor dashboard returns KPIs scoped to this vendor (call-off + RFQ)", async () => {
    const res = await alphaClient.get("/api/v1/po/vendor/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const data = res.body.data;
    // Both seeded POs are acceptance_pending → awaiting bucket.
    expect(data.kpis.awaiting_action.count).toBeGreaterThanOrEqual(2);
    expect(data.attention.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(data.earnings.by_stage)).toBe(true);
  });

  test("another vendor's POs never appear", async () => {
    const res = await betaClient.get("/api/v1/po/vendor/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.data.kpis.awaiting_action.count).toBe(0);
  });

  test("earnings_mtd excludes a completed PO from a prior month", async () => {
    const res = await alphaClient.get("/api/v1/po/vendor/dashboard");
    expect(res.status).toBe(200);
    const mtd = res.body.data.kpis.earnings_mtd;
    // The 60-days-old completed PO is "earned" but not earned THIS month, so it
    // must not inflate the month-to-date KPI.
    expect(mtd.value).toBeLessThan(OLD_COMPLETED_VALUE);
    expect(mtd).toHaveProperty("delta_pct");
  });

  // ===========================================================================
  // Task 2 — faceted vendor orders list-view (POST /po/vendor/list-view)
  // ===========================================================================
  test("vendor list-view returns tab counts + filtered rows, both PO types", async () => {
    const res = await alphaClient.post("/api/v1/po/vendor/list-view").send({ tab: "all", page: 1, limit: 20 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const data = res.body.data;
    // Both seeded acceptance_pending POs (call-off + RFQ) are visible.
    expect(data.total).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(data.rows)).toBe(true);
    expect(data.tab_counts.awaiting).toBeGreaterThanOrEqual(2);
    // Pagination + facets shape.
    expect(data.page).toBe(1);
    expect(data.limit).toBe(20);
    expect(data.facets.type.map((t) => t.key).sort()).toEqual(["call_off", "rfq"]);
    // Both PO flavours present among the rows.
    const callOffFlags = data.rows.map((r) => r.is_call_off);
    expect(callOffFlags).toContain(true);
    expect(callOffFlags).toContain(false);
  });

  test("type filter returns only call-offs", async () => {
    const res = await alphaClient
      .post("/api/v1/po/vendor/list-view")
      .send({ tab: "all", filters: { type: "call_off" }, page: 1, limit: 20 });
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.rows.length).toBeGreaterThanOrEqual(1);
    expect(data.rows.every((r) => r.is_call_off === true)).toBe(true);
  });

  test("list-view never leaks another vendor's PO", async () => {
    const res = await betaClient.post("/api/v1/po/vendor/list-view").send({ tab: "all", page: 1, limit: 20 });
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.rows.some((r) => r.finalized_vendor_id !== OTHER_VENDOR)).toBe(false);
  });

  // ===========================================================================
  // Task 3 — vendor PO detail (GET /po/vendor/detail/:po_id)
  // ===========================================================================
  test("vendor detail loads own call-off + RFQ POs, 404s another vendor's", async () => {
    // Own call-off PO → full call-off-aware detail.
    const co = await alphaClient.get(`/api/v1/po/vendor/detail/${calloffPoId}`);
    expect(co.status).toBe(200);
    expect(co.body.status).toBe(1);
    expect(co.body.data.is_call_off).toBe(true);
    expect(Array.isArray(co.body.data.items)).toBe(true);

    // Own regular RFQ PO → full detail.
    const rfq = await alphaClient.get(`/api/v1/po/vendor/detail/${rfqPoId}`);
    expect(rfq.status).toBe(200);
    expect(rfq.body.status).toBe(1);

    // Another vendor must never read vendor_alpha's PO → 404 (not 403, no leak).
    const leak = await betaClient.get(`/api/v1/po/vendor/detail/${calloffPoId}`);
    expect(leak.status).toBe(404);
  });

  test("vendor detail never exposes competitors' quote comparison", async () => {
    // buildComparison returns EVERY competing vendor's quote amounts; on the
    // vendor path it must be gated to [] so a vendor cannot see rivals' prices.
    const res = await alphaClient.get(`/api/v1/po/vendor/detail/${rfqPoId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.comparison).toEqual([]);
  });

  test("an accepted PO's audit trail marks 'Vendor accepted the PO' as done", async () => {
    // Move the call-off PO to accepted (approved). The timeline must then show
    // Sent + Vendor-accepted as done — not stuck AWAITING.
    await db.none(
      `UPDATE tbl_rfq_purchase_order SET status='approved', vendor_action_at=NOW() WHERE id=$1`,
      [calloffPoId]
    );
    const res = await alphaClient.get(`/api/v1/po/vendor/detail/${calloffPoId}`);
    expect(res.status).toBe(200);
    const wf = res.body.data.workflow || [];
    const accepted = wf.find((w) => /vendor accepted/i.test(w.title || ""));
    expect(accepted).toBeTruthy();
    expect(accepted.status).toBe("done");
    const sent = wf.find((w) => /sent to vendor/i.test(w.title || ""));
    expect(sent && sent.status).toBe("done");
  });

  test("vendor PO PDF endpoint: own PO resolves its url; cross-vendor 404s", async () => {
    // Seed a doc url so we don't depend on Puppeteer/S3 (gated off in test env).
    await db.none(`UPDATE tbl_rfq_purchase_order SET po_pdf_url='https://s3.test/co.pdf' WHERE id=$1`, [calloffPoId]);
    const ok = await alphaClient.get(`/api/v1/po/vendor/detail/${calloffPoId}/pdf`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.url).toBe("https://s3.test/co.pdf");

    const denied = await betaClient.get(`/api/v1/po/vendor/detail/${calloffPoId}/pdf`);
    expect(denied.status).toBe(404);
  });

  test("a 'sent' PO is awaiting acceptance: surfaces next_step 'Accept' and can be accepted", async () => {
    // 'sent' is the legacy synonym for acceptance_pending — the vendor must be
    // able to accept it (it should NOT read as already-accepted).
    await db.none(`UPDATE tbl_rfq_purchase_order SET status='sent', vendor_action_at=NULL WHERE id=$1`, [rfqPoId]);

    // It shows up in the vendor's attention queue with next_step = Accept.
    const dash = await alphaClient.get("/api/v1/po/vendor/dashboard");
    const row = (dash.body.data.attention || []).find((a) => Number(a.id) === Number(rfqPoId));
    expect(row).toBeTruthy();
    expect(row.next_step).toBe("Accept");

    // And the vendor can accept it (acceptPO allows the 'sent' gate) → approved.
    const acc = await alphaClient.post(`/api/v1/po/accept/${rfqPoId}`).send({});
    expect(acc.status).toBe(200);
    const after = await db.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id=$1`, [rfqPoId]);
    expect(after.status).toBe("approved");
  });
});
