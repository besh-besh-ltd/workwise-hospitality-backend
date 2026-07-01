import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';
import { logArcEvent, ARC_EVENT_TYPES } from './arcEventLogService.js';
import { notifyArcEvent } from './arcNotificationService.js';
import { dispatch as dispatchNotification } from './notificationService.js';
import arcModel from '../models/arc_v2/arcModel.js';
import arcEvalModel from '../models/arc_v2/arcEvaluationModel.js';
import { arcMomentIst, nowIst } from '../helper/arcTime.js';

/**
 * ARC submission-close sweep — the time-driven trigger for `submission_closed`.
 *
 * A floated ARC's bidding window closes when `submission_end_at` passes. Nothing
 * in request flow flips it, so this daily sweep does:
 *   1. floated → submission_closed (+ logArcEvent), in a tx.
 *   2. POST-COMMIT notify:
 *      · BUYER side (notifyArcEvent SUBMISSION_CLOSED): creator (in-app) + the
 *        NEXT-STAGE evaluators (in-app + email) who must now act — technical
 *        evaluators if the ARC has tech clauses, else commercial. Message tells
 *        them which evaluation to begin.
 *      · VENDOR side (direct in-app dispatch, vendor URL): every invited vendor
 *        gets an informational "submissions closed" — no email (light), mirrors
 *        the notifyVendorsOfFloat pattern.
 *
 * Idempotent: only status='floated' ARCs are selected; the in-tx flip means a
 * second run the same day won't re-match. Per-ARC isolation + non-blocking:
 * one ARC's failure never aborts the sweep, and notifications never run inside
 * the tx. `now` is injectable for deterministic tests.
 */

const VENDOR_BASE = '/dashboard/vendor/rate-contracts';

/**
 * @param {{ now?: Date|null }} [opts]
 *   now — injectable clock for tests (a JS Date interpreted as IST wall-clock
 *   via arcMomentIst); omit for production (uses real IST now).
 * @returns {Promise<{ closed: number }>}
 */
export async function runArcSubmissionCloseSweep({ now = null } = {}) {
  const summary = { closed: 0 };

  // Convert to IST wall-clock naive string.  The stored `submission_end_at`
  // column holds IST wall-clock as `timestamp without time zone`, so the correct
  // comparison is naive-vs-naive in IST — not naive-vs-UTC-Date.
  const nowIstStr = now != null
    ? arcMomentIst(now).format('YYYY-MM-DD HH:mm:ss')
    : nowIst().format('YYYY-MM-DD HH:mm:ss');

  let due = [];
  try {
    due = await db.any(
      `SELECT id FROM tbl_arc
        WHERE status = 'floated'
          AND submission_end_at IS NOT NULL
          AND submission_end_at < $1
        ORDER BY id`,
      [nowIstStr]
    );
  } catch (err) {
    logger.error({ err }, '[arcSubmissionClose] failed to query closable ARCs');
    return summary;
  }

  for (const { id: arcId } of due) {
    try {
      await db.tx(async (t) => {
        await t.none(
          `UPDATE tbl_arc SET status = 'submission_closed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [arcId]
        );
        await logArcEvent({
          arcId, eventType: ARC_EVENT_TYPES.SUBMISSION_CLOSED, actorId: null, payload: {}, txContext: t,
        });
      });
      summary.closed += 1;

      // Which evaluation comes next? Mirror the lifecycle: technical iff the ARC
      // has tech clauses, else commercial. Pass it so the buyer message and the
      // NEXT_STAGE_EVALUATORS audience stay in lockstep (single source of truth).
      const nextStage = (await arcEvalModel.arcHasTechClauses(arcId)) ? 'technical' : 'commercial';

      // BUYER: creator + next-stage evaluators (post-commit).
      await notifyArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.SUBMISSION_CLOSED, actorId: null, payload: { nextStage },
      });

      // VENDOR: informational, in-app only, vendor URL.
      await notifyVendorsOfSubmissionClose(arcId);
    } catch (err) {
      logger.error({ err, arcId }, '[arcSubmissionClose] failed to close ARC submissions');
    }
  }

  logger.info({ summary }, '[arcSubmissionClose] sweep complete');
  return summary;
}

// Best-effort in-app notice to every invited vendor that the window has closed.
async function notifyVendorsOfSubmissionClose(arcId) {
  try {
    const arc = await arcModel.getById(arcId);
    if (!arc) return;
    const invitations = await arcModel.listInvitations(arcId);
    const vendorIds = invitations.map((i) => Number(i.vendor_id)).filter(Boolean);
    if (vendorIds.length === 0) return;

    await dispatchNotification({
      userIds:      vendorIds,
      senderUserId: null,
      category:     'ARC',
      type:         'SUBMISSION_CLOSED',
      title:        'Submissions closed',
      body:         `Quote submission for ${arc.title} (${arc.arc_number}) has closed. Thank you for participating.`,
      data:         { arc_id: arc.id, arc_number: arc.arc_number, event_type: 'submission_closed' },
      actionUrl:    `${VENDOR_BASE}/${arc.id}`,
    });
  } catch (err) {
    logger.error({ err, arcId }, '[arcSubmissionClose] vendor submission-closed notice failed');
  }
}

export default { runArcSubmissionCloseSweep };
