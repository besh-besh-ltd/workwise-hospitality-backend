import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';

/**
 * ARC Event Log Service
 *
 * Append-only narrative event log for ARC lifecycle. Mirrors the audit pattern
 * used elsewhere (e.g. `recordLifecycleEvent` in generalModel.js for approval
 * instances), but scoped to ARC entities specifically — covers events that are
 * not approval-instance-driven (vendor invitations, quote submissions, vendor
 * sign, MR linkage, etc.) and serves as the narrative companion to the
 * approval-engine audit (tbl_approval_actions).
 *
 * Why both: snapshots in tbl_arc_comm_evaluation_award + tbl_arc_contract_line
 * protect the *decision*; tbl_arc_event_log captures the *who/what/when*.
 *
 * Usage:
 *   await logArcEvent({ arcId, eventType: 'floated', actorId: req.user.id, payload: {...} });
 *   await logArcEvent({ arcId, eventType: 'vendor_submitted', actorId, payload, txContext: t });
 *
 * Failures are logged but never thrown — the event log is a side-channel and
 * must not block primary state transitions.
 */
export const ARC_EVENT_TYPES = Object.freeze({
  // Creation & lifecycle
  CREATED: 'created',
  // Publish approval gate (buyer-internal — NOT vendor-safe)
  PUBLISH_SUBMITTED: 'publish_submitted',
  PUBLISH_APPROVED:  'publish_approved',
  PUBLISH_REJECTED:  'publish_rejected',
  PUBLISHED: 'floated',
  EXTENDED: 'deadline_extended',
  WITHDRAWN: 'withdrawn',
  TERMINATED: 'terminated',
  CLOSED_NO_AWARD: 'closed_no_award',
  SUBMISSION_CLOSED: 'submission_closed',
  // Sr 27 (Option C) — deferred float notification. Logged the moment the
  // vendor "it's open for quotes" notification is actually SENT: either right
  // away at float time (submission_start_at already <= now / absent), or later
  // by the submission-open sweep once submission_start_at passes. Doubles as
  // the idempotency marker so the sweep never double-sends (see
  // arcSubmissionOpenService.js) — no new column needed.
  SUBMISSION_OPENED: 'submission_opened',
  // Vendor invitation & response
  VENDOR_INVITED: 'vendor_invited',
  VENDOR_VIEWED: 'vendor_viewed',
  VENDOR_SUBMITTED: 'vendor_submitted',
  VENDOR_TECH_SUBMITTED: 'vendor_tech_submitted',
  VENDOR_WITHDREW: 'vendor_withdrew',
  VENDOR_DECLINED: 'vendor_declined',
  // Tech eval
  TECH_EVAL_OPENED: 'tech_eval_opened',
  TECH_EVAL_SCORED: 'tech_eval_scored',
  TECH_EVAL_SUBMITTED: 'tech_eval_submitted',
  TECH_EVAL_APPROVED: 'tech_eval_approved',
  TECH_EVAL_REJECTED: 'tech_eval_rejected',
  // Sr 54 — commercial-ranked technical-evaluation shortlist: an on-hold
  // vendor was auto-promoted into evaluation because an in-eval vendor ended
  // up not_qualified.
  TECH_SHORTLIST_PROMOTED: 'tech_shortlist_promoted',
  // Commercial eval + committee
  COMM_EVAL_OPENED: 'comm_eval_opened',
  COMM_EVAL_ALLOCATION_UPDATED: 'comm_eval_allocation_updated',
  COMM_EVAL_FINALIZED: 'comm_eval_finalized',
  COMM_EVAL_SENT_BACK: 'comm_eval_sent_back',
  COMMITTEE_DECISION: 'committee_decision',
  // Contract
  CONTRACT_GENERATED: 'contract_generated',
  CONTRACT_AWAITING_ACCEPTANCE: 'contract_awaiting_acceptance',
  CONTRACT_OTP_REQUESTED: 'contract_otp_requested',
  CONTRACT_SIGNED: 'contract_signed',
  CONTRACT_DECLINED: 'contract_declined',
  CONTRACT_ACTIVE: 'contract_active',
  // Vendor contract clarification loop (pre-signature dispute → CE re-edit → re-award)
  CLARIFICATION_REQUESTED: 'contract_clarification_requested',
  CLARIFICATION_REVISED: 'contract_clarification_revised',
  CLARIFICATION_UPHELD: 'contract_clarification_upheld',
  CONTRACT_REISSUED: 'contract_reissued',
  // Amendments (Phase C)
  AMENDMENT_REQUESTED: 'amendment_requested',
  AMENDMENT_APPROVED: 'amendment_approved',
  AMENDMENT_REJECTED: 'amendment_rejected',
  AMENDMENT_LIVE: 'amendment_live',
  AMENDMENT_ENDED: 'amendment_ended',
  // Addendum re-signing (amendment binds only after the vendor re-signs)
  AMENDMENT_AWAITING_SIGNATURE: 'amendment_awaiting_signature',
  ADDENDUM_SIGNED: 'addendum_signed',
  AMENDMENT_SIGN_DECLINED: 'amendment_sign_declined',
  AMENDMENT_VOIDED: 'amendment_voided',
  // Negotiation rounds (ARC v2 commercial evaluation)
  NEGOTIATION_ROUND_CREATED:  'negotiation_round_created',
  NEGOTIATION_ROUND_STARTED:  'negotiation_round_started',
  NEGOTIATION_QUOTE_RECEIVED: 'negotiation_quote_received',
  NEGOTIATION_ROUND_ENDED:    'negotiation_round_ended',
  NEGOTIATION_ROUND_EXPIRED:  'negotiation_round_expired',
  NEGOTIATION_ROUND_REJECTED: 'negotiation_round_rejected',
  NEGOTIATION_ROUND_CLOSED:   'negotiation_round_closed',
  // Expiry / renewal
  EXPIRING_SOON: 'expiring_soon',
  EXPIRED: 'expired',
  RENEWED: 'renewed',
  // Call-off
  CALL_OFF_RELEASED: 'call_off_released',
  CALL_OFF_REJECTED: 'call_off_rejected',
});

export async function logArcEvent({ arcId, eventType, actorId = null, payload = {}, txContext = null }) {
  if (!arcId || !eventType) {
    logger.warn({ arcId, eventType }, '[arcEventLog] missing required args — skipping');
    return null;
  }
  try {
    const runner = txContext || db;
    return await runner.oneOrNone(
      `INSERT INTO tbl_arc_event_log (arc_id, event_type, actor_id, payload, at)
       VALUES ($1, $2, $3, $4::jsonb, CURRENT_TIMESTAMP)
       RETURNING id`,
      [arcId, eventType, actorId, JSON.stringify(payload || {})]
    );
  } catch (err) {
    logger.error({ err, arcId, eventType }, '[arcEventLog] failed to write event');
    return null;
  }
}

export async function getArcEvents(arcId, { limit = 100, offset = 0 } = {}) {
  return db.any(
    `SELECT el.id, el.event_type, el.payload, el.at,
            u.id AS actor_id, u.name AS actor_name, u.email AS actor_email
       FROM tbl_arc_event_log el
       LEFT JOIN tbl_users u ON u.id = el.actor_id
      WHERE el.arc_id = $1
      ORDER BY el.at DESC
      LIMIT $2 OFFSET $3`,
    [arcId, limit, offset]
  );
}
