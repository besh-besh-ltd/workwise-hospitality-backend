// Per-caller "needs your response" work on RFQs.
//
// Distinct from getActionHoldersForRFQs, which answers "who CAN act" for the
// whole RFQ from lifecycle stage + RBAC. These four sources answer "what must
// THIS user personally do", and none of them emits an email or notification
// today — so the RFQ listing is the only place they can surface at all.
//
// Every source is creator- or recipient-scoped on purpose. The existing
// `unseen_query_count` (rfqModel.js, in getAllBuyerRfq's SELECT list) was
// rejected as a trigger: it is per-caller but fires for EVERY user whose scope
// covers the RFQ, which would recreate the flood this work exists to fix.
// tbl_query_messages.receiver_id names exactly one person and is populated on
// every vendor message.

import db from '../../config/dbConn.js';
import { logError } from '../../helper/common.js';

// Read straight off the already-computed lifecycle stage. These two stages
// additionally require "no eligible vendors", which a naive "published and
// past deadline" test does not — the difference in production is 53 rows
// versus 369.
const STUCK_STAGES = new Set(['RFQ_STUCK_COMMERCIAL', 'RFQ_STUCK_TECHNICAL']);

/**
 * @param {Array} rfqList  RFQ rows (need id, created_by)
 * @param {number} userId  the calling user
 * @param {Object} lifecycleMap { rfq_id: lifecycle_stage } from computeLifecycleStages
 * @returns {Promise<Object>} { [rfq_id]: [{ code, label, count }] } — RFQs with
 *   no personal work are absent from the map entirely.
 */
export async function getPersonalPendingForRFQs(rfqList, userId, lifecycleMap = {}) {
  if (!Array.isArray(rfqList) || rfqList.length === 0) return {};

  const uid = Number(userId);
  if (!Number.isFinite(uid)) return {};

  // A closed (2) or withdrawn (5) RFQ has no pending work of ANY kind. This
  // mirrors the guard in getActionHoldersForRFQs and has to be repeated here,
  // because these sources do not go through that helper. Without it the exact
  // defect this module is part of fixing comes back through a different door:
  // closeRFQ never clears tbl_rfq_clarifications, and the RFQ_STUCK_* branches
  // of computeLifecycleStages never read rd.status — so an RFQ closed after a
  // failed technical evaluation would report "No eligible vendors — extend or
  // close" forever, on a card whose status pill reads "Closed".
  const live = rfqList.filter((r) => {
    const s = Number(r.status);
    return s !== 2 && s !== 5;
  });
  if (live.length === 0) return {};

  const ids = live.map((r) => parseInt(r.id)).filter(Number.isFinite);
  if (ids.length === 0) return {};

  // RFQs this user created. The three creator-scoped sources only apply here:
  // resolving a clarification, extending/closing a stuck RFQ and closing a
  // negotiation round are all creator-gated in the controllers.
  const mine = live
    .filter((r) => Number(r.created_by) === uid)
    .map((r) => parseInt(r.id))
    .filter(Number.isFinite);

  const out = {};
  const add = (rfqId, reason) => {
    const key = parseInt(rfqId);
    if (!out[key]) out[key] = [];
    out[key].push(reason);
  };

  // 1. Stuck — the bid window closed with no eligible vendors. Only the
  //    creator can extend the deadline, add vendors, or close
  //    (assertEditAllowed in rfqUpdateHelpers.js is creator-only).
  for (const rfqId of mine) {
    if (STUCK_STAGES.has(lifecycleMap[rfqId])) {
      add(rfqId, { code: 'STUCK_NO_VENDORS', label: 'No eligible vendors — extend or close', count: 1 });
    }
  }

  try {
    // 2. Open clarification. Blocks EVERY vendor from quoting, and only the
    //    creator can resolve it. Sends no email or notification, so without
    //    this the task is discoverable only by polling the RFQ.
    if (mine.length > 0) {
      const clarifications = await db.any(
        `SELECT rfq_id, COUNT(*)::int AS n
           FROM tbl_rfq_clarifications
          WHERE rfq_id = ANY($1::int[]) AND status = 'OPEN'
          GROUP BY rfq_id`,
        [mine]
      );
      for (const r of clarifications) {
        add(r.rfq_id, {
          code: 'CLARIFICATION_OPEN',
          label: r.n === 1
            ? 'Clarification blocking all quotes'
            : `${r.n} clarifications blocking all quotes`,
          count: r.n,
        });
      }
    }

    // 3. Unread vendor query messages addressed to this user (sender_type 3 =
    //    vendor). Scoped by receiver_id, not by "anyone who can see the RFQ".
    const unread = await db.any(
      `SELECT qm.rfq_id, COUNT(*)::int AS n
         FROM tbl_query_messages qm
        WHERE qm.rfq_id = ANY($1::int[])
          AND qm.sender_type = 3
          AND qm.receiver_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM tbl_query_message_reads r
             WHERE r.message_id = qm.id AND r.user_id = $2
          )
        GROUP BY qm.rfq_id`,
      [ids, uid]
    );
    for (const r of unread) {
      add(r.rfq_id, {
        code: 'UNREAD_VENDOR_QUERIES',
        label: r.n === 1 ? '1 unread vendor query' : `${r.n} unread vendor queries`,
        count: r.n,
      });
    }

    // 4. A negotiation round still ACTIVE past its end date. A round whose
    //    window is still OPEN is the same situation as AWAITING_QUOTES
    //    (vendors are still responding), so it is deliberately excluded.
    //
    //    The label does NOT ask the creator to close the round: nothing in the
    //    UI can. handleNegotiationRoundExpiration flips ACTIVE -> ENDED on its
    //    own, driven by a one-shot job at create time, a boot sweep and a
    //    5-minute cron backstop (cronManager.js). What the creator actually
    //    owes here is the review of what came back, which is the same action
    //    the round-ended email and the ARC notification both ask for
    //    ("Review the revised rates", arcNotificationService.js).
    //
    //    Note this row can therefore be transient — it should clear itself
    //    within ~5 minutes of the deadline. If it persists, the round is stuck
    //    ACTIVE and the sweeper is the thing to look at, not the buyer.
    if (mine.length > 0) {
      const rounds = await db.any(
        `SELECT rfq_id, COUNT(*)::int AS n
           FROM tbl_negotiation_rounds
          WHERE rfq_id = ANY($1::int[])
            AND status = 'ACTIVE'
            AND end_date IS NOT NULL
            -- now() AT TIME ZONE 'UTC', not Asia/Kolkata: end_date is a naive
            -- column holding UTC, so converting the clock to IST compared it
            -- against wall time 5h30m ahead and called every round expired
            -- 5.5 hours early. Must stay identical to the sweeper's predicate
            -- in cronManager.js (runNegotiationRoundClosureSweep) — when the
            -- two disagree this flag fires on rounds the sweeper is correctly
            -- refusing to close, so the row cannot clear.
            AND end_date <= (now() AT TIME ZONE 'UTC')
          GROUP BY rfq_id`,
        [mine]
      );
      for (const r of rounds) {
        add(r.rfq_id, {
          code: 'NEGOTIATION_ROUND_EXPIRED',
          label: 'Negotiation round ended — review the revised rates',
          count: r.n,
        });
      }
    }
  } catch (err) {
    logError('getPersonalPendingForRFQs error', err);
    // Degrade to "no personal work" rather than breaking the whole listing.
    return {};
  }

  return out;
}

export default { getPersonalPendingForRFQs };
