import Config from '../../config/app.config.js';
import { logger } from '../../util/logger.js';
import {
  logError,
  sendMail,
  getDateRange,
  withTransaction,
  validateNumber,
  generateSignature,
  PERSISTENCE_STATUSES,
  normalizeErrors
} from '../../helper/common.js';
import rfqModel from '../../models/rfqModel.js';
import { shapeRfqLifecycle } from '../../models/rfq/rfqLifecycleShaper.js';
import userModel from '../../models/userModel.js';
import { sendNotification, dispatch as dispatchNotification } from '../../services/notificationService.js';
import excelJS from 'exceljs';
import xlsx from 'xlsx';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import vendorModel from '../../models/vendorModel.js';
import projectModel from '../../models/projectModel.js';
import hospitalityModel from '../../models/hospitalityModel.js';
import whatsappNotificationAISensy from '../../helper/whatsappNotificationAISensy.js';
import { generateEmailTemplate, getRfqEmailContent, RFQ_EMAIL_TYPE } from '../../helper/notificationEmailLayout.js';
import fs from 'fs';
import productModel from '../../models/productModel.js';
import generativeAI, { extractDatasheetSummary } from '../../helper/processBOQWithAI.js';
import db from '../../config/dbConn.js';
import puppeteer from 'puppeteer';
import { raSchedulerForBuyer, raSchedulerForVendor  } from '../../helper/sendEmailFunctions/raEmailScheduler.js';
import generalModel, { createApprovalInstance, recordLifecycleEvent, getApprovalInstancesByEntity, getApprovalInstanceById, cancelApprovalInstance, getApprovalWorkflowUsers, getRfqIdsWithPendingApprovals } from '../../models/generalModel.js';
import rfqHistoryModel from '../../models/rfqHistoryModel.js';
import {
  assertEditAllowed,
  assertEditDateConstraints,
  assertProductQuantityAndUnit,
  diffRfqSnapshot,
  applyRfqFieldChanges,
  applyProductChanges,
  applyTermsChanges,
  applyTermFileChanges,
  httpError as updateHttpError
} from './rfqUpdateHelpers.js';
import { cancelAndReissueApproval } from '../general/reapprovalService.js';
import { v4 as uuidv4 } from 'uuid';
import { executeApprovalAction } from '../../services/approvalActionService.js';
import moment from 'moment-timezone';
import { deleteSchedule } from '../../helper/createSchedule.js';
import { scheduleRfqPublish } from '../../helper/cronManager.js';
import { draftPO, buildAuthoritativePOPayload } from '../po/purchaseOrderController.js';
import { sendApprovalNotification } from '../po/purchaseOrderEmails.js';
import UsersController from '../users/usersController.js';
import { summaries } from '../../util/constants.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import negotiationModel from '../../models/negotiationModel.js';
import rbacModel from '../../models/rbacModel.js';
import { sendTechEvalCompletionNotification, sendVendorTechAcceptanceNotification } from '../../helper/sendEmailFunctions/techEvalEmails.js';
import { sendTenderFeePaymentConfirmation } from '../../helper/sendEmailFunctions/tenderFeeEmails.js';
import { sendRfqCreationNotification, sendRfqReadyToPublishNotification, sendRfqPublishedNotification, sendVendorRfqNotification, sendRfqClosedHeadsUpNotification, sendApprovalCancelledNotification } from '../../helper/sendEmailFunctions/approvalEmails.js';
import {
  buildQuoteVisibilityMeta,
  createQuoteVisibilityError,
  sanitizeQuoteProductsForLockedState,
} from '../../helper/quoteVisibility.js';
import pricingEngine from '../../services/pricingEngine.js';
import { enrichQuoteCompareData } from '../../services/quoteCompareService.js';
import quoteCompareViewModel from '../../models/quoteCompareViewModel.js';
import { deriveScope as deriveQcScope } from '../po/poDashboardController.js';

const REMINDER_SEND_YIELD_THRESHOLD = 20;
const yieldReminderEventLoop = () =>
  new Promise((resolve) => setImmediate(resolve));

const VENDORS_FILTER_KEYS = [
  'vendor_approved_by',
  'state',
  'city',
  'country',
  'turnOver',
  'vendor_type',
  'prev_worked_with',
  'vendor_name',
  'vendor_info',
  'productMakes',
  'subscription_type',
];

const getQuoteVisibilityForRfq = async (rfq_id) => {
  const rfqDetails = await rfqModel.getRfqDetailsById(rfq_id);
  const quoteVisibility = buildQuoteVisibilityMeta(rfqDetails);
  return { rfqDetails, quoteVisibility };
};

/**
 * Helper function to get project member emails for an RFQ
 * @param {number} rfq_id - The RFQ ID to get project members for
 * @returns {Promise<string[]>} - Array of project member email addresses
 */
const getProjectMemberEmailsForRFQ = async (rfq_id) => {
  try {
    // Get the RFQ details to find the project_id
    const rfqDetails = await rfqModel.getRFQDetails(rfq_id);
    if (!rfqDetails || rfqDetails.length === 0 || !rfqDetails[0].project_id) {
      return [];
    }

    const project_id = rfqDetails[0].project_id;

    // Get project team members
    const teamMembers = await projectModel.getProjectTeamMembers(project_id);
    if (!teamMembers || teamMembers.length === 0) {
      return [];
    }

    // Extract and filter valid email addresses
    const memberEmails = teamMembers
      .map(member => member.email)
      .filter(email => email && typeof email === 'string' && email.includes('@'));

    return memberEmails;
  } catch (error) {
    logError('Error getting project member emails for RFQ', error);
    return [];
  }
};

/**
 * Helper function to add project member emails to CC field
 * @param {Object} mailRecipients - The mail recipients object
 * @param {string[]} projectMemberEmails - Array of project member emails
 * @returns {Object} - Updated mail recipients with CC
 */
const addProjectMembersToCC = (mailRecipients, projectMemberEmails) => {
  if (!projectMemberEmails || projectMemberEmails.length === 0) {
    return mailRecipients;
  }

  // Get existing CC as array
  let existingCC = [];
  if (mailRecipients.cc) {
    if (Array.isArray(mailRecipients.cc)) {
      existingCC = mailRecipients.cc;
    } else if (typeof mailRecipients.cc === 'string' && mailRecipients.cc) {
      existingCC = [mailRecipients.cc];
    }
  }

  // Combine existing CC with project member emails, removing duplicates
  const allCC = [...new Set([...existingCC, ...projectMemberEmails])];

  // Filter out any emails that are already in the 'to' field to avoid duplicates
  const toEmails = Array.isArray(mailRecipients.to)
    ? mailRecipients.to
    : [mailRecipients.to];

  mailRecipients.cc = allCC.filter(email => !toEmails.includes(email));

  return mailRecipients;
};

/**
 * Get all users who should receive RFQ/Tender notification emails:
 * approval workflow users (approvers + initiator) + the RFQ creator.
 * Deduplicates by user_id.
 * @param {string} entityType - 'RFQ' or 'TENDER'
 * @param {number} rfqId - The RFQ/Tender ID
 * @param {number} createdByUserId - The user ID of the RFQ/Tender creator
 * @returns {Promise<Array<{name: string, email: string}>>}
 */
const getRfqNotificationRecipients = async (entityType, rfqId, createdByUserId) => {
  const approvalUsers = await getApprovalWorkflowUsers(entityType, rfqId);

  const creatorAlreadyIncluded = approvalUsers.some(u => u.user_id === createdByUserId);
  const recipients = approvalUsers.map(u => ({ name: u.name, email: u.email }));

  if (!creatorAlreadyIncluded && createdByUserId) {
    const creatorDetails = await userModel.user_profile_detail(createdByUserId);
    const creator = creatorDetails?.[0];
    if (creator?.email && creator.email.includes('@')) {
      recipients.push({ name: creator.name, email: creator.email });
    }
  }

  return recipients;
};

const getDownloadURL = (url, excelToJson = false) => {
  if(process.env.NODE_ENV == "production" && !url.includes("https")) {
    url = url.replace("http", "https");
  }

  if(excelToJson) {
    url = url.replace("excel", "json");
  }

  return url;
}

export const notifyBuyerOnPersistenceViaEmail = async (buyer_info, previous_status, status, persisted_rfq_id, errors, persistence, download_url) => {
  try {
    const { name, email } = buyer_info;

    let headerContent = '';
    let containerContent = '';
    let subject = '';
      
    switch(persistence.type) {
      case 'cost-estimation':
        headerContent = `<h2>Hello ${name},</h2>`;
        containerContent = `
          <p style="font-size: 15px;">
            ${
              status == PERSISTENCE_STATUSES.PARTIAL_COMPLETED ||
              status == PERSISTENCE_STATUSES.COMPLETED
                ? `The Cost Estimation Processing for your BOQ has been completed successfully, follow the below link to see the processed estimation table.`
                : status == PERSISTENCE_STATUSES.FAILED
                ? `The Cost Estimation Processing for your BOQ has been failed due to some reasons`
                : `The Cost Estimation Processing for your BOQ status has been changed from <strong>${previous_status}</strong> to <strong>${status}</strong>`
            }
          </p>
          ${
            (status == PERSISTENCE_STATUSES.PARTIAL_COMPLETED ||
            status == PERSISTENCE_STATUSES.COMPLETED)
              ? `<a href="${process.env.FRONT_END_WEBSITE}/ai-tools/cost-estimation/${persistence.id}"
                    style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
                  View Estimation
                </a>`
              : ''
          }
          ${
            status == PERSISTENCE_STATUSES.FAILED
              ? `<a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/boq-automation?tab=processing-files"
                    style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
                  View Processing RFQs
                </a>`
              : ''
          }
        `;
        subject = status == PERSISTENCE_STATUSES.PARTIAL_COMPLETED ||
          status == PERSISTENCE_STATUSES.COMPLETED
            ? `Cost Estimation has been processed successfully`
            : status == PERSISTENCE_STATUSES.FAILED
            ? `Cost Estimation Processing was failed`
            : `Cost Estimation status has been changed`;
        break;
      
      case 'simplified':
        headerContent = `<h2>Hello ${name},</h2>`;
        containerContent = `
          <p style="font-size: 15px;">
            ${
              status == PERSISTENCE_STATUSES.PARTIAL_COMPLETED ||
              status == PERSISTENCE_STATUSES.COMPLETED
                ? `The BOQ Simplification Processing has been completed successfully, follow the below link to see the simplified version of your BOQ.`
                : status == PERSISTENCE_STATUSES.FAILED
                ? `BOQ Simplification has been failed due to some reasons`
                : `BOQ Simplification status has been changed from <strong>${previous_status}</strong> to <strong>${status}</strong>`
            }
          </p>
          ${
            (status == PERSISTENCE_STATUSES.PARTIAL_COMPLETED ||
            status == PERSISTENCE_STATUSES.COMPLETED) && download_url
              ? `<a href="${
                  process.env.FRONT_END_WEBSITE
                }/dashboard/buyer/boq-automation/view?jsonUrl=${encodeURIComponent(
                  getDownloadURL(download_url, true)
                )}"
                    style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
                  View Simplified BOQ
                </a>`
              : ''
          }
          ${
            status == PERSISTENCE_STATUSES.FAILED
              ? `<a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/boq-automation?tab=processing-files"
                    style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
                  View Processing RFQs
                </a>`
              : ''
          }
        `;
        subject = status == PERSISTENCE_STATUSES.PARTIAL_COMPLETED ||
          status == PERSISTENCE_STATUSES.COMPLETED
            ? `BOQ Simplification has been processed successfully`
            : status == PERSISTENCE_STATUSES.FAILED
            ? `BOQ Simplification Processing was failed`
            : `BOQ Simplification status has been changed`;
        break;

      default:
        headerContent = `<h2>Hello ${name},</h2>`;
        containerContent = `
          <p style="font-size: 15px;">
            ${
              status == PERSISTENCE_STATUSES.PARTIAL_COMPLETED ||
              status == PERSISTENCE_STATUSES.COMPLETED
                ? `The Magic Search RFQ Processing has been completed successfully, follow the below link to see the processed draft.`
                : status == PERSISTENCE_STATUSES.FAILED
                ? `The Magic Search RFQ Processing has been failed due to some reasons`
                : `The Magic Search RFQ Processing status has been changed from <strong>${previous_status}</strong> to <strong>${status}</strong>`
            }
          </p>
          ${
            (status == PERSISTENCE_STATUSES.PARTIAL_COMPLETED ||
            status == PERSISTENCE_STATUSES.COMPLETED)
              ? `<a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management?tab=create-rfq&draft_id=${persisted_rfq_id}"
                    style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
                  View Draft
                </a>`
              : ''
          }
          ${
            status == PERSISTENCE_STATUSES.FAILED
              ? `<a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/boq-automation?tab=processing-files"
                    style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
                  View Processing RFQs
                </a>`
              : ''
          }
        `;
        subject = status == PERSISTENCE_STATUSES.PARTIAL_COMPLETED ||
          status == PERSISTENCE_STATUSES.COMPLETED
            ? `Magic Search RFQ has been processed successfully`
            : status == PERSISTENCE_STATUSES.FAILED
            ? `Magic Search RFQ Processing was failed`
            : `Magic Search RFQ status has been changed`;
            
        break;
      
    }

      const html = generateEmailTemplate(headerContent, containerContent);

      let mail = {
        from: Config.webmasterMail,
        to: email,
        subject,
        html
      };

      // Add project members to CC if RFQ ID is available
      if (persisted_rfq_id) {
        const projectMemberEmails = await getProjectMemberEmailsForRFQ(persisted_rfq_id);
        addProjectMembersToCC(mail, projectMemberEmails);
      }

      sendMail(mail);
  } catch (err) {
    logError('Error in sendRfqUpdatedMailToVendors', err);
    throw err;
  }
};


//  mukul need to delete - not in use anywhere
const getNextRfQNumber = async () => {
  // get last rfq
  return new Promise(async function (resolve, reject) {
    const response = await rfqModel.getLastRfQNumber();
    if (response && response.length > 0) {
      resolve(response[0].rfq_no + 1);
    } else {
      resolve(Math.floor(100000 + Math.random() * 900000));
    }
  });
};

const hasValidValue = (value) =>
  (Array.isArray(value) && value.length > 0) ||
  typeof value === 'string' ||
  typeof value === 'number';

const hasValidFilters = (obj) =>
  obj && Object.keys(obj).length > 0 && Object.values(obj).some(hasValidValue);


const saveMagicSearchInDraft = async (data, createdBy, processedUrl, rfqId, sheetId) => {
  try {

   
    // const nextRfqNumber = await getNextRfQNumber()
    return await rfqModel.saveMagicSearchInDraft(data, createdBy, processedUrl, rfqId, sheetId);
  } catch (error) {
    throw error
  }
}

const saveEstimates = async (data, createdBy) => {
  try {
    return await rfqModel.saveEstimatesInDB(data, createdBy);
  } catch (error) {
    throw error
  }
}




const getQUOTES = async ({ id }, user_id) => {
  try {
    const rfQItem = await rfqModel.getQuotesByRfqById(id, user_id);
    // const rfQItem = await rfqModel.getQuotesByRfqByIdByProduct(id, user_id);
    if (rfQItem && rfQItem.length > 0) {
      return rfQItem[0];
    } else {
      return {};
    }
  } catch (error) {
    logError('Error inserting data', error);
    throw error;
  }
};

const sendMailToBuyerForRegret = async (buyer, rfqNumber, vendor, rfq_id, regret_reason) => {
  try {
    const { id: buyer_id, name, email } = buyer;
    const { id: vendor_id, name: vendor_name } = vendor;

    // Validate email addresses
    const allEmails = [email];
    if (!validateEmailAddresses(allEmails)) {
      throw new Error('Invalid email address format');
    }

    const headerContent = `<h2> Dear ${name},</h2>`;
    const containerContent = `<div>
      <p style="font-size: 15px; padding-bottom: 3px;">
      Vendor <strong>${vendor_name}</strong> has regretted the quote for RFQ ${rfqNumber} </p>

      <p style="font-size: 15px; padding-bottom: 3px;">Reason: ${regret_reason}</p>
      
      <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfq_id}"
        style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
       Click here to view
      </a>      
    </div>`;

    const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

    let mailRecipients = {
      from: Config.webmasterMail,
      to: email,
      subject: `Work Wise | RFQ Regret Notification`,
      html: dynamicHTML
    };

    // Add project members to CC
    const projectMemberEmails = await getProjectMemberEmailsForRFQ(rfq_id);
    addProjectMembersToCC(mailRecipients, projectMemberEmails);

    await sendMailWithRetry(mailRecipients);

    dispatchNotification({
      userIds: [buyer_id],
      category: 'rfq',
      type: 'vendor_quote_regret',
      title: `${vendor_name} regretted RFQ #${rfqNumber}`,
      body: regret_reason ? `Reason: ${regret_reason}` : 'The vendor has declined to quote.',
      data: { rfq_id, vendor_id, regret_reason: regret_reason || null },
      actionUrl: `${process.env.FRONT_END_WEBSITE || ''}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfq_id}`
    }).catch((err) => logError('dispatch vendor_quote_regret failed', err));
  } catch (error) {
    throw error;
  }
};

const sendFollowUpEmailsService = async (payload) => {
  try {
    const { buyer, vendor, rfqNumber, rfq_id } = payload;
    const { name, email } = buyer;
    const { name: vendor_name } = vendor;

    

    const headerContent = `<h2> Dear ${name},</h2>`;
    const containerContent = `<div>
      <p style="font-size: 15px; padding-bottom: 3px;">
        Vendor <strong>${vendor_name}</strong> has sent you a follow-up mail for RFQ <strong>${rfqNumber}</strong>.
      </p>
      
      <p style="font-size: 15px; padding-bottom: 3px;">
        The vendor is awaiting your action. Kindly respond at the earliest.
      </p>

      <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${rfq_id}"
        style="background-color: #2563eb; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 220px; margin: 0 auto; text-decoration: none;">
        View RFQ & Respond
      </a>
    </div>`;

    const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

    let mailRecipients = {
      from: Config.webmasterMail,
      to: email,
      subject: `Work Wise | RFQ ${rfqNumber} Follow-up Notification`,
      html: dynamicHTML
    };

    // Add project members to CC
    const projectMemberEmails = await getProjectMemberEmailsForRFQ(rfq_id);
    addProjectMembersToCC(mailRecipients, projectMemberEmails);

    await sendMailWithRetry(mailRecipients);
    logger.info(`Follow-up email sent to buyer ${email} for RFQ ${rfqNumber}`);
  } catch (error) {
    throw error;
  }
};


/**
 *
 * @param {*} vendor
 * @param {*} user
 * @param {*} rfqNumber 
 * @param {*} products - array 
 * @last_update by mukul on 2023-11-01, for company wise email template
 */
const sendMailEachVendor = async (vendor, user, rfqNumber, products, reverse_auction, location) => {
  try {
    // Validate email addresses
    let organization_name = user?.company_name || user?.organization_name || user?.name;
    const buyerUserId = user?.id || null;
    const buyerEmail = user?.email || "";

    // Fetch user details of the vendor
    const techEval = await rfqModel.findAll('tbl_rfq_product_tech_evaluation', { rfq_id: rfqNumber });

   
    const user_details = await userModel.user_profile_detail(vendor.user_id);
    const spocList = await vendorModel.getSpocDetails(vendor.user_id, rfqNumber);

    if (user_details.length > 0) {
      // Insert token into the table and get the token value
      const token = await rfqModel.insertVendorRfqToken(user_details[0].id, rfqNumber);

      // Create a map of products with technical evaluation status
      const productsWithTechEval = products.map(product => {
        const hasTechEval = techEval.some(evaluation => evaluation.tbl_rfq_product_id === product.id);
        return {
          ...product,
          hasTechEvaluation: hasTechEval
        };
      });

      // Construct dynamic HTML for products list with tech eval info
      let productHTML = productsWithTechEval.slice(0, 3).map((product) => {
        const quantitySpec = product.spec.find(specItem => specItem.title === 'Quantity');
        return `
            <tr>
              <td style="font-size: 15px; padding-bottom: 3px;">
                ${product.name}
                ${product.hasTechEvaluation ? 
                  '<span style="color: #dc3545; font-size: 12px; margin-left: 5px;">(Technical Evaluation Required)</span>' : 
                  ''}
              </td>
              <td style="font-size: 15px; text-align: right; padding-bottom: 3px;">${quantitySpec.value || '--'}</td>
            </tr>
          `;
      }).join('');

      if (productsWithTechEval.length > 3) {
        productHTML += `
            <tr>
              <td colspan="2" style="text-align: right; padding-bottom: 3px;">
                <a href=${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfqNumber}&token=${token}
                style="font-size: 15px; color: blue; text-decoration: none;">
                  ...view more
                </a>
              </td>
            </tr>
          `;
      }

      // Add RFQ details section
      const rfqDetailsHTML = `
        <div style="margin-bottom: 15px; padding: 10px; background-color: #f8f9fa; border-radius: 5px;">
          <h4 style="margin-bottom: 10px; font-size: 16px;">RFQ Details:</h4>
          <p style="margin: 5px 0; font-size: 14px;">
            <strong>Delivery Location:</strong> ${location || 'Not specified'}
          </p>
          <p style="margin: 5px 0; font-size: 14px;">
            <strong>Reverse Auction:</strong> ${reverse_auction ? 'Enabled' : 'Disabled'}
          </p>
          ${techEval.length > 0 ? 
            `<p style="margin: 5px 0; font-size: 14px; color: #dc3545;">
              <strong>Note:</strong> Some products require technical evaluation
            </p>` : 
            ''}
        </div>
      `;

      const headerContent = ` 
        <div>
          <h2>Hello ${user_details[0].name}</h2>
          <p style="font-size:16px;">Great news! You've received a new enquiry from ${organization_name}</p>
        </div>`;

      // Construct the email content with the list of products
      const containerContent = `   
        <div>
          <h3 style="font-family: 'Roboto', sans-serif; text-align: center; font-size: 24px; margin-bottom: 8px;">
            Enquiry Details
          </h3>
          
          ${rfqDetailsHTML}

          <table style="width: 100%; padding: 8px;">
            <tbody>
              ${productHTML}
              <tr>
                <td></td>
              </tr>
            </tbody>
          </table>

          <a href=${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfqNumber}&token=${token}
            style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
            Submit Your Quote Now
          </a>

          <p style="margin-top:20px">
            Submit your quote promptly to access this opportunity with ${organization_name} and stand out as a preferred vendor.
            ${reverse_auction ? '<strong>This RFQ includes reverse auction functionality.</strong>' : ''}
          </p>
        </div>`;

      const dynamicHTML = generateEmailTemplate(headerContent, containerContent, buyerUserId);

      const org_name = user_details[0].company_name || user_details[0].organization_name || user_details[0].name || "";
      let mailRecipients = {
        from: `${organization_name} ${Config.masterEmail}`,
        subject: `New RFQ Opportunity from ${organization_name}`,
        html: dynamicHTML
      };

      if (spocList && spocList.length > 0) {
        mailRecipients.to = spocList.map(spoc => spoc.email);
      } else {
        mailRecipients.to = user_details[0].email;
      }

      // NOTE: Do NOT add project members to CC for vendor emails to prevent data leakage
      // Project members should only be CC'd on buyer emails

      // Construct an array of product descriptions
      const productDescriptions = productsWithTechEval.map((product) => {
        const quantitySpec = product.spec.find(specItem => specItem.title === 'Quantity');
        const techEvalText = product.hasTechEvaluation ? ' (Tech Evaluation Required)' : '';
        return `${product.name} - ${quantitySpec.value || '--'} ${product.unit || ''}${techEvalText}`.trim();
      }).join(', ');

      sendMail(mailRecipients);
      // console.log('Email send to follwowing people' , mailRecipients.to);

      // Send WhatsApp notifications to SPOCs
      await Promise.allSettled(
        spocList.map(async (spoc) => {
          if (spoc?.mobile) {
            const payloadForWhatsApp = {
              mobile: spoc.mobile,
              vendorName: user_details[0]?.organization_name || user_details[0]?.name || "",
              buyerName: organization_name,
              rfq_id: rfqNumber,
              token: token,
              productDetails: productDescriptions,
              location: location || 'Not specified',
              reverseAuction: reverse_auction ? 'Enabled' : 'Disabled',
              hasTechEvaluation: techEval.length > 0 ? 'Some products require technical evaluation' : ''
            };
            
            await whatsappNotificationAISensy.vendorReceivesRFQNotification(payloadForWhatsApp);
          }
        })
      );

      // Send WhatsApp notification to the main vendor contact
      const payloadForWhatsApp = {
        mobile: user_details[0]?.mobile,
        vendorName: user_details[0]?.organization_name || user_details[0]?.name || "",
        buyerName: organization_name,
        rfq_id: rfqNumber,
        token: token,
        productDetails: productDescriptions,
        location: location || 'Not specified',
        reverseAuction: reverse_auction ? 'Enabled' : 'Disabled',
        hasTechEvaluation: techEval.length > 0 ? 'Some products require technical evaluation' : ''
      };

      await whatsappNotificationAISensy.vendorReceivesRFQNotification(payloadForWhatsApp);

      // Send notification if applicable
      if (user_details[0].endpoint) {
        const payload = {
          title: `Hello ${user_details[0].name}`,
          body: `You've got a new RFQ from ${organization_name}`,
        };

        const notificationData = {
          type: 'RFQ create',
          title: `RFQ created`,
          message: `RFQ created successfully`,
          additional_data: {
            user_type: user_details[0].user_type,
            location: location,
            reverse_auction: reverse_auction,
            has_tech_evaluation: techEval.length > 0
          }
        };

        sendNotification(
          user_details[0].id,
          '',
          notificationData,
          payload,
          JSON.parse(user_details[0].endpoint)
        );
      }
    }
  } catch (error) {
    logError('Error sending email to vendor', error);
    throw error;
  }
};

const sendMailWithRetry = async (mailOptions, maxRetries = 3) => {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      await sendMail(mailOptions);
      return true;
    } catch (error) {
      retries++;
      logError(`Email send attempt ${retries} failed`, error);
      if (retries === maxRetries) {
        throw error;
      }
      // Wait for 2 seconds before retrying
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

const validateEmailAddresses = (emails) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emails.every(email => emailRegex.test(email));
};
//Send quotation mail to vendors here
const sendMailToVendorsForTargetPrice = async (
  vendorList,
  target_price,
  buyer_id
) => {
  try {
    // Loop through each vendor in the vendorList
    const productName = vendorList[0]?.productname;
    const rfq_id = vendorList[0]?.rfq_id;
    const VendorList = vendorList[0]?.created_by || [];

    const buyer_details = await userModel.user_profile_detail(buyer_id);
    // console.log("checking the buyer details", buyer_details);
    for (const vendor of VendorList) {
      try {
        const spocList = await vendorModel.getSpocDetails(vendor.id, rfq_id);
        const token = await rfqModel.insertVendorRfqToken(vendor.id, rfq_id);

        // Create product HTML content
        let productHTML = `
          <tr>
            <td style="padding: 8px 0; font-family: 'Roboto', sans-serif; font-size: 16px;">
              <strong>Product:</strong> ${productName}
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-family: 'Roboto', sans-serif; font-size: 16px;">
              <strong>Target Price:</strong> ${target_price}
            </td>
          </tr>
        `;

        const headerContent = `
          <div>
            <h2>Hello ${vendor?.name}</h2>
            <p style="font-size:16px;">
              The buyer has set a new target price for ${productName}. Kindly review and update your quote accordingly.
            </p>
          </div>
        `;

        const containerContent = `
          <div>
            <h3 style="font-family: 'Roboto', sans-serif; text-align: center; font-size: 24px; margin-bottom: 8px;">
              Target Price Update
            </h3>

            <table style="width: 100%; padding: 8px;">
              <tbody>
                ${productHTML}
                <tr>
                  <td></td>
                </tr>
              </tbody>
            </table>

            <a href=${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${token}
              style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
              Update Your Quote
            </a>

            <p style="margin-top:20px">
              Please update your quote promptly to align with the new target price set by ${buyer_details[0]?.company_name}.
            </p>
          </div>
        `;

        const dynamicHTML = generateEmailTemplate(
          headerContent,
          containerContent,
          sender_id
        );

        let mailRecipients = {
          from: buyer_details[0]?.company_name || Config.masterEmail,
          subject: `Target Price Update for ${productName} - RFQ ${rfq_id}`,
          html: dynamicHTML
        };


        // Set recipients - prioritize SPOCs if available
        if (spocList && spocList.length > 0) {
          mailRecipients.to = spocList.map((spoc) => spoc.email);
          // Optionally CC the main vendor email
          // mailRecipients.cc = [user_details[0].email];
        } else {
          mailRecipients.to = vendor.email;
          // Optionally CC the buyer's email
          // mailRecipients.cc = buyerEmail;
        }

        // NOTE: Do NOT add project members to CC for vendor emails to prevent data leakage

        // Send the email
        sendMail(mailRecipients);

        // console.log(`Email sent successfully to vendor: ${vendor.name}`);
      } catch (vendorError) {
        logError(`Error sending email to vendor ${vendor.id}`, vendorError);
        // Continue with next vendor even if one fails
      }
    }

    return {
      success: true,
      message: 'Target price notifications sent to all vendors'
    };
  } catch (error) {
    logError('Error in sendMailToVendorsForTargetPrice', error);
    throw error;
  }
};




// Update the sendMailtoVendors function
const sendMailtoVendors = async (req, rfqNumber) => {
  try {
    const {reverse_auction , location} = req.body;
    const vendorProductMap = {};

    const products = await rfqModel.getProductsByRfqId(rfqNumber);

    if(reverse_auction){
      raSchedulerForBuyer(rfqNumber, req , products);
    }
    

    const vendorProductMAP = {};  // This is different variable check the  spelling.
    
    //Creating  A New product vendor map
    products.map((product) => {
    const { name,  vendors } = product;

    vendors.map((vendor) => {
      const { user_id } = vendor;

      if (!vendorProductMAP[user_id]) {
        vendorProductMAP[user_id] = {
          vendorDetails: { ...vendor },
          products: []
        };
      }

      vendorProductMAP[user_id].products.push({ product_name : name });
    });
  });




    products.forEach((item) => {
      item.vendors.forEach((vendor) => {
        if (!vendorProductMap[vendor.user_id]) {
          vendorProductMap[vendor.user_id] = {
            vendorDetails: vendor,
            products: [],
          };
        }
        vendorProductMap[vendor.user_id].products.push(item);
      });
    });
 
    const emailPromises = Object.keys(vendorProductMap).map(async (vendorId) => {
      const vendorInfo = vendorProductMap[vendorId];
      try {
        await sendMailEachVendor(vendorInfo.vendorDetails, req.user, rfqNumber, vendorInfo.products ,reverse_auction , location );
      
      } catch (error) {
        logError(`Failed to send email to vendor ${vendorId}`, error);
        throw error;
      }
    });
   
    await Promise.all(emailPromises);
     if(reverse_auction){
      await raSchedulerForVendor(req,rfqNumber , vendorProductMAP);
    }
    return true;
  } catch (error) {
    logError('Error in sendMailtoVendors', error);
    throw error;
  }
};

// Update the sendQuotationMailToBuyer function
const sendQuotationMailToBuyer = async (req, rfqNumber) => {
  try {
    const { name, email, id } = req.user;
    const spocList = await vendorModel.getSpocDetails(id, rfqNumber);

    // Validate email addresses
    const allEmails = [email, ...(spocList?.map(spoc => spoc.email) || [])];
    if (!validateEmailAddresses(allEmails)) {
      throw new Error('Invalid email address format');
    }

    const headerContent = `<h2> Dear ${name},</h2>`;
    const containerContent = `<div>
      <p style="font-size: 15px; padding-bottom: 3px;">
      Your RFQ has been successfully shared with vendors. </p>
      
      <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfqNumber}"
        style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
       Click here to view
      </a>      
    </div>`;

    const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

    let mailRecipients = {
      from: Config.webmasterMail,
      subject: `Work Wise | RFQ Creation Confirmation`,
      html: dynamicHTML
    };

    if (spocList && spocList.length > 0) {
      mailRecipients.to = spocList.map(spoc => spoc.email);
      mailRecipients.cc = email;
    } else {
      mailRecipients.to = email;
    }

    // Add project members to CC
    const projectMemberEmails = await getProjectMemberEmailsForRFQ(rfqNumber);
    addProjectMembersToCC(mailRecipients, projectMemberEmails);

    await sendMailWithRetry(mailRecipients);
    logger.info(`Confirmation email sent successfully to buyer ${id}`);
  } catch (error) {
    logError('Error in sendQuotationMailToBuyer', error);
    throw error;
  }
};

const sendRevisedQuotationEmailToVendor =async (buyerDetails, user, rfq_id, rfq_no) => {
  
  const token = await rfqModel.getVendorRfqToken(user.id, rfq_id);
  const spocList = await vendorModel.getSpocDetails(user.id , rfq_id);

  // Extract vendor details from user object
  const vendorName = user.company_name || user.organization_name || user?.name;

  // Email content
  const headerContent = `<h2>Hello ${vendorName || ''},</h2>`;

  const containerContent = `<div style="font-size: 15px; font-family: 'Roboto', sans-serif;">
      <p style="padding-bottom: 3px;">
                   Your updated quotation for #${rfq_no} has been successfully shared with ${buyerDetails[0]?.company_name || buyerDetails[0]?.organization_name || buyerDetails[0]?.name || 'the buyer'}. This update keeps you competitive and responsive to buyer requirements.      </p>
                   </p>

      <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${token[0]?.token || ""}"
         style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; 
         text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; 
         width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
        Track RFQ Status
      </a>      

    </div>`;

  // Generate final email layout
  const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

  // Preparing the email details
  let mailRecipients = {
    from: Config.webmasterMail,
    to: user.email,
    subject: `Work Wise | New Quotation Received for Your RFQ`,
    html: dynamicHTML
  };

  if (spocList && spocList.length > 0) {
    mailRecipients.to = spocList.map(spoc => spoc.email);
  }

  // NOTE: Do NOT add project members to CC for vendor emails to prevent data leakage

  // Sending the email
  sendMail(mailRecipients);

  const message = `Thank you for submitting your updated quotation for #${rfq_no}`


  // Send notification message to vendor
    // here we have to implement await Promise.allSettled(promises); for better perfomance
    const vendorToken = token[0]?.token || '';
    if (vendorToken) {
      spocList.map(async (spoc) => {
        if (spoc.mobile) {
        const whatsappPayload ={
          mobile:spoc.mobile,
          token:vendorToken,
          rfq_id:rfq_id,
          message:message,
          name:vendorName
        }

        await whatsappNotificationAISensy.sendQuoteSubmissionNotification(whatsappPayload)
      }
      })

      // send message to vendor (skip if mobile not available, e.g. token-auth users)
      if (user.mobile) {
        const whatsappPayload ={
          mobile:user.mobile,
          token:vendorToken,
          rfq_id:rfq_id,
          message:message,
          name:vendorName
        }
        await whatsappNotificationAISensy.sendQuoteSubmissionNotification(whatsappPayload)
      }
    }
  
  

};


const sendRevisedQuotationEmailToBuyer = async (buyerDetails, quoteItemChanges, user, rfq_id, rfq_no) => {
  // Extract vendor details from user object
  const vendorName = user.company_name || user.organization_name || user?.name;

  const rfqDetails = await rfqModel.getRfqWithHospitalityDetails(rfq_id);
  const rfqTitle = rfqDetails?.title || '-';
  const buName = rfqDetails?.hotel_name || '-';
  const companyName = rfqDetails?.hospitality_company_name || '-';

  // Email content
  const headerContent = `<h2>Hello ${buyerDetails[0]?.company_name || buyerDetails[0]?.organization_name || ''},</h2>`;

  const containerContent = `<div style="font-size: 15px; font-family: 'Roboto', sans-serif;">
      <p style="padding-bottom: 3px;">
        A vendor has updated their quotation. Check out the details below:
      </p>

      <p><strong>RFQ:</strong> #${rfq_no} — ${rfqTitle}</p>
      <p><strong>Company:</strong> ${companyName}</p>
      <p><strong>BU:</strong> ${buName}</p>

      <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${rfq_id}"
         style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif;
         text-align: center; padding: 10px 24px; display: block; border-radius: 9999px;
         width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
         Compare Quote
      </a>

      <p style="margin-top:20px;">
        Stay updated with Phileein Hospitality for more opportunities.
      </p>
    </div>`;

  // Generate final email layout
  const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

  // Preparing the email details
  // NOTE: `from` intentionally omits the vendor name — keeps the buyer email consistent with the new-quote notification, no vendor identity in the sender display.
  let mailRecipients = {
    from: Config.masterEmail,
    to: buyerDetails[0]?.email,
    subject: `Updated Quotation Received for Your RFQ ${rfq_no}`,
    html: dynamicHTML
  };

  // Add project members to CC
  const projectMemberEmails = await getProjectMemberEmailsForRFQ(rfq_id);
  addProjectMembersToCC(mailRecipients, projectMemberEmails);

  // Sending the email
  sendMail(mailRecipients);

  dispatchNotification({
    userIds: [buyerDetails[0]?.id],
    category: 'rfq',
    type: 'vendor_quote_updated',
    title: `Updated quotation for RFQ #${rfq_no}`,
    body: `${vendorName} revised their quote. Review the changes.`,
    data: { rfq_id, vendor_id: user?.id, changed_items: Array.isArray(quoteItemChanges) ? quoteItemChanges.length : 0 },
    actionUrl: `${process.env.FRONT_END_WEBSITE || ''}/dashboard/buyer/quote-compare?rfq=${rfq_id}`
  }).catch((err) => logError('dispatch vendor_quote_updated failed', err));

  // send updated quote message to buyer
  const payload = {
    mobile:buyerDetails[0]?.mobile,
    rfqNumber:rfq_no,
    rfqID:rfq_id,
    projectName:"-",
    vendorName:vendorName,
    buyerName:buyerDetails[0]?.company_name || buyerDetails[0]?.organization_name || buyerDetails[0]?.name
  }

  // await whatsappNotificationAISensy.sendNewQuoteNotificationToBuyer(payload);

};


const sendQuoteNotificationToVendor = async (req) => {
  // send mail to vendors
  const {rfq_id, rfq_no} = req.body
  const { name, email, id, organization_name, company_name, mobile } = req.user;
  const user = req.user
  const token = await rfqModel.getVendorRfqToken(id, rfq_id);
  const vendorToken = token[0]?.token || '';
  const BuyerDetails = await rfqModel.getRFQCreatedBy(rfq_id)

  const vendorCompanyName = company_name || organization_name || name;
  const buyerCompanyName = BuyerDetails[0]?.company_name || BuyerDetails[0]?.organization_name || '';

  const headerContent = `<h2>Hello ${vendorCompanyName},</h2>`;

  const containerContent = `
  <div style="font-size:16px; font-family: 'Roboto', sans-serif;">
    <p>
      ${req.body.is_regret && req.body.is_regret == 1
        ? 'Your regret concern has been sent to the buyer.'
        : `<div>
            <p>Thank you for submitting your quotation for <strong>#${rfq_no}</strong>.
               We've shared it with <strong>${buyerCompanyName}</strong>, who will review it and get back to you soon.</p>
              <p><strong>Next Steps:</strong> Keep an eye out for any buyer queries or updates,
               and be ready to discuss terms to secure the order.</p>

            <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${vendorToken}"
               style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
               View RFQ Status
            </a>
          </div>`}
    </p>
  </div>`;

    const dynamicHTML = generateEmailTemplate(headerContent, containerContent)

  const spocList = await vendorModel.getSpocDetails(id , rfq_id);

  // console.log(" rfq contoller 569 spoc console  ", id, spocList)

  let mailRecipients = {
    from: Config.webmasterMail,
    subject: `Quotation Successfully Submitted for ${rfq_no}` , // Subject line
    html: dynamicHTML
  };

  if (spocList && spocList.length > 0) {
    mailRecipients.to = spocList.map(spoc => spoc.email);
    mailRecipients.cc = email;
  } else {
    mailRecipients.to = email;
  }

  // NOTE: Do NOT add project members to CC for vendor emails to prevent data leakage

  sendMail(mailRecipients);


  const message =  req.body.is_regret && req.body.is_regret == 1
  ? `Your regret concern for #${rfq_no} has been sent to the buyer.`:
  `Thank you for submitting your quotation for #${rfq_no}`

  // send message to spoc
  // here we have to implement await Promise.allSettled(promises); for better perfomance
  if (vendorToken) {
    const vendorCompanyNameForWhatsApp = user.company_name || user.organization_name || user.name;
    spocList.map(async (spoc) => {
      if (spoc.mobile) {
      const whatsappPayload ={
        mobile:spoc.mobile,
        token:vendorToken,
        rfq_id:rfq_id,
        message:message,
        name:vendorCompanyNameForWhatsApp
      }

      await whatsappNotificationAISensy.sendQuoteSubmissionNotification(whatsappPayload)
    }
    })

    // send message to vendor
    const whatsappPayload ={
      mobile:mobile,
      token:vendorToken,
      rfq_id:rfq_id,
      message:message,
      name:vendorCompanyName
    }
    await whatsappNotificationAISensy.sendQuoteSubmissionNotification(whatsappPayload)
  }

};

const sendReminderRFQMAIL = async (vendor, org_name, rfq_id, rfqBasicDetails) => {
  if (!vendor?.user_id || !(vendor.remainingProducts || []).length) return;
  if (!vendor.token) return;

  // Get rfq_product_vendor_id from vendor data if available
  // For reminders, we use the first product's vendor code, or fallback to user_id
  const rfqProductVendorId = vendor.rfq_product_vendor_id || 
    (vendor.remainingProducts && vendor.remainingProducts.length > 0 && vendor.remainingProducts[0].rfq_product_vendor_id) ||
    null;
  const vendorCode = rfqProductVendorId ? `VEN-${rfqProductVendorId}` : (vendor.user_id ? `VEN-${vendor.user_id}` : 'VEN-Unknown');
  
  const vendorName =
    vendor.company_name ||
    vendor.organization_name ||
    vendor.vendor_name ||
    vendor.name ||
    'there';

  const remainingProductsArray = Array.isArray(vendor.remainingProducts)
    ? vendor.remainingProducts
    : [];

  const remainingProductsHtml = remainingProductsArray
    .map(
      (product) =>
        `<strong>${product?.name || 'Product'}</strong>${
          product?.variant ? ` - ${product.variant}` : ''
        }<br>`
    )
    .join('');

  const headerContent = `<h2>Hello ${vendorCode},</h2>`;

  const containerContent = ` 
      <div style="font-size:16px; font-family: 'Roboto', sans-serif;">
        <p>
          This is a friendly reminder from <strong>${org_name}</strong> regarding the RFQ quotation. Ensure your quote is submitted on time to secure this opportunity.
        </p>
        <p>
          Please submit quote for the following product variant(s):
        </p>
        <p>
          ${remainingProductsHtml}
        </p>
      
        <p> <strong> Deadline: </strong> ${rfqBasicDetails?.bid_end_date || 'N/A'} </p>
      
        <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${vendor.token}"
           style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
          Submit Your Quote Now
        </a>
      
        <p style="margin-top:20px; font-weight:bold; text-align:center">   Don't miss out on this opportunity!
        </p>
      </div>`;

  // Resolve theming user id: prefer RFQ.created_by; fallback to explicit DB fetch
  let themingUserId = rfqBasicDetails?.created_by;
  if (!themingUserId) {
    try {
      const buyerRows = await rfqModel.getBuyerForRfq(rfq_id);
      themingUserId = buyerRows?.[0]?.user_id || themingUserId;
    } catch (e) {}
  }

  const dynamicHTML = generateEmailTemplate(
    headerContent,
    containerContent,
    themingUserId
  );

  const spocList = Array.isArray(vendor.spocs) ? vendor.spocs : [];

  const recipientEmails = spocList
    .map((spoc) => spoc?.email)
    .filter((email) => typeof email === 'string' && email.includes('@'));

  if (
    !recipientEmails.length &&
    typeof vendor.email === 'string' &&
    vendor.email.includes('@')
  ) {
    recipientEmails.push(vendor.email);
  }

  if (!recipientEmails.length) return;

  const mailRecipients = {
    from: `${org_name} ${Config.masterEmail}`,
    subject: `Work Wise | Reminder for Quotation | Action Required`,
    html: dynamicHTML,
    to: recipientEmails
  };

  if (spocList.length && vendor.email && vendor.email.includes('@')) {
    mailRecipients.cc = [vendor.email];
  }

  // NOTE: Do NOT add project members to CC for vendor emails to prevent data leakage

  sendMail(mailRecipients);

  const whatsappTargets = new Set();
  spocList.forEach((spoc) => {
    if (spoc?.mobile) whatsappTargets.add(spoc.mobile);
  });
  if (vendor.mobile) whatsappTargets.add(vendor.mobile);

  for (const mobile of whatsappTargets) {
    const whatsappPayload = {
      mobile,
      token: vendor.token,
      rfq_id,
      rfq_no: rfqBasicDetails?.rfq_no,
      buyerName: org_name,
      name: vendorName
    };
    await whatsappNotificationAISensy.sendQuoteReminderNotificationToVendor(
      whatsappPayload
    );
  }

  const notificationData = {
    type: 'RFQ Pending',
    title: `RFQ Pending`,
    message: `RFQ Response Pending`,
    additional_data: {
      user_type: vendor.user_type
    }
  };
  const payload = {
    title: `Hello ${vendorCode}`,
    body: `RFQ Response Pending `
  };

  if (vendor.endpoint) {
    try {
      const parsedEndpoint =
        typeof vendor.endpoint === 'string'
          ? JSON.parse(vendor.endpoint)
          : vendor.endpoint;
      if (parsedEndpoint) {
        sendNotification(vendor.user_id, '', notificationData, payload, parsedEndpoint);
      }
    } catch (error) {
      logger.warn('Failed to parse vendor endpoint for notifications');
    }
  }
};

const dispatchReminderSequence = async (
  vendors,
  org_name,
  rfq_id,
  rfqBasicDetails
) => {
  let processed = 0;
  for (const vendor of vendors) {
    try {
      await sendReminderRFQMAIL(vendor, org_name, rfq_id, rfqBasicDetails);
    } catch (error) {
      logError(error);
    }
    processed += 1;
    if (processed % REMINDER_SEND_YIELD_THRESHOLD === 0) {
      await yieldReminderEventLoop();
    }
  }
};

const hydrateReminderTokens = async (vendors, rfq_id) => {
  const missingVendorIds = vendors
    .filter((vendor) => !vendor.token)
    .map((vendor) => vendor.user_id);

  if (!missingVendorIds.length) return;

  const tokenRows = await rfqModel.ensureVendorTokens(rfq_id, missingVendorIds);
  if (!tokenRows?.length) return;

  const tokenMap = new Map(
    tokenRows.map((row) => [row.vendor_id, row.token])
  );

  vendors.forEach((vendor) => {
    if (!vendor.token && tokenMap.has(vendor.user_id)) {
      vendor.token = tokenMap.get(vendor.user_id);
    }
  });
};


const sendQuoteNotificationEmail = async (req) => {
  let { rfq_id, rfq_no } = req.body;

    let u = await rfqModel.getRFQCreatedBy(rfq_id);
    if (u.length > 0) {
      let buyer = u[0];

      const rfqDetails = await rfqModel.getRfqWithHospitalityDetails(rfq_id);
      const rfqTitle = rfqDetails?.title || '-';
      const buName = rfqDetails?.hotel_name || '-';
      const companyName = rfqDetails?.hospitality_company_name || '-';

      // Email header content
      const headerContent = `<h2>Hello ${buyer.company_name || buyer.organization_name || ''},</h2>`;

      // Email body content
      const containerContent = `
      <div style="font-size:16px; font-family: 'Roboto', sans-serif;">
        <p>
          You've received a new quotation! Check out the details below:
        </p>
        <p><strong>RFQ:</strong> #${rfq_no} — ${rfqTitle}</p>
        <p><strong>Company:</strong> ${companyName}</p>
        <p><strong>BU:</strong> ${buName}</p>

        <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfq_id}"
            style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
           Review the Quotation
        </a>

        <p style="margin-top:20px; text-align:center; ">
          We're here to help you get the best deal.
        </p>
      </div>`;

      // Generate final email layout
      const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

      // Preparing the email details
      // NOTE: `from` intentionally omits the vendor name — quotes stay sealed until the submission deadline.
      let mailRecipients = {
        from: Config.masterEmail,
        subject: `New Quotation Received for Your RFQ ${rfq_no}`,
        html: dynamicHTML
      };

      // fetch spoc for buyer
       const spocList = await vendorModel.getSpocDetails(buyer?.id, rfq_id)

      if (spocList && spocList.length > 0) {
        mailRecipients.to = spocList.map(spoc => spoc.email);
        // mailRecipients.cc = buyer.email;
      } else {
        mailRecipients.to = buyer.email;
      }

      // Add project members to CC
      const projectMemberEmails = await getProjectMemberEmailsForRFQ(rfq_id);
      addProjectMembersToCC(mailRecipients, projectMemberEmails);

      // Sending the email to the buyer
      sendMail(mailRecipients);

      const vendorCompanyName =
        req.user?.company_name || req.user?.organization_name || req.user?.name || 'A vendor';
      const productCount = Array.isArray(req.body?.products) ? req.body.products.length : 0;

      dispatchNotification({
        userIds: [buyer.id],
        category: 'rfq',
        type: 'vendor_quote_submitted',
        title: `New quotation for RFQ #${rfq_no}`,
        body: `${vendorCompanyName} submitted a quote. Review and compare.`,
        data: { rfq_id, vendor_id: req.user?.id, product_count: productCount },
        actionUrl: `${process.env.FRONT_END_WEBSITE || ''}/dashboard/buyer/quote-compare?rfq=${rfq_id}`
      }).catch((err) => logError('dispatch vendor_quote_submitted failed', err));

      // console.log(`Quotation update email sent to buyer: ${buyer.email}`);
    }
  }


  //  vendorData, rfq_id, rfq_no, buyerName
 const sendRfqUpdatedMailToVendors = async (
   vendorData,
   rfq_id,
   rfq_no,
   buyer_name,
   emailType,
   changedDetails = []
 ) => {
   // Parallelize the per-vendor SPOC + token + render work. Originally a
   // sequential `for await` loop, which on RFQs with N vendors did 2*N
   // sequential DB roundtrips for what is purely independent work.
   // sendMail is already fire-and-forget so we don't await it.
   try {
     await Promise.all(
       vendorData.map(async (vendor) => {
         try {
           const { name, email, vendor_id } = vendor;

           const [spocs, tokenData] = await Promise.all([
             vendorModel.getSpocDetails(vendor_id, rfq_id),
             rfqModel.getVendorRfqToken(vendor_id, rfq_id)
           ]);
           const token = tokenData.length > 0 ? tokenData[0].token : '';

           const validSpocEmails = spocs
             .map((spoc) => spoc?.email)
             .filter((email) => typeof email === 'string' && email.includes('@'));

           const { subject, header, content } = getRfqEmailContent({
             vendor_name: name,
             rfq_no,
             buyer_name,
             rfq_id,
             token,
             emailType,
             changedDetails
           });

           const html = generateEmailTemplate(header, content);

           const mail = {
             from: `${buyer_name} ${Config.masterEmail}`,
             subject,
             html
           };

           if (validSpocEmails.length > 0) {
             mail.to = validSpocEmails;
             mail.cc = email || '';
           } else {
             mail.to = email || '';
           }

           // NOTE: Do NOT add project members to CC for vendor emails to prevent data leakage

           sendMail(mail);
         } catch (perVendorErr) {
           // Per-vendor failure shouldn't kill the whole batch.
           logError(`[sendRfqUpdatedMailToVendors] vendor ${vendor?.vendor_id} failed`, perVendorErr);
         }
       })
     );
   } catch (err) {
     logError('Error in sendRfqUpdatedMailToVendors', err);
     throw err;
   }
 };
  
const sendAddTechCommentMailForVendor = async (vendor , product, rfq_no,  sender_id , text) => {
  try {
    const productName = product.name;
    const vendor_name = vendor.vendor_name;

    const buyer_details = await userModel.user_profile_detail(sender_id);
    // const rfq = await rfqModel.checkIfExists('tbl_rfq', `rfq_no = '${rfq_no.id}'`);
    const rfq_id = rfq_no.id;

    try {
      const spocList = await vendorModel.getSpocDetails(vendor.vendor_id , rfq_id);
      const token = await rfqModel.insertVendorRfqToken(vendor.vendor_id, rfq_id);

      // Product HTML content
      let productHTML = `
        <tr>
          <td style="padding: 8px 0; font-family: 'Roboto', sans-serif; font-size: 16px;">
            <strong>Product:</strong> ${productName}
          </td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-family: 'Roboto', sans-serif; font-size: 16px;">
            <strong>RFQ No:</strong> ${rfq_no.rfq_no}
          </td>
        </tr>
      `;

      const headerContent = `
        <div>
          <h2>Hello ${vendor_name}</h2>
          <p style="font-size:16px;">
            The buyer has added a new <strong> Deviation in The Technical Clause</strong> for product <strong>${productName}</strong> under RFQ <strong>${rfq_no.rfq_no}</strong>. 
            Kindly review it at the earliest.
          </p>
        </div>
      `;

      const containerContent = `
      <div style="font-family: 'Roboto', sans-serif; color: #333;">
        <h3 style="text-align: center; font-size: 24px; margin-bottom: 12px; color: #2E5BA8;">
          New Technical Clause Comment
        </h3>

          <p style="font-size: 16px; line-height: 1.5; text-align: center; margin-bottom: 20px;">
            ${text}
          </p>

          <table style="width: 100%; padding: 8px; border-collapse: collapse; margin-bottom: 20px;">
            <tbody>
              ${productHTML}
              <tr><td></td></tr>
            </tbody>
          </table>

          <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${token}"
            style="background-color: #2E5BA8; color: white; font-family: 'Roboto', sans-serif;
                  text-align: center; padding: 12px 24px; display: inline-block; 
                  border-radius: 8px; font-size: 16px; font-weight: 500;
                  text-decoration: none; margin: 0 auto; transition: background 0.3s;">
            View Deviation
          </a>

          <p style="margin-top: 20px; font-size: 14px; text-align: center; color: #555;">
            Please review the newly added comment to ensure alignment with the buyer's requirements.
          </p>
        </div>
`;


      const dynamicHTML = generateEmailTemplate(
        headerContent,
        containerContent
      );

      let mailRecipients = {
        from: `"${buyer_details[0]?.company_name}" <${
          buyer_details[0]?.email || Config.masterEmail
        }>`,
        subject: `New Technical Clause Comment - ${productName} (RFQ ${rfq_no.rfq_no})`,
        html: dynamicHTML
      };


      if (spocList && spocList.length > 0) {
        mailRecipients.to = spocList.map((spoc) => spoc.email);
      } else {
        mailRecipients.to = vendor.vendor_email;
      }

      // NOTE: Do NOT add project members to CC for vendor emails to prevent data leakage

      sendMail(mailRecipients);

      logger.info(`Email sent successfully to vendor: ${vendor.vendor_name}`);
    } catch (vendorError) {
      logError(`Error sending email to vendor ${vendor.id}`, vendorError);
    }

    return {
      success: true,
      message: 'Technical clause comment notification sent to vendor'
    };
  } catch (error) {
    logError('Error in sendAddTechCommentMail', error);
    throw error;
  }
};

const sendTechEvalAccepOrRejectMailToVendor = async (
  rfq_id,
  product,
  vendor_id,
  buyer_id,
  reject_message
) => {
  try {
    let productName;

    if (Array.isArray(product)) {
      // If it's an array, take the first element's name
      productName = product[0]?.name;
    } else if (product && typeof product === 'object') {
      // If it's a single object, use its name
      productName = product.name;
    } else {
      productName = null; // fallback
    }


    const vendor_details = await userModel.user_profile_detail(vendor_id);
    const vendor = vendor_details[0];
 
    const buyer_details = await userModel.user_profile_detail(buyer_id);
    const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = '${rfq_id}'`);

    try {
      const spocList = await vendorModel.getSpocDetails(vendor_id , rfq_id);
      const token = await rfqModel.insertVendorRfqToken(
        vendor_id,
        rfq_id
      );

      // Product info HTML
      let productHTML = `
        <tr>
          <td style="padding: 8px 0; font-family: 'Roboto', sans-serif; font-size: 16px;">
            <strong>Product:</strong> ${productName}
          </td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-family: 'Roboto', sans-serif; font-size: 16px;">
            <strong>RFQ No:</strong> ${rfq[0].rfq_no}
          </td>
        </tr>
      `;

      // ✅ Dynamic message based on rejection or acceptance
      let decisionMessage = "";
      let subjectLine = "";

      if (!reject_message) {
        // Accepted
        decisionMessage = `
          <p style="font-size:16px;">
            We are pleased to inform you that your submission for 
            <strong>${productName}</strong> under RFQ <strong>${rfq[0].rfq_no}</strong> 
            has been <strong style="color:green;">technically accepted</strong>.
          </p>
          <p style="font-size:16px;">
            You may proceed with the next steps as per the RFQ process.
          </p>
        `;
        subjectLine = `Technical Evaluation Accepted - ${productName} (RFQ ${rfq[0].rfq_no})`;
      } else {
        // Rejected
        decisionMessage = `
          <p style="font-size:16px;">
            We regret to inform you that your submission for 
            <strong>${productName}</strong> under RFQ <strong>${rfq[0].rfq_no}</strong> 
            has been <strong style="color:red;">technically rejected</strong>.
          </p>
          <p style="font-size:16px;">
            <strong>Reason for Rejection:</strong> ${reject_message}
          </p>
          <p style="font-size:16px;">
            Please review the rejection details and make necessary improvements for future submissions.
          </p>
        `;
        subjectLine = `Technical Evaluation Rejected - ${productName} (RFQ ${rfq[0].rfq_no})`;
      }

      const headerContent = `
        <div>
          <h2>Hello ${vendor.name},</h2>
          ${decisionMessage}
        </div>
      `;

      const containerContent = `
        <div>
          <h3 style="font-family: 'Roboto', sans-serif; text-align: center; font-size: 22px; margin-bottom: 8px;">
            Technical Evaluation Update
          </h3>

          <table style="width: 100%; padding: 8px;">
            <tbody>
              ${productHTML}
              <tr><td></td></tr>
            </tbody>
          </table>

          <a href=${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${token}
            style="background-color: #2563eb; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
            View Details
          </a>
        </div>
      `;

      const dynamicHTML = generateEmailTemplate(
        headerContent,
        containerContent
      );

      let mailRecipients = {
        from: `"${buyer_details[0]?.company_name || 'Phileein Hospitality'}" ${
          Config.masterEmail
        }`,
        subject: subjectLine,
        html: dynamicHTML
      };

      if (spocList && spocList.length > 0) {
        mailRecipients.to = spocList.map((spoc) => spoc.email);
      } else {
        mailRecipients.to = vendor.email;
      }

      // NOTE: Do NOT add project members to CC for vendor emails to prevent data leakage

      sendMail(mailRecipients);

      logger.info(`Email sent successfully to vendor: ${vendor.name} [${reject_message ? "Rejected" : "Accepted"}]`);
    } catch (vendorError) {
      logError(`Error sending email to vendor ${vendor.id}`, vendorError);
    }

    return {
      success: true,
      message: 'Technical evaluation decision email sent to vendor',
    };
  } catch (error) {
    logError('Error in sendTechEvalAccepOrRejectMailToVendor', error);
    throw error;
  }
};


const sendAddTechCommentMailForBuyer = async (buyer, vendor_id, product, text) => {
  try {
    const productName = product.name;
    const vendor_details = await userModel.user_profile_detail(vendor_id);
    const rfq_no = buyer.rfq_no;

    // For tenders, use vendor code instead of vendor name to protect identity
    const isTender = buyer.is_tender === 1;
    const vendorCode = `VEN-${product.rfq_product_vendor_id || vendor_id}`;
    const vendorName = isTender ? vendorCode : (vendor_details[0]?.company_name || "A Vendor");

    try {
      // Product HTML content
      let productHTML = `
        <tr>
          <td style="padding: 8px 0; font-family: 'Roboto', sans-serif; font-size: 16px;">
            <strong>Product:</strong> ${productName}
          </td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-family: 'Roboto', sans-serif; font-size: 16px;">
            <strong>RFQ No:</strong> ${rfq_no}
          </td>
        </tr>
      `;

      const headerContent = `
        <div>
          <h2>Hello ${buyer.companyName},</h2>
          <p style="font-size:16px;">
            Vendor <strong>${vendorName}</strong> has added a new <strong>Technical Clause Comment</strong> 
            for the product <strong>${productName}</strong> under RFQ <strong>${rfq_no}</strong>.
          </p>
        </div>
      `;

      const containerContent = `
        <div>
          <h3 style="font-family: 'Roboto', sans-serif; text-align: center; font-size: 24px; margin-bottom: 8px;">
            New Technical Clause Deviation
          </h3>
          <p style="font-size: 16px; line-height: 1.5; text-align: center; margin-bottom: 20px;">
            ${text}
          </p>
          <table style="width: 100%; padding: 8px;">
            <tbody>
              ${productHTML}
              <tr><td></td></tr>
            </tbody>
          </table>

         <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/technical-evaluation?rfq_id=${buyer.rfq_id}"
          style="background-color: #2563eb; color: white; font-family: 'Roboto', sans-serif; 
                text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; 
                width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
          View Deviation
        </a>


          <p style="margin-top:20px">
            Please review this newly added comment to ensure alignment with your requirements.
          </p>
        </div>
      `;

      const dynamicHTML = generateEmailTemplate(
        headerContent,
        containerContent
      );

      let mailRecipients = {
        from: `"${vendor_details[0]?.company_name}" <${vendor_details[0]?.email || Config.masterEmail}>`,
        to: buyer.response_email,
        subject: `Vendor ${vendorName} Added Technical Clause Deviation - ${productName} (RFQ ${rfq_no})`,
        html: dynamicHTML
      };

      // Add project members to CC
      const projectMemberEmails = await getProjectMemberEmailsForRFQ(buyer.rfq_id);
      addProjectMembersToCC(mailRecipients, projectMemberEmails);

      sendMail(mailRecipients);

      logger.info(`Email sent successfully to buyer: ${buyer.contactName}`);
    } catch (vendorError) {
      logError(`Error sending email for vendor ${vendor_id}`, vendorError);
    }

  } catch (error) {
    logError('Error in sendAddTechCommentMailForBuyer', error);
    throw error;
  }
};



const sendWinningNotificaion = async (
  vendorNonLoginRfqAccessToken,
  vendor_id,
  rfQItem,
  winning_product,
  winning_vendor_organization,
  winning_vendor_email,
  winning_vendor_name
) => {
  return new Promise(async (resolve, reject) => {

  

    const company = rfQItem.map(item => item.company_name);
    const rfqNumber = rfQItem.map(item => item.rfq_no);
   
    const size = winning_product[0]?.product_specs.find(spec => spec.title === 'Size')?.value || 'N/A';
    const spec = winning_product[0]?.product_specs.find(spec => spec.title === 'Spec')?.value || 'N/A';
    const quantity = winning_product[0]?.product_specs.find(spec => spec.title === 'Quantity')?.value || 'N/A';

    const headerContent = `<h2>Hello ${winning_vendor_name || ''},</h2>`;

const containerContent = ` 
<div style="font-size:16px; font-family: 'Roboto', sans-serif;">
  <p>
    <strong>${company}</strong> has made a selection for 
    <strong>#${rfqNumber} </strong>. We appreciate your participation and encourage you to stay active on Phileein Hospitality for future opportunities.
  </p>


  <h4> Product Details </h4> 
  <ul>
  <li> <strong> Product Name </strong> ${winning_product[0]?.product_details[0]?.name}  </li>
  <li> <strong> Size </strong> ${size}  </li>
  <li> <strong> Specification </strong> ${spec}  </li>
  <li> <strong> Quantity </strong> ${quantity} </li>
  </ul>


  <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfQItem[0]?.id}&token=${vendorNonLoginRfqAccessToken[0]?.token||''}"
     style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
    Go to Dashboard
  </a>

     <p style="margin-top:20px; text-align:center;"> <strong> Explore More Leads: </strong> New RFQs are frequently posted, so check back regularly to find other opportunities.</p>
  <p style="margin-top:20px; text-align:center;">
    Thank you for partnering with us,
  </p>
</div>`;

// Generate final email layout
const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

    const spocList = await vendorModel.getSpocDetails(vendor_id , rfQItem[0]?.id);

    // console.log(" rfq contoller 901 spoc console ", vendor_id, spocList)

    let mailRecipients = {
      from: Config.webmasterMail,
      subject: `${rfQItem[0]?.company_name} Has Finalized Their Choice for #${rfQItem[0]?.rfq_no} `, // Subject line
      html: dynamicHTML
    };

    if (spocList && spocList.length > 0) {
      mailRecipients.to = spocList.map(spoc => spoc.email);
          mailRecipients.cc =  winning_vendor_email;
    } else {
          mailRecipients.to =  winning_vendor_email;
    }

    // NOTE: Do NOT add project members to CC for vendor emails to prevent data leakage

    sendMail(mailRecipients);

    dispatchNotification({
      userIds: [vendor_id],
      category: 'rfq',
      type: 'vendor_finalized_winner',
      title: `You've been finalized for RFQ #${rfQItem[0]?.rfq_no}`,
      body: `${rfQItem[0]?.company_name || 'The buyer'} has selected your quote for ${winning_product[0]?.product_details[0]?.name || 'the product'}.`,
      data: { rfq_id: rfQItem[0]?.id, product: winning_product[0]?.product_details[0]?.name },
      actionUrl: `${process.env.FRONT_END_WEBSITE || ''}/dashboard/vendor/inquiries-details?id=${rfQItem[0]?.id}`
    }).catch((err) => logError('dispatch vendor_finalized_winner failed', err));

    // sendMail({
    //   from: Config.webmasterMail, // sender address
    //   to: winning_vendor_email, // list of receivers
    //   subject: `Work Wise | Quotation Winner | Congratulation`, // Subject line
    //   html: dynamicHTML // plain text body
    // });
    resolve(true);
  });
};

const sendFinalizationRemovalMail = async (
  vendor_id,
  rfQItem,
  product,
  vendor_organization,
  vendor_email,
  vendor_name
) => {
  try {
    const company = rfQItem.map(item => item.company_name);
    const rfqNumber = rfQItem.map(item => item.rfq_no);

    const size = product[0]?.product_specs.find(spec => spec.title === 'Size')?.value || 'N/A';
    const spec = product[0]?.product_specs.find(spec => spec.title === 'Spec')?.value || 'N/A';
    const quantity = product[0]?.product_specs.find(spec => spec.title === 'Quantity')?.value || 'N/A';

    const headerContent = `<h2>Hello ${
      vendor_name || 'Mukul Vendor'
    },</h2>`;

    const containerContent = ` 
<div style="font-size:16px; font-family: 'Roboto', sans-serif;">
  <p>
    <strong>${company}</strong> has made a selection for 
    <strong>#${rfqNumber} </strong>. You are no longer finalized for <strong>${product[0]?.product_details[0]?.name}</strong>
  </p>

  <h4> Product Details </h4> 
  <ul>
  <li> <strong> Product Name </strong> ${
    product[0]?.product_details[0]?.name
  }  </li>
  <li> <strong> Size </strong> ${size}  </li>
  <li> <strong> Specification </strong> ${spec}  </li>
  <li> <strong> Quantity </strong> ${quantity} </li>
  </ul>

     <p style="margin-top:20px; text-align:center;"> <strong> Explore More Leads: </strong> New RFQs are frequently posted, so check back regularly to find other opportunities.</p>
  <p style="margin-top:20px; text-align:center;">
    Thank you for partnering with us,
  </p>
</div>`;

    // Generate final email layout
    const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

    const spocList = await vendorModel.getSpocDetails(vendor_id , rfQItem[0]?.id);

    // console.log(" rfq contoller 901 spoc console ", vendor_id, spocList)

    let mailRecipients = {
      from: Config.webmasterMail,
      subject: `${rfQItem[0]?.company_name} Has Made a decision for #${rfQItem[0]?.rfq_no} `, // Subject line
      html: dynamicHTML
    };

    if (spocList && spocList.length > 0) {
      mailRecipients.to = spocList.map((spoc) => spoc.email);
      mailRecipients.cc = vendor_email;
    } else {
      mailRecipients.to = vendor_email;
    }

    // NOTE: Do NOT add project members to CC for vendor emails to prevent data leakage

    sendMail(mailRecipients);

    dispatchNotification({
      userIds: [vendor_id],
      category: 'rfq',
      type: 'vendor_de_finalized',
      title: `Decision made for RFQ #${rfQItem[0]?.rfq_no}`,
      body: `You're no longer finalized for ${product[0]?.product_details[0]?.name || 'the product'}. Check other open opportunities.`,
      data: { rfq_id: rfQItem[0]?.id, product: product[0]?.product_details[0]?.name },
      actionUrl: `${process.env.FRONT_END_WEBSITE || ''}/dashboard/vendor/inquiries-details?id=${rfQItem[0]?.id}`
    }).catch((err) => logError('dispatch vendor_de_finalized failed', err));

    return true;
  } catch (error) {
    throw error;
  }
};

const getVendorDetails = async (item, user_has_subscription) => {
  const vendor_approved = await rfqModel.getVendorApprovedBy(item.id);
  item.vendor_approved = vendor_approved;
  if (!user_has_subscription) {
    item.email = '*******@****.***';
    item.mobile = '+91**********';
    item.address = '********** ********** **********';
    item.website = 'https://**********.***';
  }
  item.sp = user_has_subscription;
  return item;
};

const removeDuplicates = (products) => {
  const uniqueItems = {};

  // changes by Mukul jatav 28-08-2024
  // removed products when parent id is not equals to 0
  const productList = products.filter(item => item.parent_category_id === 0);

  const filteredData = productList.filter((item) => {
    const key = `${item.variant_id}_${item.category_id}`;
    if (!uniqueItems[key]) {
      uniqueItems[key] = true;
      return true;
    }
    return false;
  });
  return filteredData;
};

const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
};


const saveRfqDraft = async (user_id, reqBody, { isDraft = false } = {}) => {
  const {
      rfq_id,
      sheet_id = null,
      comment,
      company_name,
      contact_name,
      contact_number,
      bid_end_date,
      location,
      updatableData,
      filters,
      terms,
      rfq_type,
      reverse_auction,
      is_tender,
      tender_fees,
      tender_publish_date,
      vendor_clarification_date,
      hospitality_company_id,
      hotel_id,
      hotel_ids,
      department_id,
      process_id,
      ra_start_date,
      ra_end_date,
      project_id,
      term_and_condition_files,
      termsChanged,
      termFilesChanged,
      title,
  } = reqBody;
  const response_email = reqBody.response_email?.toLowerCase() || '';

  // Validate hospitality context access if provided
  if (hospitality_company_id) {
    const hasAccess = await hospitalityModel.userHasContext(
      user_id,
      hospitality_company_id,
      hotel_id || null
    );
    if (!hasAccess) {
      throw new Error(JSON.stringify({
        message: 'You do not have access to the selected hospitality company or hotel',
        status: 2
      }));
    }
  }

  // Validate process_id if provided
  if (process_id && hospitality_company_id) {
    // Get parent company from hospitality company
    const hospCompany = await db.oneOrNone(
      `SELECT buyer_company_id AS company_id FROM tbl_hospitality_companies WHERE id = $1`,
      [hospitality_company_id]
    );

    if (!hospCompany) {
      throw new Error(JSON.stringify({
        message: 'Invalid hospitality company',
        status: 3
      }));
    }

    // Validate process belongs to parent company
    const processExists = await db.oneOrNone(
      `SELECT id FROM tbl_approval_processes
       WHERE id = $1 AND company_id = $2 AND is_active = true`,
      [process_id, hospCompany.company_id]
    );

    if (!processExists) {
      throw new Error(JSON.stringify({
        message: 'Invalid process for this company or process is inactive',
        status: 3
      }));
    }
  }

  const globalFilters = filters?.global;

  const rfqFilters = [];

  // Build RFQ filter rows only when global filters are present
  if (globalFilters) {
    for (const key in globalFilters) {
      const value = globalFilters[key];

      // If value is an array → create multiple rows
      if (Array.isArray(value)) {
        value.forEach((v) => {
          rfqFilters.push({
            rfq_id,
            type: key,
            value: v,
            user_id,
          });
        });
      }
      // If value is NOT an array and NOT null → single row
      else if (value !== null && value !== undefined && value !== "") {
        rfqFilters.push({
          rfq_id,
          type: key,
          value: value,
          user_id,
        });
      }
    }
  }

  // Auto-assign or create a default project mapped to the selected hotel
  let effectiveProjectId = project_id;
  try {
    if ((!effectiveProjectId || effectiveProjectId === '' || effectiveProjectId === -1) && hospitality_company_id && hotel_id) {
      // 1 = hotel-level mapping
      const existingMappings = await hospitalityModel.getProjectMappingsForContext(
        hospitality_company_id,
        1,
        hotel_id
      );

      if (existingMappings && existingMappings.length > 0) {
        effectiveProjectId = existingMappings[0].project_id;
      } else {
        // Create a minimal default project for this hotel context
        const defaultProjectName = `Auto Project - Hotel ${hotel_id}`;
        const tbl_project_data = {
          name: defaultProjectName,
          description: `Auto-created project for hotel ${hotel_id}`,
          location: null,
          ended_at: null,
          rfq_type,
          reverse_auction,
          budget: 0,
          user_id,
        };

        const createdProject = await projectModel.createProject(tbl_project_data);
        const newProjectId = createdProject?.id || createdProject?.project_id;

        if (newProjectId) {
          effectiveProjectId = newProjectId;

          // Map the project to the hospitality hotel context
          await hospitalityModel.insertProjectMappings([
            {
              project_id: newProjectId,
              hospitality_company_id,
              hospitality_hotel_id: hotel_id,
              mapping_type: 1,
              created_by: user_id,
            },
          ]);
        }
      }
    }
  } catch (autoProjectErr) {
    // Log but do not block RFQ creation if auto project logic fails
    logError(autoProjectErr);
  }

  // Normalize reverse_auction to ensure consistent comparison
  const isReverseAuction = reverse_auction === 1 || reverse_auction === '1' || reverse_auction === true;

  // Helper to normalize date values - convert empty strings to null,
  // and ensure bare YYYY-MM-DD dates get a T00:00:00 time component
  // so they don't look artificially changed when later edited with time.
  const normalizeDate = (dateValue) => {
    if (!dateValue || dateValue === '' || dateValue === 'null' || dateValue === 'undefined') {
      return null;
    }
    // If the value is a bare date (YYYY-MM-DD) without time, append T00:00:00
    if (typeof dateValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateValue.trim())) {
      return dateValue.trim() + 'T00:00:00';
    }
    return dateValue;
  };

  const rfqData = {
      comment,
      company_name,
      response_email,
      contact_name,
      contact_number,
      // bid_end_date is `text NOT NULL` on tbl_rfq, so a draft with no
      // deadline yet has to round-trip as an empty string. The GET handler
      // (getDraftById) maps '' back to null when serialising the response.
      bid_end_date: normalizeDate(bid_end_date) ?? '',
      location,
      rfq_type,
      reverse_auction: isReverseAuction ? 1 : 0,
      is_tender: is_tender !== undefined ? is_tender : 0,
      tender_fees: is_tender === 1 ? (tender_fees || 0) : 0,
      tender_publish_date: normalizeDate(tender_publish_date) || null,
      vendor_clarification_date: normalizeDate(vendor_clarification_date) || null,
      hospitality_company_id: hospitality_company_id || null,
      hotel_id: hotel_id || null,
      department_id: department_id || null,
      process_id: process_id || null,
      ra_start_date: isReverseAuction ? normalizeDate(ra_start_date) : null,
      ra_end_date: isReverseAuction ? normalizeDate(ra_end_date) : null,
      is_published: 0,
      updated_by: user_id,
      title: title || null,
  };

  const errorObj = { vendorNotPresent: [] };

  if (effectiveProjectId && effectiveProjectId !== -1) {
      rfqData.project_id = effectiveProjectId;
  } else if (!effectiveProjectId || effectiveProjectId == '') {
    rfqData.project_id = null;
  }

  let rfqDetail = null;
  
  await db.tx(async (t) => {
    rfqDetail = await rfqModel.updateWithTimestamp('tbl_rfq', rfqData, rfq_id, t);
    if(rfqDetail)
      rfqDetail = rfqDetail[0]
    else
      rfqDetail = {};
  
    // Persist hotel selection (Create Tender: selected hotels must be saved)
    const hotelIdsToSync = Array.isArray(hotel_ids) ? hotel_ids : [];
    if (hotelIdsToSync.length > 0) {
      await hospitalityModel.reconcileRFQHotels(rfq_id, hotelIdsToSync, user_id);
    }
  
    // Handle terms update — when the user has touched the terms field
    // (`termsChanged === true`), the full set of selections is replaced.
    // An empty array is a legitimate state (user deselected every term)
    // and must clear the join table; the previous combined guard skipped
    // the delete in that case and left stale rows behind, which then
    // resurfaced as "all terms selected" on the next reload.
    if (termsChanged) {
        await rfqModel.deleteWithReturnIds('tbl_rfq_terms_map', { rfq_id }, t);

        if (Array.isArray(terms) && terms.length > 0) {
            const rfqTerms = terms.map(term => ({
                rfq_id,
                terms_id: typeof term.id === 'number' ? term.id : parseInt(term.id)
            }));
            await rfqModel.insertArray(rfqTerms, ['rfq_id', 'terms_id'], 'tbl_rfq_terms_map', t);
        }
    }
  
    if (termFilesChanged && term_and_condition_files) {
      // First delete existing term files only if term files have changed
      await rfqModel.deleteWithReturnIds('tbl_rfq_files', { rfq_id, file_type: 'term_and_condition' }, t);
  
      const rfqFiles = term_and_condition_files.map(url => ({
          rfq_id,
          file_type: 'term_and_condition',
          file_url: url
      }));
      if(term_and_condition_files.length > 0)
        await rfqModel.insertArray(rfqFiles, ['rfq_id', 'file_type', 'file_url'], 'tbl_rfq_files', t);
    }
    
    const products = updatableData?.products;
    const updatableVendors = updatableData?.vendors;

    if (products && products?.updatable) {
      if (products.updatable?.specs)
        for (const rfqProductId of Object.keys(products.updatable.specs)) {
          if(products?.deletable && products.deletable.length > 0 && products.deletable.includes(parseInt(rfqProductId))) continue;
          const productId = products.updatable.specs[rfqProductId].product_id;
          const variant = products.updatable.specs[rfqProductId].variant;
          delete products.updatable.specs[rfqProductId].variant;
          delete products.updatable.specs[rfqProductId].product_id;

          let whereClause = `rfq_id = (${rfq_id})::INT AND product_variant_id = (${productId})::INT AND variant = (${
            variant ?? '0'
          })::INT`;

          for (const spec of Object.keys(products.updatable.specs[rfqProductId])) {
            let value = products.updatable.specs[rfqProductId][spec]
            if(spec == 'Quantity')
              value = parseFloat(value) || '';

              const data = {
                value
              };
              const currentWhereClause = whereClause + ` AND title = '${spec}'`;
              const doesExist = await rfqModel.checkIfExists(
                'tbl_rfq_products_specs',
                currentWhereClause,
                t,
              );
              if (doesExist && doesExist.length > 0) {
                await rfqModel.updateWhere(
                  'tbl_rfq_products_specs',
                  data,
                  currentWhereClause,
                  t
                );
              } else {
                const insertData = {
                  ...data,
                  rfq_id,
                  product_variant_id: productId,
                  title: spec,
                  variant: parseInt(variant ?? '0')
                };
                await rfqModel.insert(
                  'tbl_rfq_products_specs',
                  insertData,
                  t
                );
              }
            }
        };

      if (products.updatable?.files)
        for (const rfqProductId of Object.keys(products.updatable.files)) {
          if(products?.deletable && products.deletable.length > 0 && products.deletable.includes(parseInt(rfqProductId))) continue;
          delete products.updatable.files[rfqProductId].variant;
          delete products.updatable.files[rfqProductId].product_id;

          let whereClause = `rfq_product_id = (${rfqProductId})::INT`;

          for (const fileType of Object.keys(
            products.updatable.files[rfqProductId]
          )) {
            const transformedFileType =
              fileType == 'qap_file'
                ? 'QAP'
                : fileType == 'spec_file'
                ? 'SPEC'
                : 'TDS';

            const currentWhereClause =
              whereClause + ` AND file_type = '${transformedFileType}'`;
            const doesExist = await rfqModel.checkIfExists(
              'tbl_rfq_product_files',
              currentWhereClause,
              t
            );
            const data = products.updatable.files[rfqProductId][fileType];
            const isRemovable = !Array.isArray(data) && data == 'rm';

            if (doesExist && doesExist.length > 0) {
              const conditions = {
                rfq_product_id: rfqProductId,
                file_type: transformedFileType
              };
              await rfqModel.delete('tbl_rfq_product_files', conditions, t);
              if (!isRemovable) {
                const insertableData = data.map((file_url) => ({
                  rfq_product_id: rfqProductId,
                  file_type: transformedFileType,
                  file_url
                }));
                await rfqModel.insertArray(
                  insertableData,
                  Object.keys(insertableData[0]),
                  'tbl_rfq_product_files',
                  t
                );
              }
            } else if (!isRemovable) {
              const insertableData = data.map((file_url) => ({
                rfq_product_id: rfqProductId,
                file_type: transformedFileType,
                file_url
              }));
              await rfqModel.insertArray(
                insertableData,
                Object.keys(insertableData[0]),
                'tbl_rfq_product_files',
                t
              );
            }
          }
        };

      if (products.updatable?.comment)
        for (const rfqProductId of Object.keys(products.updatable.comment)) {
            if(products?.deletable && products.deletable.length > 0 && products.deletable.includes(parseInt(rfqProductId))) continue;
            const productId =
              products.updatable.comment[rfqProductId].product_id;
            const variant = products.updatable.comment[rfqProductId].variant;
            const comment = products.updatable.comment[rfqProductId].comment;

            let whereClause = `rfq_id = (${rfq_id})::INT AND product_variant_id = (${productId})::INT AND variant = (${variant})::INT`;

            const data = {
              comment
            };
            await rfqModel.updateWhere(
              'tbl_rfq_products',
              data,
              whereClause,
              t
            );
          }
    }

    if (products && products?.deletable && products.deletable.length > 0) {
      for (const rfqProductId of products.deletable) {
        // Delete records from tbl_rfq_products
        let deletedRecord = await rfqModel.delete(
          'tbl_rfq_products',
          {
            id: rfqProductId
          },
          t
        );
        if (!deletedRecord || deletedRecord.length === 0) continue;

        deletedRecord = deletedRecord[0];

        // Delete vendor mapping
        const vendorConditions = {
          rfq_id,
          product_variant_id: deletedRecord.product_variant_id,
          variant: deletedRecord.variant
        };
        await rfqModel.delete(
          'tbl_rfq_product_vendors',
          vendorConditions,
          t
        );

        // Directly deleting specs
        await rfqModel.delete(
          'tbl_rfq_products_specs',
          vendorConditions,
          t
        );

        // Delete associated files
        const directRfqProductConditions = { rfq_product_id: rfqProductId };
        await rfqModel.delete(
          'tbl_rfq_product_files',
          directRfqProductConditions,
          t
        );

        // Delete tech evaluations
        const techEvaluationCondition = { tbl_rfq_product_id: rfqProductId };
        const techEvaluationDeletedRecordsIds =
          await rfqModel.deleteWithReturnIds(
            'tbl_rfq_product_tech_evaluation',
            techEvaluationCondition,
            null,
            null,
            t
          );

        // Delete tech evaluation clauses and other nested data
        if (techEvaluationDeletedRecordsIds?.length > 0) {
          for (const techEvaluationId of techEvaluationDeletedRecordsIds) {
            const techEvaluationClauseCondition = {
              tbl_rfq_product_tech_evaluation_id: techEvaluationId
            };

            const techEvaluationClausesDeletedRecordsIds =
              await rfqModel.deleteWithReturnIds(
                'tbl_rfq_product_tech_evaluation_clauses',
                techEvaluationClauseCondition,
                null,
                null,
                t
              );

            // Delete cleared vendors
            await rfqModel.deleteWithReturnIds(
              'tbl_rfq_product_tech_evaluation_cleared_vendors',
              techEvaluationClauseCondition,
              null,
              null,
              t
            );

            if (techEvaluationClausesDeletedRecordsIds?.length > 0) {
              for (const techEvaluationClauseId of techEvaluationClausesDeletedRecordsIds) {
                const clauseCondition = {
                  tbl_rfq_product_tech_evaluation_clauses_id:
                    techEvaluationClauseId
                };

                await rfqModel.delete(
                  'tbl_rfq_product_tech_evaluation_clauses_files',
                  clauseCondition,
                  t
                );

                const techEvaluationVendorResponseDeletedRecords =
                  await rfqModel.deleteWithReturnIds(
                    'tbl_rfq_product_tech_evaluation_vendors_response',
                    clauseCondition,
                    null,
                    null,
                    t
                  );

                if (techEvaluationVendorResponseDeletedRecords?.length > 0) {
                  for (const vendorResponse of techEvaluationVendorResponseDeletedRecords) {
                    const vendorResponseCondition = {
                      tbl_rfq_product_tech_evaluation_vendors_response_id:
                        vendorResponse
                    };

                    await rfqModel.delete(
                      'tbl_rfq_product_tech_evaluation_vendors_response_files',
                      vendorResponseCondition,
                      t
                    );
                  }
                }

                const techEvaluationCommentsDeletedRecords =
                  await rfqModel.deleteWithReturnIds(
                    'tbl_rfq_product_tech_evaluation_comments',
                    clauseCondition,
                    null,
                    null,
                    t
                  );

                if (techEvaluationCommentsDeletedRecords?.length > 0) {
                  for (const evaluationComment of techEvaluationCommentsDeletedRecords) {
                    const commentFilesCondition = {
                      tbl_rfq_product_tech_evaluation_comments_id:
                        evaluationComment
                    };

                    await rfqModel.deleteWithReturnIds(
                      'tbl_rfq_product_tech_evaluation_comments_files',
                      commentFilesCondition,
                      null,
                      null,
                      t
                    );
                  }
                }
              }
            }
          }
        }
      }
    }

    const hasGlobalOrLocalFilters =
      hasValidFilters(filters.global) ||
      (filters.local &&
        Object.values(filters.local).some((rfqProductFilter) =>
          hasValidFilters(rfqProductFilter)
        ));

    if (hasGlobalOrLocalFilters) {
      let applicableFilters = generalModel.generateFilters(
        filters.global,
        VENDORS_FILTER_KEYS
      );

      const rfqFilterExists = await rfqModel.checkIfExists(
        'tbl_rfq_filters',
        `rfq_id = ${rfq_id}`
      );

    if(rfqFilterExists.length > 0){
      // Delete existing RFQ filters
      await rfqModel.delete('tbl_rfq_filters', { rfq_id }, t);

      //insert new RFQ filters
      await rfqModel.insertArray(rfqFilters , ['rfq_id', 'type', 'value', 'user_id'], 'tbl_rfq_filters', t);
    } else {
      //insert new RFQ filters
      await rfqModel.insertArray(rfqFilters , ['rfq_id', 'type', 'value', 'user_id'], 'tbl_rfq_filters', t);
    }
    

      const rfqProducts = await rfqModel.checkIfExists(
        'tbl_rfq_products',
        `rfq_id = ${rfq_id} AND id IN (${Object.keys(filters.local)
          .map((key) => parseInt(key))
          .filter(Boolean)
          .join(',')}) ${
          sheet_id
            ? ` AND sheet_id = ${sheet_id}`
            : ` AND sheet_id IS NULL`
        }`,
        t
      );


      if (rfqProducts && Array.isArray(rfqProducts) && rfqProducts.length > 0) {
        for (let product of rfqProducts) {
          const rfqProductId = product.id;
          if(!filters.local?.[rfqProductId]) continue;

          const doesLocalExist = Object.keys(filters.local?.[rfqProductId] ?? {}).length > 0;

          if (doesLocalExist) {
            applicableFilters = generalModel.generateFilters(
              filters.local[rfqProductId],
              VENDORS_FILTER_KEYS
            );
          }

          const remainingVendors = await rfqModel.getDraftProductVendors(
            rfq_id,
            rfqProductId,
            user_id,
            applicableFilters
          );


          const deletingCondition = {
            rfq_id,
            product_variant_id: product.product_variant_id,
            variant: product.variant,
            '-user_ids': remainingVendors
              .map((vendor) => vendor.user_id)
              .filter(Boolean)
          };

          if (
            deletingCondition['-user_ids'].length <= 0 &&
            (updatableVendors[rfqProductId]?.addable ?? []).length <= 0
          ) {

          // Push product ID into errorObj.vendorNotPresent
            errorObj.vendorNotPresent.push({
              rfqProductId,
              product_variant_id: product.product_variant_id,
              variant: product.variant,
            });          
            continue;
          }

          await rfqModel.delete(
            'tbl_rfq_product_vendors',
            deletingCondition,
            t,
          );

          // Step 1: Evaluate all checks in parallel
          const vendorChecks = await Promise.all(
            remainingVendors.map(async (vendor) => {
              const exists = await rfqModel.checkIfExists(
                'tbl_rfq_product_vendors',
                `rfq_id = ${rfq_id} AND product_variant_id = ${
                  product.product_variant_id
                } AND variant = '${product.variant}' AND user_id = ${
                  vendor.user_id
                } ${
                  sheet_id
                    ? ` AND sheet_id = ${sheet_id}`
                    : ` AND sheet_id IS NULL`
                }`
              );
              return {
                vendor,
                shouldInsert: (exists ?? []).length === 0,
              };
            })
          );

          // Step 2: Filter based on result
          const filteredVendors = vendorChecks
            .filter(v => v.shouldInsert)
            .map(v => v.vendor);

          // Step 3: Prepare for insertion
          const insertVendors = filteredVendors.map(vendor => ({
            rfq_id,
            product_variant_id: product.product_variant_id,
            variant: product.variant,
            user_id: vendor.user_id,
            sheet_id,
          }));

          // Step 4: Insert
          if (insertVendors.length > 0) {
            await rfqModel.insertArray(
              insertVendors,
              Object.keys(insertVendors[0]),
              'tbl_rfq_product_vendors',
              t
            );
          }
        }

        // ✅ After loop: Throw combined error (only when publishing, not when saving draft)
        if (!isDraft && errorObj.vendorNotPresent.length > 0) {
         throw new Error(
           JSON.stringify({
             message: "Some products have no vendors. Please remove product or add vendors for these products.",
             details: errorObj.vendorNotPresent,
           })
         );
         }

      }
    }

    if (updatableVendors && Object.keys(updatableVendors).length > 0) {
      for (const rfqProductId of Object.keys(updatableVendors)) {
        if(products?.deletable && products.deletable.length > 0 && products.deletable.includes(parseInt(rfqProductId))) continue;
        
        const productId = updatableVendors[rfqProductId].product_id;
        const variant = updatableVendors[rfqProductId].variant;

        const addable = updatableVendors[rfqProductId]?.addable ?? [];
        const deletable = updatableVendors[rfqProductId]?.deletable ?? [];

        // Insert new vendors
        if (!hasGlobalOrLocalFilters && addable.length > 0) {
          const addableData = addable.map((vendor) => ({
            rfq_id,
            product_variant_id: productId,
            user_id: vendor,
            variant
          }));

          await rfqModel.insertArray(
            addableData,
            Object.keys(addableData[0]),
            'tbl_rfq_product_vendors',
            t
          );
        }

        // Delete existing vendors
        if (deletable.length > 0) {
          for (const vendor of deletable) {
            let productDetails = await rfqModel.checkIfExists(
              'tbl_product_variant',
              `id = ${productId}`,
              t
            );
            if (!productDetails || productDetails.length === 0) continue;

            productDetails = productDetails[0];

            const conditions = {
              rfq_id,
              product_variant_id: productId,
              user_id: vendor,
              variant
            };

            await rfqModel.delete(
              'tbl_rfq_product_vendors',
              conditions,
              t
            );
          }
        }
      }
    }
  });

  return { status: 1, message: 'Draft has been saved successfully', rfq: {...rfqDetail} };
};


/**
 * duplicateRfqForHotels
 *
 * Duplicates a published RFQ for multiple hotels.
 * - Keeps the original RFQ for the first hotel
 * - Creates independent RFQs for remaining hotels
 * - Copies all related data (products, specs, vendors, files, terms)
 *
 * Approach:
 * - Uses a single DB transaction for atomicity
 * - Uses INSERT … SELECT for fast, set-based duplication
 * - Uses RETURNING only where new IDs are required
 * - Relies on DB sequence for unique rfq_no (concurrency-safe)
 *
 * Advantages:
 * - Prevents partial RFQ creation
 * - Scales well for large RFQs (100k+ rows)
 * - Safe under concurrent requests
 *
 * Limitations:
 * - Product rows are duplicated individually to remap IDs
 * - New NOT NULL columns must be added explicitly
 *
 * @param {number} rfq_id
 * @param {number[]} hotel_ids
 * @param {number} user_id
 * @param {Object} txContext - Optional transaction context for participating in outer transaction
 * @createdby mukul
 */
const duplicateRfqForHotels = async (rfq_id, hotel_ids, user_id, txContext = null) => {

  // Nothing to duplicate if only one or zero hotels
  // Return the original RFQ ID for approval processing
  if (!Array.isArray(hotel_ids) || hotel_ids.length <= 1) {
    return {
      originalRfqId: rfq_id,
      duplicatedRfqIds: [],
      allRfqIds: [rfq_id]
    };
  }

  // First hotel is already associated with parent RFQ
  const [, ...childHotels] = hotel_ids;

  // Track all created RFQ IDs for approval processing
  const createdRfqIds = [];

  // Executor function for the duplication logic
  const executor = async (t) => {
    
    // -------------------------  1 Fetch parent RFQ ONCE  -------------------------

    // Used as the source template for all child RFQs
    const parentRfq = await t.one(`SELECT * FROM tbl_rfq WHERE id = $1`, [
      rfq_id
    ]);

    // -------------------------  2️ Fetch all RFQ products ONCE   -------------------------

    // Needed because RFQ products are parents for
    // specs, vendors, tech evaluation, etc.
    const rfqProducts = await t.any(
      `SELECT * FROM tbl_rfq_products WHERE rfq_id = $1`,
      [rfq_id]
    );

    // -------------------------  3️ Loop through each additional hotel  -----------------------

    for (const hotel_id of childHotels) {
      // -------------------------  3A️ Create NEW RFQ for this hotel  -------------------------

      // Generate unique rfq_no for the duplicated RFQ
      // Using subquery to get max rfq_no + 1 ensures uniqueness within transaction
      // RETURNING id is CRITICAL because: All child tables depend on rfq_id
      const { id: newRfqId } = await t.one(
        `
INSERT INTO tbl_rfq (
  rfq_no,
  comment,
  company_name,
  response_email,
  contact_name,
  contact_number,
  bid_end_date,
  location,
  is_published,
  created_by,
  updated_by,
  status,
  rfq_type,
  reverse_auction,
  project_id,
  ra_start_date,
  ra_end_date,
  rfq_added_from,
  processed_url,
  is_tender,
  tender_publish_date,
  vendor_clarification_date,
  hospitality_company_id,
  tender_fees,
  hotel_id,
  process_id,
  department_id
)
SELECT
  (SELECT COALESCE(MAX(rfq_no), 100000) + 1 FROM tbl_rfq),
  comment,
  (SELECT hc.name FROM tbl_hospitality_company_hotels hch
   JOIN tbl_hospitality_companies hc ON hc.id = hch.hospitality_company_id
   WHERE hch.id = $2),
  response_email,
  contact_name,
  contact_number,
  bid_end_date,
  location,
  1,
  created_by,
  created_by,
  status,
  rfq_type,
  reverse_auction,
  project_id,
  ra_start_date,
  ra_end_date,
  rfq_added_from,
  processed_url,
  is_tender,
  tender_publish_date,
  vendor_clarification_date,
  (SELECT hch.hospitality_company_id FROM tbl_hospitality_company_hotels hch WHERE hch.id = $2),
  tender_fees,
  $2,
  process_id,
  department_id
FROM tbl_rfq
WHERE id = $1
RETURNING id;
        `,
        [rfq_id, hotel_id]
      );

      // Track created RFQ ID for approval processing
      createdRfqIds.push(newRfqId);

      // -------------------------  4️ Duplicate RFQ PRODUCTS (with per-hotel vendor filtering)  -------------------------

      // We MUST capture old → new product ID mapping
      // because child tables depend on product_id
      const productIdMap = {};

      for (const product of rfqProducts) {
        // Check vendor eligibility for THIS specific hotel
        const eligibleVendors = await hospitalityModel.getEligibleVendorsForVariant(
          product.product_variant_id, [hotel_id]
        );

        // Skip this product entirely if no vendors are eligible for this hotel
        // Downstream steps (files, specs, tech eval) auto-skip via productIdMap
        if (eligibleVendors.length === 0) continue;

        const { id: newProductId } = await t.one(
          `
          INSERT INTO tbl_rfq_products (
            rfq_id, comment, datasheet, spec_file, qap_file,
            product_variant_id, qap, datasheet_file, variant, sheet_id
          )
          VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10
          )
          RETURNING id
          `,
          [
            newRfqId,
            product.comment,
            product.datasheet,
            product.spec_file,
            product.qap_file,
            product.product_variant_id,
            product.qap,
            product.datasheet_file,
            product.variant,
            product.sheet_id
          ]
        );

        // Build mapping: old_product_id → new_product_id
        productIdMap[product.id] = newProductId;
      }

      // -------------------------  5️ Duplicate PRODUCT SPECS (leaf table)  -------------------------

      // No RETURNING needed — nothing depends on this row
      await t.none(
        `
        INSERT INTO tbl_rfq_products_specs (
          rfq_id, product_variant_id, title, value, variant, sheet_id
        )
        SELECT
          $2, product_variant_id, title, value, variant, sheet_id
        FROM tbl_rfq_products_specs
        WHERE rfq_id = $1
        `,
        [rfq_id, newRfqId]
      );

      // -------------------------  6 Duplicate PRODUCT FILES  -------------------------

      
      // Fetch product files for parent RFQ
      const productFiles = await t.any(
        `
  SELECT pf.*
  FROM tbl_rfq_product_files pf
  JOIN tbl_rfq_products p ON p.id = pf.rfq_product_id
  WHERE p.rfq_id = $1
  `,
        [rfq_id]
      );

      for (const file of productFiles) {
        const newProductId = productIdMap[file.rfq_product_id];

        // Safety check (should always exist)
        if (!newProductId) continue;

        await t.none(
          `
    INSERT INTO tbl_rfq_product_files (
      rfq_product_id,
      file_type,
      file_url,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5)
    `,
          [
            newProductId,
            file.file_type,
            file.file_url,
            file.created_at,
            file.updated_at
          ]
        );
      }

      // -------------------------  7 Duplicate PRODUCT VENDORS (per-hotel eligible vendors only)  -------------------------

      // Instead of bulk-copying all vendors, insert only eligible vendors per product
      for (const product of rfqProducts) {
        const newProductId = productIdMap[product.id];
        // Skip products that were not duplicated (no eligible vendors for this hotel)
        if (!newProductId) continue;

        const eligibleVendors = await hospitalityModel.getEligibleVendorsForVariant(
          product.product_variant_id, [hotel_id]
        );

        for (const vendor of eligibleVendors) {
          await t.none(
            `
            INSERT INTO tbl_rfq_product_vendors (
              rfq_id, product_variant_id, user_id, variant, sheet_id,
              is_rfq_viewed
            )
            VALUES ($1, $2, $3, $4, $5, 0)
            `,
            [
              newRfqId,
              product.product_variant_id,
              vendor.vendor_id,
              product.variant,
              product.sheet_id
            ]
          );
        }
      }

      // ------------------------  8 Duplicate RFQ FILES (leaf table)  --------------------------
     
      await t.none(
        `
        INSERT INTO tbl_rfq_files (rfq_id, file_type, file_url)
        SELECT
          $2, file_type, file_url
        FROM tbl_rfq_files
        WHERE rfq_id = $1
        `,
        [rfq_id, newRfqId]
      );

      // -----------------------  9 Duplicate RFQ TERMS (leaf table)  ---------------------------
      
      await t.none(
        `
        INSERT INTO tbl_rfq_terms_map (rfq_id, terms_id)
        SELECT
          $2, terms_id
        FROM tbl_rfq_terms_map
        WHERE rfq_id = $1
        `,
        [rfq_id, newRfqId]
      );

      // ------------------------  10 Duplicate TECH EVALUATION (parent table)  --------------------------

      
      // Map: old_tech_eval_id → new_tech_eval_id
      const techEvalIdMap = {};

      // Fetch tech evaluations for parent RFQ
      const techEvaluations = await t.any(
        `
  SELECT *
  FROM tbl_rfq_product_tech_evaluation
  WHERE rfq_id = $1
  `,
        [rfq_id]
      );

      for (const te of techEvaluations) {
        const newProductId = productIdMap[te.tbl_rfq_product_id];

        // Skip if product was not duplicated (safety)
        if (!newProductId) continue;

        const { id: newTechEvalId } = await t.one(
          `
    INSERT INTO tbl_rfq_product_tech_evaluation (
      rfq_id,
      tbl_rfq_product_id,
      minimum_passing_score
    )
    VALUES ($1, $2, $3)
    RETURNING id
    `,
          [newRfqId, newProductId, te.minimum_passing_score]
        );

        techEvalIdMap[te.id] = newTechEvalId;
      }

      // -------------------------  11 Duplicate TECH EVALUATION CLAUSES  -------------------------

      
      const clauseIdMap = {};

      // Fetch clauses for parent RFQ
      const clauses = await t.any(
        `
  SELECT *
  FROM tbl_rfq_product_tech_evaluation_clauses
  WHERE tbl_rfq_product_tech_evaluation_id IN (
    SELECT id
    FROM tbl_rfq_product_tech_evaluation
    WHERE rfq_id = $1
  )
  `,
        [rfq_id]
      );

      for (const clause of clauses) {
        const newTechEvalId =
          techEvalIdMap[clause.tbl_rfq_product_tech_evaluation_id];
        if (!newTechEvalId) continue;

        const { id: newClauseId } = await t.one(
          `
    INSERT INTO tbl_rfq_product_tech_evaluation_clauses (
      tbl_rfq_product_tech_evaluation_id,
      clause_text,
      weightage,
      clause_type
    )
    VALUES ($1, $2, $3, $4)
    RETURNING id
    `,
          [
            newTechEvalId,
            clause.clause_text,
            clause.weightage,
            clause.clause_type
          ]
        );

        clauseIdMap[clause.id] = newClauseId;
      }

      // --------------------------  1️2 Duplicate TECH EVALUATION CLAUSE FILES  ------------------------
      
      await t.none(
        `
  INSERT INTO tbl_rfq_product_tech_evaluation_clauses_files (
    tbl_rfq_product_tech_evaluation_clauses_id,
    file_url
  )
  SELECT
    c_new.id,
    f.file_url
  FROM tbl_rfq_product_tech_evaluation_clauses_files f
  JOIN tbl_rfq_product_tech_evaluation_clauses c_old
    ON c_old.id = f.tbl_rfq_product_tech_evaluation_clauses_id
  JOIN tbl_rfq_product_tech_evaluation_clauses c_new
    ON c_new.clause_text = c_old.clause_text
   AND c_new.tbl_rfq_product_tech_evaluation_id IN (
     SELECT id
     FROM tbl_rfq_product_tech_evaluation
     WHERE rfq_id = $2
   )
  WHERE c_old.tbl_rfq_product_tech_evaluation_id IN (
    SELECT id
    FROM tbl_rfq_product_tech_evaluation
    WHERE rfq_id = $1
  )
  `,
        [rfq_id, newRfqId]
      );
    }
  };

  // If transaction context provided, use it; otherwise create new transaction
  if (txContext) {
    await executor(txContext);
  } else {
    await db.tx(executor);
  }

  // Return all RFQ IDs for approval processing
  return {
    originalRfqId: rfq_id,
    duplicatedRfqIds: createdRfqIds,
    allRfqIds: [rfq_id, ...createdRfqIds]
  };
};


/**
 * startApprovalForRfq
 *
 * Submits an RFQ for approval by creating an approval instance.
 * Only applies to hospitality RFQs (those with hospitality_company_id).
 *
 * IMPORTANT: This function throws if no approval policy exists for the scope.
 * Hospitality RFQs MUST have an approval policy configured.
 *
 * @param {number} rfqId - The RFQ ID to submit for approval
 * @param {number} userId - The user ID initiating the approval
 * @param {Object} txContext - Optional transaction context for participating in outer transaction
 * @returns {Promise<Object|null>} - Approval instance result or null if not hospitality
 * @throws {Error} - If no approval policy exists for the hospitality RFQ scope
 */
const startApprovalForRfq = async (rfqId, userId, txContext = null) => {
  // Use transaction context if provided, otherwise use db directly
  const dbContext = txContext || db;

  const rfq = await dbContext.oneOrNone(
    `SELECT id, rfq_no, hospitality_company_id, hotel_id, department_id, process_id, is_tender, company_name
     FROM tbl_rfq WHERE id = $1`,
    [rfqId]
  );

  if (!rfq) {
    return null;
  }

  // Non-hospitality RFQs - skip approval, go straight to publish
  if (!rfq.hospitality_company_id) {
    await dbContext.none(`
      UPDATE tbl_rfq SET status = 4 WHERE id = $1
    `, [rfqId]);

    const rfqDetails = await dbContext.oneOrNone(`
      SELECT tender_publish_date, created_by FROM tbl_rfq WHERE id = $1
    `, [rfqId]);

    if (rfqDetails) {
      await scheduleRfqPublish({
        id: rfqId,
        rfq_no: rfq.rfq_no,
        is_tender: rfq.is_tender,
        tender_publish_date: rfqDetails.tender_publish_date,
        created_by: rfqDetails.created_by
      }, dbContext);
    }

    return { autoApproved: true, noApprovalRequired: true };
  }

  // For hospitality RFQs/Tenders, approval is REQUIRED
  // Determine entity type based on is_tender flag
  const entityType = rfq.is_tender === 1 ? 'TENDER' : 'RFQ';

  // Check for existing PENDING approval instances for this RFQ/Tender
  // If found, cancel them before creating a new one (allows re-submission after edits)
  const existingPendingInstances = await dbContext.any(
    `SELECT id FROM tbl_approval_instances
     WHERE entity_type = $1 AND entity_id = $2 AND status = 'PENDING'`,
    [entityType, rfqId]
  );

  // Cancel any existing pending instances
  for (const instance of existingPendingInstances) {
    // Update instance status to CANCELLED
    await dbContext.none(
      `UPDATE tbl_approval_instances
       SET status = 'CANCELLED', completed_at = NOW()
       WHERE id = $1`,
      [instance.id]
    );

    // Update all pending steps to CANCELLED
    await dbContext.none(
      `UPDATE tbl_approval_instance_steps
       SET status = 'CANCELLED', completed_at = NOW()
       WHERE approval_instance_id = $1 AND status = 'PENDING'`,
      [instance.id]
    );

    // Log the cancellation
    await dbContext.none(
      `INSERT INTO tbl_approval_actions
       (approval_instance_id, approver_user_id, action, comment)
       VALUES ($1, $2, 'CANCELLED', $3)`,
      [instance.id, userId, 'Cancelled due to RFQ re-submission with changes']
    );

    logger.info(`Cancelled existing approval instance ${instance.id} for ${entityType} ${rfqId}`);
  }

  // Create the approval instance for tracking. createApprovalInstance handles
  // the "creator is final approver" auto-approval case end-to-end, including
  // persisting per-step + per-approver rows so the lifecycle UI can render
  // the audit trail. Previously this site short-circuited via
  // checkIfUserIsFinalApprover and inserted only the parent instance row,
  // leaving zero tbl_approval_instance_steps / tbl_approval_step_approvers
  // rows and producing the "No approval steps configured" lifecycle bug.
  let result;
  try {
    result = await createApprovalInstance({
      entity_type: entityType,
      entity_id: rfqId,
      hospitality_company_id: rfq.hospitality_company_id,
      hotel_id: rfq.hotel_id,
      department_id: rfq.department_id,
      process_id: rfq.process_id,
      initiated_by: userId,
      metadata: {
        rfq_number: rfq.rfq_no,
        is_tender: rfq.is_tender,
        company_name: rfq.company_name
      },
      txContext  // Pass transaction context to createApprovalInstance
    });
  } catch (approvalError) {
    logger.warn(`[Approval] Could not create approval instance for ${entityType} ${rfqId}: ${approvalError.message}. Proceeding to publish anyway.`);
    result = null;
  }

  // Set RFQ to READY_TO_PUBLISH (4). Publishing proceeds whether approval
  // auto-completed (creator was the final approver in every resolved step)
  // or is still pending — the scheduler honours the publish date either way.
  await dbContext.none(`
    UPDATE tbl_rfq
    SET status = 4
    WHERE id = $1
  `, [rfqId]);

  const autoApproved = result?.autoApproved === true || result?.instance?.status === 'APPROVED';

  // Lifecycle event: distinguish auto-approved from publish-with-pending-approval
  if (autoApproved) {
    await recordLifecycleEvent({
      entity_type: entityType,
      entity_id: rfqId,
      stage: 'APPROVED',
      action: 'AUTO_APPROVE',
      performed_by: userId,
      metadata: {
        approval_instance_id: result?.instance?.id || null,
        rfq_no: rfq.rfq_no,
        reason: 'Created by final approver'
      },
      txContext
    });
  } else {
    await recordLifecycleEvent({
      entity_type: entityType,
      entity_id: rfqId,
      stage: 'READY_TO_PUBLISH',
      action: 'PUBLISH_WITHOUT_APPROVAL',
      performed_by: userId,
      metadata: {
        rfq_no: rfq.rfq_no,
        approval_instance_id: result?.instance?.id || null,
        approval_status: 'PENDING',
        note: 'Publishing proceeded without waiting for approval completion'
      },
      txContext
    });
  }

  // Schedule the RFQ to be published
  const rfqDetails = await dbContext.oneOrNone(`
    SELECT tender_publish_date, created_by FROM tbl_rfq WHERE id = $1
  `, [rfqId]);

  if (rfqDetails) {
    await scheduleRfqPublish({
      id: rfqId,
      rfq_no: rfq.rfq_no,
      is_tender: rfq.is_tender,
      tender_publish_date: rfqDetails.tender_publish_date,
      created_by: rfqDetails.created_by
    }, dbContext);
  }

  logger.info(`[Approval] ${entityType} ${rfqId} proceeding to publish. Approval instance: ${result?.instance?.id || 'none'} (status: ${result?.instance?.status || 'NONE'})`);

  return {
    ...(result || {}),
    publishedWithPendingApproval: !autoApproved
  };
};

/**
 * handleRFQPostApproval
 *
 * Post-approval handler for RFQ/Tender - called when approval instance is fully approved.
 * Updates RFQ status from PENDING_APPROVAL (3) to READY_TO_PUBLISH (4).
 * The scheduler will then publish the RFQ when tender_publish_date is reached.
 *
 * @param {number} approval_instance_id - The approval instance ID
 * @param {number} approver_user_id - The user who performed the final approval
 * @param {Object} [options] - Optional options
 * @param {Object} [options.txContext] - Optional transaction context to participate in
 * @returns {Promise<Object|null>} - Updated RFQ or null if not found
 */
export const handleRFQPostApproval = async (approval_instance_id, approver_user_id, options = {}) => {
  const txContext = options?.txContext ?? null;
  const t = txContext || db;

  try {
    // Get the approval instance to find the RFQ
    const instance = await getApprovalInstanceById(approval_instance_id, null, t);

    if (!instance || instance.status !== 'APPROVED') {
      logger.info(`Approval instance ${approval_instance_id} not found or not approved`);
      return null;
    }

    // Only handle RFQ and TENDER entity types
    if (!['RFQ', 'TENDER'].includes(instance.entity_type)) {
      logger.info(`Skipping non-RFQ entity type: ${instance.entity_type}`);
      return null;
    }

    const rfq_id = instance.entity_id;

    // Get RFQ details
    const rfq = await t.oneOrNone(`
      SELECT * FROM tbl_rfq WHERE id = $1
    `, [rfq_id]);

    if (!rfq) {
      logger.error(`RFQ ${rfq_id} not found for approval instance ${approval_instance_id}`);
      return null;
    }

    // If RFQ is already published (status 1) or ready to publish (status 4),
    // just record the approval event - publishing already proceeded
    if (rfq.status === 1 || rfq.status === 4) {
      logger.info(`RFQ ${rfq_id} already at status ${rfq.status} - recording late approval`);
      await recordLifecycleEvent({
        entity_type: rfq.is_tender === 1 ? 'TENDER' : 'RFQ',
        entity_id: rfq_id,
        stage: 'APPROVED',
        action: 'LATE_APPROVE',
        performed_by: approver_user_id,
        metadata: {
          approval_instance_id,
          rfq_no: rfq.rfq_no,
          note: 'Approval completed after publishing had already proceeded'
        },
        txContext: t
      });
      return { rfq_id, status: rfq.status, lateApproval: true };
    }

    // For status 3 (PENDING_APPROVAL) - normal flow
    if (rfq.status !== 3) {
      logger.info(`RFQ ${rfq_id} status is ${rfq.status}, unexpected state`);
      return null;
    }

    // Record lifecycle event for approval
    await recordLifecycleEvent({
      entity_type: rfq.is_tender === 1 ? 'TENDER' : 'RFQ',
      entity_id: rfq_id,
      stage: 'APPROVED',
      action: 'APPROVE',
      performed_by: approver_user_id,
      metadata: {
        approval_instance_id,
        rfq_no: rfq.rfq_no
      },
      txContext: t
    });

    // Check if publish date has already passed - if so, publish immediately after approval
    const publishDatePassed = rfq.tender_publish_date
      && new Date(rfq.tender_publish_date) <= new Date();

    if (publishDatePassed) {
      // Publish date already passed - publish directly within this transaction
      await t.none(`
        UPDATE tbl_rfq
        SET status = 1, is_published = 1
        WHERE id = $1
      `, [rfq_id]);

      await recordLifecycleEvent({
        entity_type: rfq.is_tender === 1 ? 'TENDER' : 'RFQ',
        entity_id: rfq_id,
        stage: 'PUBLISHED',
        action: 'AUTO_PUBLISH',
        performed_by: rfq.created_by,
        metadata: { rfq_no: rfq.rfq_no, published_by: 'post_approval_immediate' },
        txContext: t
      });

      logger.info(`RFQ ${rfq_id} approved and published immediately (publish date already passed)`);

      // Send publish notifications (direct-publish path bypasses publishRfq in cronManager)
      try {
        const rfqFull = await t.oneOrNone('SELECT title, created_by FROM tbl_rfq WHERE id = $1', [rfq_id]);

        // Notify approval workflow users + RFQ creator
        const entityType = rfq.is_tender === 1 ? 'TENDER' : 'RFQ';
        const publishUsers = await getRfqNotificationRecipients(entityType, rfq_id, rfqFull?.created_by || rfq.created_by);
        logger.info({ recipients: publishUsers.map(u => u.email) }, `[RFQ PostApproval] Direct publish email - ${entityType} #${rfq.rfq_no}: ${publishUsers.length} recipients`);
        if (publishUsers.length > 0) {
          await sendRfqPublishedNotification({
            rfqDetails: { id: rfq_id, rfq_no: rfq.rfq_no, is_tender: rfq.is_tender, title: rfqFull.title },
            users: publishUsers
          });
        }

        // Notify vendors
        const products = await rfqModel.getProductsByRfqId(rfq_id);
        const buyerDetails = await userModel.user_profile_detail(rfqFull?.created_by || rfq.created_by);
        const buyerName = buyerDetails?.[0]?.company_name || buyerDetails?.[0]?.organization_name || buyerDetails?.[0]?.name || 'Buyer';

        const vendorMap = {};
        for (const product of products) {
          if (!product.vendors) continue;
          for (const vendor of product.vendors) {
            if (!vendorMap[vendor.user_id]) {
              vendorMap[vendor.user_id] = { ...vendor, products: [] };
            }
            vendorMap[vendor.user_id].products.push(product.name);
          }
        }

        const vendorsWithTokens = [];
        for (const vendorId of Object.keys(vendorMap)) {
          const vendor = vendorMap[vendorId];
          try {
            const token = await rfqModel.insertVendorRfqToken(vendor.user_id, rfq_id);
            vendorsWithTokens.push({ user_id: vendor.user_id, name: vendor.name, email: vendor.email, token, products: vendor.products });
          } catch (tokenErr) {
            logError(`Error generating token for vendor ${vendorId}`, tokenErr);
          }
        }

        if (vendorsWithTokens.length > 0) {
          sendVendorRfqNotification({ rfq_id, rfq_no: rfq.rfq_no, is_tender: rfq.is_tender, buyerName, vendors: vendorsWithTokens });
        }
      } catch (emailError) {
        logError('Error sending direct-publish notification emails', emailError);
      }

      return { rfq_id, status: 1, published: true };
    }

    // Update RFQ status to READY_TO_PUBLISH (4)
    // The scheduler will publish it when tender_publish_date is reached
    await t.none(`
      UPDATE tbl_rfq
      SET status = 4
      WHERE id = $1
    `, [rfq_id]);

    // Schedule the RFQ to be published at tender_publish_date
    // If no publish date is set, publishes immediately
    // If publish date is in the future, schedules via EventBridge
    await scheduleRfqPublish({
      id: rfq_id,
      rfq_no: rfq.rfq_no,
      is_tender: rfq.is_tender,
      tender_publish_date: rfq.tender_publish_date,
      created_by: rfq.created_by
    }, t);

    // Send "Ready to Publish" notification for RFQs/tenders with future publish date
    // RFQs without a publish date are published immediately by scheduleRfqPublish → publishRfq (which sends its own emails)
    if (rfq.tender_publish_date && new Date(rfq.tender_publish_date) > new Date()) {
      try {
        const rfqFull = await t.oneOrNone('SELECT title FROM tbl_rfq WHERE id = $1', [rfq_id]);
        const entityType = rfq.is_tender === 1 ? 'TENDER' : 'RFQ';
        const readyUsers = await getRfqNotificationRecipients(entityType, rfq_id, rfq.created_by);
        if (readyUsers.length > 0) {
          sendRfqReadyToPublishNotification({
            rfqDetails: { id: rfq_id, rfq_no: rfq.rfq_no, is_tender: rfq.is_tender, title: rfqFull.title, tender_publish_date: rfq.tender_publish_date },
            users: readyUsers
          });
        }
      } catch (emailError) {
        logError('Error sending ready-to-publish notification', emailError);
      }
    }

    logger.info(`RFQ ${rfq_id} approved - status updated to READY_TO_PUBLISH (4)`);
    return { rfq_id, status: 4 };
  } catch (error) {
    logError('Error handling RFQ post-approval', error);
    throw error;
  }
};

/**
 * handleRFQRejection
 *
 * Rejection handler for RFQ/Tender - called when approval instance is rejected.
 * Keeps RFQ status at PENDING_APPROVAL (3) to allow creator to modify and resubmit.
 *
 * @param {number} approval_instance_id - The approval instance ID
 * @param {number} rejector_user_id - The user who rejected
 * @param {Object} [options] - Optional options
 * @param {string} [options.comment] - Optional rejection reason/comment
 * @param {Object} [options.txContext] - Optional transaction context to participate in
 * @returns {Promise<Object|null>} - RFQ info or null if not found
 */
export const handleRFQRejection = async (approval_instance_id, rejector_user_id, options = {}) => {
  const rejection_reason = options?.comment ?? null;
  const txContext = options?.txContext ?? null;
  const t = txContext || db;

  try {
    // Get the approval instance to find the RFQ
    const instance = await getApprovalInstanceById(approval_instance_id, null, t);

    if (!instance || instance.status !== 'REJECTED') {
      logger.info(`Approval instance ${approval_instance_id} not found or not rejected`);
      return null;
    }

    // Only handle RFQ and TENDER entity types
    if (!['RFQ', 'TENDER'].includes(instance.entity_type)) {
      logger.info(`Skipping non-RFQ entity type: ${instance.entity_type}`);
      return null;
    }

    const rfq_id = instance.entity_id;

    // Get RFQ details
    const rfq = await t.oneOrNone(`
      SELECT * FROM tbl_rfq WHERE id = $1
    `, [rfq_id]);

    if (!rfq) {
      logger.error(`RFQ ${rfq_id} not found for approval instance ${approval_instance_id}`);
      return null;
    }

    // Reset status to 1 (draft) so the RFQ moves back to the drafts list
    await t.none(`UPDATE tbl_rfq SET status = 1 WHERE id = $1`, [rfq_id]);

    // Record lifecycle event for rejection
    await recordLifecycleEvent({
      entity_type: rfq.is_tender === 1 ? 'TENDER' : 'RFQ',
      entity_id: rfq_id,
      stage: 'REJECTED',
      action: 'REJECT',
      performed_by: rejector_user_id,
      metadata: {
        approval_instance_id,
        rfq_no: rfq.rfq_no,
        rejection_reason
      },
      remarks: rejection_reason,
      txContext: t
    });

    // TODO: Send notification to RFQ creator about rejection with reason

    return { rfq_id, status: 1, rejection_reason };
  } catch (error) {
    logError('Error handling RFQ rejection', error);
    throw error;
  }
};

/**
 * startApprovalForTechEval
 *
 * Submits a Technical Evaluation for approval by creating an approval instance.
 * Only applies to hospitality RFQs (those with hospitality_company_id).
 *
 * NEW FLOW (Round-based):
 * 1. Get tech evaluation and check if already complete
 * 2. Fetch all evaluated vendors with their calculated scores and pass/fail status
 * 3. Create round record FIRST to get round_id
 * 4. Use round_id as entity_id in approval instance (NOT rfq_product_id)
 * 5. Include enhanced metadata with all vendors' names and status
 * 6. Update round record with approval_instance_id
 *
 * IMPORTANT: This function throws if no approval policy exists for the scope.
 * Hospitality Technical Evaluations MUST have an approval policy configured.
 *
 * @param {number} rfqProductId - The RFQ product ID to submit for approval
 * @param {number} rfqId - The RFQ ID associated with the product
 * @param {number} userId - The user ID initiating the approval
 * @param {Object} txContext - Optional transaction context for participating in outer transaction
 * @returns {Promise<Object|null>} - Approval instance result with round_id or null if not hospitality
 * @throws {Error} - If no approval policy exists for the hospitality scope
 */
const startApprovalForTechEval = async (rfqProductId, rfqId, userId, txContext = null) => {
  const dbContext = txContext || db;

  // Fetch RFQ details
  const rfq = await dbContext.oneOrNone(
    `SELECT id, rfq_no, title, hospitality_company_id, hotel_id, department_id, process_id, is_tender, company_name
     FROM tbl_rfq WHERE id = $1`,
    [rfqId]
  );

  // Skip non-hospitality RFQs - they don't require approval
  if (!rfq || !rfq.hospitality_company_id) {
    return null;
  }

  // Fetch product info
  const product = await dbContext.oneOrNone(
    `SELECT RP.id, PV.name, RP.rfq_id
     FROM tbl_rfq_products RP
     JOIN tbl_product_variant PV ON PV.id = RP.product_variant_id
     WHERE RP.id = $1 AND RP.rfq_id = $2`,
    [rfqProductId, rfqId]
  );

  if (!product) {
    throw new Error('RFQ product not found');
  }

  // Get tech evaluation record
  const techEval = await dbContext.oneOrNone(
    `SELECT id, minimum_passing_score, is_complete, current_round, total_passed_verified, required_passed_vendors
     FROM tbl_rfq_product_tech_evaluation
     WHERE tbl_rfq_product_id = $1`,
    [rfqProductId]
  );

  if (!techEval) {
    throw new Error('Technical evaluation not found for this product');
  }

  // Check if already complete
  if (techEval.is_complete) {
    throw new Error('Technical evaluation is already complete with required number of passed vendors');
  }

  // Check if there's already a pending/submitted round for this evaluation
  const existingPendingRound = await dbContext.oneOrNone(
    `SELECT id, round_number, status FROM tbl_tech_evaluation_rounds
     WHERE tbl_rfq_product_tech_evaluation_id = $1 AND status IN ('PENDING', 'SUBMITTED')
     ORDER BY round_number DESC LIMIT 1`,
    [techEval.id]
  );

  if (existingPendingRound) {
    throw new Error(`Round ${existingPendingRound.round_number} is already ${existingPendingRound.status.toLowerCase()}. Please wait for approval before submitting again.`);
  }

  // Get vendor scores with pass/fail status
  const vendorScores = await rfqModel.getVendorScoresForTechEval(
    techEval.id,
    techEval.minimum_passing_score || 0,
    dbContext
  );

  if (!vendorScores || vendorScores.length === 0) {
    throw new Error('No vendors have been evaluated for this technical evaluation');
  }

  // Defense-in-depth: exclude vendors already verified in previous approved rounds
  // (getVendorScoresForTechEval already filters these via NOT EXISTS, but we double-check)
  const verifiedVendors = await dbContext.any(
    `SELECT vendor_id FROM tbl_rfq_product_tech_evaluation_cleared_vendors
     WHERE tbl_rfq_product_tech_evaluation_id = $1 AND is_verified = true`,
    [techEval.id]
  );
  const verifiedIds = new Set(verifiedVendors.map(v => v.vendor_id));

  // Only include vendors who are fully evaluated (all clauses scored) and not already verified
  const evaluatedVendors = vendorScores.filter(v => v.is_fully_evaluated === true && !verifiedIds.has(v.vendor_id));
  const notEvaluatedVendors = vendorScores.filter(v => !v.is_fully_evaluated || verifiedIds.has(v.vendor_id));
  const passedVendors = evaluatedVendors.filter(v => v.is_passed === true);
  const failedVendors = evaluatedVendors.filter(v => v.is_passed === false);

  // Compute next round number from DB (not from techEval.current_round which may be stale)
  const lastRound = await dbContext.oneOrNone(
    `SELECT MAX(round_number) AS max_round FROM tbl_tech_evaluation_rounds
     WHERE tbl_rfq_product_tech_evaluation_id = $1`,
    [techEval.id]
  );
  const currentRound = (lastRound?.max_round || 0) + 1;

  // Ensure at least one NEW vendor has been evaluated for this round
  if (evaluatedVendors.length === 0) {
    throw new Error('No new vendors have been evaluated for this round. Please score at least one vendor before submitting.');
  }

  // Create round record FIRST to get round_id
  const round = await rfqModel.createTechEvalRound(
    techEval.id,
    currentRound,
    userId,
    dbContext
  );

  // Keep current_round in sync for display purposes
  await rfqModel.updateTechEvalStatus(techEval.id, {
    current_round: currentRound
  }, dbContext);

  // Prepare vendors metadata for approval (only include evaluated vendors)
  const vendorsMetadata = evaluatedVendors.map(v => ({
    vendor_id: v.vendor_id,
    vendor_name: v.vendor_name || v.company_name,
    vendor_email: v.vendor_email,
    rfq_product_vendor_id: v.rfq_product_vendor_id || null,
    calculated_score: parseFloat(v.calculated_score) || 0,
    is_passed: v.is_passed,
    status: v.is_passed === true ? 'PASSED' : 'FAILED'
  }));

  // Prepare not-evaluated vendors metadata (for informational purposes)
  const notEvaluatedMetadata = notEvaluatedVendors.map(v => ({
    vendor_id: v.vendor_id,
    vendor_name: v.vendor_name || v.company_name,
    vendor_email: v.vendor_email,
    rfq_product_vendor_id: v.rfq_product_vendor_id || null,
    calculated_score: null,
    is_passed: null,
    status: 'NOT_EVALUATED'
  }));

  // Create approval instance with round_id as entity_id
  const result = await createApprovalInstance({
    entity_type: 'TECHNICAL',
    entity_id: round.id, // Use round_id as entity_id
    hospitality_company_id: rfq.hospitality_company_id,
    hotel_id: rfq.hotel_id,
    department_id: rfq.department_id,
    process_id: rfq.process_id,
    initiated_by: userId,
    metadata: {
      rfq_id: rfqId,
      rfq_number: rfq.rfq_no,
      rfq_title: rfq.title || '',
      rfq_product_id: rfqProductId,
      tech_evaluation_id: techEval.id,
      is_tender: rfq.is_tender,
      company_name: rfq.company_name,
      product_name: product.name,
      evaluation_round: currentRound,
      minimum_passing_score: techEval.minimum_passing_score || 0,
      vendors: vendorsMetadata,
      not_evaluated_vendors: notEvaluatedMetadata,
      passed_vendors: passedVendors.map(v => ({
        vendor_id: v.vendor_id,
        vendor_name: v.vendor_name || v.company_name,
        calculated_score: parseFloat(v.calculated_score) || 0
      })),
      failed_vendors: failedVendors.map(v => ({
        vendor_id: v.vendor_id,
        vendor_name: v.vendor_name || v.company_name,
        calculated_score: parseFloat(v.calculated_score) || 0
      })),
      summary: {
        total_evaluated: evaluatedVendors.length,
        passed_count: passedVendors.length,
        failed_count: failedVendors.length,
        not_evaluated_count: notEvaluatedVendors.length
      }
    },
    txContext
  });

  // Update round record with approval_instance_id and status
  await rfqModel.updateTechEvalRound(round.id, {
    approval_instance_id: result.instance?.id,
    status: 'SUBMITTED',
    submitted_at: new Date(),
    vendors_evaluated: vendorsMetadata,
    passed_count: passedVendors.length,
    failed_count: failedVendors.length,
    not_evaluated_count: notEvaluatedVendors.length
  }, dbContext);

  // Return result with round info
  return {
    ...result,
    round_id: round.id,
    round_number: currentRound
  };
};

/**
 * Handle TECHNICAL post-approval actions (iterative round-based flow)
 * Called after TECHNICAL approval instance is fully approved
 *
 * NEW FLOW:
 * 1. Get round_id from entity_id (entity_id is now round_id)
 * 2. Get rfq_product_id and tech_evaluation_id from metadata
 * 3. Set is_verified=TRUE for ALL evaluated vendors (both passed and failed)
 * 4. Store evaluation_round and approval_instance_id in cleared_vendors
 * 5. Update round status to APPROVED
 * 6. Count total_passed_verified and update tech eval record
 * 7. Check completion condition (>= required passed vendors)
 * 8. If not complete, auto-replace failed vendors with next L5+ vendors
 * 9. If no more vendors available, set blocked_insufficient_vendors=TRUE
 */
const handleTechnicalPostApproval = async (approval_instance_id, approver_user_id, options = {}) => {
  const txContext = options?.txContext ?? null;
  const t = txContext || db;

  try {
    // Get approval instance
    const { getApprovalInstanceById } = await import('../../models/generalModel.js');
    const instance = await getApprovalInstanceById(approval_instance_id, 'TECHNICAL', t);
    if (!instance || instance.status !== 'APPROVED') {
      return; // Not approved yet or not TECHNICAL type
    }

    // entity_id is now the round_id
    const round_id = instance.entity_id;
    const metadata = instance.metadata || {};

    // Get rfq_product_id and tech_evaluation_id from metadata
    const rfq_product_id = metadata.rfq_product_id;
    const tech_evaluation_id = metadata.tech_evaluation_id;
    const rfq_id = metadata.rfq_id;
    const evaluation_round = metadata.evaluation_round || 1;

    // Get round record to verify
    const round = await rfqModel.getTechEvalRoundById(round_id, t);
    if (!round) {
      logger.error(`Tech eval round ${round_id} not found for approval instance ${approval_instance_id}`);
      return;
    }

    // Get tech evaluation record with product info for vendor replacement
    const techEval = await t.oneOrNone(`
      SELECT te.id, te.rfq_id, te.tbl_rfq_product_id, te.minimum_passing_score, te.current_round,
             te.total_passed_verified, te.required_passed_vendors, te.is_complete,
             rp.product_variant_id, rp.variant
      FROM tbl_rfq_product_tech_evaluation te
      JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id
      WHERE te.id = $1
    `, [tech_evaluation_id || round.tbl_rfq_product_tech_evaluation_id]);

    if (!techEval) {
      logger.error(`Tech evaluation not found for round ${round_id}`);
      return;
    }

    const requiredPassedVendors = techEval.required_passed_vendors || 5;

    // Get vendor scores for this round from metadata (or recalculate)
    let vendorScores = metadata.vendors || [];

    // If vendors not in metadata, recalculate
    if (vendorScores.length === 0) {
      vendorScores = await rfqModel.getVendorScoresForTechEval(
        techEval.id,
        techEval.minimum_passing_score || 0,
        t
      );
    }

    const passedVendors = vendorScores.filter(v => v.is_passed === true);
    const failedVendors = vendorScores.filter(v => v.is_passed === false);

    // Set is_verified=TRUE and store round info for ALL evaluated vendors
    for (const vendorScore of vendorScores) {
      if (vendorScore.is_passed !== null && vendorScore.is_passed !== undefined) {
        const status = vendorScore.is_passed ? 1 : 0;
        const reject_message = vendorScore.is_passed
          ? null
          : `Did not meet minimum passing score (${vendorScore.calculated_score}% < ${techEval.minimum_passing_score || 0}%)`;

        await rfqModel.upsertClearedVendor({
          tech_evaluation_id: techEval.id,
          vendor_id: vendorScore.vendor_id,
          status,
          reject_message,
          is_verified: true,
          evaluation_round,
          approval_instance_id,
          calculated_score: vendorScore.calculated_score,
          created_by: approver_user_id
        }, t);
      }
    }

    // Update round status to APPROVED
    await rfqModel.updateTechEvalRound(round_id, {
      status: 'APPROVED',
      completed_at: new Date(),
      passed_count: passedVendors.length,
      failed_count: failedVendors.length
    }, t);

    // Notify passed vendors of their technical acceptance (fire-and-forget)
    try {
      if (passedVendors.length > 0) {
        const vendorsWithTokens = [];
        for (const v of passedVendors) {
          let email = v.vendor_email;
          let name = v.vendor_name;
          if (!email) {
            const userInfo = await t.oneOrNone('SELECT name, email FROM tbl_users WHERE id = $1', [v.vendor_id]);
            email = userInfo?.email;
            name = name || userInfo?.name;
          }
          if (email) {
            const token = await rfqModel.insertVendorRfqToken(v.vendor_id, rfq_id);
            vendorsWithTokens.push({ vendor_id: v.vendor_id, vendor_name: name, vendor_email: email, token });
          }
        }
        if (vendorsWithTokens.length > 0) {
          sendVendorTechAcceptanceNotification({
            rfqDetails: {
              id: rfq_id,
              rfq_no: metadata.rfq_number,
              is_tender: metadata.is_tender,
              product_name: metadata.product_name,
              company_name: metadata.company_name
            },
            vendors: vendorsWithTokens
          }).catch(err => logError('Failed to send vendor tech acceptance emails', err));
        }
      }
    } catch (emailError) {
      logError('Error sending vendor tech acceptance notifications', emailError);
    }

    // Count total passed verified vendors
    const totalPassedVerified = await rfqModel.countPassedVerifiedVendors(techEval.id, t);

    // Check if we've reached the required number
    if (totalPassedVerified >= requiredPassedVendors) {
      // Evaluation complete!
      await rfqModel.updateTechEvalStatus(techEval.id, {
        is_complete: true,
        total_passed_verified: totalPassedVerified
      }, t);
      logger.info(`Tech evaluation ${techEval.id} is complete with ${totalPassedVerified} passed vendors`);

      // Send notifications to qualified users
      try {
        // Fetch RFQ details to get company_id and hotel_id
        const rfqDetails = await rfqModel.getRfqDetailsById(rfq_id);

        if (rfqDetails && rfqDetails.hospitality_company_id) {
          // Get users with EITHER quote-compare (read+write) OR negotiation (read+write)
          const qualifiedUsers = await rbacModel.getUsersWithResourcePermissionPairs(
            rfqDetails.hospitality_company_id,
            rfqDetails.hotel_id,
            ['quote-compare', 'negotiation']
          );

          if (qualifiedUsers && qualifiedUsers.length > 0) {
            // Fire-and-forget to avoid blocking transaction
            sendTechEvalCompletionNotification(
              rfqDetails,
              {
                id: techEval.id,
                total_passed_verified: totalPassedVerified,
                required_passed_vendors: requiredPassedVendors
              },
              qualifiedUsers
            ).catch(err => logError('Failed to send tech eval notifications', err));
          }
        }
      } catch (notificationError) {
        logError('Error sending tech eval completion notifications', notificationError);
      }
    } else if (failedVendors.length > 0) {
      // Need to auto-replace failed vendors
      const vendorsNeeded = requiredPassedVendors - totalPassedVerified;
      const replacementsNeeded = Math.min(failedVendors.length, vendorsNeeded);

      // Build exclude list from current round's scored vendors only.
      // Do NOT use getAllEvaluatedVendorIds (queries cleared_vendors which includes
      // reserve vendors like L6 that were individually accepted but not yet in the grid).
      // Only exclude vendors actively scored this round (L1-L5).
      const currentRoundScoredIds = vendorScores
        .filter(v => v.is_passed === true || v.is_passed === false)
        .map(v => v.vendor_id);

      // Also exclude vendors verified in previous rounds (multi-round support)
      const previousRoundVendors = evaluation_round > 1
        ? await t.any(
            `SELECT DISTINCT vendor_id FROM tbl_rfq_product_tech_evaluation_cleared_vendors
             WHERE tbl_rfq_product_tech_evaluation_id = $1 AND is_verified = true AND evaluation_round < $2`,
            [techEval.id, evaluation_round]
          ).then(rows => rows.map(r => r.vendor_id))
        : [];

      const evaluatedVendorIds = [...new Set([...currentRoundScoredIds, ...previousRoundVendors])];

      // First: look for reserve vendors in the tech eval (have responses but NOT in the grid yet)
      let nextVendors = await rfqModel.getReserveTechEvalVendors(
        techEval.id,
        techEval.rfq_id,
        techEval.tbl_rfq_product_id,
        evaluatedVendorIds,
        replacementsNeeded,
        t
      );

      logger.debug({ currentRoundScoredIds }, '[TECH-EVAL-REPLACE] currentRoundScoredIds');
      logger.debug({ evaluatedVendorIds }, '[TECH-EVAL-REPLACE] evaluatedVendorIds (exclude list)');
      logger.debug({ count: nextVendors?.length, vendors: nextVendors?.map(v => ({ id: v.vendor_id, name: v.vendor_name, rpvId: v.rfq_product_vendor_id })) }, '[TECH-EVAL-REPLACE] Reserve vendors found');

      // Fallback: look for external vendors from quotes if not enough pending vendors
      if (!nextVendors || nextVendors.length < replacementsNeeded) {
        const allExcludeIds = [
          ...evaluatedVendorIds,
          ...(nextVendors || []).map(v => v.vendor_id)
        ];
        const remaining = replacementsNeeded - (nextVendors ? nextVendors.length : 0);
        const externalVendors = await rfqModel.getNextVendorsForProduct(
          techEval.rfq_id,
          techEval.tbl_rfq_product_id,
          allExcludeIds,
          remaining,
          t
        );
        logger.debug({ count: externalVendors?.length, vendors: externalVendors?.map(v => ({ id: v.vendor_id, name: v.vendor_name })) }, '[TECH-EVAL-REPLACE] Fallback external vendors found');
        nextVendors = [...(nextVendors || []), ...(externalVendors || [])];
      }

      if (nextVendors && nextVendors.length > 0) {
        // Auto-replace failed vendors
        for (let i = 0; i < Math.min(failedVendors.length, nextVendors.length); i++) {
          const failedVendor = failedVendors[i];
          const newVendor = nextVendors[i];

          // Record replacement
          await rfqModel.replaceTechEvalVendor(
            techEval.rfq_id,
            techEval.tbl_rfq_product_id,
            failedVendor.vendor_id,
            newVendor.vendor_id,
            approver_user_id,
            t
          );

          // Update failed vendor's replaced_by_vendor_id
          const clearedVendor = await t.oneOrNone(
            `SELECT id FROM tbl_rfq_product_tech_evaluation_cleared_vendors
             WHERE tbl_rfq_product_tech_evaluation_id = $1 AND vendor_id = $2`,
            [techEval.id, failedVendor.vendor_id]
          );
          if (clearedVendor) {
            await rfqModel.updateClearedVendor(clearedVendor.id, {
              replaced_by_vendor_id: newVendor.vendor_id
            }, t);
          }

          // Ensure replacement vendor has a product-vendor record (needed for UI display)
          if (!newVendor.rfq_product_vendor_id) {
            await t.none(
              `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, variant, user_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT DO NOTHING`,
              [techEval.rfq_id, techEval.product_variant_id, techEval.variant || 0, newVendor.vendor_id]
            );
          }

          // Create empty vendor response records for new vendor (skips if already exist)
          await rfqModel.createEmptyVendorResponses(techEval.id, newVendor.vendor_id, t);

          logger.info(`Replaced failed vendor ${failedVendor.vendor_id} with ${newVendor.vendor_id}`);
        }

        // Increment current_round for next evaluation cycle
        await rfqModel.updateTechEvalStatus(techEval.id, {
          current_round: evaluation_round + 1,
          total_passed_verified: totalPassedVerified
        }, t);

        logger.info(`Prepared ${nextVendors.length} replacement vendors for round ${evaluation_round + 1}`);
      } else {
        // No more replacement vendors available — all eligible vendors
        // have been evaluated, so mark as complete even if the passed
        // count is below the configured threshold.
        await rfqModel.updateTechEvalStatus(techEval.id, {
          is_complete: true,
          blocked_insufficient_vendors: true,
          total_passed_verified: totalPassedVerified
        }, t);
        logger.info(`Tech evaluation ${techEval.id} complete (all eligible vendors evaluated, ${totalPassedVerified} passed)`);
      }
    } else {
      // All vendors passed — if no failed vendors remain, all eligible
      // vendors are evaluated. Mark complete regardless of threshold.
      await rfqModel.updateTechEvalStatus(techEval.id, {
        is_complete: true,
        total_passed_verified: totalPassedVerified
      }, t);
      logger.info(`Tech evaluation ${techEval.id} complete (all vendors passed, ${totalPassedVerified} total)`);
    }

    logger.info(`Post-approval complete for tech eval round ${round_id}: ${passedVendors.length} passed, ${failedVendors.length} failed`);
  } catch (techEvalError) {
    // Log but don't fail the transaction
    logError('Error handling TECHNICAL post-approval', techEvalError);
  }
};

/**
 * startApprovalForArc
 *
 * Submits an RFQ/Tender for ARC (Award Recommendation Committee) approval by creating an approval instance.
 * Only applies to hospitality RFQs (those with hospitality_company_id).
 * Approval is at the RFQ level - entity_id is the rfq_id.
 * This should be triggered when ALL products in the RFQ have been finalized.
 *
 * IMPORTANT: This function throws if no approval policy exists for the scope.
 * Hospitality RFQs/Tenders MUST have an approval policy configured for ARC.
 *
 * @param {number} rfqId - The RFQ ID to submit for ARC approval
 * @param {number} userId - The user ID initiating the approval
 * @param {Object} txContext - Optional transaction context for participating in outer transaction
 * @returns {Promise<Object|null>} - Approval instance result or null if not hospitality
 * @throws {Error} - If no approval policy exists for the hospitality scope
 */
const startApprovalForArc = async (rfqId, userId, txContext = null) => {
  const dbContext = txContext || db;

  // Fetch RFQ details - use transaction context if available
  const rfq = await dbContext.oneOrNone(
    `SELECT id, rfq_no, hospitality_company_id, hotel_id, department_id, process_id, is_tender, company_name
     FROM tbl_rfq WHERE id = $1`,
    [rfqId]
  );

  // Skip non-hospitality RFQs - they don't require ARC approval
  if (!rfq || !rfq.hospitality_company_id) {
    return null;
  }

  // Check if all products are finalized using model (with transaction context)
  const allFinalized = await rfqModel.checkAllProductsFinalizedForArc(rfqId, dbContext);

  if (!allFinalized || allFinalized.total_products === 0) {
    throw new Error('No products found in RFQ');
  }

  if (allFinalized.finalized_products !== allFinalized.total_products) {
    throw new Error('Not all products are finalized. Cannot submit for ARC approval.');
  }

  // Use 'ARC' as entity type for ARC approvals
  const entityType = 'ARC';

  // Create approval instance for ARC entity type at RFQ level
  const result = await createApprovalInstance({
    entity_type: entityType,
    entity_id: rfqId,
    hospitality_company_id: rfq.hospitality_company_id,
    hotel_id: rfq.hotel_id,
    department_id: rfq.department_id,
    process_id: rfq.process_id,
    initiated_by: userId,
    metadata: {
      rfq_id: rfqId,
      rfq_number: rfq.rfq_no,
      is_tender: rfq.is_tender,
      company_name: rfq.company_name
    },
    txContext
  });

  return result;
};

/**
 * Handle TECHNICAL rejection — transition the round to REJECTED so the
 * evaluator can resubmit. Mirrors the inline rejection logic that previously
 * lived in generalController.js and rfqController.js (the dedicated tech-eval
 * approval action endpoint), now extracted so the centralized
 * approvalActionService dispatcher can call it uniformly.
 *
 * @param {number} approval_instance_id
 * @param {number} _approver_user_id - currently unused, kept for handler signature parity
 * @param {Object} [ctx]
 * @param {Object} [ctx.instance] - pre-loaded approval instance, optional
 */
const handleTechnicalRejection = async (approval_instance_id, _approver_user_id, ctx = {}) => {
  const instance = ctx.instance || await getApprovalInstanceById(approval_instance_id);
  if (!instance || instance.entity_type !== 'TECHNICAL' || instance.status !== 'REJECTED') {
    return;
  }
  await rfqModel.updateTechEvalRound(instance.entity_id, {
    status: 'REJECTED',
    completed_at: new Date()
  });
};


// Export the helper functions for use in general controller and the approval action service
export { handleTechnicalPostApproval, handleTechnicalRejection };

// ──────────────────────────────────────────────────────────────────────────
// WH-69 helpers used by the rewritten update flow
// ──────────────────────────────────────────────────────────────────────────

// Convert tbl_rfq.status (numeric) to a stage name for tbl_lifecycle_history
const stageOfStatus = (status) => {
  switch (Number(status)) {
    case 0: return 'DRAFT';
    case 1: return 'PUBLISHED';
    case 2: return 'CLOSED';
    case 3: return 'PENDING_APPROVAL';
    case 4: return 'READY_TO_PUBLISH';
    default: return 'UNKNOWN';
  }
};

// Pretty label for an RFQ-level field, used in vendor notification emails.
// Anything not listed here falls back to the raw field name.
const RFQ_FIELD_LABELS = {
  title: 'Title',
  comment: 'Comment',
  contact_name: 'Contact name',
  contact_number: 'Contact number',
  response_email: 'Response email',
  location: 'Location',
  bid_end_date: 'Quote submission end date',
  tender_publish_date: 'Tender publish date',
  tender_fees: 'Tender fees',
  vendor_clarification_date: 'Vendor clarification end date',
  rfq_type: 'RFQ type',
  reverse_auction: 'Reverse auction',
  ra_start_date: 'Reverse auction start',
  ra_end_date: 'Reverse auction end',
  project_id: 'Project'
};

const formatChangeValue = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/**
 * Build a per-vendor list of human-readable change strings from the diff.
 * Returns: Map<vendorId, string[]>
 *
 * Rules:
 *   - RFQ-level field changes are visible to every vendor on the RFQ
 *   - Product-level changes (specs/files/comment) are visible only to the
 *     vendors on that product
 *   - Vendor add/remove from a product is reported individually to the
 *     vendor concerned (handled separately by NEW_PRODUCT / REMOVED_VENDOR
 *     emails, not in this map)
 */
const buildPerVendorChangedDetails = (diff) => {
  const map = new Map(); // vendorId -> string[]
  const push = (vendorId, line) => {
    const id = Number(vendorId);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(line);
  };

  // RFQ-level: collect once, broadcast later
  const rfqLevelLines = diff.rfqFields.map((c) => {
    const label = RFQ_FIELD_LABELS[c.field_name] || c.field_name;
    return `${label}: ${formatChangeValue(c.old_value)} → ${formatChangeValue(c.new_value)}`;
  });

  // Per-product changes for the vendors currently on each product
  for (const u of diff.products.updated) {
    const productLabel = u.current.product_name || `Product ${u.id}`;
    const lines = [];

    if (u.commentChanged) {
      lines.push(
        `${productLabel} — Comment: ${formatChangeValue(u.oldComment)} → ${formatChangeValue(u.newComment)}`
      );
    }
    for (const s of u.specs.added) {
      lines.push(`${productLabel} — ${s.title} added: ${formatChangeValue(s.value)}`);
    }
    for (const s of u.specs.updated) {
      lines.push(
        `${productLabel} — ${s.title}: ${formatChangeValue(s.old_value)} → ${formatChangeValue(s.new_value)}`
      );
    }
    for (const s of u.specs.removed) {
      lines.push(`${productLabel} — ${s.title} removed`);
    }
    for (const f of u.files.added) {
      lines.push(`${productLabel} — ${f.type} added`);
    }
    for (const f of u.files.removed) {
      lines.push(`${productLabel} — ${f.type} removed`);
    }

    if (lines.length === 0) continue;

    // These changes are visible to vendors that remain on the product after
    // the edit. Existing vendors = current vendors - removed + added.
    const vendorsAfter = new Set(
      (u.current.vendors || []).map((v) => Number(v.user_id))
    );
    for (const removedId of u.vendors.removed) vendorsAfter.delete(Number(removedId));
    for (const addedId of u.vendors.added) vendorsAfter.add(Number(addedId));

    for (const v of vendorsAfter) for (const line of lines) push(v, line);
  }

  // Newly-added products are folded INTO the consolidated update email
  // (used to fire a separate NEW_PRODUCT mail). The vendors auto-attached
  // to the new product see a "[Product] added to RFQ" line plus a brief
  // spec summary so they understand the new opportunity in context with
  // any other RFQ-level changes from the same edit session.
  for (const a of diff.products.added) {
    const sp = a.snapshot || {};
    const productLabel = sp.product_name || `Product`;
    const specEntries = Object.entries(sp.specs || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined);
    const specSummary = specEntries
      .slice(0, 4) // keep the line readable
      .map(([k, v]) => `${k}: ${formatChangeValue(v)}`)
      .join(', ');
    const baseLine = specSummary
      ? `${productLabel} — added (${specSummary}${specEntries.length > 4 ? ', …' : ''})`
      : `${productLabel} — added to the RFQ`;

    for (const vendorId of (sp.vendors || []).map(Number)) {
      push(vendorId, baseLine);
    }
  }

  // Removed products affect their existing vendors — but those vendors get a
  // dedicated REMOVED_VENDOR email, not the per-vendor changed-details list.
  // No-op here.

  // Broadcast RFQ-level changes to every vendor still on the RFQ. We use the
  // union of vendors across all current+added products as the audience.
  if (rfqLevelLines.length > 0) {
    const audience = new Set();
    for (const u of diff.products.updated) {
      for (const v of (u.current.vendors || [])) audience.add(Number(v.user_id));
      for (const v of u.vendors.added) audience.add(Number(v));
    }
    for (const a of diff.products.added) {
      for (const v of (a.snapshot.vendors || [])) audience.add(Number(v));
    }
    // We also need to include vendors on UNCHANGED products. The diff doesn't
    // carry them, so the caller passes a fallback set via closure (see below).
    for (const v of audience) for (const line of rfqLevelLines) push(v, line);
  }

  return { perVendorMap: map, rfqLevelLines };
};

/**
 * Best-effort vendor notification dispatch after a successful edit.
 *
 *   - Vendors newly added to a product (or to a brand-new product) get a
 *     NEW_PRODUCT email.
 *   - Vendors removed from a product (or whose product was removed) get a
 *     REMOVED_VENDOR email.
 *   - Every other vendor that remains on the RFQ and is affected by changes
 *     gets an UPDATED_VENDOR_WITH_CHANGABLE email containing a tailored,
 *     human-readable list of exactly what changed for them.
 *
 * Failures are caught by the caller — notifications are best-effort.
 */
const sendVendorEditNotifications = async (rfq_id, userId, diff) => {
  const meta = await db.oneOrNone('SELECT rfq_no FROM tbl_rfq WHERE id = $1', [rfq_id]);
  if (!meta) return;

  const buyer = await userModel.getUserById(userId).catch(() => null);
  const buyerName = (buyer && buyer[0]?.name) || 'Buyer';

  const hydrateVendors = async (vendorIds) => {
    if (!vendorIds.size) return [];
    return db.any(
      'SELECT id AS vendor_id, name, email FROM tbl_users WHERE id = ANY($1::int[])',
      [[...vendorIds]]
    );
  };

  // ── Bucket 1: NEW_PRODUCT ──────────────────────────────────────────────
  // Only fires for vendors who get added to an EXISTING product mid-edit
  // (they were previously not on this RFQ at all). Vendors auto-attached
  // to a brand-new product (`diff.products.added`) are intentionally NOT
  // bucketed here — their notification is folded into the consolidated
  // UPDATED_VENDOR_WITH_CHANGABLE email by buildPerVendorChangedDetails
  // so they don't receive two separate "this RFQ exists" emails for the
  // same edit session.
  const newOpportunityVendorIds = new Set();
  for (const u of diff.products.updated) {
    for (const v of u.vendors.added.map(Number)) newOpportunityVendorIds.add(v);
  }

  // ── Bucket 2: REMOVED_VENDOR ───────────────────────────────────────────
  const removedVendorIds = new Set();
  for (const r of diff.products.removed) {
    for (const v of (r.current.vendors || [])) removedVendorIds.add(Number(v.user_id));
  }
  for (const u of diff.products.updated) {
    for (const v of u.vendors.removed.map(Number)) removedVendorIds.add(v);
  }

  // ── Bucket 3: per-vendor tailored changedDetails ───────────────────────
  const { perVendorMap, rfqLevelLines } = buildPerVendorChangedDetails(diff);

  // Top up audience for RFQ-level changes — include vendors of unchanged
  // products too. We pull every distinct vendor for the RFQ from the DB,
  // exclude removed/new ones, and merge in any RFQ-level changes.
  if (rfqLevelLines.length > 0) {
    const allRfqVendors = await db.any(
      'SELECT DISTINCT user_id FROM tbl_rfq_product_vendors WHERE rfq_id = $1',
      [rfq_id]
    );
    for (const row of allRfqVendors) {
      const vid = Number(row.user_id);
      if (newOpportunityVendorIds.has(vid)) continue; // they get NEW_PRODUCT
      if (removedVendorIds.has(vid)) continue;        // they get REMOVED_VENDOR
      if (!perVendorMap.has(vid)) {
        perVendorMap.set(vid, [...rfqLevelLines]);
      }
    }
  }

  // Dispatch
  // Batch-hydrate every vendor we might email in ONE query, then build a
  // lookup map. The previous code did one `SELECT WHERE id = $1` per
  // vendor inside a sequential await loop, which was the single biggest
  // contributor to the 7s update latency.
  const allVendorIdsToHydrate = new Set([
    ...newOpportunityVendorIds,
    ...removedVendorIds,
    ...perVendorMap.keys()
  ]);
  const hydratedRows = allVendorIdsToHydrate.size
    ? await db.any(
        'SELECT id AS vendor_id, name, email FROM tbl_users WHERE id = ANY($1::int[])',
        [[...allVendorIdsToHydrate]]
      )
    : [];
  const vendorById = new Map(hydratedRows.map((r) => [Number(r.vendor_id), r]));
  const pickVendors = (ids) => [...ids].map((id) => vendorById.get(Number(id))).filter(Boolean);

  const dispatchTasks = [];

  const newOpportunityVendors = pickVendors(newOpportunityVendorIds);
  if (newOpportunityVendors.length > 0) {
    dispatchTasks.push(
      sendRfqUpdatedMailToVendors(
        newOpportunityVendors,
        rfq_id,
        meta.rfq_no,
        buyerName,
        RFQ_EMAIL_TYPE.NEW_PRODUCT
      )
    );
  }

  const removedVendors = pickVendors(removedVendorIds);
  if (removedVendors.length > 0) {
    dispatchTasks.push(
      sendRfqUpdatedMailToVendors(
        removedVendors,
        rfq_id,
        meta.rfq_no,
        buyerName,
        RFQ_EMAIL_TYPE.REMOVED_VENDOR
      )
    );
  }

  // Per-vendor tailored emails — one mail per vendor with their own
  // changes. Run them in parallel: each call is independent and the
  // sequential await was the second biggest latency contributor.
  for (const [vendorId, lines] of perVendorMap.entries()) {
    if (newOpportunityVendorIds.has(vendorId) || removedVendorIds.has(vendorId)) continue;
    if (lines.length === 0) continue;
    const v = vendorById.get(Number(vendorId));
    if (!v) continue;
    dispatchTasks.push(
      sendRfqUpdatedMailToVendors(
        [v],
        rfq_id,
        meta.rfq_no,
        buyerName,
        RFQ_EMAIL_TYPE.UPDATED_VENDOR_WITH_CHANGABLE,
        lines
      )
    );
  }

  // Fire all dispatches concurrently. Errors are swallowed per-vendor so
  // a single failed mail doesn't kill the batch — we just log it.
  await Promise.allSettled(dispatchTasks).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.error({ reason: r.reason?.message || r.reason }, '[wh69] vendor mail dispatch failed');
      }
    }
  });
};

const rfqController = {
  createTenderPaymentOrder: async (req, res) => {
    try {
      const { rfq_id } = req.body;
      const vendorId = req.user?.id;

      if (!rfq_id || !vendorId) {
        return res.status(400).json({ status: 3, message: 'rfq_id and vendor are required' }).end();
      }

      const rfqDetails = await rfqModel.getRFQDetails(rfq_id);
      if (!rfqDetails || rfqDetails.length === 0) {
        return res.status(404).json({ status: 0, message: 'RFQ not found' }).end();
      }

      const rfq = rfqDetails[0];
      if (rfq.is_tender !== 1) {
        return res.status(400).json({ status: 3, message: 'RFQ is not marked as tender' }).end();
      }

      // Changes by Agnij [Database stores tender_fees in paise already - don't convert]
      // Frontend stores tender_fees in paise (multiplies by 100 when user enters rupees)
      // So we use the value directly without multiplying by 100
      const amountInPaise = parseInt(rfq.tender_fees || 0);
      
      if (!amountInPaise || amountInPaise <= 0) {
        return res.status(400).json({ status: 3, message: 'Tender fees not configured' }).end();
      }

      const existingPayment = await db.oneOrNone(
        `SELECT id, payment_status 
         FROM tbl_vendor_payments 
         WHERE vendor_id = $1 AND rfq_id = $2 AND payment_type = 'tender'
         ORDER BY id DESC LIMIT 1`,
        [vendorId, rfq_id]
      );

      if (existingPayment && existingPayment.payment_status === 'success') {
        return res.status(200).json({
          status: 1,
          data: { already_paid: true, payment_id: existingPayment.id }
        }).end();
      }

      const razorpay = new Razorpay({
        key_id: Config.razorpay.razorpay_key,
        key_secret: Config.razorpay.razorpay_secret
      });

      const receipt = `TENDER-${rfq_id}-${vendorId}-${Date.now()}`;

      const order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt,
        payment_capture: 1
      });

      const beforePayload = JSON.stringify(order);
      // Changes by Agnij [Store amount in paise in database to match how it's stored in RFQ]
      const paymentRow = await db.one(
        `INSERT INTO tbl_vendor_payments 
          (vendor_id, rfq_id, amount, currency, payment_status, razorpay_order_id, payment_type, method, receipt, before_payment_response)
         VALUES ($1,$2,$3,$4,'created',$5,'tender', $6, $7, $8)
         RETURNING id`,
        [vendorId, rfq_id, amountInPaise, 'INR', order.id, order.method || null, receipt, beforePayload]
      );

      return res.status(200).json({
        status: 1,
        data: {
          order,
          payment_id: paymentRow.id
        }
      }).end();
    } catch (error) {
      logError(error);
      return res.status(400).json({ status: 3, message: error.message }).end();
    }
  },

  verifyTenderPayment: async (req, res) => {
    try {
      const { razorpay_payment_id, razorpay_order_id, razorpay_signature, rfq_id } = req.body;
      const vendorId = req.user?.id;

      if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature || !rfq_id) {
        return res.status(400).json({ status: 3, message: 'Missing payment fields' }).end();
      }

      const sign = `${razorpay_order_id}|${razorpay_payment_id}`;
      const expectedSign = crypto
        .createHmac('sha256', Config.razorpay.razorpay_secret)
        .update(sign.toString())
        .digest('hex');

      const isValid = expectedSign === razorpay_signature;
      const paymentStatus = isValid ? 'success' : 'failed';

      const afterPayload = JSON.stringify({
        razorpay_payment_id,
        razorpay_order_id,
        razorpay_signature
      });

      const updated = await db.result(
        `UPDATE tbl_vendor_payments
         SET razorpay_payment_id = $1,
             razorpay_signature = $2,
             payment_status = $3,
             after_payment_response = $4
         WHERE vendor_id = $5 AND rfq_id = $6 AND razorpay_order_id = $7
         RETURNING id`,
        [
          razorpay_payment_id,
          razorpay_signature,
          paymentStatus,
          afterPayload,
          vendorId,
          rfq_id,
          razorpay_order_id
        ]
      );

      if (updated.rowCount === 0) {
        return res.status(404).json({ status: 0, message: 'Payment record not found' }).end();
      }

      // Send payment confirmation email with invoice if payment was successful
      if (isValid) {
        try {
          // Fetch vendor details
          const vendorDetails = await db.oneOrNone(
            `SELECT id, name, email, organization_name FROM tbl_users WHERE id = $1`,
            [vendorId]
          );

          // Fetch RFQ details
          const rfqDetails = await db.oneOrNone(
            `SELECT r.id, r.rfq_no, r.title, r.tender_fees,
                    u.name as buyer_name, u.email as buyer_email,
                    hc.name as company_name
             FROM tbl_rfq r
             LEFT JOIN tbl_users u ON r.created_by = u.id
             LEFT JOIN tbl_hospitality_companies hc ON r.hospitality_company_id = hc.id
             WHERE r.id = $1`,
            [rfq_id]
          );

          // Fetch payment details
          const paymentDetails = await db.oneOrNone(
            `SELECT id as payment_id, razorpay_payment_id, razorpay_order_id, amount, receipt
             FROM tbl_vendor_payments
             WHERE id = $1`,
            [updated.rows[0].id]
          );

          // Send email with invoice
          sendTenderFeePaymentConfirmation({
            vendorDetails,
            rfqDetails,
            paymentDetails,
            buyerDetails: {
              company_name: rfqDetails?.company_name,
              email: rfqDetails?.buyer_email,
              contact_number: null
            }
          });
        } catch (emailError) {
          // Log email error but don't fail the payment verification
          logError('Error sending tender fee payment email', emailError);
        }
      }

      return res.status(200).json({
        status: isValid ? 1 : 0,
        message: isValid ? 'Payment verified' : 'Invalid signature',
        payment_id: updated.rows[0].id
      }).end();
    } catch (error) {
      logError(error);
      return res.status(400).json({ status: 3, message: error.message }).end();
    }
  },
  create: async (req, res, next) => {
    try {
      let { rfq_id , ra_start_date , ra_end_date , bid_end_date , reverse_auction, selectedSheets } = req.body;

      // Normalize reverse_auction to boolean for consistent checks
      const isReverseAuctionEnabled = reverse_auction === 1 || reverse_auction === '1' || reverse_auction === true;

      // Normalize date values - treat empty strings as null
      const normalizedRaStart = ra_start_date && ra_start_date !== '' ? ra_start_date : null;
      const normalizedRaEnd = ra_end_date && ra_end_date !== '' ? ra_end_date : null;
      const normalizedBidEnd = bid_end_date && bid_end_date !== '' ? bid_end_date : null;

      const user_id = req.user.id;
      if (!rfq_id) {
        return res
          .status(400)
          .json({
            status: 3,
            errors: {
              rfq: 'RFQ Id is required to create an RFQ from Draft!'
            }
          })
          .end();
      }
      // check if RA is true
      if (isReverseAuctionEnabled) {
        if (!normalizedRaStart || !normalizedRaEnd) {
          return res
            .status(400)
            .json({
              status: 3,
              errors: {
                ra_start_date: !normalizedRaStart ? 'RA Start Date is required' : undefined,
                ra_end_date: !normalizedRaEnd ? 'RA End Date is required' : undefined
              }
            })
            .end();
        }
        const raStartParsed = new Date(normalizedRaStart);
        const raEndParsed = new Date(normalizedRaEnd);
        const bidEndParsed = normalizedBidEnd ? new Date(normalizedBidEnd) : null;

        if (isNaN(raStartParsed.getTime()) || isNaN(raEndParsed.getTime())) {
          return res
            .status(400)
            .json({
              status: 3,
              errors: {
                ra_start_date: isNaN(raStartParsed.getTime()) ? 'Invalid RA Start Date format' : undefined,
                ra_end_date: isNaN(raEndParsed.getTime()) ? 'Invalid RA End Date format' : undefined
              }
            })
            .end();
        }
        if (raStartParsed >= raEndParsed) {
          return res
            .status(400)
            .json({ status: 3, message: 'RA Start Date should be before RA End Date' })
            .end();
        }
        if (bidEndParsed && raStartParsed <= bidEndParsed) {
          return res
            .status(400)
            .json({ status: 3, message: 'RA Start Date should be after Bid End Date' })
            .end();
        }
      }
      await saveRfqDraft(user_id, req.body);

      const isRFQComplete = await rfqModel.checkRFQCompletion(rfq_id, selectedSheets);

      if (!isRFQComplete) {
        return res
          .status(400)
          .json({
            status: 2,
            message: 'Some products are missing quantity or unit. Please fill them before proceeding.'
          })
          .end();
      }
      // Defence-in-depth: ensure every product has at least one vendor
      const productsWithoutVendors = await rfqModel.checkProductVendors(rfq_id, selectedSheets);
      if (productsWithoutVendors.length > 0) {
        const names = productsWithoutVendors.map(p => p.product_name).join(', ');
        const message = `At least one vendor is required for each product. Missing: ${names}`;
        const details = productsWithoutVendors.map(p => ({
          rfqProductId: p.id,
          productName: p.product_name
        }));
        return res
          .status(400)
          .json({ status: 2, message, details })
          .end();
      }

      await rfqModel.removeRFQData(rfq_id, selectedSheets);

      const [hotel_id] = req.body.hotel_ids || [];

      // Wrap RFQ update, duplication, and approval in a single transaction
      // If any step fails (e.g., no approval policy), everything rolls back
      const { responseUpdate, allRfqIds, isHospitalityRfq, hasAutoApproved } = await db.tx(async (t) => {
        // Look up hospitality_company_id from the hotel
        let hospitality_company_id = null;
        let hospitality_company_name = null;
        if (hotel_id) {
          const hotelRecord = await t.oneOrNone(
            `SELECT HCH.hospitality_company_id, HC.name AS hospitality_company_name FROM tbl_hospitality_company_hotels HCH JOIN tbl_hospitality_companies HC ON HC.id = HCH.hospitality_company_id WHERE HCH.id = $1 AND HCH.is_deleted = 0`,
            [hotel_id]
          );
          hospitality_company_id = hotelRecord?.hospitality_company_id || null;
          hospitality_company_name = hotelRecord?.hospitality_company_name || null
        }

        // Update RFQ with hotel_id, hospitality_company_id
        // All RFQs start in PENDING_APPROVAL state (status=3, is_published=0)
        // After approval completes, status transitions to READY_TO_PUBLISH (4)
        // Then scheduler publishes when tender_publish_date is reached
        const updateResult = await t.any(
          `UPDATE tbl_rfq
           SET is_published = 0, status = 3, hotel_id = $1, hospitality_company_id = $2, company_name = $3
           WHERE id = $4
           RETURNING *`,
          [
            hotel_id || null,
            hospitality_company_id,
            hospitality_company_name,
            rfq_id,
          ]
        );

        // Duplicate RFQ for other hotels (passes transaction context)
        const duplicationResult = await duplicateRfqForHotels(rfq_id, req.body.hotel_ids || [], user_id, t);

        // Start approval process for all RFQs (original + duplicates)
        // IMPORTANT: For hospitality RFQs, approval policy is REQUIRED
        // If no policy exists, this will throw and rollback the entire transaction
        const rfqIds = duplicationResult?.allRfqIds || [rfq_id];
        let hasAutoApproved = false;
        const approvalResults = await Promise.all(
          rfqIds.map(async (id) => {
            const approvalResult = await startApprovalForRfq(id, user_id, t);
            
            // Track if any RFQ was auto-approved
            if (approvalResult?.autoApproved) {
              hasAutoApproved = true;
            }
            
            // Record lifecycle: SUBMITTED for approval (only if not auto-approved)
            // Auto-approved RFQs already have APPROVED lifecycle event recorded
            const rfqData = await t.oneOrNone(
              `SELECT is_tender FROM tbl_rfq WHERE id = $1`,
              [id]
            );
            if (rfqData && approvalResult && !approvalResult.autoApproved) {
              await recordLifecycleEvent({
                entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
                entity_id: id,
                stage: 'SUBMITTED',
                action: 'SUBMIT',
                performed_by: user_id,
                metadata: { approval_instance_id: approvalResult.instance?.id },
                txContext: t
              });
            }
            
            return approvalResult;
          })
        );

        // PUBLISHED lifecycle event will be recorded by the scheduler after approval completes
        // and tender_publish_date is reached

        return { responseUpdate: updateResult, allRfqIds: rfqIds, hasAutoApproved };
      });

      // -------------------
      // Email notifications happen AFTER successful transaction

      // Notify approval workflow users + RFQ creator about RFQ/Tender creation (fire-and-forget)
      try {
        const rfqDetailsForEmail = await rfqModel.getRFQDetails(rfq_id);
        const rfqForEmail = rfqDetailsForEmail?.[0];

        const creationEntityType = rfqForEmail?.is_tender === 1 ? 'TENDER' : 'RFQ';
        const emailUsers = await getRfqNotificationRecipients(creationEntityType, rfq_id, rfqForEmail?.created_by);

        if (emailUsers.length > 0) {
          sendRfqCreationNotification({
            rfqDetails: { id: rfq_id, rfq_no: rfqForEmail.rfq_no, is_tender: rfqForEmail.is_tender, title: rfqForEmail.title },
            autoApproved: hasAutoApproved,
            users: emailUsers,
            creatorName: req.user.name
          });
        }
      } catch (emailError) {
        logError('Error sending RFQ creation emails', emailError);
      }

      const buyerMsgPayload = {
        mobile: req.user.mobile,
        rfq_id: rfq_id,
        rfq_no: responseUpdate[0]?.rfq_no
      };
      
      // Check final RFQ status to determine message
      const finalRfqStatus = await rfqModel.getRFQDetails(rfq_id);
      const isReadyToPublish = finalRfqStatus?.[0]?.status === 4;
      
      if (hasAutoApproved || isReadyToPublish) {
        // RFQ was auto-approved (created by final approver)
        whatsappNotificationAISensy.buyerCreatesRFQNotification(buyerMsgPayload);
        return res
          .status(200)
          .json({
            status: 1,
            data: responseUpdate[0],
            pending_approval: false,
            auto_approved: true,
            message: 'Tender created and approved instantly (created by final approver). Ready for publishing.'
          });
      } else {
        // RFQ requires approval
        whatsappNotificationAISensy.buyerCreatesRFQNotification(buyerMsgPayload);
        return res
          .status(200)
          .json({
            status: 1,
            data: responseUpdate[0],
            pending_approval: true,
            message: 'RFQ submitted for approval. Vendors will be notified after approval and publishing.'
          });
      }
    } catch (error) {
      logError(error);
      return res
        .status(400)
        .json({
          status: 2,
          message: error.message || 'An error occurred while creating RFQ',
          details: error || [],
        })
        .end();
    }
  },

  // WH-69: GET /rfq/:id/edit-history — feed for the new Edit History panel
  // on the RFQ details page.
  getEditHistory: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.id, 10);
      if (!rfq_id) {
        return res.status(400).json({ status: 0, message: 'rfq_id is required' });
      }
      const sessions = await rfqHistoryModel.getEditSessionsForRfq(rfq_id);
      return res.status(200).json({
        status: 1,
        data: { sessions: sessions || [] }
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message || 'Failed to fetch RFQ edit history'
      });
    }
  },

  /**
   * POST /rfq/copy
   *
   * Creates a DRAFT RFQ pre-populated from a source RFQ. Copies header,
   * products, specs, files, terms, and tech-eval clauses; re-resolves
   * vendors fresh against the TARGET hotel's current eligible pool so
   * newly-onboarded vendors are included and de-listed ones drop. Dates
   * are blanked; status forced to DRAFT; rfq_no is fresh.
   *
   * Notifications, approval instances, and lifecycle events are NOT
   * triggered — those fire when the buyer submits the draft from the
   * CreateRFQ wizard.
   *
   * Body: { source_rfq_id, target_hotel_id }
   * Auth: req.user.id must have hospitality_mappings access to both
   *       source.hotel_id and target_hotel_id.
   */
  copyRfq: async (req, res) => {
    try {
      const userId = req.user.id;
      const { source_rfq_id, target_hotel_id } = req.body;

      // 1. Build the caller's accessible hotel set from their mappings.
      const mappings = await hospitalityModel.getUserMappings(userId, { includeHotelRows: true });
      const accessibleHotelIds = new Set(
        (mappings || [])
          .map((m) => m.hospitality_hotel_id)
          .filter((id) => id != null)
      );

      if (!accessibleHotelIds.has(target_hotel_id)) {
        return res.status(403).json({
          status: 3,
          message: 'You do not have access to the selected business unit.'
        });
      }

      // 2. Load source RFQ row. We use the raw row (not the heavy details
      // payload from rfqModel.getRfqById) — we need the bare columns to
      // copy, and the access check above plus the hotel check below cover
      // tenant isolation.
      const sourceRfq = await db.oneOrNone(
        `SELECT * FROM tbl_rfq WHERE id = $1`,
        [source_rfq_id]
      );
      if (!sourceRfq) {
        return res.status(404).json({ status: 2, message: 'Source RFQ not found.' });
      }
      if (sourceRfq.hotel_id && !accessibleHotelIds.has(sourceRfq.hotel_id)) {
        // Treat as not-found to avoid leaking existence across tenants.
        return res.status(404).json({ status: 2, message: 'Source RFQ not found.' });
      }

      // 3. Derive the target hospitality_company_id from the target hotel.
      const targetHotel = await db.oneOrNone(
        `SELECT hospitality_company_id FROM tbl_hospitality_company_hotels WHERE id = $1 AND is_deleted = 0`,
        [target_hotel_id]
      );
      if (!targetHotel) {
        return res.status(400).json({ status: 0, message: 'Invalid business unit.' });
      }

      // 4. Clone everything atomically.
      const newRfq = await db.tx(async (t) => {
        const inserted = await t.one(
          `INSERT INTO tbl_rfq (
             rfq_no,
             comment,
             company_name,
             response_email,
             contact_name,
             contact_number,
             bid_end_date,
             location,
             is_published,
             created_by,
             updated_by,
             status,
             rfq_type,
             reverse_auction,
             project_id,
             ra_start_date,
             ra_end_date,
             rfq_added_from,
             processed_url,
             is_tender,
             tender_publish_date,
             vendor_clarification_date,
             hospitality_company_id,
             tender_fees,
             hotel_id,
             process_id,
             department_id,
             title,
             technical_evaluation_by,
             copied_from_rfq_id,
             copied_from_rfq_no
           )
           SELECT
             (SELECT COALESCE(MAX(rfq_no), 100000) + 1 FROM tbl_rfq),
             comment,
             (SELECT hc.name FROM tbl_hospitality_company_hotels hch
              JOIN tbl_hospitality_companies hc ON hc.id = hch.hospitality_company_id
              WHERE hch.id = $2),
             response_email,
             contact_name,
             contact_number,
             '',                    -- bid_end_date blanked (NOT NULL text column)
             location,
             0,                     -- is_published
             $3,                    -- created_by
             $3,                    -- updated_by
             1,                     -- status = DRAFT
             rfq_type,
             reverse_auction,
             project_id,
             NULL,                  -- ra_start_date blanked
             NULL,                  -- ra_end_date blanked
             rfq_added_from,
             processed_url,
             is_tender,
             NULL,                  -- tender_publish_date blanked
             NULL,                  -- vendor_clarification_date blanked
             $4,                    -- hospitality_company_id from target hotel
             NULL,                  -- tender_fees blanked
             $2,                    -- hotel_id = target
             process_id,
             department_id,
             title,
             technical_evaluation_by,
             $1,                    -- copied_from_rfq_id
             rfq_no                 -- copied_from_rfq_no (denormalized for list views)
           FROM tbl_rfq
           WHERE id = $1
           RETURNING id, rfq_no`,
          [source_rfq_id, target_hotel_id, userId, targetHotel.hospitality_company_id]
        );
        const newRfqId = inserted.id;

        // Hotel mapping for the new RFQ (single target).
        await t.none(
          `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [newRfqId, target_hotel_id, userId]
        );

        // Products — re-resolve vendors per product against the target hotel.
        const sourceProducts = await t.any(
          `SELECT * FROM tbl_rfq_products WHERE rfq_id = $1`,
          [source_rfq_id]
        );
        const productIdMap = {};
        for (const product of sourceProducts) {
          const newProduct = await t.one(
            `INSERT INTO tbl_rfq_products (
               rfq_id, comment, datasheet, spec_file, qap_file,
               product_variant_id, qap, datasheet_file, variant, sheet_id
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id`,
            [
              newRfqId,
              product.comment,
              product.datasheet,
              product.spec_file,
              product.qap_file,
              product.product_variant_id,
              product.qap,
              product.datasheet_file,
              product.variant,
              product.sheet_id
            ]
          );
          productIdMap[product.id] = newProduct.id;

          // Re-resolve eligible vendors for THIS variant against the TARGET
          // hotel's current subscription state. May return empty — that's a
          // legitimate DRAFT state and the buyer fills it in the editor.
          const eligibleVendors = await hospitalityModel.getEligibleVendorsForVariant(
            product.product_variant_id,
            [target_hotel_id]
          );
          for (const vendor of eligibleVendors) {
            await t.none(
              `INSERT INTO tbl_rfq_product_vendors (
                 rfq_id, product_variant_id, user_id, variant, sheet_id, is_rfq_viewed
               )
               VALUES ($1, $2, $3, $4, $5, 0)`,
              [
                newRfqId,
                product.product_variant_id,
                vendor.vendor_id,
                product.variant,
                product.sheet_id
              ]
            );
          }
        }

        // Specs (leaf).
        await t.none(
          `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant, sheet_id)
           SELECT $2, product_variant_id, title, value, variant, sheet_id
           FROM tbl_rfq_products_specs
           WHERE rfq_id = $1`,
          [source_rfq_id, newRfqId]
        );

        // Product files — remap via productIdMap.
        const productFiles = await t.any(
          `SELECT pf.*
           FROM tbl_rfq_product_files pf
           JOIN tbl_rfq_products p ON p.id = pf.rfq_product_id
           WHERE p.rfq_id = $1`,
          [source_rfq_id]
        );
        for (const file of productFiles) {
          const mappedProductId = productIdMap[file.rfq_product_id];
          if (!mappedProductId) continue;
          await t.none(
            `INSERT INTO tbl_rfq_product_files (rfq_product_id, file_type, file_url, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [mappedProductId, file.file_type, file.file_url, file.created_at, file.updated_at]
          );
        }

        // RFQ-level files (T&C, scope, etc.) — leaf.
        await t.none(
          `INSERT INTO tbl_rfq_files (rfq_id, file_type, file_url)
           SELECT $2, file_type, file_url
           FROM tbl_rfq_files
           WHERE rfq_id = $1`,
          [source_rfq_id, newRfqId]
        );

        // Terms map — leaf.
        await t.none(
          `INSERT INTO tbl_rfq_terms_map (rfq_id, terms_id)
           SELECT $2, terms_id
           FROM tbl_rfq_terms_map
           WHERE rfq_id = $1`,
          [source_rfq_id, newRfqId]
        );

        // Tech evaluation parent rows.
        const techEvals = await t.any(
          `SELECT * FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1`,
          [source_rfq_id]
        );
        const techEvalIdMap = {};
        for (const te of techEvals) {
          const newProductId = productIdMap[te.tbl_rfq_product_id];
          if (!newProductId) continue;
          const newTechEval = await t.one(
            `INSERT INTO tbl_rfq_product_tech_evaluation (
               rfq_id, tbl_rfq_product_id, minimum_passing_score
             )
             VALUES ($1, $2, $3)
             RETURNING id`,
            [newRfqId, newProductId, te.minimum_passing_score]
          );
          techEvalIdMap[te.id] = newTechEval.id;
        }

        // Clauses + capture new clause IDs for the leaf file table.
        const clauses = await t.any(
          `SELECT * FROM tbl_rfq_product_tech_evaluation_clauses
           WHERE tbl_rfq_product_tech_evaluation_id IN (
             SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1
           )`,
          [source_rfq_id]
        );
        const clauseIdMap = {};
        for (const clause of clauses) {
          const newTechEvalId = techEvalIdMap[clause.tbl_rfq_product_tech_evaluation_id];
          if (!newTechEvalId) continue;
          const newClause = await t.one(
            `INSERT INTO tbl_rfq_product_tech_evaluation_clauses (
               tbl_rfq_product_tech_evaluation_id, clause_text, weightage, clause_type
             )
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [newTechEvalId, clause.clause_text, clause.weightage, clause.clause_type]
          );
          clauseIdMap[clause.id] = newClause.id;
        }

        // Clause files — use the explicit clauseIdMap rather than text match.
        const clauseFiles = await t.any(
          `SELECT f.*
           FROM tbl_rfq_product_tech_evaluation_clauses_files f
           JOIN tbl_rfq_product_tech_evaluation_clauses c
             ON c.id = f.tbl_rfq_product_tech_evaluation_clauses_id
           JOIN tbl_rfq_product_tech_evaluation te
             ON te.id = c.tbl_rfq_product_tech_evaluation_id
           WHERE te.rfq_id = $1`,
          [source_rfq_id]
        );
        for (const file of clauseFiles) {
          const newClauseId = clauseIdMap[file.tbl_rfq_product_tech_evaluation_clauses_id];
          if (!newClauseId) continue;
          await t.none(
            `INSERT INTO tbl_rfq_product_tech_evaluation_clauses_files (
               tbl_rfq_product_tech_evaluation_clauses_id, file_url
             )
             VALUES ($1, $2)`,
            [newClauseId, file.file_url]
          );
        }

        return inserted;
      });

      return res.status(200).json({
        status: 1,
        message: 'RFQ copied to a new draft.',
        data: {
          new_rfq_id: newRfq.id,
          new_rfq_no: newRfq.rfq_no,
          copied_from: source_rfq_id
        }
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message || 'Failed to copy RFQ.'
      });
    }
  },

  /**
   * GET /rfq/:id/lineage
   * Returns the back-link (copied_from) and forward-links (copies) for an
   * RFQ, filtered by the caller's accessible hotels so we don't leak
   * cross-tenant existence.
   */
  getRfqLineage: async (req, res) => {
    try {
      const rfqId = parseInt(req.params.id, 10);
      if (!rfqId) {
        return res.status(400).json({ status: 0, message: 'Invalid RFQ id.' });
      }
      const userId = req.user.id;

      // Build accessible hotel set first, so the inner queries filter on it.
      const mappings = await hospitalityModel.getUserMappings(userId, { includeHotelRows: true });
      const accessibleHotelIds = [
        ...new Set(
          (mappings || [])
            .map((m) => m.hospitality_hotel_id)
            .filter((id) => id != null)
        )
      ];

      const rfq = await db.oneOrNone(
        `SELECT id, hotel_id FROM tbl_rfq WHERE id = $1`,
        [rfqId]
      );
      if (!rfq) {
        return res.status(404).json({ status: 2, message: 'RFQ not found.' });
      }
      if (rfq.hotel_id && !accessibleHotelIds.includes(rfq.hotel_id)) {
        return res.status(404).json({ status: 2, message: 'RFQ not found.' });
      }

      const lineage = await rfqModel.getCopyLineage(rfqId, accessibleHotelIds);
      return res.status(200).json({ status: 1, data: lineage });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message || 'Failed to fetch lineage.'
      });
    }
  },

  // WH-69 snapshot-diff update flow — see app/controllers/rfq/rfqUpdateHelpers.js
  update: async (req, res, next) => {
    try {
      const userId = req.user.id;
      const { rfq_id, snapshot } = req.body;

      if (!rfq_id || !snapshot) {
        return res.status(400).json({
          status: 0,
          message: 'rfq_id and snapshot are required'
        });
      }

      const editSessionId = uuidv4();

      const result = await db.tx(async (t) => {
        // 1. Read the canonical current state and authorise the edit
        const current = await rfqModel.getFullRfqForEdit(rfq_id, t);

        // 1b. Check for existing quotes early — needed by assertEditAllowed
        //     to allow editing when bid window closed but no vendors participated.
        //     hasQuotes is regret-inclusive and feeds the post-deadline block message.
        //     hasReceivedQuotes filters out regrets and triggers restricted-edit mode
        //     for fairness once a vendor has actually started bidding in good faith
        //     (even while bid window is still open).
        const hasQuotes = !!(await t.oneOrNone(
          'SELECT 1 FROM tbl_quotes WHERE rfq_id = $1 LIMIT 1',
          [rfq_id]
        ));
        const hasReceivedQuotes = !!(await t.oneOrNone(
          `SELECT 1 FROM tbl_quotes
            WHERE rfq_id = $1
              AND (is_regret IS NULL OR is_regret != 1)
            LIMIT 1`,
          [rfq_id]
        ));

        // 1c. Check for dead-end products — allows editing even after bid
        //     window closes when all eligible vendors' POs were rejected.
        const hasDeadEndProduct = !!(await t.oneOrNone(`
          SELECT 1 FROM tbl_rfq_products rp_de
          WHERE rp_de.rfq_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM tbl_quote_finalization qf_de
              WHERE qf_de.rfq_id = $1
                AND qf_de.product_variant_id = rp_de.product_variant_id
                AND qf_de.variant = rp_de.variant
            )
            AND NOT EXISTS (
              SELECT 1 FROM tbl_rfq_purchase_order po_de
              JOIN tbl_purchase_order_product pop_de ON pop_de.purchase_order_id = po_de.id
              WHERE po_de.rfq_id = $1
                AND pop_de.rfq_product_id = rp_de.id
                AND po_de.status NOT IN ('rejected', 'rejected_by_vendor', 'cancelled')
            )
            AND EXISTS (
              SELECT 1 FROM tbl_rfq_purchase_order po_rej
              JOIN tbl_purchase_order_product pop_rej ON pop_rej.purchase_order_id = po_rej.id
              WHERE po_rej.rfq_id = $1
                AND pop_rej.rfq_product_id = rp_de.id
                AND po_rej.status IN ('rejected', 'rejected_by_vendor')
            )
            AND NOT EXISTS (
              SELECT 1 FROM tbl_quote_items qi_de
              JOIN tbl_quotes q_de ON q_de.id = qi_de.quote_id
              WHERE q_de.rfq_id = $1
                AND qi_de.product_variant_id = rp_de.product_variant_id
                AND qi_de.variant = rp_de.variant
                AND (q_de.is_regret IS NULL OR q_de.is_regret != 1)
                AND (
                  NOT EXISTS (
                    SELECT 1 FROM tbl_rfq_product_tech_evaluation te_chk
                    WHERE te_chk.tbl_rfq_product_id = rp_de.id
                  )
                  OR EXISTS (
                    SELECT 1 FROM tbl_rfq_product_tech_evaluation_cleared_vendors tecv
                    JOIN tbl_rfq_product_tech_evaluation te
                      ON tecv.tbl_rfq_product_tech_evaluation_id = te.id
                    WHERE te.tbl_rfq_product_id = rp_de.id
                      AND tecv.vendor_id = q_de.created_by
                      AND tecv.status = 1
                  )
                )
                AND NOT EXISTS (
                  SELECT 1 FROM tbl_rfq_purchase_order po_v
                  JOIN tbl_purchase_order_product pop_v ON pop_v.purchase_order_id = po_v.id
                  WHERE po_v.rfq_id = $1
                    AND pop_v.rfq_product_id = rp_de.id
                    AND po_v.finalized_vendor_id = q_de.created_by
                    AND po_v.status IN ('rejected', 'rejected_by_vendor')
                )
            )
          LIMIT 1
        `, [rfq_id]));

        // 1d. Check for tech-eval-stuck products — allows restricted editing
        //     (only bid_end_date + vendor refresh) when all vendors failed tech eval.
        const hasTechStuckProduct = !!(await t.oneOrNone(`
          SELECT 1 FROM tbl_rfq_product_tech_evaluation te_stuck
          WHERE te_stuck.rfq_id = $1
            AND te_stuck.blocked_insufficient_vendors = TRUE
            AND COALESCE(te_stuck.total_passed_verified, 0) = 0
          LIMIT 1
        `, [rfq_id]));

        // Restricted edit = tech-stuck OR dead-end OR a real (non-regret) quote has
        // already been received. Only bid_end_date + vendor refresh are allowed.
        const isRestrictedEdit = hasTechStuckProduct || hasDeadEndProduct || hasReceivedQuotes;

        assertEditAllowed(current, userId, { hasQuotes, hasDeadEndProduct, hasTechStuckProduct, hasReceivedQuotes });

        // 2. Post-publish field restrictions
        //    Once the RFQ is live, certain fields are off limits regardless
        //    of the snapshot the client sent. Vendors have already seen them.
        if (current.is_published === 1) {
          const lockedAfterPublish = ['tender_publish_date', 'tender_fees'];
          for (const f of lockedAfterPublish) {
            if (
              snapshot[f] !== undefined &&
              String(snapshot[f] ?? '') !== String(current[f] ?? '')
            ) {
              throw updateHttpError(
                400,
                `Cannot modify '${f}' after the RFQ has been published.`,
                f
              );
            }
          }
        }

        // 3. Date-window constraints (IST):
        //   - bid_end_date >= now + 2h
        //   - vendor_clarification_date <= bid_end_date - 1h
        //   - vendor_clarification_date > tender_publish_date
        // Computed in IST epoch-ms so server timezone drift can't shift
        // the windows around. See assertEditDateConstraints.
        assertEditDateConstraints({ snapshot, current });

        // 3b. Quantity & Unit are mandatory per product. Quantity must be a
        //     positive number >= 0.1; Unit must be non-empty. Validated
        //     against the full snapshot, not just the diff, so a save can't
        //     leave a product in an invalid state regardless of which
        //     section the user edited.
        assertProductQuantityAndUnit(snapshot);

        // 4. PO-locked products — load once for use during apply
        const poLocked = await t.any(
          `SELECT rp.id FROM tbl_rfq_products rp
            WHERE rp.rfq_id = $1
            AND EXISTS (
              SELECT 1 FROM tbl_rfq_purchase_order po
              JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
              WHERE po.rfq_id = rp.rfq_id AND pop.rfq_product_id = rp.id
              AND po.status IN ('approved','sent','dispatched','GRN','completed','invoice_raised')
            )`,
          [rfq_id]
        );
        const poLockedIds = new Set(poLocked.map((r) => r.id));

        // 5. Diff
        const diff = diffRfqSnapshot(current, snapshot);
        if (diff.isEmpty) {
          return { noop: true };
        }

        // 5b. Enforce restricted edit mode — only bid_end_date + vendor refresh allowed
        if (isRestrictedEdit) {
          const disallowedFields = diff.rfqFields.filter(f => f.field_name !== 'bid_end_date');
          if (disallowedFields.length > 0) {
            throw updateHttpError(400,
              `Restricted edit: only the Quote Submission Deadline can be modified. Cannot change: ${disallowedFields.map(f => f.field_name).join(', ')}`,
              disallowedFields[0].field_name
            );
          }
          if (diff.products.added.length > 0) {
            throw updateHttpError(400, 'Restricted edit: cannot add new products.', 'products');
          }
          if (diff.products.removed.length > 0) {
            throw updateHttpError(400, 'Restricted edit: cannot remove products.', 'products');
          }
          for (const update of diff.products.updated) {
            if (update.commentChanged) {
              throw updateHttpError(400, 'Restricted edit: cannot modify product comments.', 'products');
            }
            if (update.specs.added.length > 0 || update.specs.removed.length > 0 || update.specs.updated.length > 0) {
              throw updateHttpError(400, 'Restricted edit: cannot modify product specifications.', 'products');
            }
            if (update.files.added.length > 0 || update.files.removed.length > 0) {
              throw updateHttpError(400, 'Restricted edit: cannot modify product files.', 'products');
            }
            if (update.techEvalChanged) {
              throw updateHttpError(400, 'Restricted edit: cannot modify technical evaluation clauses.', 'products');
            }
            // vendors.added IS allowed (from Refresh Vendors)
          }
          if (diff.terms.added.length > 0 || diff.terms.removed.length > 0) {
            throw updateHttpError(400, 'Restricted edit: cannot modify terms.', 'terms');
          }
          if (diff.termFiles && (diff.termFiles.added.length > 0 || diff.termFiles.removed.length > 0)) {
            throw updateHttpError(400, 'Restricted edit: cannot modify terms & conditions files.', 'term_and_condition_files');
          }
        }

        // 6. Apply changes — order matters because the field UPDATE on tbl_rfq
        //    must run before any approval re-trigger so the new instance reads
        //    the post-edit row.
        const rfqHistory = await applyRfqFieldChanges(t, rfq_id, diff.rfqFields);
        const productHistory = await applyProductChanges(
          t,
          rfq_id,
          diff.products,
          poLockedIds,
          current
        );
        const termsHistory = await applyTermsChanges(t, rfq_id, diff.terms);
        const termFilesHistory = diff.termFiles
          ? await applyTermFileChanges(t, rfq_id, diff.termFiles)
          : [];

        const allHistory = [...rfqHistory, ...productHistory, ...termsHistory, ...termFilesHistory];

        // 7. Record history rows
        if (allHistory.length > 0) {
          await rfqHistoryModel.recordChanges(
            rfq_id,
            editSessionId,
            userId,
            allHistory,
            t
          );
        }

        const hasMaterialChange = allHistory.some((h) => h.is_material);

        // 8. Re-approval if any change is material — but NOT if the RFQ is
        //    already published. Published RFQs (including auto-published ones
        //    where approval was not completed in time) should not trigger a
        //    new approval cycle on edit.
        let reapprovalResult = null;
        if (hasMaterialChange && current.is_published !== 1) {
          reapprovalResult = await cancelAndReissueApproval(
            current,
            userId,
            editSessionId,
            t
          );
        }

        // 9. Lifecycle event for the edit session
        await recordLifecycleEvent({
          entity_type: current.is_tender ? 'TENDER' : 'RFQ',
          entity_id: rfq_id,
          stage: stageOfStatus(current.status),
          action: 'EDIT',
          performed_by: userId,
          metadata: {
            edit_session_id: editSessionId,
            material: hasMaterialChange,
            field_count: allHistory.length,
            reapproval: reapprovalResult || null
          },
          txContext: t
        });

        return {
          editSessionId,
          changeCount: allHistory.length,
          material: hasMaterialChange,
          reapproval: reapprovalResult,
          diff
        };
      });

      // 10. Respond IMMEDIATELY — notifications are dispatched in the
      //     background. Originally we awaited sendVendorEditNotifications
      //     here, which on RFQs with even a handful of vendors blocked the
      //     response for 5-7 seconds (sequential SPOC + token + email
      //     queries per vendor). The notifications are best-effort and
      //     never roll back the edit, so there's no reason to make the
      //     user wait for SMTP.
      const responsePayload = {
        status: 1,
        message: result.noop
          ? 'No changes detected'
          : 'RFQ updated successfully',
        edit_session_id: result.editSessionId || null,
        change_count: result.changeCount || 0,
        material: result.material || false,
        reapproval: result.reapproval || null
      };
      res.status(200).json(responsePayload);

      if (!result.noop && result.diff) {
        // setImmediate yields back to the event loop so the response
        // flushes before the slow email work begins.
        setImmediate(() => {
          sendVendorEditNotifications(rfq_id, userId, result.diff).catch((err) => {
            logError('[wh69] vendor notification error', err);
          });
        });
      }
      return;
    } catch (error) {
      logError(error);
      if (error.isHttpError) {
        return res.status(error.statusCode || 400).json({
          status: 0,
          message: error.message,
          ...(error.field ? { field: error.field } : {})
        });
      }
      return res.status(400).json({
        status: 3,
        message: error.message || 'An error occurred while updating the RFQ'
      });
    }
  },



  saveDraft: async (req, res) => {
    try {
      const response = await saveRfqDraft(req.user.id, req.body, { isDraft: true });

      res.status(200).json({
        status: 1,
        message: response
      });
    } catch (error) {
      logError(error);

      // F-DRAFT-500: saveRfqDraft signals business-logic rejections by
      // throwing `new Error(JSON.stringify({message, status, ...}))`.
      // Translate the structured-error shape to a sensible HTTP code so
      // access-denied / validation failures don't surface as 500.
      let parsedError = {};
      let isStructured = false;
      try {
        parsedError = JSON.parse(error?.message);
        isStructured = parsedError && typeof parsedError === 'object';
      } catch {
        // Plain string error — keep historical 500.
      }

      const innerMessage = isStructured ? (parsedError.message || error.message) : error.message;
      let httpCode = 500;
      if (isStructured) {
        // saveRfqDraft uses status:2 for access-denied + status:3 for validation.
        if (parsedError.status === 2) {
          httpCode = /access|permission|forbidden|unauthor/i.test(innerMessage || '') ? 403 : 404;
        } else if (parsedError.status === 3) {
          httpCode = 400;
        }
      }

      res.status(httpCode).json({
        status: 3,
        message: httpCode === 500
          ? 'An error occurred while saving the draft'
          : (innerMessage || 'An error occurred while saving the draft'),
        errors: {
          rfq: innerMessage || 'An error occurred while saving the draft',
          details: parsedError?.details || [],
        }
      });
    }
  },
  deleteDraft: async (req, res) => {
    try {
      const { id } = req.params;
      const user_id = req.user.id;

      const rfqDraft = await rfqModel.checkIfExists(
        'tbl_rfq',
        `id = ${id} AND is_published = 0 AND created_by = ${user_id}`
      );

      if (!rfqDraft || rfqDraft.length === 0) {
        return res.status(404).json({
          status: 2,
          message: 'Draft RFQ not found or does not belong to the user!'
        });
      }
      db.tx(async (t) => {
        // Delete main RFQ
        await rfqModel.delete('tbl_rfq', { id });

        // Delete RFQ-related records
        const rfqProductIdList = await rfqModel.deleteWithReturnIds(
          'tbl_rfq_products',
          { rfq_id: id },
          t
        );

        await rfqModel.delete('tbl_rfq_product_vendors', { rfq_id: id });
        await rfqModel.delete('tbl_rfq_products_specs', { rfq_id: id });
        await rfqModel.delete('tbl_rfq_product_files', { rfq_product_id: id });

        await rfqModel.delete('tbl_rfq_draft_sheets', { rfq_id: id });

        // Delete tech evaluations and associated data
        const techEvaluationCondition = { rfq_id: id };
        const techEvaluationDeletedRecordsIds =
          await rfqModel.deleteWithReturnIds(
            'tbl_rfq_product_tech_evaluation',
            techEvaluationCondition,
            t
          );

        let techEvalClauseFilesId = [];

        if (
          Array.isArray(techEvaluationDeletedRecordsIds) &&
          techEvaluationDeletedRecordsIds.length > 0
        ) {
          for (const evaluationClauseId of techEvaluationDeletedRecordsIds) {
            const clauseCondition = {
              tbl_rfq_product_tech_evaluation_id: evaluationClauseId
            };

            const clauseFiles = await rfqModel.deleteWithReturnIds(
              'tbl_rfq_product_tech_evaluation_clauses',
              clauseCondition,
              t
            );

            if (Array.isArray(clauseFiles) && clauseFiles.length > 0) {
              techEvalClauseFilesId.push(...clauseFiles);
            }
          }
        }

        // Delete clause files
        if (techEvalClauseFilesId.length > 0) {
          for (const techEvalClauseFileId of techEvalClauseFilesId) {
            const clauseFileCondition = {
              tbl_rfq_product_tech_evaluation_clauses_id: techEvalClauseFileId
            };

            await rfqModel.delete(
              'tbl_rfq_product_tech_evaluation_clauses_files',
              clauseFileCondition,
              t
            );
          }
        }

        // Delete terms and conditions
        await rfqModel.delete('tbl_rfq_terms_map', { rfq_id: id }, t);

        return res.status(200).json({
          status: 1,
          message: 'RFQ draft and all associated records deleted successfully'
        });
      });
    } catch (error) {
      logError('Error deleting RFQ draft', error);
      logError('Error deleting RFQ draft:', error);
      return res.status(500).json({
        status: 3,
        message: 'An error occurred while deleting the RFQ draft'
      });
    }
  },

  getVendorQuoteStatus : async (req, res) => {
    try {
      const { rfq_id} = req.params;
      const user_id = req.user.id;
      const response = await rfqModel.findAll("tbl_quote_activity", {rfq_id});
      const rfqClosed = await rfqModel.checkIfExists('tbl_rfq', `id = ${rfq_id}  AND status = 2`);

      
      res.status(200).json({
        status: 1,
        data:  response || [],
        rfqClosed: rfqClosed && rfqClosed.length > 0 ? true : false
      });
    }
    catch(error)
    {
      logError('getVendorQuoteStatus error', error)
    }
    },

  getRFQDraftData: async (req, res) => {
    try {
      // Changes by Agnij 2025-06-17 [Modified to use create-fresh-draft query parameter]
      const createFreshDraft = req.query.fresh === 'true';

      if (createFreshDraft) {
        // Return empty draft data structure
        return res.status(200).json({
          status: 1,
          data: {
            rfq_id: null,
            rfq_no: null,
            rfq_form_data: {
              is_published: 0,
              comment: '',
              response_email: '',
              contact_name: '',
              contact_number: '',
              company_name: '',
              bid_end_date: '',
              rfq_type: '',
              reverse_auction: 0,
              ra_start_date: null,
              ra_end_date: null,
              project_id: null,
              location: '',
              terms: [],
              term_and_condition_files: []
            },
            rfq_products: []
          }
        });
      }

      // Original behavior - get existing draft
      const rfqList = await rfqModel.findAll('tbl_rfq', {
        is_published: 0,
        created_by: req.user.id
      });

      if (!rfqList.length) {
        return res
          .status(204)
          .json({ status: 2, message: 'Draft RFQ doesnot exist' });
      }

      const rfqData = rfqList[0];
      const id = rfqData.id;

      const rfqItem = await rfqModel.getRfqDraftById(id);

      res.status(200).json({
        status: 1,
        data: rfqItem.length > 0 ? rfqItem[0] : rfqItem
      });
    } catch (error) {
      logError('Error fetching RFQ creation data', error);
      res.status(500).json({
        status: 3,
        message: 'An error occurred while fetching RFQ draft data'
      });
    }
  },

  // Changes by Agnij 2025-05-24 [Added method to get all draft RFQs]
  getDraftRFQs: async (req, res) => {
    try {
      const user_id = req.user.id;

      const page = parseInt(req.body.page) || 1;
      const limit = parseInt(req.body.limit) || 10;
      const offset = (page - 1) * limit;
      const project_id = req.body.project_id || -1;
      const sort = req.body.sort || 'DESC';
      const reverse_auction = req.body.reverse_auction || '-1';
      const rfq_type = req.body.rfq_type || '';
      const rfq_no = req.body.search_val || req.body.rfq_no || null;
      const hotel_ids = req.body.hotel_ids || [];

      const result = await rfqModel.getAllDraftRfqs(
        limit,
        offset,
        user_id,
        project_id,
        sort,
        reverse_auction,
        rfq_type,
        rfq_no,
        hotel_ids
      );

      res.status(200).json({
        status: 1,
        data: result.data,
        total_items: parseInt(result.total_count)
      });
    } catch (error) {
      logError('Error fetching draft RFQs:', error);
      res.status(500).json({
        status: 3,
        message: 'An error occurred while fetching draft RFQs'
      });
    }
  },

  getProcessingRFQs: async (req, res) => {
    try {
      const user_id = req.user.id;

      const page = parseInt(req.body.page) || 1;
      const limit = parseInt(req.body.limit) || 10;
      const offset = (page - 1) * limit;
      const sort = req.body.sort || 'DESC';

      const result = await rfqModel.getAllProcessingRfqs(
        limit,
        offset,
        user_id,
        sort
      );

      res.status(200).json({
        status: 1,
        data: result.data,
        total_items: parseInt(result.total_count)
      });
    } catch (error) {
      logError('Error fetching processing RFQs:', error);
      res.status(500).json({
        status: 3,
        message: 'An error occurred while fetching processing RFQs'
      });
    }
  },

  // Changes by Agnij 2025-05-24 [Updated method to get a specific draft RFQ by ID with debug logs]
  // Changes by Agnij 2025-06-17 [Fixed draft RFQ retrieval issue]
  getDraftById: async (req, res) => {
    try {
      const { id } = req.params;
      const { sheetId } = req.query;
      const user_id = req.user.id;

      let sheetData = null;
      const sheets = await rfqModel.getSheetsForDraftRfq(id, null, sheetId);

      if (sheets) {
        sheetData = sheets[0];
      }

      if (sheetData && !sheetData.is_processed) {
        try {
          const [, processedData] =
            await rfqController.processRfqDraftSheetWise(
              null,
              req.user,
              id,
              sheetId
            );
          await saveMagicSearchInDraft(
            processedData,
            user_id,
            null,
            id,
            sheetId
          );
        } catch (error) {
          logError('getDraftById: failed to process sheet data', error);
          return res.status(500).json({
            status: 0,
            success: false,
            message: 'Failed to process sheet data. Please try again.',
            sheets
          });
        }
      }

      const draftData = await rfqModel.getRfqDraftById(id, sheetData);

      if (!draftData || draftData.length === 0) {
        return res.status(404).json({
          status: 2,
          message: 'Draft RFQ details not found'
        });
      }

      if (draftData[0].rfq_form_data.is_published !== 0) {
        return res.status(403).json({
          status: 2,
          message: 'This is not a draft RFQ'
        });
      }

      const isMagicRfq = draftData[0].rfq_form_data.rfq_added_from === 'magic';

      if (
        isMagicRfq &&
        (!draftData[0].sheets || draftData[0].sheets.length === 0)
      ) {
        const sheets = await rfqModel.getSheetsForDraftRfq(id);
        if (sheets && sheets.length > 0) {
          draftData[0].sheets = sheets;
        }
      }

      //  fetch rfq mapped hotels, create and assign the mapped hotels in draftData.mappedHotels
       const mappedHotels = await rfqModel.checkIfExists('tbl_rfq_hotel_mappings', `rfq_id = ${id}`);
       draftData[0].mappedHotels = mappedHotels || [];

      // bid_end_date is text NOT NULL in the DB; the auto-create path stores
      // an empty string when the user hasn't picked a date yet. Surface that
      // as null to the client so the wizard's date input renders as unset
      // rather than as the literal empty string.
      if (draftData[0].rfq_form_data && draftData[0].rfq_form_data.bid_end_date === '') {
        draftData[0].rfq_form_data.bid_end_date = null;
      }

      // Return in the same format as getRFQDraftData
      res.status(200).json({
        status: 1,
        data: draftData[0]
      });
    } catch (error) {
      // Changes by Agnij 2025-05-24 [Fixed error handling to properly use logError]
      const err = new Error('Error fetching draft RFQ by ID');
      err.original = error;
      logError(err);

      res.status(500).json({
        status: 3,
        message: 'An error occurred while fetching the draft RFQ'
      });
    }
  },

  getDraftProductVendors: async (req, res) => {
    try {
      const { draftId } = req.params;
      const { rfqProductId } = req.query;
      const buyerId = req.user.id;

      if (!validateNumber(rfqProductId))
        return res.status(400).json({
          status: 2,
          message: '`rfqProductId` is required to fetch vendors.'
        });

      const draftData = rfqModel.checkIfExists(
        'tbl_rfq',
        `id = ${draftId} AND is_published = 0`
      );
      if (!draftData || draftData.length <= 0)
        return res.status(400).json({
          status: 2,
          message: 'Draft either does not exist or is already published.'
        });

      const filters = generalModel.generateFilters(
        req.body,
        VENDORS_FILTER_KEYS
      );

      const vendors = await rfqModel.getDraftProductVendors(
        draftId,
        rfqProductId,
        buyerId,
        filters
      );

      return res.json({
        status: 1,
        message: `Vendors fetched for ${rfqProductId}`,
        data: vendors ?? []
      });
    } catch (error) {
      const err = new Error('Error fetching vendors');
      err.original = error;
      logError(err);

      res.status(500).json({
        status: 3,
        message:
          'An error occurred while fetching the vendors for this product.'
      });
    }
  },

  createOrUpdateRfqDraftWithProductVendors: async (req, res) => {
    try {
      const user_id = req.user.id;

      const user = await userModel.userinfo(user_id);
      if (!user) {
        return res.status(404).json({ status: 2, message: 'User not found' });
      }

      let rfq_id;
      let rfqData;
      let sheetData;
      let isNew = false;

      const sheet_id = req.body.sheet_id;
      const variant_id = req.body.variant_id;
      const is_tender = req.body.is_tender || 0;
      const hotel_ids = req.body.hotel_ids || [];
      const globalFilters = req.body.filters;

      // Changes by Agnij 2025-06-17 [Improved handling of specific RFQ ID]
      // If rfq_id is provided in request, use that specific ID instead of creating a new draft
      if (req.body.rfq_id) {
        const specificRfq = await rfqModel.findOne('tbl_rfq', {
          id: req.body.rfq_id,
          created_by: user_id,
          is_published: 0
        });

        if (!specificRfq) {
          return res.status(404).json({
            status: 2,
            message: 'Specified draft RFQ not found or not authorized'
          });
        }

        rfqData = specificRfq;
        rfq_id = specificRfq.id;

        const sheetRes = await rfqModel.findOne('tbl_rfq_draft_sheets', {
          id: sheet_id,
          rfq_id
        });

        sheetData = sheetRes || null;
      } else {
        // Create a new RFQ
        // bid_end_date is text NOT NULL on tbl_rfq, but the user hasn't
        // reached the timeline step yet — so we seed an empty string (which
        // satisfies NOT NULL on a text column) and let the user fill the
        // real value when they save. The GET handler normalises this empty
        // string to null in the response so the frontend sees an unset
        // field. The save-draft Joi schema then rejects empty values.
        rfqData = {
          company_name: user.organization_name || '',
          response_email: user.email,
          contact_name: user.name,
          contact_number: user.mobile || '',
          comment: req.body.comment || '',
          bid_end_date: req.body.bid_end_date || '',
          location: req.body.location || '',
          is_published: 0,
          created_by: user_id,
          updated_by: user_id,
          status: 1,
          is_tender: is_tender,
        };

        const nextRFQNumber = await getNextRfQNumber();
        rfqData.rfq_no = nextRFQNumber;

        const response = await rfqModel.insert('tbl_rfq', rfqData);
        rfq_id = response[0].id;
        isNew = true;

        const rfqTerms = [];
        for (let i = 1; i < 9; i++) {
          rfqTerms.push({ rfq_id, terms_id: i });
        }
        await rfqModel.insertArray(
          rfqTerms,
          ['rfq_id', 'terms_id'],
          'tbl_rfq_terms_map'
        );
      }

      // Add products to the RFQ
      const product = req.body;
      if (!product || !product.variant_id) {
        return res
          .status(400)
          .json({ status: 2, message: 'Invalid product data' });
      }


        // Changes by Agnij [Use reconcileRFQHotels to properly sync hotels for both new and existing drafts]
        // This ensures hotels are added/updated correctly when adding products to draft
        if (hotel_ids && hotel_ids.length > 0) {
          await hospitalityModel.reconcileRFQHotels(rfq_id, hotel_ids, user_id);
        }


      let vendorsList = [];
      // ---------------- Determine vendor source ----------------
      // Auto-add all eligible vendors for both tenders and RFQs
      // Products without vendors are allowed (will be flagged in the UI)
      if (!product.vendors || !Array.isArray(product.vendors) || product.vendors.length === 0) {
        vendorsList = await hospitalityModel.getEligibleVendorsForVariant(
          variant_id,
          hotel_ids
        );
        if (vendorsList && vendorsList.length > 0) {
          product.vendors = vendorsList.map((vendor) => ({
            vendor_id: vendor.id || vendor.vendor_id,
          }));
        } else {
          product.vendors = [];
        }
      }

      const variant = await rfqModel.getNextVariant(rfq_id, product.variant_id);

      const productData = {
        rfq_id,
        product_variant_id: product.variant_id,
        variant: variant,
        comment: '',
        datasheet: '',
        spec_file: '',
        qap_file: '',
        qap: '',
        datasheet_file: '',
        sheet_id
      };

      await rfqModel.insert('tbl_rfq_products', productData);

      const vendorPromises = product.vendors.map(async (vendor) => {
        const vendorData = {
          rfq_id,
          product_variant_id: product.variant_id,
          user_id: vendor.vendor_id,
          variant: variant,
          sheet_id
        };
        return await rfqModel.insert('tbl_rfq_product_vendors', vendorData);
      });

      await Promise.all(vendorPromises);

      if (product?.specs && typeof product.specs == 'object') {
        for (const [key, value] of Object.entries(product.specs)) {
          const specData = {
            title: key,
            value,
            rfq_id,
            product_variant_id: product.variant_id,
            variant: variant,
            sheet_id
          };

          await rfqModel.insert('tbl_rfq_products_specs', specData);
        }
      }



      //Add global filters to sheet data (skip gracefully if missing)
      if (globalFilters && typeof globalFilters === "object") {
        const extractors = {
          country: (v) => v.map((x) => x.id),
          state: (v) => v.map((x) => x.id),
          city: (v) => v.map((x) => x.id),

          approved_by_id: (v) => v.map((x) => x.id),

          vendorType: (v) => v.map((x) => x.value),    // store "branch" only
          productMakes: (v) => v,                      // store string array as-is

          category_id: (v) => v,                       // direct ID
          search_key: (v) => v,
          vendor_name: (v) => v,
          include_variants: (v) => v,

          myVendorType: (v) => v,
          prevWorkedWith: (v) => v,
          // store object as JSON
        };


        logger.debug({ globalFilters }, 'createOrUpdateRfqDraftWithProductVendors: checking global filters');
        for (const [key, rawValue] of Object.entries(globalFilters)) {
          if (rawValue === null || rawValue === "" || rawValue?.length === 0) continue;

          const extractor = extractors[key];
          if (!extractor) continue; // skip unknown fields

          const extracted = extractor(rawValue);

          logger.debug({ key, extracted }, 'Extracted filter');

          // Handle arrays → multiple inserts
          const values = Array.isArray(extracted) ? extracted : [extracted];

          for (const val of values) {
            if (val === null || val === "" || val === undefined) continue;

            const filterData = {
              variant_id,
              rfq_id,
              type: key,
              value: val,
              user_id: req.user.id,
            };
            await rfqModel.insert("tbl_rfq_filters", filterData);
          }
        }
      }
      res.status(200).json({
        status: 1,
        message: 'RFQ draft created/updated successfully',
        data: {
          rfq_id,
          isNew
        }
      });
    } catch (error) {
      logError('Error while creating or updating RFQ with products:', error);
      res.status(500).json({
        status: 3,
        message: 'An error occurred while processing your request'
      });
    }
  },

  // Recommended products for the Start RFQ wizard.
  // Combines: user history + staged-variant category similarity + popularity,
  // filtered by vendor availability for the selected hotels.
  getRecommendedProducts: async (req, res) => {
    try {
      const user_id = req.user.id;
      const hotel_ids = Array.isArray(req.body.hotel_ids) ? req.body.hotel_ids : [];
      const staged_variant_ids = Array.isArray(req.body.variant_ids)
        ? req.body.variant_ids.map((v) => parseInt(v)).filter((n) => !isNaN(n))
        : [];
      const limit = parseInt(req.body.limit) || 4;

      if (hotel_ids.length === 0) {
        return res.status(200).json({ status: 1, data: [] });
      }

      const data = await rfqModel.getRecommendedProducts({
        user_id,
        hotel_ids,
        staged_variant_ids,
        limit,
      });

      return res.status(200).json({ status: 1, data });
    } catch (error) {
      logError('Error in getRecommendedProducts:', error);
      return res.status(500).json({
        status: 3,
        message: 'Failed to fetch recommendations',
      });
    }
  },

  // Bulk variant of createOrUpdateRfqDraftWithProductVendors —
  // creates a draft (or appends to an existing one) and adds an array
  // of products to it in one round-trip. Frontend uses this when the
  // user has staged multiple products and clicks "Create Draft".
  createOrUpdateRfqDraftWithBulkProducts: async (req, res) => {
    try {
      const user_id = req.user.id;
      const user = await userModel.userinfo(user_id);
      if (!user) {
        return res.status(404).json({ status: 2, message: 'User not found' });
      }

      const is_tender = req.body.is_tender || 0;
      const hotel_ids = req.body.hotel_ids || [];
      const variants = Array.isArray(req.body.variants) ? req.body.variants : [];

      if (variants.length === 0) {
        return res.status(400).json({ status: 2, message: 'No products provided' });
      }
      if (!hotel_ids.length) {
        return res.status(400).json({ status: 2, message: 'At least one business unit is required' });
      }

      let rfq_id;
      let rfqData;
      let isNew = false;

      // Use existing draft if rfq_id provided, otherwise create new
      if (req.body.rfq_id) {
        const specificRfq = await rfqModel.findOne('tbl_rfq', {
          id: req.body.rfq_id,
          created_by: user_id,
          is_published: 0,
        });
        if (!specificRfq) {
          return res.status(404).json({
            status: 2,
            message: 'Specified draft not found or not authorized',
          });
        }
        rfqData = specificRfq;
        rfq_id = specificRfq.id;
      } else {
        const currentDate = new Date();
        const bidEndDate = new Date();
        bidEndDate.setDate(currentDate.getDate() + 30);

        rfqData = {
          company_name: user.organization_name || '',
          response_email: user.email,
          contact_name: user.name,
          contact_number: user.mobile || '',
          comment: '',
          bid_end_date: bidEndDate.toISOString().split('T')[0] + 'T00:00:00',
          location: '',
          is_published: 0,
          created_by: user_id,
          updated_by: user_id,
          status: 1,
          is_tender,
        };

        const nextRFQNumber = await getNextRfQNumber();
        rfqData.rfq_no = nextRFQNumber;

        const response = await rfqModel.insert('tbl_rfq', rfqData);
        rfq_id = response[0].id;
        isNew = true;

        const rfqTerms = [];
        for (let i = 1; i < 9; i++) {
          rfqTerms.push({ rfq_id, terms_id: i });
        }
        await rfqModel.insertArray(
          rfqTerms,
          ['rfq_id', 'terms_id'],
          'tbl_rfq_terms_map'
        );
      }

      // Sync hotel mappings (works for both new and existing drafts)
      await hospitalityModel.reconcileRFQHotels(rfq_id, hotel_ids, user_id);

      // Pre-resolve eligible vendors per unique variant once to avoid
      // re-querying for the same variant when added multiple times.
      const variantVendorCache = new Map();

      let added_count = 0;
      const failed = [];

      for (const v of variants) {
        const variant_id = v.variant_id;
        if (!variant_id) {
          failed.push({ variant_id: null, reason: 'Missing variant_id' });
          continue;
        }

        try {
          // Get eligible vendors (cached per variant_id)
          let vendorList = variantVendorCache.get(variant_id);
          if (!vendorList) {
            vendorList = await hospitalityModel.getEligibleVendorsForVariant(
              variant_id,
              hotel_ids
            ) || [];
            variantVendorCache.set(variant_id, vendorList);
          }

          const variantNum = await rfqModel.getNextVariant(rfq_id, variant_id);

          await rfqModel.insert('tbl_rfq_products', {
            rfq_id,
            product_variant_id: variant_id,
            variant: variantNum,
            comment: '',
            datasheet: '',
            spec_file: '',
            qap_file: '',
            qap: '',
            datasheet_file: '',
            sheet_id: null,
          });

          for (const vendor of vendorList) {
            await rfqModel.insert('tbl_rfq_product_vendors', {
              rfq_id,
              product_variant_id: variant_id,
              user_id: vendor.id || vendor.vendor_id,
              variant: variantNum,
              sheet_id: null,
            });
          }

          added_count++;
        } catch (err) {
          logError(`Error adding variant ${variant_id} to draft:`, err);
          failed.push({ variant_id, reason: err?.message || 'Failed' });
        }
      }

      return res.status(200).json({
        status: 1,
        message: 'Products added to draft successfully',
        data: {
          rfq_id,
          isNew,
          added_count,
          failed,
        },
      });
    } catch (error) {
      logError('Error in createOrUpdateRfqDraftWithBulkProducts:', error);
      return res.status(500).json({
        status: 3,
        message: 'An error occurred while processing your request',
      });
    }
  },

  fetchRfqFilters : async (req, res) => {
    try {
      const { rfq_id } = req.params;
      const filters =  await rfqModel.findAll('tbl_rfq_filters', {rfq_id});
      res.status(200).json({
        status: 1,
        message: 'RFQ filters fetched successfully',
        data: filters
      });
    } catch (error) {
      logError('Error while fetching RFQ filters:', error);
      res.status(500).json({
        status: 3,
        message: 'An error occurred while processing your request'
      });
    }
  },
  addProductVendorsInEditRfq: async (req, res) => {
    try {
      // Add products to the RFQ
      const product = req.body;
      const rfq_id = product.rfq_id || product.rfqId;
      const specs = product.specs;

      if (!product || !product.variant_id) {
        return res
          .status(400)
          .json({ status: 2, message: 'Invalid product data' });
      }

      // Determine vendors: use explicit array if provided, otherwise auto-map
      let vendorIds = Array.isArray(product.vendors) && product.vendors.length > 0
        ? product.vendors
        : [];
      let autoMapped = false;
      let vendor_count = vendorIds.length;

      if (vendorIds.length === 0) {
        // Auto-map vendors via hotel eligibility
        let hotel_ids = product.hotel_ids || [];

        // Fall back to tbl_rfq_hotel_mappings if hotel_ids not provided
        if (!hotel_ids.length) {
          const hotelMappings = await db.any(
            `SELECT hotel_id FROM tbl_rfq_hotel_mappings WHERE rfq_id = $1`,
            [rfq_id]
          );
          hotel_ids = hotelMappings.map(h => h.hotel_id);
        }

        if (hotel_ids.length > 0) {
          const eligibleVendors = await hospitalityModel.getEligibleVendorsForVariant(
            product.variant_id,
            hotel_ids
          );
          vendorIds = eligibleVendors.map(v => v.vendor_id);
        }

        autoMapped = true;
        vendor_count = vendorIds.length;

        // For tenders, require at least one vendor
        const is_tender = product.is_tender !== undefined
          ? product.is_tender
          : null;

        if (is_tender === null) {
          // Look up from DB
          const rfqRecord = await db.oneOrNone(
            `SELECT is_tender FROM tbl_rfq WHERE id = $1`,
            [rfq_id]
          );
          if (rfqRecord) {
            product.is_tender = rfqRecord.is_tender;
          }
        }

        if (product.is_tender === 1 && vendorIds.length === 0) {
          return res.status(400).json({
            status: 2,
            message: 'No eligible vendors found for this product variant with the selected hotels. Please check vendor subscriptions.'
          });
        }
      }

      const variant = await rfqModel.getNextVariant(rfq_id, product.variant_id);

      const productData = {
        rfq_id,
        product_variant_id: product.variant_id,
        variant,
        comment: '',
        datasheet: '',
        spec_file: '',
        qap_file: '',
        qap: '',
        datasheet_file: ''
      };

      let addedRfqProduct = await rfqModel.insert(
        'tbl_rfq_products',
        productData
      );

      if (!addedRfqProduct || !addedRfqProduct.length > 0) {
        return res.status(400).json({
          status: 3,
          message: 'Something want wrong, please try again!'
        });
      }

      addedRfqProduct = addedRfqProduct[0];

      if (specs && specs.Quantity && specs.Unit) {
        Object.entries(specs).forEach(async ([title, value]) => {
          const specsData = {
            rfq_id,
            product_variant_id: product.variant_id,
            variant,
            title: title,
            value: value
          };

          await rfqModel.insert('tbl_rfq_products_specs', specsData);
        });
      }

      if (vendorIds.length > 0) {
        const vendorPromises = vendorIds.map(async (vendor) => {
          const vendorData = {
            rfq_id,
            product_variant_id: product.variant_id,
            user_id: vendor,
            variant: variant
          };
          return await rfqModel.insert('tbl_rfq_product_vendors', vendorData);
        });

        await Promise.all(vendorPromises);
      }

      res.status(200).json({
        status: 1,
        message: autoMapped
          ? `Product added with ${vendor_count} auto-mapped vendor(s)`
          : 'Product and Vendors added successfully!',
        rfqProductId: addedRfqProduct?.id ?? -1,
        rfq_id,
        vendor_count
      });
    } catch (error) {
      logError('Error while adding Product and Vendors', error);
      res.status(500).json({
        status: 3,
        message: 'An error occurred while processing your request'
      });
    }
  },

  removeVendorFromDraft: async (req, res) => {
    const { rfq_id, product_id, variant, vendor_ids } = req.body;

    if (
      !rfq_id ||
      !product_id ||
      !variant ||
      !vendor_ids ||
      vendor_ids.length == 0
    ) {
      return res
        .status(400)
        .json({ status: 3, message: 'Missing required fields.' });
    }

    try {
      const conditions = {
        rfq_id: rfq_id,
        product_variant_id: product_id,
        user_ids: vendor_ids,
        variant: variant
      };

      const result = await rfqModel.delete(
        'tbl_rfq_product_vendors',
        conditions
      );

      if (result.length > 0) {
        return res
          .status(200)
          .json({
            status: 1,
            message: 'Vendor removed successfully.',
            deletedRows: result
          });
      } else {
        return res
          .status(404)
          .json({ status: 3, message: 'No matching record found to delete.' });
      }
    } catch (error) {
      logError('Error removing vendor from draft:', error);
      return res
        .status(500)
        .json({ status: 3, message: 'Internal server error.' });
    }
  },

  refreshVendors: async (req, res) => {
    try {
      const { rfq_id, preview } = req.body;
      if (!rfq_id) {
        return res.status(400).json({ status: 0, message: 'rfq_id is required' });
      }

      const rfqRecord = await db.oneOrNone(
        `SELECT id, is_published FROM tbl_rfq WHERE id = $1`,
        [rfq_id]
      );
      if (!rfqRecord) {
        return res.status(404).json({ status: 2, message: 'RFQ not found' });
      }

      const hotelMappings = await db.any(
        `SELECT hotel_id FROM tbl_rfq_hotel_mappings WHERE rfq_id = $1`,
        [rfq_id]
      );
      const hotel_ids = hotelMappings.map(h => h.hotel_id);

      if (hotel_ids.length === 0) {
        return res.status(400).json({ status: 0, message: 'No business units mapped to this RFQ. Please select business units first.' });
      }

      const result = await hospitalityModel.addMissingVendorsForRfq(rfq_id, hotel_ids, { preview: !!preview });

      if (preview) {
        return res.status(200).json({
          status: 1,
          data: { totalAvailable: result.uniqueVendorCount }
        });
      }

      return res.status(200).json({
        status: 1,
        message: result.totalAdded > 0
          ? `Added ${result.totalAdded} missing vendor(s) across products`
          : 'All products already have all eligible vendors',
        data: result
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({ status: 3, message: 'Failed to refresh vendors' });
    }
  },

  getRfqDetailsById: async (req, res) => {
    try {
      const { rfq_id } = req.body;

      const result = await rfqModel.getRFQDetails(rfq_id);
      if (result && result[0] && req.user && req.user.user_type == 3 && result[0].is_tender === 1 && result[0].tender_fees > 0) {
        const paymentRow = await db.oneOrNone(
          `SELECT payment_status FROM tbl_vendor_payments 
           WHERE vendor_id = $1 AND rfq_id = $2 AND payment_type = 'tender'
           ORDER BY id DESC LIMIT 1`,
          [req.user.id, rfq_id]
        );
        result[0].has_paid_tender_fees = paymentRow?.payment_status === 'success';
      }
      res
        .status(200)
        .json({
          status: 1,
          data: result[0]
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: error.message
        })
        .end();
    }
  },

  getTerms: async (req, res, next) => {
    try {
      const result = await rfqModel.getAllTerms();
      res
        .status(200)
        .json({
          status: 1,
          data: result
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  // Render the RFQ's custom Terms & Conditions (rich HTML stored on tbl_rfq.comment)
  // as a downloadable PDF. Uses Puppeteer — same engine the ARC PDF flow uses — so
  // output matches what users see in the on-screen WYSIWYG preview.
  downloadRfqTermsPdf: async (req, res, next) => {
    let browser = null;
    try {
      const rfq_id = parseInt(req.query.rfq_id, 10);
      if (!Number.isFinite(rfq_id) || rfq_id <= 0) {
        return res.status(400).json({ status: 0, message: 'rfq_id is required' });
      }

      const rfq = await rfqModel.getRfqTermsForPdf(rfq_id);
      if (!rfq) {
        return res.status(404).json({ status: 2, message: 'RFQ not found' });
      }

      const commentHtml = (rfq.comment || '').toString();
      const plainText = commentHtml.replace(/<[^>]*>/g, '').trim();
      if (!plainText) {
        return res.status(404).json({ status: 2, message: 'No Terms & Conditions to download for this RFQ' });
      }

      const entityLabel = Number(rfq.is_tender) === 1 ? 'Tender' : 'RFQ';
      const escapeHtml = (str) => String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Terms &amp; Conditions - ${escapeHtml(rfq.rfq_no)}</title>
  <style>
    @page { margin: 18mm 16mm; }
    body { font-family: 'Helvetica', 'Arial', sans-serif; color: #1a2730; font-size: 12pt; line-height: 1.55; margin: 0; }
    .doc-header { border-bottom: 2px solid #1a2730; padding-bottom: 10px; margin-bottom: 18px; }
    .doc-title { font-size: 18pt; font-weight: 700; margin: 0 0 4px 0; }
    .doc-meta { font-size: 10pt; color: #54616e; }
    .doc-meta span { margin-right: 14px; }
    .doc-body { font-size: 12pt; }
    .doc-body p { margin: 0 0 10px 0; }
    .doc-body ul, .doc-body ol { margin: 0 0 10px 22px; padding: 0; }
    .doc-body li { margin-bottom: 4px; }
    .doc-body table { border-collapse: collapse; width: 100%; margin: 10px 0; }
    .doc-body th, .doc-body td { border: 1px solid #cdd3da; padding: 6px 8px; text-align: left; }
    .doc-body img { max-width: 100%; height: auto; }
    .doc-body h1, .doc-body h2, .doc-body h3, .doc-body h4 { margin: 14px 0 8px 0; }
  </style>
</head>
<body>
  <div class="doc-header">
    <div class="doc-title">Terms &amp; Conditions</div>
    <div class="doc-meta">
      <span><strong>${escapeHtml(entityLabel)} No:</strong> ${escapeHtml(rfq.rfq_no)}</span>
      ${rfq.title ? `<span><strong>Title:</strong> ${escapeHtml(rfq.title)}</span>` : ''}
    </div>
  </div>
  <div class="doc-body">${commentHtml}</div>
</body>
</html>`;

      browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        headless: true,
      });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
      });
      await browser.close();
      browser = null;

      const safeRfqNo = String(rfq.rfq_no || rfq_id).replace(/[^A-Za-z0-9_-]/g, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="terms-and-conditions-${safeRfqNo}.pdf"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      return res.status(200).end(pdfBuffer);
    } catch (error) {
      logError(error);
      if (browser) {
        try { await browser.close(); } catch (_) { /* swallow */ }
      }
      return res.status(400).json({ status: 3, message: Config.errorText.value });
    }
  },

  getUnits: async (req, res, next) => {
    try {
      const result = await rfqModel.getAvailableUnits();
      res
        .status(200)
        .json({
          status: 1,
          data: result
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  getRfqReport: async (req, res, next) => {
    let user_id = req.user.id;
    /* if (req.body.user_id) {
      user_id = req.body.user_id;
    } */
    try {
      let page, limit, offset;
      if (req.body.page && req.body.page > 0) {
        page = req.body.page;
        limit = req.body.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      const { month, year } = req.body;

      const rfq = await rfqModel.getAllRfqBuyer(
        limit,
        offset,
        user_id,
        month,
        year
      );

      const councellorssCountArr = await Promise.all(
        rfq.map((ele) => {
          logger.debug({ ele }, 'processing RFQ element');
          if (Object.keys(ele.quotations).length > 0) {
            ele.quote_received = ele.quotations.length;
          } else {
            ele.quote_received = 0;
          }

          if (Object.keys(ele.finilize).length > 0) {
            ele.finilize_status = 'Yes';
          } else {
            ele.finilize_status = 'No';
          }

          return {
            rfq
          };
        })
      );

      res
        .status(200)
        .json({
          status: 1,
          rfq: rfq
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  getRfqChartData: async (req, res, next) => {
    const user_id = req.user.id;
    const chartFilter = req.query.chart_filter || null;
    const project_id = req.query.project || null;

    try {
      const { startDate, endDate } = getDateRange(chartFilter);
      const rfq_data = await rfqModel.getRfqChartData(
        user_id,
        chartFilter,
        startDate,
        endDate,
        project_id
      );

      res
        .status(200)
        .json({
          status: 1,
          data: rfq_data
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  getRfqByUser: async (req, res, next) => {
    let user_id = req.user.id;
    if (req.body.user_id) {
      user_id = req.body.user_id;
    }
    try {
      let page,
        limit = req.body.limit || Config.globalAdminLimit,
        offset;
      if (req.body.page && req.body.page > 0) {
        page = req.body.page;
        offset = (page - 1) * limit;
      } else {
        offset = 0;
      }

      const allowedNegotiationFilters = ['active', 'ended'];
      const negotiation_filter = allowedNegotiationFilters.includes(req.body.negotiation_filter)
        ? req.body.negotiation_filter
        : null;

      // Server-side filters
      const filters = {
        search_val: req.body.search_val || null,
        quote_status: req.body.quote_status || null,
        rfq_status: req.body.rfq_status || null,
        bid_ends_in: req.body.bid_ends_in || null,
        hotel_ids: Array.isArray(req.body.hotel_ids) ? req.body.hotel_ids.filter(Boolean) : [],
        negotiation_filter,
      };

      const listRfq = await rfqModel.getRfqByUser(limit, offset, user_id, filters);
      const totalRFQ = await rfqModel.getVendorRfqCount(user_id, filters);

      // Stats for dashboard cards
      const stats = await rfqModel.getVendorRfqStats(user_id);

      res
        .status(200)
        .json({
          status: 1,
          data: listRfq,
          totalRFQ,
          stats,
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  getLifecycleSummary: async (req, res, next) => {
    try {
      const rfqId = parseInt(req.params.rfqId);
      const userId = req.user?.id || null;

      if (!rfqId || isNaN(rfqId)) {
        return res.status(200).json({ status: 0, message: 'Invalid RFQ ID' });
      }

      const data = await rfqModel.getLifecycleSummary(rfqId, userId);

      if (!data || !data.current_stage) {
        return res.status(200).json({ status: 2, message: 'RFQ not found or lifecycle not available' });
      }

      return res.status(200).json({ status: 1, data });
    } catch (err) {
      logError('getLifecycleSummary error', err);
      return res.status(200).json({ status: 3, message: 'Error fetching lifecycle summary' });
    }
  },

  // GET /rfq/:rfqId/lifecycle — ARC-style stage lifecycle for the single RFQ
  // workspace page. Shapes the existing getLifecycleSummary phases into 4
  // navigable stages + adds tender guard, draft handling, and RFQ-scoped perms.
  getRfqLifecycle: async (req, res) => {
    try {
      const rfqId = parseInt(req.params.rfqId, 10);
      const userId = req.user?.id || null;
      if (!rfqId || isNaN(rfqId)) {
        return res.status(200).json({ status: 0, message: 'Invalid RFQ ID' });
      }

      // Basic row first — for tender guard + draft handling + permission scope.
      const rfq = await db.oneOrNone(
        `SELECT id, rfq_no, title, status, is_published, is_tender, hotel_id,
                department_id, hospitality_company_id, created_by, bid_end_date,
                ra_start_date, ra_end_date
           FROM tbl_rfq WHERE id = $1`,
        [rfqId]
      );
      if (!rfq) return res.status(200).json({ status: 2, message: 'RFQ not found' });
      if (Number(rfq.is_tender) === 1) {
        return res.status(403).json({ status: 0, message: 'This is a tender — use the ARC flow' });
      }

      // RFQ-scoped permissions (mirror ARC getLifecycle: rbac returns rows).
      const RFQ_PERMISSION_RESOURCES = ['rfq', 'te', 'quote-compare', 'negotiation', 'awarding', 'po'];
      let permissions;
      if (Number(req.user?.user_type) === 8) {
        permissions = Object.fromEntries(RFQ_PERMISSION_RESOURCES.map((r) => [r, ['read', 'write', 'approve', 'admin']]));
      } else {
        permissions = Object.fromEntries(RFQ_PERMISSION_RESOURCES.map((r) => [r, []]));
        if (rfq.hotel_id != null) {
          const rows = await rbacModel
            .getUserPermissionsForHotels(userId, [rfq.hotel_id], null, rfq.department_id || null)
            .catch(() => []);
          for (const row of rows) {
            const resource = String(row.resource);
            if (permissions[resource]) permissions[resource].push(String(row.action));
          }
        }
      }

      // Draft (status 0 = not yet submitted) → redirectable shape so the shell
      // sends the buyer to the edit/create flow instead of the stage page.
      const summary = (Number(rfq.status) === 0)
        ? null
        : await rfqModel.getLifecycleSummary(rfqId, userId);
      if (!summary || !summary.current_stage) {
        return res.status(200).json({
          status: 1,
          data: { rfq: { ...rfq, status: 'draft' }, stages: [], default_stage: null, permissions },
        });
      }

      const shaped = shapeRfqLifecycle(summary, { permissions });
      return res.status(200).json({ status: 1, data: { ...shaped, rfq } });
    } catch (err) {
      logError('getRfqLifecycle error', err);
      return res.status(200).json({ status: 3, message: 'Error fetching RFQ lifecycle' });
    }
  },

  getRfqById: async (req, res, next) => {
    let id = req.params.id;
    const { user_type, id: user_id } = req.user;
    let { includeVendors = false } = req.query;

    if (includeVendors) {
      includeVendors = includeVendors == 'true';
    }

    try {
      if (req.user.user_type == 3) {
        // check if the vendor is responsible for this RFQ
        let availability = await rfqModel.checkVendorRFQResponsibility(
          id,
          req.user.id
        );
        if (availability.length > 0) {
          // Update is_rfq_viewed status for vendor when they view RFQ
          try {
            await rfqModel.updateWhere(
              'tbl_rfq_product_vendors',
              { is_rfq_viewed: 1 },
              `rfq_id = ${id} AND user_id = ${req.user.id} AND is_rfq_viewed = 0`
            );
          } catch (error) {
            logError('Error updating RFQ viewed status', error);
          }
        } else {
          res
            .status(200)
            .json({
              status: 1,
              data: []
            })
            .end();
          return;
        }
      }

      const rfQItem = await rfqModel.getRfqById(
        id,
        req.user.id,
        req.user.user_type,
        includeVendors
      );

      const rfqData = rfQItem && rfQItem.length > 0 ? rfQItem[0] : rfQItem;

      // RBAC check for non-vendor users: must have rfq.read/boq.read for this RFQ's business unit
      if (rfqData?.id && user_type != 3) {
        const resource = rfqData.is_tender == 1 ? 'boq' : 'rfq';
        const hasAccess = await db.oneOrNone(`
          SELECT 1 FROM tbl_user_role_scopes urs
          JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
          JOIN tbl_permissions p ON p.id = rp.permission_id
          WHERE urs.user_id = $1
            AND p.resource = $2
            AND p.action = 'read'
            AND urs.company_id = $3
            AND (urs.hotel_id IS NULL OR urs.hotel_id = $4)
            AND ($5::int IS NULL OR urs.department_id = $5 OR urs.department_id IS NULL)
          LIMIT 1
        `, [user_id, resource, rfqData.hospitality_company_id, rfqData.hotel_id, rfqData.department_id || null]);

        if (!hasAccess) {
          return res.status(403).json({ status: 0, message: 'You do not have permission to view this RFQ' });
        }
      }

      let lifecycleMap = {};
      if (rfqData?.id) {
        lifecycleMap = await rfqModel.computeLifecycleStages([parseInt(rfqData.id)]);
        rfqData.lifecycle_stage = lifecycleMap[parseInt(rfqData.id)] || null;
      }

      // Enrich with action holders (who can act at current lifecycle stage)
      if (rfqData?.id && rfqData.lifecycle_stage) {
        try {
          const actionHoldersMap = await rfqModel.getActionHoldersForRFQs([rfqData], lifecycleMap);
          rfqData.action_holders = actionHoldersMap[parseInt(rfqData.id)] || null;
        } catch (err) {
          logError('Error fetching action holders for RFQ detail', err);
          rfqData.action_holders = null;
        }
      }

      if (rfqData?.hotel_id) {
        const hotelIds = [parseInt(rfqData.hotel_id)];
        const deptId = rfqData.department_id ? parseInt(rfqData.department_id) : null;
        try {
          // Technical evaluators: scoped to BU + Department
          rfqData.technical_evaluators = await rbacModel.getUsersWithModuleActionsForHotels(
            hotelIds, 'te', ['read', 'create'], deptId
          );
        } catch (evaluatorError) {
          logError('Error fetching technical evaluators for RFQ detail', evaluatorError);
          rfqData.technical_evaluators = [];
        }
        try {
          // Commercial evaluators: scoped to BU only (no department)
          rfqData.commercial_evaluators = await rbacModel.getUsersWithModuleActionsForHotels(
            hotelIds, 'quote-compare', ['read', 'create'], null
          );
        } catch (err) {
          logError('Error fetching commercial evaluators for RFQ detail', err);
          rfqData.commercial_evaluators = [];
        }
        try {
          // PO initiators: scoped to BU only (no department)
          rfqData.po_initiators = await rbacModel.getUsersWithModuleActionsForHotels(
            hotelIds, 'awarding', ['read', 'create'], null
          );
        } catch (err) {
          logError('Error fetching PO initiators for RFQ detail', err);
          rfqData.po_initiators = [];
        }
      } else {
        rfqData.technical_evaluators = [];
        rfqData.commercial_evaluators = [];
        rfqData.po_initiators = [];
      }

      // Fetch PO rejections (vendor-rejected AND approver-rejected) for this
      // RFQ. Used by Quote Compare to surface why the vendor was de-finalized.
      // - rejection_type='vendor':   PO row status='rejected_by_vendor'.
      //   Reason from po.vendor_rejection_reason; rejected_by = the vendor.
      // - rejection_type='approver': PO row status='rejected'. Reason and
      //   rejecter pulled from the matching tbl_approval_actions REJECT row,
      //   joined via the PO's approval_instance_id.
      try {
        rfqData.vendor_rejections = await db.any(`
          SELECT
            rp.product_variant_id,
            rp.variant,
            po.finalized_vendor_id AS vendor_id,
            vu.name AS vendor_name,
            vu.organization_name AS vendor_organization,
            po.po_number,
            CASE
              WHEN po.status = 'rejected_by_vendor' THEN 'vendor'
              ELSE 'approver'
            END AS rejection_type,
            CASE
              WHEN po.status = 'rejected_by_vendor' THEN po.vendor_rejection_reason
              ELSE aa.comment
            END AS rejection_reason,
            CASE
              WHEN po.status = 'rejected_by_vendor' THEN po.vendor_action_at
              ELSE aa.created_at
            END AS rejected_at,
            CASE
              WHEN po.status = 'rejected_by_vendor' THEN vu.name
              ELSE au.name
            END AS rejected_by_name,
            CASE
              WHEN po.status = 'rejected_by_vendor' THEN NULL
              ELSE au.email
            END AS rejected_by_email
          FROM tbl_rfq_purchase_order po
          JOIN tbl_users vu ON vu.id = po.finalized_vendor_id
          JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
          JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
          LEFT JOIN LATERAL (
            SELECT a.approver_user_id, a.comment, a.created_at
            FROM tbl_approval_actions a
            WHERE a.approval_instance_id = po.approval_instance_id
              AND a.action = 'REJECT'
            ORDER BY a.created_at DESC
            LIMIT 1
          ) aa ON TRUE
          LEFT JOIN tbl_users au ON au.id = aa.approver_user_id
          WHERE po.rfq_id = $1
            AND po.status IN ('rejected_by_vendor', 'rejected')
            AND NOT EXISTS (
              SELECT 1 FROM tbl_quote_finalization qf
              WHERE qf.rfq_id = po.rfq_id
                AND qf.product_variant_id = rp.product_variant_id
                AND qf.variant = rp.variant
            )
          ORDER BY rejected_at DESC NULLS LAST
        `, [rfqData.id]);
      } catch (err) {
        logError('Error fetching PO rejections for RFQ', err);
        rfqData.vendor_rejections = [];
      }

      // Attach close reason when RFQ is closed
      if (rfqData && String(rfqData.status) === '2') {
        try {
          const closeEvent = await db.oneOrNone(
            `SELECT lh.remarks
               FROM tbl_lifecycle_history lh
              WHERE lh.entity_id = $1
                AND lh.entity_type IN ('RFQ', 'TENDER')
                AND lh.action = 'RFQ_CLOSED'
              ORDER BY lh.id DESC
              LIMIT 1`,
            [rfqData.id]
          );
          let rawComment = closeEvent?.remarks || null;
          if (rawComment) {
            rawComment = rawComment.replace(/^(RFQ|TENDER) closed by creator:\s*/i, '');
            rfqData.close_comment = `Reason: ${rawComment}`;
          } else {
            rfqData.close_comment = null;
          }
        } catch (closeErr) {
          logError('Error fetching close info for RFQ', closeErr);
          rfqData.close_comment = null;
        }
      }

      // Add tender payment status for vendor viewers (sourced from main query)
      if (rfqData && rfqData.is_tender === 1 && rfqData.tender_fees > 0 && req.user.user_type == 3) {
        rfqData.has_paid_tender_fees = rfqData.vendor_payment_status === 'success';
        delete rfqData.vendor_payment_status;
      }

      res
        .status(200)
        .json({
          status: 1,
          data: rfqData
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  getTargetPricehistory: async (req, res) => {
    try {
      const { rfq_product_id } = req.params;

      const result = await rfqModel.getPricehistory(rfq_product_id);

      // const query = `
      //   SELECT *
      //   FROM tbl_rfq_product_target_price
      //   WHERE tbl_rfq_product_id = $1
      //   ORDER BY created_at DESC
      // `;

      // const data = await db.query(query, [rfq_product_id]);

      if (result.length > 0) {
        return res.json({ status: 1, data: result });
      } else {
        return res.json({
          status: 0,
          message: 'No target price history found'
        });
      }
    } catch (error) {
      logError('Error fetching target price history', error);
      return res.status(500).json({
        status: 0,
        message: 'Internal server error',
        error: error.message
      });
    }
  },

  rfqList: async (req, res, next) => {
    try {
      let user_id = req.user.id;
      const { month, year } = req.body;

      let page, limit, offset;
      if (req.body.page && req.body.page > 0) {
        page = req.body.page;
        limit = req.body.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      const rfq = await rfqModel.getAllRfqBuyer(
        limit,
        offset,
        user_id,
        month,
        year
      );

      const councellorssCountArr = await Promise.all(
        rfq.map((ele) => {
          logger.debug({ ele }, 'processing RFQ element');
          if (Object.keys(ele.quotations).length > 0) {
            ele.quote_received = ele.quotations.length;
          } else {
            ele.quote_received = 0;
          }

          if (Object.keys(ele.finilize).length > 0) {
            ele.finilize_status = 'Yes';
          } else {
            ele.finilize_status = 'No';
          }

          return {
            rfq
          };
        })
      );

      if (req.query.download == 'true') {
        const workbook = new excelJS.Workbook();
        const worksheet = workbook.addWorksheet('Rfq');

        // Add headers
        worksheet.columns = [
          { header: 'S no.', key: 's_no', width: 5 },
          { header: 'RFQ No', key: 'rfq_no', width: 20 },
          { header: 'Quotation', key: 'quotation', width: 20 },
          // { header: 'Slug', key: 'slug', width: 20 },
          { header: 'RFQ Finalize', key: 'finalize', width: 20 }
        ];

        let counter = 1;

        rfq.forEach((prod) => {
          prod.s_no = counter;
          prod.rfq_no = prod.rfq_no != '' ? prod.rfq_no : '';
          prod.quotation = prod.quote_received != '' ? prod.quote_received : '';
          prod.finalize =
            prod.finilize_status != '' ? prod.finilize_status : '';
          worksheet.addRow(prod); // Add data in worksheet

          counter++;
        });

        // Making first line in excel bold
        worksheet.getRow(1).eachCell((cell) => {
          cell.font = { bold: true };
        });

        // Set content type and disposition
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader('Content-Disposition', 'attachment; filename=rfq.xlsx');

        // Write workbook to response
        workbook.xlsx.write(res).then(() => {
          res.end();
        });
      } else {
        res
          .status(200)
          .json({
            status: 1,
            data: rfq,
            total_count: rfq.length
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  getBuyerRfq: async (req, res, next) => {
    let user_id = req.user.id;
    try {
      let page, limit, offset;
      if (req.body.page && req.body.page > 0) {
        page = req.body.page;
        limit = req.body.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      let { project_id, sort, reverse_auction, rfq_type, rfq_no, search_val, is_tender, completed_status, hotel_ids } = req.body;
      // Support unified search_val (searches both title and rfq_no)
      if (search_val && !rfq_no) {
        rfq_no = search_val;
      }
      if (project_id == -1) {
        project_id = null;
      }
      if (rfq_type == '') {
        rfq_type = null;
      }
      if (reverse_auction == '-1') {
        reverse_auction = null;
      }
      if (is_tender === '' || is_tender === undefined || is_tender === null) {
        is_tender = null;
      } else {
        is_tender = is_tender === '1' || is_tender === 1 || is_tender === true ? 1 : 0;
      }
      // Normalize completed_status: 'completed', 'active', 'closed', or undefined (no filter)
      if (completed_status && !['completed', 'active', 'closed'].includes(completed_status)) {
        completed_status = undefined;
      }

      const listRfq = await rfqModel.getAllBuyerRfq(
        limit,
        offset,
        user_id,
        project_id,
        sort,
        reverse_auction,
        rfq_type,
        rfq_no,
        is_tender,
        completed_status,
        hotel_ids
      );

      let count = await rfqModel.getBuyerRfqCount(
        user_id,
        project_id,
        rfq_type,
        reverse_auction,
        rfq_no,
        is_tender,
        completed_status,
        hotel_ids
      );

      // Enrich with lifecycle stage
      let lifecycleMap = {};
      if (listRfq && listRfq.length > 0) {
        const rfqIds = listRfq.map(r => parseInt(r.id));
        lifecycleMap = await rfqModel.computeLifecycleStages(rfqIds);
        for (const rfq of listRfq) {
          rfq.lifecycle_stage = lifecycleMap[parseInt(rfq.id)] || null;
        }
      }

      // Enrich with action holders (who can act at current lifecycle stage)
      if (listRfq && listRfq.length > 0) {
        try {
          const actionHoldersMap = await rfqModel.getActionHoldersForRFQs(listRfq, lifecycleMap);
          for (const rfq of listRfq) {
            rfq.action_holders = actionHoldersMap[parseInt(rfq.id)] || null;
          }
        } catch (err) {
          logError('Error fetching action holders', err);
        }
      }

      res
        .status(200)
        .json({
          status: 1,
          data: listRfq,
          total_items: count
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  // ── Server-side faceted + paginated RFQ management listing (mirrors the
  //    rate-contracts /all listing). Fetches the buyer's scoped RFQs fresh,
  //    computes lifecycle buckets + facet counts + tab counts in-process, then
  //    returns ONE paginated page (default 20). The client renders exactly what
  //    the server returns — no local filtering. RFQ-only (tenders live in ARC).
  getRfqListView: async (req, res) => {
    const user_id = req.user.id;
    try {
      const body = req.body || {};
      const tab = ['all', 'drafts', 'ongoing', 'approved', 'closed'].includes(body.tab) ? body.tab : 'all';
      const search = (body.search || body.search_val || '').toString().trim() || null;
      const sort = ['recent', 'oldest', 'deadline'].includes(body.sort) ? body.sort : 'recent';
      const page = Number(body.page) > 0 ? Number(body.page) : 1;
      const limit = Number(body.limit) > 0 ? Math.min(Number(body.limit), 100) : 20;
      const f = body.filters || {};
      const asStrArr = (v) => (Array.isArray(v) ? v.map(String) : []);
      const filters = {
        status: asStrArr(f.status), buId: asStrArr(f.buId), categoryId: asStrArr(f.categoryId),
        departmentId: asStrArr(f.departmentId), productId: asStrArr(f.productId), vendorId: asStrArr(f.vendorId),
      };
      const hotel_ids = Array.isArray(body.hotel_ids) ? body.hotel_ids : undefined;

      // 1. Fetch the buyer's scoped RFQs (RFQ-only). Big cap so faceting is
      //    complete; search is pushed to SQL.
      const FETCH_CAP = 1000;
      const all = await rfqModel.getAllBuyerRfq(FETCH_CAP, 0, user_id, null, 'DESC', null, null, search, 0, undefined, hotel_ids);
      const rows = Array.isArray(all) ? all : [];

      // 2. Lifecycle stage → bucket + normalized status key.
      let lifecycleMap = {};
      if (rows.length > 0) lifecycleMap = await rfqModel.computeLifecycleStages(rows.map((r) => parseInt(r.id)));
      const STAGE_BUCKET = {
        RFQ_APPROVAL: 'drafts',
        AWAITING_QUOTES: 'ongoing', TECHNICAL_AWAITING_QUOTES: 'ongoing', TECHNICAL_EVALUATING: 'ongoing',
        TECHNICAL_APPROVING: 'ongoing', TECHNICAL_REJECTED: 'ongoing', RFQ_STUCK_TECHNICAL: 'ongoing',
        RFQ_STUCK_COMMERCIAL: 'ongoing', COMMERCIAL_EVALUATION: 'ongoing', NEGOTIATION_ONGOING: 'ongoing',
        QUOTATION_APPROVAL: 'ongoing', AWAITING_PO: 'ongoing', PO_APPROVAL: 'ongoing', PO_VENDOR_REJECTED: 'ongoing',
        APPROVED_COMPLETED: 'approved',
      };
      const statusKey = (r) => {
        const s = Number(r.status);
        if (s === 2) return 'CLOSED';
        if (s === 5) return 'WITHDRAWN';
        if (s === 0) return 'DRAFT';
        if (r.lifecycle_stage) return r.lifecycle_stage;
        if (s === 3 || s === 4) return 'RFQ_APPROVAL';
        return 'AWAITING_QUOTES';
      };
      const bucketOf = (r) => {
        const s = Number(r.status);
        if (s === 2) return 'closed';
        if (s === 0 || s === 5) return 'drafts';
        const stage = r.lifecycle_stage;
        if (stage && STAGE_BUCKET[stage]) return STAGE_BUCKET[stage];
        if (s === 3 || s === 4) return 'drafts';
        if (r.po_completed) return 'approved';
        return 'ongoing';
      };
      for (const r of rows) {
        r.lifecycle_stage = lifecycleMap[parseInt(r.id)] || null;
        r._bucket = bucketOf(r);
        r._statusKey = statusKey(r);
      }

      // Safe array accessors for the json columns.
      const parseArr = (v) => {
        if (Array.isArray(v)) return v;
        if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; } }
        return [];
      };
      const dedupe = (arr, keyFn) => { const seen = new Set(); const out = []; for (const x of arr) { const k = keyFn(x); if (k && !seen.has(k)) { seen.add(k); out.push(x); } } return out; };
      const productPairs = (r) => dedupe(parseArr(r.products).map((p) => ({
        id: String(p.product_id ?? p.id ?? ''),
        name: (Array.isArray(p.product_details) && p.product_details[0] && p.product_details[0].name) || `Product ${p.product_id ?? p.id ?? ''}`,
      })), (p) => p.id);
      const vendorPairs = (r) => {
        const out = [];
        for (const p of parseArr(r.products)) for (const v of parseArr(p.vendor_details)) {
          const id = String(v.user_id ?? v.id ?? '');
          const name = (v.user_details && v.user_details.name) || '';
          if (id) out.push({ id, name: name || `Vendor ${id}` });
        }
        return dedupe(out, (v) => v.id);
      };
      const categoryPairs = (r) => dedupe(parseArr(r.categories).map((c) => ({ id: String(c.id), title: c.title })), (c) => c.id);

      // 3. tab counts (full scoped+search set).
      const tab_counts = { all: rows.length, drafts: 0, ongoing: 0, approved: 0, closed: 0 };
      for (const r of rows) tab_counts[r._bucket] = (tab_counts[r._bucket] || 0) + 1;

      // 4. tab scope.
      const tabRows = tab === 'all' ? rows : rows.filter((r) => r._bucket === tab);

      // 5. facets over the tab scope (not narrowed by facet selections).
      const fm = { status: new Map(), buId: new Map(), categoryId: new Map(), departmentId: new Map(), productId: new Map(), vendorId: new Map() };
      const bump = (m, key, label) => { const e = m.get(key) || { key, label: label || null, count: 0 }; e.count++; if (label && !e.label) e.label = label; m.set(key, e); };
      for (const r of tabRows) {
        bump(fm.status, r._statusKey, null);
        if (r.hotel_id != null) bump(fm.buId, String(r.hotel_id), r.hotel_name || `Hotel ${r.hotel_id}`);
        if (r.department_id != null) bump(fm.departmentId, String(r.department_id), r.department_title || `Dept ${r.department_id}`);
        for (const c of categoryPairs(r)) bump(fm.categoryId, c.id, c.title);
        for (const p of productPairs(r)) bump(fm.productId, p.id, p.name);
        for (const v of vendorPairs(r)) bump(fm.vendorId, v.id, v.name);
      }
      const toFacet = (m) => Array.from(m.values()).sort((a, b) => b.count - a.count);
      const facets = {
        status: toFacet(fm.status), buId: toFacet(fm.buId), categoryId: toFacet(fm.categoryId),
        departmentId: toFacet(fm.departmentId), productId: toFacet(fm.productId), vendorId: toFacet(fm.vendorId),
      };

      // 6. apply facet selections (OR within a facet, AND across facets).
      const filtered = tabRows.filter((r) => {
        if (filters.status.length && !filters.status.includes(r._statusKey)) return false;
        if (filters.buId.length && !filters.buId.includes(String(r.hotel_id))) return false;
        if (filters.departmentId.length && !filters.departmentId.includes(String(r.department_id))) return false;
        if (filters.categoryId.length && !categoryPairs(r).some((c) => filters.categoryId.includes(c.id))) return false;
        if (filters.productId.length && !productPairs(r).some((p) => filters.productId.includes(p.id))) return false;
        if (filters.vendorId.length && !vendorPairs(r).some((v) => filters.vendorId.includes(v.id))) return false;
        return true;
      });

      // 7. sort.
      const ts = (r) => new Date(r.timestamp || 0).getTime();
      const dl = (r) => new Date(r.bid_end_date || 0).getTime();
      if (sort === 'oldest') filtered.sort((a, b) => ts(a) - ts(b));
      else if (sort === 'deadline') filtered.sort((a, b) => (dl(a) || Infinity) - (dl(b) || Infinity));
      else filtered.sort((a, b) => ts(b) - ts(a));

      // 8. paginate.
      const total = filtered.length;
      const start = (page - 1) * limit;
      const pageRows = filtered.slice(start, start + limit);

      // 9. action holders for the page only (lifecycle hover tooltip).
      let actionMap = {};
      if (pageRows.length > 0) {
        try { actionMap = await rfqModel.getActionHoldersForRFQs(pageRows, lifecycleMap); } catch (e) { logError('getRfqListView action holders', e); }
      }

      // 10. trim to the display payload.
      const data = pageRows.map((r) => ({
        id: r.id, rfq_no: r.rfq_no, title: r.title, status: r.status, is_published: r.is_published,
        is_tender: r.is_tender, rfq_type: r.rfq_type, reverse_auction: r.reverse_auction,
        lifecycle_stage: r.lifecycle_stage, bucket: r._bucket, status_key: r._statusKey,
        hotel_id: r.hotel_id, hotel_name: r.hotel_name, department_id: r.department_id, department_title: r.department_title,
        categories: categoryPairs(r), products: productPairs(r), vendors: vendorPairs(r),
        project_name: r.project_name, contact_name: r.contact_name, created_by: r.created_by,
        timestamp: r.timestamp, bid_end_date: r.bid_end_date,
        invited_count: parseArr(r.vendors)[0] ? (parseArr(r.vendors)[0].total_vendors ?? 0) : 0,
        submitted_count: parseArr(r.vendors)[0] ? (parseArr(r.vendors)[0].quote_received ?? 0) : 0,
        unseen_query_count: r.unseen_query_count ?? 0,
        is_finalized: r.is_finalized, po_completed: r.po_completed, can_edit: r.can_edit,
        // Fields canEditRfq() needs so the client can gate the Edit button.
        is_quotes_present: r.is_quotes_present, has_dead_end_product: r.has_dead_end_product,
        has_tech_stuck_product: r.has_tech_stuck_product,
        action_holders: actionMap[parseInt(r.id)] || null,
      }));

      return res.status(200).json({ status: 1, data: { rows: data, facets, tab_counts, total, page, limit } });
    } catch (error) {
      logError('getRfqListView error', error);
      return res.status(200).json({ status: 3, message: 'Error fetching RFQ listing' });
    }
  },

  // Get RFQs/Tenders where user is in the approval line (current pending step)
  getPendingApprovalRfqs: async (req, res, next) => {
    let user_id = req.user.id;
    try {
      let page, limit, offset;
      if (req.body.page && req.body.page > 0) {
        page = req.body.page;
        limit = req.body.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      let { project_id, sort, reverse_auction, rfq_type, rfq_no, search_val, is_tender, hotel_ids } = req.body;
      if (search_val && !rfq_no) rfq_no = search_val;
      if (project_id == -1) {
        project_id = null;
      }
      if (rfq_type == '') {
        rfq_type = null;
      }
      if (reverse_auction == '-1') {
        reverse_auction = null;
      }
      if (is_tender === '' || is_tender === undefined || is_tender === null) {
        is_tender = null;
      } else {
        is_tender = is_tender === '1' || is_tender === 1 || is_tender === true ? 1 : 0;
      }

      const listRfq = await rfqModel.getPendingApprovalRfqs(
        limit,
        offset,
        user_id,
        project_id,
        sort,
        reverse_auction,
        rfq_type,
        rfq_no,
        is_tender,
        hotel_ids
      );

      let count = await rfqModel.getPendingApprovalRfqCount(
        user_id,
        project_id,
        rfq_type,
        reverse_auction,
        rfq_no,
        is_tender,
        hotel_ids
      );

      // Enrich with lifecycle stage
      let lifecycleMap = {};
      if (listRfq && listRfq.length > 0) {
        const rfqIds = listRfq.map(r => parseInt(r.id));
        lifecycleMap = await rfqModel.computeLifecycleStages(rfqIds);
        for (const rfq of listRfq) {
          rfq.lifecycle_stage = lifecycleMap[parseInt(rfq.id)] || null;
        }
      }

      // Enrich with action holders (who can act at current lifecycle stage)
      if (listRfq && listRfq.length > 0) {
        try {
          const actionHoldersMap = await rfqModel.getActionHoldersForRFQs(listRfq, lifecycleMap);
          for (const rfq of listRfq) {
            rfq.action_holders = actionHoldersMap[parseInt(rfq.id)] || null;
          }
        } catch (err) {
          logError('Error fetching action holders', err);
        }
      }

      res
        .status(200)
        .json({
          status: 1,
          data: listRfq,
          total_items: count
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  getVendors: async (req, res, next) => {
    let { vendors, rfq_id } = req.body;
    logger.debug({ vendors }, 'getVendors request');
    try {
      const vendorsList = await rfqModel.getVendors(vendors, rfq_id);
      res
        .status(200)
        .json({
          status: 1,
          data: vendorsList
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  getVendorsForProduct: async (req, res) => {
    let { productId, excludeIds, searchTerm } = req.body;
    let userId = req.user.id;
    try {
      const vendorsList = await rfqModel.getVendorsForProduct(
        productId,
        excludeIds,
        userId,
        searchTerm
      );

      res
        .status(200)
        .json({
          status: 1,
          data: vendorsList
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value,
          error: error
        })
        .end();
    }
  },
  getVendorsByRfqProduct: async (req, res) => {
    let { rfq_product_id } = req.query;

    try {
      if (!rfq_product_id) {
        return res
          .status(400)
          .json({
            status: 0,
            message: 'rfq_product_id is required'
          })
          .end();
      }

      const vendorsList = await rfqModel.getVendorsByRfqProduct(rfq_product_id);

      res
        .status(200)
        .json({
          status: 1,
          data: vendorsList
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value,
          error: error
        })
        .end();
    }
  },
  createQuote: async (req, res, next) => {
    let {
      rfq_id,
      rfq_no,
      status,
      products,
      globalPaymentTerms,
      globalComment,
      global_payment_term_list,
      term_and_condition_files,
      is_regret,
      regret_reason,
      vendorGSTIN,
      global_charges
    } = req.body;

    const user = req.user;

    if (user && user.user_type != 3 && user.user_type != 4) {
      res
        .status(400)
        .json({
          status: 3,
          message: "You don't have permission to submit quotation!"
        })
        .end();
      return;
    }

    try {
      // check if the rfq is belongs to the vendor
      const checkRFQExist = await userModel.user_rfq_access_review(
        rfq_id,
        user.id,
        user.user_type
      );
      if (checkRFQExist) {
        // Get RFQ details to check dates
        const rfqDetails = await rfqModel.getRFQDetails(rfq_id);
        if (!rfqDetails || rfqDetails.length === 0) {
          return res
            .status(404)
            .json({
              status: 0,
              message: 'RFQ not found!'
            })
            .end();
        }

        const now = new Date();

        // Helper to safely parse dates - returns null for invalid/empty values
        const safeParseDate = (dateValue) => {
          if (!dateValue || dateValue === '' || dateValue === 'null') {
            return null;
          }
          const parsed = new Date(dateValue);
          // Check if date is valid (Invalid Date returns NaN for getTime())
          return isNaN(parsed.getTime()) ? null : parsed;
        };

        const bidEndDate = safeParseDate(rfqDetails[0].bid_end_date);
        const raStartDate = safeParseDate(rfqDetails[0].ra_start_date);
        const raEndDate = safeParseDate(rfqDetails[0].ra_end_date);
        const isReverseAuction = rfqDetails[0].reverse_auction === 1;

        // Use exact bid_end_date time for deadline enforcement
        const bidEndDateTime = bidEndDate;

        // Check if RFQ is closed (highest priority)
        if (rfqDetails[0].status === 2) {
          return res
            .status(400)
            .json({
              status: 3,
              message: 'RFQ is Closed'
            })
            .end();
        }

        // Check if reverse auction is active (second priority)
        const isReverseAuctionActive =
          isReverseAuction &&
          raStartDate &&
          raEndDate &&
          now >= raStartDate &&
          now <= raEndDate;

        // If reverse auction is active, allow quote submission
        if (isReverseAuctionActive) {
          // Continue with quote submission - this is allowed
        }
        // Otherwise check other conditions
        else {
          // Check if all products are finalized
          const productsFinalized = await rfqModel.checkAllProductsFinalized(
            rfq_id,
            user.id
          );
          if (productsFinalized) {
            return res
              .status(400)
              .json({
                status: 3,
                message: 'All Products are Finalized'
              })
              .end();
          }

          // Check if past bid end date - but allow if there are active negotiation rounds
          if (bidEndDateTime && now > bidEndDateTime) {
            // Check if any active negotiation round exists for this RFQ
            const activeNegotiationRounds = await db.any(
              `SELECT nr.id, cp.covered_product_id AS rfq_product_id
             FROM tbl_negotiation_rounds nr
             CROSS JOIN LATERAL (
               SELECT nr.rfq_product_id AS covered_product_id
               WHERE nr.rfq_product_id IS NOT NULL
               UNION
               SELECT (p_->>'rfq_product_id')::int
               FROM jsonb_array_elements(COALESCE(nr.products,'[]'::jsonb)) p_
               WHERE p_->>'rfq_product_id' IS NOT NULL
               UNION
               -- RFQ-level entries (payment terms / global charges) keep the
               -- round registered as active even with no product entries.
               SELECT NULL::int
               FROM jsonb_array_elements(COALESCE(nr.products,'[]'::jsonb)) p_
               WHERE (p_->>'is_rfq_level')::boolean IS TRUE
             ) cp
             WHERE nr.rfq_id = $1 AND nr.status = 'ACTIVE' AND nr.end_date > NOW()`,
              [rfq_id]
            );

            // Only block if there are NO active negotiation rounds
            if (!activeNegotiationRounds || activeNegotiationRounds.length === 0) {
              // Different messages based on reverse auction status
              let message = 'Bidding Period has Ended';

              if (isReverseAuction) {
                if (raEndDate && now > raEndDate) {
                  message = 'Reverse Auction has Ended';
                } else if (raStartDate && now < raStartDate) {
                  message = 'Bidding Period Ended (Reverse Auction Pending)';
                } else if (!raStartDate || !raEndDate) {
                  message = 'Bidding Period Ended (RA Dates Invalid)';
                }
              }

              return res
                .status(400)
                .json({
                  status: 3,
                  message: message
                })
                .end();
            }

            // Active negotiation rounds exist - validate per-product
            const activeNegotiationProductIds = new Set(
              activeNegotiationRounds.map(r => r.rfq_product_id)
            );

            // Verify submitted products are limited to those with active negotiation rounds
            if (products && products.length > 0) {
              for (const product of products) {
                if (!product.product_id || (product.unit_price === '' || product.unit_price == 0)) continue;

                const rfqProductResult = await db.oneOrNone(
                  `SELECT id FROM tbl_rfq_products WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3`,
                  [rfq_id, product.product_id, product.variant]
                );

                if (rfqProductResult && !activeNegotiationProductIds.has(rfqProductResult.id)) {
                  return res
                    .status(400)
                    .json({
                      status: 3,
                      message: `Bidding period has ended. This product cannot be quoted as it does not have an active negotiation round.`
                    })
                    .end();
                }
              }
            }
          }
        }

        // Check if technical evaluation is required for any products and if vendor is accepted
        if (isReverseAuction && products && products.length > 0) {
          let rejectedProducts = [];

          for (const product of products) {
            if (!product.product_id) continue;

            // Get RFQ product ID from the database
            const rfqProductResult = await rfqModel.checkIfExists(
              'tbl_rfq_products',
              `rfq_id=${rfq_id} AND product_variant_id=${product.product_id} AND variant='${product.variant}'`
            );

            if (rfqProductResult && rfqProductResult.length > 0) {
              const rfqProductId = rfqProductResult[0].id;

              // Check if this product has technical evaluation
              const techEvalResult = await rfqModel.getTechEvaluationResult(
                rfqProductId,
                user.id
              );

              // If product has technical evaluation but vendor is not accepted, add to rejected list
              if (
                techEvalResult &&
                techEvalResult.data &&
                techEvalResult.data.has_tech_eval === true &&
                techEvalResult.data.status !== 1
              ) {
                rejectedProducts.push(product.product_id);
              }
            }
          }

          // If any products were rejected, return error
          if (rejectedProducts.length > 0) {
            return res
              .status(400)
              .json({
                status: 3,
                message: `You cannot submit a quote for products that have not passed technical evaluation. ${rejectedProducts.length} product(s) not technically accepted.`
              })
              .end();
          }
        }

        // Tender payment validation
        let tenderPaymentId = null;
        if (rfqDetails[0].is_tender === 1 && parseInt(rfqDetails[0].tender_fees || 0) > 0) {
          const paymentRow = await db.oneOrNone(
            `SELECT id, payment_status FROM tbl_vendor_payments
             WHERE vendor_id = $1 AND rfq_id = $2 AND payment_type = 'tender'
             ORDER BY id DESC LIMIT 1`,
            [user.id, rfq_id]
          );
          if (!paymentRow || paymentRow.payment_status !== 'success') {
            return res
              .status(400)
              .json({
                status: 3,
                message: 'Payment required to submit quote for this tender RFQ'
              })
              .end();
          }
          tenderPaymentId = paymentRow.id;
        }

        // Clarification period validation (IST-based).
        // Treat vendor_clarification_date as an IST datetime and convert to a UTC Date
        // so that 6:30 PM IST is respected regardless of server timezone.
        if (rfqDetails[0].vendor_clarification_date) {
          const rawClar = String(rfqDetails[0].vendor_clarification_date).trim();
          let datePart;
          let timePart;

          if (rawClar.includes('T')) {
            [datePart, timePart] = rawClar.split('T');
          } else if (rawClar.includes(' ')) {
            [datePart, timePart] = rawClar.split(' ');
          } else {
            datePart = rawClar;
            timePart = '00:00:00';
          }

          const [year, month, day] = datePart.split('-').map((v) => parseInt(v, 10));
          const [hourStr, minuteStr, secondStr] = (timePart || '00:00:00').split(':');
          const hour = parseInt(hourStr || '0', 10);
          const minute = parseInt(minuteStr || '0', 10);
          const second = parseInt((secondStr || '0').split('.')[0] || '0', 10);

          const IST_OFFSET_MINUTES = 330; // +05:30
          const clarificationEnd = new Date(
            Date.UTC(year, month - 1, day, hour, minute, second) -
              IST_OFFSET_MINUTES * 60 * 1000
          );

          const now = new Date();
          if (!isNaN(clarificationEnd.getTime()) && now < clarificationEnd) {
            return res.status(400).json({
              status: 3,
              message:
                'Quote submission is blocked until the vendor clarification period ends.',
            });
          }
        }

        // Check for open clarification - blocks all vendors from quoting
        {
          const openClarification =
            await rfqModel.checkActiveClarification(rfq_id);
          if (openClarification) {
            // For tenders, show vendor code instead of vendor name
            const vendorCode = `VEN-${openClarification.raised_by_vendor_id || 'UNKNOWN'}`;
            return res.status(400).json({
              status: 3,
              message:
                'Quote submission is blocked. There is an open clarification pending response.',
              data: {
                clarification_id: openClarification.id,
                raised_by_vendor_code: vendorCode,
                subject: openClarification.subject,
                created_at: openClarification.created_at
              }
            });
          }
        }

        // Build slug map for enriching charges
        const chargeNamesRows = await db.any(
          `SELECT name, slug FROM tbl_charge_names WHERE created_by IS NULL OR created_by = $1`,
          [user.id]
        );
        const slugMap = new Map(chargeNamesRows.map(c => [c.name.toLowerCase(), c.slug]));
        const enrichCharges = (charges) => (charges || []).map(c => ({
          ...c,
          slug: slugMap.get(c.name?.toLowerCase()) || rfqController._generateChargeSlug(c.name || '')
        }));

        // Per-product other_charges: comment is mandatory and capped at 30
        // chars (matches the send-quote modal UI). Skip when regretting the
        // quote — there are no real charges to comment on in that case.
        const PRODUCT_CHARGE_COMMENT_MAX = 30;
        const validateProductChargeComments = (charges, label) => {
          for (const c of charges || []) {
            const comment = c?.comment != null ? String(c.comment) : '';
            if (!comment.trim()) {
              return `${label}: "${c.name || 'Unnamed charge'}" requires a comment.`;
            }
            if (comment.length > PRODUCT_CHARGE_COMMENT_MAX) {
              return `${label}: "${c.name || 'Unnamed charge'}" comment cannot exceed ${PRODUCT_CHARGE_COMMENT_MAX} characters.`;
            }
          }
          return null;
        };
        if (!req.body.is_regret) {
          for (const product of products) {
            const productLabel = product.product_name || `Product ${product.product_id}`;
            const err = validateProductChargeComments(product.other_charges, productLabel);
            if (err) {
              return res.status(400).json({ status: 0, message: err }).end();
            }
          }
        }

        // Enrich other_charges with slugs for each product
        for (const product of products) {
          if (product.other_charges) {
            product.other_charges = enrichCharges(product.other_charges);
          }
        }

        return await db.tx(async (t) => {
          const tbl_quotes_data = {
            rfq_id,
            rfq_no,
            status,
            created_by: user.id,
            updated_by: user.id,
            is_regret: req.body.is_regret ? req.body.is_regret : 0,
            global_payment_term: globalPaymentTerms,
            global_comment: globalComment,
            regret_reason,
            payment_id: tenderPaymentId,
            gstin: vendorGSTIN && String(vendorGSTIN).trim() ? String(vendorGSTIN).trim() : null,
            global_charges: JSON.stringify(enrichCharges(global_charges))
          };

          // check quote is already exists or not
          // console.log("mukul 1870")
          let alreadyExists = await rfqModel.checkIfExists(
            'tbl_quotes',
            `rfq_id=${rfq_id} AND created_by=${user.id} LIMIT 1`,
            t
          );
          if (alreadyExists.length > 0) {
            throw new Error('Quote is alredy present for this RFQ!');
          }

          var quote_items_data = [];
          products.map(
            ({
              product_id,
              product_name,
              unit_price,
              tax,
              total_price,
              comment,
              delivery_period,
              quantity,
              variant,
              document_files,
              tax_mode,
              other_charges
            }) => {
              const chargesJson = JSON.stringify(other_charges || []);
              if (unit_price != '') {
                quote_items_data.push({
                  rfq_id,
                  rfq_no,
                  product_variant_id: product_id,
                  product_name,
                  unit_price,
                  package_price: 0,
                  tax,
                  freight_price: 0,
                  total_price,
                  comment,
                  delivery_period,
                  quantity,
                  variant,
                  freight_mode: null,
                  package_mode: null,
                  tax_mode,
                  other_charges: chargesJson
                });
              } else if (comment != '' || document_files?.length > 0) {
                quote_items_data.push({
                  rfq_id,
                  rfq_no,
                  product_variant_id: product_id,
                  product_name,
                  unit_price: 0,
                  package_price: 0,
                  tax,
                  freight_price: 0,
                  total_price,
                  comment,
                  delivery_period,
                  quantity,
                  variant,
                  freight_mode: null,
                  package_mode: null,
                  tax_mode,
                  other_charges: chargesJson
                });
              } else if (is_regret) {
                quote_items_data.push({
                  rfq_id,
                  rfq_no,
                  product_variant_id: product_id,
                  product_name,
                  unit_price: 0,
                  package_price: 0,
                  tax: 0,
                  freight_price: 0,
                  total_price: 0,
                  comment,
                  delivery_period,
                  quantity,
                  variant,
                  freight_mode: null,
                  package_mode: null,
                  tax_mode,
                  other_charges: chargesJson
                });
              }
            }
          );

          // Server-authoritative recompute: discard the client-supplied
          // total_price and derive it from the pricing engine. Prevents a
          // buggy/malicious client from persisting incorrect totals.
          quote_items_data.forEach((item) => {
            let parsedOtherCharges = [];
            try {
              parsedOtherCharges = JSON.parse(item.other_charges || '[]');
            } catch (_e) {
              parsedOtherCharges = [];
            }
            const engineOut = pricingEngine.calculateLineTotal({
              unit_price: item.unit_price,
              quantity: item.quantity,
              tax: item.tax,
              tax_mode: item.tax_mode,
              other_charges: parsedOtherCharges,
            });
            item.total_price = engineOut.total;
          });

          if (is_regret) {
            let quote_rsp = await rfqModel.insert(
              'tbl_quotes',
              tbl_quotes_data,
              t
            );
            const created_quote_id = quote_rsp?.[0]?.id;

            if (created_quote_id) {
              const buyer = await userModel.getUserById(
                rfqDetails[0].created_by
              );

              // adding the quote_id
              quote_items_data.map(
                (item) => (item.quote_id = created_quote_id)
              );

              const quote_items_keys = [
                'rfq_id',
                'rfq_no',
                'quote_id',
                'product_variant_id',
                'product_name',
                'unit_price',
                'package_price',
                'tax',
                'freight_price',
                'total_price',
                'comment',
                'delivery_period',
                'quantity',
                'variant',
                'freight_mode',
                'package_mode',
                'tax_mode',
                'other_charges'
              ];
              await rfqModel.insertArray(
                quote_items_data,
                quote_items_keys,
                'tbl_quote_items',
                t
              );

              await sendMailToBuyerForRegret(
                buyer[0],
                rfqDetails[0].rfq_no,
                req.user,
                rfq_id,
                regret_reason
              );

              return res
                .status(200)
                .json({
                  status: 3,
                  message: 'Your quote is regretted.',
                  regret_reason: regret_reason,
                  data: quote_rsp
                })
                .end();
            }

            return res
              .status(400)
              .json({
                status: 3,
                message: 'Something went wrong!',
                regret_reason: regret_reason,
                data: null,
                error: "Entry in table quote didn't exexuted as expected!"
              })
              .end();
          }

          // if quote item data is empty because of errors
          if (quote_items_data.length < 1) {
            throw new Error('Not able to send the Quote');
          }

          // Insertion of the quote
          let quote_rsp = await rfqModel.insert(
            'tbl_quotes',
            tbl_quotes_data,
            t
          );
          if (quote_rsp.length > 0) {
            const created_quote_id = quote_rsp[0].id;

            if (
              term_and_condition_files &&
              term_and_condition_files.length > 0
            ) {
              const quote_files = term_and_condition_files.map((url) => ({
                quote_id: created_quote_id,
                file_type: 'term_and_condition',
                file_url: url
              }));
              for (const fileData of quote_files) {
                await rfqModel.insert('tbl_quotes_files', fileData, t);
              }
            }

            // Payment Terms (tbl_quotes_payment_terms)
            if (
              Array.isArray(global_payment_term_list) &&
              global_payment_term_list.length
            ) {
              const rows = global_payment_term_list
                .filter((r) => r && r.type && r.value != null)
                .map((r) => {
                  const type = String(r.type).toLowerCase();
                  return ['advance', 'credit', 'other'].includes(type)
                    ? {
                        quote_id: created_quote_id,
                        value: Number(r.value) || 0,
                        type,
                        days:
                          type === 'credit' && r.days != null
                            ? Number(r.days)
                            : null,
                        comment: r.comment?.trim() || null,
                        created_by: req.user.id
                      }
                    : null;
                })
                .filter(Boolean);

              if (rows.length) {
                await rfqModel.insertArray(
                  rows,
                  [
                    'quote_id',
                    'value',
                    'type',
                    'days',
                    'comment',
                    'created_by'
                  ],
                  'tbl_quotes_payment_terms',
                  t
                );
              }
            }
            //  save payment term array

            // adding the quote_id
            quote_items_data.map((item) => (item.quote_id = created_quote_id));

            // console.log("mukul 1959")

            const quote_items_keys = [
              'rfq_id',
              'rfq_no',
              'quote_id',
              'product_variant_id',
              'product_name',
              'unit_price',
              'package_price',
              'tax',
              'freight_price',
              'total_price',
              'comment',
              'delivery_period',
              'quantity',
              'variant',
              'freight_mode',
              'package_mode',
              'tax_mode',
              'other_charges'
            ];
            let quotes_items = await rfqModel.insertArray(
              quote_items_data,
              quote_items_keys,
              'tbl_quote_items',
              t
            );

            // New code to insert file links into tbl_quote_item_files
            if (quotes_items.length > 0) {
              quotes_items.forEach(async (item, index) => {
                const file_links = products[index].document_files;
                if (file_links && file_links.length > 0) {
                  const file_records = file_links.map((link) => ({
                    quote_item_id: item.id,
                    file_type: 'DOC',
                    file_url: link,
                    created_at: new Date()
                  }));
                  await rfqModel.insertArray(
                    file_records,
                    ['quote_item_id', 'file_type', 'file_url', 'created_at'],
                    'tbl_quote_item_files',
                    t
                  );
                }
              });
            }

            // Save quotes to negotiation round quotes table if there's an active negotiation round
            try {
              for (const quoteItem of quotes_items) {
                // Find the rfq_product_id for this quote item
                const rfqProductResult = await t.oneOrNone(
                  `SELECT id FROM tbl_rfq_products 
                   WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3`,
                  [rfq_id, quoteItem.product_variant_id, quoteItem.variant]
                );

                if (rfqProductResult) {
                  const rfqProductId = rfqProductResult.id;

                  // Check if there's an active negotiation round for this product
                  const activeRound = await t.oneOrNone(
                    `SELECT id, rfq_product_id FROM tbl_negotiation_rounds nr
                     WHERE nr.rfq_id = $1 AND nr.status = 'ACTIVE'
                       AND nr.end_date > NOW()
                       AND (nr.rfq_product_id = $2 OR EXISTS (
                         SELECT 1 FROM jsonb_array_elements(COALESCE(nr.products,'[]'::jsonb)) p_
                         WHERE (p_->>'rfq_product_id')::int = $2
                       ))
                     ORDER BY nr.round_number DESC
                     LIMIT 1`,
                    [rfq_id, rfqProductId]
                  );

                  if (activeRound) {
                    // Check if vendor has already submitted a quote for this round
                    const existingNegotiationQuote = await t.oneOrNone(
                      `SELECT id FROM tbl_negotiation_round_quotes 
                       WHERE negotiation_round_id = $1 AND vendor_id = $2 AND rfq_product_id = $3`,
                      [activeRound.id, user.id, rfqProductId]
                    );

                    if (!existingNegotiationQuote) {
                      // Insert negotiation round quote
                      await t.none(
                        `INSERT INTO tbl_negotiation_round_quotes 
                          (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at)
                         VALUES ($1, $2, $3, $4, NULL, NOW())`,
                        [activeRound.id, user.id, rfqProductId, quoteItem.total_price]
                      );
                    }
                  }
                }
              }
            } catch (negotiationError) {
              // Log but don't fail the main quote submission
              logError('Error saving negotiation round quote', negotiationError);
            }

            await sendQuoteNotificationEmail(req);
            await sendQuoteNotificationToVendor(req);

            //  send whatsapp notification
            const buyerDetails = await rfqModel.getRFQCreatedBy(rfq_id);
            const rfqDetails = await rfqModel.getRfqDetailsById(rfq_id);
            const projectID = rfqDetails[0]?.project_id;
            const projectDetails = await projectModel.getProjectTableDataById(
              projectID,
              buyerDetails[0]?.id
            );

            const payload = {
              mobile: buyerDetails[0]?.mobile,
              rfqNumber: rfq_no,
              rfqID: rfq_id,
              projectName: projectDetails[0]?.name || '-',
              vendorName: req?.user?.company_name || req?.user?.organization_name || req?.user?.name,
              buyerName: buyerDetails[0]?.company_name || buyerDetails[0]?.organization_name || buyerDetails[0]?.name
            };

            // await whatsappNotificationAISensy.sendNewQuoteNotificationToBuyer(
            //   payload
            // );

            return res
              .status(200)
              .json({
                status: 1,
                data: quotes_items[0]
              })
              .end();
          } else {
            return res
              .status(400)
              .json({
                status: 3,
                message: Config.errorText.value
              })
              .end();
          }
        });
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: 'The RFQ is not belongs to you!'
          })
          .end();
        return;
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: error.message ?? Config.errorText.value,
          error
        })
        .end();
    }
  },
  getQuotesByRfqById: async (req, res, next) => {
    let rfq_id = req.params.id;
    const { TA_Vendors, no_freight, rfq_product_id, pageSource, include_negotiation } = req.query;
    const { id, company_id } = req.user;

    try {
      const { quoteVisibility } = await getQuoteVisibilityForRfq(rfq_id);
      let rfQItem;

      if (quoteVisibility.locked) {
        const lockedProducts = await rfqModel.getQuoteVisibilityLockedProductsByRfqId(
          rfq_id,
          rfq_product_id
        );
        rfQItem = sanitizeQuoteProductsForLockedState(lockedProducts, quoteVisibility);
      } else {
        // Vendors (user_type 3) see only negotiation rounds they are selected for
        const vendor_filter_id = req.user.user_type == 3 ? (req.user.vendor_id || id) : null;
        rfQItem = await rfqModel.getQuotesByRfqById2(
          rfq_id,
          id,
          company_id,
          TA_Vendors,
          no_freight,
          rfq_product_id,
          include_negotiation === 'true',
          vendor_filter_id
        );
      }
      // rfQItem = processQuotations(rfQItem);
       if (pageSource === "quote_compare") {
      // 👇 Check if an entry already exists
      const existingActivity = await rfqModel.checkIfExists(
        'tbl_quote_activity',
        `rfq_id = ${rfq_id} AND created_by = ${req.user.id} AND current_status = 'QC'`
      );

      if (existingActivity.length === 0) {
        const insertIntoQuoteActivity = await rfqModel.insertIntoQuoteActivity({
          rfq_id: rfq_id,
          current_status: "QC",
          created_by: req.user.id
        });
        logger.debug({ data: insertIntoQuoteActivity }, 'Inserted value into quote activity');
      } else {
        logger.debug('Skipped insert - already exists for rfq_id ${rfq_id} and user ${req.user.id}');
      }
    } else {
      logger.debug('Skipped insert for pageSource: ${pageSource}');
    }

      res
        .status(200)
        .json({
          status: 1,
          data: rfQItem,
          meta: {
            quoteVisibility,
          }
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  // Server-computed quote-compare view model. Same data as getQuotesByRfqById,
  // but every line carries engine output (base, base_tax, charges[], total),
  // every product carries comparison stats (bands, freight advantage,
  // tie-broken lowest), and the response includes overall metrics (L1,
  // baseline, savings, finalized total). The frontend never multiplies
  // prices — it just renders these values.
  getQuoteComparison: async (req, res, next) => {
    const rfq_id = req.params.id;
    const { no_freight, rfq_product_id, normalize, freightFilter, pageSource, include_negotiation } = req.query;
    const { id, company_id, user_type, vendor_id } = req.user;

    try {
      const { quoteVisibility } = await getQuoteVisibilityForRfq(rfq_id);
      let products;

      if (quoteVisibility.locked) {
        const lockedProducts = await rfqModel.getQuoteVisibilityLockedProductsByRfqId(rfq_id, rfq_product_id);
        products = sanitizeQuoteProductsForLockedState(lockedProducts, quoteVisibility);
      } else {
        const vendor_filter_id = user_type == 3 ? (vendor_id || id) : null;
        // Quote Compare is a buyer view for awarding business; technically-rejected
        // vendors must never appear here. Force tech-eval gating on the model
        // regardless of what the FE sends — the model's gating still falls through
        // for products / RFQs that don't have any technical clauses.
        products = await rfqModel.getQuotesByRfqById2(
          rfq_id, id, company_id,
          'TA', no_freight, rfq_product_id,
          include_negotiation === 'true',
          vendor_filter_id
        );
      }

      const normalizeApplied = normalize === '1' || normalize === 'true';
      const enriched = enrichQuoteCompareData(products, {
        normalizeApplied,
        freightFilter: freightFilter === '1' || freightFilter === 'true',
      });

      // Mirror getQuotesByRfqById's quote-activity insert when this is the
      // user's quote-compare visit, so analytics stays consistent.
      if (pageSource === 'quote_compare') {
        try {
          const existing = await rfqModel.checkIfExists(
            'tbl_quote_activity',
            `rfq_id = ${rfq_id} AND created_by = ${id} AND current_status = 'QC'`
          );
          if (existing.length === 0) {
            await rfqModel.insertIntoQuoteActivity({
              rfq_id, current_status: 'QC', created_by: id,
            });
          }
        } catch (activityErr) {
          logError('quote-activity insert failed', activityErr);
        }
      }

      return res
        .status(200)
        .json({
          status: 1,
          data: enriched,
          meta: { quoteVisibility, normalize_applied: normalizeApplied },
        })
        .end();
    } catch (error) {
      logError('getQuoteComparison failed', error);
      return res
        .status(400)
        .json({ status: 3, message: Config.errorText.value })
        .end();
    }
  },

  // GET /rfq/quote-comparison-view/:id
  // Single, flat, frontend-friendly "QC contract" for the buyer Quote
  // Comparison UI. Reuses the existing comparison pipeline
  // (rfqModel.getQuotesByRfqById2 + quoteCompareService.enrichQuoteCompareData)
  // and reshapes it, layering on per-product state / finalized vendor /
  // reject_info, vendor tech status, categories and the quote approval chain.
  // Scope is derived from req.user + headers ONLY; out-of-scope/not-found -> 404.
  // Query param freight=1 (default) returns landed totals incl. freight;
  // freight=0 recomputes base totals (no_freight passthrough).
  getQuoteComparisonView: async (req, res, next) => {
    try {
      const scope = deriveQcScope(req);
      // freight=1 (default) => landed (no_freight falsy). freight=0 => no_freight true.
      const freightParam = req.query.freight;
      const noFreight =
        freightParam === '0' || freightParam === 0 || freightParam === 'false' ? '1' : undefined;

      const view = await quoteCompareViewModel.getQuoteComparisonView(
        req.params.id,
        scope,
        { noFreight }
      );

      if (!view) {
        return res
          .status(404)
          .json({ status: 2, message: 'Quote comparison not found.' })
          .end();
      }
      return res.status(200).json(view).end();
    } catch (error) {
      logError('getQuoteComparisonView failed', error);
      return res
        .status(500)
        .json({ status: 0, message: error.message || Config.errorText.value })
        .end();
    }
  },

  downloadQuoteResults: async (req, res, next) => {
    let rfq_id = req.params.id;
    const { id } = req.user;

    try {
      const rfQItem = await rfqModel.getQuotesByRfqById(rfq_id, id);
      //Get all RFQs
      const listRfq = await rfqModel.getAllBuyerRfq(100000, 0, id);
      Promise.all(listRfq.map((item) => getQUOTES(item, id)))
        .then((results) => {
          res
            .status(200)
            .json({
              status: 1,
              data: results
            })
            .end();
        })
        .catch((error) => {
          logError('Error inserting data', error);
        });
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  downloadQuoteResultsProductWise: async (req, res, next) => {
    let rfq_id = req.params.id;
    const { TA_Vendors, no_freight, rfq_product_id, normalize } = req.query;

    const { id, company_id } = req.user;

    try {
      const { quoteVisibility } = await getQuoteVisibilityForRfq(rfq_id);
      if (quoteVisibility.locked) {
        throw createQuoteVisibilityError(
          quoteVisibility,
          'Quote export is locked until the quote submission deadline has passed in IST.'
        );
      }

      let rfQItem = await rfqModel.getQuotesByRfqByIdByProduct(
        rfq_id,
        id,
        company_id,
        TA_Vendors,
        no_freight,
        rfq_product_id
      );

      rfQItem.forEach((product) => {
        const vendorMap = new Map();
        product.all_vendors.forEach((vendor) =>
          vendorMap.set(vendor.id, vendor)
        );

        const updatedQuotations = product.all_vendors.map((vendor) => {
          const existingQuote = product.quotations.find(
            (q) => q.created_by === vendor.id
          );
          if (existingQuote) {
            return existingQuote;
          } else {
            // Creating a placeholder for missing quotation
            return {
              id: null,
              timestamp: null,
              status: null,
              created_by: vendor.id,
              is_regret: null,
              global_payment_term: null,
              global_comment: null,
              vendor_details: [vendor],
              quote_details: []
            };
          }
        });

        product.quotations = updatedQuotations;
      });

      // Layer engine output on top so the Excel export sums match what the
      // quote-compare page shows.
      const normalizeApplied = normalize === '1' || normalize === 'true';
      const enriched = enrichQuoteCompareData(rfQItem, { normalizeApplied });

       const insertIntoQuoteActivity = await rfqModel.insertIntoQuoteActivity({
                                                          rfq_id: rfq_id,
                                                          current_status: "QC",
                                                          created_by: req.user.id
                                                        });

      logger.debug({ data: insertIntoQuoteActivity }, 'Inserted value into quote activity');
      res
        .status(200)
        .json({
          status: 1,
          data: enriched.products,
          meta: { normalize_applied: normalizeApplied }
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(error.statusCode || 400)
        .json({
          status: 3,
          message: error.message || Config.errorText.value,
          meta: error.quoteVisibility ? { quoteVisibility: error.quoteVisibility } : undefined
        })
        .end();
    }
  },
  getLprLqrByVariantId: async (req, res, next) => {
    const { variant_id, type } = req.query;
    const { id } = req.user;
    try {
      if (variant_id) {
        const data = await rfqModel.getLprLqrByVariantId(id, variant_id, type);

        res
          .status(200)
          .json({
            status: 1,
            data: data
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  getQuoteHistoryForvendor : async (req, res, next) => {
    const { variant_id } = req.query;
    const { id } = req.user;
    try {
      if (variant_id) {
        const data = await rfqModel.getQuoteHistoryForvendor(id, variant_id);
        res
          .status(200)
          .json({
            status: 1,
            data: data
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({

          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  closeRFQ: async (req, res, next) => {
    let rfq_id = req.params.id;
    const { id } = req.user;

    try {
      const rfqDetails = await rfqModel.getRfqDetailsById(rfq_id);
      if (!rfqDetails) {
        return res.status(404).json({ status: 2, message: 'RFQ not found' });
      }
      if (String(rfqDetails.created_by) !== String(id)) {
        return res.status(403).json({ status: 0, message: 'Only the RFQ creator can close this RFQ' });
      }
      if (String(rfqDetails.status) !== '1') {
        return res.status(400).json({ status: 0, message: 'Only open RFQs can be closed' });
      }

      const entityType = rfqDetails.is_tender === 1 ? 'TENDER' : 'RFQ';
      const comment = req.body.comment || '';
      const cancelReason = comment
        ? `${entityType} closed by creator: ${comment}`
        : `${entityType} closed by creator`;

      // Captured inside the transaction, used outside the tx for emails.
      let cancelledInstances = [];
      let cancelledRoundCount = 0;

      // Update RFQ status to CLOSED (2) and cancel ALL pending approvals tied to this RFQ.
      await db.tx(async t => {
        await t.none(
          'UPDATE tbl_rfq SET status = 2, updated_by = $1 WHERE id = $2',
          [id, rfq_id]
        );

        // Cancel any ACTIVE negotiation rounds — vendors should not be able to
        // keep submitting new quotes against a closed RFQ.
        const cancelledRoundsResult = await t.result(
          `UPDATE tbl_negotiation_rounds
              SET status = 'CANCELLED', closed_at = NOW()
            WHERE rfq_id = $1 AND status = 'ACTIVE'`,
          [rfq_id]
        );
        cancelledRoundCount = cancelledRoundsResult.rowCount;

        // Bulletproof lookup: an approval can be linked to an RFQ via several
        // shapes depending on the entity_type. We catch every shape:
        //   • RFQ/TENDER:        entity_id = rfq_id
        //   • PO:                entity_id = po_id (FK to tbl_rfq_purchase_order)
        //   • NEGOTIATION:       entity_id = round_id (FK to tbl_negotiation_rounds)
        //   • NEGOTIATION_QUOTE: entity_id = rfq_product_id
        //   • ARC:               entity_id = rfq_product_id
        //   • TECHNICAL:         entity_id = tech_evaluation round id (FK to tbl_rfq_product_tech_evaluation)
        //   • Catch-all:         metadata->>'rfq_id' = rfq_id (covers any new entity_type that
        //                        consistently sets this field)
        const pendingInstances = await t.any(
          `SELECT id, entity_type, entity_id, metadata
             FROM tbl_approval_instances
            WHERE status = 'PENDING'
              AND (
                (entity_type IN ('RFQ','TENDER') AND entity_id = $1)
                OR (
                  entity_type = 'PO'
                  AND entity_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1)
                )
                OR (
                  entity_type = 'NEGOTIATION'
                  AND entity_id IN (SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = $1)
                )
                OR (
                  entity_type IN ('NEGOTIATION_QUOTE','ARC')
                  AND entity_id IN (SELECT id FROM tbl_rfq_products WHERE rfq_id = $1)
                )
                OR (
                  entity_type = 'TECHNICAL'
                  AND entity_id IN (SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1)
                )
                OR (
                  metadata->>'rfq_id' IS NOT NULL
                  AND (metadata->>'rfq_id')::int = $1
                )
              )`,
          [rfq_id]
        );

        for (const instance of pendingInstances) {
          // Capture current pending approvers BEFORE we cancel the steps,
          // so we can email them after the transaction commits.
          const approvers = await t.any(
            `SELECT u.id AS user_id, u.name AS user_name, u.email AS user_email
               FROM tbl_approval_instance_steps ais
               JOIN tbl_approval_step_approvers asa
                 ON asa.approval_instance_step_id = ais.id
               JOIN tbl_users u ON u.id = asa.approver_user_id
              WHERE ais.approval_instance_id = $1
                AND ais.status = 'PENDING'
                AND asa.status = 'PENDING'
                AND u.email IS NOT NULL
                AND u.email <> ''`,
            [instance.id]
          );

          await t.none(
            `UPDATE tbl_approval_instances
                SET status = 'CANCELLED', completed_at = NOW()
              WHERE id = $1`,
            [instance.id]
          );
          await t.none(
            `UPDATE tbl_approval_instance_steps
                SET status = 'CANCELLED', completed_at = NOW()
              WHERE approval_instance_id = $1 AND status = 'PENDING'`,
            [instance.id]
          );
          await t.none(
            `INSERT INTO tbl_approval_actions
               (approval_instance_id, approver_user_id, action, comment)
             VALUES ($1, $2, 'REJECT', $3)`,
            [instance.id, id, `[CANCELLED] ${cancelReason}`]
          );

          cancelledInstances.push({
            id: instance.id,
            entity_type: instance.entity_type,
            entity_id: instance.entity_id,
            metadata: instance.metadata,
            approvers
          });
        }
      });

      logger.debug('[closeRFQ] RFQ ${rfq_id}: cancelled ${cancelledInstances.length} pending approval instance(s) and ${cancelledRoundCount} active negotiation round(s)');

      // Re-fetch the RFQ row so the response shape stays the same as before
      const rfQItem = await rfqModel.getRfqDetailsById(rfq_id);

      // Fetch all business unit members mapped to this RFQ's hotel.
      // Includes both hotel-specific (mapping_type = 1) and company-wide
      // (mapping_type = 0) mappings, deduped by user id.
      let buMembers = [];
      try {
        buMembers = await db.any(
          `SELECT DISTINCT u.id, u.name, u.email
             FROM tbl_users u
             JOIN tbl_hospitality_user_mappings hum ON hum.user_id = u.id
            WHERE u.is_deleted = 0
              AND u.status = 1
              AND u.email IS NOT NULL
              AND u.email <> ''
              AND (
                (hum.mapping_type = 1 AND hum.hospitality_hotel_id = $1)
                OR (hum.mapping_type = 0 AND hum.hospitality_company_id = $2)
              )`,
          [rfQItem.hotel_id, rfQItem.hospitality_company_id]
        );
      } catch (buErr) {
        logError('[closeRFQ] Failed to fetch BU members for RFQ ${rfq_id}', buErr);
      }

      // Send heads-up email to all BU members (replaces the legacy vendor-targeted close email).
      sendRfqClosedHeadsUpNotification({
        rfqDetails: {
          id: rfQItem.id,
          rfq_no: rfQItem.rfq_no,
          is_tender: rfQItem.is_tender,
          title: rfQItem.title,
          hotel_name: rfqDetails.hotel_name || null,
          company_name: rfqDetails.company_name || null,
        },
        closedByName: req.user.name,
        users: buMembers.filter(u => String(u.id) !== String(id)),
        closeReason: comment || null,
      });

      // Notify each instance's current approvers that their approval is no longer needed.
      for (const inst of cancelledInstances) {
        if (!inst.approvers || inst.approvers.length === 0) continue;
        sendApprovalCancelledNotification({
          entityType: inst.entity_type,
          entityIdentifier: rfQItem.rfq_no,
          reason: cancelReason,
          approvers: inst.approvers,
          extraContext: { rfq_id: parseInt(rfq_id) },
        });
      }

      // Record lifecycle event (non-blocking — failure shouldn't break close)
      try {
        await recordLifecycleEvent({
          entity_type: entityType,
          entity_id: parseInt(rfq_id),
          stage: 'CLOSED',
          action: 'RFQ_CLOSED',
          performed_by: id,
          metadata: {
            previous_status: 1,
            cancelled_approval_count: cancelledInstances.length,
            cancelled_negotiation_round_count: cancelledRoundCount,
          },
          remarks: comment || null
        });
      } catch (lifecycleErr) {
        logError('Failed to record lifecycle event for closed RFQ ${rfq_id}', lifecycleErr);
      }

      res
        .status(200)
        .json({
          status: 1,
          data: [rfQItem]
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  withdrawPublish: async (req, res, next) => {
    const rfq_id = req.params.id;
    const { id: user_id } = req.user;

    try {
      const rfqDetails = await rfqModel.getRfqDetailsById(rfq_id);
      if (!rfqDetails) {
        return res.status(404).json({ status: 2, message: 'RFQ not found' });
      }
      if (String(rfqDetails.created_by) !== String(user_id)) {
        return res.status(403).json({ status: 0, message: 'Only the RFQ creator can withdraw the publish request' });
      }

      const currentStatus = parseInt(rfqDetails.status);
      if (currentStatus !== 3 && currentStatus !== 4) {
        return res.status(400).json({ status: 0, message: 'RFQ must be in Pending Approval or Ready to Publish status to withdraw' });
      }

      const entityType = rfqDetails.is_tender === 1 ? 'TENDER' : 'RFQ';

      // Update RFQ status to WITHDRAWN (5) and cancel pending approvals
      await db.tx(async t => {
        await t.none(
          'UPDATE tbl_rfq SET status = 5, updated_by = $1 WHERE id = $2',
          [user_id, rfq_id]
        );

        // Cancel any pending approval instances
        const pendingInstances = await t.any(
          `SELECT id FROM tbl_approval_instances
           WHERE entity_type = $1 AND entity_id = $2 AND status = 'PENDING'`,
          [entityType, rfq_id]
        );

        for (const instance of pendingInstances) {
          await t.none(
            `UPDATE tbl_approval_instances
             SET status = 'CANCELLED', completed_at = NOW()
             WHERE id = $1`,
            [instance.id]
          );
          await t.none(
            `UPDATE tbl_approval_instance_steps
             SET status = 'CANCELLED', completed_at = NOW()
             WHERE approval_instance_id = $1 AND status = 'PENDING'`,
            [instance.id]
          );
          await t.none(
            `INSERT INTO tbl_approval_actions
             (approval_instance_id, approver_user_id, action, comment)
             VALUES ($1, $2, 'REJECT', $3)`,
            [instance.id, user_id, '[CANCELLED] Publish request withdrawn by creator']
          );
        }
      });

      // Cancel EventBridge schedule (outside transaction — non-critical)
      try {
        const { removeRfqPublishJob } = await import('../../helper/cronManager.js');
        await removeRfqPublishJob(rfq_id);
      } catch (scheduleErr) {
        logError('Failed to remove publish schedule for RFQ ${rfq_id}', scheduleErr);
      }

      // Record lifecycle event
      await recordLifecycleEvent({
        entity_type: entityType,
        entity_id: parseInt(rfq_id),
        stage: 'WITHDRAWN',
        action: 'PUBLISH_WITHDRAWN',
        performed_by: user_id,
        metadata: { previous_status: currentStatus },
        remarks: 'Publish request withdrawn by creator'
      });

      // Record quote activity for audit trail
      await rfqModel.insertIntoQuoteActivity({
        rfq_id: rfq_id,
        current_status: '5',
        created_by: user_id
      });

      return res.status(200).json({
        status: 1,
        message: 'Publish request withdrawn successfully',
        data: { rfq_id, new_status: 5 }
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message || Config.errorText.value
      });
    }
  },

  terminateRFQ: async (req, res, next) => {
    const rfq_id = req.params.id;
    const { id: user_id } = req.user;

    try {
      const rfqDetails = await rfqModel.getRfqDetailsById(rfq_id);
      if (!rfqDetails) {
        return res.status(404).json({ status: 2, message: 'RFQ not found' });
      }
      if (String(rfqDetails.created_by) !== String(user_id)) {
        return res.status(403).json({ status: 0, message: 'Only the RFQ creator can terminate this RFQ' });
      }

      const currentStatus = parseInt(rfqDetails.status);
      if (currentStatus !== 3 && currentStatus !== 4) {
        return res.status(400).json({ status: 0, message: 'RFQ must be in Pending Approval or Ready to Publish status to terminate' });
      }

      const entityType = rfqDetails.is_tender === 1 ? 'TENDER' : 'RFQ';

      await db.tx(async t => {
        await t.none(
          'UPDATE tbl_rfq SET status = 2, is_published = 0, updated_by = $1 WHERE id = $2',
          [user_id, rfq_id]
        );

        const pendingInstances = await t.any(
          `SELECT id FROM tbl_approval_instances
           WHERE entity_type = $1 AND entity_id = $2 AND status = 'PENDING'`,
          [entityType, rfq_id]
        );

        for (const instance of pendingInstances) {
          await t.none(
            `UPDATE tbl_approval_instances
             SET status = 'CANCELLED', completed_at = NOW()
             WHERE id = $1`,
            [instance.id]
          );
          await t.none(
            `UPDATE tbl_approval_instance_steps
             SET status = 'CANCELLED', completed_at = NOW()
             WHERE approval_instance_id = $1 AND status = 'PENDING'`,
            [instance.id]
          );
          await t.none(
            `INSERT INTO tbl_approval_actions
             (approval_instance_id, approver_user_id, action, comment)
             VALUES ($1, $2, 'REJECT', $3)`,
            [instance.id, user_id, '[CANCELLED] RFQ terminated by creator']
          );
        }
      });

      try {
        const { removeRfqPublishJob } = await import('../../helper/cronManager.js');
        await removeRfqPublishJob(rfq_id);
      } catch (scheduleErr) {
        logError('Failed to remove publish schedule for RFQ ${rfq_id}', scheduleErr);
      }

      await recordLifecycleEvent({
        entity_type: entityType,
        entity_id: parseInt(rfq_id),
        stage: 'TERMINATED',
        action: 'RFQ_TERMINATED',
        performed_by: user_id,
        metadata: { previous_status: currentStatus },
        remarks: 'RFQ terminated by creator'
      });

      await rfqModel.insertIntoQuoteActivity({
        rfq_id: rfq_id,
        current_status: '2',
        created_by: user_id
      });

      return res.status(200).json({
        status: 1,
        message: 'RFQ terminated successfully',
        data: { rfq_id, new_status: 2 }
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message || Config.errorText.value
      });
    }
  },

  /**
   * @description This function sends a reminder to vendors for a specific RFQ. who have not submited the quote for all products.
   * @users can send max 3 reminder in a day, foradmin there are no limit, 1 - admin, 5 subadmin - 6 data entry
   */
  sendReminder: async (req, res, next) => {
    let rfq_id = req.params.id;
    const { organization_name, name, id, email } = req.user;
    const isCurrentUserAdmin = [1, 5, 6].includes(req.user.user_type);

    try {
      // const date = new Date('2024-11-28').toISOString().slice(0, 10);  // Format, YYYY-MM-DD
      const date = new Date().toISOString().slice(0, 10);

      //  if admin then skip this check
      if (!isCurrentUserAdmin) {
        const lastActivity = await rfqModel.getRFQActivity(rfq_id, id, date);
        if (lastActivity?.length > 2) {
          return res
            .status(403)
            .json({
              status: 1,
              message: 'You have already sent a reminder today for this RFQ!'
            })
            .end();
        }
      }

      const rfqBasicDetails = await rfqModel.getRfqDetailsById(rfq_id);

      if (!rfqBasicDetails) {
        return res
          .status(400)
          .json({
            status: 1,
            message: 'RFQ not found, or is no longer available!'
          })
          .end();
      }

      if (rfqBasicDetails.status == '2') {
        return res
          .status(400)
          .json({
            status: 1,
            message: 'Cannot send reminder for a closed RFQ!'
          })
          .end();
      }

      const reminderData = await rfqModel.getVendorsForReminder(
        rfq_id,
        [],
        { includeContactDetails: true }
      );

      if (!reminderData.rfq_details) {
        return res
          .status(400)
          .json({
            status: 1,
            message: 'RFQ not found, or is no longer available!'
          })
          .end();
      }

      const vendors = reminderData.vendors || [];

      if (!vendors.length) {
        return res
          .status(400)
          .json({
            status: 1,
            message: 'All vendors have already submitted their quotes!'
          })
          .end();
      }

      await hydrateReminderTokens(vendors, rfq_id);

      const org_name =
        rfqBasicDetails?.company_name || organization_name || name || '';

      await dispatchReminderSequence(
        vendors,
        org_name,
        rfq_id,
        rfqBasicDetails
      );

      await rfqModel.insertRFQActivity(rfq_id, id);

      res
        .status(200)
        .json({
          status: 1,
          message: 'Reminder has been sent successfully!'
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  /**
   * @description Get vendors who haven't submitted quotes for a specific RFQ
   */
  getVendorsForReminder: async (req, res, next) => {
    let rfq_id = req.params.id;

    try {
      const result = await rfqModel.getVendorsForReminder(rfq_id, [], {
        includeContactDetails: false
      });

      if (!result.rfq_details) {
        return res
          .status(400)
          .json({
            status: 1,
            message: 'RFQ not found, or is no longer available!'
          })
          .end();
      }

      if (result.rfq_details.status == '2') {
        return res
          .status(400)
          .json({
            status: 1,
            message: 'Cannot get vendors for a closed RFQ!'
          })
          .end();
      }

      return res
        .status(200)
        .json({
          status: 1,
          vendor_count: (result.vendors || []).length
        })
        .end();
    } catch (error) {
      logError(error);
      return res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  /**
   * @description Send reminder to selected vendors for a specific RFQ
   */
  sendSelectiveReminder: async (req, res, next) => {
    let rfq_id = req.params.id;
    const { vendor_ids } = req.body;
    const { id } = req.user;

    try {
      // If vendor_ids not provided, send to all pending vendors
      const filterIds = Array.isArray(vendor_ids) && vendor_ids.length > 0 ? vendor_ids : [];

      const result = await rfqModel.getVendorsForReminder(
        rfq_id,
        filterIds,
        { includeContactDetails: true }
      );

      if (!result.rfq_details) {
        return res
          .status(400)
          .json({
            status: 1,
            message: 'RFQ not found, or is no longer available!'
          })
          .end();
      }

      if (result.rfq_details.status == '2') {
        return res
          .status(400)
          .json({
            status: 1,
            message: 'Cannot send reminder for a closed RFQ!'
          })
          .end();
      }

      const selectedVendors = result.vendors || [];

      if (selectedVendors.length === 0) {
        return res
          .status(400)
          .json({
            status: 1,
            message: 'No valid vendors found for the selected IDs!'
          })
          .end();
      }

      await hydrateReminderTokens(selectedVendors, rfq_id);

      const org_name =
        result.rfq_details.company_name || req.user.organization_name || '';

      await dispatchReminderSequence(
        selectedVendors,
        org_name,
        rfq_id,
        result.rfq_details
      );

      await rfqModel.insertRFQActivity(rfq_id, id);

      res
        .status(200)
        .json({
          status: 1,
          message: 'Reminder has been sent successfully to selected vendors!'
        })
        .end();
    } catch (error) {
      logError(error);
      return res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  getExistingPO: async (req, res) => {
    try {
      const { vendor_id, rfq_id } = req.query;
      const user = req.user;

      const existingPOS = await rfqModel.getDraftPOByVendor(vendor_id, rfq_id, user);

      return res.json({
        status: 1, 
        existingPOS
      })
    } catch (error) {
      logError(error);
      res.status(400).json({
        status: 3,
        message: "Error fetching existing PO"
      });
    }
  },

  finalize: async (req, res, next) => {
    const { product_variant_id, vendor_id, rfq_id, rfq_no, quote_id, quote_item_id, variant, route_type, comment } =
      req.body;
    const trimmedComment = typeof comment === 'string' ? comment.trim() : '';
    
    // Default to PO route for non-hospitality RFQs, route_type for hospitality
    const selectedRoute = route_type || 'PO';

    try {
      // Check for active negotiation round blocking finalization
      const rfqProductForNego = await db.oneOrNone(
        `SELECT id FROM tbl_rfq_products WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3`,
        [rfq_id, product_variant_id, variant]
      );
      if (rfqProductForNego) {
        const activeNegotiationRound = await db.oneOrNone(
          `SELECT id FROM tbl_negotiation_rounds
           WHERE rfq_id = $1 AND rfq_product_id = $2 AND status = 'ACTIVE' AND end_date > NOW()`,
          [rfq_id, rfqProductForNego.id]
        );
        if (activeNegotiationRound) {
          return res.status(400).json({
            status: 2,
            message: 'An active negotiation round is ongoing for this product. Vendor finalization is restricted until the round ends.'
          });
        }
      }

      const vendor_details = await userModel.user_profile_detail(vendor_id);
      const rfQItem = await rfqModel.getRfqById(rfq_id, vendor_id);
      let winning_product = null;
      let winning_vendor_organization = null;
      let winning_vendor_email = null;
      let winning_vendor_name = null;

      if (vendor_details.length > 0) {
        winning_vendor_organization =
          vendor_details[0]?.organization_name ??
          vendor_details[0]?.company_name;
        winning_vendor_email = vendor_details[0].email;
        winning_vendor_name = vendor_details[0].name;
      }
      if (rfQItem.length > 0 && rfQItem[0].products.length > 0) {
        winning_product = rfQItem[0].products.filter(
          (p) => p.product_id == product_variant_id && p.variant == variant
        );
      }

      if (
        winning_product &&
        winning_vendor_organization &&
        winning_vendor_email
      ) {
        // changes by Mukul Jatav 30-08-2024
        // removed  AND quote_id=${quote_id} condition from query,
        // return 09 Conflict status code if vendor already exist for same product + variant,

        const response = await db.tx(async (t) => {
          // const userInHierarchy = t.oneOrNone(
          //   `SELECT * FROM tbl_approval_hierarchy
          //   WHERE company_id = $1 AND user_id = $2 AND hierarchy_type = $3 AND is_active = true`,
          //   [req.user.company_id, req.user.id, 'po']
          // );

          // if(!userInHierarchy) 
          //   return res
          //     .status(400)
          //     .json({
          //       status: 3,
          //       message:
          //         'Failed to finalize a vendor as you are not the part of your company\'s approval hierarchy!'
          //     })
          //     .end();

          const isFinalApprover = await t.oneOrNone(
            `SELECT * FROM tbl_approval_hierarchy
            WHERE company_id = $1 AND user_id = $2 AND hierarchy_type = $3 AND approval_level = -1`,
            [req.user.company_id, req.user.id, 'po']
          );

          if(isFinalApprover) 
            throw new Error('Failed to finalize a vendor as you are not the part of your company\'s approval hierarchy!')

          const isEligibleInHierarcy = await t.oneOrNone(
            `SELECT 1
              FROM tbl_approval_hierarchy
              WHERE company_id = $1
                AND user_id = $2 
                AND hierarchy_type = $3
              UNION
              SELECT 1
              WHERE NOT EXISTS (
                SELECT 1
                FROM tbl_approval_hierarchy
                WHERE company_id = $1
              )`,
            [req.user.company_id, req.user.id, 'po']
          );

          if(!isEligibleInHierarcy)
            throw new Error('Failed to finalize a vendor, as you don\'t belong to the company\'s approval hierarchy!')

          // Check if THIS SPECIFIC VENDOR is already finalized for this product
          // Multiple vendors can be finalized for the same product
          let sameVendorExists = await rfqModel.checkIfExists(
            'tbl_quote_finalization',
            `rfq_id=${rfq_id} AND product_variant_id=${product_variant_id} AND variant=${variant} AND vendor_id=${vendor_id} LIMIT 1`,
            t
          );

          let reFinalized = false;

          // Only replace if same vendor is being finalized again (re-finalization)
          if (sameVendorExists.length > 0) {
            const existingFinalization = sameVendorExists[0];

            const history_data = {
              rfq_id: existingFinalization.rfq_id,
              rfq_no: existingFinalization.rfq_no,
              product_variant_id: existingFinalization.product_variant_id,
              vendor_id: existingFinalization.vendor_id,
              quote_id: existingFinalization.quote_id,
              created_by: existingFinalization.created_by,
              timestamp: existingFinalization.timestamp,
              variant: existingFinalization.variant,
              changed_by: req.user.id,
              comment: existingFinalization.comment || null
            };

            await rfqModel.insert(
              'tbl_quote_finalization_history',
              history_data,
              t
            );
            await rfqModel.delete(
              'tbl_quote_finalization',
              {
                id: existingFinalization.id
              },
              t
            );
            reFinalized = true;
          }

          const tbl_quote_finalization_data = {
            rfq_id,
            rfq_no,
            product_variant_id,
            vendor_id,
            quote_id,
            created_by: req.user.id,
            variant,
            comment: trimmedComment
          };

          const response = await rfqModel.insert(
            'tbl_quote_finalization',
            tbl_quote_finalization_data,
            t
          );

          const vendorNonLoginRfqAccessToken = await rfqModel.getVendorRfqToken(
            vendor_id,
            rfq_id
          );
          
          await userModel.mapBuyerToVendor(req.user.id, vendor_id);
          
          let result = null;
          let arcApprovalCreated = false;
          let negotiationQuoteApprovalPending = false;

          // Route-based logic: PO route creates PO draft, ARC route skips PO
          if (selectedRoute === 'PO') {
            // Check if NEGOTIATION_QUOTE approval policy exists for this RFQ
            let approvalTriggered = false;
            try {
              const rfqData = await rfqModel.getRfqWithHospitalityDetails(rfq_id, t);
              if (rfqData && rfqData.hospitality_company_id) {
                const rfqProduct = await rfqModel.getRfqProductByVariant(rfq_id, product_variant_id, variant, t);
                if (rfqProduct) {
                  // Check for existing pending NEGOTIATION_QUOTE approval
                  const existingApprovals = await getApprovalInstancesByEntity('NEGOTIATION_QUOTE', rfqProduct.id, t);
                  const existingPending = existingApprovals.find(inst => inst.status === 'PENDING');

                  if (existingPending) {
                    const existingPendingState = await t.one(`
                      SELECT COUNT(sa.id)::int AS approver_count
                      FROM tbl_approval_instances ai
                      LEFT JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id
                      LEFT JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = ais.id
                      WHERE ai.id = $1
                    `, [existingPending.id]);

                    if (existingPendingState.approver_count === 0) {
                      throw new Error('A pending quote approval exists in an invalid state with no approvers. Purchase Order draft has been aborted.');
                    }

                    // An approval is already in flight for this product, so do not
                    // draft a PO or attempt to create another approval instance.
                    approvalTriggered = true;
                    negotiationQuoteApprovalPending = true;
                  } else {
                    // Try to create NEGOTIATION_QUOTE approval instance
                    // Note: createApprovalInstance allows re-approval for NEGOTIATION_QUOTE,
                    // so old APPROVED instances are preserved as historical records.
                    const approvalResult = await createApprovalInstance({
                      entity_type: 'NEGOTIATION_QUOTE',
                      entity_id: rfqProduct.id,
                      hospitality_company_id: rfqData.hospitality_company_id,
                      hotel_id: rfqData.hotel_id || null,
                      department_id: rfqData.department_id || null,
                      process_id: rfqData.process_id || null,
                      initiated_by: req.user.id,
                      metadata: {
                        rfq_id,
                        rfq_number: rfq_no,
                        rfq_title: rfqData.title || '',
                        rfq_product_id: rfqProduct.id,
                        is_tender: rfqData.is_tender || 0,
                        product_variant_id,
                        variant,
                        vendor_id,
                        quote_id,
                        quote_item_id,
                        finalization_comment: trimmedComment || null,
                        po_payload: { ...req.body, quote_id: quote_item_id },
                        po_user: { id: req.user.id, company_id: req.user.company_id }
                      },
                      txContext: t
                    });

                    if (approvalResult && !approvalResult.autoApproved) {
                      // Approval is pending - do NOT create PO yet
                      approvalTriggered = true;
                      negotiationQuoteApprovalPending = true;

                      await recordLifecycleEvent({
                        entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
                        entity_id: rfq_id,
                        stage: 'NEGOTIATION_QUOTES_SUBMITTED',
                        action: 'SUBMIT_FOR_APPROVAL',
                        performed_by: req.user.id,
                        metadata: {
                          rfq_product_id: rfqProduct.id,
                          approval_instance_id: approvalResult.instance?.id,
                          vendor_id,
                          quote_id
                        },
                        remarks: null,
                        txContext: t
                      });
                    } else if (approvalResult && approvalResult.autoApproved) {
                      // Auto-approved (no approvers or creator-only) - create PO immediately
                      const authPayload = await buildAuthoritativePOPayload({...req.body, quote_id: quote_item_id}, t);
                      result = await draftPO(authPayload, req.user, t);
                      approvalTriggered = true;
                    }
                  }
                }
              }
            } catch (approvalError) {
              // If no policy is configured, direct PO creation is allowed.
              // Any other approval error must abort the transaction to avoid
              // committing a PO alongside a partial approval record.
              if (approvalError.message?.includes('No approval policy found')) {
                approvalTriggered = false;
              } else {
                logError('Error checking NEGOTIATION_QUOTE approval', approvalError);
                throw approvalError;
              }
            }

            // Fallback: if no approval was triggered, create PO directly
            if (!approvalTriggered) {
              const authPayload = await buildAuthoritativePOPayload({...req.body, quote_id: quote_item_id}, t);
              result = await draftPO(authPayload, req.user, t);
            }
          }
          
          // Vendor finalization email removed — PO approval email already notifies the vendor
          // with full PO details and document attachment, making a separate finalization email redundant.

          if (reFinalized) {
            const lostVendorDetails = await userModel.user_profile_detail(
              vendor_id
            );
            const lostVendorOrganization =
              lostVendorDetails[0]?.organization_name ??
              lostVendorDetails[0]?.company_name;
            const lostVendorEmail = lostVendorDetails[0].email;
            const lostVendorName = lostVendorDetails[0].name;

            await sendFinalizationRemovalMail(
              sameVendorExists[0]?.vendor_id || vendor_id,
              rfQItem,
              winning_product,
              lostVendorOrganization,
              lostVendorEmail,
              lostVendorName
            );
          }

          // Record lifecycle event for vendor finalization
          await recordLifecycleEvent({
            entity_type: 'RFQ',
            entity_id: rfq_id,
            stage: 'VENDOR_FINALIZED',
            action: 'FINALIZE',
            performed_by: req.user.id,
            metadata: {
              product_variant_id,
              vendor_id,
              quote_id,
              variant,
              reFinalized,
              route_type: selectedRoute
            },
            remarks: null
          });

          // ARC Route: Create ARC approval immediately for this product (TENDER ONLY)
          if (selectedRoute === 'ARC') {
            try {
              // Get RFQ details using model
              const rfqData = await rfqModel.getRfqWithHospitalityDetails(rfq_id, t);
              
              // VALIDATION: ARC is only applicable for tenders (is_tender = 1)
              if (!rfqData || rfqData.is_tender !== 1) {
                throw new Error('ARC approval is only applicable for tenders (is_tender = 1). This RFQ is not a tender.');
              }
              
              // VALIDATION: Must be hospitality RFQ
              if (!rfqData.hospitality_company_id) {
                throw new Error('ARC approval is only available for hospitality RFQs/Tenders');
              }
              
              // Get rfq_product_id using model
              const rfqProduct = await rfqModel.getRfqProductByVariant(rfq_id, product_variant_id, variant, t);
              
              if (!rfqProduct) {
                throw new Error('RFQ product not found');
              }
              
              const rfqProductId = rfqProduct.id;
              
              // Check if ARC approval already exists for this product using model
              const existingArcApprovals = await getApprovalInstancesByEntity('ARC', rfqProductId, t);
              const existingArcApproval = existingArcApprovals.find(inst => 
                inst.status === 'PENDING' || inst.status === 'APPROVED'
              );
              
              if (existingArcApproval) {
                // ARC approval already exists for this product
                logger.debug('ARC approval already exists for product ${rfqProductId}');
                arcApprovalCreated = true;
              } else {
                // Create ARC approval instance for this product
                const arcApprovalResult = await createApprovalInstance({
                  entity_type: 'ARC',
                  entity_id: rfqProductId, // Product-level, not RFQ-level
                  hospitality_company_id: rfqData.hospitality_company_id,
                  hotel_id: rfqData.hotel_id || null,
                  department_id: rfqData.department_id || null,
                  process_id: rfqData.process_id || null,
                  initiated_by: req.user.id,
                  metadata: {
                    rfq_id: rfq_id,
                    rfq_product_id: rfqProductId,
                    rfq_number: rfq_no,
                    product_variant_id: product_variant_id,
                    variant: variant,
                    vendor_id: vendor_id,
                    quote_id: quote_id,
                    is_tender: rfqData.is_tender,
                    company_name: rfqData.company_name,
                    triggered_by: 'product_finalization',
                    finalization_comment: trimmedComment || null
                  },
                  txContext: t
                });
                
                if (arcApprovalResult) {
                  arcApprovalCreated = true;
                  // Record lifecycle event for ARC submission
                  await recordLifecycleEvent({
                    entity_type: 'TENDER', // Always TENDER for ARC
                    entity_id: rfq_id,
                    stage: 'ARC_SUBMITTED',
                    action: 'SUBMIT_ARC',
                    performed_by: req.user.id,
                    metadata: {
                      rfq_product_id: rfqProductId,
                      approval_instance_id: arcApprovalResult.instance?.id,
                      auto_approved: arcApprovalResult.autoApproved || false
                    },
                    remarks: null,
                    txContext: t
                  });
                }
              }
            } catch (arcError) {
              // Log error but don't fail the finalization
              logError('Error creating ARC approval instance', arcError);
              // Try to get rfq_product_id using model
              let rfqProductIdForError = null;
              try {
                const rfqProduct = await rfqModel.getRfqProductByVariant(rfq_id, product_variant_id, variant, t);
                rfqProductIdForError = rfqProduct?.id || null;
              } catch (e) {
                // Ignore error getting product ID
              }
              
              await recordLifecycleEvent({
                entity_type: 'TENDER',
                entity_id: rfq_id,
                stage: 'ARC_SUBMISSION_FAILED',
                action: 'SUBMIT_ARC',
                performed_by: req.user.id,
                metadata: {
                  error: arcError.message,
                  rfq_product_id: rfqProductIdForError,
                  product_variant_id: product_variant_id,
                  variant: variant
                },
                remarks: arcError.message,
                txContext: t
              });
            }
          }

          return {
            reFinalized,
            result,
            arcApprovalCreated,
            negotiationQuoteApprovalPending,
            route_type: selectedRoute
          };
        });

      // 👇 Check if an entry already exists
      //Record the finalization activity with status 'FIN'
      const existingActivity = await rfqModel.checkIfExists(
        'tbl_quote_activity',
        `rfq_id = ${rfq_id} AND current_status = 'FIN' AND created_by = ${req.user.id}`
      );
      logger.debug({ data: existingActivity }, 'Existing activity check');
      if (existingActivity.length === 0) {
        const insertIntoQuoteActivity = await rfqModel.insertIntoQuoteActivity({
          rfq_id: rfq_id,
          current_status: "FIN",
          created_by: req.user.id
        });
        logger.debug({ data: insertIntoQuoteActivity }, 'Inserted value into quote activity');
      } else {
        logger.debug('Skipped insert - already exists for rfq_id ${rfq_id} and user ${req.user.id}');
      }

        // If NEGOTIATION_QUOTE approval is pending, return appropriate message
        if (response.negotiationQuoteApprovalPending) {
          return res.status(200).json({
            status: 1,
            message: 'Vendor finalized! Approval is required before Purchase Order can be created.',
            data: response.result,
            isRefinalized: response.reFinalized,
            approvalPending: true
          });
        }

        return res.status(200).json({
          status: 1,
          message: 'A Purchase Order has been drafted successfully',
          data: response.result,
          isRefinalized: response.reFinalized
        });
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message:
              'Required fields are not present for vendors, aborting finalization.'
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: error.message ?? Config.errorText.value,
          error
        })
        .end();
    }
  },
  searchProduct: async (req, res, next) => {
    const search_key = req.body?.search_key || '';
    const category_id = req.body?.category_id || '';
    const approved_by_id = req.body?.approved_by_id || '';
    const hotel_ids = req.body?.hotel_ids || [];

    try {
      const productResult = await rfqModel.searchProduct(
        search_key,
        category_id,
        approved_by_id,
        {},
        hotel_ids
      );
      const categoryResult = await rfqModel.getCategoryList(search_key);

      // record product search
      try {
        const searchedData = [
          { product_slug: search_key, user_id: null }
        ];
        await generalModel.insertMany('product_search_record', searchedData);
      } catch (error) {
        logger.debug({ data: error.message }, 'Product search record table not available');
      }

      res.status(200).json({
        status: 1,
        data: removeDuplicates(productResult),
        categoryData: categoryResult
      });
    } catch (error) {
      logError(error);
      res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
    }
  },
  searchProductByCategory: async (req, res, next) => {
    try {
      const category_id = req.body?.category_id ? req.body?.category_id : '';

      const subCategoryList = await rfqModel.getSubcategories(category_id);

      if (!subCategoryList || subCategoryList?.length == 0) {
        return res
          .status(404)
          .json({
            status: 3,
            message: 'Products Not Found for the requested category',
            subCategoryList: subCategoryList
          })
          .end();
      }

      const productList = await rfqModel.getProductsByCategories(
        subCategoryList
      );

      res
        .status(200)
        .json({
          status: 1,
          productList: productList,
          totalProduct: productList.length,
          subCategoryList: subCategoryList,
          totalCategory: subCategoryList.length
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  bulkSearchVendorsByCategory: async (req, res, next) => {
    try {
      const {
        category_id,
        approved_by_id = [],
        state = [],
        city = [],
        country = [],
        turnOver = null,
        vendorType = [],
        prevWorkedWith = null,
        vendor_name = '',
        myVendorType = null,
        productMakes = [],
        subscriptionType = null,
        page = 1,
        limit = 20
      } = req.body;

      if (!category_id) {
        return res.status(400).json({
          status: 0,
          message: 'category_id is required'
        });
      }

      const user_id = req.is_verified ? req.user?.id : null;

      const result = await rfqModel.bulkSearchVendorsByCategory(
        category_id,
        approved_by_id,
        state,
        city,
        country,
        turnOver,
        vendorType,
        prevWorkedWith,
        vendor_name,
        myVendorType,
        productMakes,
        subscriptionType,
        page,
        limit,
        user_id
      );

      return res.status(200).json({
        status: 1,
        data: result.data,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
        logged_In: !!req.is_verified,
        subscription: true
      });

    } catch (error) {
      logError('Error in bulkSearchVendorsByCategory', error);
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'An error occurred while searching for vendors',
        error: error.message
      });
    }
  },

  /**
   * 
   * @last_changes - mukul 28-08-2025 without login senf 2 vendors details
   */
  searchVendor: async (req, res, next) => {
    // Extracting parameters from the request

    // const { search_key, category_id, approved_by_id, state, city } = req.query;
    let search_key = '';
    let category_id = '';
    let approved_by_id = '';
    let state = '';
    let city = '';
    let country = '';
    let turnOver = null;
    let vendorType = '';
    let prevWorkedWith = '';
    let myVendorType = '';
    let subscriptionType = null;

    const productMakes = req.body?.productMakes || [];
    search_key = req.body?.search_key ? req.body?.search_key : '';
    category_id = req.body?.category_id ? req.body?.category_id : '';
    approved_by_id = req.body?.approved_by_id ? req.body?.approved_by_id : '';
    state = req.body?.state ? req.body?.state : '';
    city = req.body?.city ? req.body?.city : '';
    country = req.body?.country ? req.body?.country : '';
    turnOver = req.body?.turnOver ? req.body?.turnOver : null;
    vendorType = req.body?.vendorType ? req.body?.vendorType : '';
    prevWorkedWith = req.body?.prevWorkedWith ? req.body?.prevWorkedWith : '';
    myVendorType = req.body?.myVendorType ? req.body?.myVendorType : '';
    subscriptionType = req.body?.subscriptionType ? req.body?.subscriptionType : null;
    let vendor_name = req.body.vendor_name;

    // If user is not logged in
    if (!req.is_verified) {
      try {
        // Call the searchVendor method
        const vendorResult = await rfqModel.searchVendorWithoutLogin(
          search_key,
          category_id,
          approved_by_id,
          state,
          city,
          country,
          turnOver,
          vendorType,
          prevWorkedWith
        );
        // console.log(vendorResult);

        // Check if vendorResult is not empty and has the expected structure
        if (vendorResult && vendorResult.total && vendorResult.vendor) {
          const totalCount = vendorResult.total; // Second query result: total count

          // Send the response with the vendor data and the total count
          return res.status(200).json({
            status: 1,
            data: vendorResult.vendor,
            total: totalCount,
            logged_In: false,
            subscription: false
          });
        } else {
          // No data found
          res.status(404).json({
            status: 0,
            data: [],
            total: 0,
            message: 'No vendor found matching the criteria',
            logged_In: false,
            subscription: false
          });
        }
      } catch (error) {
        logError('Error in searchVendorController', error);
        logError(error);
        // Error handling and response
        res.status(500).json({
          success: false,
          message: 'An error occurred while searching for the vendor',
          error: error.message
        });
      }
    } else {
      // if user is  logged!
      let user = req.user;
      if (user && user.user_type != 3) {
        try {
          const vendorResult = await rfqModel.searchVendor(
            req.user.id,
            search_key,
            category_id,
            approved_by_id,
            state,
            city,
            country,
            turnOver,
            vendorType,
            prevWorkedWith,
            vendor_name,
            myVendorType,
            subscriptionType,
            '', // responseKeys : function accepting this - need to recheck it's use and remove it if not required
            productMakes
          );

          // ---- Return 404 if nothing found ----
         if (!vendorResult || vendorResult.length === 0) {
           return res.status(404).json({
             status: 0,
             data: [],
             total: 0,
             message: 'No vendor found matching the criteria',
             logged_In: true,
             subscription: !!user.subscription_plan_id
           });
         }

          let items_to_show = 1;
          let total_items = vendorResult.length;
          let rest_items = 0;
          let items_to_sent = vendorResult;

          if (!user.subscription_plan_id) {
            rest_items =
              total_items > items_to_show ? total_items - items_to_show : 0;
            items_to_sent = vendorResult.slice(0, items_to_show);

            Promise.all(
              items_to_sent.map((item) => getVendorDetails(item, false))
            )
              .then((result) => {
                shuffleArray(result);
                Array.apply(null, { length: rest_items }).map((item) => {});

                res
                  .status(200)
                  .json({
                    status: 1,
                    data: result,
                    subscription: false,
                    logged_In: true,
                    total: total_items
                  })
                  .end();
              })
              .catch((error) => {
                logError('Error inserting data', error);
              });
          } else {
            Promise.all(
              vendorResult.map((item) => getVendorDetails(item, true))
            )
              .then((result) => {
                // shuffleArray(result);
                res
                  .status(200)
                  .json({
                    status: 1,
                    data: result,
                    logged_In: true,
                    subscription: true
                  })
                  .end();
              })
              .catch((error) => {
                logError('Error inserting data', error);
              });
          }
        } catch (error) {
          logError(error);
          res
            .status(400)
            .json({
              status: 3,
              message: Config.errorText.value
            })
            .end();
        }
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: "You don't have permission to perform this action!"
          })
          .end();
      }
    }
  },

  vendorTypes: async (req, res) => {
    try {
      const result = await rfqModel.fetchVendorTypes();
      return res.status(200).json({
        status: 1,
        data: result?.[0]?.nature_of_business_options ?? []
      });
    } catch (error) {
      logError(error);
      // Error handling and response
      res.status(500).json({
        success: false,
        message: 'An error occurred while fetching vendor types',
        error: error.message
      });
    }
  },

  getPastRFQs: async (req, res, next) => {
    let vendor_id = req.params.id;
    const { id } = req.user;

    try {
      const pastRFQS = await rfqModel.getPastRFQS(vendor_id, id);

      res
        .status(200)
        .json({
          status: 1,
          data: pastRFQS
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  saveStateCities: async (req, res, next) => {
    const data = {
      'Andaman and Nicobar Islands': ['Port Blair'],
      Haryana: [
        'Faridabad',
        'Gurgaon',
        'Hisar',
        'Rohtak',
        'Panipat',
        'Karnal',
        'Sonipat',
        'Yamunanagar',
        'Panchkula',
        'Bhiwani',
        'Bahadurgarh',
        'Jind',
        'Sirsa',
        'Thanesar',
        'Kaithal',
        'Palwal',
        'Rewari',
        'Hansi',
        'Narnaul',
        'Fatehabad',
        'Gohana',
        'Tohana',
        'Narwana',
        'Mandi Dabwali',
        'Charkhi Dadri',
        'Shahbad',
        'Pehowa',
        'Samalkha',
        'Pinjore',
        'Ladwa',
        'Sohna',
        'Safidon',
        'Taraori',
        'Mahendragarh',
        'Ratia',
        'Rania',
        'Sarsod'
      ],
      'Tamil Nadu': [
        'Chennai',
        'Coimbatore',
        'Madurai',
        'Tiruchirappalli',
        'Salem',
        'Tirunelveli',
        'Tiruppur',
        'Ranipet',
        'Nagercoil',
        'Thanjavur',
        'Vellore',
        'Kancheepuram',
        'Erode',
        'Tiruvannamalai',
        'Pollachi',
        'Rajapalayam',
        'Sivakasi',
        'Pudukkottai',
        'Neyveli (TS)',
        'Nagapattinam',
        'Viluppuram',
        'Tiruchengode',
        'Vaniyambadi',
        'Theni Allinagaram',
        'Udhagamandalam',
        'Aruppukkottai',
        'Paramakudi',
        'Arakkonam',
        'Virudhachalam',
        'Srivilliputhur',
        'Tindivanam',
        'Virudhunagar',
        'Karur',
        'Valparai',
        'Sankarankovil',
        'Tenkasi',
        'Palani',
        'Pattukkottai',
        'Tirupathur',
        'Ramanathapuram',
        'Udumalaipettai',
        'Gobichettipalayam',
        'Thiruvarur',
        'Thiruvallur',
        'Panruti',
        'Namakkal',
        'Thirumangalam',
        'Vikramasingapuram',
        'Nellikuppam',
        'Rasipuram',
        'Tiruttani',
        'Nandivaram-Guduvancheri',
        'Periyakulam',
        'Pernampattu',
        'Vellakoil',
        'Sivaganga',
        'Vadalur',
        'Rameshwaram',
        'Tiruvethipuram',
        'Perambalur',
        'Usilampatti',
        'Vedaranyam',
        'Sathyamangalam',
        'Puliyankudi',
        'Nanjikottai',
        'Thuraiyur',
        'Sirkali',
        'Tiruchendur',
        'Periyasemur',
        'Sattur',
        'Vandavasi',
        'Tharamangalam',
        'Tirukkoyilur',
        'Oddanchatram',
        'Palladam',
        'Vadakkuvalliyur',
        'Tirukalukundram',
        'Uthamapalayam',
        'Surandai',
        'Sankari',
        'Shenkottai',
        'Vadipatti',
        'Sholingur',
        'Tirupathur',
        'Manachanallur',
        'Viswanatham',
        'Polur',
        'Panagudi',
        'Uthiramerur',
        'Thiruthuraipoondi',
        'Pallapatti',
        'Ponneri',
        'Lalgudi',
        'Natham',
        'Unnamalaikadai',
        'P.N.Patti',
        'Tharangambadi',
        'Tittakudi',
        'Pacode',
        "O' Valley",
        'Suriyampalayam',
        'Sholavandan',
        'Thammampatti',
        'Namagiripettai',
        'Peravurani',
        'Parangipettai',
        'Pudupattinam',
        'Pallikonda',
        'Sivagiri',
        'Punjaipugalur',
        'Padmanabhapuram',
        'Thirupuvanam'
      ],
      'Madhya Pradesh': [
        'Indore',
        'Bhopal',
        'Jabalpur',
        'Gwalior',
        'Ujjain',
        'Sagar',
        'Ratlam',
        'Satna',
        'Murwara (Katni)',
        'Morena',
        'Singrauli',
        'Rewa',
        'Vidisha',
        'Ganjbasoda',
        'Shivpuri',
        'Mandsaur',
        'Neemuch',
        'Nagda',
        'Itarsi',
        'Sarni',
        'Sehore',
        'Mhow Cantonment',
        'Seoni',
        'Balaghat',
        'Ashok Nagar',
        'Tikamgarh',
        'Shahdol',
        'Pithampur',
        'Alirajpur',
        'Mandla',
        'Sheopur',
        'Shajapur',
        'Panna',
        'Raghogarh-Vijaypur',
        'Sendhwa',
        'Sidhi',
        'Pipariya',
        'Shujalpur',
        'Sironj',
        'Pandhurna',
        'Nowgong',
        'Mandideep',
        'Sihora',
        'Raisen',
        'Lahar',
        'Maihar',
        'Sanawad',
        'Sabalgarh',
        'Umaria',
        'Porsa',
        'Narsinghgarh',
        'Malaj Khand',
        'Sarangpur',
        'Mundi',
        'Nepanagar',
        'Pasan',
        'Mahidpur',
        'Seoni-Malwa',
        'Rehli',
        'Manawar',
        'Rahatgarh',
        'Panagar',
        'Wara Seoni',
        'Tarana',
        'Sausar',
        'Rajgarh',
        'Niwari',
        'Mauganj',
        'Manasa',
        'Nainpur',
        'Prithvipur',
        'Sohagpur',
        'Nowrozabad (Khodargama)',
        'Shamgarh',
        'Maharajpur',
        'Multai',
        'Pali',
        'Pachore',
        'Rau',
        'Mhowgaon',
        'Vijaypur',
        'Narsinghgarh'
      ],
      Jharkhand: [
        'Dhanbad',
        'Ranchi',
        'Jamshedpur',
        'Bokaro Steel City',
        'Deoghar',
        'Phusro',
        'Adityapur',
        'Hazaribag',
        'Giridih',
        'Ramgarh',
        'Jhumri Tilaiya',
        'Saunda',
        'Sahibganj',
        'Medininagar (Daltonganj)',
        'Chaibasa',
        'Chatra',
        'Gumia',
        'Dumka',
        'Madhupur',
        'Chirkunda',
        'Pakaur',
        'Simdega',
        'Musabani',
        'Mihijam',
        'Patratu',
        'Lohardaga',
        'Tenu dam-cum-Kathhara'
      ],
      Mizoram: ['Aizawl', 'Lunglei', 'Saiha'],
      Nagaland: [
        'Dimapur',
        'Kohima',
        'Zunheboto',
        'Tuensang',
        'Wokha',
        'Mokokchung'
      ],
      'Himachal Pradesh': [
        'Shimla',
        'Mandi',
        'Solan',
        'Nahan',
        'Sundarnagar',
        'Palampur',
        'Kullu'
      ],
      Tripura: [
        'Agartala',
        'Udaipur',
        'Dharmanagar',
        'Pratapgarh',
        'Kailasahar',
        'Belonia',
        'Khowai'
      ],
      'Andhra Pradesh': [
        'Visakhapatnam',
        'Vijayawada',
        'Guntur',
        'Nellore',
        'Kurnool',
        'Rajahmundry',
        'Kakinada',
        'Tirupati',
        'Anantapur',
        'Kadapa',
        'Vizianagaram',
        'Eluru',
        'Ongole',
        'Nandyal',
        'Machilipatnam',
        'Adoni',
        'Tenali',
        'Chittoor',
        'Hindupur',
        'Proddatur',
        'Bhimavaram',
        'Madanapalle',
        'Guntakal',
        'Dharmavaram',
        'Gudivada',
        'Srikakulam',
        'Narasaraopet',
        'Rajampet',
        'Tadpatri',
        'Tadepalligudem',
        'Chilakaluripet',
        'Yemmiganur',
        'Kadiri',
        'Chirala',
        'Anakapalle',
        'Kavali',
        'Palacole',
        'Sullurpeta',
        'Tanuku',
        'Rayachoti',
        'Srikalahasti',
        'Bapatla',
        'Naidupet',
        'Nagari',
        'Gudur',
        'Vinukonda',
        'Narasapuram',
        'Nuzvid',
        'Markapur',
        'Ponnur',
        'Kandukur',
        'Bobbili',
        'Rayadurg',
        'Samalkot',
        'Jaggaiahpet',
        'Tuni',
        'Amalapuram',
        'Bheemunipatnam',
        'Venkatagiri',
        'Sattenapalle',
        'Pithapuram',
        'Palasa Kasibugga',
        'Parvathipuram',
        'Macherla',
        'Gooty',
        'Salur',
        'Mandapeta',
        'Jammalamadugu',
        'Peddapuram',
        'Punganur',
        'Nidadavole',
        'Repalle',
        'Ramachandrapuram',
        'Kovvur',
        'Tiruvuru',
        'Uravakonda',
        'Narsipatnam',
        'Yerraguntla',
        'Pedana',
        'Puttur',
        'Renigunta',
        'Rajam',
        'Srisailam Project (Right Flank Colony) Township'
      ],
      Punjab: [
        'Ludhiana',
        'Patiala',
        'Amritsar',
        'Jalandhar',
        'Bathinda',
        'Pathankot',
        'Hoshiarpur',
        'Batala',
        'Moga',
        'Malerkotla',
        'Khanna',
        'Mohali',
        'Barnala',
        'Firozpur',
        'Phagwara',
        'Kapurthala',
        'Zirakpur',
        'Kot Kapura',
        'Faridkot',
        'Muktsar',
        'Rajpura',
        'Sangrur',
        'Fazilka',
        'Gurdaspur',
        'Kharar',
        'Gobindgarh',
        'Mansa',
        'Malout',
        'Nabha',
        'Tarn Taran',
        'Jagraon',
        'Sunam',
        'Dhuri',
        'Firozpur Cantt.',
        'Sirhind Fatehgarh Sahib',
        'Rupnagar',
        'Jalandhar Cantt.',
        'Samana',
        'Nawanshahr',
        'Rampura Phul',
        'Nangal',
        'Nakodar',
        'Zira',
        'Patti',
        'Raikot',
        'Longowal',
        'Urmar Tanda',
        'Morinda, India',
        'Phillaur',
        'Pattran',
        'Qadian',
        'Sujanpur',
        'Mukerian',
        'Talwara'
      ],
      Chandigarh: ['Chandigarh'],
      Rajasthan: [
        'Jaipur',
        'Jodhpur',
        'Bikaner',
        'Udaipur',
        'Ajmer',
        'Bhilwara',
        'Alwar',
        'Bharatpur',
        'Pali',
        'Barmer',
        'Sikar',
        'Tonk',
        'Sadulpur',
        'Sawai Madhopur',
        'Nagaur',
        'Makrana',
        'Sujangarh',
        'Sardarshahar',
        'Ladnu',
        'Ratangarh',
        'Nokha',
        'Nimbahera',
        'Suratgarh',
        'Rajsamand',
        'Lachhmangarh',
        'Rajgarh (Churu)',
        'Nasirabad',
        'Nohar',
        'Phalodi',
        'Nathdwara',
        'Pilani',
        'Merta City',
        'Sojat',
        'Neem-Ka-Thana',
        'Sirohi',
        'Pratapgarh',
        'Rawatbhata',
        'Sangaria',
        'Lalsot',
        'Pilibanga',
        'Pipar City',
        'Taranagar',
        'Vijainagar, Ajmer',
        'Sumerpur',
        'Sagwara',
        'Ramganj Mandi',
        'Lakheri',
        'Udaipurwati',
        'Losal',
        'Sri Madhopur',
        'Ramngarh',
        'Rawatsar',
        'Rajakhera',
        'Shahpura',
        'Shahpura',
        'Raisinghnagar',
        'Malpura',
        'Nadbai',
        'Sanchore',
        'Nagar',
        'Rajgarh (Alwar)',
        'Sheoganj',
        'Sadri',
        'Todaraisingh',
        'Todabhim',
        'Reengus',
        'Rajaldesar',
        'Sadulshahar',
        'Sambhar',
        'Prantij',
        'Mount Abu',
        'Mangrol',
        'Phulera',
        'Mandawa',
        'Pindwara',
        'Mandalgarh',
        'Takhatgarh'
      ],
      Assam: [
        'Guwahati',
        'Silchar',
        'Dibrugarh',
        'Nagaon',
        'Tinsukia',
        'Jorhat',
        'Bongaigaon City',
        'Dhubri',
        'Diphu',
        'North Lakhimpur',
        'Tezpur',
        'Karimganj',
        'Sibsagar',
        'Goalpara',
        'Barpeta',
        'Lanka',
        'Lumding',
        'Mankachar',
        'Nalbari',
        'Rangia',
        'Margherita',
        'Mangaldoi',
        'Silapathar',
        'Mariani',
        'Marigaon'
      ],
      Odisha: [
        'Bhubaneswar',
        'Cuttack',
        'Raurkela',
        'Brahmapur',
        'Sambalpur',
        'Puri',
        'Baleshwar Town',
        'Baripada Town',
        'Bhadrak',
        'Balangir',
        'Jharsuguda',
        'Bargarh',
        'Paradip',
        'Bhawanipatna',
        'Dhenkanal',
        'Barbil',
        'Kendujhar',
        'Sunabeda',
        'Rayagada',
        'Jatani',
        'Byasanagar',
        'Kendrapara',
        'Rajagangapur',
        'Parlakhemundi',
        'Talcher',
        'Sundargarh',
        'Phulabani',
        'Pattamundai',
        'Titlagarh',
        'Nabarangapur',
        'Soro',
        'Malkangiri',
        'Rairangpur',
        'Tarbha'
      ],
      Chhattisgarh: [
        'Raipur',
        'Bhilai Nagar',
        'Korba',
        'Bilaspur',
        'Durg',
        'Rajnandgaon',
        'Jagdalpur',
        'Raigarh',
        'Ambikapur',
        'Mahasamund',
        'Dhamtari',
        'Chirmiri',
        'Bhatapara',
        'Dalli-Rajhara',
        'Naila Janjgir',
        'Tilda Newra',
        'Mungeli',
        'Manendragarh',
        'Sakti'
      ],
      'Jammu and Kashmir': [
        'Srinagar',
        'Jammu',
        'Baramula',
        'Anantnag',
        'Sopore',
        'KathUrban Agglomeration',
        'Rajauri',
        'Punch',
        'Udhampur'
      ],
      Karnataka: [
        'Bengaluru',
        'Hubli-Dharwad',
        'Belagavi',
        'Mangaluru',
        'Davanagere',
        'Ballari',
        'Mysore',
        'Tumkur',
        'Shivamogga',
        'Raayachuru',
        'Robertson Pet',
        'Kolar',
        'Mandya',
        'Udupi',
        'Chikkamagaluru',
        'Karwar',
        'Ranebennuru',
        'Ranibennur',
        'Ramanagaram',
        'Gokak',
        'Yadgir',
        'Rabkavi Banhatti',
        'Shahabad',
        'Sirsi',
        'Sindhnur',
        'Tiptur',
        'Arsikere',
        'Nanjangud',
        'Sagara',
        'Sira',
        'Puttur',
        'Athni',
        'Mulbagal',
        'Surapura',
        'Siruguppa',
        'Mudhol',
        'Sidlaghatta',
        'Shahpur',
        'Saundatti-Yellamma',
        'Wadi',
        'Manvi',
        'Nelamangala',
        'Lakshmeshwar',
        'Ramdurg',
        'Nargund',
        'Tarikere',
        'Malavalli',
        'Savanur',
        'Lingsugur',
        'Vijayapura',
        'Sankeshwara',
        'Madikeri',
        'Talikota',
        'Sedam',
        'Shikaripur',
        'Mahalingapura',
        'Muddebihal',
        'Pavagada',
        'Malur',
        'Sindhagi',
        'Sanduru',
        'Afzalpur',
        'Maddur',
        'Madhugiri',
        'Tekkalakote',
        'Terdal',
        'Mudabidri',
        'Magadi',
        'Navalgund',
        'Shiggaon',
        'Shrirangapattana',
        'Sindagi',
        'Sakaleshapura',
        'Srinivaspur',
        'Ron',
        'Mundargi',
        'Sadalagi',
        'Piriyapatna',
        'Adyar'
      ],
      Manipur: ['Imphal', 'Thoubal', 'Lilong', 'Mayang Imphal'],
      Kerala: [
        'Thiruvananthapuram',
        'Kochi',
        'Kozhikode',
        'Kollam',
        'Thrissur',
        'Palakkad',
        'Alappuzha',
        'Malappuram',
        'Ponnani',
        'Vatakara',
        'Kanhangad',
        'Taliparamba',
        'Koyilandy',
        'Neyyattinkara',
        'Kayamkulam',
        'Nedumangad',
        'Kannur',
        'Tirur',
        'Kottayam',
        'Kasaragod',
        'Kunnamkulam',
        'Ottappalam',
        'Thiruvalla',
        'Thodupuzha',
        'Chalakudy',
        'Changanassery',
        'Punalur',
        'Nilambur',
        'Cherthala',
        'Perinthalmanna',
        'Mattannur',
        'Shoranur',
        'Varkala',
        'Paravoor',
        'Pathanamthitta',
        'Peringathur',
        'Attingal',
        'Kodungallur',
        'Pappinisseri',
        'Chittur-Thathamangalam',
        'Muvattupuzha',
        'Adoor',
        'Mavelikkara',
        'Mavoor',
        'Perumbavoor',
        'Vaikom',
        'Palai',
        'Panniyannur',
        'Guruvayoor',
        'Puthuppally',
        'Panamattom'
      ],
      Delhi: ['Delhi', 'New Delhi'],
      'Dadra and Nagar Haveli': ['Silvassa'],
      Puducherry: ['Pondicherry', 'Karaikal', 'Yanam', 'Mahe'],
      Uttarakhand: [
        'Dehradun',
        'Hardwar',
        'Haldwani-cum-Kathgodam',
        'Srinagar',
        'Kashipur',
        'Roorkee',
        'Rudrapur',
        'Rishikesh',
        'Ramnagar',
        'Pithoragarh',
        'Manglaur',
        'Nainital',
        'Mussoorie',
        'Tehri',
        'Pauri',
        'Nagla',
        'Sitarganj',
        'Bageshwar'
      ],
      'Uttar Pradesh': [
        'Lucknow',
        'Kanpur',
        'Firozabad',
        'Agra',
        'Meerut',
        'Varanasi',
        'Allahabad',
        'Amroha',
        'Moradabad',
        'Aligarh',
        'Saharanpur',
        'Noida',
        'Loni',
        'Jhansi',
        'Shahjahanpur',
        'Rampur',
        'Modinagar',
        'Hapur',
        'Etawah',
        'Sambhal',
        'Orai',
        'Bahraich',
        'Unnao',
        'Rae Bareli',
        'Lakhimpur',
        'Sitapur',
        'Lalitpur',
        'Pilibhit',
        'Chandausi',
        'Hardoi ',
        'Azamgarh',
        'Khair',
        'Sultanpur',
        'Tanda',
        'Nagina',
        'Shamli',
        'Najibabad',
        'Shikohabad',
        'Sikandrabad',
        'Shahabad, Hardoi',
        'Pilkhuwa',
        'Renukoot',
        'Vrindavan',
        'Ujhani',
        'Laharpur',
        'Tilhar',
        'Sahaswan',
        'Rath',
        'Sherkot',
        'Kalpi',
        'Tundla',
        'Sandila',
        'Nanpara',
        'Sardhana',
        'Nehtaur',
        'Seohara',
        'Padrauna',
        'Mathura',
        'Thakurdwara',
        'Nawabganj',
        'Siana',
        'Noorpur',
        'Sikandra Rao',
        'Puranpur',
        'Rudauli',
        'Thana Bhawan',
        'Palia Kalan',
        'Zaidpur',
        'Nautanwa',
        'Zamania',
        'Shikarpur, Bulandshahr',
        'Naugawan Sadat',
        'Fatehpur Sikri',
        'Shahabad, Rampur',
        'Robertsganj',
        'Utraula',
        'Sadabad',
        'Rasra',
        'Lar',
        'Lal Gopalganj Nindaura',
        'Sirsaganj',
        'Pihani',
        'Shamsabad, Agra',
        'Rudrapur',
        'Soron',
        'SUrban Agglomerationr',
        'Samdhan',
        'Sahjanwa',
        'Rampur Maniharan',
        'Sumerpur',
        'Shahganj',
        'Tulsipur',
        'Tirwaganj',
        'PurqUrban Agglomerationzi',
        'Shamsabad, Farrukhabad',
        'Warhapur',
        'Powayan',
        'Sandi',
        'Achhnera',
        'Naraura',
        'Nakur',
        'Sahaspur',
        'Safipur',
        'Reoti',
        'Sikanderpur',
        'Saidpur',
        'Sirsi',
        'Purwa',
        'Parasi',
        'Lalganj',
        'Phulpur',
        'Shishgarh',
        'Sahawar',
        'Samthar',
        'Pukhrayan',
        'Obra',
        'Niwai',
        'Mirzapur'
      ],
      Bihar: [
        'Patna',
        'Gaya',
        'Bhagalpur',
        'Muzaffarpur',
        'Darbhanga',
        'Arrah',
        'Begusarai',
        'Chhapra',
        'Katihar',
        'Munger',
        'Purnia',
        'Saharsa',
        'Sasaram',
        'Hajipur',
        'Dehri-on-Sone',
        'Bettiah',
        'Motihari',
        'Bagaha',
        'Siwan',
        'Kishanganj',
        'Jamalpur',
        'Buxar',
        'Jehanabad',
        'Aurangabad',
        'Lakhisarai',
        'Nawada',
        'Jamui',
        'Sitamarhi',
        'Araria',
        'Gopalganj',
        'Madhubani',
        'Masaurhi',
        'Samastipur',
        'Mokameh',
        'Supaul',
        'Dumraon',
        'Arwal',
        'Forbesganj',
        'BhabUrban Agglomeration',
        'Narkatiaganj',
        'Naugachhia',
        'Madhepura',
        'Sheikhpura',
        'Sultanganj',
        'Raxaul Bazar',
        'Ramnagar',
        'Mahnar Bazar',
        'Warisaliganj',
        'Revelganj',
        'Rajgir',
        'Sonepur',
        'Sherghati',
        'Sugauli',
        'Makhdumpur',
        'Maner',
        'Rosera',
        'Nokha',
        'Piro',
        'Rafiganj',
        'Marhaura',
        'Mirganj',
        'Lalganj',
        'Murliganj',
        'Motipur',
        'Manihari',
        'Sheohar',
        'Maharajganj',
        'Silao',
        'Barh',
        'Asarganj'
      ],
      Gujarat: [
        'Ahmedabad',
        'Surat',
        'Vadodara',
        'Rajkot',
        'Bhavnagar',
        'Jamnagar',
        'Nadiad',
        'Porbandar',
        'Anand',
        'Morvi',
        'Mahesana',
        'Bharuch',
        'Vapi',
        'Navsari',
        'Veraval',
        'Bhuj',
        'Godhra',
        'Palanpur',
        'Valsad',
        'Patan',
        'Deesa',
        'Amreli',
        'Anjar',
        'Dhoraji',
        'Khambhat',
        'Mahuva',
        'Keshod',
        'Wadhwan',
        'Ankleshwar',
        'Savarkundla',
        'Kadi',
        'Visnagar',
        'Upleta',
        'Una',
        'Sidhpur',
        'Unjha',
        'Mangrol',
        'Viramgam',
        'Modasa',
        'Palitana',
        'Petlad',
        'Kapadvanj',
        'Sihor',
        'Wankaner',
        'Limbdi',
        'Mandvi',
        'Thangadh',
        'Vyara',
        'Padra',
        'Lunawada',
        'Rajpipla',
        'Vapi',
        'Umreth',
        'Sanand',
        'Rajula',
        'Radhanpur',
        'Mahemdabad',
        'Ranavav',
        'Tharad',
        'Mansa',
        'Umbergaon',
        'Talaja',
        'Vadnagar',
        'Manavadar',
        'Salaya',
        'Vijapur',
        'Pardi',
        'Rapar',
        'Songadh',
        'Lathi',
        'Adalaj',
        'Chhapra',
        'Gandhinagar'
      ],
      Telangana: [
        'Hyderabad',
        'Warangal',
        'Nizamabad',
        'Karimnagar',
        'Ramagundam',
        'Khammam',
        'Mahbubnagar',
        'Mancherial',
        'Adilabad',
        'Suryapet',
        'Jagtial',
        'Miryalaguda',
        'Nirmal',
        'Kamareddy',
        'Kothagudem',
        'Bodhan',
        'Palwancha',
        'Mandamarri',
        'Koratla',
        'Sircilla',
        'Tandur',
        'Siddipet',
        'Wanaparthy',
        'Kagaznagar',
        'Gadwal',
        'Sangareddy',
        'Bellampalle',
        'Bhongir',
        'Vikarabad',
        'Jangaon',
        'Bhadrachalam',
        'Bhainsa',
        'Farooqnagar',
        'Medak',
        'Narayanpet',
        'Sadasivpet',
        'Yellandu',
        'Manuguru',
        'Kyathampalle',
        'Nagarkurnool'
      ],
      Meghalaya: ['Shillong', 'Tura', 'Nongstoin'],
      'Himachal Praddesh': ['Manali'],
      'Arunachal Pradesh': ['Naharlagun', 'Pasighat'],
      Maharashtra: [
        'Mumbai',
        'Pune',
        'Nagpur',
        'Thane',
        'Nashik',
        'Kalyan-Dombivali',
        'Vasai-Virar',
        'Solapur',
        'Mira-Bhayandar',
        'Bhiwandi',
        'Amravati',
        'Nanded-Waghala',
        'Sangli',
        'Malegaon',
        'Akola',
        'Latur',
        'Dhule',
        'Ahmednagar',
        'Ichalkaranji',
        'Parbhani',
        'Panvel',
        'Yavatmal',
        'Achalpur',
        'Osmanabad',
        'Nandurbar',
        'Satara',
        'Wardha',
        'Udgir',
        'Aurangabad',
        'Amalner',
        'Akot',
        'Pandharpur',
        'Shrirampur',
        'Parli',
        'Washim',
        'Ambejogai',
        'Manmad',
        'Ratnagiri',
        'Uran Islampur',
        'Pusad',
        'Sangamner',
        'Shirpur-Warwade',
        'Malkapur',
        'Wani',
        'Lonavla',
        'Talegaon Dabhade',
        'Anjangaon',
        'Umred',
        'Palghar',
        'Shegaon',
        'Ozar',
        'Phaltan',
        'Yevla',
        'Shahade',
        'Vita',
        'Umarkhed',
        'Warora',
        'Pachora',
        'Tumsar',
        'Manjlegaon',
        'Sillod',
        'Arvi',
        'Nandura',
        'Vaijapur',
        'Wadgaon Road',
        'Sailu',
        'Murtijapur',
        'Tasgaon',
        'Mehkar',
        'Yawal',
        'Pulgaon',
        'Nilanga',
        'Wai',
        'Umarga',
        'Paithan',
        'Rahuri',
        'Nawapur',
        'Tuljapur',
        'Morshi',
        'Purna',
        'Satana',
        'Pathri',
        'Sinnar',
        'Uchgaon',
        'Uran',
        'Pen',
        'Karjat',
        'Manwath',
        'Partur',
        'Sangole',
        'Mangrulpir',
        'Risod',
        'Shirur',
        'Savner',
        'Sasvad',
        'Pandharkaoda',
        'Talode',
        'Shrigonda',
        'Shirdi',
        'Raver',
        'Mukhed',
        'Rajura',
        'Vadgaon Kasba',
        'Tirora',
        'Mahad',
        'Lonar',
        'Sawantwadi',
        'Pathardi',
        'Pauni',
        'Ramtek',
        'Mul',
        'Soyagaon',
        'Mangalvedhe',
        'Narkhed',
        'Shendurjana',
        'Patur',
        'Mhaswad',
        'Loha',
        'Nandgaon',
        'Warud'
      ],
      Goa: ['Marmagao', 'Panaji', 'Margao', 'Mapusa'],
      'West Bengal': [
        'Kolkata',
        'Siliguri',
        'Asansol',
        'Raghunathganj',
        'Kharagpur',
        'Naihati',
        'English Bazar',
        'Baharampur',
        'Hugli-Chinsurah',
        'Raiganj',
        'Jalpaiguri',
        'Santipur',
        'Balurghat',
        'Medinipur',
        'Habra',
        'Ranaghat',
        'Bankura',
        'Nabadwip',
        'Darjiling',
        'Purulia',
        'Arambagh',
        'Tamluk',
        'AlipurdUrban Agglomerationr',
        'Suri',
        'Jhargram',
        'Gangarampur',
        'Rampurhat',
        'Kalimpong',
        'Sainthia',
        'Taki',
        'Murshidabad',
        'Memari',
        'Paschim Punropara',
        'Tarakeswar',
        'Sonamukhi',
        'PandUrban Agglomeration',
        'Mainaguri',
        'Malda',
        'Panchla',
        'Raghunathpur',
        'Mathabhanga',
        'Monoharpur',
        'Srirampore',
        'Adra'
      ]
    };

    try {
      await rfqModel.saveStateCities(data);

      res
        .status(200)
        .json({
          status: 1,
          message: 'SAVED'
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  processRfqDraftSheetWise: async (
    processedUrl,
    user,
    rfqId = null,
    sheetId = null,
    availableSheets
  ) => {
    try {
      if (
        rfqId &&
        !isNaN(parseInt(rfqId)) &&
        sheetId &&
        !isNaN(parseInt(sheetId))
      ) {
        let rfqDetails = await rfqModel.checkIfExists(
          'tbl_rfq',
          `id = ${rfqId}`
        );
        if (rfqDetails) {
          rfqDetails = rfqDetails[0];
          let sheetDetails = await rfqModel.checkIfExists(
            'tbl_rfq_draft_sheets',
            `rfq_id = ${rfqId} AND id = ${sheetId}`
          );
          if (sheetDetails) {
            sheetDetails = sheetDetails[0];
            processedUrl = sheetDetails.processed_url;
          } else processedUrl = rfqDetails.processed_url;

          if (!processedUrl)
            throw new Error(
              'Processed URL does not exist for given Sheet OR RFQ'
            );
        }
      }

      if (process.env.NODE_ENV == 'uat' && processedUrl.startsWith('http:')) {
        processedUrl = processedUrl.replace('http:', 'https:');
      }

      const boqDataJson = await generativeAI.processBOQWithAI(processedUrl);

      const termList = await rfqModel.getAllTerms();
      const transformedTermList = termList.map((term) => ({
        id: term.id,
        name: term.term_content
      }));

      const validationErrors = [];
      const products = [];
      const sheetNameList = new Set();
      const globalVariantCount = {};

      const allVariantsCount = await rfqModel.getVariantsCountForRFQ(rfqId);
      if (allVariantsCount && allVariantsCount.length > 0) {
        allVariantsCount.forEach((variantCount) => {
          const productId = variantCount.product_variant_id;
          const maxVariant = variantCount.max_variant;

          globalVariantCount[productId] = maxVariant + 1;
        });
      }

      const allProductIds = boqDataJson
        .map((item) => item.variant_id)
        .filter((item) => typeof item == 'number' || typeof item == 'string');

      const uniqueProductIds = [...new Set(allProductIds)];
      const existingProducts = await rfqModel.checkIfExists(
        'tbl_product',
        `id = ANY(ARRAY[${uniqueProductIds.join(',')}])`
      );
      const existingProductIdSet = new Set(existingProducts.map((p) => p.id));

      const vendorCache = {};

      for (const item of boqDataJson) {
        if (item.is_product == 'No') {
          continue;
        }

        const cleanId = item?.variant_id;
        const productName =
          item.core_product_name ||
          item.fetched_product_name ||
          'Unknown Product';

        if (!cleanId || item.fetched_product_name === 'Product not found') {
          validationErrors.push({
            errors: { product: `${productName} - Product not found` },
            name: productName,
            size: item.size || '',
            quantity: item.quantity || '',
            unit: item.unit || '',
            sheet_name: item.sheet_name || '',
            description: item.full_product_description || '',
            similar_products: item.reranked_variants || []
          });
          continue;
        }

        const validProductId = existingProductIdSet.has(cleanId)
          ? cleanId
          : null;

        if (!validProductId) {
          validationErrors.push({
            errors: { product: `${productName} - Product not found` },
            name: productName,
            size: item.size || '',
            quantity: item.quantity || '',
            unit: item.unit || '',
            sheet_name: item.sheet_name || '',
            description: item.full_product_description || '',
            similar_products: item.reranked_variants || []
          });
          continue;
        }

        const finalProductName =
          item.fetched_product_name || item.core_product_name;

        if (!vendorCache[validProductId]) {
          const vendors = await rfqModel.genericSearchVendors(
            user.id,
            validProductId,
            null,
            { vendorId: 'user_id', vendorName: 'name' }
          );
          vendorCache[validProductId] = vendors;
        }

        const vendorResult = vendorCache[validProductId];

        if (!vendorResult || vendorResult.length === 0) {
          validationErrors.push({
            errors: {
              vendor: `${finalProductName} - No Vendors Found`
            },
            name: finalProductName,
            size: item.size || '',
            quantity: item.quantity || '',
            unit: item.unit || '',
            sheet_name: item.sheet_name || '',
            description: item.full_product_description || '',
            similar_products: item.reranked_variants || []
          });
          continue;
        }

        const variantCount = globalVariantCount[validProductId] ?? 0;

        products.push({
          product_id: validProductId,
          name: finalProductName || 'Unnamed Product',
          variant: variantCount,
          spec: [
            { title: 'Size', value: item.size || '' },
            { title: 'Spec', value: item.feature_or_specifications || '' },
            { title: 'Quantity', value: item.quantity || 0 },
            { title: 'Unit', value: item.unit || 'NA' },
            { title: 'total_price', value: item.total_price || '0' }
          ],
          vendors: vendorResult,
          comment: item.full_product_description || '',
          defaultSelectedVAB: '',
          datasheet: '0',
          datasheet_file: [],
          spec_file: [],
          qap: '0',
          qap_file: [],
          user_selected_predefined_tds: false,
          user_selected_predefined_qap: false,
          sheet_name: item.sheet_name || ''
        });

        globalVariantCount[validProductId] = variantCount + 1;
        sheetNameList.add(item.sheet_name || '');
      }

      const finalObject = {
        response_email: user.email,
        contact_name: user.name,
        contact_number: user.mobile,
        company_name: user.organization_name || user.name,
        products,
        terms: transformedTermList,
        termList,
        term_and_condition_files: [],
        sheetNameList:
          availableSheets && availableSheets.length > 0
            ? availableSheets.map((sheet) => sheet.sheet_name)
            : Array.from(sheetNameList),
        availableSheets,
        validationErrors
      };

      // Send email notification for products or vendors not found
      const hasProductNotFound = validationErrors.some(
        (err) => err.errors && err.errors.product
      );
      const hasVendorNotFound = validationErrors.some(
        (err) => err.errors && err.errors.vendor
      );

      // Comment if not needed
      const uniqueErrors = validationErrors.filter(
        (err, index, self) =>
          index ===
          self.findIndex(
            (e) =>
              e.errors?.product === err.errors?.product &&
              e.errors?.vendor === err.errors?.vendor &&
              (e.name || e.productName || '') ===
                (err.name || err.productName || '')
          )
      );
      if (hasProductNotFound || hasVendorNotFound) {
        try {
          let emailContent = `
            <h2>Products or Vendors Not Found in Phileein Hospitality Magic Search</h2>
            <p>Needs to work on these missing products or Vendors urgently.</p>
            <p><strong>RFQ Number:</strong> ${rfqDetails?.rfq_no}</p>
            <p><strong>User:</strong> ${user.name} (${user.email})</p>
            <p><strong>Organization:</strong> ${
              user.organization_name || 'N/A'
            }</p> 
            <h3>Details:</h3>
            <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%;">
              <thead>
                <tr style="background-color: #f0f0f0;">
                  <th>Error Type</th>
                  <th>Product Name</th>
                </tr>
              </thead>
              <tbody>
          `;
          uniqueErrors.forEach((err) => {
            let errorType =
              err.errors && err.errors.product
                ? 'Product Not Found'
                : err.errors && err.errors.vendor
                ? 'Vendor Not Found'
                : 'Other';
            let productName = err.name || err.productName || '';
            emailContent += `
              <tr>
                <td>${errorType}</td>
                <td>${productName}</td>
              </tr>
            `;
          });
          emailContent += `
              </tbody>
            </table>
            <p><em>This email was automatically generated by Phileein Hospitality RFQ processing system.</em></p>
          `;

          const mailOptions = {
            from: Config.webmasterMail,
            // to:'mukul@letsworkwise.com',
            // cc:'vineet@letsworkwise.com',
            to: 'siddharth@letsworkwise.com',
            cc: [
              'sayankaworkwise@gmail.com',
              'prashant@letsworkwise.com',
              'mukul@letsworkwise.com'
            ],
            subject: `Phileein Hospitality Magic Search - Product And Vendor Not Found Error List`,
            html: emailContent
          };
          sendMail(mailOptions);
        } catch (emailError) {
          logError('Error sending product/vendor not found email:', emailError);
        }
      }

      return [uniqueErrors, finalObject];
    } catch (error) {
      logError(error);
      return [null, null];
    }
  },

  getCostEstimates: async (processedUrl) => {
    try {

      if (process.env.NODE_ENV=='uat' &&  processedUrl.startsWith('http:')) {
        processedUrl = processedUrl.replace('http:', 'https:');
      }
  
      const boqDataJson = await generativeAI.processBOQWithAI(processedUrl);
  
      const validationErrors = [];
      const products = [];
      const sheetNameList = new Set();
      const globalVariantCount = {};
  
      const allProductIds = boqDataJson.map(item => item.variant_id).filter(item => typeof item == 'number' || typeof item == 'string');
  
      const uniqueProductIds = [...new Set(allProductIds)];
      const existingProducts = await rfqModel.checkIfExists(
        'tbl_product',
        `id = ANY(ARRAY[${uniqueProductIds.join(',')}])`
      );
      const existingProductIdSet = new Set(existingProducts.map(p => p.id));
  
      const quoteCache = {};
  
      for (const item of boqDataJson) {
        if (item.is_product == "No") {
          continue
       }

        const cleanId = item?.variant_id;
        const productName = item.core_product_name || item.fetched_product_name || 'Unknown Product';
  
        if (!cleanId || item.fetched_product_name === 'Product not found') {
          validationErrors.push({
            errors: { product: `${productName} - Product not found` },
            name: productName,
            quantity: item.quantity || '',
          });
          continue;
        }
  
        const validProductId = existingProductIdSet.has(cleanId) ? cleanId : null;
  
        if (!validProductId) {
          validationErrors.push({
            errors: { product: `${productName} - Product not found` },
            name: productName,
            quantity: item.quantity || '',
          });
          continue;
        }
  
        const finalProductName = item.fetched_product_name || item.core_product_name;

        if (!quoteCache[validProductId]) {
          const quotes = await rfqModel.getEstimateQuotes(
            validProductId,
          );
          quoteCache[validProductId] = quotes;
        }
  
        const quotesResult = quoteCache[validProductId];
  
        if (!quotesResult || quotesResult.length === 0) {
          validationErrors.push({
            errors: {
              quote: `${finalProductName} - No Quotes Found` },
            name: finalProductName,
            quantity: item.quantity || '',
          });
          continue;
        }
  
        const variantCount = globalVariantCount[validProductId] ?? 0;
  
        products.push({
          product_id: validProductId,
          name: finalProductName || "Unnamed Product",
          variant: variantCount,
          quantity: item.quantity,
          quotes: quotesResult,
        });
  
        globalVariantCount[validProductId] = variantCount + 1;
        sheetNameList.add(item.sheet_name || "");
      }
  
      const finalObject = {
        products,
        validationErrors,
      };

      // Comment if not needed
      const uniqueErrors = validationErrors.filter((err, index, self) => 
        index === self.findIndex(e => 
          (e.errors?.product === err.errors?.product) && 
          (e.errors?.quote === err.errors?.quote) && 
          ((e.name || e.productName || '') === (err.name || err.productName || ''))
        )
      );

      return [uniqueErrors, finalObject];
    }
    catch (error) {
      logError(error);
      return [null, null];
    }
  },

  getCostEstimates: async (processedUrl) => {
    try {

      if (process.env.NODE_ENV=='uat' &&  processedUrl.startsWith('http:')) {
        processedUrl = processedUrl.replace('http:', 'https:');
      }
  
      const boqDataJson = await generativeAI.processBOQWithAI(processedUrl);
  
      const validationErrors = [];
      const products = [];
      const sheetNameList = new Set();
      const globalVariantCount = {};
  
      const allProductIds = boqDataJson.map(item => item.variant_id).filter(item => typeof item == 'number' || typeof item == 'string');
  
      const uniqueProductIds = [...new Set(allProductIds)];
      const existingProducts = await rfqModel.checkIfExists(
        'tbl_product',
        `id = ANY(ARRAY[${uniqueProductIds.join(',')}])`
      );
      const existingProductIdSet = new Set(existingProducts.map(p => p.id));
  
      const quoteCache = {};
  
      for (const item of boqDataJson) {
        if (item.is_product == "No") {
          continue
       }

        const cleanId = item?.variant_id;
        const productName = item.core_product_name || item.fetched_product_name || 'Unknown Product';
  
        if (!cleanId || item.fetched_product_name === 'Product not found') {
          validationErrors.push({
            errors: { product: `${productName} - Product not found` },
            name: productName,
            quantity: item.quantity || '',
          });
          continue;
        }
  
        const validProductId = existingProductIdSet.has(cleanId) ? cleanId : null;
  
        if (!validProductId) {
          validationErrors.push({
            errors: { product: `${productName} - Product not found` },
            name: productName,
            quantity: item.quantity || '',
          });
          continue;
        }
  
        const finalProductName = item.fetched_product_name || item.core_product_name;

        if (!quoteCache[validProductId]) {
          const quotes = await rfqModel.getEstimateQuotes(
            validProductId,
          );
          quoteCache[validProductId] = quotes;
        }
  
        const quotesResult = quoteCache[validProductId];
  
        if (!quotesResult || quotesResult.length === 0) {
          validationErrors.push({
            errors: {
              quote: `${finalProductName} - No Quotes Found` },
            name: finalProductName,
            quantity: item.quantity || '',
          });
          continue;
        }
  
        const variantCount = globalVariantCount[validProductId] ?? 0;
  
        products.push({
          product_id: validProductId,
          name: finalProductName || "Unnamed Product",
          variant: variantCount,
          quantity: item.quantity,
          quotes: quotesResult,
        });
  
        globalVariantCount[validProductId] = variantCount + 1;
        sheetNameList.add(item.sheet_name || "");
      }
  
      const finalObject = {
        products,
        validationErrors,
      };

      // Comment if not needed
      const uniqueErrors = validationErrors.filter((err, index, self) => 
        index === self.findIndex(e => 
          (e.errors?.product === err.errors?.product) && 
          (e.errors?.quote === err.errors?.quote) && 
          ((e.name || e.productName || '') === (err.name || err.productName || ''))
        )
      );

      return [uniqueErrors, finalObject];
    }
    catch (error) {
      logError(error);
      return [null, null];
    }
  },

  initiateMagicSearch: async (req, res) => {
    try {
      const { id } = req.user;
      const { file_name, type = 'rfq', raw_file_url } = req.body;

      if (!file_name)
        return res.status(400).json({
          status: 3,
          message: 'File name is required for persistant processing.'
        });

      const result = await rfqController.handleMagicSearchInsertion(file_name, type, id, raw_file_url);

      return res.json(result);
    } catch (error) {
      logError('rfqController error', error);
      logError(error);
      return res.status(400).json({
        status: 3,
        message: 'Something went wrong while initiating the job, please try again!',
        error,
      })
    }
  },

  handleMagicSearchInsertion: async (file_name, type, id, raw_file_url) => {
    try {
      let processing = await rfqModel.checkIfExists('tbl_rfq_persistent_jobs', `file_name = '${file_name}' AND status = 'processing' AND user_id = ${id} AND type = '${type}'`)
      if(processing && processing.length > 0) {
        processing = processing[0];
        logger.debug('FOUND ALREADY PROCESSING TASK!');

        const inputUtcMoment = moment.utc(processing.started_at);
        const inputIstMoment = inputUtcMoment.tz('Asia/Kolkata');
        const nowIst = moment().tz('Asia/Kolkata');

        const diffInHours = nowIst.diff(inputIstMoment, 'hours', true);
        if (diffInHours > 1) {
          await rfqModel.updatePersistenceJobStatus(
            processing.id,
            PERSISTENCE_STATUSES.TERMINATED,
            null,
            'Due to a longer processing time, we have terminated this BOQ Processing, please upload this BOQ again to retry the processing'
          );
        } else {
          return {
            status: 5,
            message: 'This BOQ is already under processing, please refer to the Processing tab for more info!',
            processing,
          }
        }
      }

      const baseUrl = process.env.APP_BASE_PATH;
      const secret = process.env.WEBHOOK_SECRET;
      const expires = Math.floor(Date.now() / 1000) + 12 * 60 * 60;

      const message = `${file_name}_${id}_${expires}`;
      const signature = generateSignature(message, secret);

      return db.tx(async t => {
        let persistence = await rfqModel.persistAIJobInDB(id, file_name, raw_file_url, signature, type, t);
  
        if(!persistence || persistence.length <= 0) {
          return {
            status: 3,
            message: 'Something went wrong while saving job, please try again!'
          }
        }

        persistence = persistence[0];
  
        const signedUrl = `${baseUrl}/api/v1/rfq/magic-webhook?persistence_id=${
          persistence.id
        }&user=${id}&file_name=${encodeURIComponent(
          file_name
        )}&expires=${expires}&signature=${signature}`;
  
        return {
          status: 1,
          persistence,
          webhook: signedUrl
        }
      })
    } catch (error) {
      throw error;
    }
  },

  handleAIWebhook: async (req, res) => {
    try {
      let { persistence_id, user } = req.query;
      const { jsonFileUrl, availableSheets, errors, type } = req.body;

      persistence_id = parseInt(persistence_id);

      if((errors && errors.length > 0) && (!jsonFileUrl || !availableSheets)) {
        await rfqModel.updatePersistenceJobStatus(
          persistence_id,
          PERSISTENCE_STATUSES.FAILED,
          null,
          errors ? normalizeErrors({ type: 'ai-error', actual: errors }) : null
        );

        return res.json({
          status: 2,
          message: 'Webhook triggered, errors handled!'
        });
      }

      if (type == 'simplified') {
        await rfqModel.updatePersistenceJobStatus(
          persistence_id,
          PERSISTENCE_STATUSES.COMPLETED,
          null,
          errors ? normalizeErrors({ type: 'ai-error', actual: errors }) : null,
          jsonFileUrl
        );
      } else if (type == 'rfq') {
        const response = await rfqController.magicSearchRfqCreate(
          jsonFileUrl,
          availableSheets,
          user
        );
        if (response.success) {
          await rfqModel.updatePersistenceJobStatus(
            persistence_id,
            (response.validation_errors ?? []).length > 0
              ? PERSISTENCE_STATUSES.PARTIAL_COMPLETED
              : PERSISTENCE_STATUSES.COMPLETED,
            response.savedRfq,
            (response.validation_errors ?? []).length > 0 ? normalizeErrors({ type: 'ai-error', actual: response.validation_errors }) : null,
            jsonFileUrl,
          );

        } else {
          throw new Error(response.error || 'Magic search failed to be saved in the Database, please try again after some time...')
        }
      } else {
        await rfqModel.updatePersistenceJobStatus(
          persistence_id,
          PERSISTENCE_STATUSES.FAILED,
          null,
          normalizeErrors({
            type: 'db-error',
            actual: [
              {
                status: 'failed',
                error:
                  'Something went wrong while saving RFQ in the Database, please try again!'
              }
            ]
          })
        );
      }

      return res.json({
        status: 1,
        message: 'Webhook triggered!'
      });
    } catch (error) {
      const { persistence_id } = req.query;
      await rfqModel.updatePersistenceJobStatus(persistence_id, PERSISTENCE_STATUSES.FAILED, null, normalizeErrors({
        type: 'backend-error',
        actual: [{
          status: 'failed',
          error: error.message,
        }]
      }));

      return res.status(400).json({
        status: 3,
        message: 'Something went wrong while handling AI Webhook, please try again!',
        error,
      })
    }
  },
   getCostEstimates: async (processedUrl) => {
    try {

      if (process.env.NODE_ENV=='uat' &&  processedUrl.startsWith('http:')) {
        processedUrl = processedUrl.replace('http:', 'https:');
      }
  
      const boqDataJson = await generativeAI.processBOQWithAI(processedUrl);
  
      const validationErrors = [];
      const products = [];
      const sheetNameList = new Set();
      const globalVariantCount = {};
  
      const allProductIds = boqDataJson.map(item => item.variant_id).filter(item => typeof item == 'number' || typeof item == 'string');
  
      const uniqueProductIds = [...new Set(allProductIds)];
      const existingProducts = await rfqModel.checkIfExists(
        'tbl_product',
        `id = ANY(ARRAY[${uniqueProductIds.join(',')}])`
      );
      const existingProductIdSet = new Set(existingProducts.map(p => p.id));
  
      const quoteCache = {};
  
      for (const item of boqDataJson) {
        if (item.is_product == "No") {
          continue
       }

        const cleanId = item?.variant_id;
        const productName = item.core_product_name || item.fetched_product_name || 'Unknown Product';
  
        if (!cleanId || item.fetched_product_name === 'Product not found') {
          validationErrors.push({
            errors: { product: `${productName} - Product not found` },
            name: productName,
            quantity: item.quantity || '',
          });
          continue;
        }
  
        const validProductId = existingProductIdSet.has(cleanId) ? cleanId : null;
  
        if (!validProductId) {
          validationErrors.push({
            errors: { product: `${productName} - Product not found` },
            name: productName,
            quantity: item.quantity || '',
          });
          continue;
        }
  
        const finalProductName = item.fetched_product_name || item.core_product_name;

        if (!quoteCache[validProductId]) {
          const quotes = await rfqModel.getEstimateQuotes(
            validProductId,
          );
          quoteCache[validProductId] = quotes;
        }
  
        const quotesResult = quoteCache[validProductId];
  
        if (!quotesResult || quotesResult.length === 0) {
          validationErrors.push({
            errors: {
              quote: `${finalProductName} - No Quotes Found` },
            name: finalProductName,
            quantity: item.quantity || '',
          });
          continue;
        }
  
        const variantCount = globalVariantCount[validProductId] ?? 0;
  
        products.push({
          product_id: validProductId,
          name: finalProductName || "Unnamed Product",
          variant: variantCount,
          quantity: item.quantity,
          quotes: quotesResult,
        });
  
        globalVariantCount[validProductId] = variantCount + 1;
        sheetNameList.add(item.sheet_name || "");
      }
  
      const finalObject = {
        products,
        validationErrors,
      };

      // Comment if not needed
      const uniqueErrors = validationErrors.filter((err, index, self) => 
        index === self.findIndex(e => 
          (e.errors?.product === err.errors?.product) && 
          (e.errors?.quote === err.errors?.quote) && 
          ((e.name || e.productName || '') === (err.name || err.productName || ''))
        )
      );

      return [uniqueErrors, finalObject];
    }
    catch (error) {
      logError(error);
      return [null, null];
    }
  },

   getCostEstimatesData: async (req, res) => {
    try {
      const { persistent_id } = req.params;
      const estimates = await rfqModel.getEstimatesData(persistent_id);

      return res.json(estimates);
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: 'Something went wrong while fetching cost estimates, please try again!',
        error,
      })
    }
  },


   estimateCost: async (req, res) => {
    try {
      const { email, phone, file_name, type } = req.body;
      let user = req.user ?? null;
      let didUserRegister = false;

      if(!user) {
        const userExists = await userModel.user_exist(email, phone);
        if(userExists && userExists.length > 0) {
          return res.status(403).json({
            status: 3,
            message: 'User already exist with given credentials, please login!'
          })
        }
  
        const registeredUser = await UsersController.registerBuyerAnonymously(req.body);
        if(!registeredUser) {
          return res.status(400).json({
            status: 3,
            message: 'Failed to register, please try again later. If this issue persists please contact our support team!'
          })
        }

        user = registeredUser;
        didUserRegister = true;
      }

      const processingRes = await rfqController.handleMagicSearchInsertion(file_name, type, user.id);

      return res.status(processingRes.status != 1 ? 400 : 200).json({ ...processingRes, didUserRegister, user });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: 'Something went wrong while handling AI Webhook, please try again!',
        error,
      })
    }
  },

sendFollowUpEmails: async (req, res) => {
  try {
    const payload = req.body;
    const user_id = req.user?.id ?? null;
    const { rfq_id } = payload;

    if (!rfq_id || !user_id) {
      return res.status(400).json({
        status: 2,
        message: "Missing rfq_id or user_id",
      });
    }

    // Step 1: Check how many reminders already sent
    const reminders = await rfqModel.findAll('tbl_rfq_activity', {
      rfq_id: Number(rfq_id),
      user_id: Number(user_id)
    });


    if (reminders && reminders.length >= 2) {
      return res.json({
        status: 2,
        message: "Maximum number of follow-ups reached",
      });
    }

    // Step 2: Insert activity record
    await rfqModel.insert("tbl_rfq_activity", {
      rfq_id: Number(rfq_id),
      user_id: Number(user_id),
    });

    // Step 3: Send email
    await sendFollowUpEmailsService(payload);

    return res.json({
      status: 1,
      message: "Follow up email sent successfully",
    });

  } catch (error) {
    logger.debug({ data: error }, ' SEND_FOLLOWUP_EMAILS  --------------------------------------------------');
    logError(error);
    return res.status(400).json({
      status: 3,
      message: "Something went wrong while sending follow up emails, please try again!",
      error,
    });
  }
},



  tenderSummary : async (req , res) =>{

    try {
      const { email, phone, file_name } = req.body;
      let user = req.user ?? null;
      let didUserRegister = false;

      if(!user) {
        const userExists = await userModel.user_exist(email, phone);
        if(userExists && userExists.length > 0) {
          return res.status(403).json({
            status: 3,
            message: 'User already exist with given credentials, please login!'
          })
        }
  
        const registeredUser = await UsersController.registerBuyerAnonymously(req.body);
        if(!registeredUser) {
          return res.status(400).json({
            status: 3,
            message: 'Failed to register, please try again later. If this issue persists please contact our support team!'
          })
        }

        user = registeredUser;
        didUserRegister = true;
      }

      const data = summaries.find((summary) =>
        file_name.toLowerCase().includes(summary.file_name.toLowerCase())
      );
      if(data) {
        return res.json({
          ...data,
          didUserRegister,
          user,
        });
      }

      return res.json({
        status: 2,
        message: `Summary cannot be generated for ${file_name} at the time, please try again later!`,
        didUserRegister,
        user
      })
      // const processingRes = await rfqController.handleMagicSearchInsertion(file_name, type, user.id);

      // return res.status(processingRes.status != 1 ? 400 : 200).json({ ...processingRes, didUserRegister, user });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: 'Something went wrong while handling AI Webhook, please try again!',
        error,
      })
    }

  },


  // mukul - 21-05-2025, removed file handling as now we just get json url in request, also reviewed we handling many fields in payload but in api call we just get json url, not removing them now as very soon we start this flow enhancements
  // Kushal - 21-05-2025, Highly optimized to handle large datasets
  // Kushal - 23-05-2025, Completed Sheet wise processing while saving Draft of Magic Search
  magicSearchRfqCreate: async (jsonFileUrl, availableSheets, user_id) => {
    try {
      let aiProcessedBoqJson = jsonFileUrl;

      if (availableSheets && availableSheets.length > 0) {
        aiProcessedBoqJson =
          availableSheets[0]?.download_url ?? aiProcessedBoqJson;
      }

      let user = await userModel.getUserById(user_id);
      if (!user) throw new Error('User dont exist with id: ', user_id);

      user = user[0];

      const [validationErrors, processedData] =
        await rfqController.processRfqDraftSheetWise(
          aiProcessedBoqJson,
          user,
          null,
          null,
          availableSheets
        );
      if (!processedData && !validationErrors)
        throw new Error('No Data processed!');

      const savedRfq = await saveMagicSearchInDraft(
        processedData,
        user_id,
        aiProcessedBoqJson
      );
      const sheets = await rfqModel.getSheetsForDraftRfq(savedRfq);

      return {
        status: 1,
        success: true,
        savedRfq,
        sheets,
        data: processedData, // Whole data will not be returned, client will request again for the first sheet's data from the backend after the initial save
        validation_errors: validationErrors.length ? validationErrors : null
      };
    } catch (error) {
      logError(error);
      return {
        success: false,
        message:
          'Magic search failed to complete the action, Please try again.',
        error: error
      };
    }
  },

  createCostEstimation: async (jsonFileUrl, user_id) => {
    try {
      let aiProcessedBoqJson = jsonFileUrl;
  
      let user = await userModel.getUserById(user_id);
      if(!user) throw new Error('User dont exist with id: ', user_id);

      user = user[0];

      const [validationErrors, processedData] = await rfqController.getCostEstimates(aiProcessedBoqJson, user)
      if(!processedData && !validationErrors) throw new Error("No Data processed!")

      const saveEstimate = await saveEstimates(processedData, user_id)
  
      return {
        status: 1,
        success: true,
        saveEstimate,
        data: processedData, // Whole data will not be returned, client will request again for the first sheet's data from the backend after the initial save
        validation_errors: validationErrors.length ? validationErrors : null,
      };
  
    } catch (error) {
      logError(error);
      return {
        success: false,
        message: 'Magic search failed to complete the action, Please try again.',
        error: error,
      };
    }
  },

  createCostEstimation: async (jsonFileUrl, user_id) => {
    try {
      let aiProcessedBoqJson = jsonFileUrl;
  
      let user = await userModel.getUserById(user_id);
      if(!user) throw new Error('User dont exist with id: ', user_id);

      user = user[0];

      const [validationErrors, processedData] = await rfqController.getCostEstimates(aiProcessedBoqJson, user)
      if(!processedData && !validationErrors) throw new Error("No Data processed!")

      const saveEstimate = await saveEstimates(processedData, user_id)
  
      return {
        status: 1,
        success: true,
        saveEstimate,
        data: processedData, // Whole data will not be returned, client will request again for the first sheet's data from the backend after the initial save
        validation_errors: validationErrors.length ? validationErrors : null,
      };
  
    } catch (error) {
      logError(error);
      return {
        success: false,
        message: 'Magic search failed to complete the action, Please try again.',
        error: error,
      };
    }
  },

  processMagicSearchDraft: async (req, res, next) => {
    try {
      const { rfqId, sheetId } = req.query;
      const user = req.user;

      if (!rfqId || isNaN(parseInt(rfqId))) {
        return res.status(400).json({
          status: 0,
          success: false,
          message: 'RFQ Id is required to process a draft sheet!'
        });
      }

      if (!sheetId || isNaN(parseInt(sheetId))) {
        return res.status(400).json({
          status: 0,
          success: false,
          message: 'Sheet Id is required to process a draft sheet!'
        });
      }
      try {
        const [, processedData] = await rfqController.processRfqDraftSheetWise(
          null,
          user,
          rfqId,
          sheetId
        );
        const savedRfq = await saveMagicSearchInDraft(
          processedData,
          req.user.id,
          null,
          rfqId,
          sheetId
        );

        const sheets = await rfqModel.getSheetsForDraftRfq(savedRfq);
        return res.status(200).json({
          status: 1,
          success: true,
          savedRfq,
          sheets,
          data: processedData // Including the processed data in the response
        });
      } catch (error) {
        return res.status(500).json({
          status: 0,
          success: false,
          message: 'Failed to fetch sheet data, please try again.',
          sheets
        });
      }
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        success: false,
        message:
          'Failed to fetch drafted RFQ data, either the sheet id is invalid or this rfq is no longer available!',
        error: error.message
      });
    }
  },

  getDraftRfqSheetWise: async (req, res) => {
    try {
      let { rfqId, sheetId } = req.query;

      if (!rfqId || isNaN(parseInt(rfqId)) || parseInt(rfqId) < 0) {
        return res.status(400).json({
          status: 0,
          success: false,
          message: 'RFQ id is invalid, please provide a valid RFQ id!'
        });
      }

      // Convert to integers
      rfqId = parseInt(rfqId);

      // Get sheets for this RFQ
      const sheets = await rfqModel.getSheetsForDraftRfq(rfqId);

      if (!sheets || !sheets.length > 0) {
        return res.status(200).json({
          status: 0,
          success: false,
          message: 'No sheets found for this RFQ',
          sheets: []
        });
      }

      // Validate and select sheetId
      if (!sheetId || isNaN(parseInt(sheetId)) || parseInt(sheetId) < 0) {
        sheetId = sheets[0].id;
      } else {
        sheetId = parseInt(sheetId);
      }

      // Verify the sheet exists for this RFQ
      let sheetData = await rfqModel.checkIfExists(
        'tbl_rfq_draft_sheets',
        `rfq_id = ${rfqId} AND id = ${sheetId}`
      );

      if (!sheetData || !sheetData.length > 0) {
        return res.status(400).json({
          status: 0,
          success: false,
          message:
            'Sheet does not exist, either it is inactive or does not exist!',
          sheets
        });
      }

      sheetData = sheetData[0];

      // Process unprocessed sheet if needed
      if (!sheetData.is_processed) {
        try {
          const [, processedData] =
            await rfqController.processRfqDraftSheetWise(
              null,
              req.user,
              rfqId,
              sheetId
            );
          await saveMagicSearchInDraft(
            processedData,
            req.user.id,
            null,
            rfqId,
            sheetId
          );
        } catch (error) {
          logError('rfqController error', error);
          return res.status(500).json({
            status: 0,
            success: false,
            message: 'Failed to process sheet data. Please try again.',
            sheets
          });
        }
      }

      // Get the data for this sheet
      try {
        const data = await rfqModel.getDraftRfqSheetWise(rfqId, sheetId);

        return res.status(200).json({
          status: 1,
          success: true,
          sheets,
          data
        });
      } catch (error) {
        return res.status(500).json({
          status: 0,
          success: false,
          message: 'Failed to fetch sheet data, please try again.',
          sheets
        });
      }
    } catch (error) {
      logError('[getDraftRfqSheetWise] Unhandled error', error);
      logError(error);
      return res.status(500).json({
        status: 0,
        success: false,
        message:
          'Failed to fetch drafted RFQ data, either the sheet id is invalid or this rfq is no longer available!',
        error: error.message
      });
    }
  },

  getRfqDraftSheets: async (req, res) => {
    try {
      const { rfqId } = req.query;

      if (!rfqId || isNaN(rfqId) || parseInt(rfqId) < 0)
        return res.status(400).json({
          success: false,
          message: 'RFQ id is invalid, please provide a valid RFQ id!'
        });

      const sheets = await rfqModel.getSheetsForDraftRfq(rfqId);

      return res.status(200).json({
        status: 1,
        sheets
      });
    } catch (error) {
      logError('rfqController error', error);
      logError(error);
      return res.status(500).json({
        success: false,
        message:
          'Failed to fetch drafted RFQ data, either the sheet id is invalid or this rfq is no longer available!',
        error: error.message
      });
    }
  },

  updateQuoteItems: async (req, res, next) => {
    const { quoteId } = req.params;
    let {
      rfq_id,
      rfq_no,
      // status,
      products,
      globalPaymentTerms,
      globalComment,
      global_payment_term_list,
      term_and_condition_files,
      vendorGSTIN,
      global_charges
    } = req.body;

    const user = req.user;

    // Check if all required fields are present in each product
    if (!products.every((product) => product.product_id)) {
      return res.status(400).json({
        message: 'Missing required fields in product items.',
        data: products
      });
    }

    try {
      // Check if the quote exists. F-QUOTE-NOTFOUND-001:
      // rfqModel.checkIfExists returns an empty array (truthy) when no row
      // matches, so the bare `if (!quoteExists)` guard never fires and the
      // next line crashes on quoteExists[0]. Treat array-length zero as
      // not-found and respond with 404.
      const quoteExists = await rfqModel.checkIfExists(
        'tbl_quotes',
        `id = '${quoteId}'`
      );
      if (!quoteExists || quoteExists.length === 0) {
        return res.status(404).json({ status: 0, message: 'Quote not found.' });
      }

      // Get RFQ details to check dates
      const rfqDetails = await rfqModel.getRFQDetails(quoteExists[0].rfq_id);
      if (!rfqDetails || rfqDetails.length === 0) {
        return res.status(404).json({
          status: 0,
          message: 'RFQ not found!'
        });
      }

      const now = new Date();
      const bidEndDate = rfqDetails[0].bid_end_date
        ? new Date(rfqDetails[0].bid_end_date)
        : null;
      const raStartDate = rfqDetails[0].ra_start_date
        ? new Date(rfqDetails[0].ra_start_date)
        : null;
      const raEndDate = rfqDetails[0].ra_end_date
        ? new Date(rfqDetails[0].ra_end_date)
        : null;
      const isReverseAuction = rfqDetails[0].reverse_auction === 1;

      // Use exact bid_end_date time for deadline enforcement
      const bidEndDateTime = bidEndDate;

      // Check if RFQ is closed (highest priority)
      if (rfqDetails[0].status === 2) {
        return res.status(400).json({
          status: 3,
          message: 'RFQ is Closed'
        });
      }

      // Check if reverse auction is active (second priority)
      const isReverseAuctionActive =
        isReverseAuction &&
        raStartDate &&
        raEndDate &&
        now >= raStartDate &&
        now <= raEndDate;

      // If reverse auction is active, allow quote submission
      if (isReverseAuctionActive) {
        // Continue with quote submission - this is allowed
      }
      // Otherwise check other conditions
      else {
        // Check if all products are finalized
        const productsFinalized = await rfqModel.checkAllProductsFinalized(
          quoteExists[0].rfq_id,
          user.id
        );
        if (productsFinalized) {
          return res.status(400).json({
            status: 3,
            message: 'All Products are Finalized'
          });
        }

        // Check if past bid end date - but allow if there are active negotiation rounds
        if (bidEndDateTime && now > bidEndDateTime) {
          // Check if any active negotiation round exists for this RFQ
          const activeNegotiationRounds = await db.any(
            `SELECT nr.id, cp.covered_product_id AS rfq_product_id
             FROM tbl_negotiation_rounds nr
             CROSS JOIN LATERAL (
               SELECT nr.rfq_product_id AS covered_product_id
               WHERE nr.rfq_product_id IS NOT NULL
               UNION
               SELECT (p_->>'rfq_product_id')::int
               FROM jsonb_array_elements(COALESCE(nr.products,'[]'::jsonb)) p_
               WHERE p_->>'rfq_product_id' IS NOT NULL
               UNION
               -- RFQ-level entries (payment terms / global charges) keep the
               -- round registered as active even with no product entries.
               SELECT NULL::int
               FROM jsonb_array_elements(COALESCE(nr.products,'[]'::jsonb)) p_
               WHERE (p_->>'is_rfq_level')::boolean IS TRUE
             ) cp
             WHERE nr.rfq_id = $1 AND nr.status = 'ACTIVE' AND nr.end_date > NOW()`,
            [quoteExists[0].rfq_id]
          );

          // Only block if there are NO active negotiation rounds
          if (!activeNegotiationRounds || activeNegotiationRounds.length === 0) {
            // Different messages based on reverse auction status
            let message = 'Bidding Period has Ended';

            if (isReverseAuction) {
              if (raEndDate && now > raEndDate) {
                message = 'Reverse Auction has Ended';
              } else if (raStartDate && now < raStartDate) {
                message = 'Bidding Period Ended (Reverse Auction Pending)';
              } else if (!raStartDate || !raEndDate) {
                message = 'Bidding Period Ended (RA Dates Invalid)';
              }
            }

            return res.status(400).json({
              status: 3,
              message: message
            });
          }

          // Active negotiation rounds exist - validate per-product
          const activeNegotiationProductIds = new Set(
            activeNegotiationRounds.map(r => r.rfq_product_id)
          );

          // Verify submitted products are limited to those with active negotiation rounds
          if (products && products.length > 0) {
            for (const product of products) {
              if (!product.product_id) continue;
              // Skip products with no meaningful quote data
              if (product.comment === '' && (!product.document_files || product.document_files.length <= 0) && (product.unit_price === '' || product.unit_price == 0)) continue;

              const rfqProductResult = await db.oneOrNone(
                `SELECT id FROM tbl_rfq_products WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3`,
                [quoteExists[0].rfq_id, product.product_id, product.variant]
              );

              if (rfqProductResult && !activeNegotiationProductIds.has(rfqProductResult.id)) {
                return res.status(400).json({
                  status: 3,
                  message: `Bidding period has ended. This product cannot be updated as it does not have an active negotiation round.`
                });
              }
            }
          }
        }

        // Check if RFQ has no bid end date
        if (!bidEndDate) {
          return res.status(400).json({
            status: 3,
            message: 'RFQ Not Open for Bidding'
          });
        }
      }

      // Check for open clarification - blocks all vendors from quoting
      const openClarification = await rfqModel.checkActiveClarification(
        quoteExists[0].rfq_id
      );
      if (openClarification) {
        // For emails/UX we sometimes need vendor code; keep same structure
        const vendorCode = `VEN-${openClarification.raised_by_vendor_id || 'UNKNOWN'}`;
        return res.status(400).json({
          status: 3,
          message:
            'Quote update is blocked. There is an open clarification pending response.',
          data: {
            clarification_id: openClarification.id,
            raised_by_vendor_code: vendorCode,
            subject: openClarification.subject,
            created_at: openClarification.created_at
          }
        });
      }

      // Build slug map for enriching charges
      const chargeNamesRows = await db.any(
        `SELECT name, slug FROM tbl_charge_names WHERE created_by IS NULL OR created_by = $1`,
        [user.id]
      );
      const slugMap = new Map(chargeNamesRows.map(c => [c.name.toLowerCase(), c.slug]));
      const enrichCharges = (charges) => (charges || []).map(c => ({
        ...c,
        slug: slugMap.get(c.name?.toLowerCase()) || rfqController._generateChargeSlug(c.name || '')
      }));

      // Per-product other_charges: comment is mandatory and capped at 30
      // chars (matches the send-quote modal UI). Stricter than the global
      // charges rule below.
      const PRODUCT_CHARGE_COMMENT_MAX = 30;
      const validateProductChargeComments = (charges, label) => {
        for (const c of charges || []) {
          const comment = c?.comment != null ? String(c.comment) : '';
          if (!comment.trim()) {
            return `${label}: "${c.name || 'Unnamed charge'}" requires a comment.`;
          }
          if (comment.length > PRODUCT_CHARGE_COMMENT_MAX) {
            return `${label}: "${c.name || 'Unnamed charge'}" comment cannot exceed ${PRODUCT_CHARGE_COMMENT_MAX} characters.`;
          }
        }
        return null;
      };
      // Global charges keep the original "tax > 0 ⇒ comment required" rule —
      // its UI hasn't been migrated to mandatory-everywhere yet.
      const validateGlobalChargeComments = (charges, label) => {
        for (const c of charges || []) {
          if (Number(c.tax) > 0 && (!c.comment || !String(c.comment).trim())) {
            return `${label}: "${c.name}" has tax greater than 0 but no comment/reason provided.`;
          }
        }
        return null;
      };

      for (const product of products) {
        const productLabel = product.product_name || `Product ${product.product_id}`;
        const err = validateProductChargeComments(product.other_charges, productLabel);
        if (err) {
          return res.status(400).json({ status: 0, message: err });
        }
      }
      const globalChargeErr = validateGlobalChargeComments(global_charges, 'Global charges');
      if (globalChargeErr) {
        return res.status(400).json({ status: 0, message: globalChargeErr });
      }

      // Enrich other_charges with slugs for each product
      for (const product of products) {
        if (product.other_charges) {
          product.other_charges = enrichCharges(product.other_charges);
        }
      }

      const enrichedGlobalCharges = enrichCharges(global_charges);

      // Server-authoritative recompute: discard the client-supplied
      // total_price on each product and derive it from the pricing engine.
      // The engine uses the same enriched other_charges that will be
      // persisted, so the stored total cannot drift from the inputs.
      for (const product of products) {
        const engineOut = pricingEngine.calculateLineTotal({
          unit_price: product.unit_price,
          quantity: product.quantity,
          tax: product.tax,
          tax_mode: product.tax_mode,
          other_charges: Array.isArray(product.other_charges)
            ? product.other_charges
            : [],
        });
        product.total_price = engineOut.total;
      }

      let paymentTermAndCommentChanges = false;

      // update global comment, payment term and gstin
      const currentGstin = quoteExists[0].gstin ?? null;
      const newGstin = vendorGSTIN && String(vendorGSTIN).trim() ? String(vendorGSTIN).trim() : null;
      if (
        globalPaymentTerms !== quoteExists[0].global_payment_term ||
        globalComment !== quoteExists[0].global_comment ||
        newGstin !== currentGstin ||
        JSON.stringify(enrichedGlobalCharges) !== JSON.stringify(quoteExists[0].global_charges || [])
      ) {
        const tbl_quotes_data = {
          rfq_id: quoteExists[0].rfq_id,
          rfq_no: quoteExists[0].rfq_no,
          status: quoteExists[0].status,
          created_by: quoteExists[0].created_by,
          updated_by: quoteExists[0].updated_by,
          timestamp: new Date().toISOString(),
          is_regret: 0,
          global_payment_term: globalPaymentTerms,
          global_comment: globalComment,
          gstin: newGstin,
          global_charges: JSON.stringify(enrichedGlobalCharges)
        };
        await rfqModel.update('tbl_quotes', tbl_quotes_data, quoteId);

        paymentTermAndCommentChanges = true;
      }

      // Process each product in the request
      const quoteItemChanges = await Promise.all(
        products
          .map((product) => {
            logger.debug({ data: product }, 'UPDATING:');
            if (
              product.comment == '' &&
              product.document_files?.length <= 0 &&
              (product.unit_price == '' || product.unit_price == 0)
            ) {
              return null;
            }
            return rfqModel.updateQuoteItemWithHistory(
              quoteId,
              product,
              quoteExists[0]
            );
          })
          .filter(Boolean)
      );

      logger.debug({ data: quoteItemChanges }, 'QUOTE ITEM CHANGES:');

      // Replace the quote's global attachments. When the key is present we
      // treat the incoming list as the full desired set: clear the existing
      // rows first, then insert the new ones. This makes updates reflect both
      // additions and removals (and avoids duplicating already-saved files on
      // every re-save). An empty array clears all attachments; an absent key
      // leaves them untouched.
      if (Array.isArray(term_and_condition_files)) {
        await rfqModel.deleteWithReturnIds('tbl_quotes_files', {
          quote_id: quoteId,
          file_type: 'term_and_condition'
        });
        for (const url of term_and_condition_files) {
          await rfqModel.insert('tbl_quotes_files', {
            quote_id: quoteId,
            file_type: 'term_and_condition',
            file_url: url
          });
        }
      }

      // delete payment terms list
      const deletedTerms = global_payment_term_list.deletedTerms || [];
      if (deletedTerms.length > 0) {
        await generalModel.deleteManyByIds(
          'tbl_quotes_payment_terms',
          deletedTerms
        );
      }

      // update payment terms list
      const updatedTerms = global_payment_term_list.updatedTerms || [];
      if (updatedTerms.length > 0) {
        await generalModel.updateMany(
          'tbl_quotes_payment_terms',
          updatedTerms,
          'id'
        );
      }

      // insert new payment terms list
      const createdTerms = global_payment_term_list?.createdTerms ?? [];
      if (createdTerms.length > 0) {
        const termsWithQuoteId = createdTerms.map(({ action, ...t }) => ({
          value: Number(t.value) || 0,
          type: t.type || 'advance',
          days: t.type === 'credit' && t.days != null ? Number(t.days) : null,
          comment: t.comment?.trim() || null,
          quote_id: quoteId,
          created_by: user.id
        }));
        await generalModel.insertMany(
          'tbl_quotes_payment_terms',
          termsWithQuoteId
        );
      }

      // Insert new document_files for each product if exists
      const fileUpdates = await Promise.all(
        products.map(async (prodItem) => {
          const quote_item = await rfqModel.getQuoteItem(quoteId, prodItem);
          const file_links = prodItem.document_files;

          if (file_links && file_links.length > 0) {
            const file_records = file_links.map((link) => ({
              quote_item_id: quote_item.id,
              file_type: 'DOC',
              file_url: link,
              created_at: new Date()
            }));

            if (file_records.length > 0) {
              return rfqModel.insertArray(
                file_records,
                ['quote_item_id', 'file_type', 'file_url', 'created_at'],
                'tbl_quote_item_files'
              );
            }
          }
        })
      );

      const anyQuoteChanged =
        fileUpdates || quoteItemChanges.some((result) => result.changed);
      // const changedProducts = quoteItemChanges.filter((result) =>  result.changed);
      // console.log(" quoteItemChanges ", changedProducts)

      // Save quotes to negotiation round quotes table if there's an active negotiation round
      try {
        for (const prodItem of products) {
          // Find the rfq_product_id for this product
          const rfqProductResult = await db.oneOrNone(
            `SELECT id FROM tbl_rfq_products 
             WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3`,
            [rfq_id, prodItem.product_id, prodItem.variant]
          );

          if (rfqProductResult) {
            const rfqProductId = rfqProductResult.id;

            // Check if there's an active negotiation round for this product
            const activeRound = await db.oneOrNone(
              `SELECT id, rfq_product_id FROM tbl_negotiation_rounds nr
               WHERE nr.rfq_id = $1 AND nr.status = 'ACTIVE'
                 AND nr.end_date > NOW()
                 AND (nr.rfq_product_id = $2 OR EXISTS (
                   SELECT 1 FROM jsonb_array_elements(COALESCE(nr.products,'[]'::jsonb)) p_
                   WHERE (p_->>'rfq_product_id')::int = $2
                 ))
               ORDER BY nr.round_number DESC
               LIMIT 1`,
              [rfq_id, rfqProductId]
            );

            if (activeRound) {
              // Check if vendor has already submitted a quote for this round
              const existingNegotiationQuote = await db.oneOrNone(
                `SELECT id FROM tbl_negotiation_round_quotes 
                 WHERE negotiation_round_id = $1 AND vendor_id = $2 AND rfq_product_id = $3`,
                [activeRound.id, user.id, rfqProductId]
              );

              if (!existingNegotiationQuote) {
                // Insert negotiation round quote
                await db.none(
                  `INSERT INTO tbl_negotiation_round_quotes 
                    (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at)
                   VALUES ($1, $2, $3, $4, NULL, NOW())`,
                  [activeRound.id, user.id, rfqProductId, prodItem.total_price]
                );
              }
            }
          }
        }
      } catch (negotiationError) {
        // Log but don't fail the main quote update
        logError('Error saving negotiation round quote during update', negotiationError);
      }

      let status = true;
      if (!anyQuoteChanged && !paymentTermAndCommentChanges) {
        status = false;
      }

      // Bump the quote-level timestamp on any real change so the vendor's
      // "last updated" date reflects the latest revision. The conditional
      // global-fields update above only fires for global changes; per-item
      // edits (price/comment/files) would otherwise leave TQ.timestamp
      // frozen at first submission.
      if (status) {
        try {
          await db.none(
            `UPDATE tbl_quotes SET timestamp = NOW() WHERE id = $1`,
            [quoteId]
          );
        } catch (timestampError) {
          logError('Failed to bump tbl_quotes.timestamp on update', timestampError);
        }
      }

      if (status) {
        try {
          const buyerDetails = await rfqModel.getRFQCreatedBy(rfq_id);
          await sendRevisedQuotationEmailToVendor(
            buyerDetails,
            user,
            rfq_id,
            rfq_no
          );
          await sendRevisedQuotationEmailToBuyer(
            buyerDetails,
            quoteItemChanges,
            user,
            rfq_id,
            rfq_no
          );
        } catch (notificationError) {
          logError('Failed to send quote update notifications', notificationError);
        }
      }

      return res.status(200).json({
        status: status,
        message: status
          ? 'Quote items updated successfully'
          : 'No updates made as the quotes and global terms remain unchanged',
        data: {
          quoteItems: quoteItemChanges,
          globalFilesAdded: fileUpdates,
          globalTermComment: paymentTermAndCommentChanges
            ? 'global comment and payment term is updated'
            : 'global comment and payment term is remain unchanged'
        }
      });
    } catch (error) {
      logError('Failed to update quote items', error);
      return res
        .status(500)
        .json({ message: 'Error updating quote items', error: error.message });
    }
  },
  productPriceStats: async (req, res, next) => {
    if (!req.is_verified) {
      res
        .status(400)
        .json({
          success: false,
          message: 'you are not login'
        })
        .end();
    }

    try {
      const { search_key } = req.body;
      const user_id = req.user.id;

      // find product price stats like, min, avg, max
      const priceHistoryMarket = await rfqModel.productPriceStatsMarket(
        search_key
      );
      const priceHistoryPersonal =
        await rfqModel.productPriceStatsLastQuoteAndFinilizeForUser(
          search_key,
          user_id
        );

      res
        .status(200)
        .json({
          status: 2,
          data: {
            market: priceHistoryMarket,
            personal: priceHistoryPersonal
          }
        })
        .end();
    } catch (error) {
      logError(error);
      res.status(500).json({
        success: false,
        message: 'error in finding product price stats',
        error: error.message
      });
    }
  },

  sendQueryMessage: async (req, res) => {
    const { rfq_id, receiver_id, message_text } = req.body;
    const files = req.files;
    const sender_id = req.user.id;
    const sender_type = req.user.user_type;

    try {
      const data = {
        rfq_id,
        sender_id,
        receiver_id,
        sender_type,
        message_text
      };

      const rfqDetails = await rfqModel.getRfqDetailsById(rfq_id);
      if (!rfqDetails) throw new Error(`RFQ with ID ${rfq_id} not found`);

      const rfqNumber = rfqDetails.rfq_no;
      const userIdForTheme = rfqDetails?.created_by || sender_id;
     

      const result = await rfqModel.insertReturnId('tbl_query_messages', data);
      const message_id = result[0].id;

      const filesData = files.map((file) => ({
        message_id: message_id,
        file_name: file.originalname,
        file_url: file.location
      }));
      // console.log("--------------------->filedata", filesData);

      if (filesData.length)
        await rfqModel.insertArray(
          filesData,
          ['message_id', 'file_name', 'file_url'],
          'tbl_query_message_files'
        );

      const sender_details = await userModel.user_profile_detail(sender_id);
      const senderDetails = sender_details[0];

      const receiver_details = await userModel.user_profile_detail(receiver_id);
      if (receiver_details.length > 0) {
        const receiverDetails = receiver_details[0];
        const spocList = await vendorModel.getSpocDetails(receiver_id, rfq_id);

        const receiverCompanyName = receiverDetails?.company_name || receiverDetails?.organization_name || receiverDetails?.name;
        const senderCompanyName = senderDetails?.company_name || senderDetails?.organization_name || senderDetails?.name;
        
        const headerContent = ` <div>
           <h2>Hello ${receiverCompanyName} </h2>
           </div>`;

        const containerContent = `
              <div>
                <div style="font-size:16px;">
                  ${
                    sender_type == 2
                      ? `${senderCompanyName} has a question about your submitted quotation for #${rfqNumber}. Quick responses help build trust and increase your chances of closing the order.`
                      : `One of your vendors has a question regarding your RFQ #${rfqNumber}. Here's the vendor details: <br> <strong>Vendor: </strong> ${senderCompanyName}`
                  }
                </div>
                              
               <h4> Query </h4>
                <blockquote style='border-left:3px solid #203367; font-size:16px; margin:10px 0; margin-top:-10px; padding-left:15px; padding:10px; border-radius:10px; background-color:#eef3f6; color:#333333; margin-bottom:30px;'>
                  ${message_text}
                </blockquote>
              
                <a href=${process.env.FRONT_END_WEBSITE}/dashboard/${
          sender_type == 2 ? 'buyer' : 'vendor'
        }/query?rfq_id=${rfq_id}&role=${sender_type == 2 ? 'buyer' : 'vendor'}
                  style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
                  Respond to Query
                </a>
              
                <p style="font-size:16px; text-align:center;">  
                  ${
                    sender_type == 2
                      ? 'Your quick response can help avoid delays!'
                      : 'Thank you for helping ensure a smooth, transparent process.'
                  }
                </p>
              </div>
              `;

        const dynamicHTML = generateEmailTemplate(
          headerContent,
          containerContent,
          userIdForTheme
        );

        const emailSubject =
          sender_type == 3
            ? `Vendor Query on Your RFQ #${rfqNumber}`
            : `Buyer Query for #${rfqNumber} - Your Response Needed`;

        const mailRecipients = {
          from: `${senderCompanyName} ${
            Config.masterEmail
          }`,
          subject: emailSubject,
          html: dynamicHTML
        };

        if (spocList && spocList.length > 0) {
          mailRecipients.to = spocList.map((spoc) => spoc.email);
          mailRecipients.cc = receiverDetails.email;
        } else {
          mailRecipients.to = receiverDetails.email;
        }

        // Only add project members to CC when email is going to buyer (sender_type == 3 means vendor sending)
        // Do NOT CC project members when email is going to vendor to prevent data leakage
        if (sender_type == 3) {
          const projectMemberEmails = await getProjectMemberEmailsForRFQ(rfq_id);
          addProjectMembersToCC(mailRecipients, projectMemberEmails);
        }

        sendMail(mailRecipients);

        dispatchNotification({
          userIds: [receiver_id],
          senderUserId: sender_id,
          category: 'clarification',
          type: sender_type == 3 ? 'clarification_from_vendor' : 'clarification_from_buyer',
          title: sender_type == 3
            ? `Vendor query on RFQ #${rfqNumber}`
            : `Buyer query on RFQ #${rfqNumber}`,
          body: `${senderCompanyName}: ${String(message_text || '').slice(0, 160)}`,
          data: { rfq_id, message_id, sender_id, sender_type },
          actionUrl: `${process.env.FRONT_END_WEBSITE || ''}/dashboard/${sender_type == 2 ? 'buyer' : 'vendor'}/query?rfq_id=${rfq_id}&role=${sender_type == 2 ? 'buyer' : 'vendor'}`
        }).catch((err) => logError('dispatch clarification message failed', err));

        const notificationData = {
          type: 'New Message',
          title: 'New RFQ Message Received',
          message: `You have received a new message from ${senderCompanyName}.`,
          additional_data: { user_type: receiverDetails.user_type }
        };
        const payload = {
          title: `Hello ${receiverCompanyName}`,
          body: 'You have a new message regarding an RFQ.'
        };
        const ss = JSON.parse(receiverDetails.endpoint);
        sendNotification(receiver_id, '', notificationData, payload, ss);
      }

      res
        .status(200)
        .json({
          status: 1,
          data: {
            message: 'Message sent successfully'
          }
        })
        .end();
    } catch (error) {
      logError(error);
      res.status(500).json({
        success: false,
        message: 'Error in sending message',
        error: error.message
      });
    }
  },
  sendBroadcastQueryMessageToVendors: async (req, res) => {
    const { rfq_id, receiver_ids, message_text } = req.body;
    const files = req.files;
    const sender_id = req.user.id;
    const sender_type = req.user.user_type;

    try {
      const normalizeReceiverIds = (raw) => {
        if (!raw) return [];

        let parsed = raw;
        if (typeof raw === 'string') {
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            parsed = raw.split(',').map((id) => id.trim());
          }
        }

        if (!Array.isArray(parsed)) {
          parsed = [parsed];
        }

        const ids = parsed
          .map((entry) => {
            if (typeof entry === 'object' && entry !== null) {
              return entry.id || entry.user_id || entry.receiver_id;
            }
            const parsedId = parseInt(entry, 10);
            return Number.isNaN(parsedId) ? null : parsedId;
          })
          .filter((id) => Number.isInteger(id));

        return Array.from(new Set(ids));
      };

      const receiverIdList = normalizeReceiverIds(receiver_ids);

      if (!receiverIdList.length) {
        return res.status(400).json({
          status: 0,
          message: 'No valid vendors selected for broadcast.'
        });
      }

      // Get RFQ and sender details (unchanged)
      const rfqDetails = await rfqModel.getRfqDetailsById(rfq_id);
      if (!rfqDetails) throw new Error(`RFQ with ID ${rfq_id} not found`);

      const rfqNumber = rfqDetails.rfq_no;
      const sender_details = await userModel.user_profile_detail(sender_id);
      const senderDetails = sender_details[0];

      const determineBatchSize = (count) => (count <= 2000 ? 1000 : 500);

      const MESSAGE_BATCH_SIZE = determineBatchSize(receiverIdList.length);
      const insertedMessageIds = [];
      const messageKeys = [
        'rfq_id',
        'sender_id',
        'receiver_id',
        'sender_type',
        'message_text',
        'created_at'
      ];

      for (let i = 0; i < receiverIdList.length; i += MESSAGE_BATCH_SIZE) {
        const chunk = receiverIdList.slice(i, i + MESSAGE_BATCH_SIZE);
        const insertedChunk = await db.tx(async (t) => {
          const timestamp = new Date();
          const messagePayload = chunk.map((receiverId) => ({
            rfq_id,
            sender_id,
            receiver_id: receiverId,
            sender_type,
            message_text,
            created_at: timestamp
          }));

          const insertedMessages = await rfqModel.insertArray(
            messagePayload,
            messageKeys,
            'tbl_query_messages',
            t
          );

          if (files && files.length > 0 && insertedMessages.length > 0) {
            const filePayload = [];
            for (const message of insertedMessages) {
              files.forEach((file) => {
                filePayload.push({
                  message_id: message.id,
                  file_name: file.originalname,
                  file_url: file.location
                });
              });
            }

            await rfqModel.insertArray(
              filePayload,
              ['message_id', 'file_name', 'file_url'],
              'tbl_query_message_files',
              t
            );
          }

          return insertedMessages;
        });

        insertedMessageIds.push(...insertedChunk.map((msg) => msg.id));
      }

      if (!insertedMessageIds.length) {
        return res.status(500).json({
          status: 0,
          message: 'Failed to broadcast messages.'
        });
      }

      // Get all receiver details in one query
      // const receiverDetails = await userModel.getUsersByIds(receiver_ids.map(r => r.id));

      // Prepare notifications (if needed)
      // const notifications = receiverDetails.map(receiver => ({
      //   type: 'New Message',
      //   title: 'New RFQ Message Received',
      //   message: `You have received a new message from ${senderDetails.name}.`,
      //   additional_data: { user_type: receiver.user_type }
      // }));

      // Bulk insert notifications if needed
      // await notificationModel.insertArray(notifications, [...fields...], 'notifications_table');

      res.status(200).json({
        status: 1,
        message: 'Broadcast message sent to all vendors successfully.'
      });
    } catch (error) {
      logError(error);
      res.status(500).json({
        success: false,
        message: 'Error broadcasting message',
        error: error.message
      });
    }
  },
  negotiatePrice: async (req, res) => {
    const { productId, vendorIds, targetPrice , rfq_id} = req.body;
    const user_id = req.user.id;
    try {
      // Create payload for multiple vendors
      let payload = vendorIds.map((vendorId) => {
        return {
          tbl_rfq_product_id: productId,
          target_price: targetPrice,
          created_by: user_id,
          vendor_id: vendorId
        };
      });

      // console.log("checking the payload here vendor ID", payload);

      // Keys for pg-promise insert
      const keys = [
        'tbl_rfq_product_id',
        'target_price',
        'created_by',
        'vendor_id'
      ];
      const vendorProductList =
        await rfqModel.getRfqProductvendorsForTargetPrice(productId, vendorIds);

      // Insert using insertArray helper
      const result = await rfqModel.insertArray(
        payload,
        keys,
        'tbl_rfq_product_target_price'
      );


      await sendMailToVendorsForTargetPrice(
        vendorProductList,
        targetPrice,
        user_id
      );

    
      // 👇 Check if an entry already exists
      const existingActivity = await rfqModel.checkIfExists(
        'tbl_quote_activity',
        `rfq_id = ${rfq_id} AND current_status = 'NEG' AND created_by = ${req.user.id}`
      );
      logger.debug({ data: existingActivity }, 'Existing activity check');
      if (existingActivity.length === 0) {
        const insertIntoQuoteActivity = await rfqModel.insertIntoQuoteActivity({
          rfq_id: rfq_id,
          current_status: "NEG",
          created_by: req.user.id
        });
        logger.debug({ data: insertIntoQuoteActivity }, 'Inserted value into quote activity');
      } else {
        logger.debug('Skipped insert - already exists for rfq_id ${rfq_id} and user ${req.user.id}');
      }
    

      res.json({
        status: 1,
        message: 'Target price(s) set successfully',
        data: result
      });
    } catch (error) {
      logError('Error setting target price', error);
      res.status(500).json({
        status: 0,
        message: 'Internal server error'
      });
    }
  },

  getTargetPriceHistrory: async (req, res) => {
    const { rfq_product_id } = req.params;
    const limit = req.query.limit === '1' ? 1 : null;
    const user_id = req.user.id;
    try {
      if (!rfq_product_id) {
        return res.status(400).json({
          status: 0,
          message: 'rfq_product_id is required'
        });
      }
      const validate = await rfqModel.checkIfExists(
        'tbl_rfq_products',
        `id = ${rfq_product_id}`
      );
      if (!validate || validate.length === 0) {
        return res.status(404).json({
          status: 0,
          message: 'RFQ Product not found'
        });
      }
      const history = await rfqModel.getTargetPriceHistory(
        rfq_product_id,
        user_id,
        limit
      );
      if (!history || history.length === 0) {
        return res.status(404).json({
          status: 0,
          message: 'No target price history found for this RFQ product'
        });
      }
      res.status(200).json({
        status: 1,
        message: 'Target price history retrieved successfully',
        data: history
      });
    } catch (error) {
      res.status(500).json({
        status: 0,
        message: 'Error retrieving target price history',
        error: error.message
      });
    }
  },

  listQueryMessages: async (req, res) => {
    const { rfq_id, receiver_id } = req.body;
    const sender_id = req.user.id;

    try {
      const messages = await rfqModel.getQueryMessages(
        rfq_id,
        sender_id,
        receiver_id
      );
      res
        .status(200)
        .json({
          status: 1,
          data: messages
        })
        .end();
    } catch (error) {
      logError(error);
      res.status(500).json({
        success: false,
        message: 'Error in listing messages for vendor',
        error: error.message
      });
    }
  },

  listQueries: async (req, res) => {
    const { rfq_id, user_name } = req.body;
    const user_id = req.user.id;
    const user_type = req.user.user_type;

    try {
      if (![2, 3, 8, 9, 10].includes(user_type)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user type'
        });
      }

      const summaries = await rfqModel.getQueryParticipantsSummary(
        rfq_id,
        user_id,
        user_type,
        user_name
      );

      res
        .status(200)
        .json({
          status: 1,
          data: summaries
        })
        .end();
    } catch (error) {
      logError(error);
      res.status(500).json({
        success: false,
        message: 'Error in listing queries for RFQ',
        error: error.message
      });
    }
  },



addClauseUsingFile : async (req, res) => {
  // Changes by Agnij 2025-05-14 [Refactor: use bulk insert, clean up logs, new product name function]
  try {
    let file = req.file;
    const { rfq_id, rfq_product_id } = req.body;
    if (!file) {
      return res.status(400).json({ status: 0, message: "No file provided" });
    }
    if (!rfq_id || !rfq_product_id) {
      // This is a technical summary request - extract clauses without product context
      const { email, phone, file_name } = req.body;
      let user = req.user ?? null;
      let didUserRegister = false;

      if(!user) {
        const userExists = await userModel.user_exist(email, phone);
        if(userExists && userExists.length > 0) {
          return res.status(403).json({
            status: 3,
            message: 'User already exist with given credentials, please login!'
          })
        }
  
        const registeredUser = await UsersController.registerBuyerAnonymously(req.body);
        if(!registeredUser) {
          return res.status(400).json({
            status: 3,
            message: 'Failed to register, please try again later. If this issue persists please contact our support team!'
          })
        }

        user = registeredUser;
        didUserRegister = true;
      }
      const result = await extractDatasheetSummary(file);
      
      if (!result.status) {
        let userMessage = result.message || "Failed to extract information";
        if (userMessage.match(/no relevant information detected|no information detected/i)) {
          userMessage = "No relevant information was found in the uploaded document. Please ensure the document contains technical specifications.";
        }
        return res.json({ status: 0, message: userMessage, errors: [{ Row: 0, error: userMessage }], user, didUserRegister });
      }
      
      if (!result.clauses || result.clauses.length === 0) {
        return res.json({
          status: 0,
          message: "No information was found in the document",
          errors: [{ Row: 0, error: "No information detected in the document" }],
          user, didUserRegister
        });
      }
      
      // Return the extracted clauses for technical summary
      return res.json({
        status: 1,
        message: "Technical document analyzed successfully",
        clauses: result,
        structuredData: result.structuredData,
        user, didUserRegister
      });
    }
    // Use new product/variant name function
    const productName = await rfqModel.getProductOrVariantNameByRfqProductId(rfq_product_id);
    // const result = await generativeAI.extractClauses(file, productName);
    const result = await extractDatasheetSummary(file);

      const techEvaluationClauses = result?.structuredData
        .map((item) => {
          if (item.key && item.value) return `${item.key} - ${item.value}`;
          return JSON.stringify(item);
        })
        .filter(Boolean);

    if (!result.status) {
      let userMessage = result.message || "Failed to extract information";
      if (userMessage.match(/no relevant information detected|no information detected/i)) {
        userMessage = "No relevant information for this product was found in the uploaded document. Please ensure the document is for the selected product.";
      }
      return res.json({ status: 0, message: userMessage, errors: [{ Row: 0, error: userMessage }] });
    }
    if (!result.clauses || result.clauses.length === 0) {
      return res.json({
        status: 0,
        message: productName 
          ? `No information was found for product '${productName}'`
          : "No information was found in the document",
        errors: [{ Row: 0, error: productName ? `No relevant information detected for product '${productName}'` : "No information detected in the document" }]
      });
    }
    // Bulk insert all clauses at once
    const insertResult = await rfqModel.addManyClauses(rfq_id, rfq_product_id, techEvaluationClauses);
    return res.json({
      status: insertResult.status,
      message: insertResult.status ? `${insertResult.inserted} of ${result.clauses.length} items added successfully for '${productName}'` : insertResult.message,
      errors: insertResult.status ? [] : [{ Row: 0, error: insertResult.error }],
      clauses: result
    });
  } catch (error) {
    res.status(500).json({ status: 0, message: "Error adding information", errors: [{ Row: 0, error: error?.message }] });
  }
},
processBoqAndDownload : async (req, res) => {
  try {

    const response = await generativeAI.processBoqAndDownload(req.file);

      res
        .status(200)
        .json({
          status: 1,
          data: response,
          mail_sent: true
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          error: error,
          message: Config.errorText.value
        })
        .end();
    }
  },
  addClause: async (req, res) => {
    try {
      // console.log("add clause controller");
      const { rfq_id, rfq_product_id, clause_text, file_url, clause_type = 'clause', weightage = null } = req.body;
      // console.log("bodyy = ",req.body);

      if (!rfq_id || !rfq_product_id || !clause_text) {
        return res.status(400).json({
          status: 0,
          message:
            'Invalid input. Ensure RFQ_ID, rfq_product_id and clauses are provided correctly.'
        });
      }
      // Calling  the model function
      // console.log("add clause controller working");

      const result = await rfqModel.addClause(
        rfq_id,
        rfq_product_id,
        clause_text,
        file_url,
        clause_type,
        weightage
      );

      // F-CLAUSE-NOTFOUND-001: the model returns {status:0, message} for
      // not-found cases (RFQ id missing, rfq_product_id missing). Forwarding
      // that as HTTP 200 misrepresents the outcome to any HTTP-level client.
      // Map "does not exist" to 404, other status:0 results to 400.
      if (result?.status === 0) {
        const isNotFound = /does not exist|not found/i.test(result.message || '');
        return res.status(isNotFound ? 404 : 400).json(result).end();
      }

      res.status(200).json(result).end();
    } catch (error) {
      // console.log("controller error")
      logError('Error in addClause', error);
      res.status(500).json({
        success: false,
        message: 'Error in adding clauses to technical evaluation.',
        error: error.message
      });
    }
  },

  updateClause: async (req, res) => {
    try {
      const { clause_id, clause_text, file_url, clause_type, weightage } = req.body;
      // console.log("data from update clause controller = ",clause_id,clause_text,file_url);

      const result = await rfqModel.updateClause(
        clause_id,
        clause_text,
        file_url,
        clause_type,
        weightage
      );

      res.status(200).json(result).end();
    } catch (error) {
      logError(error);
      res.status(500).json({
        success: false,
        message: 'Error in updating technical evaluation clause.',
        error: error.message
      });
    }
  },

  removeClause: async (req, res) => {
    try {
      const clause_id = parseInt(req.params.id);

      const result = await rfqModel.removeClause(clause_id);
      // console.log("result of remove clause = ",result);

      res.status(200).json(result).end();
    } catch (error) {
      logError(error);
      res.status(500).json({
        success: false,
        message: 'Error in deleting clause.',
        error: error.message
      });
    }
  },

getClauses: async (req, res) => {
  try {
    const rfq_id = req.params.id;
    const { pageSource } = req.query;

    const result = await rfqModel.getClauses(rfq_id);

    if (pageSource === "tech_evaluation") {
      // 👇 Check if an entry already exists
      const existingActivity = await rfqModel.checkIfExists(
        'tbl_quote_activity',
        `rfq_id = ${rfq_id} AND current_status = 'TE' AND created_by = ${req.user.id}`
      );
      logger.debug({ data: existingActivity }, 'Existing activity check');
      if (existingActivity.length === 0) {
        const insertIntoQuoteActivity = await rfqModel.insertIntoQuoteActivity({
          rfq_id: rfq_id,
          current_status: "TE",
          created_by: req.user.id
        });
        logger.debug({ data: insertIntoQuoteActivity }, 'Inserted value into quote activity');
      } else {
        logger.debug('Skipped insert - already exists for rfq_id ${rfq_id} and user ${req.user.id}');
      }
    } else {
      logger.debug('Skipped insert for pageSource: ${pageSource}');
    }

    res.status(200).json(result).end();
  } catch (error) {
    logError(error);
    res.status(500).json({
      success: false,
      message: 'Error in fetching clauses.',
      error: error.message
    });
  }
},



  addTechComment: async (req, res) => {
    try {
      const {
        clause_id,
        sender_id,
        receiver_id,
        text,
        file_url,
        product,
        vendor,
        rfq_no
      } = req.body;

      // Save tech comment
      const response = await rfqModel.addTechComment(
        clause_id,
        sender_id,
        receiver_id,
        text,
        file_url
      );
     const clause = await rfqModel.checkIfExists('tbl_rfq_product_tech_evaluation_clauses', `id = ${clause_id}`);
     const clausText = clause && clause.length > 0 ? clause[0].clause_text : '';

      if (response) {
        if (req.user.user_type == 3) {
          //Notice the vendor object is passed as buyer since this requet is coming from vendor and concerend prop value at frontend is same hence
          await sendAddTechCommentMailForBuyer(
            vendor,
            sender_id,
            product,
            clausText
          );
        } else if (req.user.user_type == 2) {
          //Mail t0 vendor from buyer
          await sendAddTechCommentMailForVendor(
            vendor,
            product,
            rfq_no,
            sender_id,
            clausText
          );
        }
      }

      res.status(200).json(response).end();
    } catch (error) {
      res.status(500).json({
        status: 0,
        message: 'Error storing comment.',
        error: error.message
      });
    }
  },

  getTechComments: async (req, res) => {
    try {
      const { clause_id, sender_id, receiver_id } = req.body;

    const user_id = req.user.id;
    const user_type = req.user.user_type;

      const response = await rfqModel.getTechComments(
        clause_id,
        sender_id,
        receiver_id,
        user_id,
        user_type
      );

      res.status(200).json(response).end();
    } catch (error) {
      res.status(500).json({
        status: 0,
        message: 'Error storing comment.',
        error: error.message
      });
    }
  },
  getSummarisedDeviation: async (req, res) => {
    try {
      const { rfq_id } = req.body;

      if (!rfq_id) {
        return res.status(400).json({
          status: 0,
          message: 'rfq_id is required'
        });
      }

      const result = await rfqModel.getSummarisedDeviation(rfq_id);

      if (!result || result.length === 0) {
        return res.status(404).json({
          status: 0,
          message: 'No deviations found for this RFQ'
        });
      }

      const genresult = await generativeAI.summariseTechDeviation(result);

      // Parse the response in case it's returned as a string
      let parsedResult;
      try {
        parsedResult =
          typeof genresult === 'string' ? JSON.parse(genresult) : genresult;
      } catch (parseError) {
        logError('Failed to parse Gemini response', parseError);
        throw new Error('Invalid response format from AI service');
      }

      res.status(200).json({
        status: 1,
        data: parsedResult
      });
    } catch (error) {
      logError('Error in getSummarisedDeviation API', error);
      res.status(500).json({
        status: 0,
        message: 'Error processing deviation summary',
        error:
          process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  },

  getDeviationPreviews: async (req, res) => {
    try {
      const { rfq_product_id, user_id } = req.body;
      if (!rfq_product_id) {
        return res.status(400).json({ status: 0, message: 'rfq_product_id is required' });
      }

      const result = await rfqModel.getDeviationPreviews(rfq_product_id, user_id || null);
      res.status(200).json({ status: 1, data: result });
    } catch (error) {
      logError('Error in getDeviationPreviews', error);
      res.status(500).json({ status: 0, message: 'Error fetching deviation previews' });
    }
  },

  addVendorResponse: async (req, res) => {
    try {
      const data = req.body;
      // console.log("API Input: ", req.body);

      // Validate input
      if (!data || !Array.isArray(data) || data.length === 0) {
        return res.status(400).json({
          status: 0,
          message: 'Invalid input. Please provide at least one vendor response'
        });
      }

      // Enforce: Tech evaluation responses cannot be updated after quote submission deadline.
      try {
        // We only need to compute the RFQ & deadline once; use the first response's clause_id
        const first = data[0];
        if (first?.clause_id) {
          const clauseId = parseInt(first.clause_id, 10);
          if (!Number.isNaN(clauseId)) {
            const deadlineRow = await db.oneOrNone(
              `
              SELECT r.id AS rfq_id,
                     r.rfq_no,
                     r.bid_end_date
              FROM tbl_rfq_product_tech_evaluation te
              JOIN tbl_rfq_products rp
                ON rp.id = te.tbl_rfq_product_id
              JOIN tbl_rfq r
                ON r.id = te.rfq_id
              JOIN tbl_rfq_product_tech_evaluation_clauses c
                ON c.tbl_rfq_product_tech_evaluation_id = te.id
              WHERE c.id = $1
              `,
              [clauseId]
            );

            if (deadlineRow?.bid_end_date) {
              const bidEnd = new Date(deadlineRow.bid_end_date);
              // Treat as end of that day in server timezone
              const endOfDay = new Date(
                bidEnd.getFullYear(),
                bidEnd.getMonth(),
                bidEnd.getDate(),
                23,
                59,
                59,
                999
              );
              const now = new Date();

              if (!Number.isNaN(endOfDay.getTime()) && now > endOfDay) {
                return res.status(400).json({
                  status: 3,
                  message:
                    'Technical evaluation responses are locked. The quote submission deadline has passed.',
                  data: {
                    rfq_id: deadlineRow.rfq_id,
                    rfq_no: deadlineRow.rfq_no,
                    bid_end_date: deadlineRow.bid_end_date
                  }
                });
              }
            }
          }
        }
      } catch (deadlineErr) {
        logError('Warning: failed to enforce tech eval deadline before saving vendor response', deadlineErr);
        // Do not block the request solely due to a failed deadline lookup; continue to process.
      }

      const response = await rfqModel.addVendorResponse(data);

      res.status(200).json(response).end();
    } catch (error) {
      logError('Error in addVendorResponse API:', error);
      res.status(500).json({
        status: 0,
        message: 'Error processing vendor response.',
        error: error.message
      });
    }
  },

  addtechEvaluationClearedVendors: async (req, res) => {
    try {
      const {
        rfq_id,
        product,
        vendor,
        vendor_id,
        rfq_product_tech_evaluation_id,
        status,
        reject_message
      } = req.body;
      // console.log("API Input: ", vendor_id,rfq_product_tech_evaluation_id,status,reject_message);
      const user_id = req.user.id;

      // Validate input
      if (!vendor_id || !rfq_product_tech_evaluation_id) {
        return res.status(400).json({
          status: 0,
          message:
            'Invalid input. Please provide vendor ID , rfq_product_tech_evaluation_id and status'
        });
      }

      const response = await rfqModel.addtechEvaluationClearedVendors(
        vendor_id,
        rfq_product_tech_evaluation_id,
        status,
        reject_message,
        user_id
      );

      await sendTechEvalAccepOrRejectMailToVendor(
        rfq_id,
        product,
        vendor_id,
        user_id,
        reject_message)

      res.status(200).json(response).end();
    } catch (error) {
      logError('Error in addVendorResponse API:', error);
      res.status(500).json({
        status: 0,
        message: 'Error processing vendor response.',
        error: error.message
      });
    }
  },

  replaceTechEvalVendor: async (req, res) => {
    try {
      const { rfq_id, rfq_product_id, old_vendor_id, new_vendor_id } = req.body;
      const user_id = req.user.id;

      if (!rfq_id || !rfq_product_id || !old_vendor_id || !new_vendor_id) {
        return res.status(400).json({
          status: 0,
          message: 'rfq_id, rfq_product_id, old_vendor_id, and new_vendor_id are required'
        });
      }

      const result = await rfqModel.replaceTechEvalVendor(
        rfq_id,
        rfq_product_id,
        old_vendor_id,
        new_vendor_id,
        user_id
      );

      return res.status(200).json(result);
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Error replacing vendor',
        error: error.message
      });
    }
  },

  getNextVendorsForTechEval: async (req, res) => {
    try {
      const { rfq_id, rfq_product_id, exclude_vendor_ids } = req.query;

      if (!rfq_id || !rfq_product_id) {
        return res.status(400).json({
          status: 0,
          message: 'rfq_id and rfq_product_id are required'
        });
      }

      const excludeIds = exclude_vendor_ids 
        ? exclude_vendor_ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id))
        : [];

      const result = await rfqModel.getNextVendorsForProduct(
        parseInt(rfq_id),
        parseInt(rfq_product_id),
        excludeIds,
        10
      );

      return res.status(200).json({
        status: 1,
        data: result
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Error getting next vendors',
        error: error.message
      });
    }
  },

  getVendorNames: async (req, res) => {
    try {
      const { rfq_id, rfq_product_id } = req.body;
      // console.log("API Input: ", req.body);

      // Validate input
      if (!rfq_id || !rfq_product_id) {
        return res.status(400).json({
          status: 0,
          message: 'Invalid input. Please provide RFQ ID and rfq_product_id'
        });
      }

      const response = await rfqModel.getVendorNames(rfq_id, rfq_product_id);

      res.status(200).json(response).end();
    } catch (error) {
      logError('Error in addVendorResponse API:', error);
      res.status(500).json({
        status: 0,
        message: 'Error processing vendor response.',
        error: error.message
      });
    }
  },
  getVendorResponses: async (req, res) => {
    try {
      const { rfq_id, rfq_product_id, vendor_id } = req.body;
      // console.log("API Input: ", req.body);

      // Validate input
      if (!rfq_id || !rfq_product_id || !vendor_id) {
        return res.status(400).json({
          status: 0,
          message:
            'Invalid input. Please provide RFQ ID and rfq_product_id and Vendor ID'
        });
      }

      const response = await rfqModel.getVendorResponses(
        rfq_id,
        rfq_product_id,
        vendor_id
      );

      res.status(200).json(response).end();
    } catch (error) {
      logError('Error in addVendorResponse API:', error);
      res.status(500).json({
        status: 0,
        message: 'Error processing vendor response.',
        error: error.message
      });
    }
  },

  getTechEvaluationRFQDetails: async (req, res) => {
    try {
      const user_id = req.user.id;

      let { rfq_no, project_id } = req.body;

      if (!project_id || project_id == -1) {
        project_id = null;
      }

      // Validate input
      if (!user_id) {
        return res.status(400).json({
          status: 0,
          message: 'User not found!'
        });
      }

      const response = await rfqModel.getTechEvaluationRFQDetails(
        user_id,
        rfq_no,
        project_id
      );

      res.status(200).json(response).end();
    } catch (error) {
      logError('Error in addVendorResponse API:', error);
      res.status(500).json({
        status: 0,
        message: 'Error processing vendor response.',
        error: error.message
      });
    }
  },

  getClausesOfProduct: async (req, res) => {
    try {
      const { rfq_product_id, vendor_id = null } = req.body;

      const result = await rfqModel.getClausesOfProduct(
        rfq_product_id,
        vendor_id
      );

      res.status(200).json(result).end();
    } catch (error) {
      logError(error);
      res.status(500).json({
        success: false,
        message: 'Error in deleting clause.',
        error: error.message
      });
    }
  },

  getTechEvaluationResult: async (req, res) => {
    try {
      const { rfq_product_id, vendor_id } = req.body;

      // Validate input
      if (!rfq_product_id || !vendor_id) {
        return res.status(400).json({
          status: 0,
          message: 'Invalid input. Please provide RFQ ID and RFQ product ID'
        });
      }

      const result = await rfqModel.getTechEvaluationResult(
        rfq_product_id,
        vendor_id
      );

      res.status(200).json(result).end();
    } catch (error) {
      logError(error);
      res.status(500).json({
        success: false,
        message: 'Error in deleting clause.',
        error: error.message
      });
    }
  },

  /**
   * submitTechEvalForApproval
   *
   * API endpoint to submit a technical evaluation for approval.
   * Creates an approval instance for the TECHNICAL entity type.
   *
   * NEW FLOW (Round-based):
   * - Creates a round record and uses round_id as entity_id
   * - Includes all vendor scores and pass/fail status in metadata
   * - Returns round_id for frontend to track approval by round
   *
   * POST /rfq/tech-eval/submit-for-approval
   * Body: { rfq_id: number, rfq_product_id: number, is_tender: boolean }
   */
  submitTechEvalForApproval: async (req, res) => {
    try {
      const { rfq_id, rfq_product_id } = req.body;
      const userId = req.user.id;

      // Wrap in transaction for atomicity
      const result = await db.tx(async (t) => {
        // Start approval for the technical evaluation (creates round record)
        const approvalResult = await startApprovalForTechEval(
          rfq_product_id,
          rfq_id,
          userId,
          t
        );

        // If null, it means RFQ is not a hospitality RFQ
        if (!approvalResult) {
          return {
            success: false,
            message: 'This RFQ does not require approval (not a hospitality RFQ)'
          };
        }

        // Record lifecycle event with round info
        await recordLifecycleEvent({
          entity_type: 'TECHNICAL',
          entity_id: rfq_product_id,
          stage: 'SUBMITTED',
          action: 'SUBMIT',
          performed_by: userId,
          metadata: {
            approval_instance_id: approvalResult.instance?.id,
            rfq_id: rfq_id,
            rfq_product_id: rfq_product_id,
            round_id: approvalResult.round_id,
            round_number: approvalResult.round_number
          },
          txContext: t
        });

        return {
          success: true,
          approval_instance_id: approvalResult.instance?.id,
          status: approvalResult.instance?.status,
          total_steps: approvalResult.totalSteps,
          auto_approved: approvalResult.autoApproved || false,
          round_id: approvalResult.round_id,
          round_number: approvalResult.round_number
        };
      });

      if (!result.success) {
        return res.status(400).json({
          status: 0,
          message: result.message
        });
      }

      // If auto-approved, trigger post-approval processing (mark vendors, update round, send notifications)
      if (result.auto_approved && result.approval_instance_id) {
        try {
          await handleTechnicalPostApproval(result.approval_instance_id, userId);
        } catch (postApprovalError) {
          logError('Error in TECHNICAL auto-approve post-approval processing', postApprovalError);
        }
      }

      return res.status(200).json({
        status: 1,
        message: result.auto_approved
          ? 'Technical evaluation auto-approved (creator is only approver)'
          : 'Technical evaluation submitted for approval',
        data: {
          approval_instance_id: result.approval_instance_id,
          round_id: result.round_id,
          round_number: result.round_number,
          status: result.status,
          total_steps: result.total_steps
        }
      });
    } catch (error) {
      logError(error);

      // Handle specific error cases
      if (error.message?.includes('No approval policy found')) {
        return res.status(400).json({
          status: 0,
          message: 'No approval policy configured for TECHNICAL in this scope'
        });
      }

      if (error.message?.includes('already exists') || error.message?.includes('already been approved')) {
        return res.status(400).json({
          status: 0,
          message: error.message
        });
      }

      if (error.message?.includes('RFQ product not found')) {
        return res.status(400).json({
          status: 0,
          message: 'RFQ product not found for the given RFQ'
        });
      }

      if (error.message?.includes('Technical evaluation not found')) {
        return res.status(400).json({
          status: 0,
          message: 'Technical evaluation not found for this product'
        });
      }

      if (error.message?.includes('already complete')) {
        return res.status(400).json({
          status: 0,
          message: 'Technical evaluation is already complete'
        });
      }

      if (error.message?.includes('No vendors have been evaluated')) {
        return res.status(400).json({
          status: 0,
          message: error.message || 'No vendors have been evaluated. Please score at least one vendor before submitting for approval.'
        });
      }

      if (error.message?.includes('already submitted') || error.message?.includes('already pending')) {
        return res.status(400).json({
          status: 0,
          message: error.message
        });
      }

      return res.status(500).json({
        status: 0,
        message: 'Error submitting technical evaluation for approval',
        error: error.message
      });
    }
  },

  rfqProductWiseReport: async (req, res) => {
    try {
      const { startDate, endDate, productName, productId } = req.query;
      const userId = req.user.id;

      const rfqData = await rfqModel.rfqProductReport(
        userId,
        productId,
        productName,
        startDate,
        endDate
      );

      res.status(200).json(rfqData).end();
    } catch (error) {
      logError('rfqController error', error);
      logError(error);
      res.status(500).json({
        success: false,
        message: 'no data to return',
        error: error
      });
    }
  },

  projectWiseReport: async (req, res) => {
    try {
      const { projectId, startDate, endDate } = req.query;
      const userId = req.user.id;
      const company_id = req.user.company_id;

      const rfqDetails = await rfqModel.getProjectDetailsReport(
        projectId,
        startDate,
        endDate
      );
      const quoteList = [];

      //  fetch quotes for each rfq preent in the project
      for (let i = 0; i < rfqDetails.length; i++) {
        for (let j = 0; j < rfqDetails[i].rfq_details.length; j++) {
          const rfqId = rfqDetails[i].rfq_details[j].rfq_id;
          const { quoteVisibility } = await getQuoteVisibilityForRfq(rfqId);
          if (quoteVisibility.locked) {
            throw createQuoteVisibilityError(
              quoteVisibility,
              `Project report export is locked because RFQ #${rfqDetails[i].rfq_details[j].rfq_no || rfqId} has not yet passed its quote submission deadline in IST.`
            );
          }
          let quoteDetails = await rfqModel.getQuotesByRfqById2(
            rfqId,
            company_id,
            userId,
            false
          );
          quoteList.push(quoteDetails);
        }
      }

      res.status(200).json({ quoteList: quoteList, rfqDetails: rfqDetails });
    } catch (error) {
      logError('Error fetching project report', error);
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Error processing RFQ details',
        error: error.toString(),
        meta: error.quoteVisibility ? { quoteVisibility: error.quoteVisibility } : undefined
      });
    }
  },

  sendReportOnEmail: async (req, res) => {
    try {
      // Extracting email addresses from the request
      const { emails, startDate, endDate } = req.body; // Assuming 'emails' is a comma-separated list passed as a query parameter
      const file = req.file; // Assuming file data is sent via a multipart/form-data request
      const fileName = file?.originalname?.split('.')[0] || 'report';
      const userDetails = req.user;

      const headerContent = ` <p style="height:10px " > </p> `;

      const containerContent = `
       <h2>Greetings,</h2>
        <div style=" font-size:16px ">
        <p>Please find attached the zipped folder containing the complete data set for <strong> ${fileName}  </strong> covering the period <strong> ${
        startDate + ' to ' + endDate
      } </strong>. This report includes all relevant RFQ records, Quotes, and transaction logs compiled for auditing and review purposes.</p>
        <p>If you have any questions or need additional information, please feel free to reach out.</p>
        <p>Thank you for your time and consideration.</p>
        <p>Best regards,</p>
        <p>${userDetails.name}<br>
        ${userDetails.organization_name || ''}</p>
    </div>
    `;

      const emailTemplate = generateEmailTemplate(
        headerContent,
        containerContent,
        userDetails.id
      );

      // Preparing email options with an attachment
      const mailOptions = {
        from: Config.webmasterMail, // Sender address
        to: emails, // Sending email to all recipients directly from the query string
        subject: `Project Report for ${fileName} of ${
          userDetails.organization_name || userDetails.name
        } `, // subject: `${file.originalname.split(".")[0] || "Project Report"} || Workwise ` , // Subject line
        html: emailTemplate, // HTML body content
        attachments: [
          {
            filename: file.originalname, // Using original file name
            content: file.buffer // Assuming the file is available as a buffer
          }
        ]
      };

      // Sending the email with the attachment
      sendMail(mailOptions);

      res.status(200).json({ message: 'Report sent successfully.' });
    } catch (error) {
      logError('Error fetching project report', error);
      res.status(500).json({
        success: false,
        message: 'Error processing RFQ details',
        error: error.toString()
      });
    }
  },

  // Changes by Agnij May 01, 2025 [Added endpoint to search variant products]
  searchVariantProducts: async (req, res, next) => {
    try {
      const search_key = req.body?.search_key ? req.body?.search_key : '';

      if (!search_key || search_key.trim() === '') {
        return res.status(200).json([]).end();
      }

      // Use the model to search for variant mappings
      const variantProductResults = await rfqModel.searchVariantProducts(
        search_key
      );

      if (!variantProductResults || variantProductResults.length === 0) {
        return res.status(200).json([]).end();
      }

      res.status(200).json(variantProductResults).end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  // Changes by Agnij May 01, 2025 [Added endpoint to search variant vendors]
  searchVariantVendors: async (req, res, next) => {
    try {
      const { product_id, variant_id } = req.body;

      if (!product_id && !variant_id) {
        return res.status(200).json([]).end();
      }

      // Use the model to search for vendors associated with this variant
      const variantVendorResults = await rfqModel.searchVariantVendors(
        product_id,
        variant_id
      );

      if (!variantVendorResults || variantVendorResults.length === 0) {
        return res.status(200).json([]).end();
      }

          // If empty → return 404
       if (!variantVendorResults || variantVendorResults.length === 0) {
         return res.status(404).json({
           status: 2,
           message: "No vendors found for this variant."
         });
       }

      res.status(200).json(variantVendorResults).end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  getClausesByRfqProductId: async (req, res) => {
    try {
      const { rfq_id, rfq_product_id, vendor_id } = req.body;

      if (!rfq_product_id) {
        return res.status(400).json({
          status: 0,
          message: 'Invalid input. Ensure RFQ_PRODUCT_ID is provided.'
        });
      }
      // Changes by Agnij May 13, 2025 [Fixed clause display limitation]
      const result = await rfqModel.getClausesOfProduct(
        rfq_product_id,
        vendor_id
      );

      res.status(200).json(result).end();
    } catch (error) {
      logError(error);
      res.status(500).json({
        success: false,
        message: 'Error in fetching clauses by rfq product id',
        error: error.message
      });
    }
  },

  // New unified controller method for sidebar data
  getRfqs: async (req, res) => {
    try {
      const user_id = req.user.id;
      const user_type = req.user.user_type;

      let {
        tech_eval,
        po = 'false',
        quote_compare = 'false',
        page = 1,
        limit = 10,
        project_id,
        rfq_no,
        rfq_id,
        sort = 'DESC',
        is_tender,
        module_keys,
        hotel_id,
        search
      } = req.query;

      // Convert string query parameters to proper types
      tech_eval = tech_eval === 'true';
      po = po === 'true';
      quote_compare = quote_compare === 'true';

      page = parseInt(page) || 1;
      limit = parseInt(limit) || 10;
      project_id = project_id ? parseInt(project_id) : null;
      rfq_no = rfq_no ? parseInt(rfq_no) : null;
      rfq_id = rfq_id ? parseInt(rfq_id) : null;
      hotel_id = hotel_id ? parseInt(hotel_id) : null;
      // Free-text search (case-insensitive) over rfq_no / title / project name.
      // Trimmed to null when blank so it's a no-op for existing callers.
      search = typeof search === 'string' && search.trim() !== '' ? search.trim() : null;
      is_tender = is_tender !== undefined && is_tender !== null ? (is_tender === 'true' || is_tender === true || is_tender === '1' || is_tender === 1) : null;

      // Parse module_keys into array of uppercase entity types
      let parsedModuleKeys = [];
      if (module_keys && typeof module_keys === 'string' && module_keys.trim() !== '') {
        parsedModuleKeys = module_keys.split(',').map(k => k.trim().toUpperCase()).filter(k => k.length > 0);
      }

      // Calculate offset
      const offset = (page - 1) * limit;

      // Handle project_id filter
      if (project_id === -1) {
        project_id = null;
      }

      // Get RFQs
      const rfqs = await rfqModel.getRfqs(
        user_id,
        user_type,
        tech_eval,
        po,
        limit,
        offset,
        project_id,
        rfq_no,
        sort,
        is_tender,
        rfq_id,
        hotel_id,
        quote_compare,
        search
      );

      // Enrich each RFQ with approval_required flag
      if (parsedModuleKeys.length > 0 && rfqs.length > 0) {
        const rfqIds = rfqs.map(r => parseInt(r.id));
        const rfqIdsWithApprovals = await getRfqIdsWithPendingApprovals(user_id, parsedModuleKeys, rfqIds);
        const approvalSet = new Set(rfqIdsWithApprovals);
        for (const rfq of rfqs) {
          rfq.approval_required = approvalSet.has(parseInt(rfq.id));
        }
      } else {
        for (const rfq of rfqs) {
          rfq.approval_required = false;
        }
      }

      // Enrich with has_acceptance_pending flag for vendor order book sidebar
      if (po && user_type == 3 && rfqs.length > 0) {
        try {
          const rfqIds = rfqs.map(r => parseInt(r.id));
          const pendingRows = await db.any(`
            SELECT DISTINCT rfq_id FROM tbl_rfq_purchase_order
            WHERE rfq_id = ANY($1) AND status = 'acceptance_pending' AND finalized_vendor_id = $2
          `, [rfqIds, user_id]);
          const pendingSet = new Set(pendingRows.map(r => parseInt(r.rfq_id)));
          for (const rfq of rfqs) {
            rfq.has_acceptance_pending = pendingSet.has(parseInt(rfq.id));
          }
        } catch (err) {
          logError('Error enriching RFQs with acceptance_pending flag', err);
          for (const rfq of rfqs) { rfq.has_acceptance_pending = false; }
        }
      }

      res.status(200).json({
        status: 1,
        data: rfqs,
        total_items: rfqs.length
      });
    } catch (error) {
      logError('Error in getRfqs', error);
      res.status(500).json({
        status: 0,
        message: 'Error fetching sidebar RFQs',
        error: error.message
      });
    }
  },

  getTechEvalUsers: async (req, res) => {
    try {
      const project_id = parseInt(req.params.project_id);
      if (!project_id || isNaN(project_id)) {
        return res.status(400).json({ status: 0, message: 'Valid project_id is required' });
      }

      // Get company and hotel context from headers for permission filtering
      const companyId = req.headers['x-company-id'] ? parseInt(req.headers['x-company-id']) : null;
      const hotelId = req.headers['x-hotel-id'] ? parseInt(req.headers['x-hotel-id']) : null;

      const users = await rfqModel.getTechEvalUsers(project_id, companyId, hotelId);
      res.status(200).json({ status: 1, data: users });
    } catch (error) {
      logError('Error in getTechEvalUsers', error);
      res.status(500).json({ status: 0, message: 'Error fetching tech eval users' });
    }
  },

  // Saves user downloaded excel in database
  saveExcel: async (req, res) => {
    try {
      const { rfq_id, file_path } = req.body;
      const user = req.user;

      await rfqModel.saveExcel(rfq_id, user.id, file_path);
      return res.status(201).end();
    } catch (error) {
      logError('Error in saveExcel', error);
      return res.status(500).json({
        status: 0,
        message: 'Error saving Excel to database',
        error: error.message
      });
    }
  },

  updateMinimumPassingScore: async (req, res) => {
    try {
      const { rfq_id, rfq_product_id, minimum_passing_score } = req.body;
      const user_id = req.user.id;

      if (!rfq_id || !rfq_product_id || minimum_passing_score === undefined) {
        return res.status(400).json({
          status: 0,
          message: 'Invalid input. Ensure RFQ_ID, rfq_product_id and minimum_passing_score are provided.'
        });
      }

      const result = await rfqModel.updateMinimumPassingScore(
        rfq_id,
        rfq_product_id,
        minimum_passing_score
      );

      res.status(200).json(result).end();
    } catch (error) {
      logError(error);
      res.status(500).json({
        status: 0,
        message: 'Error updating minimum passing score.',
        error: error.message
      });
    }
  },

  updateBuyerMarks: async (req, res) => {
    try {
      const { clause_id, vendor_id, buyer_marks, buyer_remark } = req.body;
      const buyer_id = req.user.id;

      if (!clause_id || !vendor_id) {
        return res.status(400).json({
          status: 0,
          message: 'Invalid input. Ensure clause_id and vendor_id are provided.'
        });
      }

      // Check clause type - remarks only allowed for sampling
      const clauseCheck = await rfqModel.getClauseType(clause_id);
      if (clauseCheck && clauseCheck.clause_type !== 'sampling' && buyer_remark) {
        return res.status(400).json({
          status: 0,
          message: 'Remarks are only allowed for sampling clauses. Regular clauses can only have marks.'
        });
      }

      // If not sampling, set remark to null
      const finalRemark = (clauseCheck && clauseCheck.clause_type === 'sampling') ? buyer_remark : null;

      const result = await rfqModel.updateBuyerMarks(
        clause_id,
        vendor_id,
        buyer_id,
        buyer_marks,
        finalRemark
      );

      res.status(200).json(result).end();
    } catch (error) {
      logError(error);
      res.status(500).json({
        status: 0,
        message: 'Error updating buyer marks.',
        error: error.message
      });
    }
  },

  // ============================================
  // One-at-a-Time Clarification System Controllers
  // ============================================

  /**
   * raiseClarification
   * Vendor raises a clarification for an RFQ/Tender
   * POST /rfq/clarification/raise
   */
  raiseClarification: async (req, res) => {
    try {
      const { rfq_id, subject, question } = req.body;
      const files = req.files || [];
      const user = req.user;

      // Fetch RFQ details
      const rfq = await db.oneOrNone(
        `SELECT id, is_tender, tender_publish_date, vendor_clarification_date, created_by, rfq_no, status, is_published
         FROM tbl_rfq WHERE id = $1`,
        [rfq_id]
      );

      if (!rfq) {
        return res.status(400).json({
          status: 0,
          message: 'RFQ not found'
        });
      }

      // Validate clarification period
      const now = new Date();
      const publishDate = rfq.tender_publish_date
        ? new Date(rfq.tender_publish_date)
        : null;
      const clarificationEndDate = rfq.vendor_clarification_date
        ? new Date(rfq.vendor_clarification_date)
        : null;

      // If tender is already published (status = 1 or is_published = 1), 
      // only check vendor_clarification_date, not tender_publish_date
      const isPublished = rfq.status === 1 || rfq.is_published === 1;

      if (!isPublished && publishDate && now < publishDate) {
        return res.status(400).json({
          status: 0,
          message: 'Clarification period has not started yet'
        });
      }

      if (clarificationEndDate && now > clarificationEndDate) {
        return res.status(400).json({
          status: 0,
          message: 'Clarification period has ended'
        });
      }

      // Check if active clarification exists (one-at-a-time rule)
      const activeClarification =
        await rfqModel.checkActiveClarification(rfq_id);
      if (activeClarification) {
        // Private visibility: don't expose other vendor's clarification details
        return res.status(400).json({
          status: 0,
          message:
            'Another clarification is already open. Please wait for it to be closed before raising a new one.'
        });
      }

      // Create clarification
      const clarification = await rfqModel.createClarification(
        rfq_id,
        user.id,
        user.company_id,
        subject,
        question,
        files
      );

      // Get vendor name for response
      const vendorName = await db.oneOrNone(
        `SELECT name FROM tbl_users WHERE id = $1`,
        [user.id]
      );

      // Format response with messages array (new chat system format)
      const responseData = {
        id: clarification.id,
        rfq_id: clarification.rfq_id,
        raised_by_vendor_id: clarification.raised_by,
        raised_by_vendor_name: vendorName?.name || null,
        subject: clarification.subject,
        status: clarification.status,
        created_at: clarification.created_at,
        closed_at: null,
        closed_by: null,
        messages: [
          {
            id: clarification.initial_message.id,
            sender_id: user.id,
            sender_type: 'VENDOR',
            sender_name: vendorName?.name || null,
            message: question,
            files: clarification.initial_message.files.map((f) => ({
              file_url: f.file_url,
              file_name: f.file_name
            })),
            created_at: clarification.initial_message.created_at
          }
        ]
      };

      return res.status(200).json({
        status: 1,
        message: 'Clarification raised successfully',
        data: responseData
      });
    } catch (error) {
      logError(error);

      if (
        error.message?.includes('unique') ||
        error.message?.includes('duplicate')
      ) {
        return res.status(400).json({
          status: 0,
          message:
            'Another clarification was just raised. Please wait for it to be closed.'
        });
      }

      return res.status(500).json({
        status: 0,
        message: 'Error raising clarification',
        error: error.message
      });
    }
  },

  /**
   * resolveClarification
   * Buyer closes a clarification with optional final response message
   * POST /rfq/clarification/resolve
   * Response is now optional - buyer can close without sending a message
   */
  resolveClarification: async (req, res) => {
    try {
      const { clarification_id, response } = req.body;
      const response_files = req.files || [];
      const user = req.user;

      // Fetch clarification with RFQ details
      const clarification =
        await rfqModel.getClarificationById(clarification_id);

      if (!clarification) {
        return res.status(400).json({
          status: 0,
          message: 'Clarification not found'
        });
      }

      if (clarification.status !== 'OPEN') {
        return res.status(400).json({
          status: 0,
          message: 'This clarification has already been closed'
        });
      }

      // Validate user is RFQ creator (or later: proxy clarifier)
      if (clarification.rfq_created_by !== user.id) {
        return res.status(403).json({
          status: 0,
          message: 'Only the RFQ creator can close clarifications'
        });
      }

      // F-CLAR-002: require a non-empty response (or at least one file).
      // Closing without answering used to silently leave the vendor's
      // question unanswered + send no notification.
      const responseText = typeof response === 'string' ? response.trim() : '';
      const hasFiles = Array.isArray(response_files) && response_files.length > 0;
      if (!responseText && !hasFiles) {
        return res.status(400).json({
          status: 0,
          message: 'Response is required to close a clarification.'
        });
      }

      // Resolve clarification with optional response
      const resolved = await rfqModel.resolveClarification(
        clarification_id,
        user.id,
        response || null,
        response_files
      );

      if (!resolved) {
        return res.status(400).json({
          status: 0,
          message: 'Failed to close clarification'
        });
      }

      // Get all messages for the clarification
      const messages = await rfqModel.getClarificationMessages(clarification_id);

      // Format response with messages array (new chat system format)
      const responseData = {
        id: resolved.id,
        rfq_id: resolved.rfq_id,
        raised_by_vendor_id: resolved.raised_by,
        raised_by_vendor_name: clarification.raised_by_vendor_name,
        subject: resolved.subject,
        status: resolved.status,
        created_at: resolved.created_at,
        closed_at: resolved.closed_at,
        closed_by: resolved.closed_by,
        messages: messages
      };

      return res.status(200).json({
        status: 1,
        message: 'Clarification closed successfully',
        data: responseData
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Error closing clarification',
        error: error.message
      });
    }
  },

  /**
   * listClarifications
   * List clarifications for an RFQ with messages (private - vendor sees only their own)
   * GET /rfq/clarifications/:rfq_id
   *
   * Privacy rules:
   * - Buyer (RFQ creator): sees ALL clarifications with all messages
   * - Vendor who raised clarification: sees their OWN clarifications with all messages
   * - Other vendors: only see has_open=true without details
   */
  listClarifications: async (req, res) => {
    try {
      const { rfq_id } = req.params;
      const currentUserId = req.user ? req.user.id : null;

      if (!rfq_id) {
        return res.status(400).json({
          status: 0,
          message: 'rfq_id is required'
        });
      }

      // Verify RFQ exists and is a tender, also get created_by for buyer check
      const rfq = await db.oneOrNone(
        `SELECT id, is_tender, created_by FROM tbl_rfq WHERE id = $1`,
        [rfq_id]
      );

      if (!rfq) {
        return res.status(400).json({
          status: 0,
          message: 'RFQ not found'
        });
      }

      // Check if current user is on the buyer side
      // Rules:
      // - Original rule (backwards compatible): RFQ creator is always treated as buyer
      // - New rule: ANY non-vendor user (user_type != 3 and != 4) from the buyer side
      //   should also be able to see ALL clarifications for this RFQ.
      //
      // This fixes the bug where other buyer-side users (project members, finance, etc.)
      // could see that a clarification is open but the clarification list was empty,
      // because only the exact RFQ creator was treated as "buyer" in this controller.
      const userType = req.user ? req.user.user_type : null;
      const isBuyer =
        !!currentUserId &&
        (
          rfq.created_by === currentUserId || // RFQ creator
          (userType !== null && userType !== 3 && userType !== 4) // Any non-vendor internal user
        );

      // Get all clarifications with messages (new chat system format)
      const allClarifications = await rfqModel.getClarificationsWithMessages(rfq_id);

      // Find open clarification if any
      const openClarification = allClarifications.find(
        (c) => c.status === 'OPEN'
      );

      // Determine if current user owns the open clarification
      const isOwnOpenClarification = openClarification &&
        currentUserId &&
        openClarification.raised_by_vendor_id === currentUserId;

      // Transform clarifications to use vendor codes instead of names (for tender privacy)
      const transformedClarifications = allClarifications.map(c => ({
        ...c,
        raised_by_vendor_code: `VEN-${c.raised_by_vendor_id}`,
        // Remove vendor name to protect identity in tenders
        raised_by_vendor_name: undefined
      }));

      const transformedOpenClarification = openClarification ? {
        ...openClarification,
        raised_by_vendor_code: `VEN-${openClarification.raised_by_vendor_id}`,
        raised_by_vendor_name: undefined
      } : null;

      // Buyer sees all clarifications with messages (vendor names replaced with codes)
      if (isBuyer) {
        return res.status(200).json({
          status: 1,
          data: {
            clarifications: transformedClarifications,
            open_clarification: transformedOpenClarification,
            has_open: !!openClarification,
            is_own_clarification: false, // Not applicable for buyer
            is_buyer: true
          }
        });
      }

      // Vendor: filter to only their own clarifications (vendor sees their own name)
      const ownClarifications = currentUserId
        ? allClarifications.filter(c => c.raised_by_vendor_id === currentUserId)
        : [];

      // Transform own clarifications to use vendor codes (for consistency)
      const transformedOwnClarifications = ownClarifications.map(c => ({
        ...c,
        raised_by_vendor_code: `VEN-${c.raised_by_vendor_id}`,
        // Remove vendor name for other vendors' clarifications
        raised_by_vendor_name: undefined
      }));

      const ownOpenClarification = isOwnOpenClarification ? {
        ...openClarification,
        raised_by_vendor_code: `VEN-${openClarification.raised_by_vendor_id}`,
        raised_by_vendor_name: undefined
      } : null;

      return res.status(200).json({
        status: 1,
        data: {
          clarifications: transformedOwnClarifications,
          open_clarification: ownOpenClarification,
          has_open: !!openClarification,
          is_own_clarification: isOwnOpenClarification,
          is_buyer: false
        }
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Error fetching clarifications',
        error: error.message
      });
    }
  },

  /**
   * getActiveClarification
   * Check if there's an open clarification for an RFQ with messages (private visibility)
   * GET /rfq/clarification/active/:rfq_id
   *
   * Privacy rules:
   * - Buyer (RFQ creator): sees full clarification details with all messages
   * - Vendor who raised clarification: sees full details with all messages
   * - Other vendors: only see has_open=true, is_own_clarification=false
   */
  getActiveClarification: async (req, res) => {
    try {
      const { rfq_id } = req.params;
      const currentUserId = req.user ? req.user.id : null;

      if (!rfq_id) {
        return res.status(400).json({
          status: 0,
          message: 'rfq_id is required'
        });
      }

      // Get RFQ to check if user is buyer
      const rfq = await db.oneOrNone(
        `SELECT id, created_by FROM tbl_rfq WHERE id = $1`,
        [rfq_id]
      );

      if (!rfq) {
        return res.status(400).json({
          status: 0,
          message: 'RFQ not found'
        });
      }

      const isBuyer = currentUserId && rfq.created_by === currentUserId;

      // Get active clarification with messages (new chat system format)
      const openClarification =
        await rfqModel.getActiveClarificationWithMessages(rfq_id);

      // No open clarification
      if (!openClarification) {
        return res.status(200).json({
          status: 1,
          has_open: false,
          is_own_clarification: false,
          is_buyer: isBuyer,
          data: null
        });
      }

      // Check if current user owns the open clarification
      const isOwnClarification = currentUserId &&
        openClarification.raised_by_vendor_id === currentUserId;

      // Buyer or owner sees full details with messages
      if (isBuyer || isOwnClarification) {
        return res.status(200).json({
          status: 1,
          has_open: true,
          is_own_clarification: isOwnClarification,
          is_buyer: isBuyer,
          data: openClarification
        });
      }

      // Other vendors: only indicate clarification is ongoing, no details
      return res.status(200).json({
        status: 1,
        has_open: true,
        is_own_clarification: false,
        is_buyer: false,
        data: null
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Error checking open clarification',
        error: error.message
      });
    }
  },

  /**
   * sendClarificationMessage
   * Send a message in an open clarification thread
   * POST /rfq/clarification/message
   *
   * Both the vendor who raised the clarification and the RFQ creator (buyer) can send messages
   */
  sendClarificationMessage: async (req, res) => {
    try {
      const { clarification_id, message } = req.body;
      const files = req.files || [];
      const user = req.user;

      // Fetch clarification with RFQ details
      const clarification =
        await rfqModel.getClarificationById(clarification_id);

      if (!clarification) {
        return res.status(400).json({
          status: 0,
          message: 'Clarification not found'
        });
      }

      if (clarification.status !== 'OPEN') {
        return res.status(400).json({
          status: 0,
          message: 'This clarification has been closed'
        });
      }

      // Determine sender type and validate authorization
      const isVendorOwner = clarification.raised_by === user.id;
      const isBuyer = clarification.rfq_created_by === user.id;

      if (!isVendorOwner && !isBuyer) {
        return res.status(403).json({
          status: 0,
          message: 'You are not authorized to send messages in this clarification'
        });
      }

      const senderType = isBuyer ? 'BUYER' : 'VENDOR';

      // Add message to clarification thread
      const newMessage = await rfqModel.addClarificationMessage(
        clarification_id,
        user.id,
        senderType,
        message,
        files
      );

      // Get sender name
      const senderName = await db.oneOrNone(
        `SELECT name FROM tbl_users WHERE id = $1`,
        [user.id]
      );

      // Get all messages for the clarification
      const allMessages = await rfqModel.getClarificationMessages(clarification_id);

      // Format response with full clarification data
      const responseData = {
        id: clarification.id,
        rfq_id: clarification.rfq_id,
        raised_by_vendor_id: clarification.raised_by,
        raised_by_vendor_name: clarification.raised_by_vendor_name,
        subject: clarification.subject,
        status: clarification.status,
        created_at: clarification.created_at,
        closed_at: clarification.closed_at,
        closed_by: clarification.closed_by,
        messages: allMessages
      };

      return res.status(200).json({
        status: 1,
        message: 'Message sent successfully',
        data: responseData
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Error sending message',
        error: error.message
      });
    }
  },

  /**
   * getTechEvalStatus
   *
   * Get the current status of a technical evaluation including:
   * - Completion status and round info
   * - Passed & verified vendors
   * - Failed & verified vendors (history)
   * - Pending evaluation vendors
   * - All rounds with their approval status
   *
   * GET /rfq/tech-eval/status/:rfq_product_id
   */
  getTechEvalStatus: async (req, res) => {
    try {
      const { rfq_product_id } = req.params;

      if (!rfq_product_id) {
        return res.status(400).json({
          status: 0,
          message: 'rfq_product_id is required'
        });
      }

      const status = await rfqModel.getTechEvalStatusByProductId(parseInt(rfq_product_id));

      if (!status) {
        return res.status(404).json({
          status: 2,
          message: 'Technical evaluation not found for this product'
        });
      }

      return res.status(200).json({
        status: 1,
        message: 'Technical evaluation status retrieved successfully',
        data: status
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Error getting technical evaluation status',
        error: error.message
      });
    }
  },

  /**
   * getTechEvalHistory
   *
   * Get the evaluation history for a technical evaluation including:
   * - All evaluation rounds with approval status
   * - Vendors evaluated in each round
   * - Historical pass/fail decisions
   *
   * GET /rfq/tech-eval/history/:rfq_product_id
   */
  getTechEvalHistory: async (req, res) => {
    try {
      const { rfq_product_id } = req.params;

      if (!rfq_product_id) {
        return res.status(400).json({
          status: 0,
          message: 'rfq_product_id is required'
        });
      }

      const history = await rfqModel.getTechEvalHistoryByProductId(parseInt(rfq_product_id));

      return res.status(200).json({
        status: 1,
        message: 'Technical evaluation history retrieved successfully',
        data: history
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Error getting technical evaluation history',
        error: error.message
      });
    }
  },

  /**
   * getTechEvalDashboard
   *
   * Returns a summary of technical evaluation progress for an RFQ.
   *
   * @route GET /api/v1/rfq/technical/dashboard/:rfq_id
   */
  getTechEvalDashboard: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id, 10);
      const dashboard = await rfqModel.getTechEvalDashboard(rfq_id);

      return res.status(200).json({
        status: 1,
        data: {
          total_products: parseInt(dashboard.total_products, 10),
          products_completed: parseInt(dashboard.products_completed, 10),
          completed_product_ids: dashboard.completed_product_ids || [],
          products_in_progress: parseInt(dashboard.products_in_progress, 10),
          vendors_passed: parseInt(dashboard.vendors_passed, 10),
          vendors_failed: parseInt(dashboard.vendors_failed, 10)
        }
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
    }
  },

  /**
   * techEvalApprovalAction
   *
   * Custom approval action endpoint for TECHNICAL evaluations.
   * This handles approve/reject actions and triggers post-approval processing
   * when the evaluation is fully approved.
   *
   * POST /rfq/tech-eval/approval/action
   * Body: {
   *   approval_instance_id: number,
   *   approval_instance_step_id?: number,
   *   action: 'APPROVE' | 'REJECT',
   *   comment?: string
   * }
   */
  techEvalApprovalAction: async (req, res) => {
    try {
      const { approval_instance_id, approval_instance_step_id, action, comment } = req.body;
      const user_id = req.user?.id;

      if (!user_id) {
        return res.status(401).json({
          status: 0,
          message: 'User authentication required'
        });
      }

      if (!approval_instance_id || !action) {
        return res.status(400).json({
          status: 0,
          message: 'approval_instance_id and action are required'
        });
      }

      if (!['APPROVE', 'REJECT'].includes(action.toUpperCase())) {
        return res.status(400).json({
          status: 0,
          message: 'Action must be APPROVE or REJECT'
        });
      }

      // Verify this is a TECHNICAL approval instance
      const instance = await getApprovalInstanceById(approval_instance_id);
      if (!instance) {
        return res.status(404).json({
          status: 2,
          message: 'Approval instance not found'
        });
      }

      if (instance.entity_type !== 'TECHNICAL') {
        return res.status(400).json({
          status: 0,
          message: 'This endpoint is only for TECHNICAL approval instances'
        });
      }

      // Submit the approval action via the centralized service. The dispatcher
      // automatically invokes handleTechnicalPostApproval / handleTechnicalRejection
      // based on the resulting instance_status, so the explicit post-action calls
      // that previously lived here are no longer needed.
      const result = await executeApprovalAction({
        approval_instance_id: parseInt(approval_instance_id),
        approval_instance_step_id: approval_instance_step_id ? parseInt(approval_instance_step_id) : null,
        approver_user_id: user_id,
        action: action.toUpperCase(),
        comment
      });

      return res.status(200).json({
        status: 1,
        message: result.message,
        data: {
          action: action.toUpperCase(),
          instance_status: result.instance_status,
          step_status: result.step_status,
          next_step: result.next_step,
          next_step_id: result.next_step_id
        }
      });
    } catch (error) {
      logError(error);

      if (error.message?.includes('not an approver')) {
        return res.status(403).json({
          status: 0,
          message: 'You are not authorized to approve this step'
        });
      }

      if (error.message?.includes('already acted')) {
        return res.status(400).json({
          status: 0,
          message: 'You have already acted on this approval step'
        });
      }

      if (error.message?.includes('Cannot act on instance')) {
        return res.status(400).json({
          status: 0,
          message: error.message
        });
      }

      return res.status(500).json({
        status: 0,
        message: 'Error processing approval action',
        error: error.message
      });
    }
  },

  /**
   * approveRFQAction
   *
   * Custom RFQ approval action endpoint.
   * Handles APPROVE and REJECT actions for RFQ/Tender approval instances.
   * After the approval action is submitted, triggers post-approval or rejection handlers.
   *
   * @route POST /api/v1/rfq/:id/approve-action
   */
  approveRFQAction: async (req, res) => {
    try {
      const { id } = req.params; // RFQ ID
      const user_id = req.user.id;
      const {
        approval_instance_id,
        approval_instance_step_id,
        action,
        comment
      } = req.body;

      if (!approval_instance_id) {
        return res.status(400).json({
          status: 0,
          message: 'approval_instance_id is required'
        });
      }

      if (!action || !['APPROVE', 'REJECT'].includes(action.toUpperCase())) {
        return res.status(400).json({
          status: 0,
          message: 'action must be APPROVE or REJECT'
        });
      }

      // Verify this is an RFQ or TENDER approval instance
      const instance = await getApprovalInstanceById(approval_instance_id);
      if (!instance) {
        return res.status(404).json({
          status: 2,
          message: 'Approval instance not found'
        });
      }

      if (!['RFQ', 'TENDER'].includes(instance.entity_type)) {
        return res.status(400).json({
          status: 0,
          message: 'This endpoint is only for RFQ/TENDER approval instances'
        });
      }

      // Verify the RFQ ID matches the entity_id in the approval instance
      if (instance.entity_id !== parseInt(id)) {
        return res.status(400).json({
          status: 0,
          message: 'Approval instance does not match the RFQ ID'
        });
      }

      // Submit the approval action via the centralized service. The dispatcher
      // automatically invokes handleRFQPostApproval / handleRFQRejection based
      // on the resulting instance_status.
      const result = await executeApprovalAction({
        approval_instance_id: parseInt(approval_instance_id),
        approval_instance_step_id: approval_instance_step_id ? parseInt(approval_instance_step_id) : null,
        approver_user_id: user_id,
        action: action.toUpperCase(),
        comment
      });

      return res.status(200).json({
        status: 1,
        message: result.message,
        data: {
          rfq_id: parseInt(id),
          action: action.toUpperCase(),
          instance_status: result.instance_status,
          step_status: result.step_status,
          next_step: result.next_step,
          next_step_id: result.next_step_id
        }
      });
    } catch (error) {
      logError(error);

      if (error.message?.includes('not an approver')) {
        return res.status(403).json({
          status: 0,
          message: 'You are not authorized to approve this step'
        });
      }

      if (error.message?.includes('already acted')) {
        return res.status(400).json({
          status: 0,
          message: 'You have already acted on this approval step'
        });
      }

      if (error.message?.includes('Cannot act on instance')) {
        return res.status(400).json({
          status: 0,
          message: error.message
        });
      }

      return res.status(500).json({
        status: 0,
        message: 'Error processing RFQ approval action',
        error: error.message
      });
    }
  },

  /**
   * Internal endpoint for EventBridge scheduler to publish RFQ
   * Called by Lambda via /internal/rfq/publish
   */
  schedulerPublishRfq: async (req, res) => {
    try {
      const { rfqId, rfq_no } = req.body;
      logger.debug('📢 Scheduler triggered RFQ publish for: ${rfq_no} (ID: ${rfqId})');

      const { publishRfqById } = await import('../../helper/cronManager.js');
      const result = await publishRfqById(rfqId, rfq_no, 'scheduler');

      const skippedMessages = {
        not_found: 'RFQ not found',
        already_published: 'RFQ already published',
        invalid_status: 'RFQ not in publishable state'
      };

      let message = 'RFQ published successfully';
      if (result.published && result.autoApproved) {
        message = 'RFQ auto-approved and published successfully (publish date arrived)';
      } else if (result.skipped) {
        message = skippedMessages[result.reason] || 'RFQ skipped';
      }

      return res.status(200).json({
        status: result.skipped ? 0 : 1,
        message,
        rfqId,
        ...result
      });
    } catch (error) {
      logError('❌ RFQ publish failed', error);
      return res.status(500).json({ status: 0, message: error.message });
    }
  },

  /**
   * Force Publish — creator-triggered manual publish for an RFQ whose scheduled
   * publish time has passed but auto-publish did not complete (Lambda failed,
   * schedule was never created, etc.). Reuses the same publish path the
   * scheduler endpoint uses so vendors are notified identically.
   *
   * Auth: JWT (passportSignIn) + acl([2,8]). Ownership is re-checked here
   * against req.user.id after reloading the RFQ — the client never names the
   * creator.
   */
  forcePublishRfq: async (req, res) => {
    const rfqId = Number(req.params.id);
    const userId = req.user?.id;
    try {
      if (!Number.isFinite(rfqId)) {
        return res.status(400).json({ status: 0, message: 'Invalid RFQ id' });
      }

      // Compare publish time in SQL so the timezone handling matches what the
      // watchdog uses — relying on `new Date(timestampWithoutTimeZone)` in JS
      // would re-interpret the value in the Node process's local TZ.
      const rfq = await db.oneOrNone(
        `SELECT id, rfq_no, is_tender, status, is_published, created_by, tender_publish_date,
                (tender_publish_date IS NULL OR tender_publish_date >= NOW()) AS publish_time_not_passed
         FROM tbl_rfq WHERE id = $1`,
        [rfqId]
      );
      if (!rfq) {
        return res.status(404).json({ status: 2, message: 'RFQ not found' });
      }
      if (Number(rfq.created_by) !== Number(userId)) {
        return res.status(403).json({ status: 0, message: 'Only the RFQ creator can force publish' });
      }
      if (rfq.is_published === 1) {
        return res.status(400).json({ status: 0, message: 'RFQ is already published' });
      }
      if (Number(rfq.status) !== 4) {
        return res.status(400).json({ status: 0, message: 'RFQ is not in Ready to Publish state' });
      }
      if (rfq.publish_time_not_passed) {
        return res.status(400).json({ status: 0, message: 'Scheduled publish time has not yet passed' });
      }

      const { publishRfqById } = await import('../../helper/cronManager.js');
      const result = await publishRfqById(rfqId, rfq.rfq_no, 'force');

      if (result?.skipped) {
        return res.status(400).json({
          status: 0,
          message: 'RFQ could not be force-published',
          reason: result.reason,
        });
      }

      // Best-effort: clean up any orphaned EventBridge schedule. The schedule
      // may already be gone (auto-delete after the failed firing) — that's fine.
      try {
        const { deleteRfqPublishSchedule } = await import('../../helper/createSchedule.js');
        await deleteRfqPublishSchedule(rfqId);
      } catch (cleanupErr) {
        logError(`Force publish: failed to delete orphaned schedule for RFQ ${rfqId}`, cleanupErr);
      }

      await recordLifecycleEvent({
        entity_type: rfq.is_tender === 1 ? 'TENDER' : 'RFQ',
        entity_id: rfqId,
        stage: 'PUBLISHED',
        action: 'FORCE_PUBLISH',
        performed_by: userId,
        metadata: {
          rfq_no: rfq.rfq_no,
          reason: 'Manual force publish after auto-publish failure',
          scheduled_publish_date: rfq.tender_publish_date,
        },
      });

      return res.status(200).json({
        status: 1,
        message: 'RFQ force published successfully',
        data: result,
      });
    } catch (error) {
      logError('Force publish failed', error);
      return res.status(500).json({ status: 3, message: error.message || 'Force publish failed' });
    }
  },

  // ============================================
  // Charge Names CRUD
  // ============================================

  _generateChargeSlug: (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),

  getAllChargeNames: async (req, res) => {
    try {
      const rows = await db.any(
        `SELECT name, slug, created_by FROM tbl_charge_names WHERE is_global = false ORDER BY created_by IS NULL DESC, id ASC`
      );
      return res.status(200).json({ status: 1, data: rows });
    } catch (error) {
      logError('Failed to fetch all charge names', error);
      return res.status(500).json({ status: 0, message: 'Error fetching charge names' });
    }
  },

  getChargeNames: async (req, res) => {
    try {
      const userId = req.user.id;
      const rows = await db.any(
        `SELECT id, name, slug, is_global, created_by FROM tbl_charge_names
         WHERE created_by IS NULL OR created_by = $1
         ORDER BY created_by IS NULL DESC, id ASC`,
        [userId]
      );
      return res.status(200).json({ status: 1, data: rows });
    } catch (error) {
      logError('Failed to fetch charge names', error);
      return res.status(500).json({ status: 0, message: 'Error fetching charge names' });
    }
  },

  createChargeName: async (req, res) => {
    try {
      const userId = req.user.id;
      const { name, is_global } = req.body;

      if (!name || !String(name).trim()) {
        return res.status(400).json({ status: 0, message: 'Name is required' });
      }

      const trimmedName = String(name).trim();

      // Check for duplicate (case-insensitive) among system defaults and vendor's own
      const existing = await db.oneOrNone(
        `SELECT id FROM tbl_charge_names
         WHERE LOWER(name) = LOWER($1) AND (created_by IS NULL OR created_by = $2)`,
        [trimmedName, userId]
      );
      if (existing) {
        return res.status(400).json({ status: 0, message: 'Charge name already exists' });
      }

      const slug = rfqController._generateChargeSlug(trimmedName);
      const row = await db.one(
        `INSERT INTO tbl_charge_names (name, slug, is_global, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id, name, slug, is_global`,
        [trimmedName, slug, is_global ?? false, userId]
      );
      return res.status(201).json({ status: 1, data: row });
    } catch (error) {
      logError('Failed to create charge name', error);
      return res.status(500).json({ status: 0, message: 'Error creating charge name' });
    }
  },

  updateChargeName: async (req, res) => {
    try {
      const userId = req.user.id;
      const { id } = req.params;
      const { name, is_global } = req.body;

      if (!name || !String(name).trim()) {
        return res.status(400).json({ status: 0, message: 'Name is required' });
      }

      const trimmedName = String(name).trim();

      // Only allow updating vendor's own custom charges
      const existing = await db.oneOrNone(
        `SELECT id, created_by FROM tbl_charge_names WHERE id = $1`,
        [id]
      );
      if (!existing) {
        return res.status(404).json({ status: 0, message: 'Charge name not found' });
      }
      if (existing.created_by === null) {
        return res.status(403).json({ status: 0, message: 'Cannot edit default charge names' });
      }

      // Check for duplicate
      const duplicate = await db.oneOrNone(
        `SELECT id FROM tbl_charge_names
         WHERE LOWER(name) = LOWER($1) AND id != $2 AND (created_by IS NULL OR created_by = $3)`,
        [trimmedName, id, userId]
      );
      if (duplicate) {
        return res.status(400).json({ status: 0, message: 'Charge name already exists' });
      }

      const slug = rfqController._generateChargeSlug(trimmedName);
      const row = await db.one(
        `UPDATE tbl_charge_names SET name = $1, slug = $2, is_global = $3
         WHERE id = $4 AND created_by = $5
         RETURNING id, name, slug, is_global`,
        [trimmedName, slug, is_global ?? false, id, userId]
      );
      return res.status(200).json({ status: 1, data: row });
    } catch (error) {
      logError('Failed to update charge name', error);
      return res.status(500).json({ status: 0, message: 'Error updating charge name' });
    }
  },

  deleteChargeName: async (req, res) => {
    try {
      const userId = req.user.id;
      const { id } = req.params;

      const existing = await db.oneOrNone(
        `SELECT id, created_by FROM tbl_charge_names WHERE id = $1`,
        [id]
      );
      if (!existing) {
        return res.status(404).json({ status: 0, message: 'Charge name not found' });
      }
      if (existing.created_by === null) {
        return res.status(403).json({ status: 0, message: 'Cannot delete default charge names' });
      }

      await db.none(
        `DELETE FROM tbl_charge_names WHERE id = $1 AND created_by = $2`,
        [id, userId]
      );
      return res.status(200).json({ status: 1, message: 'Charge name deleted' });
    } catch (error) {
      logError('Failed to delete charge name', error);
      return res.status(500).json({ status: 0, message: 'Error deleting charge name' });
    }
  }
};
export default rfqController;
