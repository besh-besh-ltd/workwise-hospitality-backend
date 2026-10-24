// Line-level GRN (Task B1): receive against a PO's delivery plan, at one
// hotel, with partial delivery, rejection, over-receipt tolerance, unit
// conversion, expiry, mark-out on arrival, reversal, replay and the legacy
// one-click markGRN.
//
// Everything goes through HTTP (the full middleware stack: auth, Joi, the
// controller, one committed transaction per request) except the concurrency
// and site-rep token cases, which call the service directly. Data is
// committed: the suite truncates the dynamic tables before and after, and
// every PO line uses its own catalogue variant so stock items and balances
// never collide between tests.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { randomUUID } from "crypto";
import { db, closeDb, truncateDynamic } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import {
  postGrn, getGrn, saveGrnDraft, postLegacyFullReceipt, SITE_REP_ACTOR,
} from "../../app/services/inventory/grnService.js";
import { setUomFactor } from "../../app/services/inventory/uom.js";
import { resolveItemForVariant } from "../../app/services/inventory/items.js";
import { ensureDefaultPlan } from "../../app/services/inventory/planCore.js";
import { postMovements } from "../../app/services/inventory/ledger.js";
import { hotelIdsWithPermission } from "../../app/services/inventory/scope.js";

const CO = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const B1 = IDS.hotels.B1;
const FB = IDS.departments.fb;

const BUYER = IDS.users.a1_proc_buyer; // owns the RFQs; legacy markGRN caller
const RECV = IDS.users.a1_proc_techEval; // Storekeeper at A1 + A2
const LIMITED = IDS.users.a1_eng_buyer; // grn read/create/update at A1 only
const CTRL = IDS.users.multiHotel; // Inventory Controller, company-wide (grn.approve)
const FOREIGN = IDS.users.companyB_admin;
const VENDOR = IDS.users.vendor_alpha;

let recv, limited, ctrl, buyer, foreign;
let variants = [];
let nextVariantIdx = 0;
let TODAY;
const scopeIds = [];
const madeRoles = [];
const madeArc = { mr: [], line: [], contract: [], item: [], arc: [] };

const nextVariant = () => {
  const v = variants[nextVariantIdx++];
  if (!v) throw new Error("ran out of catalogue variants for the GRN tests");
  return v;
};
const num = (v) => (v == null ? v : Number(v));
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  await truncateDynamic();
  variants = (await db.any(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 200`)).map((r) => Number(r.id));
  TODAY = (await db.one(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;

  // The receivers start with no GRN rights at all, so each grant below is
  // the only thing that lets them in.
  for (const u of [RECV, LIMITED, CTRL]) {
    expect(await hotelIdsWithPermission(db, u, "grn", ["read", "create", "update", "approve"])).toEqual([]);
  }
  const role = async (title) =>
    Number((await db.one(`SELECT id FROM tbl_roles WHERE title = $1 AND created_by IS NULL`, [title])).id);
  const storekeeper = await role("Storekeeper");
  const controller = await role("Inventory Controller");
  const grnOnly = Number((await db.one(
    `INSERT INTO tbl_roles (title, description, created_by) VALUES ('B1 GRN receiver', 'inventory.grn test', $1) RETURNING id`,
    [BUYER]
  )).id);
  madeRoles.push(grnOnly);
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, id FROM tbl_permissions WHERE resource::text = 'grn' AND action::text IN ('read', 'create', 'update')`,
    [grnOnly]
  );

  scopeIds.push(
    await grantRoleScope(db, { userId: RECV, roleId: storekeeper, companyId: CO, hotelId: A1 }),
    await grantRoleScope(db, { userId: RECV, roleId: storekeeper, companyId: CO, hotelId: A2 }),
    await grantRoleScope(db, { userId: LIMITED, roleId: grnOnly, companyId: CO, hotelId: A1 }),
    await grantRoleScope(db, { userId: CTRL, roleId: controller, companyId: CO }),
    await grantRoleScope(db, { userId: BUYER, roleId: storekeeper, companyId: CO }),
  );

  [recv, limited, ctrl, buyer, foreign] = await Promise.all(
    [RECV, LIMITED, CTRL, BUYER, FOREIGN].map((u) => httpClient(u))
  );
});

afterAll(async () => {
  await revokeRoleScopes(db, scopeIds);
  await truncateDynamic();
  if (madeArc.mr.length) await db.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::int[])`, [madeArc.mr]);
  if (madeArc.line.length) await db.none(`DELETE FROM tbl_arc_contract_line WHERE id = ANY($1::int[])`, [madeArc.line]);
  if (madeArc.contract.length) await db.none(`DELETE FROM tbl_arc_contract WHERE id = ANY($1::int[])`, [madeArc.contract]);
  if (madeArc.item.length) await db.none(`DELETE FROM tbl_arc_item WHERE id = ANY($1::int[])`, [madeArc.item]);
  if (madeArc.arc.length) await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [madeArc.arc]);
  await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = ANY($1::int[])`, [madeRoles]);
  await db.none(`DELETE FROM tbl_roles WHERE id = ANY($1::int[])`, [madeRoles]);
  await closeDb();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let seq = 0;
const tag = () => `${process.pid}-${++seq}`;

/**
 * A committed RFQ PO. lines = [{qty, unit?, price?}]; each line gets its own
 * catalogue variant. mappedHotels = the RFQ's hotel mappings (multi-hotel).
 */
async function makePo({
  hotel = A1, mappedHotels = [], status = "approved", lines = [{ qty: 10 }],
  hospitality = CO, receiptLegacy = false,
} = {}) {
  const process = hospitality === CO ? IDS.processes.A_P1 : IDS.processes.B_P1;
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER, status: 1, is_published: 1, hotel, hospitality, department: IDS.departments.proc, process,
  });
  for (const h of mappedHotels) {
    await db.none(`INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`, [rfq_id, h, BUYER]);
  }
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, VENDOR]
  );
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, receipt_legacy)
     VALUES ($1, $2, $3, $4, '{}', 1, 100, $5, 100, '{}', $6, $7) RETURNING id`,
    [rfq_id, hospitality === CO ? IDS.companies.A : IDS.companies.B, `B1-PO-${tag()}`, status, VENDOR, BUYER, receiptLegacy]
  );
  const lineIds = [];
  const lineVariants = [];
  for (const l of lines) {
    const variant = nextVariant();
    const price = l.price ?? 100;
    const rp = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfq_id, variant]
    );
    const qi = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, comment, delivery_period, quantity)
       VALUES ($1, $2, $3, $4, $5, $6, '', '', $7) RETURNING id`,
      [rfq_id, rfq_no, quote.id, variant, price, price * l.qty, String(l.qty)]
    );
    const pop = await db.one(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price, product_variant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [po.id, rp.id, qi.id, l.qty, l.unit ?? "kg", price, price * l.qty, variant]
    );
    lineIds.push(Number(pop.id));
    lineVariants.push(variant);
  }
  return { poId: Number(po.id), lineIds, variants: lineVariants };
}

/** A committed call-off PO raised by an MR at `hotel` (no RFQ). */
async function makeCallOffPo({ hotel = A2, qty = 6 } = {}) {
  const t0 = tag();
  const variant = nextVariant();
  const arc = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
     VALUES ($1, 'GRN call-off ARC', (SELECT id FROM tbl_category ORDER BY id LIMIT 1), $2, $3, $4, $5,
             'contract_active', NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
             NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6)
     RETURNING id`,
    [`ARC-B1-${t0}`.slice(0, 40), CO, A1, IDS.departments.proc, IDS.processes.A_P1, BUYER]
  );
  madeArc.arc.push(arc.id);
  const arcItem = await db.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 100, 'litre') RETURNING id`,
    [arc.id, variant]
  );
  madeArc.item.push(arcItem.id);
  const contract = await db.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
    [arc.id, VENDOR]
  );
  madeArc.contract.push(contract.id);
  const contractLine = await db.one(
    `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
     VALUES ($1, $2, 90, 5, 1000) RETURNING id`,
    [contract.id, arcItem.id]
  );
  madeArc.line.push(contractLine.id);
  const mr = await db.one(
    `INSERT INTO tbl_material_requisition
       (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, required_by_date)
     VALUES ($1, 'GRN call-off MR', $2, $3, $4, 'normal', $5, 'po_released', '2026-12-15') RETURNING id`,
    [`MR-B1-${t0}`.slice(0, 40), CO, hotel, IDS.departments.fb, BUYER]
  );
  madeArc.mr.push(mr.id);
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id,
        total_value, quote_id, arc_contract_id, source_mr_id, is_call_off)
     VALUES (NULL, $1, $2, 'approved', '{}', $3, 90, $4, 0, '{}', $5, $6, TRUE) RETURNING id`,
    [IDS.companies.A, `CO-B1-${t0}`, qty, VENDOR, contract.id, mr.id]
  );
  const pop = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, quantity, unit, unit_price, charges_meta, total_price, product_variant_id, arc_contract_line_id)
     VALUES ($1, $2, 'litre', 90, '{"tax":5,"tax_mode":"percentage","other_charges":[]}'::jsonb, $3, $4, $5)
     RETURNING id`,
    [po.id, qty, 94.5 * qty, variant, contractLine.id]
  );
  return { poId: Number(po.id), lineId: Number(pop.id), variant };
}

/** Insert a delivery plan: [{hotelId|null, phaseNo, dueDate, lines:[{poLineId, planned}]}]. */
async function insertPlan(poId, deliveries) {
  const out = [];
  for (const d of deliveries) {
    const row = await db.one(
      `INSERT INTO tbl_po_delivery (hospitality_company_id, po_id, hotel_id, phase_no, due_date)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [CO, poId, d.hotelId, d.phaseNo, d.dueDate ?? null]
    );
    for (const l of d.lines) {
      await db.none(
        `INSERT INTO tbl_po_delivery_line (hospitality_company_id, delivery_id, po_line_id, planned_qty)
         VALUES ($1, $2, $3, $4)`,
        [CO, row.id, l.poLineId, l.planned]
      );
    }
    out.push(Number(row.id));
  }
  return out;
}

/** The company's stock item for a variant, created up front (stock unit + extras). */
async function makeItem(variant, { stockUom, trackExpiry = false, minShelfLifeDays = null, tolerancePct = null } = {}) {
  const item = await db.tx((t) => resolveItemForVariant(t, {
    companyId: CO, productVariantId: variant, createIfMissing: true, userId: BUYER, defaultUom: stockUom,
  }));
  await db.none(
    `UPDATE tbl_inv_item SET track_expiry = $2, min_shelf_life_days = $3, over_receipt_tolerance_pct = $4 WHERE id = $1`,
    [item.id, trackExpiry, minShelfLifeDays, tolerancePct]
  );
  return item.id;
}

const grnLine = (poLineId, accepted, rejected = 0, extra = {}) => ({
  poLineId, receivedQty: accepted + rejected, acceptedQty: accepted, rejectedQty: rejected, ...extra,
});
const grnInput = (poId, hotelId, lines, extra = {}) => ({
  poId, hotelId, receivedAt: TODAY, post: true, clientEventId: randomUUID(), lines, ...extra,
});

async function balanceOf(hotelId, variant) {
  const r = await db.oneOrNone(
    `SELECT b.qty::float8 AS qty, b.avg_cost::float8 AS avg_cost
       FROM tbl_inv_balance b
       JOIN tbl_inv_item_variant iv ON iv.inv_item_id = b.inv_item_id AND iv.hospitality_company_id = $3
      WHERE b.hotel_id = $1 AND iv.product_variant_id = $2`,
    [hotelId, variant, CO]
  );
  return r ? { qty: r.qty, avgCost: r.avg_cost } : { qty: 0, avgCost: 0 };
}

async function movementsOfGrn(grnId) {
  return (await db.any(
    `SELECT movement_type, qty::float8 AS qty, unit_cost::float8 AS unit_cost, department_id, hotel_id,
            batch_no, expiry_date::text AS expiry_date
       FROM tbl_inv_movement WHERE source_type = 'GRN' AND source_id = $1 ORDER BY id`,
    [grnId]
  )).map((m) => ({ ...m, department_id: num(m.department_id), hotel_id: num(m.hotel_id) }));
}

async function poState(poId) {
  const po = await db.one(
    `SELECT status::text AS status, receipt_status, delivery_plan_locked_at FROM tbl_rfq_purchase_order WHERE id = $1`,
    [poId]
  );
  const lines = await db.any(
    `SELECT id, accepted_qty::float8 AS accepted, rejected_qty::float8 AS rejected, receipt_status
       FROM tbl_purchase_order_product WHERE purchase_order_id = $1 ORDER BY id`,
    [poId]
  );
  return { ...po, lines };
}

async function planRows(poId) {
  return (await db.any(
    `SELECT d.hotel_id, d.phase_no, d.due_date::text AS due_date, dl.po_line_id,
            dl.planned_qty::float8 AS planned, dl.accepted_qty::float8 AS accepted, dl.rejected_qty::float8 AS rejected
       FROM tbl_po_delivery d JOIN tbl_po_delivery_line dl ON dl.delivery_id = d.id
      WHERE d.po_id = $1 ORDER BY d.hotel_id NULLS FIRST, d.phase_no, dl.po_line_id`,
    [poId]
  )).map((r) => ({ ...r, hotel_id: num(r.hotel_id), po_line_id: num(r.po_line_id) }));
}

const grnCount = async (poId) =>
  Number((await db.one(`SELECT COUNT(*) AS c FROM tbl_grn WHERE po_id = $1`, [poId])).c);

// ---------------------------------------------------------------------------
// receiving
// ---------------------------------------------------------------------------

describe("receiving against the plan", () => {
  it("partial receipt keeps balance open and posts GRN_IN at PO rate", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 10, price: 125 }] });

    const res = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 4)]));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe(1);
    const grn = res.body.data;
    expect(grn).toMatchObject({ poId, hotelId: A1, status: "posted", docType: "RECEIPT", receivedAt: TODAY });
    expect(grn.grnNumber).toMatch(/^GRN\/.+\/\d{5}$/);
    expect(grn.postedBy).toBe(RECV);
    expect(grn.lines[0]).toMatchObject({ poLineId: line, acceptedQty: 4, stockQty: 4, unitCost: 125, uomFactor: 1 });

    expect(await movementsOfGrn(grn.id)).toEqual([
      expect.objectContaining({ movement_type: "GRN_IN", qty: 4, unit_cost: 125, hotel_id: A1 }),
    ]);
    expect(await balanceOf(A1, v)).toEqual({ qty: 4, avgCost: 125 });

    const state = await poState(poId);
    expect(state.receipt_status).toBe("partial");
    expect(state.lines[0]).toMatchObject({ accepted: 4, receipt_status: "partial" });

    const ctx = await recv.get(`/api/v1/inventory/receive/po/${poId}`).query({ hotelId: A1 });
    expect(ctx.status).toBe(200);
    expect(ctx.body.data.lines[0]).toMatchObject({ poLineId: line, plannedAtHotel: 10, openAtHotel: 6, maxAcceptable: 6 });
  });

  it("rejected qty does not stock and keeps line open", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 10 }] });

    const noReason = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 7, 3)]));
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe("VALIDATION");
    expect(noReason.body.details.field).toBe("rejectionReason");

    const res = await recv.post("/api/v1/inventory/grn")
      .send(grnInput(poId, A1, [grnLine(line, 7, 3, { rejectionReason: "damaged" })]));
    expect(res.status).toBe(201);
    expect(res.body.data.lines[0]).toMatchObject({ receivedQty: 10, acceptedQty: 7, rejectedQty: 3, rejectionReason: "damaged", stockQty: 7 });
    expect(await balanceOf(A1, v)).toEqual({ qty: 7, avgCost: 100 });

    const state = await poState(poId);
    expect(state.lines[0]).toMatchObject({ accepted: 7, rejected: 3, receipt_status: "partial" });
    const ctx = await recv.get(`/api/v1/inventory/receive/po/${poId}`).query({ hotelId: A1 });
    expect(ctx.body.data.lines[0]).toMatchObject({ openAtHotel: 3, maxAcceptable: 3 });
  });

  it("over-receipt beyond tolerance is OVER_RECEIPT", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 10 }] });

    const over = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 11)]));
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ status: 0, code: "OVER_RECEIPT", details: { poLineId: line, maxAcceptable: 10 } });
    expect(await grnCount(poId)).toBe(0);
    expect(await balanceOf(A1, v)).toEqual({ qty: 0, avgCost: 0 });

    expect((await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 6)]))).status).toBe(201);
    const again = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 5)]));
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ poLineId: line, maxAcceptable: 4 });

    // The excess can still be recorded, as rejected.
    const excess = await recv.post("/api/v1/inventory/grn")
      .send(grnInput(poId, A1, [grnLine(line, 4, 1, { rejectionReason: "excess" })]));
    expect(excess.status).toBe(201);
    expect(await balanceOf(A1, v)).toEqual({ qty: 10, avgCost: 100 });
  });

  it("5% item tolerance allows 105", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 100, unit: "piece" }] });
    await makeItem(v, { stockUom: "piece", tolerancePct: 5 });

    const over = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 106)]));
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: "OVER_RECEIPT", details: { poLineId: line, maxAcceptable: 105 } });

    const res = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 105)]));
    expect(res.status).toBe(201);
    expect(await balanceOf(A1, v)).toEqual({ qty: 105, avgCost: 100 });
    expect((await poState(poId)).lines[0]).toMatchObject({ accepted: 105, receipt_status: "received" });

    // Fully received: the PO no longer takes receipts at all.
    const more = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 1)]));
    expect(more.status).toBe(409);
    expect(more.body).toMatchObject({ code: "CONFLICT", details: { reason: "PO_NOT_RECEIVABLE", receiptStatus: "received" } });
  });

  it("receipt allocates to earliest-due phase at the receiving hotel", async () => {
    const { poId, lineIds: [line] } = await makePo({ lines: [{ qty: 10 }] });
    await insertPlan(poId, [
      { hotelId: A1, phaseNo: 1, dueDate: addDays(TODAY, 20), lines: [{ poLineId: line, planned: 4 }] },
      { hotelId: A1, phaseNo: 2, dueDate: addDays(TODAY, 5), lines: [{ poLineId: line, planned: 6 }] },
    ]);

    const res = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 7)]));
    expect(res.status).toBe(201);
    const allocations = res.body.data.lines[0].allocations.map((a) => [a.phaseNo, a.acceptedQty]);
    expect(allocations.sort()).toEqual([[1, 1], [2, 6]]);
    expect(await planRows(poId)).toEqual([
      expect.objectContaining({ hotel_id: A1, phase_no: 1, planned: 4, accepted: 1 }),
      expect.objectContaining({ hotel_id: A1, phase_no: 2, planned: 6, accepted: 6 }),
    ]);
  });

  it("unsplit multi-hotel PO receives at two hotels within line total", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ hotel: A1, mappedHotels: [A1, A2], lines: [{ qty: 10 }] });

    const first = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 6)]));
    expect(first.status).toBe(201);

    const ctx = await recv.get(`/api/v1/inventory/receive/po/${poId}`).query({ hotelId: A2 });
    expect(ctx.status).toBe(200);
    expect(ctx.body.data.hotelChoices.map((h) => h.id).sort()).toEqual([A1, A2]);
    expect(ctx.body.data.lines[0]).toMatchObject({ plannedAtHotel: 0, openAtHotel: 4, maxAcceptable: 4 });

    const tooMuch = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A2, [grnLine(line, 5)]));
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body).toMatchObject({ code: "OVER_RECEIPT", details: { poLineId: line, maxAcceptable: 4 } });
    const second = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A2, [grnLine(line, 4)]));
    expect(second.status).toBe(201);
    const third = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 1)]));
    expect(third.status).toBe(409);
    expect(third.body.details).toMatchObject({ reason: "PO_NOT_RECEIVABLE", receiptStatus: "received" });

    // The unallocated row handed its quantity to the receiving hotels.
    expect(await planRows(poId)).toEqual([
      expect.objectContaining({ hotel_id: null, planned: 0, accepted: 0 }),
      expect.objectContaining({ hotel_id: A1, planned: 6, accepted: 6 }),
      expect.objectContaining({ hotel_id: A2, planned: 4, accepted: 4 }),
    ]);
    expect(await balanceOf(A1, v)).toMatchObject({ qty: 6 });
    expect(await balanceOf(A2, v)).toMatchObject({ qty: 4 });
    expect((await poState(poId)).receipt_status).toBe("received");
  });

  it("call-off PO receives against MR hotel", async () => {
    const { poId, lineId, variant } = await makeCallOffPo({ hotel: A2, qty: 6 });

    const elsewhere = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(lineId, 6)]));
    expect(elsewhere.status).toBe(404);

    const ctx = await recv.get(`/api/v1/inventory/receive/po/${poId}`);
    expect(ctx.status).toBe(200);
    expect(ctx.body.data.po).toMatchObject({ id: poId, isCallOff: true });
    expect(ctx.body.data.hotel).toMatchObject({ id: A2 });

    const res = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A2, [grnLine(lineId, 6)]));
    expect(res.status).toBe(201);
    expect(res.body.data.lines[0]).toMatchObject({ unitCost: 90, stockQty: 6 });
    expect(await balanceOf(A2, variant)).toEqual({ qty: 6, avgCost: 90 });
  });

  it("a dispatch-linked delivery is drawn first and the dispatch becomes received", async () => {
    const { poId, lineIds: [line] } = await makePo({ lines: [{ qty: 10 }] });
    const [, later] = await insertPlan(poId, [
      { hotelId: A1, phaseNo: 1, dueDate: addDays(TODAY, 5), lines: [{ poLineId: line, planned: 4 }] },
      { hotelId: A1, phaseNo: 2, dueDate: addDays(TODAY, 20), lines: [{ poLineId: line, planned: 6 }] },
    ]);
    const dispatch = await db.one(
      `INSERT INTO tbl_po_dispatch (dispatch_number, hospitality_company_id, po_id, vendor_id, delivery_id, hotel_id, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'in_transit', $4) RETURNING id`,
      [`DSP-B1-${tag()}`, CO, poId, VENDOR, later, A1]
    );
    await db.none(
      `INSERT INTO tbl_po_dispatch_line (hospitality_company_id, dispatch_id, po_line_id, qty) VALUES ($1, $2, $3, 5)`,
      [CO, dispatch.id, line]
    );

    // Without the dispatch, 5 would go to phase 1 (due first) before phase 2.
    const res = await recv.post("/api/v1/inventory/grn")
      .send(grnInput(poId, A1, [grnLine(line, 5)], { dispatchId: dispatch.id }));
    expect(res.status).toBe(201);
    expect(res.body.data.lines[0].allocations.map((a) => [a.phaseNo, a.acceptedQty])).toEqual([[2, 5]]);
    expect(await planRows(poId)).toEqual([
      expect.objectContaining({ hotel_id: A1, phase_no: 1, planned: 4, accepted: 0 }),
      expect.objectContaining({ hotel_id: A1, phase_no: 2, planned: 6, accepted: 5 }),
    ]);
    expect((await db.one(`SELECT status FROM tbl_po_dispatch WHERE id = $1`, [dispatch.id])).status).toBe("received");
  });

  it("company tolerance applies when the item sets none", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 10 }] });
    await db.none(
      `INSERT INTO tbl_inv_company_settings (hospitality_company_id, over_receipt_tolerance_pct) VALUES ($1, 10)
       ON CONFLICT (hospitality_company_id) DO UPDATE SET over_receipt_tolerance_pct = 10`,
      [CO]
    );
    try {
      const over = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 12)]));
      expect(over.status).toBe(409);
      expect(over.body).toMatchObject({ code: "OVER_RECEIPT", details: { poLineId: line, maxAcceptable: 11 } });
      const res = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 11)]));
      expect(res.status).toBe(201);
      expect(await balanceOf(A1, v)).toMatchObject({ qty: 11 });
    } finally {
      await db.none(`DELETE FROM tbl_inv_company_settings WHERE hospitality_company_id = $1`, [CO]);
    }
  });
});

describe("receive context", () => {
  it("returns the ReceiveContext shape with departments and item suggestions", async () => {
    const { poId, lineIds: [line] } = await makePo({ lines: [{ qty: 3, unit: "Kg" }] });
    const res = await recv.get(`/api/v1/inventory/receive/po/${poId}`).query({ hotelId: A1 });
    expect(res.status).toBe(200);
    const ctx = res.body.data;
    expect(Object.keys(ctx).sort()).toEqual(
      ["departments", "dispatches", "draft", "hotel", "hotelChoices", "itemSuggestions", "lines", "po"].sort()
    );
    expect(ctx.po).toMatchObject({ id: poId, isCallOff: false });
    expect(ctx.hotel).toMatchObject({ id: A1 });
    expect(ctx.departments).toEqual(expect.arrayContaining([expect.objectContaining({ id: FB })]));
    expect(typeof ctx.itemSuggestions).toBe("object");
    expect(ctx.lines[0]).toMatchObject({
      poLineId: line, unit: "Kg", invItemId: null, stockUom: null, uomFactor: 1, needsUomFactor: false,
      trackExpiry: false, plannedAtHotel: 3, openAtHotel: 3, maxAcceptable: 3, defaultMarkOutOnArrival: false,
      barcodes: [], costPerPoUnit: 100,
    });
    expect(ctx.draft).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// concurrency and replay
// ---------------------------------------------------------------------------

/** Resolves for everyone once `n` callers have arrived, so both txs are open before either posts. */
function barrier(n) {
  let arrived = 0;
  let release;
  const all = new Promise((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === n) release();
    await all;
  };
}

describe("concurrency and replay", () => {
  it("concurrent GRN posts cannot over-receive", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 10 }] });
    await db.tx((t) => ensureDefaultPlan(t, poId, { userId: BUYER }));

    const gate = barrier(2);
    const receive7 = () => db.tx(async (t) => {
      await t.one("SELECT 1");
      await gate();
      return postGrn(t, { id: RECV }, {
        input: { poId, hotelId: A1, receivedAt: TODAY, clientEventId: randomUUID(), lines: [grnLine(line, 7)] },
      });
    });
    const results = await Promise.allSettled([receive7(), receive7()]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason.code).toBe("OVER_RECEIPT");
    expect(refused[0].reason.details).toMatchObject({ poLineId: line, maxAcceptable: 3 });

    expect(await balanceOf(A1, v)).toMatchObject({ qty: 7 });
    expect(await grnCount(poId)).toBe(1);
    expect((await poState(poId)).lines[0].accepted).toBe(7);
  });

  it("replayed clientEventId returns the original document", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 10 }] });
    const body = grnInput(poId, A1, [grnLine(line, 3)]);

    const first = await recv.post("/api/v1/inventory/grn").send(body);
    expect(first.status).toBe(201);
    const replay = await recv.post("/api/v1/inventory/grn").send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({ id: first.body.data.id, grnNumber: first.body.data.grnNumber });

    // Posting the same GRN again is a replay too.
    const repost = await recv.post(`/api/v1/inventory/grn/${first.body.data.id}/post`).send({ clientEventId: body.clientEventId });
    expect(repost.status).toBe(200);
    expect(repost.body.data.id).toBe(first.body.data.id);

    // Another tenant cannot fish for the document with its key.
    const fished = await foreign.post("/api/v1/inventory/grn").send({ ...body, poId, hotelId: A1 });
    expect(fished.status).toBe(404);

    expect(await grnCount(poId)).toBe(1);
    expect(await balanceOf(A1, v)).toMatchObject({ qty: 3 });
  });

  it("same-hotel receipts on an unsplit multi-hotel PO serialise on the PO row", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ hotel: A1, mappedHotels: [A1, A2], lines: [{ qty: 10 }] });
    await db.tx((t) => ensureDefaultPlan(t, poId, { userId: BUYER }));

    const pair = (qty) => {
      const gate = barrier(2);
      const receive = () => db.tx(async (t) => {
        await t.one("SELECT 1");
        await gate();
        return postGrn(t, { id: RECV }, {
          input: { poId, hotelId: A1, receivedAt: TODAY, clientEventId: randomUUID(), lines: [grnLine(line, qty)] },
        });
      });
      return Promise.allSettled([receive(), receive()]);
    };

    // Room for both: both post, one after the other.
    const first = await pair(3);
    expect(first.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

    // 4 left: one posts, the other is refused cleanly (never a deadlock or a 500).
    const second = await pair(3);
    expect(second.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = second.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({
      name: "InventoryError", code: "OVER_RECEIPT", details: { poLineId: line, maxAcceptable: 1 },
    });

    expect(await balanceOf(A1, v)).toMatchObject({ qty: 9 });
    expect(await grnCount(poId)).toBe(3);
  });

  it("PUT {post:true} and POST /post on one draft never deadlock", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 10 }] });
    const draft = await recv.post("/api/v1/inventory/grn").send({ ...grnInput(poId, A1, [grnLine(line, 2)]), post: false });
    expect(draft.status).toBe(201);
    const id = draft.body.data.id;

    const gate = barrier(2);
    const viaPut = () => db.tx(async (t) => {
      await t.one("SELECT 1");
      await gate();
      await saveGrnDraft(t, { id: RECV }, { hotelId: A1, lines: [grnLine(line, 3)] }, { grnId: id });
      return postGrn(t, { id: RECV }, { grnId: id });
    });
    const viaPost = () => db.tx(async (t) => {
      await t.one("SELECT 1");
      await gate();
      return postGrn(t, { id: RECV }, { grnId: id });
    });
    const results = await Promise.allSettled([viaPut(), viaPost()]);

    // Whichever goes second sees a posted GRN: a replay, or "only a draft can be edited".
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect(r.reason).toMatchObject({ name: "InventoryError", code: "CONFLICT" });
    }
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect((await db.one(`SELECT status FROM tbl_grn WHERE id = $1`, [id])).status).toBe("posted");
    expect(await grnCount(poId)).toBe(1);
    expect([2, 3]).toContain((await balanceOf(A1, v)).qty);
  });
});

// ---------------------------------------------------------------------------
// stock-side options
// ---------------------------------------------------------------------------

describe("stock options", () => {
  it("mark out on arrival posts GRN_IN + MARK_OUT, balance unchanged", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 5 }] });

    const res = await recv.post("/api/v1/inventory/grn")
      .send(grnInput(poId, A1, [grnLine(line, 5, 0, { markOutDepartmentId: FB })]));
    expect(res.status).toBe(201);
    expect(res.body.data.lines[0]).toMatchObject({ markOutDepartmentId: FB });
    expect(await movementsOfGrn(res.body.data.id)).toEqual([
      expect.objectContaining({ movement_type: "GRN_IN", qty: 5, unit_cost: 100 }),
      expect.objectContaining({ movement_type: "MARK_OUT", qty: -5, department_id: FB }),
    ]);
    expect((await balanceOf(A1, v)).qty).toBe(0);
  });

  it("missing UOM factor is UOM_FACTOR_REQUIRED", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 2, unit: "box" }] });
    const item = await makeItem(v, { stockUom: "piece" });

    const ctx = await recv.get(`/api/v1/inventory/receive/po/${poId}`).query({ hotelId: A1 });
    expect(ctx.body.data.lines[0]).toMatchObject({ invItemId: item, stockUom: "piece", uomFactor: null, needsUomFactor: true });

    const res = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 2)]));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "VALIDATION",
      details: { code_detail: "UOM_FACTOR_REQUIRED", poLineId: line, poUnit: "box", stockUom: "piece" },
    });
    expect(await grnCount(poId)).toBe(0);
  });

  it("receiver with inventory.update can set it inline", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 2, unit: "box", price: 100 }] });
    const item = await makeItem(v, { stockUom: "piece" });

    // grn.create alone is not enough to define a unit conversion.
    const refused = await limited.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 2, 0, { uomFactor: 12 })]));
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("FORBIDDEN");

    const res = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 2, 0, { uomFactor: 12 })]));
    expect(res.status).toBe(201);
    expect(res.body.data.lines[0]).toMatchObject({ uomFactor: 12, stockQty: 24, unitCost: 8.3333 });
    const uom = await db.one(`SELECT factor_to_stock::float8 AS f FROM tbl_inv_item_uom WHERE inv_item_id = $1`, [item]);
    expect(uom.f).toBe(12);
    expect(await balanceOf(A1, v)).toMatchObject({ qty: 24 });
  });

  it("expiry required for tracked items", async () => {
    const { poId, lineIds: [line] } = await makePo({ lines: [{ qty: 4 }] });
    const item = await makeItem((await db.one(
      `SELECT product_variant_id FROM tbl_purchase_order_product WHERE id = $1`, [line])).product_variant_id,
    { stockUom: "kg", trackExpiry: true });
    expect(item).toBeTruthy();

    const missing = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 4)]));
    expect(missing.status).toBe(400);
    expect(missing.body.details).toMatchObject({ code_detail: "EXPIRY_REQUIRED", poLineId: line });

    const expiry = addDays(TODAY, 200);
    const res = await recv.post("/api/v1/inventory/grn")
      .send(grnInput(poId, A1, [grnLine(line, 4, 0, { batchNo: "B-77", expiryDate: expiry })]));
    expect(res.status).toBe(201);
    expect(res.body.data.warnings).toEqual([]);
    expect(await movementsOfGrn(res.body.data.id)).toEqual([
      expect.objectContaining({ movement_type: "GRN_IN", batch_no: "B-77", expiry_date: expiry }),
    ]);
  });

  it("short shelf life warns", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 4 }] });
    await makeItem(v, { stockUom: "kg", trackExpiry: true, minShelfLifeDays: 30 });

    const res = await recv.post("/api/v1/inventory/grn")
      .send(grnInput(poId, A1, [grnLine(line, 4, 0, { expiryDate: addDays(TODAY, 10) })]));
    expect(res.status).toBe(201);
    expect(res.body.data.warnings).toEqual([
      expect.objectContaining({ code: "SHORT_SHELF_LIFE", poLineId: line, shelfLifeDays: 10, minShelfLifeDays: 30 }),
    ]);
    expect((await balanceOf(A1, v)).qty).toBe(4);
  });

  it("an existing unit conversion is never overwritten from a receipt", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 2, unit: "box" }] });
    const item = await makeItem(v, { stockUom: "piece" });
    await db.tx((t) => setUomFactor(t, { invItemId: item, uomLabel: "box", factor: 12, userId: BUYER }));

    // Not even a receiver who may set conversions can change one in passing.
    const mismatch = await recv.post("/api/v1/inventory/grn")
      .send(grnInput(poId, A1, [grnLine(line, 2, 0, { uomFactor: 10 })]));
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({
      code: "VALIDATION",
      details: { code_detail: "UOM_FACTOR_MISMATCH", poLineId: line, currentFactor: 12, suppliedFactor: 10 },
    });
    expect(await grnCount(poId)).toBe(0);
    const uom = await db.one(`SELECT factor_to_stock::float8 AS f FROM tbl_inv_item_uom WHERE inv_item_id = $1`, [item]);
    expect(uom.f).toBe(12);

    // Repeating the stored factor is fine, even for someone who could not set one.
    const same = await limited.post("/api/v1/inventory/grn")
      .send(grnInput(poId, A1, [grnLine(line, 2, 0, { uomFactor: 12 })]));
    expect(same.status).toBe(201);
    expect(same.body.data.lines[0]).toMatchObject({ uomFactor: 12, stockQty: 24 });
  });

  it("mapping to another company's stock item is 404", async () => {
    const { poId, lineIds: [line] } = await makePo({ lines: [{ qty: 2 }] });
    const foreignItem = await db.tx((t) => resolveItemForVariant(t, {
      companyId: IDS.hospitality.B, productVariantId: nextVariant(), createIfMissing: true, userId: BUYER, defaultUom: "kg",
    }));

    const posted = await recv.post("/api/v1/inventory/grn")
      .send(grnInput(poId, A1, [grnLine(line, 2, 0, { mapToInvItemId: foreignItem.id })]));
    expect(posted.status).toBe(404);
    const draft = await recv.post("/api/v1/inventory/grn")
      .send({ ...grnInput(poId, A1, [grnLine(line, 2, 0, { mapToInvItemId: foreignItem.id })]), post: false });
    expect(draft.status).toBe(404);
    expect(await grnCount(poId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reversal
// ---------------------------------------------------------------------------

describe("reversal", () => {
  it("reversal reopens line and restores balance", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 10 }] });
    const posted = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 10)]));
    expect(posted.status).toBe(201);
    const original = posted.body.data;
    expect((await poState(poId)).receipt_status).toBe("received");

    // A storekeeper cannot reverse (grn.approve).
    const denied = await recv.post(`/api/v1/inventory/grn/${original.id}/reverse`).send({ reason: "typo", lines: "all" });
    expect(denied.status).toBe(403);

    const partial = await ctrl.post(`/api/v1/inventory/grn/${original.id}/reverse`)
      .send({ reason: "Counted 4 too many", lines: [{ grnLineId: original.lines[0].id, qty: 4 }] });
    expect(partial.status).toBe(201);
    expect(partial.body.data).toMatchObject({ docType: "REVERSAL", reversesGrnId: original.id, status: "posted", remarks: "Counted 4 too many" });
    expect(partial.body.data.lines[0]).toMatchObject({ reversesGrnLineId: original.lines[0].id, acceptedQty: 4 });
    expect(partial.body.data.lines[0].allocations[0].acceptedQty).toBe(-4);
    expect(await movementsOfGrn(partial.body.data.id)).toEqual([
      expect.objectContaining({ movement_type: "GRN_REVERSAL", qty: -4, unit_cost: 100 }),
    ]);
    expect(await balanceOf(A1, v)).toMatchObject({ qty: 6 });
    let state = await poState(poId);
    expect(state.receipt_status).toBe("partial");
    expect(state.lines[0]).toMatchObject({ accepted: 6, receipt_status: "partial" });

    const rest = await ctrl.post(`/api/v1/inventory/grn/${original.id}/reverse`).send({ reason: "Wrong PO", lines: "all" });
    expect(rest.status).toBe(201);
    expect(rest.body.data.lines[0]).toMatchObject({ reversesGrnLineId: original.lines[0].id, acceptedQty: 6 });
    expect(await balanceOf(A1, v)).toMatchObject({ qty: 0 });
    state = await poState(poId);
    expect(state.receipt_status).toBe("not_received");
    expect(state.lines[0]).toMatchObject({ accepted: 0, receipt_status: "open" });

    const reread = await ctrl.get(`/api/v1/inventory/grn/${original.id}`);
    expect(reread.body.data.status).toBe("reversed");
    expect(reread.body.data.lines[0].reversedQty).toBe(10);
    expect(reread.body.data.reversals).toHaveLength(2);

    const nothingLeft = await ctrl.post(`/api/v1/inventory/grn/${original.id}/reverse`).send({ reason: "again", lines: "all" });
    expect(nothingLeft.status).toBe(409);
  });

  it("reversal blocked when stock already marked out", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 10 }] });
    const posted = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 10)]));
    expect(posted.status).toBe(201);
    const invItemId = posted.body.data.lines[0].invItemId;

    // 6 of the 10 leave the store for F&B.
    await db.tx((t) => postMovements(t, [{
      companyId: CO, hotelId: A1, invItemId, type: "MARK_OUT", qty: -6, departmentId: FB,
      sourceType: "OUT", sourceId: 1, postedBy: RECV,
    }]));

    const res = await ctrl.post(`/api/v1/inventory/grn/${posted.body.data.id}/reverse`).send({ reason: "Wrong PO", lines: "all" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NEGATIVE_STOCK");
    expect(res.body.details).toMatchObject({ invItemId, available: 4, requested: 10, shortfall: 6 });
    expect(res.body.details.itemName).toBeTruthy();

    const reread = await ctrl.get(`/api/v1/inventory/grn/${posted.body.data.id}`);
    expect(reread.body.data.status).toBe("posted");
    expect(await balanceOf(A1, v)).toMatchObject({ qty: 4 });
  });

  it("reversing a line marked out on arrival returns it at the mark-out cost, same batch", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 5, price: 160 }] });
    const invItemId = await makeItem(v, { stockUom: "kg" });
    // The store already holds 10 @ 100.
    await db.tx((t) => postMovements(t, [{
      companyId: CO, hotelId: A1, invItemId, type: "GRN_IN", qty: 10, unitCost: 100,
      sourceType: "TEST", sourceId: 1, postedBy: RECV,
    }]));

    const expiry = addDays(TODAY, 90);
    const posted = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [
      grnLine(line, 5, 0, { markOutDepartmentId: FB, batchNo: "LOT-9", expiryDate: expiry }),
    ]));
    expect(posted.status).toBe(201);
    // In at 160, out to F&B at the new average: (1000 + 800) / 15 = 120.
    expect(await movementsOfGrn(posted.body.data.id)).toEqual([
      expect.objectContaining({ movement_type: "GRN_IN", qty: 5, unit_cost: 160 }),
      expect.objectContaining({ movement_type: "MARK_OUT", qty: -5, unit_cost: 120, department_id: FB }),
    ]);
    expect(await balanceOf(A1, v)).toEqual({ qty: 10, avgCost: 120 });

    const res = await ctrl.post(`/api/v1/inventory/grn/${posted.body.data.id}/reverse`).send({ reason: "Wrong PO", lines: "all" });
    expect(res.status).toBe(201);
    const moves = await db.any(
      `SELECT movement_type, qty::float8 AS qty, unit_cost::float8 AS unit_cost, department_id, batch_no,
              expiry_date::text AS expiry_date, reason_code
         FROM tbl_inv_movement WHERE source_type = 'GRN' AND source_id = $1 ORDER BY id`,
      [res.body.data.id]
    );
    expect(moves).toEqual([
      { movement_type: "RETURN_IN", qty: 5, unit_cost: 120, department_id: FB, batch_no: "LOT-9", expiry_date: expiry, reason_code: "GRN_REVERSAL" },
      { movement_type: "GRN_REVERSAL", qty: -5, unit_cost: 160, department_id: null, batch_no: "LOT-9", expiry_date: expiry, reason_code: null },
    ]);

    // 10 @ 100 stays 10 @ 100, and the batch nets to nothing.
    const balance = await db.one(
      `SELECT qty::float8 AS qty, avg_cost::float8 AS avg, value::float8 AS value
         FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = $2`,
      [A1, invItemId]
    );
    expect(balance).toEqual({ qty: 10, avg: 100, value: 1000 });
    const batch = await db.one(
      `SELECT SUM(qty)::float8 AS qty FROM tbl_inv_movement WHERE hotel_id = $1 AND inv_item_id = $2 AND batch_no = 'LOT-9'`,
      [A1, invItemId]
    );
    expect(batch.qty).toBe(0);
  });

  it("reversal cannot take back what is being returned to the vendor (RTV_COVERED)", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 10 }] });
    const posted = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 10)]));
    expect(posted.status).toBe(201);
    const grn = posted.body.data;
    const rtv = await db.one(
      `INSERT INTO tbl_rtv (rtv_number, hospitality_company_id, po_id, grn_id, hotel_id, disposition, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'CREDIT', 'draft', $6) RETURNING id`,
      [`RTV-B1-${tag()}`, CO, poId, grn.id, A1, CTRL]
    );
    await db.none(
      `INSERT INTO tbl_rtv_line (hospitality_company_id, rtv_id, grn_line_id, qty, reason) VALUES ($1, $2, $3, 3, 'damaged')`,
      [CO, rtv.id, grn.lines[0].id]
    );

    const all = await ctrl.post(`/api/v1/inventory/grn/${grn.id}/reverse`).send({ reason: "Wrong PO", lines: "all" });
    expect(all.status).toBe(409);
    expect(all.body).toMatchObject({
      code: "CONFLICT",
      details: { reason: "RTV_COVERED", grnLineId: grn.lines[0].id, returnedQty: 3, maxReversible: 7 },
    });
    expect(await balanceOf(A1, v)).toMatchObject({ qty: 10 });

    const seven = await ctrl.post(`/api/v1/inventory/grn/${grn.id}/reverse`)
      .send({ reason: "Wrong PO", lines: [{ grnLineId: grn.lines[0].id, qty: 7 }] });
    expect(seven.status).toBe(201);
    expect(await balanceOf(A1, v)).toMatchObject({ qty: 3 });
  });
});

// ---------------------------------------------------------------------------
// PO side effects
// ---------------------------------------------------------------------------

describe("PO side effects", () => {
  it("first GRN moves po.status approved→GRN", async () => {
    const { poId, lineIds: [line] } = await makePo({ lines: [{ qty: 10 }] });
    expect((await poState(poId)).status).toBe("approved");
    expect((await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 1)]))).status).toBe(201);
    expect((await poState(poId)).status).toBe("GRN");
  });

  it("invoice_raised stays invoice_raised", async () => {
    const { poId, lineIds: [line] } = await makePo({ status: "invoice_raised", lines: [{ qty: 10 }] });
    expect((await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 2)]))).status).toBe(201);
    expect((await poState(poId)).status).toBe("invoice_raised");
  });

  it("plan locks on first GRN", async () => {
    const { poId, lineIds: [line] } = await makePo({ lines: [{ qty: 10 }] });
    expect((await poState(poId)).delivery_plan_locked_at).toBeNull();
    const draft = await recv.post("/api/v1/inventory/grn").send({ ...grnInput(poId, A1, [grnLine(line, 1)]), post: false });
    expect(draft.status).toBe(201);
    expect((await poState(poId)).delivery_plan_locked_at).toBeNull();
    expect((await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 1)]))).status).toBe(201);
    expect((await poState(poId)).delivery_plan_locked_at).not.toBeNull();
  });

  it("first receipt writes the legacy PO timeline 'GRN Marked' row, once", async () => {
    const { poId, lineIds: [line] } = await makePo({ lines: [{ qty: 10 }] });
    const txn = await db.one(
      `INSERT INTO tbl_approval_hierarchy_transactions (hierarchy_type, target_entity_id, company_id, initiated_by, status, meta)
       VALUES ('po', $1, $2, $3, 'approved', '{}'::jsonb) RETURNING id`,
      [poId, IDS.companies.A, BUYER]
    );
    try {
      const first = await recv.post("/api/v1/inventory/grn")
        .send(grnInput(poId, A1, [grnLine(line, 4)], { remarks: "First lot" }));
      expect(first.status).toBe(201);
      const second = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 2)]));
      expect(second.status).toBe(201);

      const rows = await db.any(
        `SELECT approved_by, remarks FROM tbl_approval_hierarchy_history
          WHERE approval_transaction_id = $1 AND action = 'grn'`,
        [txn.id]
      );
      expect(rows).toEqual([{ approved_by: RECV, remarks: "First lot" }]);

      const detail = await buyer.get(`/api/v1/po/${poId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data.approval_history).toEqual([
        expect.objectContaining({ action: "grn", approved_by: RECV, remarks: "First lot" }),
      ]);
    } finally {
      await db.none(`DELETE FROM tbl_approval_hierarchy_history WHERE approval_transaction_id = $1`, [txn.id]);
      await db.none(`DELETE FROM tbl_approval_hierarchy_transactions WHERE id = $1`, [txn.id]);
    }
  });
});

// ---------------------------------------------------------------------------
// access
// ---------------------------------------------------------------------------

describe("access", () => {
  it("user without grn.create on that hotel gets 403", async () => {
    const { poId, lineIds: [line] } = await makePo({ hotel: A2, lines: [{ qty: 10 }] });
    const res = await limited.post("/api/v1/inventory/grn").send(grnInput(poId, A2, [grnLine(line, 1)]));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    const ctx = await limited.get(`/api/v1/inventory/receive/po/${poId}`).query({ hotelId: A2 });
    expect(ctx.status).toBe(403);
    expect(await grnCount(poId)).toBe(0);
  });

  it("other company's PO gets 404", async () => {
    const { poId, lineIds: [line] } = await makePo({ hotel: B1, hospitality: IDS.hospitality.B, lines: [{ qty: 10 }] });
    const res = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, B1, [grnLine(line, 1)]));
    expect(res.status).toBe(404);
    // Naming one of the caller's own hotels does not help either.
    const own = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 1)]));
    expect(own.status).toBe(404);
    expect((await recv.get(`/api/v1/inventory/receive/po/${poId}`)).status).toBe(404);
    expect(await grnCount(poId)).toBe(0);

    // And a company-A GRN is invisible to company B.
    const mine = await makePo({ lines: [{ qty: 10 }] });
    const posted = await recv.post("/api/v1/inventory/grn").send(grnInput(mine.poId, A1, [grnLine(mine.lineIds[0], 1)]));
    expect((await foreign.get(`/api/v1/inventory/grn/${posted.body.data.id}`)).status).toBe(404);
    const list = await foreign.get("/api/v1/inventory/grn").query({ poId: mine.poId });
    expect(list.body.data).toEqual({ rows: [], total: 0 });
  });

  it("moving a draft to another hotel needs grn.create there", async () => {
    const { poId, lineIds: [line] } = await makePo({ hotel: A1, mappedHotels: [A1, A2], lines: [{ qty: 10 }] });
    const editor = Number((await db.one(
      `INSERT INTO tbl_roles (title, description, created_by) VALUES ('B1 GRN editor', 'inventory.grn test', $1) RETURNING id`,
      [BUYER]
    )).id);
    madeRoles.push(editor);
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, id FROM tbl_permissions WHERE resource::text = 'grn' AND action::text IN ('read', 'update')`,
      [editor]
    );
    // LIMITED may edit GRNs at A2 but not start one there.
    const scope = await grantRoleScope(db, { userId: LIMITED, roleId: editor, companyId: CO, hotelId: A2 });
    try {
      const draft = await limited.post("/api/v1/inventory/grn").send({ ...grnInput(poId, A1, [grnLine(line, 2)]), post: false });
      expect(draft.status).toBe(201);
      const moved = await limited.put(`/api/v1/inventory/grn/${draft.body.data.id}`).send({ hotelId: A2, lines: [grnLine(line, 2)] });
      expect(moved.status).toBe(403);
      expect(moved.body.code).toBe("FORBIDDEN");

      const byReceiver = await recv.put(`/api/v1/inventory/grn/${draft.body.data.id}`).send({ hotelId: A2, lines: [grnLine(line, 2)] });
      expect(byReceiver.status).toBe(200);
      expect(byReceiver.body.data).toMatchObject({ hotelId: A2, status: "draft" });
    } finally {
      await revokeRoleScopes(db, [scope]);
    }
  });
});

// ---------------------------------------------------------------------------
// drafts, attachments, list
// ---------------------------------------------------------------------------

describe("drafts and attachments", () => {
  it("saves, edits, attaches and posts a draft; discards another", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ lines: [{ qty: 10 }] });
    const key = randomUUID();
    const created = await recv.post("/api/v1/inventory/grn")
      .send({ ...grnInput(poId, A1, [grnLine(line, 2)]), post: false, clientEventId: key });
    expect(created.status).toBe(201);
    const draft = created.body.data;
    expect(draft).toMatchObject({ status: "draft", grnNumber: null });
    expect(await balanceOf(A1, v)).toMatchObject({ qty: 0 });

    const ctx = await recv.get(`/api/v1/inventory/receive/po/${poId}`).query({ hotelId: A1 });
    expect(ctx.body.data.draft).toMatchObject({ id: draft.id, status: "draft" });

    const edited = await recv.put(`/api/v1/inventory/grn/${draft.id}`)
      .send({ hotelId: A1, vendorChallanNo: "CH-9", lines: [grnLine(line, 5)] });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ vendorChallanNo: "CH-9" });
    expect(edited.body.data.lines[0].acceptedQty).toBe(5);

    const upload = await recv.post(`/api/v1/inventory/grn/${draft.id}/attachments`)
      .field("kind", "CHALLAN")
      .attach("file", Buffer.from("%PDF-1.4 challan"), { filename: "challan.pdf", contentType: "application/pdf" });
    expect(upload.status).toBe(201);
    expect(upload.body.data).toMatchObject({ fileName: "challan.pdf", kind: "CHALLAN" });
    expect(upload.body.data.url).toMatch(/^https:\/\/.+\/grn\/attachments\/.+\.pdf$/);

    // Someone who may not edit the GRN uploads nothing.
    const sneaky = await foreign.post(`/api/v1/inventory/grn/${draft.id}/attachments`)
      .attach("file", Buffer.from("%PDF-1.4 x"), { filename: "x.pdf", contentType: "application/pdf" });
    expect(sneaky.status).toBe(404);

    const posted = await recv.post(`/api/v1/inventory/grn/${draft.id}/post`).send({ clientEventId: key });
    expect(posted.status).toBe(200);
    expect(posted.body.data).toMatchObject({ id: draft.id, status: "posted" });
    expect(posted.body.data.attachments).toHaveLength(1);
    expect(await balanceOf(A1, v)).toMatchObject({ qty: 5 });

    // A posted GRN is no longer editable, discardable, or stripped of files.
    expect((await recv.put(`/api/v1/inventory/grn/${draft.id}`).send({ lines: [grnLine(line, 1)] })).status).toBe(409);
    expect((await recv.delete(`/api/v1/inventory/grn/${draft.id}`)).status).toBe(409);
    expect((await recv.delete(`/api/v1/inventory/grn/${draft.id}/attachments/${upload.body.data.id}`)).status).toBe(409);

    const other = await recv.post("/api/v1/inventory/grn").send({ ...grnInput(poId, A1, [grnLine(line, 1)]), post: false });
    const gone = await recv.delete(`/api/v1/inventory/grn/${other.body.data.id}`);
    expect(gone.status).toBe(200);
    expect(gone.body.data).toEqual({ deleted: true });

    const list = await recv.get("/api/v1/inventory/grn").query({ poId });
    expect(list.status).toBe(200);
    expect(list.body.data.total).toBe(1);
    expect(list.body.data.rows[0]).toMatchObject({
      id: draft.id, hotelId: A1, status: "posted", docType: "RECEIPT", lineCount: 1, acceptedValue: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// site-rep (token) receipts, at service level
// ---------------------------------------------------------------------------

describe("site-rep token receipts", () => {
  it("posts with no posted_by, records the token and hides prices", async () => {
    const { poId, lineIds: [line], variants: [v] } = await makePo({ hotel: A1, mappedHotels: [A1, A2], lines: [{ qty: 10 }] });
    const token = await db.one(
      `INSERT INTO tbl_token_login_data (token_type, entity_id, name, email, phone, added_by, token, hotel_id)
       VALUES ('GRN', $1, 'Ravi (site)', 'ravi@site.test', '9999999999', $2, $3, $4) RETURNING id`,
      [poId, BUYER, `tok-${tag()}`, A2]
    );
    const tokenId = Number(token.id);

    // The token's hotel wins over whatever the page sends.
    const { grn } = await db.tx((t) => postGrn(t, SITE_REP_ACTOR, {
      input: { poId, hotelId: A1, receivedAt: TODAY, clientEventId: randomUUID(), lines: [grnLine(line, 3)] },
    }, { viaToken: { tokenId, hotelId: A2 } }));
    expect(grn).toMatchObject({ hotelId: A2, status: "posted", postedBy: null, receivedBy: null, receivedByTokenId: tokenId });
    expect(grn.postedByName).toBe("Ravi (site)");
    expect(grn.lines[0]).not.toHaveProperty("unitCost");
    const row = await db.one(`SELECT posted_by, received_by, received_by_token_id FROM tbl_grn WHERE id = $1`, [grn.id]);
    expect(row).toEqual({ posted_by: null, received_by: null, received_by_token_id: tokenId });
    expect(await balanceOf(A2, v)).toEqual({ qty: 3, avgCost: 100 });

    // A token for another PO opens nothing.
    const other = await makePo({ lines: [{ qty: 5 }] });
    await expect(db.tx((t) => postGrn(t, SITE_REP_ACTOR, {
      input: { poId: other.poId, hotelId: A1, clientEventId: randomUUID(), lines: [grnLine(other.lineIds[0], 1)] },
    }, { viaToken: { tokenId, hotelId: A1 } }))).rejects.toMatchObject({ code: "NOT_FOUND" });

    // And the token view of a GRN carries no prices.
    const view = await db.task((t) => getGrn(t, SITE_REP_ACTOR, grn.id, { viaToken: { tokenId, hotelId: A2 } }));
    expect(view.lines[0]).not.toHaveProperty("unitCost");
  });
});

// ---------------------------------------------------------------------------
// legacy POST /po/markGRN
// ---------------------------------------------------------------------------

describe("legacy markGRN shim", () => {
  it("legacy markGRN posts full receipt for single-hotel PO and 409 USE_RECEIVE for unsplit multi-hotel", async () => {
    const { poId, lineIds: [l1, l2], variants: [v1, v2] } = await makePo({ lines: [{ qty: 10 }, { qty: 5 }] });
    // Part of line 1 already came in through Receive.
    expect((await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(l1, 3)]))).status).toBe(201);

    const url = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/purchase-order/grn-note.pdf`;
    const res = await buyer.post("/api/v1/po/markGRN").send({ po_id: poId, grn_document_url: url, remarks: "All in" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    // The old document row, same shape as before (bigint ids come back as strings).
    expect(res.body.data).toMatchObject({ purchase_order_id: String(poId), document_type: "grn", document_url: url });

    const grns = await db.any(
      `SELECT id, status, posted_by FROM tbl_grn WHERE po_id = $1 AND doc_type = 'RECEIPT' ORDER BY id`, [poId]);
    expect(grns).toHaveLength(2);
    const legacy = grns[1];
    expect(legacy).toMatchObject({ status: "posted", posted_by: BUYER });
    const lines = await db.any(
      `SELECT po_line_id, accepted_qty::float8 AS accepted FROM tbl_grn_line WHERE grn_id = $1 ORDER BY po_line_id`, [legacy.id]);
    expect(lines.map((l) => [Number(l.po_line_id), l.accepted])).toEqual([[l1, 7], [l2, 5]]);
    const att = await db.one(`SELECT kind, s3_key FROM tbl_grn_attachment WHERE grn_id = $1`, [legacy.id]);
    expect(att).toEqual({ kind: "OTHER", s3_key: "purchase-order/grn-note.pdf" });

    const state = await poState(poId);
    expect(state).toMatchObject({ status: "GRN", receipt_status: "received" });
    expect(await balanceOf(A1, v1)).toMatchObject({ qty: 10 });
    expect(await balanceOf(A1, v2)).toMatchObject({ qty: 5 });

    // Nothing left: a second click changes nothing.
    const again = await buyer.post("/api/v1/po/markGRN").send({ po_id: poId, grn_document_url: "", remarks: "x" });
    expect(again.status).toBe(409);
    expect(await grnCount(poId)).toBe(2);

    // An unsplit multi-hotel PO cannot be received in one click.
    const multi = await makePo({ hotel: A1, mappedHotels: [A1, A2], lines: [{ qty: 4 }] });
    const refused = await buyer.post("/api/v1/po/markGRN").send({ po_id: multi.poId, grn_document_url: "", remarks: "x" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("USE_RECEIVE");
    expect((await poState(multi.poId)).status).toBe("approved");
    expect(await grnCount(multi.poId)).toBe(0);
  });

  it("legacy markGRN refuses an unknown unit conversion", async () => {
    const { poId, variants: [v] } = await makePo({ lines: [{ qty: 2, unit: "box" }] });
    await makeItem(v, { stockUom: "piece" });
    const res = await buyer.post("/api/v1/po/markGRN").send({ po_id: poId, grn_document_url: "", remarks: "x" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("USE_RECEIVE");
    expect(await grnCount(poId)).toBe(0);
  });

  it("old GRN links keep working: the site-rep token posts the full receipt over HTTP", async () => {
    const { poId, variants: [v] } = await makePo({ lines: [{ qty: 6 }] });
    const secret = `tok-${randomUUID()}`;
    const token = await db.one(
      `INSERT INTO tbl_token_login_data (token_type, entity_id, name, email, phone, added_by, token)
       VALUES ('GRN', $1, 'Gate (site)', 'gate@site.test', '9999999999', $2, $3) RETURNING id`,
      [poId, BUYER, secret]
    );
    const anon = await httpClient(null);

    const wrong = await anon.post("/api/v1/po/markGRN?token=not-the-token").send({ po_id: poId, grn_document_url: "", remarks: "x" });
    expect(wrong.status).toBe(403);
    expect(await grnCount(poId)).toBe(0);

    const res = await anon.post(`/api/v1/po/markGRN?token=${secret}`)
      .send({ po_id: poId, grn_document_url: "", remarks: "Delivered at the gate" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const grn = await db.one(
      `SELECT status, hotel_id, posted_by, received_by_token_id FROM tbl_grn WHERE po_id = $1 AND doc_type = 'RECEIPT'`,
      [poId]
    );
    expect(grn).toEqual({ status: "posted", hotel_id: A1, posted_by: null, received_by_token_id: Number(token.id) });
    expect(await balanceOf(A1, v)).toMatchObject({ qty: 6 });
    expect((await poState(poId)).status).toBe("GRN");
  });

  it("legacy full receipt checks the caller before the PO's state", async () => {
    const { poId, lineIds: [line] } = await makePo({ hotel: A2, lines: [{ qty: 3 }] });
    expect((await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A2, [grnLine(line, 3)]))).status).toBe(201);

    // Fully received, but a caller without grn.create there hears 403 / 404, not 409.
    await expect(db.tx((t) => postLegacyFullReceipt(t, { id: LIMITED }, { poId })))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(db.tx((t) => postLegacyFullReceipt(t, { id: FOREIGN }, { poId })))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(db.tx((t) => postLegacyFullReceipt(t, { id: RECV }, { poId })))
      .rejects.toMatchObject({ code: "CONFLICT", details: { reason: "PO_NOT_RECEIVABLE" } });
  });
});

// ---------------------------------------------------------------------------
// activity trail
// ---------------------------------------------------------------------------

describe("activity trail", () => {
  /** The newest activity event for a GRN, polled: capture runs after the response. */
  async function grnEvent(grnId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await db.oneOrNone(
        `SELECT event_key, summary FROM tbl_activity_events
          WHERE entity_type = 'GRN' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
        [grnId]
      );
      if (row || Date.now() > deadline) return row;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("POST /grn with post:true is logged as a posting; a draft as started", async () => {
    const { poId, lineIds: [line] } = await makePo({ lines: [{ qty: 4 }] });
    const posted = await recv.post("/api/v1/inventory/grn").send(grnInput(poId, A1, [grnLine(line, 2)]));
    expect(posted.status).toBe(201);
    const draft = await recv.post("/api/v1/inventory/grn").send({ ...grnInput(poId, A1, [grnLine(line, 1)]), post: false });
    expect(draft.status).toBe(201);
    try {
      const postedEvent = await grnEvent(posted.body.data.id);
      expect(postedEvent).toMatchObject({ event_key: "inventory_grn_created" });
      expect(postedEvent.summary.endsWith(` posted goods receipt note ${posted.body.data.grnNumber}`)).toBe(true);
      const draftEvent = await grnEvent(draft.body.data.id);
      expect(draftEvent.summary).toMatch(/ started a goods receipt note GRN draft #\d+$/);
    } finally {
      await db.none(
        `DELETE FROM tbl_activity_events WHERE entity_type = 'GRN' AND entity_id = ANY($1::bigint[])`,
        [[posted.body.data.id, draft.body.data.id]]
      );
    }
  });
});
