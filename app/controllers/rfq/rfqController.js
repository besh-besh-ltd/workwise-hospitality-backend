import Config from '../../config/app.config.js';
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
import userModel from '../../models/userModel.js';
import { sendNotification } from '../../services/notificationService.js';
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
import { raSchedulerForBuyer, raSchedulerForVendor  } from '../../helper/sendEmailFunctions/raEmailScheduler.js';
import generalModel, { createApprovalInstance, recordLifecycleEvent, getApprovalInstancesByEntity } from '../../models/generalModel.js';
import moment from 'moment-timezone';
import cmsModel from '../../models/cmsModel.js';
import { deleteSchedule } from '../../helper/createSchedule.js';
import { draftPO } from '../po/purchaseOrderController.js';
import { sendApprovalNotification } from '../po/purchaseOrderEmails.js';
import UsersController from '../users/usersController.js';
import { summaries } from '../../util/constants.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import negotiationModel from '../../models/negotiationModel.js';

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

const getDownloadURL = (url, excelToJson = false) => {
  if(process.env.NODE_ENV == "production" && !url.includes("https")) {
    url = url.replace("http", "https");
  }

  if(excelToJson) {
    url = url.replace("excel", "json");
  }

  return url;
}

export const notifyBuyerOnPersistenceViaEmail = (buyer_info, previous_status, status, persisted_rfq_id, errors, persistence, download_url) => {
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

      const mail = {
        from: Config.webmasterMail,
        to: email,
        subject,
        html
      };

        sendMail(mail);
  } catch (err) {
    console.error("Error in sendRfqUpdatedMailToVendors:", err);
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
    console.error('Error inserting data:', error);
    throw error;
  }
};

const sendMailToBuyerForRegret = async (buyer, rfqNumber, vendor, rfq_id, regret_reason) => {
  try {
    const { name, email } = buyer;
    const { name: vendor_name } = vendor;

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

    await sendMailWithRetry(mailRecipients);
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

    await sendMailWithRetry(mailRecipients);
    console.log(`Follow-up email sent to buyer ${email} for RFQ ${rfqNumber}`);
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
    console.error('Error sending email to vendor:', error);
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
      console.error(`Email send attempt ${retries} failed:`, error);
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

        // Send the email
        sendMail(mailRecipients);

        // console.log(`Email sent successfully to vendor: ${vendor.name}`);
      } catch (vendorError) {
        console.error(
          `Error sending email to vendor ${vendor.id}:`,
          vendorError
        );
        // Continue with next vendor even if one fails
      }
    }

    return {
      success: true,
      message: 'Target price notifications sent to all vendors'
    };
  } catch (error) {
    console.error('Error in sendMailToVendorsForTargetPrice:', error);
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
        console.error(`Failed to send email to vendor ${vendorId}:`, error);
        throw error;
      }
    });
   
    await Promise.all(emailPromises);
     if(reverse_auction){
      await raSchedulerForVendor(req,rfqNumber , vendorProductMAP);
    }
    return true;
  } catch (error) {
    console.error('Error in sendMailtoVendors:', error);
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

    await sendMailWithRetry(mailRecipients);
    console.log(`Confirmation email sent successfully to buyer ${id}`);
  } catch (error) {
    console.error('Error in sendQuotationMailToBuyer:', error);
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

  // Sending the email
  sendMail(mailRecipients);

  const message = `Thank you for submitting your updated quotation for #${rfq_no}`


  // Send notification message to vendor 
    // here we have to implement await Promise.allSettled(promises); for better perfomance
    spocList.map(async (spoc) => {
      if (spoc.mobile) {
      const whatsappPayload ={
        mobile:spoc.mobile,
        token:token[0].token,
        rfq_id:rfq_id,
        message:message,
        name:vendorName
      }
    
      await whatsappNotificationAISensy.sendQuoteSubmissionNotification(whatsappPayload)
    }
    })
  
    // send message to vendor
    const whatsappPayload ={
      mobile:user.mobile,
      token:token[0].token,
      rfq_id:rfq_id,
      message:message,
      name:vendorName
    }  
    await whatsappNotificationAISensy.sendQuoteSubmissionNotification(whatsappPayload)
  
  

};


const sendRevisedQuotationEmailToBuyer = async (buyerDetails, quoteItemChanges, user, rfq_id, rfq_no) => {
  

  // Extract vendor details from user object
  const vendorName = user.company_name || user.organization_name || user?.name;

// Group product names and count occurrences (variants)
const productCountMap = quoteItemChanges
  .filter(item => item.quote && item.quote.product_name)
  .reduce((acc, item) => {
    const name = item.quote.product_name;
    acc[name] = (acc[name] || 0) + 1;
    return acc;
  }, {});

// Build a list like ["Product A (x3)", "Product B (x2)", ...] max 3
const countedProducts = Object.entries(productCountMap)
  .slice(0, 3)
  .map(([name, count]) => `${name} (x${count})`);

// Append a simple "view more" indicator when there are more than 3
const formattedProducts = countedProducts.length > 0
  ? countedProducts.join(', ') + (Object.keys(productCountMap).length > 3 ? ` <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${rfq_id}" style="color: #059669; text-decoration: none;">view more</a>` : '')
  : '[Products]';
  

  // Email content
  const headerContent = `<h2>Hello ${buyerDetails[0]?.company_name || buyerDetails[0]?.organization_name || ''},</h2>`;

  const containerContent = `<div style="font-size: 15px; font-family: 'Roboto', sans-serif;">
      <p style="padding-bottom: 3px;">
        You've received a new quotation! Check out the details below:
      </p>

      <p><strong>RFQ:</strong> #${rfq_no}</p>
      <p><strong>Vendor:</strong> ${vendorName}</p>
      <p><strong>Products:</strong> ${formattedProducts}</p>

      <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${rfq_id}"
         style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; 
         text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; 
         width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
         Compare Quote
      </a>      

      <p style="margin-top:20px;">
        Stay updated with Workwise for more opportunities.
      </p>
    </div>`;

  // Generate final email layout
  const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

  // Preparing the email details
  let mailRecipients = {
    from: `${vendorName} ${Config.masterEmail}`,
    to: buyerDetails[0]?.email,
    subject: `New Quotation Received for Your RFQ`,
    html: dynamicHTML
  };

  // Sending the email
  sendMail(mailRecipients);

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

            <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${token[0].token}" 
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

  sendMail(mailRecipients);


  const message =  req.body.is_regret && req.body.is_regret == 1
  ? `Your regret concern for #${rfq_no} has been sent to the buyer.`:
  `Thank you for submitting your quotation for #${rfq_no}`

  // send message to spoc
  // here we have to implement await Promise.allSettled(promises); for better perfomance
  const vendorCompanyNameForWhatsApp = user.company_name || user.organization_name || user.name;
  spocList.map(async (spoc) => {
    if (spoc.mobile) {
    const whatsappPayload ={
      mobile:spoc.mobile,
      token:token[0].token,
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
    token:token[0].token,
    rfq_id:rfq_id,
    message:message,
    name:vendorCompanyName
  }  
  await whatsappNotificationAISensy.sendQuoteSubmissionNotification(whatsappPayload)

};

const sendRFQClosedMail = (buyerInfo, rfqItem, vendorList) => {
  const { name, email, organization_name, company_name } = buyerInfo;
  const buyerCompanyName = company_name || organization_name || name;

  // Define email content based on user role
  const headerContent = `<div>
                           <h2>Hello ${name},</h2>
                          </div>`;

  const buyerContainerContent = `<div style="font-size:16px;">
        You've marked your RFQ as closed. Here are the details for your records:<br>
        <strong>RFQ Number:</strong> ${rfqItem.rfq_no}<br>
        <strong>Closed By:</strong> ${name}<br>
        <br>
        <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfqItem.id}"
           style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
          View Closed RFQs
        </a>
           <br>
        <p>
        Keep moving forward with Workwise!
        </p>
      </div>`;

  const dynamicHTML = generateEmailTemplate(
    headerContent,
    buyerContainerContent
  );

  // Send email to the buyer
  const buyerMailRecipients = {
    from: Config.webmasterMail,
    to: email,
    subject: `RFQ Marked as Closed for #${rfqItem.rfq_no}`,
    html: dynamicHTML
  };
  sendMail(buyerMailRecipients);

  // Send email to all vendors and their SPOCs
  for (const vendor of vendorList) {
    const headerContentVendor = `<div>
          <h2>Hello ${vendor.user_name},</h2>
         </div>`;

    const vendorContainerContent = `<div style="font-size:16px;">
         The RFQ for <strong>${rfqItem.rfq_no}</strong> has been marked as closed by the buyer.<br>
         Thank you for your participation, and we look forward to more opportunities to work with you.<br>
         <br>
         
         <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfqItem.id}"
            style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
           Explore New RFQs
         </a>
          <br>
         <p>
          Tip: Regularly check for new RFQs to stay ahead and grow your business through Workwise.
         </p>
 
         </div>`;

    const dynamicHTMLVendor = generateEmailTemplate(
      headerContentVendor,
      vendorContainerContent
    );

    const spocList = vendor.spocs;

    let mailRecipients = {
      from: `${buyerCompanyName} ${Config.masterEmail}`,
      subject: `RFQ Marked as Closed for #${rfqItem.rfq_no}`,
      html: dynamicHTMLVendor
    };

    if (spocList && spocList.length > 0) {
      mailRecipients.to = spocList.map((spoc) => spoc.spoc_email);
    } else {
      mailRecipients.to = vendor.user_email;
    }

    sendMail(mailRecipients);
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
      console.warn('Failed to parse vendor endpoint for notifications');
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
  let { name,  organization_name, company_name } = req.user;
  let { rfq_id, rfq_no, products } = req.body;

    let u = await rfqModel.getRFQCreatedBy(rfq_id);
    if (u.length > 0) {
      let buyer = u[0];

      // Prepare product list with grouping and variant counts, max 3 entries
      const productCountMap = (products || []).reduce((acc, item) => {
        const name = item?.product_name || item?.name;
        if (name) acc[name] = (acc[name] || 0) + 1;
        return acc;
      }, {});

      let productEntries = Object.entries(productCountMap)
        .slice(0, 3)
        .map(([name, count]) => `${name} (x${count})`)
        .join(', ');

      if (Object.keys(productCountMap).length > 3) {
        productEntries += ` <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfq_id}" style="color: #059669; text-decoration: none;">view more</a>`;
      }

      const vendorCompanyName = company_name || organization_name || name;

      // Email header content
      const headerContent = `<h2>Hello ${buyer.company_name || buyer.organization_name || ''},</h2>`;

      // Email body content
      const containerContent = `
      <div style="font-size:16px; font-family: 'Roboto', sans-serif;">
        <p>
          You've received a new quotation! Check out the details below:
        </p>
        <p><strong>Vendor:</strong> ${vendorCompanyName}</p>
        <p><strong>Products:</strong> ${productEntries || '-'}</p>

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
      let mailRecipients = {
        from: `${vendorCompanyName} ${Config.masterEmail}`, // sender address
        //  organization_name : Config.webmasterMail,
        // to: buyer.email,
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

      // Sending the email to the buyer
      sendMail(mailRecipients);

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
   try {
     for (const vendor of vendorData) {
       const { name, email, vendor_id } = vendor;

       // Fetch vendor's SPOC details and token
       const spocs = await vendorModel.getSpocDetails(vendor_id , rfq_id);
       const tokenData = await rfqModel.getVendorRfqToken(vendor_id, rfq_id);
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
        //  mail.bcc = 'ayush@letsworkwise.com';
       } else {
         mail.to = email || '';
        //  mail.bcc = 'ayush@letsworkwise.com';
       }

       sendMail(mail);
     }
   } catch (err) {
     console.error('Error in sendRfqUpdatedMailToVendors:', err);
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

      sendMail(mailRecipients);

      console.log(`Email sent successfully to vendor: ${vendor.vendor_name}`);
    } catch (vendorError) {
      console.error(`Error sending email to vendor ${vendor.id}:`, vendorError);
    }

    return {
      success: true,
      message: 'Technical clause comment notification sent to vendor'
    };
  } catch (error) {
    console.error('Error in sendAddTechCommentMail:', error);
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
      // If it's an array, take the first element’s name
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
        from: `"${buyer_details[0]?.company_name || 'Workwise'}" ${
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

      sendMail(mailRecipients);

      console.log(
        `Email sent successfully to vendor: ${vendor.name} [${reject_message ? "Rejected" : "Accepted"}]`
      );
    } catch (vendorError) {
      console.error(`Error sending email to vendor ${vendor.id}:`, vendorError);
    }

    return {
      success: true,
      message: 'Technical evaluation decision email sent to vendor',
    };
  } catch (error) {
    console.error('Error in sendTechEvalAccepOrRejectMailToVendor:', error);
    throw error;
  }
};


const sendAddTechCommentMailForBuyer = async (buyer, vendor_id, product, text) => {
  try {
    const productName = product.name;
    const vendor_details = await userModel.user_profile_detail(vendor_id);
    const vendorName = vendor_details[0]?.company_name || "A Vendor";
    const rfq_no = buyer.rfq_no;

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

      sendMail(mailRecipients);

      console.log(`Email sent successfully to buyer: ${buyer.contactName}`);
    } catch (vendorError) {
      console.error(`Error sending email for vendor ${vendor_id}:`, vendorError);
    }

  } catch (error) {
    console.error('Error in sendAddTechCommentMailForBuyer:', error);
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
    <strong>#${rfqNumber} </strong>. We appreciate your participation and encourage you to stay active on Workwise for future opportunities.
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

    sendMail(mailRecipients);

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

    sendMail(mailRecipients);

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
    const key = `${item.product_name}_${item.category_id}`;
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


const saveRfqDraft = async (user_id, reqBody) => {
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
      ra_start_date,
      ra_end_date,
      project_id,
      term_and_condition_files,
      termsChanged,
      termFilesChanged,
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

  const rfqData = {
      comment,
      company_name,
      response_email,
      contact_name,
      contact_number,
      bid_end_date,
      location,
      rfq_type,
      reverse_auction,
      is_tender: is_tender !== undefined ? is_tender : 0,
      tender_fees: is_tender === 1 ? (tender_fees || 0) : 0,
      tender_publish_date: is_tender === 1 ? tender_publish_date : null,
      vendor_clarification_date: is_tender === 1 ? vendor_clarification_date : null,
      hospitality_company_id: hospitality_company_id || null,
      hotel_id: hotel_id || null,
      ra_start_date: reverse_auction == 1 ? ra_start_date : null,
      ra_end_date: reverse_auction == 1 ? ra_end_date : null,
      is_published: 0,
      updated_by: user_id
  };

  const errorObj = { vendorNotPresent: [] };

  if (effectiveProjectId && effectiveProjectId !== -1) {
      rfqData.project_id = effectiveProjectId;
  } else if (!effectiveProjectId || effectiveProjectId == '') {
    rfqData.project_id = null;
  }

  let rfqDetail = await rfqModel.updateWithTimestamp('tbl_rfq', rfqData, rfq_id);
  if(rfqDetail)
    rfqDetail = rfqDetail[0]
  else
    rfqDetail = {};

  // Handle terms update
  if (termsChanged && terms && terms.length > 0) {
      // First delete existing terms only if terms have changed
      await rfqModel.deleteWithReturnIds('tbl_rfq_terms_map', { rfq_id });
      
      // Then insert new terms
      const rfqTerms = terms.map(term => ({ 
          rfq_id, 
          terms_id: typeof term.id === 'number' ? term.id : parseInt(term.id)
      }));
      await rfqModel.insertArray(rfqTerms, ['rfq_id', 'terms_id'], 'tbl_rfq_terms_map');
  }

  if (termFilesChanged && term_and_condition_files) {
    // First delete existing term files only if term files have changed
    await rfqModel.deleteWithReturnIds('tbl_rfq_files', { rfq_id, file_type: 'term_and_condition' })

    const rfqFiles = term_and_condition_files.map(url => ({
        rfq_id,
        file_type: 'term_and_condition',
        file_url: url
    }));
    if(term_and_condition_files.length > 0)
      await rfqModel.insertArray(rfqFiles, ['rfq_id', 'file_type', 'file_url'], 'tbl_rfq_files');
  }

  await db.tx(async (t) => {
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

        // ✅ After loop: Throw combined error
        if (errorObj.vendorNotPresent.length > 0) {
         throw new Error(
           JSON.stringify({
             message: "Some products have no vendors. Please remove product oradd vendors for these products.",
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

      // RETURNING id is CRITICAL because: All child tables depend on rfq_id
      const { id: newRfqId } = await t.one(
        `
INSERT INTO tbl_rfq (
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
  hotel_id
)
SELECT
  comment,
  company_name,
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
  hospitality_company_id,
  tender_fees,
  $2
FROM tbl_rfq
WHERE id = $1
RETURNING id;
        `,
        [rfq_id, hotel_id]
      );

      // Track created RFQ ID for approval processing
      createdRfqIds.push(newRfqId);

      // -------------------------  4️ Duplicate RFQ PRODUCTS  -------------------------

      // We MUST capture old → new product ID mapping
      // because child tables depend on product_id
      const productIdMap = {};

      for (const product of rfqProducts) {
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

      // -------------------------  7 Duplicate PRODUCT VENDORS (leaf table)  -------------------------
      
      // Reset vendor view flags for new RFQ
      await t.none(
        `
        INSERT INTO tbl_rfq_product_vendors (
          rfq_id, product_variant_id, user_id, variant, sheet_id,
          is_rfq_viewed, vendor_name
        )
        SELECT
          $2, product_variant_id, user_id, variant, sheet_id,
          0, vendor_name
        FROM tbl_rfq_product_vendors
        WHERE rfq_id = $1
        `,
        [rfq_id, newRfqId]
      );

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
    `SELECT id, rfq_no, hospitality_company_id, hotel_id, is_tender, company_name
     FROM tbl_rfq WHERE id = $1`,
    [rfqId]
  );

  // Skip non-hospitality RFQs - they don't require approval
  if (!rfq || !rfq.hospitality_company_id) {
    return null;
  }

  // For hospitality RFQs/Tenders, approval is REQUIRED
  // Determine entity type based on is_tender flag
  const entityType = rfq.is_tender === 1 ? 'TENDER' : 'RFQ';

  // Let errors propagate (especially "no policy found" errors)
  const result = await createApprovalInstance({
    entity_type: entityType,
    entity_id: rfqId,
    hospitality_company_id: rfq.hospitality_company_id,
    hotel_id: rfq.hotel_id,
    initiated_by: userId,
    metadata: {
      rfq_number: rfq.rfq_no,
      is_tender: rfq.is_tender,
      company_name: rfq.company_name
    },
    txContext  // Pass transaction context to createApprovalInstance
  });

  return result;
};

/**
 * startApprovalForTechEval
 *
 * Submits a Technical Evaluation for approval by creating an approval instance.
 * Only applies to hospitality RFQs (those with hospitality_company_id).
 * Approval is at the product level - entity_id is the rfq_product_id.
 *
 * IMPORTANT: This function throws if no approval policy exists for the scope.
 * Hospitality Technical Evaluations MUST have an approval policy configured.
 *
 * @param {number} rfqProductId - The RFQ product ID to submit for approval
 * @param {number} rfqId - The RFQ ID associated with the product
 * @param {number} userId - The user ID initiating the approval
 * @param {Object} txContext - Optional transaction context for participating in outer transaction
 * @returns {Promise<Object|null>} - Approval instance result or null if not hospitality
 * @throws {Error} - If no approval policy exists for the hospitality scope
 */
const startApprovalForTechEval = async (rfqProductId, rfqId, userId, txContext = null) => {
  const dbContext = txContext || db;

  // Fetch RFQ details
  const rfq = await dbContext.oneOrNone(
    `SELECT id, rfq_no, hospitality_company_id, hotel_id, is_tender, company_name
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

  // Create approval instance for TECHNICAL entity type at product level
  const result = await createApprovalInstance({
    entity_type: 'TECHNICAL',
    entity_id: rfqProductId,
    hospitality_company_id: rfq.hospitality_company_id,
    hotel_id: rfq.hotel_id,
    initiated_by: userId,
    metadata: {
      rfq_id: rfqId,
      rfq_number: rfq.rfq_no,
      is_tender: rfq.is_tender,
      company_name: rfq.company_name,
      product_name: product.name,
      rfq_product_id: rfqProductId
    },
    txContext
  });

  return result;
};

/**
 * Handle TECHNICAL post-approval actions (auto-accept/reject vendors)
 * Called after TECHNICAL approval instance is fully approved
 */
const handleTechnicalPostApproval = async (approval_instance_id, approver_user_id, txContext = null) => {
  const t = txContext || db;
  
  try {
    // Get approval instance
    const { getApprovalInstanceById } = await import('../../models/generalModel.js');
    const instance = await getApprovalInstanceById(approval_instance_id, 'TECHNICAL', t);
    if (!instance || instance.status !== 'APPROVED') {
      return; // Not approved yet or not TECHNICAL type
    }

    const rfq_product_id = instance.entity_id;

    // Get tech evaluation ID for this product
    const techEval = await t.oneOrNone(`
      SELECT id, rfq_id, tbl_rfq_product_id, minimum_passing_score
      FROM tbl_rfq_product_tech_evaluation
      WHERE tbl_rfq_product_id = $1
    `, [rfq_product_id]);

    if (techEval) {
      // Get all vendors with their pass/fail status based on scores
      const vendorScores = await t.any(`
        SELECT
          vr.vendor_id,
          COALESCE(SUM(vr.buyer_marks), 0) AS total_marks,
          COALESCE(SUM(c.weightage), 0) AS total_weightage,
          CASE 
            WHEN COALESCE(SUM(c.weightage), 0) > 0 
            THEN ROUND((COALESCE(SUM(vr.buyer_marks), 0)::NUMERIC / COALESCE(SUM(c.weightage), 0)::NUMERIC) * 100, 2)
            ELSE 0
          END AS calculated_score,
          $2::NUMERIC AS minimum_passing_score,
          CASE 
            WHEN COALESCE(SUM(c.weightage), 0) > 0 
            THEN CASE 
              WHEN ROUND((COALESCE(SUM(vr.buyer_marks), 0)::NUMERIC / COALESCE(SUM(c.weightage), 0)::NUMERIC) * 100, 2) >= COALESCE($2::NUMERIC, 0)
              THEN true
              ELSE false
            END
            ELSE NULL
          END AS is_passed
        FROM tbl_rfq_product_tech_evaluation_clauses c
        LEFT JOIN tbl_rfq_product_tech_evaluation_vendors_response vr 
          ON c.id = vr.tbl_rfq_product_tech_evaluation_clauses_id
        WHERE c.tbl_rfq_product_tech_evaluation_id = $1
        GROUP BY vr.vendor_id
        HAVING vr.vendor_id IS NOT NULL
      `, [techEval.id, techEval.minimum_passing_score || 0]);

      // Auto-accept/reject vendors based on calculated pass/fail status
      for (const vendorScore of vendorScores) {
        if (vendorScore.is_passed !== null) {
          const status = vendorScore.is_passed ? 1 : 0; // 1 = accepted, 0 = rejected
          const reject_message = vendorScore.is_passed 
            ? null 
            : `Did not meet minimum passing score (${vendorScore.calculated_score}% < ${vendorScore.minimum_passing_score}%)`;

          // Check if vendor already has a record
          const existingRecord = await t.oneOrNone(`
            SELECT id FROM tbl_rfq_product_tech_evaluation_cleared_vendors
            WHERE tbl_rfq_product_tech_evaluation_id = $1 AND vendor_id = $2
          `, [techEval.id, vendorScore.vendor_id]);

          if (existingRecord) {
            // Update existing record
            await t.none(`
              UPDATE tbl_rfq_product_tech_evaluation_cleared_vendors
              SET status = $1, reject_message = $2, timestamp = NOW(), created_by = $3
              WHERE id = $4
            `, [status, reject_message, approver_user_id, existingRecord.id]);
          } else {
            // Insert new record
            await t.none(`
              INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors
              (tbl_rfq_product_tech_evaluation_id, vendor_id, status, reject_message, timestamp, created_by)
              VALUES ($1, $2, $3, $4, NOW(), $5)
            `, [techEval.id, vendorScore.vendor_id, status, reject_message, approver_user_id]);
          }
        }
      }
      console.log(`Auto-accepted/rejected ${vendorScores.length} vendors for tech eval ${techEval.id}`);
    }
  } catch (techEvalError) {
    // Log but don't fail the transaction
    console.error('Error handling TECHNICAL post-approval:', techEvalError);
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
    `SELECT id, rfq_no, hospitality_company_id, hotel_id, is_tender, company_name
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


// Export the helper function for use in general controller
export { handleTechnicalPostApproval };

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
    if (!req.user.subscription_plan_id) {
      return res
        .status(400)
        .json({
          status: 3,
          message: 'You need to purchase subscription to create RFQ'
        })
        .end();
    }

    try {
      let { rfq_id , ra_start_date , ra_end_date , bid_end_date , reverse_auction, selectedSheets } = req.body;


   
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
      if (reverse_auction) {
        if (!ra_start_date || !ra_end_date) {
          return res
            .status(400)
            .json({
              status: 3,
              errors: {
                ra_start_date: 'RA Start Date is required',
                ra_end_date: 'RA End Date is required'
              }
            })
            .end();
        }
        if (new Date(ra_start_date) >= new Date(ra_end_date)) {
          return res
            .status(400)
            .json({
              status: 3,
              errors: {
                ra_start_date: 'RA Start Date should be before RA End Date'
              }
            })
            .end();
        }
        if (new Date(ra_start_date) <= new Date(bid_end_date)) {
          return res
            .status(400)
            .json({
              status: 3,
              errors: {
                ra_start_date: 'RA Start Date should be after Bid End Date'
              }
            })
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
            errors: {
              rfq_specs:
                'Some products are missing quantity or unit. Please fill them before proceeding.'
            }
          })
          .end();
      }
      // const products = await rfqModel.getProductsByRfqId(rfq_id);

      await rfqModel.removeRFQData(rfq_id, selectedSheets);

      const [hotel_id] = req.body.hotel_ids || [];

      // Wrap RFQ update, duplication, and approval in a single transaction
      // If any step fails (e.g., no approval policy), everything rolls back
      const { responseUpdate, allRfqIds } = await db.tx(async (t) => {
        // Look up hospitality_company_id from the hotel
        let hospitality_company_id = null;
        if (hotel_id) {
          const hotelRecord = await t.oneOrNone(
            `SELECT hospitality_company_id FROM tbl_hospitality_company_hotels WHERE id = $1 AND is_deleted = 0`,
            [hotel_id]
          );
          hospitality_company_id = hotelRecord?.hospitality_company_id || null;
        }

        // Update RFQ with hotel_id, hospitality_company_id, and publish
        const updateResult = await t.any(
          `UPDATE tbl_rfq
           SET is_published = 1, hotel_id = $1, hospitality_company_id = $2
           WHERE id = $3
           RETURNING *`,
          [hotel_id || null, hospitality_company_id, rfq_id]
        );

        // Duplicate RFQ for other hotels (passes transaction context)
        const duplicationResult = await duplicateRfqForHotels(rfq_id, req.body.hotel_ids || [], user_id, t);

        // Start approval process for all RFQs (original + duplicates)
        // IMPORTANT: For hospitality RFQs, approval policy is REQUIRED
        // If no policy exists, this will throw and rollback the entire transaction
        const rfqIds = duplicationResult?.allRfqIds || [rfq_id];
        await Promise.all(
          rfqIds.map(async (id) => {
            const approvalResult = await startApprovalForRfq(id, user_id, t);
            
            // Record lifecycle: SUBMITTED for approval
            const rfqData = await t.oneOrNone(
              `SELECT is_tender FROM tbl_rfq WHERE id = $1`,
              [id]
            );
            if (rfqData && approvalResult) {
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

        // Record lifecycle: PUBLISHED (after approval process started)
        const publishedRfq = updateResult[0];
        if (publishedRfq && publishedRfq.hospitality_company_id) {
          await recordLifecycleEvent({
            entity_type: publishedRfq.is_tender === 1 ? 'TENDER' : 'RFQ',
            entity_id: rfq_id,
            stage: 'PUBLISHED',
            action: 'PUBLISH',
            performed_by: user_id,
            metadata: { rfq_no: publishedRfq.rfq_no },
            txContext: t
          });
        }

        return { responseUpdate: updateResult, allRfqIds: rfqIds };
      });

      // -------------------
      // Email notifications happen AFTER successful transaction

      await sendMailtoVendors(req, rfq_id);
      await sendQuotationMailToBuyer(req, rfq_id);

      const buyerMsgPayload = {
        mobile: req.user.mobile,
        rfq_id: rfq_id,
        rfq_no: responseUpdate[0]?.rfq_no
      };

      whatsappNotificationAISensy.buyerCreatesRFQNotification(buyerMsgPayload);

      return res
        .status(200)
        .json({
          status: 1,
          data: responseUpdate[0],
          mail_sent: true
        })
        .end();
    } catch (error) {
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

  update: async (req, res, next) => {
    if (!req.user.subscription_plan_id) {
      res
        .status(400)
        .json({
          status: 3,
          message: 'You need to purchase subscription to create RFQ'
        })
        .end();
      return;
    }

    try {
      await db.tx(async (t) => {
        const data = req.body;
        console.log('rfq controller 1 data', data);
        const { termsChanged, selectedTerms } = data;

        delete data.termsChanged;
        delete data.selectedTerms;

        const rfq_id = data.rfq_id;
        delete data.rfq_id; // Remove rfq_id from update fields

        // Override model database access to use transaction
        const transactingModels = {
          rfqModel: withTransaction(rfqModel, t),
          userModel: withTransaction(userModel, t),
          vendorModel: withTransaction(vendorModel, t)
        };

        let prevRfqDetails = await rfqModel.checkIfExists(
          'tbl_rfq',
          `id = ${rfq_id}`
        );
        if (!prevRfqDetails || prevRfqDetails.length <= 0) {
          throw new Error('RFQ does not exist with id: ', rfq_id);
        }

        prevRfqDetails = prevRfqDetails[0];

        // List of keys to populate from prev if not already present
        const fieldsToPopulate = [
          'company_name',
          'ra_start_date',
          'ra_end_date'
        ];

        fieldsToPopulate.forEach((key) => {
          if (!req.body[key] && prevRfqDetails[key]) {
            req.body[key] = prevRfqDetails[key];
          }
        });

        const updatableData = data.updatableData;
        delete data.updatableData;

        const products = updatableData?.products;
        const updatableVendors = updatableData?.vendors;
        const newAddedproductVendors = {}; // { [email]: { name, email, product_names: [] } }
        const deletedProductVendors = {}; // { [email]: { name, email, product_names: [] } }
        const deletedVendorsFromExistingProducts = {}; // { [email]: { name, email, product_names: [] } }
        const addedVednorsToExistingProducts = {}; // { [email]: { name, email, product_names: [] } }
        const updatedDataVendors = [];
        const changedDetails = [];

        if (products && products?.updatable) {
          const updatableKeys = new Set();
          //handling new Product added
          if (products?.addable?.length > 0) {
            await Promise.all(
              products.addable
                .map(async (productId) => {
                  if (
                    products?.deletable &&
                    products.deletable.length > 0 &&
                    products.deletable.includes(parseInt(productId))
                  )
                    return null;
                  const vendors =
                    await transactingModels.rfqModel.searchEmailAndNameForVendor(
                      rfq_id,
                      productId
                    ); // returns array of { name, email, product_name }

                  if (Array.isArray(vendors) && vendors.length > 0) {
                    for (const {
                      vendor_id,
                      name,
                      email,
                      product_name
                    } of vendors) {
                      if (!newAddedproductVendors[vendor_id]) {
                        newAddedproductVendors[vendor_id] = {
                          name,
                          email,
                          product_names: [],
                          vendor_id
                        };
                      }

                      if (
                        !newAddedproductVendors[
                          vendor_id
                        ].product_names.includes(product_name)
                      ) {
                        newAddedproductVendors[vendor_id].product_names.push(
                          product_name
                        );
                      }

                      await transactingModels.rfqModel.insertVendorRfqToken(
                        vendor_id,
                        rfq_id
                      );
                    }
                  }
                })
                .filter(Boolean)
            );
          }

          // Handling Specs insert and/or update
          if (products.updatable?.specs)
            Object.keys(products.updatable.specs).forEach((rfqProductId) => {
              if (
                products?.deletable &&
                products.deletable.length > 0 &&
                products.deletable.includes(parseInt(rfqProductId))
              )
                return;

              const productId =
                products.updatable.specs[rfqProductId].product_id;
              const variant = products.updatable.specs[rfqProductId].variant;
              delete products.updatable.specs[rfqProductId].variant;
              delete products.updatable.specs[rfqProductId].product_id;

              if (!products.addable?.includes(parseInt(rfqProductId))) {
                updatableKeys.add(rfqProductId);
              }

              let whereClause = `rfq_id = (${rfq_id})::INT AND product_variant_id = (${productId})::INT AND variant = (${
                variant ?? '0'
              })::INT`;

              Object.keys(products.updatable.specs[rfqProductId]).forEach(
                async (spec) => {
                  const data = {
                    value: products.updatable.specs[rfqProductId][spec]
                  };
                  const currentWhereClause =
                    whereClause + ` AND title = '${spec}'`;
                  const doesExist =
                    await transactingModels.rfqModel.checkIfExists(
                      'tbl_rfq_products_specs',
                      currentWhereClause
                    );
                  if (doesExist && doesExist.length > 0) {
                    await transactingModels.rfqModel.updateWhere(
                      'tbl_rfq_products_specs',
                      data,
                      currentWhereClause
                    );
                  } else {
                    const insertData = {
                      ...data,
                      rfq_id,
                      product_variant_id: productId,
                      title: spec,
                      variant: parseInt(variant ?? '0')
                    };
                    await transactingModels.rfqModel.insert(
                      'tbl_rfq_products_specs',
                      insertData
                    );
                  }
                }
              );
            });

          // Handling Files insert and/or update
          if (products.updatable?.files)
            Object.keys(products.updatable.files).forEach((rfqProductId) => {
              if (
                products?.deletable &&
                products.deletable.length > 0 &&
                products.deletable.includes(parseInt(rfqProductId))
              )
                return;

              delete products.updatable.files[rfqProductId].variant;
              delete products.updatable.files[rfqProductId].product_id;

              if (!products.addable?.includes(parseInt(rfqProductId))) {
                updatableKeys.add(rfqProductId);
              }

              let whereClause = `rfq_product_id = (${rfqProductId})::INT`;

              Object.keys(products.updatable.files[rfqProductId]).forEach(
                async (fileType) => {
                  const transformedFileType =
                    fileType == 'qap_file'
                      ? 'QAP'
                      : fileType == 'spec_file'
                      ? 'SPEC'
                      : 'TDS';

                  const currentWhereClause =
                    whereClause + ` AND file_type = '${transformedFileType}'`;
                  const doesExist =
                    await transactingModels.rfqModel.checkIfExists(
                      'tbl_rfq_product_files',
                      currentWhereClause
                    );
                  const data = products.updatable.files[rfqProductId][fileType];
                  const isRemovable = !Array.isArray(data) && data == 'rm';

                  if (doesExist && doesExist.length > 0) {
                    const conditions = {
                      rfq_product_id: rfqProductId,
                      file_type: transformedFileType
                    };
                    await transactingModels.rfqModel.delete(
                      'tbl_rfq_product_files',
                      conditions,
                      t
                    );
                    if (!isRemovable) {
                      const insertableData = data.map((file_url) => ({
                        rfq_product_id: rfqProductId,
                        file_type: transformedFileType,
                        file_url
                      }));
                      await rfqModel.insertArray(
                        insertableData,
                        Object.keys(insertableData[0]),
                        'tbl_rfq_product_files'
                      );
                    }
                  } else if (!isRemovable) {
                    const insertableData = data.map((file_url) => ({
                      rfq_product_id: rfqProductId,
                      file_type: transformedFileType,
                      file_url
                    }));
                    await transactingModels.rfqModel.insertArray(
                      insertableData,
                      Object.keys(insertableData[0]),
                      'tbl_rfq_product_files'
                    );
                  }
                }
              );
            });

          if (products.updatable?.comment)
            Object.keys(products.updatable.comment).forEach(
              async (rfqProductId) => {
                if (
                  products?.deletable &&
                  products.deletable.length > 0 &&
                  products.deletable.includes(rfqProductId)
                )
                  return;

                const productId =
                  products.updatable.comment[rfqProductId].product_id;
                const variant =
                  products.updatable.comment[rfqProductId].variant;
                const comment =
                  products.updatable.comment[rfqProductId].comment;

                if (!products.addable?.includes(parseInt(rfqProductId))) {
                  updatableKeys.add(rfqProductId);
                }

                let whereClause = `rfq_id = (${rfq_id})::INT AND product_variant_id = (${productId})::INT AND variant = (${variant})::INT`;

                const data = {
                  comment
                };
                await transactingModels.rfqModel.updateWhere(
                  'tbl_rfq_products',
                  data,
                  whereClause
                );
              }
            );
          //Handle tech eval add ,update, delete here
          if (products.updatable?.techEval) {
            Object.keys(products.updatable.techEval).forEach((rfqProductId) => {
              if (!products.addable?.includes(parseInt(rfqProductId))) {
                updatableKeys.add(rfqProductId);
              }
            });
          }

          const uniqueVendorMap = {};
          // Fetch vendors for updated product RFQ IDs
          await Promise.all(
            Array.from(updatableKeys).map(async (rfqProductId) => {
              // const productId =
              //   products.updatable.specs?.[rfqProductId]?.product_id ||
              //   products.updatable.comment?.[rfqProductId]?.product_id ||
              //   products.updatable.files?.[rfqProductId]?.product_id;

              const vendors =
                await transactingModels.rfqModel.searchEmailAndNameForVendor(
                  rfq_id,
                  rfqProductId
                ); // returns array of { name, email, product_name }
              // console.log('vendors for updated product', vendors);

              if (Array.isArray(vendors)) {
                vendors.forEach(({ vendor_id, name, email, product_name }) => {
                  if (!uniqueVendorMap[vendor_id]) {
                    uniqueVendorMap[vendor_id] = {
                      name,
                      email,
                      product_names: new Set(),
                      vendor_id
                    };
                  }
                  uniqueVendorMap[vendor_id].product_names.add(product_name);
                });
              }
            })
          );

          // Convert Set to array
          for (const vendor of Object.values(uniqueVendorMap)) {
            updatedDataVendors.push({
              name: vendor.name,
              email: vendor.email,
              product_name: [...vendor.product_names].join(', '),
              vendor_id: vendor.vendor_id
            });
            await transactingModels.rfqModel.insertVendorRfqToken(
              vendor.vendor_id,
              rfq_id
            );
          }
        }

        if (products && products?.deletable && products.deletable.length > 0) {
          for (const rfqProductId of products.deletable) {
            const vendors =
              await transactingModels.rfqModel.searchEmailAndNameForVendor(
                rfq_id,
                rfqProductId
              );

            if (Array.isArray(vendors) && vendors.length > 0) {
              for (const { vendor_id, name, email, product_name } of vendors) {
                if (!deletedProductVendors[vendor_id]) {
                  deletedProductVendors[vendor_id] = {
                    name,
                    email,
                    product_names: [],
                    vendor_id
                  };
                }

                if (
                  !deletedProductVendors[vendor_id].product_names.includes(
                    product_name
                  )
                ) {
                  deletedProductVendors[vendor_id].product_names.push(
                    product_name
                  );
                }
              }
            }

            // Delete records from tbl_rfq_products
            let deletedRecord = await transactingModels.rfqModel.delete(
              'tbl_rfq_products',
              {
                id: rfqProductId
              }
            );
            if (!deletedRecord || deletedRecord.length === 0) continue;

            deletedRecord = deletedRecord[0];

            // Delete vendor mapping
            const vendorConditions = {
              rfq_id,
              product_variant_id: deletedRecord.product_variant_id,
              variant: deletedRecord.variant
            };
            await transactingModels.rfqModel.delete(
              'tbl_rfq_product_vendors',
              vendorConditions
            );

            // Directly deleting product specs as well
            await transactingModels.rfqModel.delete(
              'tbl_rfq_products_specs',
              vendorConditions
            );

            // Delete associated files
            const directRfqProductConditions = { rfq_product_id: rfqProductId };
            await transactingModels.rfqModel.delete(
              'tbl_rfq_product_files',
              directRfqProductConditions
            );

            // Delete tech evaluations
            const techEvaluationCondition = {
              tbl_rfq_product_id: rfqProductId
            };
            const techEvaluationDeletedRecordsIds =
              await transactingModels.rfqModel.deleteWithReturnIds(
                'tbl_rfq_product_tech_evaluation',
                techEvaluationCondition
              );

            // Delete tech evaluation clauses and other nested data
            if (techEvaluationDeletedRecordsIds?.length > 0) {
              for (const techEvaluationId of techEvaluationDeletedRecordsIds) {
                const techEvaluationClauseCondition = {
                  tbl_rfq_product_tech_evaluation_id: techEvaluationId
                };

                const techEvaluationClausesDeletedRecordsIds =
                  await transactingModels.rfqModel.deleteWithReturnIds(
                    'tbl_rfq_product_tech_evaluation_clauses',
                    techEvaluationClauseCondition
                  );

                // Delete cleared vendors
                await transactingModels.rfqModel.deleteWithReturnIds(
                  'tbl_rfq_product_tech_evaluation_cleared_vendors',
                  techEvaluationClauseCondition
                );

                if (techEvaluationClausesDeletedRecordsIds?.length > 0) {
                  for (const techEvaluationClauseId of techEvaluationClausesDeletedRecordsIds) {
                    const clauseCondition = {
                      tbl_rfq_product_tech_evaluation_clauses_id:
                        techEvaluationClauseId
                    };

                    await transactingModels.rfqModel.delete(
                      'tbl_rfq_product_tech_evaluation_clauses_files',
                      clauseCondition
                    );

                    const techEvaluationVendorResponseDeletedRecords =
                      await transactingModels.rfqModel.deleteWithReturnIds(
                        'tbl_rfq_product_tech_evaluation_vendors_response',
                        clauseCondition
                      );

                    if (
                      techEvaluationVendorResponseDeletedRecords?.length > 0
                    ) {
                      for (const vendorResponse of techEvaluationVendorResponseDeletedRecords) {
                        const vendorResponseCondition = {
                          tbl_rfq_product_tech_evaluation_vendors_response_id:
                            vendorResponse
                        };

                        await transactingModels.rfqModel.delete(
                          'tbl_rfq_product_tech_evaluation_vendors_response_files',
                          vendorResponseCondition
                        );
                      }
                    }

                    const techEvaluationCommentsDeletedRecords =
                      await transactingModels.rfqModel.deleteWithReturnIds(
                        'tbl_rfq_product_tech_evaluation_comments',
                        clauseCondition
                      );

                    if (techEvaluationCommentsDeletedRecords?.length > 0) {
                      for (const evaluationComment of techEvaluationCommentsDeletedRecords) {
                        const commentFilesCondition = {
                          tbl_rfq_product_tech_evaluation_comments_id:
                            evaluationComment
                        };

                        await transactingModels.rfqModel.deleteWithReturnIds(
                          'tbl_rfq_product_tech_evaluation_comments_files',
                          commentFilesCondition
                        );
                      }
                    }
                  }
                }
              }
            }
          }
        }

        if (updatableVendors && Object.keys(updatableVendors).length > 0) {
          for (const rfqProductId of Object.keys(updatableVendors)) {
            const productId = updatableVendors[rfqProductId].product_id;
            const variant = updatableVendors[rfqProductId].variant;

            const addable = updatableVendors[rfqProductId]?.addable ?? [];
            const deletable = updatableVendors[rfqProductId]?.deletable ?? [];

            const productDetails =
              await transactingModels.rfqModel.getProductOrVariantNameByRfqProductId(
                rfqProductId
              );

            // Extract Deleted Vendors Before deletion operation
            for (const vendorId of deletable) {
              const vendordata = await transactingModels.userModel.getUserById(
                vendorId
              );
              if (!vendordata || vendordata.length === 0) continue;

              const { id, name, email } = vendordata[0];

              if (productDetails) {
                deletedVendorsFromExistingProducts[id] = {
                  name: name || 'Unknown',
                  email: email || 'Unknown',
                  productDetails,
                  vendor_id: id
                };
              }
            }

            // Extract Added Vendors
            for (const vendorId of addable) {
              const vendordata = await transactingModels.userModel.getUserById(
                vendorId
              );
              if (!vendordata || vendordata.length === 0) continue;

              const { id, name, email } = vendordata[0];

              if (productDetails) {
                addedVednorsToExistingProducts[id] = {
                  name: name || 'Unknown',
                  email: email || 'Unknown',
                  productDetails,
                  vendor_id: id
                };
              }
              await transactingModels.rfqModel.insertVendorRfqToken(id, rfq_id);
            }

            // Insert new vendors
            if (addable.length > 0) {
              const addableData = addable.map((vendor) => ({
                rfq_id,
                product_variant_id: productId,
                user_id: vendor,
                variant
              }));

              await transactingModels.rfqModel.insertArray(
                addableData,
                Object.keys(addableData[0]),
                'tbl_rfq_product_vendors'
              );
            }

            // Delete existing vendors
            if (deletable.length > 0) {
              for (const vendor of deletable) {
                let productDetails =
                  await transactingModels.rfqModel.checkIfExists(
                    'tbl_product_variant',
                    `id = ${productId}`
                  );
                if (!productDetails || productDetails.length === 0) continue;

                productDetails = productDetails[0];

                const conditions = {
                  rfq_id,
                  product_variant_id: productId,
                  user_id: vendor,
                  variant
                };

                await transactingModels.rfqModel.delete(
                  'tbl_rfq_product_vendors',
                  conditions
                );
              }
            }
          }
        }

        // Explicitly handle potential empty strings from frontend, converting them to null
        if ('ra_start_date' in data && data.ra_start_date === '') {
          data.ra_start_date = null;
        }
        if ('ra_end_date' in data && data.ra_end_date === '') {
          data.ra_end_date = null;
        }
        if ('bid_end_date' in data && data.bid_end_date === '') {
          data.bid_end_date = null;
        }
        // Ensure reverse_auction is boolean/integer if present
        if ('reverse_auction' in data) {
          data.reverse_auction = data.reverse_auction ? 1 : 0;
        }

        //  Ensure project_id is either an integer or null
        if (
          'project_id' in data &&
          data.project_id !== null &&
          data.project_id !== undefined
        ) {
          data.project_id = parseInt(data.project_id);
        } else {
          delete data.project_id; // Avoid updating with undefined/null
        }

        // Update rfq with latest data
        let updatedData = await transactingModels.rfqModel.update(
          'tbl_rfq',
          data,
          rfq_id
        );

        if (updatedData && updatedData.length > 0) {
          updatedData = updatedData[0];

          // Check each and every field with prevRfqDetails data to get what has changed!
          if (updatedData.comment != prevRfqDetails.comment)
            changedDetails.push(
              `Comment from ${prevRfqDetails.comment} -> ${updatedData.comment}`
            );
          if (updatedData.response_email != prevRfqDetails.response_email)
            changedDetails.push(
              `Response email from ${prevRfqDetails.response_email} -> ${updatedData.response_email}`
            );
          if (updatedData.contact_name != prevRfqDetails.contact_name)
            changedDetails.push(
              `Contact name from ${prevRfqDetails.contact_name} -> ${updatedData.contact_name}`
            );
          if (updatedData.contact_number != prevRfqDetails.contact_number)
            changedDetails.push(
              `Contact number from ${prevRfqDetails.contact_number} -> ${updatedData.contact_number}`
            );
          if (updatedData.location != prevRfqDetails.location)
            changedDetails.push(
              `Location from ${prevRfqDetails.location} -> ${updatedData.location}`
            );
          if (updatedData.bid_end_date != prevRfqDetails.bid_end_date)
            changedDetails.push(
              `Procurement end date from ${prevRfqDetails.bid_end_date} -> ${updatedData.bid_end_date}`
            );
          if (updatedData.rfq_type != prevRfqDetails.rfq_type)
            changedDetails.push(
              `RFQ Type from ${prevRfqDetails.rfq_type} -> ${updatedData.rfq_type}`
            );
          if (updatedData.reverse_auction != prevRfqDetails.reverse_auction)
            changedDetails.push(
              `Reverse Auction from ${
                prevRfqDetails.reverse_auction == '-1' ||
                prevRfqDetails.reverse_auction == '0'
                  ? 'Disabled'
                  : 'Enabled'
              } -> ${
                updatedData.reverse_auction == '-1' ||
                updatedData.reverse_auction == '0'
                  ? 'Disabled'
                  : 'Enabled'
              }`
            );

          if (updatedData.project_id != prevRfqDetails.project_id)
            changedDetails.push(
              `Reverse Auction from ${prevRfqDetails.project_id} -> ${updatedData.project_id}`
            );
          if (updatedData.ra_start_date != prevRfqDetails.ra_start_date)
            changedDetails.push(
              `Reverse Auction Start Date from ${prevRfqDetails.ra_start_date} -> ${updatedData.ra_start_date}`
            );
          if (updatedData.ra_end_date != prevRfqDetails.ra_end_date)
            changedDetails.push(
              `Reverse Auction End Date from ${prevRfqDetails.ra_end_date} -> ${updatedData.ra_end_date}`
            );
        }
        let reverseAuctionDateChanged =
          updatedData.ra_start_date != prevRfqDetails.ra_start_date &&
          updatedData.ra_end_date != prevRfqDetails.ra_end_date;

        if (termsChanged && selectedTerms && selectedTerms.length > 0) {
          // First delete existing selectedTerms only if selectedTerms have changed
          await rfqModel.deleteWithReturnIds('tbl_rfq_terms_map', { rfq_id });

          // Then insert new selectedTerms
          const rfqTerms = selectedTerms.map((term) => ({
            rfq_id,
            terms_id: typeof term.id === 'number' ? term.id : parseInt(term.id)
          }));
          await rfqModel.insertArray(
            rfqTerms,
            ['rfq_id', 'terms_id'],
            'tbl_rfq_terms_map'
          );

          changedDetails.push(`Terms and Conditions`);
        }

        // get rfq vendors list
        let vendors = await transactingModels.rfqModel.gerRFQVendors(rfq_id);
        let vendorIdList = vendors.map((vendor) => vendor.user_id);

        // get vendor details along with spoc
        const vendorData =
          await transactingModels.vendorModel.getVendorsWithSpocsAndToken(
            vendorIdList,
            rfq_id
          );

        const buyerName = updatedData?.company_name ?? '-';
        const rfqNo = updatedData?.rfq_no ?? '000000';

        const newAddedproductVendorsArray = Object.values(
          newAddedproductVendors
        );
        const deletedProductVendorsArray = Object.values(deletedProductVendors);
        const deletedVendorsFromExistingProductsArray = Object.values(
          deletedVendorsFromExistingProducts
        );
        const addedVednorsToExistingProductsArray = Object.values(
          addedVednorsToExistingProducts
        );
        const updatedDataVendorsArray = Object.values(updatedDataVendors);

        const productsData = await rfqModel.getProductsByRfqId(rfq_id, t);

        const vendorProductmap = {}; // This is different variable check the  spelling.

        //Creating  A New product vendor map
        productsData.map((product) => {
          const { name, vendors } = product;

          vendors.map((vendor) => {
            const { user_id } = vendor;

            if (!vendorProductmap[user_id]) {
              vendorProductmap[user_id] = {
                vendorDetails: { ...vendor },
                products: []
              };
            }

            vendorProductmap[user_id].products.push({ product_name: name });
          });
        });
        const deleteScheduleTypesForVendors = [
          'oneDayBeforeAuctionVendor',
          'auctionStartVendor',
          'midAuctionReminderVendor',
          'auctionEndVendor'
        ];
        const deleteScheduleTypesForbuyers = [
          'auctionStartBuyer',
          'auctionEndBuyer'
        ];

        if (!data.reverse_auction) {
          //Delete Vendor Schedules if reverse auction is disabled
          for (const vendorId of Object.keys(vendorProductmap)) {
            for (const scheduleType of deleteScheduleTypesForVendors) {
              await deleteSchedule(rfq_id, scheduleType, vendorId);
            }
          }
          //Delete Buyer Schedules if reverse auction is disabled
          for (const scheduleType of deleteScheduleTypesForbuyers) {
            await deleteSchedule(rfq_id, scheduleType);
          }
        } else if (data.reverse_auction === prevRfqDetails.reverse_auction) {
          //further processing for schedules

          if (reverseAuctionDateChanged) {
            //Date changed hence delete all the existing schedules for vendors
            for (const vendorId of Object.keys(vendorProductmap)) {
              for (const scheduleType of deleteScheduleTypesForVendors) {
                await deleteSchedule(rfq_id, scheduleType, vendorId);
              }
            }
            //Date changed hence delete all the existing schedules for buyers
            for (const scheduleType of deleteScheduleTypesForbuyers) {
              await deleteSchedule(rfq_id, scheduleType);
            }
            //Create new schedules for vendors
            await raSchedulerForVendor(req, rfq_id, vendorProductmap);

            //create new schedules for buyers
            await raSchedulerForBuyer(rfq_id, req, productsData);
          } else {
            //handle the case where reverse auction is enabled but date is not changed
            //vendors might have been added or removed
            //So we need to add or remove some of the vendors schedules who have been deleted or added
            //We will not delete the existing schedules as date is not changed

            if (deletedVendorsFromExistingProductsArray.length > 0) {
              for (const vendor of deletedVendorsFromExistingProductsArray) {
                const { vendor_id } = vendor;
                for (const scheduleType of deleteScheduleTypesForVendors) {
                  const whereClause = `rfq_id = ${rfq_id} AND user_id = ${vendor_id}`;
                  // Check if vendor is still present in RFQ
                  const vendorPresentInRfq = await rfqModel.checkIfExists(
                    'tbl_rfq_product_vendors',
                    whereClause
                  );

                  if (!vendorPresentInRfq || vendorPresentInRfq.length === 0) {
                    await deleteSchedule(rfq_id, scheduleType, vendor_id);
                  }
                }
              }
            }

            if (deletedProductVendorsArray.length > 0) {
              for (const vendor of deletedProductVendorsArray) {
                const { vendor_id } = vendor;
                for (const scheduleType of deleteScheduleTypesForVendors) {
                  const whereClause = `rfq_id = ${rfq_id} AND user_id = ${vendor_id}`;
                  // Check if vendor is still present in RFQ
                  const vendorPresentInRfq = await rfqModel.checkIfExists(
                    'tbl_rfq_product_vendors',
                    whereClause
                  );

                  await deleteSchedule(rfq_id, scheduleType, vendor_id);
                }
              }
            }

            //create  a new product vendor map for new added vendors either in new products or existing products

            // Step 1: Collect all target vendor IDs from both arrays
            const targetVendorIds = new Set([
              ...newAddedproductVendorsArray.map((v) => v.vendor_id),
              ...addedVednorsToExistingProductsArray.map((v) => v.vendor_id)
            ]);

            // Step 2: Filter vendorProductmap to include only those IDs
            const filteredProductVendorMap = Object.fromEntries(
              Object.entries(vendorProductmap).filter(
                ([vendorId, vendorData]) =>
                  targetVendorIds.has(Number(vendorId))
              )
            );

            // Step 3: Done
            console.log(
              '✅ filteredProductVendorMap:',
              filteredProductVendorMap
            );
            //Create new schedules for vendors
            if (Object.keys(filteredProductVendorMap).length > 0) {
              await raSchedulerForVendor(req, rfq_id, filteredProductVendorMap);
            }
          }
        } else if (data.reverse_auction && !prevRfqDetails.reverse_auction) {
          //Create new schedules for vendors
          await raSchedulerForVendor(req, rfq_id, vendorProductmap);

          //create new schedules for buyers
          await raSchedulerForBuyer(rfq_id, req, productsData);
        }

        await sendRfqUpdatedMailToVendors(
          newAddedproductVendorsArray,
          rfq_id,
          rfqNo,
          buyerName,
          RFQ_EMAIL_TYPE.NEW_PRODUCT
        ); //for new add produccts

        await sendRfqUpdatedMailToVendors(
          deletedProductVendorsArray,
          rfq_id,
          rfqNo,
          buyerName,
          RFQ_EMAIL_TYPE.REMOVED_VENDOR
        ); //for deleted products from RFQ

        await sendRfqUpdatedMailToVendors(
          deletedVendorsFromExistingProductsArray,
          rfq_id,
          rfqNo,
          buyerName,
          RFQ_EMAIL_TYPE.REMOVED_VENDOR
        ); //for deleted vendors from existing products

        await sendRfqUpdatedMailToVendors(
          addedVednorsToExistingProductsArray,
          rfq_id,
          rfqNo,
          buyerName,
          RFQ_EMAIL_TYPE.NEW_PRODUCT
        ); //for added vendors to existing products

        // Send updated RFQ mail to vendors
        await sendRfqUpdatedMailToVendors(
          updatedDataVendorsArray,
          rfq_id,
          rfqNo,
          buyerName,
          RFQ_EMAIL_TYPE.UPDATED_RFQ
        );

        res.status(200).json({
          status: 1,
          data: updatedData || {},
          vendors: vendorData,
          rfqDetails: updatedData,
          message: 'RFQ updated successfully'
        });
      });
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: error
        })
        .end();
    }
  },

  saveDraft: async (req, res) => {
    try {
      const response = await saveRfqDraft(req.user.id, req.body);

      res.status(200).json({
        status: 1,
        message: response
      });
    } catch (error) {
      logError(error);
       
     let parsedError = {};
       parsedError = JSON.parse(error?.message);

      res.status(500).json({
        status: 3,
        message: 'An error occurred while saving the draft',
        errors: {
          rfq:error?.message || 'An error occurred while saving the draft',
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
      console.error('Error deleting RFQ draft:', error);
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
      console.log(error)
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
      console.log(error);
      logError('Error fetching RFQ creation data:', error);
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
      const rfq_no = req.body.rfq_no || null;

      const result = await rfqModel.getAllDraftRfqs(
        limit,
        offset,
        user_id,
        project_id,
        sort,
        reverse_auction,
        rfq_type,
        rfq_no
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
          console.log(error);
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

        const currentDate = new Date();
        let bidEndDate = new Date();
        bidEndDate.setDate(currentDate.getDate() + 30);

        rfqData = {
          company_name: user.organization_name || '',
          response_email: user.email,
          contact_name: user.name,
          contact_number: user.mobile || '',
          comment: req.body.comment || '',
          bid_end_date:
            req.body.bid_end_date || bidEndDate.toISOString().split('T')[0],
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
      if (is_tender === 1) {
        // Tender: strict eligibility (variant + category + hotel)
        vendorsList = await hospitalityModel.getEligibleVendorsForVariant(
          variant_id,
          hotel_ids
        );
      } else {
        // Non-tender: generic vendor discovery
        vendorsList = await rfqModel.genericSearchVendors(
          user_id,
          product.variant_id
        );
      }
      
      // ---------------- Assign vendors in product.vendors or give error ----------------
      if (vendorsList && vendorsList.length > 0) {
                console.log(" vendorsListvendorsList ", vendorsList)
        product.vendors = vendorsList.map((vendor) => ({
          vendor_id: vendor.id || vendor.vendor_id ,
        }));

        console.log(" product.vendorsproduct.vendorsproduct.vendors", product.vendors)

      } else {
        return res.status(400).json({
          status: 2,
          errors: {
            vendors:
              is_tender === 1
                ? "No eligible vendors found for the selected product based on hotel and category subscriptions."
                : "No vendors found for your selected product. Please select a different product.",
          },
        });
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


        console.log("checcking the logs here -------------", globalFilters);
        for (const [key, rawValue] of Object.entries(globalFilters)) {
          if (rawValue === null || rawValue === "" || rawValue?.length === 0) continue;

          const extractor = extractors[key];
          if (!extractor) continue; // skip unknown fields

          const extracted = extractor(rawValue);

          console.log(`Extracted filter - ${key}:`, extracted);

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

      if (
        !product ||
        !product.variant_id ||
        !Array.isArray(product.vendors) ||
        product.vendors.length === 0
      ) {
        return res
          .status(400)
          .json({ status: 2, message: 'Invalid product or vendors data' });
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

      const vendorPromises = product.vendors.map(async (vendor) => {
        const vendorData = {
          rfq_id,
          product_variant_id: product.variant_id,
          user_id: vendor,
          variant: variant
        };
        return await rfqModel.insert('tbl_rfq_product_vendors', vendorData);
      });

      await Promise.all(vendorPromises);

      res.status(200).json({
        status: 1,
        message: 'Product and Vendors added successfully!',
        rfqProductId: addedRfqProduct?.id ?? -1,
        rfq_id
      });
    } catch (error) {
      console.log(error);
      logError('Error while adding Product and Vendors:', error);
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
          console.log('ele--->', ele);
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

      const listRfq = await rfqModel.getRfqByUser(limit, offset, user_id);
      const totalRFQ = await rfqModel.getVendorRfqCount(user_id);

      res
        .status(200)
        .json({
          status: 1,
          data: listRfq,
          totalRFQ
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
  getRfqById: async (req, res, next) => {
    let id = req.params.id;
    // Determine the user ID to check based on the verification status
    const withoutLoginUserToken = !req.is_verified ? req.query.token : null;

    if (withoutLoginUserToken) {
      // Check if the token exists
      const tokenData = await rfqModel.checkIfExists(
        'tbl_vendor_rfq_tokens_non_login',
        `token = '${withoutLoginUserToken}'`
      );

      if (!tokenData || tokenData.length === 0) {
        // Token is not valid
        return res
          .status(400)
          .json({
            status: 0,
            message: 'Invalid or expired token!'
          })
          .end();
      }

      // Retrieve user data associated with the token
      const userData = await rfqModel.checkIfExists(
        'tbl_users',
        `id = ${tokenData[0].vendor_id}`
      );

      if (!userData || userData.length === 0) {
        // User data is not valid
        return res
          .status(404)
          .json({
            status: 0,
            message: 'User not found!'
          })
          .end();
      }
      // Remove password from user data
      const { password, ...userWithoutPassword } = userData[0];
      // Assign the user data to req.user
      req.user = userWithoutPassword;
    }

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
            console.error('Error updating RFQ viewed status:', error);
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

      // Add tender payment status for vendor viewers
      if (rfQItem && rfQItem.is_tender === 1 && rfQItem.tender_fees > 0 && req.user.user_type == 3) {
        const paymentRow = await db.oneOrNone(
          `SELECT payment_status FROM tbl_vendor_payments 
           WHERE vendor_id = $1 AND rfq_id = $2 AND payment_type = 'tender'
           ORDER BY id DESC LIMIT 1`,
          [req.user.id, id]
        );
        rfQItem.has_paid_tender_fees = paymentRow?.payment_status === 'success';
      }

      res
        .status(200)
        .json({
          status: 1,
          data: rfQItem.length > 0 ? rfQItem[0] : rfQItem
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
      console.error('Error fetching target price history:', error);
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
          console.log('ele--->', ele);
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

      let { project_id, sort, reverse_auction, rfq_type, rfq_no, is_tender } = req.body;
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

      const listRfq = await rfqModel.getAllBuyerRfq(
        limit,
        offset,
        user_id,
        project_id,
        sort,
        reverse_auction,
        rfq_type,
        rfq_no,
        is_tender
      );

      let count = await rfqModel.getBuyerRfqCount(
        user_id,
        project_id,
        rfq_type,
        reverse_auction,
        rfq_no,
        is_tender
      );
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

      let { project_id, sort, reverse_auction, rfq_type, rfq_no, is_tender } = req.body;
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
        is_tender
      );

      let count = await rfqModel.getPendingApprovalRfqCount(
        user_id,
        project_id,
        rfq_type,
        reverse_auction,
        rfq_no,
        is_tender
      );
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
    console.log(vendors);
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
      vendorGSTIN
    } = req.body;

    const withoutLoginUserToken = !req.is_verified ? req.query.token : null;

    if (withoutLoginUserToken) {
      // Check if the token exists
      const tokenData = await rfqModel.checkIfExists(
        'tbl_vendor_rfq_tokens_non_login',
        `token = '${withoutLoginUserToken}'`
      );

      if (!tokenData || tokenData.length === 0) {
        // Token is not valid
        return res
          .status(400)
          .json({
            status: 0,
            message: 'Invalid or expired token!'
          })
          .end();
      }

      // Retrieve user data associated with the token
      const userData = await rfqModel.checkIfExists(
        'tbl_users',
        `id = ${tokenData[0].vendor_id}`
      );

      if (!userData || userData.length === 0) {
        // User data is not valid
        return res
          .status(404)
          .json({
            status: 0,
            message: 'User not found!'
          })
          .end();
      }
      // Remove password from user data
      const { password, ...userWithoutPassword } = userData[0];
      // Assign the user data to req.user
      req.user = userWithoutPassword;
    }

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

        // Create end of day date for bid end date (to match frontend logic)
        const bidEndDateEndOfDay = bidEndDate
          ? new Date(
              bidEndDate.getFullYear(),
              bidEndDate.getMonth(),
              bidEndDate.getDate(),
              23,
              59,
              59,
              999
            )
          : null;

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

          // Check if past bid end date
          if (bidEndDateEndOfDay && now > bidEndDateEndOfDay) {
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

          // Check if RFQ has no bid end date
          if (!bidEndDate) {
            return res
              .status(400)
              .json({
                status: 3,
                message: 'RFQ Not Open for Bidding'
              })
              .end();
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

        // Check for open clarification - blocks all vendors from quoting (tenders only)
        if (rfqDetails[0].is_tender === 1) {
          const openClarification =
            await rfqModel.checkActiveClarification(rfq_id);
          if (openClarification) {
            return res.status(400).json({
              status: 3,
              message:
                'Quote submission is blocked. There is an open clarification pending response.',
              data: {
                clarification_id: openClarification.id,
                raised_by_vendor_name: openClarification.raised_by_vendor_name,
                subject: openClarification.subject,
                created_at: openClarification.created_at
              }
            });
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
            payment_id: tenderPaymentId
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
              package_price,
              tax,
              freight_price,
              total_price,
              comment,
              delivery_period,
              quantity,
              variant,
              document_files,
              freight_mode,
              package_mode,
              tax_mode
            }) => {
              if (unit_price != '') {
                quote_items_data.push({
                  rfq_id,
                  rfq_no,
                  product_variant_id: product_id,
                  product_name,
                  unit_price,
                  package_price,
                  tax,
                  freight_price,
                  total_price,
                  comment,
                  delivery_period,
                  quantity,
                  variant,
                  freight_mode,
                  package_mode,
                  tax_mode
                });
              } else if (comment != '' || document_files?.length > 0) {
                quote_items_data.push({
                  rfq_id,
                  rfq_no,
                  product_variant_id: product_id,
                  product_name,
                  unit_price: 0,
                  package_price,
                  tax,
                  freight_price,
                  total_price,
                  comment,
                  delivery_period,
                  quantity,
                  variant,
                  freight_mode,
                  package_mode,
                  tax_mode
                });
              } else if (is_regret) {
                quote_items_data.push({
                  rfq_id,
                  rfq_no,
                  product_variant_id: product_id,
                  product_name,
                  unit_price: 0,
                  package_price,
                  tax,
                  freight_price,
                  total_price,
                  comment,
                  delivery_period,
                  quantity,
                  variant,
                  freight_mode,
                  package_mode,
                  tax_mode
                });
              }
            }
          );

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
                'tax_mode'
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
              'tax_mode'
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
                    `SELECT id, rfq_product_id FROM tbl_negotiation_rounds 
                     WHERE rfq_id = $1 AND rfq_product_id = $2 AND status = 'ACTIVE' 
                     AND end_date > NOW()`,
                    [rfq_id, rfqProductId]
                  );

                  if (activeRound) {
                    // Check if vendor has already submitted a quote for this round
                    const existingNegotiationQuote = await t.oneOrNone(
                      `SELECT id FROM tbl_negotiation_round_quotes 
                       WHERE negotiation_round_id = $1 AND vendor_id = $2`,
                      [activeRound.id, user.id]
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
              console.error('Error saving negotiation round quote:', negotiationError);
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
    const { TA_Vendors, no_freight, rfq_product_id , pageSource } = req.query;
    const { id, company_id } = req.user;

    try {
      let rfQItem = await rfqModel.getQuotesByRfqById2(
        rfq_id,
        id,
        company_id,
        TA_Vendors,
        no_freight,
        rfq_product_id
      );
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
        console.log("Inserted value into quote activity:", insertIntoQuoteActivity);
      } else {
        console.log(`Skipped insert - already exists for rfq_id ${rfq_id} and user ${req.user.id}`);
      }
    } else {
      console.log(`Skipped insert for pageSource: ${pageSource}`);
    }

      res
        .status(200)
        .json({
          status: 1,
          data: rfQItem
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
          console.error('Error inserting data:', error);
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
    const { TA_Vendors, no_freight, rfq_product_id } = req.query;

    const { id, company_id } = req.user;

    try {
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
       const insertIntoQuoteActivity = await rfqModel.insertIntoQuoteActivity({
                                                          rfq_id: rfq_id,
                                                          current_status: "QC",
                                                          created_by: req.user.id
                                                        });

      console.log("Inserted value into quote activity:", insertIntoQuoteActivity);
      res
        .status(200)
        .json({
          status: 1,
          data: rfQItem
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
      const rfQItem = await rfqModel.changeRFQStatus(rfq_id, id);
      const vendorList = await rfqModel.getRfqVendorListAlongWithSPOC(rfq_id);

      sendRFQClosedMail(req.user, rfQItem[0], vendorList);

      res
        .status(200)
        .json({
          status: 1,
          data: rfQItem
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

      const sanitizedVendors = (result.vendors || []).map((vendor) => ({
        user_id: vendor.user_id,
        vendor_name: vendor.vendor_name,
        email: vendor.email,
        remainingProducts: vendor.remainingProducts || []
      }));

      return res
        .status(200)
        .json({
          status: 1,
          data: sanitizedVendors
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
      if (
        !vendor_ids ||
        !Array.isArray(vendor_ids) ||
        vendor_ids.length === 0
      ) {
        return res
          .status(400)
          .json({
            status: 1,
            message: 'Please select at least one vendor!'
          })
          .end();
      }

      const result = await rfqModel.getVendorsForReminder(
        rfq_id,
        vendor_ids,
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
    const { product_variant_id, vendor_id, rfq_id, rfq_no, quote_id, quote_item_id, variant, route_type } =
      req.body;
    
    // Default to PO route for non-hospitality RFQs, route_type for hospitality
    const selectedRoute = route_type || 'PO';

    try {
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
              changed_by: req.user.id
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
            variant
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
          
          // Route-based logic: PO route creates PO draft, ARC route skips PO
          if (selectedRoute === 'PO') {
            // PO Route: Create PO draft
            result = await draftPO({...req.body, quote_id: quote_item_id}, req.user, t);
          }
          
          await sendWinningNotificaion(
            vendorNonLoginRfqAccessToken,
            vendor_id,
            rfQItem,
            winning_product,
            winning_vendor_organization,
            winning_vendor_email,
            winning_vendor_name
          );

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
          const { recordLifecycleEvent } = await import('../models/generalModel.js');
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
                console.log(`ARC approval already exists for product ${rfqProductId}`);
                arcApprovalCreated = true;
              } else {
                // Create ARC approval instance for this product
                const arcApprovalResult = await createApprovalInstance({
                  entity_type: 'ARC',
                  entity_id: rfqProductId, // Product-level, not RFQ-level
                  hospitality_company_id: rfqData.hospitality_company_id,
                  hotel_id: rfqData.hotel_id || null,
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
                    triggered_by: 'product_finalization'
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
              console.error('Error creating ARC approval instance:', arcError);
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
            route_type: selectedRoute
          };
        });
      
      // 👇 Check if an entry already exists 
      //Record the finalization activity with status 'FIN'
      const existingActivity = await rfqModel.checkIfExists(
        'tbl_quote_activity',
        `rfq_id = ${rfq_id} AND current_status = 'FIN' AND created_by = ${req.user.id}`
      );
      console.log("Existing activity check:", existingActivity);
      if (existingActivity.length === 0) {
        const insertIntoQuoteActivity = await rfqModel.insertIntoQuoteActivity({
          rfq_id: rfq_id,
          current_status: "FIN",
          created_by: req.user.id
        });
        console.log("Inserted value into quote activity:", insertIntoQuoteActivity);
      } else {
        console.log(`Skipped insert - already exists for rfq_id ${rfq_id} and user ${req.user.id}`);
      }
    
        return res.status(200).json({
          status: 1,
          message: response.reFinalized
            ? 'Another vendor has been finalized, both vendors has been notified!'
            : 'Vendor has been finalized and notified!',
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

    try {
      // Skip processing for 'all'
      if (search_key === 'all') {
        const productResult = await rfqModel.searchProduct(
          search_key,
          category_id,
          approved_by_id
        );
        const categoryResult = await rfqModel.getCategoryList(search_key);

        return res.status(200).json({
          status: 1,
          data: removeDuplicates(productResult),
          categoryData: categoryResult
        });
      }

      // Parse slug for location filters
      let productSlug = search_key;
      let locationFilters = {};

      if (search_key.includes('-')) {
        const segments = search_key.split('-');

        if (segments.length >= 2) {
          const lastSegment = segments[segments.length - 1];
          const stateResult = await cmsModel.findStateByName(lastSegment);

          if (stateResult) {
            locationFilters.state_id = stateResult.id;
            locationFilters.country_id = stateResult.country_id;

            if (segments.length >= 3) {
              const secondLastSegment = segments[segments.length - 2];
              const cityResult = await cmsModel.findCityByNameAndState(
                stateResult.id,
                secondLastSegment
              );

              if (cityResult) {
                locationFilters.city_id = cityResult.id;
                productSlug = segments.slice(0, -2).join('-');
              } else {
                productSlug = segments.slice(0, -1).join('-');
              }
            } else {
              productSlug = segments.slice(0, -1).join('-');
            }
          } else {
            const cityResult = await cmsModel.findCityByNameAndState(
              null,
              lastSegment
            );

            if (cityResult) {
              locationFilters.city_id = cityResult.id;
              locationFilters.state_id = cityResult.state_id;
              locationFilters.country_id = cityResult.country_id;
              productSlug = segments.slice(0, -1).join('-');
            }
          }
        }
      }

      // // Default to India
      // if (!locationFilters.country_id) {
      //   const indiaResult = await cmsModel.findCountryByName('India');
      //   if (indiaResult) {
      //     locationFilters.country_id = indiaResult.id;
      //   }
      // }

      const productResult = await rfqModel.searchProduct(
        productSlug,
        category_id,
        approved_by_id,
        locationFilters
      );

     
     const categoryResult = await rfqModel.getCategoryList(productSlug);


    // record product search
    try {
      const searchedData = [
        { product_slug: productSlug, user_id: null }
      ];
      await generalModel.insertMany('product_search_record', searchedData);
    } catch (error) {
      console.log('Product search record table not available:', error.message);
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
      const hasSubscription = req.is_verified && req.user?.subscription_plan_id;

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

      if (!req.is_verified) {
        return res.status(200).json({
          status: 1,
          data: result.data.slice(0, 2),
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
          logged_In: false,
          subscription: false
        });
      }

      if (!hasSubscription) {
        return res.status(200).json({
          status: 1,
          data: result.data.slice(0, 1),
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
          logged_In: true,
          subscription: false
        });
      }

      return res.status(200).json({
        status: 1,
        data: result.data,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
        logged_In: true,
        subscription: true
      });

    } catch (error) {
      console.error('Error in bulkSearchVendorsByCategory:', error);
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
        console.error('Error in searchVendorController:', error);
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
                console.error('Error inserting data:', error);
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
                console.error('Error inserting data:', error);
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
            <h2>Products or Vendors Not Found in Workwise Magic Search</h2>
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
            <p><em>This email was automatically generated by WorkWise RFQ processing system.</em></p>
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
            subject: `Workwise Magic Search - Product And Vendor Not Found Error List`,
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
      console.log(error);
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
        console.log("FOUND ALREADY PROCESSING TASK!")

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
    console.log(" SEND_FOLLOWUP_EMAILS  --------------------------------------------------   ", error)
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
          console.log(error);
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
      console.error(`[getDraftRfqSheetWise] Unhandled error:`, error);
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
      console.log(error);
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
      vendorGSTIN
    } = req.body;

    // Determine the user ID to check based on the verification status
    const withoutLoginUserToken = !req.is_verified ? req.query.token : null;

    if (withoutLoginUserToken) {
      // Check if the token exists
      const tokenData = await rfqModel.checkIfExists(
        'tbl_vendor_rfq_tokens_non_login',
        `token = '${withoutLoginUserToken}'`
      );

      if (!tokenData || tokenData.length === 0) {
        // Token is not valid
        return res
          .status(400)
          .json({
            status: 0,
            message: 'Invalid or expired token!'
          })
          .end();
      }

      // Retrieve user data associated with the token
      const userData = await rfqModel.checkIfExists(
        'tbl_users',
        `id = ${tokenData[0].vendor_id}`
      );

      if (!userData || userData.length === 0) {
        // User data is not valid
        return res
          .status(404)
          .json({
            status: 0,
            message: 'User not found!'
          })
          .end();
      }
      // Remove password from user data
      const { password, ...userWithoutPassword } = userData[0];
      // Assign the user data to req.user
      req.user = userWithoutPassword;
    }

    const user = req.user;

    // Check if all required fields are present in each product
    if (!products.every((product) => product.product_id)) {
      return res.status(400).json({
        message: 'Missing required fields in product items.',
        data: products
      });
    }

    try {
      // Check if the quote exists
      const quoteExists = await rfqModel.checkIfExists(
        'tbl_quotes',
        `id = '${quoteId}'`
      );
      if (!quoteExists) {
        return res.status(404).json({ message: 'Quote not found.' });
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

      // Create end of day date for bid end date (to match frontend logic)
      const bidEndDateEndOfDay = bidEndDate
        ? new Date(
            bidEndDate.getFullYear(),
            bidEndDate.getMonth(),
            bidEndDate.getDate(),
            23,
            59,
            59,
            999
          )
        : null;

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

        // Check if past bid end date
        if (bidEndDateEndOfDay && now > bidEndDateEndOfDay) {
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

        // Check if RFQ has no bid end date
        if (!bidEndDate) {
          return res.status(400).json({
            status: 3,
            message: 'RFQ Not Open for Bidding'
          });
        }
      }

      // Check for open clarification - blocks all vendors from quoting (tenders only)
      if (rfqDetails[0].is_tender === 1) {
        const openClarification = await rfqModel.checkActiveClarification(
          quoteExists[0].rfq_id
        );
        if (openClarification) {
          return res.status(400).json({
            status: 3,
            message:
              'Quote update is blocked. There is an open clarification pending response.',
            data: {
              clarification_id: openClarification.id,
              raised_by_vendor_name: openClarification.raised_by_vendor_name,
              subject: openClarification.subject,
              created_at: openClarification.created_at
            }
          });
        }
      }

      let paymentTermAndCommentChanges = false;

      // update global comment and payment term
      if (
        globalPaymentTerms !== quoteExists[0].global_payment_term ||
        globalComment !== quoteExists[0].global_comment
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
          global_comment: globalComment
        };
        await rfqModel.update('tbl_quotes', tbl_quotes_data, quoteId);

        paymentTermAndCommentChanges = true;
      }

      // Process each product in the request
      const quoteItemChanges = await Promise.all(
        products
          .map((product) => {
            console.log('UPDATING: ', product);
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

      console.log('QUOTE ITEM CHANGES: ', quoteItemChanges);

      // Check if global terms & conditions file are uploaded
      if (term_and_condition_files && term_and_condition_files.length > 0) {
        const global_files = term_and_condition_files.map((url) => ({
          quote_id: quoteId,
          file_type: 'term_and_condition',
          file_url: url
        }));
        for (const fileData of global_files) {
          await rfqModel.insert('tbl_quotes_files', fileData);
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
              `SELECT id, rfq_product_id FROM tbl_negotiation_rounds 
               WHERE rfq_id = $1 AND rfq_product_id = $2 AND status = 'ACTIVE' 
               AND end_date > NOW()`,
              [rfq_id, rfqProductId]
            );

            if (activeRound) {
              // Check if vendor has already submitted a quote for this round
              const existingNegotiationQuote = await db.oneOrNone(
                `SELECT id FROM tbl_negotiation_round_quotes 
                 WHERE negotiation_round_id = $1 AND vendor_id = $2`,
                [activeRound.id, user.id]
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
        console.error('Error saving negotiation round quote during update:', negotiationError);
      }

      let status = true;
      if (!anyQuoteChanged && !paymentTermAndCommentChanges) {
        status = false;
      }

      if (status) {
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
      console.error('Failed to update quote items:', error);
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

    if (!req.user.subscription_plan_id) {
      res
        .status(400)
        .json({
          status: 3,
          message: 'You need to purchase subscription to create RFQ'
        })
        .end();
      return;
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
            : `Buyer Query for #${rfqNumber} – Your Response Needed`;

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

        sendMail(mailRecipients);

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
      console.log("Existing activity check:", existingActivity);
      if (existingActivity.length === 0) {
        const insertIntoQuoteActivity = await rfqModel.insertIntoQuoteActivity({
          rfq_id: rfq_id,
          current_status: "NEG",
          created_by: req.user.id
        });
        console.log("Inserted value into quote activity:", insertIntoQuoteActivity);
      } else {
        console.log(`Skipped insert - already exists for rfq_id ${rfq_id} and user ${req.user.id}`);
      }
    

      res.json({
        status: 1,
        message: 'Target price(s) set successfully',
        data: result
      });
    } catch (error) {
      console.error('Error setting target price:', error);
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

      res.status(200).json(result).end();
    } catch (error) {
      // console.log("controller error")
      console.error('Error in addClause:', error);
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
      console.log("Existing activity check:", existingActivity);
      if (existingActivity.length === 0) {
        const insertIntoQuoteActivity = await rfqModel.insertIntoQuoteActivity({
          rfq_id: rfq_id,
          current_status: "TE",
          created_by: req.user.id
        });
        console.log("Inserted value into quote activity:", insertIntoQuoteActivity);
      } else {
        console.log(`Skipped insert - already exists for rfq_id ${rfq_id} and user ${req.user.id}`);
      }
    } else {
      console.log(`Skipped insert for pageSource: ${pageSource}`);
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



      const withoutLoginUserToken = !req.is_verified ? req.query.token : null;

      

    if (withoutLoginUserToken) {
      // Check if the token exists
      const tokenData = await rfqModel.checkIfExists(
        'tbl_vendor_rfq_tokens_non_login',
        `token = '${withoutLoginUserToken}'`
      );
     
      if (!tokenData || tokenData.length === 0) {
        // Token is not valid
        return res
          .status(400)
          .json({
            status: 0,
            message: 'Invalid or expired token!'
          })
          .end();
      }

      // Retrieve user data associated with the token
      const userData = await rfqModel.checkIfExists(
        'tbl_users',
        `id = ${tokenData[0].vendor_id}`
      );
      
      if (!userData || userData.length === 0) {
        // User data is not valid
        return res
          .status(404)
          .json({
            status: 0,
            message: 'User not found!'
          })
          .end();
      }
      // Remove password from user data
      const { password, ...userWithoutPassword } = userData[0];
      // Assign the user data to req.user
      req.user = userWithoutPassword;
      
    }


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
      



       const withoutLoginUserToken = !req.is_verified ? req.query.token : null;

    if (withoutLoginUserToken) {
      // Check if the token exists
      const tokenData = await rfqModel.checkIfExists(
        'tbl_vendor_rfq_tokens_non_login',
        `token = '${withoutLoginUserToken}'`
      );

      if (!tokenData || tokenData.length === 0) {
        // Token is not valid
        return res
          .status(400)
          .json({
            status: 0,
            message: 'Invalid or expired token!'
          })
          .end();
      }

      // Retrieve user data associated with the token
      const userData = await rfqModel.checkIfExists(
        'tbl_users',
        `id = ${tokenData[0].vendor_id}`
      );

      if (!userData || userData.length === 0) {
        // User data is not valid
        return res
          .status(404)
          .json({
            status: 0,
            message: 'User not found!'
          })
          .end();
      }
      // Remove password from user data
      const { password, ...userWithoutPassword } = userData[0];
      // Assign the user data to req.user
      req.user = userWithoutPassword;
    }

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
        console.error('Failed to parse Gemini response:', parseError);
        throw new Error('Invalid response format from AI service');
      }

      res.status(200).json({
        status: 1,
        data: parsedResult
      });
    } catch (error) {
      console.error('Error in getSummarisedDeviation API:', error.message);
      res.status(500).json({
        status: 0,
        message: 'Error processing deviation summary',
        error:
          process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  },

  addVendorResponse: async (req, res) => {
    try {
      const data = req.body;
      // console.log("API Input: ", req.body);

      // Validate input
      if (!data) {
        return res.status(400).json({
          status: 0,
          message: 'Invalid input. Please provide vendor responses'
        });
      }

      const response = await rfqModel.addVendorResponse(data);

      res.status(200).json(response).end();
    } catch (error) {
      console.error('Error in addVendorResponse API: ', error.message);
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
      console.error('Error in addVendorResponse API: ', error.message);
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
      console.error('Error in addVendorResponse API: ', error.message);
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
      console.error('Error in addVendorResponse API: ', error.message);
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
      console.error('Error in addVendorResponse API: ', error.message);
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
   * API endpoint to submit a technical evaluation for approval at the product level.
   * Creates an approval instance for the TECHNICAL entity type with rfq_product_id as entity_id.
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
        // Start approval for the technical evaluation at product level
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

        // Record lifecycle event
        await recordLifecycleEvent({
          entity_type: 'TECHNICAL',
          entity_id: rfq_product_id,
          stage: 'SUBMITTED',
          action: 'SUBMIT',
          performed_by: userId,
          metadata: {
            approval_instance_id: approvalResult.instance?.id,
            rfq_id: rfq_id,
            rfq_product_id: rfq_product_id
          },
          txContext: t
        });

        return {
          success: true,
          approval_instance_id: approvalResult.instance?.id,
          status: approvalResult.instance?.status,
          total_steps: approvalResult.totalSteps,
          auto_approved: approvalResult.autoApproved || false
        };
      });

      if (!result.success) {
        return res.status(400).json({
          status: 0,
          message: result.message
        });
      }

      return res.status(200).json({
        status: 1,
        message: result.auto_approved
          ? 'Technical evaluation auto-approved (creator is only approver)'
          : 'Technical evaluation submitted for approval',
        data: {
          approval_instance_id: result.approval_instance_id,
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
      console.log(error);
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
      console.error('Error fetching project report:', error);
      res.status(500).json({
        success: false,
        message: 'Error processing RFQ details',
        error: error.toString()
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
      console.error('Error fetching project report:', error);
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
        page = 1,
        limit = 10,
        project_id,
        rfq_no,
        sort = 'DESC',
        is_tender
      } = req.query;

      // Convert string query parameters to proper types
      tech_eval = tech_eval === 'true';
      po = po === 'true';

      page = parseInt(page) || 1;
      limit = parseInt(limit) || 10;
      project_id = project_id ? parseInt(project_id) : null;
      rfq_no = rfq_no ? parseInt(rfq_no) : null;
      is_tender = is_tender !== undefined && is_tender !== null ? (is_tender === 'true' || is_tender === true || is_tender === '1' || is_tender === 1) : null;

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
        is_tender
      );

      res.status(200).json({
        status: 1,
        data: rfqs,
        total_items: rfqs.length
      });
    } catch (error) {
      console.error('Error in getRfqs:', error);
      res.status(500).json({
        status: 0,
        message: 'Error fetching sidebar RFQs',
        error: error.message
      });
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
      console.error('Error in saveExcel:', error);
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
   * Vendor raises a clarification for a tender
   * POST /rfq/clarification/raise
   */
  raiseClarification: async (req, res) => {
    try {
      const { rfq_id, subject, question } = req.body;
      const files = req.files || [];
      const user = req.user;

      // Fetch RFQ details
      const rfq = await db.oneOrNone(
        `SELECT id, is_tender, tender_publish_date, vendor_clarification_date, created_by, rfq_no
         FROM tbl_rfq WHERE id = $1`,
        [rfq_id]
      );

      if (!rfq) {
        return res.status(400).json({
          status: 0,
          message: 'RFQ not found'
        });
      }

      // Only allow clarifications for tenders
      if (rfq.is_tender !== 1) {
        return res.status(400).json({
          status: 0,
          message: 'Clarifications are only allowed for tenders'
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

      if (publishDate && now < publishDate) {
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

      // Format response
      const responseData = {
        id: clarification.id,
        rfq_id: clarification.rfq_id,
        raised_by_vendor_id: clarification.raised_by,
        raised_by_vendor_name: vendorName?.name || null,
        subject: clarification.subject,
        question: clarification.question,
        question_files: clarification.question_files.map((f) => ({
          file_url: f.file_url,
          file_name: f.file_name
        })),
        response: null,
        response_files: null,
        responded_by: null,
        status: clarification.status,
        created_at: clarification.created_at,
        responded_at: null,
        closed_at: null
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
   * Buyer responds to and closes a clarification
   * POST /rfq/clarification/resolve
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
          message: 'Only the tender creator can respond to clarifications'
        });
      }

      // Resolve clarification with response files
      const resolved = await rfqModel.resolveClarification(
        clarification_id,
        user.id,
        response,
        response_files
      );

      if (!resolved) {
        return res.status(400).json({
          status: 0,
          message: 'Failed to close clarification'
        });
      }

      // Format response
      const responseData = {
        id: resolved.id,
        rfq_id: resolved.rfq_id,
        raised_by_vendor_id: resolved.raised_by,
        raised_by_vendor_name: clarification.raised_by_vendor_name,
        subject: resolved.subject,
        question: resolved.question,
        question_files: [], // Would need separate query to get these
        response: resolved.response,
        response_files: resolved.response_files.map((f) => ({
          file_url: f.file_url,
          file_name: f.file_name
        })),
        responded_by: resolved.responded_by,
        status: resolved.status,
        created_at: resolved.created_at,
        responded_at: resolved.responded_at,
        closed_at: resolved.closed_at
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
   * List clarifications for an RFQ (private - vendor sees only their own)
   * GET /rfq/clarifications/:rfq_id
   *
   * Privacy rules:
   * - Buyer (tender creator): sees ALL clarifications
   * - Vendor who raised clarification: sees their OWN clarifications
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

      if (rfq.is_tender !== 1) {
        return res.status(400).json({
          status: 0,
          message: 'Clarifications are only available for tenders'
        });
      }

      // Check if current user is the buyer (tender creator)
      const isBuyer = currentUserId && rfq.created_by === currentUserId;

      // Get all clarifications
      const allClarifications = await rfqModel.getClarifications(rfq_id);

      // Find open clarification if any
      const openClarification = allClarifications.find(
        (c) => c.status === 'OPEN'
      );

      // Determine if current user owns the open clarification
      const isOwnOpenClarification = openClarification &&
        currentUserId &&
        openClarification.raised_by_vendor_id === currentUserId;

      // Buyer sees all clarifications
      if (isBuyer) {
        return res.status(200).json({
          status: 1,
          data: {
            clarifications: allClarifications,
            open_clarification: openClarification || null,
            has_open: !!openClarification,
            is_own_clarification: false, // Not applicable for buyer
            is_buyer: true
          }
        });
      }

      // Vendor: filter to only their own clarifications
      const ownClarifications = currentUserId
        ? allClarifications.filter(c => c.raised_by_vendor_id === currentUserId)
        : [];

      return res.status(200).json({
        status: 1,
        data: {
          clarifications: ownClarifications,
          open_clarification: isOwnOpenClarification ? openClarification : null,
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
   * Check if there's an open clarification for an RFQ (private visibility)
   * GET /rfq/clarification/active/:rfq_id
   *
   * Privacy rules:
   * - Buyer (tender creator): sees full clarification details
   * - Vendor who raised clarification: sees full details
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

      const openClarification =
        await rfqModel.checkActiveClarification(rfq_id);

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

      // Buyer or owner sees full details
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
  }
};
export default rfqController;
