import fs from 'fs';
import puppeteer from 'puppeteer';
import Config from '../config/app.config.js';
import { logger } from '../util/logger.js';
import { logError } from './common.js';

const INVOICE_DIR = Config.upload?.invoice_file || 'app/uploads/invoice_file';
const COMPANY_ADDRESS = '1st Floor, 271 Business Park, Model Industrial Estate, near Virwani Industrial Estate, off Western Express Highway, Vishveshwar Nagar, Goregaon, Mumbai, Maharashtra 400063';
const GSTIN = 'IN GST 19AABCD1743K1ZM';

/**
 * Generate Tax Invoice PDF for any payment type (BU, tender fee, vendor).
 * @param {Object} opts - { type, recipientName, recipientEmail?, amount, currency, paymentId, orderId, receipt, date, lineItems }
 * @returns {{ filePath: string, fileName: string } | null}
 */
export async function generateTaxInvoicePdf(opts) {
  const {
    type = 'Payment',
    recipientName,
    amount,
    currency = 'INR',
    paymentId,
    orderId,
    receipt,
    date,
    lineItems = []
  } = opts;

  const amountFormatted = typeof amount === 'number' ? amount : parseFloat(amount) || 0;
  const invoiceNumber = receipt ? `INV-${receipt}` : `INV-${orderId || paymentId}-${Date.now()}`;
  const invoiceDate = date || new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

  let rowsHtml;
  if (lineItems.length > 0) {
    rowsHtml = lineItems.map((item) => {
      const desc = item.description || item.name || 'Item';
      const amt = item.amount != null ? Number(item.amount) : amountFormatted;
      return `<tr>
          <td style="padding:10px 8px; font-size:12px; border-bottom:1px solid #e5e7eb;">${desc}</td>
          <td style="padding:10px 8px; font-size:12px; text-align:right; border-bottom:1px solid #e5e7eb;">₹ ${amt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
        </tr>`;
    }).join('');
  } else {
    rowsHtml = `<tr>
        <td style="padding:10px 8px; font-size:12px; border-bottom:1px solid #e5e7eb;">${type}</td>
        <td style="padding:10px 8px; font-size:12px; text-align:right; border-bottom:1px solid #e5e7eb;">₹ ${amountFormatted.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
      </tr>`;
  }

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>body{ font-family: Tahoma, Arial, sans-serif; font-size: 12px; color: #111; margin: 24px; } table { width: 100%; border-collapse: collapse; }</style></head>
<body>
  <div style="margin-bottom: 24px;">
    <div style="font-size: 20px; font-weight: bold; color: #158993;">Phileein Hospitality</div>
    <div style="font-size: 11px; color: #6b7280; margin-top: 4px;">${COMPANY_ADDRESS}</div>
    <div style="font-size: 11px; color: #6b7280;">${GSTIN}</div>
  </div>
  <h2 style="margin: 0 0 20px; font-size: 18px;">TAX INVOICE</h2>
  <table style="margin-bottom: 20px;">
    <tr><td style="padding:4px 0; color:#6b7280;">Invoice No.</td><td style="text-align:right;">${invoiceNumber}</td></tr>
    <tr><td style="padding:4px 0; color:#6b7280;">Date</td><td style="text-align:right;">${invoiceDate}</td></tr>
    <tr><td style="padding:4px 0; color:#6b7280;">Order ID</td><td style="text-align:right;">${orderId || '—'}</td></tr>
    <tr><td style="padding:4px 0; color:#6b7280;">Bill To</td><td style="text-align:right;">${recipientName || '—'}</td></tr>
  </table>
  <table style="border: 1px solid #e5e7eb;">
    <thead>
      <tr style="background: #f9fafb;">
        <th style="padding: 10px 8px; text-align: left; font-size: 11px;">Description</th>
        <th style="padding: 10px 8px; text-align: right; font-size: 11px;">Amount (₹)</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr style="background: #f0fdf4;">
        <td style="padding: 12px 8px; font-weight: 600;">Total</td>
        <td style="padding: 12px 8px; text-align: right; font-weight: 600;">₹ ${amountFormatted.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
      </tr>
    </tfoot>
  </table>
  <p style="margin-top: 24px; font-size: 11px; color: #6b7280;">This is a computer-generated tax invoice.</p>
</body>
</html>`;

  return generatePdf(html, `tax-invoice-${receipt || paymentId}-${Date.now()}.pdf`);
}

/**
 * Generate Payment Received / Receipt PDF.
 * @param {Object} opts - { recipientName, amount, currency, paymentId, orderId, date, description }
 * @returns {{ filePath: string, fileName: string } | null}
 */
export async function generatePaymentReceivedPdf(opts) {
  const {
    recipientName,
    amount,
    currency = 'INR',
    paymentId,
    orderId,
    date,
    description = 'Payment received'
  } = opts;

  const amountFormatted = typeof amount === 'number' ? amount : parseFloat(amount) || 0;
  const receiptDate = date || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>body{ font-family: Tahoma, Arial, sans-serif; font-size: 12px; color: #111; margin: 24px; }</style></head>
<body>
  <div style="margin-bottom: 24px;">
    <div style="font-size: 20px; font-weight: bold; color: #158993;">Phileein Hospitality</div>
    <div style="font-size: 11px; color: #6b7280; margin-top: 4px;">${COMPANY_ADDRESS}</div>
  </div>
  <h2 style="margin: 0 0 20px; font-size: 18px;">PAYMENT RECEIVED</h2>
  <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; background: #fafafa;">
    <p style="margin: 0 0 8px; color: #6b7280;">Date</p>
    <p style="margin: 0 0 16px; font-weight: 600;">${receiptDate}</p>
    <p style="margin: 0 0 8px; color: #6b7280;">Received from</p>
    <p style="margin: 0 0 16px; font-weight: 600;">${recipientName || '—'}</p>
    <p style="margin: 0 0 8px; color: #6b7280;">Description</p>
    <p style="margin: 0 0 16px;">${description}</p>
    <p style="margin: 0 0 8px; color: #6b7280;">Payment ID</p>
    <p style="margin: 0 0 16px;">${paymentId || '—'}</p>
    <p style="margin: 0 0 8px; color: #6b7280;">Order ID</p>
    <p style="margin: 0 0 16px;">${orderId || '—'}</p>
    <div style="border-top: 2px solid #158993; margin-top: 16px; padding-top: 16px;">
      <p style="margin: 0; font-size: 11px; color: #6b7280;">Amount received</p>
      <p style="margin: 4px 0 0; font-size: 22px; font-weight: 700; color: #111;">₹ ${amountFormatted.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
    </div>
  </div>
  <p style="margin-top: 24px; font-size: 11px; color: #6b7280;">This is a computer-generated receipt.</p>
</body>
</html>`;

  return generatePdf(html, `payment-received-${paymentId || orderId || 'receipt'}-${Date.now()}.pdf`);
}

async function generatePdf(html, fileName) {
  if (!fs.existsSync(INVOICE_DIR)) {
    fs.mkdirSync(INVOICE_DIR, { recursive: true });
  }
  const outputPath = `${INVOICE_DIR}/${fileName}`;
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true
    });
    await browser.close();
    return { filePath: outputPath, fileName };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    logError('paymentDocuments generatePdf error', err);
    return null;
  }
}
