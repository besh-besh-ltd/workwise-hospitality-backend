import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import Moment from 'moment';
import Razorpay from 'razorpay';
import Config from '../../config/app.config.js';
import { logError, sendMail, convertSixDigit } from '../../helper/common.js';
import { generateEmailTemplate } from '../../helper/notificationEmailLayout.js';
import { generateTaxInvoicePdf, generatePaymentReceivedPdf } from '../../helper/paymentDocuments.js';
import { sendVendorBulkRfqJoinNotification, sendVendorAutoAddedToRfqNotification } from '../../helper/sendEmailFunctions/approvalEmails.js';
import generalModel from '../../models/generalModel.js';
import hospitalityModel from '../../models/hospitalityModel.js';
import productModel from '../../models/productModel.js';
import projectModel from '../../models/projectModel.js';
import rfqModel from '../../models/rfqModel.js';
import userModel from '../../models/userModel.js';
import db, { pgp } from '../../config/dbConn.js';

const formatErrorResponse = (res, error) => {
  const statusCode = error.statusCode || 400;
  const message = error.message || Config.errorText.value;
  return res.status(statusCode).json({
    status: 3,
    message
  });
};

// ============================================================
// WH-74: Auto-map product variants when vendor subscribes to categories.
// Mirrors the admin flow in vendorController.js:1605-1636.
// The underlying bulkInsertVariantVendorMappings uses a LEFT JOIN to skip
// existing mappings, so calling this on renewal is safe (no-op for existing
// categories, maps only genuinely new ones).
// Always called inside try/catch — failure must not break the payment flow.
// ============================================================
const _autoMapProductsForCategories = async (vendorId, categoryIds) => {
  if (!categoryIds || !categoryIds.length) return;

  const variants = await rfqModel.getProductsByCategories(
    categoryIds.map(id => ({ id }))
  );
  if (!variants || !variants.length) return;

  const mappings = variants.map(v => ({
    variant_id: v.variant_id,
    vendor_id: vendorId,
    approved_by: [],
    make_list: []
  }));
  await productModel.bulkInsertVariantVendorMappings(mappings, vendorId);

  const variantIds = [...new Set(
    variants.map(v => parseInt(v.variant_id)).filter(Boolean)
  )];
  if (variantIds.length) {
    await productModel.autoApproveVariantMappings(vendorId, variantIds);
  }
};

// ============================================================
// WH-74: Remove product variant mappings when vendor unsubscribes from
// categories. Finds all variants under the given category IDs and deletes
// the vendor's mappings for them.
// ============================================================
const _unmapProductsForCategories = async (vendorId, categoryIds) => {
  if (!categoryIds || !categoryIds.length) return;

  const variants = await rfqModel.getProductsByCategories(
    categoryIds.map(id => ({ id }))
  );
  if (!variants || !variants.length) return;

  const variantIds = [...new Set(
    variants.map(v => parseInt(v.variant_id)).filter(Boolean)
  )];
  if (variantIds.length) {
    await productModel.removeVariantMappingsForVendor(vendorId, variantIds);
  }
};

// ============================================================
// WH-74: Shared subscription confirmation email builder
// Used by verifyPayment (registration / renewal / paid modification)
// AND by the modifySubscription free path (modification_free).
// Always wrapped in try/catch by callers — never throws.
// ============================================================
const _sendSubscriptionConfirmationEmail = async ({
  kind, // 'registration' | 'renewal' | 'modification' | 'modification_free'
  userId,
  totalAmount = 0,
  razorpayOrderId = null,
  razorpayPaymentId = null,
  expiryDateFormatted,
  addedCategories = [],
  addedSubcategories = [],
  addedHotels = [],
  removedCategories = [],
  removedSubcategories = [],
  removedHotels = []
}) => {
  const userDetails = await userModel.userinfo(userId);
  const user = Array.isArray(userDetails) ? userDetails[0] : userDetails;
  if (!user || !user.email) return;

  const companyDetail = await userModel.getCompanyDetail(userId);
  const company = companyDetail && companyDetail.length > 0 ? companyDetail[0] : {};
  const recipientName = company?.organization_name || company?.name || user?.name;

  const isPaid = kind !== 'modification_free';
  const subjectMap = {
    registration: 'Phileein Hospitality - Vendor Registration Confirmation',
    renewal: 'Phileein Hospitality - Subscription Renewal Confirmation',
    modification: 'Phileein Hospitality - Subscription Modification Confirmation',
    modification_free: 'Phileein Hospitality - Subscription Updated'
  };
  const introMap = {
    registration: 'Congratulations! Your Vendor registration has been successfully completed and your payment has been processed.',
    renewal: 'Your subscription has been successfully renewed and your payment has been processed.',
    modification: 'Your subscription changes have been processed successfully and the additional payment has been received.',
    modification_free: 'Your subscription has been updated. No payment was required for this change.'
  };
  const sectionTitleMap = {
    registration: 'Registration Details',
    renewal: 'Renewal Details',
    modification: 'Modification Details',
    modification_free: 'Update Summary'
  };
  const description = {
    registration: 'Hospitality Vendor Registration',
    renewal: 'Hospitality Vendor Subscription Renewal',
    modification: 'Hospitality Vendor Subscription Modification',
    modification_free: 'Hospitality Vendor Subscription Update'
  }[kind];

  // Generate PDFs only when money actually moved.
  let invoiceResult = null;
  let paymentReceivedPdf = null;
  if (isPaid) {
    try {
      invoiceResult = await generateTaxInvoicePdf({
        recipientName,
        amount: totalAmount,
        paymentId: razorpayPaymentId,
        orderId: razorpayOrderId,
        description
      });
    } catch (invoiceErr) {
      logError('Invoice generation failed:', invoiceErr);
    }
    try {
      paymentReceivedPdf = await generatePaymentReceivedPdf({
        recipientName,
        amount: totalAmount,
        paymentId: razorpayPaymentId,
        orderId: razorpayOrderId,
        description
      });
    } catch (docErr) {
      logError('Payment received doc generation failed:', docErr);
    }
  }

  const renderList = (label, names, marker = '•') => {
    if (!names?.length) return '';
    return `
      <div style="margin: 16px 0;">
        <h3 style="color: #158993; margin: 0 0 8px; font-size: 15px;">${label}</h3>
        <ul style="list-style-type: none; padding-left: 0; margin: 0;">
          ${names.map(n => `<li style="padding: 4px 0;">${marker} ${n}</li>`).join('')}
        </ul>
      </div>
    `;
  };

  const isModification = kind === 'modification' || kind === 'modification_free';

  const detailsBlock = isPaid
    ? `
      <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3 style="color: #158993; margin-top: 0;">${sectionTitleMap[kind]}</h3>
        <p style="margin: 10px 0;"><strong>Company Name:</strong> ${company.organization_name || company.name || 'N/A'}</p>
        <p style="margin: 10px 0;"><strong>Email:</strong> ${user.email}</p>
        <p style="margin: 10px 0;"><strong>Payment Amount:</strong> ₹${Number(totalAmount).toLocaleString('en-IN')}</p>
        <p style="margin: 10px 0;"><strong>Payment ID:</strong> ${razorpayPaymentId || '—'}</p>
        <p style="margin: 10px 0;"><strong>Order ID:</strong> ${razorpayOrderId || '—'}</p>
      </div>
    `
    : `
      <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3 style="color: #158993; margin-top: 0;">${sectionTitleMap[kind]}</h3>
        <p style="margin: 10px 0;"><strong>Company Name:</strong> ${company.organization_name || company.name || 'N/A'}</p>
        <p style="margin: 10px 0;"><strong>Email:</strong> ${user.email}</p>
        <p style="margin: 10px 0;">No payment was required for this change.</p>
      </div>
    `;

  // For modifications we render added vs removed groups separately so the
  // vendor sees exactly what changed; for registration/renewal we render the
  // full active set as a single list.
  const itemsBlock = isModification
    ? `
        ${renderList('Added Categories', addedCategories, '+')}
        ${renderList('Added Sub-categories', addedSubcategories, '+')}
        ${renderList('Added Business Units', addedHotels, '+')}
        ${renderList('Removed Categories', removedCategories, '−')}
        ${renderList('Removed Sub-categories', removedSubcategories, '−')}
        ${renderList('Removed Business Units', removedHotels, '−')}
      `
    : `
        ${renderList('Selected Categories', addedCategories)}
        ${renderList('Selected Sub-categories', addedSubcategories)}
        ${renderList('Selected Hotels', addedHotels)}
      `;

  const closingMap = {
    registration: 'Your account has been approved and you can now start using the Phileein Hospitality platform.',
    renewal: 'Your subscription is now active. You can continue using the Phileein Hospitality platform.',
    modification: 'Your updated subscription is now active. The new items are valid through the same end date as your current subscription.',
    modification_free: 'Your subscription has been updated. The change is reflected immediately.'
  };

  const emailHeader = `<h2>Dear ${user.name},</h2>`;
  const emailContent = `
    <p style="font-size: 16px; line-height: 1.6; color: #333;">
      ${introMap[kind]}
    </p>

    ${detailsBlock}
    ${itemsBlock}

    ${expiryDateFormatted ? `
    <div style="background-color: #e8f5e9; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #4caf50;">
      <p style="margin: 0; font-weight: 600; color: #2e7d32;">
        <strong>Subscription Expiry Date:</strong> ${expiryDateFormatted}
      </p>
    </div>
    ` : ''}

    <p style="font-size: 16px; line-height: 1.6; color: #333; margin-top: 30px;">
      ${closingMap[kind]}
    </p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/subscription"
         style="background-color: #158993; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: 600;">
        Manage Subscription
      </a>
    </div>
  `;

  const dynamicHTML = generateEmailTemplate(emailHeader, emailContent);

  const emailOptions = {
    from: Config.webmasterMail,
    to: user.email,
    subject: subjectMap[kind],
    html: dynamicHTML
  };

  const attachments = [];
  if (invoiceResult && invoiceResult.filePath && fs.existsSync(invoiceResult.filePath)) {
    attachments.push({
      filename: invoiceResult.fileName,
      path: invoiceResult.filePath,
      contentType: 'application/pdf'
    });
  }
  if (paymentReceivedPdf && paymentReceivedPdf.filePath && fs.existsSync(paymentReceivedPdf.filePath)) {
    attachments.push({
      filename: paymentReceivedPdf.fileName,
      path: paymentReceivedPdf.filePath,
      contentType: 'application/pdf'
    });
  }
  if (attachments.length) emailOptions.attachments = attachments;

  await sendMail(emailOptions);
};

const HospitalityController = {
  listCompanies: async (req, res) => {
    try {
      const company = req.companyDetails;
      const includeHotels = req.query.include === 'hotels';

      const companies = includeHotels
        ? await hospitalityModel.getCompaniesWithHotelsByBuyer(company.id)
        : await hospitalityModel.getCompaniesByBuyer(company.id);

      return res.status(200).json({
        status: 1,
        data: companies
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  createCompany: async (req, res) => {
    try {
      const company = req.companyDetails;
      const payload = {
        buyer_company_id: company.id,
        name: req.body.name?.trim(),
        region: req.body.region?.trim() || null,
        contact_email: req.body.contact_email?.trim() || null,
        registered_office_address: req.body.registered_office_address?.trim() || null,
        corporate_office_address: req.body.corporate_office_address?.trim() || null,
        gst: req.body.gst?.trim() || null,
        pan: req.body.pan?.trim() || null,
        bank_account_number: req.body.bank_account_number?.trim() || null,
        bank_name: req.body.bank_name?.trim() || null,
        ifsc_code: req.body.ifsc_code?.trim() || null,
        account_holder_name: req.body.account_holder_name?.trim() || null,
        msme: req.body.msme?.trim() || null,
        created_by: req.user.id
      };

      const created = await hospitalityModel.createCompany(payload);

      // Handle document uploads if files are present
      if (req.files) {
        const documentPromises = [];
        
        // GST document
        if (req.files.gst && req.files.gst[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              created.id,
              'gst',
              req.files.gst[0].location,
              payload.gst
            )
          );
        }
        
        // PAN document
        if (req.files.pan && req.files.pan[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              created.id,
              'pan',
              req.files.pan[0].location,
              payload.pan
            )
          );
        }
        
        // Cancelled cheque
        if (req.files.cancelled_cheque && req.files.cancelled_cheque[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              created.id,
              'cancelled_cheque',
              req.files.cancelled_cheque[0].location,
              null
            )
          );
        }
        
        // MSME document
        if (payload.msme && req.files.msme && req.files.msme[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              created.id,
              'msme',
              req.files.msme[0].location,
              payload.msme
            )
          );
        }
        
        await Promise.all(documentPromises);
      }

      return res.status(200).json({
        status: 1,
        data: created,
        message: 'Hospitality company created successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  updateCompany: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const updated = await hospitalityModel.updateCompany(
        hospitalityCompanyId,
        {
          name: req.body.name?.trim(),
          region: req.body.region?.trim() || null,
          contact_email: req.body.contact_email?.trim() || null,
          registered_office_address: req.body.registered_office_address?.trim() || null,
          corporate_office_address: req.body.corporate_office_address?.trim() || null,
          gst: req.body.gst?.trim() || null,
          pan: req.body.pan?.trim() || null,
          bank_account_number: req.body.bank_account_number?.trim() || null,
          bank_name: req.body.bank_name?.trim() || null,
          ifsc_code: req.body.ifsc_code?.trim() || null,
          account_holder_name: req.body.account_holder_name?.trim() || null,
          msme: req.body.msme?.trim() || null,
          updated_by: req.user.id
        },
        company.id
      );

      // Handle document uploads if files are present
      if (req.files) {
        const documentPromises = [];
        
        if (req.files.gst && req.files.gst[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              hospitalityCompanyId,
              'gst',
              req.files.gst[0].location,
              req.body.gst?.trim() || null
            )
          );
        }
        
        if (req.files.pan && req.files.pan[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              hospitalityCompanyId,
              'pan',
              req.files.pan[0].location,
              req.body.pan?.trim() || null
            )
          );
        }
        
        if (req.files.cancelled_cheque && req.files.cancelled_cheque[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              hospitalityCompanyId,
              'cancelled_cheque',
              req.files.cancelled_cheque[0].location,
              null
            )
          );
        }
        
        if (req.body.msme && req.files.msme && req.files.msme[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              hospitalityCompanyId,
              'msme',
              req.files.msme[0].location,
              req.body.msme?.trim() || null
            )
          );
        }
        
        await Promise.all(documentPromises);
      }

      return res.status(200).json({
        status: 1,
        data: updated,
        message: 'Hospitality company updated successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  listCompanyHotels: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const hotels = await hospitalityModel.getHotelsByCompany(
        hospitalityCompanyId
      );

      return res.status(200).json({
        status: 1,
        data: hotels
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  createHotel: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const payload = {
        hospitality_company_id: hospitalityCompanyId,
        name: req.body.name?.trim(),
        city: req.body.city?.trim() || null,
        keys: req.body.keys ? parseInt(req.body.keys, 10) : 0,
        // Status is now driven entirely by payment lifecycle
        status: 'Pending Onboarding',
        full_address: req.body.full_address?.trim() || null,
        state: req.body.state?.trim() || null,
        gst: req.body.gst?.trim() || null,
        pan: req.body.pan?.trim() || null,
        bank_account_number: req.body.bank_account_number?.trim() || null,
        bank_name: req.body.bank_name?.trim() || null,
        ifsc_code: req.body.ifsc_code?.trim() || null,
        account_holder_name: req.body.account_holder_name?.trim() || null,
        msme: req.body.msme?.trim() || null,
        delivery_address: req.body.delivery_address?.trim() || null,
        created_by: req.user.id,
        fee_amount: req.body.fee_amount
          ? parseInt(req.body.fee_amount, 10)
          : 500,
        email: req.body.email?.trim() || null,
        payment_status: 'onboarding'
      };

      const created = await hospitalityModel.createHotel(payload);

      // Handle document uploads if files are present
      if (req.files) {
        const documentPromises = [];
        
        if (req.files.gst && req.files.gst[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              created.id,
              'gst',
              req.files.gst[0].location,
              payload.gst
            )
          );
        }
        
        if (req.files.pan && req.files.pan[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              created.id,
              'pan',
              req.files.pan[0].location,
              payload.pan
            )
          );
        }
        
        if (req.files.cancelled_cheque && req.files.cancelled_cheque[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              created.id,
              'cancelled_cheque',
              req.files.cancelled_cheque[0].location,
              null
            )
          );
        }
        
        if (payload.msme && req.files.msme && req.files.msme[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              created.id,
              'msme',
              req.files.msme[0].location,
              payload.msme
            )
          );
        }
        
        await Promise.all(documentPromises);
      }

      return res.status(200).json({
        status: 1,
        data: created,
        message: 'Hotel added successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  createHO: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const created = await hospitalityModel.createHOFromCompany(
        hospitalityCompanyId,
        req.user.id
      );

      // Copy company documents to the new HO hotel
      const companyDocs = await hospitalityModel.getCompanyDocuments(hospitalityCompanyId);
      if (companyDocs && companyDocs.length > 0) {
        const docPromises = companyDocs.map(doc =>
          hospitalityModel.saveHotelDocument(
            created.id,
            doc.document_type,
            doc.document_url,
            doc.document_number
          )
        );
        await Promise.all(docPromises);
      }

      return res.status(200).json({
        status: 1,
        data: created,
        message: 'Head Office business unit created successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  updateHotel: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const hotelId = parseInt(req.params.hotel_id, 10);

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const hotelRecord = await hospitalityModel.getHotelById(hotelId);
      if (!hotelRecord || hotelRecord.hospitality_company_id !== record.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hotel not found in selected company'
        });
      }

      const payload = {
        name: req.body.name?.trim(),
        city: req.body.city?.trim() || null,
        keys: req.body.keys ? parseInt(req.body.keys, 10) : 0,
        // Allow manual override of status on edit; fall back to existing value
        status: req.body.status?.trim() || hotelRecord.status,
        full_address: req.body.full_address?.trim() || null,
        state: req.body.state?.trim() || null,
        gst: req.body.gst?.trim() || null,
        pan: req.body.pan?.trim() || null,
        bank_account_number: req.body.bank_account_number?.trim() || null,
        bank_name: req.body.bank_name?.trim() || null,
        ifsc_code: req.body.ifsc_code?.trim() || null,
        account_holder_name: req.body.account_holder_name?.trim() || null,
        msme: req.body.msme?.trim() || null,
        delivery_address: req.body.delivery_address?.trim() || null,
        updated_by: req.user.id,
        email: req.body.email?.trim() || null,
        fee_amount: req.body.fee_amount !== undefined && req.body.fee_amount !== null && req.body.fee_amount !== ''
          ? parseInt(req.body.fee_amount, 10)
          : hotelRecord.fee_amount
      };

      const updated = await hospitalityModel.updateHotel(hotelId, payload, record.id);

      // Handle document uploads if files are present
      if (req.files) {
        const documentPromises = [];
        
        if (req.files.gst && req.files.gst[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              hotelId,
              'gst',
              req.files.gst[0].location,
              payload.gst
            )
          );
        }
        
        if (req.files.pan && req.files.pan[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              hotelId,
              'pan',
              req.files.pan[0].location,
              payload.pan
            )
          );
        }
        
        if (req.files.cancelled_cheque && req.files.cancelled_cheque[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              hotelId,
              'cancelled_cheque',
              req.files.cancelled_cheque[0].location,
              null
            )
          );
        }
        
        if (payload.msme && req.files.msme && req.files.msme[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              hotelId,
              'msme',
              req.files.msme[0].location,
              payload.msme
            )
          );
        }
        
        await Promise.all(documentPromises);
      }

      return res.status(200).json({
        status: 1,
        data: updated,
        message: 'Business unit updated successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  mapUsers: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const mappingType = parseInt(req.body.mapping_type, 10);
      const userIds = req.body.user_ids || [];
      const autoMapProjects = req.body.auto_map_projects === true;
      let hotelId =
        req.body.hotel_id !== undefined && req.body.hotel_id !== null
          ? parseInt(req.body.hotel_id, 10)
          : null;

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      if (mappingType === 1) {
        if (!hotelId) {
          return res.status(400).json({
            status: 2,
            message: 'Hotel is required for hotel level mapping'
          });
        }
        const hotelRecord = await hospitalityModel.getHotelById(hotelId);
        if (!hotelRecord || hotelRecord.hospitality_company_id !== record.id) {
          return res.status(404).json({
            status: 2,
            message: 'Hotel not found in selected company'
          });
        }
      } else {
        hotelId = null;
      }

      const allowedUsers = await hospitalityModel.filterUsersByCompany(
        userIds,
        company.id
      );
      const sanitizedUserIds = allowedUsers.map((u) => parseInt(u.id, 10));

      if (!sanitizedUserIds.length) {
        return res.status(400).json({
          status: 2,
          message: 'No valid users found for this company'
        });
      }

      const rows = sanitizedUserIds.map((userId) => ({
        user_id: userId,
        hospitality_company_id: record.id,
        hospitality_hotel_id: hotelId,
        mapping_type: mappingType,
        auto_map_projects: autoMapProjects,
        created_by: req.user.id
      }));

      await hospitalityModel.insertUserMappings(rows);

      if (autoMapProjects) {
        const projectMappings =
          await hospitalityModel.getProjectMappingsForContext(
            record.id,
            mappingType,
            hotelId
          );
        if (projectMappings.length) {
          await Promise.all(
            projectMappings.flatMap((mapping) =>
              sanitizedUserIds.map(async (userId) => {
                const isMember = await projectModel.isTeamMember(
                  mapping.project_id,
                  userId
                );
                if (!isMember) {
                  return projectModel.addTeamMember({
                    project_id: mapping.project_id,
                    user_id: userId,
                    role: 2,
                    created_by: req.user.id
                  });
                }
              })
            )
          );
        }
      }

      return res.status(200).json({
        status: 1,
        message: 'Users mapped successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  mapProjects: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const mappingType = parseInt(req.body.mapping_type, 10);
      const projectIds = req.body.project_ids || [];
      let hotelId =
        req.body.hotel_id !== undefined && req.body.hotel_id !== null
          ? parseInt(req.body.hotel_id, 10)
          : null;

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      if (mappingType === 1) {
        if (!hotelId) {
          return res.status(400).json({
            status: 2,
            message: 'Hotel is required for hotel level mapping'
          });
        }
        const hotelRecord = await hospitalityModel.getHotelById(hotelId);
        if (!hotelRecord || hotelRecord.hospitality_company_id !== record.id) {
          return res.status(404).json({
            status: 2,
            message: 'Hotel not found in selected company'
          });
        }
      } else {
        hotelId = null;
      }

      const allowedProjects = await hospitalityModel.filterProjectsByCompany(
        projectIds,
        company.id
      );
      const sanitizedProjectIds = allowedProjects.map((p) => parseInt(p.id, 10));

      if (!sanitizedProjectIds.length) {
        return res.status(400).json({
          status: 2,
          message: 'No valid projects found for this company'
        });
      }

      const rows = sanitizedProjectIds.map((projectId) => ({
        project_id: projectId,
        hospitality_company_id: record.id,
        hospitality_hotel_id: hotelId,
        mapping_type: mappingType,
        created_by: req.user.id
      }));

      const inserted = await hospitalityModel.insertProjectMappings(rows);

      if (inserted.length) {
        const autoUsers = await hospitalityModel.getAutoMapUsersForContext(
          record.id,
          mappingType,
          hotelId
        );
        if (autoUsers.length) {
          await Promise.all(
            inserted.flatMap((mapping) =>
              autoUsers.map(async (user) => {
                const isMember = await projectModel.isTeamMember(
                  mapping.project_id,
                  user.user_id
                );
                if (!isMember) {
                  return projectModel.addTeamMember({
                    project_id: mapping.project_id,
                    user_id: user.user_id,
                    role: 2,
                    created_by: req.user.id
                  });
                }
              })
            )
          );
        }
      }

      return res.status(200).json({
        status: 1,
        message: 'Projects mapped successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  getMappedUserIds: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const mappingType = parseInt(req.query.mapping_type, 10);
      const hotelId = req.query.hotel_id ? parseInt(req.query.hotel_id, 10) : null;

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const mappedUsers = await hospitalityModel.getMappedUserIds(
        hospitalityCompanyId,
        mappingType,
        hotelId
      );

      return res.status(200).json({
        status: 1,
        data: mappedUsers.map(u => u.user_id)
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  getMappedProjectIds: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const mappingType = parseInt(req.query.mapping_type, 10);
      const hotelId = req.query.hotel_id ? parseInt(req.query.hotel_id, 10) : null;

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const mappedProjects = await hospitalityModel.getMappedProjectIds(
        hospitalityCompanyId,
        mappingType,
        hotelId
      );

      return res.status(200).json({
        status: 1,
        data: mappedProjects.map(p => p.project_id)
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  getProjectMappings: async (req, res) => {
    try {
      const projectId = parseInt(req.params.project_id, 10);
      const mappings = await hospitalityModel.getProjectMappings(projectId);

      return res.status(200).json({
        status: 1,
        data: mappings
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  deleteProjectMapping: async (req, res) => {
    try {
      const company = req.companyDetails;
      const projectId = parseInt(req.params.project_id, 10);
      const companyId = parseInt(req.body.company_id, 10);
      const mappingType = parseInt(req.body.mapping_type, 10);
      const hotelId = req.body.hotel_id ? parseInt(req.body.hotel_id, 10) : null;

      const record = await hospitalityModel.getCompanyById(companyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      await hospitalityModel.deleteProjectMappings(
        projectId,
        companyId,
        mappingType,
        hotelId
      );

      // Remove team members that were added via this hospitality context
      const contextUsers = await hospitalityModel.getMappedUserIds(
        companyId,
        mappingType,
        hotelId
      );
      if (contextUsers && contextUsers.length) {
        await Promise.all(
          contextUsers.map((row) =>
            projectModel.removeTeamMember(projectId, row.user_id)
          )
        );
      }

      return res.status(200).json({
        status: 1,
        message: 'Project mapping deleted successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  getUserMappingsById: async (req, res) => {
    try {
      const userId = parseInt(req.params.user_id, 10);
      if (!userId) {
        return res.status(400).json({ status: 0, message: 'user_id is required' });
      }
      const mappings = await hospitalityModel.getUserMappings(userId);
      return res.status(200).json({ status: 1, data: mappings });
    } catch (error) {
      console.error('Error fetching user mappings:', error);
      return res.status(500).json({ status: 3, message: 'Failed to fetch user mappings' });
    }
  },

  deleteUserMapping: async (req, res) => {
    try {
      const company = req.companyDetails;
      const userId = parseInt(req.params.user_id, 10);
      const companyId = parseInt(req.body.company_id, 10);
      const mappingType = parseInt(req.body.mapping_type, 10);
      const hotelId = req.body.hotel_id ? parseInt(req.body.hotel_id, 10) : null;

      const record = await hospitalityModel.getCompanyById(companyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      await hospitalityModel.deleteUserMappings(userId, companyId, mappingType, hotelId);

      return res.status(200).json({
        status: 1,
        message: 'User mapping deleted successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  listCompanyUserMappings: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const mappingTypeParam = req.query.mapping_type;
      let mappingType = null;
      if (mappingTypeParam !== undefined) {
        mappingType = parseInt(mappingTypeParam, 10);
        if (![0, 1].includes(mappingType)) {
          return res.status(400).json({
            status: 2,
            message: 'Invalid mapping_type value'
          });
        }
      }
      let hotelId = null;
      if (mappingType === 1) {
        const hotelParam = req.query.hotel_id;
        if (!hotelParam) {
          return res.status(400).json({
            status: 2,
            message: 'hotel_id is required for hotel level mappings'
          });
        }
        hotelId = parseInt(hotelParam, 10);
        const hotelRecord = await hospitalityModel.getHotelById(hotelId);
        if (!hotelRecord || hotelRecord.hospitality_company_id !== hospitalityCompanyId) {
          return res.status(404).json({
            status: 2,
            message: 'Hotel not found in selected company'
          });
        }
      }

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const includeAll = req.query.include_all === 'true' && mappingType === null;
      const mappings = await hospitalityModel.getUserMappingsForCompany(
        hospitalityCompanyId,
        mappingType,
        mappingType === 1 ? hotelId : null,
        includeAll
      );

      return res.status(200).json({
        status: 1,
        data: mappings
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  getMyContexts: async (req, res) => {
    try {
      const mappings = await hospitalityModel.getUserContexts(req.user.id);

      // Group flat mappings into companies with nested hotels
      const companyMap = {};

      for (const mapping of mappings) {
        const companyId = mapping.hospitality_company_id;

        if (!companyMap[companyId]) {
          companyMap[companyId] = {
            id: companyId,
            name: mapping.company_name,
            isCompanyLevel: false,
            hotels: []
          };
        }

        if (mapping.mapping_type === 0) {
          companyMap[companyId].isCompanyLevel = true;
        }

        if (mapping.mapping_type === 1 && mapping.hospitality_hotel_id) {
          companyMap[companyId].hotels.push({
            id: mapping.hospitality_hotel_id,
            name: mapping.hotel_name
          });
        }
      }

      // For company-level mappings, fetch ALL hotels in those companies
      for (const companyId of Object.keys(companyMap)) {
        if (companyMap[companyId].isCompanyLevel) {
          const allHotels = await hospitalityModel.getHotelsByCompany(
            parseInt(companyId, 10)
          );
          companyMap[companyId].hotels = allHotels.map((h) => ({
            id: h.id,
            name: h.name
          }));
        }
      }

      // Clean up internal flag before sending
      const grouped = Object.values(companyMap).map(({ isCompanyLevel, ...rest }) => rest);

      return res.status(200).json({
        status: 1,
        data: grouped
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  
  /**
   * @created : mukul jatav 
   * get all hotels currently mapped to the specified RFQ.
 */
  getRFQHotels: async (req, res) => {
    try {

      const rfq_id = req.params.rfq_id;

      //  check if rfg exist
      const rfqExist = await rfqModel.checkIfExists('tbl_rfq', `id = ${rfq_id}`);
      if( rfqExist.length === 0 ) {
        return res.status(404).json({
          status: 2,
          message: 'RFQ not found'
        });
      }

      //  fetch mapped hotels with names
      const mappedHotels = await db.any(
        `SELECT rhm.rfq_id, rhm.hotel_id,
                rhm.hotel_id AS hospitality_hotel_id,
                h.name AS hotel_name,
                h.city
         FROM tbl_rfq_hotel_mappings rhm
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = rhm.hotel_id
         WHERE rhm.rfq_id = $1
         ORDER BY h.name`,
        [rfq_id]
      );

      return res.status(200).json({
        status: 1,
        data: mappedHotels
      });

    } catch (error) {
      logError(error);

      //  throw error
       return res.status(500).json({
        message: "failed to fetch hotels",
        error: error
      });
    }
  },

  getHotelDocuments: async (req, res) => {
    try {
      const hotelId = parseInt(req.params.hotel_id, 10);

      if (!hotelId) {
        return res.status(400).json({
          status: 0,
          message: "Hotel ID is required"
        });
      }

      const documents = await hospitalityModel.getHotelDocuments(hotelId);

      return res.status(200).json({
        status: 1,
        data: documents
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // Send payment link email to the business unit email
  sendPaymentLink: async (req, res) => {
    try {
      const hotelId = parseInt(req.params.hotel_id, 10);
      const hotel = await hospitalityModel.getHotelPaymentDetails(hotelId);

      if (!hotel) {
        return res.status(404).json({ status: 0, message: 'Business unit not found' });
      }

      if (!hotel.email) {
        return res.status(400).json({ status: 0, message: 'No email configured for this business unit' });
      }

      if (!hotel.fee_amount || hotel.fee_amount <= 0) {
        return res.status(400).json({ status: 0, message: 'Fee amount not configured for this business unit' });
      }

      // Generate a payment link URL
      // Prefer configured FRONT_END_WEBSITE, fall back to FRONTEND_URL, then localhost
      const frontendUrl =
        process.env.FRONT_END_WEBSITE ||
        process.env.FRONTEND_URL ||
        'http://localhost:3000';
      const paymentLink = `${frontendUrl}/hotel-payment?hotel_id=${hotelId}`;

      // Send email using the standard WorkWise template
      const { sendMail } = await import('../../helper/common.js');
      const { generateEmailTemplate } = await import('../../helper/notificationEmailLayout.js');

      const headerContent = `<h2 style=\"margin: 0 0 8px; font-size: 22px; font-weight: 700; color: #111827;\">Welcome, ${hotel.name}!</h2>`;
      const containerContent = `
        <p style=\"font-size: 15px; color: #4b5563; margin: 0 0 16px;\">
          You have been added as a business unit under <strong>${hotel.company_name}</strong> on the Phileein Hospitality Procurement Platform.
          To activate your business unit, please complete the onboarding payment.
        </p>
        <div style=\"background: #f9fafb; border-radius: 12px; padding: 16px 20px; margin: 16px 0;\">
          <p style=\"margin: 0 0 6px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em;\">Payment Details</p>
          <p style=\"margin: 0; font-size: 26px; font-weight: 700; color: #158993;\">₹ ${hotel.fee_amount}</p>
        </div>
        <div style=\"text-align: center; margin: 24px 0 12px;\">
          <a href=\"${paymentLink}\"
             style=\"background-color: #158993; color: #ffffff; padding: 12px 32px; border-radius: 9999px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;\">
            Complete Payment
          </a>
        </div>
        <p style=\"font-size: 12px; color: #9ca3af; margin: 0; text-align: center;\">
          If the button doesn't work, copy and paste this link into your browser:<br/>
          <a href=\"${paymentLink}\" style=\"color: #158993; word-break: break-all;\">${paymentLink}</a>
        </p>
      `;

      const html = generateEmailTemplate(headerContent, containerContent, null);

      await sendMail({
        from: Config.webmasterMail,
        to: hotel.email,
        subject: `Phileein Hospitality Procurement Platform - Complete Payment for ${hotel.name}`,
        html
      });

      // Update payment status to onboarding (mail sent)
      await hospitalityModel.updateHotelPaymentStatus(hotelId, 'onboarding');

      return res.status(200).json({
        status: 1,
        message: 'Payment link sent successfully',
        data: { email: hotel.email }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // Send batch payment links (company-level or BU-level)
  sendBatchPaymentLinks: async (req, res) => {
    try {
      const { company_id, payment_mode, hotel_ids } = req.body;

      // Validate input
      if (!company_id) {
        return res.status(400).json({ status: 0, message: 'company_id is required' });
      }

      if (!payment_mode || !['bu', 'company'].includes(payment_mode)) {
        return res.status(400).json({ status: 0, message: 'payment_mode must be "bu" or "company"' });
      }

      if (!hotel_ids || !Array.isArray(hotel_ids) || hotel_ids.length === 0) {
        return res.status(400).json({ status: 0, message: 'hotel_ids array is required and must not be empty' });
      }

      // Fetch all selected hotels with company information
      const hotels = await hospitalityModel.getHotelsByIds(hotel_ids);

      if (!hotels || hotels.length === 0) {
        return res.status(404).json({ status: 0, message: 'No valid business units found' });
      }

      const { sendMail } = await import('../../helper/common.js');
      const { generateEmailTemplate } = await import('../../helper/notificationEmailLayout.js');

      const frontendUrl =
        process.env.FRONT_END_WEBSITE ||
        process.env.FRONTEND_URL ||
        'http://localhost:3000';

      const companyName = hotels[0]?.company_name || 'Your Company';

      if (payment_mode === 'bu') {
        // BU Mode: Validate all hotels have emails
        const hotelsWithoutEmail = hotels.filter(h => !h.email);
        if (hotelsWithoutEmail.length > 0) {
          const hotelNames = hotelsWithoutEmail.map(h => h.name || `ID: ${h.id}`).join(', ');
          return res.status(400).json({
            status: 0,
            message: `Some business units missing email: ${hotelNames}`
          });
        }

        // Send individual payment links to each BU
        const emailPromises = hotels.map(async (hotel) => {
          const paymentLink = `${frontendUrl}/hotel-payment?hotel_id=${hotel.id}`;

          const headerContent = `<h2 style="margin: 0 0 8px; font-size: 22px; font-weight: 700; color: #111827;">Welcome, ${hotel.name}!</h2>`;
          const containerContent = `
            <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px;">
              You have been added as a business unit under <strong>${companyName}</strong> on the Phileein Hospitality Procurement Platform.
              To activate your business unit, please complete the onboarding payment.
            </p>
            <div style="background: #f9fafb; border-radius: 12px; padding: 16px 20px; margin: 16px 0;">
              <p style="margin: 0 0 6px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em;">Payment Details</p>
              <p style="margin: 0; font-size: 26px; font-weight: 700; color: #158993;">₹ ${hotel.fee_amount}</p>
            </div>
            <div style="text-align: center; margin: 24px 0 12px;">
              <a href="${paymentLink}"
                 style="background-color: #158993; color: #ffffff; padding: 12px 32px; border-radius: 9999px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">
                Complete Payment
              </a>
            </div>
            <p style="font-size: 12px; color: #9ca3af; margin: 0; text-align: center;">
              If the button doesn't work, copy and paste this link into your browser:<br/>
              <a href="${paymentLink}" style="color: #158993; word-break: break-all;">${paymentLink}</a>
            </p>
          `;

          const html = generateEmailTemplate(headerContent, containerContent, null);

          await sendMail({
            from: Config.webmasterMail,
            to: hotel.email,
            subject: `Phileein Hospitality Procurement Platform - Complete Payment for ${hotel.name}`,
            html
          });

          await hospitalityModel.updateHotelPaymentStatus(hotel.id, 'onboarding');
        });

        await Promise.all(emailPromises);

        return res.status(200).json({
          status: 1,
          message: `Payment links sent to ${hotels.length} business unit(s)`,
          data: {
            mode: 'bu',
            hotels_count: hotels.length,
            emails: hotels.map(h => h.email)
          }
        });

      } else {
        // Company Mode: Send consolidated payment link
        const companyEmail = hotels[0]?.company_email;

        if (!companyEmail) {
          return res.status(400).json({
            status: 0,
            message: 'Company contact email not configured. Please update company email before sending payment links.'
          });
        }

        const totalAmount = hotels.reduce((sum, h) => sum + parseFloat(h.fee_amount || 0), 0);
        const hotelIdsParam = hotel_ids.join(',');
        const paymentLink = `${frontendUrl}/hotel-payment?company_id=${company_id}&hotel_ids=${hotelIdsParam}`;

        const headerContent = `<h2 style="margin: 0 0 8px; font-size: 22px; font-weight: 700; color: #111827;">Welcome, ${companyName}!</h2>`;

        const hotelsList = hotels.map(h =>
          `<li style="margin: 8px 0; font-size: 14px; color: #4b5563;">
            <strong>${h.name}</strong> - ₹${h.fee_amount}
          </li>`
        ).join('');

        const containerContent = `
          <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px;">
            Your business units have been added to the Phileein Hospitality Procurement Platform.
            To activate all business units, please complete the consolidated onboarding payment.
          </p>
          <div style="background: #f9fafb; border-radius: 12px; padding: 16px 20px; margin: 16px 0;">
            <p style="margin: 0 0 12px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em;">Business Units</p>
            <ul style="list-style: none; padding: 0; margin: 0;">${hotelsList}</ul>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;" />
            <p style="margin: 0 0 6px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em;">Total Payment</p>
            <p style="margin: 0; font-size: 26px; font-weight: 700; color: #158993;">₹ ${totalAmount.toFixed(2)}</p>
          </div>
          <div style="text-align: center; margin: 24px 0 12px;">
            <a href="${paymentLink}"
               style="background-color: #158993; color: #ffffff; padding: 12px 32px; border-radius: 9999px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">
              Complete Payment
            </a>
          </div>
          <p style="font-size: 12px; color: #9ca3af; margin: 0; text-align: center;">
            If the button doesn't work, copy and paste this link into your browser:<br/>
            <a href="${paymentLink}" style="color: #158993; word-break: break-all;">${paymentLink}</a>
          </p>
        `;

        const html = generateEmailTemplate(headerContent, containerContent, null);

        await sendMail({
          from: Config.webmasterMail,
          to: companyEmail,
          subject: `Phileein Hospitality Procurement Platform - Complete Payment for ${companyName}`,
          html
        });

        // Update all hotels to onboarding status
        await Promise.all(hotel_ids.map(hotelId =>
          hospitalityModel.updateHotelPaymentStatus(hotelId, 'onboarding')
        ));

        return res.status(200).json({
          status: 1,
          message: 'Consolidated payment link sent successfully',
          data: {
            mode: 'company',
            hotels_count: hotels.length,
            total_amount: totalAmount,
            email: companyEmail
          }
        });
      }
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // Create Razorpay payment order for hotel onboarding (public endpoint - no auth required)
  // Supports both single hotel and consolidated company payments
  createHotelPaymentOrder: async (req, res) => {
    try {
      const { hotel_id, company_id, hotel_ids } = req.body;

      // Handle consolidated company payment
      if (company_id && hotel_ids && Array.isArray(hotel_ids) && hotel_ids.length > 0) {
        const hotelIds = hotel_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));

        if (hotelIds.length === 0) {
          return res.status(400).json({ status: 0, message: 'Invalid hotel_ids array' });
        }

        const hotels = await hospitalityModel.getHotelsByIds(hotelIds);

        if (!hotels || hotels.length === 0) {
          return res.status(404).json({ status: 0, message: 'No valid business units found' });
        }

        // Verify all hotels belong to the same company
        const companyIds = [...new Set(hotels.map(h => h.hospitality_company_id))];
        if (companyIds.length > 1 || companyIds[0] !== company_id) {
          return res.status(400).json({ status: 0, message: 'All business units must belong to the specified company' });
        }

        // Check if all hotels are already paid or have in-progress payments
        const paymentChecks = await Promise.all(
          hotelIds.map(hotelId => hospitalityModel.getHotelPayment(hotelId))
        );
        const allPaid = paymentChecks.every(payment => payment?.payment_status === 'success');
        if (allPaid) {
          return res.status(200).json({
            status: 1,
            data: { already_paid: true }
          });
        }
        // If any hotel has an in-progress payment, return existing order details
        const inProgressPayment = paymentChecks.find(p => p && ['created', 'pending'].includes(p.payment_status) && p.razorpay_order_id);
        if (inProgressPayment) {
          return res.status(200).json({
            status: 1,
            data: {
              order: { id: inProgressPayment.razorpay_order_id, amount: inProgressPayment.amount, currency: 'INR' },
              payment_id: inProgressPayment.id,
              amount: inProgressPayment.amount / 100,
              razorpay_key: Config.razorpay.razorpay_key
            }
          });
        }

        const totalAmount = hotels.reduce((sum, h) => sum + parseFloat(h.fee_amount || 0), 0);

        if (totalAmount <= 0) {
          return res.status(400).json({ status: 0, message: 'Total fee amount must be greater than 0' });
        }

        const { default: Razorpay } = await import('razorpay');
        const razorpay = new Razorpay({
          key_id: Config.razorpay.razorpay_key,
          key_secret: Config.razorpay.razorpay_secret
        });

        const amountInPaise = Math.round(totalAmount * 100);
        const receipt = `COMPANY-${company_id}-${Date.now()}`;

        const order = await razorpay.orders.create({
          amount: amountInPaise,
          currency: 'INR',
          receipt,
          payment_capture: 1
        });

        const beforePayload = JSON.stringify(order);

        // Use the first hotel's created_by as the user_id (or 0 if not available)
        const userId = hotels[0]?.created_by || 0;

        const paymentRow = await hospitalityModel.createHotelPayment({
          user_id: userId,
          amount: amountInPaise,
          currency: 'INR',
          payment_status: 'created',
          razorpay_order_id: order.id,
          receipt,
          before_payment_response: beforePayload
        });

        // Update all hotels payment_status to pending
        await Promise.all(hotelIds.map(hotelId =>
          hospitalityModel.updateHotelPaymentStatus(hotelId, 'pending')
        ));

        return res.status(200).json({
          status: 1,
          data: {
            order,
            payment_id: paymentRow.id,
            company_name: hotels[0]?.company_name,
            company_id: company_id,
            hotel_ids: hotelIds,
            hotels: hotels.map(h => ({ id: h.id, name: h.name, fee_amount: h.fee_amount })),
            total_amount: totalAmount,
            razorpay_key: Config.razorpay.razorpay_key
          }
        });
      }

      // Handle single hotel payment (existing logic)
      if (!hotel_id) {
        return res.status(400).json({ status: 0, message: 'hotel_id is required for single hotel payment, or company_id and hotel_ids for consolidated payment' });
      }

      const hotel = await hospitalityModel.getHotelPaymentDetails(hotel_id);
      if (!hotel) {
        return res.status(404).json({ status: 0, message: 'Business unit not found' });
      }

      if (!hotel.fee_amount || hotel.fee_amount <= 0) {
        return res.status(400).json({ status: 0, message: 'Fee amount not configured' });
      }

      // Check for existing payment (success, created, or pending)
      const existingPayment = await hospitalityModel.getHotelPayment(hotel_id);
      if (existingPayment && existingPayment.payment_status === 'success') {
        return res.status(200).json({
          status: 1,
          data: { already_paid: true, payment_id: existingPayment.id }
        });
      }
      // If a payment order already exists (created/pending), return the existing order
      if (existingPayment && ['created', 'pending'].includes(existingPayment.payment_status) && existingPayment.razorpay_order_id) {
        return res.status(200).json({
          status: 1,
          data: {
            order: { id: existingPayment.razorpay_order_id, amount: existingPayment.amount, currency: 'INR' },
            payment_id: existingPayment.id,
            hotel_name: hotel.name,
            company_name: hotel.company_name,
            amount: hotel.fee_amount,
            razorpay_key: Config.razorpay.razorpay_key
          }
        });
      }

      const { default: Razorpay } = await import('razorpay');
      const razorpay = new Razorpay({
        key_id: Config.razorpay.razorpay_key,
        key_secret: Config.razorpay.razorpay_secret
      });

      const amountInPaise = hotel.fee_amount * 100;
      const receipt = `HOTEL-${hotel_id}-${Date.now()}`;

      const order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt,
        payment_capture: 1
      });

      const beforePayload = JSON.stringify(order);

      const paymentRow = await hospitalityModel.createHotelPayment({
        user_id: hotel.created_by,
        amount: amountInPaise,
        currency: 'INR',
        payment_status: 'created',
        razorpay_order_id: order.id,
        receipt,
        before_payment_response: beforePayload
      });

      // Update hotel payment_status to pending (payment attempt made)
      await hospitalityModel.updateHotelPaymentStatus(hotel_id, 'pending');

      return res.status(200).json({
        status: 1,
        data: {
          order,
          payment_id: paymentRow.id,
          hotel_name: hotel.name,
          company_name: hotel.company_name,
          amount: hotel.fee_amount,
          razorpay_key: Config.razorpay.razorpay_key
        }
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({ status: 3, message: error.message });
    }
  },

  // Verify Razorpay payment for hotel onboarding (public endpoint)
  // Supports both single hotel and consolidated company payments
  verifyHotelPayment: async (req, res) => {
    try {
      const { hotel_id, company_id, hotel_ids, razorpay_order_id, razorpay_payment_id, razorpay_signature, payment_id } = req.body;

      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ status: 0, message: 'Missing required payment verification fields' });
      }

      // Verify signature
      const { createHmac } = await import('crypto');
      const sign = `${razorpay_order_id}|${razorpay_payment_id}`;
      const expectedSign = createHmac('sha256', Config.razorpay.razorpay_secret)
        .update(sign)
        .digest('hex');

      const isValid = expectedSign === razorpay_signature;

      const afterPayload = JSON.stringify({
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        verified: isValid
      });

      // Update payment record
      await hospitalityModel.updateHotelPayment(payment_id, {
        razorpay_payment_id,
        razorpay_signature,
        payment_status: isValid ? 'success' : 'failed',
        after_payment_response: afterPayload
      });

      if (isValid) {
        // Handle consolidated company payment
        if (company_id && hotel_ids && Array.isArray(hotel_ids) && hotel_ids.length > 0) {
          const hotelIds = hotel_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));

          // Update all hotels status to active
          await Promise.all(hotelIds.map(hotelId =>
            hospitalityModel.updateHotelPaymentStatus(hotelId, 'active')
          ));

          // Send confirmation email to company email
          try {
            const hotels = await hospitalityModel.getHotelsByIds(hotelIds);
            if (hotels && hotels.length > 0) {
              const companyEmail = hotels[0]?.company_email;
              const companyName = hotels[0]?.company_name || 'Your Company';
              const totalAmount = hotels.reduce((sum, h) => sum + parseFloat(h.fee_amount || 0), 0);

              if (companyEmail) {
                const { sendMail } = await import('../../helper/common.js');
                const { generateEmailTemplate } = await import('../../helper/notificationEmailLayout.js');

                const hotelsList = hotels.map(h =>
                  `<li style="margin: 8px 0; font-size: 14px; color: #4b5563;">
                    <strong>${h.name}</strong> - ₹${h.fee_amount}
                  </li>`
                ).join('');

                const headerContent = `<h2 style="margin: 0 0 8px; font-size: 22px; font-weight: 700; color: #111827;">Payment Successful</h2>`;
                const containerContent = `
                  <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px;">
                    All business units for <strong>${companyName}</strong> have been successfully activated on the Phileein Hospitality Procurement Platform.
                  </p>
                  <div style="background: #f0fdf4; padding: 14px 18px; border-radius: 10px; border: 1px solid #bbf7d0; margin: 16px 0 8px;">
                    <p style="margin: 0 0 12px; color: #166534; font-size: 14px; font-weight: 600;">Business Units Activated:</p>
                    <ul style="list-style: none; padding: 0; margin: 0;">${hotelsList}</ul>
                    <hr style="border: none; border-top: 1px solid #bbf7d0; margin: 12px 0;" />
                    <p style="margin: 0; color: #166534; font-size: 14px;">
                      <strong>Total Amount Paid:</strong> ₹ ${totalAmount.toFixed(2)}<br/>
                      <strong>Payment ID:</strong> ${razorpay_payment_id}
                    </p>
                  </div>
                  <p style="font-size: 13px; color: #6b7280; margin: 12px 0 0;">
                    Tax invoice and payment received documents are attached to this email.
                  </p>
                  <p style="font-size: 13px; color: #6b7280; margin: 12px 0 0;">
                    You can now start using your business units or contact your administrator for any assistance.
                  </p>
                `;

                const html = generateEmailTemplate(headerContent, containerContent, null);

                const mailOpts = {
                  from: Config.webmasterMail,
                  to: companyEmail,
                  subject: `Phileein Hospitality Procurement Platform - Payment Confirmed for ${companyName}`,
                  html
                };

                try {
                  const paymentRecord = await hospitalityModel.getPaymentById(payment_id);
                  const receipt = paymentRecord?.receipt || `COMPANY-${company_id}-${Date.now()}`;
                  const amountInRupees = paymentRecord?.amount ? paymentRecord.amount / 100 : totalAmount;
                  const lineItems = hotels.map(h => ({ name: `Business Unit: ${h.name}`, amount: h.fee_amount }));

                  const taxInvoicePdf = await generateTaxInvoicePdf({
                    type: 'Business Unit Onboarding',
                    recipientName: companyName,
                    amount: amountInRupees,
                    paymentId: razorpay_payment_id,
                    orderId: razorpay_order_id,
                    receipt,
                    lineItems
                  });
                  const paymentReceivedPdf = await generatePaymentReceivedPdf({
                    recipientName: companyName,
                    amount: amountInRupees,
                    paymentId: razorpay_payment_id,
                    orderId: razorpay_order_id,
                    description: `Business Units Onboarding - ${companyName}`
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
                  logError('BU payment doc generation failed:', docErr);
                }

                await sendMail(mailOpts);
              }
            }
          } catch (emailError) {
            logError('Email failed but payment verified:', emailError);
          }

          return res.status(200).json({
            status: 1,
            message: 'Payment verified successfully. All business units are now active.',
            data: { verified: true, hotel_ids: hotelIds }
          });
        }

        // Handle single hotel payment (existing logic)
        if (!hotel_id) {
          return res.status(400).json({ status: 0, message: 'hotel_id is required for single hotel payment, or company_id and hotel_ids for consolidated payment' });
        }

        // Update hotel status to active
        await hospitalityModel.updateHotelPaymentStatus(hotel_id, 'active');

        // Send confirmation email with tax invoice and payment received attachments
        try {
          const hotel = await hospitalityModel.getHotelPaymentDetails(hotel_id);
          if (hotel?.email) {
            const { sendMail } = await import('../../helper/common.js');
            const { generateEmailTemplate } = await import('../../helper/notificationEmailLayout.js');

            const headerContent = `<h2 style=\"margin: 0 0 8px; font-size: 22px; font-weight: 700; color: #111827;\">Payment Successful</h2>`;
            const containerContent = `
              <p style=\"font-size: 15px; color: #4b5563; margin: 0 0 16px;\">
                Your business unit <strong>${hotel.name}</strong> has been successfully activated on the Phileein Hospitality Procurement Platform.
              </p>
              <div style=\"background: #f0fdf4; padding: 14px 18px; border-radius: 10px; border: 1px solid #bbf7d0; margin: 16px 0 8px;\">
                <p style=\"margin: 0; color: #166534; font-size: 14px;\">
                  <strong>Amount Paid:</strong> ₹ ${hotel.fee_amount?.toLocaleString('en-IN') || hotel.fee_amount}<br/>
                  <strong>Payment ID:</strong> ${razorpay_payment_id}
                </p>
              </div>
              <p style=\"font-size: 13px; color: #6b7280; margin: 12px 0 0;\">
                Tax invoice and payment received documents are attached to this email.
              </p>
              <p style=\"font-size: 13px; color: #6b7280; margin: 12px 0 0;\">
                You can now start using your business unit or contact your administrator for any assistance.
              </p>
            `;

            const html = generateEmailTemplate(headerContent, containerContent, null);

            const mailOpts = {
              from: Config.webmasterMail,
              to: hotel.email,
              subject: `Phileein Hospitality Procurement Platform - Payment Confirmed for ${hotel.name}`,
              html
            };

            try {
              const paymentRecord = await hospitalityModel.getPaymentById(payment_id);
              const receipt = paymentRecord?.receipt || `HOTEL-${hotel_id}-${Date.now()}`;
              const amountInRupees = paymentRecord?.amount ? paymentRecord.amount / 100 : hotel.fee_amount;

              const taxInvoicePdf = await generateTaxInvoicePdf({
                type: 'Business Unit Onboarding',
                recipientName: hotel.company_name || hotel.name,
                amount: amountInRupees,
                paymentId: razorpay_payment_id,
                orderId: razorpay_order_id,
                receipt,
                lineItems: [{ name: `Business Unit: ${hotel.name}`, amount: hotel.fee_amount }]
              });
              const paymentReceivedPdf = await generatePaymentReceivedPdf({
                recipientName: hotel.company_name || hotel.name,
                amount: amountInRupees,
                paymentId: razorpay_payment_id,
                orderId: razorpay_order_id,
                description: `Business Unit Onboarding - ${hotel.name}`
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
              logError('BU payment doc generation failed:', docErr);
            }

            await sendMail(mailOpts);
          }
        } catch (emailError) {
          logError('Email failed but payment verified:', emailError);
        }

        return res.status(200).json({
          status: 1,
          message: 'Payment verified successfully. Business unit is now active.',
          data: { verified: true }
        });
      } else {
        return res.status(400).json({
          status: 0,
          message: 'Payment verification failed. Invalid signature.',
          data: { verified: false }
        });
      }
    } catch (error) {
      logError('Payment verification error:', error);
      console.error('Full error details:', error);
      return res.status(400).json({
        status: 3,
        message: error.message || 'Payment verification failed',
        error: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  },

  // Get hotel payment info (public endpoint for payment page)
  getHotelPaymentInfo: async (req, res) => {
    try {
      const hotelId = parseInt(req.params.hotel_id, 10);
      if (!hotelId) {
        return res.status(400).json({ status: 0, message: 'hotel_id is required' });
      }

      const hotel = await hospitalityModel.getHotelPaymentDetails(hotelId);
      if (!hotel) {
        return res.status(404).json({ status: 0, message: 'Business unit not found' });
      }

      const existingPayment = await hospitalityModel.getHotelPayment(hotelId);

      return res.status(200).json({
        status: 1,
        data: {
          id: hotel.id,
          name: hotel.name,
          company_name: hotel.company_name,
          fee_amount: hotel.fee_amount,
          payment_status: hotel.payment_status,
          email: hotel.email,
          already_paid: existingPayment?.payment_status === 'success',
          razorpay_key: Config.razorpay.razorpay_key
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // Get company-level payment info (consolidated payment for multiple hotels)
  getCompanyPaymentInfo: async (req, res) => {
    try {
      const companyId = parseInt(req.query.company_id, 10);
      const hotelIdsParam = req.query.hotel_ids;

      if (!companyId || !hotelIdsParam) {
        return res.status(400).json({ status: 0, message: 'company_id and hotel_ids are required' });
      }

      const hotelIds = hotelIdsParam.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));

      if (hotelIds.length === 0) {
        return res.status(400).json({ status: 0, message: 'Invalid hotel_ids parameter' });
      }

      const hotels = await hospitalityModel.getHotelsByIds(hotelIds);

      if (!hotels || hotels.length === 0) {
        return res.status(404).json({ status: 0, message: 'No valid business units found' });
      }

      // Verify all hotels belong to the same company
      const companyIds = [...new Set(hotels.map(h => h.hospitality_company_id))];
      if (companyIds.length > 1 || companyIds[0] !== companyId) {
        return res.status(400).json({ status: 0, message: 'All business units must belong to the specified company' });
      }

      const totalAmount = hotels.reduce((sum, h) => sum + parseFloat(h.fee_amount || 0), 0);
      const companyName = hotels[0]?.company_name || 'Company';

      // Check if all hotels are already paid by checking their payment_status field
      // (when payment is verified, hotels are updated to 'active' status)
      const allPaid = hotels.every(hotel => hotel.payment_status === 'active');

      return res.status(200).json({
        status: 1,
        data: {
          company_id: companyId,
          company_name: companyName,
          company_email: hotels[0]?.company_email,
          hotels: hotels.map(h => ({
            id: h.id,
            name: h.name,
            fee_amount: h.fee_amount,
            payment_status: h.payment_status
          })),
          total_amount: totalAmount,
          hotel_ids: hotelIds,
          already_paid: allPaid,
          razorpay_key: Config.razorpay.razorpay_key
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get vendor's hotel and category mappings
   * Returns all active subscriptions for the authenticated vendor
   * Organizes categories into hierarchical structure (main categories with sub-categories)
   *
   * @route GET /api/v1/hospitality/vendor/my-mappings
   * @access Private (Vendors only)
   */
  getVendorMappings: async (req, res) => {
    try {
      const vendorId = req.user.id;

      // Get all active subscriptions from model
      const { hotels, categories } = await hospitalityModel.getVendorHotelCategoryMappings(vendorId);

      // Process categories into hierarchical structure
      // Group by parent_id to identify main categories and their sub-categories
      const mainCategoryMap = new Map();
      const standaloneSubs = [];

      // First pass: Build main categories map
      categories.forEach(cat => {
        if (!cat.parent_id || cat.parent_id === 0) {
          // This is a main category
          if (!mainCategoryMap.has(cat.category_id)) {
            mainCategoryMap.set(cat.category_id, {
              subscription_id: cat.subscription_id,
              category_id: cat.category_id,
              category_name: cat.category_name,
              parent_id: cat.parent_id,
              start_date: cat.start_date,
              end_date: cat.end_date,
              fee_amount: cat.fee_amount,
              sub_categories: []
            });
          }
        }
      });

      // Second pass: Attach sub-categories to their parents or mark as standalone
      categories.forEach(cat => {
        if (cat.parent_id && cat.parent_id !== 0) {
          // This is a sub-category
          if (mainCategoryMap.has(cat.parent_id)) {
            // Parent exists in vendor's subscriptions
            const parent = mainCategoryMap.get(cat.parent_id);
            parent.sub_categories.push({
              subscription_id: cat.subscription_id,
              category_id: cat.category_id,
              category_name: cat.category_name,
              parent_id: cat.parent_id,
              parent_category_name: cat.parent_category_name,
              start_date: cat.start_date,
              end_date: cat.end_date,
              fee_amount: cat.fee_amount
            });
          } else {
            // Vendor has sub-category but not the parent
            standaloneSubs.push({
              subscription_id: cat.subscription_id,
              category_id: cat.category_id,
              category_name: cat.category_name,
              parent_id: cat.parent_id,
              parent_category_name: cat.parent_category_name,
              start_date: cat.start_date,
              end_date: cat.end_date,
              fee_amount: cat.fee_amount
            });
          }
        }
      });

      return res.status(200).json({
        status: 1,
        data: {
          hotels,
          categories: {
            main_categories: Array.from(mainCategoryMap.values()),
            standalone_subcategories: standaloneSubs
          }
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  sendBUCredentials: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const hotelId = parseInt(req.params.hotel_id, 10);

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({ status: 2, message: 'Hospitality company not found' });
      }

      const hotel = await hospitalityModel.getHotelById(hotelId);
      if (!hotel || hotel.hospitality_company_id !== hospitalityCompanyId) {
        return res.status(404).json({ status: 2, message: 'Hotel not found in selected company' });
      }

      const users = await hospitalityModel.getUsersForHotelWithPassword(hospitalityCompanyId, hotelId);

      if (!users || users.length === 0) {
        return res.status(200).json({ status: 2, message: 'No users mapped to this business unit' });
      }

      const DEFAULT_PASSWORD = 'Workwise@123';
      const loginUrl = 'https://phileeinhospitality.com';
      let emailsSent = 0;

      for (const user of users) {
        const isDefaultPassword = user.password
          ? await bcrypt.compare(DEFAULT_PASSWORD, user.password)
          : false;

        const employeeCodeLine = user.employee_code
          ? `<li style="padding:4px 0;"><strong>Employee Code:</strong> ${user.employee_code}</li>`
          : '';

        let credentialsBlock;
        if (isDefaultPassword) {
          credentialsBlock = `
            <div style="background-color:#EFF6FF; border-left:4px solid #3B82F6; padding:16px; margin:16px 0; border-radius:4px;">
              <p style="margin:0 0 8px 0; font-weight:600; color:#1E40AF;">Your Login Credentials:</p>
              <ul style="list-style:none; padding:0; margin:0;">
                ${employeeCodeLine}
                <li style="padding:4px 0;"><strong>Email:</strong> ${user.email}</li>
                <li style="padding:4px 0;"><strong>Password:</strong> ${DEFAULT_PASSWORD}</li>
              </ul>
            </div>
            <p style="font-size:13px; color:#777; margin-top:8px;"><em>For security reasons, we recommend changing your password after your first login.</em></p>`;
        } else {
          credentialsBlock = `
            <div style="background-color:#FFF7ED; border-left:4px solid #F59E0B; padding:16px; margin:16px 0; border-radius:4px;">
              <p style="margin:0; color:#92400E;">Kindly login with the credentials already provided to you.</p>
              <ul style="list-style:none; padding:0; margin:8px 0 0 0;">
                ${employeeCodeLine}
                <li style="padding:4px 0;"><strong>Email:</strong> ${user.email}</li>
              </ul>
            </div>`;
        }

        const headerContent = `<h2>Hello ${user.name || 'User'},</h2>`;
        const containerContent = `
          <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
            <p>Your account has been made active for <strong>${hotel.name}</strong>.</p>
            ${credentialsBlock}
            <div style="text-align:center; margin-top:24px;">
              <a href="${loginUrl}"
                 style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
                Login Now
              </a>
            </div>
          </div>`;

        const htmlContent = generateEmailTemplate(headerContent, containerContent);

        console.log(`\n========== [BU CREDENTIALS EMAIL] ==========`);
        console.log(`To: ${user.email}`);
        console.log(`User: ${user.name}`);
        console.log(`Hotel: ${hotel.name}`);
        console.log(`Default Password: ${isDefaultPassword ? 'YES' : 'NO (changed)'}`);
        console.log(`\n--- FULL HTML ---\n`);
        console.log(htmlContent);
        console.log(`\n========== [END EMAIL] ==========\n`);

        sendMail({
          from: Config.webmasterMail,
          to: user.email,
          subject: `Your Account is Active — ${hotel.name}`,
          html: htmlContent
        });

        emailsSent++;
      }

      return res.status(200).json({
        status: 1,
        message: `Credentials email sent to ${emailsSent} user(s) for ${hotel.name}`
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * GET /api/v1/hospitality/vendor/subscription-status
   * Returns the vendor's full subscription state for the subscription management UI
   */
  getVendorSubscriptionStatus: async (req, res) => {
    try {
      const vendorId = req.user.id;

      // Mark any stale expired subscriptions first
      await hospitalityModel.markExpiredSubscriptions(vendorId);

      const hasActiveSub = await hospitalityModel.hasValidPaidSubscription(vendorId);
      const allSubs = await hospitalityModel.getVendorSubscriptionStatus(vendorId);

      // Separate current (active/non-expired), expired, and pending subscriptions.
      // Unpaid self-registration rows stay in pending state; only paid or admin-assigned
      // active rows on approved vendors count as active.
      const now = Moment().startOf('day');
      const isVendorApproved = req.user?.status === 1 || req.user?.status === '1';
      const isValidSub = (s) =>
        s.payment_status === 'paid' ||
        s.payment_status === 'success' ||
        (s.status === 'active' && !s.payment_id && isVendorApproved);
      const activeSubs = allSubs.filter(s =>
        Moment(s.end_date).isSameOrAfter(now, 'day') && isValidSub(s)
      );
      const expiredSubs = allSubs.filter(s =>
        Moment(s.end_date).isBefore(now, 'day') && isValidSub(s)
      );
      const pendingSubs = allSubs.filter(s =>
        s.payment_status === 'created' || s.payment_status === 'pending'
        || s.status === 'pending'
      );

      // Build response for active or most recent expired subscription
      const relevantSubs = activeSubs.length > 0 ? activeSubs : expiredSubs;
      const categories = relevantSubs
        .filter(s => s.item_type === 'category')
        .map(s => ({ id: s.item_id, name: s.item_name, fee_amount: s.fee_amount }));
      const subcategories = relevantSubs
        .filter(s => s.item_type === 'subcategory')
        .map(s => ({ id: s.item_id, name: s.item_name, fee_amount: s.fee_amount }));
      const hotels = relevantSubs
        .filter(s => s.item_type === 'hotel')
        .map(s => ({ id: s.item_id, name: s.item_name, fee_amount: s.fee_amount }));

      const endDate = relevantSubs.length > 0 ? relevantSubs[0].end_date : null;
      const startDate = relevantSubs.length > 0 ? relevantSubs[0].start_date : null;
      const daysRemaining = endDate ? Moment(endDate).diff(Moment(), 'days') : 0;
      const totalPaid = relevantSubs.reduce((sum, s) => sum + (parseFloat(s.fee_amount) || 0), 0);

      const isExpired = !hasActiveSub && expiredSubs.length > 0;
      const canRenew = isExpired || (daysRemaining >= 0 && daysRemaining <= 30);

      return res.status(200).json({
        status: 1,
        data: {
          has_active_subscription: hasActiveSub,
          subscription: relevantSubs.length > 0 ? {
            categories,
            subcategories,
            hotels,
            start_date: startDate,
            end_date: endDate,
            total_paid: totalPaid,
            payment_id: relevantSubs[0].razorpay_payment_id || null,
            days_remaining: Math.max(daysRemaining, 0)
          } : null,
          is_expired: isExpired,
          has_pending: pendingSubs.length > 0,
          can_renew: canRenew
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * POST /api/v1/hospitality/renew-subscription
   * Dedicated renewal endpoint - auto-populates from previous subscription, vendor can optionally modify
   */
  renewSubscription: async (req, res) => {
    try {
      const vendorId = req.user.id;
      const { categories: reqCategories, subcategories: reqSubcategories, hotels: reqHotels } = req.body;

      // Verify vendor is a hospitality vendor
      const companyDetails = await userModel.getCompanyDetail(vendorId);
      const isHospitalityVendor =
        companyDetails && companyDetails[0] &&
        (companyDetails[0].is_hospitality === 1 || companyDetails[0].is_hospitality === '1');
      if (!isHospitalityVendor) {
        return res.status(400).json({ status: 2, message: 'Hospitality subscription not applicable' });
      }

      // Prevent double-pay: block if vendor already has active subscription
      const hasActiveSub = await hospitalityModel.hasValidPaidSubscription(vendorId);
      if (hasActiveSub) {
        return res.status(400).json({ status: 2, message: 'You already have an active subscription' });
      }

      // Get categories/hotels: use request body if provided, otherwise fall back to expired subscription
      let categoryIds = Array.isArray(reqCategories) && reqCategories.length > 0 ? reqCategories : [];
      let subcategoryIds = Array.isArray(reqSubcategories) && reqSubcategories.length > 0 ? reqSubcategories : [];
      let hotelIds = Array.isArray(reqHotels) && reqHotels.length > 0 ? reqHotels : [];

      if (!categoryIds.length && !hotelIds.length) {
        const expiredSubs = await hospitalityModel.getExpiredSubscriptionsForVendor(vendorId);
        if (expiredSubs && expiredSubs.length > 0) {
          for (const sub of expiredSubs) {
            if (sub.item_type === 'category' && !categoryIds.includes(sub.item_id)) {
              categoryIds.push(sub.item_id);
            } else if (sub.item_type === 'subcategory' && !subcategoryIds.includes(sub.item_id)) {
              subcategoryIds.push(sub.item_id);
            } else if (sub.item_type === 'hotel' && !hotelIds.includes(sub.item_id)) {
              hotelIds.push(sub.item_id);
            }
          }
        }
      }

      if (!categoryIds.length) {
        return res.status(400).json({ status: 2, message: 'No categories selected for subscription renewal' });
      }
      if (!hotelIds.length) {
        return res.status(400).json({ status: 2, message: 'No hotels selected for subscription renewal' });
      }

      // Calculate FY end date with minimum 30-day rule
      const startDate = Moment();
      const currentYear = startDate.year();
      const fyEndThisYear = Moment(`${currentYear}-03-31`, 'YYYY-MM-DD');
      let fyEnd = startDate.isAfter(fyEndThisYear) || startDate.isSame(fyEndThisYear, 'day')
        ? fyEndThisYear.clone().add(1, 'year')
        : fyEndThisYear.clone();

      // Minimum 30-day subscription
      const daysTillEnd = fyEnd.diff(startDate, 'days');
      if (daysTillEnd < 30) {
        fyEnd = fyEnd.add(1, 'year');
      }
      const fyEndDateStr = fyEnd.format('YYYY-MM-DD');

      // Calculate pricing
      let totalAmount = 0;
      const subscriptionRows = [];
      const uniqueCategoryIds = [...new Set(categoryIds)];

      if (uniqueCategoryIds.length) {
        const dbCategories = await productModel.getCategoriesByIds(uniqueCategoryIds);
        const numHotels = hotelIds.length;

        for (const row of dbCategories) {
          const baseFee = row.fee_amount || 500;
          const effectiveFee = numHotels > 0 ? baseFee * numHotels : baseFee;
          totalAmount += effectiveFee;
          subscriptionRows.push({
            vendor_id: vendorId,
            item_type: 'category',
            item_id: row.id,
            fee_amount: effectiveFee,
            start_date: startDate.format('YYYY-MM-DD'),
            end_date: fyEndDateStr,
            status: 'active'
          });
        }
      }

      if (hotelIds.length) {
        const dbHotels = await hospitalityModel.getHotelsByIds(hotelIds);
        for (const row of dbHotels) {
          subscriptionRows.push({
            vendor_id: vendorId,
            item_type: 'hotel',
            item_id: row.id,
            fee_amount: 0,
            start_date: startDate.format('YYYY-MM-DD'),
            end_date: fyEndDateStr,
            status: 'active'
          });
        }
      }

      if (!subscriptionRows.length || totalAmount <= 0) {
        return res.status(400).json({ status: 2, message: 'No valid hospitality items selected for subscription' });
      }

      // Create Razorpay order
      const digit = convertSixDigit(vendorId);
      const razorpay = new Razorpay({
        key_id: Config.razorpay.razorpay_key,
        key_secret: Config.razorpay.razorpay_secret
      });
      const options = {
        amount: totalAmount * 100,
        currency: 'INR',
        receipt: `RNW${digit}`,
        payment_capture: 1
      };
      const razorpayOrder = await razorpay.orders.create(options);

      // Store intended subscription items in payment metadata
      // Subscription rows are only created after successful payment
      const vendorPayment = await hospitalityModel.createVendorPayment({
        vendor_id: vendorId,
        razorpay_order_id: razorpayOrder.id,
        razorpay_payment_id: null,
        razorpay_signature: null,
        amount: totalAmount,
        currency: 'INR',
        payment_status: 'created',
        metadata: {
          subscription_items: subscriptionRows,
          fy_end_date: fyEndDateStr
        }
      });

      return res.status(200).json({
        status: 1,
        data: {
          order_id: razorpayOrder.id,
          amount: totalAmount,
          currency: 'INR',
          end_date: fyEndDateStr,
          categories: uniqueCategoryIds,
          hotels: hotelIds
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * POST /api/v1/hospitality/verify-payment
   * Secure payment verification endpoint - validates Razorpay signature
   */
  verifyPayment: async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ status: 2, message: 'Missing payment verification parameters' });
      }

      // Validate Razorpay signature
      const generatedSignature = crypto
        .createHmac('sha256', Config.razorpay.razorpay_secret)
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');

      if (generatedSignature !== razorpay_signature) {
        return res.status(400).json({ status: 2, message: 'Payment verification failed - invalid signature' });
      }

      // Find the vendor payment record
      const vendorPayment = await hospitalityModel.getVendorPaymentByOrderId(razorpay_order_id);
      if (!vendorPayment || vendorPayment.length === 0) {
        return res.status(404).json({ status: 2, message: 'Payment record not found' });
      }

      const payment = vendorPayment[0];
      const userId = payment.vendor_id;

      // Mark payment as successful
      await db.none(
        `UPDATE tbl_vendor_payments
         SET razorpay_payment_id = $1,
             razorpay_signature = $2,
             payment_status = 'success'
         WHERE razorpay_order_id = $3`,
        [razorpay_payment_id, razorpay_signature, razorpay_order_id]
      );

      const metadata = typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata;

      // ---------- WH-74: Subscription modification branch ----------
      // If this payment is a modification (vendor added/removed items mid-cycle),
      // apply the diff atomically and send a modification confirmation email.
      if (metadata && metadata.type === 'modification') {
        let applied = null;
        await db.tx(async t => {
          applied = await _applyModificationFromMetadata(
            { ...payment, id: payment.id, vendor_id: userId },
            t
          );
        });

        const expiryDateFormatted = applied?.sharedEnd
          ? Moment(applied.sharedEnd).format('MMMM DD, YYYY')
          : null;

        // Send modification confirmation email (with invoice + payment PDFs).
        try {
          await _sendSubscriptionConfirmationEmail({
            kind: 'modification',
            userId,
            totalAmount: parseFloat(payment.amount) || 0,
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
            expiryDateFormatted,
            addedCategories: applied?.addedCategoryNames || [],
            addedSubcategories: applied?.addedSubcategoryNames || [],
            addedHotels: applied?.addedHotelNames || [],
            removedCategories: applied?.removedCategoryNames || [],
            removedSubcategories: applied?.removedSubcategoryNames || [],
            removedHotels: applied?.removedHotelNames || []
          });
        } catch (emailErr) {
          logError('Modification confirmation email failed:', emailErr);
        }

        return res.status(200).json({
          status: 1,
          message: 'Subscription modification applied successfully!',
          data: {
            is_modification: true,
            amount: parseFloat(payment.amount) || 0,
            expiry_date: expiryDateFormatted,
            added_categories: applied?.addedCategoryNames || [],
            added_subcategories: applied?.addedSubcategoryNames || [],
            added_hotels: applied?.addedHotelNames || [],
            removed_categories: applied?.removedCategoryNames || [],
            removed_subcategories: applied?.removedSubcategoryNames || [],
            removed_hotels: applied?.removedHotelNames || [],
            order_id: razorpay_order_id,
            payment_id: razorpay_payment_id
          }
        });
      }

      // ---------- Existing registration / renewal / extension branch ----------
      // Before creating new subscription rows, cancel any existing active rows
      // for this vendor that belong to the previous period. This prevents
      // duplicate rows (old + new) from showing up in the frontend.
      if (metadata && metadata.subscription_items && metadata.subscription_items.length > 0) {
        const isExtension = metadata.kind === 'extension';
        const isRenewalPayment = payment.receipt && payment.receipt.startsWith('RNW');

        if (isExtension || isRenewalPayment) {
          // Cancel all current active subscription rows that have a DIFFERENT
          // end_date than the new rows (i.e. they belong to the old period).
          const newEndDate = metadata.fy_end_date || metadata.subscription_items[0]?.end_date;
          if (newEndDate) {
            await db.none(
              `UPDATE tbl_vendor_hotel_category_subscription
                  SET status = 'expired',
                      cancelled_at = NOW()
                WHERE vendor_id = $1
                  AND status = 'active'
                  AND end_date::text != $2`,
              [userId, newEndDate]
            );
          }
        }

        const subscriptionRows = metadata.subscription_items.map(row => ({
          ...row,
          vendor_id: userId,
          payment_id: payment.id,
          status: 'active'
        }));
        await hospitalityModel.createVendorHotelCategorySubscription(subscriptionRows);
      }

      // Auto-map product variants for subscribed categories
      try {
        const allCatIds = (metadata?.subscription_items || [])
          .filter(r => r.item_type === 'category' || r.item_type === 'subcategory')
          .map(r => r.item_id);
        await _autoMapProductsForCategories(userId, allCatIds);
      } catch (mapErr) {
        logError('Product mapping after payment failed (non-fatal):', mapErr);
      }

      // Approve vendor if not already approved
      await userModel.updateUserAccount(userId, { status: 1 });

      // Get subscription details for response and email
      const subscriptions = await db.any(
        `SELECT vhcs.*,
         CASE
           WHEN vhcs.item_type = 'category' THEN c.title
           WHEN vhcs.item_type = 'hotel' THEN h.name
         END AS item_name
         FROM tbl_vendor_hotel_category_subscription vhcs
         LEFT JOIN tbl_category c ON vhcs.item_type = 'category' AND c.id = vhcs.item_id
         LEFT JOIN tbl_hospitality_company_hotels h ON vhcs.item_type = 'hotel' AND h.id = vhcs.item_id
         WHERE vhcs.vendor_id = $1
           AND vhcs.payment_id = $2
           AND vhcs.status = 'active'`,
        [userId, payment.id]
      );

      const categories = subscriptions.filter(s => s.item_type === 'category').map(s => s.item_name);
      const hotels = subscriptions.filter(s => s.item_type === 'hotel').map(s => s.item_name);
      const expiryDate = subscriptions.length > 0 ? subscriptions[0].end_date : null;
      const expiryDateFormatted = expiryDate
        ? Moment(expiryDate).format('MMMM DD, YYYY')
        : 'March 31, ' + (Moment().month() >= 2 ? Moment().year() + 1 : Moment().year());
      const totalAmount = subscriptions.reduce((sum, s) => sum + (parseFloat(s.fee_amount) || 0), 0);

      // Determine if this is a renewal or first-time registration
      const paymentCount = await db.oneOrNone(
        `SELECT COUNT(*) as cnt FROM tbl_vendor_payments
         WHERE vendor_id = $1 AND payment_status IN ('paid', 'success')`,
        [userId]
      );
      const isRenewal = paymentCount && parseInt(paymentCount.cnt) > 1;

      // Send confirmation email (registration / renewal — modification path
      // is sent further below after _applyModificationFromMetadata).
      try {
        await _sendSubscriptionConfirmationEmail({
          kind: isRenewal ? 'renewal' : 'registration',
          userId,
          totalAmount,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          expiryDateFormatted,
          addedCategories: categories,
          addedSubcategories: [],
          addedHotels: hotels
        });
      } catch (emailError) {
        logError('Verify payment email error:', emailError);
      }

      return res.status(200).json({
        status: 1,
        message: isRenewal ? 'Subscription renewed successfully!' : 'Payment verified successfully!',
        data: {
          is_renewal: isRenewal,
          amount: totalAmount,
          expiry_date: expiryDateFormatted,
          categories,
          hotels,
          order_id: razorpay_order_id,
          payment_id: razorpay_payment_id
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // ============================================================
  // WH-74: Vendor self-service subscription management
  // ============================================================

  /**
   * GET /api/v1/hospitality/vendor/subscription-summary
   * Returns a rich payload for the new Subscription page: status + active
   * items (cats with sub-cats nested under parents + hotels) + payment
   * history + available_actions.
   */
  getVendorSubscriptionSummary: async (req, res) => {
    try {
      const vendorId = req.user.id;

      // Transition any stale expired rows before we read state
      await hospitalityModel.markExpiredSubscriptions(vendorId);

      const hasActiveSub = await hospitalityModel.hasValidPaidSubscription(vendorId);
      const allSubs = await hospitalityModel.getVendorSubscriptionStatus(vendorId);
      const history = await hospitalityModel.getVendorPaymentHistory(vendorId, { limit: 50 });

      const isVendorApproved = req.user?.status === 1 || req.user?.status === '1';
      const isValidSub = (s) =>
        s.payment_status === 'paid' ||
        s.payment_status === 'success' ||
        (s.status === 'active' && !s.payment_id && isVendorApproved);

      const now = Moment().startOf('day');
      const activeSubs = allSubs.filter(s =>
        Moment(s.end_date).isSameOrAfter(now, 'day') && isValidSub(s) && s.status === 'active'
      );
      const expiredSubs = allSubs.filter(s =>
        Moment(s.end_date).isBefore(now, 'day') && isValidSub(s)
      );
      const pendingSubs = allSubs.filter(s =>
        s.payment_status === 'created' || s.payment_status === 'pending' || s.status === 'pending'
      );

      let statusKey = 'none';
      if (hasActiveSub && activeSubs.length > 0) statusKey = 'active';
      else if (expiredSubs.length > 0) statusKey = 'expired';
      else if (pendingSubs.length > 0) statusKey = 'pending';

      const relevantSubs = statusKey === 'active' ? activeSubs : expiredSubs;

      // Group sub-cats under their parent category for the nested display.
      const categoryMap = new Map();
      relevantSubs
        .filter(s => s.item_type === 'category')
        .forEach(s => {
          categoryMap.set(s.item_id, {
            subscription_id: s.subscription_id,
            id: s.item_id,
            name: s.item_name,
            fee_amount: parseFloat(s.fee_amount) || 0,
            start_date: s.start_date,
            end_date: s.end_date,
            sub_categories: []
          });
        });

      // Pull parent_id for each subcategory so we can group correctly
      const subRows = relevantSubs.filter(s => s.item_type === 'subcategory');
      if (subRows.length > 0) {
        const subIds = subRows.map(s => s.item_id);
        const subMeta = await db.any(
          `SELECT id, title, parent_id FROM tbl_category WHERE id = ANY($1::int[])`,
          [subIds]
        );
        const parentById = new Map(subMeta.map(r => [r.id, r.parent_id]));
        subRows.forEach(s => {
          const parentId = parentById.get(s.item_id);
          const parent = parentId ? categoryMap.get(parentId) : null;
          const subItem = {
            subscription_id: s.subscription_id,
            id: s.item_id,
            name: s.item_name,
            parent_id: parentId || null,
            start_date: s.start_date,
            end_date: s.end_date
          };
          if (parent) {
            parent.sub_categories.push(subItem);
          }
        });
      }

      const categories = Array.from(categoryMap.values());
      const hotels = relevantSubs
        .filter(s => s.item_type === 'hotel')
        .map(s => ({
          subscription_id: s.subscription_id,
          id: s.item_id,
          name: s.item_name,
          city: s.hotel_city || null,
          company_name: s.hotel_company_name || null,
          start_date: s.start_date,
          end_date: s.end_date
        }));

      // Compute the "active since" anchor from the earliest start_date across
      // all currently-relevant rows (across potentially several payments).
      const earliestStart = relevantSubs.reduce((min, s) => {
        if (!s.start_date) return min;
        if (!min || Moment(s.start_date).isBefore(Moment(min))) return s.start_date;
        return min;
      }, null);
      const endDate = relevantSubs.length > 0 ? relevantSubs[0].end_date : null;
      const daysRemaining = endDate ? Math.max(Moment(endDate).diff(Moment(), 'days'), 0) : 0;
      // Current active cost = sum of fee_amount from active subscription rows only.
      // This reflects what the vendor is currently paying, not historical totals.
      // Category rows carry the real fee; hotel/subcategory rows have fee_amount=0.
      const activeCost = relevantSubs
        .filter(s => s.status === 'active')
        .reduce((sum, s) => sum + (parseFloat(s.fee_amount) || 0), 0);

      const canModify = statusKey === 'active';
      const canRenew = statusKey === 'expired' || (statusKey === 'active' && daysRemaining <= 30);
      let blockedReason = null;
      if (statusKey === 'pending') {
        blockedReason = 'Your initial registration payment is pending. Complete it to manage your subscription.';
      } else if (statusKey === 'none') {
        blockedReason = 'No subscription found. Please contact support to set up your subscription.';
      }

      // Compute an "FY label" so the hero card can print a friendly period.
      let fyLabel = null;
      if (endDate) {
        const endMoment = Moment(endDate);
        const fyStartYear = endMoment.month() >= 3 ? endMoment.year() : endMoment.year() - 1;
        fyLabel = `FY ${fyStartYear}-${String(fyStartYear + 1).slice(-2)}`;
      }

      return res.status(200).json({
        status: 1,
        data: {
          status: statusKey,
          subscription: relevantSubs.length > 0 ? {
            start_date: earliestStart,
            end_date: endDate,
            days_remaining: daysRemaining,
            fy_label: fyLabel,
            categories,
            hotels,
            active_cost: activeCost,
            total_categories: categories.length,
            total_subcategories: categories.reduce((c, cat) => c + cat.sub_categories.length, 0),
            total_hotels: hotels.length
          } : null,
          payment_history: history,
          available_actions: {
            can_modify: canModify,
            can_renew: canRenew,
            blocked_reason: blockedReason
          }
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * POST /api/v1/hospitality/vendor/subscription/preview
   * Pure read: takes a desired target state and returns the diff + cost.
   * Called by the Edit drawer's live cost preview (debounced client-side).
   */
  previewSubscriptionModification: async (req, res) => {
    try {
      const vendorId = req.user.id;
      const preview = await _computeModificationPreview(vendorId, req.body);
      if (preview.error) {
        return res.status(400).json({ status: 0, message: preview.error });
      }
      return res.status(200).json({ status: 1, data: preview.data });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * POST /api/v1/hospitality/vendor/subscription/modify
   * Applies the desired target state. Free path commits in a single tx and
   * sends a "Subscription Updated" email. Paid path creates a Razorpay order
   * whose metadata carries the diff; verifyPayment commits it on signature
   * validation.
   */
  modifySubscription: async (req, res) => {
    try {
      const vendorId = req.user.id;

      const companyDetails = await userModel.getCompanyDetail(vendorId);
      const isHospitalityVendor =
        companyDetails && companyDetails[0] &&
        (companyDetails[0].is_hospitality === 1 || companyDetails[0].is_hospitality === '1');
      if (!isHospitalityVendor) {
        return res.status(400).json({ status: 2, message: 'Hospitality subscription not applicable' });
      }

      const hasActiveSub = await hospitalityModel.hasValidPaidSubscription(vendorId);
      if (!hasActiveSub) {
        return res.status(400).json({
          status: 0,
          message: 'You need an active subscription to modify it. Please renew first.'
        });
      }

      const hasPending = await hospitalityModel.hasPendingModification(vendorId);
      if (hasPending) {
        return res.status(400).json({
          status: 0,
          message: 'A previous subscription modification is still pending. Please complete or wait for it to expire.'
        });
      }

      const preview = await _computeModificationPreview(vendorId, req.body);
      if (preview.error) {
        return res.status(400).json({ status: 0, message: preview.error });
      }
      const { diff, pricing, shared_end_date } = preview.data;

      const hasRemovals =
        diff.removed_categories.length > 0 ||
        diff.removed_hotels.length > 0;
      if (hasRemovals && req.body.confirm_removals !== true) {
        return res.status(400).json({
          status: 0,
          message: 'Removals require confirmation. Re-send with confirm_removals: true.'
        });
      }

      const netCost = pricing.net_cost;
      const addedCategoryNames = diff.added_categories.map(c => c.name);
      const addedSubcategoryNames = diff.added_subcategories.map(c => c.name);
      const addedHotelNames = diff.added_hotels.map(h => h.name);
      const removedCategoryNames = diff.removed_categories.map(c => c.name);
      const removedSubcategoryNames = [
        ...diff.removed_subcategories.map(c => c.name),
        ...diff.cascaded_subcategories.map(c => c.name)
      ];
      const removedHotelNames = diff.removed_hotels.map(h => h.name);

      const expiryDateFormatted = shared_end_date
        ? Moment(shared_end_date).format('MMMM DD, YYYY')
        : null;

      // ---------- FREE PATH (no charge) ----------
      if (netCost === 0) {
        const todayStr = Moment().format('YYYY-MM-DD');

        // Create a $0 payment record so the modification appears in payment history
        let freePaymentId = null;
        try {
          freePaymentId = await hospitalityModel.createVendorPayment({
            vendor_id: vendorId,
            razorpay_order_id: null,
            razorpay_payment_id: null,
            razorpay_signature: null,
            amount: 0,
            currency: 'INR',
            payment_status: 'success',
            metadata: {
              type: 'modification',
              shared_end_date,
              added_category_names: addedCategoryNames,
              added_subcategory_names: addedSubcategoryNames,
              added_hotel_names: addedHotelNames,
              removed_category_names: removedCategoryNames,
              removed_subcategory_names: removedSubcategoryNames,
              removed_hotel_names: removedHotelNames
            }
          });
        } catch (payErr) {
          logError('Free modification payment record creation failed (non-fatal):', payErr);
        }

        await db.tx(async t => {
          // Soft-cancel explicit removals
          const cancelIds = [
            ...diff.removed_categories.map(c => c.subscription_id),
            ...diff.removed_subcategories.map(c => c.subscription_id),
            ...diff.removed_hotels.map(h => h.subscription_id)
          ].filter(Boolean);
          if (cancelIds.length > 0) {
            await hospitalityModel.cancelSubscriptionItems(vendorId, cancelIds, { tx: t });
          }

          // Cascade-cancel sub-categories whose parent was removed (separate
          // call because we don't have their subscription_ids in `diff`).
          const parentIdsRemoved = diff.removed_categories.map(c => c.id);
          if (parentIdsRemoved.length > 0) {
            await hospitalityModel.cancelSubcategoriesByParentCategoryIds(
              vendorId, parentIdsRemoved, { tx: t }
            );
          }

          // Insert new rows (upsert via ON CONFLICT in the model). Added cats
          // keep their fee as "included in swap" — we store the nominal fee
          // so the history shows non-zero line items.
          const addRows = [];
          for (const cat of diff.added_categories) {
            addRows.push({
              vendor_id: vendorId,
              item_type: 'category',
              item_id: cat.id,
              fee_amount: 0, // free path — no money moved
              start_date: todayStr,
              end_date: shared_end_date,
              status: 'active',
              payment_id: null
            });
          }
          for (const sc of diff.added_subcategories) {
            addRows.push({
              vendor_id: vendorId,
              item_type: 'subcategory',
              item_id: sc.id,
              fee_amount: 0,
              start_date: todayStr,
              end_date: shared_end_date,
              status: 'active',
              payment_id: null
            });
          }
          for (const h of diff.added_hotels) {
            addRows.push({
              vendor_id: vendorId,
              item_type: 'hotel',
              item_id: h.id,
              fee_amount: 0,
              start_date: todayStr,
              end_date: shared_end_date,
              status: 'active',
              payment_id: null
            });
          }
          if (addRows.length > 0) {
            const columnSet = new pgp.helpers.ColumnSet(
              ['vendor_id', 'item_type', 'item_id', 'fee_amount',
               'start_date', 'end_date', 'status', 'payment_id'],
              { table: 'tbl_vendor_hotel_category_subscription' }
            );
            const query =
              pgp.helpers.insert(addRows, columnSet) +
              ` ON CONFLICT (vendor_id, item_type, item_id, end_date)
                DO UPDATE SET
                  fee_amount = EXCLUDED.fee_amount,
                  start_date = EXCLUDED.start_date,
                  status = 'active',
                  payment_id = EXCLUDED.payment_id,
                  cancelled_at = NULL,
                  cancelled_by = NULL`;
            await t.none(query);
          }
        });

        // Auto-map product variants for newly added categories (free path)
        const addedCatIdsForMapping = diff.added_categories
          .map(c => c.id)
          .concat(diff.added_subcategories.map(s => s.id));
        if (addedCatIdsForMapping.length > 0) {
          try {
            await _autoMapProductsForCategories(vendorId, addedCatIdsForMapping);
          } catch (mapErr) {
            logError('Product mapping after free modification failed (non-fatal):', mapErr);
          }
        }

        // Unmap product variants for removed categories (free path)
        const removedCatIdsForUnmap = diff.removed_categories
          .map(c => c.id)
          .concat(diff.removed_subcategories.map(s => s.id))
          .concat(diff.cascaded_subcategories.map(s => s.id));
        if (removedCatIdsForUnmap.length > 0) {
          try {
            await _unmapProductsForCategories(vendorId, removedCatIdsForUnmap);
          } catch (mapErr) {
            logError('Product unmapping after free modification failed (non-fatal):', mapErr);
          }
        }

        // Fire-and-forget email (never fails the response)
        try {
          await _sendSubscriptionConfirmationEmail({
            kind: 'modification_free',
            userId: vendorId,
            totalAmount: 0,
            expiryDateFormatted,
            addedCategories: addedCategoryNames,
            addedSubcategories: addedSubcategoryNames,
            addedHotels: addedHotelNames,
            removedCategories: removedCategoryNames,
            removedSubcategories: removedSubcategoryNames,
            removedHotels: removedHotelNames
          });
        } catch (emailErr) {
          logError('Free modification email failed:', emailErr);
        }

        return res.status(200).json({
          status: 1,
          data: {
            requires_payment: false,
            applied: true,
            summary: {
              added_categories: diff.added_categories,
              added_subcategories: diff.added_subcategories,
              added_hotels: diff.added_hotels,
              removed_categories: diff.removed_categories,
              removed_subcategories: diff.removed_subcategories,
              removed_hotels: diff.removed_hotels,
              cascaded_subcategories: diff.cascaded_subcategories
            },
            shared_end_date,
            expiry_date: expiryDateFormatted
          }
        });
      }

      // ---------- PAID PATH (Razorpay order) ----------
      // Build the list of new subscription rows that will be persisted only
      // after the payment is verified. We compute per-row fee_amount so the
      // invoice line items are faithful to the pricing formula.
      const addSubscriptionItems = [];
      const newTotalHotelsCount =
        preview.data.current.hotels.length
        + diff.added_hotels.length
        - diff.removed_hotels.length;

      for (const cat of diff.added_categories) {
        const effectiveFee = (cat.fee_amount || 0) * (newTotalHotelsCount || 1);
        addSubscriptionItems.push({
          item_type: 'category',
          item_id: cat.id,
          item_name: cat.name,
          fee_amount: effectiveFee
        });
      }
      for (const sc of diff.added_subcategories) {
        addSubscriptionItems.push({
          item_type: 'subcategory',
          item_id: sc.id,
          item_name: sc.name,
          fee_amount: 0
        });
      }
      for (const h of diff.added_hotels) {
        // Per hotel: all surviving categories must cover it. We already
        // baked that into `pricing.cost_added_hotels`; at the row level we
        // store 0 so the hotel line shows as included.
        addSubscriptionItems.push({
          item_type: 'hotel',
          item_id: h.id,
          item_name: h.name,
          fee_amount: 0
        });
      }
      // When hotels are added, the "cost for added hotels" covers surviving
      // categories × added hotel count. We fold this into the FIRST added
      // hotel row so the total reconciles to net_cost. If no hotels were
      // added but the swap-credited categories still contribute, this is
      // already in cost_added_cats on the category rows above.
      if (diff.added_hotels.length > 0 && pricing.cost_added_hotels > 0) {
        addSubscriptionItems.find(r => r.item_type === 'hotel').fee_amount =
          pricing.cost_added_hotels;
      }

      const cancelSubscriptionIds = [
        ...diff.removed_categories.map(c => c.subscription_id),
        ...diff.removed_subcategories.map(c => c.subscription_id),
        ...diff.removed_hotels.map(h => h.subscription_id)
      ].filter(Boolean);

      const digit = convertSixDigit(vendorId);
      const razorpay = new Razorpay({
        key_id: Config.razorpay.razorpay_key,
        key_secret: Config.razorpay.razorpay_secret
      });
      const razorpayOrder = await razorpay.orders.create({
        amount: Math.round(netCost * 100),
        currency: 'INR',
        receipt: `MOD${digit}`,
        payment_capture: 1
      });

      await hospitalityModel.createVendorPayment({
        vendor_id: vendorId,
        razorpay_order_id: razorpayOrder.id,
        razorpay_payment_id: null,
        razorpay_signature: null,
        amount: netCost,
        currency: 'INR',
        payment_status: 'created',
        metadata: {
          type: 'modification',
          shared_end_date,
          add_subscription_items: addSubscriptionItems,
          cancel_subscription_ids: cancelSubscriptionIds,
          cascade_parent_category_ids: diff.removed_categories.map(c => c.id),
          added_category_names: addedCategoryNames,
          added_subcategory_names: addedSubcategoryNames,
          added_hotel_names: addedHotelNames,
          removed_category_names: removedCategoryNames,
          removed_subcategory_names: removedSubcategoryNames,
          removed_hotel_names: removedHotelNames
        }
      });

      return res.status(200).json({
        status: 1,
        data: {
          requires_payment: true,
          order_id: razorpayOrder.id,
          amount: netCost,
          currency: 'INR',
          shared_end_date,
          expiry_date: expiryDateFormatted,
          diff
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * GET /api/v1/hospitality/vendor/subscription/payment-history
   * Paginated list of the vendor's past paid subscriptions (registration,
   * renewals, modifications) with per-payment item breakdowns.
   */
  getVendorPaymentHistoryPaginated: async (req, res) => {
    try {
      const vendorId = req.user.id;
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
      const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
      const rows = await hospitalityModel.getVendorPaymentHistory(vendorId, { limit, offset });
      return res.status(200).json({ status: 1, data: rows });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * POST /api/v1/hospitality/vendor/subscription/extend
   * Extends the current active subscription by 1 more financial year.
   * New end_date = current end_date + 1 year (next March 31).
   * Charges the same category × hotels pricing for the extension period.
   */
  extendSubscription: async (req, res) => {
    try {
      const vendorId = req.user.id;

      const companyDetails = await userModel.getCompanyDetail(vendorId);
      const isHospitalityVendor =
        companyDetails && companyDetails[0] &&
        (companyDetails[0].is_hospitality === 1 || companyDetails[0].is_hospitality === '1');
      if (!isHospitalityVendor) {
        return res.status(400).json({ status: 2, message: 'Hospitality subscription not applicable' });
      }

      const hasActiveSub = await hospitalityModel.hasValidPaidSubscription(vendorId);
      if (!hasActiveSub) {
        return res.status(400).json({
          status: 0,
          message: 'No active subscription to extend. Please renew instead.'
        });
      }

      const current = await hospitalityModel.getActiveSubscriptionItemsForVendor(vendorId);
      if (!current.shared_end_date || !current.categories.length) {
        return res.status(400).json({
          status: 0,
          message: 'Unable to determine current subscription details.'
        });
      }

      // New end_date: current end_date + 1 year
      const currentEnd = Moment(current.shared_end_date);
      const newEnd = currentEnd.clone().add(1, 'year');
      // Snap to March 31 of the resulting year
      const newEndYear = newEnd.month() >= 3 ? newEnd.year() + 1 : newEnd.year();
      const newEndDate = Moment(`${newEndYear}-03-31`, 'YYYY-MM-DD');
      const newEndDateStr = newEndDate.format('YYYY-MM-DD');
      const newStartDateStr = currentEnd.clone().add(1, 'day').format('YYYY-MM-DD');

      // Calculate pricing: same categories × same hotels
      const numHotels = current.hotels.length || 1;
      let totalAmount = 0;
      const subscriptionRows = [];

      const catIds = current.categories.map(c => c.id);
      const dbCategories = await productModel.getCategoriesByIds(catIds);

      for (const row of dbCategories) {
        const baseFee = row.fee_amount || 500;
        const effectiveFee = baseFee * numHotels;
        totalAmount += effectiveFee;
        subscriptionRows.push({
          item_type: 'category',
          item_id: row.id,
          item_name: row.title || row.name,
          fee_amount: effectiveFee
        });
      }

      // Sub-categories (free)
      for (const sc of current.subcategories) {
        subscriptionRows.push({
          item_type: 'subcategory',
          item_id: sc.id,
          item_name: sc.name,
          fee_amount: 0
        });
      }

      // Hotels (fee stored as 0)
      for (const h of current.hotels) {
        subscriptionRows.push({
          item_type: 'hotel',
          item_id: h.id,
          item_name: h.name,
          fee_amount: 0
        });
      }

      if (totalAmount <= 0) {
        return res.status(400).json({ status: 0, message: 'Unable to calculate extension cost.' });
      }

      const digit = convertSixDigit(vendorId);
      const razorpay = new Razorpay({
        key_id: Config.razorpay.razorpay_key,
        key_secret: Config.razorpay.razorpay_secret
      });
      const razorpayOrder = await razorpay.orders.create({
        amount: Math.round(totalAmount * 100),
        currency: 'INR',
        receipt: `EXT${digit}`,
        payment_capture: 1
      });

      // Store as renewal-type metadata so verifyPayment's existing path handles it
      await hospitalityModel.createVendorPayment({
        vendor_id: vendorId,
        razorpay_order_id: razorpayOrder.id,
        razorpay_payment_id: null,
        razorpay_signature: null,
        amount: totalAmount,
        currency: 'INR',
        payment_status: 'created',
        metadata: {
          kind: 'extension',
          subscription_items: subscriptionRows.map(r => ({
            vendor_id: vendorId,
            item_type: r.item_type,
            item_id: r.item_id,
            fee_amount: r.fee_amount,
            start_date: newStartDateStr,
            end_date: newEndDateStr,
            status: 'active'
          })),
          fy_end_date: newEndDateStr
        }
      });

      return res.status(200).json({
        status: 1,
        data: {
          order_id: razorpayOrder.id,
          amount: totalAmount,
          currency: 'INR',
          current_end_date: current.shared_end_date,
          new_end_date: newEndDateStr,
          categories: catIds,
          hotels: current.hotels.map(h => h.id)
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * GET /api/v1/hospitality/vendor/subscription/download/:paymentId
   * On-demand PDF generation for a past payment. Query param `type` controls
   * which document: "invoice" (Tax Invoice) or "receipt" (Payment Received).
   * Streams the PDF directly as a download.
   */
  downloadPaymentDocument: async (req, res) => {
    try {
      const vendorId = req.user.id;
      const paymentId = parseInt(req.params.paymentId, 10);
      const docType = req.query.type || 'invoice'; // 'invoice' | 'receipt'

      if (!paymentId || isNaN(paymentId)) {
        return res.status(400).json({ status: 0, message: 'Invalid payment ID' });
      }

      // Verify the payment belongs to the requesting vendor
      const payment = await db.oneOrNone(
        `SELECT * FROM tbl_vendor_payments
         WHERE id = $1 AND vendor_id = $2 AND payment_status IN ('paid', 'success')`,
        [paymentId, vendorId]
      );

      if (!payment) {
        return res.status(404).json({ status: 0, message: 'Payment not found' });
      }

      const companyDetail = await userModel.getCompanyDetail(vendorId);
      const company = companyDetail && companyDetail.length > 0 ? companyDetail[0] : {};
      const recipientName = company?.organization_name || company?.name || 'Vendor';

      let parsedMeta = null;
      try {
        parsedMeta = typeof payment.metadata === 'string'
          ? JSON.parse(payment.metadata) : payment.metadata;
      } catch (_) {}

      const isModification = parsedMeta?.type === 'modification';
      const isExtension = parsedMeta?.kind === 'extension';
      const isRenewal = payment.receipt?.startsWith('RNW');
      const description = isModification
        ? 'Hospitality Vendor Subscription Modification'
        : isExtension
        ? 'Hospitality Vendor Subscription Extension'
        : isRenewal
        ? 'Hospitality Vendor Subscription Renewal'
        : 'Hospitality Vendor Registration';

      let result;
      if (docType === 'receipt') {
        result = await generatePaymentReceivedPdf({
          recipientName,
          amount: parseFloat(payment.amount) || 0,
          paymentId: payment.razorpay_payment_id,
          orderId: payment.razorpay_order_id,
          description
        });
      } else {
        result = await generateTaxInvoicePdf({
          recipientName,
          amount: parseFloat(payment.amount) || 0,
          paymentId: payment.razorpay_payment_id,
          orderId: payment.razorpay_order_id,
          receipt: payment.receipt,
          description
        });
      }

      if (!result || !result.filePath || !fs.existsSync(result.filePath)) {
        return res.status(500).json({ status: 0, message: 'Failed to generate document' });
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      const stream = fs.createReadStream(result.filePath);
      stream.pipe(res);
      stream.on('end', () => {
        // Clean up temp file after sending
        try { fs.unlinkSync(result.filePath); } catch (_) {}
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // ============================================================
  // WH-67: Auto-add vendors to open RFQs after registration
  // ============================================================

  /**
   * GET /api/v1/hospitality/vendor/matching-open-rfqs
   * Returns open RFQs the vendor is eligible for but not yet added to.
   */
  getMatchingOpenRfqs: async (req, res) => {
    try {
      const vendorId = req.user.id;
      const rfqs = await hospitalityModel.getMatchingOpenRfqsForVendor(vendorId);
      return res.status(200).json({ status: 1, data: { rfqs } });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * POST /api/v1/hospitality/vendor/join-open-rfqs
   * Adds the vendor to selected open RFQs, generates tokens, and sends emails.
   * Body: { rfq_ids: [1, 2, 3] }
   */
  joinOpenRfqs: async (req, res) => {
    try {
      const vendorId = req.user.id;
      const { rfq_ids } = req.body;

      if (!Array.isArray(rfq_ids) || rfq_ids.length === 0) {
        return res.status(400).json({ status: 0, message: 'rfq_ids must be a non-empty array' });
      }

      const rfqIds = [...new Set(rfq_ids.map(Number).filter(n => !isNaN(n)))];
      if (rfqIds.length === 0) {
        return res.status(400).json({ status: 0, message: 'No valid RFQ IDs provided' });
      }

      // Batch-fetch: vendor details + all open RFQs in one go
      const [vendorUser, openRfqs] = await Promise.all([
        db.oneOrNone(`SELECT id, name, email FROM tbl_users WHERE id = $1`, [vendorId]),
        db.any(
          `SELECT id, rfq_no, title, is_tender, bid_end_date, created_by
           FROM tbl_rfq
           WHERE id = ANY($1::int[])
             AND status = 1 AND is_published = 1
             AND bid_end_date::timestamp > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')`,
          [rfqIds]
        )
      ]);

      if (!vendorUser) {
        return res.status(404).json({ status: 0, message: 'Vendor not found' });
      }
      if (!openRfqs.length) {
        return res.status(200).json({ status: 1, message: 'No open RFQs to join', data: { joined_count: 0, rfqs: [] } });
      }

      // Insert vendor into all RFQs in parallel
      const insertResults = await Promise.all(
        openRfqs.map(rfq => hospitalityModel.addVendorToRfq(vendorId, rfq.id))
      );

      // Collect joined RFQs and product variant IDs
      const joinedRfqs = [];
      const allVariantIds = new Set();
      const rfqProductMap = new Map(); // rfq index → inserted products

      openRfqs.forEach((rfq, i) => {
        const inserted = insertResults[i] || [];
        if (inserted.length > 0) {
          joinedRfqs.push({ rfq, inserted });
          inserted.forEach(p => allVariantIds.add(p.product_variant_id));
          rfqProductMap.set(i, inserted);
        }
      });

      if (joinedRfqs.length === 0) {
        return res.status(200).json({ status: 1, message: 'Already added to all RFQs', data: { joined_count: 0, rfqs: [] } });
      }

      // Batch-fetch: product names + creator details + generate tokens in parallel
      const creatorIds = [...new Set(joinedRfqs.map(j => j.rfq.created_by))];
      const [productNames, creators, ...tokens] = await Promise.all([
        db.any(
          `SELECT DISTINCT id, COALESCE(name, '') AS name FROM tbl_product_variant WHERE id = ANY($1::int[])`,
          [[...allVariantIds]]
        ),
        db.any(`SELECT id, name, email FROM tbl_users WHERE id = ANY($1::int[])`, [creatorIds]),
        ...joinedRfqs.map(j =>
          rfqModel.insertVendorRfqToken(vendorId, j.rfq.rfq_no).catch(() => null)
        )
      ]);

      const productNameMap = new Map(productNames.map(p => [p.id, p.name]));
      const creatorMap = new Map(creators.map(c => [c.id, c]));

      // Respond immediately — send emails fire-and-forget
      const responseRfqs = joinedRfqs.map((j, i) => ({
        rfq_id: j.rfq.id,
        rfq_no: j.rfq.rfq_no,
        title: j.rfq.title,
        products_added: j.inserted.length
      }));

      res.status(200).json({
        status: 1,
        message: `Successfully joined ${joinedRfqs.length} RFQ(s)`,
        data: { joined_count: joinedRfqs.length, rfqs: responseRfqs }
      });

      // Fire-and-forget: send consolidated emails in background
      setImmediate(() => {
        try {
          // 1 email to vendor with ALL joined RFQs
          const vendorRfqList = joinedRfqs.map((j, i) => {
            const names = [...new Set(j.inserted.map(p => productNameMap.get(p.product_variant_id)).filter(Boolean))];
            const creator = creatorMap.get(j.rfq.created_by);
            return {
              rfq_id: j.rfq.id, rfq_no: j.rfq.rfq_no, is_tender: j.rfq.is_tender,
              title: j.rfq.title, bid_end_date: j.rfq.bid_end_date,
              token: tokens[i], buyerName: creator?.name || 'Buyer', products: names
            };
          });

          sendVendorBulkRfqJoinNotification({
            vendor_name: vendorUser.name,
            vendor_email: vendorUser.email,
            rfqs: vendorRfqList
          }).catch(() => {});

          // 1 email per creator with all THEIR affected RFQs
          const creatorRfqMap = new Map();
          for (let i = 0; i < joinedRfqs.length; i++) {
            const { rfq, inserted } = joinedRfqs[i];
            const creator = creatorMap.get(rfq.created_by);
            if (!creator) continue;
            if (!creatorRfqMap.has(creator.id)) creatorRfqMap.set(creator.id, { creator, rfqs: [] });
            const names = [...new Set(inserted.map(p => productNameMap.get(p.product_variant_id)).filter(Boolean))];
            creatorRfqMap.get(creator.id).rfqs.push({
              rfq_id: rfq.id, rfq_no: rfq.rfq_no, is_tender: rfq.is_tender,
              title: rfq.title, product_names: names
            });
          }

          for (const { creator, rfqs: creatorRfqs } of creatorRfqMap.values()) {
            sendVendorAutoAddedToRfqNotification({
              creator_email: creator.email,
              creator_name: creator.name,
              rfqs: creatorRfqs
            }).catch(() => {});
          }
        } catch (err) {
          logError('[WH-67] Background email error:', err);
        }
      });

      return;
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  }

};

// ============================================================
// WH-74: Preview computation (shared between preview + modify endpoints)
// Re-runs server-side on modify so clients can't inject a stale net_cost.
// ============================================================
const _computeModificationPreview = async (vendorId, body) => {
  const targetCategoryIds = Array.isArray(body?.target_categories)
    ? [...new Set(body.target_categories.map(Number).filter(n => !isNaN(n)))]
    : [];
  const targetSubcategoryIds = Array.isArray(body?.target_subcategories)
    ? [...new Set(body.target_subcategories.map(Number).filter(n => !isNaN(n)))]
    : [];
  const targetHotelIds = Array.isArray(body?.target_hotels)
    ? [...new Set(body.target_hotels.map(Number).filter(n => !isNaN(n)))]
    : [];

  if (targetCategoryIds.length === 0) {
    return { error: 'At least one category is required.' };
  }
  if (targetHotelIds.length === 0) {
    return { error: 'At least one business unit (hotel) is required.' };
  }

  const current = await hospitalityModel.getActiveSubscriptionItemsForVendor(vendorId);
  if (!current.shared_end_date) {
    return { error: 'No active subscription found to modify.' };
  }

  // Validate sub-cat parents must be present in target cats
  if (targetSubcategoryIds.length > 0) {
    const subMeta = await db.any(
      `SELECT id, title, parent_id, fee_amount
       FROM tbl_category
       WHERE id = ANY($1::int[]) AND is_deleted = 0 AND parent_id IS NOT NULL`,
      [targetSubcategoryIds]
    );
    if (subMeta.length !== targetSubcategoryIds.length) {
      return { error: 'One or more selected sub-categories are no longer available.' };
    }
    const orphan = subMeta.find(sc => !targetCategoryIds.includes(sc.parent_id));
    if (orphan) {
      return {
        error: `Sub-category "${orphan.title}" requires its parent category to be in the subscription.`
      };
    }
  }

  // Fetch full metadata for target categories (names + fees)
  const catMeta = await db.any(
    `SELECT id, title AS name, COALESCE(fee_amount, 500) AS fee_amount
     FROM tbl_category
     WHERE id = ANY($1::int[]) AND is_deleted = 0 AND (parent_id IS NULL OR parent_id = 0)`,
    [targetCategoryIds]
  );
  if (catMeta.length !== targetCategoryIds.length) {
    return { error: 'One or more selected categories are no longer available.' };
  }

  // Fetch full metadata for target hotels
  const hotelMeta = await db.any(
    `SELECT id, name, city, hospitality_company_id
     FROM tbl_hospitality_company_hotels
     WHERE id = ANY($1::int[]) AND is_deleted = 0`,
    [targetHotelIds]
  );
  if (hotelMeta.length !== targetHotelIds.length) {
    return { error: 'One or more selected business units are no longer available.' };
  }

  // Sub-category metadata (names for diff labels)
  let subMetaFull = [];
  if (targetSubcategoryIds.length > 0) {
    subMetaFull = await db.any(
      `SELECT id, title AS name, parent_id
       FROM tbl_category
       WHERE id = ANY($1::int[])`,
      [targetSubcategoryIds]
    );
  }

  const currentCatIds = current.categories.map(c => c.id);
  const currentSubIds = current.subcategories.map(c => c.id);
  const currentHotelIds = current.hotels.map(h => h.id);

  const addedCategoryIds = targetCategoryIds.filter(id => !currentCatIds.includes(id));
  const removedCategoryIds = currentCatIds.filter(id => !targetCategoryIds.includes(id));
  const addedSubIds = targetSubcategoryIds.filter(id => !currentSubIds.includes(id));
  const removedSubIds = currentSubIds.filter(id => !targetSubcategoryIds.includes(id));
  const addedHotelIds = targetHotelIds.filter(id => !currentHotelIds.includes(id));
  const removedHotelIds = currentHotelIds.filter(id => !targetHotelIds.includes(id));

  const addedCats = addedCategoryIds.map(id => {
    const row = catMeta.find(c => c.id === id);
    return { id, name: row.name, fee_amount: parseFloat(row.fee_amount) || 0 };
  });
  const removedCats = removedCategoryIds.map(id => {
    const cur = current.categories.find(c => c.id === id);
    return {
      id,
      name: cur?.name,
      fee_amount: cur?.fee_amount || 0,
      subscription_id: cur?.subscription_id
    };
  });
  const survivingCats = current.categories.filter(c => !removedCategoryIds.includes(c.id));

  const addedSubs = addedSubIds.map(id => {
    const row = subMetaFull.find(c => c.id === id) || {};
    return { id, name: row.name, parent_id: row.parent_id };
  });
  const removedSubs = removedSubIds.map(id => {
    const cur = current.subcategories.find(c => c.id === id);
    return { id, name: cur?.name, subscription_id: cur?.subscription_id };
  });

  // Cascade: any current sub-cat whose parent was removed gets cascaded
  // regardless of whether the user explicitly listed it in target_subcategories.
  const cascadedSubs = current.subcategories
    .filter(sc => removedCategoryIds.includes(sc.parent_id))
    .filter(sc => !removedSubIds.includes(sc.id))
    .map(sc => ({
      id: sc.id,
      name: sc.name,
      subscription_id: sc.subscription_id,
      parent_id: sc.parent_id
    }));

  const addedHotels = addedHotelIds.map(id => {
    const row = hotelMeta.find(h => h.id === id);
    return { id, name: row.name, city: row.city };
  });
  const removedHotels = removedHotelIds.map(id => {
    const cur = current.hotels.find(h => h.id === id);
    return {
      id,
      name: cur?.name,
      subscription_id: cur?.subscription_id
    };
  });

  // Pricing formula (from plan)
  const newTotalHotelsCount =
    currentHotelIds.length + addedHotelIds.length - removedHotelIds.length;

  const sumFee = (list) => list.reduce((s, x) => s + (x.fee_amount || 0), 0);
  const cost_added_cats = sumFee(addedCats) * newTotalHotelsCount;
  const cost_added_hotels = sumFee(survivingCats) * addedHotelIds.length;
  const additions_cost = cost_added_cats + cost_added_hotels;

  // No swap credit — removals do not offset the cost of new additions.
  // Vendors must pay full price for every new category/hotel regardless
  // of what they remove, to prevent the loophole of rotating categories
  // within a financial year without paying.
  const swap_credit_cats = 0;
  const swap_credit_hotels = 0;
  const swap_credit = 0;

  const net_cost = Math.max(0, additions_cost);

  const warnings = [];
  if (removedCategoryIds.length > 0 || removedHotelIds.length > 0) {
    warnings.push('Removals do not earn refunds or credits. New categories are charged separately at full price');
  }
  if (cascadedSubs.length > 0) {
    warnings.push(
      `Removing ${removedCategoryIds.length} parent categor${removedCategoryIds.length === 1 ? 'y' : 'ies'} will also cancel ${cascadedSubs.length} linked sub-categor${cascadedSubs.length === 1 ? 'y' : 'ies'}.`
    );
  }
  if (addedSubIds.length > 0 || removedSubIds.length > 0) {
    warnings.push('Sub-category changes are always free.');
  }

  return {
    data: {
      current: {
        categories: current.categories.map(c => ({ id: c.id, name: c.name, fee_amount: c.fee_amount })),
        subcategories: current.subcategories.map(c => ({ id: c.id, name: c.name, parent_id: c.parent_id })),
        hotels: current.hotels.map(h => ({ id: h.id, name: h.name }))
      },
      target: {
        categories: targetCategoryIds,
        subcategories: targetSubcategoryIds,
        hotels: targetHotelIds
      },
      diff: {
        added_categories: addedCats,
        removed_categories: removedCats,
        added_subcategories: addedSubs,
        removed_subcategories: removedSubs,
        cascaded_subcategories: cascadedSubs,
        added_hotels: addedHotels,
        removed_hotels: removedHotels
      },
      pricing: {
        cost_added_cats,
        cost_added_hotels,
        additions_cost,
        swap_credit_cats,
        swap_credit_hotels,
        swap_credit,
        net_cost,
        currency: 'INR',
        existing_hotels_count: currentHotelIds.length,
        new_total_hotels_count: newTotalHotelsCount
      },
      warnings,
      shared_end_date: current.shared_end_date,
      earliest_start_date: current.earliest_start_date
    }
  };
};

// ============================================================
// WH-74: Commit a modification from payment metadata. Called from
// verifyPayment when metadata.type === 'modification'.
// ============================================================
const _applyModificationFromMetadata = async (payment, t) => {
  const metadata = typeof payment.metadata === 'string'
    ? JSON.parse(payment.metadata)
    : payment.metadata;
  if (!metadata || metadata.type !== 'modification') return null;

  const vendorId = payment.vendor_id;
  const todayStr = Moment().format('YYYY-MM-DD');
  const sharedEnd = metadata.shared_end_date;

  // 1. Soft-cancel explicit removals
  if (Array.isArray(metadata.cancel_subscription_ids) && metadata.cancel_subscription_ids.length > 0) {
    await hospitalityModel.cancelSubscriptionItems(
      vendorId, metadata.cancel_subscription_ids, { tx: t }
    );
  }

  // 2. Cascade-cancel children of removed parents
  if (Array.isArray(metadata.cascade_parent_category_ids) && metadata.cascade_parent_category_ids.length > 0) {
    await hospitalityModel.cancelSubcategoriesByParentCategoryIds(
      vendorId, metadata.cascade_parent_category_ids, { tx: t }
    );
  }

  // 3. Insert/upsert additions
  const addItems = Array.isArray(metadata.add_subscription_items)
    ? metadata.add_subscription_items
    : [];
  if (addItems.length > 0) {
    const addRows = addItems.map(item => ({
      vendor_id: vendorId,
      item_type: item.item_type,
      item_id: item.item_id,
      fee_amount: item.fee_amount || 0,
      start_date: todayStr,
      end_date: sharedEnd,
      status: 'active',
      payment_id: payment.id
    }));
    const columnSet = new pgp.helpers.ColumnSet(
      ['vendor_id', 'item_type', 'item_id', 'fee_amount',
       'start_date', 'end_date', 'status', 'payment_id'],
      { table: 'tbl_vendor_hotel_category_subscription' }
    );
    const query =
      pgp.helpers.insert(addRows, columnSet) +
      ` ON CONFLICT (vendor_id, item_type, item_id, end_date)
        DO UPDATE SET
          fee_amount = EXCLUDED.fee_amount,
          start_date = EXCLUDED.start_date,
          status = 'active',
          payment_id = EXCLUDED.payment_id,
          cancelled_at = NULL,
          cancelled_by = NULL`;
    await t.none(query);
  }

  // 4. Auto-map product variants for newly added categories
  const addedCatIds = addItems
    .filter(r => r.item_type === 'category' || r.item_type === 'subcategory')
    .map(r => r.item_id);
  if (addedCatIds.length > 0) {
    try {
      await _autoMapProductsForCategories(vendorId, addedCatIds);
    } catch (mapErr) {
      logError('Product mapping after modification failed (non-fatal):', mapErr);
    }
  }

  // 5. Unmap product variants for removed categories
  const removedCatIds = [
    ...(Array.isArray(metadata.cancel_subscription_ids) ? [] : []),
    ...(Array.isArray(metadata.cascade_parent_category_ids) ? metadata.cascade_parent_category_ids : [])
  ];
  // We need the actual category IDs that were removed — extract from the
  // subscription items that were cancelled. The metadata stores the
  // subscription row IDs, not the category IDs directly. But we also have
  // the category names lists. Let's use the cancel_subscription_ids to look
  // up what was cancelled, or more simply use the removed category names to
  // find their IDs. The simplest: use cascade_parent_category_ids (those are
  // the parent category IDs that were removed) plus any explicitly removed
  // category/subcategory item_ids from the add_subscription_items inverse.
  // Actually, the metadata doesn't store removed item_ids directly. Let's
  // query what was just cancelled.
  try {
    const cancelledRows = await db.any(
      `SELECT item_id, item_type FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND status = 'cancelled'
         AND cancelled_at >= NOW() - INTERVAL '1 minute'
         AND item_type IN ('category', 'subcategory')`,
      [vendorId]
    );
    const cancelledCatIds = cancelledRows.map(r => r.item_id);
    if (cancelledCatIds.length > 0) {
      await _unmapProductsForCategories(vendorId, cancelledCatIds);
    }
  } catch (mapErr) {
    logError('Product unmapping after modification failed (non-fatal):', mapErr);
  }

  return {
    sharedEnd,
    addedCategoryNames: metadata.added_category_names || [],
    addedSubcategoryNames: metadata.added_subcategory_names || [],
    addedHotelNames: metadata.added_hotel_names || [],
    removedCategoryNames: metadata.removed_category_names || [],
    removedSubcategoryNames: metadata.removed_subcategory_names || [],
    removedHotelNames: metadata.removed_hotel_names || []
  };
};

export default HospitalityController;

