import config from "../../config/app.config.js";
import { sendMail, logError } from "../common.js";
import { generateEmailTemplate } from "../notificationEmailLayout.js";
import { logger } from '../../util/logger.js';

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
      logger.debug('No users to notify for RFQ creation');
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
            <strong>— Phileein Hospitality Team</strong>
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

    logger.info(`Sent ${entityLabel} creation notifications to ${users.length} users for ${entityLabel} #${rfq_no}`);
    return true;
  } catch (err) {
    logError("Error sending RFQ creation notification emails:", err);
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
      logger.debug('No approvers to notify for approval step');
      return false;
    }

    const label = ENTITY_LABELS[entityType] || entityType;
    const linkFn = ENTITY_LINK_MAP[entityType];
    const linkPath = linkFn ? linkFn(entityId, extraContext) : `/dashboard`;
    const actionUrl = `${process.env.FRONT_END_WEBSITE}${linkPath}`;

    const isNegotiationType = entityType === 'NEGOTIATION' || entityType === 'NEGOTIATION_QUOTE';
    const rfqTitle = extraContext?.rfq_title || '';

    const subject = isNegotiationType
      ? `Action Required: Approve ${label} — RFQ #${entityIdentifier}${rfqTitle ? ` ${rfqTitle}` : ''} (Step ${stepOrder}/${totalSteps})`
      : `Action Required: Approve ${label} #${entityIdentifier}${rfqTitle ? ` ${rfqTitle}` : ''} (Step ${stepOrder}/${totalSteps})`;

    for (const approver of approvers) {
      const headerContent = `<h2>Hello ${approver.user_name || 'Approver'},</h2>`;

      const detailsList = isNegotiationType
        ? `<ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>Type:</strong> ${label}</li>
            <li style="padding:4px 0;"><strong>RFQ Number:</strong> #${entityIdentifier}</li>
            ${rfqTitle ? `<li style="padding:4px 0;"><strong>RFQ Title:</strong> ${rfqTitle}</li>` : ''}
            <li style="padding:4px 0;"><strong>Initiated By:</strong> ${initiatorName || 'N/A'}</li>
          </ul>`
        : `<ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>Type:</strong> ${label}</li>
            <li style="padding:4px 0;"><strong>Identifier:</strong> #${entityIdentifier}</li>
            ${rfqTitle ? `<li style="padding:4px 0;"><strong>RFQ Title:</strong> ${rfqTitle}</li>` : ''}
            <li style="padding:4px 0;"><strong>Initiated By:</strong> ${initiatorName || 'N/A'}</li>
          </ul>`;

      const approvalDescription = isNegotiationType
        ? `<strong>${label}</strong> for <strong>RFQ #${entityIdentifier}${rfqTitle ? ` — ${rfqTitle}` : ''}</strong>`
        : `<strong>${label} #${entityIdentifier}</strong>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            Your approval is required for ${approvalDescription}.
          </p>

          <div style="background-color:#EFF6FF; border-left:4px solid #3B82F6; padding:12px 16px; margin:16px 0; border-radius:4px;">
            <span style="color:#1E40AF; font-weight:600;">Step ${stepOrder} of ${totalSteps}</span>
          </div>

          ${detailsList}

          <div style="text-align:center; margin-top:24px;">
            <a href="${actionUrl}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              Review & Approve
            </a>
          </div>

          <p style="text-align:center; margin-top:30px;">
            <strong>— Phileein Hospitality Team</strong>
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

    logger.info(`Sent approval step notifications to ${approvers.length} approvers for ${label} #${entityIdentifier} (Step ${stepOrder}/${totalSteps})`);
    return true;
  } catch (err) {
    logError("Error sending approval step notification emails:", err);
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
            <strong>— Phileein Hospitality Team</strong>
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

    logger.info(`Sent ready-to-publish notifications to ${users.length} users for ${entityLabel} #${rfq_no}`);
    return true;
  } catch (err) {
    logError("Error sending ready-to-publish notification emails:", err);
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
      logger.debug('[Published Email] No users provided, skipping');
      return false;
    }

    const { id: rfq_id, rfq_no, is_tender, title, bid_end_date, hotel_name, hospitality_company_name } = rfqDetails || {};
    const entityLabel = is_tender === 1 ? 'Tender' : 'RFQ';
    const viewUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?type=buyer-view&id=${rfq_id}`;

    const bidEndFormatted = bid_end_date
      ? new Date(bid_end_date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
      : null;

    const subject = `${entityLabel} #${rfq_no} — Now Published`;
    logger.info(`[Published Email] Sending to ${users.length} users for ${entityLabel} #${rfq_no}. Recipients: ${users.map(u => u.email).join(', ')}`);

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
            ${title ? `<li style="padding:4px 0;"><strong>${entityLabel} Title:</strong> ${title}</li>` : ''}
            ${hospitality_company_name ? `<li style="padding:4px 0;"><strong>Company Name:</strong> ${hospitality_company_name}</li>` : ''}
            ${hotel_name ? `<li style="padding:4px 0;"><strong>Business Unit:</strong> ${hotel_name}</li>` : ''}
            ${bidEndFormatted ? `<li style="padding:4px 0;"><strong>Quote Submission End Date & Time:</strong> ${bidEndFormatted}</li>` : ''}
          </ul>

          <div style="text-align:center; margin-top:24px;">
            <a href="${viewUrl}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              View ${entityLabel}
            </a>
          </div>

          <p style="text-align:center; margin-top:30px;">
            <strong>— Phileein Hospitality Team</strong>
          </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      const result = await sendMail({
        from: config.webmasterMail,
        to: user.email,
        subject,
        html: htmlContent
      });
      logger.debug(`[Published Email] sendMail result for ${user.email}: ${result}`);
    }

    logger.info(`[Published Email] Completed sending to ${users.length} users for ${entityLabel} #${rfq_no}`);
    return true;
  } catch (err) {
    logError("[Published Email] Error sending published notification emails:", err);
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
export const sendVendorRfqNotification = async ({ rfq_id, rfq_no, is_tender, title, bid_end_date, hotel_name, hospitality_company_name, buyerName, vendors }) => {
  try {
    if (!vendors || vendors.length === 0) return false;

    const entityLabel = is_tender === 1 ? 'Tender' : 'RFQ';

    const bidEndFormatted = bid_end_date
      ? new Date(bid_end_date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
      : null;

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
            ${title ? `<li style="padding:4px 0;"><strong>${entityLabel} Title:</strong> ${title}</li>` : ''}
            ${hospitality_company_name ? `<li style="padding:4px 0;"><strong>Company Name:</strong> ${hospitality_company_name}</li>` : ''}
            ${hotel_name ? `<li style="padding:4px 0;"><strong>Business Unit:</strong> ${hotel_name}</li>` : ''}
            <li style="padding:4px 0;"><strong>From:</strong> ${buyerName}</li>
            ${bidEndFormatted ? `<li style="padding:4px 0;"><strong>Quote Submission End Date & Time:</strong> ${bidEndFormatted}</li>` : ''}
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
            <strong>— Phileein Hospitality Team</strong>
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

    logger.info(`Sent vendor notifications to ${vendors.length} vendors for ${entityLabel} #${rfq_no}`);
    return true;
  } catch (err) {
    logError("Error sending vendor RFQ notification emails:", err);
    return false;
  }
};

/**
 * WH-67: Notify the RFQ/Tender creator that a new vendor has registered and
 * been automatically added to their RFQ(s). Sends ONE email per creator listing
 * all affected RFQs. Intentionally omits vendor details (name, email, company).
 *
 * @param {Object} params
 * @param {string} params.creator_email
 * @param {string} params.creator_name
 * @param {Array}  params.rfqs - Array of { rfq_id, rfq_no, is_tender, title, product_names }
 */
export const sendVendorAutoAddedToRfqNotification = async ({
  creator_email, creator_name, rfqs
}) => {
  try {
    if (!creator_email || !rfqs || rfqs.length === 0) return false;

    const registrationTime = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
    });

    const rfqListHTML = rfqs.map(rfq => {
      const label = rfq.is_tender === 1 ? 'Tender' : 'RFQ';
      const viewUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?type=buyer-view&id=${rfq.rfq_id}`;
      const products = (rfq.product_names || []).join(', ') || '—';
      return `
        <tr>
          <td style="padding:10px 12px; border-bottom:1px solid #f1f5f9;">
            <a href="${viewUrl}" style="color:#2e5ba8; font-weight:600; text-decoration:none;">${label} #${rfq.rfq_no}</a>
            ${rfq.title ? `<div style="font-size:12px; color:#64748b; margin-top:2px;">${rfq.title}</div>` : ''}
          </td>
          <td style="padding:10px 12px; border-bottom:1px solid #f1f5f9; font-size:13px; color:#475569;">${products}</td>
        </tr>`;
    }).join('');

    const subject = rfqs.length === 1
      ? `New Vendor Registered — ${rfqs[0].is_tender === 1 ? 'Tender' : 'RFQ'} #${rfqs[0].rfq_no}`
      : `New Vendor Registered — Added to ${rfqs.length} RFQs`;

    const headerContent = `<h2>Hello ${creator_name || 'there'},</h2>`;

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          A new vendor has registered and been automatically added to
          ${rfqs.length === 1
            ? `your <strong>${rfqs[0].is_tender === 1 ? 'Tender' : 'RFQ'} #${rfqs[0].rfq_no}</strong>.`
            : `<strong>${rfqs.length}</strong> of your open RFQs.`}
        </p>

        <table style="width:100%; border-collapse:collapse; margin:16px 0; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden;">
          <thead>
            <tr style="background:#f8fafc;">
              <th style="padding:10px 12px; text-align:left; font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.05em;">RFQ</th>
              <th style="padding:10px 12px; text-align:left; font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.05em;">Products</th>
            </tr>
          </thead>
          <tbody>${rfqListHTML}</tbody>
        </table>

        <ul style="list-style:none; padding-left:0;">
          <li style="padding:4px 0;"><strong>Registration Date & Time:</strong> ${registrationTime}</li>
        </ul>

        <p style="margin-top:20px; color:#6B7280; font-size:14px;">
          No action is required on your part. The vendor can now submit quotes for these RFQs.
        </p>

        <p style="text-align:center; margin-top:30px;">
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

    const htmlContent = generateEmailTemplate(headerContent, containerContent);

    sendMail({
      from: `Phileein Hospitality ${config.masterEmail}`,
      to: creator_email,
      subject,
      html: htmlContent
    });

    console.log(`[WH-67] Sent creator notification for ${rfqs.length} RFQ(s) to ${creator_email}`);
    return true;
  } catch (err) {
    console.error('[WH-67] Error sending creator notification email:', err);
    return false;
  }
};

/**
 * WH-67: Send ONE consolidated email to a vendor listing all RFQs they were
 * auto-added to after registration, with token links for each.
 *
 * @param {Object} params
 * @param {string} params.vendor_name
 * @param {string} params.vendor_email
 * @param {Array}  params.rfqs - Array of { rfq_id, rfq_no, is_tender, title, bid_end_date, token, buyerName, products }
 */
export const sendVendorBulkRfqJoinNotification = async ({
  vendor_name, vendor_email, rfqs
}) => {
  try {
    if (!vendor_email || !rfqs || rfqs.length === 0) return false;

    const rfqListHTML = rfqs.map(rfq => {
      const label = rfq.is_tender === 1 ? 'Tender' : 'RFQ';
      const sendQuoteUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/send-quote?id=${rfq.rfq_id}&token=${rfq.token}`;
      const viewUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq.rfq_id}&token=${rfq.token}`;
      const bidEnd = rfq.bid_end_date
        ? new Date(rfq.bid_end_date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
        : null;
      const productsHTML = (rfq.products || []).slice(0, 3).map(p => `<span>${p}</span>`).join(', ');
      const moreCount = (rfq.products || []).length > 3 ? ` +${rfq.products.length - 3} more` : '';

      return `
        <div style="border:1px solid #e2e8f0; border-radius:10px; padding:16px; margin-bottom:12px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
              <div style="font-weight:700; color:#0f172a;">${label} #${rfq.rfq_no}</div>
              ${rfq.title ? `<div style="font-size:13px; color:#64748b; margin-top:2px;">${rfq.title}</div>` : ''}
              ${rfq.buyerName ? `<div style="font-size:12px; color:#94a3b8; margin-top:2px;">From: ${rfq.buyerName}</div>` : ''}
            </div>
          </div>
          ${productsHTML ? `<div style="font-size:12px; color:#475569; margin-top:8px;">Products: ${productsHTML}${moreCount}</div>` : ''}
          ${bidEnd ? `<div style="font-size:12px; color:#94a3b8; margin-top:4px;">Quote deadline: ${bidEnd}</div>` : ''}
          <div style="margin-top:12px;">
            <a href="${sendQuoteUrl}" style="background-color:#059669; color:white; padding:8px 16px; border-radius:6px; text-decoration:none; display:inline-block; font-weight:600; font-size:13px; margin-right:8px;">Submit Quote</a>
            <a href="${viewUrl}" style="background-color:#6B7280; color:white; padding:8px 16px; border-radius:6px; text-decoration:none; display:inline-block; font-weight:600; font-size:13px;">View Details</a>
          </div>
        </div>`;
    }).join('');

    const headerContent = `<h2>Hello ${vendor_name || 'Vendor'},</h2>`;

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          Great news! You've been added to <strong>${rfqs.length}</strong> open RFQ${rfqs.length > 1 ? 's' : ''}
          based on your registered categories. Start submitting your quotes now.
        </p>

        ${rfqListHTML}

        <p style="margin-top:20px;">
          Submit your quotes promptly to make the most of these opportunities.
        </p>

        <p style="text-align:center; margin-top:30px;">
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

    const htmlContent = generateEmailTemplate(headerContent, containerContent);

    const subject = rfqs.length === 1
      ? `New RFQ Opportunity #${rfqs[0].rfq_no} — You've Been Added`
      : `${rfqs.length} New RFQ Opportunities — You've Been Added`;

    sendMail({
      from: `Phileein Hospitality ${config.masterEmail}`,
      to: vendor_email,
      subject,
      html: htmlContent
    });

    console.log(`[WH-67] Sent bulk RFQ join notification (${rfqs.length} RFQs) to ${vendor_email}`);
    return true;
  } catch (err) {
    console.error('[WH-67] Error sending vendor bulk RFQ notification:', err);
    return false;
  }
};

/**
 * Send a HEADS-UP email to all members of the business unit when an RFQ/Tender
 * is closed by the creator. Conveys urgency: all actions on this RFQ are now
 * permanently restricted (no scoring, no negotiation, no PO edits, no approvals).
 *
 * @param {Object} params
 * @param {Object} params.rfqDetails - { id, rfq_no, is_tender, title, hotel_name, company_name }
 * @param {string} params.closedByName - Name of the user who closed the RFQ
 * @param {Array}  params.users - Array of { name, email } — business unit members
 */
export const sendRfqClosedHeadsUpNotification = async ({
  rfqDetails,
  closedByName,
  users,
}) => {
  try {
    if (!users || users.length === 0) {
      logger.debug('[RFQ Closed Heads-Up] No BU members to notify');
      return false;
    }

    const { id: rfq_id, rfq_no, is_tender, title, hotel_name, company_name } = rfqDetails || {};
    const entityLabel = is_tender === 1 ? 'Tender' : 'RFQ';
    const viewUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfq_id}`;

    const subject = `Heads up: ${entityLabel} #${rfq_no} has been CLOSED — all actions are now restricted`;

    for (const user of users) {
      const headerContent = `<h2>Hello ${user.name || 'Team Member'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p style="font-size:17px; margin-bottom:16px;">
            <strong>Heads up</strong> — ${entityLabel} <strong>#${rfq_no}</strong>
            has been <strong style="color:#991B1B;">CLOSED</strong> by ${closedByName || 'the creator'}.
          </p>

          <div style="background-color:#FEF2F2; border-left:4px solid #DC2626; padding:14px 18px; margin:18px 0; border-radius:6px;">
            <div style="color:#7F1D1D; font-weight:700; font-size:14px; margin-bottom:6px;">
              ALL ACTIONS ARE NOW PERMANENTLY RESTRICTED
            </div>
            <div style="color:#991B1B; font-size:13px; line-height:1.6;">
              From this point forward, no further activity is permitted on this ${entityLabel}:
              <ul style="margin:8px 0 0 18px; padding:0;">
                <li>Technical evaluation, scoring, and re-evaluation are blocked</li>
                <li>Quote comparison, negotiation rounds, and vendor finalization are blocked</li>
                <li>Purchase Order edits, creation, and approvals are blocked</li>
                <li>All pending approvals (technical / commercial / PO) have been <strong>cancelled</strong></li>
              </ul>
            </div>
          </div>

          <ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>${entityLabel} Number:</strong> #${rfq_no}</li>
            ${title ? `<li style="padding:4px 0;"><strong>Title:</strong> ${title}</li>` : ''}
            ${company_name ? `<li style="padding:4px 0;"><strong>Company:</strong> ${company_name}</li>` : ''}
            ${hotel_name ? `<li style="padding:4px 0;"><strong>Business Unit:</strong> ${hotel_name}</li>` : ''}
            <li style="padding:4px 0;"><strong>Closed By:</strong> ${closedByName || 'N/A'}</li>
          </ul>

          <div style="text-align:center; margin-top:24px;">
            <a href="${viewUrl}"
               style="background-color:#DC2626; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              View Closed ${entityLabel}
            </a>
          </div>

          <p style="margin-top:24px; font-size:13px; color:#6B7280;">
            If you believe this ${entityLabel} was closed in error, please contact ${closedByName || 'the creator'} directly.
            A closed ${entityLabel} cannot be reopened.
          </p>

          <p style="text-align:center; margin-top:30px;">
            <strong>— Phileein Hospitality Team</strong>
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

    logger.info(`[RFQ Closed Heads-Up] Sent to ${users.length} BU members for ${entityLabel} #${rfq_no}`);
    return true;
  } catch (err) {
    logError('[RFQ Closed Heads-Up] Error:', err);
    return false;
  }
};

/**
 * Send notification to current pending approvers when their approval instance
 * has been CANCELLED (for example because the parent RFQ was closed). Tells
 * them their action is no longer required.
 *
 * @param {Object} params
 * @param {string} params.entityType - 'RFQ', 'TENDER', 'TECHNICAL', 'NEGOTIATION', 'NEGOTIATION_QUOTE', 'PO', 'ARC'
 * @param {string} params.entityIdentifier - Display identifier (e.g. rfq_no)
 * @param {string} params.reason - Human-readable reason (e.g. "RFQ closed by creator")
 * @param {Array}  params.approvers - Array of { user_id, user_name, user_email }
 * @param {Object} params.extraContext - Optional { rfq_id }
 */
export const sendApprovalCancelledNotification = async ({
  entityType,
  entityIdentifier,
  reason,
  approvers,
  extraContext = {},
}) => {
  try {
    if (!approvers || approvers.length === 0) return false;

    const label = ENTITY_LABELS[entityType] || entityType;
    const linkFn = ENTITY_LINK_MAP[entityType];
    const linkPath = linkFn && extraContext?.rfq_id
      ? linkFn(extraContext.rfq_id, extraContext)
      : '/dashboard';
    const viewUrl = `${process.env.FRONT_END_WEBSITE}${linkPath}`;

    const subject = `Approval No Longer Required — ${label}${entityIdentifier ? ` #${entityIdentifier}` : ''}`;

    for (const approver of approvers) {
      const headerContent = `<h2>Hello ${approver.user_name || 'Approver'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            The approval request for <strong>${label}${entityIdentifier ? ` #${entityIdentifier}` : ''}</strong>
            that was waiting on you has been <strong style="color:#991B1B;">CANCELLED</strong>.
            <strong>Your approval is no longer required.</strong>
          </p>

          <div style="background-color:#FEF2F2; border-left:4px solid #DC2626; padding:12px 16px; margin:16px 0; border-radius:4px;">
            <span style="color:#7F1D1D; font-weight:600;">No action needed</span>
            ${reason ? `<div style="color:#991B1B; font-size:13px; margin-top:4px;">Reason: ${reason}</div>` : ''}
          </div>

          <ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>Type:</strong> ${label}</li>
            ${entityIdentifier ? `<li style="padding:4px 0;"><strong>Identifier:</strong> #${entityIdentifier}</li>` : ''}
          </ul>

          <div style="text-align:center; margin-top:24px;">
            <a href="${viewUrl}"
               style="background-color:#6B7280; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
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
        to: approver.user_email,
        subject,
        html: htmlContent
      });
    }

    logger.info(`[Approval Cancelled] Notified ${approvers.length} approver(s) for ${label}${entityIdentifier ? ` #${entityIdentifier}` : ''}`);
    return true;
  } catch (err) {
    logError('[Approval Cancelled] Error:', err);
    return false;
  }
};
