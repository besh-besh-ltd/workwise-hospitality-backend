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
  const groupedData = data.reduce((acc, item) => {
    acc[item.product_id] = acc[item.product_id] || [];
    acc[item.product_id].push(item);
    return acc;
  }, {});

  Object.keys(groupedData).forEach((product_id) => {
    const items = groupedData[product_id];
    items.forEach((item, idx) => {
      const totalSets = Math.floor(item.product_specs.length / 3);
      const setToKeep = totalSets - idx;

      if (setToKeep > 0 && setToKeep <= totalSets) {
        const start = (setToKeep - 1) * 3;
        item.product_specs = item.product_specs.slice(start, start + 3);
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
      comment,
      datasheet,
      spec_file,
      qap_file,
      rfq_id: created_rfq_id,
      datasheet_file,
      qap
    };
    let spec_array = spec.map((item) => {
      item.rfq_id = created_rfq_id;
      item.product_id = product_id;
      return item;
    });
    const spec_keys = ['title', 'value', 'rfq_id', 'product_id'];

    const vendor_keys = ['user_id', 'rfq_id', 'product_id'];
    var vendor_array = [];
    if (vendors.length > 0) {
      vendor_array = vendors.map((item) => {
        item.rfq_id = created_rfq_id;
        item.product_id = product_id;
        return item;
      });
    }

    const productResult = await rfqModel.insert(
      'tbl_rfq_products',
      tbl_rfq_products_data
    );
    const spec_info = await rfqModel.insertArray(
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
const sendMailEachVendor = async ({ vendors }, user, rfqNumber) => {
  console.log('===========', vendors);
  try {
    let organization_name = user.organization_name
      ? user.organization_name
      : user.name;

    Promise.all(
      vendors &
        vendors
          .map(async (vendorsItem) => {
            let user_details = await userModel.user_profile_detail(
              vendorsItem.user_id
            );
            if (user_details.length > 0) {
              let dynamicHTML = `
                <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
                  <tr>
                    <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#fff; font-weight:normal; padding:0px; background:#203367; line-height:30px;'><table border="0" width="100%">
                          <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img alt="Workwise"  width="160" height="41"  src="http://143.110.242.57:8111/_next/image?url=%2Fassets%2Fimages%2Flogo.png&w=256&q=75">  </td>
                          <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
                          <p>Suite 804, 8th Floor , Martin Burn Business Park, <br />
                            Block , BP 3 Sector V, Salt Lake , Kolkata- 700 091</p></td>
                      </table></td>
                  </tr>
                  <tr>
                  <td colspan="2" align='left' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:normal; padding:5px 5px; background:#fff; line-height:1.5;'>
                    <strong>Dear ${user_details[0].name},</strong><br>
                    
                    </td>
                  </tr>
                  <tr>
                    <td align='left' valign='top'  style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:bold; background-color:#f2f2f2; padding:5px;'>You have a new RFQ from ${organization_name}. Review now to submit your quotation.
                    <a href="${process.env.FRONT_END_WBSITE}/dashboard/vendor/inquiries-details?id=${rfqNumber}">Click here to view RFQ</a></td>
                    
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

              sendMail({
                from: Config.webmasterMail, // sender address
                to: user_details[0]?.email, // list of receivers
                subject: `Work Wise | New RFQ Alert`, // Subject line
                html: dynamicHTML // plain text body
              });
              const notificationData = {
                type: 'RFQ create',
                title: `RFQ created`,
                message: `RFQ created successfully`,
                additional_data: {
                  user_type: user_details[0].user_type
                }
              };
              // const receiverUserIds = [req.params.id];
              // await sendNotification(user_id[0].id, '', notificationData);
              const payload = {
                title: `Hello ${user_details[0].name}`,
                body: `You've got a new RFQ from ${user.organization_name}`
              };
              const ss = JSON.parse(user_details[0].endpoint);
              sendNotification(
                user_details[0].id,
                '',
                notificationData,
                payload,
                ss
              );
            }
          })
          .then((result) => {
            return {};
          })
    );
  } catch (error) {
    console.error('Error inserting data:', error);
    throw error;
  }
};

const sendMailtoVendors = async (req, rfqNumber) => {
  // send mail to vendors
  const { products } = req.body;

  Promise.all(
    products.map((item) => sendMailEachVendor(item, req.user, rfqNumber))
  )
    .then((result) => {
      return true;
    })
    .catch((error) => {
      console.error('Error inserting data:', error);
    });
};

const sendQuotationMailToBuyer = async (req, rfqNumber) => {
  // send mail to vendors
  const { name, email } = req.user;
  let dynamicHTML = `
  <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
    <tr>
      <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#fff; font-weight:normal; padding:0px; background:#203367; line-height:30px;'><table border="0" width="100%">
            <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img alt="Workwise"  width="160" height="41"  src="http://143.110.242.57:8111/_next/image?url=%2Fassets%2Fimages%2Flogo.png&w=256&q=75">  </td>
            <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
            <p>Suite 804, 8th Floor , Martin Burn Business Park, <br />
              Block , BP 3 Sector V, Salt Lake , Kolkata- 700 091</p></td>
        </table></td>
    </tr>
    <tr>
    <td colspan="2" align='left' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:normal; padding:5px 5px; background:#fff; line-height:1.5;'>
      <strong>Dear ${name},</strong><br>
      
      </td>
    </tr>
    <tr>
      <td align='left' valign='top'  style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:bold; background-color:#f2f2f2; padding:5px;'>Your RFQ has been successfully shared with vendors.<a href="${process.env.FRONT_END_WBSITE}/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfqNumber}">Click here to view </a></td>
      
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

  sendMail({
    from: Config.webmasterMail, // sender address
    to: email, // list of receivers
    subject: `Work Wise | RFQ Creation Confirmation`, // Subject line
    html: dynamicHTML // plain text body
  });
};
const sendQuoteNotificationToVendor = async (req) => {
  // send mail to vendors
  const { name, email } = req.user;
  let dynamicHTML = `
  <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
    <tr>
      <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#fff; font-weight:normal; padding:0px; background:#203367; line-height:30px;'><table border="0" width="100%">
            <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img alt="Workwise"  width="160" height="41"  src="http://143.110.242.57:8111/_next/image?url=%2Fassets%2Fimages%2Flogo.png&w=256&q=75">  </td>
            <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
            <p>Suite 804, 8th Floor , Martin Burn Business Park, <br />
              Block , BP 3 Sector V, Salt Lake , Kolkata- 700 091</p></td>
        </table></td>
    </tr>
    <tr>
    <td colspan="2" align='left' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:normal; padding:5px 5px; background:#fff; line-height:1.5;'>
      <strong>Dear ${name},</strong><br>
      
      </td>
    </tr>
    <tr>
      <td align='left' valign='top'  style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:bold; background-color:#f2f2f2; padding:5px;'>
      ${
        req.body.is_regret && req.body.is_regret == 1
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

  sendMail({
    from: Config.webmasterMail, // sender address
    to: email, // list of receivers
    subject:
      req.body.is_regret && req.body.is_regret == 1
        ? `Work Wise | Quotation Regreted`
        : `Work Wise | Quotation Submitted`, // Subject line
    html: dynamicHTML // plain text body
  });
};

const sendReminderRFQMAIL = async (vendoritem, org_name) => {
  let user_details = await userModel.user_profile_detail(vendoritem.user_id);
  if (user_details.length > 0) {
    let dynamicHTML = `
                  <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
                    <tr>
                      <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#fff; font-weight:normal; padding:0px; background:#203367; line-height:30px;'><table border="0" width="100%">
                            <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img alt="Workwise"  width="160" height="41"  src="http://143.110.242.57:8111/_next/image?url=%2Fassets%2Fimages%2Flogo.png&w=256&q=75">  </td>
                            <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
                            <p>Suite 804, 8th Floor , Martin Burn Business Park, <br />
                              Block , BP 3 Sector V, Salt Lake , Kolkata- 700 091</p></td>
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

    sendMail({
      from: Config.webmasterMail, // sender address
      to: user_details[0].email, // list of receivers
      subject: `Work Wise | Reminder for Quotation | Action Required`, // Subject line
      html: dynamicHTML // plain text body
    });
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
      let vendor = u[0];
      dynamicHTML = `
      <table width='600' border='1px' bordercolor='#B6B6B6' align='center' cellspacing='0' cellpadding='0' style='border:1px solid #000; border-collapse:collapse; background-color:#FFF; margin-top:15px; margin-bottom:10px;'>
        <tr>
          <td colspan="2" align='center' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#fff; font-weight:normal; padding:0px; background:#203367; line-height:30px;'><table border="0" width="100%">
                <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img alt="Workwise"  width="160" height="41"  src="http://143.110.242.57:8111/_next/image?url=%2Fassets%2Fimages%2Flogo.png&w=256&q=75">  </td>
                <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
                <p>Suite 804, 8th Floor , Martin Burn Business Park, <br />
                  Block , BP 3 Sector V, Salt Lake , Kolkata- 700 091</p></td>
            </table></td>
        </tr>
        <tr>
        <td colspan="2" align='left' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:normal; padding:15px 30px; background:#fff; line-height:1.5;'>
          <strong>Dear ${organization_name},</strong><br>
          
          </td>
        </tr>
        <tr>
          <td align='left' valign='top'  style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:bold; background-color:#f2f2f2; padding:30px;'>You've received a new quote from <u>${
            vendor.name
          }</u> on <a href="http://143.110.242.57:8111/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfq_id}"><u>RFQ#${rfq_no}</u> </a>for bellow products:
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
                  <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img alt="Workwise"  width="160" height="41"  src="http://143.110.242.57:8111/_next/image?url=%2Fassets%2Fimages%2Flogo.png&w=256&q=75">  </td>
                  <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
                  <p>Suite 804, 8th Floor , Martin Burn Business Park, <br />
                    Block , BP 3 Sector V, Salt Lake , Kolkata- 700 091</p></td>
              </table></td>
          </tr>
          <tr>
          <td colspan="2" align='left' valign='top' style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:normal; padding:15px 30px; background:#fff; line-height:1.5;'>
            <strong>Dear ${organization_name},</strong><br>
            
            </td>
          </tr>
          <tr>
            <td align='left' valign='top'  style='font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#414141; font-weight:bold; background-color:#f2f2f2; padding:30px;'>
            <u>${
              vendor.name
            }</u> is declined the RFQ request (<a href="http://143.110.242.57:8111/dashboard/buyer/rfq-management-details?type=buyer-view&id=${rfq_id}"><u>RFQ#${rfq_no}</a></u>) you've sent for bellow products:            
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

      sendMail({
        from: Config.webmasterMail, // sender address
        to: vendor.email, // list of receivers
        subject:
          req.body.is_regret && req.body.is_regret == 1
            ? `Work Wise | RFQ#${rfq_no} | RFQ Request Declined`
            : `Work Wise | RFQ#${rfq_no} | New Quotation Received`, // Subject line
        html: dynamicHTML // plain text body
      });
      resolve(u);
    }
  });
};

const sendWinningNotificaion = async (
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
                <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:18px; color:#fff; font-weight:bold; padding:10px 5px; text-align:left' width="200"><img alt="Workwise"  width="160" height="41"  src="http://143.110.242.57:8111/_next/image?url=%2Fassets%2Fimages%2Flogo.png&w=256&q=75">  </td>
                <td style='background-color:#203367; font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#fff; padding:10px 5px; text-align:right; line-height:1.5;'>
                <p>Suite 804, 8th Floor , Martin Burn Business Park, <br />
                  Block , BP 3 Sector V, Salt Lake , Kolkata- 700 091</p></td>
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
            <p style="font-weight:normal;">*&nbsp;For detailed information, please <a href="http://143.110.242.57:8111">login</a> to our portal</p>        
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

    sendMail({
      from: Config.webmasterMail, // sender address
      to: winning_vendor_email, // list of receivers
      subject: `Work Wise | Quotation Winner | Congratulation`, // Subject line
      html: dynamicHTML // plain text body
    });
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
  const filteredData = products.filter((item) => {
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

const rfqController = {
  create: async (req, res, next) => {
    const user_id = req.user.id;
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
      const {
        rfq_id,
        comment,
        company_name,
        response_email,
        contact_name,
        contact_number,
        bid_end_date,
        location,
        is_published,
        products,
        terms
      } = req.body;
      console.log('RFQ products==>', products);
      if (rfq_id && rfq_id != '' && rfq_id != null) {
        // Updating existing RFQ

        const tbl_rfq_update_data = {
          comment,
          company_name,
          response_email,
          contact_name,
          contact_number,
          bid_end_date,
          location,
          is_published: 1,
          updated_by: user_id
        };
        const response = await rfqModel.update(
          'tbl_rfq',
          tbl_rfq_update_data,
          rfq_id
        );

        res
          .status(400)
          .json({
            status: 2,
            data: response[0]
          })
          .end();
      } else {
        // Creating fresh RFQ

        const nextRFQNumber = await getNextRfQNumber();

        const tbl_rfq_data = {
          comment,
          company_name,
          response_email,
          contact_name,
          contact_number,
          bid_end_date,
          location,
          is_published,
          rfq_no: nextRFQNumber,
          created_by: user_id,
          updated_by: user_id
        };

        const response = await rfqModel.insert('tbl_rfq', tbl_rfq_data);
        var rfqtermsRsp = null;

        if (response.length > 0) {
          const created_rfq_id = response[0].id;

          if (terms.length > 0) {
            var tbl_rfq_terms_map_array = [];

            terms.map((item) => {
              tbl_rfq_terms_map_array.push({
                rfq_id: created_rfq_id,
                terms_id: item.id
              });
            });
            const tbl_rfq_terms_map_keys = ['rfq_id', 'terms_id'];
            rfqtermsRsp = await rfqModel.insertArray(
              tbl_rfq_terms_map_array,
              tbl_rfq_terms_map_keys,
              'tbl_rfq_terms_map'
            );
          }

          Promise.all(
            products.map((item) => insertProduct(item, created_rfq_id))
          )
            .then(async (results) => {
              // console.log('Data inserted successfully:', results);
              response[0].otherDetails = results;
              response[0].terms = rfqtermsRsp;
              await sendMailtoVendors(req, response[0].id);
              await sendQuotationMailToBuyer(req, response[0].id);

              res
                .status(200)
                .json({
                  status: 1,
                  data: response[0]
                })
                .end();
            })
            .catch((error) => {
              console.error('Error inserting data:', error);
            });
        } else {
          res
            .status(400)
            .json({
              status: 2,
              data: response
            })
            .end();
        }
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
  listAll: async (req, res, next) => {
    try {
      let page, limit, offset;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      const listRfq = await rfqModel.getAll(limit, offset);
      let count = await rfqModel.getRfqCount();
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

      res
        .status(200)
        .json({
          status: 1,
          data: listRfq
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
        console.log('=======================', userProducts);
        if (
          userProducts.length > 0 &&
          rfQItem.length > 0 &&
          rfQItem[0].products.length > 0
        ) {
          let fproducts = [];
          userProducts.map((prod_item) => {
            prod_item.product_id;
            rfQItem[0].products.map((pintem) => {
              if (prod_item.product_id == pintem.product_id) {
                fproducts.push(pintem);
              }
            });
          });

          rfQItem[0].products = await removeSpecsDynamically(fproducts); // remove duplicate specs from products
          // rfQItem[0].products = fproducts;
        }
      } else {
        for await (let i of rfQItem) {
          if (i.products.length > 0) {
            i.product = await removeSpecsDynamically(i.products);
            // for await (let j of i.products) {
            //   j.specs = await removeSpecsDynamically(j.specs);
            // }
          }
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

      const listRfq = await rfqModel.getAllBuyerRfq(limit, offset, user_id);
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
      globalComment
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
            global_comment: globalComment
          };

          // check quote is already exists or not

          let alreadyExists = await rfqModel.checkIfExists(
            'tbl_quotes',
            `rfq_id=${rfq_id} AND created_by=${user.id} LIMIT 1`
          );
          if (alreadyExists.length > 0) {
            let quote_rsp = await rfqModel.update(
              'tbl_quotes',
              tbl_quotes_data,
              alreadyExists[0].id
            );
            if (quote_rsp.length > 0) {
              res
                .status(200)
                .json({
                  status: 1,
                  data: quote_rsp[0]
                })
                .end();
            } else {
              res
                .status(400)
                .json({
                  status: 3,
                  message: 'Unable to update quote!'
                })
                .end();
            }

            return;
          }

          let quote_rsp = await rfqModel.insert('tbl_quotes', tbl_quotes_data);
          if (quote_rsp.length > 0) {
            const created_quote_id = quote_rsp[0].id;
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
                quantity
              }) => {
                quote_items_data.push({
                  rfq_id,
                  rfq_no,
                  quote_id: created_quote_id,
                  product_id,
                  product_name,
                  unit_price,
                  package_price,
                  tax,
                  freight_price,
                  total_price,
                  comment,
                  delivery_period,
                  quantity
                });
              }
            );

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
              'quantity'
            ];
            let quotes_items = await rfqModel.insertArray(
              quote_items_data,
              quote_items_keys,
              'tbl_quote_items'
            );

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
      rfQItem = processQuotations(rfQItem);
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
      rfQItem = processQuotCompare(rfQItem);
      let rfqDATA = [];
      if (rfQItem.length > 0) {
        rfqDATA = rfQItem.map((item) => {
          let base = item.all_vendors;
          let data = item.quotations;
          let quotes_unavailable_vendors = base.filter(
            (baseitem) => !data.find((d) => d.created_by == baseitem.id)
          );
          item.quotes_unavailable_vendors = quotes_unavailable_vendors;

          if (quotes_unavailable_vendors.length > 0) {
            quotes_unavailable_vendors.map((q_item) => {
              item.quotations.push({
                id: null,
                timestamp: null,
                status: 1,
                created_by: q_item.id,
                is_regret: null,
                quote_details: [],
                vendor_details: [q_item]
              });
            });
          }
          item.quotations.sort((a, b) => a.created_by - b.created_by);

          return item;
        });
      }
      res
        .status(200)
        .json({
          status: 1,
          data: rfqDATA
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
    const { organization_name, name } = req.user;

    try {
      const vendors = await rfqModel.gerRFQVendors(rfq_id);

      let org_name = organization_name ? organization_name : name;
      Promise.all(vendors.map((item) => sendReminderRFQMAIL(item, org_name)))
        .then(() => {
          res
            .status(200)
            .json({
              status: 1,
              message: 'Reminder has been sent successfully!'
            })
            .end();
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
    const { product_id, vendor_id, rfq_id, rfq_no, quote_id } = req.body;
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
          (p) => p.product_id == product_id
        );
      }

      if (
        winning_product &&
        winning_vendor_organization &&
        winning_vendor_email
      ) {
        let alreadyExists = await rfqModel.checkIfExists(
          'tbl_quote_finalization',
          `rfq_id=${rfq_id} AND quote_id=${quote_id}  AND product_id=${product_id} AND created_by=${req.user.id} LIMIT 1`
        );
        if (alreadyExists.length > 0) {
          res
            .status(200)
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
            created_by: req.user.id
          };

          const response = await rfqModel.insert(
            'tbl_quote_finalization',
            tbl_quote_finalization_data
          );
          await sendWinningNotificaion(
            rfQItem,
            winning_product,
            winning_vendor_organization,
            winning_vendor_email,
            winning_vendor_name
          );

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
    let user = req.user;
    if (user && user.user_type != 3) {
      let search_key = '';
      let category_id = '';
      let approved_by_id = '';
      search_key = req.body?.search_key ? req.body?.search_key : '';
      category_id = req.body?.category_id ? req.body?.category_id : '';
      approved_by_id = req.body?.approved_by_id ? req.body?.approved_by_id : '';

      try {
        const productResult = await rfqModel.searchProduct(
          search_key,
          category_id,
          approved_by_id
        );

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
            data: removeDuplicates(items_to_sent)
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
    } else {
      res
        .status(400)
        .json({
          status: 3,
          message: "You don't have permission to perform this action!"
        })
        .end();
    }
  },
  searchVendor: async (req, res, next) => {
    let user = req.user;
    if (user && user.user_type != 3) {
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

      try {
        const vendorResult = await rfqModel.searchVendor(
          search_key,
          category_id,
          approved_by_id,
          state,
          city
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
                result.push(dummyOBJ);
              });

              res
                .status(200)
                .json({
                  status: 1,
                  data: result
                })
                .end();
            })
            .catch((error) => {
              console.error('Error inserting data:', error);
            });
        } else {
          Promise.all(vendorResult.map((item) => getVendorDetails(item, true)))
            .then((result) => {
              shuffleArray(result);
              res
                .status(200)
                .json({
                  status: 1,
                  data: result
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
  }
};
export default rfqController;
