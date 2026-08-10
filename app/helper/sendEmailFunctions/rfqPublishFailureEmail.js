import config from "../../config/app.config.js";
import { sendMail, logError } from "../common.js";
import { generateEmailTemplate } from "../notificationEmailLayout.js";
import { logger } from '../../util/logger.js';
import userModel from '../../models/userModel.js';
import { dispatch as dispatchNotification } from "../../services/notificationService.js";
import { buyerRfqDetail, buyerRfqList, toAbsoluteUrl } from "../../services/notificationLinks.js";

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Notify the RFQ creator that the system failed to auto-publish their RFQ
 * and they need to use the Force Publish button to publish it manually.
 *
 * Called by the stuck-RFQ watchdog after MAX_WATCHDOG_ATTEMPTS failed retries,
 * and by the one-time backfill script for RFQs already stuck at deploy time.
 *
 * Idempotency is the caller's responsibility (they set
 * tbl_rfq.publish_failure_notified_at after a successful send).
 *
 * @param {Object} params
 * @param {Object} params.rfq - { id, rfq_no, is_tender, created_by, tender_publish_date }
 * @param {string} [params.failureReason] - Last failure reason, if any
 */
export const sendRfqPublishFailureToCreator = async ({ rfq, failureReason }) => {
  try {
    if (!rfq?.created_by) {
      logger.warn({ rfqId: rfq?.id }, '[Publish Failure Email] No creator on RFQ, skipping');
      return false;
    }

    const creatorRows = await userModel.user_profile_detail(rfq.created_by);
    const creator = Array.isArray(creatorRows) ? creatorRows[0] : creatorRows;
    if (!creator?.email || !String(creator.email).includes('@')) {
      logger.warn({ rfqId: rfq.id, createdBy: rfq.created_by }, '[Publish Failure Email] Creator has no usable email, skipping');
      return false;
    }

    const entityLabel = rfq.is_tender === 1 ? 'Tender' : 'RFQ';
    const scheduledFormatted = rfq.tender_publish_date
      ? new Date(rfq.tender_publish_date).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : 'an earlier scheduled time';

    // `rfq-management` is a leaf listing page, so the old `/rfq-management/<id>`
    // form matched no route at all — Force Publish lives on the workspace.
    const linkPath = buyerRfqDetail(rfq.id) || buyerRfqList();
    const detailsUrl = toAbsoluteUrl(linkPath);
    const subject = `Action required: ${entityLabel} #${rfq.rfq_no} failed to auto-publish`;

    const reasonBlock = failureReason
      ? `<p style="margin:8px 0 0 0; color:#7F1D1D; font-size:14px;">
           <strong>Last error:</strong> ${escapeHtml(failureReason)}
         </p>`
      : '';

    const headerContent = `<h2>Hello ${escapeHtml(creator.name || 'there')},</h2>`;

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          Your <strong>${entityLabel} #${escapeHtml(rfq.rfq_no)}</strong> was scheduled to be published on
          <strong>${escapeHtml(scheduledFormatted)} (IST)</strong>, but our system was unable to
          publish it after several automatic retries.
        </p>

        <div style="background-color:#FEF2F2; border-left:4px solid #DC2626; padding:12px 16px; margin:16px 0; border-radius:4px;">
          <span style="color:#7F1D1D; font-weight:600;">Auto-publish failed &mdash; manual action needed</span>
          ${reasonBlock}
        </div>

        <p>
          The ${entityLabel} is still in <strong>Ready to Publish</strong> state. Open it in Workwise
          and click the <strong>Force Publish</strong> button to publish it now &mdash; vendors will be
          notified exactly as they would have been by the scheduled publish.
        </p>

        <div style="text-align:center; margin-top:24px;">
          <a href="${detailsUrl}"
             style="background-color:#DC2626; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            Open ${entityLabel} &amp; Force Publish
          </a>
        </div>

        <p style="font-size:13px; color:#6B7280; margin-top:24px;">
          You're receiving this because you created this ${entityLabel}. Only the creator can force publish it.
        </p>

        <p style="text-align:center; margin-top:30px;">
          <strong>&mdash; Phileein Hospitality Team</strong>
        </p>
      </div>`;

    const htmlContent = generateEmailTemplate(headerContent, containerContent);

    const result = await sendMail({
      from: config.webmasterMail,
      to: creator.email,
      subject,
      html: htmlContent,
    });

    logger.info(
      { rfqId: rfq.id, rfq_no: rfq.rfq_no, creator: creator.email, sent: !!result },
      '[Publish Failure Email] Sent to creator'
    );

    try {
      await dispatchNotification({
        userIds: [rfq.created_by],
        category: 'rfq',
        type: 'rfq_publish_failed',
        title: `Action required: ${entityLabel} #${rfq.rfq_no} failed to auto-publish`,
        body: `Auto-publish failed after retries. Use Force Publish to publish manually.`,
        data: { rfq_id: rfq.id, is_tender: rfq.is_tender, reason: failureReason || null },
        actionUrl: linkPath
      });
    } catch (notifyErr) {
      logError('[Publish Failure] dispatch failed', notifyErr);
    }

    return !!result;
  } catch (err) {
    logError('[Publish Failure Email] Error sending', err);
    return false;
  }
};
