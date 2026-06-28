import cron from 'node-cron';
import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';
import { logArcEvent, ARC_EVENT_TYPES } from './arcEventLogService.js';
import { notifyArcEvent } from './arcNotificationService.js';

/**
 * ARC Amendment Lifecycle
 *
 * Owns every status transition that happens AFTER the approval engine says
 * APPROVED (the engine itself only ever yields approved/rejected):
 *
 *   approved ──(amendment_from reached)──▶ live ──(amendment_to passed)──▶ ended
 *
 * Two entry points:
 *   - applyAmendmentApprovalEffects(amendmentId) — invoked the moment the
 *     engine approves (from reviewAmendment and from the ARC_AMENDMENT
 *     post-approval hook). Applies durable effects (term extension moves the
 *     ARC's contract_end_at) and short-circuits the cron when the window has
 *     already opened (or already closed) by approval time.
 *   - runAmendmentLifecycleTick(asOf) — the daily cron body, exported
 *     separately so tests can drive it deterministically. Flips
 *     approved→live at amendment_from and live→ended after amendment_to.
 *
 * Pricing NEVER depends on these flips — arcPricingResolver overlays by
 * window dates with status IN ('approved','live'), so a late cron can't
 * mis-price a call-off. The flips exist for display (vendor/buyer tabs) and
 * for the event log narrative.
 *
 * Term extensions are durable, not windowed: amendment_from carries the
 * proposed new end date, it is written onto tbl_arc.contract_end_at at
 * approval, and the amendment stays 'live' (amendment_to is NULL so the
 * expiry sweep never touches it).
 */

// Local-calendar formatter. pg DATE columns parse to LOCAL midnight, so
// running them through toISOString() (UTC) shifts the day back for any
// timezone east of UTC — format from local components instead.
const dateOnly = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${x.getFullYear()}-${m}-${day}`;
};

/**
 * Apply post-approval effects for one amendment. Idempotent: safe to call
 * from both the review endpoint and the engine hook, in any order relative
 * to refreshChainCache (it never downgrades live/ended back to approved).
 * Returns the (possibly updated) amendment row, or null if not found.
 */
export async function applyAmendmentApprovalEffects(amendmentId, { actorId = null, txContext = null } = {}) {
  const runner = txContext || db;
  const am = await runner.oneOrNone(
    `SELECT am.*, c.arc_id
       FROM tbl_arc_amendment am
       JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
      WHERE am.id = $1`,
    [amendmentId]
  );
  if (!am) return null;
  // Terminal / already-activated states are left alone.
  if (['rejected', 'live', 'ended', 'voided'].includes(am.status)) return am;

  const today = dateOnly(new Date());

  // ── Term extension: durable application ─────────────────────────────
  if (am.amendment_type === 'term') {
    const newEnd = dateOnly(am.amendment_from);
    await runner.none(
      `UPDATE tbl_arc SET contract_end_at = $1::date, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [newEnd, am.arc_id]
    );
    const row = await runner.one(
      `UPDATE tbl_arc_amendment
          SET status = 'live', decided_at = COALESCE(decided_at, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`,
      [am.id]
    );
    await logArcEvent({
      arcId: am.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_LIVE, actorId,
      payload: { amendment_id: am.id, amendment_type: 'term', new_end_date: newEnd },
      txContext,
    });
    // Notify post-commit only when we own the runner (no outer tx)
    if (!txContext) {
      await notifyArcEvent({ arcId: am.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_LIVE, actorId, payload: { vendorId: am.requested_by ?? null } });
    }
    return { ...row, arc_id: am.arc_id };
  }

  // ── Windowed types: live now, live later, or already-expired ────────
  const from = dateOnly(am.amendment_from);
  const to = am.amendment_to ? dateOnly(am.amendment_to) : null;
  let next = 'approved';
  if (to && to < today) next = 'ended';      // approved after the window closed
  else if (from <= today) next = 'live';     // window already open

  if (next === am.status) return am;
  const row = await runner.one(
    `UPDATE tbl_arc_amendment
        SET status = $1, decided_at = COALESCE(decided_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 RETURNING *`,
    [next, am.id]
  );
  if (next === 'live') {
    await logArcEvent({
      arcId: am.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_LIVE, actorId,
      payload: { amendment_id: am.id, amendment_type: am.amendment_type, amendment_from: from, amendment_to: to },
      txContext,
    });
    if (!txContext) {
      await notifyArcEvent({ arcId: am.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_LIVE, actorId, payload: { vendorId: am.requested_by ?? null } });
    }
  } else if (next === 'ended') {
    await logArcEvent({
      arcId: am.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_ENDED, actorId,
      payload: { amendment_id: am.id, amendment_type: am.amendment_type, amendment_to: to },
      txContext,
    });
    if (!txContext) {
      await notifyArcEvent({ arcId: am.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_ENDED, actorId, payload: { vendorId: am.requested_by ?? null } });
    }
  }
  return { ...row, arc_id: am.arc_id };
}

/**
 * One sweep of the lifecycle cron. Exported so tests can call it with a
 * pinned `asOf` date instead of waiting on cron.schedule.
 * Returns { activated, ended } row counts.
 */
export async function runAmendmentLifecycleTick(asOf = new Date()) {
  const day = dateOnly(asOf);

  // approved → live once the window opens (and hasn't already closed).
  const activated = await db.any(
    `UPDATE tbl_arc_amendment am
        SET status = 'live', updated_at = CURRENT_TIMESTAMP
       FROM tbl_arc_contract c
      WHERE c.id = am.arc_contract_id
        AND am.status = 'approved'
        AND am.amendment_from <= $1::date
        AND (am.amendment_to IS NULL OR am.amendment_to >= $1::date)
      RETURNING am.id, am.amendment_type, am.amendment_from, am.amendment_to, c.arc_id, am.requested_by AS vendor_id`,
    [day]
  );
  for (const row of activated) {
    await logArcEvent({
      arcId: row.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_LIVE,
      payload: { amendment_id: row.id, amendment_type: row.amendment_type, via: 'lifecycle_cron' },
    });
    await notifyArcEvent({ arcId: row.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_LIVE, actorId: null, payload: { vendorId: row.vendor_id } });
  }

  // live → ended after the window closes. Also sweeps approved rows whose
  // window expired before they ever went live (e.g. cron downtime).
  const ended = await db.any(
    `UPDATE tbl_arc_amendment am
        SET status = 'ended', updated_at = CURRENT_TIMESTAMP
       FROM tbl_arc_contract c
      WHERE c.id = am.arc_contract_id
        AND am.status IN ('live', 'approved')
        AND am.amendment_to IS NOT NULL
        AND am.amendment_to < $1::date
      RETURNING am.id, am.amendment_type, am.amendment_to, c.arc_id, am.requested_by AS vendor_id`,
    [day]
  );
  for (const row of ended) {
    await logArcEvent({
      arcId: row.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_ENDED,
      payload: { amendment_id: row.id, amendment_type: row.amendment_type, via: 'lifecycle_cron' },
    });
    await notifyArcEvent({ arcId: row.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_ENDED, actorId: null, payload: { vendorId: row.vendor_id } });
  }

  if (activated.length || ended.length) {
    logger.info({ activated: activated.length, ended: ended.length, asOf: day },
      '[arcAmendmentLifecycle] tick applied transitions');
  }
  return { activated: activated.length, ended: ended.length };
}

/**
 * Registers the daily sweep. 00:15 UTC — just after the date rolls over in
 * UTC so window boundaries (DATE columns) flip on their first calendar day.
 */
export const startArcAmendmentLifecycleCron = () => {
  cron.schedule('15 0 * * *', async () => {
    try {
      await runAmendmentLifecycleTick(new Date());
    } catch (err) {
      logger.error({ err }, '[arcAmendmentLifecycle] cron tick failed');
    }
  });
  logger.info('[arcAmendmentLifecycle] Cron scheduled: daily 00:15 UTC (approved→live, live→ended)');
};
