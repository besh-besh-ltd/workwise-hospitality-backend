// Telling people about a PO put on hold for information (client ticket T3).
//
//   requested → the person asked; link: the PO.
//   answered  → whoever asked, plus every approver still PENDING on the held
//               step (any of them may now decide), never the person who
//               answered; link: the PO's approval.
//   withdrawn → the person asked; link: the PO.
//   closed    → the person asked, when the approval the hold froze ended or
//               was restarted (PO edited, RFQ closed, policy or membership
//               change, approval cancelled); link: the PO.
//   reminder  → the person asked, once, when the hold is 48 hours old
//               (remindOpenHolds); link: the PO.
//
// In the app (notificationService.dispatch) and by email. Active buyers only:
// never a vendor, an inactive or deleted account, or the actor.
//
// WHEN: after the transaction that wrote the change commits. Never throws: a
// notification problem must not turn a committed change into an error.
// Mirrors poRejectionNotifier.

import db from "../../config/dbConn.js";
import config from "../../config/app.config.js";
import { sendMail, logError } from "../../helper/common.js";
import { logger } from "../../util/logger.js";
import { generateEmailTemplate, emailButton } from "../../helper/notificationEmailLayout.js";
import { clampText } from "../../helper/poReference.js";
import { quoteInSentence } from "../../helper/quoteInSentence.js";
import { dispatch as dispatchNotification } from "../notificationService.js";
import { buyerPoApproval, buyerPoDetail, toAbsoluteUrl } from "../notificationLinks.js";
import { reasonLabel } from "./poSendBackReasons.js";
import { afterCommitOf } from "../approvalEvents.js";

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The send-back with what the copy needs, or null. */
async function loadContext(sendBackId) {
  return db.oneOrNone(
    `SELECT sb.id, sb.status, sb.resolution, sb.reason_category, sb.comment, sb.response_text,
            sb.requested_by, rq.name AS requested_by_name,
            sb.target_user_id, sb.approval_instance_step_id,
            po.id AS po_id, po.po_number, po.rfq_id, r.rfq_no
       FROM tbl_po_send_backs sb
       JOIN tbl_rfq_purchase_order po ON po.id = sb.purchase_order_id
       LEFT JOIN tbl_rfq r ON r.id = po.rfq_id
       LEFT JOIN tbl_users rq ON rq.id = sb.requested_by
      WHERE sb.id = $1`,
    [sendBackId]
  );
}

/** Active buyers among `userIds`, minus the actor. */
async function activeBuyers(userIds, actorId) {
  const ids = [...new Set((userIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return [];
  return db.any(
    `SELECT id AS user_id, name, email
       FROM tbl_users
      WHERE id = ANY($1::int[])
        AND id <> $2
        AND status = 1
        AND COALESCE(is_deleted, 0) = 0
        AND COALESCE(user_type, 0) <> 3
      ORDER BY id`,
    [ids, actorId || 0]
  );
}

const poLabelOf = (ctx) => `PO ${ctx.po_number || `#${ctx.po_id}`}`;
const rfqPart = (ctx) => (ctx.rfq_no ? ` (RFQ ${ctx.rfq_no})` : "");

/** Why a hold was closed, by its resolution, for the "closed" copy. */
export const CLOSED_BECAUSE = Object.freeze({
  PO_AMENDED_RESTARTED: "the PO was edited",
  RFQ_CLOSED: "the RFQ was closed",
  // A policy edit that removed, reshaped or moved past the held step, the held
  // step's role losing approve, or its last approver leaving. Nothing restarts
  // on any of these. cancelApprovalInstance passes its own reason instead.
  PO_SUPERSEDED: "the approval steps for this PO changed",
});

/** Title, body, link and button per event. Exported for copy tests. */
export function buildSendBackCopy(event, { ctx, actorName, because }) {
  const who = actorName || "Someone";
  const po = poLabelOf(ctx);
  if (event === "closed") {
    const why = because || CLOSED_BECAUSE[ctx.resolution] || "the approval it was waiting on ended";
    return {
      title: clampText(`Request for information on ${po} closed`),
      body: `The request for information on ${po} was closed because ${why}. Nothing more is needed from you.`,
      linkPath: buyerPoDetail(ctx.po_id),
      button: "Open the purchase order",
    };
  }
  if (event === "reminder") {
    const asker = ctx.requested_by_name || "An approver";
    return {
      title: clampText(`Reminder: ${po} is waiting for your answer`),
      body: `${asker} asked you for information on ${po}${rfqPart(ctx)}: ${reasonLabel(ctx.reason_category)}.${quoteInSentence(ctx.comment)} The approval is waiting for your answer.`,
      linkPath: buyerPoDetail(ctx.po_id),
      button: "Answer on the purchase order",
    };
  }
  if (event === "requested") {
    return {
      title: clampText(`${po} is on hold: ${who} needs information from you`),
      body: `${who} asked you for information on ${po}${rfqPart(ctx)}: ${reasonLabel(ctx.reason_category)}.${quoteInSentence(ctx.comment)} The approval waits until you answer.`,
      linkPath: buyerPoDetail(ctx.po_id),
      button: "Answer on the purchase order",
    };
  }
  if (event === "answered") {
    return {
      title: clampText(`${who} answered the question on ${po}`),
      body: `${who} answered the request for information on ${po}${rfqPart(ctx)}.${quoteInSentence(ctx.response_text)} The approval can continue.`,
      linkPath: buyerPoApproval(ctx.po_id, ctx.rfq_id),
      button: "Review and decide",
    };
  }
  return {
    title: clampText(`Request for information on ${po} withdrawn`),
    body: `${who} withdrew the request for information on ${po}${rfqPart(ctx)}. Nothing more is needed from you.`,
    linkPath: buyerPoDetail(ctx.po_id),
    button: "Open the purchase order",
  };
}

const TYPES = Object.freeze({
  requested: "po_send_back_requested",
  answered: "po_send_back_answered",
  withdrawn: "po_send_back_withdrawn",
  closed: "po_send_back_closed",
  reminder: "po_send_back_reminder",
});

async function recipientsFor(event, ctx, actorId) {
  if (event === "answered") {
    const onStep = ctx.approval_instance_step_id
      ? await db.any(
          `SELECT approver_user_id AS id FROM tbl_approval_step_approvers
            WHERE approval_instance_step_id = $1 AND status = 'PENDING' AND removed_at IS NULL`,
          [ctx.approval_instance_step_id]
        )
      : [];
    return activeBuyers([ctx.requested_by, ...onStep.map((r) => r.id)], actorId);
  }
  return activeBuyers([ctx.target_user_id], actorId);
}

async function notifyNow(event, { sendBackId, actorId, because }) {
  try {
    const ctx = await loadContext(sendBackId);
    if (!ctx) return;
    const [actor, recipients] = await Promise.all([
      actorId ? db.oneOrNone(`SELECT name FROM tbl_users WHERE id = $1`, [actorId]) : null,
      recipientsFor(event, ctx, actorId),
    ]);
    if (!recipients.length) {
      logger.info({ send_back_id: ctx.id, event }, "[poSendBackNotifier] no one to notify");
      return;
    }
    const { title, body, linkPath, button } = buildSendBackCopy(event, { ctx, actorName: actor?.name, because });

    await dispatchNotification({
      userIds: recipients.map((r) => r.user_id),
      senderUserId: actorId || null,
      category: "po",
      type: TYPES[event],
      title,
      body,
      data: {
        po_id: Number(ctx.po_id),
        rfq_id: ctx.rfq_id == null ? null : Number(ctx.rfq_id),
        rfq_no: ctx.rfq_no || null,
        send_back_id: Number(ctx.id),
        reason_category: ctx.reason_category,
      },
      actionUrl: linkPath,
    });

    const url = toAbsoluteUrl(linkPath);
    const mails = [];
    for (const r of recipients) {
      if (!r.email) continue;
      try {
        const headerContent = `<h2>Hello ${esc(r.name || "")},</h2>`;
        const containerContent = `
          <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
            <div style="background-color:#FEF3C7; border-left:4px solid #F59E0B; padding:16px; margin:16px 0; border-radius:4px;">
              <p style="margin:0; font-weight:600; color:#92400E;">${esc(title)}</p>
            </div>
            <p>${esc(body)}</p>
            <div style="text-align:center; margin-top:24px;">
              ${emailButton(url, button)}
            </div>
            <p style="text-align:center; margin-top: 30px;">
              <strong>— Phileein Hospitality Team</strong>
            </p>
          </div>`;
        const sent = sendMail({
          from: config.webmasterMail,
          to: r.email,
          subject: title,
          html: generateEmailTemplate(headerContent, containerContent),
        });
        mails.push(Promise.resolve(sent).catch((e) => logError("poSendBackNotifier email failed", e)));
      } catch (e) {
        logError("poSendBackNotifier email build failed", e);
      }
    }
    await Promise.all(mails);
    logger.info({ send_back_id: ctx.id, po_id: ctx.po_id, event, recipients: recipients.length }, "[poSendBackNotifier] notified");
  } catch (e) {
    logError(`poSendBackNotifier ${event} failed`, e);
  }
}

// Notifications still running, so tests can wait for them deterministically.
const inFlight = new Set();

function track(p) {
  inFlight.add(p);
  const done = () => inFlight.delete(p);
  p.then(done, done);
  return p;
}

/** The person asked hears they are being waited on. Call after COMMIT. Never throws. */
export const notifySendBackRequested = (args) => track(notifyNow("requested", args));

/** Whoever asked, and the step's pending approvers, hear it was answered. Call after COMMIT. Never throws. */
export const notifySendBackAnswered = (args) => track(notifyNow("answered", args));

/** The person asked hears they are no longer needed. Call after COMMIT. Never throws. */
export const notifySendBackWithdrawn = (args) => track(notifyNow("withdrawn", args));

/**
 * The person asked hears the hold was closed because the approval it froze
 * ended or restarted (`because` completes "was closed because ..."). Called
 * INSIDE the closing transaction with its context: sends only after the
 * outermost transaction commits, nothing if it rolls back. Never throws.
 */
export const notifySendBackClosed = (args, dbContext) =>
  track(afterCommitOf(dbContext, () => notifyNow("closed", args)));

/** The person asked is reminded the PO still waits on them. Never throws. */
export const notifySendBackReminder = (args) => track(notifyNow("reminder", { ...args, actorId: null }));

/**
 * Resolves once every send-back notification started so far has settled. For
 * tests only: production code never calls it.
 */
export async function drainPoSendBackNotifications() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}
