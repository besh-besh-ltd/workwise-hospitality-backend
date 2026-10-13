// Purchase Requisitions — who hears about what (spec §11).
//
// One function per event. Every one of them:
//   - is called AFTER the transaction that made the change has committed, so
//     nobody is told about a change that rolled back;
//   - never throws (a failed notification must not make a committed change
//     look failed) — it catches and logs;
//   - de-duplicates recipients and never includes the actor;
//   - writes the in-app row through notificationService.dispatch
//     (category 'pr', data {pr_id}, a link to the PR detail);
//   - also emails the action-required events (review task, returned, approved,
//     assigned).
//
// Task 6 implements the approval-path events, Task 8 the buyer pool's
// (notifyAssigned, notifyLineClosed, notifyLineCancelled, notifyCatalogRequested);
// Task 11 completes the matrix (notifyConverted, notifyCatalogResolved,
// notifyComment) under these names.
//
// `pr` is a PR row (at least id, pr_number, title, raised_by,
// hospitality_company_id, hotel_id).

import db from '../../config/dbConn.js';
import config from '../../config/app.config.js';
import { logger } from '../../util/logger.js';
import { sendMail } from '../../helper/common.js';
import { generateEmailTemplate, emailButton } from '../../helper/notificationEmailLayout.js';
import { dispatch } from '../notificationService.js';
import { buyerPrDetail, toAbsoluteUrl } from '../notificationLinks.js';
import { HOTEL_BUYERS_SQL } from './prConstants.js';

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Positive integer ids, de-duplicated, without the actor. */
function audience(ids, actorId) {
  const actor = Number(actorId);
  return [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    .filter((n) => n !== actor);
}

const label = (pr) => `${pr.pr_number}${pr.title ? ` — ${pr.title}` : ''}`;

/** In-app rows for `userIds` (already filtered). */
async function inApp(pr, userIds, actorId, { type, title, body }) {
  if (!userIds.length) return;
  await dispatch({
    userIds,
    senderUserId: actorId || null,
    category: 'pr',
    type,
    title,
    body,
    data: { pr_id: Number(pr.id), pr_number: pr.pr_number },
    actionUrl: buyerPrDetail(pr.id),
  });
}

/** One email per active recipient with an address; fire-and-forget. */
async function email(pr, userIds, { subject, intro, details = [], cta }) {
  if (!userIds.length) return;
  const users = await db.any(
    `SELECT id, name, email FROM tbl_users
      WHERE id = ANY($1::int[]) AND status = 1 AND COALESCE(is_deleted, 0) = 0
        AND email IS NOT NULL AND email <> ''`,
    [userIds]);
  const url = toAbsoluteUrl(buyerPrDetail(pr.id));
  const rows = details
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<li style="padding:4px 0;"><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</li>`)
    .join('');
  for (const u of users) {
    const html = generateEmailTemplate(
      `<h2>Hello ${escapeHtml(u.name || 'there')},</h2>`,
      `<div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
         <p>${intro}</p>
         ${rows ? `<ul style="list-style:none; padding-left:0; margin-top:16px;">${rows}</ul>` : ''}
         <div style="text-align:center; margin-top:24px;">${emailButton(url, escapeHtml(cta))}</div>
       </div>`);
    sendMail({ from: config.webmasterMail, to: u.email, subject, html })
      .catch((err) => logger.error({ err, prId: pr.id }, '[prNotify] email failed'));
  }
}

/** Run one notification; anything it throws is logged, never propagated. */
async function safely(name, pr, fn) {
  try {
    await fn();
  } catch (err) {
    logger.error({ err, prId: pr?.id }, `[prNotify] ${name} failed`);
  }
}

/**
 * Submitted with technical review: each group's eligible reviewers get a task.
 * @param {{pr, reviews: Array<{review_id, department_title, reviewer_ids:number[]}>, actorId}} p
 */
export async function notifyReviewTasks({ pr, reviews, actorId }) {
  await safely('notifyReviewTasks', pr, async () => {
    for (const r of reviews || []) {
      const to = audience(r.reviewer_ids, actorId);
      const title = `Technical review needed: ${pr.pr_number}`;
      await inApp(pr, to, actorId, {
        type: 'pr_review_task',
        title,
        body: `${label(pr)} needs a ${r.department_title} technical review.`,
      });
      await email(pr, to, {
        subject: `${title} (${r.department_title})`,
        intro: `Purchase requisition <strong>${escapeHtml(label(pr))}</strong> is waiting for your `
          + `<strong>${escapeHtml(r.department_title)}</strong> technical review.`,
        details: [['Requisition', pr.pr_number], ['Title', pr.title], ['Reviewing department', r.department_title]],
        cta: 'Review requisition',
      });
    }
  });
}

/**
 * Sent back to the requester (by a reviewer or an approver), with the note.
 * @param {{pr, note: string, actorId, by: 'reviewer'|'approver'}} p
 */
export async function notifyReturned({ pr, note, actorId, by = 'approver' }) {
  await safely('notifyReturned', pr, async () => {
    const to = audience([pr.raised_by], actorId);
    const who = by === 'reviewer' ? 'a technical reviewer' : 'an approver';
    const title = `Sent back: ${pr.pr_number}`;
    await inApp(pr, to, actorId, { type: 'pr_returned', title, body: `Sent back by ${who} — "${note}"` });
    await email(pr, to, {
      subject: `${title} — changes requested`,
      intro: `Your purchase requisition <strong>${escapeHtml(label(pr))}</strong> was sent back by ${who}. `
        + 'Update it and submit it again.',
      details: [['Note', note]],
      cta: 'Open requisition',
    });
  });
}

/**
 * Fully approved: the requester, and every buyer of the hotel (the PR's lines
 * are now in their purchase queue).
 * @param {{pr, actorId}} p
 */
export async function notifyApproved({ pr, actorId }) {
  await safely('notifyApproved', pr, async () => {
    const requester = audience([pr.raised_by], actorId);
    const buyers = audience(
      (await db.any(HOTEL_BUYERS_SQL('$1', '$2'), [Number(pr.hospitality_company_id), Number(pr.hotel_id)]))
        .map((b) => b.id),
      actorId,
    ).filter((id) => !requester.includes(id));

    const title = `Approved: ${pr.pr_number}`;
    await inApp(pr, requester, actorId, {
      type: 'pr_approved', title, body: `Your purchase requisition ${label(pr)} is approved and with the purchase team.`,
    });
    await email(pr, requester, {
      subject: title,
      intro: `Your purchase requisition <strong>${escapeHtml(label(pr))}</strong> is approved and is now with the purchase team.`,
      cta: 'Open requisition',
    });
    await inApp(pr, buyers, actorId, {
      type: 'pr_approved', title: `In purchase queue: ${pr.pr_number}`, body: `${label(pr)} is approved and ready to source.`,
    });
    await email(pr, buyers, {
      subject: `In purchase queue: ${pr.pr_number}`,
      intro: `Purchase requisition <strong>${escapeHtml(label(pr))}</strong> is approved and its lines are in your purchase queue.`,
      cta: 'Open requisition',
    });
  });
}

/**
 * Rejected (terminal): the requester, in-app.
 * @param {{pr, actorId, comment?: string}} p
 */
export async function notifyRejected({ pr, actorId, comment }) {
  await safely('notifyRejected', pr, async () => {
    const to = audience([pr.raised_by], actorId);
    await inApp(pr, to, actorId, {
      type: 'pr_rejected',
      title: `Rejected: ${pr.pr_number}`,
      body: comment ? `Your purchase requisition was rejected — "${comment}"` : 'Your purchase requisition was rejected.',
    });
  });
}

// ---------------------------------------------------------------------------
// Buyer pool (Task 8)
// ---------------------------------------------------------------------------

const lineLabel = (line) => `line ${line.line_no}${line.free_text_name ? ` (${line.free_text_name})` : ''}`;

/**
 * Assigned to a buyer: the assignee gets the task (in-app + email) unless they
 * took it themselves; the requester learns who handles it ("Handled by …").
 * @param {{pr, assigneeId: number, assigneeName: string, actorId}} p
 */
export async function notifyAssigned({ pr, assigneeId, assigneeName, actorId }) {
  await safely('notifyAssigned', pr, async () => {
    const assignee = audience([assigneeId], actorId);
    const requester = audience([pr.raised_by], actorId).filter((id) => !assignee.includes(id) && id !== Number(assigneeId));
    const title = `Assigned to you: ${pr.pr_number}`;
    await inApp(pr, assignee, actorId, {
      type: 'pr_assigned', title, body: `${label(pr)} is assigned to you in the purchase queue.`,
    });
    await email(pr, assignee, {
      subject: title,
      intro: `Purchase requisition <strong>${escapeHtml(label(pr))}</strong> is assigned to you in the purchase queue.`,
      details: [['Requisition', pr.pr_number], ['Title', pr.title]],
      cta: 'Open requisition',
    });
    await inApp(pr, requester, actorId, {
      type: 'pr_assigned',
      title: `Handled by ${assigneeName}: ${pr.pr_number}`,
      body: `${assigneeName} from the purchase team is handling your purchase requisition ${label(pr)}.`,
    });
  });
}

/**
 * A buyer closed a line: the requester, in-app, with the reason.
 * @param {{pr, line: {line_no, free_text_name?}, reason: string, actorId}} p
 */
export async function notifyLineClosed({ pr, line, reason, actorId }) {
  await safely('notifyLineClosed', pr, async () => {
    await inApp(pr, audience([pr.raised_by], actorId), actorId, {
      type: 'pr_line_closed',
      title: `Line closed: ${pr.pr_number}`,
      body: `The purchase team closed ${lineLabel(line)} of ${label(pr)} — "${reason}"`,
    });
  });
}

/**
 * The requester cancelled a line: the assigned buyer (if any), in-app.
 * @param {{pr, line: {line_no, free_text_name?}, reason: string, actorId}} p
 */
export async function notifyLineCancelled({ pr, line, reason, actorId }) {
  await safely('notifyLineCancelled', pr, async () => {
    await inApp(pr, audience([pr.assigned_buyer_id], actorId), actorId, {
      type: 'pr_line_cancelled',
      title: `Line cancelled: ${pr.pr_number}`,
      body: `The requester cancelled ${lineLabel(line)} of ${label(pr)} — "${reason}"`,
    });
  });
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * A buyer asked the platform team for a catalog item. notificationService has
 * no platform-admin channel: the admin-panel queue of open requests is the
 * primary channel, and when PR_CATALOG_REQUEST_EMAIL (comma-separated
 * addresses, read at call time) is set, each address also gets an email.
 * Unset → an info log, nothing else; the request never fails because of it.
 * @param {{pr, line: {line_no, free_text_name}, request: {id, requested_name, description}, actorId}} p
 */
export async function notifyCatalogRequested({ pr, line, request, actorId }) {
  await safely('notifyCatalogRequested', pr, async () => {
    const to = [...new Set(String(process.env.PR_CATALOG_REQUEST_EMAIL || '')
      .split(',').map((a) => a.trim()).filter((a) => EMAIL_RE.test(a)))];
    if (!to.length) {
      logger.info({ prId: pr.id, requestId: request.id },
        '[prNotify] PR_CATALOG_REQUEST_EMAIL not set — the catalog request waits in the admin-panel queue');
      return;
    }
    const ctx = await db.oneOrNone(
      `SELECT hc.name AS company_name, h.name AS hotel_name, cat.title AS category_title, u.name AS requested_by_name
         FROM tbl_purchase_requisition p
         LEFT JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = p.hotel_id
         LEFT JOIN tbl_category cat ON cat.id = $2
         LEFT JOIN tbl_users u ON u.id = $3
        WHERE p.id = $1`,
      [pr.id, request.category_id ?? null, actorId ?? null]);
    const adminUrl = (process.env.ADMIN_BASE_URL || 'https://admin.hospitality.letsworkwise.com').replace(/\/+$/, '');
    const rows = [
      ['Requested item', request.requested_name], ['Description', request.description],
      ['Category', ctx?.category_title], ['Company', ctx?.company_name], ['Hotel', ctx?.hotel_name],
      ['Requisition', `${pr.pr_number}, line ${line.line_no}`], ['Requested by', ctx?.requested_by_name],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `<li style="padding:4px 0;"><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</li>`)
      .join('');
    const html = generateEmailTemplate(
      '<h2>New catalog request</h2>',
      `<div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
         <p>A buyer could not find this item in the catalog and asked for it to be added.
            Fulfil or reject it from the Catalog requests queue in the admin panel.</p>
         <ul style="list-style:none; padding-left:0; margin-top:16px;">${rows}</ul>
         <div style="text-align:center; margin-top:24px;">${emailButton(adminUrl, 'Open admin panel')}</div>
       </div>`);
    const subject = `Catalog request: ${request.requested_name} (${pr.pr_number})`;
    for (const address of to) {
      sendMail({ from: config.webmasterMail, to: address, subject, html })
        .catch((err) => logger.error({ err, prId: pr.id, requestId: request.id }, '[prNotify] catalog request email failed'));
    }
  });
}

export default {
  notifyReviewTasks, notifyReturned, notifyApproved, notifyRejected,
  notifyAssigned, notifyLineClosed, notifyLineCancelled, notifyCatalogRequested,
};
