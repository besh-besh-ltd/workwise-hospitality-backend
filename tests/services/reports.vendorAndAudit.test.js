// Reports 2.2 (Vendor Concentration Risk), 2.3 (Vendor Master Activity) and
// 5.1 (Approval Audit Trail).
// ----------------------------------------------------------------------------
// Each of these makes a claim that somebody will act on — "this category has
// one supplier", "this vendor is dormant", "this order was self-approved" — so
// the tests are about whether the claim is true and whether the report is
// honest about how hard it is.
//
// Two of the honesty checks matter most:
//
//   • 5.1 must NOT carry a "Matrix OK" column. The approved sample asserts
//     each order was approved at the authority its value required, and this
//     platform holds no value-based approval matrix. A column that always read
//     "Y" would be worse than no column.
//   • 2.3 must NOT carry a blacklist sheet. Blacklisting is not a state this
//     schema can represent, so there is nothing to list.

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
let POLICY_ID = null;
let POLICY_STEP_ID = null;

beforeAll(async () => {
  const vs = await db.any(
    `SELECT id FROM tbl_product_variant WHERE product_id IS NOT NULL ORDER BY id ASC LIMIT 2`
  );
  if (vs[0]) VARIANT_A = vs[0].id;
  if (vs[1]) VARIANT_B = vs[1].id;

  const r = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by)
     VALUES ('TEST Reports — vendor and audit', 'test-only role', $1) RETURNING id`,
    [IDS.users.superAdmin]
  );
  ROLE_ID = Number(r.id);
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, id FROM tbl_permissions
      WHERE resource::text = 'reports'
        AND action::text IN ('vendor_concentration', 'vendor_master', 'approval_audit_trail')`,
    [ROLE_ID]
  );

  const pol = await db.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by)
     VALUES ('PO', $1, $2, $3, true, $4) RETURNING id`,
    [IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.users.superAdmin]
  );
  POLICY_ID = Number(pol.id);
  const st = await db.one(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id, sla_hours)
     VALUES ($1, 1, 'ANY', 'USER', $2, 8) RETURNING id`,
    [POLICY_ID, IDS.users.a1_proc_poApp]
  );
  POLICY_STEP_ID = Number(st.id);
});

afterAll(async () => {
  if (POLICY_ID) {
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
  }
  if (ROLE_ID) {
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [ROLE_ID]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = $1`, [ROLE_ID]);
    await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [ROLE_ID]);
  }
  await closeDb();
});

const inserted = {
  rfqIds: [], poIds: [], poProductIds: [], rfqProductIds: [], quoteIds: [],
  scopeIds: [], instanceIds: [],
};

beforeEach(() => { for (const k of Object.keys(inserted)) inserted[k] = []; });

afterEach(async () => {
  await revokeRoleScopes(db, inserted.scopeIds);
  await db.none(`DELETE FROM tbl_report_exports WHERE requested_by = $1`, [IDS.users.a1_proc_buyer]);
  if (inserted.instanceIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [inserted.instanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [inserted.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [inserted.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inserted.instanceIds]);
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
});

let PO_NO = 9_900_000;

async function grant(userId) {
  const id = await grantRoleScope(db, {
    userId, roleId: ROLE_ID, companyId: IDS.hospitality.A, hotelId: null,
  });
  inserted.scopeIds.push(id);
}

async function makePo({
  value = 1000, vendorId = IDS.users.vendor_alpha, variant = VARIANT_A,
  initiatedBy = IDS.users.a1_proc_buyer, daysAgo = 1,
}) {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1, is_published: 1, bid_end_date: oneDayAgo,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
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
     VALUES ($1,$2,$3,'approved',$4,1,100,$5,$6,$7,$8, NOW() - ($9 || ' days')::interval, NOW())
     RETURNING id, po_number`,
    [rfq_id, IDS.companies.A, `VA-PO-${++PO_NO}`, [product.id], vendorId, value,
     [quote.id], initiatedBy, String(daysAgo)]
  );
  inserted.poIds.push(po.id);
  const line = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price, product_variant_id)
     VALUES ($1,$2,$3,1,'NOS',$4,$4,$5) RETURNING id`,
    [po.id, product.id, quote.id, value, variant]
  );
  inserted.poProductIds.push(line.id);
  return po;
}

/** An approval decision on `poId`, taken by `actorId` at a given IST hour. */
async function makeDecision(poId, { actorId, action = "APPROVE", istHour = 11, comment = "ok" }) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, created_at, completed_at)
     VALUES ('PO', $1, $2, 'APPROVED', 1, $3, $4, $5, $6,
             (NOW() AT TIME ZONE 'UTC') - INTERVAL '2 hours', (NOW() AT TIME ZONE 'UTC'))
     RETURNING id`,
    [poId, POLICY_ID, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.users.a1_proc_buyer]
  );
  inserted.instanceIds.push(Number(inst.id));

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, policy_step_id, step_order, decision_rule, status, created_at, completed_at)
     VALUES ($1, $2, 1, 'ANY', 'APPROVED',
             (NOW() AT TIME ZONE 'UTC') - INTERVAL '2 hours', (NOW() AT TIME ZONE 'UTC'))
     RETURNING id`,
    [inst.id, POLICY_STEP_ID]
  );
  await db.none(
    `INSERT INTO tbl_approval_step_approvers
       (approval_instance_step_id, approver_user_id, status, created_at, acted_at)
     VALUES ($1, $2, 'APPROVED', (NOW() AT TIME ZONE 'UTC') - INTERVAL '2 hours', (NOW() AT TIME ZONE 'UTC'))`,
    [step.id, actorId]
  );

  // Stored as naive UTC; the hour given is the IST wall-clock we want the
  // report to read back, so shift by -5:30 on the way in.
  await db.none(
    `INSERT INTO tbl_approval_actions
       (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment, created_at)
     VALUES ($1, $2, $3, $4, $5,
             ((CURRENT_DATE::timestamp + ($6 || ' hours')::interval) - INTERVAL '5 hours 30 minutes'))`,
    [inst.id, step.id, actorId, action, comment, String(istHour)]
  );
  return Number(inst.id);
}

const binary = (req) =>
  req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "binary")));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

async function getReport(key) {
  const client = await httpClient(IDS.users.a1_proc_buyer);
  const res = await binary(client.post(`/api/v1/reports/${key}/download`).send({}));
  const wb = new excelJS.Workbook();
  await wb.xlsx.load(res.body);
  return wb;
}

const HEADER_FILL = "FFD9D9D9";

function headerRowOf(ws) {
  for (let r = 1; r <= ws.rowCount; r += 1) {
    const fill = ws.getRow(r).getCell(1).fill;
    if (fill && fill.fgColor && fill.fgColor.argb === HEADER_FILL) return r;
  }
  throw new Error("no header row");
}

function headersOf(ws) {
  const out = [];
  ws.getRow(headerRowOf(ws)).eachCell((c) => out.push(String(c.value ?? "")));
  return out;
}

function locate(ws, header) {
  const headerRow = headerRowOf(ws);
  let found = null;
  ws.getRow(headerRow).eachCell((cell, c) => {
    if (found === null && String(cell.value ?? "") === header) found = c;
  });
  if (found === null) throw new Error(`no column headed "${header}"`);
  return { headerRow, col: found };
}

function bodyValues(ws, header) {
  const { headerRow, col } = locate(ws, header);
  const out = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
    const first = String(ws.getRow(r).getCell(1).value ?? "").trim();
    if (first === "Total" || first === "") break;
    const v = ws.getRow(r).getCell(col).value;
    out.push(v === undefined ? null : v);
  }
  return out;
}

describe("Report 2.2 — Vendor Concentration Risk", () => {
  beforeEach(async () => { await grant(IDS.users.a1_proc_buyer); });

  it("returns the three agreed sheets", async () => {
    await makePo({ value: 1000 });
    const wb = await getReport("vendor_concentration");
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Category Risk", "Vendor Exposures", "Single-Source Items",
    ]);
  });

  it("rates a category bought from one vendor as Critical", async () => {
    await makePo({ value: 100000, vendorId: IDS.users.vendor_alpha });

    const ws = (await getReport("vendor_concentration")).getWorksheet("Category Risk");
    expect(bodyValues(ws, "Vendors")).toEqual([1]);
    expect(bodyValues(ws, "Top %")).toEqual([1]);
    // One supplier holding everything: HHI is the maximum 10,000.
    expect(bodyValues(ws, "HHI")).toEqual([10000]);
    expect(bodyValues(ws, "Rating")).toEqual(["Critical"]);
    expect(bodyValues(ws, "Single Source?")).toEqual(["Yes"]);
  });

  it("computes HHI and the top share from an actual split", async () => {
    // 75 / 25 between two vendors: HHI = 75^2 + 25^2 = 6,250.
    await makePo({ value: 75000, vendorId: IDS.users.vendor_alpha });
    await makePo({ value: 25000, vendorId: IDS.users.vendor_beta });

    const ws = (await getReport("vendor_concentration")).getWorksheet("Category Risk");
    expect(bodyValues(ws, "Vendors")).toEqual([2]);
    expect(Number(bodyValues(ws, "Top %")[0])).toBeCloseTo(0.75, 6);
    expect(bodyValues(ws, "HHI")).toEqual([6250]);
    expect(bodyValues(ws, "Rating")).toEqual(["Critical"]); // top > 60%
  });

  it("flags a vendor above 10% of total spend as board-reportable", async () => {
    await makePo({ value: 90000, vendorId: IDS.users.vendor_alpha });
    await makePo({ value: 10000, vendorId: IDS.users.vendor_beta });

    const ws = (await getReport("vendor_concentration")).getWorksheet("Vendor Exposures");
    // 90% is reportable; exactly 10% is not above the threshold.
    expect(bodyValues(ws, "Board-Reportable")).toEqual(["Yes", "—"]);
  });

  it("lists an item as single-source only while one vendor supplies it", async () => {
    await makePo({ value: 5000, variant: VARIANT_A, vendorId: IDS.users.vendor_alpha });
    await makePo({ value: 6000, variant: VARIANT_B, vendorId: IDS.users.vendor_alpha });
    await makePo({ value: 7000, variant: VARIANT_B, vendorId: IDS.users.vendor_beta });

    const ws = (await getReport("vendor_concentration")).getWorksheet("Single-Source Items");
    // VARIANT_B has two suppliers, so only VARIANT_A qualifies.
    expect(bodyValues(ws, "Spend (₹)")).toEqual([5000]);
  });
});

describe("Report 2.3 — Vendor Master Activity", () => {
  beforeEach(async () => { await grant(IDS.users.a1_proc_buyer); });

  it("has no blacklist sheet, because the platform cannot record one", async () => {
    await makePo({ value: 1000 });
    const wb = await getReport("vendor_master");
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Vendor Master", "Onboarded in Period"]);
    expect(wb.worksheets.map((w) => w.name)).not.toContain("Blacklist Log");
  });

  it("derives activity from the last order rather than a status field", async () => {
    await makePo({ value: 1000, vendorId: IDS.users.vendor_alpha, daysAgo: 5 });
    await makePo({ value: 2000, vendorId: IDS.users.vendor_beta, daysAgo: 200 });

    const ws = (await getReport("vendor_master")).getWorksheet("Vendor Master");
    const names = bodyValues(ws, "Vendor Name").map(String);
    const activity = bodyValues(ws, "Activity").map(String);

    // Ordered 5 days ago vs 200: active and dormant respectively.
    const beta = names.findIndex((n) => n.toLowerCase().includes("beta"));
    const alpha = names.findIndex((n) => n.toLowerCase().includes("alpha"));
    expect(activity[alpha]).toBe("Active");
    expect(activity[beta]).toBe("Dormant");
  });

  it("separates period spend from lifetime spend", async () => {
    await makePo({ value: 4000, vendorId: IDS.users.vendor_alpha, daysAgo: 2 });
    const ws = (await getReport("vendor_master")).getWorksheet("Vendor Master");
    expect(bodyValues(ws, "Period Spend (₹)")).toEqual([4000]);
    expect(bodyValues(ws, "Lifetime Spend (₹)")).toEqual([4000]);
  });
});

describe("Report 5.1 — Approval Audit Trail", () => {
  beforeEach(async () => { await grant(IDS.users.a1_proc_buyer); });

  it("returns the three agreed sheets", async () => {
    const po = await makePo({ value: 1000 });
    await makeDecision(po.id, { actorId: IDS.users.a1_proc_poApp, istHour: 11 });
    const wb = await getReport("approval_audit_trail");
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Event Log", "Anomalies", "Event Mix"]);
  });

  it("does NOT claim a matrix check it cannot make", async () => {
    const po = await makePo({ value: 1000 });
    await makeDecision(po.id, { actorId: IDS.users.a1_proc_poApp, istHour: 11 });

    const headers = headersOf((await getReport("approval_audit_trail")).getWorksheet("Event Log"));
    // No value-based approval matrix exists in this platform, so a column
    // asserting the order was approved at the right authority would be a
    // column that always said yes.
    expect(headers).not.toContain("Matrix OK");
    expect(headers).not.toContain("Required Lvl");
  });

  it("flags a self-approval as High severity", async () => {
    // The person who raised the order is the person who approved it.
    const po = await makePo({ value: 250000, initiatedBy: IDS.users.a1_proc_poApp });
    await makeDecision(po.id, { actorId: IDS.users.a1_proc_poApp, istHour: 11 });

    const ws = (await getReport("approval_audit_trail")).getWorksheet("Anomalies");
    expect(bodyValues(ws, "Severity")).toEqual(["High"]);
    expect(String(bodyValues(ws, "Finding")[0])).toMatch(/self-approval/i);
  });

  it("does not flag a normal working-hours decision by someone else", async () => {
    const po = await makePo({ value: 1000, initiatedBy: IDS.users.a1_proc_buyer });
    await makeDecision(po.id, { actorId: IDS.users.a1_proc_poApp, istHour: 11 });

    const ws = (await getReport("approval_audit_trail")).getWorksheet("Anomalies");
    expect(bodyValues(ws, "Severity")).toHaveLength(0);
  });

  it("flags an out-of-hours decision as Low, not as a fault", async () => {
    const po = await makePo({ value: 1000, initiatedBy: IDS.users.a1_proc_buyer });
    await makeDecision(po.id, { actorId: IDS.users.a1_proc_poApp, istHour: 23 });

    const ws = (await getReport("approval_audit_trail")).getWorksheet("Anomalies");
    // Unusual timing is where an auditor starts looking, not a breach.
    expect(bodyValues(ws, "Severity")).toEqual(["Low"]);
    expect(String(bodyValues(ws, "Finding")[0])).toMatch(/outside working hours \(23:00 IST\)/i);
  });

  it("raises TWO findings for an event that is both self-approved and out of hours", async () => {
    const po = await makePo({ value: 500000, initiatedBy: IDS.users.a1_proc_poApp });
    await makeDecision(po.id, { actorId: IDS.users.a1_proc_poApp, istHour: 2 });

    const ws = (await getReport("approval_audit_trail")).getWorksheet("Anomalies");
    // Two separate things to chase, so two separate lines — High first.
    expect(bodyValues(ws, "Severity")).toEqual(["High", "Low"]);
  });

  it("summarises the decision mix", async () => {
    const a = await makePo({ value: 1000 });
    const b = await makePo({ value: 2000 });
    await makeDecision(a.id, { actorId: IDS.users.a1_proc_poApp, action: "APPROVE", istHour: 10 });
    await makeDecision(b.id, { actorId: IDS.users.a1_proc_poApp, action: "REJECT", istHour: 10 });

    const ws = (await getReport("approval_audit_trail")).getWorksheet("Event Mix");
    const labels = bodyValues(ws, "Decision").map(String);
    expect(labels.sort()).toEqual(["Approved", "Rejected"]);
    expect(bodyValues(ws, "Count")).toEqual([1, 1]);
  });
});
