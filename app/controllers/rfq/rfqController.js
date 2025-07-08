import Config from '../../config/app.config.js';
import {
  logError,
  sendMail,
  getDateRange,
  withTransaction,
  validateNumber
} from '../../helper/common.js';
import rfqModel from '../../models/rfqModel.js';
import userModel from '../../models/userModel.js';
import { sendNotification } from '../../services/notificationService.js';
import excelJS from 'exceljs';
import xlsx from 'xlsx';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import vendorModel from '../../models/vendorModel.js';
import projectModel from '../../models/projectModel.js';
import whatsappNotificationFluxChat from '../../helper/whatsappNotificationFluxChat.js';
import { generateEmailTemplate, getRfqEmailContent, RFQ_EMAIL_TYPE } from '../../helper/notificationEmailLayout.js';
import fs from 'fs';
import productModel from '../../models/productModel.js';
import generativeAI from '../../helper/processBOQWithAI.js';
import db from '../../config/dbConn.js';
import { raSchedulerForBuyer, raSchedulerForVendor  } from '../../helper/sendEmailFunctions/raEmailScheduler.js';
import generalModel from '../../models/generalModel.js';



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
  'productMakes'
];


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

const removeSpecsDynamically = (data) => {
  // modified my mukul on 23-AUG
  // No longer use of this function

  const groupedData = data.reduce((acc, item) => {
    acc[item.product_id] = acc[item.product_id] || [];
    acc[item.product_id].push(item);
    return acc;
  }, {});

  Object.keys(groupedData).forEach((product_id) => {
    const items = groupedData[product_id];
    items.forEach((item, idx) => {
      const totalSets = Math.floor(item.product_specs.length / 4);
      const setToKeep = totalSets - idx;

      if (setToKeep > 0 && setToKeep <= totalSets) {
        const start = (setToKeep - 1) * 4;
        item.product_specs = item.product_specs.slice(start, start + 4);
      } else if (setToKeep <= 0) {
        item.product_specs = [];
      }
      // If setToKeep > totalSets, keep all specs
    });
  });

  return data;
};

function filterQuotations(data) {
  // Group by product_id
  const grouped = data.reduce((acc, item, index) => {
    if (!acc[item.product_id]) {
      acc[item.product_id] = [];
    }
    acc[item.product_id].push({ index, item });
    return acc;
  }, {});

  // Filter quotations
  const filteredData = Object.values(grouped).flatMap((group) =>
    group.map((entry, i) => {
      const newItem = { ...entry.item };
      if (i < newItem.quotations.length) {
        newItem.quotations = [newItem.quotations[i]];
      } else {
        newItem.quotations = [];
      }
      return { index: entry.index, item: newItem };
    })
  );

  // Sort by original index and return only the items
  return filteredData
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.item);
}



function processQuotations(data) {
  const grouped = data.reduce((acc, item) => {
    if (!acc[item.product_id]) {
      acc[item.product_id] = [];
    }
    acc[item.product_id].push(item);
    return acc;
  }, {});

  Object.values(grouped).forEach((items) => {
    items.forEach((item, idx) => {
      if (items.length > 1) {
        item.quotations = item.quotations.filter(
          (_, i) => i % items.length === idx
        );
      }
    });
  });

  return data.flat();
}

function processQuotCompare(data) {
  const grouped = data.reduce((acc, item) => {
    if (!acc[item.product_id]) {
      acc[item.product_id] = [];
    }
    acc[item.product_id].push(item);
    return acc;
  }, {});

  Object.values(grouped).forEach((items) => {
    items.forEach((item, idx) => {
      if (items.length > 1) {
        item.quotations = item.quotations.filter(
          (_, i) => i % items.length === idx
        );
        // Keep only the quote_details at the index corresponding to the product's index
        item.quotations.forEach((quotation) => {
          quotation.quote_details = [quotation.quote_details[idx]];
        });
      }
    });
  });

  return data;
}

const saveMagicSearchInDraft = async (data, createdBy, processedUrl, rfqId, sheetId) => {
  try {

   
    const nextRfqNumber = await getNextRfQNumber()
    return await rfqModel.saveMagicSearchInDraft(data, nextRfqNumber, createdBy, processedUrl, rfqId, sheetId);
  } catch (error) {
    throw error
  }
}

const insertProduct = async (
  {
    product_id,
    variant,
    comment,
    datasheet,
    spec_file,
    qap_file,
    spec,
    vendors,
    datasheet_file,
    qap
  },
  created_rfq_id,
  sheet_id,
) => {
  try {
    let tbl_rfq_products_data = {
      product_variant_id: product_id,
      variant,
      comment,
      datasheet: datasheet || '', // Changes by Agnij 2025-06-18 [Fixed not-null constraint violation]
      spec_file:'',// this field we have to remove from database
      qap_file:'',// this field we have to remove from database
      rfq_id: created_rfq_id,
      datasheet_file:"",// this field we have to remove from database
      qap: qap || '', // Also ensuring qap is not null
      sheet_id,
    };
    
    let spec_array = spec?.map((item) => {
      item.rfq_id = created_rfq_id;
      item.product_variant_id = product_id;
      item.variant = variant;
      item.sheet_id = sheet_id;
      return item;
    });
    const spec_keys = ['title', 'value', 'rfq_id', 'product_variant_id', 'variant', 'sheet_id'];

    const vendor_keys = ['user_id', 'rfq_id', 'product_variant_id', 'variant', 'sheet_id'];
    var vendor_array = [];
    // Changes by Agnij 2025-06-18 [Added null check for vendors]
    if (vendors && vendors.length > 0) {
      vendor_array = vendors.map((item) => {
        // Changes by Agnij 2025-06-18 [Fixed missing user_id property]
        // Check if vendor has user_id property, if not try to get it from id
        if (!item.user_id && item.id) {
          item.user_id = item.id;
        }
        
        item.rfq_id = created_rfq_id;
        item.product_variant_id = product_id;
        item.variant = variant;
        item.sheet_id = sheet_id;
        return item;
      });
      
      // Filter out any vendors that still don't have user_id
      vendor_array = vendor_array.filter(item => item.user_id);
    }

    const productResult = await rfqModel.insert(
      'tbl_rfq_products',
      tbl_rfq_products_data
    );

    const spec_info = spec_array && await rfqModel.insertArray(
      spec_array,
      spec_keys,
      'tbl_rfq_products_specs'
    );

    var vendor_info = [];
    // Changes by Agnij 2025-06-18 [Added null check for vendors and vendor_array]
    if (vendors && vendors.length > 0 && vendor_array.length > 0) {
      vendor_info = await rfqModel.insertArray(
        vendor_array,
        vendor_keys,
        'tbl_rfq_product_vendors'
      );
    }

    // Handle multiple datasheet files
    if (datasheet_file && datasheet_file.length > 0) {
      const fileDataArray = datasheet_file.map(url => ({
        rfq_product_id:productResult[0].id,
        file_type: 'TDS',
        file_url: url
      }));
      for (const fileData of fileDataArray) {
        await rfqModel.insert('tbl_rfq_product_files', fileData);
      }
    }

    if (qap_file && qap_file.length > 0) {
      const qapFiles = qap_file.map(url => ({
        rfq_product_id:productResult[0].id,
        file_type: 'QAP',
        file_url: url
      }));
      for (const fileData of qapFiles) {
        await rfqModel.insert('tbl_rfq_product_files', fileData);
      }
    }

    if (spec_file && spec_file.length > 0) {
      const specFiles = spec_file.map(url => ({
        rfq_product_id:productResult[0].id,
        file_type: 'SPEC',
        file_url: url
      }));
      for (const fileData of specFiles) {
        await rfqModel.insert('tbl_rfq_product_files', fileData);
      }
    }

    return { product_info: productResult[0], spec_info, vendor_info };
  } catch (error) {
    console.error('Error inserting data:', error);
    throw error;
  }
};

const updateRfqProductIdInTechEvaluation = async (oldProductId, newProductId) => {
  try {

    const records = await rfqModel.getTechEvaluationRecordsByProductId(oldProductId);

    if (records.length > 0) {
      await Promise.all(
        records.map((record) =>
          rfqModel.update(
            'tbl_rfq_product_tech_evaluation',
            { tbl_rfq_product_id: newProductId },
            record.id
          )
        )
      );
    }

  } catch (error) {
    console.error('Error updating RFQ Product IDs:', error.message);
    throw error;
  }
};

const getQUOTES = async ({ id }, user_id) => {
  console.log('RFQ ID', id);
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
        style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
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

/**
 * 
 * @param {*} vendor 
 * @param {*} user 
 * @param {*} rfqNumber 
 * @param {*} products - array 
 * @last_update by mukul on 2023-11-01, for company wise email template
 */
const sendMailEachVendor = async (vendor, user, rfqNumber, products) => {
  try {
    let organization_name = user?.organization_name || user?.name;
    const buyerUserId = user?.id || null // 
    const buyerEmail = user?.email || ""

    // Fetch user details of the vendor
    const user_details = await userModel.user_profile_detail(vendor.user_id);

    const spocList = await vendorModel.getSpocDetails(vendor.user_id)

    // console.log(" rfq contoller spoc console ", vendor.user_id, spocList)


    if (user_details.length > 0) {
      // Insert token into the table and get the token value
      const token = await rfqModel.insertVendorRfqToken(user_details[0].id, rfqNumber);

      // Construct dynamic HTML for products list
      let productHTML = products.slice(0, 3).map((product) => {
        const quantitySpec = product.spec.find(specItem => specItem.title === 'Quantity');
        return `
            <tr>
              <td style="font-size: 15px; padding-bottom: 3px;">${product.name}</td>
              <td style="font-size: 15px; text-align: right; padding-bottom: 3px;">${quantitySpec.value || '--'}</td>
            </tr>
          `;
      })
        .join('');

      if (products.length > 3) {
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

      const headerContent = ` <div>
        <h2>Hello ${user_details[0].name}</h2>
        <p style="font-size:16px;"> Great news! You've received a new enquiry from ${organization_name} </p>
        </div>`

      // Construct the email content with the list of products
      const containerContent = `   <div>
      <h3 style="font-family: 'Roboto', sans-serif; text-align: center; font-size: 24px; margin-bottom: 8px;">
        Enquiry Details
      </h3>

          <table style="width: 100%; padding: 8px;">
            <tbody>
            ${productHTML}
            <tr>
            <td></td>
          </tr>
            </tbody>
          </table>

            <a href=${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfqNumber}&token=${token}
        style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
        Submit Your Quote Now
      </a>

      <p style="margin-top:20px" >
               Submit your quote promptly to access this opportunity with ${organization_name} and stand out as a preferred vendor.
      </p>

        </div>`;

      const dynamicHTML = generateEmailTemplate(headerContent, containerContent, buyerUserId)

        const org_name = user_details[0].organization_name || user_details[0].name || ""
       let mailRecipients = {
        from: `${organization_name} ${Config.masterEmail}`,
        subject: `New RFQ Opportunity from ${organization_name}`,
        html: dynamicHTML
      };

      if (spocList && spocList.length > 0) {
        mailRecipients.to = spocList.map(spoc => spoc.email);
        mailRecipients.cc = [user_details[0].email, buyerEmail];
      } else {
        mailRecipients.to = user_details[0].email;
        mailRecipients.cc = buyerEmail
      }

      // console.log(" rfq contoller 377 spoc console ", user_details[0]?.id, spocList)

            // Construct an array of product descriptions
            const productDescriptions = products.map((product) => {
              const quantitySpec = product.spec.find(specItem => specItem.title === 'Quantity');
              return `${product.name} - ${quantitySpec.value || '--'} ${product.unit || ''}`.trim();
            }).join(', ');
      sendMail(mailRecipients);

      // here we have to implement await Promise.allSettled(promises); for better perfomance
      spocList.map( async (spoc) =>  {

        if(spoc?.mobile){
      const payloadForWhatsApp = {
        mobile: spoc.mobile, // Assuming `mobile` is a property on the `vendor` object
        vendorName: user_details[0]?.organization_name || user_details[0]?.name || "" ,
        buyerName: organization_name ,
        rfq_id: rfqNumber,
        token: token,
        productDetails: productDescriptions // Joining all product details into a single string for message
      };
      
      await whatsappNotificationFluxChat.vendorReceivesRFQNotification(payloadForWhatsApp);
      }
      });

            // Here, productDescriptions will be an array of strings like ["Product1 - 10 Units", "Product2 - 5 Units"]
       const payloadForWhatsApp = {
         mobile: user_details[0]?.mobile, // Assuming `mobile` is a property on the `vendor` object
         vendorName: user_details[0]?.organization_name || user_details[0]?.name || "" ,
         buyerName: organization_name ,
         rfq_id: rfqNumber,
         token: token,
         productDetails: productDescriptions // Joining all product details into a single string for message
       };

       await whatsappNotificationFluxChat.vendorReceivesRFQNotification(payloadForWhatsApp);

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
            user_type: user_details[0].user_type
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

// Update the sendMailtoVendors function
const sendMailtoVendors = async (req, rfqNumber) => {
  try {
    const {reverse_auction} = req.body;
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
        await sendMailEachVendor(vendorInfo.vendorDetails, req.user, rfqNumber, vendorInfo.products);
      
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
    const spocList = await vendorModel.getSpocDetails(id);

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
        style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
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
  const spocList = await vendorModel.getSpocDetails(user.id)

  // Extract vendor details from user object
  const vendorName = user.organization_name || user?.name;

  // Email content
  const headerContent = `<h2>Hello ${vendorName || ''},</h2>`;

  const containerContent = `<div style="font-size: 15px; font-family: 'Roboto', sans-serif;">
      <p style="padding-bottom: 3px;">
                   Your updated quotation for #${rfq_no} has been successfully shared with ${buyerDetails[0]?.organization_name}. This update keeps you competitive and responsive to buyer requirements.      </p>
                   </p>

      <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${token[0]?.token || ""}"
         style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; 
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
    to: buyerDetails[0]?.email,
    // cc:"mukul@letsworkwise.com",
    subject: `Work Wise | New Quotation Received for Your RFQ`,
    html: dynamicHTML
  };

  if (spocList && spocList.length > 0) {
    mailRecipients.to = spocList.map(spoc => spoc.email);
    mailRecipients.cc = user.email;
  } else {
    mailRecipients.to = user.email;
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
    
      await whatsappNotificationFluxChat.sendQuoteSubmissionNotification(whatsappPayload)
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
    await whatsappNotificationFluxChat.sendQuoteSubmissionNotification(whatsappPayload)
  
  

};


const sendRevisedQuotationEmailToBuyer = async (buyerDetails, quoteItemChanges, user, rfq_id, rfq_no) => {
  

  // Extract vendor details from user object
  const vendorName = user.organization_name || user?.name;

// Extract unique product names safely
const productList = [...new Set(
  quoteItemChanges
    .filter(item => item.quote && item.quote.product_name)  // Ensure 'quote' and 'product_name' exist
    .map(item => item.quote.product_name)
)];

// Format the product list
const formattedProducts = productList.length > 0 
  ? productList.slice(0, 2).join(', ') + (productList.length > 2 ? ', and more' : '') 
  : '[Product 1], [Product 2], and more';
  

  // Email content
  const headerContent = `<h2>Hello ${buyerDetails[0]?.organization_name || ''},</h2>`;

  const containerContent = `<div style="font-size: 15px; font-family: 'Roboto', sans-serif;">
      <p style="padding-bottom: 3px;">
        You've received a new quotation! Check out the details below:
      </p>

      <p><strong>RFQ:</strong> #${rfq_no}</p>
      <p><strong>Vendor:</strong> ${vendorName}</p>
      <p><strong>Products:</strong> ${formattedProducts}</p>

      <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${rfq_id}"
         style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; 
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
    buyerName:buyerDetails[0]?.name
  }

  await whatsappNotificationFluxChat.sendNewQuoteNotificationToBuyer(payload);

};


const sendQuoteNotificationToVendor = async (req) => {
  // send mail to vendors
  const {rfq_id, rfq_no} = req.body
  const { name, email, id, organization_name, mobile } = req.user;
  const token = await rfqModel.getVendorRfqToken(id, rfq_id);
  const BuyerDetails = await rfqModel.getRFQCreatedBy(rfq_id) 
  
  const headerContent = `<h2>Hello ${organization_name || name},</h2>`;

  const containerContent = ` 
  <div style="font-size:16px; font-family: 'Roboto', sans-serif;">
    <p>
      ${req.body.is_regret && req.body.is_regret == 1
        ? 'Your regret concern has been sent to the buyer.'
        : `<div>
            <p>Thank you for submitting your quotation for <strong>#${rfq_no}</strong>. 
               We've shared it with <strong>${BuyerDetails[0]?.organization_name || ''}</strong>, who will review it and get back to you soon.</p>
              <p><strong>Next Steps:</strong> Keep an eye out for any buyer queries or updates, 
               and be ready to discuss terms to secure the order.</p>

            <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${token[0].token}" 
               style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
               View RFQ Status
            </a>
          </div>`}
    </p>
  </div>`;
  
    const dynamicHTML = generateEmailTemplate(headerContent, containerContent)

  const spocList = await vendorModel.getSpocDetails(id)

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
  spocList.map(async (spoc) => {
    if (spoc.mobile) {
    const whatsappPayload ={
      mobile:spoc.mobile,
      token:token[0].token,
      rfq_id:rfq_id,
      message:message,
      name:organization_name || name
    }
  
    await whatsappNotificationFluxChat.sendQuoteSubmissionNotification(whatsappPayload)
  }
  })

  // send message to vendor
  const whatsappPayload ={
    mobile:mobile,
    token:token[0].token,
    rfq_id:rfq_id,
    message:message,
    name:organization_name || name
  }  
  await whatsappNotificationFluxChat.sendQuoteSubmissionNotification(whatsappPayload)

};


const sendReminderRFQMAIL = async (vendoritem, remainingProducts, org_name,rfq_id, rfqBasicDetails) => {
  let user_details = await userModel.user_profile_detail(vendoritem.user_id);
  const token = await rfqModel.getVendorRfqToken(vendoritem.user_id, rfq_id);
  const vendorName =  user_details[0].organization_name || user_details[0].name
  if (user_details.length > 0) {

    const headerContent = `<h2>Hello ${vendorName},</h2>`;

const containerContent = ` 
       <div style="font-size:16px; font-family: 'Roboto', sans-serif;">
         <p>
           This is a friendly reminder from <strong>${org_name}</strong> regarding the RFQ quotation. Ensure your quote is submitted on time to secure this opportunity.
         </p>
         <p>
           Please submit quote for the following product variant(s):
         </p>
         <p>
           ${remainingProducts.map(product => (
            `<strong>${product.name}</strong><br>`
           ))}
         </p>
       
         <p> <strong> Deadline: </strong> ${rfqBasicDetails?.bid_end_date || 'N/A'} </p>
       
         <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${token[0].token}"
            style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
           Submit Your Quote Now
         </a>
       
         <p style="margin-top:20px; font-weight:bold; text-align:center">   Don't miss out on this opportunity!
         </p>
       </div>`;

  // console.log(containerContent)
  
  const dynamicHTML = generateEmailTemplate(headerContent, containerContent, rfqBasicDetails.created_by)

    const spocList = await vendorModel.getSpocDetails(user_details[0]?.id)

    
    let mailRecipients = {
      from:  `${org_name} ${Config.masterEmail}`,
      subject: `Work Wise | Reminder for Quotation | Action Required`, // Subject line
      html: dynamicHTML
    };
    if (spocList && spocList.length > 0) {
      mailRecipients.to = spocList.map(spoc => spoc.email);
      mailRecipients.cc = [user_details[0].email, rfqBasicDetails.response_email];
    } else {
      mailRecipients.to = user_details[0].email;
      mailRecipients.cc = rfqBasicDetails.response_email
    }
    sendMail(mailRecipients);

    spocList.map( async (spoc) =>{
      if (spoc.mobile) {  // Check if the mobile number is not null or undefined
        const whatsappPayloadSPOC = {
          mobile: spoc.mobile,
          token: token[0].token,
          rfq_id: rfq_id,
          rfq_no: rfqBasicDetails?.rfq_no,
          buyerName: org_name,
          name: vendorName
        };
    
        await whatsappNotificationFluxChat.sendQuoteReminderNotificationToVendor(whatsappPayloadSPOC);
      }
    });
    
    const whatsappPayloadForVendor= {
      mobile:user_details[0].mobile,
      token:token[0].token,
      rfq_id: rfq_id,
      rfq_no:rfqBasicDetails?.rfq_no,
      buyerName:org_name,
      name:vendorName
    }

    await whatsappNotificationFluxChat.sendQuoteReminderNotificationToVendor(whatsappPayloadForVendor)

    const notificationData = {
      type: 'RFQ Pending',
      title: `RFQ Pending`,
      message: `RFQ Response Pending`,
      additional_data: {
        user_type: user_details[0].user_type
      }
    };
    const payload = {
      title: `Hello ${user_details[0].name}`,
      body: `RFQ Response Pending `
    };
    const ss = JSON.parse(user_details[0].endpoint);
    sendNotification(user_details[0].id, '', notificationData, payload, ss);
  }
};


const sendQuoteNotificationEmail = async (req) => {
  let { name,  organization_name } = req.user;
  let { rfq_id, rfq_no, products } = req.body;

    let u = await rfqModel.getRFQCreatedBy(rfq_id);
    if (u.length > 0) {
      let buyer = u[0];

      // Prepare product list with inline logic
      let productNames = products.map(item => item.product_name);
      let formattedProducts = productNames.slice(0, 3).join(', ');
      if (productNames.length > 3) {
        formattedProducts += `, <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfq_id}"
          style="color: #f87171; text-decoration: none;">view more</a>`;
      }

      // Email header content
      const headerContent = `<h2>Hello ${buyer.organization_name || ''},</h2>`;

      // Email body content
      const containerContent = `
      <div style="font-size:16px; font-family: 'Roboto', sans-serif;">
        <p>
          You've received a new quotation! Check out the details below:
        </p>
        <p><strong>Vendor:</strong> ${organization_name || name}</p>
        <p><strong>Products:</strong> ${formattedProducts || '-'}</p>

        <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfq_id}"
            style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
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
        from: `${organization_name || name} ${Config.masterEmail}`, // sender address
        //  organization_name : Config.webmasterMail,
        // to: buyer.email,
        subject: `New Quotation Received for Your RFQ ${rfq_no}`,
        html: dynamicHTML
      };

      // fetch spoc for buyer
       const spocList = await vendorModel.getSpocDetails(buyer?.id)

      if (spocList && spocList.length > 0) {
        mailRecipients.to = spocList.map(spoc => spoc.email);
        mailRecipients.cc = buyer.email;
      } else {
        mailRecipients.to = buyer.email;
      }

      // Sending the email to the buyer
      sendMail(mailRecipients);

      console.log(`Quotation update email sent to buyer: ${buyer.email}`);
    } 
  }


  //  vendorData, rfq_id, rfq_no, buyerName
 const sendRfqUpdatedMailToVendors = async (
   vendorData,
   rfq_id,
   rfq_no,
   buyer_name,
   emailType
 ) => {
   try {
     for (const vendor of vendorData) {
       const { name, email, vendor_id } = vendor;

       // Fetch vendor's SPOC details and token
       const spocs = await vendorModel.getSpocDetails(vendor_id);
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
         emailType
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

  const sendRfqAddVendorMail = async (vendorData, rfq_id, rfq_no, buyer_name) => {
    try {
      for (const vendor of vendorData) {
        const { vendor_name, vendor_email, spocs = [], token } = vendor;
  
        // Skip if no main email and no spocs
        const validSpocEmails = spocs
        .map(spoc => spoc?.email)
        .filter(email => typeof email === 'string' && email.includes('@'));
        
        const headerContent = `<h2>Hello ${vendor_name},</h2>`;
        const containerContent = `
          <p style="font-size: 15px;">
            RFQ #${rfq_no} has been updated by ${buyer_name}.
          </p>
          <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${token}"
             style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
            View RFQ
          </a>
        `;
  
        const html = generateEmailTemplate(headerContent, containerContent);
  
        const mail = {
          from:  `${buyer_name} ${Config.masterEmail}`,
          subject: `RFQ #${rfq_no} Details has beed updated by ${buyer_name}`,
          html
        };
  

        if (validSpocEmails.length > 0) {
          mail.to = validSpocEmails;
          mail.cc = vendor_email || '';
        } else {
          mail.to = vendor_email || '';
        }

         sendMail(mail);
      }
    } catch (err) {
      console.error("Error in sendRfqUpdatedMailToVendors:", err);
      throw err;
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

    const headerContent = `<h2>Hello ${winning_vendor_name || 'Mukul Vendor'},</h2>`;

const containerContent = ` 
<div style="font-size:16px; font-family: 'Roboto', sans-serif;">
  <p>
    <strong>${rfQItem[0]?.company_name}</strong> has made a selection for 
    <strong>#${rfQItem[0]?.rfq_no} </strong>. We appreciate your participation and encourage you to stay active on Workwise for future opportunities.
  </p>


  <h4> Product Details </h4> 
  <ul>
  <li> <strong> Product Name </strong> ${winning_product[0]?.product_details[0]?.name}  </li>
  <li> <strong> Size </strong> ${winning_product[0]?.product_specs[0]?.value}  </li>
  <li> <strong> Specification </strong> ${winning_product[0]?.product_specs[1]?.value}  </li>
  <li> <strong> Quantity </strong> ${winning_product[0]?.product_specs[2]?.value} </li>
  </ul>


  <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfQItem[0]?.id}&token=${vendorNonLoginRfqAccessToken[0]?.token||''}"
     style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
    Go to Dashboard
  </a>

     <p style="margin-top:20px; text-align:center;"> <strong> Explore More Leads: </strong> New RFQs are frequently posted, so check back regularly to find other opportunities.</p>
  <p style="margin-top:20px; text-align:center;">
    Thank you for partnering with us,
  </p>
</div>`;

// Generate final email layout
const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

    const spocList = await vendorModel.getSpocDetails(vendor_id)

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

const deleteRelatedRecords = async (rfq_id) => {
  try {
      await Promise.all([
          rfqModel.deleteWithReturnIds('tbl_rfq_files', { rfq_id, file_type: 'term_and_condition' }),
          rfqModel.deleteWithReturnIds('tbl_rfq_product_vendors', { rfq_id }),
          rfqModel.deleteWithReturnIds('tbl_rfq_terms_map', { rfq_id }),
          rfqModel.deleteWithReturnIds('tbl_rfq_products_specs', { rfq_id })
      ]);

      const rfqProductIds = await rfqModel.deleteWithReturnIds('tbl_rfq_products', { rfq_id });

      // Delete from tbl_rfq_product_files based on retrieved rfq_product_ids
      if (rfqProductIds.length > 0) {
          await rfqModel.deleteProductFilesByIds(rfqProductIds);
      }
  } catch (error) {
      logError("Error deleting related records:", error);
      throw error;
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
      ra_start_date,
      ra_end_date,
      project_id,
      term_and_condition_files,
      termsChanged,
      termFilesChanged,
  } = reqBody;
  const response_email = reqBody.response_email?.toLowerCase() || '';
  
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
      ra_start_date: reverse_auction == 1 ? ra_start_date : null,
      ra_end_date: reverse_auction == 1 ? ra_end_date : null,
      is_published: 0,
      updated_by: user_id
  };


  if (project_id && project_id !== -1) {
      rfqData.project_id = project_id;
  } else if (!project_id || project_id == '') {
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
              value = parseInt(value) || '';

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
            throw new Error(
              'Some products contain No Vendors, Please delete the products with no vendors!'
            );
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

const rfqController = {
  create: async (req, res, next) => {
    if (!req.user.subscription_plan_id) {
      return res.status(400).json({
        status: 3,
        message: 'You need to purchase subscription to create RFQ'
      }).end();
    }

    try {
      let { rfq_id , ra_start_date , ra_end_date , bid_end_date , reverse_auction} = req.body;
      const user_id = req.user.id;

      if (!rfq_id) {
        return res.status(400).json({
          status: 3,
          errors: {
            rfq: 'RFQ Id is required to create an RFQ from Draft!'
          }
        }).end();
      }
      // check if RA is true
      if(reverse_auction){
        if(!ra_start_date || !ra_end_date){
          return res.status(400).json({
            status: 3,
            errors: {
              ra_start_date: 'RA Start Date is required',
              ra_end_date: 'RA End Date is required'
            }
          }).end();
        }
        if(new Date(ra_start_date) >= new Date(ra_end_date)){
          return res.status(400).json({
            status: 3,
            errors: {
              ra_start_date: 'RA Start Date should be before RA End Date'
            }
          }).end();
        }
        if(new Date(ra_start_date) <= new Date(bid_end_date)){
          return res.status(400).json({
            status: 3,
            errors: {
              ra_start_date: 'RA Start Date should be after Bid End Date'
            }
          }).end();
        }
      }
      await saveRfqDraft(user_id, req.body);

      const isRFQComplete = await rfqModel.checkRFQCompletion(rfq_id);

      if(!isRFQComplete) {
        return res.status(400).json({
          status: 2,
          errors: {
            rfq_specs: 'Some products are missing quantity or unit. Please fill them before proceeding.'
          }
        }).end();
      }
      const products = await rfqModel.getProductsByRfqId(rfq_id);

      const responseUpdate = await rfqModel.update(
        'tbl_rfq',
        { is_published: 1 },
        rfq_id
      );
      
      await sendMailtoVendors(req, rfq_id);
      await sendQuotationMailToBuyer(req, rfq_id);

      const buyerMsgPayload = {
        mobile: req.user.mobile,
        rfq_id: rfq_id,
        rfq_no: responseUpdate[0]?.rfq_no
      };
  
      whatsappNotificationFluxChat.buyerCreatesRFQNotification(buyerMsgPayload);

      return res.status(200).json({
        status: 1,
        data: responseUpdate[0],
        mail_sent: true
      }).end();

    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: Config.errorText.value
      }).end();
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

      await db.tx(async t => {
   
      const data = req.body;

      const rfq_id = data.rfq_id;
      delete data.rfq_id; // Remove rfq_id from update fields

      // Override model database access to use transaction
      const transactingModels = {
            rfqModel: withTransaction(rfqModel, t),
            userModel: withTransaction(userModel, t),
            vendorModel: withTransaction(vendorModel, t)
        };



      const updatableData = data.updatableData;
      delete data.updatableData;

      const products = updatableData?.products;
      const updatableVendors = updatableData?.vendors;
      const newAddedproductVendors = {}; // { [email]: { name, email, product_names: [] } }
      const deletedProductVendors = {}; // { [email]: { name, email, product_names: [] } }
      const deletedVendorsFromExistingProducts = {}; // { [email]: { name, email, product_names: [] } }
      const addedVednorsToExistingProducts = {}; // { [email]: { name, email, product_names: [] } }
      const updatedDataVendors = [];

    

      if (products && products?.updatable) {
        const updatableKeys = new Set();
        //handling new Product added
        if (products?.addable?.length > 0) {
          await Promise.all(
            products.addable.map(async (productId) => {
              if(products?.deletable && products.deletable.length > 0 && products.deletable.includes(parseInt(productId))) return null;
              const vendors = await transactingModels.rfqModel.searchEmailAndNameForVendor(
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
                    !newAddedproductVendors[vendor_id].product_names.includes(
                      product_name
                    )
                  ) {
                    newAddedproductVendors[vendor_id].product_names.push(
                      product_name
                    );
                  }

                  await transactingModels.rfqModel.insertVendorRfqToken(vendor_id, rfq_id);
                }
              }
            }).filter(Boolean)
          );
        }

        // Handling Specs insert and/or update
        if (products.updatable?.specs)
          Object.keys(products.updatable.specs).forEach((rfqProductId) => {
            if(products?.deletable && products.deletable.length > 0 && products.deletable.includes(parseInt(rfqProductId))) return;

            const productId = products.updatable.specs[rfqProductId].product_id;
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
                const doesExist = await transactingModels.rfqModel.checkIfExists(
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
                    variant: parseInt(
                      variant ?? '0'
                    )
                  };
                  await transactingModels.rfqModel.insert('tbl_rfq_products_specs', insertData);
                }
              }
            );
          });

        // Handling Files insert and/or update
        if (products.updatable?.files)
          Object.keys(products.updatable.files).forEach((rfqProductId) => {
            if(products?.deletable && products.deletable.length > 0 && products.deletable.includes(parseInt(rfqProductId))) return;

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
                const doesExist = await transactingModels.rfqModel.checkIfExists(
                  'tbl_rfq_product_files',
                  currentWhereClause,
                );
                const data = products.updatable.files[rfqProductId][fileType];
                const isRemovable = !Array.isArray(data) && data == 'rm';

                if (doesExist && doesExist.length > 0) {
                  const conditions = {
                    rfq_product_id: rfqProductId,
                    file_type: transformedFileType
                  };
                  await transactingModels.rfqModel.delete('tbl_rfq_product_files', conditions, t);
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
                    'tbl_rfq_product_files',
                  );
                }
              }
            );
          });

        if (products.updatable?.comment)
          Object.keys(products.updatable.comment).forEach(
            async (rfqProductId) => {
              if(products?.deletable && products.deletable.length > 0 && products.deletable.includes(rfqProductId)) return;

              const productId =
                products.updatable.comment[rfqProductId].product_id;
              const variant = products.updatable.comment[rfqProductId].variant;
              const comment = products.updatable.comment[rfqProductId].comment;

              if (!products.addable?.includes(parseInt(rfqProductId))) {
                updatableKeys.add(rfqProductId);
              }

              let whereClause = `rfq_id = (${rfq_id})::INT AND product_variant_id = (${productId})::INT AND variant = (${variant})::INT`;

              const data = {
                comment
              };
              await transactingModels.rfqModel.updateWhere('tbl_rfq_products', data, whereClause);
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

            const vendors = await transactingModels.rfqModel.searchEmailAndNameForVendor(
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
          await transactingModels.rfqModel.insertVendorRfqToken(vendor.vendor_id, rfq_id);
        }
      }

      if (products && products?.deletable && products.deletable.length > 0) {
        for (const rfqProductId of products.deletable) {
          const vendors = await transactingModels.rfqModel.searchEmailAndNameForVendor(
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
          let deletedRecord = await transactingModels.rfqModel.delete('tbl_rfq_products', {
            id: rfqProductId
          });
          if (!deletedRecord || deletedRecord.length === 0) continue;

          deletedRecord = deletedRecord[0];

          // Delete vendor mapping
          const vendorConditions = {
            rfq_id,
            product_variant_id: deletedRecord.product_variant_id,
            variant: deletedRecord.variant
          };
          await transactingModels.rfqModel.delete('tbl_rfq_product_vendors', vendorConditions);

          // Directly deleting product specs as well
          await transactingModels.rfqModel.delete('tbl_rfq_products_specs', vendorConditions);

          // Delete associated files
          const directRfqProductConditions = { rfq_product_id: rfqProductId };
          await transactingModels.rfqModel.delete(
            'tbl_rfq_product_files',
            directRfqProductConditions
          );

          // Delete tech evaluations
          const techEvaluationCondition = { tbl_rfq_product_id: rfqProductId };
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

                  if (techEvaluationVendorResponseDeletedRecords?.length > 0) {
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
            await transactingModels.rfqModel.getProductOrVariantNameByRfqProductId(rfqProductId);

          // Extract Deleted Vendors Before deletion operation
          for (const vendorId of deletable) {
            const vendordata = await transactingModels.userModel.getUserById(vendorId);
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
            const vendordata = await transactingModels.userModel.getUserById(vendorId);
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
              let productDetails = await transactingModels.rfqModel.checkIfExists(
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

              await transactingModels.rfqModel.delete('tbl_rfq_product_vendors', conditions);
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
      const updatedData = await transactingModels.rfqModel.update(
        'tbl_rfq',
        data,
        rfq_id
      );

      // get rfq vendors list
      let vendors = await transactingModels.rfqModel.gerRFQVendors(rfq_id);
      let vendorIdList = vendors.map((vendor) => vendor.user_id);

      // get vendor details along with spoc
      const vendorData = await transactingModels.vendorModel.getVendorsWithSpocsAndToken(
        vendorIdList,
        rfq_id
      );

      const buyerName = updatedData?.[0]?.company_name ?? '-';
      const rfqNo = updatedData?.[0]?.rfq_no ?? '000000';

      const newAddedproductVendorsArray = Object.values(newAddedproductVendors);
      const deletedProductVendorsArray = Object.values(deletedProductVendors);
      const deletedVendorsFromExistingProductsArray = Object.values(
        deletedVendorsFromExistingProducts
      );
      const addedVednorsToExistingProductsArray = Object.values(
        addedVednorsToExistingProducts
      );
      const updatedDataVendorsArray = Object.values(updatedDataVendors);

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
        RFQ_EMAIL_TYPE.REMOVED_VENDOR_FROM_EXISTING_PRODUCT
      ); //for deleted vendors from existing products

      await sendRfqUpdatedMailToVendors(
        addedVednorsToExistingProductsArray,
        rfq_id,
        rfqNo,
        buyerName,
        RFQ_EMAIL_TYPE.ADDED_VENDOR_TO_EXISTING_PRODUCT
      ); //for added vendors to existing products

      // Send updated RFQ mail to vendors
      await sendRfqUpdatedMailToVendors(
        updatedDataVendorsArray,
        rfq_id,
        rfqNo,
        buyerName,
        RFQ_EMAIL_TYPE.UPDATED_VENDOR
      );

      res.status(200).json({
        status: 1,
        data: updatedData || {},
        vendors: vendorData,
        rfqDetails: updatedData,
        message: 'RFQ updated successfully'
      });
    }
   )
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
      res.status(500).json({
        status: 3,
        message: 'An error occurred while saving the draft',
        errors: {rfq: error.message ?? 'An error occurred while saving the draft'},
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
        message: "Draft RFQ not found or does not belong to the user!",
      });
    }
    db.tx(async (t)=>{
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

    await rfqModel.delete('tbl_rfq_draft_sheets', {rfq_id:id})

    // Delete tech evaluations and associated data
    const techEvaluationCondition = { rfq_id: id };
    const techEvaluationDeletedRecordsIds = await rfqModel.deleteWithReturnIds(
      'tbl_rfq_product_tech_evaluation',
      techEvaluationCondition,
      t
    );

    let techEvalClauseFilesId = [];

    if (Array.isArray(techEvaluationDeletedRecordsIds) && techEvaluationDeletedRecordsIds.length > 0) {
      for (const evaluationClauseId of techEvaluationDeletedRecordsIds) {
        const clauseCondition = {
          tbl_rfq_product_tech_evaluation_id: evaluationClauseId,
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
          tbl_rfq_product_tech_evaluation_clauses_id: techEvalClauseFileId,
        };

        await rfqModel.delete(
          'tbl_rfq_product_tech_evaluation_clauses_files',
          clauseFileCondition,
          t
        );
      }
    }

    // Delete terms and conditions
    await rfqModel.delete('tbl_rfq_terms_map', { rfq_id: id },t);

    return res.status(200).json({
      status: 1,
      message: "RFQ draft and all associated records deleted successfully",
    });
    })
    
  } catch (error) {
    console.error("Error deleting RFQ draft:", error);
    logError("Error deleting RFQ draft:", error);
    return res.status(500).json({
      status: 3,
      message: "An error occurred while deleting the RFQ draft",
    });
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
        const rfqList = await rfqModel.findAll('tbl_rfq', { is_published: 0, created_by: req.user.id });

        if (!rfqList.length) {
            return res.status(204).json({ status: 2, message: 'Draft RFQ doesnot exist' });
        }

        const rfqData = rfqList[0];
        const id = rfqData.id;

        const rfqItem = await rfqModel.getRfqDraftById(id);

        res.status(200).json({
            status: 1,
            data: rfqItem.length > 0 ? rfqItem[0] : rfqItem
        });
    } catch (error) {
        console.log(error)
        logError("Error fetching RFQ creation data:", error);
        res.status(500).json({
            status: 3,
            message: "An error occurred while fetching RFQ draft data"
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
      logError("Error fetching draft RFQs:", error);
      res.status(500).json({
        status: 3,
        message: "An error occurred while fetching draft RFQs"
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

      if(sheets) {
        sheetData = sheets[0];
      }

      if(sheetData && !sheetData.is_processed) {
        try {
          const [,processedData] = await rfqController.processRfqDraftSheetWise(null, req.user, id, sheetId);
          await saveMagicSearchInDraft(processedData, user_id, null, id, sheetId);
        } catch (error) {
          console.log(error)
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
          message: "Draft RFQ details not found" 
        });
      }
      
      if (draftData[0].rfq_form_data.is_published !== 0) {
        return res.status(403).json({ 
          status: 2, 
          message: "This is not a draft RFQ" 
        });
      }

      const isMagicRfq = draftData[0].rfq_form_data.rfq_added_from === 'magic';
      
      if (isMagicRfq && (!draftData[0].sheets || draftData[0].sheets.length === 0)) {
        const sheets = await rfqModel.getSheetsForDraftRfq(id);
        if (sheets && sheets.length > 0) {
          draftData[0].sheets = sheets;
        }
      }
      
      // Return in the same format as getRFQDraftData
      res.status(200).json({
        status: 1,
        data: draftData[0]
      });
    } catch (error) {
      
      // Changes by Agnij 2025-05-24 [Fixed error handling to properly use logError]
      const err = new Error("Error fetching draft RFQ by ID");
      err.original = error;
      logError(err);
      
      res.status(500).json({
        status: 3,
        message: "An error occurred while fetching the draft RFQ"
      });
    }
  },

  getDraftProductVendors: async (req, res) => {
    try {
      const { draftId } = req.params;
      const { rfqProductId } = req.query;
      const buyerId = req.user.id;

      if(!validateNumber(rfqProductId))
        return res.status(400).json({ 
          status: 2, 
          message: "`rfqProductId` is required to fetch vendors." 
        });
      
      const draftData = rfqModel.checkIfExists('tbl_rfq', `id = ${draftId} AND is_published = 0`)
      if(!draftData || draftData.length <= 0)
        return res.status(400).json({ 
          status: 2, 
          message: "Draft either does not exist or is already published." 
        });

      const filters = generalModel.generateFilters(req.body, VENDORS_FILTER_KEYS);

      const vendors = await rfqModel.getDraftProductVendors(draftId, rfqProductId, buyerId, filters)

      return res.json({ 
          status: 1, 
          message: `Vendors fetched for ${rfqProductId}`,
          data: vendors ?? [],
        });

    } catch (error) {
      const err = new Error("Error fetching vendors");
      err.original = error;
      logError(err);
      
      res.status(500).json({
        status: 3,
        message: "An error occurred while fetching the vendors for this product."
      });
    }
  },

  createOrUpdateRfqDraftWithProductVendors : async (req, res) => {
    try {
        const user_id = req.user.id;

        const user = await userModel.userinfo(user_id);
        if (!user) {
            return res.status(404).json({ status: 2, message: 'User not found' });
        }

        let rfq_id;
        let rfqData;
        let isNew = false;

        const sheet_id = req.body.sheet_id;

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
                bid_end_date: req.body.bid_end_date || bidEndDate.toISOString().split('T')[0],
                location: req.body.location || '',
                is_published: 0,
                created_by: user_id,
                updated_by: user_id,
                status: 1,
                // timestamp: currentDate,
            };

            const nextRFQNumber = await getNextRfQNumber();
            rfqData.rfq_no = nextRFQNumber;

            const response = await rfqModel.insert('tbl_rfq', rfqData);
            rfq_id = response[0].id;
            isNew = true

            const rfqTerms = [];
            for(let i=1; i<9; i++){
              rfqTerms.push({ rfq_id, terms_id: i });
            }
            await rfqModel.insertArray(rfqTerms, ['rfq_id', 'terms_id'], 'tbl_rfq_terms_map');
        }

        // Add products to the RFQ
        const product = req.body;
        if (!product || !product.variant_id || !Array.isArray(product.vendors) || product.vendors.length === 0) {
          return res.status(400).json({ status: 2, message: 'Invalid product or vendors data' });
        }

        const variant = await rfqModel.getNextVariant(rfq_id, product.variant_id);

        const productData = {
            rfq_id,
            product_variant_id: product.variant_id,
            variant: variant,
            comment: "",
            datasheet: "",
            spec_file: "",
            qap_file: "",
            qap: "",
            datasheet_file: "",
            sheet_id,
        };

        await rfqModel.insert('tbl_rfq_products', productData);

        const vendorPromises = product.vendors.map(async (vendor) => {

            const vendorData = {
                rfq_id,
                product_variant_id: product.variant_id,
                user_id: vendor.vendor_id,
                variant: variant,
                sheet_id,
            };
            return await rfqModel.insert('tbl_rfq_product_vendors', vendorData);
        });

        await Promise.all(vendorPromises);

        res.status(200).json({
            status: 1,
            message: 'RFQ draft created/updated successfully',
            data: {
                rfq_id,
                isNew
            }
        });

    } catch (error) {
        logError("Error while creating or updating RFQ with products:", error);    
        res.status(500).json({
            status: 3,
            message: "An error occurred while processing your request"
        });
    }
  },
  addProductVendorsInEditRfq : async (req, res) => {
    try {
        // Add products to the RFQ
        const product = req.body;
        const rfq_id = product.rfq_id || product.rfqId;
        const specs = product.specs;

        if (!product || !product.variant_id || !Array.isArray(product.vendors) || product.vendors.length === 0) {
          return res.status(400).json({ status: 2, message: 'Invalid product or vendors data' });
        }

        const variant = await rfqModel.getNextVariant(rfq_id, product.variant_id);

        const productData = {
            rfq_id,
            product_variant_id: product.variant_id,
            variant,
            comment: "",
            datasheet: "",
            spec_file: "",
            qap_file: "",
            qap: "",
            datasheet_file: ""
        };

        let addedRfqProduct = await rfqModel.insert('tbl_rfq_products', productData);

        if(!addedRfqProduct || !addedRfqProduct.length > 0) {
          return res.status(400).json({
            status: 3,
            message: 'Something want wrong, please try again!'
          })
        }

        addedRfqProduct = addedRfqProduct[0]

        if(specs && specs.Quantity && specs.Unit) {
          Object.entries(specs).forEach(async ([title, value]) => {
            const specsData = {
              rfq_id,
              product_variant_id: product.variant_id,
              variant,
              title: title,
              value: value
            };
  
            await rfqModel.insert(
              'tbl_rfq_products_specs',
              specsData
            );
          })
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
        console.log(error)
        logError("Error while adding Product and Vendors:", error);    
        res.status(500).json({
            status: 3,
            message: "An error occurred while processing your request"
        });
    }
  },

  removeVendorFromDraft: async (req, res) => {
    const {
        rfq_id,
        product_id,
        variant,
        vendor_ids
    } = req.body;

    if (!rfq_id || !product_id || !variant || !vendor_ids || vendor_ids.length == 0) {
        return res.status(400).json({ status : 3,  message: "Missing required fields." });
    }

    try {
        const conditions = {
            rfq_id: rfq_id,
            product_variant_id: product_id,
            user_ids: vendor_ids,
            variant: variant
        };

        const result = await rfqModel.delete('tbl_rfq_product_vendors', conditions);

        if (result.length > 0) {
            return res.status(200).json({ status : 1, message: "Vendor removed successfully.", deletedRows: result });
        } else {
            return res.status(404).json({ status : 3, message: "No matching record found to delete." });
        }
    } catch (error) {
        logError("Error removing vendor from draft:", error);
        return res.status(500).json({ status: 3, message: "Internal server error." });
    }
  },
 
  getRfqDetailsById: async (req, res) => {
    try {
      const { rfq_id } = req.body;

      const result = await rfqModel.getRFQDetails(rfq_id);
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
      const rfq_data = await rfqModel.getRfqChartData(user_id, chartFilter, startDate, endDate, project_id);         

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
      let page, limit, offset;
      if (req.body.page && req.body.page > 0) {
        page = req.body.page;
        limit = req.body.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      const listRfq = await rfqModel.getRfqByUser(limit, offset, user_id);
      const  totalRFQ = await rfqModel.getVendorRfqCount(user_id);

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
      const tokenData = await rfqModel.checkIfExists("tbl_vendor_rfq_tokens_non_login", `token = '${withoutLoginUserToken}'`);

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
      const userData = await rfqModel.checkIfExists("tbl_users", `id = ${tokenData[0].vendor_id}`);

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

        const { user_type, id:user_id } = req.user;

    try {
      if (user_type == 2 || user_type == 8) {
        // for buyer
        // check if the user is part of the team
        let allowBuyerViewAccess = await userModel.user_rfq_access_review(id, user_id, user_type);
        if (!allowBuyerViewAccess) {
          res
            .status(200)
            .json({
              status: 1,
              message: 'You are not authorized to view this RFQ',
              data: []
            })
            .end();
          return;
        }
      } else if (req.user.user_type == 3) {
        // check if the vendor is responsible for this RFQ
        let availability = await rfqModel.checkVendorRFQResponsibility(
          id,
          req.user.id
        );
        if (availability.length > 0) {
          // Update is_rfq_viewed status for vendor when they view RFQ
          try {
            await rfqModel.updateWhere('tbl_rfq_product_vendors', 
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
        req.user.user_type
      );

      // Fix for auction dates - Enhanced logging and data transformation
      if (rfQItem && rfQItem.length > 0) {
        
        // Ensure auction dates are properly formatted strings, not null/undefined
        if (rfQItem[0].reverse_auction === 1) {
          // If reverse auction is enabled but dates are empty, set default values
          if (!rfQItem[0].ra_start_date || rfQItem[0].ra_start_date === '' || rfQItem[0].ra_start_date === 'null') {
            rfQItem[0].ra_start_date = new Date().toISOString().split('T')[0];
          }
          
          if (!rfQItem[0].ra_end_date || rfQItem[0].ra_end_date === '' || rfQItem[0].ra_end_date === 'null') {
            if (rfQItem[0].bid_end_date) {
              rfQItem[0].ra_end_date = rfQItem[0].bid_end_date;
            } else {
              // If no bid_end_date, set to 7 days from now
              const endDate = new Date();
              endDate.setDate(endDate.getDate() + 7);
              rfQItem[0].ra_end_date = endDate.toISOString().split('T')[0];
            }
          }
          
          // Update the database with these defaults if they were missing
          if (rfQItem[0].ra_start_date && rfQItem[0].ra_end_date) {
            try {
              await rfqModel.update('tbl_rfq', {
                ra_start_date: rfQItem[0].ra_start_date,
                ra_end_date: rfQItem[0].ra_end_date
              }, id);
            } catch (updateError) {
              console.error("Error updating auction dates:", updateError);
            }
          }
        } else {
          // If reverse auction is disabled, explicitly set dates to empty strings for frontend
          rfQItem[0].ra_start_date = '';
          rfQItem[0].ra_end_date = '';
        }
        
      }

      // this block is for vendor, to show only those products which are assigned to the vendor
      if (req.user.user_type != 2) {
        const userProducts = await rfqModel.getUserProducts(id, req.user.id);
        if (
          userProducts.length > 0 &&
          rfQItem.length > 0 &&
          rfQItem[0].products.length > 0
        ) {
          let fproducts = [];
          userProducts.map((prod_item) => {
            rfQItem[0].products.map((pintem) => {
              if (prod_item.product_id == pintem.product_id && prod_item.variant == pintem.variant) {
                pintem.vendor_details = pintem.vendor_details.filter(vendor => vendor.user_id === req.user.id);
                fproducts.push(pintem);
              }
            });
          });

          // changes done by mukul, no need to remove duplicate specs, they are already product and variant specific
          // rfQItem[0].products =  await removeSpecsDynamically(fproducts); // remove duplicate specs from products
          rfQItem[0].products = fproducts;
        }
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

      let {project_id,sort,reverse_auction,rfq_type,rfq_no} = req.body;
      if(project_id==-1){
        project_id=null;
      }
      if(rfq_type==''){
        rfq_type=null;
      }
      if(reverse_auction=='-1'){
        reverse_auction=null;
      }


      const listRfq = await rfqModel.getAllBuyerRfq(limit, offset, user_id,project_id,sort,reverse_auction,rfq_type,rfq_no);

      let count = await rfqModel.getBuyerRfqCount(user_id,project_id,rfq_type,reverse_auction,rfq_no);
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
    let {productId, excludeIds} = req.body;
    let userId = req.user.id;
    try {
      const vendorsList = await rfqModel.getVendorsForProduct(productId, excludeIds, userId);

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
    let {rfq_product_id} = req.query;
    
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
      term_and_condition_files,
      is_regret,
      regret_reason
    } = req.body;

    const withoutLoginUserToken = !req.is_verified ? req.query.token : null;

    if (withoutLoginUserToken) {
      // Check if the token exists
      const tokenData = await rfqModel.checkIfExists("tbl_vendor_rfq_tokens_non_login", `token = '${withoutLoginUserToken}'`);

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
      const userData = await rfqModel.checkIfExists("tbl_users", `id = ${tokenData[0].vendor_id}`);

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
      const listRfq = await rfqModel.getRfqByUser(1000000, 0, user.id);
      if (listRfq.length > 0) {
        let filteredRFQ = listRfq.filter((item) => item.id == rfq_id);
        if (filteredRFQ.length > 0) {
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
          const bidEndDate = rfqDetails[0].bid_end_date ? new Date(rfqDetails[0].bid_end_date) : null;
          const raStartDate = rfqDetails[0].ra_start_date ? new Date(rfqDetails[0].ra_start_date) : null;
          const raEndDate = rfqDetails[0].ra_end_date ? new Date(rfqDetails[0].ra_end_date) : null;
          const isReverseAuction = rfqDetails[0].reverse_auction === 1;
          
          // Create end of day date for bid end date (to match frontend logic)
          const bidEndDateEndOfDay = bidEndDate ? new Date(bidEndDate.getFullYear(), bidEndDate.getMonth(), bidEndDate.getDate(), 23, 59, 59, 999) : null;

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
          const isReverseAuctionActive = isReverseAuction && raStartDate && raEndDate && now >= raStartDate && now <= raEndDate;

          // If reverse auction is active, allow quote submission
          if (isReverseAuctionActive) {
            // Continue with quote submission - this is allowed
          }
          // Otherwise check other conditions
          else {
            // Check if all products are finalized
            const productsFinalized = await rfqModel.checkAllProductsFinalized(rfq_id, user.id);
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
                const techEvalResult = await rfqModel.getTechEvaluationResult(rfqProductId, user.id);

                // If product has technical evaluation but vendor is not accepted, add to rejected list
                if (techEvalResult && techEvalResult.data &&
                    techEvalResult.data.has_tech_eval === true &&
                    techEvalResult.data.status !== 1) {
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

          return await db.tx(async t => {

            const tbl_quotes_data = {
              rfq_id,
              rfq_no,
              status,
              created_by: user.id,
              updated_by: user.id,
              is_regret: req.body.is_regret ? req.body.is_regret : 0,
              global_payment_term: globalPaymentTerms,
              global_comment: globalComment,
              regret_reason
            };
  
            // check quote is already exists or not
            // console.log("mukul 1870")
            let alreadyExists = await rfqModel.checkIfExists(
              'tbl_quotes',
              `rfq_id=${rfq_id} AND created_by=${user.id} LIMIT 1`,
              t
            );
            if (alreadyExists.length > 0) {
              throw new Error('Quote is alredy present for this RFQ!')
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
                  document_files
                }) => {
                  if(unit_price!=""){
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
                      variant
                    });
                  }else if(comment!="" || document_files?.length>0){
                    quote_items_data.push({
                      rfq_id,
                      rfq_no,
                      product_variant_id: product_id,
                      product_name,
                      unit_price:0,
                      package_price,
                      tax,
                      freight_price,
                      total_price,
                      comment,
                      delivery_period,
                      quantity,
                      variant
                    });
                  } else if(is_regret){
                    quote_items_data.push({
                      rfq_id,
                      rfq_no,
                      product_variant_id: product_id,
                      product_name,
                      unit_price:0,
                      package_price,
                      tax,
                      freight_price,
                      total_price,
                      comment,
                      delivery_period,
                      quantity,
                      variant
                    })
                  }
                }
              );
  
              if(is_regret){
                let quote_rsp = await rfqModel.insert('tbl_quotes', tbl_quotes_data, t);
                const created_quote_id = quote_rsp?.[0]?.id;

                if(created_quote_id) {
                  const buyer = await userModel.getUserById(rfqDetails[0].created_by);
                  
                  // adding the quote_id
                  quote_items_data.map((item)=> item.quote_id=created_quote_id);
                  
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
                    'variant'
                  ];
                  await rfqModel.insertArray(
                    quote_items_data,
                    quote_items_keys,
                    'tbl_quote_items',
                    t
                  );

                  await sendMailToBuyerForRegret(buyer[0], rfqDetails[0].rfq_no, req.user, rfq_id, regret_reason);

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
                    error: 'Entry in table quote didn\'t exexuted as expected!'
                  })
                  .end();
              }
  
              // if quote item data is empty because of errors
              if(quote_items_data.length < 1){
                throw new Error('Not able to send the Quote')
              }
  
            // Insertion of the quote
            let quote_rsp = await rfqModel.insert('tbl_quotes', tbl_quotes_data, t);
            if (quote_rsp.length > 0) {
  
              const created_quote_id = quote_rsp[0].id;
  
              if (term_and_condition_files && term_and_condition_files.length > 0) {
                const quote_files = term_and_condition_files.map(url => ({
                  quote_id:created_quote_id,
                  file_type: 'term_and_condition',
                  file_url: url
                }));
                for (const fileData of quote_files) {
                  await rfqModel.insert('tbl_quotes_files', fileData, t);
                }
              }
  
              // adding the quote_id
              quote_items_data.map((item)=> item.quote_id=created_quote_id);
  
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
                'variant'
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
                    const file_records = file_links.map(link => ({
                      quote_item_id: item.id,
                      file_type: "DOC",
                      file_url: link,
                      created_at: new Date()
                    }));
                    await rfqModel.insertArray( file_records, ['quote_item_id', 'file_type', 'file_url', 'created_at'], 'tbl_quote_item_files', t
                    );
                  }
                });
              }
  
              await sendQuoteNotificationEmail(req);
              await sendQuoteNotificationToVendor(req);
  
              //  send whatsapp notification
              const buyerDetails = await rfqModel.getRFQCreatedBy(rfq_id);
              const rfqDetails = await rfqModel.getRfqDetailsById(rfq_id)
              const projectID = rfqDetails[0]?.project_id
              const projectDetails = await projectModel.getProjectTableDataById(projectID, buyerDetails[0]?.id)
  
              
              const payload = {
                mobile:buyerDetails[0]?.mobile,
                rfqNumber:rfq_no,
                rfqID:rfq_id,
                projectName:projectDetails[0]?.name || "-",
                vendorName:req?.user?.name,
                buyerName:buyerDetails[0]?.name
              }
       
              await whatsappNotificationFluxChat.sendNewQuoteNotificationToBuyer(payload);
  
  
              return res
                .status(200)
                .json({
                  status: 1,
                  data: quotes_items[0],
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
          })

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
          error,
        })
        .end();
    }
  },
  getQuotesByRfqById: async (req, res, next) => {
    let rfq_id = req.params.id;
    const {TA_Vendors, no_freight} = req.query;
    const { id } = req.user;

    try {
      let rfQItem = await rfqModel.getQuotesByRfqById2(rfq_id, id, TA_Vendors, no_freight);
      // rfQItem = filterQuotations(rfQItem);
      // rfQItem = processQuotations(rfQItem);
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
    const {TA_Vendors, no_freight} = req.query;

    const { id } = req.user;

    try {
      let rfQItem = await rfqModel.getQuotesByRfqByIdByProduct(rfq_id, id, TA_Vendors, no_freight);
      
      rfQItem.forEach(product => {
        const vendorMap = new Map();
        product.all_vendors.forEach(vendor => vendorMap.set(vendor.id, vendor));
    
        const updatedQuotations = product.all_vendors.map(vendor => {
            const existingQuote = product.quotations.find(q => q.created_by === vendor.id);
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
  getLprLqrByVariantId : async (  req , res ,next) => {
   
   const { variant_id, type } = req.query; 
    const {id} = req.user;
    console.log("req recieved", variant_id, type, id);
    try {
         
      if(variant_id){
         const data =  await rfqModel.getLprLqrByVariantId(id, variant_id, type);

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
    const { id , organization_name , name} = req.user;
  

    try {


      const rfQItem = await rfqModel.changeRFQStatus(rfq_id, id);
      const vendorList = await rfqModel.getRfqVendorListAlongWithSPOC(rfq_id)

    // Define email content based on user role
    const headerContent = `<div>
                           <h2>Hello ${req.user.name},</h2>
                          </div>`;


    const buyerContainerContent = `<div style="font-size:16px;">
        You've marked your RFQ as closed. Here are the details for your records:<br>
        <strong>RFQ Number:</strong> ${rfQItem[0]?.rfq_no}<br>
        <strong>Closed By:</strong> ${req.user.name}<br>
        <br>
        <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfq_id}"
           style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
          View Closed RFQs
        </a>
           <br>
        <p>
        Keep moving forward with Workwise!
        </p>
      </div>`

    const dynamicHTML = generateEmailTemplate(headerContent, buyerContainerContent);

        // Send email to the buyer
        const buyerMailRecipients = {
          from: Config.webmasterMail,
          to: req.user.email,
          subject: `RFQ Marked as Closed for #${rfQItem[0]?.rfq_no}`,
          html: dynamicHTML,
        };
        sendMail(buyerMailRecipients);

        

         // Send email to all vendors and their SPOCs
         console.log("vendorList ", vendorList)
         for (const vendor of vendorList) {

          const headerContentVendor = `<div>
          <h2>Hello ${vendor.user_name},</h2>
         </div>`;

         const vendorContainerContent = `<div style="font-size:16px;">
         The RFQ for <strong>${rfQItem[0]?.rfq_no}</strong> has been marked as closed by the buyer.<br>
         Thank you for your participation, and we look forward to more opportunities to work with you.<br>
         <br>
         
         <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}"
            style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
           Explore New RFQs
         </a>
          <br>
         <p>
          Tip: Regularly check for new RFQs to stay ahead and grow your business through Workwise.
         </p>
 
         </div>`

         const dynamicHTMLVendor = generateEmailTemplate(headerContentVendor, vendorContainerContent);

          const spocList = vendor.spocs;
        
            let mailRecipients ={
              from: `${organization_name ?? name} ${Config.masterEmail}`,
              subject: `RFQ Marked as Closed for #${rfQItem[0]?.rfq_no}`,
              html: dynamicHTMLVendor,
            }

            if (spocList && spocList.length > 0) {
              mailRecipients.to = spocList.map(spoc => spoc.spoc_email);
              mailRecipients.cc = vendor.user_email;
            } else {
              mailRecipients.to = vendor.user_email;
            }

             sendMail(mailRecipients);
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

  /**
   * @description This function sends a reminder to vendors for a specific RFQ. who have not submited the quote for all products.
   * @users can send max 3 reminder in a day, foradmin there are no limit, 1 - admin, 5 subadmin - 6 data entry 
   */
  sendReminder: async (req, res, next) => {
    let rfq_id = req.params.id;
    const { organization_name, name, id, email } = req.user;
    const isCurrentUserAdmin = [1,5,6].includes(req.user.user_type);


    try {

      // const date = new Date('2024-11-28').toISOString().slice(0, 10);  // Format, YYYY-MM-DD
      const date = new Date().toISOString().slice(0, 10); 

      //  if admin then skip this check
      if(!isCurrentUserAdmin){
      const lastActivity = await rfqModel.getRFQActivity(rfq_id, id, date);
      if ( lastActivity?.length > 2) {
          return res
            .status(403)
            .json({
              status: 1,
              message: "You have already sent a reminder today for this RFQ!"
            })
            .end();
      }
      }

      const rfqBasicDetails = await rfqModel.getRfqDetailsById(rfq_id);

      if(!rfqBasicDetails) {
        return res
            .status(400)
            .json({
              status: 1,
              message: "RFQ not found, or is no longer available!"
            })
            .end(); 
      }

      if(rfqBasicDetails.status == '2') {
        return res
            .status(400)
            .json({
              status: 1,
              message: "Cannot send reminder for a closed RFQ!"
            })
            .end(); 
      }

      let vendors = await rfqModel.gerRFQVendors(rfq_id);
      const quote_vendor = await rfqModel.quoteVendor(rfq_id);

      //  buyer org name, the company name he used in create rfq field
      let org_name = rfqBasicDetails?.company_name || '';

      const createdByIds = new Set(quote_vendor.map((item) => item.created_by));

      const unmatchedVendors = (
        await Promise.all(
          vendors.map(async (vendor) => {
            let q = `rfq_id = ${rfq_id} AND created_by = ${vendor.user_id} AND is_regret = 1`;
            const isRegret = await rfqModel.checkIfExists('tbl_quotes', q)

            if(isRegret && isRegret.length > 0) return null;

            const vendorProducts = await rfqModel.getVendorProductsCount(rfq_id, vendor.user_id);
            const vendorProductsQuoted = await rfqModel.getVendorProductsQuoted(rfq_id, vendor.user_id);
      
            const requiredCount = vendorProducts.length;
            const quotedCount = vendorProductsQuoted.length;
      
            const isUnmatched =
              !createdByIds.has(vendor.user_id) || requiredCount !== quotedCount;
      
            return isUnmatched ? {
              vendor,
              remainingProducts: vendorProducts.filter(product => !vendorProductsQuoted.some(_product => _product.product_id == product.product_id))
            } : null;
          })
        )
      ).filter(Boolean);
      
      vendors = unmatchedVendors;

      Promise.all(vendors.map((item) => sendReminderRFQMAIL(item.vendor, item.remainingProducts, org_name, rfq_id,rfqBasicDetails  )))
        .then(async () => {
          try {
            await rfqModel.insertRFQActivity(rfq_id, id);
          }
          catch (error) {
            throw new Error(error)
          }
          finally {
            res
              .status(200)
              .json({
                status: 1,
                message: 'Reminder has been sent successfully!'
              })
              .end();
          }
        })
        .catch((error) => {
          logError(error);
          res
            .status(400)
            .json({
              status: 3,
              message: Config.errorText.value
            })
            .end();
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
  
  finalize: async (req, res, next) => {
    const { organization_name, name } = req.user;
    const { product_variant_id, vendor_id, rfq_id, rfq_no, quote_id, variant } = req.body;

    try {
      const vendor_details = await userModel.user_profile_detail(vendor_id);
      const rfQItem = await rfqModel.getRfqById(rfq_id, vendor_id);
      let winning_product = null;
      let winning_vendor_organization = null;
      let winning_vendor_email = null;
      let winning_vendor_name = null;

      if (vendor_details.length > 0) {
        winning_vendor_organization = vendor_details[0]?.organization_name ?? vendor_details[0]?.company_name;
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

        let alreadyExists = await rfqModel.checkIfExists(
          'tbl_quote_finalization',
          `rfq_id=${rfq_id} AND product_variant_id=${product_variant_id} AND variant=${variant} AND created_by=${req.user.id} LIMIT 1`
        );

        if (alreadyExists.length > 0) {
          res
            .status(409)
            .json({
              status: 1,
              message: "You've already finalized a vendor for this product!"
            })
            .end();
        } else {
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
            tbl_quote_finalization_data
          );

          const vendorNonLoginRfqAccessToken = await rfqModel.getVendorRfqToken(vendor_id, rfq_id)

          await sendWinningNotificaion(
            vendorNonLoginRfqAccessToken,
            vendor_id,
            rfQItem,
            winning_product,
            winning_vendor_organization,
            winning_vendor_email,
            winning_vendor_name
          );

          await userModel.mapBuyerToVendor(req.user.id, vendor_id);

          res
            .status(200)
            .json({
              status: 1,
              message: 'Notification has been sent!',
              data: response
            })
            .end();
        }
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: "Required fields are not present for vendors, aborting finalization."
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
  searchProduct: async (req, res, next) => {
    let search_key = '';
    let category_id = '';
    let approved_by_id = '';
    search_key = req.body?.search_key ? req.body?.search_key : ' ';
    category_id = req.body?.category_id ? req.body?.category_id : '';
    approved_by_id = req.body?.approved_by_id ? req.body?.approved_by_id : '';

    try {
      const productResult = await rfqModel.searchProduct(
        search_key,
        category_id,
        approved_by_id
      );

      const categoryResult = (search_key && search_key.length > 0) ? await rfqModel.getCategoryList(search_key) : [];

      let dummyOBJ = {
        product_id: '***',
        product_name: '**** ****',
        description:
          '******* ***** ****** ***** ************* ***** ****** ***** ************* ***** ****** ***** ******',
        category_name: '*******',
        vendor_name: '***** ********'
      };
      let items_to_show = 5;
      let total_items = productResult.length;
      let rest_items = 0;
      let items_to_sent = productResult;

      // if (!user.subscription_plan_id || user.subscription_plan_id == 0) {
      //   rest_items =
      //     total_items > items_to_show ? total_items - items_to_show : 0;
      //   items_to_sent = productResult.slice(0, items_to_show);

      //   Array.apply(null, { length: rest_items }).map((item) => {
      //     items_to_sent.push(dummyOBJ);
      //   });
      // }

      res
        .status(200)
        .json({
          status: 1,
          data: removeDuplicates(items_to_sent),
          categoryData: categoryResult
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
  searchProductByCategory: async (req, res, next) => {
    try {
      const category_id = req.body?.category_id ? req.body?.category_id : '';

      const subCategoryList = await rfqModel.getSubcategories(category_id)
   
      if(!subCategoryList || subCategoryList?.length==0){
        return res
        .status(404)
        .json({
          status: 3,
          message: "Products Not Found for the requested category",
          subCategoryList: subCategoryList,
        })
        .end();
      }

      const productList = await rfqModel.getProductsByCategories(subCategoryList)

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
    const productMakes = req.body?.productMakes || [] 
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
    let vendor_name = req.body.vendor_name;
    
    // If user is not logged in
    if (!req.is_verified) {
      try {

        // Call the searchVendor method
        const vendorResult = await rfqModel.searchVendorWithoutLogin(search_key, category_id, approved_by_id, state, city, country, turnOver, vendorType, prevWorkedWith);
        // console.log(vendorResult);

        // Check if vendorResult is not empty and has the expected structure
        if (vendorResult && vendorResult.total && vendorResult.vendor) {
          const vendorData = vendorResult.vendor; // First query result
          const totalCount = vendorResult.total; // Second query result: total count

          // Send the response with the vendor data and the total count
          return res.status(200).json({
            status: 1,
            data: [vendorData],
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
            subscription: false,
          });
        }
      } catch (error) {
        console.error('Error in searchVendorController:', error);
        logError(error);
        // Error handling and response
        res.status(500).json({
          success: false,
          message: 'An error occurred while searching for the vendor',
          error: error.message,
        });
      }
    } else {

      // if user is not logged!
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
            "", // responseKeys : function accepting this - need to recheck it's use and remove it if not required 
            productMakes
          );

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
                Array.apply(null, { length: rest_items }).map((item) => {

                });

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
            Promise.all(vendorResult.map((item) => getVendorDetails(item, true)))
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
        data: result?.[0]?.nature_of_business_options ?? [],
      });
    } catch (error) {
      logError(error);
        // Error handling and response
        res.status(500).json({
          success: false,
          message: 'An error occurred while fetching vendor types',
          error: error.message,
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

  processRfqDraftSheetWise: async (processedUrl, user, rfqId = null, sheetId = null, availableSheets) => {
    try {
      
      if (rfqId && !isNaN(parseInt(rfqId)) && sheetId && !isNaN(parseInt(sheetId))) {
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
          if(sheetDetails) {
            sheetDetails = sheetDetails[0];
            processedUrl = sheetDetails.processed_url;
          } else
            processedUrl = rfqDetails.processed_url;

          if (!processedUrl)
            throw new Error('Processed URL does not exist for given Sheet OR RFQ')
        }
      }

      if (process.env.NODE_ENV=='uat' &&  processedUrl.startsWith('http:')) {
        processedUrl = processedUrl.replace('http:', 'https:');
      }
  
      const boqDataJson = await generativeAI.processBOQWithAI(processedUrl);

      const termList = await rfqModel.getAllTerms();
      const transformedTermList = termList.map(term => ({ id: term.id, name: term.term_content }));
  
      const validationErrors = [];
      const products = [];
      const sheetNameList = new Set();
      const globalVariantCount = {};

      const allVariantsCount = await rfqModel.getVariantsCountForRFQ(rfqId);
      if(allVariantsCount && allVariantsCount.length > 0) {
        allVariantsCount.forEach(variantCount => {
          const productId = variantCount.product_variant_id;
          const maxVariant = variantCount.max_variant;

          globalVariantCount[productId] = maxVariant + 1;
        })
      }
  
      const allProductIds = boqDataJson.map(item => item.variant_id).filter(item => typeof item == 'number' || typeof item == 'string');
  
      const uniqueProductIds = [...new Set(allProductIds)];
      const existingProducts = await rfqModel.checkIfExists(
        'tbl_product',
        `id = ANY(ARRAY[${uniqueProductIds.join(',')}])`
      );
      const existingProductIdSet = new Set(existingProducts.map(p => p.id));
  
      const vendorCache = {};
  
      for (const item of boqDataJson) {
        if (item.is_product == "No") {
          continue
       }

        const cleanId = item?.variant_id;
        const productName = item.core_product_name || item.fetched_product_name || 'Unknown Product';
  
        if (!cleanId || item.fetched_product_name === 'Product not found') {
          validationErrors.push({
            errors: { product: `${productName} - Product not found` }
          });
          continue;
        }
  
        const validProductId = existingProductIdSet.has(cleanId) ? cleanId : null;
  
        if (!validProductId) {
          validationErrors.push({
            errors: { product: `${productName} - Product not found` }
          });
          continue;
        }
  
        const finalProductName = item.fetched_product_name || item.core_product_name;

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
              vendor: `${finalProductName} - No Vendors Found` }
          });
          continue;
        }
  
        const variantCount = globalVariantCount[validProductId] ?? 0;
  
        products.push({
          product_id: validProductId,
          name: finalProductName || "Unnamed Product",
          variant: variantCount,
          spec: [
            { title: "Size", value: item.size || "" },
            { title: "Spec", value: item.feature_or_specifications || "" },
            { title: "Quantity", value: item.quantity || 0 },
            { title: "Unit", value: item.unit || "NA" },
          ],
          vendors: vendorResult,
          comment: item.full_product_description || "",
          defaultSelectedVAB: "",
          datasheet: "0",
          datasheet_file: [],
          spec_file: [],
          qap: "0",
          qap_file: [],
          user_selected_predefined_tds: false,
          user_selected_predefined_qap: false,
          sheet_name: item.sheet_name || "",
        });
  
        globalVariantCount[validProductId] = variantCount + 1;
        sheetNameList.add(item.sheet_name || "");
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
        sheetNameList: (availableSheets && availableSheets.length > 0) ? availableSheets.map(sheet => sheet.sheet_name) : Array.from(sheetNameList),
        availableSheets,
      };

      // Send email notification for products or vendors not found
      const hasProductNotFound = validationErrors.some(err => err.errors && err.errors.product);
      const hasVendorNotFound = validationErrors.some(err => err.errors && err.errors.vendor);
      if (hasProductNotFound || hasVendorNotFound) {
        try {
          let emailContent = `
            <h2>Products or Vendors Not Found in WorkWise RFQ Processing</h2>
            <p><strong>User:</strong> ${user.name} (${user.email})</p>
            <p><strong>Organization:</strong> ${user.organization_name || 'N/A'}</p>
            <p><strong>Total Errors:</strong> ${validationErrors.length}</p>
            <h3>Details:</h3>
            <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%;">
              <thead>
                <tr style="background-color: #f0f0f0;">
                  <th>Error Type</th>
                  <th>Product Name</th>
                  <th>Description</th>
                  <th>Size</th>
                  <th>Quantity</th>
                  <th>Unit</th>
                  <th>Sheet Name</th>
                  <th>Error Message</th>
                </tr>
              </thead>
              <tbody>
          `;
          validationErrors.forEach(err => {
            let errorType = err.errors.product ? 'Product Not Found' : (err.errors.vendor ? 'Vendor Not Found' : 'Other');
            let productName = err.name || err.productName || '';
            let description = err.description || '';
            let size = err.size || '';
            let quantity = err.quantity || '';
            let unit = err.unit || '';
            let sheetName = err.sheet_name || '';
            let errorMsg = err.errors.product || err.errors.vendor || '';
            emailContent += `
              <tr>
                <td>${errorType}</td>
                <td>${productName}</td>
                <td>${description}</td>
                <td>${size}</td>
                <td>${quantity}</td>
                <td>${unit}</td>
                <td>${sheetName}</td>
                <td>${errorMsg}</td>
              </tr>
            `;
          });
          emailContent += `
              </tbody>
            </table>
            <p><em>This email was automatically generated by WorkWise RFQ processing system.</em></p>
          `;
          const mailOptions = {
            from: Config.fromMail,
            to: 'siddharth@letsworkwise.com',
            cc: ['sayankaworkwise@gmail.com', 'prashant@letsworkwise.com'],
            subject: `WorkWise RFQ: ${validationErrors.length} Products or Vendors Not Found - ${user.organization_name || user.name}`,
            html: emailContent
          };
          sendMail(mailOptions);
        } catch (emailError) {
          logError('Error sending product/vendor not found email:', emailError);
        }
      }

      return [validationErrors, finalObject];
    }
    catch (error) {
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

  // mukul - 21-05-2025, removed file handling as now we just get json url in request, also reviewed we handling many fields in payload but in api call we just get json url, not removing them now as very soon we start this flow enhancements
  // Kushal - 21-05-2025, Highly optimized to handle large datasets
  // Kushal - 23-05-2025, Completed Sheet wise processing while saving Draft of Magic Search
  magicSearchRfqCreate: async (req, res, next) => {
    try {
      let aiProcessedBoqJson = req.body.jsonFileUrl;
      let availableSheets = req.body.availableSheets;
      const user = req.user;

      if(availableSheets && availableSheets.length > 0) {
        aiProcessedBoqJson = availableSheets[0]?.download_url ?? aiProcessedBoqJson
      }
  


      const [validationErrors, processedData] = await rfqController.processRfqDraftSheetWise(aiProcessedBoqJson, user, null, null, availableSheets)

      const savedRfq = await saveMagicSearchInDraft(processedData, req.user.id, aiProcessedBoqJson)
      const sheets = await rfqModel.getSheetsForDraftRfq(savedRfq)
  
      return res.status(200).json({
        status: 1,
        savedRfq,
        sheets,
        data: processedData, // Whole data will not be returned, client will request again for the first sheet's data from the backend after the initial save
        validation_errors: validationErrors.length ? validationErrors : null,
      });
  
    } catch (error) {
      logError(error);
      return res.status(500).json({
        success: false,
        message: 'Magic search failed to complete the action, Please try again.',
        error: error.message,
      });
    }
  },

  processMagicSearchDraft: async (req, res, next) => {
    try {
      const {rfqId, sheetId} = req.query;
      const user = req.user;


      if(!rfqId || isNaN(parseInt(rfqId))) {
        
        return res.status(400).json({
          status: 0,
          success: false,
          message: 'RFQ Id is required to process a draft sheet!'
        });
      }
      
      if(!sheetId || isNaN(parseInt(sheetId))) {
        
        return res.status(400).json({
          status: 0,
          success: false,
          message: 'Sheet Id is required to process a draft sheet!'
        });
      }
      try {
        const [,processedData] = await rfqController.processRfqDraftSheetWise(null, user, rfqId, sheetId);
        const savedRfq = await saveMagicSearchInDraft(processedData, req.user.id, null, rfqId, sheetId);
        
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
        message: 'Failed to fetch drafted RFQ data, either the sheet id is invalid or this rfq is no longer available!',
        error: error.message
      });
    }
  },

  getDraftRfqSheetWise: async (req, res) => {
    try {
      let { rfqId, sheetId } = req.query;

      if(!rfqId || isNaN(parseInt(rfqId)) || parseInt(rfqId) < 0) {
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

      if(!sheets || !sheets.length > 0) {
        return res.status(200).json({
          status: 0,
          success: false,
          message: 'No sheets found for this RFQ',
          sheets: []
        });
      }
      
      // Validate and select sheetId
      if(!sheetId || isNaN(parseInt(sheetId)) || parseInt(sheetId) < 0) {
        sheetId = sheets[0].id;
      } else {
        sheetId = parseInt(sheetId);
      }

      // Verify the sheet exists for this RFQ
      let sheetData = await rfqModel.checkIfExists('tbl_rfq_draft_sheets', `rfq_id = ${rfqId} AND id = ${sheetId}`);
      
      if(!sheetData || !sheetData.length > 0) {
        return res.status(400).json({
          status: 0,
          success: false,
          message: 'Sheet does not exist, either it is inactive or does not exist!',
          sheets
        });
      }

      sheetData = sheetData[0];

      // Process unprocessed sheet if needed
      if(!sheetData.is_processed) {
        try {
          const [,processedData] = await rfqController.processRfqDraftSheetWise(null, req.user, rfqId, sheetId);
          await saveMagicSearchInDraft(processedData, req.user.id, null, rfqId, sheetId);
        } catch (error) {
          console.log(error)
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
        message: 'Failed to fetch drafted RFQ data, either the sheet id is invalid or this rfq is no longer available!',
        error: error.message
      });
    }
  },

  getRfqDraftSheets: async (req, res) => {
    try {
      const { rfqId } = req.query;

      if(!rfqId || isNaN(rfqId) || parseInt(rfqId) < 0) 
        return res.status(400).json({
          success: false,
          message: 'RFQ id is invalid, please provide a valid RFQ id!',
        });

      const sheets = await rfqModel.getSheetsForDraftRfq(rfqId)

      return res.status(200).json({
        status: 1,
        sheets,
      });

    } catch (error) {
      console.log(error)
      logError(error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch drafted RFQ data, either the sheet id is invalid or this rfq is no longer available!',
        error: error.message,
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
      term_and_condition_files
    } = req.body;

       // Determine the user ID to check based on the verification status
    const withoutLoginUserToken = !req.is_verified ? req.query.token : null;

    if (withoutLoginUserToken) {
      // Check if the token exists
      const tokenData = await rfqModel.checkIfExists("tbl_vendor_rfq_tokens_non_login", `token = '${withoutLoginUserToken}'`);

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
      const userData = await rfqModel.checkIfExists("tbl_users", `id = ${tokenData[0].vendor_id}`);

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
    if (
      !products.every((product) => product.product_id)
    ) {
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
      const bidEndDate = rfqDetails[0].bid_end_date ? new Date(rfqDetails[0].bid_end_date) : null;
      const raStartDate = rfqDetails[0].ra_start_date ? new Date(rfqDetails[0].ra_start_date) : null;
      const raEndDate = rfqDetails[0].ra_end_date ? new Date(rfqDetails[0].ra_end_date) : null;
      const isReverseAuction = rfqDetails[0].reverse_auction === 1;
      
      // Create end of day date for bid end date (to match frontend logic)
      const bidEndDateEndOfDay = bidEndDate ? new Date(bidEndDate.getFullYear(), bidEndDate.getMonth(), bidEndDate.getDate(), 23, 59, 59, 999) : null;

      // Check if RFQ is closed (highest priority)
      if (rfqDetails[0].status === 2) {
        return res.status(400).json({
          status: 3,
          message: 'RFQ is Closed'
        });
      }

      // Check if reverse auction is active (second priority)
      const isReverseAuctionActive = isReverseAuction && raStartDate && raEndDate && now >= raStartDate && now <= raEndDate;

      // If reverse auction is active, allow quote submission
      if (isReverseAuctionActive) {
        // Continue with quote submission - this is allowed
      }
      // Otherwise check other conditions
      else {
        // Check if all products are finalized
        const productsFinalized = await rfqModel.checkAllProductsFinalized(quoteExists[0].rfq_id, user.id);
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
          products.map((product) => {
            if ((product.comment == "" && product.document_files?.length <= 0) && (product.unit_price=='' || product.unit_price==0)) {
              return null;
            }
            return rfqModel.updateQuoteItemWithHistory(quoteId, product,quoteExists[0]);
          }).filter(Boolean)
        );

        // console.log("mj ", quoteItemChanges)

      // Check if global terms & conditions file are uploaded
      if (term_and_condition_files && term_and_condition_files.length > 0) {
        const global_files = term_and_condition_files.map(url => ({
          quote_id: quoteId,
          file_type: 'term_and_condition',
          file_url: url
        }));
        for (const fileData of global_files) {
          await rfqModel.insert('tbl_quotes_files', fileData);
        }
      }


      // Insert new document_files for each product if exists
      const fileUpdates = await Promise.all(
        products.map(async (prodItem) => {
          const quote_item = await rfqModel.getQuoteItem(quoteId, prodItem);
          const file_links = prodItem.document_files;

          if (file_links && file_links.length > 0) {
            const file_records = file_links.map(link => ({
              quote_item_id: quote_item.id,
              file_type: "DOC",
              file_url: link,
              created_at: new Date()
            }));

            if (file_records.length > 0) {
              return rfqModel.insertArray(file_records, ['quote_item_id', 'file_type', 'file_url', 'created_at'], 'tbl_quote_item_files');
            }
          }
        })
      );

      const anyQuoteChanged = fileUpdates || quoteItemChanges.some((result) => result.changed);
      // const changedProducts = quoteItemChanges.filter((result) =>  result.changed);
      // console.log(" quoteItemChanges ", changedProducts)

      let status = true;
      if (!anyQuoteChanged && !paymentTermAndCommentChanges) {
        status = false;
      }

      if(status){
        const buyerDetails =  await rfqModel.getRFQCreatedBy(rfq_id) 
        await sendRevisedQuotationEmailToVendor(buyerDetails, user, rfq_id, rfq_no)
        await sendRevisedQuotationEmailToBuyer(buyerDetails, quoteItemChanges, user, rfq_id, rfq_no)
      }

      return res.status(200).json({
        status: status,
        message: status ? 'Quote items updated successfully' : "No updates made as the quotes and global terms remain unchanged",
        data: {
          quoteItems: quoteItemChanges,
          globalFilesAdded: fileUpdates,
          globalTermComment: paymentTermAndCommentChanges ? "global comment and payment term is updated" : "global comment and payment term is remain unchanged"
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
          message: 'you are not login',
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

      const { search_key } = req.body
      const user_id = req.user.id;

      // find product price stats like, min, avg, max
      const priceHistoryMarket = await rfqModel.productPriceStatsMarket(search_key);
      const priceHistoryPersonal = await rfqModel.productPriceStatsLastQuoteAndFinilizeForUser(search_key, user_id);

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
      res
        .status(500)
        .json({
          success: false,
          message: 'error in finding product price stats',
          error: error.message,
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

    const result = await rfqModel.insertReturnId('tbl_query_messages', data);
    const message_id = result[0].id;

    const filesData = files.map(file => ({
      message_id: message_id,
      file_name: file.originalname,
      file_url: file.location
    }));
    // console.log("--------------------->filedata", filesData);

    if (filesData.length) await rfqModel.insertArray(filesData, ['message_id', 'file_name', 'file_url'], 'tbl_query_message_files');

    const sender_details = await userModel.user_profile_detail(sender_id);
    const senderDetails = sender_details[0];

    const receiver_details = await userModel.user_profile_detail(receiver_id);
    if (receiver_details.length > 0) {
      const receiverDetails = receiver_details[0];
      const spocList = await vendorModel.getSpocDetails(receiver_id);


      const headerContent = ` <div>
           <h2>Hello ${receiverDetails?.organization_name || receiverDetails?.name} </h2>
           </div>`;


           const containerContent = `
              <div>
                <div style="font-size:16px;">
                  ${sender_type == 2 ?
                   `${senderDetails?.organization_name || senderDetails?.name} has a question about your submitted quotation for #${rfqNumber}. Quick responses help build trust and increase your chances of closing the order.`:
                    `One of your vendors has a question regarding your RFQ #${rfqNumber}. Here's the vendor details: <br> <strong>Vendor: </strong> ${senderDetails.name}` }
                </div>
                              
               <h4> Query </h4>
                <blockquote style='border-left:3px solid #203367; font-size:16px; margin:10px 0; margin-top:-10px; padding-left:15px; padding:10px; border-radius:10px; background-color:#eef3f6; color:#333333; margin-bottom:30px;'>
                  ${message_text}
                </blockquote>
              
                <a href=${process.env.FRONT_END_WEBSITE}/dashboard/${sender_type == 2 ? "buyer" : "vendor"}/query?rfq_id=${rfq_id}&role=${sender_type == 2 ? "buyer" : "vendor"}
                  style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
                  Respond to Query
                </a>
              
                <p style="font-size:16px; text-align:center;">  
                  ${sender_type == 2 ?
                    "Your quick response can help avoid delays!" :
                    "Thank you for helping ensure a smooth, transparent process."
                  }
                </p>
              </div>
              `;

      const dynamicHTML = generateEmailTemplate(headerContent, containerContent)

    const emailSubject = sender_type==3? `Vendor Query on Your RFQ #${rfqNumber}`:  `Buyer Query for #${rfqNumber} – Your Response Needed`

    const mailRecipients = {
      from: `${senderDetails?.organization_name || senderDetails?.name} ${Config.masterEmail}`,
      subject: emailSubject,
      html: dynamicHTML
    };
    
    if (spocList && spocList.length > 0) {
      mailRecipients.to = spocList.map(spoc => spoc.email);
      mailRecipients.cc = receiverDetails.email;
    } else {
      mailRecipients.to = receiverDetails.email;
    }
    
    sendMail(mailRecipients);
    
    const notificationData = {
      type: 'New Message',
      title: 'New RFQ Message Received',
      message: `You have received a new message from ${senderDetails.name}.`,
      additional_data: { user_type: receiverDetails.user_type }
    };
    const payload = {
      title: `Hello ${receiverDetails.name}`,
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
    res
      .status(500)
      .json({
        success: false,
        message: 'Error in sending message',
        error: error.message,
      });
  }
},

listQueryMessages: async (req, res) => {
  const { rfq_id, receiver_id } = req.body;
  const sender_id = req.user.id;

  try {
      const messages = await rfqModel.getQueryMessages(rfq_id, sender_id, receiver_id);
      res
        .status(200)
        .json({
          status: 1,
          data: messages
        })
        .end();
  } catch (error) {
      logError(error);
      res
        .status(500)
        .json({
          success: false,
          message: 'Error in listing messages for vendor',
          error: error.message,
        });
  }
},

listQueries: async (req, res) => {
  const { rfq_id, user_name } = req.body;
  const user_id = req.user.id;
  const user_type = req.user.user_type;

  try {
      let users;
      
      if ([2, 8, 9, 10].includes(user_type)) {
          const vendorResult = await rfqModel.getVendorsForRfq(rfq_id, user_name);
          users = vendorResult.map(row => row.user_id);
      } else if (user_type === 3) {
          const buyerResult = await rfqModel.getBuyerForRfq(rfq_id);
          users = buyerResult.length ? [buyerResult[0].user_id] : [];
      } else {
          return res.status(400).json({
              success: false,
              message: 'Invalid user type'
          });
      }

      const summaries = await Promise.all(users.map(async (other_user_id) => {
          const summaryResult = await rfqModel.getQueryMessageSummary(rfq_id, user_id, other_user_id);
          return {
              user_id: other_user_id,
              user_name: summaryResult[0]?.user_name || '',
              company_name: summaryResult[0]?.company_name || '',
              unseen_count: summaryResult[0]?.unseen_count || 0,
              last_message: summaryResult[0]?.last_message || '',
              last_message_timestamp: summaryResult[0]?.last_message_timestamp || null
          };
      }));

    summaries.sort((a, b) => {
        if (a.last_message_timestamp === null && b.last_message_timestamp === null) return 0;
        if (a.last_message_timestamp === null) return 1;
        if (b.last_message_timestamp === null) return -1;
        return new Date(b.last_message_timestamp) - new Date(a.last_message_timestamp);
    });

      res.status(200).json({
          status: 1,
          data: summaries
      }).end();

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
      return res.status(400).json({ status: 0, message: "Invalid input. Ensure RFQ_ID and RFQ_PRODUCT_ID are provided" });
    }
    // Use new product/variant name function
    const productName = await rfqModel.getProductOrVariantNameByRfqProductId(rfq_product_id);
    const result = await generativeAI.extractClauses(file, productName);

  const techEvaluationClauses = result?.structuredData?.technicalSpecifications.map(item => {
    if (item?.text) return item.text;
    if (item?.parameter && item?.value) return `${item.parameter}: ${item.value}${item.unit ? ' ' + item.unit : ''}`;
    if (item?.parameter) return `${item.parameter}: ${item.value || ''}${item.unit ? ' ' + item.unit : ''}`;
    return JSON.stringify(item);
  }).filter(Boolean);
  

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
          error:error,
          message: Config.errorText.value
        })
        .end();
  }
},
addClause: async (req, res) => {
  try {
    // console.log("add clause controller");
    const { rfq_id,rfq_product_id, clause_text,file_url } = req.body;
    // console.log("bodyy = ",req.body);

    if (!rfq_id ||!rfq_product_id || !clause_text) {
      return res.status(400).json({
        status: 0,
        message: "Invalid input. Ensure RFQ_ID, rfq_product_id and clauses are provided correctly.",
      });
    }
    // Calling  the model function
    // console.log("add clause controller working");

    const result = await rfqModel.addClause(rfq_id, rfq_product_id, clause_text,file_url );

    res.status(200).json(result).end();
  } catch (error) {
    // console.log("controller error")
    console.error("Error in addClause:", error);
    res.status(500).json({
      success: false,
      message: "Error in adding clauses to technical evaluation.",
      error: error.message,
    });
  }
},

updateClause: async (req, res) => {
  try {
    const {clause_id, clause_text,file_url} = req.body;
    // console.log("data from update clause controller = ",clause_id,clause_text,file_url);

    const result = await rfqModel.updateClause(clause_id, clause_text,file_url);

    res
      .status(200)
      .json(result)
      .end();
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

    res
      .status(200)
      .json(result)
      .end();
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

    const result = await rfqModel.getClauses(rfq_id);
    // console.log("Result main of get clauses = ",result);

    res
      .status(200)
      .json(result)
      .end();
  } catch (error) {
    logError(error);
    res.status(500).json({
        success: false,
        message: 'Error in deleting clause.',
        error: error.message
    });
  }
},

addTechComment: async (req, res) => {
  try{
    const { clause_id, sender_id, receiver_id, text, file_url } = req.body;

    // Save tech comment 
    const response = await rfqModel.addTechComment(clause_id, sender_id, receiver_id, text, file_url);
    res
      .status(200)
      .json(response)
      .end();
  } catch (error) {
    res.status(500).json({
      status: 0,
      message: "Error storing comment.",
      error: error.message,
    });
  }
},

getTechComments: async (req, res) => {
  try{
    const { clause_id, sender_id, receiver_id } = req.body;
    const user_id = req.user.id;
    const user_type = req.user.user_type;

    const response = await rfqModel.getTechComments(clause_id, sender_id, receiver_id, user_id, user_type);
    res
      .status(200)
      .json(response)
      .end();
  } catch (error) {
    res.status(500).json({
      status: 0,
      message: "Error storing comment.",
      error: error.message,
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
        message: "Invalid input. Please provide vendor responses",
      });
    }

    const response = await rfqModel.addVendorResponse(data);

    res
      .status(200)
      .json(response)
      .end();
  } catch (error) {
    console.error("Error in addVendorResponse API: ", error.message);
    res.status(500).json({
      status: 0,
      message: "Error processing vendor response.",
      error: error.message,
    });
  }
},

addtechEvaluationClearedVendors: async (req, res) => {
  try {
    const {vendor_id, rfq_product_tech_evaluation_id,status, reject_message} = req.body;
    // console.log("API Input: ", vendor_id,rfq_product_tech_evaluation_id,status,reject_message);
    const user_id = req.user.id

    // Validate input
    if (!vendor_id || !rfq_product_tech_evaluation_id ) {
      return res.status(400).json({
        status: 0,
        message: "Invalid input. Please provide vendor ID , rfq_product_tech_evaluation_id and status",
      });
    }

    const response = await rfqModel.addtechEvaluationClearedVendors(vendor_id, rfq_product_tech_evaluation_id,status, reject_message, user_id);

    res
      .status(200)
      .json(response)
      .end();
  } catch (error) {
    console.error("Error in addVendorResponse API: ", error.message);
    res.status(500).json({
      status: 0,
      message: "Error processing vendor response.",
      error: error.message,
    });
  }
},

getVendorNames: async (req, res) => {
  try {
    const {rfq_id, rfq_product_id} = req.body;
    // console.log("API Input: ", req.body);

    // Validate input
    if (!rfq_id || ! rfq_product_id) {
      return res.status(400).json({
        status: 0,
        message: "Invalid input. Please provide RFQ ID and rfq_product_id",
      });
    }

    const response = await rfqModel.getVendorNames(rfq_id, rfq_product_id);

    res
      .status(200)
      .json(response)
      .end();
  } catch (error) {
    console.error("Error in addVendorResponse API: ", error.message);
    res.status(500).json({
      status: 0,
      message: "Error processing vendor response.",
      error: error.message,
    });
  }
},
getVendorResponses: async (req, res) => {
  try {
    const {rfq_id, rfq_product_id, vendor_id} = req.body;
    // console.log("API Input: ", req.body);

    // Validate input
    if (!rfq_id || ! rfq_product_id || !vendor_id) {
      return res.status(400).json({
        status: 0,
        message: "Invalid input. Please provide RFQ ID and rfq_product_id and Vendor ID",
      });
    }

    const response = await rfqModel.getVendorResponses(rfq_id, rfq_product_id, vendor_id);

    res
      .status(200)
      .json(response)
      .end();
  } catch (error) {
    console.error("Error in addVendorResponse API: ", error.message);
    res.status(500).json({
      status: 0,
      message: "Error processing vendor response.",
      error: error.message,
    });
  }
},

getTechEvaluationRFQDetails: async (req, res) => {
  try {

    const user_id = req.user.id;    

    let {rfq_no, project_id} = req.body;

    if(!project_id || project_id==-1){
      project_id=null;
    }

    // Validate input
    if (!user_id) {
      return res.status(400).json({
        status: 0,
        message: "User not found!",
      });
    }


    const response = await rfqModel.getTechEvaluationRFQDetails(user_id, rfq_no, project_id);


    res
      .status(200)
      .json(response)
      .end();
  } catch (error) {
    console.error("Error in addVendorResponse API: ", error.message);
    res.status(500).json({
      status: 0,
      message: "Error processing vendor response.",
      error: error.message,
    });
  }
},

getClausesOfProduct: async (req, res) => {
  try {
    const {rfq_product_id, vendor_id = null} = req.body;

    const result = await rfqModel.getClausesOfProduct(rfq_product_id, vendor_id);

    res
      .status(200)
      .json(result)
      .end();
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
    const {rfq_product_id, vendor_id} = req.body;

    // Validate input
    if (!rfq_product_id || !vendor_id) {
      return res.status(400).json({
        status: 0,
        message: "Invalid input. Please provide RFQ ID and RFQ product ID",
      });
    }

    const result = await rfqModel.getTechEvaluationResult(rfq_product_id,vendor_id);

    res
      .status(200)
      .json(result)
      .end();
  } catch (error) {
    logError(error);
    res.status(500).json({
        success: false,
        message: 'Error in deleting clause.',
        error: error.message
    });
  }
},

rfqProductWiseReport: async (req, res) => {
  try {
    const { startDate, endDate ,productName, productId} = req.query;
    const userId = req.user.id;


    const rfqData = await rfqModel.rfqProductReport(userId, productId, productName, startDate, endDate);

    res
      .status(200)
      .json(rfqData)
      .end();
  } catch (error) {
    console.log(error)
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


    const rfqDetails = await rfqModel.getProjectDetailsReport(projectId, startDate, endDate);
    const  quoteList = []

    //  fetch quotes for each rfq preent in the project
    for (let i = 0; i < rfqDetails.length; i++) {
      for (let j = 0; j < rfqDetails[i].rfq_details.length; j++) {
        const rfqId = rfqDetails[i].rfq_details[j].rfq_id;
        let quoteDetails = await rfqModel.getQuotesByRfqById2(rfqId, userId, false);
        quoteList.push(quoteDetails)
      }
    }

    res.status(200).json({quoteList: quoteList,  rfqDetails:rfqDetails});
  } catch (error) {
    console.error("Error fetching project report:", error);
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
    const {emails, startDate, endDate} = req.body // Assuming 'emails' is a comma-separated list passed as a query parameter
    const file = req.file;  // Assuming file data is sent via a multipart/form-data request
    const fileName = file?.originalname?.split(".")[0] || "report"
    const userDetails = req.user

    const headerContent = ` <p style="height:10px " > </p> `;

    const containerContent =  `
       <h2>Greetings,</h2>
        <div style=" font-size:16px ">
        <p>Please find attached the zipped folder containing the complete data set for <strong> ${fileName}  </strong> covering the period <strong> ${ startDate + " to " +  endDate } </strong>. This report includes all relevant RFQ records, Quotes, and transaction logs compiled for auditing and review purposes.</p>
        <p>If you have any questions or need additional information, please feel free to reach out.</p>
        <p>Thank you for your time and consideration.</p>
        <p>Best regards,</p>
        <p>${userDetails.name}<br>
        ${userDetails.organization_name}</p>
    </div>
    `

    const emailTemplate = generateEmailTemplate(headerContent, containerContent);


    // Preparing email options with an attachment
    const mailOptions = {
      from: Config.webmasterMail, // Sender address
      to: emails, // Sending email to all recipients directly from the query string
      subject: `Project Report for ${fileName} of ${userDetails.organization_name || userDetails.name} `,     // subject: `${file.originalname.split(".")[0] || "Project Report"} || Workwise ` , // Subject line
      html: emailTemplate, // HTML body content
     attachments: [
        {
          filename: file.originalname,  // Using original file name
          content: file.buffer          // Assuming the file is available as a buffer
        }
      ]
    };

    // Sending the email with the attachment
    sendMail(mailOptions);

    res.status(200).json({ message: "Report sent successfully." });

  } catch (error) {
    console.error("Error fetching project report:", error);
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
    const variantProductResults = await rfqModel.searchVariantProducts(search_key);
    
    if (!variantProductResults || variantProductResults.length === 0) {
      return res.status(200).json([]).end();
    }
    
    res.status(200).json(variantProductResults).end();
  } catch (error) {
    logError(error);
    res.status(400).json({
      status: 3,
      message: Config.errorText.value
    }).end();
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
    const variantVendorResults = await rfqModel.searchVariantVendors(product_id, variant_id);
    
    if (!variantVendorResults || variantVendorResults.length === 0) {
      return res.status(200).json([]).end();
    }
    
    res.status(200).json(variantVendorResults).end();
  } catch (error) {
    logError(error);
    res.status(400).json({
      status: 3,
      message: Config.errorText.value
    }).end();
  }
},

getClausesByRfqProductId: async (req,res) =>{
    try{
        const {rfq_id, rfq_product_id, vendor_id} = req.body;

        if (!rfq_product_id) {
            return res.status(400).json({
                status: 0,
                message: "Invalid input. Ensure RFQ_PRODUCT_ID is provided.",
            });
        }
        // Changes by Agnij May 13, 2025 [Fixed clause display limitation]
        const result = await rfqModel.getClausesOfProduct(rfq_product_id, vendor_id);

        res.status(200).json(result).end();

    }catch(error){
        logError(error);
        res.status(500).json({
            success: false,
            message: 'Error in fetching clauses by rfq product id',
            error: error.message
        });
    }
},

};
export default rfqController;
