// Call-off release vs the contract give-back paths: one lock order (E1 M-3).
//
// Short-close, reopen, a CREDIT return to vendor and a vendor rejection all
// lock a call-off PO's contract lines in id order (callOffPoService
// lockConsumptionRows). The release used to touch them in the order its item
// query returned the requisition items, so a release meeting L2 before L1
// could hold L2 and wait on L1 while a give-back held L1 and waited on L2:
// Postgres aborts one of them with 40P01. The release now takes the same
// id-ordered locks before it writes anything against a contract line.
//
// Deterministic: a holder connection plays the give-back. It takes L1, the
// release starts and queues on it, then the holder asks for L2. The item
// query's output order is the planner's, so the scenario runs for a
// requisition listing [L1, L2] and one listing [L2, L1]: before the fix one
// of the two released holding L2 (deadlock); now neither holds anything yet.
//
// Real Postgres, committed rows, cleaned up after.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { releaseForMr } from "../../../app/services/callOffPoService.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;

let arcId;
let contractId;
let L1;
let L2;
const variantOf = new Map();
const mrIds = [];

beforeAll(async () => {
  const arc = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
     VALUES ('ARC-COLOCK-1', 'Call-off lock order ARC', $1, $2, $3, $4, $5, 'contract_active',
             NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
             NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6) RETURNING id`,
    [TEST_CATEGORIES.beverages, HC, HOTEL, DEPT, PROC, BUYER]
  );
  arcId = arc.id;
  const contract = await db.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
    [arcId, VENDOR]
  );
  contractId = contract.id;
  const ids = [];
  for (const variant of [1, 3]) {
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 1000, 'litre') RETURNING id`,
      [arcId, variant]
    );
    const line = await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 90, 5, 1000) RETURNING id`,
      [contractId, item.id]
    );
    ids.push(Number(line.id));
    variantOf.set(Number(line.id), variant);
  }
  [L1, L2] = ids.sort((a, b) => a - b);
});

afterAll(async () => {
  const poIds = (await db.any(`SELECT id FROM tbl_rfq_purchase_order WHERE arc_contract_id = $1`, [contractId])).map((r) => r.id);
  if (poIds.length) {
    await db.none(`DELETE FROM tbl_po_delivery WHERE po_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
  }
  await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id = $1`, [contractId]);
  await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id = $1`, [contractId]);
  if (mrIds.length) {
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE mr_id = ANY($1::int[])`, [mrIds]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::int[])`, [mrIds]);
  }
  await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
  await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
  await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  await closeDb();
});

/** An approved requisition at A1 for 10 of each contract line, items in `lineOrder`. */
async function makeMr(tag, lineOrder) {
  const mr = await db.one(
    `INSERT INTO tbl_material_requisition
       (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
     VALUES ($1, $2, $3, $4, $5, 'normal', $6, 'approved', NOW()) RETURNING id`,
    [`MR-COLOCK-${tag}`, `COLOCK ${tag}`, HC, HOTEL, DEPT, BUYER]
  );
  mrIds.push(mr.id);
  for (const lineId of lineOrder) {
    await db.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1, $2, 10, 'litre', $3, $4, 90)`,
      [mr.id, variantOf.get(lineId), contractId, lineId]
    );
  }
  return mr.id;
}

/** Waits until a backend of this database is blocked on a lock. */
async function waitForLockWaiter(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { waiting } = await db.one(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`
    );
    if (waiting >= 1) return;
    if (Date.now() > deadline) throw new Error("the release never queued on the contract line");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The give-back takes L1, the release queues on it, the give-back asks for L2.
 * @returns {Promise<{holderError:Error|null, released?:Array, error?:Error}>}
 */
async function releaseAgainstGiveBack(mrId) {
  const holder = await db.connect();
  let release;
  let holderError = null;
  try {
    await holder.none("BEGIN");
    await holder.none("SET LOCAL lock_timeout = '5s'");
    // lockConsumptionRows: contract lines by id, so L1 first ...
    await holder.one(`SELECT id FROM tbl_arc_contract_line WHERE id = $1 FOR UPDATE`, [L1]);
    release = db.tx((t) => releaseForMr(mrId, t)).then((released) => ({ released }), (error) => ({ error }));
    await waitForLockWaiter();
    // ... then L2. A release already holding L2 deadlocks here.
    try {
      await holder.one(`SELECT id FROM tbl_arc_contract_line WHERE id = $1 FOR UPDATE`, [L2]);
    } catch (err) {
      holderError = err;
    }
    await holder.none(holderError ? "ROLLBACK" : "COMMIT");
  } finally {
    await holder.none("ROLLBACK").catch(() => {});
    holder.done();
  }
  return { holderError, ...(await release) };
}

describe("call-off release lock order (E1 M-3)", () => {
  it("a release never deadlocks with a give-back, whatever order its items come in", async () => {
    for (const [tag, order] of [["fwd", [L1, L2]], ["rev", [L2, L1]]]) {
      const mrId = await makeMr(tag, order);
      const outcome = await releaseAgainstGiveBack(mrId);
      expect({ tag, holder: outcome.holderError?.code ?? null, release: outcome.error?.code ?? null })
        .toEqual({ tag, holder: null, release: null });
      expect(outcome.released).toHaveLength(1);
    }
    const consumed = await db.any(
      `SELECT id::int AS id, consumed_qty::float AS consumed FROM tbl_arc_contract_line WHERE arc_contract_id = $1 ORDER BY id`,
      [contractId]
    );
    expect(consumed).toEqual([{ id: L1, consumed: 20 }, { id: L2, consumed: 20 }]);
  });
});
