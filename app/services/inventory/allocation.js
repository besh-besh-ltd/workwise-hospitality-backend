// Delivery-plan state for receiving (part of the GRN service; import from
// grnService.js): the plan as receiving sees it, how much a hotel can still
// accept on a PO line, and the allocator that spreads a receipt over the
// plan's delivery lines (earliest due first, a dispatch's delivery before
// the rest, materialising unallocated quantity at the receiving hotel).
//
// loadPlan {lock:true} takes the delivery-line row locks (step 2 of the lock
// order in grnService.js); callers hold the PO row lock already.

import { toQ, qStr, sum, numOrNull } from './grnCommon.js';

// ---------------------------------------------------------------------------
// delivery plan state
// ---------------------------------------------------------------------------

/**
 * The PO's delivery lines with their delivery, as 1/10000 integers. `lock`
 * takes FOR UPDATE on the lines, ordered by id (step 2 of the lock order).
 */
export async function loadPlan(t, poId, { lock = false } = {}) {
  const rows = await t.any(
    `SELECT dl.id, dl.delivery_id, dl.po_line_id,
            dl.planned_qty::text AS planned, dl.accepted_qty::text AS accepted, dl.rejected_qty::text AS rejected,
            dl.returned_replace_qty::text AS rr, dl.returned_credit_qty::text AS rc,
            dl.short_closed_qty::text AS sc,
            d.hotel_id, d.phase_no, d.due_date::text AS due_date, d.status AS delivery_status
       FROM tbl_po_delivery_line dl
       JOIN tbl_po_delivery d ON d.id = dl.delivery_id
      WHERE d.po_id = $1
      ORDER BY dl.id
      ${lock ? 'FOR UPDATE OF dl' : ''}`,
    [poId]
  );
  const deliveries = await t.any(
    `SELECT id, hotel_id, phase_no, due_date::text AS due_date, status FROM tbl_po_delivery WHERE po_id = $1 ORDER BY id`,
    [poId]
  );
  const lines = rows.map((r) => {
    const l = {
      id: Number(r.id),
      deliveryId: Number(r.delivery_id),
      poLineId: Number(r.po_line_id),
      hotelId: numOrNull(r.hotel_id),
      phaseNo: Number(r.phase_no),
      dueDate: r.due_date,
      plannedQ: toQ(r.planned),
      acceptedQ: toQ(r.accepted),
      rejectedQ: toQ(r.rejected),
      rrQ: toQ(r.rr),
      rcQ: toQ(r.rc),
      scQ: toQ(r.sc),
    };
    l.openQ = Math.max(0, l.plannedQ - (l.acceptedQ - l.rrQ - l.rcQ) - l.scQ);
    return l;
  });
  return {
    lines,
    deliveries: deliveries.map((d) => ({
      id: Number(d.id), hotelId: numOrNull(d.hotel_id), phaseNo: Number(d.phase_no), dueDate: d.due_date, status: d.status,
    })),
  };
}

/** Earliest due date first (no date last), then phase, then id. */
function byDue(a, b) {
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate == null) return 1;
    if (b.dueDate == null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return a.phaseNo - b.phaseNo || a.id - b.id;
}

const netOf = (l) => l.acceptedQ - l.rrQ - l.rcQ;

/**
 * Receiving headroom for one PO line at one hotel (spec §6.5), PO units:
 *   per hotel  net accepted + new ≤ (planned at hotel − short-closed + unallocated open) × (1 + tol)
 *   per line   net accepted + new ≤ (ordered − short-closed) × (1 + tol)
 * maxQ is the most that can still be accepted; openAtHotelQ what is expected.
 */
export function capacityFor(plan, { poLineId, hotelId, orderedQ, tolPct }) {
  const lines = plan.lines.filter((l) => l.poLineId === poLineId);
  const atHotel = lines.filter((l) => l.hotelId === hotelId);
  const unallocated = lines.filter((l) => l.hotelId == null);
  const hotelNet = sum(atHotel.map(netOf));
  const hotelPlanned = sum(atHotel.map((l) => Math.max(0, l.plannedQ - l.scQ)));
  const unallocatedOpen = sum(unallocated.map((l) => l.openQ));
  const lineNet = sum(lines.map(netOf));
  const lineEffective = Math.max(0, orderedQ - sum(lines.map((l) => l.scQ)));
  const tolerance = 1 + (Number(tolPct) || 0) / 100;
  const hotelCap = Math.round((hotelPlanned + unallocatedOpen) * tolerance);
  const lineCap = Math.round(lineEffective * tolerance);
  return {
    maxQ: Math.max(0, Math.min(hotelCap - hotelNet, lineCap - lineNet)),
    plannedAtHotelQ: sum(atHotel.map((l) => l.plannedQ)),
    openAtHotelQ: Math.max(0, Math.min(
      sum(atHotel.map((l) => l.openQ)) + unallocatedOpen,
      lineEffective - lineNet
    )),
  };
}

/**
 * Allocator for one GRN at one hotel (spec §6.4): a dispatch-linked delivery
 * first, then the hotel's open rows by due date / phase, then the unallocated
 * rows, materialised into a row for the hotel (a reused latest undated hotel
 * delivery, else a new one at phase max+1 with no due date). Mutates `plan`
 * as it goes, so several GRN lines for one PO line share the headroom.
 */
export function makeAllocator(t, { plan, ctx, hotelId, dispatchDeliveryId, userId }) {
  let targetDelivery = null;

  async function targetDeliveryFor() {
    if (targetDelivery) return targetDelivery;
    const mine = plan.deliveries.filter((d) => d.hotelId === hotelId);
    const maxPhase = mine.reduce((m, d) => Math.max(m, d.phaseNo), 0);
    const latest = mine.find((d) => d.phaseNo === maxPhase);
    if (latest && latest.dueDate == null && latest.status !== 'short_closed') {
      targetDelivery = latest;
      return latest;
    }
    const row = await t.one(
      `INSERT INTO tbl_po_delivery (hospitality_company_id, po_id, hotel_id, phase_no, due_date, created_by, updated_by)
       VALUES ($1, $2, $3, $4, NULL, $5, $5) RETURNING id`,
      [ctx.companyId, ctx.po.id, hotelId, maxPhase + 1, userId]
    );
    targetDelivery = { id: Number(row.id), hotelId, phaseNo: maxPhase + 1, dueDate: null, status: 'open' };
    plan.deliveries.push(targetDelivery);
    return targetDelivery;
  }

  /** The hotel's materialisation row for a PO line, created with planned 0 if needed. */
  async function targetLineFor(poLineId) {
    const d = await targetDeliveryFor();
    let line = plan.lines.find((l) => l.deliveryId === d.id && l.poLineId === poLineId);
    if (line) return line;
    const row = await t.one(
      `INSERT INTO tbl_po_delivery_line
         (hospitality_company_id, delivery_id, po_line_id, planned_qty, created_by, updated_by)
       VALUES ($1, $2, $3, 0, $4, $4) RETURNING id`,
      [ctx.companyId, d.id, poLineId, userId]
    );
    line = {
      id: Number(row.id), deliveryId: d.id, poLineId, hotelId, phaseNo: d.phaseNo, dueDate: d.dueDate,
      plannedQ: 0, acceptedQ: 0, rejectedQ: 0, rrQ: 0, rcQ: 0, scQ: 0, openQ: 0,
    };
    plan.lines.push(line);
    return line;
  }

  function candidates(poLineId) {
    const atHotel = plan.lines.filter((l) => l.poLineId === poLineId && l.hotelId === hotelId).sort(byDue);
    if (!dispatchDeliveryId) return atHotel;
    const first = atHotel.filter((l) => l.deliveryId === dispatchDeliveryId);
    return [...first, ...atHotel.filter((l) => l.deliveryId !== dispatchDeliveryId)];
  }

  /** @returns {Promise<Array<{deliveryLineId:number, acceptedQ:number, rejectedQ:number}>>} */
  return async function allocate({ poLineId, acceptedQ, rejectedQ }) {
    const out = new Map();
    const add = (line, a, r) => {
      const cur = out.get(line.id) || { deliveryLineId: line.id, acceptedQ: 0, rejectedQ: 0 };
      cur.acceptedQ += a;
      cur.rejectedQ += r;
      out.set(line.id, cur);
    };
    const list = candidates(poLineId);
    let left = acceptedQ;
    let first = null;
    let last = null;

    for (const line of list) {
      if (left <= 0) break;
      const take = Math.min(left, line.openQ);
      if (take > 0) {
        add(line, take, 0);
        line.openQ -= take;
        line.acceptedQ += take;
        left -= take;
        first = first ?? line;
        last = line;
      }
    }

    if (left > 0) {
      // Draw on the unallocated rows: move the planned qty to this hotel.
      let moved = 0;
      const unallocated = plan.lines.filter((l) => l.poLineId === poLineId && l.hotelId == null).sort(byDue);
      for (const u of unallocated) {
        const m = Math.min(left - moved, u.openQ);
        if (m <= 0) continue;
        await t.none(
          `UPDATE tbl_po_delivery_line SET planned_qty = planned_qty - $2::numeric, updated_at = now(), updated_by = $3
            WHERE id = $1`,
          [u.id, qStr(m), userId]
        );
        u.plannedQ -= m;
        u.openQ -= m;
        moved += m;
        if (moved >= left) break;
      }
      if (moved > 0) {
        const target = await targetLineFor(poLineId);
        await t.none(
          `UPDATE tbl_po_delivery_line SET planned_qty = planned_qty + $2::numeric, updated_at = now(), updated_by = $3
            WHERE id = $1`,
          [target.id, qStr(moved), userId]
        );
        target.plannedQ += moved;
        add(target, moved, 0);
        target.acceptedQ += moved;
        left -= moved;
        first = first ?? target;
        last = target;
      }
    }

    if (left > 0) {
      // Within tolerance beyond the plan: book it on the latest row used.
      const sink = last ?? list[list.length - 1] ?? (await targetLineFor(poLineId));
      add(sink, left, 0);
      sink.acceptedQ += left;
      first = first ?? sink;
      left = 0;
    }

    if (rejectedQ > 0) {
      const sink = first ?? list[0] ?? (await targetLineFor(poLineId));
      add(sink, 0, rejectedQ);
    }
    return [...out.values()];
  };
}
