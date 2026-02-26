import config from "../../config/app.config.js";
import { sendMail } from "../common.js";
import { generateEmailTemplate } from "../notificationEmailLayout.js";

// Entity type → frontend link path mapping
const ENTITY_LINK_MAP = {
  'RFQ': (id) => `/dashboard/vendor/inquiries-details?type=buyer-view&id=${id}`,
  'TENDER': (id) => `/dashboard/vendor/inquiries-details?type=buyer-view&id=${id}`,
  'TECHNICAL': (id) => `/dashboard/buyer/technical-evaluation?rfq_id=${id}`,
  'NEGOTIATION': (id, ctx) => `/dashboard/buyer/quote-compare?rfq=${ctx?.rfq_id || id}`,
  'NEGOTIATION_QUOTE': (id, ctx) => `/dashboard/buyer/quote-compare?rfq=${ctx?.rfq_id || id}`,
  'ARC': (id, ctx) => `/dashboard/buyer/arc-committee?rfq_id=${ctx?.rfq_id || id}`,
  'PO': (id, ctx) => `/dashboard/buyer/purchase-order?rfq=${ctx?.rfq_id || id}`,
};

// Entity type → display label
const ENTITY_LABELS = {
  'RFQ': 'RFQ',
  'TENDER': 'Tender',
  'TECHNICAL': 'Technical Evaluation',
  'NEGOTIATION': 'Negotiation',
  'NEGOTIATION_QUOTE': 'Negotiation Quote',
  'ARC': 'ARC',
  'PO': 'Purchase Order',
};

/**
 * Send RFQ/Tender creation notification to project team members
 * @param {Object} params
 * @param {Object} params.rfqDetails - { id, rfq_no, is_tender, title }
 * @param {boolean} params.autoApproved - Whether the RFQ was auto-approved
 * @param {Array} params.users - Array of { name, email } (project team members)
 * @param {string} params.creatorName - Name of the user who created the RFQ
 */
export const sendRfqCreationNotification = async ({
  rfqDetails,
  autoApproved,
  users,
  creatorName
}) => {
  try {
    if (!users || users.length === 0) {
      console.log('No users to notify for RFQ creation');
      return false;
    }

    const { id: rfq_id, rfq_no, is_tender, title } = rfqDetails || {};
    const entityLabel = is_tender === 1 ? 'Tender' : 'RFQ';
    const viewUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?type=buyer-view&id=${rfq_id}`;

    const subject = autoApproved
      ? `${entityLabel} #${rfq_no} — Created & Ready to Publish`
      : `${entityLabel} #${rfq_no} — Submitted for Approval`;

    const statusMessage = autoApproved
      ? `has been created by <strong>${creatorName || 'a team member'}</strong> and is <strong>ready to publish</strong>.`
      : `has been submitted for approval by <strong>${creatorName || 'a team member'}</strong>.`;

    const statusBadge = autoApproved
      ? `<div style="background-color:#F0FDF4; border-left:4px solid #10B981; padding:12px 16px; margin:16px 0; border-radius:4px;">
           <span style="color:#166534; font-weight:600;">Ready to Publish</span>
         </div>`
      : `<div style="background-color:#FEF3C7; border-left:4px solid #F59E0B; padding:12px 16px; margin:16px 0; border-radius:4px;">
           <span style="color:#92400E; font-weight:600;">Pending Approval</span>
         </div>`;

    for (const user of users) {
      const headerContent = `<h2>Hello ${user.name || 'User'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            <strong>${entityLabel} #${rfq_no}</strong> ${statusMessage}
          </p>

          ${statusBadge}

          <ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>${entityLabel} Number:</strong> ${rfq_no}</li>
            ${title ? `<li style="padding:4px 0;"><strong>Title:</strong> ${title}</li>` : ''}
            <li style="padding:4px 0;"><strong>Created By:</strong> ${creatorName || 'N/A'}</li>
          </ul>

          <div style="text-align:center; margin-top:24px;">
            <a href="${viewUrl}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              View ${entityLabel}
            </a>
          </div>

          <p style="text-align:center; margin-top:30px;">
            <strong>— Workwise Team</strong>
          </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      sendMail({
        from: config.webmasterMail,
        to: user.email,
        subject,
        html: htmlContent
      });
    }

    console.log(`Sent ${entityLabel} creation notifications to ${users.length} users for ${entityLabel} #${rfq_no}`);
    return true;
  } catch (err) {
    console.error("Error sending RFQ creation notification emails:", err);
    return false;
  }
};

/**
 * Send notification to approvers that their approval is needed
 * @param {Object} params
 * @param {string} params.entityType - 'RFQ', 'TENDER', 'PO', 'TECHNICAL', 'NEGOTIATION', 'NEGOTIATION_QUOTE', 'ARC'
 * @param {number} params.entityId - The entity ID
 * @param {string} params.entityIdentifier - Display identifier (e.g., rfq_no, po_number)
 * @param {number} params.stepOrder - Current step number
 * @param {number} params.totalSteps - Total number of approval steps
 * @param {string} params.initiatorName - Name of the user who initiated the approval
 * @param {Array} params.approvers - Array of { user_id, user_name, user_email }
 * @param {Object} params.extraContext - Optional additional context (e.g., { rfq_id })
 */
export const sendApprovalStepNotification = async ({
  entityType,
  entityId,
  entityIdentifier,
  stepOrder,
  totalSteps,
  initiatorName,
  approvers,
  extraContext = {}
}) => {
  try {
    if (!approvers || approvers.length === 0) {
      console.log('No approvers to notify for approval step');
      return false;
    }

    const label = ENTITY_LABELS[entityType] || entityType;
    const linkFn = ENTITY_LINK_MAP[entityType];
    const linkPath = linkFn ? linkFn(entityId, extraContext) : `/dashboard`;
    const actionUrl = `${process.env.FRONT_END_WEBSITE}${linkPath}`;

    const subject = `Action Required: Approve ${label} #${entityIdentifier} (Step ${stepOrder}/${totalSteps})`;

    for (const approver of approvers) {
      const headerContent = `<h2>Hello ${approver.user_name || 'Approver'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            Your approval is required for <strong>${label} #${entityIdentifier}</strong>.
          </p>

          <div style="background-color:#EFF6FF; border-left:4px solid #3B82F6; padding:12px 16px; margin:16px 0; border-radius:4px;">
            <span style="color:#1E40AF; font-weight:600;">Step ${stepOrder} of ${totalSteps}</span>
          </div>

          <ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>Type:</strong> ${label}</li>
            <li style="padding:4px 0;"><strong>Identifier:</strong> #${entityIdentifier}</li>
            <li style="padding:4px 0;"><strong>Initiated By:</strong> ${initiatorName || 'N/A'}</li>
          </ul>

          <div style="text-align:center; margin-top:24px;">
            <a href="${actionUrl}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              Review & Approve
            </a>
          </div>

          <p style="text-align:center; margin-top:30px;">
            <strong>— Workwise Team</strong>
          </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      sendMail({
        from: config.webmasterMail,
        to: approver.user_email,
        subject,
        html: htmlContent
      });
    }

    console.log(`Sent approval step notifications to ${approvers.length} approvers for ${label} #${entityIdentifier} (Step ${stepOrder}/${totalSteps})`);
    return true;
  } catch (err) {
    console.error("Error sending approval step notification emails:", err);
    return false;
  }
};

/**
 * Send notification to team members when a Tender is approved and scheduled for publishing
 * @param {Object} params
 * @param {Object} params.rfqDetails - { id, rfq_no, is_tender, title, tender_publish_date }
 * @param {Array} params.users - Array of { name, email }
 */
export const sendRfqReadyToPublishNotification = async ({ rfqDetails, users }) => {
  try {
    if (!users || users.length === 0) return false;

    const { id: rfq_id, rfq_no, is_tender, title, tender_publish_date } = rfqDetails || {};
    const entityLabel = is_tender === 1 ? 'Tender' : 'RFQ';
    const viewUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?type=buyer-view&id=${rfq_id}`;

    const publishDateFormatted = tender_publish_date
      ? new Date(tender_publish_date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
      : 'Scheduled';

    const subject = `${entityLabel} #${rfq_no} — Approved & Scheduled for Publishing`;

    for (const user of users) {
      const headerContent = `<h2>Hello ${user.name || 'User'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            <strong>${entityLabel} #${rfq_no}</strong> has been approved and is scheduled to be published.
          </p>

          <div style="background-color:#F0FDF4; border-left:4px solid #10B981; padding:12px 16px; margin:16px 0; border-radius:4px;">
            <span style="color:#166534; font-weight:600;">Approved — Publishing on ${publishDateFormatted}</span>
          </div>

          <ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>${entityLabel} Number:</strong> ${rfq_no}</li>
            ${title ? `<li style="padding:4px 0;"><strong>Title:</strong> ${title}</li>` : ''}
            <li style="padding:4px 0;"><strong>Scheduled Publish Date:</strong> ${publishDateFormatted}</li>
          </ul>

          <div style="text-align:center; margin-top:24px;">
            <a href="${viewUrl}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              View ${entityLabel}
            </a>
          </div>

          <p style="text-align:center; margin-top:30px;">
            <strong>— Workwise Team</strong>
          </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      sendMail({
        from: config.webmasterMail,
        to: user.email,
        subject,
        html: htmlContent
      });
    }

    console.log(`Sent ready-to-publish notifications to ${users.length} users for ${entityLabel} #${rfq_no}`);
    return true;
  } catch (err) {
    console.error("Error sending ready-to-publish notification emails:", err);
    return false;
  }
};

/**
 * Send notification to team members when an RFQ/Tender is published
 * @param {Object} params
 * @param {Object} params.rfqDetails - { id, rfq_no, is_tender, title }
 * @param {Array} params.users - Array of { name, email }
 */
export const sendRfqPublishedNotification = async ({ rfqDetails, users }) => {
  try {
    if (!users || users.length === 0) {
      console.log('[Published Email] No users provided, skipping');
      return false;
    }

    const { id: rfq_id, rfq_no, is_tender, title } = rfqDetails || {};
    const entityLabel = is_tender === 1 ? 'Tender' : 'RFQ';
    const viewUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?type=buyer-view&id=${rfq_id}`;

    const subject = `${entityLabel} #${rfq_no} — Now Published`;
    console.log(`[Published Email] Sending to ${users.length} users for ${entityLabel} #${rfq_no}. Recipients:`, users.map(u => u.email));

    for (const user of users) {
      const headerContent = `<h2>Hello ${user.name || 'User'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            <strong>${entityLabel} #${rfq_no}</strong> is now live. Vendors have been invited to submit their quotes.
          </p>

          <div style="background-color:#ECFDF5; border-left:4px solid #059669; padding:12px 16px; margin:16px 0; border-radius:4px;">
            <span style="color:#065F46; font-weight:600;">Published</span>
          </div>

          <ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>${entityLabel} Number:</strong> ${rfq_no}</li>
            ${title ? `<li style="padding:4px 0;"><strong>Title:</strong> ${title}</li>` : ''}
          </ul>

          <div style="text-align:center; margin-top:24px;">
            <a href="${viewUrl}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              View ${entityLabel}
            </a>
          </div>

          <p style="text-align:center; margin-top:30px;">
            <strong>— Workwise Team</strong>
          </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      const result = await sendMail({
        from: config.webmasterMail,
        to: user.email,
        subject,
        html: htmlContent
      });
      console.log(`[Published Email] sendMail result for ${user.email}: ${result}`);
    }

    console.log(`[Published Email] Completed sending to ${users.length} users for ${entityLabel} #${rfq_no}`);
    return true;
  } catch (err) {
    console.error("[Published Email] Error sending published notification emails:", err);
    return false;
  }
};

/**
 * Send notification to vendors when an RFQ/Tender is published
 * @param {Object} params
 * @param {number} params.rfq_id - RFQ ID
 * @param {string} params.rfq_no - RFQ number
 * @param {number} params.is_tender - 0 or 1
 * @param {string} params.buyerName - Buyer company/organization name
 * @param {Array} params.vendors - Array of { user_id, name, email, token, products: [string] }
 */
export const sendVendorRfqNotification = async ({ rfq_id, rfq_no, is_tender, buyerName, vendors }) => {
  try {
    if (!vendors || vendors.length === 0) return false;

    const entityLabel = is_tender === 1 ? 'Tender' : 'RFQ';

    for (const vendor of vendors) {
      const sendQuoteUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/send-quote?id=${rfq_id}&token=${vendor.token}`;
      const viewUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${vendor.token}`;

      const productListHTML = (vendor.products || []).slice(0, 5).map(p =>
        `<li style="padding:2px 0;">${p}</li>`
      ).join('');
      const moreProducts = (vendor.products || []).length > 5
        ? `<li style="padding:2px 0; color:#6B7280;">...and ${vendor.products.length - 5} more</li>`
        : '';

      const headerContent = `<h2>Hello ${vendor.name || 'Vendor'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            You've received a new <strong>${entityLabel}</strong> from <strong>${buyerName}</strong>.
          </p>

          <ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>${entityLabel} Number:</strong> #${rfq_no}</li>
            <li style="padding:4px 0;"><strong>From:</strong> ${buyerName}</li>
          </ul>

          ${productListHTML ? `
          <h4 style="margin-top:16px; margin-bottom:8px; color:#1F2937;">Products</h4>
          <ul style="padding-left:16px;">
            ${productListHTML}
            ${moreProducts}
          </ul>
          ` : ''}

          <div style="text-align:center; margin-top:24px;">
            <a href="${sendQuoteUrl}"
               style="background-color:#059669; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600; margin-right:12px;">
              Submit Your Quote
            </a>
            <a href="${viewUrl}"
               style="background-color:#6B7280; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              View Details
            </a>
          </div>

          <p style="margin-top:20px;">
            Submit your quote promptly to access this opportunity with ${buyerName}.
          </p>

          <p style="text-align:center; margin-top:30px;">
            <strong>— Workwise Team</strong>
          </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      sendMail({
        from: `${buyerName} ${config.masterEmail}`,
        to: vendor.email,
        subject: `New ${entityLabel} Opportunity #${rfq_no} from ${buyerName}`,
        html: htmlContent
      });
    }

    console.log(`Sent vendor notifications to ${vendors.length} vendors for ${entityLabel} #${rfq_no}`);
    return true;
  } catch (err) {
    console.error("Error sending vendor RFQ notification emails:", err);
    return false;
  }
};
