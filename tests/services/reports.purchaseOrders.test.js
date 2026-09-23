// Reports 3.1 (Open PO Register), 3.2 (PO Aging by Approver) and
// 6.1 (PO Approval TAT).
// ----------------------------------------------------------------------------
// These three report on operational state rather than spend, so the assertions
// are about DEFINITIONS rather than totals — and each of the three definitions
// below is one somebody could reasonably have got wrong:
//
//   • "Open" is a status set, and it excludes drafts and anything awaiting
//     approval. An order nobody has approved is not an open commitment.
//   • A step that any one of several people may approve lists ALL of them.
//     Until somebody acts, each is equally the reason it has not moved.
//   • A step with no SLA is UNMEASURED — not compliant, not in breach. The
//     alternative, defaulting to some plausible number of hours, reports most
//     of the company as late off a target nobody set.
//
// Approval rows are inserted directly rather than driven through the approval
// engine: these tests are about how the report reads the rows, and direct
// inserts give exact control over the timestamps the whole report turns on.

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
let POLICY_ID = null;
let POLICY_STEP_SLA = null;   // sla_hours = 4
let POLICY_STEP_NO_SLA = null;

beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT_ID = v.id;

  const r = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by)
     VALUES ('TEST Reports — purchase orders', 'test-only role', $1) RETURNING id`,
    [IDS.users.superAdmin]
  );
  ROLE_ID = Number(r.id);
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, id FROM tbl_permissions
      WHERE resource::text = 'reports'
        AND action::text IN ('open_po_register', 'po_aging_by_approver', 'po_approval_tat')`,
    [ROLE_ID]
  );

  // A policy with two steps: one carrying an SLA, one deliberately without,
  // so "unmeasured" is testable alongside "breached".
  const pol = await db.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by)
     VALUES ('PO', $1, $2, $3, true, $4) RETURNING id`,
    [IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.users.superAdmin]
  );
  POLICY_ID = Number(pol.id);
  const s1 = await db.one(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id, sla_hours)
     VALUES ($1, 1, 'ANY', 'USER', $2, 4) RETURNING id`,
    [POLICY_ID, IDS.users.a1_proc_poApp]
  );
  POLICY_STEP_SLA = Number(s1.id);
  const s2 = await db.one(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id, sla_hours)
     VALUES ($1, 2, 'ANY', 'USER', $2, NULL) RETURNING id`,
    [POLICY_ID, IDS.users.a1_proc_finance]
  );
  POLICY_STEP_NO_SLA = Number(s2.id);
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

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

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

let PO_NO = 9_700_000;

async function grant(userId) {
  const id = await grantRoleScope(db, {
    userId, roleId: ROLE_ID, companyId: IDS.hospitality.A, hotelId: null,
  });
  inserted.scopeIds.push(id);
}

async function makePo({ status = "approved", value = 1000, daysAgo = 1, hotel = IDS.hotels.A1 }) {
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
    [rfq_id, VARIANT_ID, IDS.users.vendor_alpha]
  );
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1,$2,$3,$3) RETURNING id`,
    [rfq_id, rfq_no, IDS.users.vendor_alpha]
  );
  inserted.quoteIds.push(quote.id);

  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,1,100,$6,$7,$8,$9, NOW() - ($10 || ' days')::interval, NOW())
     RETURNING id, po_number`,
    [rfq_id, IDS.companies.A, `PO-RPT-${++PO_NO}`, status, [product.id], IDS.users.vendor_alpha,
     value, [quote.id], IDS.users.a1_proc_buyer, String(daysAgo)]
  );
  inserted.poIds.push(po.id);
  const line = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price, product_variant_id)
     VALUES ($1,$2,$3,1,'NOS',$4,$4,$5) RETURNING id`,
    [po.id, product.id, quote.id, value, VARIANT_ID]
  );
  inserted.poProductIds.push(line.id);
  return po;
}

/**
 * An approval instance on `poId`.
 *
 * `openedHoursAgo` sets when the step opened; `actedHoursAgo` (null = still
 * pending) when the approver decided. Both are written as naive UTC, matching
 * how the approval engine stores them.
 */
async function makeApproval(poId, {
  approvers, policyStepId = POLICY_STEP_SLA, stepOrder = 1,
  openedHoursAgo = 10, actedHoursAgo = null, instanceStatus = "PENDING",
}) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, created_at, completed_at)
     VALUES ('PO', $1, $2, $3, $4, $5, $6, $7, $8,
             (NOW() AT TIME ZONE 'UTC') - ($9 || ' hours')::interval,
             CASE WHEN $10::text IS NULL THEN NULL
                  ELSE (NOW() AT TIME ZONE 'UTC') - ($10 || ' hours')::interval END)
     RETURNING id`,
    [poId, POLICY_ID, instanceStatus, stepOrder, IDS.hospitality.A, IDS.hotels.A1,
     IDS.departments.proc, IDS.users.a1_proc_buyer, String(openedHoursAgo),
     actedHoursAgo === null ? null : String(actedHoursAgo)]
  );
  inserted.instanceIds.push(Number(inst.id));

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, policy_step_id, step_order, decision_rule, status, created_at, completed_at)
     VALUES ($1, $2, $3, 'ANY', $4,
             (NOW() AT TIME ZONE 'UTC') - ($5 || ' hours')::interval,
             CASE WHEN $6::text IS NULL THEN NULL
                  ELSE (NOW() AT TIME ZONE 'UTC') - ($6 || ' hours')::interval END)
     RETURNING id`,
    [inst.id, policyStepId, stepOrder, actedHoursAgo === null ? "PENDING" : "APPROVED",
     String(openedHoursAgo), actedHoursAgo === null ? null : String(actedHoursAgo)]
  );

  for (const userId of approvers) {
    await db.none(
      `INSERT INTO tbl_approval_step_approvers
         (approval_instance_step_id, approver_user_id, status, created_at, acted_at)
       VALUES ($1, $2, $3,
               (NOW() AT TIME ZONE 'UTC') - ($4 || ' hours')::interval,
               CASE WHEN $5::text IS NULL THEN NULL
                    ELSE (NOW() AT TIME ZONE 'UTC') - ($5 || ' hours')::interval END)`,
      [step.id, userId, actedHoursAgo === null ? "PENDING" : "APPROVED",
       String(openedHoursAgo), actedHoursAgo === null ? null : String(actedHoursAgo)]
    );
  }
  return { instanceId: Number(inst.id), stepId: Number(step.id) };
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

/**
 * The grid's header row — the first row carrying the header fill.
 *
 * Scanning for the label alone is not enough: the parameters block above the
 * grid explains some columns and therefore repeats their names in column A
 * ("Bottleneck Index", "SLA"). A naive search matches that prose row first and
 * then reads the rest of the parameters block as data.
 */
function headerRowOf(ws) {
  for (let r = 1; r <= ws.rowCount; r += 1) {
    const fill = ws.getRow(r).getCell(1).fill;
    if (fill && fill.fgColor && fill.fgColor.argb === HEADER_FILL) return r;
  }
  throw new Error("no header row (no cell carries the header fill)");
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

/**
 * The body cells under `header`.
 *
 * Stops at the total row OR at the first blank first-column cell — a sheet
 * with no total row is followed by a spacer and then the footer, and walking
 * into those reads provenance lines as data.
 */
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

/** Only the rows whose `keyHeader` cell matches `keyValue`. */
function rowWhere(ws, keyHeader, keyValue, wantedHeader) {
  const keys = bodyValues(ws, keyHeader);
  const wanted = bodyValues(ws, wantedHeader);
  const idx = keys.findIndex((k) => String(k) === String(keyValue));
  return idx === -1 ? undefined : wanted[idx];
}

describe("Report 3.1 — Open PO Register", () => {
  beforeEach(async () => { await grant(IDS.users.a1_proc_buyer); });

  it("returns the three agreed sheets", async () => {
    await makePo({ status: "approved" });
    const wb = await getReport("open_po_register");
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Open POs", "Aging Summary", "90+ Days"]);
  });

  it("counts an order as open only once it is actually raised", async () => {
    const open = await makePo({ status: "approved", value: 5000 });
    await makePo({ status: "draft", value: 6000 });
    await makePo({ status: "pending_approval", value: 7000 });
    await makePo({ status: "rejected", value: 8000 });
    await makePo({ status: "completed", value: 9000 });

    const ws = (await getReport("open_po_register")).getWorksheet("Open POs");
    const numbers = bodyValues(ws, "PO Number").map(String);

    // A draft or an unapproved order is not an open commitment; a completed
    // one is no longer outstanding.
    expect(numbers).toEqual([open.po_number]);
    expect(bodyValues(ws, "PO Value (₹)")).toEqual([5000]);
  });

  it("buckets by age and says Days Open, not Days Overdue", async () => {
    await makePo({ status: "approved", daysAgo: 5, value: 100 });
    await makePo({ status: "approved", daysAgo: 45, value: 200 });
    await makePo({ status: "approved", daysAgo: 120, value: 300 });

    const wb = await getReport("open_po_register");
    const ws = wb.getWorksheet("Open POs");

    // The header must not promise a deadline the platform never recorded.
    expect(() => locate(ws, "Days Open")).not.toThrow();
    expect(() => locate(ws, "Days Overdue")).toThrow();

    expect(bodyValues(ws, "Ageing").sort()).toEqual(["0-15", "31-60", "90+"]);
    expect(bodyValues(wb.getWorksheet("90+ Days"), "PO Value (₹)")).toEqual([300]);
  });

  it("summarises count and value by bucket", async () => {
    await makePo({ status: "approved", daysAgo: 2, value: 1000 });
    await makePo({ status: "approved", daysAgo: 3, value: 3000 });

    const ws = (await getReport("open_po_register")).getWorksheet("Aging Summary");
    expect(rowWhere(ws, "Ageing Bucket", "0-15 days", "PO Count")).toBe(2);
    expect(rowWhere(ws, "Ageing Bucket", "0-15 days", "Open Value (₹)")).toBe(4000);
    expect(rowWhere(ws, "Ageing Bucket", "16-30 days", "PO Count")).toBe(0);
  });
});

describe("Report 3.2 — PO Aging by Approver", () => {
  beforeEach(async () => { await grant(IDS.users.a1_proc_buyer); });

  it("lists EVERY approver who could act on an ANY step", async () => {
    const po = await makePo({ status: "pending_approval", value: 50000 });
    await makeApproval(po.id, {
      approvers: [IDS.users.a1_proc_poApp, IDS.users.a1_proc_finance],
      openedHoursAgo: 2,
    });

    const ws = (await getReport("po_aging_by_approver")).getWorksheet("Pending Queue");
    // Two rows for one PO: until one of them acts, each is equally the reason.
    expect(bodyValues(ws, "PO Number").filter((n) => n === po.po_number)).toHaveLength(2);
    expect(bodyValues(ws, "Rule")).toEqual(["ANY", "ANY"]);
  });

  it("reports a breach against the configured SLA", async () => {
    const po = await makePo({ status: "pending_approval", value: 20000 });
    // SLA on this step is 4 hours; it has been waiting 10.
    await makeApproval(po.id, {
      approvers: [IDS.users.a1_proc_poApp], policyStepId: POLICY_STEP_SLA, openedHoursAgo: 10,
    });

    const wb = await getReport("po_aging_by_approver");
    const ws = wb.getWorksheet("Pending Queue");
    expect(bodyValues(ws, "SLA (hrs)")).toEqual([4]);
    expect(Number(bodyValues(ws, "Breach By (hrs)")[0])).toBeCloseTo(6, 0);
    expect(bodyValues(wb.getWorksheet("SLA Breaches"), "PO Number")).toEqual([po.po_number]);
  });

  it("treats a step with no SLA as unmeasured, NOT as compliant or breached", async () => {
    const po = await makePo({ status: "pending_approval", value: 30000 });
    await makeApproval(po.id, {
      approvers: [IDS.users.a1_proc_finance], policyStepId: POLICY_STEP_NO_SLA,
      stepOrder: 2, openedHoursAgo: 500,
    });

    const wb = await getReport("po_aging_by_approver");
    const ws = wb.getWorksheet("Pending Queue");

    // 500 hours pending, and still not a breach — because nobody ever set a
    // target. Defaulting to one would invent the breach.
    expect(bodyValues(ws, "SLA (hrs)")).toEqual([null]);
    expect(bodyValues(ws, "Breach By (hrs)")).toEqual([null]);
    expect(bodyValues(wb.getWorksheet("SLA Breaches"), "PO Number")).toHaveLength(0);
    expect(rowWhere(wb.getWorksheet("By Approver"), "Approver", null, "Measured")).toBeUndefined();
  });

  it("does not put a total on PO value in the queue, because rows repeat", async () => {
    const po = await makePo({ status: "pending_approval", value: 50000 });
    await makeApproval(po.id, {
      approvers: [IDS.users.a1_proc_poApp, IDS.users.a1_proc_finance], openedHoursAgo: 1,
    });

    const ws = (await getReport("po_aging_by_approver")).getWorksheet("Pending Queue");
    // Summing a column that repeats one PO across two approver rows would
    // report Rs 1,00,000 of pending value where there is Rs 50,000.
    let hasTotal = false;
    for (let r = 1; r <= ws.rowCount; r += 1) {
      if (String(ws.getRow(r).getCell(1).value ?? "") === "Total") hasTotal = true;
    }
    expect(hasTotal).toBe(false);
  });
});

describe("Report 6.1 — PO Approval TAT", () => {
  beforeEach(async () => { await grant(IDS.users.a1_proc_buyer); });

  it("returns the three agreed sheets", async () => {
    const po = await makePo({ status: "approved" });
    await makeApproval(po.id, {
      approvers: [IDS.users.a1_proc_poApp], openedHoursAgo: 10, actedHoursAgo: 8,
      instanceStatus: "APPROVED",
    });
    const wb = await getReport("po_approval_tat");
    expect(wb.worksheets.map((w) => w.name)).toEqual(["TAT by Value", "By Approver", "By Stage"]);
  });

  it("measures completed approvals and ignores what is still pending", async () => {
    const done = await makePo({ status: "approved", value: 50000 });
    await makeApproval(done.id, {
      approvers: [IDS.users.a1_proc_poApp], openedHoursAgo: 10, actedHoursAgo: 8,
      instanceStatus: "APPROVED",
    });
    const stuck = await makePo({ status: "pending_approval", value: 60000 });
    await makeApproval(stuck.id, { approvers: [IDS.users.a1_proc_poApp], openedHoursAgo: 900 });

    const ws = (await getReport("po_approval_tat")).getWorksheet("TAT by Value");
    // One completed approval of Rs 50,000, and a 2-hour turnaround. The order
    // stuck for 900 hours must not drag this — it has no turnaround yet.
    expect(rowWhere(ws, "Value Band", "Routine (≤ ₹1 L)", "Approvals")).toBe(1);
    expect(Number(rowWhere(ws, "Value Band", "Routine (≤ ₹1 L)", "Avg TAT (hrs)"))).toBeCloseTo(2, 0);
    expect(rowWhere(ws, "Value Band", "Routine (≤ ₹1 L)", "Value Approved (₹)")).toBe(50000);
  });

  it("files each approval into its value band", async () => {
    const small = await makePo({ status: "approved", value: 50000 });
    await makeApproval(small.id, {
      approvers: [IDS.users.a1_proc_poApp], openedHoursAgo: 6, actedHoursAgo: 5, instanceStatus: "APPROVED",
    });
    const big = await makePo({ status: "approved", value: 3000000 });
    await makeApproval(big.id, {
      approvers: [IDS.users.a1_proc_poApp], openedHoursAgo: 30, actedHoursAgo: 6, instanceStatus: "APPROVED",
    });

    const ws = (await getReport("po_approval_tat")).getWorksheet("TAT by Value");
    expect(rowWhere(ws, "Value Band", "Routine (≤ ₹1 L)", "Approvals")).toBe(1);
    expect(rowWhere(ws, "Value Band", "Capex (> ₹25 L)", "Approvals")).toBe(1);
    expect(rowWhere(ws, "Value Band", "Mid value (₹1–5 L)", "Approvals")).toBe(0);
  });

  it("computes the bottleneck index against the step's SLA", async () => {
    const po = await makePo({ status: "approved", value: 10000 });
    // SLA 4 hours, took 8 — an index of 2.00.
    await makeApproval(po.id, {
      approvers: [IDS.users.a1_proc_poApp], policyStepId: POLICY_STEP_SLA,
      openedHoursAgo: 12, actedHoursAgo: 4, instanceStatus: "APPROVED",
    });

    const ws = (await getReport("po_approval_tat")).getWorksheet("By Stage");
    expect(rowWhere(ws, "Step", "L1", "SLA (hrs)")).toBe(4);
    expect(Number(rowWhere(ws, "Step", "L1", "Bottleneck Index"))).toBeCloseTo(2, 1);
  });

  it("leaves Within SLA blank where the step has no target", async () => {
    const po = await makePo({ status: "approved", value: 10000 });
    await makeApproval(po.id, {
      approvers: [IDS.users.a1_proc_finance], policyStepId: POLICY_STEP_NO_SLA, stepOrder: 2,
      openedHoursAgo: 40, actedHoursAgo: 1, instanceStatus: "APPROVED",
    });

    const wb = await getReport("po_approval_tat");
    expect(bodyValues(wb.getWorksheet("By Approver"), "Within SLA %")).toEqual([null]);
    expect(bodyValues(wb.getWorksheet("By Stage"), "Bottleneck Index")).toEqual([null]);
  });
});
