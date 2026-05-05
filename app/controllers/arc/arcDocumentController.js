import db from '../../config/dbConn.js';
import fs from 'fs';
import path from 'path';
import Handlebars from 'handlebars';
import puppeteer from 'puppeteer';
import config from '../../config/app.config.js';
import { sendMail, logError } from '../../helper/common.js';
import { getLifecycleHistory } from '../../models/generalModel.js';
import { generateEmailTemplate } from '../../helper/notificationEmailLayout.js';
import userModel from '../../models/userModel.js';
import vendorModel from '../../models/vendorModel.js';
import rfqModel from '../../models/rfqModel.js';

/**
 * Build the Handlebars template payload for the consolidated per-vendor
 * ARC award document. Pure data — no Puppeteer, no I/O beyond the DB
 * reads — so the data shape can be tested without rendering a PDF.
 *
 * Contract:
 *   - `products` lists ONLY the envelope's APPROVED items, never the
 *     rejected ones (rejected lines must not appear on a signed contract).
 *   - Each product carries name/category/unit/unit_price. Quantity is
 *     INTENTIONALLY NOT included (per product team — qty is a per-call-off
 *     concern, not a master-contract concern).
 *   - `hotels` is the array of all hotels covered by the envelope. Single
 *     ARC has length 1; Group ARC has length ≥2 and may span multiple
 *     hospitality_company_ids.
 *   - `period_from` / `period_to` are formatted strings; the boolean
 *     `is_group_arc` drives the parties section in the template.
 *
 * Throws when the envelope is missing, not a tender, or has no approved
 * items.
 */
export const buildArcTemplateData = async (arc_id, txContext = null) => {
  const t = txContext || db;

  if (!arc_id) throw new Error('arc_id is required');

  // 1. Envelope + parent tender header.
  const envelope = await t.oneOrNone(
    `SELECT a.*, r.rfq_no, r.title AS rfq_title, r.bid_end_date,
            r.created_by AS rfq_created_by, r.is_tender, r.tender_scope
       FROM tbl_arc a
       JOIN tbl_rfq r ON r.id = a.rfq_id
      WHERE a.id = $1`,
    [arc_id]
  );
  if (!envelope) throw new Error(`ARC envelope ${arc_id} not found`);
  if (envelope.is_tender !== 1) throw new Error('ARC document generation is only valid for tenders');

  // 2. Approved items only — rejected cells must NOT appear on the signed contract.
  //    The product name lives on tbl_product.name (the variant table only
  //    carries variant_name/value qualifiers). Schema-correct join chain:
  //    arc_item → product_variant → product.
  const items = await t.any(
    `SELECT ai.*,
            COALESCE(p.name, pv.variant_name, 'Item') AS product_name,
            pv.variant_name,
            pv.variant_value,
            pc.category_name AS product_category_name,
            ps_unit.value AS unit_value
       FROM tbl_arc_item ai
       LEFT JOIN tbl_product_variants pv ON pv.id = ai.product_variant_id
       LEFT JOIN tbl_product p ON p.id = pv.product_id
       LEFT JOIN LATERAL (
         SELECT category_name FROM tbl_product_categories
          WHERE product_id = pv.product_id LIMIT 1
       ) pc ON true
       LEFT JOIN LATERAL (
         SELECT value FROM tbl_rfq_products_specs
          WHERE rfq_id = $2 AND product_variant_id = ai.product_variant_id
            AND title = 'Unit' LIMIT 1
       ) ps_unit ON true
      WHERE ai.arc_id = $1 AND ai.status = 'APPROVED'
      ORDER BY ai.id`,
    [arc_id, envelope.rfq_id]
  );
  if (items.length === 0) throw new Error('No approved ARC items to include in the document');

  // 3. Vendor details (single — envelope is per-vendor).
  const vendorRows = await userModel.user_profile_detail(envelope.vendor_id);
  if (!vendorRows || vendorRows.length === 0) {
    throw new Error(`Vendor ${envelope.vendor_id} details not found`);
  }
  const vendor = vendorRows[0];

  // 4. Buyer / service-provider header.
  let buyerCompany = null;
  if (envelope.rfq_created_by) {
    const companyData = await userModel.getCompanyDetail(envelope.rfq_created_by);
    if (companyData && companyData.length > 0) buyerCompany = companyData[0];
  }

  // 5. Hotels covered by the envelope. Single ARC has 1 row; Group ARC
  //    has ≥2 (and may span hospitality companies — by design).
  // Schema-correct columns on tbl_hospitality_company_hotels: full_address,
  // city, state. There is no `address` column.
  const hotels = await t.any(
    `SELECT h.id, h.name, h.full_address, h.city, h.state,
            hc.name AS company_name
       FROM tbl_arc_hotels ah
       JOIN tbl_hospitality_company_hotels h ON h.id = ah.hotel_id
       LEFT JOIN tbl_hospitality_companies hc ON hc.id = h.hospitality_company_id
      WHERE ah.arc_id = $1
      ORDER BY h.name`,
    [arc_id]
  );

  const lifecycleHistory = await getLifecycleHistory('TENDER', envelope.rfq_id, t);

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'long', year: 'numeric',
  }) : '';

  return {
    effective_date: formatDate(new Date()),
    period_from: formatDate(envelope.period_from),
    period_to: formatDate(envelope.period_to),
    tender_scope: envelope.tender_scope,
    is_group_arc: envelope.tender_scope === 'GROUP',
    service_provider: {
      name: 'Phileein Hospitality Pvt. Ltd.',
      address: 'Address to be filled',
    },
    hotels: hotels.map((h) => ({
      name: h.name,
      address: h.full_address
        || [h.city, h.state].filter(Boolean).join(', ')
        || 'Address to be filled',
      company_name: h.company_name || '',
    })),
    hotel: hotels[0] ? {
      name: hotels[0].name,
      address: hotels[0].full_address
        || [hotels[0].city, hotels[0].state].filter(Boolean).join(', ')
        || 'Address to be filled',
    } : null,
    vendor: {
      name: vendor.organization_name || vendor.company_name || vendor.name,
      address: vendor.address || 'Address to be filled',
      email: vendor.email,
      phone: vendor.mobile || vendor.phone,
      gstin: vendor.gstin || 'GSTIN to be filled',
    },
    buyer_company: buyerCompany ? { name: buyerCompany.company_name } : null,
    products: items.map((item) => ({
      name: item.product_name || 'Item',
      category: item.product_category_name || '',
      unit: item.unit_value || 'NOS',
      unit_price: item.unit_price || 0,
      // Quantity intentionally NOT included — qty is a per-call-off
      // concern (release order), not a master-contract concern.
    })),
    rfq: {
      rfq_no: envelope.rfq_no,
      bid_end_date: envelope.bid_end_date ? formatDate(envelope.bid_end_date) : '',
      title: envelope.rfq_title || '',
    },
    terms_and_conditions: 'As per RFQ terms and conditions',
    lifecycle_history: lifecycleHistory.map((event) => ({
      stage: event.stage,
      action: event.action,
      performed_by: event.performed_by_name || 'System',
      performed_at: new Date(event.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      remarks: event.remarks || '-',
    })),
    has_lifecycle_history: lifecycleHistory.length > 0,
    // Internal — used by the renderer below to derive filenames; not
    // referenced by the template itself.
    _envelope: { rfq_no: envelope.rfq_no, vendor_id: envelope.vendor_id },
  };
};

/**
 * Generate the consolidated per-vendor ARC award document.
 *
 * One PDF covers EVERY product the vendor won under the tender, with
 * period dates and intentionally NO quantity (per product team —
 * quantity is a per-call-off concern, not a master-contract concern).
 *
 * @param {number} arc_id - The tbl_arc envelope ID
 * @param {Object} txContext - Transaction context (optional)
 * @returns {Promise<{ok:boolean, file?:string, absolutePath?:string, error?:string}>}
 */
export const generateAwardDocument = async (arc_id, txContext = null) => {
  try {
    const templateData = await buildArcTemplateData(arc_id, txContext);

    const templatePath = path.join(process.cwd(), 'app', 'helper', 'arcAwardTemplate.hbs');
    if (!fs.existsSync(templatePath)) {
      throw new Error(`ARC template not found at ${templatePath}`);
    }
    const templateSource = fs.readFileSync(templatePath, 'utf8');
    const template = Handlebars.compile(templateSource);
    const html = template(templateData);

    const storageDir = path.join(process.cwd(), 'app', 'storage', 'arc-documents');
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
    const fileName = `arc-${templateData._envelope.rfq_no}-vendor-${templateData._envelope.vendor_id}-${Date.now()}.pdf`;
    const fullPath = path.join(storageDir, fileName);

    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      headless: true,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: fullPath, format: 'A4', printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
    });
    await browser.close();

    return {
      ok: true,
      message: 'ARC document PDF created',
      file: `/app/storage/arc-documents/${fileName}`,
      absolutePath: fullPath,
    };
  } catch (error) {
    logError('generateAwardDocument failed', error);
    return { ok: false, error: error.message || 'Failed to generate ARC document' };
  }
};

/**
 * Email the consolidated ARC document to the vendor. ONE email per
 * envelope, listing all products the vendor won under this tender.
 */
export const sendAwardDocumentToVendor = async (arc_id, document_url, txContext = null) => {
  const t = txContext || db;

  try {
    const envelope = await t.oneOrNone(
      `SELECT a.*, r.rfq_no, r.created_by AS rfq_created_by, r.tender_scope
       FROM tbl_arc a
       JOIN tbl_rfq r ON r.id = a.rfq_id
       WHERE a.id = $1`,
      [arc_id]
    );
    if (!envelope) throw new Error(`ARC envelope ${arc_id} not found`);

    const vendorRows = await userModel.user_profile_detail(envelope.vendor_id);
    if (!vendorRows || vendorRows.length === 0) {
      throw new Error('Vendor details not found');
    }
    const vendor = vendorRows[0];

    let company = null;
    if (envelope.rfq_created_by) {
      const companyData = await userModel.getCompanyDetail(envelope.rfq_created_by);
      if (companyData && companyData.length > 0) company = companyData[0];
    }

    // Approved items list — used to render product names in the email.
    const items = await t.any(
      `SELECT ai.unit_price, pv.name AS product_name
       FROM tbl_arc_item ai
       LEFT JOIN tbl_product_variants pv ON pv.id = ai.product_variant_id
       WHERE ai.arc_id = $1 AND ai.status = 'APPROVED'
       ORDER BY ai.id`,
      [arc_id]
    );

    const productList = items.length > 0
      ? `<ul>${items.map((i) => `<li><strong>${i.product_name || 'Item'}</strong> — ₹${Number(i.unit_price || 0).toFixed(2)}/unit</li>`).join('')}</ul>`
      : '';

    const fmt = (d) => d ? new Date(d).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'long', year: 'numeric',
    }) : '';

    const headerContent = `<h2>Hello ${vendor.organization_name || vendor.name || 'Vendor'},</h2>`;

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          We're pleased to inform you that your quote has been <strong>awarded</strong> through the ARC (Annual Rate Contract) approval process.
          <br>
          Please refer to the attachment in this email for the formal ARC Award Document covering all items below.
        </p>

        <h4>Award Details</h4>
        <ul>
          <li><strong>Tender Number:</strong> ${envelope.rfq_no}</li>
          <li><strong>ARC Period:</strong> ${fmt(envelope.period_from)} → ${fmt(envelope.period_to)}</li>
          <li><strong>Scope:</strong> ${envelope.tender_scope === 'GROUP' ? 'Group ARC (multiple hotels)' : 'Single ARC'}</li>
          <li><strong>Award Date:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</li>
        </ul>

        <h4>Awarded Items</h4>
        ${productList}

        ${company ? `
          <h4>Buyer Info</h4>
          <p><strong>Company Name:</strong> ${company.company_name}</p>
        ` : ''}

        <p style="margin-top:20px;">
          Please ensure your team is aligned and prepared to fulfil release orders against this contract throughout the validity period.
        </p>

        <a href='${document_url}'>Click here to view ARC Award Document</a>

        <p style="text-align:center; margin-top: 30px;">
          Thank you for your continued partnership.<br/>
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>
    `;

    const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

    // Vendor SPOCs (read but currently not addressed; kept for parity).
    try {
      await vendorModel.getSpocDetails(envelope.vendor_id);
    } catch (_) {
      /* non-fatal */
    }

    const mailRecipients = {
      from: company ? `${company.company_name} ${config.masterEmail}` : config.webmasterMail,
      to: vendor.email,
      subject: `ARC Award Confirmed — Tender #${envelope.rfq_no}`,
      html: dynamicHTML,
    };

    await sendMail(mailRecipients);
  } catch (error) {
    throw error;
  }
};
