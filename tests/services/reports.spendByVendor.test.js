// Reports module — catalogue entitlement, tenant scope, and report 1.4.
// ----------------------------------------------------------------------------
// Product-level: real Express app + Postgres over HTTP. The download assertions
// PARSE THE RETURNED WORKBOOK rather than trusting a 200 — the deliverable is a
// file, so the file is what gets asserted, down to the number formats and the
// formula in the total row.
//
// Two things here are regression tests for defects that would be invisible in a
// 200-only check:
//
//   • SPEND RECONCILIATION. The vendor rows must sum to the ledger for the same
//     window. This catches both halves of the definition — the status filter
//     (a draft or rejected PO is not spend) and the category join.
//   • THE CATEGORY DOUBLE-COUNT. tbl_product_categories maps a product to BOTH
//     its parent and its leaf. Joining through it naively doubles every rupee:
//     on staging, true spend Rs 7,36,29,816 reported as Rs 15,09,11,261. The
//     test seeds a product mapped to both levels and asserts the total is the
//     ledger, not twice it.
//
// Tenant strategy mirrors po.export.test.js: no hospitality headers are sent,
// so a1_proc_buyer is in scope for company-A rows and companyB_admin never is.

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import excelJS from "exceljs";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";

let VARIANT_ID = 1;
let PRODUCT_ID = null;
let REPORTS_ROLE_ID = null;      // reports.spend_by_vendor only
let BLOCKED_ROLE_ID = null;      // reports.budget_vs_actual only (not_configured)

beforeAll(async () => {
  const v = await db.oneOrNone(
    `SELECT id, product_id FROM tbl_product_variant WHERE product_id IS NOT NULL ORDER BY id ASC LIMIT 1`
  );
  if (v) {
    VARIANT_ID = v.id;
    PRODUCT_ID = v.product_id;
  }

  // Purpose-built roles carrying exactly one reports permission each, so
  // "entitled to A but not B" is testable. Granting the seeded Company
  // Administrator role instead would hand over all sixteen at once.
  const mkRole = async (title, action) => {
    const r = await db.one(
      `INSERT INTO tbl_roles (title, description, created_by)
       VALUES ($1, 'test-only role', $2) RETURNING id`,
      [title, IDS.users.superAdmin]
    );
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, id FROM tbl_permissions
        WHERE resource::text = 'reports' AND action::text = $2`,
      [r.id, action]
    );
    return Number(r.id);
  };
  REPORTS_ROLE_ID = await mkRole("TEST Reports — spend by vendor", "spend_by_vendor");
  BLOCKED_ROLE_ID = await mkRole("TEST Reports — budget vs actual", "budget_vs_actual");

  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`, [
    [IDS.users.vendor_alpha, IDS.users.vendor_beta],
  ]);
});

// One afterAll, and the order matters: closeDb() destroys the pool, so any
// cleanup that still needs a query has to happen before it.
afterAll(async () => {
  for (const id of [REPORTS_ROLE_ID, BLOCKED_ROLE_ID].filter(Boolean)) {
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [id]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = $1`, [id]);
    await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [id]);
  }
  await closeDb();
});

// ---- Row tracking -----------------------------------------------------------
const inserted = {
  rfqIds: [], poIds: [], poProductIds: [], rfqProductIds: [], quoteIds: [],
  scopeIds: [], exportIds: [], categoryIds: [], productCategoryIds: [],
};

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  await revokeRoleScopes(db, inserted.scopeIds);
  if (inserted.exportIds.length) {
    await db.none(`DELETE FROM tbl_report_exports WHERE id = ANY($1::bigint[])`, [inserted.exportIds]);
  }
  await db.none(`DELETE FROM tbl_report_exports WHERE report_key LIKE 'spend_by_vendor'
                   AND requested_by = ANY($1::int[])`,
    [[IDS.users.a1_proc_buyer, IDS.users.companyB_admin, IDS.users.superAdmin]]);
  if (inserted.productCategoryIds.length) {
    await db.none(`DELETE FROM tbl_product_categories WHERE id = ANY($1::int[])`, [inserted.productCategoryIds]);
  }
  if (inserted.poProductIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE id = ANY($1::int[])`, [inserted.poProductIds]);
  }
  if (inserted.poIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type='PO' AND entity_id = ANY($1::int[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [inserted.poIds]);
  }
  if (inserted.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [inserted.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [inserted.quoteIds]);
  }
  if (inserted.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [inserted.rfqProductIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  if (inserted.categoryIds.length) {
    await db.none(`DELETE FROM tbl_category WHERE id = ANY($1::int[])`, [inserted.categoryIds]);
  }
});

// ---- Setup helpers ----------------------------------------------------------
let PO_NO = 9_100_000;
const nextPoNo = () => `RPT-PO-${++PO_NO}`;

async function grantReports(userId, roleId, { hospitality = IDS.hospitality.A, hotel = null } = {}) {
  const id = await grantRoleScope(db, {
    userId, roleId, companyId: hospitality, hotelId: hotel,
  });
  inserted.scopeIds.push(id);
  return id;
}

async function makeRfqWithVendor({ vendorId, hospitality = IDS.hospitality.A, hotel = IDS.hotels.A1 }) {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1, is_published: 1, bid_end_date: oneDayAgo,
    hospitality, hotel, department: IDS.departments.proc, process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);

  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, 'Spec text', '', '', '', '', $2, 0) RETURNING id`,
    [rfq_id, VARIANT_ID]
  );
  inserted.rfqProductIds.push(product.id);

  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, VARIANT_ID, vendorId]
  );
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1,$2,$3,$3) RETURNING id`,
    [rfq_id, rfq_no, vendorId]
  );
  inserted.quoteIds.push(quote.id);
  return { rfq_id, rfq_product_id: product.id, quote_id: quote.id };
}

/** A PO with one line worth `lineTotal`. */
async function makePoWithLine({
  vendorId = IDS.users.vendor_alpha, status = "approved", lineTotal = 1000,
  hospitality = IDS.hospitality.A, hotel = IDS.hotels.A1, companyId = IDS.companies.A,
}) {
  const r = await makeRfqWithVendor({ vendorId, hospitality, hotel });
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,1,100,$6,$7,$8,$9,NOW(),NOW()) RETURNING id, po_number`,
    [r.rfq_id, companyId, nextPoNo(), status, [r.rfq_product_id], vendorId, lineTotal,
     [r.quote_id], IDS.users.a1_proc_buyer]
  );
  inserted.poIds.push(po.id);
  const line = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price, product_variant_id)
     VALUES ($1,$2,$3,1,'NOS',$4,$4,$5) RETURNING id`,
    [po.id, r.rfq_product_id, r.quote_id, lineTotal, VARIANT_ID]
  );
  inserted.poProductIds.push(line.id);
  return po;
}

// ---- Workbook helpers -------------------------------------------------------
const binary = (req) =>
  req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "binary")));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

async function loadWorkbook(buf) {
  const wb = new excelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

/**
 * The header row index. Unlike the PO exports, a report sheet opens with a
 * title and a parameters block, so the header is not row 1 — it is the first
 * row whose column A is "Rank".
 */
function headerRowIndex(ws) {
  for (let r = 1; r <= ws.rowCount; r += 1) {
    if (String(ws.getRow(r).getCell(1).value ?? "").trim() === "Rank") return r;
  }
  throw new Error("no header row found");
}

function headers(ws) {
  const hr = ws.getRow(headerRowIndex(ws));
  const out = [];
  hr.eachCell((cell) => out.push(String(cell.value ?? "")));
  return out;
}

/** Data rows between the header and the total row, as arrays of cells. */
function bodyRows(ws) {
  const hr = headerRowIndex(ws);
  const rows = [];
  for (let r = hr + 1; r <= ws.rowCount; r += 1) {
    const first = ws.getRow(r).getCell(1).value;
    if (first === "Total" || first === null || first === undefined || first === "") break;
    rows.push(ws.getRow(r));
  }
  return rows;
}

function totalRow(ws) {
  for (let r = 1; r <= ws.rowCount; r += 1) {
    if (String(ws.getRow(r).getCell(1).value ?? "") === "Total") return ws.getRow(r);
  }
  return null;
}

function sheetText(ws) {
  const out = [];
  ws.eachRow((row) => row.eachCell((cell) => out.push(String(cell.value ?? ""))));
  return out;
}

const download = async (userId, body = {}) => {
  const client = await httpClient(userId);
  return binary(client.post("/api/v1/reports/spend_by_vendor/download").send(body));
};

// ============================================================================

describe("GET /reports/catalogue", () => {
  it("lists nothing when the user holds no reports permission", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get("/api/v1/reports/catalogue");
    expect(res.status).toBe(200);
    expect(res.body.data.reports).toEqual([]);
  });

  it("lists only the report the user is entitled to, and marks it runnable", async () => {
    await grantReports(IDS.users.a1_proc_buyer, REPORTS_ROLE_ID);
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get("/api/v1/reports/catalogue");

    expect(res.status).toBe(200);
    const keys = res.body.data.reports.map((r) => r.key);
    expect(keys).toEqual(["spend_by_vendor"]);

    const only = res.body.data.reports[0];
    expect(only).toMatchObject({ number: "1.4", family: "Spend Analytics", runnable: true });
    expect(only.readiness.state).toBe("ready");
  });

  it("shows a report with no backing data as not runnable, and says what is missing", async () => {
    await grantReports(IDS.users.a1_proc_buyer, BLOCKED_ROLE_ID);
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get("/api/v1/reports/catalogue");

    const budget = res.body.data.reports.find((r) => r.key === "budget_vs_actual");
    expect(budget).toBeTruthy();
    expect(budget.runnable).toBe(false);
    expect(budget.readiness.state).toBe("not_configured");
    // The reason is shown to the user, so it must actually say something.
    expect(budget.readiness.missing).toMatch(/budget/i);
  });

  it("refuses a vendor outright", async () => {
    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get("/api/v1/reports/catalogue");
    expect(res.status).toBe(403);
  });
});

describe("POST /reports/:key/download — entitlement", () => {
  it("refuses a report the user holds no permission for", async () => {
    await makePoWithLine({ lineTotal: 1000 });
    const client = await httpClient(IDS.users.a1_proc_buyer); // no grant
    const res = await client.post("/api/v1/reports/spend_by_vendor/download").send({});
    expect(res.status).toBe(403);
  });

  it("answers an unknown key exactly as it answers an unentitled one", async () => {
    await grantReports(IDS.users.a1_proc_buyer, REPORTS_ROLE_ID);
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const unknown = await client.post("/api/v1/reports/no_such_report/download").send({});
    const unentitled = await client.post("/api/v1/reports/spend_summary/download").send({});
    // Distinguishing them would turn the endpoint into a directory of what exists.
    expect(unknown.status).toBe(403);
    expect(unentitled.status).toBe(403);
    expect(unknown.body.message).toBe(unentitled.body.message);
  });

  it("refuses to run a report that has no backing data, and explains why", async () => {
    await grantReports(IDS.users.a1_proc_buyer, BLOCKED_ROLE_ID);
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.post("/api/v1/reports/budget_vs_actual/download").send({});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/budget/i);
  });

  it("refuses a vendor", async () => {
    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.post("/api/v1/reports/spend_by_vendor/download").send({});
    expect(res.status).toBe(403);
  });
});

describe("POST /reports/spend_by_vendor/download — the workbook", () => {
  beforeEach(async () => {
    await grantReports(IDS.users.a1_proc_buyer, REPORTS_ROLE_ID);
  });

  it("returns a readable .xlsx with both sheets and the agreed columns", async () => {
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, lineTotal: 5000 });
    const res = await download(IDS.users.a1_proc_buyer);

    expect(res.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toMatch(
      /attachment; filename="spend-by-vendor_\d{4}-\d{2}-\d{2}\.xlsx"/
    );

    const wb = await loadWorkbook(res.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Vendor Ranking", "Top 25"]);

    expect(headers(wb.getWorksheet("Vendor Ranking"))).toEqual([
      "Rank", "Vendor ID", "Vendor Name", "Primary Category", "GSTIN",
      "Spend (₹)", "Share %", "Cum %", "Prior Period (₹)", "YoY %",
      "MSME", "ARC", "POs", "Last PO",
    ]);
  });

  it("writes money as a NUMBER in Indian format, not a formatted string", async () => {
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, lineTotal: 1234567 });
    const wb = await loadWorkbook((await download(IDS.users.a1_proc_buyer)).body);
    const ws = wb.getWorksheet("Vendor Ranking");
    const row = bodyRows(ws)[0];

    const spend = row.getCell(6);
    expect(typeof spend.value).toBe("number");
    expect(spend.value).toBe(1234567);

    // Indian lakh/crore grouping. Asserted in its READ-BACK form: ExcelJS drops
    // the backslash escapes when it parses a workbook, while the file itself
    // keeps them. Verified against the approved sample — both
    // 1.4_Spend_by_Vendor_FY26.xlsx and our output carry
    //   formatCode="##\,##\,##\,##0;[Red]\-##\,##\,##\,##0;0"
    // in xl/styles.xml. Do not "fix" excelKit to match the string below.
    expect(spend.numFmt).toBe("##,##,##,##0;[Red]-##,##,##,##0;0");
    expect(ws.getRow(headerRowIndex(ws) + 1).getCell(7).numFmt).toBe("0.0%");
  });

  it("totals with a FORMULA, so the number follows the sheet if it is filtered", async () => {
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, lineTotal: 1000 });
    await makePoWithLine({ vendorId: IDS.users.vendor_beta, lineTotal: 2000 });
    const wb = await loadWorkbook((await download(IDS.users.a1_proc_buyer)).body);
    const ws = wb.getWorksheet("Vendor Ranking");

    const total = totalRow(ws);
    expect(total).toBeTruthy();
    expect(total.getCell(6).value).toHaveProperty("formula");
    expect(total.getCell(6).value.formula).toMatch(/^SUM\(F\d+:F\d+\)$/);
  });

  it("freezes below the header and turns on autofilter, so a long sheet stays usable", async () => {
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, lineTotal: 1000 });
    const wb = await loadWorkbook((await download(IDS.users.a1_proc_buyer)).body);
    const ws = wb.getWorksheet("Vendor Ranking");
    const hr = headerRowIndex(ws);

    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: hr });
    // Freezing at or above the header would scroll it out of view — the flaw in
    // the sample workbooks this deliberately departs from.
    expect(ws.views[0].ySplit).toBeGreaterThanOrEqual(hr);
    // ExcelJS writes the object we set but reads it back as a range string.
    expect(ws.autoFilter).toBeTruthy();
    expect(String(ws.autoFilter)).toMatch(new RegExp(`^A${hr}:`));
  });

  it("records the download in the export ledger", async () => {
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, lineTotal: 4242 });
    await download(IDS.users.a1_proc_buyer);

    const row = await db.oneOrNone(
      `SELECT report_key, requested_by, mode, status, row_count, filters
         FROM tbl_report_exports
        WHERE requested_by = $1 ORDER BY id DESC LIMIT 1`,
      [IDS.users.a1_proc_buyer]
    );
    expect(row).toBeTruthy();
    expect(row).toMatchObject({
      report_key: "spend_by_vendor",
      requested_by: IDS.users.a1_proc_buyer,
      mode: "SYNC",
      status: "READY",
    });
    expect(row.filters).toHaveProperty("fy");
  });
});

describe("SECURITY: /reports is scoped from req.user", () => {
  it("a company-B user's report contains no company-A vendor", async () => {
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, lineTotal: 7777 });

    await grantReports(IDS.users.a1_proc_buyer, REPORTS_ROLE_ID);
    const aWb = await loadWorkbook((await download(IDS.users.a1_proc_buyer)).body);
    const aText = sheetText(aWb.getWorksheet("Vendor Ranking")).join("|");
    expect(aText).toContain("7777");

    await grantReports(IDS.users.companyB_admin, REPORTS_ROLE_ID, { hospitality: IDS.hospitality.B });
    const bWb = await loadWorkbook((await download(IDS.users.companyB_admin)).body);
    const bText = sheetText(bWb.getWorksheet("Vendor Ranking")).join("|");
    expect(bText).not.toContain("7777");
  });

  it("a forged company id in the payload changes nothing", async () => {
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, lineTotal: 8888 });
    await grantReports(IDS.users.companyB_admin, REPORTS_ROLE_ID, { hospitality: IDS.hospitality.B });

    const forged = await download(IDS.users.companyB_admin, {
      hospitality_company_id: IDS.hospitality.A,
      company_id: IDS.companies.A,
    });
    const wb = await loadWorkbook(forged.body);
    expect(sheetText(wb.getWorksheet("Vendor Ranking")).join("|")).not.toContain("8888");
  });

  it("a hotel facet narrows the report and can never widen it", async () => {
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, lineTotal: 111, hotel: IDS.hotels.A1 });
    await grantReports(IDS.users.a1_proc_buyer, REPORTS_ROLE_ID);

    // Naming a hotel the caller has no rows in yields fewer rows, not an error
    // and not somebody else's data.
    const narrowed = await download(IDS.users.a1_proc_buyer, { hotel_ids: [IDS.hotels.B1] });
    const wb = await loadWorkbook(narrowed.body);
    expect(sheetText(wb.getWorksheet("Vendor Ranking")).join("|")).not.toContain("111");
  });
});

describe("CORRECTNESS: what the numbers mean", () => {
  beforeEach(async () => {
    await grantReports(IDS.users.a1_proc_buyer, REPORTS_ROLE_ID);
  });

  it("counts approved spend and ignores drafts, rejections and cancellations", async () => {
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, status: "approved", lineTotal: 1000 });
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, status: "draft", lineTotal: 500 });
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, status: "rejected", lineTotal: 300 });
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, status: "pending_approval", lineTotal: 200 });

    const wb = await loadWorkbook((await download(IDS.users.a1_proc_buyer)).body);
    const ws = wb.getWorksheet("Vendor Ranking");
    const alpha = bodyRows(ws).find((r) => Number(r.getCell(2).value) === IDS.users.vendor_alpha);

    // A commitment that was never approved is not spend.
    expect(alpha.getCell(6).value).toBe(1000);
  });

  it("does not double-count a product mapped to BOTH its parent and its leaf category", async () => {
    // The defect this guards: on staging the naive join turned Rs 7,36,29,816
    // of spend into Rs 15,09,11,261 because nearly every product carries two
    // tbl_product_categories rows.
    expect(PRODUCT_ID).toBeTruthy();

    const parent = await db.one(
      `INSERT INTO tbl_category (title, parent_id, status, is_deleted, created_by)
       VALUES ('TEST Parent Cat', 0, 1, 0, $1) RETURNING id`,
      [IDS.users.superAdmin]
    );
    inserted.categoryIds.push(parent.id);
    const leaf = await db.one(
      `INSERT INTO tbl_category (title, parent_id, status, is_deleted, created_by)
       VALUES ('TEST Leaf Cat', $1, 1, 0, $2) RETURNING id`,
      [parent.id, IDS.users.superAdmin]
    );
    inserted.categoryIds.push(leaf.id);

    for (const cat of [parent, leaf]) {
      const pc = await db.one(
        `INSERT INTO tbl_product_categories (product_id, category_name, category_id)
         VALUES ($1, 'TEST', $2) RETURNING id`,
        [PRODUCT_ID, cat.id]
      );
      inserted.productCategoryIds.push(pc.id);
    }

    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, lineTotal: 10000 });

    const wb = await loadWorkbook((await download(IDS.users.a1_proc_buyer)).body);
    const ws = wb.getWorksheet("Vendor Ranking");
    const alpha = bodyRows(ws).find((r) => Number(r.getCell(2).value) === IDS.users.vendor_alpha);

    // Exactly the ledger, not twice it — and exactly one row for the vendor.
    expect(alpha.getCell(6).value).toBe(10000);
    expect(bodyRows(ws).filter((r) => Number(r.getCell(2).value) === IDS.users.vendor_alpha)).toHaveLength(1);
    // The leaf wins over its parent, so the category column is the specific one.
    expect(String(alpha.getCell(4).value)).toBe("TEST Leaf Cat");
  });

  it("shares sum to 1 and the cumulative column ends at 1", async () => {
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, lineTotal: 3000 });
    await makePoWithLine({ vendorId: IDS.users.vendor_beta, lineTotal: 1000 });

    const wb = await loadWorkbook((await download(IDS.users.a1_proc_buyer)).body);
    const rows = bodyRows(wb.getWorksheet("Vendor Ranking"));

    const shares = rows.map((r) => Number(r.getCell(7).value));
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    // Ranked descending, so the biggest vendor is first and cum% ends at 1.
    expect(Number(rows[0].getCell(6).value)).toBe(3000);
    expect(Number(rows[rows.length - 1].getCell(8).value)).toBeCloseTo(1, 6);
  });

  it("leaves YoY empty for a vendor with no prior-period spend rather than dividing by zero", async () => {
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, lineTotal: 2500 });
    const wb = await loadWorkbook((await download(IDS.users.a1_proc_buyer)).body);
    const alpha = bodyRows(wb.getWorksheet("Vendor Ranking"))[0];

    expect(alpha.getCell(9).value ?? null).toBeNull();   // prior period
    expect(alpha.getCell(10).value ?? null).toBeNull();  // YoY %
  });
});

describe("POST /reports/spend_by_vendor/preview", () => {
  it("previews the same columns and rows the download will contain", async () => {
    await grantReports(IDS.users.a1_proc_buyer, REPORTS_ROLE_ID);
    await makePoWithLine({ vendorId: IDS.users.vendor_alpha, lineTotal: 6543 });

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.post("/api/v1/reports/spend_by_vendor/preview").send({});
    expect(res.status).toBe(200);

    const { columns, rows, total_rows } = res.body.data;
    expect(columns.map((c) => c.header)).toContain("Spend (₹)");
    expect(total_rows).toBeGreaterThan(0);

    const wb = await loadWorkbook((await download(IDS.users.a1_proc_buyer)).body);
    const ws = wb.getWorksheet("Vendor Ranking");
    // Same column list, same order, in both surfaces.
    expect(columns.map((c) => c.header)).toEqual(headers(ws));
    expect(rows[0].amount).toBe(Number(bodyRows(ws)[0].getCell(6).value));
  });

  it("refuses a report the caller is not entitled to", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.post("/api/v1/reports/spend_by_vendor/preview").send({});
    expect(res.status).toBe(403);
  });
});
