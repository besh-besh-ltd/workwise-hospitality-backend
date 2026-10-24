// Tracking ETA (Task C2, spec §7.6): the PO tracking page's ETA switches from
// the payment-milestone date to the next open delivery due date.
//
// Rule under test (app/models/poDashboardModel.js fetchTrackingRows):
//   - open delivery = tbl_po_delivery with status open|partial and a due date,
//     on a PO that is not legacy-received, not received / closed short and not
//     completed;
//   - ETA = the earliest open due date on or after today (IST), else the
//     earliest overdue one;
//   - `overdue` = some open delivery is past its IST due date;
//   - with no open dated delivery, ETA and `overdue` fall back to the
//     milestone date as before.
//
// Dates are computed from Postgres's IST "today", so the suite means the same
// thing under the UTC session CI and prod run in and under a local IST one.
// The tracking model reads through the shared pool, so rows are committed and
// removed in afterEach.

import { describe, it, expect, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import * as fx from "../helpers/invPlanFixtures.js";

const tr = fx.newTracker();

afterEach(async () => {
  if (tr.poIds.length) {
    await db.none(`DELETE FROM tbl_payment_milestone WHERE po_id = ANY($1::int[])`, [tr.poIds]);
  }
  await fx.cleanupTracked(db, tr);
});
afterAll(async () => {
  await closeDb();
});

/** IST calendar day `offset` days from today, as YYYY-MM-DD. */
async function istDay(offset = 0) {
  const r = await db.one(
    `SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS d`,
    [offset]
  );
  return r.d;
}

/**
 * A committed one-line PO at A1 with the given plan and an optional payment
 * milestone. deliveries = [{phaseNo, dueDate|null, status?}], each planning
 * the whole line (the tracking ETA reads delivery rows, not quantities).
 */
async function poWithPlan({ deliveries, milestoneDue = null, status = "approved", legacy = false }) {
  return db.tx(async (t) => {
    const po = await fx.makeRfqPo(t, { status, lines: [{ qty: 10 }], tracker: tr });
    if (legacy) {
      await t.none(`UPDATE tbl_rfq_purchase_order SET receipt_legacy = true WHERE id = $1`, [po.poId]);
    }
    for (const d of deliveries) {
      const row = await t.one(
        `INSERT INTO tbl_po_delivery (hospitality_company_id, po_id, hotel_id, phase_no, due_date, status)
         VALUES ($1, $2, $3, $4, $5::date, $6) RETURNING id`,
        [fx.CO, po.poId, fx.A1, d.phaseNo, d.dueDate, d.status ?? "open"]
      );
      await t.none(
        `INSERT INTO tbl_po_delivery_line (hospitality_company_id, delivery_id, po_line_id, planned_qty)
         VALUES ($1, $2, $3, 10)`,
        [fx.CO, row.id, po.lineIds[0]]
      );
    }
    if (milestoneDue) {
      await t.none(
        `INSERT INTO tbl_payment_milestone (rfq_id, po_id, company_id, milestone_name, due_date, milestone_description, created_by)
         VALUES ($1, $2, $3, 'Balance', $4::date, 'Balance payment', $5)`,
        [po.rfqId, po.poId, IDS.companies.A, milestoneDue, fx.BUYER]
      );
    }
    return po;
  });
}

async function trackingRows() {
  const client = await httpClient(fx.BUYER);
  const res = await client.get(
    `/api/v1/po/tracking?tab=all&limit=100&search=${encodeURIComponent(`ib2-${process.pid}-`)}`
  );
  expect(res.status).toBe(200);
  return new Map(res.body.data.map((r) => [r.id, r]));
}

describe("PO tracking ETA", () => {
  it("tracking ETA uses next open delivery due date", async () => {
    const [m3, m1, today, p4, p5, p12, p30] = await Promise.all(
      [-3, -1, 0, 4, 5, 12, 30].map((n) => istDay(n))
    );
    const m6 = await istDay(-6);

    // Phase 1 already received; phase 2 is the next one due; the milestone is later.
    const upcoming = await poWithPlan({
      deliveries: [
        { phaseNo: 1, dueDate: m3, status: "received" },
        { phaseNo: 3, dueDate: p12 },
        { phaseNo: 2, dueDate: p5, status: "partial" },
      ],
      milestoneDue: p30,
    });
    // A late phase and an upcoming one: the ETA is the upcoming date, flagged overdue.
    const lateAndNext = await poWithPlan({
      deliveries: [
        { phaseNo: 1, dueDate: m1 },
        { phaseNo: 2, dueDate: p4 },
      ],
      milestoneDue: p30,
    });
    // Only late phases: the earliest of them.
    const allLate = await poWithPlan({
      deliveries: [
        { phaseNo: 1, dueDate: m6 },
        { phaseNo: 2, dueDate: m1 },
      ],
    });
    // Due today (IST) is on time, not overdue.
    const dueToday = await poWithPlan({ deliveries: [{ phaseNo: 1, dueDate: today }], milestoneDue: m3 });

    const rows = await trackingRows();

    expect(rows.get(upcoming.poId)).toMatchObject({ eta_label: p5, overdue: false });
    expect(rows.get(upcoming.poId).eta_delivery.slice(0, 10)).toBe(p5);

    expect(rows.get(lateAndNext.poId)).toMatchObject({ eta_label: p4, overdue: true });
    expect(rows.get(lateAndNext.poId).eta_delivery.slice(0, 10)).toBe(p4);

    expect(rows.get(allLate.poId)).toMatchObject({ eta_label: m6, overdue: true });

    // The overdue milestone no longer decides the ETA or its colour…
    expect(rows.get(dueToday.poId)).toMatchObject({ eta_label: today, overdue: false });
    // …but it still drives the payment state.
    expect(rows.get(dueToday.poId).payment_status).toBe("overdue");
  });

  it("falls back to the milestone date when no open delivery is dated", async () => {
    const [m2, p20] = await Promise.all([-2, 20].map((n) => istDay(n)));

    // Unscheduled plan (no due date).
    const unscheduled = await poWithPlan({ deliveries: [{ phaseNo: 1, dueDate: null }], milestoneDue: p20 });
    // Every dated phase is received or short-closed.
    const done = await poWithPlan({
      deliveries: [
        { phaseNo: 1, dueDate: m2, status: "received" },
        { phaseNo: 2, dueDate: m2, status: "short_closed" },
      ],
      milestoneDue: p20,
    });
    // Received before line-level receiving existed: its plan rows don't count.
    const legacy = await poWithPlan({ deliveries: [{ phaseNo: 1, dueDate: m2 }], milestoneDue: p20, legacy: true });
    // A completed PO's leftover open phase doesn't count either.
    const completed = await poWithPlan({
      deliveries: [{ phaseNo: 1, dueDate: m2 }], milestoneDue: p20, status: "completed",
    });
    // No plan and no milestone: no ETA.
    const nothing = await poWithPlan({ deliveries: [] });

    const rows = await trackingRows();

    for (const po of [unscheduled, done, legacy, completed]) {
      expect(rows.get(po.poId)).toMatchObject({ eta_label: p20, overdue: false });
    }
    expect(rows.get(nothing.poId)).toMatchObject({ eta_delivery: null, eta_label: null, overdue: false });
  });
});
