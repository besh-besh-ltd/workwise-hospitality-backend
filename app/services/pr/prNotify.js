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
// (notifyAssigned, notifyLineClosed, notifyLineCancelled, notifyCatalogRequested),
// Task 9 notifyConverted; Task 11 completes the matrix (notifyCatalogResolved,
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
import { resolveReviewers } from './prRouting.js';
import { readersOf } from './prAccess.js';

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
 * The requester cancelled a line: the assigned buyer (if any), in-app — only
 * while they may still read the PR (readersOf): a buyer who lost pr.convert
 * since the assignment is not sent its content.
 * @param {{pr, line: {line_no, free_text_name?}, reason: string, actorId}} p
 */
export async function notifyLineCancelled({ pr, line, reason, actorId }) {
  await safely('notifyLineCancelled', pr, async () => {
    const to = audience(await readersOf(pr.id, [pr.assigned_buyer_id]), actorId);
    await inApp(pr, to, actorId, {
      type: 'pr_line_cancelled',
      title: `Line cancelled: ${pr.pr_number}`,
      body: `The requester cancelled ${lineLabel(line)} of ${label(pr)} — "${reason}"`,
    });
  });
}

/**
 * Lines of the PR went onto an RFQ draft (POST /pr/convert): the requester,
 * in-app — one notification per PR, whichever of its lines were converted.
 * @param {{pr, rfqNo: number, lineCount: number, actorId}} p
 */
export async function notifyConverted({ pr, rfqNo, lineCount, actorId }) {
  await safely('notifyConverted', pr, async () => {
    const lines = lineCount === 1 ? '1 line' : `${lineCount} lines`;
    await inApp(pr, audience([pr.raised_by], actorId), actorId, {
      type: 'pr_converted',
      title: `${pr.pr_number} is being sourced: RFQ #${rfqNo}`,
      body: `The purchase team is sourcing ${lines} of your purchase requisition ${label(pr)} on RFQ #${rfqNo}.`,
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

/**
 * The platform resolved a catalog request (fulfilled or rejected): the PR's
 * requester, whoever filed the request, and the assigned buyer — or, while the
 * PR is unassigned, every pr.convert holder of its hotel. In-app, once each,
 * never the actor, and only those who may still read the PR (readersOf): the
 * filer or the assigned buyer may have lost pr.convert since.
 * @param {{pr, line: {line_no, free_text_name?}, request: {requested_name, requested_by},
 *          outcome: 'fulfilled'|'rejected', variantName?: string, note?: string, actorId}} p
 */
export async function notifyCatalogResolved({ pr, line, request, outcome, variantName, note, actorId }) {
  await safely('notifyCatalogResolved', pr, async () => {
    const handlers = pr.assigned_buyer_id
      ? [pr.assigned_buyer_id]
      : (await db.any(HOTEL_BUYERS_SQL('$1', '$2'), [pr.hospitality_company_id, pr.hotel_id])).map((r) => r.id);
    const to = audience(await readersOf(pr.id, [pr.raised_by, request.requested_by, ...handlers]), actorId);
    const fulfilled = outcome === 'fulfilled';
    const what = `"${request.requested_name}" for ${lineLabel(line)} of ${label(pr)}`;
    await inApp(pr, to, actorId, {
      type: fulfilled ? 'pr_catalog_fulfilled' : 'pr_catalog_rejected',
      title: fulfilled ? `Catalog item added: ${pr.pr_number}` : `Catalog request declined: ${pr.pr_number}`,
      body: fulfilled
        ? `The platform team fulfilled the catalog request ${what}${variantName ? ` with ${variantName}` : ''}.`
        : `The platform team declined the catalog request ${what}${note ? ` — "${note}"` : ''}.`,
    });
  });
}

// ---------------------------------------------------------------------------
// Conversation (Task 11)
// ---------------------------------------------------------------------------

/**
 * Everyone with a stake in the PR right now (spec §11, "new comment"): the
 * requester, the assigned buyer, the eligible reviewers of the reviews that are
 * still pending (resolved now, not at submit) plus every reviewer who acted on
 * any review, the pending approvers of the CURRENT step, and everyone who has
 * already commented — narrowed to those who may READ the PR right now (the
 * read rule, prAccess.readersOf), so someone who acted earlier and has since
 * lost access (a reviewer whose pr.evaluate was revoked, an unmapped buyer)
 * is never sent the comment's text. Not actor-filtered; `audience()` does that.
 */
async function commentParticipants(pr) {
  const rows = await db.any(
    `SELECT p.raised_by AS uid FROM tbl_purchase_requisition p WHERE p.id = $1
     UNION ALL SELECT p.assigned_buyer_id FROM tbl_purchase_requisition p WHERE p.id = $1
     UNION ALL SELECT rv.acted_by FROM tbl_pr_review rv WHERE rv.pr_id = $1
     UNION ALL SELECT cm.author_id FROM tbl_pr_comment cm WHERE cm.pr_id = $1
     UNION ALL
     SELECT asa.approver_user_id
       FROM tbl_purchase_requisition p
       JOIN tbl_approval_instances ai ON ai.id = p.approval_instance_id AND ai.entity_type = 'PR' AND ai.entity_id = p.id
       JOIN tbl_approval_instance_steps st ON st.approval_instance_id = ai.id AND st.step_order = ai.current_step
       JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = st.id
      WHERE p.id = $1 AND p.status = 'pending_approval' AND ai.status = 'PENDING'
        AND asa.status = 'PENDING' AND asa.removed_at IS NULL`,
    [pr.id]);
  const ids = rows.map((r) => r.uid);
  const pending = await db.any(
    `SELECT DISTINCT rv.department_id
       FROM tbl_purchase_requisition p
       JOIN tbl_pr_review rv ON rv.pr_id = p.id AND rv.revision = p.revision AND rv.status = 'pending'
      WHERE p.id = $1 AND p.status = 'in_review'`,
    [pr.id]);
  for (const d of pending) {
    const reviewers = await resolveReviewers({
      companyId: Number(pr.hospitality_company_id), hotelId: Number(pr.hotel_id), departmentId: Number(d.department_id),
    });
    ids.push(...reviewers.map((r) => r.id));
  }
  return readersOf(pr.id, ids);
}

/**
 * A comment was posted (after commit): every participant except the author, in-app.
 * @param {{pr, authorId: number, body: string}} p
 */
export async function notifyComment({ pr, authorId, body }) {
  await safely('notifyComment', pr, async () => {
    const to = audience(await commentParticipants(pr), authorId);
    if (!to.length) return;
    const author = await db.oneOrNone(`SELECT name FROM tbl_users WHERE id = $1`, [authorId]);
    const text = String(body ?? '');
    const snippet = text.length > 140 ? `${text.slice(0, 139)}…` : text;
    await inApp(pr, to, authorId, {
      type: 'pr_comment',
      title: `New comment: ${pr.pr_number}`,
      body: `${author?.name || 'Someone'} commented on ${label(pr)} — "${snippet}"`,
    });
  });
}

export default {
  notifyReviewTasks, notifyReturned, notifyApproved, notifyRejected,
  notifyAssigned, notifyLineClosed, notifyLineCancelled, notifyCatalogRequested, notifyCatalogResolved, notifyConverted, notifyComment,
};
