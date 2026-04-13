import config from "../../config/app.config.js";
import { sendMail, logError } from "../common.js";
import { generateEmailTemplate } from "../notificationEmailLayout.js";
import { logger } from '../../util/logger.js';

/**
 * Format a DB timestamp as IST display string.
 * DB stores timestamps without timezone — treat bare strings as UTC before converting.
 */
const formatDateIST = (dateValue) => {
  if (!dateValue) return 'N/A';
  let str = String(dateValue);
  // Append 'Z' to bare timestamps so Date parses as UTC
  if (!str.includes('+') && !str.includes('Z')) {
    str = str.replace(' ', 'T') + 'Z';
  }
  return new Date(str).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
};

/**
 * Send notification when a negotiation round expires while still pending approval.
 * @param {Object} params
 * @param {Object} params.round - The negotiation round record
 * @param {string} params.rfqNo - RFQ number
 * @param {string} params.productName - Product name
 * @param {Object} params.initiator - { name, email } of the round creator
 * @param {Array} params.commercialEvaluators - Array of { name, email }
 */
export const sendNegotiationExpiredNotification = async ({
  round,
  rfqNo,
  productName,
  initiator,
  commercialEvaluators = []
}) => {
  try {
    if (!initiator || !initiator.email) {
      logger.debug('No initiator to notify for negotiation round expiry');
      return false;
    }

    const quoteCompareUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${round.rfq_id}`;
    const subject = `Negotiation Round Expired — RFQ #${rfqNo}`;

    const headerContent = `<h2>Hello ${initiator.name || 'User'},</h2>`;

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          A negotiation round that was pending approval has now <strong>expired</strong>.
        </p>

        <div style="background-color:#FEF2F2; border-left:4px solid #EF4444; padding:12px 16px; margin:16px 0; border-radius:4px;">
          <span style="color:#991B1B; font-weight:600;">Round ${round.round_number || ''} — Expired</span>
        </div>

        <ul style="list-style:none; padding-left:0; margin-top:16px;">
          <li style="padding:4px 0;"><strong>RFQ Number:</strong> #${rfqNo}</li>
          <li style="padding:4px 0;"><strong>Product:</strong> ${productName}</li>
          <li style="padding:4px 0;"><strong>Target Price:</strong> ₹${parseFloat(round.target_price || 0).toLocaleString('en-IN')}</li>
          <li style="padding:4px 0;"><strong>End Date:</strong> ${formatDateIST(round.end_date)}</li>
        </ul>

        <p style="margin-top:16px;">
          A new negotiation round will be needed if you wish to set a target price for this product.
        </p>

        <div style="text-align:center; margin-top:24px;">
          <a href="${quoteCompareUrl}"
             style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            View Quote Compare
          </a>
        </div>

        <p style="text-align:center; margin-top:30px;">
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

    const htmlContent = generateEmailTemplate(headerContent, containerContent);

    const ccEmails = commercialEvaluators
      .map(e => e.email)
      .filter(email => email && email !== initiator.email);

    await sendMail({
      from: config.webmasterMail,
      to: initiator.email,
      cc: ccEmails.length > 0 ? ccEmails : undefined,
      subject,
      html: htmlContent
    });

    logger.info(`Sent negotiation round expired notification for RFQ #${rfqNo}, Round ${round.round_number}`);
    return true;
  } catch (err) {
    logError("Error sending negotiation round expired notification:", err);
    return false;
  }
};

/**
 * Send notification when an active negotiation round ends (end_date reached).
 * @param {Object} params
 * @param {Object} params.round - The negotiation round record
 * @param {string} params.rfqNo - RFQ number
 * @param {string} params.productName - Product name
 * @param {number} params.quoteCount - Number of quotes received during the round
 * @param {Array} params.commercialEvaluators - Array of { name, email }
 */
export const sendNegotiationRoundEndedNotification = async ({
  round,
  rfqNo,
  productName,
  quoteCount = 0,
  commercialEvaluators = []
}) => {
  try {
    if (!commercialEvaluators || commercialEvaluators.length === 0) {
      logger.debug('No commercial evaluators to notify for negotiation round end');
      return false;
    }

    const quoteCompareUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${round.rfq_id}`;
    const subject = `Negotiation Round Ended — RFQ #${rfqNo}`;

    const quotesMessage = quoteCount > 0
      ? `<strong>${quoteCount} quote(s)</strong> were received during this round. Please review the quotes.`
      : `<strong>No quotes</strong> were received during this round. You may run another round or finalize a vendor.`;

    const statusColor = quoteCount > 0 ? '#059669' : '#D97706';
    const statusBg = quoteCount > 0 ? '#ECFDF5' : '#FFFBEB';
    const statusBorder = quoteCount > 0 ? '#10B981' : '#F59E0B';
    const statusText = quoteCount > 0 ? `${quoteCount} Quote(s) Received` : 'No Quotes Received';

    for (const evaluator of commercialEvaluators) {
      const headerContent = `<h2>Hello ${evaluator.name || 'User'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            A negotiation round has <strong>ended</strong> for the following product.
          </p>

          <div style="background-color:${statusBg}; border-left:4px solid ${statusBorder}; padding:12px 16px; margin:16px 0; border-radius:4px;">
            <span style="color:${statusColor}; font-weight:600;">Round ${round.round_number || ''} — ${statusText}</span>
          </div>

          <ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>RFQ Number:</strong> #${rfqNo}</li>
            <li style="padding:4px 0;"><strong>Product:</strong> ${productName}</li>
            <li style="padding:4px 0;"><strong>Target Price:</strong> ₹${parseFloat(round.target_price || 0).toLocaleString('en-IN')}</li>
            <li style="padding:4px 0;"><strong>End Date:</strong> ${formatDateIST(round.end_date)}</li>
          </ul>

          <p style="margin-top:16px;">
            ${quotesMessage}
          </p>

          <div style="text-align:center; margin-top:24px;">
            <a href="${quoteCompareUrl}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              Review Quotes
            </a>
          </div>

          <p style="text-align:center; margin-top:30px;">
            <strong>— Phileein Hospitality Team</strong>
          </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      sendMail({
        from: config.webmasterMail,
        to: evaluator.email,
        subject,
        html: htmlContent
      });
    }

    logger.info(`Sent negotiation round ended notification to ${commercialEvaluators.length} evaluators for RFQ #${rfqNo}, Round ${round.round_number}`);
    return true;
  } catch (err) {
    logError("Error sending negotiation round ended notification:", err);
    return false;
  }
};

/**
 * Send notification to the initiator when a negotiation round is created.
 * Shows either "submitted and waiting for approval" or "auto-approved and live".
 * @param {Object} params
 * @param {Object} params.round - The negotiation round record (with status)
 * @param {string} params.rfqNo - RFQ number
 * @param {string} params.productName - Product name
 * @param {Object} params.initiator - { name, email }
 * @param {boolean} params.autoApproved - Whether the round was auto-approved
 */
export const sendNegotiationRoundCreatedNotification = async ({
  round,
  rfqNo,
  productName,
  initiator,
  autoApproved = false
}) => {
  try {
    if (!initiator || !initiator.email) {
      logger.debug('No initiator to notify for negotiation round creation');
      return false;
    }

    const quoteCompareUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${round.rfq_id}`;

    const subject = autoApproved
      ? `Negotiation Round Live — RFQ #${rfqNo}`
      : `Negotiation Round Submitted — RFQ #${rfqNo}`;

    const statusBg = autoApproved ? '#ECFDF5' : '#EFF6FF';
    const statusBorder = autoApproved ? '#10B981' : '#3B82F6';
    const statusColor = autoApproved ? '#065F46' : '#1E40AF';
    const statusText = autoApproved ? 'Auto-Approved & Live' : 'Submitted — Awaiting Approval';

    const bodyMessage = autoApproved
      ? 'Your negotiation round has been <strong>auto-approved</strong> and is now <strong>live</strong>. Vendors can submit their quotes.'
      : 'Your negotiation round has been <strong>submitted</strong> and is <strong>awaiting approval</strong> from the approval committee.';

    const headerContent = `<h2>Hello ${initiator.name || 'User'},</h2>`;

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>${bodyMessage}</p>

        <div style="background-color:${statusBg}; border-left:4px solid ${statusBorder}; padding:12px 16px; margin:16px 0; border-radius:4px;">
          <span style="color:${statusColor}; font-weight:600;">Round ${round.round_number || ''} — ${statusText}</span>
        </div>

        <ul style="list-style:none; padding-left:0; margin-top:16px;">
          <li style="padding:4px 0;"><strong>RFQ Number:</strong> #${rfqNo}</li>
          <li style="padding:4px 0;"><strong>Product:</strong> ${productName}</li>
          <li style="padding:4px 0;"><strong>Target Price:</strong> ₹${parseFloat(round.target_price || 0).toLocaleString('en-IN')}</li>
          <li style="padding:4px 0;"><strong>End Date:</strong> ${formatDateIST(round.end_date)}</li>
        </ul>

        <div style="text-align:center; margin-top:24px;">
          <a href="${quoteCompareUrl}"
             style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            View Quote Compare
          </a>
        </div>

        <p style="text-align:center; margin-top:30px;">
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

    const htmlContent = generateEmailTemplate(headerContent, containerContent);

    await sendMail({
      from: config.webmasterMail,
      to: initiator.email,
      subject,
      html: htmlContent
    });

    logger.info(`Sent negotiation round created notification (autoApproved=${autoApproved}) for RFQ #${rfqNo}, Round ${round.round_number}`);
    return true;
  } catch (err) {
    logError("Error sending negotiation round created notification:", err);
    return false;
  }
};

/**
 * Send notification when a negotiation round is fully approved and made live.
 * @param {Object} params
 * @param {Object} params.round - The negotiation round record
 * @param {string} params.rfqNo - RFQ number
 * @param {string} params.productName - Product name
 * @param {Object} params.initiator - { name, email } of the round creator
 * @param {Array} params.commercialEvaluators - Array of { name, email }
 */
export const sendNegotiationRoundApprovedNotification = async ({
  round,
  rfqNo,
  productName,
  initiator,
  commercialEvaluators = []
}) => {
  try {
    if (!initiator || !initiator.email) {
      logger.debug('No initiator to notify for negotiation round approval');
      return false;
    }

    const quoteCompareUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${round.rfq_id}`;
    const subject = `Negotiation Round Approved & Live — RFQ #${rfqNo}`;

    const headerContent = `<h2>Hello ${initiator.name || 'User'},</h2>`;

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          A negotiation round has been <strong>fully approved</strong> and is now <strong>live</strong>. Vendors can submit their quotes.
        </p>

        <div style="background-color:#ECFDF5; border-left:4px solid #10B981; padding:12px 16px; margin:16px 0; border-radius:4px;">
          <span style="color:#065F46; font-weight:600;">Round ${round.round_number || ''} — Approved & Live</span>
        </div>

        <ul style="list-style:none; padding-left:0; margin-top:16px;">
          <li style="padding:4px 0;"><strong>RFQ Number:</strong> #${rfqNo}</li>
          <li style="padding:4px 0;"><strong>Product:</strong> ${productName}</li>
          <li style="padding:4px 0;"><strong>Target Price:</strong> ₹${parseFloat(round.target_price || 0).toLocaleString('en-IN')}</li>
          <li style="padding:4px 0;"><strong>End Date:</strong> ${formatDateIST(round.end_date)}</li>
        </ul>

        <div style="text-align:center; margin-top:24px;">
          <a href="${quoteCompareUrl}"
             style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            View Quote Compare
          </a>
        </div>

        <p style="text-align:center; margin-top:30px;">
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

    const htmlContent = generateEmailTemplate(headerContent, containerContent);

    const ccEmails = commercialEvaluators
      .map(e => e.email)
      .filter(email => email && email !== initiator.email);

    await sendMail({
      from: config.webmasterMail,
      to: initiator.email,
      cc: ccEmails.length > 0 ? ccEmails : undefined,
      subject,
      html: htmlContent
    });

    logger.info(`Sent negotiation round approved notification for RFQ #${rfqNo}, Round ${round.round_number}`);
    return true;
  } catch (err) {
    logError("Error sending negotiation round approved notification:", err);
    return false;
  }
};
