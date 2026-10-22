// Vendor Orders: the RFQ or contract behind every PO (client ticket T2).
//
// A vendor used to see only PO numbers. Every vendor PO surface now carries the
// RFQ number + title (or the ARC number + title + MR number for a call-off):
// list rows, the attention queue, the Excel export, the reminder / release
// emails and the detail payload, and the list search matches them.
//
// Product-level: real Express app + Postgres via supertest. The only mock is
// the mail transport (sendMail), so subjects can be read and nothing is sent.

import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import excelJS from "exceljs";

const sentMails = [];
const actualCommon = await import("../../app/helper/common.js");
jest.unstable_mockModule("../../app/helper/common.js", () => ({
  ...actualCommon,
  sendMail: (opts) => {
    sentMails.push(opts);
    return Promise.resolve({ messageId: "<captured>" });
  },
}));

const { httpClient } = await import("../helpers/http.js");
const { db } = await import("../setup/db.js");
const { IDS } = await import("../fixtures/ids.js");
const { TEST_CATEGORIES } = await import("../fixtures/vendors.js");
const { buildVendorPoReference } = await import("../../app/helper/poReference.js");

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const OTHER_VENDOR = IDS.users.vendor_beta;
const CATEGORY = TEST_CATEGORIES.beverages;

const ARC_NUMBER = "ARC-2026-27-0918";
const ARC_TITLE = "Linen Rate Contract";
const MR_NUMBER = "2026-0077";
const MR_TITLE = "SECRET-MR-TITLE-ZZ";

const binary = (req) =>
  req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "binary")));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

describe("Vendor PO reference (RFQ / contract) on every vendor surface", () => {
  let alpha, beta;
  let arcId, contractId, calloffPoId, mrId, rfqId, rfqPoId, betaPoId, rfqNo, vendorCompanyId;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`, [[VENDOR, OTHER_VENDOR]]);
    alpha = await httpClient(VENDOR);
    beta = await httpClient(OTHER_VENDOR);
    vendorCompanyId = (await db.one(`SELECT company_id FROM tbl_users WHERE id = $1`, [VENDOR])).company_id;

    // RFQ with a messy title (padding + repeated spaces).
    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, created_by, updated_by, status,
          hospitality_company_id, hotel_id, department_id, process_id, title)
       VALUES ('ref rfq','Hotel A1','buyer@test.local','A1 Buyer','9999999999',
               $1,'A1',$2,$2,1,$3,$4,$5,$6,'   Pool   Towels  Refresh  ') RETURNING id, rfq_no`,
      [String(Date.now() + 86400000), BUYER, HC, HOTEL, DEPT, PROC]);
    rfqId = rfq.id;
    rfqNo = rfq.rfq_no;
    const mkPo = async (num, vendor) =>
      (await db.one(
        `INSERT INTO tbl_rfq_purchase_order
           (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
            finalized_vendor_id, total_value, quote_id, is_call_off)
         VALUES ($1,$2,$3,'acceptance_pending','{1}',10,50,$4,500,'{}',false) RETURNING id`,
        [rfqId, vendorCompanyId, num, vendor])).id;
    rfqPoId = await mkPo("PO-REF-A-1", VENDOR);
    betaPoId = await mkPo("PO-REF-B-1", OTHER_VENDOR);

    // ARC + contract + MR + released call-off PO for vendor alpha.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ($7,$8,$1,$2,$3,$4,$5,'contract_active',
               NOW()-INTERVAL '30 days', NOW()-INTERVAL '20 days',
               NOW()-INTERVAL '10 days', NOW()+INTERVAL '180 days', $6) RETURNING id`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER, ARC_NUMBER, ARC_TITLE]);
    arcId = arc.id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1,1,1000,'litre') RETURNING id`, [arcId]);
    const contract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'active') RETURNING id`, [arcId, VENDOR]);
    contractId = contract.id;
    const line = await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1,$2,90,5,1000) RETURNING id`, [contractId, item.id]);
    const mr = await db.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
       VALUES ($5,$6,$1,$2,$3,'normal',$4,'pending_approval',NOW()) RETURNING id`,
      [HC, HOTEL, DEPT, BUYER, MR_NUMBER, MR_TITLE]);
    mrId = mr.id;
    await db.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1,1,100,'litre',$2,$3,90)`, [mrId, contractId, line.id]);
    const { handleMrPostApproval } = await import("../../app/controllers/mr/mrController.js");
    await handleMrPostApproval(79131, BUYER, {
      instance: { id: 79131, entity_type: "MR", entity_id: mrId, status: "APPROVED" },
    });
    calloffPoId = (await db.one(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mrId])).po_id;
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [[rfqPoId, betaPoId].filter(Boolean)]);
    if (rfqId) await db.none(`DELETE FROM tbl_rfq WHERE id=$1`, [rfqId]);
    await db.none(`DELETE FROM tbl_notifications WHERE category IN ('CALL_OFF','mr')`);
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1)`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE id=$1`, [mrId]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
  });

  const list = async (client, search) => {
    const res = await client.post("/api/v1/po/vendor/list-view").send({ tab: "all", search, page: 1, limit: 50 });
    expect(res.status).toBe(200);
    return res.body.data.rows;
  };
  const ids = (rows) => rows.map((r) => Number(r.id));

  it("returns rfq_no and rfq_title on RFQ PO rows", async () => {
    const row = (await list(alpha)).find((r) => Number(r.id) === rfqPoId);
    expect(row).toBeTruthy();
    expect(Number(row.rfq_no)).toBe(Number(rfqNo));
    expect(row.rfq_title).toBe("Pool Towels Refresh");
    expect(row.arc_number).toBeNull();
    expect(row.mr_number).toBeNull();
  });

  it("returns ARC and MR numbers on call-off rows and never the MR title", async () => {
    const rows = await list(alpha);
    const row = rows.find((r) => Number(r.id) === calloffPoId);
    expect(row).toBeTruthy();
    expect(row.arc_number).toBe(ARC_NUMBER);
    expect(row.arc_title).toBe(ARC_TITLE);
    expect(row.mr_number).toBe(MR_NUMBER);
    expect(row.rfq_no).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(MR_TITLE);

    const detail = await alpha.get(`/api/v1/po/vendor/detail/${calloffPoId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.arc_number).toBe(ARC_NUMBER);
    expect(detail.body.data.arc_title).toBe(ARC_TITLE);
    expect(detail.body.data.mr_number).toBe(MR_NUMBER);
    expect(JSON.stringify(detail.body)).not.toContain(MR_TITLE);

    const rfqDetail = await alpha.get(`/api/v1/po/vendor/detail/${rfqPoId}`);
    expect(Number(rfqDetail.body.data.rfq_no)).toBe(Number(rfqNo));
    expect(rfqDetail.body.data.rfq_title).toBe("Pool Towels Refresh");

    const dash = await alpha.get("/api/v1/po/vendor/dashboard");
    expect(JSON.stringify(dash.body)).not.toContain(MR_TITLE);
  });

  it("finds a PO by RFQ number, by #RFQ number, by a title fragment, by ARC number and by MR number", async () => {
    expect(ids(await list(alpha, String(rfqNo)))).toContain(rfqPoId);
    expect(ids(await list(alpha, `#${rfqNo}`))).toContain(rfqPoId);
    expect(ids(await list(alpha, "towels refresh"))).toContain(rfqPoId);
    expect(ids(await list(alpha, "Pool Towels"))).toContain(rfqPoId);
    expect(ids(await list(alpha, ARC_NUMBER))).toContain(calloffPoId);
    expect(ids(await list(alpha, "Linen Rate"))).toContain(calloffPoId);
    expect(ids(await list(alpha, MR_NUMBER))).toContain(calloffPoId);
    // Still finds by PO number, and the MR title is not searchable.
    expect(ids(await list(alpha, "PO-REF-A-1"))).toContain(rfqPoId);
    expect(await list(alpha, MR_TITLE)).toEqual([]);
    // LIKE wildcards are literal, not patterns.
    expect(await list(alpha, "%")).toEqual([]);
    expect(await list(alpha, "_")).toEqual([]);
  });

  it("vendor B cannot find vendor A's PO by A's RFQ number", async () => {
    for (const term of [String(rfqNo), `#${rfqNo}`, "Pool Towels", ARC_NUMBER, MR_NUMBER]) {
      const rows = await list(beta, term);
      expect(ids(rows)).not.toContain(rfqPoId);
      expect(ids(rows)).not.toContain(calloffPoId);
      expect(rows.every((r) => Number(r.finalized_vendor_id) === OTHER_VENDOR)).toBe(true);
    }
    // B sees its own PO on the same RFQ (same RFQ number, different vendor).
    expect(ids(await list(beta, String(rfqNo)))).toEqual([betaPoId]);
    // A search term cannot break out of the vendor scope.
    const inj = await list(beta, "x' OR '1'='1");
    expect(inj).toEqual([]);
  });

  it("export and attention list carry the reference", async () => {
    const dash = await alpha.get("/api/v1/po/vendor/dashboard");
    const att = dash.body.data.attention;
    const rfqRow = att.find((a) => Number(a.id) === rfqPoId);
    expect(Number(rfqRow.rfq_no)).toBe(Number(rfqNo));
    expect(rfqRow.rfq_title).toBe("Pool Towels Refresh");
    const coRow = att.find((a) => Number(a.id) === calloffPoId);
    expect(coRow.arc_number).toBe(ARC_NUMBER);
    expect(coRow.arc_title).toBe(ARC_TITLE);
    expect(coRow.mr_number).toBe(MR_NUMBER);

    const res = await binary(alpha.post("/api/v1/po/vendor/export").send({ tab: "all", search: String(rfqNo) }));
    expect(res.status).toBe(200);
    const wb = new excelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet("My orders");
    const head = ws.getRow(1).values.slice(1).map(String);
    const col = head.indexOf("RFQ / Contract") + 1;
    expect(col).toBeGreaterThan(0);
    const row = ws.getRows(2, ws.rowCount).find((r) => r.getCell(1).value === "PO-REF-A-1");
    expect(row.getCell(col).value).toBe(`RFQ #${rfqNo} · Pool Towels Refresh`);

    const all = await binary(alpha.post("/api/v1/po/vendor/export").send({ tab: "all", search: ARC_NUMBER }));
    const wb2 = new excelJS.Workbook();
    await wb2.xlsx.load(all.body);
    const ws2 = wb2.getWorksheet("My orders");
    const coCell = ws2.getRows(2, ws2.rowCount)[0].getCell(col).value;
    expect(coCell).toBe(`${ARC_NUMBER} · ${ARC_TITLE} · MR ${MR_NUMBER}`);
    expect(JSON.stringify(ws2.getSheetValues())).not.toContain(MR_TITLE);
  });

  it("builds the email reference for both PO kinds", async () => {
    // Pure builder: R4 - never double the ARC prefix, no dangling separators.
    expect(buildVendorPoReference({ rfq_no: 536894, rfq_title: "  Pool  Towels " })).toBe("RFQ #536894 · Pool Towels");
    expect(buildVendorPoReference({ rfq_no: 536894, rfq_title: "" })).toBe("RFQ #536894");
    expect(buildVendorPoReference({ rfq_no: 536894, title: "A &amp; B" })).toBe("RFQ #536894 · A & B");
    expect(
      buildVendorPoReference({ is_call_off: true, arc_number: "ARC-2026-27-0018", arc_title: "Linen", mr_number: "MR-5" })
    ).toBe("ARC-2026-27-0018 · Linen · MR-5");
    expect(
      buildVendorPoReference({ is_call_off: true, arc_number: "2026-0018", arc_title: "Linen", mr_number: "5" })
    ).toBe("ARC 2026-0018 · Linen · MR 5");
    expect(buildVendorPoReference({ is_call_off: true, arc_number: "arc-9", mr_number: "5" })).toBe("arc-9 · MR 5");
    expect(buildVendorPoReference({ is_call_off: true, arc_title: "Linen" })).toBe("Linen");
    expect(buildVendorPoReference({ is_call_off: true, arc_number: "ARC-1", mr_number: "MR-0005" })).toBe("ARC-1 · MR-0005");
    expect(buildVendorPoReference({})).toBe("");

    // Reminder subjects (cron data path -> email builder).
    const { findPosNeedingVendorReminder } = await import("../../app/helper/cronManager.js");
    const { sendPOAcceptanceReminderToVendor } = await import("../../app/controllers/po/purchaseOrderEmails.js");
    await db.none(
      `UPDATE tbl_rfq_purchase_order SET updated_at = NOW() - INTERVAL '2 days', vendor_reminder_count = 0 WHERE id = ANY($1::int[])`,
      [[rfqPoId, calloffPoId]]
    );
    const due = await findPosNeedingVendorReminder(new Date());
    for (const id of [rfqPoId, calloffPoId]) {
      const po = due.find((p) => Number(p.id) === id);
      expect(po).toBeTruthy();
      await sendPOAcceptanceReminderToVendor(
        po,
        { rfq_no: po.rfq_no, title: po.rfq_title, arc_number: po.arc_number, arc_title: po.arc_title, mr_number: po.mr_number, is_call_off: po.is_call_off },
        1
      );
    }
    const subj = sentMails.map((m) => m.subject);
    expect(subj).toContain(`Gentle Reminder: PO #PO-REF-A-1 (RFQ #${rfqNo} · Pool Towels Refresh) awaiting your response`);
    expect(subj.some((s) => s.includes(`(${ARC_NUMBER} · ${ARC_TITLE} · MR ${MR_NUMBER}) awaiting your response`))).toBe(true);

    // Call-off release email (fired when handleMrPostApproval released the PO).
    const released = subj.find((s) => /^New released purchase order .* acceptance required$/.test(s));
    expect(released).toBeTruthy();
    expect(released).toContain(`(${ARC_NUMBER} · ${ARC_TITLE} · MR ${MR_NUMBER})`);
    for (const s of subj) expect(s).not.toMatch(/&amp;|&lt;|<[a-z]/i);
    expect(JSON.stringify(sentMails.map((m) => m.subject))).not.toContain(MR_TITLE);
  });
});
