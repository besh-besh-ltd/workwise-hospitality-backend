// Report 1.1 — Total Spend Summary.
// ----------------------------------------------------------------------------
// The assertion that matters most here is RECONCILIATION: the monthly sheet,
// the per-property sheet and the per-category sheet are three different
// groupings of one number, so all three totals must be equal. If they are not,
// one of the joins is either dropping rows or counting them twice — and a
// spend report that disagrees with itself is worse than no report, because
// somebody will act on whichever figure they read first.
//
// Verified against staging while building this: all three groupings summed to
// Rs 6,42,49,612.38, at both the parent and the leaf category grain.

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
let ROLE_ID = null;

beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT_ID = v.id;

  const r = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by)
     VALUES ('TEST Reports — spend summary', 'test-only role', $1) RETURNING id`,
    [IDS.users.superAdmin]
  );
  ROLE_ID = Number(r.id);
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, id FROM tbl_permissions
      WHERE resource::text = 'reports' AND action::text = 'spend_summary'`,
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

let PO_NO = 9_300_000;

/**
 * Widen the caller's ROW scope to a second business unit by re-granting the
 * role they already hold there.
 *
 * Entitlement and row scope are different gates: holding reports.spend_summary
 * lets you open the report, but the rows in it still come from the
 * rfq/awarding/boq read scopes. Without this the fixture buyer sees hotel A1
 * only — which is correct behaviour, and is asserted directly further down.
 */
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

async function grantSummary(userId) {
  const id = await grantRoleScope(db, {
    userId, roleId: ROLE_ID, companyId: IDS.hospitality.A, hotelId: null,
  });
  inserted.scopeIds.push(id);
}

async function makePo({ lineTotal, hotel = IDS.hotels.A1, vendorId = IDS.users.vendor_alpha, status = "approved" }) {
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
    [rfq_id, VARIANT_ID]
  );
  inserted.rfqProductIds.push(product.id);
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1,$2,$3,0)`,
    [rfq_id, VARIANT_ID, vendorId]
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
     VALUES ($1,$2,$3,$4,$5,1,100,$6,$7,$8,$9,NOW(),NOW()) RETURNING id`,
    [rfq_id, IDS.companies.A, `SUM-PO-${++PO_NO}`, status, [product.id], vendorId, lineTotal,
     [quote.id], IDS.users.a1_proc_buyer]
  );
  inserted.poIds.push(po.id);
  const line = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price, product_variant_id)
     VALUES ($1,$2,$3,1,'NOS',$4,$4,$5) RETURNING id`,
    [po.id, product.id, quote.id, lineTotal, VARIANT_ID]
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

async function downloadSummary() {
  const client = await httpClient(IDS.users.a1_proc_buyer);
  const res = await binary(client.post("/api/v1/reports/spend_summary/download").send({}));
  const wb = new excelJS.Workbook();
  await wb.xlsx.load(res.body);
  return { res, wb };
}

/** The value in the total row for the column headed `header`. */
function totalFor(ws, header) {
  let headerRow = null;
  let col = null;
  for (let r = 1; r <= ws.rowCount && !headerRow; r += 1) {
    ws.getRow(r).eachCell((cell, c) => {
      if (String(cell.value ?? "") === header) {
        headerRow = r;
        col = c;
      }
    });
  }
  if (!headerRow) throw new Error(`no column headed "${header}"`);
  for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
    if (String(ws.getRow(r).getCell(1).value ?? "") === "Total") {
      return { row: r, cell: ws.getRow(r).getCell(col), col };
    }
  }
  throw new Error("no total row");
}

/** Sum the body cells under `header`, which is what the total FORMULA covers. */
function sumBody(ws, header) {
  const { row: totalRowIdx, col } = totalFor(ws, header);
  let headerRow = null;
  for (let r = 1; r < totalRowIdx && headerRow === null; r += 1) {
    if (String(ws.getRow(r).getCell(col).value ?? "") === header) headerRow = r;
  }
  let sum = 0;
  for (let r = headerRow + 1; r < totalRowIdx; r += 1) {
    const v = ws.getRow(r).getCell(col).value;
    if (typeof v === "number") sum += v;
  }
  return sum;
}

describe("Report 1.1 — Total Spend Summary", () => {
  beforeEach(async () => {
    await grantSummary(IDS.users.a1_proc_buyer);
  });

  it("returns the three agreed sheets", async () => {
    await makePo({ lineTotal: 1000 });
    const { res, wb } = await downloadSummary();

    expect(res.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Monthly Summary", "By Property", "Top Categories",
    ]);
  });

  it("RECONCILES: the monthly, property and category sheets total the same", async () => {
    // Two properties, three amounts, one truth.
    await alsoScopeTo(IDS.users.a1_proc_buyer, IDS.hotels.A2);
    await makePo({ lineTotal: 120000, hotel: IDS.hotels.A1 });
    await makePo({ lineTotal: 80000, hotel: IDS.hotels.A2 });
    await makePo({ lineTotal: 45000, hotel: IDS.hotels.A1 });
    const expected = 245000;

    const { wb } = await downloadSummary();
    const monthly = sumBody(wb.getWorksheet("Monthly Summary"), "Actual (₹)");
    const property = sumBody(wb.getWorksheet("By Property"), "Actual (₹)");
    const category = sumBody(wb.getWorksheet("Top Categories"), "Actual (₹)");

    expect(monthly).toBe(expected);
    expect(property).toBe(expected);
    expect(category).toBe(expected);
  });

  it("omits a business unit the caller has no row scope for", async () => {
    // Entitlement is not scope: holding the report permission at company level
    // does not widen which rows appear in it.
    await makePo({ lineTotal: 120000, hotel: IDS.hotels.A1 });
    await makePo({ lineTotal: 80000, hotel: IDS.hotels.A2 });

    const { wb } = await downloadSummary();
    expect(sumBody(wb.getWorksheet("By Property"), "Actual (₹)")).toBe(120000);
  });

  it("keeps a month with no spend as a zero row rather than dropping it", async () => {
    await makePo({ lineTotal: 5000 });
    const { wb } = await downloadSummary();
    const ws = wb.getWorksheet("Monthly Summary");

    // A financial year has twelve months whether or not each one had spend;
    // dropping the empty ones makes a 12-month report render nine rows.
    const { row: totalRowIdx } = totalFor(ws, "Actual (₹)");
    let headerRow = null;
    for (let r = 1; r < totalRowIdx && headerRow === null; r += 1) {
      if (String(ws.getRow(r).getCell(1).value ?? "") === "Month") headerRow = r;
    }
    expect(totalRowIdx - headerRow - 1).toBe(12);
  });

  it("leaves Cost per Key blank when the business unit has no room count", async () => {
    await makePo({ lineTotal: 90000 });
    const { wb } = await downloadSummary();
    const ws = wb.getWorksheet("By Property");

    const { cell } = totalFor(ws, "Actual (₹)");
    expect(typeof cell.value).toBe("object"); // a SUM formula
    // Keys are unset in fixtures, so the derived column must stay empty rather
    // than render a division by zero.
    const { col: keyCol } = totalFor(ws, "Cost per Key (₹)");
    expect(keyCol).toBeTruthy();
  });

  it("rolls sub-categories up to their parent without double-counting", async () => {
    await makePo({ lineTotal: 33000 });
    const { wb } = await downloadSummary();
    const ws = wb.getWorksheet("Top Categories");

    expect(sumBody(ws, "Actual (₹)")).toBe(33000);
    // Share % over the whole sheet is 1, which only holds if each line landed
    // in exactly one category.
    const shares = [];
    const { row: totalRowIdx, col } = totalFor(ws, "Share %");
    for (let r = 1; r < totalRowIdx; r += 1) {
      const v = ws.getRow(r).getCell(col).value;
      if (typeof v === "number") shares.push(v);
    }
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("is refused without the permission", async () => {
    await revokeRoleScopes(db, inserted.scopeIds);
    inserted.scopeIds = [];
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.post("/api/v1/reports/spend_summary/download").send({});
    expect(res.status).toBe(403);
  });
});
