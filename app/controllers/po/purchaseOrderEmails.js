import config from "../../config/app.config.js";
import db from "../../config/dbConn.js";
import { sendMail, logError } from "../../helper/common.js";
import { logger } from '../../util/logger.js';
import { generateEmailTemplate } from "../../helper/notificationEmailLayout.js";
import userModel from "../../models/userModel.js";
import vendorModel from "../../models/vendorModel.js";
import rbacModel from "../../models/rbacModel.js";
import hospitalityModel from "../../models/hospitalityModel.js";
import { dispatch as dispatchNotification } from "../../services/notificationService.js";
import {
  buyerPoApproval,
  buyerQuoteComparison,
  toAbsoluteUrl,
  vendorPoDetail,
  vendorPoList
} from "../../services/notificationLinks.js";

// Root-relative on purpose: the in-app row resolves it against whichever origin
// the reader is on. Email bodies wrap the same path with toAbsoluteUrl().
const poActionUrl = (purchaseOrder, role = 'buyer') => {
  return role === 'vendor'
    ? vendorPoDetail(purchaseOrder.id) || vendorPoList()
    : buyerPoApproval(purchaseOrder.id, purchaseOrder.rfq_id);
};

export const sendApprovalNotification = async (purchaseOrder, userId) => {
  return new Promise(async (resolve, reject) => {
    let user = await userModel.getUserById(userId);
    if (user) user = user[0];
    else reject('User not found!');

    const products = await db.any(
      `SELECT pv.name, pop.quantity, pop.unit, pop.total_price
       FROM tbl_purchase_order_product pop
       JOIN tbl_rfq_products rp ON pop.rfq_product_id = rp.id
       JOIN tbl_product_variant pv ON rp.product_variant_id = pv.id
       WHERE pop.purchase_order_id = $1`,
      [purchaseOrder.id]
    );
    const computedTotal = products.reduce((sum, p) => sum + Number(p.total_price || 0), 0);
    const computedQuantity = products.reduce((sum, p) => sum + Number(p.quantity || 0), 0);

    let finalized = await db.oneOrNone(
        `SELECT id, name FROM tbl_users WHERE id = $1`,
        [purchaseOrder.finalized_vendor_id]
    )

    const headerContent = `<h2>Hello ${user.name},</h2>`;

    const linkPath = poActionUrl(purchaseOrder, 'buyer');
    const emailUrl = toAbsoluteUrl(linkPath);

    const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
            <p>
            A Purchase Order has been initiated in your company that needs your approval.
            </p>

            <h4>Purchase Order Details</h4>
            <ul>
            <li><strong>Product(s) Name:</strong> ${products.map(p => p?.name).filter(Boolean).join(", ")}</li>
            <li><strong>Quantity:</strong> ${computedQuantity || 'N/A'}</li>
            <li><strong>Total Value:</strong> ₹${computedTotal.toLocaleString('en-IN')}</li>
            <li><strong>Finalized Vendor:</strong> ${finalized.name}</li>
            <li><strong>Created At:</strong> ${
                purchaseOrder.created_at
            }</li>
            </ul>

            <p style="margin-top:20px; text-align:center;">
                Please ensure the necessary actions are taken to proceed the Purchase Order.
            </p>

            <a href="${emailUrl}"
            style="background-color: #3B82F6; color: white; text-align: center; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600; margin: 20px auto;">
            View Purchase Order
            </a>

            <p style="text-align:center; margin-top: 30px;">
            Thank you for staying proactive.<br/>
            <strong>— Phileein Hospitality Team</strong>
            </p>
        </div>`;

    // Generate final email layout
    const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

    let mailRecipients = {
      from: config.webmasterMail,
      to: user?.email,
      subject: `New PO Approval Request — Your Action is Needed`,
      html: dynamicHTML
    };

    sendMail(mailRecipients);

    dispatchNotification({
      userIds: [user.id],
      category: 'po',
      type: 'po_approval_needed',
      title: `PO #${purchaseOrder.po_number || purchaseOrder.id} needs your approval`,
      body: `A purchase order is awaiting your approval.`,
      data: { po_id: purchaseOrder.id, rfq_id: purchaseOrder.rfq_id },
      actionUrl: linkPath
    }).catch((err) => logError('dispatch po_approval_needed failed', err));

    resolve(true);
  });
};

export const sendPONotificationToVendor = async (purchaseOrder, user) => {
    try {
        logger.info("PO TEST -> PURCHASE ORDER EMAIL TRIGGERED!")
        let company = await userModel.getCompanyDetail(user.id);
        if(company) company = company[0];

        const products = await db.any(
            `SELECT pv.name, pop.quantity, pop.unit, pop.total_price
             FROM tbl_purchase_order_product pop
             JOIN tbl_rfq_products rp ON pop.rfq_product_id = rp.id
             JOIN tbl_product_variant pv ON rp.product_variant_id = pv.id
             WHERE pop.purchase_order_id = $1`,
            [purchaseOrder.id]
        );
        const computedTotal = products.reduce((sum, p) => sum + Number(p.total_price || 0), 0);
        const computedQuantity = products.reduce((sum, p) => sum + Number(p.quantity || 0), 0);

        let vendor = await userModel.getUserById(purchaseOrder.finalized_vendor_id);
        if(!vendor) throw new Error("Vendor Not Found!");
        vendor = vendor[0];

        const headerContent = `<h2>Hello ${vendor.organization_name || vendor.name || "Vendor"},</h2>`;

        const fileName = `po-${purchaseOrder.po_number}.pdf`;

        const containerContent = `
            <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
            <p>
                We're excited to inform you that a <strong>Purchase Order</strong> has been created for your quote.
                <br>
                Please refer to the attachment in this email for the formal PO document.
            </p>

            <h4>Purchase Order Details</h4>
            <ul>
                <li><strong>PO Number:</strong> ${purchaseOrder.po_number}</li>
                <li><strong>Product(s) Name:</strong> ${products.map(p => p.name).join(", ")}</li>
                <li><strong>Quantity:</strong> ${computedQuantity || 'N/A'}</li>
                <li><strong>Total Value:</strong> ₹${computedTotal.toLocaleString('en-IN')}</li>
                <li><strong>Created At:</strong> ${new Date(purchaseOrder.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</li>
            </ul>

            <h4>Buyer Info</h4>
            <p><strong>Company Name: </strong> ${company.company_name}</p>
            <p><strong>User Name: </strong> ${user.name}</p>
            <p><strong>User Email: </strong> ${user.email}</p>

            <p style="margin-top:20px;">
                Please ensure your team is aligned and prepared to fulfill the order as per the specified terms.
            </p>

            <a href='${purchaseOrder.po_pdf_url}'>Click here to view PO Document</a>

            <p style="text-align:center; margin-top: 30px;">
                Thank you for your continued partnership.<br/>
                <strong>— Phileein Hospitality Team</strong>
            </p>
            </div>
            `;

        // Generate final email layout
        const dynamicHTML = generateEmailTemplate(
          headerContent,
          containerContent
        );

        const spocList = await vendorModel.getSpocDetails(purchaseOrder.finalized_vendor_id);

        let mailRecipients = {
            from: `${company.company_name} ${config.masterEmail}`,
            to: vendor.email,
            subject: `Purchase Order Confirmed — PO #${purchaseOrder.po_number}`, // Subject line
            html: dynamicHTML,
            // attachments: [
            //     {
            //         filename: `PO_${purchaseOrder.po_number}.pdf`,
            //         path: `/app/storage/invoices/${fileName}`,
            //         contentType: 'application/pdf'
            //     }
            // ]
        };
        
        logger.debug({ vendor }, "PO TEST -> VENDOR");
        logger.debug({ mailRecipients }, "PO TEST -> MAIL RECIPIENTS");

        // if (spocList && spocList.length > 0) {
        //     mailRecipients.to = spocList.map(spoc => spoc.email);
        //     mailRecipients.cc =  vendor.email;
        // } else {
        //     mailRecipients.to =  vendor.email;
        // }

        sendMail(mailRecipients);

        dispatchNotification({
          userIds: [vendor.id],
          category: 'po',
          type: 'po_sent_to_vendor',
          title: `New PO #${purchaseOrder.po_number} for your acceptance`,
          body: `${company?.company_name || 'A buyer'} has raised a Purchase Order.`,
          data: { po_id: purchaseOrder.id, rfq_id: purchaseOrder.rfq_id },
          actionUrl: poActionUrl(purchaseOrder, 'vendor')
        }).catch((err) => logError('dispatch po_sent_to_vendor failed', err));

        logger.info("PO TEST -> EMAIL HAS BEEN SENT!")
    } catch (error) {
        logError('sendPONotificationToVendor error', error);
        throw error;
    }
}

/**
 * Send email to vendor requesting them to accept or reject the PO.
 * Called when PO is fully approved internally and moves to acceptance_pending.
 */
export const sendPOAcceptanceRequestToVendor = async (purchaseOrder, rfqDetails) => {
  try {
    let vendor = await userModel.getUserById(purchaseOrder.finalized_vendor_id);
    if (!vendor || !vendor[0]) throw new Error("Vendor Not Found!");
    vendor = vendor[0];

    const products = await db.any(
      `SELECT pv.id, pv.name, pop.quantity, pop.unit, pop.unit_price, pop.total_price
       FROM tbl_purchase_order_product pop
       JOIN tbl_rfq_products rp ON pop.rfq_product_id = rp.id
       JOIN tbl_product_variant pv ON rp.product_variant_id = pv.id
       WHERE pop.purchase_order_id = $1`,
      [purchaseOrder.id]
    );

    const computedTotal = products.reduce((sum, p) => sum + Number(p.total_price || 0), 0);
    const computedQuantity = products.reduce((sum, p) => sum + Number(p.quantity || 0), 0);

    const headerContent = `<h2>Hello ${vendor.organization_name || vendor.name || "Vendor"},</h2>`;

    const linkPath = poActionUrl(purchaseOrder, 'vendor');
    const reviewUrl = toAbsoluteUrl(linkPath);

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          A <strong>Purchase Order</strong> has been raised for you for
          RFQ <strong>#${rfqDetails?.rfq_no || ''}</strong>.
          Your action is required to proceed.
        </p>

        <h4>Purchase Order Details</h4>
        <ul>
          <li><strong>PO Number:</strong> ${purchaseOrder.po_number}</li>
          <li><strong>Product(s):</strong> ${products.map(p => p.name).join(", ")}</li>
          <li><strong>Quantity:</strong> ${computedQuantity || 'N/A'}</li>
          <li><strong>Total Value:</strong> Rs. ${computedTotal.toLocaleString('en-IN')}</li>
        </ul>

        <div style="background-color:#FEF3C7; border-left:4px solid #F59E0B; padding:16px; margin:16px 0; border-radius:4px;">
          <p style="margin:0; font-weight:600; color:#92400E;">
            Please review and accept or reject this Purchase Order.
          </p>
          <p style="margin:8px 0 0; color:#92400E;">
            If you are unable to fulfill this order, you may reject it and the buyer will be notified to finalize an alternative vendor.
          </p>
        </div>

        <div style="text-align:center; margin-top:24px;">
          <a href="${reviewUrl}"
             style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            Review Purchase Order
          </a>
        </div>

        <p style="text-align:center; margin-top: 30px;">
          Thank you for your prompt response.<br/>
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

    const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

    sendMail({
      from: config.webmasterMail,
      to: vendor.email,
      subject: `Action Required: PO #${purchaseOrder.po_number} for RFQ #${rfqDetails?.rfq_no || ''} — Accept or Reject`,
      html: dynamicHTML
    });

    dispatchNotification({
      userIds: [vendor.id],
      category: 'po',
      type: 'po_acceptance_request',
      title: `Action required: PO #${purchaseOrder.po_number}`,
      body: `Please accept or reject this Purchase Order.`,
      data: { po_id: purchaseOrder.id, rfq_id: purchaseOrder.rfq_id },
      actionUrl: linkPath
    }).catch((err) => logError('dispatch po_acceptance_request failed', err));

    logger.info(`Sent PO acceptance request email to vendor ${vendor.email} for PO ${purchaseOrder.po_number}`);
  } catch (error) {
    logError('sendPOAcceptanceRequestToVendor error', error);
    throw error;
  }
};

/**
 * Send email to Commercial Evaluators when vendor rejects a PO.
 */
export const sendVendorRejectionNotification = async (purchaseOrder, vendorUserId, reason) => {
  try {
    let vendor = await userModel.getUserById(vendorUserId);
    vendor = vendor?.[0];
    let vendorCompany = await userModel.getCompanyDetail(purchaseOrder.finalized_vendor_id);
    vendorCompany = vendorCompany?.[0];
    const vendorName = vendor?.organization_name || vendor?.name || 'Vendor';
    const companyName = vendorCompany?.company_name || 'Company';

    const rfqDetails = await db.oneOrNone(
      `SELECT r.id, r.rfq_no, r.title, r.hotel_id
       FROM tbl_rfq r WHERE r.id = $1`,
      [purchaseOrder.rfq_id]
    );

    const products = await db.any(
      `SELECT pv.name
       FROM tbl_purchase_order_product pop
       JOIN tbl_rfq_products rp ON pop.rfq_product_id = rp.id
       JOIN tbl_product_variant pv ON rp.product_variant_id = pv.id
       WHERE pop.purchase_order_id = $1`,
      [purchaseOrder.id]
    );

    // Get commercial evaluators for this BU
    const evaluators = await rbacModel.getUsersWithModuleActionsForHotels(
      [rfqDetails?.hotel_id],
      'quote-compare',
      ['read', 'create'],
      null
    );

    if (!evaluators || evaluators.length === 0) {
      logger.info('No commercial evaluators to notify for vendor PO rejection');
      return;
    }

    const linkPath = buyerQuoteComparison(purchaseOrder.rfq_id);
    const quoteCompareUrl = toAbsoluteUrl(linkPath);

    for (const user of evaluators) {
      const headerContent = `<h2>Hello ${user.name},</h2>`;
      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <div style="background-color:#FEE2E2; border-left:4px solid #EF4444; padding:16px; margin:16px 0; border-radius:4px;">
            <p style="margin:0; font-weight:600; color:#991B1B;">
              ${companyName} has rejected PO #${purchaseOrder.po_number}
            </p>
          </div>

          <h4>Details</h4>
          <ul>
            <li><strong>RFQ:</strong> #${rfqDetails?.rfq_no || ''} ${rfqDetails?.title ? `— ${rfqDetails.title}` : ''}</li>
            <li><strong>Product(s):</strong> ${products.map(p => p.name).join(", ")}</li>
            <li><strong>Vendor:</strong> ${vendorName}</li>
            ${reason ? `<li><strong>Reason:</strong> ${reason}</li>` : ''}
          </ul>

          <p>
            The vendor has been de-finalized for this RFQ. Please review the Quote Comparison
            and finalize an alternative vendor to proceed.
          </p>

          <div style="text-align:center; margin-top:24px;">
            <a href="${quoteCompareUrl}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              Go to Quote Compare
            </a>
          </div>

          <p style="text-align:center; margin-top: 30px;">
            Your prompt action is appreciated.<br/>
            <strong>— Phileein Hospitality Team</strong>
          </p>
        </div>`;

      const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

      sendMail({
        from: config.webmasterMail,
        to: user.email,
        subject: `PO Rejected by Vendor — ${vendorName} rejected PO #${purchaseOrder.po_number}`,
        html: dynamicHTML
      });
    }

    dispatchNotification({
      userIds: evaluators.map((u) => u.id).filter(Boolean),
      category: 'po',
      type: 'po_vendor_rejected',
      title: `Vendor rejected PO #${purchaseOrder.po_number} — action needed`,
      body: `${vendorName} has rejected PO #${purchaseOrder.po_number}. Please finalize an alternative vendor.`,
      data: { po_id: purchaseOrder.id, rfq_id: purchaseOrder.rfq_id, reason: reason || null },
      actionUrl: linkPath
    }).catch((err) => logError('dispatch po_vendor_rejected failed', err));

    logger.info(`Sent vendor rejection notifications to ${evaluators.length} commercial evaluators for PO ${purchaseOrder.po_number}`);
  } catch (error) {
    logError('sendVendorRejectionNotification error', error);
  }
};

/**
 * Send reminder email to vendor for a PO still in acceptance_pending status.
 * @param {Object} purchaseOrder - PO row
 * @param {Object} rfqDetails - { rfq_no }
 * @param {number} reminderNumber - 1, 2, or 3
 */
export const sendPOAcceptanceReminderToVendor = async (purchaseOrder, rfqDetails, reminderNumber) => {
  try {
    let vendor = await userModel.getUserById(purchaseOrder.finalized_vendor_id);
    if (!vendor || !vendor[0]) return;
    vendor = vendor[0];

    const products = await db.any(
      `SELECT pv.name, pop.quantity, pop.unit, pop.total_price
       FROM tbl_purchase_order_product pop
       JOIN tbl_rfq_products rp ON pop.rfq_product_id = rp.id
       JOIN tbl_product_variant pv ON rp.product_variant_id = pv.id
       WHERE pop.purchase_order_id = $1`,
      [purchaseOrder.id]
    );
    const computedTotal = products.reduce((sum, p) => sum + Number(p.total_price || 0), 0);
    const computedQuantity = products.reduce((sum, p) => sum + Number(p.quantity || 0), 0);

    const subjects = {
      1: `Gentle Reminder: PO #${purchaseOrder.po_number} awaiting your response`,
      2: `Reminder: PO #${purchaseOrder.po_number} still requires your action`,
      3: `Final Reminder: PO #${purchaseOrder.po_number} needs your immediate attention`,
    };

    const tones = {
      1: 'This is a gentle reminder that the following Purchase Order is awaiting your response.',
      2: 'This is a reminder that the following Purchase Order still requires your action. Please respond at your earliest convenience.',
      3: 'This is the final reminder. The following Purchase Order urgently needs your attention. Please accept or reject this order immediately.',
    };

    const bgColors = {
      1: '#FEF3C7',
      2: '#FED7AA',
      3: '#FEE2E2',
    };
    const borderColors = {
      1: '#F59E0B',
      2: '#F97316',
      3: '#EF4444',
    };
    const textColors = {
      1: '#92400E',
      2: '#9A3412',
      3: '#991B1B',
    };

    const headerContent = `<h2>Hello ${vendor.organization_name || vendor.name || "Vendor"},</h2>`;
    const linkPath = poActionUrl(purchaseOrder, 'vendor');
    const reviewUrl = toAbsoluteUrl(linkPath);

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>${tones[reminderNumber] || tones[1]}</p>

        <h4>Purchase Order Details</h4>
        <ul>
          <li><strong>PO Number:</strong> ${purchaseOrder.po_number}</li>
          <li><strong>RFQ:</strong> #${rfqDetails?.rfq_no || ''}</li>
          <li><strong>Product(s):</strong> ${products.map(p => p.name).join(", ")}</li>
          <li><strong>Quantity:</strong> ${computedQuantity || 'N/A'}</li>
          <li><strong>Total Value:</strong> Rs. ${computedTotal.toLocaleString('en-IN')}</li>
        </ul>

        <div style="background-color:${bgColors[reminderNumber] || bgColors[1]}; border-left:4px solid ${borderColors[reminderNumber] || borderColors[1]}; padding:16px; margin:16px 0; border-radius:4px;">
          <p style="margin:0; font-weight:600; color:${textColors[reminderNumber] || textColors[1]};">
            Please accept or reject this Purchase Order.
          </p>
        </div>

        <div style="text-align:center; margin-top:24px;">
          <a href="${reviewUrl}"
             style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            Review Purchase Order
          </a>
        </div>

        <p style="text-align:center; margin-top: 30px;">
          Thank you for your prompt response.<br/>
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

    const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

    sendMail({
      from: config.webmasterMail,
      to: vendor.email,
      subject: subjects[reminderNumber] || subjects[1],
      html: dynamicHTML
    });

    dispatchNotification({
      userIds: [vendor.id],
      category: 'po',
      type: `po_acceptance_reminder_${reminderNumber}`,
      title: subjects[reminderNumber] || subjects[1],
      body: `PO #${purchaseOrder.po_number} still requires your action.`,
      data: { po_id: purchaseOrder.id, rfq_id: purchaseOrder.rfq_id, reminder: reminderNumber },
      actionUrl: linkPath
    }).catch((err) => logError(`dispatch po_acceptance_reminder_${reminderNumber} failed`, err));

    logger.info(`Sent PO acceptance reminder #${reminderNumber} to vendor ${vendor.email} for PO ${purchaseOrder.po_number}`);
  } catch (error) {
    logError('sendPOAcceptanceReminderToVendor error', error);
  }
};

/**
 * Send email to all internal BU members when vendor accepts a PO.
 */
export const sendPOAcceptedNotificationToTeam = async (purchaseOrder, rfqDetails) => {
  try {
    let vendor = await userModel.getUserById(purchaseOrder.finalized_vendor_id);
    let vendorCompany = await userModel.getCompanyDetail(purchaseOrder.finalized_vendor_id);
    vendor = vendor?.[0];
    vendorCompany = vendorCompany?.[0];
    const vendorName = vendor?.organization_name || vendor?.name || 'Vendor';
    const companyName = vendorCompany?.company_name || 'Company';

    const products = await db.any(
      `SELECT pv.name, pop.quantity, pop.unit, pop.total_price
       FROM tbl_purchase_order_product pop
       JOIN tbl_rfq_products rp ON pop.rfq_product_id = rp.id
       JOIN tbl_product_variant pv ON rp.product_variant_id = pv.id
       WHERE pop.purchase_order_id = $1`,
      [purchaseOrder.id]
    );
    const computedTotal = products.reduce((sum, p) => sum + Number(p.total_price || 0), 0);
    const computedQuantity = products.reduce((sum, p) => sum + Number(p.quantity || 0), 0);

    // Get company details
    const companyDetails = await db.oneOrNone(`
      SELECT name AS company_name FROM tbl_hospitality_companies WHERE id = $1
    `, [rfqDetails?.hospitality_company_id]);

    // Get users mapped to this specific hotel + company-level admins
    const hotelUsers = await hospitalityModel.getUserMappingsForCompany(
      rfqDetails?.hospitality_company_id,
      1,
      rfqDetails?.hotel_id
    );
    const companyAdmins = await hospitalityModel.getUserMappingsForCompany(
      rfqDetails?.hospitality_company_id,
      0
    );

    // Deduplicate by user_id
    const userMap = new Map();
    [...hotelUsers, ...companyAdmins].forEach(m => {
      if (!userMap.has(m.user_id)) {
        userMap.set(m.user_id, { id: m.user_id, name: m.name, email: m.email });
      }
    });
    const usersToNotify = Array.from(userMap.values());

    if (usersToNotify.length === 0) {
      logger.debug('No users to notify for PO vendor acceptance');
      return;
    }

    const linkPath = poActionUrl(purchaseOrder, 'buyer');
    const poUrl = toAbsoluteUrl(linkPath);

    for (const user of usersToNotify) {
      const headerContent = `<h2>Hello ${user.name || 'User'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            Great news! The vendor has accepted the Purchase Order.
          </p>

          <div style="background-color:#F0FDF4; border-left:4px solid #10B981; padding:16px; margin:16px 0; border-radius:4px;">
            <p style="margin:0; font-size:18px; font-weight:600; color:#166534;">
              ${companyName} has accepted PO #${purchaseOrder.po_number}
            </p>
          </div>

          <h4 style="margin-top:24px; color:#1F2937;">RFQ Details</h4>
          <ul style="list-style:none; padding-left:0;">
            <li style="padding:4px 0;"><strong>RFQ Number:</strong> ${rfqDetails?.rfq_no || 'N/A'}</li>
            ${rfqDetails?.title ? `<li style="padding:4px 0;"><strong>RFQ Title:</strong> ${rfqDetails.title}</li>` : ''}
          </ul>

          <h4 style="margin-top:24px; color:#1F2937;">Purchase Order Details</h4>
          <ul style="list-style:none; padding-left:0;">
            <li style="padding:4px 0;"><strong>PO Number:</strong> ${purchaseOrder.po_number}</li>
            <li style="padding:4px 0;"><strong>Product(s):</strong> ${products.map(p => p.name).join(', ') || 'N/A'}</li>
            <li style="padding:4px 0;"><strong>Quantity:</strong> ${computedQuantity || 'N/A'}</li>
            <li style="padding:4px 0;"><strong>Total Value:</strong> Rs. ${computedTotal.toLocaleString('en-IN')}</li>
          </ul>

          <h4 style="margin-top:24px; color:#1F2937;">Vendor Details</h4>
          <ul style="list-style:none; padding-left:0;">
            <li style="padding:4px 0;"><strong>Vendor:</strong> ${vendorName}</li>
            <li style="padding:4px 0;"><strong>Email:</strong> ${vendor?.email || 'N/A'}</li>
          </ul>

          <div style="text-align:center; margin-top:24px;">
            <a href="${poUrl}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              View Purchase Order
            </a>
          </div>

          <p style="text-align:center; margin-top: 30px;">
            <strong>— ${companyDetails?.company_name || 'Phileein Hospitality'} Team</strong>
          </p>
        </div>`;

      const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

      sendMail({
        from: config.webmasterMail,
        to: user.email,
        subject: `Vendor Accepted PO #${purchaseOrder.po_number} for RFQ #${rfqDetails?.rfq_no || ''}`,
        html: dynamicHTML
      });
    }

    dispatchNotification({
      userIds: usersToNotify.map((u) => u.id).filter(Boolean),
      category: 'po',
      type: 'po_vendor_accepted',
      title: `Vendor accepted PO #${purchaseOrder.po_number}`,
      body: `${vendorName} has accepted the Purchase Order.`,
      data: { po_id: purchaseOrder.id, rfq_id: purchaseOrder.rfq_id },
      actionUrl: linkPath
    }).catch((err) => logError('dispatch po_vendor_accepted failed', err));

    logger.info(`Sent PO accepted notifications to ${usersToNotify.length} users for PO ${purchaseOrder.po_number}`);
  } catch (error) {
    logError('sendPOAcceptedNotificationToTeam error', error);
  }
};