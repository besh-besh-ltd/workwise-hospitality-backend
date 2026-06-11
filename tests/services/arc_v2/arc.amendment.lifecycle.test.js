// ARC amendment — lifecycle transitions + pricing overlay + call-off pricing.
//
// Proves the post-approval half of the amendment journey:
//   1. arcPricingResolver overlays a live price amendment ONLY inside its
//      effective window — before/after the window the original rate applies,
//      and both window boundary days are inclusive.
//   2. An 'approved' amendment whose window covers asOf prices identically
//      to a 'live' one (the cron flip is bookkeeping, never a pricing gate).
//   3. Qty amendments overlay committed_qty_effective without touching rate.
//   4. runAmendmentLifecycleTick flips approved→live when the window opens,
//      leaves future windows untouched, ends live amendments past their
//      window, sweeps approved-but-expired straight to ended, and never
//      auto-ends term amendments (their amendment_to is NULL).
//   5. After an amendment ends, EVERYTHING reverts: resolver returns the
//      original rate and applied_amendment_id is null again.
//   6. Call-off release (handleMrPostApproval → callOffPoService) prices
//      through the live amendment: tbl_arc_callof_po.price_applied carries
//      the amended rate and applied_amendment_id points at the amendment.

import { resolveCurrentPrice } from "../../../app/services/arcPricingResolver.js";
import { runAmendmentLifecycleTick } from "../../../app/services/arcAmendmentLifecycleService.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HC     = IDS.hospitality.A;
const HOTEL  = IDS.hotels.A1;
const DEPT   = IDS.departments.proc;
const PROC   = IDS.processes.A_P1;
const BUYER  = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

const dIso = (offsetDays) => {
  // Local-calendar day (pg DATE comparisons are local; toISOString would
  // shift the day for TZs east of UTC when run near midnight).
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const atOffset = (offsetDays) => new Date(Date.now() + offsetDays * 86400_000);

describe("ARC amendment lifecycle — overlay window, cron transitions, call-off pricing", () => {
  let arcId, contractId;
  const line = {}; // A: price overlay, B: qty overlay, C: call-off, D: tick fixtures

  async function insertAmendment({ lineId = null, type, from, to, status, payload = {}, reason = "test" }) {
    const fullPayload = lineId ? { arc_contract_line_id: lineId, ...payload } : payload;
    return db.one(
      `INSERT INTO tbl_arc_amendment
         (arc_contract_id, amendment_type, amendment_from, amendment_to, status, reason, payload, requested_by)
       VALUES ($1, $2, $3::date, $4::date, $5, $6, $7::jsonb, $8)
       RETURNING *`,
      [contractId, type, from, to, status, reason, JSON.stringify(fullPayload), VENDOR]
    );
  }

  beforeAll(async () => {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by)
       VALUES ('ARC-TEST-AMDLC-1', 'Amendment lifecycle ARC', $1, $2, $3, $4, $5,
               'contract_active',
               NOW() - INTERVAL '40 days', NOW() - INTERVAL '30 days',
               NOW() - INTERVAL '20 days', NOW() + INTERVAL '180 days',
               $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    const contract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status)
       VALUES ($1, $2, 'active') RETURNING *`, [arcId, VENDOR]);
    contractId = contract.id;

    // tbl_arc_item is unique on (arc_id, product_variant_id) — one variant
    // per line. Variants 1..4 are seeded beverages.
    const variantFor = { A: 1, B: 2, C: 3, D: 4 };
    for (const key of ["A", "B", "C", "D"]) {
      const item = await db.one(
        `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
         VALUES ($1, $2, 500, 'litre') RETURNING *`, [arcId, variantFor[key]]);
      const rate = { A: 100, B: 80, C: 60, D: 40 }[key];
      const row = await db.one(
        `INSERT INTO tbl_arc_contract_line
           (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
         VALUES ($1, $2, $3, 5, 500) RETURNING id`, [contractId, item.id, rate]);
      line[key] = row.id;
    }
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE mr_number LIKE 'MR-TEST-AMDLC-%'`);
    await db.none(`DELETE FROM tbl_arc_amendment WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  });

  // ── pricing overlay ─────────────────────────────────────────────────────
  test("live price amendment overlays the rate only inside its window (boundaries inclusive)", async () => {
    const am = await insertAmendment({
      lineId: line.A, type: "price", from: dIso(-1), to: dIso(5),
      status: "live", payload: { new_rate: 120 },
    });

    const inWindow = await resolveCurrentPrice(line.A, new Date());
    expect(Number(inWindow.unit_rate)).toBe(120);
    expect(Number(inWindow.applied_amendment_id)).toBe(Number(am.id));
    // Original line is still exposed untouched for caller introspection.
    expect(Number(inWindow.contract_line.unit_rate)).toBe(100);

    const before = await resolveCurrentPrice(line.A, atOffset(-10));
    expect(Number(before.unit_rate)).toBe(100);
    expect(before.applied_amendment_id).toBeNull();

    const after = await resolveCurrentPrice(line.A, atOffset(10));
    expect(Number(after.unit_rate)).toBe(100);
    expect(after.applied_amendment_id).toBeNull();

    // Boundary days: the from-day and the to-day both price amended.
    const onFrom = await resolveCurrentPrice(line.A, atOffset(-1));
    expect(Number(onFrom.unit_rate)).toBe(120);
    const onTo = await resolveCurrentPrice(line.A, atOffset(5));
    expect(Number(onTo.unit_rate)).toBe(120);
    const dayAfterTo = await resolveCurrentPrice(line.A, atOffset(6));
    expect(Number(dayAfterTo.unit_rate)).toBe(100);
  });

  test("'approved' amendment with an open window prices identically to 'live' (cron-independent)", async () => {
    const am = await insertAmendment({
      lineId: line.B, type: "price", from: dIso(-1), to: dIso(5),
      status: "approved", payload: { new_rate: 90 },
    });
    const r = await resolveCurrentPrice(line.B, new Date());
    expect(Number(r.unit_rate)).toBe(90);
    expect(Number(r.applied_amendment_id)).toBe(Number(am.id));
    // Park it so it doesn't interfere with the qty overlay below.
    await db.none(`UPDATE tbl_arc_amendment SET status = 'voided' WHERE id = $1`, [am.id]);
  });

  test("qty amendment overlays committed_qty_effective without touching the rate", async () => {
    const am = await insertAmendment({
      lineId: line.B, type: "qty", from: dIso(-1), to: dIso(5),
      status: "live", payload: { new_qty: 350 },
    });
    const r = await resolveCurrentPrice(line.B, new Date());
    expect(Number(r.unit_rate)).toBe(80);                      // unchanged
    expect(Number(r.committed_qty_effective)).toBe(350);       // overlaid
    expect(Number(r.applied_amendment_id)).toBe(Number(am.id));

    const outside = await resolveCurrentPrice(line.B, atOffset(10));
    expect(Number(outside.committed_qty_effective)).toBe(500); // original cap
  });

  // ── lifecycle tick ──────────────────────────────────────────────────────
  test("tick activates approved amendments whose window has opened, and logs it", async () => {
    const am = await insertAmendment({
      lineId: line.D, type: "price", from: dIso(-2), to: dIso(10),
      status: "approved", payload: { new_rate: 44 },
    });
    const result = await runAmendmentLifecycleTick(new Date());
    expect(result.activated).toBeGreaterThanOrEqual(1);

    const row = await db.one(`SELECT status FROM tbl_arc_amendment WHERE id = $1`, [am.id]);
    expect(row.status).toBe("live");

    const ev = await db.oneOrNone(
      `SELECT * FROM tbl_arc_event_log
        WHERE arc_id = $1 AND event_type = 'amendment_live'
          AND (payload->>'amendment_id')::bigint = $2`, [arcId, am.id]);
    expect(ev).toBeTruthy();
    expect(ev.payload.via).toBe("lifecycle_cron");
  });

  test("tick leaves future-window amendments approved", async () => {
    // line.C is free of in-flight rows at this point.
    const am = await insertAmendment({
      lineId: line.C, type: "price", from: dIso(15), to: dIso(25),
      status: "approved", payload: { new_rate: 70 },
    });
    await runAmendmentLifecycleTick(new Date());
    const row = await db.one(`SELECT status FROM tbl_arc_amendment WHERE id = $1`, [am.id]);
    expect(row.status).toBe("approved");
    // And it doesn't price today either.
    const r = await resolveCurrentPrice(line.C, new Date());
    expect(Number(r.unit_rate)).toBe(60);
    await db.none(`UPDATE tbl_arc_amendment SET status = 'voided' WHERE id = $1`, [am.id]);
  });

  test("tick ends live amendments past their window — and pricing fully reverts", async () => {
    // Rewind line.A's live amendment so its window closed yesterday.
    const am = await db.one(
      `UPDATE tbl_arc_amendment
          SET amendment_from = $2::date, amendment_to = $3::date
        WHERE arc_contract_id = $1 AND status = 'live'
          AND (payload->>'arc_contract_line_id')::bigint = $4
        RETURNING id`,
      [contractId, dIso(-10), dIso(-1), line.A]
    );
    const result = await runAmendmentLifecycleTick(new Date());
    expect(result.ended).toBeGreaterThanOrEqual(1);

    const row = await db.one(`SELECT status FROM tbl_arc_amendment WHERE id = $1`, [am.id]);
    expect(row.status).toBe("ended");

    const ev = await db.oneOrNone(
      `SELECT * FROM tbl_arc_event_log
        WHERE arc_id = $1 AND event_type = 'amendment_ended'
          AND (payload->>'amendment_id')::bigint = $2`, [arcId, am.id]);
    expect(ev).toBeTruthy();

    // Everything reverted: original rate, no applied amendment.
    const r = await resolveCurrentPrice(line.A, new Date());
    expect(Number(r.unit_rate)).toBe(100);
    expect(r.applied_amendment_id).toBeNull();
  });

  test("approved amendment whose window fully passed is swept straight to ended", async () => {
    const am = await insertAmendment({
      lineId: line.C, type: "price", from: dIso(-10), to: dIso(-2),
      status: "approved", payload: { new_rate: 75 },
    });
    await runAmendmentLifecycleTick(new Date());
    const row = await db.one(`SELECT status FROM tbl_arc_amendment WHERE id = $1`, [am.id]);
    expect(row.status).toBe("ended");
  });

  test("term amendments (open-ended) are never auto-ended by the tick", async () => {
    const am = await insertAmendment({
      type: "term", from: dIso(200), to: null, status: "live",
      payload: {},
    });
    await runAmendmentLifecycleTick(new Date());
    const row = await db.one(`SELECT status FROM tbl_arc_amendment WHERE id = $1`, [am.id]);
    expect(row.status).toBe("live");
  });

  // ── call-off integration ────────────────────────────────────────────────
  test("call-off release prices through the live amendment (price_applied + applied_amendment_id)", async () => {
    // Live price amendment on line.D (rate 40 → 44, activated by the tick above).
    const liveAm = await db.one(
      `SELECT id FROM tbl_arc_amendment
        WHERE arc_contract_id = $1 AND status = 'live'
          AND (payload->>'arc_contract_line_id')::bigint = $2`,
      [contractId, line.D]
    );

    const mr = await db.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id,
          urgency, raised_by, status, submitted_at)
       VALUES ('MR-TEST-AMDLC-1', 'Amended-rate call-off', $1, $2, $3,
               'normal', $4, 'pending_approval', NOW())
       RETURNING *`,
      [HC, HOTEL, DEPT, BUYER]
    );
    // matched_unit_rate carries the STALE pre-amendment rate on purpose —
    // release must re-resolve, not trust the snapshot.
    await db.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1, $2, 50, 'litre', $3, $4, 40)`,
      [mr.id, VARIANT_ID, contractId, line.D]
    );

    const { handleMrPostApproval } = await import("../../../app/controllers/mr/mrController.js");
    await handleMrPostApproval(77777, BUYER, {
      instance: { id: 77777, entity_type: "MR", entity_id: mr.id, status: "APPROVED" },
    });

    const co = await db.one(`SELECT * FROM tbl_arc_callof_po WHERE mr_id = $1`, [mr.id]);
    expect(Number(co.price_applied)).toBe(44);                       // amended, not 40
    expect(Number(co.applied_amendment_id)).toBe(Number(liveAm.id)); // provenance pinned

    const consumed = await db.one(
      `SELECT consumed_qty FROM tbl_arc_contract_line WHERE id = $1`, [line.D]);
    expect(Number(consumed.consumed_qty)).toBe(50);
  });
});
