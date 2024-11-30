import Config from '../../config/app.config.js';
import {
  logError,
  currentDateTime,
  titleToSlug,
  generateOTPRandomNo,
  generateRandomString,
  createPay,
  sendMail
} from '../../helper/common.js';
import rfqModel from '../../models/rfqModel.js';
import userModel from '../../models/userModel.js';
import { sendNotification } from '../../services/notificationService.js';
import excelJS from 'exceljs';
import xlsx from 'xlsx';
import vendorModel from '../../models/vendorModel.js';


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
      product_id,
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
      item.product_id = product_id;
      item.variant = variant;
      return item;
    });
    const spec_keys = ['title', 'value', 'rfq_id', 'product_id', 'variant'];

    const vendor_keys = ['user_id', 'rfq_id', 'product_id', 'variant'];
    var vendor_array = [];
    if (vendors.length > 0) {
      vendor_array = vendors.map((item) => {
        item.rfq_id = created_rfq_id;
        item.product_id = product_id;
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
    let organization_name = user.organization_name || user.name;

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


      // Construct the email content with the list of products
      let dynamicHTML = `
<div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; background-color: #ffe4e4eb; width: 100%; max-width: 768px; border-radius: 20px; margin: 0 auto; padding: 40px; box-sizing: border-box;">
      <div>
        <img style="width: 200px; mix-blend-mode: multiply;" src="https://letsworkwise.com/assets/images/logo.png" alt="workwise-Logo" />
        <p style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; font-size: 16px; font-weight: 600; color: #333333; margin-top: 10px;">
          Suite no. 801, Synergy Business Park, ITT Bhatti, <br/>
          Hanuman Tekdi, Goregaon, Mumbai, Maharashtra 400063
        </p>
      </div>
        <hr />
        <h1>Hello ${user_details[0].name}</h1>
        <p style="font-size:16px;"> Great news! You’ve received a new enquiry from ${organization_name} </p>
       <div
      style="border-radius: 24px; padding: 32px 16px; margin-bottom: 24px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
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

        </div>
        <hr />
        <p style="font-size: 16px;">If you need assistance, contact us at <a href="mailto:hello@letsworkwise.com">hello@letsworkwise.com</a></p>
        <p style="font-size: 16px;">© WorkWise. All Rights Reserved.</p>
      </div>`;

      // Send the email
      //  sendMail({
      //   from: Config.webmasterMail,
      //   to: user_details[0].email,
      //   subject: `Work Wise | New RFQ Alert`,
      //   html: dynamicHTML,
      // });


      let mailRecipients = {
        from: Config.webmasterMail,
        subject: `Work Wise | New RFQ Alert`,
        html: dynamicHTML
      };

      if (spocList && spocList.length > 0) {
        mailRecipients.to = spocList.map(spoc => spoc.email);
        mailRecipients.cc = user_details[0].email;
      } else {
        mailRecipients.to = user_details[0].email;
      }

      // console.log(" rfq contoller 377 spoc console ", user_details[0]?.id, spocList)

      sendMail(mailRecipients);

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

const sendMailtoVendors = async (req, rfqNumber) => {
  // Extract products from request body
  const { products } = req.body;

  // Create a map to group vendors and their products
  const vendorProductMap = {};

  // Iterate over products to group them by vendors
  products.forEach((item) => {
    item.vendors.forEach((vendor) => {
      if (!vendorProductMap[vendor.user_id]) {
        vendorProductMap[vendor.user_id] = {
          vendorDetails: vendor,
          products: [],
        };
      }
      // Push product details for this vendor
      vendorProductMap[vendor.user_id].products.push(item);
    });
  });

  // Now send mail to each vendor with the grouped products
  try {
    await Promise.all(
      Object.keys(vendorProductMap).map(async (vendorId) => {
        const vendorInfo = vendorProductMap[vendorId];
        await sendMailEachVendor(vendorInfo.vendorDetails, req.user, rfqNumber, vendorInfo.products);
      })
    );
    return true;
  } catch (error) {
    console.error('Error sending emails:', error);
    throw error;
  }
};

const sendQuotationMailToBuyer = async (req, rfqNumber) => {
  // send mail to vendors
  const { name, email, id } = req.user;
  let dynamicHTML = `
  <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
    <tr>
      <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#fff; font-weight:normal; padding:0px; background:#203367; line-height:30px;'><table border="0" width="100%">
            <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img style="width: 200px; mix-blend-mode: multiply;" src="https://letsworkwise.com/assets/images/logo.png" alt="workwise-Logo" />  </td>
            <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
            <p>Suite no. 801, Synergy Business Park, ITT Bhatti, <br/>
            Hanuman Tekdi, Goregaon, Mumbai, Maharashtra 400063</p></td>
        </table></td>
    </tr>
    <tr>
    <td colspan="2" align='left' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:normal; padding:5px 5px; background:#fff; line-height:1.5;'>
      <strong>Dear ${name},</strong><br>
      
      </td>
    </tr>
    <tr>
      <td align='left' valign='top'  style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:bold; background-color:#f2f2f2; padding:5px;'>Your RFQ has been successfully shared with vendors.<a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfqNumber}">Click here to view </a></td>
      
    </tr>
      

    <tr>
      <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#000; font-weight:normal; padding:5px; background:#efefef; line-height:30px;'><div>
          <div>
            <div>
              <div>
                <p>© WorkWise. All Rights Reserved.</p>
              </div>
            </div>
          </div>
        </div></td>
    </tr>
    </table>`;

  const spocList = await vendorModel.getSpocDetails(id)

  // console.log(" rfq contoller 488 spoc console ", id, spocList)

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

  sendMail(mailRecipients);

  // sendMail({
  //   from: Config.webmasterMail, // sender address
  //   to: email, // list of receivers
  //   subject: `Work Wise | RFQ Creation Confirmation`, // Subject line
  //   html: dynamicHTML // plain text body
  // });
};
const sendQuoteNotificationToVendor = async (req) => {
  // send mail to vendors
  const { name, email, id } = req.user;
  let dynamicHTML = `
  <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
    <tr>
      <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#fff; font-weight:normal; padding:0px; background:#203367; line-height:30px;'><table border="0" width="100%">
            <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img style="width: 200px; mix-blend-mode: multiply;" src="https://letsworkwise.com/assets/images/logo.png" alt="workwise-Logo" />  </td>
            <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
            <p>Suite no. 801, Synergy Business Park, ITT Bhatti, <br/>
            Hanuman Tekdi, Goregaon, Mumbai, Maharashtra 400063</p></td>
        </table></td>
    </tr>
    <tr>
    <td colspan="2" align='left' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:normal; padding:5px 5px; background:#fff; line-height:1.5;'>
      <strong>Dear ${name},</strong><br>
      
      </td>
    </tr>
    <tr>
      <td align='left' valign='top'  style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:bold; background-color:#f2f2f2; padding:5px;'>
      ${req.body.is_regret && req.body.is_regret == 1
      ? 'Your regret concern has been sent to the buyer.'
      : 'Your quotation has been submitted to the buyer.'
    }
      
      </td>
      
    </tr>
      

    <tr>
      <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#000; font-weight:normal; padding:5px; background:#efefef; line-height:30px;'><div>
          <div>
            <div>
              <div>
                <p>© WorkWise. All Rights Reserved.</p>
              </div>
            </div>
          </div>
        </div></td>
    </tr>
    </table>`;

  // sendMail({
  //   from: Config.webmasterMail, // sender address
  //   to: email, // list of receivers
  //   subject:
  //     req.body.is_regret && req.body.is_regret == 1
  //       ? `Work Wise | Quotation Regreted`
  //       : `Work Wise | Quotation Submitted`, // Subject line
  //   html: dynamicHTML // plain text body
  // });


  const spocList = await vendorModel.getSpocDetails(id)

  // console.log(" rfq contoller 569 spoc console  ", id, spocList)

  let mailRecipients = {
    from: Config.webmasterMail,
    subject:
      req.body.is_regret && req.body.is_regret == 1
        ? `Work Wise | Quotation Regreted`
        : `Work Wise | Quotation Submitted`, // Subject line
    html: dynamicHTML
  };

  if (spocList && spocList.length > 0) {
    mailRecipients.to = spocList.map(spoc => spoc.email);
    mailRecipients.cc = email;
  } else {
    mailRecipients.to = email;
  }

  sendMail(mailRecipients);

};

const sendReminderRFQMAIL = async (vendoritem, org_name,rfq_id) => {
  let user_details = await userModel.user_profile_detail(vendoritem.user_id);
  const token = await rfqModel.getVendorRfqToken(vendoritem.user_id, rfq_id);
  if (user_details.length > 0) {
    let dynamicHTML = `
                  <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
                    <tr>
                      <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#fff; font-weight:normal; padding:0px; background:#203367; line-height:30px;'><table border="0" width="100%">
                            <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img style="width: 200px; mix-blend-mode: multiply;" src="https://letsworkwise.com/assets/images/logo.png" alt="workwise-Logo" />  </td>
                            <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
                            <p>Suite no. 801, Synergy Business Park, ITT Bhatti, <br/>
                            Hanuman Tekdi, Goregaon, Mumbai, Maharashtra 400063</p></td>
                        </table></td>
                    </tr>
                    <tr>
                    <td colspan="2" align='left' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:normal; padding:5px 5px; background:#fff; line-height:1.5;'>
                      <strong>Dear ${user_details[0].name},</strong><br>
                      
                      </td>
                    </tr>
                    <tr>
                      <td align='left' valign='top'  style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:bold; background-color:#f2f2f2; padding:5px;'>You have received a reminder from ${org_name} to provide a quote for the RFQ.</td>                      
                    </tr>
                     <tr>
                      <td colspan="2" style="text-align: center; padding-bottom: 3px;">
                        <a href=${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${token[0].token}
                        style="font-size: 15px; color: blue; text-decoration: none;">
                          click here
                        </a>
                      </td>
                    </tr>
                      

                    <tr>
                      <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#000; font-weight:normal; padding:5px; background:#efefef; line-height:30px;'><div>
                          <div>
                            <div>
                              <div>
                                <p>© WorkWise. All Rights Reserved.</p>
                              </div>
                            </div>
                          </div>
                        </div></td>
                    </tr>
                    </table>`;



    const spocList = await vendorModel.getSpocDetails(user_details[0]?.id)

    // console.log(" rfq contoller  632 spoc console ", user_details[0]?.id, spocList)

    
    let mailRecipients = {
      from: Config.webmasterMail,
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

    // sendMail({
    //   from: Config.webmasterMail, // sender address
    //   to: user_details[0].email, // list of receivers
    //   subject: `Work Wise | Reminder for Quotation | Action Required`, // Subject line
    //   html: dynamicHTML // plain text body
    // });
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
  let { name, email, organization_name } = req.user;
  let { rfq_id, rfq_no, products } = req.body;
  let dynamicHTML = '';
  const getProducts = () => {
    let phtml = '';
    if (products.length > 0) {
      phtml = '<ul style="padding-left: 0; margin-top: 40px;">';
      products.map((item) => {
        phtml = phtml + `<li>${item.product_name}</li>`;
      });
      phtml = phtml + '</ul>';
    }
    return phtml;
  };

  return new Promise(async (resolve, reject) => {
    let u = await rfqModel.getRFQCreatedBy(rfq_id);
    if (u.length > 0) {
      //This is the buyer
      let vendor = u[0];
      dynamicHTML = `
      <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
        <tr>
          <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#fff; font-weight:normal; padding:0px; background:#203367; line-height:30px;'><table border="0" width="100%">
                <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img style="width: 200px; mix-blend-mode: multiply;" src="https://letsworkwise.com/assets/images/logo.png" alt="workwise-Logo" />  </td>
                <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
                <p>Suite no. 801, Synergy Business Park, ITT Bhatti, <br/>
                Hanuman Tekdi, Goregaon, Mumbai, Maharashtra 400063</p></td>
            </table></td>
        </tr>
        <tr>
        <td colspan="2" align='left' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:normal; padding:15px 30px; background:#fff; line-height:1.5;'>
          <strong>Dear ${vendor.name},</strong><br>
          
          </td>
        </tr>
        <tr>
          <td align='left' valign='top'  style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:bold; background-color:#f2f2f2; padding:30px;'>You've received a new quote from <u>${organization_name
        }</u> on <a href=${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfq_id}><u>RFQ#${rfq_no}</u> </a>for bellow products:
          ${getProducts()}
          
          </td>
          
        </tr>
          

        <tr>
          <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#000; font-weight:normal; padding:5px; background:#efefef; line-height:30px;'><div>
              <div>
                <div>
                  <div>
                    <p>© WorkWise. All Rights Reserved.</p>
                  </div>
                </div>
              </div>
            </div></td>
        </tr>
        </table>`;

      if (req.body.is_regret && req.body.is_regret == 1) {
        dynamicHTML = `
        <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
          <tr>
            <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#fff; font-weight:normal; padding:0px; background:#203367; line-height:30px;'><table border="0" width="100%">
                  <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img style="width: 200px; mix-blend-mode: multiply;" src="https://letsworkwise.com/assets/images/logo.png" alt="workwise-Logo" /> </td>
                  <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
                  <p>Suite no. 801, Synergy Business Park, ITT Bhatti, <br/>
                  Hanuman Tekdi, Goregaon, Mumbai, Maharashtra 400063</p></td>
              </table></td>
          </tr>
          <tr>
          <td colspan="2" align='left' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:normal; padding:15px 30px; background:#fff; line-height:1.5;'>
            <strong>Dear ${vendor.name},</strong><br>
            
            </td>
          </tr>
          <tr>
            <td align='left' valign='top'  style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:bold; background-color:#f2f2f2; padding:30px;'>
            <u>${organization_name
          }</u> has declined the RFQ request (<a href=${process.env.FRONT_END_WEBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfq_id}><u>RFQ#${rfq_no}</a></u>) you've sent for bellow products:            
             ${getProducts()}            
            
            </td>
            <td colspan="2" align='left' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:normal; padding:15px 30px; background:#fff; line-height:1.5;'>
            <strong>Reason: </strong><br>
            ${req.body.regret_reason}
            </td>
            
          </tr>
            
  
          <tr>
            <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#000; font-weight:normal; padding:5px; background:#efefef; line-height:30px;'><div>
                <div>
                  <div>
                    <div>
                      <p>© WorkWise. All Rights Reserved.</p>
                    </div>
                  </div>
                </div>
              </div></td>
          </tr>
          </table>`;
      }


      const spocList = await vendorModel.getSpocDetails(vendor?.id)

      // console.log(" rfq contoller 781 spoc console ", vendor?.id, spocList)

      let mailRecipients = {
        from: Config.webmasterMail,
        subject: `Work Wise | New RFQ Alert`,
        html: dynamicHTML
      };

      if (spocList && spocList.length > 0) {
        mailRecipients.to = spocList.map(spoc => spoc.email);
        mailRecipients.cc =  vendor.email
      } else {
        mailRecipients.to =  vendor.email;
      }

      sendMail(mailRecipients);

      // sendMail({
      //   from: Config.webmasterMail, // sender address
      //   to: vendor.email, // list of receivers
      //   subject:
      //     req.body.is_regret && req.body.is_regret == 1
      //       ? `Work Wise | RFQ#${rfq_no} | RFQ Request Declined`
      //       : `Work Wise | RFQ#${rfq_no} | New Quotation Received`, // Subject line
      //   html: dynamicHTML // plain text body
      // });
      resolve(u);
    }
  });
};

const sendWinningNotificaion = async (
  vendor_id,
  rfQItem,
  winning_product,
  winning_vendor_organization,
  winning_vendor_email,
  winning_vendor_name
) => {
  return new Promise(async (resolve, reject) => {
    let dynamicHTML = `
      <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
        <tr>
          <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#fff; font-weight:normal; padding:0px; background:#203367; line-height:30px;'><table border="0" width="100%">
                <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img style="width: 200px; mix-blend-mode: multiply;" src="https://letsworkwise.com/assets/images/logo.png" alt="workwise-Logo" />  </td>
                <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
                <p>Suite no. 801, Synergy Business Park, ITT Bhatti, <br/>
                Hanuman Tekdi, Goregaon, Mumbai, Maharashtra 400063</p></td>
            </table></td>
        </tr>
        <tr>
        <td colspan="2" align='left' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:normal; padding:15px 30px; background:#fff; line-height:1.5;'>
        <h1 style="text-align: center; color: #203367;">!!CONGRATULATIONS!!</h1>
          <p><strong>Dear ${winning_vendor_name},</strong><br></p>   
          <p>You're the <strong>winner</strong> for the quotation you've placed for <strong><u>RFQ#${rfQItem[0].rfq_no}</u></strong><p>       
        </td>
        </tr>
        <tr>
          <td align='left' valign='top'  style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:bold; background-color:#f2f2f2; padding:30px;'>Here are the product details:<br>
            <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
              <tr>
                <th style='background-color: #203367;color: #fff;padding: 10px 15px; text-align: left;width: 140px;'>Product Name</th>
                <td style="padding: 10px 15px;">${winning_product[0]?.product_details[0]?.name}</td>
              </tr>
              <tr>
                <th style='background-color: #203367;color: #fff;padding: 10px 15px; text-align: left;width: 140px;'>Size</th>
                <td style="padding: 10px 15px;">${winning_product[0]?.product_specs[0]?.value}</td>
              </tr>
              <tr>
                <th style='background-color: #203367;color: #fff;padding: 10px 15px; text-align: left;width: 140px;'>Specification</th>
                <td style="padding: 10px 15px;">${winning_product[0]?.product_specs[1]?.value}</td>
              </tr>
              <tr>
                <th style='background-color: #203367;color: #fff;padding: 10px 15px; text-align: left;width: 140px;'>Quantity</th>
                <td style="padding: 10px 15px;">${winning_product[0]?.product_specs[2]?.value}</td>
              </tr>
            </table>
            <p>Here are the buyer details:</p>
            <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
              <tr>
                <th style='background-color: #203367;color: #fff;padding: 10px 15px; text-align: left;width: 140px;'>Company Name</th>
                <td style="padding: 10px 15px;">${rfQItem[0]?.company_name}</td>
              </tr>
              <tr>
                <th style='background-color: #203367;color: #fff;padding: 10px 15px; text-align: left;width: 140px;'>Email</th>
                <td style="padding: 10px 15px;">${rfQItem[0]?.response_email}</td>
              </tr>
              <tr>
                <th style='background-color: #203367;color: #fff;padding: 10px 15px; text-align: left;width: 140px;'>Contact Person</th>
                <td style="padding: 10px 15px;">${rfQItem[0]?.contact_name}</td>
              </tr>
              <tr>
                <th style='background-color: #203367;color: #fff;padding: 10px 15px; text-align: left;width: 140px;'>Contact Number</th>
                <td style="padding: 10px 15px;">${rfQItem[0]?.contact_number}</td>
              </tr>
              
            </table>   
            <br> 
            <br> 
            <p style="font-weight:normal;">*&nbsp;For detailed information, please <a href=${process.env.FRONT_END_WEBSITE}>login</a> to our portal</p>        
          </td>
          
        </tr>
          

        <tr>
          <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#000; font-weight:normal; padding:5px; background:#efefef; line-height:30px;'><div>
              <div>
                <div>
                  <div>
                    <p>© WorkWise. All Rights Reserved.</p>
                  </div>
                </div>
              </div>
            </div></td>
        </tr>
        </table>`;

    const spocList = await vendorModel.getSpocDetails(vendor_id)

    // console.log(" rfq contoller 901 spoc console ", vendor_id, spocList)

    let mailRecipients = {
      from: Config.webmasterMail,
      subject: `Work Wise | Quotation Winner | Congratulation`, // Subject line
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
      is_published: 0,
      updated_by: user_id
  };

  let rfq_id;
  const rfqList = await rfqModel.findAll('tbl_rfq', { is_published: 0, created_by: user_id });
  if (rfqList.length > 0) {
    rfq_id = rfqList[0].id;
  } else {
      return {
        success: true,
        message: 'No RFQ draft found!'
      };
  }

  if (project_id && project_id !== -1) {
      rfqData.project_id = project_id;
  }


  await rfqModel.update('tbl_rfq', rfqData, rfq_id);
  await rfqModel.updateWithTimestamp('tbl_rfq', rfqData, rfq_id);
  await deleteRelatedRecords(rfq_id);

  if (terms && terms.length > 0) {
      const rfqTerms = terms.map(term => ({ rfq_id, terms_id: term.id }));
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
    for (const product of products) {
        await insertProduct(product, rfq_id);
    }
  }

  return { status: 1, message: 'Draft saved successfully', rfq_id };
};

const rfqController = {
  create: async (req, res, next) => {

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
        project_id
      } = req.body;
      const response_email = req.body.response_email?.toLowerCase();

      const user_id = req.user.id;

      if(!rfq_id){
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
          reverse_auction
        };

        if(project_id!=-1){
          tbl_rfq_data.project_id=project_id;
        }

        const response = await rfqModel.insert('tbl_rfq', tbl_rfq_data);

        if (response.length > 0) {
          req.body.rfq_id = response[0].id;
          rfq_id = response[0].id;
        }  
      }

      await saveRfqDraft(req.user.id, req.body);

      const response = await rfqModel.update(
        'tbl_rfq',
        {is_published: 1},
        rfq_id
      );

      await sendMailtoVendors(req, rfq_id);
      await sendQuotationMailToBuyer(req, rfq_id);

      res
        .status(200)
        .json({
          status: 2,
          data: response[0]
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

        const rfqItem = await rfqModel.getRfqDraftId(id);

        res.status(200).json({
            status: 1,
            data: rfqItem.length > 0 ? rfqItem[0] : rfqItem
        });
    } catch (error) {
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
                timestamp: new Date(),
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
        if (!product || !product.product_id || !Array.isArray(product.vendors) || product.vendors.length === 0) {
          return res.status(400).json({ status: 2, message: 'Invalid product or vendors data' });
        }

        const variant = await rfqModel.getNextVariant(rfq_id, product.product_id);

        const productData = {
            rfq_id,
            product_id: product.product_id,
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
                product_id: product.product_id,
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

      // else block commented by by mukul jatav
      // else {
      // no use of removeSpecsDynamically here, 

      // for await (let i of rfQItem) {
      //   if (i.products.length > 0) {
      //     // console.log("mukul ji", i.products)
      //     // i.product = await removeSpecsDynamically(i.products);
      //     for await (let j of i.products) {
      //       console.log("ok ",j.product_specs)
      //       //  j.specs = await removeSpecsDynamically(j.product_specs);
      //      }
      //   }
      // }
      // }

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
  /*   rfqList: async (req, res, next) => {
    try {
      let vendorId = req.user.id;
      let page,
        limit,
        offset,
        products = [];
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }
      let productName = req.query?.productName;
      let filterProduct = {};
      let vendorApprove = req.query?.vendorApprove;
      if (vendorApprove) {
        filterProduct = await productModel.getApprovedByProduct(vendorApprove);
      }
      if (req.query?.download == 'true' && req.query?.downloadAll === 'true') {
        offset = 0;
        limit = 'ALL';
      }
      if (req.query?.download == 'true' && req.query?.product_ids) {
        products = JSON.parse(req.query.product_ids);
      }

      let productList = await productModel.getVendorProductList(
        limit,
        offset,
        vendorId,
        productName,
        filterProduct,
        products
      );
      let productCount = await productModel.getVendorProductCount(
        vendorId,
        productName,
        filterProduct
      );

      if (req.query.download == 'true') {
        const workbook = new excelJS.Workbook();
        const worksheet = workbook.addWorksheet('Products');

        // Add headers
        worksheet.columns = [
          { header: 'S no.', key: 's_no', width: 5 },
          { header: 'Name', key: 'name', width: 20 },
          { header: 'Manufacturer', key: 'manufacturer', width: 20 },
          // { header: 'Slug', key: 'slug', width: 20 },
          { header: 'Category', key: 'category', width: 20 },
          { header: 'Specification Key', key: 'specification_Key', width: 20 },
          {
            header: 'Specification Value',
            key: 'specification_value',
            width: 20
          },
          { header: 'Approved By', key: 'vendor_approve', width: 20 },
          { header: 'Availability', key: 'availability', width: 20 },
          { header: 'Status', key: 'status', width: 20 }
        ];

        let counter = 1;

        productList.forEach((prod) => {
          prod.s_no = counter;
          prod.availability =
            prod.availability == 1 ? 'Available' : 'Not Available';
          prod.status = prod.status == 1 ? 'Active' : 'Not active';
          prod.category = prod.product_categories[0]?.category_name || '';
          prod.specification_Key = prod.product_variants[0]?.variant_name || '';
          prod.vendor_approve =
            prod.product_approve_by.length > 0
              ? prod.product_approve_by
                  .map((item) => item.vendor_approve_name)
                  .join(',')
              : '';
          prod.specification_value =
            prod.product_variants[0]?.variant_value || '';
          worksheet.addRow(prod); // Add data in worksheet
          if (
            prod.product_categories?.length > 1 ||
            prod.product_variants?.length > 1
          ) {
            let maxCount = Math.max(
              prod.product_categories?.length || 0,
              prod.product_variants?.length || 0
            );
            for (let index = 1; index < maxCount; index++) {
              let newData = {};
              if (prod.product_categories[index]?.category_name) {
                newData.category = prod.product_categories[index].category_name;
              }
              if (prod.product_variants[index]?.variant_name) {
                newData.specification_Key =
                  prod.product_variants[index].variant_name;
                newData.specification_value =
                  prod.product_variants[index].variant_value;
              }
              worksheet.addRow(newData);
            }
          }

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
        res.setHeader(
          'Content-Disposition',
          'attachment; filename=products.xlsx'
        );

        // Write workbook to response
        workbook.xlsx.write(res).then(() => {
          res.end();
        });
      } else {
        res
          .status(200)
          .json({
            status: 1,
            data: productList,
            total_count: productCount.count
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
  }, */
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

      let {project_id,sort,reverse_auction,rfq_type} = req.body;
      if(project_id==-1){
        project_id=null;
      }
      if(rfq_type==''){
        rfq_type=null;
      }
      if(reverse_auction=='-1'){
        reverse_auction=null;
      }


      const listRfq = await rfqModel.getAllBuyerRfq(limit, offset, user_id,project_id,sort,reverse_auction,rfq_type);

      let count = await rfqModel.getBuyerRfqCount(user_id);
      res
        .status(200)
        .json({
          status: 1,
          data: listRfq,
          total_items: count.length
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
          const tbl_quotes_data = {
            rfq_id,
            rfq_no,
            status,
            created_by: user.id,
            updated_by: user.id,
            timestamp: Date.now(),
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
            // let quote_rsp = await rfqModel.update(
            //   'tbl_quotes',
            //   tbl_quotes_data,
            //   alreadyExists[0].id
            // );
            // if (quote_rsp.length > 0) {
            //   res
            //     .status(200)
            //     .json({
            //       status: 1,
            //       data: quote_rsp[0]
            //     })
            //     .end();
            // } else {
            //   res
            //     .status(400)
            //     .json({
            //       status: 3,
            //       message: 'Unable to update quote!'
            //     })
            //     .end();
            // }

            return;
          }
          // console.log("mukul 1908")

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
                    variant
                  });
                }else if(comment!="" || document_files?.length>0){
                  quote_items_data.push({
                    rfq_id,
                    rfq_no,
                    product_id,
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
                    product_id,
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
                'product_id',
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
              'product_id',
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

            await sendQuoteNotificationEmail(req, rfq_id);
            await sendQuoteNotificationToVendor(req);

            res
              .status(200)
              .json({
                status: 1,
                data: quotes_items[0]
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
    const { id } = req.user;

    try {
      let rfQItem = await rfqModel.getQuotesByRfqById2(rfq_id, id);
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
    const { id } = req.user;

    try {
      let rfQItem = await rfqModel.getQuotesByRfqByIdByProduct(rfq_id, id);
      
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
    const { id } = req.user;

    try {
      const rfQItem = await rfqModel.changeRFQStatus(rfq_id, id);
      console.log(rfQItem.length);
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

      let vendors = await rfqModel.gerRFQVendors(rfq_id);
      const quote_vendor = await rfqModel.quoteVendor(rfq_id);

      const createdByIds = new Set(quote_vendor.map((item) => item.created_by));

      const unmatchedVendors = vendors.filter(
        (vendor) => !createdByIds.has(vendor.user_id)
      );
      vendors = unmatchedVendors;
      let org_name = organization_name ? organization_name : name;

      Promise.all(vendors.map((item) => sendReminderRFQMAIL(item, org_name, rfq_id)))
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
    const { product_id, vendor_id, rfq_id, rfq_no, quote_id, variant } = req.body;

    try {
      const vendor_details = await userModel.user_profile_detail(vendor_id);
      const rfQItem = await rfqModel.getRfqById(rfq_id, vendor_id);
      let winning_product = null;
      let winning_vendor_organization = null;
      let winning_vendor_email = null;
      let winning_vendor_name = null;

      if (vendor_details.length > 0) {
        winning_vendor_organization = vendor_details[0].organization_name;
        winning_vendor_email = vendor_details[0].email;
        winning_vendor_name = vendor_details[0].name;
      }
      if (rfQItem.length > 0 && rfQItem[0].products.length > 0) {
        winning_product = rfQItem[0].products.filter(
          (p) => p.product_id == product_id && p.variant == variant
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
          `rfq_id=${rfq_id} AND product_id=${product_id} AND variant=${variant} AND created_by=${req.user.id} LIMIT 1`
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
            product_id,
            vendor_id,
            quote_id,
            created_by: req.user.id,
            variant
          };

          const response = await rfqModel.insert(
            'tbl_quote_finalization',
            tbl_quote_finalization_data
          );
          await sendWinningNotificaion(
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
            message: Config.errorText.value
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
    search_key = req.body?.search_key ? req.body?.search_key : '';
    category_id = req.body?.category_id ? req.body?.category_id : '';
    approved_by_id = req.body?.approved_by_id ? req.body?.approved_by_id : '';
    state = req.body?.state ? req.body?.state : '';
    city = req.body?.city ? req.body?.city : '';
    let vendor_name = req.body.vendor_name;
    let is_private = req.body.is_private;
    let preferred_vendor = req.body.preferred_vendor;
    
    // If user is not logged in
    if (!req.is_verified) {
      try {

        // Call the searchVendor method
        const vendorResult = await rfqModel.searchVendorWithoutLogin(search_key, category_id, approved_by_id, state, city);
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

        // Type validation for the is_private check
        if (is_private && typeof is_private !== "boolean") {
          return res.status(400).json({ 
            status: 1,
            message: "is_private must be a boolean"
          });
        }

        // Type validation for the preferred_vendor check
        if (preferred_vendor && typeof preferred_vendor !== "boolean") {
          return res.status(400).json({ 
            status: 1,
            message: "preferred_vendor must be a boolean"
          });
        }



        try {
          const vendorResult = await rfqModel.searchVendor(
            req.user.id,
            search_key,
            category_id,
            approved_by_id,
            state,
            city,
            vendor_name,
            is_private = is_private ? true : false,
            preferred_vendor = preferred_vendor ? true : false,
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
        'Mudalagi',
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
      let file = req.file;
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

      // convert excel to json
      const workbook = xlsx.readFile(file.path);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(sheet);

      // get all terms list
      const termList = await rfqModel.getAllTerms();
      const transformedTermList = termList.map(term => ({ id: term.id, name: term.term_content }));

      // product error
      const products = [];

      // validation error array ko keep monitor all products
      const validationErrors = [];


      // run loop on excel data 
      for await (const value of jsonData) {

        // trim all inputs
        const productName = (value["Product Name"] || "").trim();
        const size = (value["Size"] || "").trim();
        const specifications = (value["specifications"] || "").trim();
        const quantity = (String(value["Quantity"]) || "").trim();
        const unit = (value["Unit"] || "").trim();

        // check if all required fileds are present
        if (!productName || !size || !specifications || !quantity || !unit) {

          // push errors in validation array
          validationErrors.push({
            row: jsonData.indexOf(value) + 1, // Assuming rows start at 1
            errors: {
              product_name: !productName ? "Missing product name" : productName,
              size: !size ? "Missing size" : null,
              specifications: !specifications ? "Missing specifications" : null,
              quantity: !quantity ? "Missing quantity" : null,
              unit: !unit ? "Missing unit" : null
            }
          });
          continue; // Skip this product
        }

        // Check if quantity is a valid number
        const parsedQuantity = parseFloat(quantity);
        if (isNaN(parsedQuantity) || parsedQuantity <= 0) {

          // push error in validation array
          validationErrors.push({
            row: jsonData.indexOf(value) + 1,
            errors: {
              product_name: productName,
              quantity: "Quantity must be a valid number greater than zero"
            }
          });
          continue; // Skip this product
        }

        // search product in our database
        const searchObj = {
          search_key: value["Product Name"],
          category_id: "",
          approved_by_id: ""
        };
        const searchedPro = await rfqModel.searchProduct(
          searchObj.search_key,
          searchObj.category_id,
          searchObj.approved_by_id
        );

        // break if no product found
        if (!searchedPro || searchedPro.length === 0) {
          validationErrors.push({
            row: jsonData.indexOf(value) + 1,
            errors: { product: `No product found for "${productName}"` }
          });
          continue; // Skip this product
        }

        // check for unique product, and select first unique product from the list
        const uniqueProducts = removeDuplicates(searchedPro);
        let search_key = uniqueProducts[0];

        // product spec object
        const spec = [
          { title: "Size", value: size },
          { title: "Spec", value: specifications },
          { title: "Quantity", value: quantity },
          { title: "Unit", value: unit }
        ];

        // seacrch vendor for the selected product
        const vendorResult = await rfqModel.searchVendor(
          user.id,
          search_key.product_name,
          searchObj.category_id,
          searchObj.approved_by_id,
          "",
          "",
          "",
          false,
          false
        );


        // if no vendor found for the product, push error in validation array
        if (!vendorResult || vendorResult.length === 0) {
          validationErrors.push({
            row: jsonData.indexOf(value) + 1,
            errors: { vendor: `No vendor found for product "${productName}"` }
          });
          continue; // Skip this product
        }

        // transform vendor to required form
        const transformedVendorResult = vendorResult.map(({ id, vendor_name }) => ({ user_id: id, name: vendor_name}));

        // Initialize the variant to 0
        let variant = 0;

        // Iterate over the existing products array to find the same product name and increment the variant
        products.forEach((product) => {
          if (product.name === search_key.product_name && product.product_id === search_key.product_id) {
            variant = Math.max(variant, product.variant + 1);
          }
        });

        // create product object and push in products array
        const product = {
          product_id: search_key.product_id,
          predefined_tds_file: search_key.pd_tds_file_url,
          predefined_qap_file: search_key.pd_qap_file_url,
          name: search_key.product_name,
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

     
      // check if all row are failed in our validation
      if (validationErrors.length === jsonData.length) {
        return res
          .status(400)
          .json({
            success: false,
            message: "All rows have validation errors. Please check your data and try again.",
            validationErrors: validationErrors,
          })
          .end();
        // Exit early if every row has an error
      }

      res.status(200).json({
        status:1,
        data : finalObject,
        validation_errors: validationErrors.length ? validationErrors : null
      })
      .end();

      // // here we are dividing the api into two different parts
      
      //  // Step 2: Generate the next RFQ number
      //  const nextRFQNumber = await getNextRfQNumber();

      //  // Step 3: Insert the RFQ data into the database
      //  const tbl_rfq_data = {
      //    comment: finalObject.comment,
      //    company_name: finalObject.company_name,
      //    response_email: finalObject.response_email,
      //    contact_name: finalObject.contact_name,
      //    contact_number: finalObject.contact_number,
      //    bid_end_date: finalObject.bid_end_date,
      //    location: finalObject.location,
      //    rfq_type: finalObject.rfq_type,
      //    reverse_auction: finalObject.reverse_auction,
      //    is_published: finalObject.is_published,
      //    rfq_no: nextRFQNumber,
      //    created_by: user.id,
      //    updated_by: user.id,
      //    project_id: project_id
      //  };


      // // insert basic rfq info in database
      // const response = await rfqModel.insert('tbl_rfq', tbl_rfq_data);
      // var rfqtermsRsp = null;

      // // if basic info successfully inserted in database
      // if (response.length > 0) {
      //   const created_rfq_id = response[0].id;

      //   // Step 4: Insert the terms into the RFQ terms mapping table
      //   if (finalObject.terms.length > 0) {
      //     var tbl_rfq_terms_map_array = [];

      //     finalObject.terms.map((item) => {
      //       tbl_rfq_terms_map_array.push({
      //         rfq_id: created_rfq_id,
      //         terms_id: item.id
      //       });
      //     });
      //     const tbl_rfq_terms_map_keys = ['rfq_id', 'terms_id'];
      //     rfqtermsRsp = await rfqModel.insertArray(
      //       tbl_rfq_terms_map_array,
      //       tbl_rfq_terms_map_keys,
      //       'tbl_rfq_terms_map'
      //     );
      //   }

      //   // Step 5: Insert the products into the RFQ products table
      //   Promise.all(finalObject.products.map((item) => insertProduct(item, created_rfq_id)))
      //     .then(async (results) => {
      //       response[0].otherDetails = results;
      //       response[0].terms = rfqtermsRsp;

      //       // Step 6: Send emails to vendors and buyer
      //       req.body.products = products
      //       await sendMailtoVendors(req, response[0].id);
      //       await sendQuotationMailToBuyer(req, response[0].id);

      //       // Step 7: Send the final response back to the client
      //       res
      //         .status(200)
      //         .json({
      //           status: 1,
      //           data: response[0],
      //           validation_errors: validationErrors.length ? validationErrors : null
      //         })
      //         .end();
      //     })
      //     .catch((error) => {
      //       console.error('Error inserting data:', error);
      //       res
      //         .status(500)
      //         .json({
      //           success: false,
      //           message: 'Error inserting RFQ data',
      //           error: error.message
      //         })
      //         .end();
      //     });
      // } else {
      //   res
      //     .status(400)
      //     .json({
      //       status: 2,
      //       data: response
      //     })
      //     .end();
      // }
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
      // rfq_id,
      // rfq_no,
      // status,
      products,
      globalPaymentTerms,
      globalComment,
      term_and_condition_files
    } = req.body;

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
          timestamp: Date.now(),
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
            return rfqModel.updateQuoteItemWithHistory(quoteId, product,quoteExists[0]);
          })
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

      let status = true;
      if (!anyQuoteChanged && !paymentTermAndCommentChanges) {
        status = false;
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
      file_name: file.name,
      file_url: file.url
    }));

    if (filesData.length) await rfqModel.insertArray(filesData, ['message_id', 'file_name', 'file_url'], 'tbl_query_message_files');

    const sender_details = await userModel.user_profile_detail(sender_id);
    const senderDetails = sender_details[0];

    const receiver_details = await userModel.user_profile_detail(receiver_id);
    if (receiver_details.length > 0) {
      const receiverDetails = receiver_details[0];
      const spocList = await vendorModel.getSpocDetails(receiver_id);
      const dynamicHTML = `
      <table width='600' border='0' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #B6B6B6; background-color:#FFFFFF; margin-top:15px; margin-bottom:10px; font-family:Arial, sans-serif; color:#414141;'>
        <tr>
          <td colspan="2" align='center' style='background:#203367; padding:20px; color:#FFFFFF; font-size:18px; font-weight:bold;'>
            You have a new message from ${senderDetails.name}
          </td>
        </tr>
        <tr>
          <td colspan="2" align='left' style='padding:20px; font-size:14px; line-height:1.6;'>
            <strong>Hello ${receiverDetails.name},</strong><br><br>
            You have received a new message regarding the RFQ #${rfqNumber}:<br>
            <blockquote style='border-left:3px solid #203367; margin:10px 0; padding-left:15px; color:#333333;'>${message_text}</blockquote>
          </td>
        </tr>
        <tr>
          <td colspan="2" align='center' style='background:#F8F8F8; padding:15px; font-size:12px; color:#333333;'>
            <p>© WorkWise. All Rights Reserved.</p>
          </td>
        </tr>
      </table>
    `;
    
    const mailRecipients = {
      from: Config.webmasterMail,
      subject: `WorkWise | New Message Notification | RFQ #${rfqNumber}`,
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

};
export default rfqController;
