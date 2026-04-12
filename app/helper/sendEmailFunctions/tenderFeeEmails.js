import fs from "fs";
import config from "../../config/app.config.js";
import { sendMail, logError } from "../common.js";
import { generateEmailTemplate } from "../notificationEmailLayout.js";
import { generateTaxInvoicePdf, generatePaymentReceivedPdf } from "../paymentDocuments.js";
import { logger } from '../../util/logger.js';

/**
 * Send tender fee payment confirmation email with invoice to vendor
 * @param {Object} params
 * @param {Object} params.vendorDetails - { id, name, email, organization_name }
 * @param {Object} params.rfqDetails - { id, rfq_no, title, tender_fees }
 * @param {Object} params.paymentDetails - { payment_id, razorpay_payment_id, razorpay_order_id, amount, receipt }
 * @param {Object} params.buyerDetails - { company_name, email, contact_number }
 */
export const sendTenderFeePaymentConfirmation = async ({
  vendorDetails,
  rfqDetails,
  paymentDetails,
  buyerDetails
}) => {
  try {
    if (!vendorDetails?.email) {
      logger.debug('No vendor email for tender fee payment confirmation');
      return false;
    }

    const vendorName = vendorDetails?.organization_name || vendorDetails?.name || 'Vendor';
    const amountInRupees = (paymentDetails?.amount || 0) / 100;
    const paymentDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    const headerContent = `<h2>Hello ${vendorName},</h2>`;

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          Thank you for your payment! Your tender participation fee has been successfully received.
        </p>

        <div style="background-color:#F0FDF4; border-left:4px solid #10B981; padding:16px; margin:16px 0; border-radius:4px;">
          <p style="margin:0; font-size:18px; font-weight:600; color:#166534;">
            Payment Successful
          </p>
        </div>

        <!-- Invoice Section -->
        <div style="border:1px solid #e5e7eb; border-radius:8px; padding:24px; margin:24px 0; background-color:#fafafa;">
          <div style="text-align:center; border-bottom:1px solid #e5e7eb; padding-bottom:16px; margin-bottom:16px;">
            <h3 style="margin:0; color:#1F2937;">TENDER FEE INVOICE</h3>
            <p style="margin:4px 0 0; color:#6B7280; font-size:14px;">Receipt #${paymentDetails?.receipt || paymentDetails?.payment_id || 'N/A'}</p>
          </div>

          <table style="width:100%; margin-bottom:16px;">
            <tr>
              <td style="padding:8px 0; color:#6B7280;">Invoice Date:</td>
              <td style="padding:8px 0; text-align:right; font-weight:600;">${paymentDate}</td>
            </tr>
            <tr>
              <td style="padding:8px 0; color:#6B7280;">Payment ID:</td>
              <td style="padding:8px 0; text-align:right; font-weight:600;">${paymentDetails?.razorpay_payment_id || 'N/A'}</td>
            </tr>
            <tr>
              <td style="padding:8px 0; color:#6B7280;">Order ID:</td>
              <td style="padding:8px 0; text-align:right; font-weight:600;">${paymentDetails?.razorpay_order_id || 'N/A'}</td>
            </tr>
          </table>

          <div style="border-top:1px solid #e5e7eb; padding-top:16px;">
            <h4 style="margin:0 0 12px; color:#1F2937;">Tender Details</h4>
            <table style="width:100%;">
              <tr>
                <td style="padding:4px 0; color:#6B7280;">Tender Number:</td>
                <td style="padding:4px 0; text-align:right;">${rfqDetails?.rfq_no || 'N/A'}</td>
              </tr>
              ${rfqDetails?.title ? `
              <tr>
                <td style="padding:4px 0; color:#6B7280;">Tender Title:</td>
                <td style="padding:4px 0; text-align:right;">${rfqDetails.title}</td>
              </tr>
              ` : ''}
            </table>
          </div>

          <div style="border-top:1px solid #e5e7eb; margin-top:16px; padding-top:16px;">
            <h4 style="margin:0 0 12px; color:#1F2937;">Bill To</h4>
            <p style="margin:0; color:#374151;">${vendorName}</p>
            <p style="margin:4px 0 0; color:#6B7280; font-size:14px;">${vendorDetails?.email || ''}</p>
          </div>

          <div style="border-top:2px solid #1F2937; margin-top:16px; padding-top:16px;">
            <table style="width:100%;">
              <tr>
                <td style="padding:8px 0;">Tender Participation Fee</td>
                <td style="padding:8px 0; text-align:right;">Rs. ${amountInRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              </tr>
              <tr style="font-size:18px; font-weight:600; color:#10B981;">
                <td style="padding:12px 0; border-top:1px solid #e5e7eb;">Total Paid</td>
                <td style="padding:12px 0; text-align:right; border-top:1px solid #e5e7eb;">Rs. ${amountInRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              </tr>
            </table>
          </div>

          <div style="text-align:center; margin-top:16px; padding:12px; background-color:#D1FAE5; border-radius:4px;">
            <span style="color:#065F46; font-weight:600;">PAID</span>
          </div>
        </div>

        <p style="margin-top:24px;">
          Tax invoice and payment received documents are attached to this email.
        </p>
        <p style="margin-top:12px;">
          You are now eligible to submit your quote for this tender. Please ensure you submit your quote before the bid end date.
        </p>

        <div style="text-align:center; margin-top:24px;">
          <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/send-quote?rfq=${rfqDetails?.id}"
             style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            Submit Your Quote
          </a>
        </div>

        ${buyerDetails?.company_name ? `
        <div style="margin-top:24px; padding:16px; background-color:#F3F4F6; border-radius:8px;">
          <h4 style="margin:0 0 8px; color:#1F2937;">Buyer Contact</h4>
          <p style="margin:0; font-size:14px; color:#6B7280;">
            ${buyerDetails.company_name}<br/>
            ${buyerDetails.email ? `Email: ${buyerDetails.email}<br/>` : ''}
            ${buyerDetails.contact_number ? `Phone: ${buyerDetails.contact_number}` : ''}
          </p>
        </div>
        ` : ''}

        <p style="text-align:center; margin-top: 30px;">
          Thank you for your participation.<br/>
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

    const htmlContent = generateEmailTemplate(headerContent, containerContent);

    const mailOpts = {
      from: config.webmasterMail,
      to: vendorDetails.email,
      subject: `Payment Confirmed — Tender Fee for ${rfqDetails?.rfq_no || 'Tender'}`,
      html: htmlContent
    };

    try {
      const receipt = paymentDetails?.receipt || `TENDER-${paymentDetails?.payment_id}-${Date.now()}`;
      const taxInvoicePdf = await generateTaxInvoicePdf({
        type: 'Tender Participation Fee',
        recipientName: vendorName,
        amount: amountInRupees,
        paymentId: paymentDetails?.razorpay_payment_id,
        orderId: paymentDetails?.razorpay_order_id,
        receipt,
        date: paymentDate,
        lineItems: [{ name: `Tender Fee - ${rfqDetails?.rfq_no || 'Tender'}`, amount: amountInRupees }]
      });
      const paymentReceivedPdf = await generatePaymentReceivedPdf({
        recipientName: vendorName,
        amount: amountInRupees,
        paymentId: paymentDetails?.razorpay_payment_id,
        orderId: paymentDetails?.razorpay_order_id,
        date: paymentDate,
        description: `Tender Participation Fee - ${rfqDetails?.rfq_no || 'Tender'}`
      });

      const attachments = [];
      if (taxInvoicePdf?.filePath && fs.existsSync(taxInvoicePdf.filePath)) {
        attachments.push({ filename: taxInvoicePdf.fileName, path: taxInvoicePdf.filePath, contentType: 'application/pdf' });
      }
      if (paymentReceivedPdf?.filePath && fs.existsSync(paymentReceivedPdf.filePath)) {
        attachments.push({ filename: paymentReceivedPdf.fileName, path: paymentReceivedPdf.filePath, contentType: 'application/pdf' });
      }
      if (attachments.length) mailOpts.attachments = attachments;
    } catch (docErr) {
      logError('Tender fee doc generation failed:', docErr);
    }

    await sendMail(mailOpts);

    logger.info(`Sent tender fee payment confirmation to ${vendorDetails.email} for RFQ ${rfqDetails?.rfq_no}`);
    return true;
  } catch (err) {
    logError("Error sending tender fee payment confirmation email:", err);
    return false;
  }
};
