// Daily phase-due sweeper (fixes D7). Replaces the in-memory GRN reminder
// jobs, which were three one-shot cron jobs per PO, lost on every restart and
// keyed off one "approval + delivery_period" date.
//
// Reads the delivery plan (tbl_po_delivery + lines). A delivery is due when,
// on the IST calendar day `today`:
//   due_tomorrow  due_date = today + 1
//   due_today     due_date = today
//   overdue       due_date = today − 3
// and at least one of its lines still has goods to receive:
//   open = max(0, planned − (accepted − returned_replace − returned_credit) − short_closed)
// Skipped: legacy POs (receipt_legacy), POs fully received or short-closed, and
// POs not in a receivable status (approved, dispatched, GRN, invoice_raised).
//
// Unallocated deliveries (hotel_id NULL, a multi-hotel PO with no split) are
// listed at every hotel of the PO. Then, per hotel:
//   - one in-app digest to the hotel's receivers (notifyPhaseDueDigest), at
//     most once per hotel per day: a hotel already digested for `today` is
//     skipped, so a second run (or a second instance) sends nothing new;
//   - one reminder to each live site-rep link at that hotel, without the link
//     itself (only its hash is stored).
// One run at a time across instances: a session advisory lock; a run that
// cannot take it returns { skipped: true }.

import db from '../../config/dbConn.js';
import { logError } from '../../helper/common.js';
import { LIVE_TOKEN_SQL } from '../../helper/receiveToken.js';
import { sendSiteRepDeliveryReminderEmail } from '../../helper/sendEmailFunctions/generalReminderEmails.js';
import { logger } from '../../util/logger.js';
import { notifyPhaseDueDigest, PHASE_DUE_DIGEST_TYPE } from './notices/digestNotices.js';
import { getPoContext } from './planCore.js';
import { LEGACY_PO_STATUS_ORDER } from './poStatus.js';

export const PHASE_DUE_SWEEP_LOCK_NS = 950701;
export const PHASE_DUE_SWEEP_LOCK_KEY = 'inventory:phase_due_sweep';
const DEFAULT_LIMIT = 5000;

const OPEN_QTY_SQL = `GREATEST(0, dl.planned_qty - (dl.accepted_qty - dl.returned_replace_qty - dl.returned_credit_qty) - dl.short_closed_qty)`;

async function dueDeliveries(c, today, limit) {
  return c.any(
    `SELECT d.id AS delivery_id, d.po_id, d.hotel_id, d.phase_no, d.due_date::text AS due_date,
            po.po_number,
            CASE WHEN d.due_date = $1::date + 1 THEN 'due_tomorrow'
                 WHEN d.due_date = $1::date     THEN 'due_today'
                 ELSE 'overdue' END AS bucket,
            COUNT(*) FILTER (WHERE ${OPEN_QTY_SQL} > 0) AS open_line_count
       FROM tbl_po_delivery d
       JOIN tbl_rfq_purchase_order po ON po.id = d.po_id
       JOIN tbl_po_delivery_line dl   ON dl.delivery_id = d.id
      WHERE d.due_date IN ($1::date + 1, $1::date, $1::date - 3)
        AND d.status IN ('open', 'partial')
        AND po.status::text = ANY($2::text[])
        AND po.receipt_legacy IS NOT TRUE
        AND po.receipt_status NOT IN ('received', 'closed_short')
      GROUP BY d.id, po.id
     HAVING COUNT(*) FILTER (WHERE ${OPEN_QTY_SQL} > 0) > 0
      ORDER BY d.due_date, d.po_id, d.phase_no
      LIMIT $3`,
    [today, [...LEGACY_PO_STATUS_ORDER], limit]
  );
}

async function sweep(c, { today, limit, notify, remindSiteRep }) {
  const { date } = await c.one(
    `SELECT COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date)::text AS date`,
    [today]
  );
  const rows = await dueDeliveries(c, date, limit);
  if (rows.length >= limit) logger.warn({ date, limit }, '[Phase Due Sweeper] row limit reached; some deliveries were not considered');

  // The PO's hotels, for unallocated rows and hotel-less site-rep links.
  const poHotels = new Map();
  const hotelsOfPo = async (poId) => {
    if (!poHotels.has(poId)) {
      try {
        poHotels.set(poId, (await getPoContext(c, poId)).hotelIds);
      } catch (err) {
        logError(`[Phase Due Sweeper] PO ${poId} context failed`, err);
        poHotels.set(poId, []);
      }
    }
    return poHotels.get(poId);
  };

  const byHotel = new Map(); // hotelId -> Map(deliveryId -> delivery)
  for (const r of rows) {
    const delivery = {
      deliveryId: Number(r.delivery_id),
      poId: Number(r.po_id),
      poNumber: r.po_number,
      phaseNo: Number(r.phase_no),
      dueDate: r.due_date,
      bucket: r.bucket,
      openLineCount: Number(r.open_line_count),
      unallocated: r.hotel_id == null,
    };
    const hotels = r.hotel_id == null ? await hotelsOfPo(delivery.poId) : [Number(r.hotel_id)];
    for (const h of hotels) {
      if (!byHotel.has(h)) byHotel.set(h, new Map());
      byHotel.get(h).set(delivery.deliveryId, delivery);
    }
  }

  const hotelIds = [...byHotel.keys()].sort((a, b) => a - b);
  const out = { date, deliveries: rows.length, hotels: hotelIds.length, digests: 0, alreadyDigested: 0, siteRepEmails: 0 };
  if (!hotelIds.length) return out;

  const hotelRows = await c.any(
    `SELECT id, name, hospitality_company_id FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[])`,
    [hotelIds]
  );
  const hotelInfo = new Map(hotelRows.map((h) => [Number(h.id), h]));

  // Once a day per hotel.
  const done = await c.any(
    `SELECT DISTINCT (additional_data->>'hotelId')::int AS hotel_id
       FROM tbl_notifications
      WHERE type = $1
        AND created_at >= now() - interval '3 days'
        AND additional_data->>'date' = $2`,
    [PHASE_DUE_DIGEST_TYPE, date]
  );
  const alreadyDigested = new Set(done.map((r) => Number(r.hotel_id)));

  const digestedNow = new Set();
  for (const hotelId of hotelIds) {
    if (alreadyDigested.has(hotelId)) {
      out.alreadyDigested += 1;
      continue;
    }
    const info = hotelInfo.get(hotelId);
    const deliveries = [...byHotel.get(hotelId).values()];
    try {
      await notify(
        {
          hotelId,
          hotelName: info?.name ?? null,
          companyId: info ? Number(info.hospitality_company_id) : null,
          date,
          deliveries,
        },
        { conn: c }
      );
      out.digests += 1;
      digestedNow.add(hotelId);
    } catch (err) {
      logError(`[Phase Due Sweeper] digest for hotel ${hotelId} failed`, err);
    }
  }
  if (!digestedNow.size) return out;

  // Site reps: each live link on a due PO, for that PO's deliveries at the
  // link's hotel (all of the PO's hotels for a hotel-less legacy link).
  const poIds = [...new Set(rows.map((r) => Number(r.po_id)))];
  const links = await c.any(
    `SELECT tl.id, tl.entity_id, tl.hotel_id, tl.name, tl.email,
            COALESCE(tl.expires_at, tl.created_at + interval '14 days') AS expires_at
       FROM tbl_token_login_data tl
       JOIN tbl_rfq_purchase_order po ON po.id = tl.entity_id
      WHERE tl.entity_id = ANY($1::bigint[])
        AND ${LIVE_TOKEN_SQL}
      ORDER BY tl.id`,
    [poIds]
  );
  for (const link of links) {
    const poId = Number(link.entity_id);
    const linkHotels = link.hotel_id != null ? [Number(link.hotel_id)] : await hotelsOfPo(poId);
    const hotels = linkHotels.filter((h) => digestedNow.has(h));
    const seen = new Map();
    for (const h of hotels) {
      for (const d of byHotel.get(h)?.values() ?? []) {
        if (d.poId === poId) seen.set(d.deliveryId, d);
      }
    }
    if (!seen.size) continue;
    const deliveries = [...seen.values()].sort((a, b) => a.phaseNo - b.phaseNo);
    try {
      const sent = await remindSiteRep({
        to: link.email,
        name: link.name,
        poNumber: deliveries[0].poNumber,
        hotelName: hotels.length === 1 ? hotelInfo.get(hotels[0])?.name ?? null : null,
        expiresAt: link.expires_at,
        deliveries: deliveries.map((d) => ({ phaseNo: d.phaseNo, dueDate: d.dueDate, bucket: d.bucket })),
      });
      if (sent !== false) out.siteRepEmails += 1;
    } catch (err) {
      logError(`[Phase Due Sweeper] site-rep reminder for link ${link.id} failed`, err);
    }
  }
  return out;
}

/**
 * Run one sweep.
 *
 * @param {{conn?:object, today?:string|null, limit?:number,
 *   notify?:Function, remindSiteRep?:Function}} [opts]
 *   today: 'YYYY-MM-DD' (default: today in IST). notify / remindSiteRep are
 *   injectable for tests (default notifyPhaseDueDigest /
 *   sendSiteRepDeliveryReminderEmail).
 * @returns {Promise<{skipped:true}|{date:string, deliveries:number, hotels:number,
 *   digests:number, alreadyDigested:number, siteRepEmails:number}>}
 */
export async function runPhaseDueSweep({
  conn = db,
  today = null,
  limit = DEFAULT_LIMIT,
  notify = notifyPhaseDueDigest,
  remindSiteRep = sendSiteRepDeliveryReminderEmail,
} = {}) {
  return conn.task(async (c) => {
    const { locked } = await c.one(`SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS locked`, [
      PHASE_DUE_SWEEP_LOCK_NS,
      PHASE_DUE_SWEEP_LOCK_KEY,
    ]);
    if (!locked) return { skipped: true };
    try {
      return await sweep(c, { today, limit, notify, remindSiteRep });
    } finally {
      try {
        await c.one(`SELECT pg_advisory_unlock($1::int, hashtext($2)) AS unlocked`, [
          PHASE_DUE_SWEEP_LOCK_NS,
          PHASE_DUE_SWEEP_LOCK_KEY,
        ]);
      } catch (err) {
        logError('[Phase Due Sweeper] unlock failed', err);
      }
    }
  });
}

export default { runPhaseDueSweep };
