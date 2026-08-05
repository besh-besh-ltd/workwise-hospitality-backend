import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';
import { logArcEvent, ARC_EVENT_TYPES } from './arcEventLogService.js';
import arcModel from '../models/arc_v2/arcModel.js';
import { arcMomentIst, nowIst } from '../helper/arcTime.js';

/**
 * ARC submission-OPEN sweep — the time-driven trigger for the DEFERRED float
 * notification (Sr 27 / Option C: "vendors could VIEW and SUBMIT before the
 * publish date").
 *
 * WHY: a floated ARC may be published with `submission_start_at` still in the
 * IST future — buyers are allowed to complete approval/float ahead of the
 * intended open date. In that case `handleArcPublishApproval`
 * (arcController.js) deliberately SKIPS `notifyVendorsOfFloat` at float time:
 * a vendor must not be told "it's open for quotes" before the window actually
 * opens (and the vendor-visibility filters in arcVendorController.js hide the
 * ARC from list/detail/tech-clauses reads until then too). This sweep is the
 * other half — once `submission_start_at` passes, it fires that exact same
 * notification (email + in-app, via the shared `notifyVendorsOfFloat`) and
 * logs the marker event so a later run (or the immediate-float path) never
 * double-sends.
 *
 * Idempotency: EVENT-LOG based, not a new column. `ARC_EVENT_TYPES
 * .SUBMISSION_OPENED` ('submission_opened') is logged the moment the vendor
 * notification is actually sent — either here, or immediately at float time
 * in handleArcPublishApproval when the window was already open. The sweep's
 * query excludes any ARC that already has that event; a per-ARC re-check
 * immediately before sending guards a race between two overlapping runs.
 *
 * Mirrors `arcSubmissionCloseService.js`: per-ARC isolation (one ARC's
 * failure never aborts the sweep), the notify call runs OUTSIDE any
 * transaction (best-effort, must never roll back or block), and `now` is
 * injectable for deterministic tests.
 */

/**
 * @param {{ now?: Date|null }} [opts]
 *   now — injectable clock for tests (a JS Date interpreted as IST wall-clock
 *   via arcMomentIst); omit for production (uses real IST now).
 * @returns {Promise<{ opened: number }>}
 */
export async function runArcSubmissionOpenSweep({ now = null } = {}) {
  const summary = { opened: 0 };

  // Naive IST wall-clock string — submission_start_at is TIMESTAMP WITHOUT
  // TIME ZONE holding IST wall-clock, so the comparison must be naive-vs-naive
  // in IST, never naive-vs-UTC-Date (see arcTime.js convention).
  const nowIstStr = now != null
    ? arcMomentIst(now).format('YYYY-MM-DD HH:mm:ss')
    : nowIst().format('YYYY-MM-DD HH:mm:ss');

  let due = [];
  try {
    due = await db.any(
      `SELECT a.id FROM tbl_arc a
        WHERE a.status = 'floated'
          AND a.submission_start_at IS NOT NULL
          AND a.submission_start_at <= $1
          AND NOT EXISTS (
                SELECT 1 FROM tbl_arc_event_log e
                 WHERE e.arc_id = a.id AND e.event_type = $2
              )
        ORDER BY a.id`,
      [nowIstStr, ARC_EVENT_TYPES.SUBMISSION_OPENED]
    );
  } catch (err) {
    logger.error({ err }, '[arcSubmissionOpen] failed to query openable ARCs');
    return summary;
  }

  for (const { id: arcId } of due) {
    try {
      // Re-check right before sending — belt-and-suspenders against a race
      // with a concurrent run or the immediate-float path.
      const already = await db.oneOrNone(
        `SELECT 1 FROM tbl_arc_event_log WHERE arc_id = $1 AND event_type = $2 LIMIT 1`,
        [arcId, ARC_EVENT_TYPES.SUBMISSION_OPENED]
      );
      if (already) continue;

      const arc = await arcModel.getById(arcId);
      if (!arc) continue;

      const invitations = await arcModel.listInvitations(arcId);

      // Lazy import — arcController.js is a controller module; importing it
      // dynamically here mirrors the existing cycle-avoidance pattern already
      // used for controller/model cross-references elsewhere in this codebase
      // (e.g. approvalActionService.js's dynamic import of arcController.js).
      const { notifyVendorsOfFloat } = await import('../controllers/arc_v2/arcController.js');
      await notifyVendorsOfFloat(arc, invitations, null);

      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.SUBMISSION_OPENED, actorId: null, payload: { source: 'open_sweep' },
      });
      summary.opened += 1;
    } catch (err) {
      logger.error({ err, arcId }, '[arcSubmissionOpen] failed to notify vendors for an opened ARC');
    }
  }

  logger.info({ summary }, '[arcSubmissionOpen] sweep complete');
  return summary;
}

export default { runArcSubmissionOpenSweep };
