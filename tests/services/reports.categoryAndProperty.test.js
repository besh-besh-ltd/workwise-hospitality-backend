// Reports 1.2 (Spend by Category) and 1.3 (Spend by Property).
// ----------------------------------------------------------------------------
// Both reports re-cut the same spend, so the assertions are mostly about
// AGREEMENT: the category sheet and the sub-category sheet must total the same
// (the double-count guard holding at two grains), and the category x property
// grid must total the same as both.
//
// The rate-variance sheet gets its own attention because it is the one place
// these reports invite an action — "consolidate this item" — and a wrong row
// there sends a buyer to renegotiate a price that was never different. The
// trap, found on staging: an item bought in different UNITS at two properties
// compares as an 86x rate gap when it is really boxes against pieces.

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import excelJS from "exceljs";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";

let VARIANT_A = 1;
let VARIANT_B = 2;
let ROLE_ID = null;

beforeAll(async () => {
  const vs = await db.any(
    `SELECT id FROM tbl_product_variant WHERE product_id IS NOT NULL ORDER BY id ASC LIMIT 2`
  );
  if (vs[0]) VARIANT_A = vs[0].id;
  if (vs[1]) VARIANT_B = vs[1].id;

  const r = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by)
     VALUES ('TEST Reports — category and property', 'test-only role', $1) RETURNING id`,
    [IDS.users.superAdmin]
  );
  ROLE_ID = Number(r.id);
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, id FROM tbl_permissions
      WHERE resource::text = 'reports'
        AND action::text IN ('spend_by_category', 'spend_by_property')`,
    [ROLE_ID]
  );
});

afterAll(async () => {
  if (ROLE_ID) {
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [ROLE_ID]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = $1`, [ROLE_ID]);
    await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [ROLE_ID]);
  }
  await closeDb();
});

const inserted = { rfqIds: [], poIds: [], poProductIds: [], rfqProductIds: [], quoteIds: [], scopeIds: [] };

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  await revokeRoleScopes(db, inserted.scopeIds);
  await db.none(`DELETE FROM tbl_report_exports WHERE requested_by = $1`, [IDS.users.a1_proc_buyer]);
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
});

let PO_NO = 9_500_000;

async function grant(userId) {
  const id = await grantRoleScope(db, {
    userId, roleId: ROLE_ID, companyId: IDS.hospitality.A, hotelId: null,
  });
  inserted.scopeIds.push(id);
}

/** Widen ROW scope to a second business unit — see reports.spendSummary.test.js. */
async function alsoScopeTo(userId, hotelId) {
  const row = await db.oneOrNone(
    `SELECT urs.role_id
       FROM tbl_user_role_scopes urs
       JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE urs.user_id = $1
        AND (p.resource || '.' || p.action) IN ('rfq.read', 'awarding.read', 'boq.read')
      LIMIT 1`,
    [userId]
  );
  if (!row) throw new Error("fixture user holds no rfq/awarding/boq read role");
  const id = await grantRoleScope(db, {
    userId, roleId: row.role_id, companyId: IDS.hospitality.A, hotelId,
  });
  inserted.scopeIds.push(id);
}

/** A PO with one line: `qty` of `variant` at `unit`, worth `lineTotal`. */
async function makePo({
  lineTotal, hotel = IDS.hotels.A1, variant = VARIANT_A, qty = 1, unit = "NOS",
  vendorId = IDS.users.vendor_alpha,
}) {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1, is_published: 1, bid_end_date: oneDayAgo,
    hospitality: IDS.hospitality.A, hotel,
    department: IDS.departments.proc, process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);

  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1,'Spec','','','','',$2,0) RETURNING id`,
    [rfq_id, variant]
  );
  inserted.rfqProductIds.push(product.id);
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1,$2,$3,0)`,
    [rfq_id, variant, vendorId]
  );
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1,$2,$3,$3) RETURNING id`,
    [rfq_id, rfq_no, vendorId]
  );
  inserted.quoteIds.push(quote.id);

  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, created_at, updated_at)
     VALUES ($1,$2,$3,'approved',$4,$5,100,$6,$7,$8,$9,NOW(),NOW()) RETURNING id`,
    [rfq_id, IDS.companies.A, `CP-PO-${++PO_NO}`, [product.id], qty, vendorId, lineTotal,
     [quote.id], IDS.users.a1_proc_buyer]
  );
  inserted.poIds.push(po.id);
  const line = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price, product_variant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [po.id, product.id, quote.id, qty, unit, lineTotal / qty, lineTotal, variant]
  );
  inserted.poProductIds.push(line.id);
  return po;
}

const binary = (req) =>
  req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "binary")));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

async function downloadReport(key) {
  const client = await httpClient(IDS.users.a1_proc_buyer);
  const res = await binary(client.post(`/api/v1/reports/${key}/download`).send({}));
  const wb = new excelJS.Workbook();
  await wb.xlsx.load(res.body);
  return { res, wb };
}

/** Locate a column by header, returning its index and header row. */
function locate(ws, header) {
  for (let r = 1; r <= ws.rowCount; r += 1) {
    let found = null;
    ws.getRow(r).eachCell((cell, c) => {
      if (found === null && String(cell.value ?? "") === header) found = c;
    });
    if (found !== null) return { headerRow: r, col: found };
  }
  throw new Error(`no column headed "${header}"`);
}

/** Sum the numeric body cells under `header`, stopping at the total row. */
function sumBody(ws, header) {
  const { headerRow, col } = locate(ws, header);
  let sum = 0;
  for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
    if (String(ws.getRow(r).getCell(1).value ?? "") === "Total") break;
    const v = ws.getRow(r).getCell(col).value;
    if (typeof v === "number") sum += v;
  }
  return sum;
}

function bodyValues(ws, header) {
  const { headerRow, col } = locate(ws, header);
  const out = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
    if (String(ws.getRow(r).getCell(1).value ?? "") === "Total") break;
    const v = ws.getRow(r).getCell(col).value;
    if (v !== null && v !== undefined && v !== "") out.push(v);
  }
  return out;
}

describe("Report 1.2 — Spend by Category", () => {
  beforeEach(async () => {
    await grant(IDS.users.a1_proc_buyer);
  });

  it("returns the three agreed sheets", async () => {
    await makePo({ lineTotal: 1000 });
    const { wb } = await downloadReport("spend_by_category");
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Categories", "Sub-Categories", "Category x Property",
    ]);
  });

  it("RECONCILES: category, sub-category and the grid all total the same", async () => {
    await alsoScopeTo(IDS.users.a1_proc_buyer, IDS.hotels.A2);
    await makePo({ lineTotal: 60000, hotel: IDS.hotels.A1 });
    await makePo({ lineTotal: 25000, hotel: IDS.hotels.A2 });
    const expected = 85000;

    const { wb } = await downloadReport("spend_by_category");
    // Rolling up to the parent and reporting the leaf are two views of the
    // same rupees; if they differ, one of them is counting a line twice.
    expect(sumBody(wb.getWorksheet("Categories"), "Actual (₹)")).toBe(expected);
    expect(sumBody(wb.getWorksheet("Sub-Categories"), "Actual (₹)")).toBe(expected);
    expect(sumBody(wb.getWorksheet("Category x Property"), "Total (₹)")).toBe(expected);
  });

  it("gives the grid one column per property in scope", async () => {
    await alsoScopeTo(IDS.users.a1_proc_buyer, IDS.hotels.A2);
    await makePo({ lineTotal: 1000, hotel: IDS.hotels.A1 });
    await makePo({ lineTotal: 2000, hotel: IDS.hotels.A2 });

    const { wb } = await downloadReport("spend_by_category");
    const ws = wb.getWorksheet("Category x Property");
    const { headerRow } = locate(ws, "Category");
    const headers = [];
    ws.getRow(headerRow).eachCell((c) => headers.push(String(c.value ?? "")));

    // Category + two properties + Total + Share.
    expect(headers[0]).toBe("Category");
    expect(headers).toContain("Total (₹)");
    expect(headers).toContain("Share %");
    expect(headers.length).toBe(5);
  });
});

describe("Report 1.3 — Spend by Property", () => {
  beforeEach(async () => {
    await grant(IDS.users.a1_proc_buyer);
  });

  it("returns the two agreed sheets and reconciles the property totals", async () => {
    await alsoScopeTo(IDS.users.a1_proc_buyer, IDS.hotels.A2);
    await makePo({ lineTotal: 40000, hotel: IDS.hotels.A1 });
    await makePo({ lineTotal: 10000, hotel: IDS.hotels.A2 });

    const { wb } = await downloadReport("spend_by_property");
    expect(wb.worksheets.map((w) => w.name)).toEqual(["By Property", "Rate Variance"]);
    expect(sumBody(wb.getWorksheet("By Property"), "Actual (₹)")).toBe(50000);
  });

  it("flags an item bought at a materially different rate at another property", async () => {
    await alsoScopeTo(IDS.users.a1_proc_buyer, IDS.hotels.A2);
    // Same item, same unit, 10 units each: Rs 100/unit vs Rs 200/unit.
    await makePo({ lineTotal: 1000, qty: 10, unit: "NOS", variant: VARIANT_A, hotel: IDS.hotels.A1 });
    await makePo({ lineTotal: 2000, qty: 10, unit: "NOS", variant: VARIANT_A, hotel: IDS.hotels.A2 });

    const { wb } = await downloadReport("spend_by_property");
    const ws = wb.getWorksheet("Rate Variance");

    expect(bodyValues(ws, "Lowest Rate (₹)")).toContain(100);
    expect(bodyValues(ws, "Highest Rate (₹)")).toContain(200);
    // Buying all 20 at the low rate would have cost Rs 2,000 rather than
    // Rs 3,000.
    expect(bodyValues(ws, "Save Potential (₹)")).toContain(1000);
  });

  it("does NOT compare rates across different units of measure", async () => {
    await alsoScopeTo(IDS.users.a1_proc_buyer, IDS.hotels.A2);
    // A box of 50 against a single piece is not a 50x price difference. Before
    // the query grouped on unit, staging reported exactly this as an 8,609%
    // rate variance with a six-figure "saving" attached.
    await makePo({ lineTotal: 5000, qty: 1, unit: "BOX", variant: VARIANT_B, hotel: IDS.hotels.A1 });
    await makePo({ lineTotal: 100, qty: 1, unit: "NOS", variant: VARIANT_B, hotel: IDS.hotels.A2 });

    const { wb } = await downloadReport("spend_by_property");
    const ws = wb.getWorksheet("Rate Variance");
    expect(bodyValues(ws, "Save Potential (₹)")).not.toContain(4900);
  });

  it("ignores a rate gap below the 10% reporting floor", async () => {
    await alsoScopeTo(IDS.users.a1_proc_buyer, IDS.hotels.A2);
    // Rs 100 vs Rs 105 — a 5% gap is noise, not a negotiation.
    await makePo({ lineTotal: 1000, qty: 10, unit: "NOS", variant: VARIANT_A, hotel: IDS.hotels.A1 });
    await makePo({ lineTotal: 1050, qty: 10, unit: "NOS", variant: VARIANT_A, hotel: IDS.hotels.A2 });

    const { wb } = await downloadReport("spend_by_property");
    const ws = wb.getWorksheet("Rate Variance");
    expect(bodyValues(ws, "Lowest Rate (₹)")).not.toContain(100);
  });

  it("says nothing about an item bought at only one property", async () => {
    await makePo({ lineTotal: 9000, qty: 3, unit: "NOS", variant: VARIANT_A, hotel: IDS.hotels.A1 });
    const { wb } = await downloadReport("spend_by_property");
    // There is no second property to compare against, so there is no variance.
    expect(bodyValues(wb.getWorksheet("Rate Variance"), "Lowest Rate (₹)")).toHaveLength(0);
  });
});
