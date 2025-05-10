import Config from '../../config/app.config.js';
import {
  logError,
  sendMail,
  getDateRange
} from '../../helper/common.js';
import rfqModel from '../../models/rfqModel.js';
import userModel from '../../models/userModel.js';
import { sendNotification } from '../../services/notificationService.js';
import excelJS from 'exceljs';
import xlsx from 'xlsx';
import vendorModel from '../../models/vendorModel.js';
import projectModel from '../../models/projectModel.js';
import whatsappNotificationFluxChat from '../../helper/whatsappNotificationFluxChat.js';
import { generateEmailTemplate } from '../../helper/notificationEmailLayout.js';
import fs from 'fs';
import productModel from '../../models/productModel.js';
import generativeAI from '../../helper/processBOQWithAI.js';
import { setupReverseAuctionMails } from '../../helper/sendEmailFunctions/raEmailScheduler.js';
import { setupReverseAuctionWhatsAppNotifications } from '../../helper/sendWhatsAppFunctions/sendWhatsappNotification.js';




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

/* function processQuotations(data) {
  // Group by product_id
  const grouped = data.reduce((acc, item) => {
    if (!acc[item.product_id]) {
      acc[item.product_id] = [];
    }
    acc[item.product_id].push(item);
    return acc;
  }, {});

  // Filter quotations
  Object.keys(grouped).forEach((product_id) => {
    const items = grouped[product_id];
    if (items.length === 2) {
      items.forEach((item, idx) => {
        if (idx === 0) {
          item.quotations = item.quotations.filter((_, i) => i % 2 === 0);
        } else {
          item.quotations = item.quotations.filter((_, i) => i % 2 !== 0);
        }
      });
    }
  });

  return data;
} */

/* function processQuotations(data) {
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
        if (idx === 0) {
          item.quotations = item.quotations.filter((_, i) => i % 2 === 0);
        } else if (idx === 1) {
          item.quotations = item.quotations.filter((_, i) => i % 2 !== 0);
        }
        // For idx > 1, keep all quotations
      }
    });
  });

  return data;
} */

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
  created_rfq_id
) => {
  try {
    let tbl_rfq_products_data = {
      product_variant_id: product_id,
      variant,
      comment,
      datasheet,
      spec_file:'',// this field we have to remove from database
      qap_file:'',// this field we have to remove from database
      rfq_id: created_rfq_id,
      datasheet_file:"",// this field we have to remove from database
      qap
    };

    let spec_array = spec?.map((item) => {
      item.rfq_id = created_rfq_id;
      item.product_variant_id = product_id;
      item.variant = variant;
      return item;
    });
    const spec_keys = ['title', 'value', 'rfq_id', 'product_variant_id', 'variant'];

    const vendor_keys = ['user_id', 'rfq_id', 'product_variant_id', 'variant'];
    var vendor_array = [];
    if (vendors.length > 0) {
      vendor_array = vendors.map((item) => {
        item.rfq_id = created_rfq_id;
        item.product_variant_id = product_id;
        item.variant = variant;
        return item;
      });
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
    if (vendors.length > 0) {
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

console.log({ product_info: productResult[0], spec_info, vendor_info })
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

const sendMailEachVendor = async (vendor, user, rfqNumber, products) => {
  try {
    let organization_name = user?.organization_name || user?.name;

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
               Submit your quote promptly to access this opportunity with [Buyer Name] and stand out as a preferred vendor.
      </p>

        </div>`;

        const dynamicHTML = generateEmailTemplate(headerContent, containerContent)
        const org_name = user_details[0].organization_name || user_details[0].name || ""
       let mailRecipients = {
        from: `${organization_name} ${Config.masterEmail}`,
        subject: `New RFQ Opportunity from ${organization_name}`,
        html: dynamicHTML
      };

      if (spocList && spocList.length > 0) {
        mailRecipients.to = spocList.map(spoc => spoc.email);
        mailRecipients.cc = user_details[0].email;
      } else {
        mailRecipients.to = user_details[0].email;
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
    const { products } = req.body;
    const vendorProductMap = {};

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
    cc:"mukul@letsworkwise.com",
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

  const dynamicHTML = generateEmailTemplate(headerContent, containerContent)

    const spocList = await vendorModel.getSpocDetails(user_details[0]?.id)


    let mailRecipients = {
      from:  `${vendorName} ${Config.masterEmail}`,
      subject: `Work Wise | Reminder for Quotation | Action Required`, // Subject line
      html: dynamicHTML
    };
    if (spocList && spocList.length > 0) {
      mailRecipients.to = spocList.map(spoc => spoc.email);
      mailRecipients.cc = user_details[0].email;
    } else {
      mailRecipients.to = user_details[0].email;
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
        to: buyer.email,
        subject: `New Quotation Received for Your RFQ ${rfq_no}`,
        html: dynamicHTML
      };

      // Sending the email to the buyer
      sendMail(mailRecipients);

      console.log(`Quotation update email sent to buyer: ${buyer.email}`);
    }
  }


  //  vendorData, rfq_id, rfq_no, buyerName
  const sendRfqUpdatedMailToVendors = async (vendorData, rfq_id, rfq_no, buyer_name, updated_data) => {
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
          mail.bcc = "mukuljatav1010+if@gmail.com";
        } else {
          mail.to = vendor_email || '';
          mail.bcc = "mukuljatav1010+else@gmail.com";
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
      comment,
      company_name,
      contact_name,
      contact_number,
      bid_end_date,
      location,
      products,
      terms,
      rfq_type,
      reverse_auction,
      ra_start_date,
      ra_end_date,
      project_id,
      term_and_condition_files
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
  }

  await rfqModel.update('tbl_rfq', rfqData, rfq_id);
  await rfqModel.updateWithTimestamp('tbl_rfq', rfqData, rfq_id);


  // Only delete product-related records, preserve terms
  await Promise.all([
      rfqModel.deleteWithReturnIds('tbl_rfq_files', { rfq_id, file_type: 'term_and_condition' }),
      rfqModel.deleteWithReturnIds('tbl_rfq_product_vendors', { rfq_id }),
      rfqModel.deleteWithReturnIds('tbl_rfq_products_specs', { rfq_id })
  ]);

  const rfqProductIds = await rfqModel.deleteWithReturnIds('tbl_rfq_products', { rfq_id });
  if (rfqProductIds.length > 0) {
      await rfqModel.deleteProductFilesByIds(rfqProductIds);
  }

  // Handle terms update
  if (terms && terms.length > 0) {
      // First delete existing terms
      await rfqModel.deleteWithReturnIds('tbl_rfq_terms_map', { rfq_id });

      // Then insert new terms
      const rfqTerms = terms.map(term => ({
          rfq_id,
          terms_id: typeof term.id === 'number' ? term.id : parseInt(term.id)
      }));
      await rfqModel.insertArray(rfqTerms, ['rfq_id', 'terms_id'], 'tbl_rfq_terms_map');
  }

  if (term_and_condition_files && term_and_condition_files.length > 0) {
      const rfqFiles = term_and_condition_files.map(url => ({
          rfq_id,
          file_type: 'term_and_condition',
          file_url: url
      }));
      await rfqModel.insertArray(rfqFiles, ['rfq_id', 'file_type', 'file_url'], 'tbl_rfq_files');
  }

  if (products && products.length > 0) {
    await Promise.all(
      products.map(async (product) => {
        const insertResult = await insertProduct(product, rfq_id);
        const oldProductId = product.id;
        const newProductId = insertResult.product_info.id;

        await updateRfqProductIdInTechEvaluation(oldProductId, newProductId);
      })
    );
  }

  return { status: 1, message: 'Draft saved successfully', rfq_id };
};

const rfqController = {
  create: async (req, res, next) => {
    if (!req.user.subscription_plan_id) {
      res.status(400).json({
        status: 3,
        message: 'You need to purchase subscription to create RFQ'
      }).end();
      return;
    }

    try {
      let {
        rfq_id,
        comment,
        company_name,
        contact_name,
        contact_number,
        bid_end_date,
        location,
        rfq_type,
        reverse_auction,
        project_id,
        ra_start_date,
        ra_end_date
      } = req.body;
      const response_email = req.body.response_email?.toLowerCase();
      const is_update = !!rfq_id;
      const user_id = req.user.id;
      const { products } = req.body;


    if (!rfq_id) {
      const nextRFQNumber = await getNextRfQNumber();

      const tbl_rfq_data = {
        comment,
        company_name,
        response_email,
        contact_name,
        contact_number,
        bid_end_date,
        location,
        is_published: 0,
        rfq_type,
        rfq_no: nextRFQNumber,
        created_by: user_id,
        updated_by: user_id,
        reverse_auction,
        ra_start_date,
        ra_end_date
      };

      if (project_id != -1) {
        tbl_rfq_data.project_id = project_id;
      }

      const responseInsert = await rfqModel.insert('tbl_rfq', tbl_rfq_data);

      if (responseInsert.length > 0) {
        req.body.rfq_id = responseInsert[0].id;
        rfq_id = responseInsert[0].id;

        const savedRfq = await rfqModel.getRFQDetails(rfq_id);
      }
    }

    await saveRfqDraft(user_id, req.body);

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




            // Step 1: Build map with vendorId as key
            const vendorProductMap = new Map();

     products.forEach((product) => {
        if (product.vendors && Array.isArray(product.vendors)) {
          product.vendors.forEach((vendor) => {
            if (vendorProductMap.has(vendor.user_id)) {
              vendorProductMap.get(vendor.user_id).products.push(product.name);
            } else {
              vendorProductMap.set(vendor.user_id, {
                name: vendor.name,
                products: [product.name]
              });
            }
          });
        }
      });

      // Step 2: Prepare final array with mobile numbers
      const finalArray = [];

      for (const [vendorId, vendorData] of vendorProductMap.entries()) {
        const vendorDetails = await rfqModel.getVendorDetailsByUserId(vendorId);

        finalArray.push({
          vendor_id: vendorId,
          rfq_id,
          vendor: vendorDetails.name,
          products: vendorData.products.join(', '),
          vendorMobile: vendorDetails.mobile || '',
          vendorEmail: vendorDetails.email || '',
        });
      }
      if (reverse_auction == 1) {

        // FORCE set auction start date to today if not provided or empty
        if (!ra_start_date || ra_start_date === '') {
          ra_start_date = new Date().toISOString().split('T')[0];
          throw new Error('Please provide reverse auction start date');
        }

        if ((!ra_end_date || ra_end_date === '') && bid_end_date) {
          throw new Error('Please provide reverse auction end date');
        }

  const timezone = process.env.TIMEZONE || 'Asia/Kolkata';
        const buyer_name = req.user.name || '';
        const buyer_email = req.user.email || '';
        const project = await rfqModel.getProjectNameById(project_id);
        const project_name = project[0]?.name || 'Project';

        setupReverseAuctionMails(
          finalArray,
          company_name,
          reverse_auction,
          ra_start_date,
          ra_end_date,
          bid_end_date,
          timezone,
          buyer_name,
          buyer_email,
          project_name
        );
   setupReverseAuctionWhatsAppNotifications(
          finalArray,
          company_name,
          reverse_auction,
          ra_start_date,
          ra_end_date,
          bid_end_date,
          timezone,
          buyer_name,
          project_name,
          contact_number
        );
      } else {
        ra_start_date = null;
        ra_end_date = null;
      }
  res.status(200).json({
       status: 1,
        data: responseUpdate[0],
        mail_sent: true
      }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({
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

      const data = req.body;

      const rfq_id = data.rfq_id;
      delete data.rfq_id; // Remove rfq_id from update fields

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
      if ('project_id' in data && data.project_id !== null && data.project_id !== undefined) {
        data.project_id = parseInt(data.project_id);
      } else {
        delete data.project_id; // Avoid updating with undefined/null
      }

      // get rfq vendors list
      let vendors = await rfqModel.gerRFQVendors(rfq_id);
      let vendorIdList  = vendors.map(vendor => vendor.user_id);

      // get vendor details along with spoc
      const vendorData = await vendorModel.getVendorsWithSpocsAndToken(vendorIdList, rfq_id)

      // get vendor details along with spoc
      const updatedData = await rfqModel.updateWithTimestamp('tbl_rfq', data, rfq_id);

      await sendRfqUpdatedMailToVendors(vendorData, rfq_id, rfq_no, buyerName, data);

      res.status(200).json({
        status: 1,
        data: updatedData || {},
        vendors: vendorData,
        rfqDetails:rfqDetails,
        message: 'RFQ updated successfully'
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
      res.status(500).json({
        status: 3,
        message: 'An error occurred while saving the draft'
      });
    }
  },

  getRFQDraftData: async (req, res) => {
    try {
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

  createOrUpdateRfqDraftWithProductVendors : async (req, res) => {
    try {
        const user_id = req.user.id;

        const user = await userModel.userinfo(user_id);
        if (!user) {
            return res.status(404).json({ status: 2, message: 'User not found' });
        }

        //Check for existing RFQ drafts
        const rfqList = await rfqModel.findAll('tbl_rfq', { is_published: 0, created_by: user_id });

        let rfq_id;
        let rfqData;

        if (rfqList.length > 0) {

            rfqData = rfqList[0];
            rfq_id = rfqData.id;
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
            datasheet_file: ""
        };

        await rfqModel.insert('tbl_rfq_products', productData);

        const vendorPromises = product.vendors.map(async (vendor) => {

            const vendorData = {
                rfq_id,
                product_variant_id: product.variant_id,
                user_id: vendor.vendor_id,
                variant: variant
            };
            return await rfqModel.insert('tbl_rfq_product_vendors', vendorData);
        });

        await Promise.all(vendorPromises);

        res.status(200).json({
            status: 1,
            message: 'RFQ draft created/updated successfully',
            rfq_id
        });

    } catch (error) {
        logError("Error while creating or updating RFQ with products:", error);
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
            product_id: product_id,
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


    try {
      if (req.user.user_type == 2) {
        // for buyer
        // check if the buyer created the rfq
        let created_by = await rfqModel.getRFQCreatedBy(id);
        if (created_by.length > 0 && created_by[0].email == req.user.email) {
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
      } else if (req.user.user_type == 3) {
        // check if the vendor is responsible for this RFQ
        let availability = await rfqModel.checkVendorRFQResponsibility(
          id,
          req.user.id
        );
        if (availability.length > 0) {
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
    let { vendors } = req.body;
    console.log(vendors);
    try {
      const vendorsList = await rfqModel.getVendors(vendors);
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
            // For each product, check if it has technical evaluation and if the vendor is accepted
            // Changes by Agnij 2024-06-14 [Enhanced validation to check all products]
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
            `rfq_id=${rfq_id} AND created_by=${user.id} LIMIT 1`
          );
          if (alreadyExists.length > 0) {
            res
              .status(400)
              .json({
                status: 3,
                message: 'Quote is alredy present for this RFQ!'
              })
              .end();
            return;
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
              let quote_rsp = await rfqModel.insert('tbl_quotes', tbl_quotes_data);
              const created_quote_id = quote_rsp[0].id;

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
              await rfqModel.insertArray(
                quote_items_data,
                quote_items_keys,
                'tbl_quote_items'
              );
              res
              .status(200)
              .json({
                status: 3,
                message: 'Your quote is regretted.',
                regret_reason: regret_reason,
                data: quote_rsp
              })
              .end();
              return;

            }

            // if quote item data is empty because of errors
            if(quote_items_data.length < 1){
              res
              .status(200)
              .json({
                status: 3,
                message: 'Not able to send the Quote'
              })
              .end();
              return;
            }

          // Insertion of the quote
          let quote_rsp = await rfqModel.insert('tbl_quotes', tbl_quotes_data);
          if (quote_rsp.length > 0) {

            const created_quote_id = quote_rsp[0].id;

            if (term_and_condition_files && term_and_condition_files.length > 0) {
              const quote_files = term_and_condition_files.map(url => ({
                quote_id:created_quote_id,
                file_type: 'term_and_condition',
                file_url: url
              }));
              for (const fileData of quote_files) {
                await rfqModel.insert('tbl_quotes_files', fileData);
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
              'tbl_quote_items'
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
                  await rfqModel.insertArray( file_records, ['quote_item_id', 'file_type', 'file_url', 'created_at'], 'tbl_quote_item_files'
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


            res
              .status(200)
              .json({
                status: 1,
                data: quotes_items[0],
              })
              .end();
          } else {
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
          message: Config.errorText.value
        })
        .end();
    }
  },
  getQuotesByRfqById: async (req, res, next) => {
    let rfq_id = req.params.id;
    const {TA_Vendors} =req.query
    const { id } = req.user;

    try {
      let rfQItem = await rfqModel.getQuotesByRfqById2(rfq_id, id, TA_Vendors);
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
    const {TA_Vendors} = req.query

    const { id } = req.user;

    try {
      let rfQItem = await rfqModel.getQuotesByRfqByIdByProduct(rfq_id, id, TA_Vendors);

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



      // rfQItem = processQuotCompare(rfQItem);

      // let rfqDATA = [];
      // if (rfQItem.length > 0) {
      //   rfqDATA = rfQItem.map((item) => {
      //     let base = item.all_vendors;
      //     let data = item.quotations;
      //     let quotes_unavailable_vendors = base.filter(
      //       (baseitem) => !data.find((d) => d.created_by == baseitem.id)
      //     );
      //     item.quotes_unavailable_vendors = quotes_unavailable_vendors;

      //     if (quotes_unavailable_vendors.length > 0) {
      //       quotes_unavailable_vendors.map((q_item) => {
      //         item.quotations.push({
      //           id: null,
      //           timestamp: null,
      //           status: 1,
      //           created_by: q_item.id,
      //           is_regret: null,
      //           quote_details: [],
      //           vendor_details: [q_item]
      //         });
      //       });
      //     }
      //     item.quotations.sort((a, b) => a.created_by - b.created_by);
      //     if (quotes_unavailable_vendors.length > 0) {
      //       quotes_unavailable_vendors.map((q_item) => {
      //         item.quotations.push({
      //           id: null,
      //           timestamp: null,
      //           status: 1,
      //           created_by: q_item.id,
      //           is_regret: null,
      //           quote_details: [],
      //           vendor_details: [q_item]
      //         });
      //       });
      //     }
      //     item.quotations.sort((a, b) => a.created_by - b.created_by);

      //     return item;
      //   });
      // }
      res
        .status(200)
        .json({
          status: 1,
          data: rfQItem
        })
        .end();
      //const rfQItem = await rfqModel.getQuotesByRfqById(rfq_id, id);
      // Get all RFQs
      // const listRfq = await rfqModel.getAllBuyerRfq(100000, 0, id);
      // Promise.all(listRfq.map((item) => getQUOTES(item, id)))
      //   .then((results) => {
      //     res
      //       .status(200)
      //       .json({
      //         status: 1,
      //         data: results
      //       })
      //       .end();
      //   })
      //   .catch((error) => {
      //     console.error('Error inserting data:', error);
      //   });
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
              from: `${organization_name} ${Config.masterEmail}`,
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
  sendReminder: async (req, res, next) => {
    let rfq_id = req.params.id;
    const { organization_name, name, id } = req.user;

    try {

      // const date = new Date('2024-11-28').toISOString().slice(0, 10);  // Format, YYYY-MM-DD
      const date = new Date().toISOString().slice(0, 10);

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

      const rfqBasicDetails = await rfqModel.getRfqDetailsById(rfq_id)
      let vendors = await rfqModel.gerRFQVendors(rfq_id);
      const quote_vendor = await rfqModel.quoteVendor(rfq_id);

      const createdByIds = new Set(quote_vendor.map((item) => item.created_by));

      // const unmatchedVendors = vendors.filter(
      //   async (vendor) => {
      //     const vendorProducts = await rfqModel.getVendorProductsCount(rfq_id, vendor.user_id)
      //     const vendorProductsQuoted = await rfqModel.getVendorProductsQuoted(rfq_id, vendor.user_id)
      //     if(vendorProducts) {
      //       const productsCount = vendorProducts[0].count
      //     }
      //     return !createdByIds.has(vendor.user_id)
      //   }
      // );

      const unmatchedVendors = (
        await Promise.all(
          vendors.map(async (vendor) => {
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
      let org_name = organization_name ? organization_name : name;

      Promise.all(vendors.map((item) => sendReminderRFQMAIL(item.vendor, item.remainingProducts, org_name, rfq_id,rfqBasicDetails)))
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
          );

          let dummyOBJ = {
            sp: false,
            id: '**',
            vendor_name: '***** ******',
            email: '********@*****.***',
            mobile: '**********',
            company_name: '******',
            address: '******** ******* ** ****** **** ******** ****',
            image_url: null,
            vendor_approved: [
              {
                id: '**',
                vendor_approve: '****'
              },
              {
                id: '**',
                vendor_approve: '**** **'
              },
              {
                id: '**',
                vendor_approve: '****'
              }
            ]
          };
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
  magicSearchRfqCreate: async (req, res, next) => {
    try {
      const file = req.file.location;
      const user = req.user;
      const comment = req.body.comment;
      const response_email = user.email;
      const contact_name = user.name;
      const contact_number = user.mobile;
      const company_name = user.organization_name || user.name;
      const location = req.body.delivery_location || "";
      const bid_end_date = req.body.bid_end_date || "";
      const project_id = req.body.project_id;
      const rfq_type = req.body.rfq_type || "";
      const reverse_auction = req.body.reverse_auction || "";

      // process boq with AI
      const boqDataJson = await generativeAI.processBOQWithAI(file);

      // get all terms list
      const termList = await rfqModel.getAllTerms();
      const transformedTermList = termList.map(term => ({ id: term.id, name: term.term_content }));

      // product error
      const products = [];

      // validation error array ko keep monitor all products
      const validationErrors = [];


      // run loop on excel data
      for await (const value of boqDataJson?.productList) {

        // trim all inputs
        const productName = value?.product_name.toString();
        const size = value?.size.toString();
        const specifications = value?.specifications.toString();
        const quantity = value?.quantity.toString();
        const unit = value?.unit.toString();

        // if product name is not present then skip this product
       if(!productName || productName=="NA"){
          continue
        }

        // search product in our database
        const searchObj = {
          search_key: productName || "",
          category_id: "",
          approved_by_id: ""
        };

        const searchedPro = await productModel.checkVariantExists(searchObj.search_key);

        // // break if no product found
        if (!searchedPro || searchedPro.length === 0) {
          validationErrors.push({
            // row: jsonData.indexOf(value) + 1,
            errors: { product: productName + " - No variant name found " }
          });
          continue; // Skip this product
        }

        // check for unique product, and select first unique product from the list
        let search_key = searchedPro[0];

        // product spec object
        const spec = [
          { title: "Size", value: size },
          { title: "Spec", value: specifications },
          { title: "Quantity", value: quantity },
          { title: "Unit", value: unit }
        ];

        let vendorResult = null
        // seacrch vendor for the selected product
        if(searchObj.search_key){
          vendorResult = await rfqModel.searchVendor(
            user.id,
            searchObj?.search_key ,
            searchObj.category_id,
            searchObj.approved_by_id,
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
          );
        }

        // if no vendor found for the product, push error in validation array
        if (!vendorResult || vendorResult.length === 0) {
          validationErrors.push({
            // row: jsonData.indexOf(value) + 1,
            errors: { vendor: productName + " - `No vendor found for variant " }
          });
          continue; // Skip this product
        }

        // transform vendor to required form
        const transformedVendorResult = vendorResult.map(
          ({ id, vendor_name, ...otherData }) => ({
            user_id: id,
            name: vendor_name,
            ...otherData
          }));

        // Initialize the variant to 0
        let variant = 0;

        // Iterate over the existing products array to find the same product name and increment the variant
        products.forEach((product) => {
          if (product.name === search_key.name && product.product_id === search_key.id) {
            variant = Math.max(variant, product.variant) + 1;
          }
        });

        // create product object and push in products array
        const product = {
          product_id:  search_key?.id,
          name: search_key.name,
          variant: variant,
          spec: spec,
          vendors: transformedVendorResult,
          comment: value["Comments"] || "",
          defaultSelectedVAB: "",
          datasheet: "0",
          datasheet_file: [],
          spec_file: [],
          qap: "0",
          qap_file: [],
          user_selected_predefined_tds: false,
          user_selected_predefined_qap: false
        };

        // push in products array
        products.push(product);
      }
      // json data loop end here


      // final data for fuuther processing
      const finalObject = {
        is_published: 1,
        comment: comment,
        response_email: response_email,
        contact_name: contact_name,
        contact_number: contact_number,
        location: location,
        rfq_type: rfq_type,
        reverse_auction: reverse_auction,
        bid_end_date: bid_end_date,
        company_name: company_name,
        products: products,
        terms: transformedTermList,
        project_id: project_id,
        term_and_condition_files:[],
      };


      // Delete the uploaded file to save space
      // fs.unlinkSync(file.path);


      res.status(200).json({
        status:1,
        data : finalObject,
        validation_errors: validationErrors.length ? validationErrors : null,
      })
      .end();

    } catch (error) {
      logError(error);
      res
        .status(500)
        .json({
          success: false,
          message: 'Magic search failed to complete the action, Please try again.',
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
    const user = req.user

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
      if (user_type === 2) {
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

// addTechnicalEveluation: async (req, res) => {
//   try {
//     const { rfq_ID, rfq_product_id } = req.body;

//     const result = rfqModel.addTechnicalEveluation(rfq_ID, rfq_product_id);

//     res
//       .status(200)
//       .json({
//         status: 1,
//         // data:result,
//         data: "product successfully added to technical eveluation"
//       })
//       .end();
//   } catch (error) {
//     logError(error);
//     res.status(500).json({
//         success: false,
//         message: 'Error in adding product in technical eveluation',
//         error: error.message
//     });
//   }
// },


addClauseUsingFile : async (req, res) => {
  try {

    // converting the excel into json object
    let file = req.file;
    const workbook = xlsx.readFile(file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    let jsonData = xlsx.utils.sheet_to_json(sheet);

    // if there is no Clauses in the excel file.
    if(jsonData.length < 1){
      return res.status(200).json({
        status: 0,
        message: "List of Clauses is empty",
      });
    }

    const { rfq_id,rfq_product_id, } = req.body;
    let errors=[];
    for await(const[index,value] of jsonData.entries()){
      const clause_text = (value['List of Clauses'] || "").trim();

      if(clause_text==''){
        errors.push({
          Row:index,
          error:"Either not find the column or Clause is empty"
        })
      }else{
        const result = await rfqModel.addClause(rfq_id, rfq_product_id, clause_text,[]);
        if(!result.status){
          errors.push({
            Row:index,
            error:result.message
          })
        }
      }

    }

    res.status(200).json({status:errors?.length>0 ? 0 : 1, message : "Clause added Successfully", errors:errors}).end();

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

    const response = await rfqModel.getTechComments(clause_id, sender_id, receiver_id);
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

    // Validate input
    if (!vendor_id || !rfq_product_tech_evaluation_id ) {
      return res.status(400).json({
        status: 0,
        message: "Invalid input. Please provide vendor ID , rfq_product_tech_evaluation_id and status",
      });
    }

    const response = await rfqModel.addtechEvaluationClearedVendors(vendor_id, rfq_product_tech_evaluation_id,status, reject_message);

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
    console.log("Start Date, End Date, ProjectId:", startDate, endDate, projectId);


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
    console.log('[RFQ Controller] searchVariantProducts called with:', JSON.stringify(req.body));
    const search_key = req.body?.search_key ? req.body?.search_key : '';
    
    if (!search_key || search_key.trim() === '') {
      console.log('[RFQ Controller] Empty search key, returning empty results');
      return res.status(200).json([]).end();
    }
    
    // Use the model to search for variant mappings
    const variantProductResults = await rfqModel.searchVariantProducts(search_key);
    console.log(`[RFQ Controller] Found ${variantProductResults?.length || 0} variant products for search: "${search_key}"`);
    
    if (!variantProductResults || variantProductResults.length === 0) {
      return res.status(200).json([]).end();
    }
    
    res.status(200).json(variantProductResults).end();
  } catch (error) {
    console.error('[RFQ Controller] Error in searchVariantProducts:', error.message);
    logError(error);
    res.status(400).json({
      status: 3,
      message: Config.errorText.value
    }).end();
  }
},

processBoqAndDownload : async (req, res) => {
  try {

    const response = await generativeAI.processBoqAndDownload(req.file);

    console.log(response)

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

// Changes by Agnij May 01, 2025 [Added endpoint to search variant vendors]
searchVariantVendors: async (req, res, next) => {
  try {
    console.log('[RFQ Controller] searchVariantVendors called with:', JSON.stringify(req.body));
    const { product_id, variant_id } = req.body;
    
    if (!product_id && !variant_id) {
      console.log('[RFQ Controller] No product_id or variant_id provided, returning empty results');
      return res.status(200).json([]).end();
    }
    
    // Log which ID we're using
    if (variant_id) {
      console.log(`[RFQ Controller] Searching vendors for variant ID: ${variant_id}`);
    } else {
      console.log(`[RFQ Controller] Searching vendors for product ID: ${product_id}`);
    }
    
    // Use the model to search for vendors associated with this variant
    const variantVendorResults = await rfqModel.searchVariantVendors(product_id, variant_id);
    console.log(`[RFQ Controller] Found ${variantVendorResults?.length || 0} vendors for ${variant_id ? 'variant' : 'product'} ID: ${variant_id || product_id}`);
    
    if (!variantVendorResults || variantVendorResults.length === 0) {
      return res.status(200).json([]).end();
    }
    
    res.status(200).json(variantVendorResults).end();
  } catch (error) {
    console.error('[RFQ Controller] Error in searchVariantVendors:', error.message);
    logError(error);
    res.status(400).json({
      status: 3,
      message: Config.errorText.value
    }).end();
  }
},

};
export default rfqController;
