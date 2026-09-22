// Report 3.3 — Rejected PO Log, and the misreading it exists to avoid.
// ----------------------------------------------------------------------------
// The platform wrote a cancellation as action 'REJECT' with a '[CANCELLED]'
// comment prefix. Count REJECT actions on prod and you get 69 "rejections";
// 22 of them are closed RFQs, and the real number is 47. Both this report and
// the Approval Audit Trail (5.1) must keep the two apart, and must do it for
// history written in the old shape as well as new rows written as CANCELLED.
//
// Two further traps, both found on prod data and both pinned here:
//
//   * "Re-raised" means a later PO orders the SAME items. Matching on the same
//     RFQ and vendor instead reports 29 of 47 rejections as re-raised; the
//     truth is 5, because one RFQ yields several POs to one vendor for
//     different items.
//   * A PO marked rejected with no decision on record (staging's seeded demo
//     rows) is listed as "Not recorded", not silently dropped.
//
// Access is the other half: the log names approvers and quotes them, so it is
// admin-only, and the 183-user Report Download role must not reach it.

import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach } from "@jest/globals";
import excelJS from "exceljs";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";

const BUYER = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_poApp;

let VARIANTS = [1, 2];
let ROLE_ID = null;         // reports.po_rejections + reports.approval_audit_trail
let POLICY_ID = null;
let POLICY_STEP_ID = null;

beforeAll(async () => {
  const vs = await db.any(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 2`);
  if (vs.length === 2) VARIANTS = vs.map((v) => v.id);

  const r = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by)
     VALUES ('TEST Reports — rejections', 'test-only role', $1) RETURNING id`,
    [IDS.users.superAdmin]
  );
  ROLE_ID = Number(r.id);
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, id FROM tbl_permissions
      WHERE resource::text = 'reports'
        AND action::text IN ('po_rejections', 'approval_audit_trail')`,
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
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ANY', 'USER', $2) RETURNING id`,
    [POLICY_ID, APPROVER]
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

const made = {
  rfqIds: [], poIds: [], rfqProductIds: [], quoteIds: [], instanceIds: [], scopeIds: [],
};
beforeEach(() => { for (const k of Object.keys(made)) made[k] = []; });

afterEach(async () => {
  await revokeRoleScopes(db, made.scopeIds);
  await db.none(`DELETE FROM tbl_report_exports WHERE requested_by = ANY($1::int[])`,
    [[BUYER, IDS.users.companyB_admin]]);
  if (made.instanceIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [made.instanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [made.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [made.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [made.instanceIds]);
  }
  if (made.poIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [made.poIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type='PO' AND entity_id = ANY($1::int[])`, [made.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [made.poIds]);
  }
  if (made.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [made.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [made.quoteIds]);
  }
  if (made.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [made.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [made.rfqProductIds]);
  }
  if (made.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [made.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [made.rfqIds]);
  }
});

let PO_NO = 9_960_000;

async function grant(userId, roleId = ROLE_ID, hospitality = IDS.hospitality.A) {
  const id = await grantRoleScope(db, { userId, roleId, companyId: hospitality, hotelId: null });
  made.scopeIds.push(id);
}

/** An RFQ with `n` items, each its own rfq_products row. */
async function rfqWithItems(n = 1) {
  const yesterday = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER, status: 1, is_published: 1, bid_end_date: yesterday,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    department: IDS.departments.proc, process: IDS.processes.A_P1,
  });
  made.rfqIds.push(rfq_id);
  const items = [];
  for (let k = 0; k < n; k += 1) {
    const p = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1,'Spec','','','','',$2,0) RETURNING id`,
      [rfq_id, VARIANTS[k % VARIANTS.length]]
    );
    made.rfqProductIds.push(p.id);
    items.push(Number(p.id));
  }
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1,$2,$3,0)`,
    [rfq_id, VARIANTS[0], IDS.users.vendor_alpha]
  );
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1,$2,$3,$3) RETURNING id`,
    [rfq_id, rfq_no, IDS.users.vendor_alpha]
  );
  made.quoteIds.push(q.id);
  return { rfq_id, items, quote_id: Number(q.id) };
}

/** A PO ordering `itemIds`, raised `ageMinutes` ago. */
async function makePo(rfq, { status, itemIds, value = 5000, ageMinutes = 60, extra = {} }) {
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by,
        vendor_rejection_reason, vendor_action_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,1,100,$6,$7,$8,$9,$10,$11,
             NOW() - ($12 || ' minutes')::interval, NOW())
     RETURNING id, po_number`,
    [rfq.rfq_id, IDS.companies.A, `REJ-PO-${++PO_NO}`, status, itemIds.slice(0, 1),
     IDS.users.vendor_alpha, value, [rfq.quote_id], extra.initiatedBy || BUYER,
     extra.vendorReason || null, extra.vendorReason ? new Date() : null, String(ageMinutes)]
  );
  made.poIds.push(Number(po.id));
  for (const item of itemIds) {
    await db.none(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
       VALUES ($1,$2,$3,1,'NOS',$4,$4)`,
      [po.id, item, rfq.quote_id, value / itemIds.length]
    );
  }
  return { id: Number(po.id), po_number: po.po_number };
}

/**
 * The decision record on a PO. `action` is what lands in tbl_approval_actions;
 * `instanceStatus` what the instance concluded as.
 */
async function decide(poId, { action, instanceStatus, comment, actor = APPROVER, istHour = 11 }) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, created_at, completed_at)
     VALUES ('PO', $1, $2, $3, 1, $4, $5, $6, $7,
             (NOW() AT TIME ZONE 'UTC') - INTERVAL '3 hours', (NOW() AT TIME ZONE 'UTC'))
     RETURNING id`,
    [poId, POLICY_ID, instanceStatus, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, BUYER]
  );
  made.instanceIds.push(Number(inst.id));
  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, policy_step_id, step_order, decision_rule, status, created_at, completed_at)
     VALUES ($1, $2, 1, 'ANY', $3, (NOW() AT TIME ZONE 'UTC') - INTERVAL '3 hours', (NOW() AT TIME ZONE 'UTC'))
     RETURNING id`,
    [inst.id, POLICY_STEP_ID, instanceStatus]
  );
  await db.none(
    `INSERT INTO tbl_approval_actions
       (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment, created_at)
     VALUES ($1, $2, $3, $4, $5,
             ((CURRENT_DATE::timestamp + ($6 || ' hours')::interval) - INTERVAL '5 hours 30 minutes'))`,
    [inst.id, action === "CANCELLED" || String(comment).startsWith("[CANCELLED]") ? null : step.id,
     actor, action, comment, String(istHour)]
  );
  return Number(inst.id);
}

const binary = (req) =>
  req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "binary")));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

async function download(key, userId = BUYER) {
  const client = await httpClient(userId);
  const res = await binary(client.post(`/api/v1/reports/${key}/download`).send({}));
  if (res.status !== 200) return { res, wb: null };
  const wb = new excelJS.Workbook();
  await wb.xlsx.load(res.body);
  return { res, wb };
}

const HEADER_FILL = "FFD9D9D9";
function headerRowOf(ws) {
  for (let r = 1; r <= ws.rowCount; r += 1) {
    const fill = ws.getRow(r).getCell(1).fill;
    if (fill && fill.fgColor && fill.fgColor.argb === HEADER_FILL) return r;
  }
  throw new Error(`no header row on ${ws.name}`);
}
function column(ws, header) {
  const hr = headerRowOf(ws);
  let col = null;
  ws.getRow(hr).eachCell((c, i) => { if (col === null && String(c.value ?? "") === header) col = i; });
  if (col === null) throw new Error(`no column "${header}" on ${ws.name}`);
  const out = [];
  for (let r = hr + 1; r <= ws.rowCount; r += 1) {
    const first = String(ws.getRow(r).getCell(1).value ?? "").trim();
    if (first === "Total" || first === "") break;
    const v = ws.getRow(r).getCell(col).value;
    out.push(v === undefined ? null : v);
  }
  return out;
}

// ============================================================================

describe("Report 3.3 — Rejected PO Log", () => {
  beforeEach(async () => { await grant(BUYER); });

  it("returns the summary, one sheet per kind, and the two roll-ups", async () => {
    const rfq = await rfqWithItems(1);
    const po = await makePo(rfq, { status: "rejected", itemIds: rfq.items });
    await decide(po.id, { action: "REJECT", instanceStatus: "REJECTED", comment: "rate too high" });

    const { wb } = await download("po_rejections");
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Summary", "Rejected by Approver", "Cancelled", "Rejected by Vendor", "By Approver", "By Business Unit",
    ]);
  });

  it("records who rejected it, at which step, and the reason they gave", async () => {
    const rfq = await rfqWithItems(1);
    const po = await makePo(rfq, { status: "rejected", itemIds: rfq.items, value: 42000 });
    await decide(po.id, { action: "REJECT", instanceStatus: "REJECTED", comment: "vendor not empanelled" });

    const ws = (await download("po_rejections")).wb.getWorksheet("Rejected by Approver");
    expect(column(ws, "PO Number")).toEqual([po.po_number]);
    expect(column(ws, "PO Value (₹)")).toEqual([42000]);
    expect(column(ws, "Step")).toEqual(["L1"]);
    expect(column(ws, "Reason")).toEqual(["vendor not empanelled"]);
    const who = await db.one(`SELECT name FROM tbl_users WHERE id = $1`, [APPROVER]);
    expect(column(ws, "Rejected By")).toEqual([who.name]);
  });

  it("files a cancellation logged the OLD way under Cancelled, not under Rejected", async () => {
    // History before the fix: action REJECT, '[CANCELLED]' comment, PO left at
    // pending_approval with nothing pending behind it.
    const rfq = await rfqWithItems(1);
    const po = await makePo(rfq, { status: "pending_approval", itemIds: rfq.items });
    await decide(po.id, {
      action: "REJECT", instanceStatus: "CANCELLED",
      comment: "[CANCELLED] RFQ closed by creator: configuration does not match", actor: BUYER,
    });

    const { wb } = await download("po_rejections");
    expect(column(wb.getWorksheet("Rejected by Approver"), "PO Number")).toEqual([]);
    expect(column(wb.getWorksheet("Cancelled"), "PO Number")).toEqual([po.po_number]);
    // The mechanical prefix is stripped; the human reason is kept.
    expect(column(wb.getWorksheet("Cancelled"), "Reason")).toEqual([
      "RFQ closed by creator: configuration does not match",
    ]);
  });

  it("files a cancellation written the NEW way under Cancelled too", async () => {
    const rfq = await rfqWithItems(1);
    const po = await makePo(rfq, { status: "cancelled", itemIds: rfq.items });
    await decide(po.id, {
      action: "CANCELLED", instanceStatus: "CANCELLED",
      comment: "[CANCELLED] RFQ closed by creator: budget moved", actor: BUYER,
    });

    const { wb } = await download("po_rejections");
    expect(column(wb.getWorksheet("Cancelled"), "PO Number")).toEqual([po.po_number]);
    expect(column(wb.getWorksheet("Rejected by Approver"), "PO Number")).toEqual([]);
  });

  it("lists a vendor's refusal with the vendor's own reason", async () => {
    const rfq = await rfqWithItems(1);
    const po = await makePo(rfq, {
      status: "rejected_by_vendor", itemIds: rfq.items, extra: { vendorReason: "cannot meet delivery date" },
    });

    const ws = (await download("po_rejections")).wb.getWorksheet("Rejected by Vendor");
    expect(column(ws, "PO Number")).toEqual([po.po_number]);
    expect(column(ws, "Vendor's Reason")).toEqual(["cannot meet delivery date"]);
  });

  it("RECONCILES: the summary counts are the per-kind sheets", async () => {
    const rfq = await rfqWithItems(1);
    const a = await makePo(rfq, { status: "rejected", itemIds: rfq.items, value: 1000 });
    await decide(a.id, { action: "REJECT", instanceStatus: "REJECTED", comment: "no" });
    const b = await makePo(rfq, { status: "rejected", itemIds: rfq.items, value: 2000 });
    await decide(b.id, { action: "REJECT", instanceStatus: "REJECTED", comment: "no again" });
    const c = await makePo(rfq, { status: "pending_approval", itemIds: rfq.items, value: 4000 });
    await decide(c.id, { action: "REJECT", instanceStatus: "CANCELLED", comment: "[CANCELLED] RFQ closed by creator", actor: BUYER });

    const ws = (await download("po_rejections")).wb.getWorksheet("Summary");
    expect(column(ws, "Kind")).toEqual(["Rejected by approver", "Cancelled", "Rejected by vendor"]);
    // Two rejections, one cancellation — not three rejections.
    expect(column(ws, "POs")).toEqual([2, 1, 0]);
    expect(column(ws, "PO Value (₹)")).toEqual([3000, 4000, 0]);
  });

  it("calls it re-raised only when a later PO orders the SAME items", async () => {
    const rfq = await rfqWithItems(2);
    const [itemA, itemB] = rfq.items;

    const rejected = await makePo(rfq, { status: "rejected", itemIds: [itemA], ageMinutes: 300 });
    await decide(rejected.id, { action: "REJECT", instanceStatus: "REJECTED", comment: "rate" });

    // Same RFQ, same vendor, but a DIFFERENT item. On prod, matching on RFQ
    // and vendor reads this as a re-raise and inflates 5 into 29.
    await makePo(rfq, { status: "approved", itemIds: [itemB], ageMinutes: 200 });
    let ws = (await download("po_rejections")).wb.getWorksheet("Rejected by Approver");
    expect(column(ws, "Re-raised As")).toEqual(["Not re-raised"]);

    // Now a PO that orders the rejected item again.
    const reissue = await makePo(rfq, { status: "approved", itemIds: [itemA, itemB], ageMinutes: 100 });
    ws = (await download("po_rejections")).wb.getWorksheet("Rejected by Approver");
    expect(column(ws, "Re-raised As")).toEqual([reissue.po_number]);
    expect(column(ws, "Re-raised Status")).toEqual(["approved"]);
  });

  it("keeps a rejected PO with no decision on record, marked as not recorded", async () => {
    const rfq = await rfqWithItems(1);
    const po = await makePo(rfq, { status: "rejected", itemIds: rfq.items });

    const ws = (await download("po_rejections")).wb.getWorksheet("Rejected by Approver");
    expect(column(ws, "PO Number")).toEqual([po.po_number]);
    expect(column(ws, "Rejected By")).toEqual(["Not recorded"]);
  });

  it("does not show one company's rejections to another", async () => {
    const rfq = await rfqWithItems(1);
    const po = await makePo(rfq, { status: "rejected", itemIds: rfq.items });
    await decide(po.id, { action: "REJECT", instanceStatus: "REJECTED", comment: "company A only" });

    await grant(IDS.users.companyB_admin, ROLE_ID, IDS.hospitality.B);
    const { wb } = await download("po_rejections", IDS.users.companyB_admin);
    expect(column(wb.getWorksheet("Rejected by Approver"), "PO Number")).not.toContain(po.po_number);
  });
});

describe("Report 3.3 — access", () => {
  it("is not reachable through the Report Download role", async () => {
    const rd = await db.one(
      `SELECT id FROM tbl_roles WHERE title = 'Report Download' AND created_by IS NULL`
    );
    await grant(BUYER, Number(rd.id));

    const client = await httpClient(BUYER);
    const cat = await client.get("/api/v1/reports/catalogue");
    const keys = cat.body.data.reports.map((r) => r.key);

    // Report Download reaches the commercial reports...
    expect(keys).toContain("spend_by_vendor");
    // ...and neither of the two that name individuals.
    expect(keys).not.toContain("po_rejections");
    expect(keys).not.toContain("approval_audit_trail");

    const res = await client.post("/api/v1/reports/po_rejections/download").send({});
    expect(res.status).toBe(403);
  });
});

describe("Report 5.1 — a cancellation is not a rejection", () => {
  beforeEach(async () => { await grant(BUYER); });

  it("labels an old-shape cancellation 'Cancelled' in the event log and the mix", async () => {
    const rfq = await rfqWithItems(1);
    const po = await makePo(rfq, { status: "pending_approval", itemIds: rfq.items });
    await decide(po.id, {
      action: "REJECT", instanceStatus: "CANCELLED",
      comment: "[CANCELLED] RFQ closed by creator: not required", actor: BUYER,
    });

    const { wb } = await download("approval_audit_trail");
    expect(column(wb.getWorksheet("Event Log"), "Decision")).toEqual(["Cancelled"]);
    expect(column(wb.getWorksheet("Event Log"), "Comment")).toEqual(["RFQ closed by creator: not required"]);
    expect(column(wb.getWorksheet("Event Mix"), "Decision")).toEqual(["Cancelled"]);
  });

  it("does not flag someone rejecting their own PO as a self-approval", async () => {
    const rfq = await rfqWithItems(1);
    const po = await makePo(rfq, { status: "rejected", itemIds: rfq.items, extra: { initiatedBy: APPROVER } });
    await decide(po.id, { action: "REJECT", instanceStatus: "REJECTED", comment: "withdrawing my own", actor: APPROVER });

    // Rejecting your own order is not a segregation-of-duties breach.
    const { wb } = await download("approval_audit_trail");
    expect(column(wb.getWorksheet("Anomalies"), "Severity")).toEqual([]);
  });

  it("still flags someone approving their own PO", async () => {
    const rfq = await rfqWithItems(1);
    const po = await makePo(rfq, { status: "approved", itemIds: rfq.items, extra: { initiatedBy: APPROVER } });
    await decide(po.id, { action: "APPROVE", instanceStatus: "APPROVED", comment: "ok", actor: APPROVER });

    const { wb } = await download("approval_audit_trail");
    expect(column(wb.getWorksheet("Anomalies"), "Severity")).toEqual(["High"]);
  });
});
