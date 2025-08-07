import config from "../../config/app.config.js";
import db from "../../config/dbConn.js";
import { sendMail } from "../../helper/common.js";
import { generateEmailTemplate } from "../../helper/notificationEmailLayout.js";
import userModel from "../../models/userModel.js";
import vendorModel from "../../models/vendorModel.js";

export const sendApprovalNotification = async (purchaseOrder, userId) => {
  return new Promise(async (resolve, reject) => {
    const quantity = purchaseOrder.quantity || 'N/A';
    const totalValue = purchaseOrder.total_value || 'N/A';

    let user = await userModel.getUserById(userId);
    if (user) user = user[0];
    else reject('User not found!');

    let product = await db.oneOrNone(
      `SELECT P.id, P.name FROM tbl_rfq_products trp JOIN tbl_product_variant P ON P.id = trp.product_variant_id WHERE trp.id = $1`,
      [purchaseOrder.rfq_product_id]
    );

    let finalized = await db.oneOrNone(
        `SELECT id, name FROM tbl_users WHERE id = $1`,
        [purchaseOrder.finalized_vendor_id]
    )

    const headerContent = `<h2>Hello ${user.name},</h2>`;

    const containerContent = ` 
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
            <p>
            A Purchase Order has been initiated in your company that needs your approval.
            </p>

            <h4>Purchase Order Details</h4>
            <ul>
            <li><strong>Product Name:</strong> ${product.name}</li>
            <li><strong>Quantity:</strong> ${quantity}</li>
            <li><strong>Total Value:</strong> ₹${totalValue}.00</li>
            <li><strong>Finalized Vendor:</strong> ${finalized.name}</li>
            <li><strong>Created At:</strong> ${
                new Date(purchaseOrder.created_at).toLocaleString()
            }</li>
            </ul>

            <p style="margin-top:20px; text-align:center;">
                Please ensure the necessary actions are taken to proceed the Purchase Order.
            </p>

            <a href="${
            process.env.FRONT_END_WEBSITE
            }/dashboard/buyer/purchase-order?rfq=${purchaseOrder.rfq_id}&po=${purchaseOrder.id}" 
            style="background-color: #3B82F6; color: white; text-align: center; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600; margin: 20px auto;">
            View Purchase Order
            </a>

            <p style="text-align:center; margin-top: 30px;">
            Thank you for staying proactive.<br/>
            <strong>— Workwise Team</strong>
            </p>
        </div>`;

    // Generate final email layout
    const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

    let mailRecipients = {
      from: config.webmasterMail,
      to: user?.email,
      subject: `New PO Approval Request — Your Action is Needed`,
      html: dynamicHTML
    };

    sendMail(mailRecipients);
    resolve(true);
  });
};

export const sendPONotificationToVendor = async (purchaseOrder, user) => {
    try {
        let company = await userModel.getCompanyDetail(user.id);
        if(company) company = company[0];

        const product = await db.one(
            `SELECT P.id, P.name FROM tbl_rfq_products TRP JOIN tbl_product_variant P ON TRP.product_variant_id = P.id WHERE TRP.id = $1`,
            [purchaseOrder.rfq_product_id]
        )

        let vendor = await userModel.getUserById(purchaseOrder.finalized_vendor_id);
        if(!vendor) throw new Error("Vendor Not Found!");
        vendor = vendor[0];

        const headerContent = `<h2>Hello ${vendor.organization_name || vendor.name || "Vendor"},</h2>`;

        const containerContent = ` 
            <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
            <p>
                We're excited to inform you that a <strong>Purchase Order</strong> has been created for your quote.
            </p>

            <h4>Purchase Order Details</h4>
            <ul>
                <li><strong>PO Number:</strong> ${purchaseOrder.po_number}</li>
                <li><strong>Product Name:</strong> ${product.name}</li>
                <li><strong>Quantity:</strong> ${purchaseOrder.quantity}</li>
                <li><strong>Total Value:</strong> ₹${purchaseOrder.total_value}.00</li>
                <li><strong>Created At:</strong> ${new Date(purchaseOrder.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</li>
            </ul>

            <h4>Buyer Info</h4>
            <p><strong>Company Name: </strong> ${company.company_name}</p>
            <p><strong>User Name: </strong> ${user.name}</p>
            <p><strong>User Email: </strong> ${user.email}</p>

            <p style="margin-top:20px;">
                Please ensure your team is aligned and prepared to fulfill the order as per the specified terms.
            </p>

            <p style="text-align:center; margin-top: 30px;">
                Thank you for your continued partnership.<br/>
                <strong>— Team Workwise</strong>
            </p>
            </div>`;

        // Generate final email layout
        const dynamicHTML = generateEmailTemplate(
          headerContent,
          containerContent
        );

        const spocList = await vendorModel.getSpocDetails(purchaseOrder.finalized_vendor_id);

        let mailRecipients = {
            from: `${company.company_name} <hello@letsworkwise.com>`,
            subject: `Purchase Order Confirmed — PO #${purchaseOrder.po_number} for ${product.name}`, // Subject line
            html: dynamicHTML
        };

        if (spocList && spocList.length > 0) {
            mailRecipients.to = spocList.map(spoc => spoc.email);
            mailRecipients.cc =  vendor.email;
        } else {
            mailRecipients.to =  vendor.email;
        }

        sendMail(mailRecipients);
    } catch (error) {
        console.error(error);
        throw error;
    }
}