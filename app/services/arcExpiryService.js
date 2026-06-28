import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';
import { logArcEvent, ARC_EVENT_TYPES } from './arcEventLogService.js';
import { notifyArcEvent } from './arcNotificationService.js';

/**
 * ARC expiry sweep — the time-driven trigger for the EXPIRING_SOON / EXPIRED
 * notifications. The contract window lives on tbl_arc (contract_end_at); a live
 * rate contract has tbl_arc.status = 'contract_active' (per-vendor
 * tbl_arc_contract.status = 'active'). This sweep advances the lifecycle:
 *   contract_active → expiring_soon → expired
 *
 * Mirrors markExpiredHospitalitySubscriptions in
 * subscriptionNotificationandEexpireCron.js, and is invoked from that same
 * daily script so it rides the existing proven schedule (no new cron infra).
 *
 * Robustness mirrors logArcEvent / notifyArcEvent: every ARC is handled in
 * isolation; a failure is logged and never aborts the rest of the sweep.
 * Notifications fire POST-COMMIT (email/push must not run inside a tx).
 *
 * `now` is injectable so tests are deterministic.
 */

// Day-marks before contract_end_at at which to send an "expiring soon" reminder.
export const REMINDER_DAYS = [30, 15, 7, 1];

// ARC root statuses considered a "live contract" — eligible to remind / expire.
const LIVE_STATUSES = ['contract_active', 'expiring_soon'];

// Local date 'YYYY-MM-DD'. The sweep runs daily; date-only comparison is intended.
function toDateOnly(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<{ expired: number, reminded: Record<number, number> }>}
 */
export async function runArcExpirySweep({ now = new Date() } = {}) {
  const today = toDateOnly(now);
  const summary = { expired: 0, reminded: {} };

  // ── 1. EXPIRE — contract window has fully elapsed ──────────────────────────
  let toExpire = [];
  try {
    toExpire = await db.any(
      `SELECT id FROM tbl_arc
        WHERE status = ANY($1::text[])
          AND contract_end_at IS NOT NULL
          AND contract_end_at::date < $2::date
        ORDER BY id`,
      [LIVE_STATUSES, today]
    );
  } catch (err) {
    logger.error({ err }, '[arcExpiry] failed to query expirable ARCs');
  }

  for (const { id: arcId } of toExpire) {
    try {
      await db.tx(async (t) => {
        await t.none(
          `UPDATE tbl_arc SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [arcId]
        );
        await t.none(
          `UPDATE tbl_arc_contract SET status = 'expired', updated_at = CURRENT_TIMESTAMP
            WHERE arc_id = $1 AND status IN ('active', 'expiring_soon')`,
          [arcId]
        );
        await logArcEvent({
          arcId, eventType: ARC_EVENT_TYPES.EXPIRED, actorId: null, payload: {}, txContext: t,
        });
      });
      summary.expired += 1;
      // Post-commit: never inside the tx (slow email/push, and a rollback must
      // not have already notified).
      await notifyArcEvent({ arcId, eventType: ARC_EVENT_TYPES.EXPIRED, actorId: null, payload: {} });
    } catch (err) {
      logger.error({ err, arcId }, '[arcExpiry] failed to expire ARC');
    }
  }

  // ── 2. REMIND — N days before contract_end_at ─────────────────────────────
  for (const N of REMINDER_DAYS) {
    summary.reminded[N] = 0;
    let due = [];
    try {
      due = await db.any(
        `SELECT id FROM tbl_arc
          WHERE status = ANY($1::text[])
            AND contract_end_at IS NOT NULL
            AND contract_end_at::date = ($2::date + ($3 || ' days')::interval)::date
          ORDER BY id`,
        [LIVE_STATUSES, today, String(N)]
      );
    } catch (err) {
      logger.error({ err, daysLeft: N }, '[arcExpiry] failed to query expiring-soon ARCs');
      continue;
    }

    for (const { id: arcId } of due) {
      try {
        // Idempotency: skip if an expiring_soon event for this ARC with this
        // daysLeft was already logged today (safe on same-day re-runs).
        const already = await db.oneOrNone(
          `SELECT 1 FROM tbl_arc_event_log
            WHERE arc_id = $1 AND event_type = $2
              AND (payload->>'daysLeft')::int = $3
              AND at::date = $4::date
            LIMIT 1`,
          [arcId, ARC_EVENT_TYPES.EXPIRING_SOON, N, today]
        );
        if (already) continue;

        // Flip to expiring_soon for display (idempotent via status guard).
        await db.none(
          `UPDATE tbl_arc SET status = 'expiring_soon', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'contract_active'`,
          [arcId]
        );
        await db.none(
          `UPDATE tbl_arc_contract SET status = 'expiring_soon', updated_at = CURRENT_TIMESTAMP
            WHERE arc_id = $1 AND status = 'active'`,
          [arcId]
        );
        await logArcEvent({
          arcId, eventType: ARC_EVENT_TYPES.EXPIRING_SOON, actorId: null, payload: { daysLeft: N },
        });
        await notifyArcEvent({
          arcId, eventType: ARC_EVENT_TYPES.EXPIRING_SOON, actorId: null, payload: { daysLeft: N },
        });
        summary.reminded[N] += 1;
      } catch (err) {
        logger.error({ err, arcId, daysLeft: N }, '[arcExpiry] failed to send expiring-soon reminder');
      }
    }
  }

  logger.info({ summary }, '[arcExpiry] sweep complete');
  return summary;
}

export default { runArcExpirySweep, REMINDER_DAYS };
