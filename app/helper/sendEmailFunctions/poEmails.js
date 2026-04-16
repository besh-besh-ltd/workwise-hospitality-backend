import config from "../../config/app.config.js";
import { sendMail, logError } from "../common.js";
import { generateEmailTemplate } from "../notificationEmailLayout.js";
import { logger } from '../../util/logger.js';

/**
 * Send notification to all company members when PO is fully approved
 * @param {Object} params
 * @param {Object} params.rfqDetails - { id, rfq_no, title, created_at }
 * @param {Object} params.poDetails - { id, po_number, total_value, quantity, po_pdf_url, created_at }
 * @param {Object} params.vendorDetails - { id, organization_name, name, email }
 * @param {Array} params.productNames - Array of product name strings
 * @param {Array} params.approvalHistory - Array of { step_order, approver_name, action, created_at }
 * @param {Array} params.users - Array of { id, name, email } to notify
 * @param {Object} params.companyDetails - { company_name }
 */
export const sendPOApprovalCompletionNotification = async ({
  rfqDetails,
  poDetails,
  vendorDetails,
  productNames,
  approvalHistory,
  users,
  companyDetails
}) => {
  try {
    if (!users || users.length === 0) {
      logger.debug('No users to notify for PO approval completion');
      return false;
    }

    const { rfq_no, title: rfq_title } = rfqDetails || {};
    const { po_number, total_value, quantity, po_pdf_url } = poDetails || {};
    const vendorName = vendorDetails?.company_name || vendorDetails?.organization_name || vendorDetails?.name || 'Vendor';

    // Format approval history as HTML table rows
    const approvalHistoryHTML = approvalHistory && approvalHistory.length > 0
      ? approvalHistory.map(action => `
          <tr>
            <td style="padding:8px; border:1px solid #e5e7eb;">Step ${action.step_order}</td>
            <td style="padding:8px; border:1px solid #e5e7eb;">${action.approver_name}</td>
            <td style="padding:8px; border:1px solid #e5e7eb;">
              <span style="color:${action.action === 'APPROVE' ? '#10B981' : '#EF4444'}; font-weight:600;">
                ${action.action === 'APPROVE' ? 'Approved' : 'Rejected'}
              </span>
            </td>
            <td style="padding:8px; border:1px solid #e5e7eb;">
              ${new Date(action.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
            </td>
          </tr>
        `).join('')
      : '<tr><td colspan="4" style="padding:8px; text-align:center;">No approval history available</td></tr>';

    for (const user of users) {
      const headerContent = `<h2>Hello ${user.name || 'User'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            A <strong>Purchase Order</strong> has been fully approved internally and sent to the vendor for acceptance.
          </p>

          <div style="background-color:#FEF3C7; border-left:4px solid #F59E0B; padding:16px; margin:16px 0; border-radius:4px;">
            <p style="margin:0; font-size:18px; font-weight:600; color:#92400E;">
              Awaiting Vendor Acceptance: ${vendorName}
            </p>
            <p style="margin:8px 0 0; font-size:14px; color:#92400E;">
              The vendor has been notified and must accept or reject this PO before it can proceed.
            </p>
          </div>

          <h4 style="margin-top:24px; color:#1F2937;">RFQ Details</h4>
          <ul style="list-style:none; padding-left:0;">
            <li style="padding:4px 0;"><strong>RFQ Number:</strong> ${rfq_no}</li>
            ${rfq_title ? `<li style="padding:4px 0;"><strong>RFQ Title:</strong> ${rfq_title}</li>` : ''}
          </ul>

          <h4 style="margin-top:24px; color:#1F2937;">Purchase Order Details</h4>
          <ul style="list-style:none; padding-left:0;">
            <li style="padding:4px 0;"><strong>PO Number:</strong> ${po_number}</li>
            <li style="padding:4px 0;"><strong>Product(s):</strong> ${productNames?.join(', ') || 'N/A'}</li>
            <li style="padding:4px 0;"><strong>Quantity:</strong> ${quantity || 'N/A'}</li>
            <li style="padding:4px 0;"><strong>Total Value:</strong> Rs. ${total_value ? Number(total_value).toLocaleString('en-IN') : '0'}</li>
          </ul>

          <h4 style="margin-top:24px; color:#1F2937;">Vendor Details</h4>
          <ul style="list-style:none; padding-left:0;">
            <li style="padding:4px 0;"><strong>Vendor Name:</strong> ${vendorName}</li>
            <li style="padding:4px 0;"><strong>Vendor Email:</strong> ${vendorDetails?.email || 'N/A'}</li>
          </ul>

          <h4 style="margin-top:24px; color:#1F2937;">Approval Workflow</h4>
          <table style="width:100%; border-collapse:collapse; margin-top:8px;">
            <thead>
              <tr style="background-color:#F3F4F6;">
                <th style="padding:8px; border:1px solid #e5e7eb; text-align:left;">Step</th>
                <th style="padding:8px; border:1px solid #e5e7eb; text-align:left;">Approver</th>
                <th style="padding:8px; border:1px solid #e5e7eb; text-align:left;">Action</th>
                <th style="padding:8px; border:1px solid #e5e7eb; text-align:left;">Date & Time</th>
              </tr>
            </thead>
            <tbody>
              ${approvalHistoryHTML}
            </tbody>
          </table>

          <div style="text-align:center; margin-top:24px;">
            <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-details?id=${rfqDetails?.id}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600; margin-right:12px;">
              View RFQ Details
            </a>
            ${po_pdf_url ? `
            <a href="${po_pdf_url}"
               style="background-color:#10B981; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              Download PO Document
            </a>
            ` : ''}
          </div>

          <p style="text-align:center; margin-top: 30px;">
            Thank you for your continued attention to this procurement.<br/>
            <strong>— ${companyDetails?.company_name || 'Phileein Hospitality'} Team</strong>
          </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      sendMail({
        from: config.webmasterMail,
        to: user.email,
        subject: `PO Approved & Sent to Vendor — Awaiting Acceptance for RFQ #${rfq_no}`,
        html: htmlContent
      });
    }

    logger.info(`Sent PO approval completion notifications to ${users.length} users for PO ${po_number}`);
    return true;
  } catch (err) {
    logError("Error sending PO approval completion emails:", err);
    return false;
  }
};
