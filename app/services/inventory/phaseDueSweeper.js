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
// listed at every hotel of the PO. Then:
//   - per hotel, one in-app digest to the hotel's receivers
//     (notifyPhaseDueDigest). A hotel counts as digested for `today` only when
//     the digest actually reached someone; a hotel already digested is skipped,
//     so a second run (or a second instance) sends nothing new, while one whose
//     digest failed is tried again;
//   - per live site-rep link on a due PO, one reminder email for the PO's
//     deliveries at the link's hotel, without the link itself (only its hash
//     is stored). Each email sent is recorded as an inert tbl_notifications row
//     (type SITE_REP_REMINDER_TYPE, no recipient, so no inbox ever shows it)
//     keyed by link and day; a link, or the same person on the same PO, that
//     was already reminded today is skipped. Independent of the digest.
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

// Bookkeeping row for a site-rep reminder email (see header). recipient_user_id
// and sender_user_id stay NULL, so no user's inbox, count or badge sees it.
export const SITE_REP_REMINDER_TYPE = 'inventory_site_rep_reminder';

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
  const out = {
    date, deliveries: rows.length, hotels: hotelIds.length,
    digests: 0, alreadyDigested: 0, siteRepEmails: 0, siteRepAlreadyReminded: 0,
  };
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

  for (const hotelId of hotelIds) {
    if (alreadyDigested.has(hotelId)) {
      out.alreadyDigested += 1;
      continue;
    }
    const info = hotelInfo.get(hotelId);
    const deliveries = [...byHotel.get(hotelId).values()];
    try {
      const result = await notify(
        {
          hotelId,
          hotelName: info?.name ?? null,
          companyId: info ? Number(info.hospitality_company_id) : null,
          date,
          deliveries,
        },
        { conn: c }
      );
      // Only a digest that reached someone counts; the next run retries others.
      if (result?.sent) out.digests += 1;
    } catch (err) {
      logError(`[Phase Due Sweeper] digest for hotel ${hotelId} failed`, err);
    }
  }

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
  if (!links.length) return out;

  // Who was already reminded today: by link, and by person + PO (a link
  // re-issued during the day must not earn its holder a second email).
  const reminded = await c.any(
    `SELECT additional_data->>'tokenId' AS token_id,
            additional_data->>'poId'    AS po_id,
            lower(additional_data->>'email') AS email
       FROM tbl_notifications
      WHERE type = $1
        AND created_at >= now() - interval '3 days'
        AND additional_data->>'date' = $2`,
    [SITE_REP_REMINDER_TYPE, date]
  );
  const remindedTokens = new Set(reminded.map((r) => String(r.token_id)));
  const remindedPeople = new Set(reminded.map((r) => `${r.po_id}|${r.email}`));
  const personKey = (poId, email) => `${poId}|${String(email || '').trim().toLowerCase()}`;

  for (const link of links) {
    const poId = Number(link.entity_id);
    if (remindedTokens.has(String(link.id)) || remindedPeople.has(personKey(poId, link.email))) {
      out.siteRepAlreadyReminded += 1;
      continue;
    }
    const hotels = link.hotel_id != null ? [Number(link.hotel_id)] : await hotelsOfPo(poId);
    const seen = new Map();
    for (const h of hotels) {
      for (const d of byHotel.get(h)?.values() ?? []) {
        if (d.poId === poId) seen.set(d.deliveryId, d);
      }
    }
    if (!seen.size) continue;
    const deliveries = [...seen.values()].sort((a, b) => a.phaseNo - b.phaseNo);
    let sent = false;
    try {
      sent = await remindSiteRep({
        to: link.email,
        name: link.name,
        poNumber: deliveries[0].poNumber,
        hotelName: hotels.length === 1 ? hotelInfo.get(hotels[0])?.name ?? null : null,
        expiresAt: link.expires_at,
        deliveries: deliveries.map((d) => ({ phaseNo: d.phaseNo, dueDate: d.dueDate, bucket: d.bucket })),
      });
    } catch (err) {
      logError(`[Phase Due Sweeper] site-rep reminder for link ${link.id} failed`, err);
      continue;
    }
    if (sent !== true) continue; // not sent: the next run tries again
    out.siteRepEmails += 1;
    remindedTokens.add(String(link.id));
    remindedPeople.add(personKey(poId, link.email));
    try {
      await c.none(
        `INSERT INTO tbl_notifications
           (type, category, title, message, additional_data, is_read, delivered_at, dismissed_at)
         VALUES ($1, 'inventory', 'Delivery reminder emailed to a site representative', $2, $3::json, 1, now(), now())`,
        [
          SITE_REP_REMINDER_TYPE,
          `Purchase order ${deliveries[0].poNumber ?? poId}: ${deliveries.length} deliver${deliveries.length === 1 ? 'y' : 'ies'}`,
          JSON.stringify({
            tokenId: Number(link.id),
            poId,
            email: String(link.email || '').trim().toLowerCase(),
            date,
            deliveryIds: deliveries.map((d) => d.deliveryId),
          }),
        ]
      );
    } catch (err) {
      // The email went; without the record a later run today may send it again.
      logError(`[Phase Due Sweeper] recording the site-rep reminder for link ${link.id} failed`, err);
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
 *   injectable for tests (default notifyPhaseDueDigest, which resolves
 *   { sent }, and sendSiteRepDeliveryReminderEmail, which resolves true when
 *   the email went).
 * @returns {Promise<{skipped:true}|{date:string, deliveries:number, hotels:number,
 *   digests:number, alreadyDigested:number, siteRepEmails:number,
 *   siteRepAlreadyReminded:number}>}
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
