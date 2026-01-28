import config from "../../config/app.config.js";
import { sendMail } from "../common.js";
import { generateEmailTemplate } from "../notificationEmailLayout.js";

/**
 * Send notification emails when technical evaluation completes
 * @param {Object} rfqDetails - RFQ details (id, rfq_no, title, hospitality_company_id, hotel_id)
 * @param {Object} techEvalDetails - { id, total_passed_verified, required_passed_vendors }
 * @param {Array} users - Array of users to notify (id, name, email)
 */
export const sendTechEvalCompletionNotification = async (rfqDetails, techEvalDetails, users) => {
  try {
    if (!users || users.length === 0) {
      console.log('No users to notify for tech evaluation completion');
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
            <strong>— Workwise Team</strong>
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

    console.log(`Sent tech eval completion notifications to ${users.length} users for RFQ ${rfq_no}`);
    return true;
  } catch (err) {
    console.error("Error sending tech evaluation completion emails:", err);
    return false;
  }
};
