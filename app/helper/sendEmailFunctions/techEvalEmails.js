import config from "../../config/app.config.js";
import { sendMail, logError } from "../common.js";
import { generateEmailTemplate } from "../notificationEmailLayout.js";
import { logger } from '../../util/logger.js';

/**
 * Send notification emails when technical evaluation completes
 * @param {Object} rfqDetails - RFQ details (id, rfq_no, title, hospitality_company_id, hotel_id)
 * @param {Object} techEvalDetails - { id, total_passed_verified, required_passed_vendors }
 * @param {Array} users - Array of users to notify (id, name, email)
 */
export const sendTechEvalCompletionNotification = async (rfqDetails, techEvalDetails, users) => {
  try {
    if (!users || users.length === 0) {
      logger.debug('No users to notify for tech evaluation completion');
      return false;
    }

    const { id: rfq_id, rfq_no, title: rfq_title } = rfqDetails || {};
    const { total_passed_verified, required_passed_vendors } = techEvalDetails || {};

    for (const user of users) {
      const headerContent = `<h2>Hello ${user.name || 'User'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            Great news! The <strong>Technical Evaluation</strong> for RFQ <strong>#${rfq_no}</strong>
            has been completed successfully.
          </p>

          <h4>Evaluation Summary</h4>
          <ul>
            <li><strong>RFQ Number:</strong> ${rfq_no}</li>
            ${rfq_title ? `<li><strong>RFQ Title:</strong> ${rfq_title}</li>` : ''}
            <li><strong>Total Passed Vendors:</strong> ${total_passed_verified}</li>
            <li><strong>Required Vendors:</strong> ${required_passed_vendors}</li>
          </ul>

          <p style="margin-top:16px;">
            The technical evaluation has reached the required number of qualified vendors.
            You can now proceed with:
          </p>
          <ul>
            <li><strong>Quote Comparison</strong> - Review and compare vendor quotes</li>
            <li><strong>Negotiation</strong> - Initiate negotiations with qualified vendors</li>
          </ul>

          <div style="text-align:center; margin-top:24px;">
            <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-details?id=${rfq_id}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600; margin-right:12px;">
              View RFQ Details
            </a>
            <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${rfq_id}"
               style="background-color:#10B981; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              Compare Quotes
            </a>
          </div>

          <p style="text-align:center; margin-top: 30px;">
            Thank you for your continued attention to this procurement.<br/>
            <strong>— Phileein Hospitality Team</strong>
          </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      sendMail({
        from: config.webmasterMail,
        to: user.email,
        subject: `Technical Evaluation Complete — RFQ #${rfq_no}`,
        html: htmlContent
      });
    }

    logger.info(`Sent tech eval completion notifications to ${users.length} users for RFQ ${rfq_no}`);
    return true;
  } catch (err) {
    logError("Error sending tech evaluation completion emails:", err);
    return false;
  }
};

/**
 * Send notification to vendors when they are technically accepted
 * @param {Object} params
 * @param {Object} params.rfqDetails - { id, rfq_no, is_tender, product_name, company_name }
 * @param {Array} params.vendors - Array of { vendor_id, vendor_name, vendor_email, token }
 */
export const sendVendorTechAcceptanceNotification = async ({ rfqDetails, vendors }) => {
  try {
    if (!vendors || vendors.length === 0) return false;

    const { id: rfq_id, rfq_no, is_tender, product_name, company_name } = rfqDetails || {};
    const entityLabel = is_tender === 1 ? 'Tender' : 'RFQ';

    for (const vendor of vendors) {
      const viewUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${vendor.token}`;

      const headerContent = `<h2>Hello ${vendor.vendor_name || 'Vendor'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            Your submission for <strong>${product_name || 'the product'}</strong> in
            ${entityLabel} <strong>#${rfq_no}</strong> has been <strong style="color:#059669;">technically accepted</strong>.
          </p>

          <div style="background-color:#F0FDF4; border-left:4px solid #10B981; padding:12px 16px; margin:16px 0; border-radius:4px;">
            <span style="color:#166534; font-weight:600;">Technical Evaluation — Passed</span>
          </div>

          <ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>${entityLabel} Number:</strong> #${rfq_no}</li>
            ${product_name ? `<li style="padding:4px 0;"><strong>Product:</strong> ${product_name}</li>` : ''}
            ${company_name ? `<li style="padding:4px 0;"><strong>Buyer:</strong> ${company_name}</li>` : ''}
          </ul>

          <div style="text-align:center; margin-top:24px;">
            <a href="${viewUrl}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              View Details
            </a>
          </div>

          <p style="text-align:center; margin-top:30px;">
            <strong>— Phileein Hospitality Team</strong>
          </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      sendMail({
        from: config.webmasterMail,
        to: vendor.vendor_email,
        subject: `Technical Evaluation Passed — ${entityLabel} #${rfq_no}`,
        html: htmlContent
      });
    }

    logger.info(`Sent tech acceptance notifications to ${vendors.length} vendors for ${entityLabel} #${rfq_no}`);
    return true;
  } catch (err) {
    logError("Error sending vendor tech acceptance emails:", err);
    return false;
  }
};
