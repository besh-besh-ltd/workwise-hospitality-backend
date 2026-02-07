import db from '../../config/dbConn.js';
import fs from 'fs';
import path from 'path';
import Handlebars from 'handlebars';
import puppeteer from 'puppeteer';
import { sendMail } from '../../helper/common.js';
import { getLifecycleHistory } from '../../models/generalModel.js';
import { generateEmailTemplate } from '../../helper/notificationEmailLayout.js';
import userModel from '../../models/userModel.js';
import vendorModel from '../../models/vendorModel.js';
import rfqModel from '../../models/rfqModel.js';

/**
 * Generate ARC Award Document PDF for a product
 * @param {number} rfq_product_id - The RFQ product ID
 * @param {Object} txContext - Transaction context (optional)
 * @returns {Promise<Object>} PDF generation result
 */
export const generateAwardDocument = async (rfq_product_id, txContext = null) => {
  const t = txContext || db;

  try {
    // Get RFQ product details using model
    const productData = await rfqModel.getRfqProductDetailsForArc(rfq_product_id, t);

    if (!productData) {
      throw new Error('RFQ product not found');
    }

    // VALIDATION: ARC is only applicable for tenders (is_tender = 1)
    if (!productData.is_tender || productData.is_tender !== 1) {
      throw new Error('ARC document generation is only applicable for tenders (is_tender = 1)');
    }

    // Get finalized vendor using model
    const finalization = await rfqModel.getFinalizedVendorForProduct(
      productData.rfq_id,
      productData.product_variant_id,
      productData.variant,
      t
    );

    if (!finalization) {
      throw new Error('No finalized vendor found for this product');
    }

    // Get vendor details
    const vendorData = await userModel.user_profile_detail(finalization.vendor_id);
    if (!vendorData || vendorData.length === 0) {
      throw new Error('Vendor details not found');
    }
    const vendor = vendorData[0];

    // Get quote details using model
    const quoteData = await rfqModel.getQuoteItemDetails(finalization.quote_id, t);

    // Get product specs using model
    const productSpecs = await rfqModel.getRfqProductSpecs(
      productData.rfq_id,
      productData.product_variant_id,
      productData.variant,
      ['Quantity', 'Unit'],
      t
    );

    const quantitySpec = productSpecs.find(s => s.title === 'Quantity');
    const unitSpec = productSpecs.find(s => s.title === 'Unit');

    // Get lifecycle history for this tender
    const lifecycleHistory = await getLifecycleHistory('TENDER', productData.rfq_id, t);

    // Prepare data for template
    const now = new Date();
    const effectiveDate = now.toLocaleDateString('en-GB', { 
      day: '2-digit', 
      month: 'long', 
      year: 'numeric' 
    });

    const templateData = {
      effective_date: effectiveDate,
      service_provider: {
        name: 'Phileein Hospitality Pvt. Ltd.',
        address: productData.hospitality_company_address || 'Address to be filled',
        // Add more details if available
      },
      hotel: {
        name: productData.hotel_name || productData.company_name,
        address: productData.hotel_address || productData.location || 'Address to be filled',
      },
      vendor: {
        name: vendor.organization_name || vendor.company_name || vendor.name,
        address: vendor.address || 'Address to be filled',
        email: vendor.email,
        phone: vendor.mobile || vendor.phone,
        gstin: vendor.gstin || 'GSTIN to be filled',
      },
      product: {
        name: productData.product_name,
        category: productData.product_category_name,
        quantity: quantitySpec?.value || quoteData?.quantity || 1,
        unit: unitSpec?.value || quoteData?.unit || 'NOS',
        unit_price: quoteData?.unit_price || 0,
        total_price: quoteData?.total_price || 0,
      },
      rfq: {
        rfq_no: productData.rfq_no,
        bid_end_date: productData.bid_end_date ? new Date(productData.bid_end_date).toLocaleDateString('en-GB') : '',
      },
      terms_and_conditions: 'As per RFQ terms and conditions',
      lifecycle_history: lifecycleHistory.map(event => ({
        stage: event.stage,
        action: event.action,
        performed_by: event.performed_by_name || 'System',
        performed_at: new Date(event.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        remarks: event.remarks || '-',
      })),
      has_lifecycle_history: lifecycleHistory.length > 0,
    };

    // Load Handlebars template
    const templatePath = path.join(process.cwd(), 'app', 'helper', 'arcAwardTemplate.hbs');

    if (!fs.existsSync(templatePath)) {
      throw new Error(`ARC template not found at ${templatePath}`);
    }

    const templateSource = fs.readFileSync(templatePath, 'utf8');
    const template = Handlebars.compile(templateSource);

    // Render HTML
    const html = template(templateData);

    // Ensure output folder exists
    const storageDir = path.join(process.cwd(), 'app', 'storage', 'arc-documents');
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    const fileName = `arc-award-${productData.rfq_no}-product-${rfq_product_id}-${Date.now()}.pdf`;
    const fullPath = path.join(storageDir, fileName);

    // Generate PDF using Puppeteer
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    await page.pdf({
      path: fullPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' }
    });

    await browser.close();

    return {
      ok: true,
      message: 'ARC document PDF created',
      file: `/app/storage/arc-documents/${fileName}`,
      absolutePath: fullPath
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || 'Failed to generate ARC document'
    };
  }
};

/**
 * Send ARC Award Document to Vendor
 * @param {number} rfq_product_id - The RFQ product ID
 * @param {string} document_url - The S3 URL of the document
 * @param {Object} txContext - Transaction context (optional)
 * @returns {Promise<void>}
 */
export const sendAwardDocumentToVendor = async (rfq_product_id, document_url, txContext = null) => {
  const t = txContext || db;

  try {
    // Get product details using model
    const productData = await rfqModel.getRfqProductDetailsForArc(rfq_product_id, t);

    if (!productData) {
      throw new Error('RFQ product not found');
    }

    // Get finalized vendor using model
    const finalization = await rfqModel.getFinalizedVendorForProduct(
      productData.rfq_id,
      productData.product_variant_id,
      productData.variant,
      t
    );

    if (!finalization) {
      throw new Error('No finalized vendor found for this product');
    }

    // Get vendor details
    const vendorData = await userModel.user_profile_detail(finalization.vendor_id);
    if (!vendorData || vendorData.length === 0) {
      throw new Error('Vendor details not found');
    }
    const vendor = vendorData[0];

    // Get buyer company details
    const rfqData = await rfqModel.getRfqById(productData.rfq_id, null, null, false);
    const rfq = rfqData && rfqData.length > 0 ? rfqData[0] : null;

    let company = null;
    if (rfq && rfq.created_by) {
      const companyData = await userModel.getCompanyDetail(rfq.created_by);
      if (companyData && companyData.length > 0) {
        company = companyData[0];
      }
    }

    // Get quote details using model
    const quoteData = await rfqModel.getQuoteItemDetails(finalization.quote_id, t);

    const headerContent = `<h2>Hello ${vendor.organization_name || vendor.name || "Vendor"},</h2>`;

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          We're pleased to inform you that your quote has been <strong>awarded</strong> through the ARC (Award Recommendation Committee) approval process.
          <br>
          Please refer to the attachment in this email for the formal ARC Award Document.
        </p>

        <h4>Award Details</h4>
        <ul>
          <li><strong>Tender Number:</strong> ${productData.rfq_no}</li>
          <li><strong>Product Name:</strong> ${productData.product_name}</li>
          ${quoteData ? `<li><strong>Total Value:</strong> ₹${quoteData.total_price || 0}</li>` : ''}
          <li><strong>Award Date:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</li>
        </ul>

        ${company ? `
          <h4>Buyer Info</h4>
          <p><strong>Company Name: </strong> ${company.company_name || productData.company_name}</p>
        ` : ''}

        <p style="margin-top:20px;">
          Please ensure your team is aligned and prepared to fulfill the order as per the specified terms and conditions in the award document.
        </p>

        <a href='${document_url}'>Click here to view ARC Award Document</a>

        <p style="text-align:center; margin-top: 30px;">
          Thank you for your continued partnership.<br/>
          <strong>— Team Workwise</strong>
        </p>
      </div>
    `;

    // Generate final email layout
    const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

    // Get vendor SPOC list
    await vendorModel.getSpocDetails(finalization.vendor_id);

    const mailRecipients = {
      from: company ? `${company.company_name} <hello@letsworkwise.com>` : 'Workwise <hello@letsworkwise.com>',
      to: vendor.email,
      subject: `ARC Award Confirmed — Tender #${productData.rfq_no}`,
      html: dynamicHTML,
    };

    await sendMail(mailRecipients);
  } catch (error) {
    throw error;
  }
};

