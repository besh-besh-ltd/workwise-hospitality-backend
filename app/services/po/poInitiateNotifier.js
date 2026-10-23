// "Your draft PO is ready" — tells everyone who can initiate a draft PO that it
// is waiting, and nudges them once more if it is still a draft 48 hours later.
//
// Why: a PO drafted by an award approval sat unseen because nothing told the
// people allowed to initiate it (prod, 2026-10-22: 12 live drafts, no
// draft-created notification existed).
//
// WHO: listPoInitiatorRecipients, the same read-and-write-grant intersection
// the initiators panel and the initiate gate use, UNCAPPED, active users only,
// never vendors. Nobody is excluded for having triggered the draft: the
// approver whose award created it is still an initiator.
//
// WHEN: notifyDraftCreated is called AFTER the drafting transaction commits and
// only for POs that call CREATED (draftPurchaseOrder's `created` flag), so a
// later award merging into an existing draft stays quiet.
// remindStaleDrafts runs from the daily cron.
//
// Neither function throws: a notification problem must never turn a finished
// award into an error.

import db from "../../config/dbConn.js";
import config from "../../config/app.config.js";
import { sendMail, logError } from "../../helper/common.js";
import { logger } from "../../util/logger.js";
import { generateEmailTemplate, emailButton } from "../../helper/notificationEmailLayout.js";
import { dispatch as dispatchNotification } from "../notificationService.js";
import { buyerPoInitiate, toAbsoluteUrl } from "../notificationLinks.js";
import { resolvePoScopeTuple, listPoInitiatorRecipients } from "../../models/purchaseOrderModel.js";

// A draft is reminded once it is at least this old ...
const REMINDER_AFTER_HOURS = 48;
// ... and never once it is older than this. The cap is load-bearing: it keeps
// the deploy from emailing about drafts that have sat in prod for weeks.
const REMINDER_MAX_AGE_DAYS = 14;

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The PO + RFQ facts the copy needs. Null when the PO is gone. */
async function loadDraft(poId, dbCtx = db) {
  return dbCtx.oneOrNone(
    `SELECT po.id, po.po_number, po.status::text AS status, po.rfq_id, r.rfq_no, r.title AS rfq_title
       FROM tbl_rfq_purchase_order po
       LEFT JOIN tbl_rfq r ON r.id = po.rfq_id
      WHERE po.id = $1`,
    [poId]
  );
}

/** Send the in-app row to every recipient and one email each. Never throws. */
async function sendToInitiators(po, recipients, { reminder }) {
  const poLabel = po.po_number ? `PO ${po.po_number}` : `PO #${po.id}`;
  const rfqPart = po.rfq_no ? ` for RFQ #${po.rfq_no}` : "";
  const linkPath = buyerPoInitiate(po.id);
  const url = toAbsoluteUrl(linkPath);

  const title = reminder
    ? `Reminder: ${poLabel} is still waiting to be initiated`
    : `${poLabel} is ready for you to initiate`;
  const body = reminder
    ? `${poLabel}${rfqPart} has been waiting for 2 days. Open it and press Initiate to send it for approval.`
    : `${poLabel}${rfqPart} is ready for you to initiate. Open it and press Initiate to send it for approval.`;

  await dispatchNotification({
    userIds: recipients.map((r) => r.user_id),
    category: "po",
    type: reminder ? "po_draft_initiate_reminder" : "po_draft_ready",
    title,
    body,
    data: { po_id: po.id, rfq_id: po.rfq_id },
    actionUrl: linkPath,
  });

  const mails = [];
  for (const r of recipients) {
    if (!r.email) continue;
    try {
      const headerContent = `<h2>Hello ${esc(r.name || "")},</h2>`;
      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <div style="background-color:#DBEAFE; border-left:4px solid #3B82F6; padding:16px; margin:16px 0; border-radius:4px;">
            <p style="margin:0; font-weight:600; color:#1E3A8A;">${esc(title)}</p>
          </div>
          <p>${esc(body)}</p>
          <div style="text-align:center; margin-top:24px;">
            ${emailButton(url, "Open the PO")}
          </div>
          <p style="text-align:center; margin-top: 30px;">
            Your prompt action is appreciated.<br/>
            <strong>— Phileein Hospitality Team</strong>
          </p>
        </div>`;
      const sent = sendMail({
        from: config.webmasterMail,
        to: r.email,
        subject: title,
        html: generateEmailTemplate(headerContent, containerContent),
      });
      mails.push(Promise.resolve(sent).catch((e) => logError("poInitiateNotifier email failed", e)));
    } catch (e) {
      logError("poInitiateNotifier email build failed", e);
    }
  }
  await Promise.all(mails);
}

/** Active initiators of a PO, uncapped. Empty when the PO is not found. */
async function recipientsFor(poId) {
  const tuple = await resolvePoScopeTuple(poId);
  return listPoInitiatorRecipients(tuple);
}

// Notifications still running, so tests can wait for them deterministically.
const inFlight = new Set();

/**
 * Tell everyone who can initiate that a freshly created draft is ready.
 * Call after the drafting transaction commits, only for a PO the call created.
 * @param {number} poId
 * @returns {Promise<void>}
 */
export function notifyDraftCreated(poId) {
  const p = notifyDraftCreatedNow(poId);
  inFlight.add(p);
  const done = () => inFlight.delete(p);
  p.then(done, done);
  return p;
}

/**
 * Resolves once every notification started so far has settled. For tests only:
 * production code never calls it.
 */
export async function drainInitiateNotifications() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

async function notifyDraftCreatedNow(poId) {
  try {
    const po = await loadDraft(poId);
    // The tx may have rolled back, or the PO may already have moved on.
    if (!po || po.status !== "draft") return;
    const recipients = await recipientsFor(po.id);
    if (!recipients.length) {
      logger.info({ po_id: po.id }, "[poInitiateNotifier] draft ready: no initiators to notify");
      return;
    }
    await sendToInitiators(po, recipients, { reminder: false });
    logger.info({ po_id: po.id, recipients: recipients.length }, "[poInitiateNotifier] draft ready notified");
  } catch (e) {
    logError("notifyDraftCreated failed", e);
  }
}

/**
 * One reminder for drafts 48h to 14 days old that nobody has initiated.
 * Timestamps are compared in SQL against the `now` parameter (timestamptz).
 * @param {Date} [now]
 * @returns {Promise<{reminded:number}>}
 */
export async function remindStaleDrafts(now = new Date()) {
  let reminded = 0;
  try {
    const due = await db.any(
      `SELECT po.id
         FROM tbl_rfq_purchase_order po
         JOIN tbl_rfq r ON r.id = po.rfq_id
        WHERE po.status = 'draft'
          AND po.initiate_reminded_at IS NULL
          AND r.status <> 2
          AND po.created_at <= $1::timestamptz - make_interval(hours => $2)
          AND po.created_at >  $1::timestamptz - make_interval(days => $3)
        ORDER BY po.id`,
      [now, REMINDER_AFTER_HOURS, REMINDER_MAX_AGE_DAYS]
    );
    for (const { id } of due) {
      try {
        const recipients = await recipientsFor(id);
        // Nobody to remind: leave it unmarked so a later grant still gets one.
        if (!recipients.length) continue;
        // Claim first so an overlapping run cannot send a second reminder.
        const claimed = await db.oneOrNone(
          `UPDATE tbl_rfq_purchase_order
              SET initiate_reminded_at = $2::timestamptz
            WHERE id = $1 AND status = 'draft' AND initiate_reminded_at IS NULL
        RETURNING id`,
          [id, now]
        );
        if (!claimed) continue;
        const po = await loadDraft(id);
        await sendToInitiators(po, recipients, { reminder: true });
        reminded += 1;
      } catch (e) {
        logError(`remindStaleDrafts failed for PO ${id}`, e);
      }
    }
  } catch (e) {
    logError("remindStaleDrafts failed", e);
  }
  return { reminded };
}
