// "Awaiting delivery" list (Task B1): one row per (PO, hotel) with quantity
// still to receive at a hotel the user may see receipts at, bucketed by the
// delivery plan's due dates in IST.
//
// Through HTTP, committed data; the dynamic tables are truncated before and
// after the suite.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb, truncateDynamic } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import { hotelIdsWithPermission } from "../../app/services/inventory/scope.js";

const CO = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const B1 = IDS.hotels.B1;
const BUYER = IDS.users.a1_proc_buyer;
const RECV = IDS.users.a1_proc_techEval; // Storekeeper at A1 only
const VENDOR = IDS.users.vendor_alpha;

let recv;
let TODAY;
const scopeIds = [];

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  await truncateDynamic();
  TODAY = (await db.one(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
  expect(await hotelIdsWithPermission(db, RECV, "grn", ["read", "create"])).toEqual([]);
  const storekeeper = Number((await db.one(
    `SELECT id FROM tbl_roles WHERE title = 'Storekeeper' AND created_by IS NULL`
  )).id);
  scopeIds.push(await grantRoleScope(db, { userId: RECV, roleId: storekeeper, companyId: CO, hotelId: A1 }));
  recv = await httpClient(RECV);
});

afterAll(async () => {
  await revokeRoleScopes(db, scopeIds);
  await truncateDynamic();
  await closeDb();
});

let seq = 0;

/** A committed RFQ PO; lines = [{qty, price?}]. */
async function makePo({
  hotel = A1, mappedHotels = [], status = "approved", lines = [{ qty: 10 }], hospitality = CO,
  receiptLegacy = false, receiptStatus = "not_received",
} = {}) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER, status: 1, is_published: 1, hotel, hospitality, department: IDS.departments.proc,
    process: hospitality === CO ? IDS.processes.A_P1 : IDS.processes.B_P1,
  });
  for (const h of mappedHotels) {
    await db.none(`INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`, [rfq_id, h, BUYER]);
  }
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, VENDOR]
  );
  const poNumber = `AW-${process.pid}-${++seq}`;
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, receipt_legacy, receipt_status)
     VALUES ($1, $2, $3, $4, '{}', 1, 100, $5, 100, '{}', $6, $7, $8) RETURNING id`,
    [rfq_id, hospitality === CO ? IDS.companies.A : IDS.companies.B, poNumber, status, VENDOR, BUYER,
      receiptLegacy, receiptStatus]
  );
  const lineIds = [];
  for (const l of lines) {
    const rp = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
      [rfq_id]
    );
    const qi = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, comment, delivery_period, quantity)
       VALUES ($1, $2, $3, 1, $4, $5, '', '', $6) RETURNING id`,
      [rfq_id, rfq_no, quote.id, l.price ?? 100, (l.price ?? 100) * l.qty, String(l.qty)]
    );
    const pop = await db.one(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price, product_variant_id)
       VALUES ($1, $2, $3, $4, 'kg', $5, $6, 1) RETURNING id`,
      [po.id, rp.id, qi.id, l.qty, l.price ?? 100, (l.price ?? 100) * l.qty]
    );
    lineIds.push(Number(pop.id));
  }
  return { poId: Number(po.id), poNumber, lineIds };
}

/** One delivery with one line per PO line, planned at `planned` each. */
async function plan(poId, lineIds, { hotelId = A1, phaseNo = 1, dueDate = null, planned = 10, accepted = 0 } = {}) {
  const d = await db.one(
    `INSERT INTO tbl_po_delivery (hospitality_company_id, po_id, hotel_id, phase_no, due_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [CO, poId, hotelId, phaseNo, dueDate]
  );
  for (const l of lineIds) {
    await db.none(
      `INSERT INTO tbl_po_delivery_line (hospitality_company_id, delivery_id, po_line_id, planned_qty, accepted_qty)
       VALUES ($1, $2, $3, $4, $5)`,
      [CO, d.id, l, planned, accepted]
    );
  }
}

async function awaiting(filter, extra = {}) {
  const res = await recv.get("/api/v1/inventory/receive/awaiting").query({ filter, ...extra });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  return res.body.data;
}
const poIdsOf = (data) => data.rows.map((r) => r.poId).sort((a, b) => a - b);

describe("awaiting deliveries", () => {
  let dueToday;
  let overdue;
  let soon;
  let undated;
  let unplanned;
  let legacy;
  let elsewhere;
  let multi;
  let foreign;
  let done;

  beforeAll(async () => {
    dueToday = await makePo({ lines: [{ qty: 10, price: 50 }, { qty: 4, price: 25 }] });
    await plan(dueToday.poId, dueToday.lineIds, { dueDate: TODAY, planned: 10, accepted: 0 });
    overdue = await makePo();
    await plan(overdue.poId, overdue.lineIds, { dueDate: addDays(TODAY, -2) });
    soon = await makePo();
    await plan(soon.poId, soon.lineIds, { dueDate: addDays(TODAY, 3) });
    undated = await makePo();
    await plan(undated.poId, undated.lineIds, { dueDate: null });
    unplanned = await makePo(); // no plan rows yet
    legacy = await makePo({ receiptLegacy: true }); // from before the module, no plan
    elsewhere = await makePo({ hotel: A2 }); // only at A2: out of scope
    await plan(elsewhere.poId, elsewhere.lineIds, { hotelId: A2, dueDate: TODAY });
    multi = await makePo({ hotel: A1, mappedHotels: [A1, A2] }); // unsplit: unallocated row
    await plan(multi.poId, multi.lineIds, { hotelId: null, dueDate: addDays(TODAY, -5) });
    foreign = await makePo({ hotel: B1, hospitality: IDS.hospitality.B });
    done = await makePo({ status: "GRN", receiptStatus: "received" });
    await plan(done.poId, done.lineIds, { dueDate: addDays(TODAY, -1), planned: 10, accepted: 10 });
  });

  it("due_today/overdue/unscheduled buckets", async () => {
    const today = await awaiting("due_today");
    expect(poIdsOf(today)).toEqual([dueToday.poId]);
    expect(today.total).toBe(1);
    expect(today.rows[0]).toEqual({
      poId: dueToday.poId,
      poNumber: dueToday.poNumber,
      vendorName: expect.any(String),
      hotelId: A1,
      hotelName: expect.any(String),
      nextDueDate: TODAY,
      overdue: false,
      openLineCount: 2,
      openValue: 10 * 50 + 10 * 25,
      isCallOff: false,
      receiptLegacy: false,
      hasInTransitDispatch: false,
    });

    const late = await awaiting("overdue");
    expect(poIdsOf(late)).toEqual([overdue.poId]);
    expect(late.rows[0]).toMatchObject({ overdue: true, nextDueDate: addDays(TODAY, -2) });

    expect(poIdsOf(await awaiting("this_week"))).toEqual([dueToday.poId, soon.poId].sort((a, b) => a - b));

    // No date, no plan yet, or not yet split to a hotel: unscheduled, never overdue.
    const unscheduled = await awaiting("unscheduled");
    expect(poIdsOf(unscheduled)).toEqual([undated.poId, unplanned.poId, multi.poId].sort((a, b) => a - b));
    expect(unscheduled.rows.every((r) => r.overdue === false)).toBe(true);

    // Fully received POs are not awaiting anything.
    expect(poIdsOf(await awaiting("all"))).not.toContain(done.poId);
  });

  it("legacy POs only under older", async () => {
    const older = await awaiting("older");
    expect(poIdsOf(older)).toEqual([legacy.poId]);
    expect(older.rows[0]).toMatchObject({ receiptLegacy: true, overdue: false, nextDueDate: null });
    for (const f of ["all", "due_today", "overdue", "this_week", "unscheduled"]) {
      expect(poIdsOf(await awaiting(f))).not.toContain(legacy.poId);
    }
  });

  it("out-of-scope hotels excluded", async () => {
    const all = await awaiting("all");
    expect(poIdsOf(all)).toEqual(
      [dueToday.poId, overdue.poId, soon.poId, undated.poId, unplanned.poId, multi.poId].sort((a, b) => a - b)
    );
    // The unsplit PO shows once, at the hotel in scope.
    expect(all.rows.filter((r) => r.poId === multi.poId).map((r) => r.hotelId)).toEqual([A1]);
    expect(poIdsOf(all)).not.toContain(elsewhere.poId);
    expect(poIdsOf(all)).not.toContain(foreign.poId);

    // Asking for an out-of-scope hotel narrows to nothing; it never widens.
    // The filter's choices are the hotels in scope, A2 not among them.
    const narrowed = await awaiting("all", { hotelId: A2 });
    expect(narrowed).toMatchObject({ rows: [], total: 0 });
    expect(narrowed.hotels.map((h) => h.id)).toEqual([A1]);
    expect(all.hotels).toEqual([{ id: A1, name: expect.any(String) }]);
    // Search matches the PO number.
    expect(poIdsOf(await awaiting("all", { search: soon.poNumber }))).toEqual([soon.poId]);
  });
});
