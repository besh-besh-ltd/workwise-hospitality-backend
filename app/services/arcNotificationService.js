/**
 * ARC Notification Service
 *
 * Central fan-out for all ARC lifecycle notifications. One call site per
 * transition:
 *   await notifyArcEvent({ arcId, eventType: ARC_EVENT_TYPES.X, actorId, payload });
 *
 * Design rules:
 *  - Always non-blocking: the whole body is wrapped so any failure is swallowed
 *    and logged. A rejection NEVER propagates to the caller.
 *  - Always post-commit: call sites are placed AFTER db.tx(...) resolves.
 *  - In-app always; email only when the event's config marks email:true.
 *  - Self-notification suppressed: actorId is filtered out of recipients.
 *  - Dedup by numeric user id (in-app) and lowercased email (email).
 */

import db from '../config/dbConn.js';
import arcModel from '../models/arc_v2/arcModel.js';
import arcEvalModel from '../models/arc_v2/arcEvaluationModel.js';
import rbacModel from '../models/rbacModel.js';
import { dispatch as dispatchNotification } from './notificationService.js';
import { sendMail, logError } from '../helper/common.js';
import { logger } from '../util/logger.js';
import { ARC_EVENT_TYPES } from './arcEventLogService.js';
import { getApprovalWorkflowUsers } from '../models/generalModel.js';
import { generateEmailTemplate } from '../helper/notificationEmailLayout.js';

const BUYER_BASE  = '/dashboard/buyer/rate-contracts';
const VENDOR_BASE = '/dashboard/vendor/rate-contracts';

// Audience tokens resolved per event config.
const AUDIENCE = Object.freeze({
  CREATOR:          'creator',
  TECH_EVALUATORS:  'tech_evaluators',
  COMM_EVALUATORS:  'comm_evaluators',
  // Routes to tech OR commercial evaluators depending on the ARC's next stage
  // (technical if the ARC has tech clauses, else commercial). Used by
  // submission_closed so only the evaluator who must act next is notified.
  NEXT_STAGE_EVALUATORS: 'next_stage_evaluators',
  COMMITTEE:        'committee',
  AWARDED_VENDORS:  'awarded_vendors',
  INVITED_VENDORS:  'invited_vendors',
  EVENT_VENDOR:     'event_vendor',
});

// ─── Event configuration ─────────────────────────────────────────────────────
//
// Each entry: {
//   audiences: [...AUDIENCE values],   // which groups to notify in-app
//   emailAudiences: [...] | null,       // if set, only these get email; else all if email:true
//   email: bool,                        // send email at all?
//   vendorFacing: bool,                 // true → actionUrl uses VENDOR_BASE
//   title: string,
//   body: (arc, payload) => string,
//   url: (arc, role) => string,         // role = 'vendor' | 'buyer'
// }
//
// For events with mixed channels per audience we call notifyArcEvent twice with
// recipientsOverride from the caller (see spec §"mixed channels").
const EVENT_CONFIG = {

  // ── Creation & lifecycle ──────────────────────────────────────────────────

  [ARC_EVENT_TYPES.PUBLISH_APPROVED]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        true,
    vendorFacing: false,
    title:        'Rate contract approved & live',
    body:         (arc) => `${arc.title} (${arc.arc_number}) was approved and is now open to vendors.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  // Sr 47 (Cap 2, Path A) — the mechanics are still the publish-reject path
  // (same event type/status, unchanged), only the copy is softened to read
  // as a send-back for revision rather than a hard kill.
  [ARC_EVENT_TYPES.PUBLISH_REJECTED]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        true,
    vendorFacing: false,
    title:        'Changes requested on your rate contract',
    body:         (arc, payload) => `The approver requested changes before publishing ${arc.title} (${arc.arc_number}).${payload.reason ? ' Note: ' + payload.reason : ''} Revise and re-publish to send it back for approval.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  // floated — creator only IN-APP (vendor email handled by existing notifyVendorsOfFloat)
  [ARC_EVENT_TYPES.PUBLISHED]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        false,
    vendorFacing: false,
    title:        'Your rate contract is live',
    body:         (arc) => `${arc.title} (${arc.arc_number}) is now open for vendor quotes.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.EXTENDED]: {
    audiences:    [AUDIENCE.INVITED_VENDORS],
    email:        true,
    vendorFacing: true,
    title:        'Submission deadline extended',
    body:         (arc, payload) => `The deadline for ${arc.title} (${arc.arc_number}) was extended${payload.newDeadline ? ' to ' + payload.newDeadline : ''}.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  // Buyer-facing close: creator (in-app) + the NEXT-STAGE evaluators (in-app +
  // email) who must now act — technical evaluators if the ARC has tech clauses,
  // else commercial. The vendor-facing "submissions closed" info is dispatched
  // separately (in-app only, vendor URL) by arcSubmissionCloseService.
  [ARC_EVENT_TYPES.SUBMISSION_CLOSED]: {
    audiences:    [AUDIENCE.NEXT_STAGE_EVALUATORS, AUDIENCE.CREATOR],
    emailAudiences: [AUDIENCE.NEXT_STAGE_EVALUATORS],
    email:        true,
    vendorFacing: false,
    title:        'Submissions closed — ready for evaluation',
    body:         (arc, payload) => {
      const stage = payload && (payload.nextStage === 'technical' || payload.nextStage === 'commercial')
        ? payload.nextStage : null;
      return `Quote submission for ${arc.title} (${arc.arc_number}) has closed${stage ? ` — begin ${stage} evaluation` : ''}.`;
    },
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.WITHDRAWN]: {
    audiences:    [AUDIENCE.INVITED_VENDORS],
    email:        true,
    vendorFacing: true,
    title:        'Rate contract withdrawn',
    body:         (arc) => `${arc.title} (${arc.arc_number}) has been withdrawn.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.TERMINATED]: {
    // awarded vendors first; caller falls back to invited when none exist (handled in resolveAudiences)
    audiences:    [AUDIENCE.AWARDED_VENDORS],
    email:        true,
    vendorFacing: true,
    title:        'Rate contract terminated',
    body:         (arc) => `${arc.title} (${arc.arc_number}) has been terminated.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.CLOSED_NO_AWARD]: {
    audiences:    [AUDIENCE.INVITED_VENDORS],
    email:        true,
    vendorFacing: true,
    title:        'Rate contract closed without award',
    body:         (arc) => `${arc.title} (${arc.arc_number}) was closed without an award.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  // ── Vendor invitation & response ─────────────────────────────────────────

  [ARC_EVENT_TYPES.VENDOR_INVITED]: {
    audiences:    [AUDIENCE.EVENT_VENDOR],
    email:        true,
    vendorFacing: true,
    title:        'New rate contract opportunity',
    body:         (arc) => `You've been invited to quote on ${arc.title} (${arc.arc_number}).`,
    url:          () => `${VENDOR_BASE}/requests`,
  },

  [ARC_EVENT_TYPES.VENDOR_SUBMITTED]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.COMM_EVALUATORS],
    email:        false,
    vendorFacing: false,
    title:        'Vendor submitted a quote',
    body:         (arc) => `A vendor submitted a quote for ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.VENDOR_TECH_SUBMITTED]: {
    audiences:    [AUDIENCE.TECH_EVALUATORS],
    email:        false,
    vendorFacing: false,
    title:        'Technical response ready for evaluation',
    body:         (arc) => `A technical response was submitted for ${arc.title} (${arc.arc_number}) and is ready for evaluation.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.VENDOR_WITHDREW]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        true,
    vendorFacing: false,
    title:        'Vendor withdrew from a rate contract',
    body:         (arc) => `A vendor withdrew from ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.VENDOR_DECLINED]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        false,
    vendorFacing: false,
    title:        'Vendor declined to participate',
    body:         (arc) => `A vendor declined participation in ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  // ── Technical evaluation ─────────────────────────────────────────────────

  [ARC_EVENT_TYPES.TECH_EVAL_OPENED]: {
    audiences:    [AUDIENCE.TECH_EVALUATORS],
    email:        true,
    vendorFacing: false,
    title:        'Technical evaluation open',
    body:         (arc) => `Technical evaluation is open for ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.TECH_EVAL_SUBMITTED]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        false,
    vendorFacing: false,
    title:        'Technical evaluation submitted',
    body:         (arc) => `Technical evaluation for ${arc.title} (${arc.arc_number}) was submitted and is pending approval.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.TECH_EVAL_APPROVED]: {
    audiences:    [AUDIENCE.COMM_EVALUATORS, AUDIENCE.CREATOR, AUDIENCE.TECH_EVALUATORS],
    emailAudiences: [AUDIENCE.COMM_EVALUATORS, AUDIENCE.CREATOR],
    email:        true,
    vendorFacing: false,
    title:        'Technical evaluation approved',
    body:         (arc) => `Technical evaluation for ${arc.title} (${arc.arc_number}) was approved. Commercial evaluation can proceed.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.TECH_EVAL_REJECTED]: {
    audiences:    [AUDIENCE.TECH_EVALUATORS, AUDIENCE.CREATOR],
    email:        true,
    vendorFacing: false,
    title:        'Technical evaluation rejected',
    body:         (arc) => `Technical evaluation for ${arc.title} (${arc.arc_number}) was rejected and needs rework.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  // Sr 54 — a held vendor was auto-promoted into evaluation because one of
  // the in-eval vendors ended up not_qualified. Tech evaluators only — the
  // copy stays blind (no vendor identity/price), same as the on-screen banner.
  [ARC_EVENT_TYPES.TECH_SHORTLIST_PROMOTED]: {
    audiences:    [AUDIENCE.TECH_EVALUATORS],
    email:        true,
    vendorFacing: false,
    title:        'A held vendor was moved into technical evaluation',
    body:         (arc) => `A shortlisted vendor did not qualify on ${arc.title} (${arc.arc_number}) — the next vendor in commercial rank was automatically moved into evaluation.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  // ── Commercial evaluation & committee ────────────────────────────────────

  [ARC_EVENT_TYPES.COMM_EVAL_OPENED]: {
    audiences:    [AUDIENCE.COMM_EVALUATORS],
    email:        true,
    vendorFacing: false,
    title:        'Commercial evaluation open',
    body:         (arc) => `Commercial evaluation is open for ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.COMM_EVAL_FINALIZED]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        true,
    vendorFacing: false,
    title:        'Commercial evaluation finalized',
    body:         (arc) => `Commercial evaluation for ${arc.title} (${arc.arc_number}) was finalized and sent to committee.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.COMM_EVAL_SENT_BACK]: {
    audiences:    [AUDIENCE.COMM_EVALUATORS],
    email:        true,
    vendorFacing: false,
    title:        'Commercial evaluation sent back',
    body:         (arc, payload) => `Commercial evaluation for ${arc.title} (${arc.arc_number}) was sent back for revision.${payload.reason ? ' Reason: ' + payload.reason : ''}`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.COMMITTEE_DECISION]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.COMM_EVALUATORS],
    email:        true,
    vendorFacing: false,
    title:        'Committee decision recorded',
    body:         (arc, payload) => `The committee ${payload.decision === 'rejected' ? 'sent back' : 'approved'} ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  // ── Contract (award → sign → active) ─────────────────────────────────────

  [ARC_EVENT_TYPES.CONTRACT_GENERATED]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        false,
    vendorFacing: false,
    title:        'Contracts generated',
    body:         (arc) => `Contracts were generated for ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.CONTRACT_AWAITING_ACCEPTANCE]: {
    audiences:    [AUDIENCE.AWARDED_VENDORS],
    email:        true,
    vendorFacing: true,
    title:        "You've been awarded a rate contract",
    body:         (arc) => `You've been awarded ${arc.title} (${arc.arc_number}). Please review and sign.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.CONTRACT_OTP_REQUESTED]: {
    audiences:    [AUDIENCE.EVENT_VENDOR],
    email:        false,
    vendorFacing: true,
    title:        'Signing OTP requested',
    body:         (arc) => `A one-time passcode was requested to sign ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.CONTRACT_SIGNED]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.COMM_EVALUATORS, AUDIENCE.EVENT_VENDOR],
    emailAudiences: [AUDIENCE.CREATOR, AUDIENCE.COMM_EVALUATORS],
    email:        true,
    vendorFacing: false,
    title:        'Vendor signed the rate contract',
    body:         (arc) => `A vendor signed the contract for ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.CONTRACT_ACTIVE]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.AWARDED_VENDORS],
    email:        true,
    vendorFacing: false,
    title:        'Rate contract active',
    body:         (arc) => `The rate contract ${arc.title} (${arc.arc_number}) is now active.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.CONTRACT_DECLINED]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.COMM_EVALUATORS],
    email:        true,
    vendorFacing: false,
    title:        'Vendor declined the contract',
    body:         (arc) => `A vendor declined the contract for ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  // ── Contract clarification loop ───────────────────────────────────────────

  [ARC_EVENT_TYPES.CLARIFICATION_REQUESTED]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.COMM_EVALUATORS],
    email:        true,
    vendorFacing: false,
    title:        'Vendor raised a clarification',
    body:         (arc) => `A vendor raised a clarification on the contract for ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.CLARIFICATION_REVISED]: {
    audiences:    [AUDIENCE.EVENT_VENDOR],
    email:        true,
    vendorFacing: true,
    title:        'Your clarification was addressed',
    body:         (arc) => `Your clarification on ${arc.title} (${arc.arc_number}) was addressed and a revised contract issued.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.CLARIFICATION_UPHELD]: {
    audiences:    [AUDIENCE.EVENT_VENDOR],
    email:        true,
    vendorFacing: true,
    title:        'Clarification reviewed',
    body:         (arc) => `Your clarification on ${arc.title} (${arc.arc_number}) was reviewed and the original terms upheld.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.CONTRACT_REISSUED]: {
    audiences:    [AUDIENCE.EVENT_VENDOR],
    email:        true,
    vendorFacing: true,
    title:        'Revised contract ready to sign',
    body:         (arc) => `A revised contract for ${arc.title} (${arc.arc_number}) is ready for your signature.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  // ── Amendments & addendum re-signing ─────────────────────────────────────

  [ARC_EVENT_TYPES.AMENDMENT_REQUESTED]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.COMM_EVALUATORS],
    email:        true,
    vendorFacing: false,
    title:        'Amendment requested',
    body:         (arc) => `A vendor requested an amendment on ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.AMENDMENT_APPROVED]: {
    audiences:    [AUDIENCE.EVENT_VENDOR],
    email:        true,
    vendorFacing: true,
    title:        'Amendment approved',
    body:         (arc) => `Your amendment on ${arc.title} (${arc.arc_number}) was approved. Please sign the addendum.`,
    url:          () => `${VENDOR_BASE}/amendments`,
  },

  [ARC_EVENT_TYPES.AMENDMENT_REJECTED]: {
    audiences:    [AUDIENCE.EVENT_VENDOR],
    email:        true,
    vendorFacing: true,
    title:        'Amendment rejected',
    body:         (arc) => `Your amendment request on ${arc.title} (${arc.arc_number}) was rejected.`,
    url:          () => `${VENDOR_BASE}/amendments`,
  },

  [ARC_EVENT_TYPES.AMENDMENT_AWAITING_SIGNATURE]: {
    audiences:    [AUDIENCE.EVENT_VENDOR],
    email:        true,
    vendorFacing: true,
    title:        'Addendum awaiting signature',
    body:         (arc) => `An addendum for ${arc.title} (${arc.arc_number}) is awaiting your signature.`,
    url:          () => `${VENDOR_BASE}/amendments`,
  },

  [ARC_EVENT_TYPES.ADDENDUM_SIGNED]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.COMM_EVALUATORS, AUDIENCE.EVENT_VENDOR],
    emailAudiences: [AUDIENCE.CREATOR, AUDIENCE.COMM_EVALUATORS],
    email:        true,
    vendorFacing: false,
    title:        'Addendum signed',
    body:         (arc) => `A vendor signed the addendum for ${arc.title} (${arc.arc_number}); the amendment now binds.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/amendments` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.AMENDMENT_SIGN_DECLINED]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        true,
    vendorFacing: false,
    title:        'Addendum signing declined',
    body:         (arc) => `A vendor declined to sign the addendum for ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.AMENDMENT_VOIDED]: {
    audiences:    [AUDIENCE.EVENT_VENDOR, AUDIENCE.CREATOR],
    email:        true,
    vendorFacing: true,
    title:        'Amendment voided',
    body:         (arc) => `An amendment on ${arc.title} (${arc.arc_number}) was voided.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/amendments` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.AMENDMENT_LIVE]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.EVENT_VENDOR],
    email:        true,
    vendorFacing: false,
    title:        'Amendment now in effect',
    body:         (arc) => `An amendment to ${arc.title} (${arc.arc_number}) is now in effect.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/amendments` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.AMENDMENT_ENDED]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.EVENT_VENDOR],
    email:        false,
    vendorFacing: false,
    title:        'Amendment ended',
    body:         (arc) => `An amendment period on ${arc.title} (${arc.arc_number}) has ended.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/amendments` : `${BUYER_BASE}/${arc.id}`,
  },

  // ── Expiry / renewal (cron-driven — wired only if cron exists) ────────────

  [ARC_EVENT_TYPES.EXPIRING_SOON]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.AWARDED_VENDORS],
    email:        true,
    vendorFacing: false,
    title:        'Rate contract expiring soon',
    body:         (arc, payload) => payload && payload.daysLeft
      ? `${arc.title} (${arc.arc_number}) expires in ${payload.daysLeft} day${payload.daysLeft === 1 ? '' : 's'}.`
      : `${arc.title} (${arc.arc_number}) is expiring soon.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.EXPIRED]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.AWARDED_VENDORS],
    email:        true,
    vendorFacing: false,
    title:        'Rate contract expired',
    body:         (arc) => `${arc.title} (${arc.arc_number}) has expired.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.RENEWED]: {
    audiences:    [AUDIENCE.CREATOR, AUDIENCE.AWARDED_VENDORS],
    email:        true,
    vendorFacing: false,
    title:        'Rate contract renewed',
    body:         (arc) => `${arc.title} (${arc.arc_number}) has been renewed.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  // ── ARC Negotiation rounds ────────────────────────────────────────────────
  // STARTED and QUOTE_RECEIVED use recipientsOverride at the call site so no
  // audience token is needed — the override bypasses the audience resolver.

  [ARC_EVENT_TYPES.NEGOTIATION_ROUND_CREATED]: {
    audiences:    [AUDIENCE.COMM_EVALUATORS, AUDIENCE.CREATOR],
    email:        false,
    vendorFacing: false,
    title:        'Negotiation round pending approval',
    body:         (arc, payload) => `A negotiation round (#${payload?.round_number ?? ''}) for ${arc.title} (${arc.arc_number}) is pending your approval.`,
    url:          (arc) => `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.NEGOTIATION_ROUND_STARTED]: {
    // recipientsOverride supplied by caller (targeted vendors only)
    audiences:    [],
    email:        true,
    vendorFacing: true,
    title:        'Negotiation round active — submit your revised rate',
    body:         (arc, payload) => `A negotiation round is now active on ${arc.title} (${arc.arc_number}). Please submit a revised rate before the deadline.`,
    url:          (arc) => `${VENDOR_BASE}/requests/${arc.id}`,
  },

  [ARC_EVENT_TYPES.NEGOTIATION_QUOTE_RECEIVED]: {
    audiences:    [AUDIENCE.COMM_EVALUATORS, AUDIENCE.CREATOR],
    email:        true,
    vendorFacing: false,
    title:        'Vendor submitted a revised rate',
    body:         (arc, payload) => `A vendor submitted a revised rate for ${arc.title} (${arc.arc_number})${payload?.arc_item_id ? ` (item ${payload.arc_item_id})` : ''}.`,
    url:          (arc) => `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.NEGOTIATION_ROUND_ENDED]: {
    audiences:    [AUDIENCE.COMM_EVALUATORS, AUDIENCE.CREATOR],
    email:        true,
    vendorFacing: false,
    title:        'Negotiation round ended',
    body:         (arc, payload) => `A negotiation round has ended for ${arc.title} (${arc.arc_number}). Review the revised rates.`,
    url:          (arc) => `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.NEGOTIATION_ROUND_EXPIRED]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        false,
    vendorFacing: false,
    title:        'Negotiation round expired without approval',
    body:         (arc) => `A negotiation round for ${arc.title} (${arc.arc_number}) expired before it could be approved.`,
    url:          (arc) => `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.NEGOTIATION_ROUND_REJECTED]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        false,
    vendorFacing: false,
    title:        'Negotiation round rejected',
    body:         (arc) => `A negotiation round for ${arc.title} (${arc.arc_number}) was rejected.`,
    url:          (arc) => `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.NEGOTIATION_ROUND_CLOSED]: {
    audiences:    [AUDIENCE.COMM_EVALUATORS],
    email:        false,
    vendorFacing: false,
    title:        'Negotiation round closed',
    body:         (arc) => `A negotiation round for ${arc.title} (${arc.arc_number}) was closed by the evaluator.`,
    url:          (arc) => `${BUYER_BASE}/${arc.id}`,
  },

  // ── Call-off ──────────────────────────────────────────────────────────────

  [ARC_EVENT_TYPES.CALL_OFF_RELEASED]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        false,
    vendorFacing: false,
    title:        'Call-off order released',
    body:         (arc) => `A call-off order was released against ${arc.title} (${arc.arc_number}).`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },

  [ARC_EVENT_TYPES.CALL_OFF_REJECTED]: {
    audiences:    [AUDIENCE.CREATOR],
    email:        false,
    vendorFacing: false,
    title:        'Call-off order rejected',
    body:         (arc) => `A call-off order against ${arc.title} (${arc.arc_number}) was rejected.`,
    url:          (arc, role) => role === 'vendor' ? `${VENDOR_BASE}/${arc.id}` : `${BUYER_BASE}/${arc.id}`,
  },
};

// ─── Recipient resolution ─────────────────────────────────────────────────────

/**
 * Resolve all audiences listed in cfg into [{id, name, email}] user objects.
 * For TERMINATED: if AWARDED_VENDORS resolves to empty, fall back to INVITED_VENDORS
 * so the audience is never empty when contracts haven't been generated yet.
 */
async function resolveAudiences(audiences, arc, payload) {
  const all = [];
  const audiencesSet = new Set(audiences);

  for (const aud of audiences) {
    const users = await resolveOneAudience(aud, arc, payload);
    all.push(...users);
  }

  // Special fallback: terminated ARC with no contracts yet — fall back to invited
  if (audiencesSet.has(AUDIENCE.AWARDED_VENDORS)) {
    const awarded = all.filter((u) => u._audience === AUDIENCE.AWARDED_VENDORS);
    if (awarded.length === 0 && !audiencesSet.has(AUDIENCE.INVITED_VENDORS)) {
      const invitedFallback = await resolveOneAudience(AUDIENCE.INVITED_VENDORS, arc, payload);
      all.push(...invitedFallback);
    }
  }

  return all;
}

async function resolveOneAudience(audience, arc, payload) {
  const tag = (users) => users.map((u) => ({ ...u, _audience: audience }));
  try {
    switch (audience) {
      case AUDIENCE.CREATOR: {
        const user = await db.oneOrNone(
          `SELECT id, name, email FROM tbl_users WHERE id = $1`,
          [arc.created_by]
        );
        return user ? tag([user]) : [];
      }
      case AUDIENCE.TECH_EVALUATORS: {
        const users = await rbacModel.getUsersWithModuleActionsForHotels(
          [arc.hotel_id], 'arc-tech', ['evaluate'], arc.department_id
        );
        return tag(users);
      }
      case AUDIENCE.COMM_EVALUATORS: {
        const users = await rbacModel.getUsersWithModuleActionsForHotels(
          [arc.hotel_id], 'arc-comm', ['evaluate'], arc.department_id
        );
        return tag(users);
      }
      case AUDIENCE.NEXT_STAGE_EVALUATORS: {
        // Mirror the lifecycle: technical stage first iff the ARC has tech
        // clauses (arcHasTechClauses), else commercial. The caller may pass
        // payload.nextStage to avoid a re-query and keep message + audience
        // in lockstep; fall back to computing it here.
        let stage = payload && payload.nextStage;
        if (stage !== 'technical' && stage !== 'commercial') {
          stage = (await arcEvalModel.arcHasTechClauses(arc.id)) ? 'technical' : 'commercial';
        }
        const resource = stage === 'technical' ? 'arc-tech' : 'arc-comm';
        const users = await rbacModel.getUsersWithModuleActionsForHotels(
          [arc.hotel_id], resource, ['evaluate'], arc.department_id
        );
        return tag(users);
      }
      case AUDIENCE.COMMITTEE: {
        let users = [];
        try {
          const rows = await getApprovalWorkflowUsers('ARC_COMMITTEE', arc.id);
          users = rows.map((r) => ({ id: r.user_id, name: r.name, email: r.email }));
        } catch (_) {
          // fallback: role lookup
          users = await rbacModel.getUsersWithModuleActionsForHotels(
            [arc.hotel_id], 'arc-comm', ['read'], arc.department_id
          );
        }
        if (!users.length) {
          users = await rbacModel.getUsersWithModuleActionsForHotels(
            [arc.hotel_id], 'arc-comm', ['read'], arc.department_id
          );
        }
        return tag(users);
      }
      case AUDIENCE.AWARDED_VENDORS: {
        const rows = await db.any(
          `SELECT c.vendor_id AS id, u.name, u.email
             FROM tbl_arc_contract c
             JOIN tbl_users u ON u.id = c.vendor_id
            WHERE c.arc_id = $1`,
          [arc.id]
        );
        return tag(rows);
      }
      case AUDIENCE.INVITED_VENDORS: {
        const invitations = await arcModel.listInvitations(arc.id);
        return tag(
          invitations
            .filter((i) => i.vendor_id != null)
            .map((i) => ({ id: i.vendor_id, name: i.vendor_name, email: i.vendor_email }))
        );
      }
      case AUDIENCE.EVENT_VENDOR: {
        if (!payload.vendorId) return [];
        const user = await db.oneOrNone(
          `SELECT id, name, email FROM tbl_users WHERE id = $1`,
          [payload.vendorId]
        );
        return user ? tag([user]) : [];
      }
      default:
        return [];
    }
  } catch (err) {
    logger.warn({ err, audience, arcId: arc.id }, '[arcNotify] resolveOneAudience failed');
    return [];
  }
}

// ─── Deduplication helpers ────────────────────────────────────────────────────

function dedupeUsers(list) {
  const seen = new Set();
  return list.filter((u) => {
    const key = Number(u.id);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function normalizeOverride(list) {
  if (!Array.isArray(list)) return [];
  // Accept [{id,name,email}] or plain ids
  return list
    .filter(Boolean)
    .map((r) => {
      if (typeof r === 'number' || (typeof r === 'string' && /^\d+$/.test(r))) {
        return { id: Number(r), name: null, email: null };
      }
      if (typeof r === 'object') {
        return { id: Number(r.id || r.user_id || 0), name: r.name || null, email: r.email || null };
      }
      return null;
    })
    .filter((r) => r && r.id);
}

// ─── Email renderer ───────────────────────────────────────────────────────────

function renderArcEmail({ arc, title, body, url, recipientName }) {
  const greeting = recipientName ? `Hello ${recipientName},` : 'Hello,';
  const frontendBase = process.env.FRONT_END_WEBSITE || '';
  const fullUrl = url ? (url.startsWith('http') ? url : `${frontendBase}${url}`) : null;

  const headerContent = `<h2 style="margin: 0 0 8px; font-size: 20px; color: #1A5C7E;">${title}</h2>`;
  const containerContent = `
    <p style="font-size: 15px; margin: 0 0 16px; color: #333;">${greeting}</p>
    <p style="font-size: 15px; margin: 0 0 20px; color: #333;">${body}</p>
    ${fullUrl ? `
    <a href="${fullUrl}"
       style="background-color: #1A5C7E; color: #fff; padding: 10px 22px;
              text-decoration: none; border-radius: 5px; display: inline-block;">
      View Rate Contract
    </a>` : ''}
  `;
  return generateEmailTemplate(headerContent, containerContent);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * notifyArcEvent — fan out in-app + optional email notifications for one
 * ARC lifecycle event. Always resolves (never throws). Call AFTER db.tx commits.
 *
 * @param {object} opts
 * @param {number} opts.arcId
 * @param {string} opts.eventType  — ARC_EVENT_TYPES value
 * @param {number|null} opts.actorId  — suppressed from recipients
 * @param {object} opts.payload       — vendorId, reason, decision, etc.
 * @param {Array|null} opts.recipientsOverride — bypass audience resolution
 */
export async function notifyArcEvent({ arcId, eventType, actorId = null, payload = {}, recipientsOverride = null }) {
  try {
    const cfg = EVENT_CONFIG[eventType];
    if (!cfg) return;  // deliberately unconfigured event

    const arc = await arcModel.getById(arcId);
    if (!arc) return;

    // 1. Resolve recipients
    const rawRecipients = recipientsOverride
      ? await normalizeOverride(recipientsOverride)
      : await resolveAudiences(cfg.audiences, arc, payload);

    const targets = dedupeUsers(rawRecipients).filter(
      (u) => Number(u.id) !== Number(actorId)
    );
    if (targets.length === 0) return;

    const title = cfg.title;
    const body  = cfg.body(arc, payload);
    const role  = cfg.vendorFacing ? 'vendor' : 'buyer';
    const actionUrl = cfg.url(arc, role);

    // 2. In-app (always)
    await dispatchNotification({
      userIds:      targets.map((u) => Number(u.id)).filter(Boolean),
      senderUserId: actorId,
      category:     'ARC',
      type:         eventType.toUpperCase().replace(/-/g, '_'),
      title,
      body,
      data: {
        arc_id:     arc.id,
        arc_number: arc.arc_number,
        event_type: eventType,
        ...(payload?.notifyData || {}),
      },
      actionUrl,
    }).catch((e) => logError('[arcNotify] in-app dispatch failed', e));

    // 3. Email (only when cfg.email)
    if (cfg.email) {
      // When emailAudiences is specified, only those audience members get email
      let emailTargets = targets;
      if (cfg.emailAudiences) {
        const emailAudienceSet = new Set(cfg.emailAudiences);
        // rawRecipients carry _audience tag; but dedupeUsers strips it — re-tag
        const taggedRaw = recipientsOverride
          ? rawRecipients
          : await resolveAudiences(cfg.audiences, arc, payload);

        // Build the set of ids that belong to email-eligible audiences
        const emailEligibleIds = new Set(
          taggedRaw
            .filter((u) => emailAudienceSet.has(u._audience))
            .map((u) => Number(u.id))
        );
        emailTargets = targets.filter((u) => emailEligibleIds.has(Number(u.id)));
      }

      const seen = new Set();
      for (const u of emailTargets) {
        const email = (u.email || '').trim().toLowerCase();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        sendMail({
          to:      u.email,
          subject: title,
          html:    renderArcEmail({ arc, title, body, url: actionUrl, recipientName: u.name }),
        }).catch((e) => logError('[arcNotify] email failed', e));
      }
    }
  } catch (err) {
    logger.error({ err, arcId, eventType }, '[arcNotificationService] notifyArcEvent failed (swallowed)');
  }
}
